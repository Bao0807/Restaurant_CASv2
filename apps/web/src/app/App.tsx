import { lazy, Suspense, useEffect, useState } from 'react';
import {
  AppView, OrderStep, Table, CartItem, PaymentRecord,
  INITIAL_TABLES, INITIAL_TABLE_ORDERS, CATEGORIES, MENU_ITEMS,
  type KitchenStatus, type MenuCategory, type MenuItem,
  formatVND,
} from './data';
import {
  APP_VIEW_LABELS, BRAND_ASSETS, DEFAULT_RESTAURANT_SETTINGS,
  type RestaurantSettings,
} from './config/restaurant';
import {
  ApiError,
  authenticate,
  bootstrapCatalog,
  checkApiSession,
  clearApiCredentials,
  deleteOrder,
  fetchCatalog,
  fetchOperations,
  fetchPayments,
  fetchRestaurantSettings,
  recordPayment,
  saveOrder,
  saveRestaurantSettings,
  updateTableStatus,
} from './services/api';
import { BottomNav } from './components/BottomNav';
import { TableSelectStep } from './components/TableSelectStep';
import { LoginPage } from './components/LoginPage';

const MenuStep = lazy(() => import('./components/MenuStep').then(module => ({ default: module.MenuStep })));
const OrderConfirmStep = lazy(() => import('./components/OrderConfirmStep').then(module => ({ default: module.OrderConfirmStep })));
const OrderSuccessStep = lazy(() => import('./components/OrderSuccessStep').then(module => ({ default: module.OrderSuccessStep })));
const OverviewPage = lazy(() => import('./components/OverviewPage').then(module => ({ default: module.OverviewPage })));
const PaymentPage = lazy(() => import('./components/PaymentPage').then(module => ({ default: module.PaymentPage })));
const DashboardPage = lazy(() => import('./components/DashboardPage').then(module => ({ default: module.DashboardPage })));

export default function App() {
  const [view, setView] = useState<AppView>('order');
  const [orderStep, setOrderStep] = useState<OrderStep>('tables');
  const [selectedTableId, setSelectedTableId] = useState<string | null>(null);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [tables, setTables] = useState<Table[]>(INITIAL_TABLES);
  const [tableOrders, setTableOrders] = useState<Record<string, CartItem[]>>(INITIAL_TABLE_ORDERS);
  const [lastOrderNumber, setLastOrderNumber] = useState('');
  const [restaurantSettings, setRestaurantSettings] = useState<RestaurantSettings>(DEFAULT_RESTAURANT_SETTINGS);
  const [completedPayments, setCompletedPayments] = useState<PaymentRecord[]>([]);
  const [kitchen, setKitchen] = useState<KitchenStatus>({ concurrency: 2, cookingCount: 0, waitingCount: 0, staleCount: 0, staleAfterMinutes: 120, automationEnabled: true, paused: false });
  const [categories, setCategories] = useState<MenuCategory[]>(CATEGORIES.filter(category => category.id !== 'all'));
  const [menuItems, setMenuItems] = useState<MenuItem[]>(MENU_ITEMS);
  const [settingsStatus, setSettingsStatus] = useState<'idle' | 'loading' | 'saving' | 'saved' | 'error'>('loading');
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' | 'info' } | null>(null);
  const [authStatus, setAuthStatus] = useState<'checking' | 'required' | 'authenticated'>('checking');
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [bootstrapStatus, setBootstrapStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  /** Hiển thị phản hồi ngắn sau thao tác mà không chặn luồng người dùng. */
  const showToast = (msg: string, type: 'success' | 'error' | 'info' = 'info') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 2800);
  };

  useEffect(() => {
    let mounted = true;

    checkApiSession()
      .then(() => { if (mounted) setAuthStatus('authenticated'); })
      .catch(error => {
        if (!mounted) return;
        if (error instanceof ApiError && error.status === 401) {
          clearApiCredentials();
          setAuthStatus('required');
          return;
        }
        setLoginError(error instanceof Error ? error.message : 'Không thể kết nối API.');
        setAuthStatus('required');
      });

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (authStatus !== 'authenticated') return;
    let mounted = true;
    setBootstrapStatus('loading');
    setBootstrapError(null);
    setSettingsStatus('loading');

    const catalogRequest = fetchCatalog().then(catalog => (
      catalog.items.length > 0 ? catalog : bootstrapCatalog(CATEGORIES, MENU_ITEMS)
    ));
    Promise.all([
      fetchRestaurantSettings(),
      fetchOperations(),
      fetchPayments(),
      catalogRequest,
    ])
      .then(([settings, operations, payments, catalog]) => {
        if (!mounted) return;
        setRestaurantSettings(settings);
        setTables(operations.tables);
        setTableOrders(operations.tableOrders);
        setKitchen(operations.kitchen);
        setCompletedPayments(payments);
        setCategories(catalog.categories);
        setMenuItems(catalog.items);
        setSettingsStatus('saved');
        setBootstrapStatus('ready');
      })
      .catch(error => {
        if (!mounted) return;
        if (error instanceof ApiError && error.status === 401) {
          clearApiCredentials();
          setAuthStatus('required');
          setLoginError('Phiên đăng nhập không còn hợp lệ.');
          return;
        }
        setSettingsStatus('error');
        setBootstrapError(error instanceof Error ? error.message : 'Không thể tải dữ liệu vận hành.');
        setBootstrapStatus('error');
      });

    return () => { mounted = false; };
  }, [authStatus, reloadKey]);

  useEffect(() => {
    if (authStatus !== 'authenticated' || bootstrapStatus !== 'ready') return;
    let stopped = false;
    let refreshing = false;

    /** Đồng bộ trạng thái bàn/queue; khóa cục bộ ngăn hai lần polling chồng nhau. */
    const refresh = async () => {
      if (refreshing || document.visibilityState === 'hidden') return;
      refreshing = true;
      try {
        const operations = await fetchOperations();
        if (!stopped) {
          setTables(operations.tables);
          setTableOrders(operations.tableOrders);
          setKitchen(operations.kitchen);
        }
      } catch (error) {
        if (!stopped && error instanceof ApiError && error.status === 401) {
          clearApiCredentials();
          setAuthStatus('required');
          setLoginError('Phiên đăng nhập không còn hợp lệ.');
        }
      } finally {
        refreshing = false;
      }
    };

    const timer = window.setInterval(() => { void refresh(); }, 3_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [authStatus, bootstrapStatus]);

  const handleLogin = async (username: string, password: string) => {
    setLoginBusy(true);
    setLoginError(null);
    try {
      await authenticate(username, password);
      setAuthStatus('authenticated');
      setReloadKey(key => key + 1);
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : 'Đăng nhập thất bại.');
    } finally {
      setLoginBusy(false);
    }
  };

  const selectedTable = tables.find(t => t.id === selectedTableId) ?? null;

  /* ─── Order Flow ─── */
  const handleSelectTable = (tableId: string) => {
    setSelectedTableId(tableId);
    // Pre-fill cart with existing order if any
    const existing = tableOrders[tableId];
    setCart(existing ? existing.map(i => ({ ...i, cartId: i.cartId })) : []);
    setOrderStep('menu');
  };

  const handleBackToTables = () => {
    setSelectedTableId(null);
    setCart([]);
    setOrderStep('tables');
  };

  /** Lưu order ở server rồi tải lại snapshot queue đã được điều phối. */
  const handlePlaceOrder = async () => {
    if (!selectedTableId || cart.length === 0) return;
    try {
      const saved = await saveOrder(selectedTableId, cart);
      const operations = await fetchOperations();
      setLastOrderNumber(String(saved.orderNumber).padStart(4, '0'));
      setTableOrders(operations.tableOrders);
      setTables(operations.tables);
      setKitchen(operations.kitchen);
      setCart(saved.items);
      setOrderStep('success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Không thể lưu order', 'error');
      throw error;
    }
  };

  /* ─── Overview Actions ─── */
  const handleOverviewStartOrder = (tableId: string) => {
    setSelectedTableId(tableId);
    const existing = tableOrders[tableId];
    setCart(existing ? [...existing] : []);
    setOrderStep('menu');
    setView('order');
  };

  const handleDeleteOrder = async (tableId: string) => {
    const table = tables.find(t => t.id === tableId);
    if (table?.status === 'cooking') {
      showToast('Không thể hủy khi bàn đang nấu!', 'error');
      return;
    }
    try {
      await deleteOrder(tableId);
      const operations = await fetchOperations();
      setTableOrders(operations.tableOrders);
      setTables(operations.tables);
      setKitchen(operations.kitchen);
      showToast('Đã hủy order', 'info');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Không thể hủy order', 'error');
    }
  };

  const handleMarkDone = async (tableId: string) => {
    try {
      await updateTableStatus(tableId, 'done');
      const operations = await fetchOperations();
      setTableOrders(operations.tableOrders);
      setTables(operations.tables);
      setKitchen(operations.kitchen);
      showToast('Đã hoàn thành; queue đang lấy order kế tiếp', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Không thể đổi trạng thái bàn', 'error');
    }
  };

  /* ─── Payment ─── */
  /** Ghi thanh toán theo transaction server và chỉ giải phóng bàn khi thành công. */
  const handleProcessPayment = async (payment: PaymentRecord, _items: CartItem[]): Promise<PaymentRecord> => {
    try {
      const savedPayment = await recordPayment(payment);
      const operations = await fetchOperations();
      setTableOrders(operations.tableOrders);
      setTables(operations.tables);
      setKitchen(operations.kitchen);
      setCompletedPayments(prev => [savedPayment, ...prev.filter(item => item.invoiceCode !== savedPayment.invoiceCode)].slice(0, 100));
      showToast(`Thanh toán ${formatVND(savedPayment.total)} thành công`, 'success');
      return savedPayment;
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Không thể ghi nhận thanh toán', 'error');
      throw error;
    }
  };

  const handleSaveSettings = async (next: RestaurantSettings) => {
    setRestaurantSettings(next);
    setSettingsStatus('saving');

    try {
      const saved = await saveRestaurantSettings(next);
      setRestaurantSettings(saved);
      setSettingsStatus('saved');
      showToast('Đã lưu cấu hình nhà hàng', 'success');
      setTimeout(() => setSettingsStatus('idle'), 1800);
    } catch (error) {
      console.warn('Không thể lưu cấu hình vào API.', error);
      setSettingsStatus('error');
      showToast('Đã cập nhật giao diện, chưa lưu được vào MySQL', 'error');
    }
  };

  const refreshManagementData = async () => {
    const [operations, catalog] = await Promise.all([fetchOperations(), fetchCatalog()]);
    setTables(operations.tables);
    setTableOrders(operations.tableOrders);
    setKitchen(operations.kitchen);
    setCategories(catalog.categories);
    setMenuItems(catalog.items);
  };

  /* ─── View Change ─── */
  const handleViewChange = (v: AppView) => {
    setView(v);
    if (v !== 'order') {
      // Reset order flow when navigating away
      setOrderStep('tables');
      setSelectedTableId(null);
      setCart([]);
    }
  };

  const toastColors = {
    success: { bg: '#ECFDF5', border: '#6EE7B7', text: '#065F46' },
    error:   { bg: '#FEF2F2', border: '#FECACA', text: '#991B1B' },
    info:    { bg: '#EFF6FF', border: '#BFDBFE', text: '#1E40AF' },
  };

  if (authStatus === 'required') {
    return <LoginPage busy={loginBusy} error={loginError} onLogin={handleLogin} />;
  }

  if (authStatus === 'checking' || bootstrapStatus === 'idle' || bootstrapStatus === 'loading') {
    return (
      <main style={{ minHeight: '100dvh', background: '#0F172A', display: 'grid', placeItems: 'center', color: '#E5E7EB' }}>
        <div role="status" style={{ textAlign: 'center' }}>
          <img src={BRAND_ASSETS.logoHorizontalWhite} alt="CAS" style={{ width: 140, marginBottom: 16 }} />
          <div>Đang đồng bộ dữ liệu vận hành…</div>
        </div>
      </main>
    );
  }

  if (bootstrapStatus === 'error') {
    return (
      <main style={{ minHeight: '100dvh', background: '#F9FAFB', display: 'grid', placeItems: 'center', padding: 24 }}>
        <div role="alert" style={{ maxWidth: 420, textAlign: 'center', background: '#fff', padding: 28, borderRadius: 18, border: '1px solid #FECACA' }}>
          <h1 style={{ color: '#991B1B', fontSize: 20 }}>Không thể tải dữ liệu POS</h1>
          <p style={{ color: '#6B7280' }}>{bootstrapError}</p>
          <button onClick={() => setReloadKey(key => key + 1)} style={{ border: 0, borderRadius: 10, padding: '11px 18px', background: '#0D9488', color: '#fff', fontWeight: 800, cursor: 'pointer' }}>
            Thử lại
          </button>
        </div>
      </main>
    );
  }

  return (
    <div className="cas-app-shell" style={{ display: 'flex', flexDirection: 'column', height: '100dvh', background: '#F9FAFB', overflow: 'hidden', width: '100%', maxWidth: 1440, margin: '0 auto', position: 'relative' }}>
      {/* Top Bar */}
      <header className="cas-topbar" style={{
        background: '#111827', padding: '11px 16px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        flexShrink: 0, boxShadow: '0 1px 0 rgba(255,255,255,0.05)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, minWidth: 0 }}>
          <div style={{ width: 42, height: 42, borderRadius: 12, background: '#0F172A', border: '1px solid rgba(45,212,191,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <img src={BRAND_ASSETS.mark} alt="CAS" style={{ width: 28, height: 28 }} />
          </div>
          <div style={{ minWidth: 0 }}>
            <img src={BRAND_ASSETS.logoHorizontalWhite} alt="CAS" style={{ display: 'block', width: 96, height: 24, objectFit: 'contain', marginBottom: 1 }} />
            <div style={{ color: '#E5E7EB', fontWeight: 700, fontSize: '12px', letterSpacing: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 230 }}>
              {restaurantSettings.restaurantName}
            </div>
            <div style={{ color: '#6B7280', fontSize: '11px' }}>
              {APP_VIEW_LABELS[view]}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ textAlign: 'right' }}>
            <div style={{ color: '#9CA3AF', fontSize: '11px' }}>
              {new Date().toLocaleDateString('vi-VN', { weekday: 'short', day: '2-digit', month: '2-digit' })}
            </div>
            <div style={{ color: '#F97316', fontSize: '12px', fontWeight: 600 }}>
              {tables.filter(t => t.status !== 'empty').length}/{tables.length} bàn
            </div>
          </div>
        </div>
      </header>

      {/* Breadcrumb for order flow */}
      {view === 'order' && orderStep !== 'tables' && (
        <div style={{
          background: '#fff', padding: '8px 16px', borderBottom: '1px solid #F3F4F6',
          display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0,
        }}>
          {(['tables', 'menu', 'confirm', 'success'] as OrderStep[]).map((step, idx, arr) => {
            const labels: Record<OrderStep, string> = {
              tables: 'Chọn bàn', menu: 'Chọn món', confirm: 'Xác nhận', success: 'Hoàn thành',
            };
            const stepIdx = arr.indexOf(orderStep);
            const isActive = step === orderStep;
            const isDone = arr.indexOf(step) < stepIdx;
            return (
              <div key={step} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 4,
                  padding: '2px 8px', borderRadius: 20,
                  background: isActive ? '#FFF7ED' : isDone ? '#ECFDF5' : 'transparent',
                }}>
                  <span style={{ fontSize: '14px' }}>
                    {isDone ? '✓' : idx + 1 + '.'}
                  </span>
                  <span style={{
                    fontSize: '11px', fontWeight: isActive ? 700 : 500,
                    color: isActive ? '#EA580C' : isDone ? '#059669' : '#9CA3AF',
                  }}>
                    {labels[step]}
                  </span>
                </div>
                {idx < arr.length - 1 && <span style={{ color: '#D1D5DB', fontSize: '11px' }}>›</span>}
              </div>
            );
          })}
        </div>
      )}

      {/* Main Content */}
      <main className="cas-main" style={{ flex: 1, overflow: 'hidden', position: 'relative', display: 'flex', flexDirection: 'column' }}>
        <Suspense fallback={<div role="status" style={{ padding: 24, color: '#6B7280' }}>Đang tải giao diện…</div>}>
        {view === 'order' && (
          <>
            {orderStep === 'tables' && (
              <div style={{ flex: 1, overflowY: 'auto' }}>
                <TableSelectStep
                  tables={tables}
                  tableOrders={tableOrders}
                  kitchen={kitchen}
                  onSelectTable={handleSelectTable}
                />
              </div>
            )}
            {orderStep === 'menu' && selectedTable && (
              <MenuStep
                table={selectedTable}
                cart={cart}
                categories={categories}
                menuItems={menuItems}
                onCartChange={setCart}
                onBack={handleBackToTables}
                onConfirm={() => setOrderStep('confirm')}
              />
            )}
            {orderStep === 'confirm' && selectedTable && (
              <OrderConfirmStep
                table={selectedTable}
                cart={cart}
                onCartChange={setCart}
                onBack={handleBackToTables}
                onEdit={() => setOrderStep('menu')}
                onPlaceOrder={handlePlaceOrder}
              />
            )}
            {orderStep === 'success' && selectedTable && (
              <OrderSuccessStep
                orderNumber={lastOrderNumber}
                table={selectedTable}
                cart={cart}
                onAddMore={() => setOrderStep('menu')}
                onDone={handleBackToTables}
              />
            )}
          </>
        )}

        {view === 'overview' && (
          <div style={{ flex: 1, overflowY: 'auto' }}>
            <OverviewPage
              tables={tables}
              tableOrders={tableOrders}
              onStartOrder={handleOverviewStartOrder}
              onDeleteOrder={handleDeleteOrder}
              onMarkDone={handleMarkDone}
            />
          </div>
        )}

        {view === 'payment' && (
          <div style={{ flex: 1, overflowY: 'auto' }}>
            <PaymentPage
              tables={tables}
              tableOrders={tableOrders}
              settings={restaurantSettings}
              onProcessPayment={handleProcessPayment}
            />
          </div>
        )}

        {view === 'reports' && (
          <div style={{ flex: 1, overflowY: 'auto' }}>
            <Suspense fallback={<div role="status" style={{ padding: 24, color: '#6B7280' }}>Đang tải báo cáo…</div>}>
              <DashboardPage
                mode="reports"
                tables={tables}
                tableOrders={tableOrders}
                payments={completedPayments}
                settings={restaurantSettings}
                settingsStatus={settingsStatus}
                categories={categories}
                menuItems={menuItems}
                kitchen={kitchen}
                onManagementChanged={refreshManagementData}
                onSettingsChange={setRestaurantSettings}
                onSaveSettings={handleSaveSettings}
              />
            </Suspense>
          </div>
        )}

        {view === 'dashboard' && (
          <div style={{ flex: 1, overflowY: 'auto' }}>
            <Suspense fallback={<div role="status" style={{ padding: 24, color: '#6B7280' }}>Đang tải dashboard…</div>}>
              <DashboardPage
                mode="admin"
                tables={tables}
                tableOrders={tableOrders}
                payments={completedPayments}
                settings={restaurantSettings}
                settingsStatus={settingsStatus}
                categories={categories}
                menuItems={menuItems}
                kitchen={kitchen}
                onManagementChanged={refreshManagementData}
                onSettingsChange={setRestaurantSettings}
                onSaveSettings={handleSaveSettings}
              />
            </Suspense>
          </div>
        )}
        </Suspense>
      </main>

      {/* Bottom Nav */}
      <BottomNav view={view} onViewChange={handleViewChange} />

      {/* Toast */}
      {toast && (
        <div role="status" aria-live="polite" style={{
          position: 'fixed', bottom: 80, left: '50%', transform: 'translateX(-50%)',
          zIndex: 200, background: toastColors[toast.type].bg,
          border: `1.5px solid ${toastColors[toast.type].border}`,
          color: toastColors[toast.type].text,
          padding: '10px 18px', borderRadius: 12, fontSize: '13px', fontWeight: 600,
          whiteSpace: 'nowrap', boxShadow: '0 4px 12px rgba(0,0,0,0.12)',
          animation: 'fadeInUp 0.2s ease',
        }}>
          {toast.msg}
        </div>
      )}

      <style>{`
        @keyframes fadeInUp {
          from { opacity: 0; transform: translateX(-50%) translateY(8px); }
          to { opacity: 1; transform: translateX(-50%) translateY(0); }
        }
        * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
        button { -webkit-tap-highlight-color: transparent; }
        ::-webkit-scrollbar { width: 0; height: 0; }
      `}</style>
    </div>
  );
}
