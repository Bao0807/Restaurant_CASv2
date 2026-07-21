import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import {
  BadgeCheck, BellRing, CalendarClock, Circle, Clock, Flame, Hourglass,
  LayoutGrid, Map as MapIcon, Search, Users,
} from 'lucide-react';
import type { CartItem, KitchenStatus, Table, TableStatus } from '../data';
import type { EditableOrderBatch } from '../services/api';
import { formatReservationSlot, STATUS_CONFIG } from '../data';
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
}

type TableFilter = 'all' | TableStatus | 'paid';
type TableViewMode = 'grid' | 'floor';

const STATUS_ORDER: TableStatus[] = ['empty', 'waiting', 'cooking', 'done', 'reserved'];
const DEFAULT_AREA = 'Khu vực chung';

function tableArea(table: Table): string {
  return table.area?.trim() || DEFAULT_AREA;
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
  active, count, icon, label, onClick,
}: {
  active: boolean;
  count: number;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button type="button" className={`table-filter-chip${active ? ' active' : ''}`} aria-pressed={active} onClick={onClick}>
      {icon}<span>{label}</span><strong>{count}</strong>
    </button>
  );
}

function TableCard({
  table,
  order,
  floor = false,
  onOpen,
}: {
  table: Table;
  order?: CartItem[];
  floor?: boolean;
  onOpen: () => void;
}) {
  const cfg = STATUS_CONFIG[table.status];
  const hasOrder = Boolean(order?.length);
  const portionCount = order?.reduce((sum, item) => sum + item.quantity, 0) ?? 0;
  const isReady = table.status === 'done';
  const style = {
    '--table-card-bg': cfg.bg,
    '--table-card-border': cfg.border,
    '--table-card-text': cfg.text,
  } as CSSProperties;

  return (
    <button
      type="button"
      data-table-id={table.id}
      className={`operations-table-card status-${table.status}${floor ? ' floor-card' : ''}${isReady ? ' ready-card' : ''}`}
      onClick={onOpen}
      aria-label={`Bàn ${table.number}, khu vực ${tableArea(table)}, ${cfg.label}${isReady ? ', cần phục vụ món' : ''}${table.isPaid ? ', đã thanh toán' : ''}${table.nextReservation ? `. Lịch kế tiếp ${formatReservationSlot(table.nextReservation.reservedAt)}, ${table.nextReservation.customerName}` : ''}. Mở thao tác bàn.`}
      style={style}
    >
      <span className="operations-table-card-header">
        <span className="operations-table-number">{table.number}</span>
        <span className="operations-table-badges">
          {table.isPaid && (
            <span className="table-paid-chip" title="Đã thanh toán"><BadgeCheck size={12} /> Đã trả</span>
          )}
          {hasOrder && <span className="table-item-chip">{order!.length} món</span>}
          {(table.additionalBatchCount ?? 0) > 0 && (
            <span className="table-addition-chip">+{table.additionalBatchCount} gọi thêm</span>
          )}
        </span>
      </span>

      <span className="operations-table-area">{tableArea(table)}</span>

      <span className="operations-table-meta"><Users size={14} aria-hidden="true" /> {table.seats} chỗ{hasOrder ? ` · ${portionCount} phần` : ''}</span>

      <span className="operations-table-card-footer">
        <span className={`operations-status-pill status-${table.status}`}>
          <StatusIcon status={table.status} />
          <span>{cfg.label}</span>
        </span>

        {table.nextReservation && (
          <span className="operations-reservation-note">
            <Clock size={12} aria-hidden="true" />
            <span>{formatReservationSlot(table.nextReservation.reservedAt)} · {table.nextReservation.customerName}</span>
          </span>
        )}

        {(table.status === 'waiting' || table.status === 'cooking') && <OrderTimer table={table} />}

        {isReady && (
          <span className="operations-ready-notice" role="status">
            <BellRing size={14} aria-hidden="true" /> Món đã xong · cần phục vụ
          </span>
        )}

        {hasOrder && (table.batchCount ?? 0) > 1 && (
          <span className="operations-batch-summary">
            {table.cookingBatchCount ?? 0} nấu · {table.waitingBatchCount ?? 0} chờ · {table.doneBatchCount ?? 0} xong
          </span>
        )}
      </span>
    </button>
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
}: TableSelectStepProps) {
  const [selectedTableId, setSelectedTableId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<TableFilter>('all');
  const [area, setArea] = useState('all');
  const [viewMode, setViewMode] = useState<TableViewMode>(() => (
    window.localStorage.getItem('cas-table-view') === 'floor' ? 'floor' : 'grid'
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

  const normalizedSearch = search.trim().toLocaleLowerCase('vi-VN');
  const visibleTables = useMemo(() => tables.filter(table => {
    if (area !== 'all' && tableArea(table) !== area) return false;
    if (filter === 'paid' ? !table.isPaid : filter !== 'all' && table.status !== filter) return false;
    if (!normalizedSearch) return true;
    return [String(table.number), tableArea(table), table.nextReservation?.customerName, table.nextReservation?.code]
      .filter(Boolean)
      .some(value => String(value).toLocaleLowerCase('vi-VN').includes(normalizedSearch));
  }), [area, filter, normalizedSearch, tables]);

  const counts = useMemo(() => ({
    all: tables.length,
    empty: tables.filter(table => table.status === 'empty').length,
    waiting: tables.filter(table => table.status === 'waiting').length,
    cooking: tables.filter(table => table.status === 'cooking').length,
    done: tables.filter(table => table.status === 'done').length,
    reserved: tables.filter(table => table.status === 'reserved').length,
    paid: tables.filter(table => table.isPaid).length,
  }), [tables]);

  const floorAreas = area === 'all' ? areas : areas.filter(item => item === area);

  return (
    <div className="table-operations-page">
      <header className="table-operations-hero">
        <div>
          <h1>Vận hành bàn</h1>
          <p>Gọi món, theo dõi bếp và xử lý bàn tại một nơi</p>
        </div>
        <div className="table-operations-kitchen" aria-label="Tình trạng vận hành bàn">
          <span className="serving"><Users size={15} /> Đang phục vụ <strong>{counts.waiting + counts.cooking + counts.done}</strong></span>
          <span className="cooking"><Flame size={15} /> Đang nấu <strong>{kitchen.cookingCount}/{kitchen.concurrency}</strong></span>
          <span className="waiting"><Hourglass size={15} /> Đang chờ <strong>{kitchen.waitingCount}</strong></span>
          {counts.done > 0 && <span className="ready"><BellRing size={15} /> Cần phục vụ <strong>{counts.done}</strong></span>}
          <span className="reserved"><CalendarClock size={15} /> Đặt trước <strong>{counts.reserved}</strong></span>
          <span className="paid"><BadgeCheck size={15} /> Đã trả trước <strong>{counts.paid}</strong></span>
        </div>
      </header>

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
        <div className="table-view-toggle" role="group" aria-label="Kiểu hiển thị bàn">
          <button type="button" className={viewMode === 'grid' ? 'active' : ''} aria-pressed={viewMode === 'grid'} onClick={() => setViewMode('grid')}><LayoutGrid size={17} /> Lưới</button>
          <button type="button" className={viewMode === 'floor' ? 'active' : ''} aria-pressed={viewMode === 'floor'} onClick={() => setViewMode('floor')}><MapIcon size={17} /> Sơ đồ</button>
        </div>
      </section>

      <div className="table-filter-row" role="group" aria-label="Lọc theo trạng thái">
        <FilterButton active={filter === 'all'} count={counts.all} icon={<LayoutGrid size={14} />} label="Tất cả" onClick={() => setFilter('all')} />
        {STATUS_ORDER.map(status => (
          <FilterButton
            key={status}
            active={filter === status}
            count={counts[status]}
            icon={<StatusIcon status={status} />}
            label={status === 'done' ? 'Cần phục vụ' : STATUS_CONFIG[status].label}
            onClick={() => setFilter(status)}
          />
        ))}
        <FilterButton active={filter === 'paid'} count={counts.paid} icon={<BadgeCheck size={14} />} label="Đã trả" onClick={() => setFilter('paid')} />
      </div>

      {visibleTables.length === 0 ? (
        <div className="table-operations-empty">
          <Search size={30} /><strong>Không tìm thấy bàn phù hợp</strong><span>Thử đổi từ khóa, khu vực hoặc trạng thái.</span>
        </div>
      ) : viewMode === 'grid' ? (
        <div className="operations-table-grid">
          {visibleTables.map(table => (
            <TableCard key={table.id} table={table} order={tableOrders[table.id]} onOpen={() => setSelectedTableId(table.id)} />
          ))}
        </div>
      ) : (
        <div className="floor-plan-list">
          {floorAreas.map(areaName => {
            const allAreaTables = tables.filter(table => tableArea(table) === areaName).sort((left, right) => left.number - right.number);
            const areaTables = visibleTables.filter(table => tableArea(table) === areaName);
            if (areaTables.length === 0) return null;
            const positions = buildFloorPositions(allAreaTables);
            const columns = Math.max(4, ...[...positions.values()].map(position => position.x));
            const rows = Math.max(1, ...[...positions.values()].map(position => position.y));
            return (
              <section className="floor-plan-area" key={areaName}>
                <header><div><MapIcon size={18} /><strong>{areaName}</strong></div><span>{areaTables.length} bàn đang hiển thị</span></header>
                <div className="floor-plan-scroll">
                  <div
                    className="floor-plan-grid"
                    style={{
                      gridTemplateColumns: `repeat(${columns}, minmax(132px, 1fr))`,
                      gridTemplateRows: `repeat(${rows}, minmax(190px, auto))`,
                      minWidth: `${columns * 148}px`,
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
                          <TableCard table={table} order={tableOrders[table.id]} floor onOpen={() => setSelectedTableId(table.id)} />
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
        />
      )}
    </div>
  );
}
