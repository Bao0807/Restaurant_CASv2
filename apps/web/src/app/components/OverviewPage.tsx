import { useEffect, useState } from 'react';
import { Clock, Users } from 'lucide-react';
import { cartTotal, formatReservationSlot, formatVND, STATUS_CONFIG, type CartItem, type Table, type TableStatus } from '../data';
import type { EditableOrderBatch } from '../services/api';
import { OrderTimer } from './OrderTimer';
import { getTableOptionsHistoryTableId, TableOptionsModal } from './TableOptionsModal';

interface OverviewPageProps {
  tables: Table[];
  tableOrders: Record<string, CartItem[]>;
  waitingBatchesByTable: Record<string, EditableOrderBatch[]>;
  onStartOrder: (tableId: string) => void;
  onEditOrder: (tableId: string, batchId: number) => void;
  onDeleteOrder: (tableId: string) => Promise<void>;
  onMarkDone: (tableId: string) => Promise<void>;
}

const STATUS_ORDER: TableStatus[] = ['empty', 'waiting', 'cooking', 'done', 'reserved'];

function StatusDot({ status, animate }: { status: TableStatus; animate?: boolean }) {
  const cfg = STATUS_CONFIG[status];
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-block',
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: cfg.dot,
        marginRight: 5,
        flexShrink: 0,
        animation: animate ? 'pulse 2s infinite' : 'none',
      }}
    />
  );
}

export function OverviewPage({
  tables,
  tableOrders,
  waitingBatchesByTable,
  onStartOrder,
  onEditOrder,
  onDeleteOrder,
  onMarkDone,
}: OverviewPageProps) {
  const [selectedTableId, setSelectedTableId] = useState<string | null>(null);
  const selectedTable = tables.find(table => table.id === selectedTableId) ?? null;

  useEffect(() => {
    const restoreModalFromHistory = () => {
      const tableId = getTableOptionsHistoryTableId();
      setSelectedTableId(tableId && tables.some(table => table.id === tableId) ? tableId : null);
    };
    restoreModalFromHistory();
    window.addEventListener('popstate', restoreModalFromHistory);
    return () => window.removeEventListener('popstate', restoreModalFromHistory);
  }, [tables]);

  const occupied = tables.filter(table => table.status !== 'empty').length;
  const cooking = tables.filter(table => table.status === 'cooking').length;
  const done = tables.filter(table => table.status === 'done').length;

  return (
    <div style={{ minHeight: '100%' }}>
      <style>{`
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
      `}</style>

      <div style={{ padding: '20px 16px 14px', background: '#fff', borderBottom: '1px solid #F3F4F6' }}>
        <h1 style={{ margin: '0 0 4px', color: '#111827' }}>Tổng quan bàn</h1>
        <p style={{ margin: 0, color: '#6B7280', fontSize: 13 }}>
          Nhấn vào bàn để xem và quản lý
        </p>
      </div>

      <div style={{ display: 'flex', gap: 1, background: '#F3F4F6', overflow: 'hidden' }}>
        {[
          { label: 'Đang phục vụ', value: occupied, color: '#F97316' },
          { label: 'Đang nấu', value: cooking, color: '#EA580C' },
          { label: 'Đã xong', value: done, color: '#15803D' },
          { label: 'Tổng bàn', value: tables.length, color: '#1D4ED8' },
        ].map(stat => (
          <div key={stat.label} style={{ flex: 1, background: '#fff', padding: '12px 10px', textAlign: 'center' }}>
            <div style={{ fontSize: 22, fontWeight: 800, color: stat.color }}>{stat.value}</div>
            <div style={{ fontSize: 10, color: '#9CA3AF', marginTop: 2, fontWeight: 500 }}>{stat.label}</div>
          </div>
        ))}
      </div>

      <div style={{ padding: '10px 16px', background: '#fff', display: 'flex', gap: 12, flexWrap: 'wrap', borderBottom: '1px solid #F3F4F6' }}>
        {STATUS_ORDER.map(status => {
          const cfg = STATUS_CONFIG[status];
          return (
            <div key={status} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <StatusDot status={status} />
              <span style={{ fontSize: 12, color: '#6B7280' }}>{cfg.label}</span>
            </div>
          );
        })}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 12, padding: 16 }}>
        {tables.map(table => {
          const cfg = STATUS_CONFIG[table.status];
          const order = tableOrders[table.id];
          const hasOrder = Boolean(order?.length);
          const total = hasOrder ? cartTotal(order) : 0;

          return (
            <button
              key={table.id}
              type="button"
              onClick={() => setSelectedTableId(table.id)}
              aria-label={`Bàn ${table.number}, ${cfg.label}${table.nextReservation ? `. Lịch kế tiếp ${formatReservationSlot(table.nextReservation.reservedAt)}, ${table.nextReservation.customerName}` : ''}`}
              style={{
                background: cfg.bg,
                border: `2px solid ${cfg.border}`,
                borderRadius: 16,
                padding: 14,
                cursor: 'pointer',
                textAlign: 'left',
                transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
                position: 'relative',
                minHeight: 120,
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
              }}
            >
              {table.status === 'cooking' && (
                <span
                  aria-hidden="true"
                  style={{
                    position: 'absolute',
                    inset: -3,
                    borderRadius: 18,
                    border: '2px solid #F97316',
                    opacity: 0.3,
                    animation: 'pulse 2s infinite',
                    pointerEvents: 'none',
                  }}
                />
              )}

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <span style={{ fontSize: 28, fontWeight: 800, color: '#111827', lineHeight: 1 }}>{table.number}</span>
                {hasOrder && (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                    <span style={{ background: cfg.dot, color: '#fff', fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 20 }}>{formatVND(total)}</span>
                    {(table.additionalBatchCount ?? 0) > 0 && (
                      <span style={{ background: '#7C3AED', color: '#fff', fontSize: 9, fontWeight: 800, padding: '2px 6px', borderRadius: 20 }}>
                        +{table.additionalBatchCount} gọi thêm
                      </span>
                    )}
                  </div>
                )}
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 3, color: '#9CA3AF', margin: '6px 0' }}>
                <Users size={12} />
                <span style={{ fontSize: 12 }}>{table.seats} chỗ</span>
              </div>

              <div>
                <div style={{ display: 'inline-flex', alignItems: 'center', background: 'rgba(255,255,255,0.75)', border: `1px solid ${cfg.border}`, borderRadius: 20, padding: '3px 8px' }}>
                  <StatusDot status={table.status} animate={table.status === 'cooking' || table.status === 'waiting'} />
                  <span style={{ fontSize: 11, color: cfg.text, fontWeight: 600 }}>{cfg.label}</span>
                </div>
                {table.nextReservation ? (
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 4, marginTop: 7, padding: '6px 7px', borderRadius: 8, background: '#EFF6FF', border: '1px solid #BFDBFE' }}>
                    <Clock size={11} color="#3B82F6" />
                    <span style={{ minWidth: 0, fontSize: 10, lineHeight: 1.35, color: '#1D4ED8', fontWeight: 700 }}>
                      {formatReservationSlot(table.nextReservation.reservedAt)} · {table.nextReservation.customerName} · {table.nextReservation.partySize} khách
                    </span>
                  </div>
                ) : null}
                {hasOrder && (
                  <div style={{ fontSize: 10, color: '#9CA3AF', marginTop: 3 }}>
                    {order.reduce((sum, item) => sum + item.quantity, 0)} phần
                  </div>
                )}
                <div style={{ marginTop: 6 }}><OrderTimer table={table} compact /></div>
                {hasOrder && (table.batchCount ?? 0) > 1 && (
                  <div style={{ marginTop: 4, fontSize: 10, color: '#6D28D9', fontWeight: 700 }}>
                    {table.cookingBatchCount ?? 0} lượt nấu · {table.waitingBatchCount ?? 0} lượt chờ · {table.doneBatchCount ?? 0} xong
                  </div>
                )}
              </div>
            </button>
          );
        })}
      </div>

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
        />
      )}
    </div>
  );
}
