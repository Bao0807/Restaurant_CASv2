import { LogOut, UserRound } from 'lucide-react';
import type { AppView, EmployeeRole, OrderStep } from '../data';
import { APP_VIEW_LABELS, BRAND_ASSETS } from '../config/restaurant';
import { getServerNowMs } from '../services/api';
import type { ToastMessage } from '../hooks/useTransientToast';

interface AppTopBarProps {
  view: AppView;
  restaurantName: string;
  syncStatus: 'online' | 'stale';
  lastSyncAt: Date | null;
  servingTableCount: number;
  tableCount: number;
  username: string;
  role: EmployeeRole;
  onLogout: () => void;
}

const ROLE_LABELS: Record<EmployeeRole, string> = {
  manager: 'Quản lý',
  cashier: 'Thu ngân',
  server: 'Phục vụ',
  chef: 'Bếp',
};

export function AppTopBar({
  view, restaurantName, syncStatus, lastSyncAt,
  servingTableCount, tableCount, username, role, onLogout,
}: AppTopBarProps) {
  const displayName = username || 'Người dùng';
  return (
    <header className="cas-topbar">
      <div className="cas-topbar-brand" aria-label={`${restaurantName} · ${APP_VIEW_LABELS[view]}`}>
        <img className="cas-topbar-logo" src={BRAND_ASSETS.logoHorizontalWhite} alt="CAS" />
        <span className="cas-topbar-context">{APP_VIEW_LABELS[view]}</span>
      </div>
      <div className="cas-topbar-meta">
        <span
          className="cas-sync-indicator"
          data-status={syncStatus}
          title={syncStatus === 'online'
            ? `Cập nhật lúc ${lastSyncAt?.toLocaleTimeString('vi-VN') ?? 'vừa xong'}`
            : 'Mất kết nối. Một số thông tin có thể chưa được cập nhật.'}
        >
          <span className="cas-sync-dot" aria-hidden="true" />
          <span className="cas-sync-label">{syncStatus === 'online' ? 'Sẵn sàng' : 'Mất kết nối'}</span>
        </span>
        <div className="cas-topbar-date">
          <div className="cas-topbar-calendar">
            {new Date(getServerNowMs()).toLocaleDateString('vi-VN', { weekday: 'short', day: '2-digit', month: '2-digit' })}
          </div>
          <div className="cas-topbar-occupancy" aria-label={`${servingTableCount} trên ${tableCount} bàn đang phục vụ`}>
            <strong>{servingTableCount}/{tableCount}</strong>
            <span>bàn đang phục vụ</span>
          </div>
        </div>
        <div className="cas-account" aria-label={`Đã đăng nhập: ${displayName}`}>
          <span className="cas-account-avatar"><UserRound size={16} /></span>
          <span className="cas-account-copy"><small>{ROLE_LABELS[role]}</small><strong>{displayName}</strong></span>
          <button className="cas-signout-button" type="button" onClick={onLogout} title="Đăng xuất">
            <LogOut size={16} /><span>Đăng xuất</span>
          </button>
        </div>
      </div>
    </header>
  );
}

const ORDER_STEPS: OrderStep[] = ['tables', 'menu', 'confirm', 'success'];
const ORDER_STEP_LABELS: Record<OrderStep, string> = {
  tables: 'Chọn bàn', menu: 'Chọn món', confirm: 'Xác nhận', success: 'Hoàn thành',
};

export function OrderBreadcrumb({ current }: { current: OrderStep }) {
  if (current === 'tables') return null;
  const currentIndex = ORDER_STEPS.indexOf(current);
  return (
    <nav className="cas-order-breadcrumb" aria-label="Tiến trình gọi món">
      {ORDER_STEPS.map((step, index) => {
        const active = step === current;
        const done = index < currentIndex;
        return (
          <span className="cas-order-breadcrumb-item" key={step}>
            <span className={`cas-order-breadcrumb-step${active ? ' active' : ''}${done ? ' done' : ''}`} aria-current={active ? 'step' : undefined}>
              <span>{done ? '✓' : `${index + 1}.`}</span>
              <strong>{ORDER_STEP_LABELS[step]}</strong>
            </span>
            {index < ORDER_STEPS.length - 1 && <span className="cas-order-breadcrumb-separator" aria-hidden="true">›</span>}
          </span>
        );
      })}
    </nav>
  );
}

export function AppToast({ toast }: { toast: ToastMessage | null }) {
  if (!toast) return null;
  return <div className="cas-toast" data-tone={toast.type} role="status" aria-live="polite">{toast.msg}</div>;
}

export function AppLoadingStatus({ children }: { children: string }) {
  return <div className="cas-loading-status" role="status">{children}</div>;
}

export function AppBootLoading() {
  return (
    <main className="cas-boot-screen loading">
      <div className="cas-boot-loading" role="status">
        <img src={BRAND_ASSETS.logoHorizontalWhite} alt="CAS" />
        <span>Đang chuẩn bị màn hình làm việc…</span>
      </div>
    </main>
  );
}

export function AppBootError({ message, onRetry }: { message: string | null; onRetry: () => void }) {
  return (
    <main className="cas-boot-screen error">
      <div className="cas-boot-error" role="alert">
        <h1>Không thể tải dữ liệu nhà hàng</h1>
        <p>{message}</p>
        <button type="button" onClick={onRetry}>Thử lại</button>
      </div>
    </main>
  );
}
