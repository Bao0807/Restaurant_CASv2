import { ArrowLeft, Pencil, Trash2, X, Minus, Plus, Save, AlertCircle, Clock3 } from 'lucide-react';
import { useState } from 'react';
import {
  Table, CartItem, MenuItem, cartEstimatedCookMinutes, cartItemCookMinutes,
  cartItemTotal, cartQuantityForMenuItem, cartTotal, formatVND, getCartStockIssues,
  menuItemDailyAllowance, STATUS_CONFIG,
} from '../data';

interface OrderConfirmStepProps {
  table: Table;
  cart: CartItem[];
  isAddition: boolean;
  isEditing: boolean;
  menuItems: MenuItem[];
  inventoryCredits: Record<string, number>;
  onCartChange: (cart: CartItem[]) => void;
  onBack: () => void;
  onEdit: () => void;
  onPlaceOrder: () => Promise<void>;
}

export function OrderConfirmStep({ table, cart, isAddition, isEditing, menuItems, inventoryCredits, onCartChange, onBack, onEdit, onPlaceOrder }: OrderConfirmStepProps) {
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const cfg = STATUS_CONFIG[table.status];
  const total = cartTotal(cart);
  const estimatedCookMinutes = cartEstimatedCookMinutes(cart);
  const catalog = new Map(menuItems.map(item => [item.id, item]));
  const stockIssues = getCartStockIssues(cart, menuItems, inventoryCredits);

  const handlePlaceOrder = async () => {
    if (submitting || stockIssues.length > 0) return;
    setSubmitting(true);
    try {
      await onPlaceOrder();
    } catch {
      // App hiển thị thông báo lỗi và giữ nguyên order để người dùng thử lại.
    } finally {
      setSubmitting(false);
    }
  };

  const updateQty = (cartId: string, delta: number) => {
    const target = cart.find(item => item.cartId === cartId);
    if (!target) return;
    const latest = catalog.get(target.menuItem.id) ?? target.menuItem;
    const allowance = menuItemDailyAllowance(latest, inventoryCredits[latest.id] ?? 0);
    const currentTotal = cartQuantityForMenuItem(cart, latest.id);
    if (delta > 0 && allowance != null && currentTotal >= allowance) return;
    onCartChange(cart.map(item => item.cartId === cartId
      ? { ...item, menuItem: latest, quantity: Math.min(99, Math.max(1, item.quantity + delta)) }
      : item));
  };

  const remove = (cartId: string) => {
    onCartChange(cart.filter(i => i.cartId !== cartId));
  };

  if (cart.length === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, gap: 16, padding: 24 }}>
        <div style={{ fontSize: 64 }}>🛒</div>
        <p style={{ color: '#6B7280', textAlign: 'center', margin: 0 }}>Giỏ hàng trống. Vui lòng chọn thêm món.</p>
        <button
          onClick={onEdit}
          style={{ background: '#F97316', color: '#fff', border: 'none', borderRadius: 12, padding: '12px 24px', cursor: 'pointer', fontWeight: 600 }}
        >
          ← Thêm món
        </button>
      </div>
    );
  }

  return (
    <div data-page="order-confirm" style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      {/* Header */}
      <div style={{ padding: '12px 16px', background: '#fff', borderBottom: '1px solid #F3F4F6', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
        <button
          aria-label="Quay lại chọn món"
          onClick={onBack}
          style={{ background: '#F3F4F6', border: 'none', borderRadius: 10, width: 44, height: 44, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
        >
          <ArrowLeft size={20} color="#374151" />
        </button>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontWeight: 700, color: '#111827', fontSize: '16px' }}>
              {isEditing ? 'Xác nhận sửa phiếu chờ' : isAddition ? 'Xác nhận gọi thêm' : 'Xác nhận gọi món'}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
            <span style={{ fontSize: '13px', color: '#374151' }}>Bàn {table.number}</span>
            <span style={{
              background: cfg.bg, border: `1px solid ${cfg.border}`,
              color: cfg.text, fontSize: '11px', fontWeight: 600,
              padding: '2px 8px', borderRadius: 20,
            }}>
              {cfg.label}
            </span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            aria-label="Quay lại sửa món"
            onClick={onEdit}
            style={{
              background: '#EEF2FF', border: 'none', borderRadius: 10,
              width: 44, height: 44, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
            title="Thêm/sửa món"
          >
            <Pencil size={18} color="#4F46E5" />
          </button>
          <button
            aria-label="Xóa toàn bộ món"
            onClick={() => setShowClearConfirm(true)}
            style={{
              background: '#FEF2F2', border: 'none', borderRadius: 10,
              width: 44, height: 44, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
            title="Xóa tất cả"
          >
            <Trash2 size={18} color="#EF4444" />
          </button>
        </div>
      </div>

      {/* Items List */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px' }}>
        <div style={{ marginBottom: 8, fontSize: '12px', color: '#9CA3AF', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          {cart.length} món · {cart.reduce((s, i) => s + i.quantity, 0)} phần
        </div>
        {cart.map((item, idx) => {
          const latest = catalog.get(item.menuItem.id) ?? item.menuItem;
          const allowance = menuItemDailyAllowance(latest, inventoryCredits[latest.id] ?? 0);
          const cannotIncrease = item.quantity >= 99
            || (allowance != null && cartQuantityForMenuItem(cart, latest.id) >= allowance);
          return (
          <div
            key={item.cartId}
            style={{
              background: '#fff', borderRadius: 16, padding: '14px',
              marginBottom: 10, border: '1.5px solid #F3F4F6',
              boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
            }}
          >
            <div style={{ display: 'flex', gap: 12 }}>
              <img
                src={item.menuItem.image}
                alt={item.menuItem.name}
                loading="lazy"
                decoding="async"
                style={{ width: 60, height: 60, borderRadius: 10, objectFit: 'cover', flexShrink: 0 }}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <span style={{ fontWeight: 700, color: '#111827', fontSize: '14px', flex: 1, marginRight: 8, lineHeight: 1.3 }}>
                    {item.menuItem.name}
                  </span>
                  <button
                    aria-label={`Xóa ${item.menuItem.name} khỏi lượt gọi`}
                    onClick={() => remove(item.cartId)}
                    style={{ width: 44, height: 44, background: 'none', border: 'none', cursor: 'pointer', padding: 0, flexShrink: 0, display: 'grid', placeItems: 'center' }}
                  >
                    <X size={16} color="#D1D5DB" />
                  </button>
                </div>

                {item.selectedSize && (
                  <div style={{ fontSize: '12px', color: '#6B7280', marginTop: 2 }}>
                    Kích cỡ: <strong>{item.selectedSize.label}</strong>
                    {item.selectedSize.extraPrice > 0 && ` (+${formatVND(item.selectedSize.extraPrice)})`}
                  </div>
                )}
                {item.selectedToppings.length > 0 && (
                  <div style={{ fontSize: '12px', color: '#6B7280', marginTop: 2 }}>
                    {item.selectedToppings.map(t => t.label).join(', ')}
                  </div>
                )}
                {item.note && (
                  <div style={{ fontSize: '11px', color: '#9CA3AF', marginTop: 2, fontStyle: 'italic' }}>
                    Ghi chú: "{item.note}"
                  </div>
                )}
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 5, padding: '3px 7px', borderRadius: 999, background: '#EFF6FF', color: '#1D4ED8', fontSize: 11, fontWeight: 700 }}>
                  <Clock3 size={12} /> {item.menuItem.cookMinutes ?? 10} phút × {item.quantity} = khoảng {cartItemCookMinutes(item)} phút
                </div>
                {allowance != null && (
                  <div style={{ marginTop: 5, color: cannotIncrease ? '#B45309' : '#047857', fontSize: 11, fontWeight: 750 }}>
                    Hạn mức khả dụng hôm nay: {allowance} phần
                  </div>
                )}

                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 10 }}>
                  <div style={{ display: 'flex', alignItems: 'center', background: '#F9FAFB', borderRadius: 10, overflow: 'hidden' }}>
                    <button
                      aria-label={`Giảm số lượng ${item.menuItem.name}`}
                      onClick={() => updateQty(item.cartId, -1)}
                      style={{ width: 44, height: 44, border: 'none', background: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                    >
                      <Minus size={14} color={item.quantity <= 1 ? '#D1D5DB' : '#374151'} />
                    </button>
                    <span style={{ minWidth: 28, textAlign: 'center', fontWeight: 700, color: '#111827', fontSize: '14px' }}>
                      {item.quantity}
                    </span>
                    <button
                      aria-label={`Tăng số lượng ${item.menuItem.name}`}
                      onClick={() => updateQty(item.cartId, 1)}
                      disabled={cannotIncrease}
                      style={{ width: 44, height: 44, border: 'none', background: 'none', cursor: cannotIncrease ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                    >
                      <Plus size={14} color={cannotIncrease ? '#D1D5DB' : '#374151'} />
                    </button>
                  </div>
                  <span style={{ fontWeight: 700, color: '#F97316', fontSize: '15px' }}>
                    {formatVND(cartItemTotal(item))}
                  </span>
                </div>
              </div>
            </div>
          </div>
        );})}
      </div>

      {/* Footer Summary */}
      <div style={{ padding: '14px 16px 24px', borderTop: '1px solid #F3F4F6', background: '#fff', flexShrink: 0 }}>
        <div style={{ background: '#F9FAFB', borderRadius: 14, padding: '12px 14px', marginBottom: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
            <span style={{ color: '#6B7280', fontSize: '13px' }}>Tạm tính</span>
            <span style={{ color: '#374151', fontWeight: 600 }}>{formatVND(total)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, padding: '8px 10px', borderRadius: 10, background: '#ECFEFF', color: '#0F766E' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 700 }}><Clock3 size={15} /> Thời gian nấu ước tính</span>
            <strong>~{estimatedCookMinutes} phút</strong>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
            <span style={{ color: '#6B7280', fontSize: '13px' }}>Bàn {table.number} · {cart.reduce((s, i) => s + i.quantity, 0)} phần</span>
            <span style={{ color: '#6B7280', fontSize: '13px' }}>{table.seats} chỗ</span>
          </div>
          <div style={{ borderTop: '1px dashed #E5E7EB', paddingTop: 8, display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ fontWeight: 700, color: '#111827' }}>Tổng cộng</span>
            <span style={{ fontWeight: 700, fontSize: '18px', color: '#111827' }}>{formatVND(total)}</span>
          </div>
        </div>

        {stockIssues.length > 0 && (
          <div role="alert" style={{ marginBottom: 12, padding: '10px 12px', border: '1px solid #FECACA', borderRadius: 11, background: '#FEF2F2', color: '#B91C1C', fontSize: 12, fontWeight: 750 }}>
            Số lượng vừa thay đổi trên hệ thống: {stockIssues.map(issue => `${issue.name} chọn ${issue.requested}, còn ${issue.allowance}`).join(' · ')}. Hãy giảm số lượng trước khi gửi bếp.
          </div>
        )}

        <button
          onClick={handlePlaceOrder}
          disabled={submitting || stockIssues.length > 0}
          style={{
            width: '100%', background: stockIssues.length > 0 ? '#94A3B8' : '#111827', color: '#fff', border: 'none',
            borderRadius: 14, padding: '15px', cursor: submitting ? 'wait' : stockIssues.length > 0 ? 'not-allowed' : 'pointer', fontWeight: 700,
            fontSize: '15px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
            opacity: submitting ? 0.7 : 1,
          }}
        >
          <Save size={20} />
          {submitting
            ? isEditing ? 'Đang cập nhật…' : 'Đang gửi bếp…'
            : isEditing ? 'Cập nhật phiếu chờ' : isAddition ? 'Gửi phiếu gọi thêm' : 'Gửi bếp'}
        </button>
      </div>

      {/* Clear Confirm Modal */}
      {showClearConfirm && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <div style={{ background: '#fff', borderRadius: 20, padding: 24, width: '100%', maxWidth: 360 }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, textAlign: 'center' }}>
              <div style={{ width: 56, height: 56, background: '#FEF2F2', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <AlertCircle size={28} color="#EF4444" />
              </div>
              <h3 style={{ margin: 0, color: '#111827' }}>Xóa tất cả?</h3>
              <p style={{ margin: 0, color: '#6B7280', fontSize: '14px' }}>Toàn bộ món trong giỏ hàng sẽ bị xóa.</p>
            </div>
            <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
              <button
                onClick={() => setShowClearConfirm(false)}
                style={{ flex: 1, background: '#F3F4F6', border: 'none', borderRadius: 12, padding: '12px', cursor: 'pointer', fontWeight: 600, color: '#374151' }}
              >
                Không
              </button>
              <button
                onClick={() => { onCartChange([]); setShowClearConfirm(false); onBack(); }}
                style={{ flex: 1, background: '#EF4444', border: 'none', borderRadius: 12, padding: '12px', cursor: 'pointer', fontWeight: 700, color: '#fff' }}
              >
                Xóa hết
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
