import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  X, CreditCard, Banknote, QrCode, CheckCircle, Users,
  Printer, ReceiptText, Building2,
} from 'lucide-react';
import {
  Table, CartItem, Employee, PaymentMethodId, PaymentRecord,
  STATUS_CONFIG, cartTotal, cartItemTotal, formatVND,
} from '../data';
import {
  BRAND_ASSETS, PAYMENT_METHOD_LABELS,
  calculateInvoiceTotals, type RestaurantSettings,
} from '../config/restaurant';
import { RestaurantInvoice, type PrintableInvoiceData } from './invoice/RestaurantInvoice';
import { OrderTimer } from './OrderTimer';
import { fetchEmployees } from '../services/api';

interface PaymentPageProps {
  tables: Table[];
  tableOrders: Record<string, CartItem[]>;
  settings: RestaurantSettings;
  onProcessPayment: (payment: PaymentRecord, items: CartItem[]) => Promise<PaymentRecord>;
}

const METHODS: { id: PaymentMethodId; label: string; icon: ReactNode; desc: string }[] = [
  { id: 'cash', label: 'Tiền mặt', icon: <Banknote size={22} />, desc: 'Khách trả tiền mặt' },
  { id: 'card', label: 'Thẻ', icon: <CreditCard size={22} />, desc: 'Visa / Mastercard / ATM' },
  { id: 'qr', label: 'QR Code', icon: <QrCode size={22} />, desc: 'MoMo / VNPay / ZaloPay' },
];

function unitPrice(item: CartItem): number {
  return item.menuItem.price
    + (item.selectedSize?.extraPrice ?? 0)
    + item.selectedToppings.reduce((sum, topping) => sum + topping.price, 0);
}

function invoiceItemName(item: CartItem): string {
  const options = [
    item.selectedSize?.label,
    ...item.selectedToppings.map(topping => topping.label),
  ].filter(Boolean);

  return options.length ? `${item.menuItem.name} (${options.join(', ')})` : item.menuItem.name;
}

/** Sinh mã hóa đơn đủ ngẫu nhiên để backend dùng làm khóa idempotency. */
function makeCode(prefix: string): string {
  const now = new Date();
  const datePart = now.toISOString().slice(2, 10).replaceAll('-', '');
  const randomPart = crypto.randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase();
  return `${prefix}-${datePart}-${randomPart}`;
}

function makePaymentCodes() {
  return {
    invoiceCode: makeCode('CAS'),
    transactions: {
      cash: makeCode('CASH'), card: makeCode('CARD'), qr: makeCode('QR'),
    } as Record<PaymentMethodId, string>,
  };
}

function BillPanel({
  table,
  order,
  settings,
  onClose,
  onConfirm,
}: {
  table: Table;
  order: CartItem[];
  settings: RestaurantSettings;
  onClose: () => void;
  onConfirm: (payment: PaymentRecord, items: CartItem[]) => Promise<PaymentRecord>;
}) {
  const enabledMethods = METHODS.filter(method => settings.activePaymentMethods.includes(method.id));
  const firstMethod = enabledMethods[0]?.id ?? 'cash';
  const [method, setMethod] = useState<PaymentMethodId>(firstMethod);
  const [invoiceData, setInvoiceData] = useState<PrintableInvoiceData | null>(null);
  const [processing, setProcessing] = useState(false);
  const [paymentError, setPaymentError] = useState<string | null>(null);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [employeeId, setEmployeeId] = useState('');
  const paymentCodes = useRef(makePaymentCodes());
  const dialogRef = useRef<HTMLDivElement>(null);
  const processingRef = useRef(processing);
  const onCloseRef = useRef(onClose);
  const selectedMethod = enabledMethods.some(item => item.id === method) ? method : firstMethod;
  const selectedEmployee = employees.find(employee => employee.id === employeeId);
  processingRef.current = processing;
  onCloseRef.current = onClose;

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !processingRef.current) onCloseRef.current();
      if (event.key !== 'Tab') return;
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
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
    requestAnimationFrame(() => dialogRef.current?.querySelector<HTMLElement>('button, select')?.focus());
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown);
      previouslyFocused?.focus();
    };
  }, []);

  useEffect(() => {
    let active = true;
    fetchEmployees(true).then(rows => {
      if (!active) return;
      const serviceEmployees = rows.filter(employee => employee.role === 'server');
      setEmployees(serviceEmployees);
      setEmployeeId(current => (
        serviceEmployees.some(employee => employee.id === current)
          ? current
          : serviceEmployees.find(employee => employee.name === settings.staffName)?.id || serviceEmployees[0]?.id || ''
      ));
    }).catch(() => {});
    return () => { active = false; };
  }, [settings.staffName]);

  useEffect(() => {
    paymentCodes.current = makePaymentCodes();
    setInvoiceData(null);
    setPaymentError(null);
  }, [table.id]);

  const subtotal = cartTotal(order);
  const totals = calculateInvoiceTotals(subtotal, settings);

  /** Dựng cùng lúc dữ liệu gửi API và bản in tạm; tổng cuối vẫn do server quyết định. */
  const buildInvoice = (paymentMethod: PaymentMethodId): { invoice: PrintableInvoiceData; payment: PaymentRecord } => {
    const now = new Date();
    const invoiceCode = paymentCodes.current.invoiceCode;
    const transactionCode = paymentCodes.current.transactions[paymentMethod];
    const itemCount = order.reduce((sum, item) => sum + item.quantity, 0);
    const staffName = selectedEmployee?.name ?? settings.staffName;

    const invoice: PrintableInvoiceData = {
      logo: BRAND_ASSETS.logoStacked,
      invoiceCode,
      transactionCode,
      date: now.toLocaleDateString('vi-VN'),
      time: now.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }),
      table: String(table.number),
      area: settings.defaultArea,
      customerName: settings.customerName,
      guestCount: settings.guestCount,
      batchCount: table.batchCount ?? 1,
      additionalBatchCount: table.additionalBatchCount ?? 0,
      staffName,
      cashierName: settings.cashierName,
      restaurant: {
        name: settings.restaurantName,
        legalName: settings.legalName,
        tagline: settings.tagline,
        address: settings.address,
        phone: settings.phone,
        email: settings.email,
        website: settings.website,
      },
      items: order.map(item => ({
        name: invoiceItemName(item),
        quantity: item.quantity,
        price: unitPrice(item),
      })),
      subtotal: totals.subtotal,
      discount: totals.discount,
      serviceFee: totals.serviceFee,
      serviceFeeRate: settings.serviceFeeRate,
      vat: totals.vat,
      vatRate: settings.vatRate,
      total: totals.total,
      paymentMethod: PAYMENT_METHOD_LABELS[paymentMethod],
      paymentStatus: 'Đã thanh toán',
      note: settings.invoiceNote,
    };

    const payment: PaymentRecord = {
      id: invoiceCode,
      invoiceCode,
      transactionCode,
      tableId: table.id,
      tableNumber: table.number,
      method: paymentMethod,
      subtotal: totals.subtotal,
      discount: totals.discount,
      serviceFee: totals.serviceFee,
      vat: totals.vat,
      total: totals.total,
      itemCount,
      paidAt: now.toISOString(),
      ...(selectedEmployee ? { employeeId: selectedEmployee.id } : {}),
      staffName,
      cashierName: settings.cashierName,
    };

    return { invoice, payment };
  };

  /** Chỉ mở hóa đơn in sau khi transaction thanh toán ở server thành công. */
  const handleConfirm = async () => {
    if (invoiceData || processing) return;
    const { invoice, payment } = buildInvoice(selectedMethod);
    setProcessing(true);
    setPaymentError(null);
    try {
      const saved = await onConfirm(payment, order);
      const paidAt = new Date(saved.paidAt);
      setInvoiceData({
        ...invoice,
        invoiceCode: saved.invoiceCode,
        transactionCode: saved.transactionCode,
        date: paidAt.toLocaleDateString('vi-VN'),
        time: paidAt.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }),
        subtotal: saved.subtotal,
        discount: saved.discount,
        serviceFee: saved.serviceFee,
        vat: saved.vat,
        total: saved.total,
        paymentMethod: PAYMENT_METHOD_LABELS[saved.method],
        staffName: saved.staffName,
        cashierName: saved.cashierName,
      });
      paymentCodes.current = makePaymentCodes();
    } catch (error) {
      setPaymentError(error instanceof Error ? error.message : 'Không thể xử lý thanh toán.');
    } finally {
      setProcessing(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="payment-dialog-title"
      style={{ position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}
      onClick={() => { if (!processing) onClose(); }}
    >
      <div
        ref={dialogRef}
        style={{ background: '#fff', borderRadius: '18px 18px 0 0', width: '100%', maxWidth: invoiceData ? 980 : 520, maxHeight: '96vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
        onClick={event => event.stopPropagation()}
      >
        {invoiceData ? (
          <>
            <div className="invoice-actions" style={{ padding: '14px 16px', borderBottom: '1px solid #E5E7EB', display: 'flex', alignItems: 'center', gap: 12, background: '#fff', flexShrink: 0 }}>
              <div style={{ width: 40, height: 40, borderRadius: 10, background: '#ECFDF5', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#15803D', flexShrink: 0 }}>
                <CheckCircle size={22} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div id="payment-dialog-title" style={{ fontWeight: 800, color: '#111827', fontSize: '15px' }}>Thanh toán thành công</div>
                <div style={{ color: '#6B7280', fontSize: '12px', marginTop: 2 }}>
                  {invoiceData.invoiceCode} · {formatVND(invoiceData.total)}
                </div>
              </div>
              <button
                onClick={() => window.print()}
                style={{ background: '#0D9488', color: '#fff', border: 'none', borderRadius: 10, height: 38, padding: '0 14px', cursor: 'pointer', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8 }}
              >
                <Printer size={17} />
                In
              </button>
              <button
                onClick={onClose}
                style={{ background: '#F3F4F6', border: 'none', borderRadius: 10, width: 38, height: 38, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                aria-label="Đóng hóa đơn"
              >
                <X size={18} color="#374151" />
              </button>
            </div>
            <div style={{ flex: 1, overflow: 'auto', background: '#E5E7EB' }}>
              <RestaurantInvoice data={invoiceData} />
            </div>
          </>
        ) : (
          <>
            <div style={{ padding: '16px 20px 12px', borderBottom: '1px solid #F3F4F6', display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ width: 40, height: 40, borderRadius: 10, background: '#ECFEFF', border: '1px solid #99F6E4', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <img src={BRAND_ASSETS.mark} alt="CAS" style={{ width: 24, height: 24 }} />
              </div>
              <div style={{ flex: 1 }}>
                <h3 id="payment-dialog-title" style={{ margin: 0, color: '#111827' }}>Thanh toán · Bàn {table.number}</h3>
                <div style={{ fontSize: '13px', color: '#6B7280', marginTop: 2 }}>
                  {table.seats} chỗ · {order.reduce((sum, item) => sum + item.quantity, 0)} phần · {settings.restaurantName}
                </div>
                <div style={{ marginTop: 6 }}><OrderTimer table={table} compact /></div>
              </div>
              <button aria-label="Đóng thanh toán" disabled={processing} onClick={onClose} style={{ background: '#F3F4F6', border: 'none', borderRadius: 10, width: 36, height: 36, cursor: processing ? 'wait' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <X size={18} color="#374151" />
              </button>
            </div>

            <div style={{ flex: 1, overflowY: 'auto' }}>
              <div style={{ margin: '14px 16px', background: '#F9FAFB', borderRadius: 12, overflow: 'hidden', border: '1px solid #F3F4F6' }}>
                <div style={{ background: '#111827', padding: '14px 18px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <img src={BRAND_ASSETS.logoHorizontalWhite} alt="CAS" style={{ width: 92, height: 30, objectFit: 'contain' }} />
                    <div>
                      <div style={{ color: '#fff', fontWeight: 700, fontSize: '13px' }}>Hóa đơn tạm tính</div>
                      <div style={{ color: '#9CA3AF', fontSize: '11px', marginTop: 1 }}>{settings.restaurantName}</div>
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ color: '#2DD4BF', fontWeight: 700, fontSize: '18px' }}>Bàn {table.number}</div>
                    <div style={{ color: '#9CA3AF', fontSize: '11px' }}>{new Date().toLocaleDateString('vi-VN')}</div>
                  </div>
                </div>

                <div style={{ padding: '0 16px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0 6px', borderBottom: '1px dashed #E5E7EB' }}>
                    <span style={{ fontSize: '11px', color: '#9CA3AF', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Món ăn</span>
                    <span style={{ fontSize: '11px', color: '#9CA3AF', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Thành tiền</span>
                  </div>

                  {order.map(item => (
                    <div key={item.cartId} style={{ padding: '10px 0', borderBottom: '1px solid #F3F4F6' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                        <div style={{ flex: 1, marginRight: 8 }}>
                          <span style={{ fontSize: '13px', fontWeight: 600, color: '#111827' }}>{item.menuItem.name}</span>
                          {item.selectedSize && (
                            <span style={{ fontSize: '11px', color: '#9CA3AF', marginLeft: 4 }}>({item.selectedSize.label})</span>
                          )}
                        </div>
                        <span style={{ fontSize: '13px', fontWeight: 600, color: '#111827', flexShrink: 0 }}>
                          {formatVND(cartItemTotal(item))}
                        </span>
                      </div>
                      {item.selectedToppings.length > 0 && (
                        <div style={{ fontSize: '11px', color: '#9CA3AF', marginTop: 2, paddingLeft: 4 }}>
                          + {item.selectedToppings.map(topping => topping.label).join(', ')}
                        </div>
                      )}
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 3 }}>
                        <span style={{ fontSize: '11px', color: '#9CA3AF' }}>
                          {formatVND(unitPrice(item))} × {item.quantity}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>

                <div style={{ padding: '12px 16px', background: '#fff', borderTop: '2px dashed #E5E7EB' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                    <span style={{ fontSize: '13px', color: '#6B7280' }}>Tạm tính</span>
                    <span style={{ fontSize: '13px', color: '#374151', fontWeight: 600 }}>{formatVND(totals.subtotal)}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                    <span style={{ fontSize: '13px', color: '#6B7280' }}>Giảm giá</span>
                    <span style={{ fontSize: '13px', color: '#0F766E', fontWeight: 600 }}>-{formatVND(totals.discount)}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                    <span style={{ fontSize: '13px', color: '#6B7280' }}>Phí dịch vụ ({Math.round(settings.serviceFeeRate * 100)}%)</span>
                    <span style={{ fontSize: '13px', color: '#374151' }}>{formatVND(totals.serviceFee)}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
                    <span style={{ fontSize: '13px', color: '#6B7280' }}>VAT ({Math.round(settings.vatRate * 100)}%)</span>
                    <span style={{ fontSize: '13px', color: '#374151' }}>{formatVND(totals.vat)}</span>
                  </div>
                  <div style={{ borderTop: '2px solid #111827', paddingTop: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontWeight: 800, fontSize: '15px', color: '#111827' }}>TỔNG CỘNG</span>
                    <span style={{ fontWeight: 800, fontSize: '20px', color: '#0D9488' }}>{formatVND(totals.total)}</span>
                  </div>
                </div>
              </div>

              <div style={{ padding: '0 16px 8px' }}>
                <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: '#374151', marginBottom: 12 }}>
                  Nhân viên phục vụ
                  <select
                    value={employeeId}
                    onChange={event => setEmployeeId(event.target.value)}
                    disabled={employees.length === 0}
                    style={{ display: 'block', width: '100%', marginTop: 7, border: '1px solid #D1D5DB', borderRadius: 10, padding: '10px 11px', background: '#fff', color: '#111827', fontSize: 13 }}
                  >
                    {employees.length === 0 && <option value="">{settings.staffName}</option>}
                    {employees.map(employee => <option key={employee.id} value={employee.id}>{employee.code} · {employee.name}</option>)}
                  </select>
                </label>
                <div style={{ fontSize: '13px', fontWeight: 600, color: '#374151', marginBottom: 10 }}>
                  Phương thức thanh toán
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  {enabledMethods.map(item => {
                    const selected = selectedMethod === item.id;
                    return (
                      <button
                        key={item.id}
                        onClick={() => setMethod(item.id)}
                        aria-pressed={selected}
                        style={{
                          flex: 1, padding: '12px 8px', borderRadius: 10,
                          border: selected ? '2px solid #0D9488' : '2px solid #E5E7EB',
                          background: selected ? '#F0FDFA' : '#FAFAFA',
                          cursor: 'pointer', textAlign: 'center',
                        }}
                      >
                        <div style={{ color: selected ? '#0D9488' : '#6B7280', marginBottom: 4, display: 'flex', justifyContent: 'center' }}>
                          {item.icon}
                        </div>
                        <div style={{ fontSize: '12px', fontWeight: selected ? 700 : 500, color: selected ? '#0F766E' : '#374151' }}>
                          {item.label}
                        </div>
                        <div style={{ fontSize: '10px', color: '#9CA3AF', marginTop: 2, lineHeight: 1.3 }}>{item.desc}</div>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            <div style={{ padding: '12px 16px 28px', borderTop: '1px solid #F3F4F6', background: '#fff', flexShrink: 0 }}>
              {paymentError && (
                <div role="alert" style={{ marginBottom: 10, color: '#B91C1C', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 10, padding: 10, fontSize: 13 }}>
                  {paymentError} Order vẫn được giữ nguyên để bạn thử lại.
                </div>
              )}
              <button
                onClick={() => void handleConfirm()}
                disabled={processing}
                style={{
                  width: '100%', background: '#15803D', color: '#fff', border: 'none',
                  borderRadius: 12, padding: '15px', cursor: processing ? 'wait' : 'pointer', fontWeight: 700,
                  fontSize: '15px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
                  opacity: processing ? 0.7 : 1,
                }}
              >
                <CheckCircle size={20} />
                {processing ? 'Đang ghi nhận…' : `Xác nhận thanh toán · ${formatVND(totals.total)}`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function PaymentPage({ tables, tableOrders, settings, onProcessPayment }: PaymentPageProps) {
  const [selectedTableId, setSelectedTableId] = useState<string | null>(null);
  const selectedTable = tables.find(table => table.id === selectedTableId) ?? null;

  const orderedTables = tables.filter(table => tableOrders[table.id] && tableOrders[table.id].length > 0);
  const payableTables = orderedTables.filter(table => table.status === 'done');
  const emptyOrReserved = tables.filter(table => !tableOrders[table.id] || tableOrders[table.id].length === 0);
  const pendingRevenue = orderedTables.reduce((sum, table) => {
    const order = tableOrders[table.id] || [];
    return sum + calculateInvoiceTotals(cartTotal(order), settings).total;
  }, 0);

  return (
    <div style={{ minHeight: '100%' }}>
      <div style={{ padding: '18px 16px 12px', background: '#fff', borderBottom: '1px solid #F3F4F6' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 38, height: 38, borderRadius: 10, background: '#ECFEFF', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid #99F6E4' }}>
            <ReceiptText size={20} color="#0D9488" />
          </div>
          <div>
            <h1 style={{ margin: '0 0 4px', color: '#111827', fontSize: '24px' }}>Thanh toán</h1>
            <p style={{ margin: 0, color: '#6B7280', fontSize: '13px' }}>
              {settings.restaurantName} · {payableTables.length} bàn sẵn sàng thanh toán
            </p>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 1, background: '#F3F4F6' }}>
        <div style={{ flex: 1, background: '#fff', padding: '12px 10px', textAlign: 'center' }}>
          <div style={{ fontSize: '22px', fontWeight: 800, color: '#0D9488' }}>{payableTables.length}</div>
          <div style={{ fontSize: '10px', color: '#9CA3AF', marginTop: 2 }}>Đã hoàn tất bếp</div>
        </div>
        <div style={{ flex: 1, background: '#fff', padding: '12px 10px', textAlign: 'center' }}>
          <div style={{ fontSize: '22px', fontWeight: 800, color: '#111827' }}>{formatVND(pendingRevenue)}</div>
          <div style={{ fontSize: '10px', color: '#9CA3AF', marginTop: 2 }}>Dự thu</div>
        </div>
      </div>

      <div style={{ padding: 16 }}>
        {orderedTables.length > 0 && (
          <>
            <div style={{ fontSize: '12px', fontWeight: 700, color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>
              Bàn có order · Chỉ bàn đã xong mới được thanh toán
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 20 }}>
              {orderedTables.map(table => {
                const order = tableOrders[table.id] || [];
                const cfg = STATUS_CONFIG[table.status];
                const total = calculateInvoiceTotals(cartTotal(order), settings).total;
                const canPay = table.status === 'done';
                return (
                  <button
                    key={table.id}
                    onClick={() => { if (canPay) setSelectedTableId(table.id); }}
                    disabled={!canPay}
                    aria-label={canPay ? `Thanh toán bàn ${table.number}` : `Bàn ${table.number} chưa thể thanh toán vì bếp chưa hoàn tất`}
                    style={{
                      background: '#fff', border: `2px solid ${cfg.border}`,
                      borderRadius: 12, padding: '14px 16px', cursor: canPay ? 'pointer' : 'not-allowed',
                      textAlign: 'left', display: 'flex', alignItems: 'center', gap: 14,
                      boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
                      opacity: canPay ? 1 : 0.72,
                    }}
                  >
                    <div style={{
                      width: 52, height: 52, background: cfg.bg, border: `2px solid ${cfg.border}`,
                      borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                    }}>
                      <span style={{ fontWeight: 800, fontSize: '20px', color: '#111827' }}>{table.number}</span>
                    </div>

                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontWeight: 700, color: '#111827', fontSize: '15px' }}>Bàn {table.number}</span>
                        <span style={{
                          background: cfg.bg, border: `1px solid ${cfg.border}`,
                          color: cfg.text, fontSize: '10px', fontWeight: 600,
                          padding: '2px 7px', borderRadius: 20,
                        }}>
                          {cfg.label}
                        </span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 3, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: '12px', color: '#6B7280', display: 'flex', alignItems: 'center', gap: 3 }}>
                          <Users size={11} /> {table.seats} chỗ
                        </span>
                        <span style={{ fontSize: '12px', color: '#6B7280' }}>·</span>
                        <span style={{ fontSize: '12px', color: '#6B7280' }}>
                          {order.reduce((sum, item) => sum + item.quantity, 0)} phần
                        </span>
                        <span style={{ fontSize: '12px', color: '#6B7280' }}>·</span>
                        <span style={{ fontSize: '12px', color: '#6B7280' }}>{order.length} món</span>
                        {(table.additionalBatchCount ?? 0) > 0 && (
                          <span style={{ fontSize: '11px', color: '#6D28D9', fontWeight: 800 }}>· {table.batchCount} lượt (+{table.additionalBatchCount})</span>
                        )}
                        <OrderTimer table={table} compact />
                      </div>
                      {!canPay && <div style={{ color: '#B45309', fontSize: 11, fontWeight: 700, marginTop: 5 }}>Chỉ thanh toán sau khi bếp hoàn tất tất cả lượt gọi</div>}
                    </div>

                    <div style={{ textAlign: 'right', flexShrink: 0 }}>
                      <div style={{ fontWeight: 800, fontSize: '16px', color: '#0D9488' }}>{formatVND(total)}</div>
                      <div style={{ fontSize: '10px', color: '#9CA3AF', marginTop: 2 }}>đã gồm phí</div>
                    </div>
                  </button>
                );
              })}
            </div>
          </>
        )}

        {emptyOrReserved.length > 0 && (
          <>
            <div style={{ fontSize: '12px', fontWeight: 700, color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>
              Bàn chưa có order
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: 8 }}>
              {emptyOrReserved.map(table => {
                const cfg = STATUS_CONFIG[table.status];
                return (
                  <div
                    key={table.id}
                    style={{
                      background: '#F9FAFB', border: '1.5px solid #E5E7EB',
                      borderRadius: 10, padding: '12px', opacity: 0.6,
                      display: 'flex', flexDirection: 'column', gap: 4,
                    }}
                  >
                    <span style={{ fontWeight: 700, fontSize: '20px', color: '#9CA3AF' }}>Bàn {table.number}</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 3, color: '#C4C9D0' }}>
                      <Users size={11} />
                      <span style={{ fontSize: '11px' }}>{table.seats} chỗ</span>
                    </div>
                    <span style={{ fontSize: '11px', color: '#C4C9D0', fontWeight: 500 }}>{cfg.label}</span>
                  </div>
                );
              })}
            </div>
          </>
        )}

        {orderedTables.length === 0 && (
          <div style={{ textAlign: 'center', padding: '48px 24px', color: '#9CA3AF' }}>
            <div style={{ width: 64, height: 64, borderRadius: 16, background: '#ECFEFF', margin: '0 auto 12px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Building2 size={30} color="#0D9488" />
            </div>
            <div style={{ fontWeight: 600, color: '#374151', marginBottom: 6 }}>Tất cả bàn đã thanh toán</div>
            <div style={{ fontSize: '13px' }}>Không có bàn nào cần thanh toán</div>
          </div>
        )}
      </div>

      {selectedTable && (
        <BillPanel
          table={selectedTable}
          order={tableOrders[selectedTable.id] || []}
          settings={settings}
          onClose={() => setSelectedTableId(null)}
          onConfirm={(payment, items) => onProcessPayment(payment, items)}
        />
      )}
    </div>
  );
}
