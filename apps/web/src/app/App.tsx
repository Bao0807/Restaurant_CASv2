import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { LogOut, UserRound } from 'lucide-react';
import {
  AppView, OrderStep, Table, CartItem, PaymentRecord,
  INITIAL_TABLES, INITIAL_TABLE_ORDERS, CATEGORIES, MENU_ITEMS,
  type KitchenStatus, type MenuCategory, type MenuItem, type Reservation,
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
  synchronizeServerClock,
  updateTableStatus,
  updateWaitingOrderBatch,
  type EditableOrderBatch,
  type SavedOrderBatch,
} from './services/api';
import { BottomNav } from './components/BottomNav';
import { TableSelectStep } from './components/TableSelectStep';
import { canDeleteWaitingOrder } from './components/TableOptionsModal';
import { LoginPage } from './components/LoginPage';

const MenuStep = lazy(() => import('./components/MenuStep').then(module => ({ default: module.MenuStep })));
const OrderConfirmStep = lazy(() => import('./components/OrderConfirmStep').then(module => ({ default: module.OrderConfirmStep })));
const OrderSuccessStep = lazy(() => import('./components/OrderSuccessStep').then(module => ({ default: module.OrderSuccessStep })));
const OverviewPage = lazy(() => import('./components/OverviewPage').then(module => ({ default: module.OverviewPage })));
const ReservationsPage = lazy(() => import('./components/ReservationsPage').then(module => ({ default: module.ReservationsPage })));
const PaymentPage = lazy(() => import('./components/PaymentPage').then(module => ({ default: module.PaymentPage })));
const DashboardPage = lazy(() => import('./components/DashboardPage').then(module => ({ default: module.DashboardPage })));

type OrderMode = 'new' | 'addition' | 'edit';

interface AppNavigationState {
  casNavigation: true;
  view: AppView;
  orderStep: OrderStep;
  selectedTableId: string | null;
  orderMode: OrderMode;
  editingBatchId: number | null;
}

type OperationsSnapshot = Awaited<ReturnType<typeof fetchOperations>>;

function isAppNavigationState(value: unknown): value is AppNavigationState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Partial<AppNavigationState>;
  return state.casNavigation === true
    && ['order', 'overview', 'reservations', 'payment', 'reports', 'dashboard'].includes(state.view ?? '')
    && ['tables', 'menu', 'confirm', 'success'].includes(state.orderStep ?? '')
    && ['new', 'addition', 'edit'].includes(state.orderMode ?? '');
}

export default function App() {
  const [view, setView] = useState<AppView>('order');
  const [orderStep, setOrderStep] = useState<OrderStep>('tables');
  const [selectedTableId, setSelectedTableId] = useState<string | null>(null);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [tables, setTables] = useState<Table[]>(INITIAL_TABLES);
  const [tableOrders, setTableOrders] = useState<Record<string, CartItem[]>>(INITIAL_TABLE_ORDERS);
  const [waitingBatchesByTable, setWaitingBatchesByTable] = useState<Record<string, EditableOrderBatch[]>>({});
  const [lastOrderNumber, setLastOrderNumber] = useState('');
  const [lastOrderBatch, setLastOrderBatch] = useState<SavedOrderBatch | null>(null);
  const [orderMode, setOrderMode] = useState<OrderMode>('new');
  const [editingBatchId, setEditingBatchId] = useState<number | null>(null);
  const [restaurantSettings, setRestaurantSettings] = useState<RestaurantSettings>(DEFAULT_RESTAURANT_SETTINGS);
  const [completedPayments, setCompletedPayments] = useState<PaymentRecord[]>([]);
  const [kitchen, setKitchen] = useState<KitchenStatus>({ concurrency: 2, cookingCount: 0, waitingCount: 0, staleCount: 0, staleBatches: [], staleAfterMinutes: 120, automationEnabled: true, paused: false, version: 1 });
  const [categories, setCategories] = useState<MenuCategory[]>(CATEGORIES.filter(category => category.id !== 'all'));
  const [menuItems, setMenuItems] = useState<MenuItem[]>(MENU_ITEMS);
  const [settingsStatus, setSettingsStatus] = useState<'idle' | 'loading' | 'saving' | 'saved' | 'error'>('loading');
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' | 'info' } | null>(null);
  const [authStatus, setAuthStatus] = useState<'checking' | 'required' | 'authenticated'>('checking');
  const [authenticatedUsername, setAuthenticatedUsername] = useState('');
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [bootstrapStatus, setBootstrapStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [operationsSyncStatus, setOperationsSyncStatus] = useState<'online' | 'stale'>('online');
  const [lastOperationsSyncAt, setLastOperationsSyncAt] = useState<Date | null>(null);
  const historyReadyRef = useRef(false);
  const operationsRequestSequenceRef = useRef(0);
  const lastAppliedOperationsSequenceRef = useRef(0);
  const lastOperationsSnapshotRef = useRef<OperationsSnapshot | null>(null);

  /** Chỉ áp dụng snapshot mới hơn snapshot gần nhất, tránh poll cũ ghi đè mutation vừa lưu. */
  const applyOperationsSnapshot = useCallback((operations: OperationsSnapshot, sequence: number) => {
    if (sequence < lastAppliedOperationsSequenceRef.current) return false;
    lastAppliedOperationsSequenceRef.current = sequence;
    lastOperationsSnapshotRef.current = operations;
    synchronizeServerClock(operations.serverClockOffsetMs);
    setTables(operations.tables);
    setTableOrders(operations.tableOrders);
    setWaitingBatchesByTable(operations.waitingBatchesByTable);
    setKitchen(operations.kitchen);
    setOperationsSyncStatus('online');
    setLastOperationsSyncAt(new Date());
    return true;
  }, []);

  const refreshOperationsSnapshot = useCallback(async () => {
    const sequence = ++operationsRequestSequenceRef.current;
    try {
      const operations = await fetchOperations();
      const applied = applyOperationsSnapshot(operations, sequence);
      return applied ? operations : (lastOperationsSnapshotRef.current ?? operations);
    } catch (error) {
      // Một request cũ thất bại sau khi snapshot mới đã áp dụng không được hạ trạng thái đồng bộ.
      if (sequence < lastAppliedOperationsSequenceRef.current && lastOperationsSnapshotRef.current) {
        return lastOperationsSnapshotRef.current;
      }
      throw error;
    }
  }, [applyOperationsSnapshot]);

  /** Hiển thị phản hồi ngắn sau thao tác mà không chặn luồng người dùng. */
  const showToast = (msg: string, type: 'success' | 'error' | 'info' = 'info') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 2800);
  };

  /** Ghi một mốc điều hướng SPA để Back/Forward khôi phục đúng trang và bước order. */
  const navigate = (
    overrides: Partial<Omit<AppNavigationState, 'casNavigation'>>,
    method: 'push' | 'replace' = 'push',
  ) => {
    const next: AppNavigationState = {
      casNavigation: true,
      view,
      orderStep,
      selectedTableId,
      orderMode,
      editingBatchId,
      ...overrides,
    };

    if (method === 'replace') window.history.replaceState(next, '');
    else window.history.pushState(next, '');

    historyReadyRef.current = true;
    setView(next.view);
    setOrderStep(next.orderStep);
    setSelectedTableId(next.selectedTableId);
    setOrderMode(next.orderMode);
    setEditingBatchId(next.editingBatchId);
  };

  useEffect(() => {
    if (authStatus !== 'authenticated' || bootstrapStatus !== 'ready' || historyReadyRef.current) return;

    const stored = window.history.state;
    if (isAppNavigationState(stored)) {
      const tableExists = !stored.selectedTableId || tables.some(table => table.id === stored.selectedTableId);
      const requiresTable = stored.view === 'order' && stored.orderStep !== 'tables';
      const hasStaleReceipt = stored.orderStep === 'success';
      const next = (requiresTable && !tableExists) || hasStaleReceipt
        ? { ...stored, orderStep: 'tables' as const, selectedTableId: null, orderMode: 'new' as const, editingBatchId: null }
        : stored;

      setView(next.view);
      setOrderStep(next.orderStep);
      setSelectedTableId(next.selectedTableId);
      setOrderMode(next.orderMode);
      setEditingBatchId(next.editingBatchId);
      if (next.orderMode === 'edit' && next.editingBatchId !== null && next.selectedTableId) {
        const batch = waitingBatchesByTable[next.selectedTableId]?.find(item => item.batchId === next.editingBatchId);
        if (batch) setCart(batch.items);
      }
      window.history.replaceState(next, '');
    } else {
      window.history.replaceState({
        casNavigation: true,
        view,
        orderStep,
        selectedTableId,
        orderMode,
        editingBatchId,
      } satisfies AppNavigationState, '');
    }
    historyReadyRef.current = true;
  }, [authStatus, bootstrapStatus, editingBatchId, orderMode, orderStep, selectedTableId, tables, view, waitingBatchesByTable]);

  useEffect(() => {
    const handlePopState = (event: PopStateEvent) => {
      if (!isAppNavigationState(event.state)) return;

      let next = event.state;
      const requiresTable = next.view === 'order' && next.orderStep !== 'tables';
      const tableExists = Boolean(next.selectedTableId && tables.some(table => table.id === next.selectedTableId));
      if (requiresTable && !tableExists) {
        next = { ...next, orderStep: 'tables', selectedTableId: null, orderMode: 'new', editingBatchId: null };
        window.history.replaceState(next, '');
      }

      if (next.orderMode === 'edit' && next.editingBatchId !== null && next.selectedTableId) {
        const batch = waitingBatchesByTable[next.selectedTableId]?.find(item => item.batchId === next.editingBatchId);
        if (!batch) {
          next = { ...next, orderStep: 'tables', selectedTableId: null, orderMode: 'new', editingBatchId: null };
          window.history.replaceState(next, '');
          setToast({ msg: 'Phiếu này không còn ở trạng thái chờ để sửa.', type: 'info' });
        } else if (orderMode !== 'edit' || editingBatchId !== next.editingBatchId) {
          setCart(batch.items);
        }
      }

      setView(next.view);
      setOrderStep(next.orderStep);
      setSelectedTableId(next.selectedTableId);
      setOrderMode(next.orderMode);
      setEditingBatchId(next.editingBatchId);
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [editingBatchId, orderMode, tables, waitingBatchesByTable]);

  useEffect(() => {
    let mounted = true;

    checkApiSession()
      .then(session => {
        if (!mounted) return;
        setAuthenticatedUsername(session.username);
        setAuthStatus('authenticated');
      })
      .catch(error => {
        if (!mounted) return;
        if (error instanceof ApiError && error.status === 401) {
          clearApiCredentials();
          setAuthenticatedUsername('');
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
    const operationsSequence = ++operationsRequestSequenceRef.current;
    Promise.all([
      fetchRestaurantSettings(),
      fetchOperations(),
      fetchPayments(),
      catalogRequest,
    ])
      .then(([settings, operations, payments, catalog]) => {
        if (!mounted) return;
        setRestaurantSettings(settings);
        applyOperationsSnapshot(operations, operationsSequence);
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
          setAuthenticatedUsername('');
          setAuthStatus('required');
          setLoginError('Phiên đăng nhập không còn hợp lệ.');
          return;
        }
        setSettingsStatus('error');
        setBootstrapError(error instanceof Error ? error.message : 'Không thể tải dữ liệu vận hành.');
        setBootstrapStatus('error');
      });

    return () => { mounted = false; };
  }, [applyOperationsSnapshot, authStatus, reloadKey]);

  useEffect(() => {
    if (authStatus !== 'authenticated' || bootstrapStatus !== 'ready') return;
    let stopped = false;
    let refreshing = false;

    /** Đồng bộ trạng thái bàn/queue; khóa cục bộ ngăn hai lần polling chồng nhau. */
    const refresh = async () => {
      if (refreshing || document.visibilityState === 'hidden') return;
      refreshing = true;
      try {
        await refreshOperationsSnapshot();
      } catch (error) {
        if (!stopped && error instanceof ApiError && error.status === 401) {
          clearApiCredentials();
          setAuthenticatedUsername('');
          setAuthStatus('required');
          setLoginError('Phiên đăng nhập không còn hợp lệ.');
        } else if (!stopped) {
          setOperationsSyncStatus('stale');
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
  }, [authStatus, bootstrapStatus, refreshOperationsSnapshot]);

  useEffect(() => {
    if (
      bootstrapStatus !== 'ready'
      || orderMode !== 'edit'
      || (orderStep !== 'menu' && orderStep !== 'confirm')
      || !selectedTableId
      || editingBatchId === null
    ) return;

    const remainsWaiting = waitingBatchesByTable[selectedTableId]?.some(batch => batch.batchId === editingBatchId);
    if (remainsWaiting) return;

    const next: AppNavigationState = {
      casNavigation: true,
      view: 'order',
      orderStep: 'tables',
      selectedTableId: null,
      orderMode: 'new',
      editingBatchId: null,
    };
    window.history.replaceState(next, '');
    setOrderStep('tables');
    setSelectedTableId(null);
    setOrderMode('new');
    setEditingBatchId(null);
    setCart([]);
    showToast('Phiếu đã được bếp nhận nấu nên không thể tiếp tục sửa.', 'info');
  }, [bootstrapStatus, editingBatchId, orderMode, orderStep, selectedTableId, waitingBatchesByTable]);

  const handleLogin = async (username: string, password: string) => {
    setLoginBusy(true);
    setLoginError(null);
    try {
      await authenticate(username, password);
      setAuthenticatedUsername(username);
      setAuthStatus('authenticated');
      setReloadKey(key => key + 1);
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : 'Đăng nhập thất bại.');
    } finally {
      setLoginBusy(false);
    }
  };

  /** Xóa credential của tab và quay lại màn đăng nhập mà không reload toàn trang. */
  const handleLogout = () => {
    clearApiCredentials();
    setAuthenticatedUsername('');
    setLoginError(null);
    setAuthStatus('required');
    setBootstrapStatus('idle');
    setView('order');
    setOrderStep('tables');
    setSelectedTableId(null);
    setOrderMode('new');
    setEditingBatchId(null);
    setCart([]);
    window.history.replaceState({
      casNavigation: true,
      view: 'order',
      orderStep: 'tables',
      selectedTableId: null,
      orderMode: 'new',
      editingBatchId: null,
    } satisfies AppNavigationState, '');
    historyReadyRef.current = false;
  };

  const selectedTable = tables.find(t => t.id === selectedTableId) ?? null;

  /* ─── Order Flow ─── */
  const handleStartOrder = (tableId: string) => {
    const hasExistingOrder = Boolean(tableOrders[tableId]?.length);
    // Gọi thêm luôn bắt đầu bằng giỏ rỗng để tạo một phiếu bếp riêng.
    setCart([]);
    navigate({
      view: 'order',
      orderStep: 'menu',
      selectedTableId: tableId,
      orderMode: hasExistingOrder ? 'addition' : 'new',
      editingBatchId: null,
    });
  };

  const handleEditWaitingOrder = (tableId: string, batchId: number) => {
    const batch = waitingBatchesByTable[tableId]?.find(item => item.batchId === batchId);
    if (!batch) {
      showToast('Phiếu này không còn ở trạng thái chờ để sửa.', 'error');
      return;
    }

    setCart(batch.items.map(item => ({
      ...item,
      selectedSize: item.selectedSize ? { ...item.selectedSize } : undefined,
      selectedToppings: item.selectedToppings.map(topping => ({ ...topping })),
    })));
    navigate({
      view: 'order',
      orderStep: 'menu',
      selectedTableId: tableId,
      orderMode: 'edit',
      editingBatchId: batchId,
    });
  };

  const handleBrowserBack = () => {
    if (isAppNavigationState(window.history.state) && orderStep !== 'tables') {
      window.history.back();
      return;
    }
    navigate({ orderStep: 'tables', selectedTableId: null, orderMode: 'new', editingBatchId: null });
  };

  const handleFinishOrder = () => {
    setCart([]);
    navigate({ view: 'order', orderStep: 'tables', selectedTableId: null, orderMode: 'new', editingBatchId: null });
  };

  /** Lưu order ở server rồi tải lại snapshot queue đã được điều phối. */
  const handlePlaceOrder = async () => {
    if (!selectedTableId || cart.length === 0) return;
    try {
      if (orderMode === 'edit' && editingBatchId === null) {
        throw new Error('Không xác định được phiếu chờ cần sửa.');
      }
      const saved = orderMode === 'edit'
        ? await updateWaitingOrderBatch(selectedTableId, editingBatchId!, cart)
        : await saveOrder(selectedTableId, cart, orderMode === 'addition');
      await refreshOperationsSnapshot();
      setLastOrderNumber(String(saved.orderNumber).padStart(4, '0'));
      setLastOrderBatch(saved);
      setCart(saved.items);
      // Thay mốc xác nhận bằng thành công để Back không gửi trùng cùng một phiếu.
      navigate({ orderStep: 'success' }, 'replace');
    } catch (error) {
      showToast(error instanceof Error ? error.message : orderMode === 'edit' ? 'Không thể cập nhật phiếu chờ' : 'Không thể lưu phiếu gọi món', 'error');
      throw error;
    }
  };

  const handleDeleteOrder = async (tableId: string) => {
    const table = tables.find(t => t.id === tableId);
    if (!table || !canDeleteWaitingOrder(table, Boolean(tableOrders[tableId]?.length))) {
      const error = new Error('Chỉ có thể hủy khi toàn bộ lượt gọi còn đang chờ.');
      showToast(error.message, 'error');
      throw error;
    }
    try {
      await deleteOrder(tableId);
      await refreshOperationsSnapshot();
      showToast('Đã hủy phiếu gọi món', 'info');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Không thể hủy phiếu gọi món', 'error');
      throw error;
    }
  };

  const handleMarkDone = async (tableId: string) => {
    try {
      const expectedBatchId = tables.find(table => table.id === tableId)?.cookingBatchId;
      if (!expectedBatchId) throw new Error('Phiếu đang nấu đã thay đổi. Hãy tải lại trạng thái bàn.');
      await updateTableStatus(tableId, 'done', expectedBatchId);
      await refreshOperationsSnapshot();
      showToast('Đã hoàn thành; bếp đang nhận phiếu tiếp theo', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Không thể đổi trạng thái bàn', 'error');
      throw error;
    }
  };

  /* ─── Payment ─── */
  /** Ghi thanh toán theo transaction server và chỉ giải phóng bàn khi thành công. */
  const handleProcessPayment = async (payment: PaymentRecord, _items: CartItem[]): Promise<PaymentRecord> => {
    try {
      const savedPayment = await recordPayment(payment);
      await refreshOperationsSnapshot();
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
    const [, catalog] = await Promise.all([refreshOperationsSnapshot(), fetchCatalog()]);
    setCategories(catalog.categories);
    setMenuItems(catalog.items);
  };

  /** Đồng bộ lịch trên sơ đồ bàn mà không tải lại catalog. */
  const refreshReservationOperations = async () => {
    return refreshOperationsSnapshot();
  };

  /** Sau check-in, mở thẳng menu của đúng bàn và vẫn tôn trọng order đang tồn tại. */
  const handleOpenReservationOrder = async (reservation: Reservation) => {
    if (!reservation.tableId) throw new Error('Lịch đặt bàn không còn liên kết với bàn.');
    const operations = await refreshReservationOperations();
    const table = operations.tables.find(row => row.id === reservation.tableId);
    if (!table) throw new Error('Không tìm thấy bàn của lịch đặt.');
    setCart([]);
    navigate({
      view: 'order',
      orderStep: 'menu',
      selectedTableId: table.id,
      orderMode: operations.tableOrders[table.id]?.length ? 'addition' : 'new',
      editingBatchId: null,
    });
  };

  /* ─── View Change ─── */
  const handleViewChange = (v: AppView) => {
    if (v === view) return;
    navigate({ view: v });
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
    <div className="cas-app-shell" style={{ display: 'flex', flexDirection: 'column', height: '100dvh', background: '#F9FAFB', overflow: 'hidden', width: '100vw', position: 'relative' }}>
      {/* Top Bar */}
      <header className="cas-topbar" style={{
        background: '#111827', padding: '11px 16px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        flexShrink: 0, boxShadow: '0 1px 0 rgba(255,255,255,0.05)',
      }}>
        <div className="cas-topbar-brand" aria-label={`${restaurantSettings.restaurantName} · ${APP_VIEW_LABELS[view]}`}>
          <img className="cas-topbar-logo" src={BRAND_ASSETS.logoHorizontalWhite} alt="CAS" />
          <span className="cas-topbar-context">{APP_VIEW_LABELS[view]}</span>
        </div>
        <div className="cas-topbar-meta">
          <span
            className="cas-sync-indicator"
            data-status={operationsSyncStatus}
            title={operationsSyncStatus === 'online'
              ? `Đồng bộ lần cuối ${lastOperationsSyncAt?.toLocaleTimeString('vi-VN') ?? 'vừa xong'}`
              : 'Không thể làm mới dữ liệu. Thông tin trên màn hình có thể đã cũ.'}
          >
            <span className="cas-sync-dot" aria-hidden="true" />
            <span className="cas-sync-label">{operationsSyncStatus === 'online' ? 'Đã đồng bộ' : 'Mất đồng bộ'}</span>
          </span>
          <div className="cas-topbar-date" style={{ textAlign: 'right' }}>
            <div style={{ color: '#9CA3AF', fontSize: '11px' }}>
              {new Date().toLocaleDateString('vi-VN', { weekday: 'short', day: '2-digit', month: '2-digit' })}
            </div>
            <div style={{ color: '#F97316', fontSize: '12px', fontWeight: 600 }}>
              {tables.filter(t => t.status !== 'empty').length}/{tables.length} bàn
            </div>
          </div>
          <div className="cas-account" aria-label={`Đã đăng nhập: ${authenticatedUsername || 'Người dùng'}`}>
            <span className="cas-account-avatar"><UserRound size={16} /></span>
            <span className="cas-account-copy">
              <small>Đã đăng nhập</small>
              <strong>{authenticatedUsername || 'Người dùng'}</strong>
            </span>
            <button className="cas-signout-button" type="button" onClick={handleLogout} title="Đăng xuất">
              <LogOut size={16} />
              <span>Đăng xuất</span>
            </button>
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
                  waitingBatchesByTable={waitingBatchesByTable}
                  kitchen={kitchen}
                  onStartOrder={handleStartOrder}
                  onEditOrder={handleEditWaitingOrder}
                  onDeleteOrder={handleDeleteOrder}
                  onMarkDone={handleMarkDone}
                />
              </div>
            )}
            {orderStep === 'menu' && selectedTable && (
              <MenuStep
                table={selectedTable}
                cart={cart}
                categories={categories}
                menuItems={menuItems}
                isAddition={orderMode === 'addition'}
                isEditing={orderMode === 'edit'}
                onCartChange={setCart}
                onBack={handleBrowserBack}
                onConfirm={() => navigate({ orderStep: 'confirm' })}
              />
            )}
            {orderStep === 'confirm' && selectedTable && (
              <OrderConfirmStep
                table={selectedTable}
                cart={cart}
                isAddition={orderMode === 'addition'}
                isEditing={orderMode === 'edit'}
                onCartChange={setCart}
                onBack={handleBrowserBack}
                onEdit={handleBrowserBack}
                onPlaceOrder={handlePlaceOrder}
              />
            )}
            {orderStep === 'success' && selectedTable && (
              <OrderSuccessStep
                orderNumber={lastOrderNumber}
                table={selectedTable}
                cart={cart}
                batch={lastOrderBatch}
                isEditing={orderMode === 'edit'}
                onAddMore={() => {
                  setCart([]);
                  navigate({ orderStep: 'menu', orderMode: 'addition', editingBatchId: null });
                }}
                onDone={handleFinishOrder}
              />
            )}
          </>
        )}

        {view === 'overview' && (
          <div style={{ flex: 1, overflowY: 'auto' }}>
            <OverviewPage
              tables={tables}
              tableOrders={tableOrders}
              waitingBatchesByTable={waitingBatchesByTable}
              onStartOrder={handleStartOrder}
              onEditOrder={handleEditWaitingOrder}
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

        {view === 'reservations' && (
          <div style={{ flex: 1, overflowY: 'auto' }}>
            <ReservationsPage
              tables={tables}
              onChanged={async () => { await refreshReservationOperations(); }}
              onOpenOrder={handleOpenReservationOrder}
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
            <Suspense fallback={<div role="status" style={{ padding: 24, color: '#6B7280' }}>Đang tải trang quản trị…</div>}>
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
          maxWidth: 'calc(100vw - 24px)', whiteSpace: 'normal', textAlign: 'center',
          boxShadow: '0 4px 12px rgba(0,0,0,0.12)',
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
      `}</style>
    </div>
  );
}
