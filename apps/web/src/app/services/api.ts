import type {
  CartItem, EditableOrderBatch, Employee, KitchenStatus, MenuCategory, MenuItem,
  MenuAvailability, PaymentRecord, PaymentResult, ReportSummary, Reservation, ReservationInput, ReservationStatus,
  Table, TableStatus,
} from '../data';
import { normalizeSettings, type RestaurantSettings } from '../config/restaurant';

export type { EditableOrderBatch } from '../data';

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '');
const AUTH_STORAGE_KEY = 'cas-api-basic-auth';
let serverClockOffsetMs = 0;

/** Đồng hồ hiệu chỉnh theo MySQL, tránh timer sai khi giờ máy POS bị lệch. */
export function getServerNowMs(): number {
  return Date.now() + serverClockOffsetMs;
}

/** Chỉ App được áp dụng offset của snapshot đã thắng sequence race. */
export function synchronizeServerClock(offsetMs: number | null): void {
  if (offsetMs != null && Number.isFinite(offsetMs)) serverClockOffsetMs = offsetMs;
}

export class ApiError extends Error {
  status: number;
  code?: string;
  field?: string;

  constructor(message: string, status: number, code?: string, field?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.field = field;
  }
}

function getAuthorization(): string | null {
  return sessionStorage.getItem(AUTH_STORAGE_KEY);
}

function encodeBasicAuth(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = '';
  bytes.forEach(byte => { binary += String.fromCharCode(byte); });
  return `Basic ${btoa(binary)}`;
}

export function clearApiCredentials(): void {
  sessionStorage.removeItem(AUTH_STORAGE_KEY);
}

/** Client HTTP dùng chung: gắn auth theo tab và chuẩn hóa mọi lỗi API. */
async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const authorization = getAuthorization();
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 12_000);
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...options,
      signal: options?.signal ?? controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(authorization ? { Authorization: authorization } : {}),
        ...(options?.headers ?? {}),
      },
    });
  } catch (error) {
    if (controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
      throw new ApiError('Hệ thống phản hồi quá lâu. Vui lòng kiểm tra kết nối và thử lại.', 0, 'REQUEST_TIMEOUT');
    }
    throw new ApiError('Không thể kết nối hệ thống. Vui lòng kiểm tra mạng và thử lại.', 0, 'NETWORK_ERROR');
  } finally {
    window.clearTimeout(timeout);
  }

  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json')
    ? await response.json() as { error?: string; message?: string; field?: string }
    : null;

  if (!response.ok) {
    throw new ApiError(
      body?.message || `Không thể hoàn tất yêu cầu (mã ${response.status}).`,
      response.status,
      body?.error,
      body?.field,
    );
  }

  return body as T;
}

export async function checkApiSession(): Promise<{ authRequired: boolean; username: string }> {
  const data = await request<{
    authRequired: boolean;
    user: { username: string };
  }>('/auth/session');
  return { authRequired: data.authRequired, username: data.user.username };
}

export async function authenticate(username: string, password: string): Promise<void> {
  sessionStorage.setItem(AUTH_STORAGE_KEY, encodeBasicAuth(username, password));
  try {
    await checkApiSession();
  } catch (error) {
    clearApiCredentials();
    throw error;
  }
}

export async function fetchRestaurantSettings(): Promise<RestaurantSettings> {
  const data = await request<{ settings: RestaurantSettings }>('/settings');
  return normalizeSettings(data.settings);
}

export async function saveRestaurantSettings(settings: RestaurantSettings): Promise<RestaurantSettings> {
  const data = await request<{ settings: RestaurantSettings }>('/settings', {
    method: 'PUT',
    body: JSON.stringify({ settings }),
  });
  return normalizeSettings(data.settings);
}

export async function fetchEmployees(activeOnly = false): Promise<Employee[]> {
  const data = await request<{ employees: Employee[] }>(`/employees${activeOnly ? '?active=true' : ''}`);
  return data.employees.map(employee => ({ ...employee, active: Boolean(employee.active) }));
}

export async function saveEmployee(employee: Partial<Employee>): Promise<Employee> {
  const path = employee.id ? `/employees/${encodeURIComponent(employee.id)}` : '/employees';
  const data = await request<{ employee: Employee }>(path, {
    method: employee.id ? 'PUT' : 'POST',
    body: JSON.stringify({ employee }),
  });
  return { ...data.employee, active: Boolean(data.employee.active) };
}

/** Ngừng hoạt động thay vì xóa vật lý để giữ lịch sử hóa đơn. */
export async function deactivateEmployee(employeeId: string): Promise<void> {
  await request(`/employees/${encodeURIComponent(employeeId)}`, { method: 'DELETE' });
}

function normalizeReservation(reservation: Reservation): Reservation {
  return {
    ...reservation,
    id: Number(reservation.id),
    version: Number(reservation.version),
    tableNumber: Number(reservation.tableNumber),
    ...(reservation.tableSeats == null ? {} : { tableSeats: Number(reservation.tableSeats) }),
    partySize: Number(reservation.partySize),
    durationMinutes: Number(reservation.durationMinutes),
    reservedAt: new Date(reservation.reservedAt).toISOString(),
    endsAt: new Date(reservation.endsAt).toISOString(),
    ...(reservation.seatedAt ? { seatedAt: new Date(reservation.seatedAt).toISOString() } : {}),
    ...(reservation.closedAt ? { closedAt: new Date(reservation.closedAt).toISOString() } : {}),
    createdAt: new Date(reservation.createdAt).toISOString(),
    updatedAt: new Date(reservation.updatedAt).toISOString(),
    notes: reservation.notes ?? '',
  };
}

export interface ReservationQuery {
  from?: Date;
  to?: Date;
  status?: ReservationStatus;
  q?: string;
  tableId?: string;
}

export interface AvailableReservationTable {
  id: string;
  number: number;
  seats: number;
}

/** Lấy lịch đặt bàn theo khoảng thời gian; API luôn là nguồn kiểm tra xung đột cuối cùng. */
export async function fetchReservations(query: ReservationQuery = {}): Promise<Reservation[]> {
  const params = new URLSearchParams();
  if (query.from) params.set('from', query.from.toISOString());
  if (query.to) params.set('to', query.to.toISOString());
  if (query.status) params.set('status', query.status);
  if (query.q?.trim()) params.set('q', query.q.trim());
  if (query.tableId) params.set('tableId', query.tableId);
  const data = await request<{ reservations: Reservation[] }>(`/reservations${params.size ? `?${params}` : ''}`);
  return data.reservations.map(normalizeReservation);
}

export async function fetchReservationAvailability(
  reservedAt: Date,
  durationMinutes: number,
  partySize: number,
): Promise<AvailableReservationTable[]> {
  const params = new URLSearchParams({
    reservedAt: reservedAt.toISOString(),
    durationMinutes: String(durationMinutes),
    partySize: String(partySize),
  });
  const data = await request<{ tables: AvailableReservationTable[] }>(`/reservations/availability?${params}`);
  return data.tables.map(table => ({ ...table, number: Number(table.number), seats: Number(table.seats) }));
}

export async function createReservation(reservation: ReservationInput): Promise<Reservation> {
  const data = await request<{ reservation: Reservation }>('/reservations', {
    method: 'POST',
    body: JSON.stringify({ reservation }),
  });
  return normalizeReservation(data.reservation);
}

export async function updateReservation(
  reservationId: number,
  reservation: ReservationInput,
  expectedVersion: number,
): Promise<Reservation> {
  const data = await request<{ reservation: Reservation }>(`/reservations/${encodeURIComponent(String(reservationId))}`, {
    method: 'PUT',
    body: JSON.stringify({ reservation, expectedVersion }),
  });
  return normalizeReservation(data.reservation);
}

export async function updateReservationStatus(
  reservationId: number,
  status: ReservationStatus,
  expectedVersion: number,
): Promise<Reservation> {
  const data = await request<{ reservation: Reservation }>(`/reservations/${encodeURIComponent(String(reservationId))}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status, expectedVersion }),
  });
  return normalizeReservation(data.reservation);
}

/** Lấy snapshot nhất quán của bàn, order và trạng thái bếp. */
export async function fetchOperations(): Promise<{
  serverNow: string;
  serverClockOffsetMs: number | null;
  tables: Table[];
  tableOrders: Record<string, CartItem[]>;
  waitingBatchesByTable: Record<string, EditableOrderBatch[]>;
  menuAvailability: MenuAvailability[];
  kitchen: KitchenStatus;
}> {
  const requestedAt = Date.now();
  const snapshot = await request<{
    serverNow: string;
    tables: Table[];
    tableOrders: Record<string, CartItem[]>;
    waitingBatchesByTable: Record<string, EditableOrderBatch[]>;
    menuAvailability: MenuAvailability[];
    kitchen: KitchenStatus;
  }>('/operations');
  const receivedAt = Date.now();
  const parsedServerNow = Date.parse(snapshot.serverNow);
  return {
    ...snapshot,
    serverClockOffsetMs: Number.isFinite(parsedServerNow)
      ? parsedServerNow - Math.round((requestedAt + receivedAt) / 2)
      : null,
  };
}

export async function fetchCatalog(): Promise<{ categories: MenuCategory[]; items: MenuItem[] }> {
  return request('/catalog');
}

export async function bootstrapCatalog(categories: MenuCategory[], items: MenuItem[]): Promise<{ categories: MenuCategory[]; items: MenuItem[] }> {
  return request('/catalog/bootstrap', {
    method: 'POST',
    body: JSON.stringify({ categories, items }),
  });
}

export async function saveMenuItem(item: Partial<MenuItem>): Promise<MenuItem> {
  const path = item.id ? `/menu-items/${encodeURIComponent(item.id)}` : '/menu-items';
  const data = await request<{ item: MenuItem }>(path, {
    method: item.id ? 'PUT' : 'POST',
    body: JSON.stringify({ item }),
  });
  return data.item;
}

export async function deactivateMenuItem(itemId: string): Promise<void> {
  await request(`/menu-items/${encodeURIComponent(itemId)}`, { method: 'DELETE' });
}

export async function saveCategory(category: Partial<MenuCategory>): Promise<MenuCategory> {
  const path = category.id ? `/categories/${encodeURIComponent(category.id)}` : '/categories';
  const data = await request<{ category: MenuCategory }>(path, {
    method: category.id ? 'PUT' : 'POST',
    body: JSON.stringify({ category }),
  });
  return data.category;
}

type KitchenConfig = Pick<KitchenStatus, 'concurrency' | 'staleAfterMinutes' | 'automationEnabled' | 'paused' | 'version'>;

export async function saveKitchenConfig(
  expectedVersion: number,
  changes: Partial<Omit<KitchenConfig, 'version'>>,
): Promise<KitchenConfig> {
  const data = await request<KitchenConfig>('/kitchen/config', {
    method: 'PATCH', body: JSON.stringify({ expectedVersion, ...changes }),
  });
  return data;
}

export async function dispatchNextKitchenOrder(): Promise<number> {
  const data = await request<{ count: number }>('/kitchen/dispatch-next', { method: 'POST' });
  return data.count;
}

export async function createTable(
  number: number,
  seats: number,
  layout: Pick<Table, 'area' | 'positionX' | 'positionY'> = {},
): Promise<Table> {
  const data = await request<{ table: Table }>('/tables', {
    method: 'POST', body: JSON.stringify({ table: { number, seats, ...layout } }),
  });
  return data.table;
}

export async function saveTable(table: Table): Promise<Table> {
  const data = await request<{ table: Table }>(`/tables/${encodeURIComponent(table.id)}`, {
    method: 'PUT', body: JSON.stringify({ table }),
  });
  return data.table;
}

export async function removeTable(tableId: string): Promise<void> {
  await request(`/tables/${encodeURIComponent(tableId)}`, { method: 'DELETE' });
}

/** Lưu order; backend sẽ chuẩn hóa lại catalog, giá và ETA. */
export interface SavedOrderBatch {
  orderNumber: number;
  batchId: number;
  batchNumber: number;
  isAddition: boolean;
  status: TableStatus;
  queuedAt: string;
  cookingStartedAt?: string;
  estimatedCookMinutes: number;
  inventoryDate: string;
  items: CartItem[];
}

/** Mỗi lần gọi thêm gửi một batch mới; backend xếp batch đó vào FIFO độc lập. */
export async function saveOrder(tableId: string, items: CartItem[], append = false): Promise<SavedOrderBatch> {
  return request(`/orders/${encodeURIComponent(tableId)}`, {
    method: 'PUT',
    body: JSON.stringify({ items, append }),
  });
}

/** Sửa một phiếu bếp còn chờ mà không đổi số phiếu hoặc vị trí FIFO. */
export async function updateWaitingOrderBatch(tableId: string, batchId: number, items: CartItem[]): Promise<SavedOrderBatch> {
  return request(`/orders/${encodeURIComponent(tableId)}/batches/${encodeURIComponent(String(batchId))}`, {
    method: 'PUT',
    body: JSON.stringify({ items }),
  });
}

export async function deleteOrder(tableId: string): Promise<void> {
  await request(`/orders/${encodeURIComponent(tableId)}`, { method: 'DELETE' });
}

export async function requeueOrder(tableId: string, expectedBatchId: number): Promise<void> {
  await request(`/orders/${encodeURIComponent(tableId)}/requeue`, {
    method: 'POST',
    body: JSON.stringify({ expectedBatchId }),
  });
}

export async function updateTableStatus(tableId: string, status: TableStatus, expectedBatchId: number): Promise<TableStatus> {
  const data = await request<{ status: TableStatus }>(`/tables/${encodeURIComponent(tableId)}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status, expectedBatchId }),
  });
  return data.status;
}

/** Đóng bàn đã trả trước sau khi bếp hoàn tất và nhân viên xác nhận khách đã rời. */
export async function confirmTableDeparture(tableId: string): Promise<void> {
  await request(`/orders/${encodeURIComponent(tableId)}/confirm-departure`, { method: 'POST' });
}

export async function fetchPayments(): Promise<PaymentRecord[]> {
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  const to = new Date(from);
  to.setDate(to.getDate() + 1);
  const query = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
  const data = await request<{ payments: PaymentRecord[] }>(`/payments?${query}`);
  return data.payments.map(payment => ({
    ...payment,
    tableNumber: Number(payment.tableNumber),
    ...(payment.reservationId != null ? { reservationId: Number(payment.reservationId) } : {}),
    ...(payment.guestCount != null ? { guestCount: Number(payment.guestCount) } : {}),
    subtotal: Number(payment.subtotal),
    discount: Number(payment.discount),
    serviceFee: Number(payment.serviceFee),
    vat: Number(payment.vat),
    total: Number(payment.total),
    itemCount: Number(payment.itemCount),
    paidAt: new Date(payment.paidAt).toISOString(),
  }));
}

/** Lấy số liệu đã aggregate từ hóa đơn; không phụ thuộc order đang mở hay giới hạn danh sách 1.000 dòng. */
export async function fetchReportSummary(from: Date, to: Date): Promise<ReportSummary> {
  const query = new URLSearchParams({
    from: from.toISOString(),
    to: to.toISOString(),
    timezoneOffsetMinutes: String(-from.getTimezoneOffset()),
  });
  return request(`/reports/summary?${query}`);
}

/** Ghi thanh toán idempotent theo invoiceCode và nhận tổng tiền đã tính lại. */
export async function recordPayment(payment: PaymentRecord): Promise<PaymentResult> {
  const data = await request<{
    payment: PaymentRecord;
    requiresDepartureConfirmation: boolean;
    orderClosed: boolean;
  }>('/payments', {
    method: 'POST',
    body: JSON.stringify({ payment }),
  });
  return {
    ...data.payment,
    tableNumber: Number(data.payment.tableNumber),
    ...(data.payment.reservationId != null ? { reservationId: Number(data.payment.reservationId) } : {}),
    ...(data.payment.guestCount != null ? { guestCount: Number(data.payment.guestCount) } : {}),
    subtotal: Number(data.payment.subtotal),
    discount: Number(data.payment.discount),
    serviceFee: Number(data.payment.serviceFee),
    vat: Number(data.payment.vat),
    total: Number(data.payment.total),
    itemCount: Number(data.payment.itemCount),
    paidAt: new Date(data.payment.paidAt).toISOString(),
    requiresDepartureConfirmation: Boolean(data.requiresDepartureConfirmation),
    orderClosed: Boolean(data.orderClosed),
  };
}
