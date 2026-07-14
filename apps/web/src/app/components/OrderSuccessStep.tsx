import { CheckCircle, Plus } from 'lucide-react';
import { Table, CartItem, cartEstimatedCookMinutes, cartTotal, formatVND } from '../data';
import { BRAND_ASSETS } from '../config/restaurant';

interface OrderSuccessStepProps {
  orderNumber: string;
  table: Table;
  cart: CartItem[];
  onAddMore: () => void;
  onDone: () => void;
}

export function OrderSuccessStep({ orderNumber, table, cart, onAddMore, onDone }: OrderSuccessStepProps) {
  const total = cartTotal(cart);
  const estimatedCookMinutes = cartEstimatedCookMinutes(cart);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, background: '#F9FAFB' }}>
      {/* Success Header */}
      <div style={{ background: '#fff', padding: '32px 24px 24px', textAlign: 'center', borderBottom: '1px solid #F3F4F6' }}>
        <div style={{
          width: 72, height: 72, background: '#ECFDF5', borderRadius: '50%',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          margin: '0 auto 16px',
          boxShadow: '0 0 0 12px rgba(16,185,129,0.08)',
        }}>
          <CheckCircle size={40} color="#10B981" fill="#10B981" />
        </div>
        <h2 style={{ margin: '0 0 6px', color: '#111827' }}>Order đã gửi bếp!</h2>
        <p style={{ margin: 0, color: '#6B7280', fontSize: '14px' }}>
          Phiếu #{orderNumber} · Bàn {table.number}
        </p>
      </div>

      {/* Order Summary */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px' }}>
        {/* Receipt Card */}
        <div style={{ background: '#fff', borderRadius: 20, overflow: 'hidden', boxShadow: '0 2px 8px rgba(0,0,0,0.06)' }}>
          {/* Receipt Header */}
          <div style={{ background: '#111827', padding: '16px 20px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <img src={BRAND_ASSETS.mark} alt="CAS" style={{ width: 28, height: 28, flexShrink: 0 }} />
                <div>
                <div style={{ color: '#fff', fontWeight: 700, fontSize: '15px' }}>Phiếu gọi món</div>
                <div style={{ color: '#9CA3AF', fontSize: '12px', marginTop: 2 }}>#{orderNumber}</div>
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ color: '#F97316', fontWeight: 700, fontSize: '16px' }}>Bàn {table.number}</div>
                <div style={{ color: '#9CA3AF', fontSize: '12px' }}>{table.seats} chỗ</div>
              </div>
            </div>
          </div>

          {/* Items */}
          <div style={{ padding: '0 20px' }}>
            {cart.map((item, idx) => (
              <div
                key={item.cartId}
                style={{
                  display: 'flex', gap: 12, padding: '14px 0',
                  borderBottom: idx < cart.length - 1 ? '1px solid #F9FAFB' : 'none',
                  alignItems: 'flex-start',
                }}
              >
                <img
                  src={item.menuItem.image}
                  alt={item.menuItem.name}
                  loading="lazy"
                  decoding="async"
                  style={{ width: 44, height: 44, borderRadius: 8, objectFit: 'cover', flexShrink: 0 }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, color: '#111827', fontSize: '13px' }}>
                    {item.menuItem.name}
                  </div>
                  {(item.selectedSize || item.selectedToppings.length > 0) && (
                    <div style={{ fontSize: '11px', color: '#9CA3AF', marginTop: 2 }}>
                      {[
                        item.selectedSize?.label,
                        ...item.selectedToppings.map(t => t.label),
                      ].filter(Boolean).join(' · ')}
                    </div>
                  )}
                  {item.note && (
                    <div style={{ fontSize: '11px', color: '#9CA3AF', fontStyle: 'italic', marginTop: 1 }}>"{item.note}"</div>
                  )}
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <div style={{ fontSize: '12px', color: '#6B7280' }}>x{item.quantity}</div>
                  <div style={{ fontWeight: 700, color: '#F97316', fontSize: '13px' }}>
                    {formatVND(item.menuItem.price + (item.selectedSize?.extraPrice ?? 0) + item.selectedToppings.reduce((s, t) => s + t.price, 0))}
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Total */}
          <div style={{ padding: '14px 20px', borderTop: '2px dashed #F3F4F6', background: '#FAFAFA' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ color: '#374151', fontWeight: 600 }}>Tổng {cart.reduce((s, i) => s + i.quantity, 0)} phần</span>
              <span style={{ fontWeight: 800, fontSize: '18px', color: '#111827' }}>{formatVND(total)}</span>
            </div>
          </div>
        </div>

        <div style={{
          marginTop: 14, background: '#FFFBEB', borderRadius: 14, padding: '12px 16px',
          display: 'flex', gap: 10, alignItems: 'flex-start',
          border: '1px solid #FDE68A',
        }}>
          <span style={{ fontSize: 18 }}>🍳</span>
          <p style={{ margin: 0, fontSize: '13px', color: '#92400E', lineHeight: 1.5 }}>
            Order đã được gửi đến bếp. Thời gian nấu ước tính khoảng <strong>{estimatedCookMinutes} phút</strong>; số phần của từng món đã được tính vào ETA.
          </p>
        </div>
      </div>

      {/* Actions */}
      <div style={{ padding: '14px 16px 24px', background: '#fff', borderTop: '1px solid #F3F4F6', display: 'flex', gap: 10, flexShrink: 0 }}>
        <button
          onClick={onAddMore}
          style={{
            flex: 1, background: '#F3F4F6', color: '#374151', border: 'none',
            borderRadius: 14, padding: '14px', cursor: 'pointer', fontWeight: 600,
            fontSize: '14px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
          }}
        >
          <Plus size={18} /> Thêm món
        </button>
        <button
          onClick={onDone}
          style={{
            flex: 2, background: '#F97316', color: '#fff', border: 'none',
            borderRadius: 14, padding: '14px', cursor: 'pointer', fontWeight: 700,
            fontSize: '14px',
          }}
        >
          Xong · Về trang bàn
        </button>
      </div>
    </div>
  );
}
