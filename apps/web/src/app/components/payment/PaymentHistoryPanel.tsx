import { ChevronDown, ChevronUp, History, Printer, ReceiptText, Search } from 'lucide-react';
import { type PaymentMethodId, type PaymentRecord, formatVND } from '../../data';
import { PAYMENT_METHOD_LABELS } from '../../config/restaurant';

const PAYMENT_METHODS: PaymentMethodId[] = ['cash', 'card', 'qr'];

function formatPaymentDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

interface PaymentHistoryPanelProps {
  payments: PaymentRecord[];
  filteredPayments: PaymentRecord[];
  visiblePayments: PaymentRecord[];
  filteredPaymentTotal: number;
  historyLimit: number;
  search: string;
  method: 'all' | PaymentMethodId;
  showAll: boolean;
  receiptLoading: string | null;
  receiptError: string | null;
  onSearchChange: (value: string) => void;
  onMethodChange: (value: 'all' | PaymentMethodId) => void;
  onToggleShowAll: () => void;
  onOpenReceipt: (payment: PaymentRecord) => void;
}

export function PaymentHistoryPanel({
  payments,
  filteredPayments,
  visiblePayments,
  filteredPaymentTotal,
  historyLimit,
  search,
  method,
  showAll,
  receiptLoading,
  receiptError,
  onSearchChange,
  onMethodChange,
  onToggleShowAll,
  onOpenReceipt,
}: PaymentHistoryPanelProps) {
  return (
    <section className="payment-history-section" aria-labelledby="payment-history-title">
      <header className="payment-history-header">
        <div className="payment-history-heading">
          <span className="payment-history-heading-icon" aria-hidden="true">
            <History size={20} />
          </span>
          <div>
            <h2 id="payment-history-title">Lịch sử đơn đã thanh toán</h2>
            <p>Tối đa 100 hóa đơn gần nhất được đồng bộ từ hệ thống</p>
          </div>
        </div>
        <div className="payment-history-summary" aria-live="polite">
          <span>{filteredPayments.length} hóa đơn</span>
          <strong>{formatVND(filteredPaymentTotal)}</strong>
        </div>
      </header>

      <div className="payment-history-controls">
        <label className="payment-history-search">
          <Search size={16} aria-hidden="true" />
          <span className="payment-history-control-label">Tìm hóa đơn</span>
          <input
            value={search}
            onChange={event => onSearchChange(event.target.value)}
            placeholder="Mã hóa đơn, bàn, khách hoặc nhân viên"
            aria-label="Tìm trong lịch sử thanh toán"
          />
        </label>
        <label className="payment-history-method">
          <span className="payment-history-control-label">Phương thức</span>
          <select
            value={method}
            onChange={event => onMethodChange(event.target.value as 'all' | PaymentMethodId)}
            aria-label="Lọc lịch sử theo phương thức thanh toán"
          >
            <option value="all">Tất cả phương thức</option>
            {PAYMENT_METHODS.map(paymentMethod => (
              <option key={paymentMethod} value={paymentMethod}>
                {PAYMENT_METHOD_LABELS[paymentMethod]}
              </option>
            ))}
          </select>
        </label>
      </div>

      {receiptError && (
        <div className="payment-history-detail-error" role="alert">
          {receiptError}
        </div>
      )}

      <div className="payment-history-list">
        {visiblePayments.map(payment => (
          <button
            type="button"
            className="payment-history-row"
            key={payment.invoiceCode}
            onClick={() => onOpenReceipt(payment)}
            disabled={receiptLoading !== null}
            aria-label={`Mở hóa đơn ${payment.invoiceCode}, bàn ${payment.tableNumber}, ${formatVND(payment.total)}`}
          >
            <span className="payment-history-table-number">
              <small>Bàn</small>
              <strong>{payment.tableNumber}</strong>
            </span>
            <span className="payment-history-copy">
              <span className="payment-history-title-row">
                <strong>{payment.invoiceCode}</strong>
                <span className={`payment-history-method-badge method-${payment.method}`}>
                  {PAYMENT_METHOD_LABELS[payment.method]}
                </span>
              </span>
              <span className="payment-history-meta">
                <span>{formatPaymentDate(payment.paidAt)}</span>
                <span>{payment.itemCount} phần</span>
                <span>{payment.cashierName || payment.staffName}</span>
                {payment.customerName && <span>{payment.customerName}</span>}
              </span>
            </span>
            <span className="payment-history-amount">
              <strong>{formatVND(payment.total)}</strong>
              <small>{payment.transactionCode}</small>
              <span className="payment-history-open-hint">
                <Printer size={13} aria-hidden="true" />
                {receiptLoading === payment.invoiceCode ? 'Đang tải…' : 'Xem và in lại'}
              </span>
            </span>
          </button>
        ))}

        {filteredPayments.length === 0 && (
          <div className="payment-history-empty">
            <ReceiptText size={26} aria-hidden="true" />
            <strong>
              {payments.length ? 'Không tìm thấy hóa đơn phù hợp' : 'Chưa có hóa đơn đã thanh toán'}
            </strong>
            <span>
              {payments.length
                ? 'Thử đổi từ khóa hoặc phương thức thanh toán.'
                : 'Hóa đơn hoàn tất sẽ xuất hiện tại đây.'}
            </span>
          </div>
        )}
      </div>

      {filteredPayments.length > historyLimit && (
        <button type="button" className="payment-history-toggle" onClick={onToggleShowAll}>
          {showAll ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          {showAll ? 'Thu gọn lịch sử' : `Xem thêm ${filteredPayments.length - historyLimit} hóa đơn`}
        </button>
      )}
    </section>
  );
}
