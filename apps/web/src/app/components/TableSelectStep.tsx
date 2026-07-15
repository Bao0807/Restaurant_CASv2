import { useEffect, useState } from 'react';
import { Clock, Users } from 'lucide-react';
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
}

function StatusDot({ status }: { status: TableStatus }) {
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
        animation: (status === 'cooking' || status === 'waiting') ? 'pulse 2s infinite' : 'none',
      }}
    />
  );
}

const STATUS_ORDER: TableStatus[] = ['empty', 'waiting', 'cooking', 'done', 'reserved'];

export function TableSelectStep({
  tables,
  tableOrders,
  waitingBatchesByTable,
  kitchen,
  onStartOrder,
  onEditOrder,
  onDeleteOrder,
  onMarkDone,
}: TableSelectStepProps) {
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

  return (
    <div style={{ minHeight: '100%' }}>
      <div style={{ padding: '20px 16px 12px', background: '#fff', borderBottom: '1px solid #F3F4F6' }}>
        <h1 style={{ margin: 0, color: '#111827' }}>Chọn bàn</h1>
        <p style={{ margin: '4px 0 0', color: '#6B7280', fontSize: 14 }}>
          Chọn bàn để gọi món hoặc quản lý phiếu đang phục vụ
        </p>
        <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ background: '#FFEDD5', color: '#C2410C', borderRadius: 999, padding: '4px 9px', fontSize: 11, fontWeight: 800 }}>
            🔥 Đang nấu {kitchen.cookingCount}/{kitchen.concurrency}
          </span>
          <span style={{ background: '#FEF3C7', color: '#B45309', borderRadius: 999, padding: '4px 9px', fontSize: 11, fontWeight: 800 }}>
            ⏱ Hàng chờ {kitchen.waitingCount}
          </span>
        </div>
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

          return (
            <button
              key={table.id}
              type="button"
              data-table-id={table.id}
              onClick={() => setSelectedTableId(table.id)}
              aria-label={`Bàn ${table.number}, ${cfg.label}${table.nextReservation ? `. Lịch kế tiếp ${formatReservationSlot(table.nextReservation.reservedAt)}, ${table.nextReservation.customerName}` : ''}. Mở tùy chọn.`}
              style={{
                background: cfg.bg,
                border: `2px solid ${cfg.border}`,
                borderRadius: 16,
                padding: '16px 14px',
                cursor: 'pointer',
                textAlign: 'left',
                transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
                position: 'relative',
                minHeight: 110,
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <span style={{ fontSize: 28, fontWeight: 700, color: '#111827', lineHeight: 1 }}>{table.number}</span>
                {hasOrder && (
                  <div style={{ display: 'flex', alignItems: 'flex-end', flexDirection: 'column', gap: 4 }}>
                    <span style={{ background: cfg.dot, color: '#fff', fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 20, letterSpacing: '0.04em' }}>
                      {order.length} món
                    </span>
                    {(table.additionalBatchCount ?? 0) > 0 && (
                      <span style={{ background: '#7C3AED', color: '#fff', fontSize: 9, fontWeight: 800, padding: '2px 6px', borderRadius: 20 }}>
                        +{table.additionalBatchCount} gọi thêm
                      </span>
                    )}
                  </div>
                )}
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 4, color: '#9CA3AF', marginTop: 6 }}>
                <Users size={13} />
                <span style={{ fontSize: 12 }}>{table.seats} chỗ</span>
              </div>

              <div style={{ marginTop: 10 }}>
                <div style={{ display: 'inline-flex', alignItems: 'center', background: 'rgba(255,255,255,0.7)', border: `1px solid ${cfg.border}`, borderRadius: 20, padding: '4px 10px' }}>
                  <StatusDot status={table.status} />
                  <span style={{ fontSize: 12, color: cfg.text, fontWeight: 600 }}>{cfg.label}</span>
                </div>
                {table.nextReservation ? (
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 4, marginTop: 7, padding: '6px 7px', borderRadius: 8, background: '#EFF6FF', border: '1px solid #BFDBFE' }}>
                    <Clock size={11} color="#3B82F6" />
                    <span style={{ minWidth: 0, fontSize: 10, lineHeight: 1.35, color: '#1D4ED8', fontWeight: 700 }}>
                      {formatReservationSlot(table.nextReservation.reservedAt)} · {table.nextReservation.customerName} · {table.nextReservation.partySize} khách
                    </span>
                  </div>
                ) : null}
                {(table.status === 'waiting' || table.status === 'cooking') && (
                  <div style={{ marginTop: 6 }}><OrderTimer table={table} /></div>
                )}
                {hasOrder && (table.batchCount ?? 0) > 1 && (
                  <div style={{ marginTop: 5, fontSize: 10, color: '#6D28D9', fontWeight: 700 }}>
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

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>
    </div>
  );
}
