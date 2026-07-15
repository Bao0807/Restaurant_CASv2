import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ShoppingCart, Plus, Minus, X, Star, Sparkles, ChevronRight } from 'lucide-react';
import {
  STATUS_CONFIG,
  CartItem, MenuCategory, MenuItem, MenuItemSize, Topping, Table,
  cartItemTotal, cartTotal, formatVND, genId,
} from '../data';

interface MenuStepProps {
  table: Table;
  cart: CartItem[];
  categories: MenuCategory[];
  menuItems: MenuItem[];
  isAddition: boolean;
  isEditing: boolean;
  onCartChange: (cart: CartItem[]) => void;
  onBack: () => void;
  onConfirm: () => void;
}

interface CustomizerState {
  item: MenuItem;
  editCartId?: string;
  quantity: number;
  selectedSize?: MenuItemSize;
  selectedToppings: Topping[];
  note: string;
}

type MenuOverlayHistory =
  | { type: 'customizer'; itemId: string }
  | { type: 'cart' };

const MENU_OVERLAY_HISTORY_KEY = 'casMenuOverlay';

function getMenuOverlayHistory(state: unknown = window.history.state): MenuOverlayHistory | null {
  if (!state || typeof state !== 'object') return null;
  const value = (state as Record<string, unknown>)[MENU_OVERLAY_HISTORY_KEY];
  if (!value || typeof value !== 'object') return null;
  const overlay = value as Partial<MenuOverlayHistory>;
  if (overlay.type === 'cart') return { type: 'cart' };
  if (overlay.type === 'customizer' && typeof overlay.itemId === 'string') {
    return { type: 'customizer', itemId: overlay.itemId };
  }
  return null;
}

/** Khóa focus trong sheet, hỗ trợ Escape và trả focus về nút đã mở sheet. */
function useAccessibleSheet(onClose: () => void) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const initialFocusRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? []);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', handleKeyDown);
    initialFocusRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown);
      previouslyFocused?.focus();
    };
  }, []);

  return { dialogRef, initialFocusRef };
}

function ItemCustomizerModal({
  state,
  onClose,
  onAdd,
}: {
  state: CustomizerState;
  onClose: () => void;
  onAdd: (state: CustomizerState) => void;
}) {
  const { dialogRef, initialFocusRef } = useAccessibleSheet(onClose);
  const [qty, setQty] = useState(state.quantity);
  const [size, setSize] = useState<MenuItemSize | undefined>(state.selectedSize);
  const [toppings, setToppings] = useState<Topping[]>(state.selectedToppings);
  const [note, setNote] = useState(state.note);

  const { item } = state;
  const sizeExtra = size?.extraPrice ?? 0;
  const toppingExtra = toppings.reduce((s, t) => s + t.price, 0);
  const lineTotal = (item.price + sizeExtra + toppingExtra) * qty;

  const toggleTopping = (t: Topping) => {
    setToppings(prev =>
      prev.find(x => x.id === t.id) ? prev.filter(x => x.id !== t.id) : [...prev, t]
    );
  };

  return createPortal(
    <div
      role="presentation"
      style={{
        position: 'fixed', inset: 0, zIndex: 100,
        background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)',
        display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
      }}
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Tùy chỉnh món ${item.name}`}
        style={{
          background: '#fff', borderRadius: '24px 24px 0 0', width: '100%',
          maxWidth: 520, maxHeight: '92vh', display: 'flex', flexDirection: 'column',
          overflow: 'hidden',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Image */}
        <div style={{ position: 'relative', height: 200, flexShrink: 0 }}>
          <img
            src={item.image}
            alt={item.name}
            decoding="async"
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
          <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(to top, rgba(0,0,0,0.5) 0%, transparent 60%)' }} />
          <button
            ref={initialFocusRef}
            aria-label="Đóng tùy chỉnh món"
            onClick={onClose}
            style={{
              position: 'absolute', top: 12, right: 12,
              background: 'rgba(0,0,0,0.5)', border: 'none', borderRadius: '50%',
              width: 44, height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer', color: '#fff',
            }}
          >
            <X size={18} />
          </button>
          {item.isBestseller && (
            <div style={{
              position: 'absolute', bottom: 12, left: 12,
              background: '#F97316', color: '#fff', fontSize: '11px', fontWeight: 700,
              padding: '3px 8px', borderRadius: 20, display: 'flex', alignItems: 'center', gap: 4,
            }}>
              <Star size={10} fill="#fff" /> BESTSELLER
            </div>
          )}
        </div>

        {/* Scrollable Content */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 16px 0' }}>
          <h2 style={{ margin: '0 0 4px', color: '#111827' }}>{item.name}</h2>
          <p style={{ margin: '0 0 14px', color: '#6B7280', fontSize: '13px', lineHeight: 1.5 }}>
            {item.description}
          </p>
          <div style={{ fontSize: '20px', fontWeight: 700, color: '#F97316', marginBottom: 16 }}>
            {formatVND(item.price)}
          </div>

          {/* Size selection */}
          {item.sizes && item.sizes.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: '13px', fontWeight: 600, color: '#374151', marginBottom: 8 }}>
                Kích cỡ
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {item.sizes.map(s => {
                  const selected = size?.label === s.label;
                  return (
                    <button
                      key={s.label}
                      onClick={() => setSize(s)}
                      style={{
                        padding: '8px 16px', borderRadius: 10,
                        border: selected ? '2px solid #F97316' : '2px solid #E5E7EB',
                        background: selected ? '#FFF7ED' : '#fff',
                        color: selected ? '#EA580C' : '#374151',
                        cursor: 'pointer', fontWeight: selected ? 600 : 400,
                        fontSize: '13px', minHeight: 44,
                      }}
                    >
                      {s.label}
                      {s.extraPrice > 0 && (
                        <span style={{ color: selected ? '#EA580C' : '#9CA3AF', fontSize: '11px', marginLeft: 4 }}>
                          +{formatVND(s.extraPrice)}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Toppings */}
          {item.toppings && item.toppings.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: '13px', fontWeight: 600, color: '#374151', marginBottom: 8 }}>
                Thêm topping
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {item.toppings.map(t => {
                  const selected = toppings.find(x => x.id === t.id);
                  return (
                    <button
                      key={t.id}
                      onClick={() => toggleTopping(t)}
                      style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        padding: '10px 12px', borderRadius: 10,
                        border: selected ? '2px solid #F97316' : '2px solid #F3F4F6',
                        background: selected ? '#FFF7ED' : '#FAFAFA',
                        cursor: 'pointer', textAlign: 'left', minHeight: 44,
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{
                          width: 18, height: 18, borderRadius: 5,
                          border: selected ? '2px solid #F97316' : '2px solid #D1D5DB',
                          background: selected ? '#F97316' : '#fff',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          flexShrink: 0,
                        }}>
                          {selected && <span style={{ color: '#fff', fontSize: 11, fontWeight: 700 }}>✓</span>}
                        </div>
                        <span style={{ fontSize: '13px', color: '#374151' }}>{t.label}</span>
                      </div>
                      {t.price > 0 && (
                        <span style={{ fontSize: '12px', color: '#F97316', fontWeight: 600 }}>
                          +{formatVND(t.price)}
                        </span>
                      )}
                      {t.price === 0 && (
                        <span style={{ fontSize: '12px', color: '#6B7280' }}>Miễn phí</span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Note */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: '13px', fontWeight: 600, color: '#374151', marginBottom: 6 }}>
              Ghi chú (tuỳ chọn)
            </div>
            <textarea
              value={note}
              onChange={e => setNote(e.target.value)}
              placeholder="Ví dụ: ít cay, không hành..."
              rows={2}
              style={{
                width: '100%', border: '2px solid #E5E7EB', borderRadius: 10,
                padding: '8px 12px', fontSize: '13px', resize: 'none', outline: 'none',
                boxSizing: 'border-box', fontFamily: 'inherit',
              }}
            />
          </div>
        </div>

        {/* Footer */}
        <div style={{
          padding: '12px 16px 20px', borderTop: '1px solid #F3F4F6',
          background: '#fff', flexShrink: 0,
        }}>
          {/* Quantity + Total */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 0, background: '#F3F4F6', borderRadius: 12, overflow: 'hidden' }}>
              <button
                aria-label="Giảm số lượng"
                onClick={() => setQty(q => Math.max(1, q - 1))}
                style={{
                  width: 44, height: 44, border: 'none', background: 'none',
                  cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: qty <= 1 ? '#D1D5DB' : '#374151',
                }}
              >
                <Minus size={18} />
              </button>
              <span style={{ minWidth: 32, textAlign: 'center', fontWeight: 700, color: '#111827', fontSize: '16px' }}>
                {qty}
              </span>
              <button
                aria-label="Tăng số lượng"
                onClick={() => setQty(q => Math.min(99, q + 1))}
                disabled={qty >= 99}
                style={{
                  width: 44, height: 44, border: 'none', background: 'none',
                  cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: qty >= 99 ? '#D1D5DB' : '#374151',
                }}
              >
                <Plus size={18} />
              </button>
            </div>
            <span style={{ fontSize: '18px', fontWeight: 700, color: '#111827' }}>
              {formatVND(lineTotal)}
            </span>
          </div>
          <div style={{ margin: '-4px 0 12px', textAlign: 'right', color: '#1D4ED8', fontSize: 11, fontWeight: 700 }}>
            Nấu dự kiến: {item.cookMinutes ?? 10} phút × {qty} = {(item.cookMinutes ?? 10) * qty} phút
          </div>

          <button
            data-action="save-cart-item"
            onClick={() => onAdd({ item, editCartId: state.editCartId, quantity: qty, selectedSize: size, selectedToppings: toppings, note })}
            style={{
              width: '100%', background: '#F97316', color: '#fff', border: 'none',
              borderRadius: 14, padding: '14px', cursor: 'pointer', fontWeight: 700,
              fontSize: '15px',
            }}
          >
            {state.editCartId ? 'Cập nhật' : 'Thêm vào giỏ'} · {formatVND(lineTotal)}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function CartSheet({
  cart,
  onClose,
  onCartChange,
  onConfirm,
}: {
  cart: CartItem[];
  onClose: () => void;
  onCartChange: (cart: CartItem[]) => void;
  onConfirm: () => void;
}) {
  const { dialogRef, initialFocusRef } = useAccessibleSheet(onClose);
  const total = cartTotal(cart);

  const updateQty = (cartId: string, delta: number) => {
    onCartChange(cart.map(i =>
      i.cartId === cartId
        ? { ...i, quantity: Math.min(99, Math.max(1, i.quantity + delta)) }
        : i
    ));
  };

  const remove = (cartId: string) => {
    onCartChange(cart.filter(i => i.cartId !== cartId));
  };

  return createPortal(
    <div
      role="presentation"
      style={{ position: 'fixed', inset: 0, zIndex: 90, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'flex-end' }}
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Giỏ hàng"
        style={{
          background: '#fff', borderRadius: '24px 24px 0 0', width: '100%',
          maxHeight: '80vh', display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ padding: '16px 16px 12px', borderBottom: '1px solid #F3F4F6', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ margin: 0, color: '#111827' }}>Giỏ hàng ({cart.length} món)</h3>
          <button ref={initialFocusRef} aria-label="Đóng giỏ hàng" onClick={onClose} style={{ background: '#F3F4F6', border: 'none', borderRadius: '50%', width: 44, height: 44, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <X size={16} color="#374151" />
          </button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px' }}>
          {cart.map(item => (
            <div key={item.cartId} style={{ display: 'flex', gap: 10, paddingBottom: 12, marginBottom: 12, borderBottom: '1px solid #F9FAFB' }}>
              <img src={item.menuItem.image} alt={item.menuItem.name} style={{ width: 52, height: 52, borderRadius: 10, objectFit: 'cover', flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, color: '#111827', fontSize: '13px', marginBottom: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.menuItem.name}</div>
                {item.selectedSize && <div style={{ fontSize: '11px', color: '#9CA3AF' }}>Size: {item.selectedSize.label}</div>}
                {item.selectedToppings.length > 0 && (
                  <div style={{ fontSize: '11px', color: '#9CA3AF' }}>{item.selectedToppings.map(t => t.label).join(', ')}</div>
                )}
                {item.note && <div style={{ fontSize: '11px', color: '#9CA3AF', fontStyle: 'italic' }}>"{item.note}"</div>}
                <div style={{ fontSize: '13px', fontWeight: 600, color: '#F97316', marginTop: 4 }}>{formatVND(cartItemTotal(item))}</div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
                <button aria-label={`Xóa ${item.menuItem.name} khỏi giỏ`} onClick={() => remove(item.cartId)} style={{ background: '#FEF2F2', border: 'none', borderRadius: 8, width: 44, height: 44, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <X size={13} color="#EF4444" />
                </button>
                <div style={{ display: 'flex', alignItems: 'center', gap: 0, background: '#F3F4F6', borderRadius: 8 }}>
                  <button aria-label={`Giảm số lượng ${item.menuItem.name}`} onClick={() => updateQty(item.cartId, -1)} style={{ width: 44, height: 44, border: 'none', background: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Minus size={12} color="#374151" />
                  </button>
                  <span style={{ fontSize: '13px', fontWeight: 700, minWidth: 20, textAlign: 'center', color: '#111827' }}>{item.quantity}</span>
                  <button aria-label={`Tăng số lượng ${item.menuItem.name}`} disabled={item.quantity >= 99} onClick={() => updateQty(item.cartId, 1)} style={{ width: 44, height: 44, border: 'none', background: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Plus size={12} color={item.quantity >= 99 ? '#D1D5DB' : '#374151'} />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>

        <div style={{ padding: '12px 16px 24px', borderTop: '1px solid #F3F4F6', background: '#FAFAFA' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
            <span style={{ color: '#374151', fontWeight: 600 }}>Tổng cộng</span>
            <span style={{ fontWeight: 700, fontSize: '18px', color: '#111827' }}>{formatVND(total)}</span>
          </div>
          <button
            data-action="confirm-cart"
            onClick={onConfirm}
            style={{
              width: '100%', background: '#111827', color: '#fff', border: 'none',
              borderRadius: 14, padding: '14px', cursor: 'pointer', fontWeight: 700,
              fontSize: '15px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            }}
          >
            Xem xác nhận order <ChevronRight size={18} />
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function MenuStep({ table, cart, categories, menuItems, isAddition, isEditing, onCartChange, onBack, onConfirm }: MenuStepProps) {
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [customizer, setCustomizer] = useState<CustomizerState | null>(null);
  const [showCart, setShowCart] = useState(false);

  const cfg = STATUS_CONFIG[table.status];
  const cartCount = cart.reduce((s, i) => s + i.quantity, 0);
  const total = cartTotal(cart);

  const pushMenuOverlay = (overlay: MenuOverlayHistory) => {
    const current = window.history.state && typeof window.history.state === 'object'
      ? window.history.state as Record<string, unknown>
      : {};
    window.history.pushState({ ...current, [MENU_OVERLAY_HISTORY_KEY]: overlay }, '');
  };

  const closeMenuOverlay = () => {
    setCustomizer(null);
    setShowCart(false);
    if (getMenuOverlayHistory()) window.history.back();
  };

  useEffect(() => {
    const syncOverlayFromHistory = (state: unknown) => {
      const overlay = getMenuOverlayHistory(state);
      if (overlay?.type === 'cart') {
        setCustomizer(null);
        setShowCart(true);
        return;
      }
      if (overlay?.type === 'customizer') {
        const item = menuItems.find(candidate => candidate.id === overlay.itemId && candidate.available);
        if (item) {
          setShowCart(false);
          setCustomizer({
            item,
            quantity: 1,
            selectedSize: item.sizes?.[0],
            selectedToppings: [],
            note: '',
          });
          return;
        }
      }
      setCustomizer(null);
      setShowCart(false);
    };
    const handlePopState = (event: PopStateEvent) => syncOverlayFromHistory(event.state);

    syncOverlayFromHistory(window.history.state);
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [menuItems]);

  const filteredItems = selectedCategory === 'all'
    ? menuItems.filter(item => item.available)
    : menuItems.filter(item => item.available && item.categoryId === selectedCategory);

  const openCustomizer = (item: MenuItem) => {
    pushMenuOverlay({ type: 'customizer', itemId: item.id });
    setCustomizer({
      item,
      quantity: 1,
      selectedSize: item.sizes?.[0],
      selectedToppings: [],
      note: '',
    });
  };

  const handleAdd = (state: CustomizerState) => {
    if (state.editCartId) {
      onCartChange(cart.map(i =>
        i.cartId === state.editCartId
          ? { ...i, quantity: state.quantity, selectedSize: state.selectedSize, selectedToppings: state.selectedToppings, note: state.note }
          : i
      ));
    } else {
      const existing = cart.find(i =>
        i.menuItem.id === state.item.id &&
        i.selectedSize?.label === state.selectedSize?.label &&
        i.selectedToppings.length === 0 && state.selectedToppings.length === 0 &&
        i.note === state.note
      );
      if (existing && state.selectedToppings.length === 0) {
        onCartChange(cart.map(i =>
          i.cartId === existing.cartId
            ? { ...i, quantity: i.quantity + state.quantity }
            : i
        ));
      } else {
        const newItem: CartItem = {
          cartId: genId(),
          menuItem: state.item,
          quantity: state.quantity,
          selectedSize: state.selectedSize,
          selectedToppings: state.selectedToppings,
          note: state.note,
        };
        onCartChange([...cart, newItem]);
      }
    }
    closeMenuOverlay();
  };

  const openCart = () => {
    if (cartCount <= 0) return;
    pushMenuOverlay({ type: 'cart' });
    setCustomizer(null);
    setShowCart(true);
  };

  const confirmCart = () => {
    setShowCart(false);
    if (getMenuOverlayHistory()?.type === 'cart') {
      window.addEventListener('popstate', () => onConfirm(), { once: true });
      window.history.back();
      return;
    }
    onConfirm();
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      {/* Header */}
      <div style={{ padding: '12px 16px', background: '#fff', borderBottom: '1px solid #F3F4F6', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
        <button aria-label="Quay lại chọn bàn" onClick={onBack} style={{ background: '#F3F4F6', border: 'none', borderRadius: 10, width: 44, height: 44, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <ArrowLeft size={20} color="#374151" />
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontWeight: 700, color: '#111827', fontSize: '16px' }}>Bàn {table.number}</span>
            {isEditing ? (
              <span style={{ padding: '3px 8px', borderRadius: 999, background: '#EDE9FE', color: '#6D28D9', fontSize: 10, fontWeight: 800 }}>SỬA PHIẾU CHỜ</span>
            ) : isAddition ? (
              <span style={{ padding: '3px 8px', borderRadius: 999, background: '#EDE9FE', color: '#6D28D9', fontSize: 10, fontWeight: 800 }}>GỌI THÊM</span>
            ) : null}
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              background: cfg.bg, border: `1px solid ${cfg.border}`,
              color: cfg.text, fontSize: '11px', fontWeight: 600,
              padding: '2px 8px', borderRadius: 20,
            }}>
              {cfg.label}
            </span>
          </div>
          <div style={{ fontSize: '12px', color: '#9CA3AF' }}>{table.seats} chỗ ngồi</div>
        </div>
        <button
          onClick={openCart}
          style={{
            position: 'relative', background: cartCount > 0 ? '#111827' : '#F3F4F6',
            border: 'none', borderRadius: 12, padding: '8px 14px',
            minHeight: 44,
            cursor: cartCount > 0 ? 'pointer' : 'default',
            display: 'flex', alignItems: 'center', gap: 8,
            color: cartCount > 0 ? '#fff' : '#9CA3AF',
          }}
        >
          <ShoppingCart size={18} />
          {cartCount > 0 && (
            <>
              <span style={{ fontSize: '13px', fontWeight: 700 }}>{cartCount}</span>
              <span style={{ position: 'absolute', top: -6, right: -6, background: '#F97316', color: '#fff', fontSize: '10px', fontWeight: 700, width: 18, height: 18, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {cartCount}
              </span>
            </>
          )}
        </button>
      </div>

      {/* Category Filter */}
      <div style={{ padding: '10px 0', background: '#fff', borderBottom: '1px solid #F3F4F6', overflowX: 'auto', flexShrink: 0 }}>
        <div style={{ display: 'flex', gap: 8, padding: '0 16px', width: 'max-content' }}>
          {[{ id: 'all', name: 'Tất cả', emoji: '🍽️' }, ...categories.filter(category => category.active !== false)].map(cat => {
            const active = selectedCategory === cat.id;
            return (
              <button
                key={cat.id}
                onClick={() => setSelectedCategory(cat.id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '8px 14px', borderRadius: 20,
                  border: active ? '2px solid #F97316' : '2px solid #E5E7EB',
                  background: active ? '#FFF7ED' : '#fff',
                  color: active ? '#EA580C' : '#374151',
                  cursor: 'pointer', whiteSpace: 'nowrap', fontWeight: active ? 600 : 400,
                  fontSize: '13px', minHeight: 44,
                }}
              >
                <span>{cat.emoji}</span>
                {cat.name}
              </button>
            );
          })}
        </div>
      </div>

      {/* Menu Items Grid */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px 16px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12 }}>
          {filteredItems.map(item => {
            const cartQty = cart.filter(c => c.menuItem.id === item.id).reduce((s, c) => s + c.quantity, 0);
            return (
              <button
                key={item.id}
                data-menu-item-id={item.id}
                onClick={() => openCustomizer(item)}
                style={{
                  background: '#fff', border: '1.5px solid #F3F4F6', borderRadius: 16,
                  overflow: 'hidden', cursor: 'pointer', textAlign: 'left', padding: 0,
                  position: 'relative', display: 'flex', flexDirection: 'column',
                  boxShadow: cartQty > 0 ? '0 0 0 2.5px #F97316' : '0 1px 4px rgba(0,0,0,0.06)',
                  transition: 'box-shadow 0.15s',
                }}
              >
                <div style={{ position: 'relative', paddingTop: '68%' }}>
                  <img
                    src={item.image}
                    alt={item.name}
                    loading="lazy"
                    decoding="async"
                    style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
                  />
                  {item.isBestseller && (
                    <div style={{ position: 'absolute', top: 8, left: 8, background: '#F97316', color: '#fff', fontSize: '9px', fontWeight: 700, padding: '2px 6px', borderRadius: 10, display: 'flex', alignItems: 'center', gap: 2 }}>
                      <Star size={8} fill="#fff" /> BEST
                    </div>
                  )}
                  {item.isNew && (
                    <div style={{ position: 'absolute', top: 8, left: 8, background: '#8B5CF6', color: '#fff', fontSize: '9px', fontWeight: 700, padding: '2px 6px', borderRadius: 10, display: 'flex', alignItems: 'center', gap: 2 }}>
                      <Sparkles size={8} /> MỚI
                    </div>
                  )}
                  {cartQty > 0 && (
                    <div style={{ position: 'absolute', top: 6, right: 6, background: '#F97316', color: '#fff', fontSize: '11px', fontWeight: 700, width: 22, height: 22, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      {cartQty}
                    </div>
                  )}
                </div>
                <div style={{ padding: '10px 10px 12px', flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
                  <div style={{ fontSize: '13px', fontWeight: 600, color: '#111827', marginBottom: 4, lineHeight: 1.3 }}>{item.name}</div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 6 }}>
                    <span style={{ fontSize: '13px', fontWeight: 700, color: '#F97316' }}>{formatVND(item.price)}</span>
                    <div style={{ background: '#F97316', borderRadius: 8, width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      <Plus size={16} color="#fff" strokeWidth={2.5} />
                    </div>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Cart Bar (sticky bottom) */}
      {cartCount > 0 && (
        <div style={{ padding: '10px 16px 12px', background: '#fff', borderTop: '1px solid #F3F4F6', flexShrink: 0 }}>
          <button
            data-action="open-cart"
            onClick={openCart}
            style={{
              width: '100%', background: '#F97316', color: '#fff', border: 'none',
              borderRadius: 16, padding: '14px 20px', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              boxShadow: '0 4px 16px rgba(249,115,22,0.35)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ background: 'rgba(255,255,255,0.25)', borderRadius: 8, padding: '4px 10px', fontWeight: 700, fontSize: '13px' }}>
                {cartCount} món
              </div>
              <span style={{ fontWeight: 600, fontSize: '14px' }}>
                {isEditing ? 'Xem phiếu đang sửa' : isAddition ? 'Xem phiếu gọi thêm' : 'Xem giỏ hàng'}
              </span>
            </div>
            <span style={{ fontWeight: 700, fontSize: '15px' }}>{formatVND(total)}</span>
          </button>
        </div>
      )}

      {/* Modals */}
      {customizer && (
        <ItemCustomizerModal
          state={customizer}
          onClose={closeMenuOverlay}
          onAdd={handleAdd}
        />
      )}

      {showCart && (
        <CartSheet
          cart={cart}
          onClose={closeMenuOverlay}
          onCartChange={onCartChange}
          onConfirm={confirmCart}
        />
      )}
    </div>
  );
}
