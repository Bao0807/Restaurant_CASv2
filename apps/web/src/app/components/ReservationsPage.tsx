import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Ban, CalendarCheck2, CalendarPlus, CheckCircle2, Clock3, LogIn,
  MapPin, Pencil, Phone, RefreshCw, Search, UserX, Users, X,
} from 'lucide-react';
import {
  formatReservationTimeRange,
  RESERVATION_BUFFER_MINUTES,
  type Reservation,
  type ReservationInput,
  type ReservationStatus,
  type Table,
} from '../data';
import {
  createReservation, fetchReservationAvailability, fetchReservations,
  getServerNowMs,
  updateReservation, updateReservationStatus,
} from '../services/api';
import { ConfirmationDialog } from './ConfirmationDialog';
import '../../styles/reservations.css';

type ReservationScope = 'today' | 'week' | 'month' | 'overdue';
type StatusFilter = 'all' | ReservationStatus;

interface ReservationsPageProps {
  tables: Table[];
  onChanged: () => void | Promise<void>;
  onOpenOrder: (reservation: Reservation) => void | Promise<void>;
}

interface ReservationFormState {
  customerName: string;
  customerPhone: string;
  partySize: number;
  date: string;
  time: string;
  endTime: string;
  tableId: string;
  notes: string;
}

const STATUS_META: Record<ReservationStatus, { label: string; className: string }> = {
  booked: { label: 'Đã đặt', className: 'booked' },
  seated: { label: 'Đã nhận bàn', className: 'seated' },
  cancelled: { label: 'Đã hủy', className: 'cancelled' },
  no_show: { label: 'Không đến', className: 'no-show' },
  completed: { label: 'Hoàn tất', className: 'completed' },
};

const SCOPE_LABELS: Array<{ id: ReservationScope; label: string }> = [
  { id: 'today', label: 'Hôm nay' },
  { id: 'week', label: '7 ngày' },
  { id: 'month', label: 'Tháng này' },
];

const STATUS_FILTERS: Array<{ id: StatusFilter; label: string }> = [
  { id: 'all', label: 'Tất cả trạng thái' },
  { id: 'booked', label: 'Đã đặt' },
  { id: 'seated', label: 'Đã nhận bàn' },
  { id: 'completed', label: 'Hoàn tất' },
  { id: 'cancelled', label: 'Đã hủy' },
  { id: 'no_show', label: 'Không đến' },
];

const RESERVATION_TIME_SLOTS = Array.from({ length: 24 * 4 }, (_, index) => {
  const hours = Math.floor(index / 4);
  const minutes = (index % 4) * 15;
  const value = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  return { value, label: value };
});

function isQuarterHour(value: string): boolean {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  return Boolean(match && Number(match[2]) % 15 === 0);
}

function localDateValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function localTimeValue(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function defaultStart(): Date {
  const date = new Date(getServerNowMs() + 60 * 60_000);
  date.setMinutes(Math.ceil(date.getMinutes() / 15) * 15, 0, 0);
  return date;
}

function rangeForScope(scope: ReservationScope): { from: Date; to: Date; label: string } {
  const from = new Date(getServerNowMs());
  from.setHours(0, 0, 0, 0);
  const to = new Date(from);
  if (scope === 'overdue') {
    from.setTime(0);
    to.setTime(getServerNowMs());
  } else if (scope === 'month') {
    from.setDate(1);
    to.setTime(from.getTime());
    to.setMonth(to.getMonth() + 1);
  } else {
    to.setDate(to.getDate() + (scope === 'today' ? 1 : 7));
  }
  if (scope === 'overdue') return { from, to, label: 'Lịch đã quá giờ nhưng chưa đóng' };
  const inclusiveTo = new Date(to);
  inclusiveTo.setDate(inclusiveTo.getDate() - 1);
  const short = (date: Date) => date.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' });
  return { from, to, label: scope === 'today' ? short(from) : `${short(from)} – ${short(inclusiveTo)}` };
}

function initialForm(tables: Table[], reservation?: Reservation): ReservationFormState {
  const start = reservation ? new Date(reservation.reservedAt) : defaultStart();
  const end = reservation ? new Date(reservation.endsAt) : new Date(start.getTime() + 120 * 60_000);
  const firstTable = [...tables].sort((left, right) => left.number - right.number)[0];
  return {
    customerName: reservation?.customerName ?? '',
    customerPhone: reservation?.customerPhone ?? '',
    partySize: reservation?.partySize ?? 2,
    date: localDateValue(start),
    time: localTimeValue(start),
    endTime: localTimeValue(end),
    tableId: reservation?.tableId ?? firstTable?.id ?? '',
    notes: (reservation?.notes ?? '').slice(0, 500),
  };
}

function reservationWindow(form: Pick<ReservationFormState, 'date' | 'time' | 'endTime'>): {
  start: Date;
  end: Date;
  durationMinutes: number;
  crossesMidnight: boolean;
} | null {
  if (!form.date || !form.time || !form.endTime) return null;
  const start = new Date(`${form.date}T${form.time}:00`);
  const end = new Date(`${form.date}T${form.endTime}:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  let crossesMidnight = false;
  if (end <= start) {
    end.setDate(end.getDate() + 1);
    crossesMidnight = true;
  }
  const durationMinutes = (end.getTime() - start.getTime()) / 60_000;
  if (!Number.isSafeInteger(durationMinutes)) return null;
  return { start, end, durationMinutes, crossesMidnight };
}

function moveReservationStart(
  current: ReservationFormState,
  date: string,
  time: string,
): ReservationFormState {
  const currentWindow = reservationWindow(current);
  const durationMinutes = currentWindow?.durationMinutes && currentWindow.durationMinutes <= 480
    ? currentWindow.durationMinutes
    : 120;
  const nextStart = new Date(`${date}T${time}:00`);
  if (Number.isNaN(nextStart.getTime())) return { ...current, date, time };
  const nextEnd = new Date(nextStart.getTime() + durationMinutes * 60_000);
  return { ...current, date, time, endTime: localTimeValue(nextEnd) };
}

function formatReservationDate(value: string): string {
  return new Date(value).toLocaleDateString('vi-VN', {
    weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric',
  });
}

function replaceReservation(rows: Reservation[], replacement: Reservation): Reservation[] {
  const exists = rows.some(row => row.id === replacement.id);
  const next = exists ? rows.map(row => row.id === replacement.id ? replacement : row) : [replacement, ...rows];
  return next.sort((left, right) => new Date(left.reservedAt).getTime() - new Date(right.reservedAt).getTime());
}

export function ReservationsPage({ tables, onChanged, onOpenOrder }: ReservationsPageProps) {
  const [scope, setScope] = useState<ReservationScope>('week');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Reservation | 'new' | null>(null);
  const [form, setForm] = useState<ReservationFormState>(() => initialForm(tables));
  const [formError, setFormError] = useState<string | null>(null);
  const [availableTableIds, setAvailableTableIds] = useState<Set<string> | null>(null);
  const [availabilityLoading, setAvailabilityLoading] = useState(false);
  const [availabilityError, setAvailabilityError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [actionId, setActionId] = useState<number | null>(null);
  const [transition, setTransition] = useState<{ reservation: Reservation; status: ReservationStatus } | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const firstFieldRef = useRef<HTMLInputElement>(null);
  const editorReturnFocusRef = useRef<HTMLElement | null>(null);
  const savingRef = useRef(false);
  const range = useMemo(() => rangeForScope(scope), [scope]);

  useEffect(() => { savingRef.current = saving; }, [saving]);

  const loadReservations = useCallback(async (showLoader = false) => {
    if (showLoader) setLoading(true);
    try {
      const rows = await fetchReservations({
        from: range.from,
        to: range.to,
        ...(scope === 'overdue' ? { status: 'booked' as const } : {}),
      });
      setReservations(rows);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Không thể tải lịch đặt bàn.');
    } finally {
      if (showLoader) setLoading(false);
    }
  }, [range, scope]);

  useEffect(() => {
    void loadReservations(true);
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void loadReservations(false);
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [loadReservations]);

  useEffect(() => {
    if (!editing) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const timer = window.setTimeout(() => firstFieldRef.current?.focus(), 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !savingRef.current) setEditing(null);
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)',
      ));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      editorReturnFocusRef.current?.focus();
    };
  }, [editing]);

  useEffect(() => {
    const bookingWindow = reservationWindow({
      date: form.date,
      time: form.time,
      endTime: form.endTime,
    });
    if (
      editing !== 'new' || !bookingWindow || form.partySize < 1
      || bookingWindow.durationMinutes < 30 || bookingWindow.durationMinutes > 480
    ) {
      setAvailableTableIds(null);
      setAvailabilityLoading(false);
      setAvailabilityError(null);
      return undefined;
    }
    let active = true;
    setAvailabilityLoading(true);
    setAvailabilityError(null);
    const timer = window.setTimeout(() => {
      fetchReservationAvailability(bookingWindow.start, bookingWindow.durationMinutes, form.partySize)
        .then(rows => { if (active) setAvailableTableIds(new Set(rows.map(row => row.id))); })
        .catch(() => {
          if (!active) return;
          setAvailableTableIds(null);
          setAvailabilityError('Chưa kiểm tra được lịch trống. Vui lòng thử lại trước khi lưu.');
        })
        .finally(() => { if (active) setAvailabilityLoading(false); });
    }, 250);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [editing, form.date, form.endTime, form.partySize, form.time]);

  const normalizedSearch = search.trim().toLocaleLowerCase('vi-VN');
  const visibleReservations = useMemo(() => reservations.filter(reservation => {
    if (scope === 'overdue' && (
      reservation.status !== 'booked'
      || new Date(reservation.endsAt).getTime() > getServerNowMs()
    )) return false;
    if (statusFilter !== 'all' && reservation.status !== statusFilter) return false;
    if (!normalizedSearch) return true;
    return [reservation.code, reservation.customerName, reservation.customerPhone, `bàn ${reservation.tableNumber}`]
      .some(value => value.toLocaleLowerCase('vi-VN').includes(normalizedSearch));
  }), [normalizedSearch, reservations, scope, statusFilter]);

  const eligibleTables = useMemo(() => [...tables]
    .sort((left, right) => left.number - right.number), [tables]);

  const localConflict = useMemo(() => {
    const bookingWindow = reservationWindow({
      date: form.date,
      time: form.time,
      endTime: form.endTime,
    });
    if (!bookingWindow || !form.tableId) return null;
    const bufferMs = RESERVATION_BUFFER_MINUTES * 60_000;
    return reservations.find(row => (
      row.id !== (editing === 'new' || !editing ? -1 : editing.id)
      && row.tableId === form.tableId
      && (row.status === 'booked' || row.status === 'seated')
      && bookingWindow.start.getTime() < new Date(row.endsAt).getTime() + bufferMs
      && new Date(row.reservedAt).getTime() < bookingWindow.end.getTime() + bufferMs
    )) ?? null;
  }, [editing, form.date, form.endTime, form.tableId, form.time, reservations]);

  const openEditor = (reservation?: Reservation) => {
    editorReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setForm(initialForm(tables, reservation));
    setFormError(null);
    setAvailableTableIds(null);
    setAvailabilityError(null);
    setEditing(reservation ?? 'new');
  };

  const buildInput = (): ReservationInput | null => {
    const customerName = form.customerName.trim();
    const customerPhone = form.customerPhone.trim();
    if (!customerName) { setFormError('Vui lòng nhập tên khách.'); return null; }
    if (!customerPhone) { setFormError('Vui lòng nhập số điện thoại.'); return null; }
    if (!form.tableId) { setFormError('Vui lòng chọn bàn.'); return null; }
    const table = tables.find(row => row.id === form.tableId);
    if (!table) { setFormError('Bàn đã chọn không còn tồn tại.'); return null; }
    const bookingWindow = reservationWindow(form);
    if (!bookingWindow) {
      setFormError('Giờ bắt đầu hoặc giờ kết thúc không hợp lệ.');
      return null;
    }
    if (!isQuarterHour(form.time) || !isQuarterHour(form.endTime)) {
      setFormError('Giờ đặt bàn phải theo mốc 15 phút, ví dụ 13:15, 13:30 hoặc 13:45.');
      return null;
    }
    if (bookingWindow.durationMinutes < 30 || bookingWindow.durationMinutes > 480) {
      setFormError('Khung giờ phải kéo dài từ 30 phút đến tối đa 8 giờ.');
      return null;
    }
    if (form.partySize < 1 || form.partySize > table.seats) {
      setFormError(`Bàn ${table.number} chỉ phù hợp tối đa ${table.seats} khách.`);
      return null;
    }
    if (editing === 'new' && availableTableIds !== null && !availableTableIds.has(table.id)) {
      setFormError(`Bàn ${table.number} đã có lịch giao nhau trong khung giờ này.`);
      return null;
    }
    if (editing === 'new' && bookingWindow.start.getTime() < getServerNowMs() - 60_000) {
      setFormError('Thời gian đặt bàn phải ở hiện tại hoặc tương lai.');
      return null;
    }
    if (localConflict) {
      setFormError(`Khung giờ này trùng hoặc cách lịch ${localConflict.code} dưới ${RESERVATION_BUFFER_MINUTES} phút.`);
      return null;
    }
    return {
      tableId: form.tableId,
      customerName,
      customerPhone,
      partySize: form.partySize,
      reservedAt: bookingWindow.start.toISOString(),
      durationMinutes: bookingWindow.durationMinutes,
      notes: form.notes.trim(),
    };
  };

  const submit = async () => {
    const input = buildInput();
    if (!input || !editing || saving) return;
    setSaving(true);
    setFormError(null);
    try {
      const saved = editing === 'new'
        ? await createReservation(input)
        : await updateReservation(editing.id, input, editing.version);
      setReservations(rows => replaceReservation(rows, saved));
      setLoadError(null);
      setEditing(null);
      await onChanged();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Không thể lưu lịch đặt bàn.');
      await loadReservations(false);
    } finally {
      setSaving(false);
    }
  };

  const performTransition = async () => {
    if (!transition || actionId !== null) return;
    const { reservation, status } = transition;
    setTransition(null);
    setActionId(reservation.id);
    try {
      const saved = await updateReservationStatus(reservation.id, status, reservation.version);
      setReservations(rows => replaceReservation(rows, saved));
      setLoadError(null);
      await onChanged();
      if (status === 'seated') await onOpenOrder(saved);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Không thể cập nhật trạng thái đặt bàn.');
      await loadReservations(false);
    } finally {
      setActionId(null);
    }
  };

  const openExistingOrder = async (reservation: Reservation) => {
    if (actionId !== null) return;
    setActionId(reservation.id);
    try {
      await onOpenOrder(reservation);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Không thể mở gọi món cho bàn này.');
      setActionId(null);
    }
  };

  const transitionCopy = transition ? ({
    seated: {
      title: 'Xác nhận khách đã đến?',
      message: `Bàn ${transition.reservation.tableNumber} sẽ được nhận cho ${transition.reservation.customerName} và mở ngay phần gọi món.`,
      label: 'Nhận bàn và gọi món',
    },
    cancelled: {
      title: 'Hủy lịch đặt bàn?',
      message: `Lịch ${transition.reservation.code} sẽ chuyển sang trạng thái đã hủy và giải phóng khung giờ.`,
      label: 'Xác nhận hủy',
    },
    no_show: {
      title: 'Đánh dấu khách không đến?',
      message: `Lịch ${transition.reservation.code} sẽ đóng và giải phóng khung giờ của bàn ${transition.reservation.tableNumber}.`,
      label: 'Khách không đến',
    },
    completed: {
      title: 'Hoàn tất lượt đặt bàn?',
      message: `Lịch ${transition.reservation.code} sẽ được lưu vào lịch sử hoàn tất.`,
      label: 'Hoàn tất',
    },
    booked: { title: '', message: '', label: '' },
  } satisfies Record<ReservationStatus, { title: string; message: string; label: string }>)[transition.status] : null;
  const formTimeWindow = reservationWindow(form);

  return (
    <div className="reservations-page">
      <h1 className="sr-only">Đặt bàn trước</h1>

      <section className="reservation-toolbar" aria-label="Lọc lịch đặt bàn">
        <button className="reservation-primary-button reservation-toolbar-create" type="button" onClick={() => openEditor()}>
          <CalendarPlus size={18} /> Tạo lịch
        </button>
        <div className="reservation-scope-selector" role="group" aria-label="Chọn khoảng thời gian">
          {SCOPE_LABELS.map(option => (
            <button key={option.id} type="button" className={scope === option.id ? 'active' : ''} aria-pressed={scope === option.id} onClick={() => setScope(option.id)}>
              {option.label}
            </button>
          ))}
        </div>
        <span className="reservation-range-label"><Clock3 size={15} /> {range.label}</span>
        <label className="reservation-search">
          <Search size={17} aria-hidden="true" />
          <span className="sr-only">Tìm lịch đặt bàn</span>
          <input value={search} onChange={event => setSearch(event.target.value)} placeholder="Mã lịch, tên, SĐT hoặc bàn" />
        </label>
        <select className="reservation-status-filter" aria-label="Lọc trạng thái" value={statusFilter} onChange={event => setStatusFilter(event.target.value as StatusFilter)}>
          {STATUS_FILTERS.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
        </select>
        <button
          className={`reservation-overdue-button${scope === 'overdue' ? ' active' : ''}`}
          type="button"
          aria-pressed={scope === 'overdue'}
          onClick={() => setScope(currentScope => currentScope === 'overdue' ? 'week' : 'overdue')}
        >
          <UserX size={16} />
          <span>Cần xử lý</span>
        </button>
        <button className="reservation-refresh-button" type="button" aria-label="Làm mới lịch đặt bàn" title="Làm mới" disabled={loading} onClick={() => void loadReservations(true)}>
          <RefreshCw size={17} className={loading ? 'spin' : ''} />
        </button>
      </section>

      {loadError && <div className="reservation-alert" role="alert">{loadError}</div>}

      <section className="reservation-list" aria-busy={loading} aria-label="Danh sách đặt bàn">
        {loading && reservations.length === 0 && <div className="reservation-empty" role="status"><RefreshCw size={24} className="spin" /><strong>Đang tải lịch đặt bàn…</strong></div>}
        {!loading && visibleReservations.length === 0 && (
          <div className="reservation-empty">
            <CalendarCheck2 size={34} />
            <strong>Không có lịch phù hợp</strong>
            <span>Đổi khoảng thời gian hoặc bộ lọc để xem lịch khác.</span>
          </div>
        )}
        {visibleReservations.map(reservation => {
          const meta = STATUS_META[reservation.status];
          const busy = actionId === reservation.id;
          const anotherActionBusy = actionId !== null && !busy;
          const now = getServerNowMs();
          const reservedAt = new Date(reservation.reservedAt).getTime();
          const canCheckIn = now >= reservedAt - 60 * 60_000 && now < new Date(reservation.endsAt).getTime();
          const canMarkNoShow = now >= reservedAt + 15 * 60_000;
          const overdue = reservation.status === 'booked' && now >= new Date(reservation.endsAt).getTime();
          const linkedTable = tables.find(table => table.id === reservation.tableId);
          const hasActiveOrder = Boolean(linkedTable?.orderNumber);
          const isPaid = Boolean(linkedTable?.isPaid);
          return (
            <article className={`reservation-card status-${meta.className}${overdue ? ' is-overdue' : ''}`} key={reservation.id}>
              <div className="reservation-card-time">
                <strong>{formatReservationTimeRange(reservation.reservedAt, reservation.endsAt)}</strong>
                <span>{formatReservationDate(reservation.reservedAt)}</span>
                <small>Giữ bàn {reservation.durationMinutes} phút</small>
              </div>
              <div className="reservation-card-main">
                <div className="reservation-card-title">
                  <div>
                    <span className="reservation-code">{reservation.code}</span>
                    <h2>{reservation.customerName}</h2>
                  </div>
                  <span className={`reservation-status ${meta.className}`}>{meta.label}</span>
                  {overdue && <span className="reservation-status no-show">Quá giờ · cần xử lý</span>}
                </div>
                <div className="reservation-details">
                  <span><MapPin size={15} /> Bàn {reservation.tableNumber}</span>
                  <span><Users size={15} /> {reservation.partySize} khách</span>
                  <a href={`tel:${reservation.customerPhone}`}><Phone size={15} /> {reservation.customerPhone}</a>
                </div>
                {reservation.notes && <p className="reservation-notes">{reservation.notes}</p>}
                <div className="reservation-card-actions">
                  {reservation.status === 'booked' && (
                    <>
                      {!overdue && <button type="button" className="reservation-action edit" disabled={busy || anotherActionBusy} onClick={() => openEditor(reservation)}><Pencil size={16} /> Sửa</button>}
                      <button type="button" className="reservation-action check-in" disabled={busy || anotherActionBusy || !canCheckIn} title={canCheckIn ? 'Nhận bàn và mở gọi món' : 'Có thể nhận bàn sớm tối đa 60 phút'} onClick={() => setTransition({ reservation, status: 'seated' })}><LogIn size={16} /> Nhận bàn</button>
                      <button type="button" className="reservation-action subtle-danger" disabled={busy || anotherActionBusy} onClick={() => setTransition({ reservation, status: 'cancelled' })}><Ban size={16} /> Hủy</button>
                      <button type="button" className="reservation-action subtle-danger" disabled={busy || anotherActionBusy || !canMarkNoShow} title={canMarkNoShow ? 'Đóng lịch do khách không đến' : 'Chỉ đánh dấu sau giờ hẹn 15 phút'} onClick={() => setTransition({ reservation, status: 'no_show' })}><UserX size={16} /> Không đến</button>
                    </>
                  )}
                  {reservation.status === 'seated' && (
                    <>
                      {!isPaid && (
                        <button type="button" className="reservation-action check-in" disabled={busy || anotherActionBusy || !reservation.tableId} onClick={() => void openExistingOrder(reservation)}><LogIn size={16} /> Mở gọi món</button>
                      )}
                      <button
                        type="button"
                        className="reservation-action complete"
                        disabled={busy || anotherActionBusy || hasActiveOrder}
                        title={isPaid
                          ? 'Chờ món hoàn tất và xác nhận khách rời tại bàn'
                          : hasActiveOrder ? 'Thanh toán trước khi hoàn tất lượt phục vụ' : 'Hoàn tất lượt đặt bàn'}
                        onClick={() => setTransition({ reservation, status: 'completed' })}
                      >
                        <CheckCircle2 size={16} /> {isPaid ? (linkedTable?.status === 'served' ? 'Chờ khách rời' : 'Đã thanh toán') : hasActiveOrder ? 'Chờ thanh toán' : 'Hoàn tất'}
                      </button>
                    </>
                  )}
                  {busy && <span className="reservation-action-progress" role="status">Đang cập nhật…</span>}
                </div>
              </div>
            </article>
          );
        })}
      </section>

      {editing && createPortal(
        <div className="reservation-dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !saving) setEditing(null); }}>
          <div ref={dialogRef} className="reservation-dialog" role="dialog" aria-modal="true" aria-labelledby="reservation-dialog-title">
            <header>
              <div>
                <span>{editing === 'new' ? 'Lịch đặt bàn mới' : editing.code}</span>
                <h2 id="reservation-dialog-title">{editing === 'new' ? 'Thêm đặt bàn' : 'Cập nhật đặt bàn'}</h2>
              </div>
              <button type="button" aria-label="Đóng biểu mẫu đặt bàn" disabled={saving} onClick={() => setEditing(null)}><X size={20} /></button>
            </header>
            <div className="reservation-form-scroll">
              {formError && <div className="reservation-form-error" role="alert">{formError}</div>}
              <div className="reservation-form-grid">
                <label className="wide">Tên khách *<input ref={firstFieldRef} value={form.customerName} maxLength={120} autoComplete="name" onChange={event => setForm(current => ({ ...current, customerName: event.target.value }))} placeholder="Nguyễn Văn A" /></label>
                <label>Số điện thoại *<input type="tel" value={form.customerPhone} maxLength={32} autoComplete="tel" onChange={event => setForm(current => ({ ...current, customerPhone: event.target.value }))} placeholder="0901 234 567" /></label>
                <label>Số khách *<input type="number" min={1} max={100} value={form.partySize} onChange={event => setForm(current => ({ ...current, partySize: Number(event.target.value) }))} /></label>
                <label>Ngày *<input type="date" min={editing === 'new' ? localDateValue(new Date(getServerNowMs())) : undefined} value={form.date} onChange={event => setForm(current => moveReservationStart(current, event.target.value, current.time))} /></label>
                <label>Từ giờ *
                  <select value={form.time} onChange={event => setForm(current => moveReservationStart(current, current.date, event.target.value))}>
                    {!isQuarterHour(form.time) && <option value={form.time} disabled>{form.time} · giờ cũ, hãy chọn lại</option>}
                    {RESERVATION_TIME_SLOTS.map(slot => <option key={slot.value} value={slot.value}>{slot.label}</option>)}
                  </select>
                </label>
                <label>Đến giờ *
                  <select value={form.endTime} onChange={event => setForm(current => ({ ...current, endTime: event.target.value }))}>
                    {!isQuarterHour(form.endTime) && <option value={form.endTime} disabled>{form.endTime} · giờ cũ, hãy chọn lại</option>}
                    {RESERVATION_TIME_SLOTS.map(slot => <option key={slot.value} value={slot.value}>{slot.label}</option>)}
                  </select>
                </label>
                <label>Bàn *{availabilityLoading && <small className="availability-label">Đang kiểm tra lịch trống…</small>}<select value={form.tableId} onChange={event => setForm(current => ({ ...current, tableId: event.target.value }))}>
                  <option value="">Chọn bàn phù hợp</option>
                  {eligibleTables.map(table => {
                    const lacksSeats = table.seats < form.partySize;
                    const unavailable = editing === 'new' && availableTableIds !== null && !availableTableIds.has(table.id);
                    return <option key={table.id} value={table.id} disabled={lacksSeats || unavailable}>Bàn {table.number} · {table.seats} chỗ{lacksSeats ? ' · không đủ chỗ' : unavailable ? ` · trùng/sát lịch ${RESERVATION_BUFFER_MINUTES} phút` : ''}</option>;
                  })}
                </select></label>
                <div className="reservation-window-hint wide" role="note">
                  <Clock3 size={15} aria-hidden="true" />
                  <span>
                    {formTimeWindow && formTimeWindow.durationMinutes >= 30 && formTimeWindow.durationMinutes <= 480
                      ? `Khung ${formTimeWindow.durationMinutes} phút${formTimeWindow.crossesMidnight ? ' · kết thúc ngày kế tiếp' : ''}`
                      : 'Khung giờ phải từ 30 phút đến tối đa 8 giờ'}
                    {' · '}Giờ chọn theo từng mốc 15 phút · Cần cách lịch liền kề ít nhất {RESERVATION_BUFFER_MINUTES} phút.
                  </span>
                </div>
                <label className="wide">Ghi chú<textarea rows={3} maxLength={500} value={form.notes} onChange={event => setForm(current => ({ ...current, notes: event.target.value }))} placeholder="Vị trí mong muốn, dị ứng, sinh nhật…" /></label>
              </div>
              {localConflict && (
                <div className="reservation-conflict">
                  <Clock3 size={16} />
                  Khung giờ trùng hoặc cách lịch {localConflict.code} của {localConflict.customerName} dưới {RESERVATION_BUFFER_MINUTES} phút.
                </div>
              )}
              {availabilityError && <div className="reservation-form-error" role="alert">{availabilityError}</div>}
            </div>
            <footer>
              <button type="button" className="reservation-dialog-cancel" disabled={saving} onClick={() => setEditing(null)}>Đóng</button>
              <button type="button" className="reservation-primary-button" disabled={saving || Boolean(localConflict) || Boolean(availabilityError) || availabilityLoading} onClick={() => void submit()}>
                {saving ? <><RefreshCw size={17} className="spin" /> Đang lưu…</> : editing === 'new' ? <><CalendarPlus size={17} /> Tạo lịch</> : <><CheckCircle2 size={17} /> Lưu thay đổi</>}
              </button>
            </footer>
          </div>
        </div>,
        document.body,
      )}

      {transition && transitionCopy && (
        <ConfirmationDialog
          title={transitionCopy.title}
          message={transitionCopy.message}
          confirmLabel={transitionCopy.label}
          onCancel={() => setTransition(null)}
          onConfirm={() => void performTransition()}
        />
      )}
    </div>
  );
}
