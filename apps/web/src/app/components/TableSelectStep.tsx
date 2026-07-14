import { Users, Clock } from 'lucide-react';
import type { Table, TableStatus, CartItem, KitchenStatus } from '../data';
import { STATUS_CONFIG } from '../data';
import { OrderTimer } from './OrderTimer';

interface TableSelectStepProps {
  tables: Table[];
  tableOrders: Record<string, CartItem[]>;
  kitchen: KitchenStatus;
  onSelectTable: (tableId: string) => void;
}

function StatusDot({ status }: { status: TableStatus }) {
  const cfg = STATUS_CONFIG[status];
  return (
    <span
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

export function TableSelectStep({ tables, tableOrders, kitchen, onSelectTable }: TableSelectStepProps) {
  return (
    <div style={{ minHeight: '100%' }}>
      {/* Header */}
      <div style={{ padding: '20px 16px 12px', background: '#fff', borderBottom: '1px solid #F3F4F6' }}>
        <h1 style={{ margin: 0, color: '#111827' }}>Chọn Bàn</h1>
        <p style={{ margin: '4px 0 0', color: '#6B7280', fontSize: '14px' }}>
          Chọn bàn để bắt đầu gọi món
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

      {/* Legend */}
      <div style={{ padding: '10px 16px', background: '#fff', display: 'flex', gap: 12, flexWrap: 'wrap', borderBottom: '1px solid #F3F4F6' }}>
        {STATUS_ORDER.map(s => {
          const cfg = STATUS_CONFIG[s];
          return (
            <div key={s} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <StatusDot status={s} />
              <span style={{ fontSize: '12px', color: '#6B7280' }}>{cfg.label}</span>
            </div>
          );
        })}
      </div>

      {/* Table Grid */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
          gap: 12,
          padding: 16,
        }}
      >
        {tables.map(table => {
          const cfg = STATUS_CONFIG[table.status];
          const hasOrder = !!tableOrders[table.id];
          const isSelectable = table.status !== 'reserved';
          return (
            <button
              key={table.id}
              data-table-id={table.id}
              onClick={() => isSelectable && onSelectTable(table.id)}
              disabled={!isSelectable}
              style={{
                background: cfg.bg,
                border: `2px solid ${cfg.border}`,
                borderRadius: 16,
                padding: '16px 14px',
                cursor: isSelectable ? 'pointer' : 'not-allowed',
                textAlign: 'left',
                transition: 'all 0.15s ease',
                opacity: isSelectable ? 1 : 0.65,
                position: 'relative',
                minHeight: 110,
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
              }}
            >
              {/* Table Number */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <span style={{ fontSize: '28px', fontWeight: 700, color: '#111827', lineHeight: 1 }}>
                  {table.number}
                </span>
                {hasOrder && (
                  <span
                    style={{
                      background: cfg.dot,
                      color: '#fff',
                      fontSize: '10px',
                      fontWeight: 700,
                      padding: '2px 6px',
                      borderRadius: 20,
                      letterSpacing: '0.04em',
                    }}
                  >
                    {tableOrders[table.id]?.length || 0} món
                  </span>
                )}
              </div>

              {/* Seat Count */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, color: '#9CA3AF', marginTop: 6 }}>
                <Users size={13} />
                <span style={{ fontSize: '12px' }}>{table.seats} chỗ</span>
              </div>

              {/* Status Badge */}
              <div style={{ marginTop: 10 }}>
                <div
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    background: 'rgba(255,255,255,0.7)',
                    border: `1px solid ${cfg.border}`,
                    borderRadius: 20,
                    padding: '4px 10px',
                  }}
                >
                  <StatusDot status={table.status} />
                  <span style={{ fontSize: '12px', color: cfg.text, fontWeight: 600 }}>
                    {cfg.label}
                  </span>
                </div>
                {table.status === 'reserved' && table.reservedTime && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 4 }}>
                    <Clock size={11} color="#3B82F6" />
                    <span style={{ fontSize: '11px', color: '#3B82F6' }}>{table.reservedTime}</span>
                  </div>
                )}
                {(table.status === 'waiting' || table.status === 'cooking') && (
                  <div style={{ marginTop: 6 }}><OrderTimer table={table} /></div>
                )}
              </div>
            </button>
          );
        })}
      </div>

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>
    </div>
  );
}
