import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  ArrowRight, BadgeCheck, BellRing, CalendarClock, Circle, Clock, Flame, Hourglass,
  ClipboardList, LayoutGrid, Map as MapIcon, Maximize2, Minimize2, Search, Users, X,
} from 'lucide-react';
import type { CartItem, KitchenStatus, Table, TableStatus } from '../data';
import type { EditableOrderBatch } from '../services/api';
import { getServerNowMs } from '../services/api';
import { formatReservationTimeRange, STATUS_CONFIG } from '../data';
import { OrderTimer } from './OrderTimer';
import { getTableOptionsHistoryTableId, TableOptionsModal } from './TableOptionsModal';

interface TableSelectStepProps {
  tables: Table[];
  tableOrders: Record<string, CartItem[]>;
  waitingBatchesByTable: Record<string, EditableOrderBatch[]>;
  kitchen: KitchenStatus;
  onStartOrder: (tableId: string) => void;
  onEditOrder: (tableId: string, batchId: number) => void;
  onDeleteOrder: (tableId: string) => Promise<void>;
  onMarkDone: (tableId: string) => Promise<void>;
  onConfirmDeparture: (tableId: string) => Promise<void>;
  onCheckInReservation: (tableId: string) => Promise<void>;
  onPay: (tableId: string) => void;
}

type TableFilter = 'all' | 'serving' | TableStatus | 'paid';
type TableViewMode = 'grid' | 'floor';
type TableDensity = 'comfortable' | 'compact';

const STATUS_ORDER: TableStatus[] = ['empty', 'waiting', 'cooking', 'done', 'reserved'];
const PROGRESS_STATUSES: TableStatus[] = ['waiting', 'cooking', 'done', 'reserved'];
const SERVING_STATUSES = new Set<TableStatus>(['waiting', 'cooking', 'done']);
const DEFAULT_AREA = 'Khu vực chung';

interface TableBadgeDetail {
  className: string;
  icon?: ReactNode;
  key: string;
  label: string;
  title: string;
  tone: 'addition' | 'paid' | 'items';
}

function tableArea(table: Table): string {
  return table.area?.trim() || DEFAULT_AREA;
}

/** Dùng chung một predicate cho cả số đếm và danh sách để chip không lệch kết quả hiển thị. */
function matchesTableFilter(table: Table, filter: TableFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'serving') return SERVING_STATUSES.has(table.status);
  if (filter === 'paid') return Boolean(table.isPaid);
  // Đặt trước là trạng thái phụ có thể chồng lấn: bàn vẫn có thể đang trống hoặc đang phục vụ
  // trong khi đã có một lịch booked/seated được backend gắn vào `nextReservation`.
  if (filter === 'reserved') return Boolean(table.nextReservation);
  return table.status === filter;
}

/** Giữ vị trí sơ đồ ổn định và tự tìm ô trống cho dữ liệu cũ chưa có tọa độ. */
function buildFloorPositions(tables: Table[]): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  const used = new Set<string>();
  const pending: Table[] = [];

  for (const table of tables) {
    const x = Number(table.positionX);
    const y = Number(table.positionY);
    const key = `${x}:${y}`;
    if (Number.isInteger(x) && Number.isInteger(y) && x >= 1 && x <= 24 && y >= 1 && y <= 24 && !used.has(key)) {
      positions.set(table.id, { x, y });
      used.add(key);
    } else {
      pending.push(table);
    }
  }

  for (const table of pending) {
    let assigned = false;
    for (let y = 1; y <= 24 && !assigned; y += 1) {
      for (let x = 1; x <= 24; x += 1) {
        const key = `${x}:${y}`;
        if (used.has(key)) continue;
        positions.set(table.id, { x, y });
        used.add(key);
        assigned = true;
        break;
      }
    }
  }

  return positions;
}

function StatusIcon({ status, size = 14 }: { status: TableStatus; size?: number }) {
  const common = { size, strokeWidth: 2.2, 'aria-hidden': true } as const;
  if (status === 'waiting') return <Hourglass {...common} />;
  if (status === 'cooking') return <Flame {...common} />;
  if (status === 'done') return <BellRing {...common} />;
  if (status === 'reserved') return <CalendarClock {...common} />;
  return <Circle {...common} />;
}

function FilterButton({
  active, attention = false, count, icon, label, onClick, title, tone,
}: {
  active: boolean;
  attention?: boolean;
  count: number;
  icon: ReactNode;
  label: string;
  onClick: () => void;
  title?: string;
  tone: TableFilter;
}) {
  const statusConfig = STATUS_ORDER.includes(tone as TableStatus)
    ? STATUS_CONFIG[tone as TableStatus]
    : null;
  const paletteStyle = statusConfig ? {
    '--filter-accent': statusConfig.dot,
    '--filter-border': statusConfig.border,
    '--filter-bg': statusConfig.bg,
    '--filter-text': statusConfig.text,
  } as CSSProperties : undefined;

  return (
    <button
      type="button"
      className={`table-filter-chip filter-${tone}${active ? ' active' : ''}${attention && count > 0 ? ' attention' : ''}`}
      aria-label={title ? `${label}: ${title}` : undefined}
      aria-pressed={active}
      onClick={onClick}
      style={paletteStyle}
      title={title}
    >
      {icon}<span>{label}</span><strong>{count}</strong>
    </button>
  );
}

function BadgeOverflow({
  items,
  popoverId,
}: {
  items: TableBadgeDetail[];
  popoverId: string;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeAndRestoreFocus = () => {
    setOpen(false);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  };

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      closeAndRestoreFocus();
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  if (items.length === 0) return null;

  return (
    <span className="table-badge-overflow" ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        className="table-more-chip"
        aria-expanded={open}
        aria-controls={popoverId}
        aria-haspopup="dialog"
        aria-label={`Xem ${items.length} thông tin khác`}
        onClick={() => setOpen(current => !current)}
      >
        +{items.length}
      </button>
      {open && (
        <span className="table-badge-popover" id={popoverId} role="dialog" aria-label="Thông tin bổ sung của bàn">
          <span className="table-badge-popover-header">
            <strong>Thông tin khác</strong>
            <button type="button" aria-label="Đóng thông tin bổ sung" onClick={closeAndRestoreFocus}>
              <X size={13} aria-hidden="true" />
            </button>
          </span>
          <span className="table-badge-popover-list">
            {items.map(item => (
              <span key={item.key} className="table-badge-popover-item" data-tone={item.tone} title={item.title}>
                {item.icon}
                <span>{item.label}</span>
              </span>
            ))}
          </span>
        </span>
      )}
    </span>
  );
}

function StatusBadge({ status }: { status: TableStatus }) {
  const config = STATUS_CONFIG[status];
  const isReady = status === 'done';

  return (
    <span className={`operations-status-badge status-${status}`} role={isReady ? 'status' : undefined}>
      <StatusIcon status={status} />
      <span>{isReady ? 'Cần phục vụ' : config.label}</span>
    </span>
  );
}

function TableMeta({ order, seats }: { order?: CartItem[]; seats: number }) {
  const portionCount = order?.reduce((sum, item) => sum + item.quantity, 0) ?? 0;

  return (
    <span className="operations-table-meta-list">
      <span className="operations-table-meta" aria-label={`Sức chứa ${seats} chỗ`} title={`Sức chứa: ${seats} khách`}>
        <Users size={14} aria-hidden="true" />
        <strong>{seats} chỗ</strong>
      </span>
      {portionCount > 0 && (
        <span className="operations-table-meta" aria-label={`Đã gọi ${portionCount} phần`} title={`Tổng số lượng đã gọi: ${portionCount} phần`}>
          <ClipboardList size={14} aria-hidden="true" />
          <strong>{portionCount} phần</strong>
        </span>
      )}
    </span>
  );
}

function ProgressInfo({
  compact,
  hasOrder,
  table,
}: {
  compact: boolean;
  hasOrder: boolean;
  table: Table;
}) {
  const isActive = SERVING_STATUSES.has(table.status);
  if (!isActive || !hasOrder) return null;

  const showBatchProgress = (table.batchCount ?? 0) > 0;

  return (
    <span className="operations-progress-info">
      {(table.status === 'waiting' || table.status === 'cooking') && (
        <OrderTimer table={table} compact={compact} />
      )}
      {showBatchProgress && (
        <span className="operations-service-progress" aria-label="Tiến độ các lượt gọi món">
          <span
            aria-label={`${table.waitingBatchCount ?? 0} lượt gọi món đang chờ bếp`}
            title="Số lượt gọi món đang chờ bếp"
          >
            <strong>{table.waitingBatchCount ?? 0}</strong><small>Chờ</small>
          </span>
          <span
            aria-label={`${table.cookingBatchCount ?? 0} lượt gọi món đang được nấu`}
            title="Số lượt gọi món đang được bếp chế biến"
          >
            <strong>{table.cookingBatchCount ?? 0}</strong><small>Nấu</small>
          </span>
          <span
            aria-label={`${table.doneBatchCount ?? 0} lượt gọi món đã hoàn tất`}
            title="Số lượt gọi món đã được bếp hoàn tất"
          >
            <strong>{table.doneBatchCount ?? 0}</strong><small>Xong</small>
          </span>
        </span>
      )}
    </span>
  );
}

function TableAction({
  hasOrder,
  onOpen,
  onQuickOrder,
  table,
}: {
  hasOrder: boolean;
  onOpen: () => void;
  onQuickOrder: () => void;
  table: Table;
}) {
  const isEmpty = table.status === 'empty';
  const label = isEmpty ? 'Gọi món' : hasOrder ? 'Xem đơn' : 'Chi tiết';

  return (
    <button
      type="button"
      className={`operations-table-action${isEmpty ? ' is-primary' : hasOrder ? ' is-view-order' : ''}`}
      aria-label={`${label} cho bàn ${table.number}`}
      onClick={isEmpty ? onQuickOrder : onOpen}
    >
      {isEmpty ? <ClipboardList size={15} aria-hidden="true" /> : null}
      <span>{label}</span>
      {!isEmpty ? <ArrowRight size={14} aria-hidden="true" /> : null}
    </button>
  );
}

function TableCard({
  table,
  order,
  floor = false,
  compact = false,
  onOpen,
  onQuickOrder,
}: {
  table: Table;
  order?: CartItem[];
  floor?: boolean;
  compact?: boolean;
  onOpen: () => void;
  onQuickOrder: () => void;
}) {
  const cfg = STATUS_CONFIG[table.status];
  const hasOrder = Boolean(order?.length);
  const isReady = table.status === 'done';
  const isOperational = SERVING_STATUSES.has(table.status);
  const areaName = tableArea(table);
  const additionalBatchCount = table.additionalBatchCount ?? 0;
  const cookingStartedAtMs = table.cookingStartedAt ? Date.parse(table.cookingStartedAt) : Number.NaN;
  const cookDurationMs = Math.max(1, table.estimatedCookMinutes ?? 10) * 60_000;
  const cookingRemainingMs = table.status === 'cooking' && Number.isFinite(cookingStartedAtMs)
    ? cookingStartedAtMs + cookDurationMs - getServerNowMs()
    : Number.POSITIVE_INFINITY;
  const nearDeadlineMs = Math.min(3 * 60_000, Math.max(60_000, cookDurationMs * .2));
  const alertLevel = table.kitchenStale || cookingRemainingMs <= 0
    ? 'critical'
    : additionalBatchCount >= 3 || cookingRemainingMs <= nearDeadlineMs
      ? 'warning'
      : 'none';
  const tableBadges: TableBadgeDetail[] = [];
  if (additionalBatchCount > 0) {
    tableBadges.push({
      key: 'addition',
      label: `+${additionalBatchCount} gọi thêm`,
      title: `${additionalBatchCount} lượt gọi thêm`,
      tone: 'addition',
      className: `table-addition-chip${additionalBatchCount === 2 ? ' is-elevated' : ''}${additionalBatchCount >= 3 ? ' is-alert' : ''}`,
    });
  }
  if (table.isPaid) {
    tableBadges.push({
      key: 'paid',
      label: 'Đã trả',
      title: 'Đã thanh toán',
      tone: 'paid',
      className: 'table-paid-chip',
      icon: <BadgeCheck size={12} aria-hidden="true" />,
    });
  }
  if (hasOrder) {
    tableBadges.push({
      key: 'items',
      label: `${order!.length} món`,
      title: `${order!.length} món khác nhau`,
      tone: 'items',
      className: 'table-item-chip',
    });
  }
  const visibleBadges = tableBadges.slice(0, 2);
  const overflowBadges = tableBadges.slice(2);
  const style = {
    '--table-status-accent': cfg.dot,
    '--table-status-soft': cfg.bg,
    '--table-status-border': cfg.border,
    '--table-status-text': cfg.text,
  } as CSSProperties;

  return (
    <article
      className={`operations-table-card status-${table.status}${floor ? ' floor-card' : ''}${isOperational ? ' is-operational' : ''}${alertLevel !== 'none' ? ` alert-${alertLevel}` : ''}`}
      style={style}
    >
      <header className="operations-table-card-header">
        <span className="operations-table-number">{table.number}</span>
        <span className="operations-table-badges">
          {visibleBadges.map(badge => (
            <span key={badge.key} className={badge.className} title={badge.title}>
              {badge.icon}
              {badge.label}
            </span>
          ))}
          <BadgeOverflow items={overflowBadges} popoverId={`table-badges-${table.id}`} />
        </span>
      </header>

      <p className="operations-table-area" title={areaName}>{areaName}</p>

      <div className="operations-table-card-body">
        <div className="operations-table-context">
          <TableMeta order={order} seats={table.seats} />
          {table.nextReservation && (
            <span
              className="operations-reservation-note"
              aria-label={`Đặt trước ${formatReservationTimeRange(table.nextReservation.reservedAt, table.nextReservation.endsAt)}, khách ${table.nextReservation.customerName}`}
              title={`${formatReservationTimeRange(table.nextReservation.reservedAt, table.nextReservation.endsAt)} · ${table.nextReservation.customerName}`}
            >
              <Clock size={12} aria-hidden="true" />
              <time dateTime={table.nextReservation.reservedAt}>
                {formatReservationTimeRange(table.nextReservation.reservedAt, table.nextReservation.endsAt)}
              </time>
              <span className="operations-reservation-separator" aria-hidden="true">·</span>
              <span className="operations-reservation-customer">{table.nextReservation.customerName}</span>
            </span>
          )}
        </div>
        <ProgressInfo compact={compact} hasOrder={hasOrder} table={table} />
      </div>

      <button
        type="button"
        data-table-id={table.id}
        className="operations-table-open"
        onClick={onOpen}
        aria-label={`Bàn ${table.number}, khu vực ${areaName}, ${cfg.label}${isReady ? ', cần phục vụ món' : ''}${table.isPaid ? ', đã thanh toán' : ''}${table.nextReservation ? `. Lịch gần nhất hôm nay ${formatReservationTimeRange(table.nextReservation.reservedAt, table.nextReservation.endsAt)}, ${table.nextReservation.customerName}` : ''}. Mở thao tác bàn.`}
      />

      <footer className="operations-table-card-footer">
        <StatusBadge status={table.status} />
        <TableAction
          hasOrder={hasOrder}
          onOpen={onOpen}
          onQuickOrder={onQuickOrder}
          table={table}
        />
      </footer>
    </article>
  );
}

export function TableSelectStep({
  tables,
  tableOrders,
  waitingBatchesByTable,
  kitchen,
  onStartOrder,
  onEditOrder,
  onDeleteOrder,
  onMarkDone,
  onConfirmDeparture,
  onCheckInReservation,
  onPay,
}: TableSelectStepProps) {
  const [selectedTableId, setSelectedTableId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<TableFilter>('all');
  const [area, setArea] = useState('all');
  const [viewMode, setViewMode] = useState<TableViewMode>(() => (
    window.localStorage.getItem('cas-table-view') === 'floor' ? 'floor' : 'grid'
  ));
  const [density, setDensity] = useState<TableDensity>(() => (
    window.localStorage.getItem('cas-table-density') === 'compact' ? 'compact' : 'comfortable'
  ));
  const selectedTable = tables.find(table => table.id === selectedTableId) ?? null;
  const areas = useMemo(() => [...new Set(tables.map(tableArea))].sort((left, right) => left.localeCompare(right, 'vi')), [tables]);

  useEffect(() => {
    const restoreModalFromHistory = () => {
      const tableId = getTableOptionsHistoryTableId();
      setSelectedTableId(tableId && tables.some(table => table.id === tableId) ? tableId : null);
    };
    restoreModalFromHistory();
    window.addEventListener('popstate', restoreModalFromHistory);
    return () => window.removeEventListener('popstate', restoreModalFromHistory);
  }, [tables]);

  useEffect(() => {
    if (area !== 'all' && !areas.includes(area)) setArea('all');
  }, [area, areas]);

  useEffect(() => {
    window.localStorage.setItem('cas-table-view', viewMode);
  }, [viewMode]);

  useEffect(() => {
    window.localStorage.setItem('cas-table-density', density);
  }, [density]);

  const normalizedSearch = search.trim().toLocaleLowerCase('vi-VN');
  const visibleTables = useMemo(() => tables.filter(table => {
    if (area !== 'all' && tableArea(table) !== area) return false;
    if (!matchesTableFilter(table, filter)) return false;
    if (!normalizedSearch) return true;
    return [String(table.number), tableArea(table), table.nextReservation?.customerName, table.nextReservation?.code]
      .filter(Boolean)
      .some(value => String(value).toLocaleLowerCase('vi-VN').includes(normalizedSearch));
  }), [area, filter, normalizedSearch, tables]);

  const counts = useMemo(() => ({
    all: tables.filter(table => matchesTableFilter(table, 'all')).length,
    serving: tables.filter(table => matchesTableFilter(table, 'serving')).length,
    empty: tables.filter(table => matchesTableFilter(table, 'empty')).length,
    waiting: tables.filter(table => matchesTableFilter(table, 'waiting')).length,
    cooking: tables.filter(table => matchesTableFilter(table, 'cooking')).length,
    done: tables.filter(table => matchesTableFilter(table, 'done')).length,
    reserved: tables.filter(table => matchesTableFilter(table, 'reserved')).length,
    paid: tables.filter(table => matchesTableFilter(table, 'paid')).length,
  }), [tables]);

  const floorAreas = area === 'all' ? areas : areas.filter(item => item === area);

  return (
    <div className={`table-operations-page density-${density}`}>
      <h1 className="sr-only">Vận hành bàn</h1>

      <section className="table-operations-toolbar" aria-label="Tìm và lọc bàn">
        <label className="table-search-field">
          <Search size={18} aria-hidden="true" />
          <span className="sr-only">Tìm bàn</span>
          <input value={search} onChange={event => setSearch(event.target.value)} placeholder="Tìm số bàn, khu vực hoặc tên khách" />
        </label>
        <label className="table-area-filter">
          <span className="sr-only">Lọc theo khu vực</span>
          <select value={area} onChange={event => setArea(event.target.value)}>
            <option value="all">Tất cả khu vực</option>
            {areas.map(item => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>
        <div className="table-display-controls">
          <div className="table-density-toggle" role="group" aria-label="Mật độ thẻ bàn">
            <button type="button" className={density === 'comfortable' ? 'active' : ''} aria-pressed={density === 'comfortable'} onClick={() => setDensity('comfortable')} title="Card lớn, phù hợp màn hình cảm ứng"><Maximize2 size={15} /> Thoáng</button>
            <button type="button" className={density === 'compact' ? 'active' : ''} aria-pressed={density === 'compact'} onClick={() => setDensity('compact')} title="Hiển thị được nhiều bàn hơn"><Minimize2 size={15} /> Thu gọn</button>
          </div>
          <div className="table-view-toggle" role="group" aria-label="Kiểu hiển thị bàn">
            <button type="button" className={viewMode === 'grid' ? 'active' : ''} aria-pressed={viewMode === 'grid'} onClick={() => setViewMode('grid')}><LayoutGrid size={16} /> Lưới</button>
            <button type="button" className={viewMode === 'floor' ? 'active' : ''} aria-pressed={viewMode === 'floor'} onClick={() => setViewMode('floor')}><MapIcon size={16} /> Sơ đồ</button>
          </div>
        </div>
      </section>

      <div className="table-filter-row" aria-label="Thống kê và lọc bàn theo trạng thái">
        <div className="table-filter-primary" role="group" aria-label="Tình trạng sử dụng bàn">
          <FilterButton active={filter === 'all'} count={counts.all} icon={<LayoutGrid size={14} />} label="Tất cả" onClick={() => setFilter('all')} tone="all" />
          <FilterButton active={filter === 'serving'} count={counts.serving} icon={<Users size={14} />} label="Có khách" onClick={() => setFilter('serving')} tone="serving" />
          <FilterButton active={filter === 'empty'} count={counts.empty} icon={<StatusIcon status="empty" />} label={STATUS_CONFIG.empty.label} onClick={() => setFilter('empty')} tone="empty" />
        </div>
        <span className="table-filter-divider" aria-hidden="true" />
        <div
          className="table-filter-secondary"
          role="group"
          aria-label="Tiến trình và cảnh báo; các số liệu có thể chồng lấn"
          title="Các trạng thái trong nhóm này có thể chồng lấn và không nhất thiết cộng lại bằng tổng số bàn."
        >
          <span className="table-filter-group-label">Tiến trình</span>
          {PROGRESS_STATUSES.map(status => (
            <FilterButton
              key={status}
              active={filter === status}
              attention={status === 'done'}
              count={counts[status]}
              icon={<StatusIcon status={status} />}
              label={status === 'done' ? 'Cần phục vụ' : STATUS_CONFIG[status].label}
              onClick={() => setFilter(status)}
              title={status === 'cooking'
                ? `${counts.cooking} bàn đang nấu. Bếp đang sử dụng ${kitchen.cookingCount}/${kitchen.concurrency} suất nấu đồng thời.`
                : undefined}
              tone={status}
            />
          ))}
          <FilterButton active={filter === 'paid'} count={counts.paid} icon={<BadgeCheck size={14} />} label="Đã trả trước" onClick={() => setFilter('paid')} tone="paid" />
        </div>
      </div>

      {visibleTables.length === 0 ? (
        <div className="table-operations-empty">
          <Search size={30} /><strong>Không tìm thấy bàn phù hợp</strong><span>Thử đổi từ khóa, khu vực hoặc trạng thái.</span>
        </div>
      ) : viewMode === 'grid' ? (
        <div className="operations-table-grid">
          {visibleTables.map(table => (
            <TableCard
              key={table.id}
              table={table}
              order={tableOrders[table.id]}
              compact={density === 'compact'}
              onOpen={() => setSelectedTableId(table.id)}
              onQuickOrder={() => onStartOrder(table.id)}
            />
          ))}
        </div>
      ) : (
        <div className="floor-plan-list">
          {floorAreas.map(areaName => {
            const allAreaTables = tables.filter(table => tableArea(table) === areaName).sort((left, right) => left.number - right.number);
            const areaTables = visibleTables.filter(table => tableArea(table) === areaName);
            if (areaTables.length === 0) return null;
            const positions = buildFloorPositions(allAreaTables);
            const compactFloor = density === 'compact';
            const columns = Math.max(4, ...[...positions.values()].map(position => position.x));
            const rows = Math.max(1, ...[...positions.values()].map(position => position.y));
            return (
              <section className="floor-plan-area" key={areaName}>
                <header><div><MapIcon size={18} /><strong>{areaName}</strong></div><span>{areaTables.length} bàn đang hiển thị</span></header>
                <div className="floor-plan-scroll">
                  <div
                    className="floor-plan-grid"
                    style={{
                      gridTemplateColumns: `repeat(${columns}, minmax(${compactFloor ? 180 : 200}px, 1fr))`,
                      gridTemplateRows: `repeat(${rows}, minmax(${compactFloor ? 190 : 220}px, 1fr))`,
                      minWidth: `${columns * (compactFloor ? 194 : 214)}px`,
                    }}
                  >
                    {areaTables.map(table => {
                      const position = positions.get(table.id) ?? { x: 1, y: 1 };
                      return (
                        <div
                          key={table.id}
                          style={{
                            gridColumnStart: position.x,
                            gridRowStart: position.y,
                          }}
                        >
                          <TableCard
                            table={table}
                            order={tableOrders[table.id]}
                            floor
                            compact={compactFloor}
                            onOpen={() => setSelectedTableId(table.id)}
                            onQuickOrder={() => onStartOrder(table.id)}
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
              </section>
            );
          })}
        </div>
      )}

      {selectedTable && (
        <TableOptionsModal
          table={selectedTable}
          order={tableOrders[selectedTable.id]}
          waitingBatches={waitingBatchesByTable[selectedTable.id]}
          onClose={() => setSelectedTableId(null)}
          onStartOrder={() => onStartOrder(selectedTable.id)}
          onEditOrder={batchId => onEditOrder(selectedTable.id, batchId)}
          onDeleteOrder={() => onDeleteOrder(selectedTable.id)}
          onMarkDone={() => onMarkDone(selectedTable.id)}
          onConfirmDeparture={() => onConfirmDeparture(selectedTable.id)}
          onCheckInReservation={() => onCheckInReservation(selectedTable.id)}
          onPay={() => onPay(selectedTable.id)}
        />
      )}
    </div>
  );
}
