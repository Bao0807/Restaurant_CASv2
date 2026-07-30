import { useSyncExternalStore, type CSSProperties } from 'react';
import { BellRing, Clock3, Flame } from 'lucide-react';
import type { Table } from '../data';
import { getServerNowMs } from '../services/api';

let clockNow = getServerNowMs();
let clockTimer: number | null = null;
const clockListeners = new Set<() => void>();

/** Một đồng hồ dùng chung cho mọi thẻ bàn, tránh tạo một interval cho từng OrderTimer. */
function subscribeClock(listener: () => void) {
  clockListeners.add(listener);
  if (clockTimer === null) {
    clockNow = getServerNowMs();
    clockTimer = window.setInterval(() => {
      clockNow = getServerNowMs();
      clockListeners.forEach(notify => notify());
    }, 1000);
  }
  return () => {
    clockListeners.delete(listener);
    if (clockListeners.size === 0 && clockTimer !== null) {
      window.clearInterval(clockTimer);
      clockTimer = null;
    }
  };
}

function subscribeDisabled() {
  return () => undefined;
}

function getClockSnapshot() {
  return clockNow;
}

/** Định dạng timer bếp dạng mm:ss hoặc h:mm:ss mà không phụ thuộc timezone. */
function formatElapsed(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/** Hiển thị thời gian chờ/nấu và đổi màu khi vượt ETA backend. */
export function OrderTimer({ table, compact = false }: { table: Table; compact?: boolean }) {
  const startedAt = table.status === 'cooking' ? table.cookingStartedAt : table.queuedAt;
  const active = Boolean(startedAt && (table.status === 'waiting' || table.status === 'cooking'));
  const now = useSyncExternalStore(active ? subscribeClock : subscribeDisabled, getClockSnapshot, getClockSnapshot);

  if (table.status === 'done') {
    return (
      <span className={`order-timer order-timer--done${compact ? ' order-timer--compact' : ''}`} role="status">
        <BellRing size={compact ? 12 : 14} aria-hidden="true" />
        <span>Món đã xong · Cần phục vụ</span>
      </span>
    );
  }

  if (!startedAt || (table.status !== 'waiting' && table.status !== 'cooking')) return null;

  const startedAtMs = new Date(startedAt).getTime();
  if (!Number.isFinite(startedAtMs)) return null;

  const elapsedMilliseconds = Math.max(0, now - startedAtMs);
  const elapsed = formatElapsed(elapsedMilliseconds);
  const cooking = table.status === 'cooking';
  const expectedMinutes = Math.max(1, table.estimatedCookMinutes ?? 10);
  const expectedMilliseconds = expectedMinutes * 60_000;
  const remainingMilliseconds = expectedMilliseconds - elapsedMilliseconds;
  const etaReached = cooking && remainingMilliseconds <= 0;
  const progress = cooking ? Math.min(100, Math.max(0, (elapsedMilliseconds / expectedMilliseconds) * 100)) : 0;
  const distanceLabel = remainingMilliseconds < 60_000
    ? 'dưới 1 phút'
    : `${Math.ceil(remainingMilliseconds / 60_000)} phút`;
  const primaryText = etaReached ? 'Đang hoàn tất…' : `Còn khoảng ${distanceLabel}`;
  const displayedCookingElapsed = etaReached ? formatElapsed(expectedMilliseconds) : elapsed;
  const timerStyle = { '--order-timer-progress': `${progress}%` } as CSSProperties;

  if (!cooking) {
    return (
      <span
        className={`order-timer order-timer--waiting${compact ? ' order-timer--compact' : ''}`}
        role="timer"
        aria-label={`Bàn đã chờ bếp ${elapsed}${table.queuePosition ? `, thứ ${table.queuePosition} trong hàng chờ` : ''}`}
        title={`Đã chờ bếp ${elapsed}${table.queuePosition ? ` · Thứ ${table.queuePosition} trong hàng chờ` : ''}`}
      >
        <Clock3 size={compact ? 12 : 14} aria-hidden="true" />
        <span>Đã chờ {elapsed}</span>
        {table.queuePosition ? <small>· Thứ tự {table.queuePosition}</small> : null}
      </span>
    );
  }

  return (
    <span
      className={`order-timer order-timer--cooking${etaReached ? ' order-timer--finishing' : ''}${compact ? ' order-timer--compact' : ''}`}
      style={timerStyle}
      role="timer"
      aria-label={etaReached
        ? 'Đã đủ thời gian nấu. Đang đồng bộ trạng thái hoàn tất với bếp.'
        : `${primaryText} để hoàn tất. Đã nấu ${displayedCookingElapsed} trên dự kiến ${expectedMinutes} phút.`}
      title={etaReached
        ? 'Đã đủ ETA · Đang đồng bộ trạng thái hoàn tất'
        : `${primaryText} · Đã nấu ${displayedCookingElapsed} / dự kiến ${expectedMinutes} phút`}
    >
      <span className="order-timer__summary">
        {etaReached
          ? <Clock3 size={compact ? 12 : 14} aria-hidden="true" />
          : <Flame size={compact ? 12 : 14} aria-hidden="true" />}
        <strong>{primaryText}</strong>
        <small>Đã nấu {displayedCookingElapsed} / {expectedMinutes} phút</small>
      </span>
      <span
        className="order-timer__track"
        role="progressbar"
        aria-label="Tiến độ nấu"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress)}
        aria-valuetext={etaReached
          ? 'Đã đủ thời gian nấu, đang đồng bộ trạng thái hoàn tất'
          : `${Math.round(progress)} phần trăm, ${primaryText.toLocaleLowerCase('vi-VN')}`}
      >
        <span className="order-timer__progress" />
      </span>
    </span>
  );
}
