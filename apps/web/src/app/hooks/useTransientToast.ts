import { useCallback, useEffect, useRef, useState } from 'react';

export type ToastTone = 'success' | 'error' | 'info';
export interface ToastMessage { msg: string; type: ToastTone }

/** Một timeout duy nhất cho toast; thông báo cũ không thể đóng nhầm thông báo mới. */
export function useTransientToast(durationMs = 2_800) {
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const timerRef = useRef<number | null>(null);

  const showToast = useCallback((msg: string, type: ToastTone = 'info') => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    setToast({ msg, type });
    timerRef.current = window.setTimeout(() => {
      setToast(null);
      timerRef.current = null;
    }, durationMs);
  }, [durationMs]);

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);

  return { toast, showToast };
}
