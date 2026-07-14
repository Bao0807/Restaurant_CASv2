import type { PaymentRecord } from './data';

export interface HourlyReportRow {
  hour: string;
  revenue: number;
  orders: number;
}

/** Các khung giờ phục vụ được hiển thị cố định để biểu đồ không bị nhảy cột. */
export const REPORT_HOURS: HourlyReportRow[] = Array.from({ length: 17 }, (_, index) => ({
  hour: `${index + 6}h`,
  revenue: 0,
  orders: 0,
}));

/** Lọc giao dịch theo ngày địa phương của thiết bị đang vận hành POS. */
export function paymentsForLocalDay(payments: PaymentRecord[], reference = new Date()): PaymentRecord[] {
  return payments.filter(payment => {
    const paidAt = new Date(payment.paidAt);
    return paidAt.getFullYear() === reference.getFullYear()
      && paidAt.getMonth() === reference.getMonth()
      && paidAt.getDate() === reference.getDate();
  });
}

/** Gom doanh thu và số hóa đơn của một ngày vào từng khung giờ báo cáo. */
export function buildHourlyReport(payments: PaymentRecord[]): HourlyReportRow[] {
  const grouped = payments.reduce<Record<string, { revenue: number; orders: number }>>((result, payment) => {
    const key = `${new Date(payment.paidAt).getHours()}h`;
    const current = result[key] ?? { revenue: 0, orders: 0 };
    current.revenue += payment.total;
    current.orders += 1;
    result[key] = current;
    return result;
  }, {});

  return REPORT_HOURS.map(row => ({
    ...row,
    revenue: grouped[row.hour]?.revenue ?? 0,
    orders: grouped[row.hour]?.orders ?? 0,
  }));
}
