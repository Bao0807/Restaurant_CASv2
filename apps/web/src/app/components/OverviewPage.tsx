import { useState } from 'react';
import { Users, Clock, X, ClipboardList, Pencil, Trash2, AlertCircle, ChevronRight } from 'lucide-react';
import { Table, TableStatus, CartItem, STATUS_CONFIG, cartTotal, formatVND } from '../data';
import { OrderTimer } from './OrderTimer';

interface OverviewPageProps {
  tables: Table[];
  tableOrders: Record<string, CartItem[]>;
  onStartOrder: (tableId: string) => void;
  onDeleteOrder: (tableId: string) => Promise<void>;
  onMarkDone: (tableId: string) => Promise<void>;
}

const STATUS_ORDER: TableStatus[] = ['empty', 'waiting', 'cooking', 'done', 'reserved'];

function StatusDot({ status, animate }: { status: TableStatus; animate?: boolean }) {
  const cfg = STATUS_CONFIG[status];
  return (
    <span style={{
      display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
      background: cfg.dot, marginRight: 5, flexShrink: 0,
      animation: animate ? 'pulse 2s infinite' : 'none',
    }} />
  );
}

function TableOptionsModal({
  table,
  order,
  onClose,
  onStartOrder,
  onDeleteOrder,
  onMarkDone,
}: {
  table: Table;
  order?: CartItem[];
  onClose: () => void;
  onStartOrder: () => void;
  onDeleteOrder: () => Promise<void>;
  onMarkDone: () => Promise<void>;
}) {
  const cfg = STATUS_CONFIG[table.status];
  const hasOrder = order && order.length > 0;
  const isCooking = table.status === 'cooking';
  const total = hasOrder ? cartTotal(order!) : 0;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="table-options-title"
      style={{ position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}
      onClick={onClose}
    >
      <div
        style={{ background: '#fff', borderRadius: '24px 24px 0 0', width: '100%', maxWidth: 520, maxHeight: '85vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div style={{ padding: '16px 20px 12px', borderBottom: '1px solid #F3F4F6', display: 'flex', alignItems: 'center', gap: 12 }}>
          <div
            style={{
              width: 48, height: 48, borderRadius: 14, background: cfg.bg,
              border: `2px solid ${cfg.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <span style={{ fontWeight: 800, color: '#111827', fontSize: '18px' }}>{table.number}</span>
          </div>
          <div style={{ flex: 1 }}>
            <div id="table-options-title" style={{ fontWeight: 700, color: '#111827', fontSize: '16px' }}>Bàn {table.number}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 }}>
              <StatusDot status={table.status} animate={isCooking || table.status === 'waiting'} />
              <span style={{ fontSize: '13px', color: cfg.text, fontWeight: 600 }}>{cfg.label}</span>
              <span style={{ fontSize: '12px', color: '#9CA3AF' }}>· {table.seats} chỗ</span>
              {table.status === 'reserved' && table.reservedTime && (
                <span style={{ fontSize: '12px', color: '#3B82F6' }}>· {table.reservedTime}</span>
              )}
            </div>
            <div style={{ marginTop: 6 }}><OrderTimer table={table} compact /></div>
          </div>
          <button aria-label="Đóng tùy chọn bàn" onClick={onClose} style={{ background: '#F3F4F6', border: 'none', borderRadius: '50%', width: 36, height: 36, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <X size={18} color="#374151" />
          </button>
        </div>

        {/* Order Preview */}
        {hasOrder && (
          <div style={{ padding: '12px 20px', background: '#FAFAFA', borderBottom: '1px solid #F3F4F6', maxHeight: 180, overflowY: 'auto' }}>
            <div style={{ fontSize: '12px', color: '#9CA3AF', fontWeight: 600, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              Món đã gọi ({order!.reduce((s, i) => s + i.quantity, 0)} phần)
            </div>
            {order!.map(item => (
              <div key={item.cartId} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                <span style={{ fontSize: '13px', color: '#374151' }}>
                  {item.menuItem.name}
                  {item.selectedSize ? ` (${item.selectedSize.label})` : ''}
                  {' '}x{item.quantity}
                </span>
                <span style={{ fontSize: '13px', fontWeight: 600, color: '#F97316' }}>
                  {formatVND((item.menuItem.price + (item.selectedSize?.extraPrice ?? 0) + item.selectedToppings.reduce((s, t) => s + t.price, 0)) * item.quantity)}
                </span>
              </div>
            ))}
            <div style={{ borderTop: '1px dashed #E5E7EB', paddingTop: 8, display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ fontWeight: 700, fontSize: '14px', color: '#111827' }}>Tổng</span>
              <span style={{ fontWeight: 700, fontSize: '14px', color: '#111827' }}>{formatVND(total)}</span>
            </div>
          </div>
        )}

        {/* Actions */}
        <div style={{ padding: '12px 20px 28px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {/* Start/Add order */}
          {(table.status === 'empty' || hasOrder) && (
            <button
              onClick={() => { onStartOrder(); onClose(); }}
              style={{
                display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px',
                background: '#FFF7ED', border: '1.5px solid #FDBA74', borderRadius: 14,
                cursor: 'pointer', textAlign: 'left', width: '100%',
              }}
            >
              <div style={{ width: 40, height: 40, background: '#F97316', borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                {hasOrder ? <Pencil size={18} color="#fff" /> : <ClipboardList size={18} color="#fff" />}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, color: '#111827', fontSize: '14px' }}>
                  {hasOrder ? 'Thêm / sửa món' : 'Gọi món cho bàn này'}
                </div>
                <div style={{ fontSize: '12px', color: '#6B7280', marginTop: 2 }}>
                  {hasOrder ? 'Thêm món mới hoặc sửa đơn hàng' : 'Mở menu và chọn món'}
                </div>
              </div>
              <ChevronRight size={18} color="#9CA3AF" />
            </button>
          )}

          {/* Mark as done */}
          {table.status === 'cooking' && (
            <button
              onClick={() => { onMarkDone(); onClose(); }}
              style={{
                display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px',
                background: '#F0FDF4', border: '1.5px solid #86EFAC', borderRadius: 14,
                cursor: 'pointer', textAlign: 'left', width: '100%',
              }}
            >
              <div style={{ width: 40, height: 40, background: '#22C55E', borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <span style={{ fontSize: 18 }}>✅</span>
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, color: '#111827', fontSize: '14px' }}>Đánh dấu xong nấu</div>
                <div style={{ fontSize: '12px', color: '#6B7280', marginTop: 2 }}>Chuyển trạng thái sang "Đã xong"</div>
              </div>
              <ChevronRight size={18} color="#9CA3AF" />
            </button>
          )}

          {/* Delete order */}
          {hasOrder && (
            <button
              onClick={() => {
                if (!isCooking) { onDeleteOrder(); onClose(); }
              }}
              disabled={isCooking}
              style={{
                display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px',
                background: isCooking ? '#F9FAFB' : '#FEF2F2',
                border: `1.5px solid ${isCooking ? '#E5E7EB' : '#FECACA'}`,
                borderRadius: 14,
                cursor: isCooking ? 'not-allowed' : 'pointer', textAlign: 'left', width: '100%',
                opacity: isCooking ? 0.65 : 1,
              }}
            >
              <div style={{ width: 40, height: 40, background: isCooking ? '#E5E7EB' : '#EF4444', borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <Trash2 size={18} color="#fff" />
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, color: isCooking ? '#9CA3AF' : '#DC2626', fontSize: '14px' }}>
                  Hủy order
                </div>
                <div style={{ fontSize: '12px', color: '#6B7280', marginTop: 2, display: 'flex', alignItems: 'center', gap: 4 }}>
                  {isCooking && <AlertCircle size={11} color="#F59E0B" />}
                  {isCooking ? 'Không thể hủy khi đang nấu' : 'Xóa toàn bộ đơn gọi món'}
                </div>
              </div>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function OverviewPage({ tables, tableOrders, onStartOrder, onDeleteOrder, onMarkDone }: OverviewPageProps) {
  const [selectedTableId, setSelectedTableId] = useState<string | null>(null);
  const selectedTable = tables.find(table => table.id === selectedTableId) ?? null;

  const occupied = tables.filter(t => t.status !== 'empty').length;
  const cooking = tables.filter(t => t.status === 'cooking').length;
  const done = tables.filter(t => t.status === 'done').length;

  return (
    <div style={{ minHeight: '100%' }}>
      <style>{`
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
      `}</style>

      {/* Header */}
      <div style={{ padding: '20px 16px 14px', background: '#fff', borderBottom: '1px solid #F3F4F6' }}>
        <h1 style={{ margin: '0 0 4px', color: '#111827' }}>Tổng quan bàn</h1>
        <p style={{ margin: 0, color: '#6B7280', fontSize: '13px' }}>
          Nhấn vào bàn để xem và quản lý
        </p>
      </div>

      {/* Stats Bar */}
      <div style={{ display: 'flex', gap: 1, background: '#F3F4F6', overflow: 'hidden' }}>
        {[
          { label: 'Đang phục vụ', value: occupied, bg: '#FFF7ED', color: '#F97316', border: '#FDBA74' },
          { label: 'Đang nấu', value: cooking, bg: '#FFF7ED', color: '#EA580C', border: '#FDBA74' },
          { label: 'Đã xong', value: done, bg: '#F0FDF4', color: '#15803D', border: '#86EFAC' },
          { label: 'Tổng bàn', value: tables.length, bg: '#EFF6FF', color: '#1D4ED8', border: '#93C5FD' },
        ].map(s => (
          <div key={s.label} style={{ flex: 1, background: '#fff', padding: '12px 10px', textAlign: 'center' }}>
            <div style={{ fontSize: '22px', fontWeight: 800, color: s.color }}>{s.value}</div>
            <div style={{ fontSize: '10px', color: '#9CA3AF', marginTop: 2, fontWeight: 500 }}>{s.label}</div>
          </div>
        ))}
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
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 12, padding: 16 }}>
        {tables.map(table => {
          const cfg = STATUS_CONFIG[table.status];
          const order = tableOrders[table.id];
          const hasOrder = order && order.length > 0;
          const total = hasOrder ? cartTotal(order!) : 0;

          return (
            <button
              key={table.id}
              onClick={() => setSelectedTableId(table.id)}
              style={{
                background: cfg.bg, border: `2px solid ${cfg.border}`,
                borderRadius: 16, padding: '14px', cursor: 'pointer', textAlign: 'left',
                transition: 'all 0.15s ease', position: 'relative',
                minHeight: 120, display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
              }}
            >
              {/* Pulsing ring for cooking */}
              {table.status === 'cooking' && (
                <span style={{
                  position: 'absolute', inset: -3, borderRadius: 18,
                  border: '2px solid #F97316', opacity: 0.3,
                  animation: 'pulse 2s infinite',
                  pointerEvents: 'none',
                }} />
              )}

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <span style={{ fontSize: '28px', fontWeight: 800, color: '#111827', lineHeight: 1 }}>
                  {table.number}
                </span>
                {hasOrder && (
                  <span style={{
                    background: cfg.dot, color: '#fff', fontSize: '10px', fontWeight: 700,
                    padding: '2px 6px', borderRadius: 20,
                  }}>
                    {formatVND(total)}
                  </span>
                )}
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 3, color: '#9CA3AF', margin: '6px 0' }}>
                <Users size={12} />
                <span style={{ fontSize: '12px' }}>{table.seats} chỗ</span>
              </div>

              <div>
                <div style={{
                  display: 'inline-flex', alignItems: 'center',
                  background: 'rgba(255,255,255,0.75)', border: `1px solid ${cfg.border}`,
                  borderRadius: 20, padding: '3px 8px',
                }}>
                  <StatusDot status={table.status} animate={table.status === 'cooking' || table.status === 'waiting'} />
                  <span style={{ fontSize: '11px', color: cfg.text, fontWeight: 600 }}>{cfg.label}</span>
                </div>
                {table.status === 'reserved' && table.reservedTime && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 3, marginTop: 4 }}>
                    <Clock size={11} color="#3B82F6" />
                    <span style={{ fontSize: '11px', color: '#3B82F6', fontWeight: 600 }}>{table.reservedTime}</span>
                  </div>
                )}
                {hasOrder && (
                  <div style={{ fontSize: '10px', color: '#9CA3AF', marginTop: 3 }}>
                    {order!.reduce((s, i) => s + i.quantity, 0)} phần
                  </div>
                )}
                <div style={{ marginTop: 6 }}><OrderTimer table={table} compact /></div>
              </div>
            </button>
          );
        })}
      </div>

      {/* Options Modal */}
      {selectedTable && (
        <TableOptionsModal
          table={selectedTable}
          order={tableOrders[selectedTable.id]}
          onClose={() => setSelectedTableId(null)}
          onStartOrder={() => onStartOrder(selectedTable.id)}
          onDeleteOrder={() => onDeleteOrder(selectedTable.id)}
          onMarkDone={() => onMarkDone(selectedTable.id)}
        />
      )}
    </div>
  );
}
