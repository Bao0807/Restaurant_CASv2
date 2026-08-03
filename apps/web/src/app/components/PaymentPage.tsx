import {
  useEffect, useMemo, useRef, useState,
  type KeyboardEvent as ReactKeyboardEvent, type ReactNode,
} from 'react';
import {
  ArrowRight, X, CreditCard, Banknote, QrCode, CheckCircle, Users,
  Printer, ReceiptText, BadgeCheck, History, Search, ChevronDown, ChevronUp,
  SlidersHorizontal, LogOut,
} from 'lucide-react';
import {
  Table, CartItem, Employee, PaymentMethodId, PaymentReceiptDetails, PaymentRecord, PaymentResult,
  STATUS_CONFIG, cartTotal, cartItemTotal, formatVND,
} from '../data';
import {
  BRAND_ASSETS, PAYMENT_METHOD_LABELS,
  calculateInvoiceTotals, type RestaurantSettings,
} from '../config/restaurant';
import {
  RestaurantInvoice,
  type InvoicePrintFormat,
  type PrintableInvoiceData,
} from './invoice/RestaurantInvoice';
import { OrderTimer } from './OrderTimer';
import { fetchEmployees, fetchPaymentReceipt, getServerNowMs } from '../services/api';
import { PaymentHistoryPanel } from './payment/PaymentHistoryPanel';
import { ConfirmationDialog } from './ConfirmationDialog';
import '../../styles/payment.css';

interface PaymentPageProps {
  tables: Table[];
  tableOrders: Record<string, CartItem[]>;
  payments: PaymentRecord[];
  settings: RestaurantSettings;
  onProcessPayment: (payment: PaymentRecord, items: CartItem[]) => Promise<PaymentResult>;
  onConfirmDeparture: (tableId: string) => Promise<void>;
}

const PAYMENT_HISTORY_KEY = 'casPaymentTableId';
const PAYMENT_VIEW_HISTORY_KEY = 'casPaymentView';
const PAYMENT_HISTORY_LIMIT = 10;

type PaymentView = 'queue' | 'history';
type PaymentQueueFilter = 'all' | 'ready' | 'early';

const INVOICE_PRINT_FORMAT_KEY = 'casInvoicePrintFormat';

function paymentHistoryTableId(state: unknown = window.history.state): string | null {
  if (!state || typeof state !== 'object') return null;
  const value = (state as Record<string, unknown>)[PAYMENT_HISTORY_KEY];
  return typeof value === 'string' ? value : null;
}

function paymentViewFromHistory(state: unknown = window.history.state): PaymentView {
  if (!state || typeof state !== 'object') return 'queue';
  return (state as Record<string, unknown>)[PAYMENT_VIEW_HISTORY_KEY] === 'history' ? 'history' : 'queue';
}

const METHODS: { id: PaymentMethodId; label: string; icon: ReactNode; desc: string }[] = [
  { id: 'cash', label: 'Tiền mặt', icon: <Banknote size={22} />, desc: 'Khách trả tiền mặt' },
  { id: 'card', label: 'Thẻ', icon: <CreditCard size={22} />, desc: 'Ghi nhận nội bộ · chưa xác minh cổng thẻ' },
  { id: 'qr', label: 'QR Code', icon: <QrCode size={22} />, desc: 'Ghi nhận nội bộ · chưa đối soát cổng QR' },
];

const PAYMENT_STATUS_PRIORITY: Record<Table['status'], number> = {
  served: 0,
  done: 1,
  cooking: 2,
  waiting: 3,
  reserved: 4,
  empty: 5,
};

function printablePaymentMethod(method: PaymentMethodId): string {
  const label = PAYMENT_METHOD_LABELS[method];
  return method === 'cash' ? label : `${label} · ghi nhận nội bộ`;
}

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

/** Tổng dự kiến trên danh sách thu ngân; backend vẫn là nguồn quyết định số tiền cuối cùng. */
function payableTotal(order: CartItem[], settings: RestaurantSettings): number {
  return calculateInvoiceTotals(cartTotal(order), settings).total;
}

function initialPrintFormat(): InvoicePrintFormat {
  return window.localStorage.getItem(INVOICE_PRINT_FORMAT_KEY) === 'thermal' ? 'thermal' : 'a4';
}

function printInvoice(format: InvoicePrintFormat) {
  const root = document.documentElement;
  const style = document.createElement('style');
  style.dataset.invoicePrintPage = 'true';
  style.textContent = `@page { size: ${format === 'thermal' ? '80mm auto' : 'A4 portrait'}; margin: 0; }`;
  root.dataset.invoicePrintFormat = format;
  document.head.appendChild(style);
  try {
    window.print();
  } finally {
    delete root.dataset.invoicePrintFormat;
    style.remove();
  }
}

function setStoredPrintFormat(format: InvoicePrintFormat) {
  window.localStorage.setItem(INVOICE_PRINT_FORMAT_KEY, format);
}

function historicalItemName(item: PaymentReceiptDetails['items'][number]): string {
  const options = [
    item.options?.size,
    ...(item.options?.toppings ?? []),
  ].filter(Boolean);
  return options.length ? `${item.name} (${options.join(', ')})` : item.name;
}

function historicalInvoice(
  details: PaymentReceiptDetails,
  settings: RestaurantSettings,
): PrintableInvoiceData {
  const { payment, snapshot } = details;
  const paidAt = new Date(payment.paidAt);
  const taxableBase = Math.max(payment.subtotal - payment.discount, 0);
  const serviceFeeRate = taxableBase > 0 ? payment.serviceFee / taxableBase : 0;
  const vatBase = taxableBase + payment.serviceFee;
  const vatRate = vatBase > 0 ? payment.vat / vatBase : 0;
  return {
    logo: BRAND_ASSETS.logoStacked,
    invoiceCode: payment.invoiceCode,
    transactionCode: payment.transactionCode,
    date: paidAt.toLocaleDateString('vi-VN'),
    time: paidAt.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }),
    table: String(payment.tableNumber),
    area: snapshot.area || settings.defaultArea,
    customerName: payment.customerName || settings.customerName,
    guestCount: payment.guestCount ?? settings.guestCount,
    staffName: payment.staffName,
    cashierName: payment.cashierName,
    restaurant: {
      name: snapshot.restaurantName || settings.restaurantName,
      legalName: snapshot.legalName || settings.legalName,
      tagline: snapshot.tagline || settings.tagline,
      address: snapshot.address || settings.address,
      phone: snapshot.phone || settings.phone,
      email: snapshot.email || settings.email,
      website: snapshot.website || settings.website,
    },
    items: details.items.map(item => ({
      name: historicalItemName(item),
      quantity: item.quantity,
      price: item.price,
    })),
    subtotal: payment.subtotal,
    discount: payment.discount,
    serviceFee: payment.serviceFee,
    serviceFeeRate: Number(snapshot.serviceFeeRate ?? serviceFeeRate),
    vat: payment.vat,
    vatRate: Number(snapshot.vatRate ?? vatRate),
    total: payment.total,
    paymentMethod: printablePaymentMethod(payment.method),
    paymentStatus: 'Đã thanh toán',
    ...(payment.cashReceived != null ? { cashReceived: payment.cashReceived } : {}),
    ...(payment.cashChange != null ? { cashChange: payment.cashChange } : {}),
    note: snapshot.invoiceNote || settings.invoiceNote,
  };
}

function InvoicePreviewContent({
  data,
  format,
  onFormatChange,
  onClose,
  headingId,
  title,
  supportingText,
}: {
  data: PrintableInvoiceData;
  format: InvoicePrintFormat;
  onFormatChange: (format: InvoicePrintFormat) => void;
  onClose: () => void;
  headingId: string;
  title: string;
  supportingText?: string;
}) {
  return (
    <>
      <div className="invoice-actions payment-invoice-toolbar">
        <div className="payment-invoice-success-icon"><CheckCircle size={22} /></div>
        <div className="payment-invoice-heading">
          <div id={headingId}>{title}</div>
          <span>{data.invoiceCode} · {formatVND(data.total)}</span>
          {supportingText && <small>{supportingText}</small>}
        </div>
        <div className="payment-print-format" role="group" aria-label="Khổ in hóa đơn">
          <button
            type="button"
            className={format === 'a4' ? 'active' : ''}
            aria-pressed={format === 'a4'}
            onClick={() => onFormatChange('a4')}
          >
            A4
          </button>
          <button
            type="button"
            className={format === 'thermal' ? 'active' : ''}
            aria-pressed={format === 'thermal'}
            onClick={() => onFormatChange('thermal')}
          >
            80 mm
          </button>
        </div>
        <button type="button" className="payment-invoice-print" onClick={() => printInvoice(format)}>
          <Printer size={17} /> In
        </button>
        <button type="button" className="payment-invoice-close" onClick={onClose} aria-label="Đóng hóa đơn">
          <X size={18} />
        </button>
      </div>
      <div className={`invoice-preview payment-invoice-preview format-${format}`}>
        <RestaurantInvoice data={data} format={format} />
      </div>
    </>
  );
}

function HistoryInvoiceDialog({
  data,
  format,
  onFormatChange,
  onClose,
}: {
  data: PrintableInvoiceData;
  format: InvoicePrintFormat;
  onFormatChange: (format: InvoicePrintFormat) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseRef.current();
      if (event.key !== 'Tab') return;
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
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
    requestAnimationFrame(() => dialogRef.current?.querySelector<HTMLElement>('button')?.focus());
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown);
      previouslyFocused?.focus();
    };
  }, []);

  return (
    <div
      className="payment-dialog-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="history-invoice-dialog-title"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        className="payment-dialog-shell is-invoice"
        onClick={event => event.stopPropagation()}
      >
        <InvoicePreviewContent
          data={data}
          format={format}
          onFormatChange={onFormatChange}
          onClose={onClose}
          headingId="history-invoice-dialog-title"
          title="Chi tiết hóa đơn"
          supportingText="Bản lưu đã chốt · có thể in lại"
        />
      </div>
    </div>
  );
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
  onConfirm: (payment: PaymentRecord, items: CartItem[]) => Promise<PaymentResult>;
}) {
  const enabledMethods = METHODS.filter(method => settings.activePaymentMethods.includes(method.id));
  const firstMethod = enabledMethods[0]?.id ?? 'cash';
  const [method, setMethod] = useState<PaymentMethodId>(firstMethod);
  const [invoiceData, setInvoiceData] = useState<PrintableInvoiceData | null>(null);
  const [processing, setProcessing] = useState(false);
  const [paymentError, setPaymentError] = useState<string | null>(null);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [employeeError, setEmployeeError] = useState<string | null>(null);
  const [employeeId, setEmployeeId] = useState('');
  const [cashReceivedInput, setCashReceivedInput] = useState('');
  const [departureRequired, setDepartureRequired] = useState(false);
  const [printFormat, setPrintFormat] = useState<InvoicePrintFormat>(initialPrintFormat);
  const paymentCodes = useRef(makePaymentCodes());
  const keepTableOpenRef = useRef(table.status !== 'served');
  const localPaymentCommittedRef = useRef(false);
  const tableEntryRef = useRef({ id: table.id, status: table.status });
  if (tableEntryRef.current.id !== table.id) {
    tableEntryRef.current = { id: table.id, status: table.status };
  }
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
      setEmployeeError(null);
      const serviceEmployees = rows.filter(employee => employee.role === 'server');
      setEmployees(serviceEmployees);
      setEmployeeId(current => (
        serviceEmployees.some(employee => employee.id === current)
          ? current
          : serviceEmployees.find(employee => employee.name === settings.staffName)?.id || serviceEmployees[0]?.id || ''
      ));
    }).catch(() => {
      if (active) setEmployeeError('Không tải được danh sách nhân viên. Hóa đơn sẽ dùng tên mặc định.');
    });
    return () => { active = false; };
  }, [settings.staffName]);

  useEffect(() => {
    paymentCodes.current = makePaymentCodes();
    keepTableOpenRef.current = tableEntryRef.current.status !== 'served';
    localPaymentCommittedRef.current = false;
    setInvoiceData(null);
    setPaymentError(null);
    setCashReceivedInput('');
    setDepartureRequired(false);
  }, [table.id]);

  const subtotal = cartTotal(order);
  const totals = calculateInvoiceTotals(subtotal, settings);
  const cashReceived = cashReceivedInput === '' ? null : Number(cashReceivedInput);
  const cashPaymentInvalid = selectedMethod === 'cash' && (
    !Number.isSafeInteger(cashReceived)
    || cashReceived! < totals.total
    || cashReceived! > 2_000_000_000
  );
  const cashChange = selectedMethod === 'cash' && cashReceived != null && !cashPaymentInvalid
    ? cashReceived - totals.total
    : null;
  const cashSuggestions = [...new Set([
    totals.total,
    Math.ceil(totals.total / 10_000) * 10_000,
    Math.ceil(totals.total / 50_000) * 50_000,
    Math.ceil(totals.total / 100_000) * 100_000,
  ])].filter(value => value > 0 && value <= 2_000_000_000).slice(0, 4);
  const paymentUnavailable = !invoiceData
    && !processing
    && !localPaymentCommittedRef.current
    && (table.isPaid || order.length === 0);

  useEffect(() => {
    if (paymentUnavailable) {
      setPaymentError('Bàn này vừa được thanh toán trên thiết bị khác.');
    }
  }, [paymentUnavailable]);

  /** Dựng cùng lúc dữ liệu gửi API và bản in tạm; tổng cuối vẫn do server quyết định. */
  const buildInvoice = (paymentMethod: PaymentMethodId): { invoice: PrintableInvoiceData; payment: PaymentRecord } => {
    const now = new Date(getServerNowMs());
    const invoiceCode = paymentCodes.current.invoiceCode;
    const transactionCode = paymentCodes.current.transactions[paymentMethod];
    const itemCount = order.reduce((sum, item) => sum + item.quantity, 0);
    const staffName = selectedEmployee?.name ?? settings.staffName;
    const checkedInReservation = table.nextReservation?.status === 'seated'
      ? table.nextReservation
      : null;

    const invoice: PrintableInvoiceData = {
      logo: BRAND_ASSETS.logoStacked,
      invoiceCode,
      transactionCode,
      date: now.toLocaleDateString('vi-VN'),
      time: now.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }),
      table: String(table.number),
      area: table.area || settings.defaultArea,
      customerName: checkedInReservation?.customerName ?? settings.customerName,
      guestCount: checkedInReservation?.partySize ?? settings.guestCount,
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
      paymentMethod: printablePaymentMethod(paymentMethod),
      paymentStatus: 'Đã thanh toán',
      ...(paymentMethod === 'cash' && cashReceived != null ? {
        cashReceived,
        cashChange: Math.max(0, cashReceived - totals.total),
      } : {}),
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
      ...(paymentMethod === 'cash' && cashReceived != null ? { cashReceived } : {}),
      itemCount,
      paidAt: now.toISOString(),
      keepTableOpen: keepTableOpenRef.current,
      ...(selectedEmployee ? { employeeId: selectedEmployee.id } : {}),
      staffName,
      cashierName: settings.cashierName,
    };

    return { invoice, payment };
  };

  /** Chỉ mở hóa đơn in sau khi transaction thanh toán ở server thành công. */
  const handleConfirm = async () => {
    if (invoiceData || processing || paymentUnavailable || cashPaymentInvalid) return;
    const { invoice, payment } = buildInvoice(selectedMethod);
    setProcessing(true);
    setPaymentError(null);
    try {
      const saved = await onConfirm(payment, order);
      // A following isPaid/empty-order snapshot belongs to this local payment,
      // so it must not be reported as a conflict from another device.
      localPaymentCommittedRef.current = true;
      const paidAt = new Date(saved.paidAt);
      const fallbackInvoice: PrintableInvoiceData = {
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
        paymentMethod: printablePaymentMethod(saved.method),
        ...(saved.cashReceived != null ? { cashReceived: saved.cashReceived } : {}),
        ...(saved.cashChange != null ? { cashChange: saved.cashChange } : {}),
        customerName: saved.customerName || invoice.customerName,
        guestCount: saved.guestCount ?? invoice.guestCount,
        staffName: saved.staffName,
        cashierName: saved.cashierName,
      };
      setInvoiceData(fallbackInvoice);
      setDepartureRequired(saved.requiresDepartureConfirmation);
      paymentCodes.current = makePaymentCodes();
      try {
        const details = await fetchPaymentReceipt(saved.invoiceCode);
        setInvoiceData(historicalInvoice(details, settings));
      } catch {
        // The payment is already committed. Keep the server-total fallback visible;
        // history can load the canonical receipt again when connectivity recovers.
      }
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
      className="payment-dialog-overlay"
      onClick={() => { if (!processing) onClose(); }}
    >
      <div
        ref={dialogRef}
        className={`payment-dialog-shell ${invoiceData ? 'is-invoice' : 'is-checkout'}`}
        onClick={event => event.stopPropagation()}
      >
        {invoiceData ? (
          <InvoicePreviewContent
            data={invoiceData}
            format={printFormat}
            onFormatChange={format => {
              setPrintFormat(format);
              setStoredPrintFormat(format);
            }}
            onClose={onClose}
            headingId="payment-dialog-title"
            title="Thanh toán thành công"
            supportingText={departureRequired
              ? 'Bàn vẫn đang phục vụ · xác nhận khách rời sau khi món hoàn tất'
              : undefined}
          />
        ) : (
          <>
            <div className="payment-checkout-header">
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

            <div className="payment-checkout-body">
              <div className="payment-checkout-receipt-pane">
              {keepTableOpenRef.current && (
                <div style={{ margin: '14px 16px 0', padding: '11px 13px', borderRadius: 11, background: '#FFF7ED', border: '1px solid #FDBA74', color: '#9A3412', fontSize: 12, lineHeight: 1.5 }}>
                  <strong>Thanh toán trước khi món hoàn tất.</strong> Bếp vẫn tiếp tục chuẩn bị món và bàn vẫn được giữ cho khách.
                </div>
              )}
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
                    <div style={{ color: '#6B7280', fontSize: '11px' }}>{new Date(getServerNowMs()).toLocaleDateString('vi-VN')}</div>
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
              </div>

              <div className="payment-checkout-controls-pane">
                <label className="payment-employee-field">
                  Nhân viên phục vụ
                  <select
                    value={employeeId}
                    onChange={event => setEmployeeId(event.target.value)}
                    disabled={employees.length === 0}
                  >
                    {employees.length === 0 && <option value="">{settings.staffName}</option>}
                    {employees.map(employee => <option key={employee.id} value={employee.id}>{employee.code} · {employee.name}</option>)}
                  </select>
                  {employeeError && <span style={{ display: 'block', marginTop: 5, color: '#B45309', fontSize: 11, fontWeight: 500 }}>{employeeError}</span>}
                </label>
                <div className="payment-method-label">
                  Phương thức thanh toán
                </div>
                <div
                  className="payment-method-options"
                  role="group"
                  aria-label="Phương thức thanh toán"
                >
                  {enabledMethods.map(item => {
                    const selected = selectedMethod === item.id;
                    return (
                      <button
                        type="button"
                        key={item.id}
                        onClick={() => setMethod(item.id)}
                        aria-pressed={selected}
                        className={`payment-method-option${selected ? ' selected' : ''}`}
                      >
                        <span className="payment-method-icon">
                          {item.icon}
                        </span>
                        <strong>
                          {item.label}
                        </strong>
                        <small>{item.desc}</small>
                      </button>
                    );
                  })}
                </div>
                {selectedMethod === 'cash' && (
                  <div className="payment-cash-panel">
                    <label htmlFor="payment-cash-received">Khách đưa</label>
                    <div className="payment-cash-input">
                      <input
                        id="payment-cash-received"
                        type="number"
                        inputMode="numeric"
                        min={totals.total}
                        max={2_000_000_000}
                        step={1_000}
                        value={cashReceivedInput}
                        onChange={event => setCashReceivedInput(event.target.value)}
                        placeholder={String(totals.total)}
                        aria-describedby="payment-cash-feedback"
                      />
                      <span>đ</span>
                    </div>
                    <div
                      className="payment-cash-suggestions"
                      role="group"
                      aria-label="Số tiền khách đưa thường dùng"
                    >
                      {cashSuggestions.map(value => (
                        <button type="button" key={value} onClick={() => setCashReceivedInput(String(value))}>
                          {formatVND(value)}
                        </button>
                      ))}
                    </div>
                    <div
                      id="payment-cash-feedback"
                      className={`payment-cash-feedback${cashPaymentInvalid ? ' is-error' : ''}`}
                      aria-live="polite"
                    >
                      {cashReceivedInput === ''
                        ? 'Nhập số tiền khách đưa để tính tiền thừa.'
                        : cashPaymentInvalid
                          ? `Còn thiếu ${formatVND(Math.max(0, totals.total - Number(cashReceived || 0)))}`
                          : <>Tiền thừa <strong>{formatVND(cashChange ?? 0)}</strong></>}
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="payment-checkout-footer">
              {paymentError && (
                <div role="alert" style={{ marginBottom: 10, color: '#B91C1C', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 10, padding: 10, fontSize: 13 }}>
                  {paymentError} {!paymentUnavailable && 'Phiếu gọi món vẫn được giữ nguyên để bạn thử lại.'}
                </div>
              )}
              <button
                onClick={() => void handleConfirm()}
                disabled={processing || paymentUnavailable || cashPaymentInvalid}
                style={{
                  width: '100%', background: '#15803D', color: '#fff', border: 'none',
                  borderRadius: 12, padding: '15px', cursor: processing ? 'wait' : 'pointer', fontWeight: 700,
                  fontSize: '15px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
                  opacity: processing || paymentUnavailable || cashPaymentInvalid ? 0.7 : 1,
                }}
              >
                <CheckCircle size={20} />
                {paymentUnavailable ? 'Bàn đã được thanh toán' : processing ? 'Đang ghi nhận…' : `Xác nhận thanh toán · ${formatVND(totals.total)}`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function PaymentPage({
  tables,
  tableOrders,
  payments,
  settings,
  onProcessPayment,
  onConfirmDeparture,
}: PaymentPageProps) {
  const [selectedTableId, setSelectedTableId] = useState<string | null>(null);
  const [paymentView, setPaymentView] = useState<PaymentView>(() => paymentViewFromHistory());
  const [queueSearch, setQueueSearch] = useState('');
  const [queueFilter, setQueueFilter] = useState<PaymentQueueFilter>('all');
  const [showPaidServing, setShowPaidServing] = useState(true);
  const [historySearch, setHistorySearch] = useState('');
  const [historyMethod, setHistoryMethod] = useState<'all' | PaymentMethodId>('all');
  const [showAllHistory, setShowAllHistory] = useState(false);
  const [historyInvoiceData, setHistoryInvoiceData] = useState<PrintableInvoiceData | null>(null);
  const [historyReceiptLoading, setHistoryReceiptLoading] = useState<string | null>(null);
  const [historyReceiptError, setHistoryReceiptError] = useState<string | null>(null);
  const [historyPrintFormat, setHistoryPrintFormat] = useState<InvoicePrintFormat>(initialPrintFormat);
  const [departureTableId, setDepartureTableId] = useState<string | null>(null);
  const [departureBusy, setDepartureBusy] = useState(false);
  const paymentTabsRef = useRef<HTMLDivElement>(null);
  const tablesRef = useRef(tables);
  const ordersRef = useRef(tableOrders);
  tablesRef.current = tables;
  ordersRef.current = tableOrders;
  const selectedTable = tables.find(table => table.id === selectedTableId) ?? null;
  const departureTable = tables.find(table => table.id === departureTableId) ?? null;

  useEffect(() => {
    const restoreFromHistory = () => {
      const tableId = paymentHistoryTableId();
      const table = tablesRef.current.find(row => row.id === tableId);
      const hasOrder = Boolean(tableId && ordersRef.current[tableId]?.length);
      setSelectedTableId(tableId && table && !table.isPaid && hasOrder ? tableId : null);
      setPaymentView(paymentViewFromHistory());
    };
    restoreFromHistory();
    window.addEventListener('popstate', restoreFromHistory);
    return () => window.removeEventListener('popstate', restoreFromHistory);
  }, []);

  const openPayment = (tableId: string) => {
    const current = window.history.state && typeof window.history.state === 'object'
      ? window.history.state as Record<string, unknown>
      : {};
    window.history.pushState({ ...current, [PAYMENT_HISTORY_KEY]: tableId }, '');
    setSelectedTableId(tableId);
  };

  const closePayment = () => {
    if (paymentHistoryTableId() === selectedTableId) window.history.back();
    else setSelectedTableId(null);
  };

  const switchPaymentView = (nextView: PaymentView) => {
    if (nextView === paymentView) return;
    const current = window.history.state && typeof window.history.state === 'object'
      ? window.history.state as Record<string, unknown>
      : {};
    window.history.pushState({ ...current, [PAYMENT_VIEW_HISTORY_KEY]: nextView }, '');
    setPaymentView(nextView);
    window.requestAnimationFrame(() => paymentTabsRef.current?.scrollIntoView({ block: 'start' }));
  };

  const handlePaymentTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    let nextView: PaymentView | null = null;
    if (event.key === 'ArrowLeft' || event.key === 'Home') nextView = 'queue';
    if (event.key === 'ArrowRight' || event.key === 'End') nextView = 'history';
    if (!nextView) return;
    event.preventDefault();
    switchPaymentView(nextView);
    window.requestAnimationFrame(() => {
      paymentTabsRef.current
        ?.querySelector<HTMLButtonElement>(`[data-payment-view="${nextView}"]`)
        ?.focus();
    });
  };

  const orderedTables = tables.filter(table => tableOrders[table.id] && tableOrders[table.id].length > 0);
  const unpaidTables = orderedTables
    .filter(table => !table.isPaid)
    .sort((left, right) => (
      PAYMENT_STATUS_PRIORITY[left.status] - PAYMENT_STATUS_PRIORITY[right.status]
      || left.number - right.number
    ));
  const normalizedQueueSearch = queueSearch.trim().toLocaleLowerCase('vi-VN');
  const visibleUnpaidTables = unpaidTables.filter(table => {
    if (queueFilter === 'ready' && table.status !== 'served') return false;
    if (queueFilter === 'early' && table.status === 'served') return false;
    if (!normalizedQueueSearch) return true;
    const order = tableOrders[table.id] || [];
    return [
      String(table.number),
      `bàn ${table.number}`,
      table.area ?? '',
      STATUS_CONFIG[table.status].label,
      ...order.map(item => item.menuItem.name),
    ].some(value => value.toLocaleLowerCase('vi-VN').includes(normalizedQueueSearch));
  });
  const paidServingTables = orderedTables.filter(table => table.isPaid);
  const unpaidTotal = unpaidTables.reduce((sum, table) => (
    sum + payableTotal(tableOrders[table.id] || [], settings)
  ), 0);
  const visibleUnpaidTotal = visibleUnpaidTables.reduce((sum, table) => (
    sum + payableTotal(tableOrders[table.id] || [], settings)
  ), 0);
  const queueIsFiltered = queueFilter !== 'all' || normalizedQueueSearch.length > 0;
  const filteredPayments = useMemo(() => {
    const search = historySearch.trim().toLocaleLowerCase('vi-VN');
    return [...payments]
      .sort((left, right) => new Date(right.paidAt).getTime() - new Date(left.paidAt).getTime())
      .filter(payment => historyMethod === 'all' || payment.method === historyMethod)
      .filter(payment => {
        if (!search) return true;
        return [
          payment.invoiceCode,
          payment.transactionCode,
          `bàn ${payment.tableNumber}`,
          String(payment.tableNumber),
          payment.customerName,
          payment.staffName,
          payment.cashierName,
        ].some(value => value?.toLocaleLowerCase('vi-VN').includes(search));
      });
  }, [historyMethod, historySearch, payments]);
  const visiblePayments = showAllHistory
    ? filteredPayments
    : filteredPayments.slice(0, PAYMENT_HISTORY_LIMIT);
  const filteredPaymentTotal = filteredPayments.reduce((sum, payment) => sum + payment.total, 0);

  const openHistoryReceipt = async (payment: PaymentRecord) => {
    if (historyReceiptLoading) return;
    setHistoryReceiptLoading(payment.invoiceCode);
    setHistoryReceiptError(null);
    try {
      const details = await fetchPaymentReceipt(payment.invoiceCode);
      setHistoryInvoiceData(historicalInvoice(details, settings));
    } catch (error) {
      setHistoryReceiptError(error instanceof Error ? error.message : 'Không thể tải chi tiết hóa đơn.');
    } finally {
      setHistoryReceiptLoading(null);
    }
  };

  const confirmDeparture = async () => {
    if (!departureTableId || departureBusy) return;
    setDepartureBusy(true);
    try {
      await onConfirmDeparture(departureTableId);
      setDepartureTableId(null);
    } catch {
      // App đã hiển thị lỗi; giữ dialog mở để nhân viên có thể thử lại hoặc quay lại.
    } finally {
      setDepartureBusy(false);
    }
  };

  return (
    <div className="payment-page">
      <h1 style={{ position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0, 0, 0, 0)', whiteSpace: 'nowrap', border: 0 }}>Thanh toán</h1>

      <div className="payment-page-content">
        <div className="payment-page-toolbar">
          <div ref={paymentTabsRef} className="payment-view-tabs" role="tablist" aria-label="Nội dung thanh toán">
            <button
              type="button"
              id="payment-queue-tab"
              role="tab"
              data-payment-view="queue"
              className={paymentView === 'queue' ? 'active' : ''}
              onClick={() => switchPaymentView('queue')}
              onKeyDown={handlePaymentTabKeyDown}
              aria-controls="payment-queue-panel"
              aria-selected={paymentView === 'queue'}
              tabIndex={paymentView === 'queue' ? 0 : -1}
            >
              <CreditCard size={17} aria-hidden="true" />
              <span>Thanh toán</span>
              <strong>{unpaidTables.length}</strong>
            </button>
            <button
              type="button"
              id="payment-history-tab"
              role="tab"
              data-payment-view="history"
              className={paymentView === 'history' ? 'active' : ''}
              onClick={() => switchPaymentView('history')}
              onKeyDown={handlePaymentTabKeyDown}
              aria-controls="payment-history-panel"
              aria-selected={paymentView === 'history'}
              tabIndex={paymentView === 'history' ? 0 : -1}
            >
              <History size={17} aria-hidden="true" />
              <span>Lịch sử đơn</span>
              <strong>{payments.length}</strong>
            </button>
          </div>

          {paymentView === 'queue' && (
            <header className="payment-view-summary">
              <div className="payment-view-summary-copy">
                <h2 id="payment-unpaid-title">Chưa thanh toán</h2>
                <p aria-live="polite">
                  {visibleUnpaidTables.length}/{unpaidTables.length} bàn đang hiển thị
                </p>
              </div>
              <div className="payment-unpaid-totals" aria-live="polite">
                {queueIsFiltered && (
                  <div
                    className="payment-total-metric is-filtered"
                    aria-label={`Tổng các bàn đang hiển thị ${formatVND(visibleUnpaidTotal)}`}
                  >
                    <span>Đang hiển thị</span>
                    <strong>{formatVND(visibleUnpaidTotal)}</strong>
                  </div>
                )}
                <div
                  className="payment-total-metric"
                  aria-label={`Tổng tất cả chưa thu ${formatVND(unpaidTotal)}`}
                >
                  <span>Tổng tất cả chưa thu</span>
                  <strong>{formatVND(unpaidTotal)}</strong>
                </div>
              </div>
            </header>
          )}

          {paymentView === 'history' && (
            <header className="payment-view-summary">
              <div className="payment-view-summary-copy">
                <h2 id="payment-history-title">Lịch sử đơn đã thanh toán</h2>
                <p>Tối đa 100 hóa đơn gần nhất được đồng bộ từ hệ thống</p>
              </div>
              <div
                className="payment-total-metric"
                aria-live="polite"
                aria-label={`${filteredPayments.length} hóa đơn, tổng giá trị ${formatVND(filteredPaymentTotal)}`}
              >
                <span>{filteredPayments.length} hóa đơn</span>
                <strong>{formatVND(filteredPaymentTotal)}</strong>
              </div>
            </header>
          )}
        </div>

        {paymentView === 'queue' && (
          <div
            id="payment-queue-panel"
            className="payment-live-content"
            role="tabpanel"
            aria-labelledby="payment-queue-tab"
          >
          {unpaidTables.length > 0 && (
          <section className="payment-unpaid-section" aria-labelledby="payment-unpaid-title">
            <div className="payment-queue-controls">
              <label className="payment-queue-search">
                <Search size={17} aria-hidden="true" />
                <span className="sr-only">Tìm bàn cần thanh toán</span>
                <input
                  value={queueSearch}
                  onChange={event => setQueueSearch(event.target.value)}
                  placeholder="Tìm số bàn, khu vực hoặc món"
                />
              </label>
              <div
                className="payment-queue-filters"
                role="group"
                aria-label="Lọc bàn theo khả năng thanh toán"
              >
                <SlidersHorizontal size={16} aria-hidden="true" />
                {([
                  ['all', 'Tất cả', unpaidTables.length],
                  ['ready', 'Đã phục vụ', unpaidTables.filter(table => table.status === 'served').length],
                  ['early', 'Có thể trả trước', unpaidTables.filter(table => table.status !== 'served').length],
                ] as Array<[PaymentQueueFilter, string, number]>).map(([id, label, count]) => (
                  <button
                    type="button"
                    key={id}
                    className={queueFilter === id ? 'active' : ''}
                    aria-pressed={queueFilter === id}
                    onClick={() => setQueueFilter(id)}
                  >
                    {label} <strong>{count}</strong>
                  </button>
                ))}
              </div>
            </div>

            <div className="payment-table-list">
              {visibleUnpaidTables.map(table => {
                const order = tableOrders[table.id] || [];
                const total = payableTotal(order, settings);
                const readyToClose = table.status === 'served';
                return (
                  <button
                    key={table.id}
                    type="button"
                    className={`payment-table-row${readyToClose ? ' ready-to-close' : ' early-payment'}`}
                    onClick={() => openPayment(table.id)}
                    aria-label={`Thanh toán bàn ${table.number}, ${formatVND(total)}${readyToClose ? ', món đã được phục vụ' : ', thanh toán trước khi phục vụ hoàn tất'}`}
                  >
                    <span className="payment-table-number">{table.number}</span>

                    <span className="payment-table-copy">
                      <span className="payment-table-title">
                        <strong>Bàn {table.number}</strong>
                        <span className={`payment-table-status ${readyToClose ? 'is-ready' : 'is-early'}`}>
                          {readyToClose ? 'Đã phục vụ' : 'Có thể trả trước'}
                        </span>
                      </span>
                      <span className="payment-table-meta">
                        <span>
                          <Users size={12} aria-hidden="true" /> {table.seats} chỗ
                        </span>
                        <span>{order.reduce((sum, item) => sum + item.quantity, 0)} phần</span>
                        <span>{order.length} món</span>
                        {(table.additionalBatchCount ?? 0) > 0 && (
                          <span className="payment-table-batches">{table.batchCount} lượt (+{table.additionalBatchCount})</span>
                        )}
                        <OrderTimer table={table} compact />
                      </span>
                      {!readyToClose && (
                        <span className="payment-table-guidance">
                          Bàn vẫn được giữ cho khách sau khi thanh toán
                        </span>
                      )}
                    </span>

                    <span className="payment-table-action-rail">
                      <span className="payment-table-amount">
                        <strong>{formatVND(total)}</strong>
                      </span>
                      <span className="payment-table-cta" aria-hidden="true">
                        <CreditCard size={16} />
                        <strong>Thanh toán</strong>
                        <ArrowRight size={16} />
                      </span>
                    </span>
                  </button>
                );
              })}
              {visibleUnpaidTables.length === 0 && (
                <div className="payment-queue-empty">
                  <Search size={24} aria-hidden="true" />
                  <strong>Không có bàn phù hợp</strong>
                  <span>Thử đổi từ khóa hoặc bộ lọc trạng thái thu tiền.</span>
                </div>
              )}
            </div>
          </section>
        )}

        {paidServingTables.length > 0 && (
          <section className="payment-paid-section" aria-labelledby="payment-paid-title">
            <button
              type="button"
              className="payment-paid-toggle"
              aria-expanded={showPaidServing}
              aria-controls="payment-paid-serving-list"
              onClick={() => setShowPaidServing(value => !value)}
            >
              <span>
                <BadgeCheck size={18} aria-hidden="true" />
                <span>
                  <strong id="payment-paid-title">Đã thanh toán · đang phục vụ</strong>
                  <small>{paidServingTables.length} bàn đã thu tiền, chưa giải phóng</small>
                </span>
              </span>
              {showPaidServing ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
            </button>
            {showPaidServing && (
              <div id="payment-paid-serving-list" className="payment-paid-list" role="list">
              {paidServingTables.map(table => {
                const order = tableOrders[table.id] || [];
                const paidTotal = table.paidTotal ?? payableTotal(order, settings);
                return (
                  <div
                    className={`payment-paid-row${table.status === 'served' ? ' is-departure-ready' : ''}`}
                    key={table.id}
                    role="listitem"
                  >
                    <span className="payment-table-number">{table.number}</span>
                    <span className="payment-paid-copy">
                      <span className="payment-table-title">
                        <strong>Bàn {table.number}</strong>
                        <span className="payment-paid-badge"><BadgeCheck size={13} /> Đã thanh toán</span>
                      </span>
                      <span className="payment-table-meta">
                        <span><Users size={12} aria-hidden="true" /> {table.seats} chỗ</span>
                        <span>{order.reduce((sum, item) => sum + item.quantity, 0)} phần</span>
                        <OrderTimer table={table} compact />
                      </span>
                      <span className="payment-paid-guidance">
                        {table.status === 'served'
                          ? 'Món đã được phục vụ · có thể xác nhận khách rời'
                          : table.status === 'done'
                            ? 'Bếp đã xong · chờ xác nhận mang món ra bàn'
                            : 'Bếp vẫn đang chuẩn bị món · bàn tiếp tục được giữ'}
                      </span>
                    </span>
                    <span className="payment-paid-action">
                      <span className="payment-paid-amount">
                        <span>Đã thu</span>
                        <strong>{formatVND(paidTotal)}</strong>
                        <small title={table.paymentId || undefined}>
                          {table.paidAt
                            ? `Lúc ${new Date(table.paidAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}`
                            : 'Đã thanh toán'}
                          {table.paymentId ? ` · ${table.paymentId}` : ''}
                        </small>
                      </span>
                      {table.status === 'served' && (
                        <button
                          type="button"
                          className="payment-paid-departure"
                          onClick={() => setDepartureTableId(table.id)}
                        >
                          <LogOut size={15} aria-hidden="true" />
                          Xác nhận khách rời
                        </button>
                      )}
                    </span>
                  </div>
                );
              })}
              </div>
            )}
          </section>
        )}

          {orderedTables.length === 0 && (
          <div style={{ textAlign: 'center', padding: '48px 24px', color: '#9CA3AF' }}>
            <div style={{ width: 64, height: 64, borderRadius: 16, background: '#ECFEFF', margin: '0 auto 12px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <ReceiptText size={30} color="#0D9488" />
            </div>
            <div style={{ fontWeight: 600, color: '#374151', marginBottom: 6 }}>Chưa có bàn cần thanh toán</div>
            <div style={{ fontSize: '13px' }}>Các bàn đã gọi món sẽ xuất hiện tại đây</div>
          </div>
          )}
          </div>
        )}

        {paymentView === 'history' && (
          <div
            id="payment-history-panel"
            role="tabpanel"
            aria-labelledby="payment-history-tab"
          >
            <PaymentHistoryPanel
              payments={payments}
              filteredPayments={filteredPayments}
              visiblePayments={visiblePayments}
              historyLimit={PAYMENT_HISTORY_LIMIT}
              search={historySearch}
              method={historyMethod}
              showAll={showAllHistory}
              receiptLoading={historyReceiptLoading}
              receiptError={historyReceiptError}
              onSearchChange={value => {
                setHistorySearch(value);
                setShowAllHistory(false);
              }}
              onMethodChange={value => {
                setHistoryMethod(value);
                setShowAllHistory(false);
              }}
              onToggleShowAll={() => setShowAllHistory(value => !value)}
              onOpenReceipt={payment => void openHistoryReceipt(payment)}
            />
          </div>
        )}
      </div>

      {selectedTable && (
        <BillPanel
          table={selectedTable}
          order={tableOrders[selectedTable.id] || []}
          settings={settings}
          onClose={closePayment}
          onConfirm={(payment, items) => onProcessPayment(payment, items)}
        />
      )}
      {historyInvoiceData && (
        <HistoryInvoiceDialog
          data={historyInvoiceData}
          format={historyPrintFormat}
          onFormatChange={format => {
            setHistoryPrintFormat(format);
            setStoredPrintFormat(format);
          }}
          onClose={() => setHistoryInvoiceData(null)}
        />
      )}
      {departureTable && (
        <ConfirmationDialog
          title={`Xác nhận khách rời Bàn ${departureTable.number}?`}
          message={`Thao tác này sẽ đóng lượt phục vụ và đưa Bàn ${departureTable.number} về trạng thái Trống.`}
          confirmLabel="Xác nhận khách rời"
          busy={departureBusy}
          onCancel={() => {
            if (!departureBusy) setDepartureTableId(null);
          }}
          onConfirm={() => void confirmDeparture()}
        />
      )}
    </div>
  );
}
