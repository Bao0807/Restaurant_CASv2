import type { CartItem, KitchenStatus, MenuCategory, MenuItem, PaymentRecord, Table, TableStatus } from '../data';
import { normalizeSettings, type RestaurantSettings } from '../config/restaurant';

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '');
const AUTH_STORAGE_KEY = 'cas-api-basic-auth';

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
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(authorization ? { Authorization: authorization } : {}),
      ...(options?.headers ?? {}),
    },
  });

  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json')
    ? await response.json() as { error?: string; message?: string; field?: string }
    : null;

  if (!response.ok) {
    throw new ApiError(
      body?.message || `API trả về lỗi ${response.status}`,
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

/** Lấy snapshot nhất quán của bàn, order và trạng thái bếp. */
export async function fetchOperations(): Promise<{
  tables: Table[];
  tableOrders: Record<string, CartItem[]>;
  kitchen: KitchenStatus;
}> {
  return request('/operations');
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

export async function saveKitchenConfig(concurrency: number, staleAfterMinutes: number, automationEnabled: boolean, paused: boolean): Promise<Pick<KitchenStatus, 'concurrency' | 'staleAfterMinutes' | 'automationEnabled' | 'paused'>> {
  const data = await request<Pick<KitchenStatus, 'concurrency' | 'staleAfterMinutes' | 'automationEnabled' | 'paused'>>('/kitchen/config', {
    method: 'PUT', body: JSON.stringify({ concurrency, staleAfterMinutes, automationEnabled, paused }),
  });
  return data;
}

export async function dispatchNextKitchenOrder(): Promise<number> {
  const data = await request<{ count: number }>('/kitchen/dispatch-next', { method: 'POST' });
  return data.count;
}

export async function createTable(number: number, seats: number): Promise<Table> {
  const data = await request<{ table: Table }>('/tables', {
    method: 'POST', body: JSON.stringify({ table: { number, seats } }),
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
export async function saveOrder(tableId: string, items: CartItem[]): Promise<{
  orderNumber: number;
  status: TableStatus;
  queuedAt: string;
  cookingStartedAt?: string;
  estimatedCookMinutes?: number;
  items: CartItem[];
}> {
  return request(`/orders/${encodeURIComponent(tableId)}`, {
    method: 'PUT',
    body: JSON.stringify({ items }),
  });
}

export async function deleteOrder(tableId: string): Promise<void> {
  await request(`/orders/${encodeURIComponent(tableId)}`, { method: 'DELETE' });
}

export async function requeueOrder(tableId: string): Promise<void> {
  await request(`/orders/${encodeURIComponent(tableId)}/requeue`, { method: 'POST' });
}

export async function updateTableStatus(tableId: string, status: TableStatus): Promise<TableStatus> {
  const data = await request<{ status: TableStatus }>(`/tables/${encodeURIComponent(tableId)}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });
  return data.status;
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
    subtotal: Number(payment.subtotal),
    discount: Number(payment.discount),
    serviceFee: Number(payment.serviceFee),
    vat: Number(payment.vat),
    total: Number(payment.total),
    itemCount: Number(payment.itemCount),
    paidAt: new Date(payment.paidAt).toISOString(),
  }));
}

/** Ghi thanh toán idempotent theo invoiceCode và nhận tổng tiền đã tính lại. */
export async function recordPayment(payment: PaymentRecord): Promise<PaymentRecord> {
  const data = await request<{ payment: PaymentRecord }>('/payments', {
    method: 'POST',
    body: JSON.stringify({ payment }),
  });
  return {
    ...data.payment,
    tableNumber: Number(data.payment.tableNumber),
    subtotal: Number(data.payment.subtotal),
    discount: Number(data.payment.discount),
    serviceFee: Number(data.payment.serviceFee),
    vat: Number(data.payment.vat),
    total: Number(data.payment.total),
    itemCount: Number(data.payment.itemCount),
    paidAt: new Date(data.payment.paidAt).toISOString(),
  };
}
