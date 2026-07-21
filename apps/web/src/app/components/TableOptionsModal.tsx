import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertCircle,
  BadgeCheck,
  CheckCircle2,
  ChevronRight,
  ClipboardList,
  DoorOpen,
  Pencil,
  Trash2,
  X,
} from 'lucide-react';
import { cartTotal, formatVND, STATUS_CONFIG, type CartItem, type Table, type TableStatus } from '../data';
import type { EditableOrderBatch } from '../services/api';
import { OrderTimer } from './OrderTimer';
import { ConfirmationDialog } from './ConfirmationDialog';

interface TableOptionsModalProps {
  table: Table;
  order?: CartItem[];
  waitingBatches?: EditableOrderBatch[];
  onClose: () => void;
  onStartOrder: () => void;
  onEditOrder: (batchId: number) => void;
  onDeleteOrder: () => Promise<void>;
  onMarkDone: () => Promise<void>;
  onConfirmDeparture: () => Promise<void>;
}

const TABLE_OPTIONS_HISTORY_KEY = 'casTableOptionsId';

export function getTableOptionsHistoryTableId(state: unknown = window.history.state): string | null {
  if (!state || typeof state !== 'object') return null;
  const value = (state as Record<string, unknown>)[TABLE_OPTIONS_HISTORY_KEY];
  return typeof value === 'string' ? value : null;
}

/** Chỉ cho phép hủy khi mọi phiếu của order vẫn nằm trong hàng chờ. */
export function canDeleteWaitingOrder(table: Table, hasOrder: boolean): boolean {
  if (!hasOrder || table.status !== 'waiting' || table.isPaid) return false;

  const totalBatches = table.batchCount ?? 0;
  const waitingBatches = table.waitingBatchCount ?? 0;
  const cookingBatches = table.cookingBatchCount ?? 0;
  const doneBatches = table.doneBatchCount ?? 0;

  return waitingBatches > 0
    && cookingBatches === 0
    && doneBatches === 0
    && (totalBatches === 0 || waitingBatches === totalBatches);
}

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

function deleteBlockedReason(table: Table): string {
  if (table.isPaid) return 'Không thể hủy vì bàn đã thanh toán';
  if ((table.cookingBatchCount ?? 0) > 0 || table.status === 'cooking') {
    return 'Không thể hủy vì đã có phiếu đang nấu';
  }
  if ((table.doneBatchCount ?? 0) > 0 || table.status === 'done') {
    return 'Không thể hủy vì đã có phiếu nấu xong';
  }
  return 'Chỉ có thể hủy khi toàn bộ phiếu còn đang chờ';
}

function formatReservationTime(value: string): string {
  return new Date(value).toLocaleString('vi-VN', {
    hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit',
  });
}

/** Modal thao tác trực tiếp từ màn Vận hành bàn. */
export function TableOptionsModal({
  table,
  order,
  waitingBatches = [],
  onClose,
  onStartOrder,
  onEditOrder,
  onDeleteOrder,
  onMarkDone,
  onConfirmDeparture,
}: TableOptionsModalProps) {
  const titleId = useId();
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const confirmationOpenRef = useRef(false);
  const [showDeleteConfirmation, setShowDeleteConfirmation] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [markDoneBusy, setMarkDoneBusy] = useState(false);
  const [departureBusy, setDepartureBusy] = useState(false);
  const [showDepartureConfirmation, setShowDepartureConfirmation] = useState(false);
  const cfg = STATUS_CONFIG[table.status];
  const hasOrder = Boolean(order?.length);
  const checkedInReservation = table.nextReservation?.status === 'seated';
  const isCooking = table.status === 'cooking';
  const total = hasOrder ? cartTotal(order!) : 0;
  const canDelete = canDeleteWaitingOrder(table, hasOrder);
  confirmationOpenRef.current = showDeleteConfirmation || showDepartureConfirmation;
  onCloseRef.current = onClose;

  const requestClose = () => {
    if (getTableOptionsHistoryTableId() === table.id) {
      window.history.back();
    } else {
      onCloseRef.current();
    }
  };

  const closeAfterAction = () => {
    // Điều hướng sang menu đã tạo một history entry mới; thao tác tại chỗ thì lùi entry modal.
    if (getTableOptionsHistoryTableId() === table.id) requestClose();
    else onCloseRef.current();
  };

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (confirmationOpenRef.current) return;
      if (event.key === 'Escape') requestClose();
      if (event.key === 'Tab') {
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
      }
    };
    const handlePopState = () => {
      if (getTableOptionsHistoryTableId() !== table.id) onCloseRef.current();
    };

    if (getTableOptionsHistoryTableId() !== table.id) {
      const current = window.history.state && typeof window.history.state === 'object'
        ? window.history.state as Record<string, unknown>
        : {};
      window.history.pushState({ ...current, [TABLE_OPTIONS_HISTORY_KEY]: table.id }, '');
    }

    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('popstate', handlePopState);
    closeButtonRef.current?.focus();

    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('popstate', handlePopState);
      previouslyFocused?.focus();
    };
  }, [table.id]);

  return createPortal(
    <div
      className="table-options-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onClick={requestClose}
    >
      <div ref={dialogRef} className="table-options-dialog" onClick={event => event.stopPropagation()}>
        <div className="table-options-header">
          <div
            style={{
              width: 48,
              height: 48,
              borderRadius: 14,
              background: cfg.bg,
              border: `2px solid ${cfg.border}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <span style={{ fontWeight: 800, color: '#111827', fontSize: 18 }}>{table.number}</span>
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div id={titleId} style={{ fontWeight: 700, color: '#111827', fontSize: 16 }}>Bàn {table.number}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2, flexWrap: 'wrap' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center' }}>
                <StatusDot status={table.status} animate={isCooking || table.status === 'waiting'} />
                <span style={{ fontSize: 13, color: cfg.text, fontWeight: 600 }}>{cfg.label}</span>
              </span>
              <span style={{ fontSize: 12, color: '#9CA3AF' }}>· {table.seats} chỗ</span>
              {table.isPaid && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, borderRadius: 999, padding: '3px 8px', background: '#DCFCE7', color: '#166534', fontSize: 11, fontWeight: 900 }}>
                  <BadgeCheck size={13} /> Đã thanh toán
                </span>
              )}
              {table.nextReservation && (
                <span style={{ fontSize: 12, color: '#2563EB' }}>
                  · {formatReservationTime(table.nextReservation.reservedAt)} · {table.nextReservation.customerName}
                </span>
              )}
            </div>
            <div style={{ marginTop: 6 }}><OrderTimer table={table} compact /></div>
            {(table.additionalBatchCount ?? 0) > 0 && (
              <div style={{ marginTop: 6, color: '#6D28D9', fontSize: 11, fontWeight: 800 }}>
                {table.batchCount} lượt gọi · +{table.additionalBatchCount} gọi thêm
              </div>
            )}
            {table.isPaid && (
              <div style={{ marginTop: 6, color: '#166534', fontSize: 12, fontWeight: 700 }}>
                {table.paidAt ? `Đã thu lúc ${new Date(table.paidAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}` : 'Đã thu tiền'}
                {table.paymentId ? ` · ${table.paymentId}` : ''}
              </div>
            )}
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            aria-label="Đóng tùy chọn bàn"
            onClick={requestClose}
            className="table-options-close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="table-options-scroll">
          {hasOrder && (
            <div className="table-options-order-preview">
              <div className="table-options-section-label">
                Món đã gọi ({order!.reduce((sum, item) => sum + item.quantity, 0)} phần)
              </div>
              {order!.map(item => (
                <div key={item.cartId} className="table-options-order-line">
                  <span>
                    {item.menuItem.name}
                    {item.selectedSize ? ` (${item.selectedSize.label})` : ''} x{item.quantity}
                  </span>
                  <strong>{formatVND((item.menuItem.price + (item.selectedSize?.extraPrice ?? 0) + item.selectedToppings.reduce((sum, topping) => sum + topping.price, 0)) * item.quantity)}</strong>
                </div>
              ))}
              <div className="table-options-total">
                <span>{table.isPaid ? 'Đã thu' : 'Tổng'}</span>
                <strong>{formatVND(table.isPaid && table.paidTotal != null ? table.paidTotal : total)}</strong>
              </div>
            </div>
          )}

          <div className="table-options-actions">
            {!table.isPaid && (table.status === 'empty' || hasOrder || checkedInReservation)
              && (table.status !== 'reserved' || checkedInReservation) && (
              <button
                type="button"
                onClick={() => { onStartOrder(); closeAfterAction(); }}
                className="table-option-action table-option-action-add"
              >
                <span className="table-option-action-icon table-option-action-icon-add">
                  {hasOrder ? <Pencil size={18} /> : <ClipboardList size={18} />}
                </span>
                <span className="table-option-action-copy">
                  <strong>{hasOrder ? 'Gọi thêm món' : 'Gọi món cho bàn này'}</strong>
                  <small>{hasOrder ? 'Tạo một lượt gọi thêm' : 'Mở menu và chọn món'}</small>
                </span>
                <ChevronRight size={18} />
              </button>
            )}

            {!table.isPaid && waitingBatches.length > 0 && (
              <section className="table-options-edit-section" aria-label="Các phiếu đang chờ có thể sửa">
                {waitingBatches.length > 1 && (
                  <div className="table-options-section-label">Chọn phiếu đang chờ cần sửa</div>
                )}
                {waitingBatches.map(batch => (
                  <button
                    key={batch.batchId}
                    type="button"
                    onClick={() => { onEditOrder(batch.batchId); closeAfterAction(); }}
                    className="table-option-action table-option-action-edit"
                  >
                    <span className="table-option-action-icon table-option-action-icon-edit"><Pencil size={18} /></span>
                    <span className="table-option-action-copy">
                      <strong>Sửa phiếu chờ #{batch.batchNumber}</strong>
                      <small>
                        {batch.items.reduce((sum, item) => sum + item.quantity, 0)} phần · dự kiến {batch.estimatedCookMinutes} phút
                      </small>
                    </span>
                    <ChevronRight size={18} />
                  </button>
                ))}
              </section>
            )}

            {isCooking && (
              <button
                type="button"
                onClick={() => {
                  if (markDoneBusy) return;
                  setMarkDoneBusy(true);
                  void onMarkDone().then(
                    () => {
                      setMarkDoneBusy(false);
                      closeAfterAction();
                    },
                    () => setMarkDoneBusy(false),
                  );
                }}
                disabled={markDoneBusy}
                aria-busy={markDoneBusy}
                className="table-option-action table-option-action-done"
              >
                <span className="table-option-action-icon table-option-action-icon-done"><CheckCircle2 size={19} /></span>
                <span className="table-option-action-copy">
                  <strong>{markDoneBusy ? 'Đang hoàn tất…' : 'Đánh dấu xong nấu'}</strong>
                  <small>{markDoneBusy ? 'Đang cập nhật…' : 'Chuyển phiếu đang nấu sang “Đã xong”'}</small>
                </span>
                <ChevronRight size={18} />
              </button>
            )}

            {table.isPaid && table.status !== 'done' && (
              <div className="table-options-information" style={{ background: '#F0FDF4', borderColor: '#86EFAC', color: '#166534' }}>
                <BadgeCheck size={17} />
                Bàn đã thanh toán và vẫn đang phục vụ. Chờ bếp hoàn tất món trước khi xác nhận khách rời.
              </div>
            )}

            {table.isPaid && table.status === 'done' && (
              <button
                type="button"
                onClick={() => setShowDepartureConfirmation(true)}
                disabled={departureBusy}
                className="table-option-action table-option-action-done"
              >
                <span className="table-option-action-icon table-option-action-icon-done"><DoorOpen size={19} /></span>
                <span className="table-option-action-copy">
                  <strong>{departureBusy ? 'Đang đóng bàn…' : 'Xác nhận khách đã rời'}</strong>
                  <small>Đưa bàn về trạng thái trống</small>
                </span>
                <ChevronRight size={18} />
              </button>
            )}

            {hasOrder && !table.isPaid && (
              <button
                type="button"
                onClick={() => {
                  if (canDelete) setShowDeleteConfirmation(true);
                }}
                disabled={!canDelete}
                className={`table-option-action table-option-action-delete${canDelete ? '' : ' is-disabled'}`}
              >
                <span className="table-option-action-icon table-option-action-icon-delete"><Trash2 size={18} /></span>
                <span className="table-option-action-copy">
                  <strong>Hủy phiếu gọi món</strong>
                  <small>
                    {!canDelete && <AlertCircle size={11} />}
                    {canDelete ? 'Xóa toàn bộ lượt gọi còn đang chờ' : deleteBlockedReason(table)}
                  </small>
                </span>
              </button>
            )}

            {table.status === 'reserved' && !checkedInReservation && (
              <div className="table-options-information">
                <AlertCircle size={17} />
                Bàn đang được giữ theo lịch. Hãy check-in khách tại mục Đặt bàn trước khi gọi món.
              </div>
            )}
          </div>
        </div>
        {showDeleteConfirmation && (
          <ConfirmationDialog
            title="Hủy toàn bộ lượt gọi?"
            message={`Toàn bộ phiếu đang chờ của bàn ${table.number} sẽ bị xóa. Thao tác này không thể hoàn tác.`}
            confirmLabel="Xác nhận hủy"
            busy={deleteBusy}
            onCancel={() => { if (!deleteBusy) setShowDeleteConfirmation(false); }}
            onConfirm={() => {
              if (deleteBusy) return;
              setDeleteBusy(true);
              void onDeleteOrder().then(
                () => {
                  setDeleteBusy(false);
                  setShowDeleteConfirmation(false);
                  closeAfterAction();
                },
                () => {
                  setDeleteBusy(false);
                  setShowDeleteConfirmation(false);
                },
              );
            }}
          />
        )}
        {showDepartureConfirmation && (
          <ConfirmationDialog
            title="Xác nhận khách đã rời?"
            message={`Bàn ${table.number} đã thanh toán và món đã hoàn tất. Xác nhận để đóng lượt phục vụ và đưa bàn về trạng thái trống.`}
            confirmLabel="Khách đã rời"
            busy={departureBusy}
            onCancel={() => { if (!departureBusy) setShowDepartureConfirmation(false); }}
            onConfirm={() => {
              if (departureBusy) return;
              setDepartureBusy(true);
              void onConfirmDeparture().then(
                () => {
                  setDepartureBusy(false);
                  setShowDepartureConfirmation(false);
                  closeAfterAction();
                },
                () => {
                  setDepartureBusy(false);
                  setShowDepartureConfirmation(false);
                },
              );
            }}
          />
        )}
      </div>
    </div>,
    document.body,
  );
}
