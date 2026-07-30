import { useCallback, useReducer } from 'react';
import type { CartItem, KitchenStatus, MenuCategory, MenuItem, PaymentRecord, Table } from '../data';
import { DEFAULT_RESTAURANT_SETTINGS, type RestaurantSettings } from '../config/restaurant';
import type { EditableOrderBatch, fetchCatalog, fetchOperations } from '../services/api';

export type OperationsSnapshot = Awaited<ReturnType<typeof fetchOperations>>;
type CatalogSnapshot = Awaited<ReturnType<typeof fetchCatalog>>;

interface RestaurantStoreState {
  tables: Table[];
  tableOrders: Record<string, CartItem[]>;
  waitingBatchesByTable: Record<string, EditableOrderBatch[]>;
  restaurantSettings: RestaurantSettings;
  completedPayments: PaymentRecord[];
  kitchen: KitchenStatus;
  categories: MenuCategory[];
  menuItems: MenuItem[];
}

const INITIAL_KITCHEN: KitchenStatus = {
  concurrency: 2,
  cookingCount: 0,
  waitingCount: 0,
  staleCount: 0,
  staleBatches: [],
  staleAfterMinutes: 120,
  automationEnabled: true,
  paused: false,
  version: 1,
};

const INITIAL_STORE: RestaurantStoreState = {
  tables: [],
  tableOrders: {},
  waitingBatchesByTable: {},
  restaurantSettings: DEFAULT_RESTAURANT_SETTINGS,
  completedPayments: [],
  kitchen: INITIAL_KITCHEN,
  categories: [],
  menuItems: [],
};

/** Gắn snapshot tồn kho nhẹ vào catalog mà không tải lại ảnh và mô tả món. */
function mergeMenuAvailability(items: MenuItem[], availability: OperationsSnapshot['menuAvailability']): MenuItem[] {
  const byId = new Map(availability.map(item => [item.id, item]));
  let changed = false;
  const next = items.map(item => {
    const current = byId.get(item.id);
    if (!current
      || (item.dailyLimit ?? null) === current.dailyLimit
      && Number(item.dailyUsed ?? 0) === current.dailyUsed
      && (item.dailyRemaining ?? null) === current.dailyRemaining
      && item.inventoryDate === current.inventoryDate) return item;
    changed = true;
    return { ...item, ...current };
  });
  return changed ? next : items;
}

type StoreAction =
  | { type: 'operations'; operations: OperationsSnapshot }
  | {
    type: 'bootstrap-data';
    settings: RestaurantSettings;
    payments: PaymentRecord[];
    catalog: CatalogSnapshot;
    availability: OperationsSnapshot['menuAvailability'];
  }
  | { type: 'payment-recorded'; payment: PaymentRecord }
  | { type: 'settings-changed'; settings: RestaurantSettings }
  | { type: 'catalog-changed'; catalog: CatalogSnapshot }
  | { type: 'reset' };

function restaurantStoreReducer(state: RestaurantStoreState, action: StoreAction): RestaurantStoreState {
  switch (action.type) {
    case 'operations':
      return {
        ...state,
        tables: action.operations.tables,
        tableOrders: action.operations.tableOrders,
        waitingBatchesByTable: action.operations.waitingBatchesByTable,
        kitchen: action.operations.kitchen,
        menuItems: mergeMenuAvailability(state.menuItems, action.operations.menuAvailability),
      };
    case 'bootstrap-data':
      return {
        ...state,
        restaurantSettings: action.settings,
        completedPayments: action.payments,
        categories: action.catalog.categories,
        menuItems: mergeMenuAvailability(action.catalog.items, action.availability),
      };
    case 'payment-recorded':
      return {
        ...state,
        completedPayments: [
          action.payment,
          ...state.completedPayments.filter(item => item.invoiceCode !== action.payment.invoiceCode),
        ].slice(0, 100),
      };
    case 'settings-changed':
      return { ...state, restaurantSettings: action.settings };
    case 'catalog-changed':
      return { ...state, categories: action.catalog.categories, menuItems: action.catalog.items };
    case 'reset':
      return INITIAL_STORE;
  }
}

/** Store miền dữ liệu vận hành; reducer giữ các snapshot liên quan được cập nhật nguyên tử. */
export function useRestaurantStore() {
  const [state, dispatch] = useReducer(restaurantStoreReducer, INITIAL_STORE);
  const applyOperations = useCallback((operations: OperationsSnapshot) => dispatch({ type: 'operations', operations }), []);
  const applyBootstrapData = useCallback((
    settings: RestaurantSettings,
    payments: PaymentRecord[],
    catalog: CatalogSnapshot,
    availability: OperationsSnapshot['menuAvailability'],
  ) => dispatch({ type: 'bootstrap-data', settings, payments, catalog, availability }), []);
  const recordCompletedPayment = useCallback((payment: PaymentRecord) => dispatch({ type: 'payment-recorded', payment }), []);
  const setRestaurantSettings = useCallback((settings: RestaurantSettings) => dispatch({ type: 'settings-changed', settings }), []);
  const setCatalog = useCallback((catalog: CatalogSnapshot) => dispatch({ type: 'catalog-changed', catalog }), []);
  const resetRestaurantStore = useCallback(() => dispatch({ type: 'reset' }), []);

  return {
    ...state,
    applyOperations,
    applyBootstrapData,
    recordCompletedPayment,
    setRestaurantSettings,
    setCatalog,
    resetRestaurantStore,
  };
}
