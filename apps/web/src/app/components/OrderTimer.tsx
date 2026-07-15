import { useSyncExternalStore } from 'react';
import { Clock3, Flame } from 'lucide-react';
import type { Table } from '../data';

let clockNow = Date.now();
let clockTimer: number | null = null;
const clockListeners = new Set<() => void>();

/** Một đồng hồ dùng chung cho mọi thẻ bàn, tránh tạo một interval cho từng OrderTimer. */
function subscribeClock(listener: () => void) {
  clockListeners.add(listener);
  if (clockTimer === null) {
    clockNow = Date.now();
    clockTimer = window.setInterval(() => {
      clockNow = Date.now();
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

  if (!startedAt || (table.status !== 'waiting' && table.status !== 'cooking')) return null;

  const elapsed = formatElapsed(now - new Date(startedAt).getTime());
  const cooking = table.status === 'cooking';
  const elapsedMilliseconds = now - new Date(startedAt).getTime();
  const expectedMilliseconds = (table.estimatedCookMinutes ?? 10) * 60_000;
  const overdue = cooking && elapsedMilliseconds > expectedMilliseconds;
  const color = overdue ? '#B91C1C' : cooking ? '#C2410C' : '#B45309';
  const background = overdue ? '#FEE2E2' : cooking ? '#FFEDD5' : '#FEF3C7';
  const Icon = cooking ? Flame : Clock3;

  return (
    <span
      title={cooking ? `Thời gian đang nấu: ${elapsed} / dự kiến ${table.estimatedCookMinutes ?? 10} phút` : `Thời gian chờ: ${elapsed}`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        color, background, borderRadius: 999,
        padding: compact ? '2px 6px' : '4px 8px',
        fontSize: compact ? 10 : 11, fontWeight: 800,
        fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
      }}
    >
      <Icon size={compact ? 11 : 13} aria-hidden="true" />
      {cooking ? `Nấu ${elapsed} / ${table.estimatedCookMinutes ?? 10}p` : `Chờ${table.queuePosition ? ` #${table.queuePosition}` : ''} ${elapsed}`}
    </span>
  );
}
