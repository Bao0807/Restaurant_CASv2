export type TableStatus = 'empty' | 'waiting' | 'cooking' | 'done' | 'reserved';
export type AppView = 'order' | 'overview' | 'reservations' | 'payment' | 'reports' | 'dashboard';
export type OrderStep = 'tables' | 'menu' | 'confirm' | 'success';
export type PaymentMethodId = 'cash' | 'card' | 'qr';
export type EmployeeRole = 'manager' | 'cashier' | 'server' | 'chef';
export type ReservationStatus = 'booked' | 'seated' | 'cancelled' | 'no_show' | 'completed';

export interface NextReservation {
  id: number;
  code: string;
  customerName: string;
  partySize: number;
  reservedAt: string;
  endsAt: string;
  status: Extract<ReservationStatus, 'booked' | 'seated'>;
}

export interface Reservation extends Omit<NextReservation, 'status'> {
  version: number;
  tableId?: string | null;
  tableNumber: number;
  tableSeats?: number;
  customerPhone: string;
  durationMinutes: number;
  status: ReservationStatus;
  notes: string;
  seatedAt?: string;
  closedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReservationInput {
  tableId: string;
  customerName: string;
  customerPhone: string;
  partySize: number;
  reservedAt: string;
  durationMinutes: number;
  notes: string;
}

export interface Employee {
  id: string;
  code: string;
  name: string;
  role: EmployeeRole;
  phone: string;
  shiftStart?: string;
  shiftEnd?: string;
  active: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface Table {
  id: string;
  number: number;
  seats: number;
  status: TableStatus;
  /** Khu vực phục vụ dùng để lọc và nhóm bàn trên sơ đồ. */
  area?: string;
  /** Tọa độ lưới của bàn trong khu vực, bắt đầu từ 1. */
  positionX?: number | null;
  positionY?: number | null;
  orderNumber?: number;
  queuedAt?: string;
  cookingStartedAt?: string;
  cookingBatchId?: number;
  queuePosition?: number;
  estimatedCookMinutes?: number;
  kitchenStale?: boolean;
  batchCount?: number;
  additionalBatchCount?: number;
  waitingBatchCount?: number;
  cookingBatchCount?: number;
  doneBatchCount?: number;
  latestBatchNumber?: number;
  /** Order hiện tại đã được thu tiền nhưng bàn có thể vẫn đang phục vụ. */
  isPaid?: boolean;
  paidAt?: string;
  paymentId?: string;
  paidTotal?: number;
  nextReservation?: NextReservation | null;
}

export interface KitchenStatus {
  concurrency: number;
  cookingCount: number;
  waitingCount: number;
  staleCount: number;
  staleBatches: KitchenStaleBatch[];
  staleAfterMinutes: number;
  automationEnabled: boolean;
  paused: boolean;
  version: number;
}

export interface KitchenStaleBatch {
  batchId: number;
  batchNumber: number;
  tableId: string;
  tableNumber: number;
  orderNumber: number;
  isAddition: boolean;
  cookingStartedAt: string;
  estimatedCookMinutes: number;
}

export interface MenuCategory {
  id: string;
  name: string;
  emoji: string;
  sortOrder?: number;
  active?: boolean;
}

export interface MenuItemSize {
  label: string;
  extraPrice: number;
}

export interface Topping {
  id: string;
  label: string;
  price: number;
}

export interface MenuItem {
  id: string;
  name: string;
  description: string;
  price: number;
  image: string;
  categoryId: string;
  cookMinutes?: number;
  /** NULL/undefined là không giới hạn; 0 là chủ động hết món trong ngày. */
  dailyLimit?: number | null;
  dailyUsed?: number;
  dailyRemaining?: number | null;
  inventoryDate?: string;
  isBestseller?: boolean;
  isNew?: boolean;
  sizes?: MenuItemSize[];
  toppings?: Topping[];
  available: boolean;
}

export interface CartItem {
  cartId: string;
  menuItem: MenuItem;
  quantity: number;
  selectedSize?: MenuItemSize;
  selectedToppings: Topping[];
  note: string;
}

/** Một phiếu FIFO còn chờ và vì thế vẫn được phép chỉnh sửa. */
export interface EditableOrderBatch {
  batchId: number;
  batchNumber: number;
  items: CartItem[];
  queuedAt: string;
  estimatedCookMinutes: number;
  inventoryDate: string;
}

export interface MenuAvailability {
  id: string;
  dailyLimit: number | null;
  dailyUsed: number;
  dailyRemaining: number | null;
  inventoryDate: string;
}

/** Số phần tối đa giỏ hiện tại được phép chứa; null nghĩa là món không đặt hạn mức. */
export function menuItemDailyAllowance(item: MenuItem, inventoryCredit = 0): number | null {
  if (item.dailyLimit == null) return null;
  const remaining = item.dailyRemaining == null
    ? Math.max(0, Number(item.dailyLimit) - Number(item.dailyUsed ?? 0))
    : Math.max(0, Number(item.dailyRemaining));
  return remaining + Math.max(0, inventoryCredit);
}

export function cartQuantityForMenuItem(cart: CartItem[], menuItemId: string): number {
  return cart.reduce((total, item) => total + (item.menuItem.id === menuItemId ? item.quantity : 0), 0);
}

export interface CartStockIssue {
  menuItemId: string;
  name: string;
  requested: number;
  allowance: number;
}

/** Kiểm tra tổng mọi dòng size/topping của cùng món, không chỉ từng dòng giỏ. */
export function getCartStockIssues(
  cart: CartItem[],
  menuItems: MenuItem[],
  inventoryCredits: Record<string, number> = {},
): CartStockIssue[] {
  const catalog = new Map(menuItems.map(item => [item.id, item]));
  const ids = [...new Set(cart.map(item => item.menuItem.id))];
  return ids.flatMap(id => {
    const item = catalog.get(id) ?? cart.find(row => row.menuItem.id === id)?.menuItem;
    if (!item) return [];
    const allowance = menuItemDailyAllowance(item, inventoryCredits[id] ?? 0);
    const requested = cartQuantityForMenuItem(cart, id);
    return allowance != null && requested > allowance
      ? [{ menuItemId: id, name: item.name, requested, allowance }]
      : [];
  });
}

export interface PaymentRecord {
  id: string;
  invoiceCode: string;
  transactionCode: string;
  tableId: string;
  tableNumber: number;
  reservationId?: number | null;
  reservationCode?: string | null;
  customerName?: string | null;
  guestCount?: number | null;
  method: PaymentMethodId;
  subtotal: number;
  discount: number;
  serviceFee: number;
  vat: number;
  total: number;
  itemCount: number;
  paidAt: string;
  employeeId?: string;
  staffName: string;
  cashierName: string;
  /** Ý định giữ bàn của thu ngân khi mở thanh toán trước lúc món hoàn tất. */
  keepTableOpen?: boolean;
}

export interface PaymentResult extends PaymentRecord {
  /** True khi khách trả trước lúc bếp hoàn tất và bàn cần được xác nhận rời sau đó. */
  requiresDepartureConfirmation: boolean;
  /** True khi thanh toán đã đóng order ngay theo luồng cũ. */
  orderClosed: boolean;
}

export interface ReportSummary {
  range: { from: string; to: string; timezoneOffsetMinutes?: number };
  totals: { revenue: number; orders: number; itemCount: number; averageBill: number };
  hourly: Array<{ hour: number; revenue: number; orders: number }>;
  daily: Array<{ date: string; revenue: number; orders: number }>;
  paymentMethods: Array<{ method: PaymentMethodId; revenue: number; orders: number }>;
  topItems: Array<{ id: string; name: string; quantity: number; revenue: number }>;
  categories: Array<{ id: string; name: string; quantity: number; revenue: number }>;
  staff: Array<{ employeeId?: string; name: string; revenue: number; orders: number; itemCount: number }>;
}

/** Tính thành tiền một dòng giỏ hàng, bao gồm size, topping và số lượng. */
export function cartItemTotal(item: CartItem): number {
  const sizeExtra = item.selectedSize?.extraPrice ?? 0;
  const toppingTotal = item.selectedToppings.reduce((s, t) => s + t.price, 0);
  return (item.menuItem.price + sizeExtra + toppingTotal) * item.quantity;
}

export function cartTotal(items: CartItem[]): number {
  return items.reduce((s, i) => s + cartItemTotal(i), 0);
}

/** Thời gian một dòng món tăng tuyến tính theo số phần cùng loại. */
export function cartItemCookMinutes(item: CartItem): number {
  return (Number(item.menuItem.cookMinutes) || 10) * Math.max(1, item.quantity);
}

/** ETA order là dòng lâu nhất vì các dòng món khác nhau có thể chạy song song. */
export function cartEstimatedCookMinutes(items: CartItem[]): number {
  return Math.max(1, ...items.map(cartItemCookMinutes));
}

export function formatVND(amount: number): string {
  return new Intl.NumberFormat('vi-VN').format(amount) + 'đ';
}

/** Hiển thị giờ nếu lịch trong hôm nay, thêm ngày cho lịch ở ngày khác. */
export function formatReservationSlot(value: string): string {
  const date = new Date(value);
  const today = new Date();
  const sameDay = date.getFullYear() === today.getFullYear()
    && date.getMonth() === today.getMonth()
    && date.getDate() === today.getDate();
  return date.toLocaleString('vi-VN', sameDay
    ? { hour: '2-digit', minute: '2-digit' }
    : { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function genId(): string {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

export type StatusIconName = 'circle' | 'clock' | 'flame' | 'bell-ring' | 'calendar-clock';

export interface TableStatusConfig {
  label: string;
  bg: string;
  text: string;
  border: string;
  dot: string;
  /** Tên biểu tượng ngữ nghĩa để giao diện không phải truyền đạt trạng thái chỉ bằng màu sắc. */
  icon: StatusIconName;
}

export const STATUS_CONFIG: Record<TableStatus, TableStatusConfig> = {
  empty:    { label: 'Trống',      bg: '#F8FAFC', text: '#64748B', border: '#CBD5E1', dot: '#94A3B8', icon: 'circle' },
  waiting:  { label: 'Đang chờ',   bg: '#EFF6FF', text: '#1D4ED8', border: '#93C5FD', dot: '#2563EB', icon: 'clock' },
  cooking:  { label: 'Đang nấu',   bg: '#FFF7ED', text: '#C2410C', border: '#FDBA74', dot: '#EA580C', icon: 'flame' },
  done:     { label: 'Đã xong',    bg: '#F0FDF4', text: '#15803D', border: '#86EFAC', dot: '#16A34A', icon: 'bell-ring' },
  reserved: { label: 'Đặt trước',  bg: '#FAF5FF', text: '#7E22CE', border: '#D8B4FE', dot: '#9333EA', icon: 'calendar-clock' },
};

export const CATEGORIES = [
  { id: 'all',        name: 'Tất cả',        emoji: '🍽️' },
  { id: 'pho-bun',   name: 'Phở & Bún',     emoji: '🍜' },
  { id: 'com',       name: 'Cơm',            emoji: '🍚' },
  { id: 'nuong',     name: 'Nướng',          emoji: '🔥' },
  { id: 'do-uong',   name: 'Đồ uống',        emoji: '🥤' },
  { id: 'trang-miem',name: 'Tráng miệng',    emoji: '🍮' },
];

export const MENU_ITEMS: MenuItem[] = [
  {
    id: 'm1', name: 'Phở Bò Tái',
    description: 'Phở bò truyền thống với thịt bò tái mềm, hành lá, giá đỗ tươi',
    price: 65000,
    image: 'https://images.unsplash.com/photo-1597345637412-9fd611e758f3?w=400&q=80',
    categoryId: 'pho-bun', cookMinutes: 12, dailyLimit: 60, isBestseller: true,
    sizes: [{ label: 'Nhỏ', extraPrice: 0 }, { label: 'Vừa', extraPrice: 10000 }, { label: 'To', extraPrice: 20000 }],
    toppings: [
      { id: 'tp1', label: 'Thêm thịt bò', price: 25000 },
      { id: 'tp2', label: 'Thêm gân', price: 15000 },
      { id: 'tp3', label: 'Thêm trứng', price: 10000 },
      { id: 'tp4', label: 'Thêm hành phi', price: 5000 },
    ],
    available: true,
  },
  {
    id: 'm2', name: 'Bún Bò Huế',
    description: 'Bún bò Huế cay thơm đặc trưng, chả cua và thịt bò hầm mềm',
    price: 70000,
    image: 'https://images.unsplash.com/photo-1583316175701-0bc5f25a0a44?w=400&q=80',
    categoryId: 'pho-bun', cookMinutes: 15, dailyLimit: 50, isBestseller: true,
    sizes: [{ label: 'Vừa', extraPrice: 0 }, { label: 'To', extraPrice: 15000 }],
    toppings: [
      { id: 'tp5', label: 'Thêm chả cua', price: 20000 },
      { id: 'tp6', label: 'Thêm giò heo', price: 25000 },
      { id: 'tp7', label: 'Ít cay', price: 0 },
    ],
    available: true,
  },
  {
    id: 'm3', name: 'Bún Riêu Cua',
    description: 'Bún riêu cua đồng đậm đà với cà chua tươi và đậu hũ chiên vàng',
    price: 60000,
    image: 'https://images.unsplash.com/photo-1605311572312-a926afe51604?w=400&q=80',
    categoryId: 'pho-bun', cookMinutes: 14, dailyLimit: 45,
    sizes: [{ label: 'Vừa', extraPrice: 0 }, { label: 'To', extraPrice: 12000 }],
    toppings: [
      { id: 'tp8', label: 'Thêm chả', price: 15000 },
      { id: 'tp9', label: 'Thêm đậu hũ', price: 10000 },
    ],
    available: true,
  },
  {
    id: 'm4', name: 'Phở Gà',
    description: 'Phở gà ta ngọt thanh, thịt gà xé sợi mềm thơm, nước dùng trong',
    price: 60000,
    image: 'https://images.unsplash.com/photo-1731460202531-bf8389d565f7?w=400&q=80',
    categoryId: 'pho-bun', cookMinutes: 12, dailyLimit: 50,
    sizes: [{ label: 'Nhỏ', extraPrice: 0 }, { label: 'Vừa', extraPrice: 10000 }, { label: 'To', extraPrice: 18000 }],
    toppings: [
      { id: 'tp10', label: 'Thêm thịt gà', price: 20000 },
      { id: 'tp11', label: 'Thêm trứng', price: 10000 },
    ],
    available: true,
  },
  {
    id: 'm5', name: 'Cơm Sườn Nướng',
    description: 'Cơm tấm sườn nướng than hoa, bì chả, trứng ốp la, mỡ hành thơm',
    price: 75000,
    image: 'https://images.unsplash.com/photo-1562565652-a0d8f0c59eb4?w=400&q=80',
    categoryId: 'com', cookMinutes: 18, dailyLimit: 40, isBestseller: true,
    toppings: [
      { id: 'tp12', label: 'Thêm trứng', price: 10000 },
      { id: 'tp13', label: 'Thêm bì chả', price: 15000 },
      { id: 'tp14', label: 'Thêm sườn', price: 30000 },
    ],
    available: true,
  },
  {
    id: 'm6', name: 'Cơm Gà Xối Mỡ',
    description: 'Gà ta chiên vàng giòn, xối mỡ hành phi thơm phức, cơm dẻo mềm',
    price: 80000,
    image: 'https://images.unsplash.com/photo-1641440615059-42c8ed3af8c8?w=400&q=80',
    categoryId: 'com', cookMinutes: 18, dailyLimit: 35,
    toppings: [
      { id: 'tp15', label: 'Thêm trứng', price: 10000 },
      { id: 'tp16', label: 'Thêm rau', price: 8000 },
    ],
    available: true,
  },
  {
    id: 'm7', name: 'Cơm Bò Lúc Lắc',
    description: 'Thịt bò thăn xào lúc lắc tiêu xanh thơm, ăn kèm cơm trắng dẻo',
    price: 95000,
    image: 'https://images.unsplash.com/photo-1672858502422-ab27ac933910?w=400&q=80',
    categoryId: 'com', cookMinutes: 15, dailyLimit: 30, isNew: true,
    toppings: [
      { id: 'tp17', label: 'Thêm trứng', price: 10000 },
      { id: 'tp18', label: 'Thêm nấm', price: 15000 },
    ],
    available: true,
  },
  {
    id: 'm8', name: 'Sườn Nướng Mật Ong',
    description: 'Sườn heo nướng mật ong thơm ngon, kèm rau sống và tương đặc biệt',
    price: 120000,
    image: 'https://images.unsplash.com/photo-1568376794508-ae52c6ab3929?w=400&q=80',
    categoryId: 'nuong', cookMinutes: 25, dailyLimit: 25, isBestseller: true,
    toppings: [
      { id: 'tp19', label: 'Thêm sốt BBQ', price: 10000 },
      { id: 'tp20', label: 'Phần lớn', price: 40000 },
    ],
    available: true,
  },
  {
    id: 'm9', name: 'Gà Nướng Muối Ớt',
    description: 'Gà ta nướng muối ớt xanh, da giòn vàng, thịt mềm ngọt tự nhiên',
    price: 135000,
    image: 'https://images.unsplash.com/photo-1708388464878-5df2d66b758e?w=400&q=80',
    categoryId: 'nuong', cookMinutes: 30, dailyLimit: 20,
    toppings: [
      { id: 'tp21', label: 'Thêm sốt', price: 10000 },
      { id: 'tp22', label: 'Ít cay', price: 0 },
    ],
    available: true,
  },
  {
    id: 'm10', name: 'Mực Nướng Sa Tế',
    description: 'Mực ống tươi nướng than sa tế cay, dai ngọt đậm đà hương biển',
    price: 150000,
    image: 'https://images.unsplash.com/photo-1631100732613-6b65da9a343d?w=400&q=80',
    categoryId: 'nuong', cookMinutes: 22, dailyLimit: 18, isNew: true,
    toppings: [
      { id: 'tp23', label: 'Thêm sa tế', price: 5000 },
      { id: 'tp24', label: 'Thêm chanh', price: 5000 },
    ],
    available: true,
  },
  {
    id: 'm11', name: 'Cà Phê Sữa Đá',
    description: 'Cà phê phin truyền thống đậm đặc, pha sữa đặc và đá viên mát lạnh',
    price: 35000,
    image: 'https://images.unsplash.com/photo-1509072619873-adb3dc289b50?w=400&q=80',
    categoryId: 'do-uong', cookMinutes: 5, dailyLimit: 100, isBestseller: true,
    sizes: [{ label: 'Vừa', extraPrice: 0 }, { label: 'To', extraPrice: 10000 }],
    toppings: [
      { id: 'tp25', label: 'Thêm sữa', price: 5000 },
      { id: 'tp26', label: 'Ít đá', price: 0 },
      { id: 'tp27', label: 'Không đá', price: 0 },
    ],
    available: true,
  },
  {
    id: 'm12', name: 'Trà Đào Cam Sả',
    description: 'Trà đào kết hợp cam tươi và sả thơm, thanh mát dịu ngọt',
    price: 45000,
    image: 'https://images.unsplash.com/photo-1640116309648-79c20583e1c9?w=400&q=80',
    categoryId: 'do-uong', cookMinutes: 6, dailyLimit: 80, isNew: true,
    sizes: [{ label: 'Vừa', extraPrice: 0 }, { label: 'To', extraPrice: 8000 }],
    toppings: [
      { id: 'tp28', label: 'Thêm thạch', price: 8000 },
      { id: 'tp29', label: 'Ít ngọt', price: 0 },
      { id: 'tp30', label: 'Ít đá', price: 0 },
    ],
    available: true,
  },
  {
    id: 'm13', name: 'Nước Ép Dưa Hấu',
    description: 'Dưa hấu đỏ tươi nguyên chất, mát lành, ngọt tự nhiên không đường',
    price: 40000,
    image: 'https://images.unsplash.com/photo-1657812538913-1da9218af26b?w=400&q=80',
    categoryId: 'do-uong', cookMinutes: 5, dailyLimit: 70,
    sizes: [{ label: 'Vừa', extraPrice: 0 }, { label: 'To', extraPrice: 10000 }],
    toppings: [
      { id: 'tp31', label: 'Không đá', price: 0 },
      { id: 'tp32', label: 'Thêm muối', price: 0 },
    ],
    available: true,
  },
  {
    id: 'm14', name: 'Chè Bà Ba',
    description: 'Chè truyền thống với đậu xanh, khoai lang, chuối chín, nước cốt dừa',
    price: 35000,
    image: 'https://images.unsplash.com/photo-1527997921830-de1cf1f9b430?w=400&q=80',
    categoryId: 'trang-miem', cookMinutes: 8, dailyLimit: 35, isBestseller: true,
    toppings: [
      { id: 'tp33', label: 'Thêm nước cốt dừa', price: 8000 },
      { id: 'tp34', label: 'Nóng', price: 0 },
    ],
    available: true,
  },
  {
    id: 'm15', name: 'Kem Dừa Sầu Riêng',
    description: 'Kem dừa béo ngậy kết hợp sầu riêng Ri6 tươi nguyên chất ngọt đậm',
    price: 55000,
    image: 'https://images.unsplash.com/photo-1672858502748-fb7dc81ef830?w=400&q=80',
    categoryId: 'trang-miem', cookMinutes: 7, dailyLimit: 30,
    toppings: [
      { id: 'tp35', label: 'Thêm sầu riêng', price: 20000 },
      { id: 'tp36', label: 'Thêm thạch', price: 8000 },
    ],
    available: true,
  },
];

export const INITIAL_TABLES: Table[] = [
  { id: 't1',  number: 1,  seats: 4, status: 'empty' },
  { id: 't2',  number: 2,  seats: 2, status: 'empty' },
  { id: 't3',  number: 3,  seats: 6, status: 'empty' },
  { id: 't4',  number: 4,  seats: 4, status: 'empty' },
  { id: 't5',  number: 5,  seats: 4, status: 'empty' },
  { id: 't6',  number: 6,  seats: 8, status: 'empty' },
  { id: 't7',  number: 7,  seats: 4, status: 'empty' },
  { id: 't8',  number: 8,  seats: 2, status: 'empty' },
  { id: 't9',  number: 9,  seats: 6, status: 'empty' },
  { id: 't10', number: 10, seats: 4, status: 'empty' },
  { id: 't11', number: 11, seats: 8, status: 'empty' },
  { id: 't12', number: 12, seats: 4, status: 'empty' },
];

export const INITIAL_TABLE_ORDERS: Record<string, CartItem[]> = {};
