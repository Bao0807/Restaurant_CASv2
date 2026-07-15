import type { PaymentRecord } from './data';

export interface HourlyReportRow {
  hour: string;
  revenue: number;
  orders: number;
}

export interface StaffReportRow {
  key: string;
  employeeId?: string;
  name: string;
  revenue: number;
  orders: number;
  itemCount: number;
  averageBill: number;
}

/** Đủ 24 giờ để KPI và biểu đồ không lệch khi nhà hàng phục vụ qua đêm. */
export const REPORT_HOURS: HourlyReportRow[] = Array.from({ length: 24 }, (_, index) => ({
  hour: `${index}h`,
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

/** Xếp hạng hiệu suất theo hóa đơn đã thanh toán, giữ staffName làm snapshot lịch sử. */
export function buildStaffReport(payments: PaymentRecord[]): StaffReportRow[] {
  const grouped = payments.reduce<Record<string, Omit<StaffReportRow, 'averageBill'>>>((result, payment) => {
    const name = payment.staffName?.trim() || 'Chưa gán nhân viên';
    const key = payment.employeeId || `name:${name.toLocaleLowerCase('vi-VN')}`;
    const current = result[key] ?? {
      key,
      ...(payment.employeeId ? { employeeId: payment.employeeId } : {}),
      name,
      revenue: 0,
      orders: 0,
      itemCount: 0,
    };
    current.revenue += payment.total;
    current.orders += 1;
    current.itemCount += payment.itemCount;
    result[key] = current;
    return result;
  }, {});

  return Object.values(grouped)
    .map(row => ({ ...row, averageBill: row.orders ? Math.round(row.revenue / row.orders) : 0 }))
    .sort((left, right) => right.revenue - left.revenue || right.orders - left.orders || left.name.localeCompare(right.name, 'vi'));
}
