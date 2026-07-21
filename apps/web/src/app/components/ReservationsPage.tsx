import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Ban, CalendarCheck2, CalendarPlus, CheckCircle2, Clock3, LogIn,
  MapPin, Pencil, Phone, RefreshCw, Search, UserX, Users, X,
} from 'lucide-react';
import type { Reservation, ReservationInput, ReservationStatus, Table } from '../data';
import {
  createReservation, fetchReservationAvailability, fetchReservations,
  getServerNowMs,
  updateReservation, updateReservationStatus,
} from '../services/api';
import { ConfirmationDialog } from './ConfirmationDialog';
import '../../styles/reservations.css';

type ReservationScope = 'today' | 'week' | 'month';
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
  durationMinutes: number;
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
  if (scope === 'month') {
    from.setDate(1);
    to.setTime(from.getTime());
    to.setMonth(to.getMonth() + 1);
  } else {
    to.setDate(to.getDate() + (scope === 'today' ? 1 : 7));
  }
  const inclusiveTo = new Date(to);
  inclusiveTo.setDate(inclusiveTo.getDate() - 1);
  const short = (date: Date) => date.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' });
  return { from, to, label: scope === 'today' ? short(from) : `${short(from)} – ${short(inclusiveTo)}` };
}

function initialForm(tables: Table[], reservation?: Reservation): ReservationFormState {
  const start = reservation ? new Date(reservation.reservedAt) : defaultStart();
  const firstTable = [...tables].sort((left, right) => left.number - right.number)[0];
  return {
    customerName: reservation?.customerName ?? '',
    customerPhone: reservation?.customerPhone ?? '',
    partySize: reservation?.partySize ?? 2,
    date: localDateValue(start),
    time: localTimeValue(start),
    durationMinutes: reservation?.durationMinutes ?? 120,
    tableId: reservation?.tableId ?? firstTable?.id ?? '',
    notes: (reservation?.notes ?? '').slice(0, 500),
  };
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
      const rows = await fetchReservations({ from: range.from, to: range.to });
      setReservations(rows);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Không thể tải lịch đặt bàn.');
    } finally {
      if (showLoader) setLoading(false);
    }
  }, [range.from.getTime(), range.to.getTime()]);

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
    if (
      editing !== 'new' || !form.date || !form.time || form.partySize < 1
      || !Number.isInteger(form.durationMinutes)
      || form.durationMinutes < 30 || form.durationMinutes > 480
    ) {
      setAvailableTableIds(null);
      setAvailabilityLoading(false);
      setAvailabilityError(null);
      return undefined;
    }
    const reservedAt = new Date(`${form.date}T${form.time}:00`);
    if (Number.isNaN(reservedAt.getTime())) return undefined;
    let active = true;
    setAvailabilityLoading(true);
    setAvailabilityError(null);
    const timer = window.setTimeout(() => {
      fetchReservationAvailability(reservedAt, form.durationMinutes, form.partySize)
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
  }, [editing, form.date, form.durationMinutes, form.partySize, form.time]);

  const normalizedSearch = search.trim().toLocaleLowerCase('vi-VN');
  const visibleReservations = useMemo(() => reservations.filter(reservation => {
    if (statusFilter !== 'all' && reservation.status !== statusFilter) return false;
    if (!normalizedSearch) return true;
    return [reservation.code, reservation.customerName, reservation.customerPhone, `bàn ${reservation.tableNumber}`]
      .some(value => value.toLocaleLowerCase('vi-VN').includes(normalizedSearch));
  }), [normalizedSearch, reservations, statusFilter]);

  const serverNow = getServerNowMs();
  const todayKey = localDateValue(new Date(serverNow));
  const stats = useMemo(() => ({
    today: reservations.filter(row => localDateValue(new Date(row.reservedAt)) === todayKey).length,
    upcoming: reservations.filter(row => row.status === 'booked' && new Date(row.endsAt).getTime() >= serverNow).length,
    seated: reservations.filter(row => row.status === 'seated').length,
    attention: reservations.filter(row => row.status === 'cancelled' || row.status === 'no_show').length,
  }), [reservations, serverNow, todayKey]);

  const eligibleTables = useMemo(() => [...tables]
    .sort((left, right) => left.number - right.number), [tables]);

  const localConflict = useMemo(() => {
    if (!form.date || !form.time || !form.tableId) return null;
    const start = new Date(`${form.date}T${form.time}:00`);
    const end = new Date(start.getTime() + form.durationMinutes * 60_000);
    if (Number.isNaN(start.getTime())) return null;
    return reservations.find(row => (
      row.id !== (editing === 'new' || !editing ? -1 : editing.id)
      && row.tableId === form.tableId
      && (row.status === 'booked' || row.status === 'seated')
      && start.getTime() < new Date(row.endsAt).getTime()
      && new Date(row.reservedAt).getTime() < end.getTime()
    )) ?? null;
  }, [editing, form.date, form.durationMinutes, form.tableId, form.time, reservations]);

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
    if (!Number.isInteger(form.durationMinutes) || form.durationMinutes < 30 || form.durationMinutes > 480) {
      setFormError('Thời lượng phải từ 30 đến 480 phút.');
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
    const reservedAt = new Date(`${form.date}T${form.time}:00`);
    if (Number.isNaN(reservedAt.getTime())) { setFormError('Ngày hoặc giờ đặt bàn không hợp lệ.'); return null; }
    if (editing === 'new' && reservedAt.getTime() < getServerNowMs() - 60_000) {
      setFormError('Thời gian đặt bàn phải ở hiện tại hoặc tương lai.');
      return null;
    }
    if (localConflict) {
      setFormError(`Khung giờ này trùng với lịch ${localConflict.code} của ${localConflict.customerName}.`);
      return null;
    }
    return {
      tableId: form.tableId,
      customerName,
      customerPhone,
      partySize: form.partySize,
      reservedAt: reservedAt.toISOString(),
      durationMinutes: form.durationMinutes,
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
      label: 'Check-in và gọi món',
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

  return (
    <div className="reservations-page">
      <header className="reservations-hero">
        <div className="reservations-heading">
          <span className="reservations-heading-icon" aria-hidden="true"><CalendarCheck2 size={25} /></span>
          <div>
            <h1>Đặt bàn trước</h1>
            <p>Quản lý lịch khách, khung giờ và check-in tại một nơi</p>
          </div>
        </div>
        <button className="reservation-primary-button" type="button" onClick={() => openEditor()}>
          <CalendarPlus size={18} /> Tạo lịch mới
        </button>
      </header>

      <section className="reservation-kpi-grid" aria-label="Tổng quan lịch đặt bàn">
        <div><span>Hôm nay</span><strong>{stats.today}</strong><small>lịch trong ngày</small></div>
        <div><span>Sắp tới</span><strong>{stats.upcoming}</strong><small>đang giữ chỗ</small></div>
        <div><span>Đã nhận bàn</span><strong>{stats.seated}</strong><small>đang phục vụ</small></div>
        <div><span>Cần lưu ý</span><strong>{stats.attention}</strong><small>hủy hoặc không đến</small></div>
      </section>

      <section className="reservation-toolbar" aria-label="Lọc lịch đặt bàn">
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
          const linkedTable = tables.find(table => table.id === reservation.tableId);
          const hasActiveOrder = Boolean(linkedTable?.orderNumber);
          const isPaid = Boolean(linkedTable?.isPaid);
          return (
            <article className={`reservation-card status-${meta.className}`} key={reservation.id}>
              <div className="reservation-card-time">
                <strong>{new Date(reservation.reservedAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}</strong>
                <span>{formatReservationDate(reservation.reservedAt)}</span>
                <small>{reservation.durationMinutes} phút</small>
              </div>
              <div className="reservation-card-main">
                <div className="reservation-card-title">
                  <div>
                    <span className="reservation-code">{reservation.code}</span>
                    <h2>{reservation.customerName}</h2>
                  </div>
                  <span className={`reservation-status ${meta.className}`}>{meta.label}</span>
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
                      <button type="button" className="reservation-action edit" disabled={busy || anotherActionBusy} onClick={() => openEditor(reservation)}><Pencil size={16} /> Sửa</button>
                      <button type="button" className="reservation-action check-in" disabled={busy || anotherActionBusy || !canCheckIn} title={canCheckIn ? 'Nhận bàn và mở gọi món' : 'Có thể nhận bàn sớm tối đa 60 phút'} onClick={() => setTransition({ reservation, status: 'seated' })}><LogIn size={16} /> Check-in</button>
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
                        <CheckCircle2 size={16} /> {isPaid ? (linkedTable?.status === 'done' ? 'Chờ khách rời' : 'Đã thanh toán') : hasActiveOrder ? 'Chờ thanh toán' : 'Hoàn tất'}
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
                <label>Ngày *<input type="date" min={editing === 'new' ? localDateValue(new Date(getServerNowMs())) : undefined} value={form.date} onChange={event => setForm(current => ({ ...current, date: event.target.value }))} /></label>
                <label>Giờ *<input type="time" step={900} value={form.time} onChange={event => setForm(current => ({ ...current, time: event.target.value }))} /></label>
                <label>Thời lượng (phút)<input type="number" min={30} max={480} step={15} value={form.durationMinutes} onChange={event => setForm(current => ({ ...current, durationMinutes: Number(event.target.value) }))} /></label>
                <label>Bàn *{availabilityLoading && <small className="availability-label">Đang kiểm tra lịch trống…</small>}<select value={form.tableId} onChange={event => setForm(current => ({ ...current, tableId: event.target.value }))}>
                  <option value="">Chọn bàn phù hợp</option>
                  {eligibleTables.map(table => {
                    const lacksSeats = table.seats < form.partySize;
                    const unavailable = editing === 'new' && availableTableIds !== null && !availableTableIds.has(table.id);
                    return <option key={table.id} value={table.id} disabled={lacksSeats || unavailable}>Bàn {table.number} · {table.seats} chỗ{lacksSeats ? ' · không đủ chỗ' : unavailable ? ' · đã có lịch' : ''}</option>;
                  })}
                </select></label>
                <label className="wide">Ghi chú<textarea rows={3} maxLength={500} value={form.notes} onChange={event => setForm(current => ({ ...current, notes: event.target.value }))} placeholder="Vị trí mong muốn, dị ứng, sinh nhật…" /></label>
              </div>
              {localConflict && <div className="reservation-conflict"><Clock3 size={16} /> Trùng lịch {localConflict.code} · {localConflict.customerName} tại bàn {localConflict.tableNumber}</div>}
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
