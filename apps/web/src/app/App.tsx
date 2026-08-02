import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type AppView, type CartItem, type EmployeeRole, type PaymentRecord, type PaymentResult, type Reservation,
  formatVND,
} from './data';
import {
  APP_VIEW_LABELS,
  type RestaurantSettings,
} from './config/restaurant';
import {
  ApiError,
  authenticate,
  checkApiSession,
  clearApiCredentials,
  confirmTableDeparture,
  deleteOrder,
  fetchCatalog,
  fetchPayments,
  fetchRestaurantSettings,
  logoutApiSession,
  recordPayment,
  saveOrder,
  saveRestaurantSettings,
  updateTableStatus,
  updateReservationStatus,
  updateWaitingOrderBatch,
  type SavedOrderBatch,
} from './services/api';
import { BottomNav } from './components/BottomNav';
import { TableSelectStep } from './components/TableSelectStep';
import { canDeleteWaitingOrder, getTableOptionsHistoryTableId } from './components/TableOptionsModal';
import { LoginPage } from './components/LoginPage';
import {
  AppBootError, AppBootLoading, AppLoadingStatus, AppToast, AppTopBar, OrderBreadcrumb,
} from './components/AppChrome';
import {
  INITIAL_APP_NAVIGATION, isAppNavigationState, normalizeNavigationState,
  useAppNavigation,
} from './hooks/useAppNavigation';
import { useTransientToast } from './hooks/useTransientToast';
import { useRestaurantStore } from './hooks/useRestaurantStore';
import { useOperationsSync } from './hooks/useOperationsSync';

const MenuStep = lazy(() => import('./components/MenuStep').then(module => ({ default: module.MenuStep })));
const OrderConfirmStep = lazy(() => import('./components/OrderConfirmStep').then(module => ({ default: module.OrderConfirmStep })));
const OrderSuccessStep = lazy(() => import('./components/OrderSuccessStep').then(module => ({ default: module.OrderSuccessStep })));
const ReservationsPage = lazy(() => import('./components/ReservationsPage').then(module => ({ default: module.ReservationsPage })));
const PaymentPage = lazy(() => import('./components/PaymentPage').then(module => ({ default: module.PaymentPage })));
const DashboardPage = lazy(() => import('./components/DashboardPage').then(module => ({ default: module.DashboardPage })));

const ROLE_VIEWS: Record<EmployeeRole, AppView[]> = {
  manager: ['order', 'reservations', 'payment', 'reports', 'dashboard'],
  cashier: ['order', 'reservations', 'payment', 'reports'],
  server: ['order', 'reservations'],
  chef: ['order'],
};

export default function App() {
  const {
    navigation, view, orderStep, selectedTableId, orderMode, editingBatchId,
    navigate, applyNavigation, historyReadyRef,
  } = useAppNavigation();
  const [cart, setCart] = useState<CartItem[]>([]);
  const {
    tables, tableOrders, waitingBatchesByTable, restaurantSettings, completedPayments,
    kitchen, categories, menuItems, applyOperations, applyBootstrapData,
    recordCompletedPayment, setRestaurantSettings, setCatalog, resetRestaurantStore,
  } = useRestaurantStore();
  const [lastOrderNumber, setLastOrderNumber] = useState('');
  const [lastOrderBatch, setLastOrderBatch] = useState<SavedOrderBatch | null>(null);
  const [settingsStatus, setSettingsStatus] = useState<'idle' | 'loading' | 'saving' | 'saved' | 'error'>('loading');
  const { toast, showToast } = useTransientToast();
  const [authStatus, setAuthStatus] = useState<'checking' | 'required' | 'authenticated'>('checking');
  const [authenticatedUsername, setAuthenticatedUsername] = useState('');
  const [authenticatedRole, setAuthenticatedRole] = useState<EmployeeRole>('manager');
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [bootstrapStatus, setBootstrapStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const orderSubmissionLockRef = useRef(false);

  const handleSessionExpired = useCallback(() => {
    clearApiCredentials();
    setAuthenticatedUsername('');
    setAuthenticatedRole('manager');
    setAuthStatus('required');
    setLoginError('Phiên đăng nhập không còn hợp lệ.');
  }, []);
  const { operationsSyncStatus, lastOperationsSyncAt, refreshOperationsSnapshot } = useOperationsSync({
    active: authStatus === 'authenticated' && bootstrapStatus === 'ready',
    tables,
    applyOperations,
    onUnauthorized: handleSessionExpired,
  });

  useEffect(() => {
    const viewLabel = APP_VIEW_LABELS[view];
    document.title = `${restaurantSettings.restaurantName} · ${viewLabel}`;
  }, [restaurantSettings.restaurantName, view]);

  useEffect(() => {
    if (authStatus !== 'authenticated' || bootstrapStatus !== 'ready' || historyReadyRef.current) return;

    const stored = window.history.state;
    if (isAppNavigationState(stored)) {
      const normalizedStored = normalizeNavigationState(stored);
      const tableExists = !normalizedStored.selectedTableId || tables.some(table => table.id === normalizedStored.selectedTableId);
      const requiresTable = normalizedStored.view === 'order' && normalizedStored.orderStep !== 'tables';
      const hasStaleReceipt = normalizedStored.orderStep === 'success';
      const next = (requiresTable && !tableExists) || hasStaleReceipt
        ? { ...normalizedStored, orderStep: 'tables' as const, selectedTableId: null, orderMode: 'new' as const, editingBatchId: null }
        : normalizedStored;

      applyNavigation(next);
      if (next.orderMode === 'edit' && next.editingBatchId !== null && next.selectedTableId) {
        const batch = waitingBatchesByTable[next.selectedTableId]?.find(item => item.batchId === next.editingBatchId);
        if (batch) setCart(batch.items);
      }
      window.history.replaceState(next, '');
    } else {
      window.history.replaceState(navigation, '');
    }
    historyReadyRef.current = true;
  }, [
    applyNavigation, authStatus, bootstrapStatus, editingBatchId, historyReadyRef, navigation,
    orderMode, orderStep, selectedTableId, tables, view, waitingBatchesByTable,
  ]);

  useEffect(() => {
    const handlePopState = (event: PopStateEvent) => {
      if (!isAppNavigationState(event.state)) return;

      const wasLegacyOverview = event.state.view === 'overview';
      let next = normalizeNavigationState(event.state);
      if (wasLegacyOverview) window.history.replaceState(next, '');
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
          showToast('Phiếu này không còn ở trạng thái chờ để sửa.', 'info');
        } else if (orderMode !== 'edit' || editingBatchId !== next.editingBatchId) {
          setCart(batch.items);
        }
      }

      applyNavigation(next);
      if (wasLegacyOverview) setCart([]);
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [applyNavigation, editingBatchId, orderMode, showToast, tables, waitingBatchesByTable]);

  useEffect(() => {
    let mounted = true;

    checkApiSession()
      .then(session => {
        if (!mounted) return;
        setAuthenticatedUsername(session.username);
        setAuthenticatedRole(session.role);
        setAuthStatus('authenticated');
      })
      .catch(error => {
        if (!mounted) return;
        if (error instanceof ApiError && error.status === 401) {
          clearApiCredentials();
          setAuthenticatedUsername('');
          setAuthenticatedRole('manager');
          setAuthStatus('required');
          return;
        }
        setLoginError(error instanceof Error ? error.message : 'Không thể kết nối hệ thống.');
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

    const catalogRequest = fetchCatalog();
    const canReadPayments = authenticatedRole === 'manager' || authenticatedRole === 'cashier';
    Promise.all([
      fetchRestaurantSettings(),
      refreshOperationsSnapshot(() => mounted),
      canReadPayments ? fetchPayments() : Promise.resolve([]),
      catalogRequest,
    ])
      .then(([settings, operations, payments, catalog]) => {
        if (!mounted) return;
        applyBootstrapData(settings, payments, catalog, operations.menuAvailability);
        setSettingsStatus('saved');
        setBootstrapStatus('ready');
      })
      .catch(error => {
        if (!mounted) return;
        if (error instanceof ApiError && error.status === 401) {
          clearApiCredentials();
          setAuthenticatedUsername('');
          setAuthenticatedRole('manager');
          setAuthStatus('required');
          setLoginError('Phiên đăng nhập không còn hợp lệ.');
          return;
        }
        setSettingsStatus('error');
        setBootstrapError(error instanceof Error ? error.message : 'Không thể tải dữ liệu vận hành.');
        setBootstrapStatus('error');
      });

    return () => { mounted = false; };
  }, [applyBootstrapData, authStatus, authenticatedRole, refreshOperationsSnapshot, reloadKey]);

  useEffect(() => {
    if (authStatus !== 'authenticated' || ROLE_VIEWS[authenticatedRole].includes(view)) return;
    navigate({
      view: 'order',
      orderStep: 'tables',
      selectedTableId: null,
      orderMode: 'new',
      editingBatchId: null,
      casPaymentTableId: null,
    });
  }, [authStatus, authenticatedRole, navigate, view]);

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

    const next = { ...INITIAL_APP_NAVIGATION };
    window.history.replaceState(next, '');
    applyNavigation(next);
    setCart([]);
    showToast('Phiếu đã được bếp nhận nấu nên không thể tiếp tục sửa.', 'info');
  }, [
    applyNavigation, bootstrapStatus, editingBatchId, orderMode, orderStep,
    selectedTableId, showToast, waitingBatchesByTable,
  ]);

  const handleLogin = async (username: string, password: string) => {
    setLoginBusy(true);
    setLoginError(null);
    try {
      const session = await authenticate(username, password);
      setAuthenticatedUsername(session.username);
      setAuthenticatedRole(session.role);
      setAuthStatus('authenticated');
      setReloadKey(key => key + 1);
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : 'Đăng nhập thất bại.');
    } finally {
      setLoginBusy(false);
    }
  };

  /** Thu hồi cookie phiên và quay lại màn đăng nhập mà không reload toàn trang. */
  const handleLogout = () => {
    void logoutApiSession();
    clearApiCredentials();
    setAuthenticatedUsername('');
    setAuthenticatedRole('manager');
    setLoginError(null);
    setAuthStatus('required');
    setBootstrapStatus('idle');
    applyNavigation(INITIAL_APP_NAVIGATION);
    setCart([]);
    resetRestaurantStore();
    window.history.replaceState(INITIAL_APP_NAVIGATION, '');
    historyReadyRef.current = false;
  };

  const selectedTable = tables.find(t => t.id === selectedTableId) ?? null;
  const inventoryCredits = useMemo(() => {
    if (orderMode !== 'edit' || !selectedTableId || editingBatchId === null) return {};
    const batch = waitingBatchesByTable[selectedTableId]?.find(item => item.batchId === editingBatchId);
    if (!batch) return {};
    const catalog = new Map(menuItems.map(item => [item.id, item]));
    return batch.items.reduce<Record<string, number>>((credits, item) => {
      const latest = catalog.get(item.menuItem.id);
      if (latest?.inventoryDate === batch.inventoryDate) {
        credits[item.menuItem.id] = (credits[item.menuItem.id] ?? 0) + item.quantity;
      }
      return credits;
    }, {});
  }, [editingBatchId, menuItems, orderMode, selectedTableId, waitingBatchesByTable]);

  useEffect(() => {
    if (
      bootstrapStatus !== 'ready'
      || view !== 'order'
      || (orderStep !== 'menu' && orderStep !== 'confirm')
      || !selectedTableId
      || (orderMode !== 'addition' && orderMode !== 'edit')
    ) return;

    const table = tables.find(row => row.id === selectedTableId);
    const orderStillOpen = Boolean(tableOrders[selectedTableId]?.length);
    if (!table?.isPaid && orderStillOpen) return;

    const next = { ...INITIAL_APP_NAVIGATION };
    window.history.replaceState(next, '');
    applyNavigation(next);
    setCart([]);
    showToast(table?.isPaid ? 'Bàn vừa được thanh toán trên thiết bị khác.' : 'Lượt phục vụ của bàn đã kết thúc.', 'info');
  }, [
    applyNavigation, bootstrapStatus, orderMode, orderStep, selectedTableId,
    showToast, tableOrders, tables, view,
  ]);

  /* ─── Order Flow ─── */
  const handleStartOrder = (tableId: string) => {
    const table = tables.find(row => row.id === tableId);
    if (table?.isPaid) {
      showToast('Bàn này đã thanh toán. Không thể gọi thêm món.', 'info');
      return;
    }
    const hasExistingOrder = Boolean(tableOrders[tableId]?.length);
    // Gọi thêm luôn bắt đầu bằng giỏ rỗng để tạo một phiếu bếp riêng.
    setCart([]);
    navigate({
      view: 'order',
      orderStep: 'menu',
      selectedTableId: tableId,
      orderMode: hasExistingOrder ? 'addition' : 'new',
      editingBatchId: null,
    }, getTableOptionsHistoryTableId() === tableId ? 'replace' : 'push');
  };

  const handleEditWaitingOrder = (tableId: string, batchId: number) => {
    if (tables.find(table => table.id === tableId)?.isPaid) {
      showToast('Bàn này đã thanh toán. Không thể sửa phiếu món.', 'info');
      return;
    }
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
    }, getTableOptionsHistoryTableId() === tableId ? 'replace' : 'push');
  };

  /** Exit is an explicit app action, not browser Back: always land on table operations. */
  const handleExitOrder = () => {
    setCart([]);
    navigate({
      view: 'order',
      orderStep: 'tables',
      selectedTableId: null,
      orderMode: 'new',
      editingBatchId: null,
      casPaymentTableId: null,
    }, 'replace');
  };

  /** Return exactly one order-workflow step without consulting browser history. */
  const handleReturnToMenu = () => {
    navigate({ orderStep: 'menu' }, 'replace');
  };

  const handleFinishOrder = () => {
    setCart([]);
    navigate({ view: 'order', orderStep: 'tables', selectedTableId: null, orderMode: 'new', editingBatchId: null });
  };

  /** Lưu order ở server rồi tải lại snapshot queue đã được điều phối. */
  const handlePlaceOrder = async () => {
    if (!selectedTableId || cart.length === 0 || orderSubmissionLockRef.current) return;
    orderSubmissionLockRef.current = true;
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
      if (error instanceof ApiError && error.code === 'MENU_ITEM_DAILY_LIMIT_EXCEEDED') {
        await refreshOperationsSnapshot().catch(() => undefined);
      }
      showToast(error instanceof Error ? error.message : orderMode === 'edit' ? 'Không thể cập nhật phiếu chờ' : 'Không thể lưu phiếu gọi món', 'error');
      throw error;
    } finally {
      orderSubmissionLockRef.current = false;
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
  /** Ghi nhận thanh toán; bàn trả trước chỉ đóng sau khi khách rời. */
  const handleProcessPayment = async (payment: PaymentRecord, _items: CartItem[]): Promise<PaymentResult> => {
    try {
      const savedPayment = await recordPayment(payment);
      recordCompletedPayment(savedPayment);
      showToast(
        savedPayment.requiresDepartureConfirmation
          ? `Đã thanh toán ${formatVND(savedPayment.total)} · bàn vẫn đang phục vụ`
          : `Thanh toán ${formatVND(savedPayment.total)} thành công`,
        'success',
      );
      // Let the payment dialog commit its paid/invoice state before the refreshed
      // operations snapshot removes the order or marks the table as paid.
      window.setTimeout(() => {
        void refreshOperationsSnapshot().catch(() => undefined);
      }, 0);
      return savedPayment;
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Không thể ghi nhận thanh toán', 'error');
      throw error;
    }
  };

  /** Mở thẳng màn thu ngân với đúng hóa đơn từ popup thao tác bàn. */
  const handleOpenTablePayment = (tableId: string) => {
    const table = tables.find(row => row.id === tableId);
    const hasOrder = Boolean(tableOrders[tableId]?.length);

    if (!table || !hasOrder) {
      showToast('Bàn chưa có hóa đơn để thanh toán.', 'info');
      return;
    }
    if (table.isPaid) {
      showToast('Bàn này đã được thanh toán.', 'info');
      return;
    }

    setCart([]);
    navigate({
      view: 'payment',
      orderStep: 'tables',
      selectedTableId: null,
      orderMode: 'new',
      editingBatchId: null,
      casPaymentTableId: tableId,
    });
  };

  const handleConfirmDeparture = async (tableId: string) => {
    try {
      await confirmTableDeparture(tableId);
      await refreshOperationsSnapshot();
      showToast('Đã xác nhận khách rời · bàn chuyển về trống', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Không thể đóng bàn', 'error');
      throw error;
    }
  };

  const handleSaveSettings = async (next: RestaurantSettings) => {
    const previous = restaurantSettings;
    setRestaurantSettings(next);
    setSettingsStatus('saving');

    try {
      const saved = await saveRestaurantSettings(next);
      setRestaurantSettings(saved);
      setSettingsStatus('saved');
      showToast('Đã lưu cấu hình nhà hàng', 'success');
      setTimeout(() => setSettingsStatus('idle'), 1800);
    } catch (error) {
      console.warn('Không thể lưu cấu hình.', error);
      try {
        setRestaurantSettings(await fetchRestaurantSettings());
      } catch {
        setRestaurantSettings(previous);
      }
      setSettingsStatus('error');
      showToast(error instanceof Error ? error.message : 'Thay đổi chưa được lưu. Vui lòng kiểm tra kết nối.', 'error');
    }
  };

  const refreshManagementData = async () => {
    const [, catalog] = await Promise.all([refreshOperationsSnapshot(), fetchCatalog()]);
    setCatalog(catalog);
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

  /** Check-in trực tiếp từ card vận hành rồi mở đúng bàn để gọi món. */
  const handleCheckInTableReservation = async (tableId: string) => {
    const reservation = tables.find(table => table.id === tableId)?.nextReservation;
    if (!reservation || reservation.status !== 'booked') {
      const error = new Error('Lịch gần nhất của bàn đã thay đổi. Hãy tải lại trạng thái bàn.');
      showToast(error.message, 'info');
      throw error;
    }

    try {
      const seated = await updateReservationStatus(reservation.id, 'seated', reservation.version);
      showToast(`Đã nhận bàn cho ${seated.customerName}`, 'success');
      await handleOpenReservationOrder(seated);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Không thể nhận bàn lúc này.', 'error');
      throw error;
    }
  };

  /* ─── View Change ─── */
  const handleViewChange = (v: AppView) => {
    const nextView: AppView = v === 'overview' ? 'order' : v;
    if (!ROLE_VIEWS[authenticatedRole].includes(nextView)) return;
    if (nextView === view && (nextView !== 'order' || orderStep === 'tables')) return;

    if (nextView === 'order') {
      setCart([]);
      navigate({
        view: 'order',
        orderStep: 'tables',
        selectedTableId: null,
        orderMode: 'new',
        editingBatchId: null,
        casPaymentTableId: null,
      });
      return;
    }

    navigate({ view: nextView, casPaymentTableId: null });
  };

  const servingTableCount = tables.filter(table => (
    table.status === 'waiting' || table.status === 'cooking' || table.status === 'done'
  )).length;

  if (authStatus === 'required') {
    return <LoginPage busy={loginBusy} error={loginError} onLogin={handleLogin} />;
  }

  if (authStatus === 'checking' || bootstrapStatus === 'idle' || bootstrapStatus === 'loading') {
    return <AppBootLoading />;
  }

  if (bootstrapStatus === 'error') {
    return <AppBootError message={bootstrapError} onRetry={() => setReloadKey(key => key + 1)} />;
  }

  return (
    <div className="cas-app-shell">
      <AppTopBar
        view={view}
        restaurantName={restaurantSettings.restaurantName}
        syncStatus={operationsSyncStatus}
        lastSyncAt={lastOperationsSyncAt}
        servingTableCount={servingTableCount}
        tableCount={tables.length}
        username={authenticatedUsername}
        role={authenticatedRole}
        onLogout={handleLogout}
      />
      {view === 'order' && <OrderBreadcrumb current={orderStep} />}

      {/* Main Content */}
      <main className="cas-main">
        <Suspense fallback={<AppLoadingStatus>Đang tải giao diện…</AppLoadingStatus>}>
        {view === 'order' && (
          <>
            {orderStep === 'tables' && (
              <div className="cas-page-scroll">
                <TableSelectStep
                  role={authenticatedRole}
                  tables={tables}
                  tableOrders={tableOrders}
                  waitingBatchesByTable={waitingBatchesByTable}
                  kitchen={kitchen}
                  onStartOrder={handleStartOrder}
                  onEditOrder={handleEditWaitingOrder}
                  onDeleteOrder={handleDeleteOrder}
                  onMarkDone={handleMarkDone}
                  onConfirmDeparture={handleConfirmDeparture}
                  onCheckInReservation={handleCheckInTableReservation}
                  onPay={handleOpenTablePayment}
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
                inventoryCredits={inventoryCredits}
                onCartChange={setCart}
                onBack={handleExitOrder}
                onConfirm={() => navigate({ orderStep: 'confirm' })}
              />
            )}
            {orderStep === 'confirm' && selectedTable && (
              <OrderConfirmStep
                table={selectedTable}
                cart={cart}
                isAddition={orderMode === 'addition'}
                isEditing={orderMode === 'edit'}
                menuItems={menuItems}
                inventoryCredits={inventoryCredits}
                onCartChange={setCart}
                onBack={handleReturnToMenu}
                onEdit={handleReturnToMenu}
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

        {view === 'payment' && (
          <div className="cas-page-scroll">
            <PaymentPage
              tables={tables}
              tableOrders={tableOrders}
              payments={completedPayments}
              settings={restaurantSettings}
              onProcessPayment={handleProcessPayment}
              onConfirmDeparture={handleConfirmDeparture}
            />
          </div>
        )}

        {view === 'reservations' && (
          <div className="cas-page-scroll">
            <ReservationsPage
              tables={tables}
              onChanged={async () => { await refreshReservationOperations(); }}
              onOpenOrder={handleOpenReservationOrder}
            />
          </div>
        )}

        {view === 'reports' && (
          <div className="cas-page-scroll">
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
          </div>
        )}

        {view === 'dashboard' && (
          <div className="cas-page-scroll">
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
          </div>
        )}
        </Suspense>
      </main>

      {/* Bottom Nav */}
      <BottomNav view={view} role={authenticatedRole} onViewChange={handleViewChange} />

      <AppToast toast={toast} />
    </div>
  );
}
