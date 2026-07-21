import type { PaymentRecord, ReportSummary } from './data';

export type ReportPeriod = 'day' | 'week' | 'month';

export interface ReportRange {
  from: Date;
  to: Date;
  label: string;
  contextLabel: string;
}

export interface ReportTimelineRow {
  key: string;
  label: string;
  detail: string;
  revenue: number | null;
  orders: number | null;
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

interface BuildReportTimelineOptions {
  period: ReportPeriod;
  from: Date;
  to: Date;
  payments?: PaymentRecord[];
  summary?: Pick<ReportSummary, 'hourly' | 'daily'> | null;
  now?: Date;
}

interface Aggregate {
  revenue: number;
  orders: number;
}

const WEEKDAY_SHORT = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
const WEEKDAY_LONG = ['Chủ nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];

const pad2 = (value: number) => String(value).padStart(2, '0');

const formatReportDate = (date: Date) => date.toLocaleDateString('vi-VN', {
  day: '2-digit', month: '2-digit', year: 'numeric',
});

function startOfLocalDay(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function addLocalDays(value: Date, amount: number): Date {
  const result = new Date(value);
  result.setDate(result.getDate() + amount);
  return result;
}

function localDateKey(value: Date): string {
  return `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`;
}

function shortDate(value: Date): string {
  return `${pad2(value.getDate())}/${pad2(value.getMonth() + 1)}`;
}

function fullDate(value: Date): string {
  return `${shortDate(value)}/${value.getFullYear()}`;
}

/** Tạo khoảng [from, to) theo giờ địa phương để khớp bộ lọc của API báo cáo. */
export function buildReportRange(period: ReportPeriod, reference = new Date()): ReportRange {
  const from = startOfLocalDay(reference);

  if (period === 'week') {
    const dayFromMonday = (from.getDay() + 6) % 7;
    from.setDate(from.getDate() - dayFromMonday);
  } else if (period === 'month') {
    from.setDate(1);
  }

  const to = new Date(from);
  if (period === 'day') to.setDate(to.getDate() + 1);
  else if (period === 'week') to.setDate(to.getDate() + 7);
  else to.setMonth(to.getMonth() + 1);

  const inclusiveTo = addLocalDays(to, -1);
  const label = period === 'day'
    ? reference.toLocaleDateString('vi-VN', {
      weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric',
    })
    : period === 'week'
      ? `Tuần ${formatReportDate(from)} – ${formatReportDate(inclusiveTo)}`
      : `Tháng ${pad2(from.getMonth() + 1)}/${from.getFullYear()}`;

  return {
    from,
    to,
    label,
    contextLabel: period === 'day' ? 'trong ngày' : period === 'week' ? 'trong tuần' : 'trong tháng',
  };
}

/** Giá trị cho date/month input; không dùng toISOString để tránh lệch ngày theo múi giờ. */
export function reportReferenceInputValue(period: ReportPeriod, reference: Date): string {
  const yearMonth = `${reference.getFullYear()}-${pad2(reference.getMonth() + 1)}`;
  return period === 'month' ? yearMonth : `${yearMonth}-${pad2(reference.getDate())}`;
}

/** Đọc date/month input thành ngày địa phương và từ chối ngày bị JavaScript tự cuộn tháng. */
export function parseReportReferenceInput(period: ReportPeriod, value: string): Date | null {
  const match = period === 'month'
    ? /^(\d{4})-(\d{2})$/.exec(value)
    : /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const day = period === 'month' ? 1 : Number(match[3]);
  const result = new Date(year, monthIndex, day);
  if (
    result.getFullYear() !== year
    || result.getMonth() !== monthIndex
    || result.getDate() !== day
  ) return null;
  return result;
}

/** Dịch đúng một kỳ lịch, tránh lỗi 31/01 cộng một tháng thành tháng 03. */
export function shiftReportReference(reference: Date, period: ReportPeriod, amount: number): Date {
  const result = startOfLocalDay(reference);
  if (period === 'day') result.setDate(result.getDate() + amount);
  else if (period === 'week') result.setDate(result.getDate() + amount * 7);
  else {
    result.setDate(1);
    result.setMonth(result.getMonth() + amount);
  }
  return result;
}

function aggregatePaymentsByHour(payments: PaymentRecord[], from: Date, to: Date): Map<number, Aggregate> {
  const result = new Map<number, Aggregate>();
  payments.forEach(payment => {
    const paidAt = new Date(payment.paidAt);
    if (paidAt < from || paidAt >= to) return;
    const hour = paidAt.getHours();
    const current = result.get(hour) ?? { revenue: 0, orders: 0 };
    current.revenue += payment.total;
    current.orders += 1;
    result.set(hour, current);
  });
  return result;
}

function aggregatePaymentsByDay(payments: PaymentRecord[], from: Date, to: Date): Map<string, Aggregate> {
  const result = new Map<string, Aggregate>();
  payments.forEach(payment => {
    const paidAt = new Date(payment.paidAt);
    if (paidAt < from || paidAt >= to) return;
    const key = localDateKey(paidAt);
    const current = result.get(key) ?? { revenue: 0, orders: 0 };
    current.revenue += payment.total;
    current.orders += 1;
    result.set(key, current);
  });
  return result;
}

function hourlyAggregates(options: BuildReportTimelineOptions): Map<number, Aggregate> {
  if (!options.summary) return aggregatePaymentsByHour(options.payments ?? [], options.from, options.to);
  return new Map(options.summary.hourly.map(row => [row.hour, {
    revenue: Number(row.revenue) || 0,
    orders: Number(row.orders) || 0,
  }]));
}

function dailyAggregates(options: BuildReportTimelineOptions): Map<string, Aggregate> {
  if (!options.summary) return aggregatePaymentsByDay(options.payments ?? [], options.from, options.to);
  return new Map(options.summary.daily.map(row => [row.date, {
    revenue: Number(row.revenue) || 0,
    orders: Number(row.orders) || 0,
  }]));
}

/** Ngày dùng giờ, tuần dùng ngày và tháng dùng tuần lịch để trục X đúng cấp độ quản trị. */
export function buildReportTimeline(options: BuildReportTimelineOptions): ReportTimelineRow[] {
  const { period } = options;
  const from = startOfLocalDay(options.from);
  const to = startOfLocalDay(options.to);
  const now = options.now ?? new Date();

  if (period === 'day') {
    const byHour = hourlyAggregates(options);
    return Array.from({ length: 24 }, (_, hour) => {
      const bucketStart = new Date(from);
      bucketStart.setHours(hour);
      const aggregate = byHour.get(hour) ?? { revenue: 0, orders: 0 };
      const isFuture = bucketStart > now;
      return {
        key: `${localDateKey(from)}T${pad2(hour)}`,
        label: `${pad2(hour)}h`,
        detail: `${pad2(hour)}:00–${pad2(hour)}:59 · ${fullDate(from)}`,
        revenue: isFuture ? null : aggregate.revenue,
        orders: isFuture ? null : aggregate.orders,
      };
    });
  }

  const byDay = dailyAggregates(options);
  if (period === 'week') {
    const rows: ReportTimelineRow[] = [];
    for (let cursor = from; cursor < to; cursor = addLocalDays(cursor, 1)) {
      const aggregate = byDay.get(localDateKey(cursor)) ?? { revenue: 0, orders: 0 };
      const isFuture = cursor > now;
      rows.push({
        key: localDateKey(cursor),
        label: `${WEEKDAY_SHORT[cursor.getDay()]} ${shortDate(cursor)}`,
        detail: `${WEEKDAY_LONG[cursor.getDay()]}, ${fullDate(cursor)}`,
        revenue: isFuture ? null : aggregate.revenue,
        orders: isFuture ? null : aggregate.orders,
      });
    }
    return rows;
  }

  const rows: ReportTimelineRow[] = [];
  for (let cursor = from; cursor < to;) {
    const bucketStart = new Date(cursor);
    const dayFromMonday = (bucketStart.getDay() + 6) % 7;
    const nextMonday = addLocalDays(bucketStart, 7 - dayFromMonday);
    const bucketEndExclusive = nextMonday < to ? nextMonday : new Date(to);
    const bucketEnd = addLocalDays(bucketEndExclusive, -1);
    let revenue = 0;
    let orders = 0;

    for (let day = bucketStart; day < bucketEndExclusive; day = addLocalDays(day, 1)) {
      const aggregate = byDay.get(localDateKey(day));
      revenue += aggregate?.revenue ?? 0;
      orders += aggregate?.orders ?? 0;
    }

    const isFuture = bucketStart > now;
    const isCurrentPartial = !isFuture && now < bucketEndExclusive && startOfLocalDay(now) <= bucketEnd;
    const label = bucketStart.getTime() === bucketEnd.getTime()
      ? shortDate(bucketStart)
      : `${pad2(bucketStart.getDate())}–${shortDate(bucketEnd)}`;
    rows.push({
      key: `week:${localDateKey(bucketStart)}`,
      label,
      detail: `Tuần ${fullDate(bucketStart)} – ${fullDate(bucketEnd)}${isCurrentPartial ? ` · đến ${fullDate(now)}` : ''}`,
      revenue: isFuture ? null : revenue,
      orders: isFuture ? null : orders,
    });
    cursor = bucketEndExclusive;
  }
  return rows;
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
