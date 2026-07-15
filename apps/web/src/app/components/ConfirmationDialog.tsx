import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, X } from 'lucide-react';

interface ConfirmationDialogProps {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
}

/** Dialog xác nhận có focus trap, thay cho confirm native làm gián đoạn giao diện POS. */
export function ConfirmationDialog({ title, message, confirmLabel, onConfirm, onCancel, busy = false }: ConfirmationDialogProps) {
  const titleId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancelRef.current();
      if (event.key !== 'Tab') return;
      const buttons = Array.from(document.querySelectorAll<HTMLElement>('[data-confirm-dialog] button'));
      if (buttons.length < 2) return;
      if (event.shiftKey && document.activeElement === buttons[0]) {
        event.preventDefault();
        buttons[buttons.length - 1].focus();
      } else if (!event.shiftKey && document.activeElement === buttons[buttons.length - 1]) {
        event.preventDefault();
        buttons[0].focus();
      }
    };
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', handleKeyDown);
    cancelRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus();
    };
  }, []);

  return createPortal(
    <div className="confirm-overlay" role="presentation" onClick={() => { if (!busy) onCancel(); }}>
      <div
        data-confirm-dialog
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={event => event.stopPropagation()}
      >
        <div className="confirm-dialog-icon"><AlertTriangle size={22} /></div>
        <div className="confirm-dialog-copy">
          <h2 id={titleId}>{title}</h2>
          <p>{message}</p>
        </div>
        <button className="confirm-dialog-close" type="button" aria-label="Đóng xác nhận" disabled={busy} onClick={onCancel}><X size={17} /></button>
        <div className="confirm-dialog-actions">
          <button ref={cancelRef} type="button" className="confirm-dialog-cancel" disabled={busy} onClick={onCancel}>Quay lại</button>
          <button type="button" className="confirm-dialog-submit" disabled={busy} aria-busy={busy} onClick={onConfirm}>{busy ? 'Đang xử lý…' : confirmLabel}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
