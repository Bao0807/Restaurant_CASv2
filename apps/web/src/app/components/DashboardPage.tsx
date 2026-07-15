import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Banknote, Building2, CreditCard, QrCode, ReceiptText,
  Save, Settings, ShoppingBag, SlidersHorizontal, Users, WalletCards, Wrench,
} from 'lucide-react';
import type { CartItem, KitchenStatus, MenuCategory, MenuItem, PaymentMethodId, PaymentRecord, ReportSummary, Table } from '../data';
import { cartTotal, formatVND } from '../data';
import {
  BRAND_ASSETS, DASHBOARD_WIDGETS, DEFAULT_RESTAURANT_SETTINGS,
  PAYMENT_METHOD_LABELS, calculateInvoiceTotals, type RestaurantSettings,
} from '../config/restaurant';
import { buildHourlyReport, buildStaffReport, paymentsForLocalDay } from '../reporting';
import { fetchReportSummary } from '../services/api';

const ManagementPanel = lazy(() => import('./ManagementPanel').then(module => ({ default: module.ManagementPanel })));
const RevenueChart = lazy(() => import('./DashboardCharts').then(module => ({ default: module.RevenueChart })));
const OrdersChart = lazy(() => import('./DashboardCharts').then(module => ({ default: module.OrdersChart })));

type DashboardTab = 'reports' | 'management' | 'settings';
type SettingsStatus = 'idle' | 'loading' | 'saving' | 'saved' | 'error';

interface DashboardPageProps {
  mode: 'reports' | 'admin';
  tables: Table[];
  tableOrders: Record<string, CartItem[]>;
  payments: PaymentRecord[];
  settings: RestaurantSettings;
  settingsStatus: SettingsStatus;
  categories: MenuCategory[];
  menuItems: MenuItem[];
  kitchen: KitchenStatus;
  onManagementChanged: () => void | Promise<void>;
  onSettingsChange: (settings: RestaurantSettings) => void;
  onSaveSettings: (settings: RestaurantSettings) => void | Promise<void>;
}

const METHOD_META: Record<PaymentMethodId, { icon: ReactNode; color: string; bg: string }> = {
  cash: { icon: <Banknote size={16} />, color: '#15803D', bg: '#DCFCE7' },
  card: { icon: <CreditCard size={16} />, color: '#1D4ED8', bg: '#DBEAFE' },
  qr: { icon: <QrCode size={16} />, color: '#7C3AED', bg: '#EDE9FE' },
};

function formatShort(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}tỷ`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}tr`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

function SectionTitle({ title, sub }: { title: string; sub?: string }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontWeight: 800, color: '#111827', fontSize: '15px' }}>{title}</div>
      {sub && <div style={{ color: '#6B7280', fontSize: '12px', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function KpiCard({
  icon, label, value, sub, color,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  sub: string;
  color: string;
}) {
  return (
    <div style={{ background: '#fff', border: '1px solid #E5E7EB', borderRadius: 8, padding: 14, minWidth: 150, flex: '1 1 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ width: 36, height: 36, borderRadius: 8, background: `${color}18`, display: 'flex', alignItems: 'center', justifyContent: 'center', color }}>
          {icon}
        </div>
        <img src={BRAND_ASSETS.mark} alt="CAS" style={{ width: 18, height: 18, opacity: 0.45 }} />
      </div>
      <div style={{ fontSize: '20px', fontWeight: 900, color: '#111827', lineHeight: 1.1 }}>{value}</div>
      <div style={{ fontSize: '12px', color: '#374151', fontWeight: 700, marginTop: 5 }}>{label}</div>
      <div style={{ fontSize: '11px', color: '#9CA3AF', marginTop: 3 }}>{sub}</div>
    </div>
  );
}

const inputStyle = {
  width: '100%',
  border: '1px solid #D1D5DB',
  borderRadius: 8,
  padding: '10px 11px',
  fontSize: '13px',
  color: '#111827',
  background: '#fff',
} as const;

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontSize: '12px', fontWeight: 700, color: '#374151' }}>{label}</span>
      {children}
    </label>
  );
}

/** Chuyển map order theo bàn thành danh sách dòng món để tổng hợp báo cáo. */
function flattenOrders(tableOrders: Record<string, CartItem[]>): CartItem[] {
  return Object.values(tableOrders).flat();
}

export function DashboardPage({
  mode,
  tables,
  tableOrders,
  payments,
  settings,
  settingsStatus,
  categories,
  menuItems,
  kitchen,
  onManagementChanged,
  onSettingsChange,
  onSaveSettings,
}: DashboardPageProps) {
  const [tab, setTab] = useState<DashboardTab>(mode === 'reports' ? 'reports' : 'management');
  const [draft, setDraft] = useState<RestaurantSettings>(settings);
  const [reportSummary, setReportSummary] = useState<ReportSummary | null>(null);
  const [reportState, setReportState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');

  useEffect(() => {
    setDraft(settings);
  }, [settings]);
  useEffect(() => {
    setTab(mode === 'reports' ? 'reports' : 'management');
  }, [mode]);
  useEffect(() => {
    if (mode !== 'reports') return undefined;
    let active = true;
    const loadReport = async () => {
      if (document.visibilityState === 'hidden') return;
      const from = new Date();
      from.setHours(0, 0, 0, 0);
      const to = new Date(from);
      to.setDate(to.getDate() + 1);
      try {
        const summary = await fetchReportSummary(from, to);
        if (!active) return;
        setReportSummary(summary);
        setReportState('ready');
      } catch {
        if (active) setReportState('error');
      }
    };
    setReportState('loading');
    void loadReport();
    const timer = window.setInterval(() => { void loadReport(); }, 30_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [mode, payments.length, payments[0]?.invoiceCode]);

  const activeOrders = useMemo(() => flattenOrders(tableOrders), [tableOrders]);
  const todayPayments = useMemo(() => paymentsForLocalDay(payments), [payments]);
  const pendingTotal = useMemo(() => Object.values(tableOrders).reduce(
    (sum, order) => sum + calculateInvoiceTotals(cartTotal(order), settings).total,
    0,
  ), [settings, tableOrders]);
  const paidRevenue = reportSummary?.totals.revenue
    ?? todayPayments.reduce((sum, payment) => sum + payment.total, 0);
  const paidOrders = reportSummary?.totals.orders ?? todayPayments.length;
  const servingTables = tables.filter(table => ['waiting', 'cooking', 'done'].includes(table.status)).length;

  const hourlyData = useMemo(() => {
    if (!reportSummary) return buildHourlyReport(todayPayments);
    const byHour = new Map(reportSummary.hourly.map(row => [row.hour, row]));
    return Array.from({ length: 24 }, (_, hour) => ({
      hour: `${hour}h`,
      revenue: byHour.get(hour)?.revenue ?? 0,
      orders: byHour.get(hour)?.orders ?? 0,
    }));
  }, [reportSummary, todayPayments]);
  const staffPerformance = useMemo(() => {
    if (!reportSummary) return buildStaffReport(todayPayments);
    return reportSummary.staff.map(staff => ({
      ...staff,
      key: staff.employeeId || `name:${staff.name.toLocaleLowerCase('vi-VN')}`,
      averageBill: staff.orders ? Math.round(staff.revenue / staff.orders) : 0,
    }));
  }, [reportSummary, todayPayments]);

  const paymentMix = (['cash', 'card', 'qr'] as PaymentMethodId[]).map(method => {
    const aggregated = reportSummary?.paymentMethods.find(row => row.method === method);
    return {
      method,
      label: PAYMENT_METHOD_LABELS[method],
      amount: aggregated?.revenue
        ?? todayPayments.filter(payment => payment.method === method).reduce((sum, payment) => sum + payment.total, 0),
      count: aggregated?.orders ?? todayPayments.filter(payment => payment.method === method).length,
      ...METHOD_META[method],
    };
  });

  const topItems = reportSummary?.topItems.slice(0, 5) ?? [];
  const categoryRevenue = reportSummary?.categories ?? [];
  const categoryTotal = categoryRevenue.reduce((sum, category) => sum + category.revenue, 0);

  const updateDraft = <K extends keyof RestaurantSettings>(key: K, value: RestaurantSettings[K]) => {
    setDraft(prev => ({ ...prev, [key]: value }));
  };

  const togglePaymentMethod = (method: PaymentMethodId) => {
    setDraft(prev => {
      const exists = prev.activePaymentMethods.includes(method);
      if (exists && prev.activePaymentMethods.length === 1) return prev;

      return {
        ...prev,
        activePaymentMethods: exists
          ? prev.activePaymentMethods.filter(item => item !== method)
          : [...prev.activePaymentMethods, method],
      };
    });
  };

  const toggleWidget = (widgetId: string) => {
    setDraft(prev => ({
      ...prev,
      visibleDashboardWidgets: prev.visibleDashboardWidgets.includes(widgetId)
        ? prev.visibleDashboardWidgets.filter(item => item !== widgetId)
        : [...prev.visibleDashboardWidgets, widgetId],
    }));
  };

  const handleSave = () => {
    onSettingsChange(draft);
    void onSaveSettings(draft);
  };

  const resetDraft = () => setDraft(DEFAULT_RESTAURANT_SETTINGS);

  const widgetVisible = (id: string) => settings.visibleDashboardWidgets.includes(id);

  return (
    <div className={`dashboard-page dashboard-${mode}`} style={{ minHeight: '100%', background: '#F8FAFC' }}>
      <div style={{ background: '#fff', borderBottom: '1px solid #E5E7EB', padding: '16px 16px 0' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
            <div style={{ width: 42, height: 42, borderRadius: 10, background: '#0F172A', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <img src={BRAND_ASSETS.mark} alt="CAS" style={{ width: 27, height: 27 }} />
            </div>
            <div style={{ minWidth: 0 }}>
              <h1 style={{ margin: 0, color: '#111827', fontSize: '22px' }}>{mode === 'reports' ? 'Báo cáo vận hành' : 'Dashboard quản trị'}</h1>
              <p style={{ margin: '3px 0 0', color: '#6B7280', fontSize: '13px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {settings.restaurantName} · {new Date().toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' })}
              </p>
            </div>
          </div>
          <div style={{ background: settingsStatus === 'error' ? '#FEF2F2' : '#F0FDFA', color: settingsStatus === 'error' ? '#B91C1C' : '#0F766E', border: `1px solid ${settingsStatus === 'error' ? '#FECACA' : '#99F6E4'}`, borderRadius: 8, padding: '7px 10px', fontSize: '11px', fontWeight: 800 }}>
            {settingsStatus === 'saving' ? 'Đang lưu' : settingsStatus === 'saved' ? 'Đã đồng bộ' : settingsStatus === 'loading' ? 'Đang tải' : settingsStatus === 'error' ? 'Local' : 'Sẵn sàng'}
          </div>
        </div>

        {mode === 'admin' && <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
          {([
            { id: 'management', label: 'Vận hành', icon: <Wrench size={16} /> },
            { id: 'settings', label: 'Tùy chỉnh', icon: <SlidersHorizontal size={16} /> },
          ] as const).map(item => {
            const active = tab === item.id;
            return (
              <button
                key={item.id}
                data-dashboard-tab={item.id}
                onClick={() => setTab(item.id)}
                style={{
                  border: 'none',
                  borderBottom: active ? '3px solid #0D9488' : '3px solid transparent',
                  background: '#fff',
                  color: active ? '#0F766E' : '#6B7280',
                  padding: '9px 6px',
                  fontSize: '13px',
                  fontWeight: active ? 800 : 600,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 7,
                }}
              >
                {item.icon}
                {item.label}
              </button>
            );
          })}
        </div>}
      </div>

      {tab === 'reports' ? (
        <div className="dashboard-reports-page" style={{ padding: '14px 14px 96px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {reportState === 'error' && (
            <div role="status" style={{ padding: '10px 12px', border: '1px solid #FDE68A', background: '#FFFBEB', color: '#92400E', borderRadius: 8, fontSize: 12 }}>
              Chưa tải được API tổng hợp; các KPI cơ bản đang dùng danh sách hóa đơn gần nhất.
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {widgetVisible('revenue') && (
              <KpiCard
                icon={<WalletCards size={18} />}
                label="Doanh thu đã thu"
                value={formatShort(paidRevenue)}
                sub={`${paidOrders} giao dịch đã thanh toán`}
                color="#0D9488"
              />
            )}
            {widgetVisible('orders') && (
              <KpiCard
                icon={<ShoppingBag size={18} />}
                label="Dự thu đang phục vụ"
                value={formatShort(pendingTotal)}
                sub={`${activeOrders.reduce((sum, item) => sum + item.quantity, 0)} phần chưa thanh toán`}
                color="#EA580C"
              />
            )}
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <KpiCard
              icon={<Users size={18} />}
              label="Bàn đang dùng"
              value={`${servingTables}/${tables.length}`}
              sub={`${tables.length ? Math.round((servingTables / tables.length) * 100) : 0}% công suất bàn`}
              color="#2563EB"
            />
            <KpiCard
              icon={<ReceiptText size={18} />}
              label="Hóa đơn gần đây"
              value={todayPayments[0]?.invoiceCode ?? 'CAS'}
              sub={todayPayments[0] ? formatVND(todayPayments[0].total) : 'Chưa có giao dịch hôm nay'}
              color="#7C3AED"
            />
          </div>

          {widgetVisible('revenue') && (
            <div style={{ background: '#fff', border: '1px solid #E5E7EB', borderRadius: 8, padding: 16 }}>
              <SectionTitle title="Doanh thu theo giờ" sub={todayPayments.length ? 'Theo hóa đơn đã thanh toán hôm nay' : 'Chưa có giao dịch hôm nay'} />
              <Suspense fallback={<div style={{ height: 184 }} />}><RevenueChart data={hourlyData} /></Suspense>
            </div>
          )}

          {widgetVisible('paymentMix') && (
            <div style={{ background: '#fff', border: '1px solid #E5E7EB', borderRadius: 8, padding: 16 }}>
              <SectionTitle title="Phương thức thanh toán" sub={`${todayPayments.length} giao dịch hôm nay`} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {paymentMix.map(item => (
                  <div key={item.method}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                        <div style={{ width: 32, height: 32, borderRadius: 8, background: item.bg, color: item.color, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          {item.icon}
                        </div>
                        <div>
                          <div style={{ fontSize: '13px', fontWeight: 700, color: '#111827' }}>{item.label}</div>
                          <div style={{ fontSize: '11px', color: '#9CA3AF' }}>{item.count} giao dịch</div>
                        </div>
                      </div>
                      <div style={{ fontWeight: 800, color: item.color, fontSize: '13px' }}>{formatVND(item.amount)}</div>
                    </div>
                    <div style={{ height: 6, borderRadius: 999, background: '#F3F4F6', overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${paidRevenue ? Math.round((item.amount / paidRevenue) * 100) : 0}%`, background: item.color }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 14 }}>
            {widgetVisible('topItems') && (
              <div style={{ background: '#fff', border: '1px solid #E5E7EB', borderRadius: 8, padding: 16 }}>
                <SectionTitle title="Món bán chạy" sub="Tính theo món trên hóa đơn đã thanh toán hôm nay" />
                {reportState === 'loading' && <div role="status" style={{ color: '#64748B', fontSize: 13, padding: '14px 0' }}>Đang tổng hợp dữ liệu món…</div>}
                {reportState !== 'loading' && topItems.length === 0 && <div style={{ color: '#9CA3AF', fontSize: 13, padding: '14px 0' }}>Chưa có món đã thanh toán hôm nay.</div>}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                  {topItems.map((item, index) => (
                    <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0', borderBottom: index < topItems.length - 1 ? '1px solid #F3F4F6' : 'none' }}>
                      <div style={{ width: 28, height: 28, borderRadius: 8, background: index === 0 ? '#0D9488' : '#F3F4F6', color: index === 0 ? '#fff' : '#6B7280', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: '12px' }}>
                        {index + 1}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: '13px', color: '#111827', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.name}</div>
                        <div style={{ fontSize: '11px', color: '#9CA3AF', marginTop: 2 }}>{item.quantity} phần đã thanh toán</div>
                      </div>
                      <div style={{ fontSize: '13px', color: '#0D9488', fontWeight: 800 }}>{formatShort(item.revenue)}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {widgetVisible('orders') && (
              <div style={{ background: '#fff', border: '1px solid #E5E7EB', borderRadius: 8, padding: 16 }}>
                <SectionTitle title="Số đơn theo giờ" sub="Nhịp phục vụ trong ngày" />
                <Suspense fallback={<div style={{ height: 140 }} />}><OrdersChart data={hourlyData} /></Suspense>
              </div>
            )}
          </div>

          {widgetVisible('staff') && (
            <div style={{ background: '#fff', border: '1px solid #E5E7EB', borderRadius: 8, padding: 16 }}>
              <SectionTitle title="Hiệu suất nhân viên" sub={`${staffPerformance.length} nhân viên có giao dịch hôm nay`} />
              {staffPerformance.length === 0 ? (
                <div style={{ color: '#9CA3AF', fontSize: 13, padding: '14px 0' }}>Chưa có hóa đơn thanh toán hôm nay để tính hiệu suất.</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  {staffPerformance.map((staff, index) => (
                    <div key={staff.key} style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', padding: '12px 0', borderBottom: index < staffPerformance.length - 1 ? '1px solid #F3F4F6' : 'none', minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: '1 1 180px' }}>
                        <div style={{ width: 34, height: 34, borderRadius: 10, background: index === 0 ? '#CCFBF1' : '#F3F4F6', color: index === 0 ? '#0F766E' : '#64748B', display: 'grid', placeItems: 'center', fontWeight: 900, flexShrink: 0 }}>{index + 1}</div>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ color: '#111827', fontSize: 13, fontWeight: 800, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{staff.name}</div>
                          <div style={{ color: '#9CA3AF', fontSize: 11, marginTop: 2 }}>{staff.itemCount} phần đã phục vụ</div>
                        </div>
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8, flex: '1 1 240px', minWidth: 0 }}>
                        <div><div style={{ color: '#9CA3AF', fontSize: 9, textTransform: 'uppercase' }}>Hóa đơn</div><strong style={{ color: '#334155', fontSize: 12 }}>{staff.orders}</strong></div>
                        <div><div style={{ color: '#9CA3AF', fontSize: 9, textTransform: 'uppercase' }}>TB / đơn</div><strong style={{ color: '#334155', fontSize: 12 }}>{formatShort(staff.averageBill)}</strong></div>
                        <div style={{ textAlign: 'right', minWidth: 0 }}><div style={{ color: '#9CA3AF', fontSize: 9, textTransform: 'uppercase' }}>Doanh thu</div><strong style={{ color: '#0F766E', fontSize: 12, whiteSpace: 'nowrap' }}>{formatShort(staff.revenue)}</strong></div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div style={{ background: '#fff', border: '1px solid #E5E7EB', borderRadius: 8, padding: 16 }}>
            <SectionTitle title="Danh mục doanh thu" sub="Giá trị món trước giảm giá, phí dịch vụ và thuế" />
            {reportState === 'loading' && <div role="status" style={{ color: '#64748B', fontSize: 13, padding: '14px 0' }}>Đang tổng hợp danh mục…</div>}
            {reportState !== 'loading' && categoryRevenue.length === 0 && <div style={{ color: '#9CA3AF', fontSize: 13, padding: '14px 0' }}>Chưa có món đã thanh toán hôm nay.</div>}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {categoryRevenue.map(category => {
                const percentage = categoryTotal ? Math.round((category.revenue / categoryTotal) * 100) : 0;
                return (
                  <div key={category.id}>
                    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, marginBottom: 6 }}>
                      <div style={{ minWidth: 0 }}>
                        <strong style={{ color: '#111827', fontSize: 13 }}>{category.name}</strong>
                        <span style={{ color: '#94A3B8', fontSize: 11, marginLeft: 7 }}>{category.quantity} phần</span>
                      </div>
                      <div style={{ color: '#0F766E', fontSize: 12, fontWeight: 800, whiteSpace: 'nowrap' }}>{formatVND(category.revenue)} · {percentage}%</div>
                    </div>
                    <div style={{ height: 7, background: '#F1F5F9', borderRadius: 999, overflow: 'hidden' }}>
                      <div style={{ width: `${percentage}%`, height: '100%', borderRadius: 999, background: 'linear-gradient(90deg, #0D9488, #2DD4BF)' }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      ) : tab === 'management' ? (
        <Suspense fallback={<div role="status" style={{ padding: 24, color: '#64748B' }}>Đang tải công cụ vận hành…</div>}>
          <ManagementPanel
            tables={tables}
            categories={categories}
            menuItems={menuItems}
            kitchen={kitchen}
            onChanged={onManagementChanged}
          />
        </Suspense>
      ) : (
        <div className="dashboard-settings-page" style={{ padding: '14px 14px 96px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="dashboard-settings-card dashboard-brand-card" style={{ background: '#fff', border: '1px solid #E5E7EB', borderRadius: 8, padding: 16 }}>
            <SectionTitle title="Thương hiệu" sub="Thông tin hiển thị trên app và hóa đơn" />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 12 }}>
              <Field label="Tên nhà hàng">
                <input style={inputStyle} value={draft.restaurantName} onChange={event => updateDraft('restaurantName', event.target.value)} />
              </Field>
              <Field label="Tên pháp lý">
                <input style={inputStyle} value={draft.legalName} onChange={event => updateDraft('legalName', event.target.value)} />
              </Field>
              <Field label="Tagline">
                <input style={inputStyle} value={draft.tagline} onChange={event => updateDraft('tagline', event.target.value)} />
              </Field>
              <Field label="Địa chỉ">
                <input style={inputStyle} value={draft.address} onChange={event => updateDraft('address', event.target.value)} />
              </Field>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <Field label="Hotline">
                  <input style={inputStyle} value={draft.phone} onChange={event => updateDraft('phone', event.target.value)} />
                </Field>
                <Field label="Website">
                  <input style={inputStyle} value={draft.website} onChange={event => updateDraft('website', event.target.value)} />
                </Field>
              </div>
              <Field label="Email">
                <input style={inputStyle} value={draft.email} onChange={event => updateDraft('email', event.target.value)} />
              </Field>
            </div>
          </div>

          <div className="dashboard-settings-card" style={{ background: '#fff', border: '1px solid #E5E7EB', borderRadius: 8, padding: 16 }}>
            <SectionTitle title="Hóa đơn" sub="Giá trị mặc định khi in cho khách" />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 12 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <Field label="Khu vực">
                  <input style={inputStyle} value={draft.defaultArea} onChange={event => updateDraft('defaultArea', event.target.value)} />
                </Field>
                <Field label="Số khách">
                  <input style={inputStyle} type="number" min={1} value={draft.guestCount} onChange={event => updateDraft('guestCount', Number(event.target.value))} />
                </Field>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <Field label="Phục vụ">
                  <input style={inputStyle} value={draft.staffName} onChange={event => updateDraft('staffName', event.target.value)} />
                </Field>
                <Field label="Thu ngân">
                  <input style={inputStyle} value={draft.cashierName} onChange={event => updateDraft('cashierName', event.target.value)} />
                </Field>
              </div>
              <Field label="Khách hàng">
                <input style={inputStyle} value={draft.customerName} onChange={event => updateDraft('customerName', event.target.value)} />
              </Field>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
                <Field label="VAT (%)">
                  <input style={inputStyle} type="number" min={0} value={Math.round(draft.vatRate * 100)} onChange={event => updateDraft('vatRate', Number(event.target.value) / 100)} />
                </Field>
                <Field label="Phí DV (%)">
                  <input style={inputStyle} type="number" min={0} value={Math.round(draft.serviceFeeRate * 100)} onChange={event => updateDraft('serviceFeeRate', Number(event.target.value) / 100)} />
                </Field>
                <Field label="Giảm giá">
                  <input style={inputStyle} type="number" min={0} value={draft.discountAmount} onChange={event => updateDraft('discountAmount', Number(event.target.value))} />
                </Field>
              </div>
              <Field label="Ghi chú">
                <textarea style={{ ...inputStyle, minHeight: 72, resize: 'vertical' }} value={draft.invoiceNote} onChange={event => updateDraft('invoiceNote', event.target.value)} />
              </Field>
            </div>
          </div>

          <div className="dashboard-settings-card" style={{ background: '#fff', border: '1px solid #E5E7EB', borderRadius: 8, padding: 16 }}>
            <SectionTitle title="Thanh toán" sub="Phương thức được phép chọn" />
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
              {(['cash', 'card', 'qr'] as PaymentMethodId[]).map(method => {
                const active = draft.activePaymentMethods.includes(method);
                const meta = METHOD_META[method];
                return (
                  <button
                    key={method}
                    onClick={() => togglePaymentMethod(method)}
                    style={{
                      border: active ? `2px solid ${meta.color}` : '2px solid #E5E7EB',
                      background: active ? meta.bg : '#fff',
                      borderRadius: 8,
                      padding: '12px 8px',
                      color: active ? meta.color : '#6B7280',
                      cursor: 'pointer',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      gap: 6,
                      fontWeight: 800,
                      fontSize: '12px',
                    }}
                  >
                    {meta.icon}
                    {PAYMENT_METHOD_LABELS[method]}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="dashboard-settings-card" style={{ background: '#fff', border: '1px solid #E5E7EB', borderRadius: 8, padding: 16 }}>
            <SectionTitle title="Widget dashboard" sub="Các khối hiển thị trong báo cáo" />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {DASHBOARD_WIDGETS.map(widget => {
                const active = draft.visibleDashboardWidgets.includes(widget.id);
                return (
                  <button
                    key={widget.id}
                    onClick={() => toggleWidget(widget.id)}
                    style={{
                      border: active ? '1.5px solid #0D9488' : '1.5px solid #E5E7EB',
                      background: active ? '#F0FDFA' : '#fff',
                      color: active ? '#0F766E' : '#6B7280',
                      borderRadius: 8,
                      padding: '10px 12px',
                      textAlign: 'left',
                      cursor: 'pointer',
                      fontSize: '12px',
                      fontWeight: 800,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                    }}
                  >
                    <Settings size={14} />
                    {widget.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="dashboard-brand-preview" style={{ background: '#0F172A', borderRadius: 8, padding: 14, display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 44, height: 44, borderRadius: 8, background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <img src={BRAND_ASSETS.mark} alt="CAS" style={{ width: 30, height: 30 }} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ color: '#fff', fontSize: '14px', fontWeight: 900, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{draft.restaurantName}</div>
              <div style={{ color: '#94A3B8', fontSize: '12px', marginTop: 2 }}>{draft.phone} · {draft.website}</div>
            </div>
            <Building2 size={22} color="#2DD4BF" />
          </div>

          <div className="dashboard-settings-actions" style={{ display: 'flex', gap: 10 }}>
            <button
              onClick={resetDraft}
              style={{ flex: 1, border: '1.5px solid #D1D5DB', background: '#fff', color: '#374151', borderRadius: 8, padding: '13px 12px', fontSize: '13px', fontWeight: 800, cursor: 'pointer' }}
            >
              Mặc định
            </button>
            <button
              onClick={handleSave}
              disabled={settingsStatus === 'saving'}
              style={{ flex: 2, border: 'none', background: '#0D9488', color: '#fff', borderRadius: 8, padding: '13px 12px', fontSize: '13px', fontWeight: 900, cursor: settingsStatus === 'saving' ? 'wait' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
            >
              <Save size={17} />
              {settingsStatus === 'saving' ? 'Đang lưu' : 'Lưu cấu hình'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
