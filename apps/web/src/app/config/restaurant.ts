import type { AppView, PaymentMethodId } from '../data';

export const BRAND_ASSETS = {
  mark: '/brand/CAS_mark.svg',
  icon: '/brand/CAS_app_icon_navy.svg',
  iconTeal: '/brand/CAS_app_icon_teal.svg',
  logoHorizontal: '/brand/CAS_logo_horizontal.svg',
  logoHorizontalWhite: '/brand/CAS_logo_horizontal_white_transparent.svg',
  logoStacked: '/brand/CAS_logo_stacked.svg',
};

export const APP_VIEW_LABELS: Record<AppView, string> = {
  order: 'Gọi món',
  overview: 'Tổng quan bàn',
  reservations: 'Đặt bàn trước',
  payment: 'Thanh toán',
  reports: 'Báo cáo vận hành',
  dashboard: 'Quản trị',
};

export const PAYMENT_METHOD_LABELS: Record<PaymentMethodId, string> = {
  cash: 'Tiền mặt',
  card: 'Thẻ',
  qr: 'QR Code',
};

export interface RestaurantSettings {
  restaurantName: string;
  legalName: string;
  tagline: string;
  address: string;
  phone: string;
  email: string;
  website: string;
  defaultArea: string;
  staffName: string;
  cashierName: string;
  customerName: string;
  guestCount: number;
  vatRate: number;
  serviceFeeRate: number;
  discountAmount: number;
  invoiceNote: string;
  activePaymentMethods: PaymentMethodId[];
  visibleDashboardWidgets: string[];
}

export const DASHBOARD_WIDGETS = [
  { id: 'revenue', label: 'Doanh thu' },
  { id: 'orders', label: 'Đơn hàng' },
  { id: 'paymentMix', label: 'Thanh toán' },
  { id: 'topItems', label: 'Món bán chạy' },
  { id: 'staff', label: 'Nhân viên' },
];

export const DEFAULT_RESTAURANT_SETTINGS: RestaurantSettings = {
  restaurantName: 'Nhà hàng CAS',
  legalName: 'Core Advanced Solutions',
  tagline: 'Giải pháp vận hành nhà hàng',
  address: '127 Nguyễn Văn Linh, Quận 7, TP. Hồ Chí Minh',
  phone: '0900 123 456',
  email: 'hello@cas.vn',
  website: 'cas.vn',
  defaultArea: 'Sảnh chính',
  staffName: 'Nhân viên phục vụ',
  cashierName: 'Thu ngân CAS',
  customerName: 'Khách lẻ',
  guestCount: 2,
  vatRate: 0.1,
  serviceFeeRate: 0.05,
  discountAmount: 0,
  invoiceNote: 'Cảm ơn quý khách. Hẹn gặp lại!',
  activePaymentMethods: ['cash', 'card', 'qr'],
  visibleDashboardWidgets: DASHBOARD_WIDGETS.map(widget => widget.id),
};

/** Bổ sung giá trị mặc định và ép kiểu dữ liệu settings trả về từ API. */
export function normalizeSettings(settings: Partial<RestaurantSettings> | null | undefined): RestaurantSettings {
  const merged = {
    ...DEFAULT_RESTAURANT_SETTINGS,
    ...(settings ?? {}),
  };

  return {
    ...merged,
    guestCount: Number.isFinite(Number(merged.guestCount)) ? Number(merged.guestCount) : DEFAULT_RESTAURANT_SETTINGS.guestCount,
    vatRate: Number.isFinite(Number(merged.vatRate)) ? Number(merged.vatRate) : DEFAULT_RESTAURANT_SETTINGS.vatRate,
    serviceFeeRate: Number.isFinite(Number(merged.serviceFeeRate)) ? Number(merged.serviceFeeRate) : DEFAULT_RESTAURANT_SETTINGS.serviceFeeRate,
    discountAmount: Number.isFinite(Number(merged.discountAmount)) ? Number(merged.discountAmount) : DEFAULT_RESTAURANT_SETTINGS.discountAmount,
    activePaymentMethods: merged.activePaymentMethods?.length
      ? merged.activePaymentMethods
      : DEFAULT_RESTAURANT_SETTINGS.activePaymentMethods,
    visibleDashboardWidgets: merged.visibleDashboardWidgets?.length
      ? merged.visibleDashboardWidgets
      : DEFAULT_RESTAURANT_SETTINGS.visibleDashboardWidgets,
  };
}

/** Công thức preview hóa đơn; backend sẽ tính lại cùng công thức khi thanh toán. */
export function calculateInvoiceTotals(subtotal: number, settings: RestaurantSettings) {
  const discount = Math.min(Math.max(settings.discountAmount, 0), subtotal);
  const taxableBase = Math.max(subtotal - discount, 0);
  const serviceFee = Math.round(taxableBase * Math.max(settings.serviceFeeRate, 0));
  const vat = Math.round((taxableBase + serviceFee) * Math.max(settings.vatRate, 0));
  const total = taxableBase + serviceFee + vat;

  return { subtotal, discount, serviceFee, vat, total };
}
