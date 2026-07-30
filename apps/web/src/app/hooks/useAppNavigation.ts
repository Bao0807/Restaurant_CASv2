import { useCallback, useReducer, useRef } from 'react';
import type { AppView, OrderStep } from '../data';

export type OrderMode = 'new' | 'addition' | 'edit';

export interface AppNavigationState {
  casNavigation: true;
  view: AppView;
  orderStep: OrderStep;
  selectedTableId: string | null;
  orderMode: OrderMode;
  editingBatchId: number | null;
}

export const INITIAL_APP_NAVIGATION: AppNavigationState = {
  casNavigation: true,
  view: 'order',
  orderStep: 'tables',
  selectedTableId: null,
  orderMode: 'new',
  editingBatchId: null,
};

export function isAppNavigationState(value: unknown): value is AppNavigationState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Partial<AppNavigationState>;
  return state.casNavigation === true
    && ['order', 'overview', 'reservations', 'payment', 'reports', 'dashboard'].includes(state.view ?? '')
    && ['tables', 'menu', 'confirm', 'success'].includes(state.orderStep ?? '')
    && ['new', 'addition', 'edit'].includes(state.orderMode ?? '');
}

/** Chuyển mốc Tổng quan cũ về màn vận hành bàn đã hợp nhất. */
export function normalizeNavigationState(state: AppNavigationState): AppNavigationState {
  if (state.view !== 'overview') return state;
  return { ...INITIAL_APP_NAVIGATION };
}

function navigationReducer(_state: AppNavigationState, next: AppNavigationState): AppNavigationState {
  return normalizeNavigationState(next);
}

/** Quản lý điều hướng SPA như một trạng thái nguyên tử, đồng bộ với Back/Forward. */
export function useAppNavigation() {
  const [navigation, dispatch] = useReducer(navigationReducer, INITIAL_APP_NAVIGATION);
  const historyReadyRef = useRef(false);

  const applyNavigation = useCallback((next: AppNavigationState) => {
    dispatch(next);
  }, []);

  const navigate = useCallback((
    overrides: Partial<Omit<AppNavigationState, 'casNavigation'>>,
    method: 'push' | 'replace' = 'push',
  ) => {
    const next = normalizeNavigationState({ ...navigation, ...overrides });
    if (method === 'replace') window.history.replaceState(next, '');
    else window.history.pushState(next, '');
    historyReadyRef.current = true;
    dispatch(next);
  }, [navigation]);

  return {
    navigation,
    ...navigation,
    navigate,
    applyNavigation,
    historyReadyRef,
  };
}
