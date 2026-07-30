export const RESERVATION_STATUSES = new Set(['booked', 'seated', 'cancelled', 'no_show', 'completed']);
export const RESERVATION_BUFFER_MINUTES = 15;
export const RESERVATION_TIME_STEP_MINUTES = 15;

const PHONE_PATTERN = /^[0-9+().\s-]+$/;
const MAX_BOOKING_HORIZON_MS = 730 * 24 * 60 * 60 * 1000;

function invalid(message, field) {
  const error = new Error(message);
  error.status = 400;
  error.code = 'VALIDATION_ERROR';
  error.field = field;
  return error;
}

function requiredString(value, field, maxLength) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    throw invalid(`${field} không hợp lệ`, field);
  }
  return value.trim();
}

/** Chuẩn hóa payload đặt bàn tại ranh giới API; mọi thời điểm được lưu dưới UTC. */
export function normalizeReservation(input, { now = new Date(), allowPast = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw invalid('Thông tin đặt bàn không hợp lệ.', 'reservation');
  }

  const tableId = requiredString(input.tableId, 'tableId', 32);
  const customerName = requiredString(input.customerName, 'customerName', 120);
  const customerPhone = requiredString(input.customerPhone, 'customerPhone', 32);
  const phoneDigits = customerPhone.replace(/\D/g, '');
  if (!PHONE_PATTERN.test(customerPhone) || phoneDigits.length < 8 || phoneDigits.length > 15) {
    throw invalid('Số điện thoại phải có từ 8 đến 15 chữ số.', 'customerPhone');
  }

  const partySize = Number(input.partySize);
  if (!Number.isSafeInteger(partySize) || partySize < 1 || partySize > 100) {
    throw invalid('Số khách phải nằm trong khoảng 1–100.', 'partySize');
  }

  const reservedAt = new Date(input.reservedAt);
  if (Number.isNaN(reservedAt.getTime())) {
    throw invalid('Ngày giờ đặt bàn không hợp lệ.', 'reservedAt');
  }
  if (
    reservedAt.getUTCMinutes() % RESERVATION_TIME_STEP_MINUTES !== 0
    || reservedAt.getUTCSeconds() !== 0
    || reservedAt.getUTCMilliseconds() !== 0
  ) {
    throw invalid('Giờ đặt bàn phải theo mốc 15 phút (:00, :15, :30 hoặc :45).', 'reservedAt');
  }
  const nowTime = now.getTime();
  if (!allowPast && reservedAt.getTime() < nowTime - 15 * 60_000) {
    throw invalid('Không thể tạo lịch đặt bàn trong quá khứ.', 'reservedAt');
  }
  if (reservedAt.getTime() > nowTime + MAX_BOOKING_HORIZON_MS) {
    throw invalid('Chỉ có thể đặt bàn trước tối đa 24 tháng.', 'reservedAt');
  }

  const durationMinutes = Number(input.durationMinutes ?? 120);
  if (!Number.isSafeInteger(durationMinutes) || durationMinutes < 30 || durationMinutes > 480) {
    throw invalid('Thời lượng giữ bàn phải nằm trong khoảng 30–480 phút.', 'durationMinutes');
  }
  if (durationMinutes % RESERVATION_TIME_STEP_MINUTES !== 0) {
    throw invalid('Giờ kết thúc phải theo mốc 15 phút (:00, :15, :30 hoặc :45).', 'durationMinutes');
  }

  const notes = input.notes == null ? '' : String(input.notes).trim();
  if (notes.length > 500) throw invalid('Ghi chú không được vượt quá 500 ký tự.', 'notes');

  return {
    tableId,
    customerName,
    customerPhone,
    phoneNormalized: phoneDigits,
    partySize,
    reservedAt,
    endsAt: new Date(reservedAt.getTime() + durationMinutes * 60_000),
    durationMinutes,
    notes,
  };
}

/** Kiểm tra hai khung giờ có giao nhau hoặc không đủ khoảng đệm vận hành. */
export function reservationIntervalsOverlap(
  leftStart,
  leftDuration,
  rightStart,
  rightDuration,
  bufferMinutes = RESERVATION_BUFFER_MINUTES,
) {
  const left = new Date(leftStart).getTime();
  const right = new Date(rightStart).getTime();
  const leftEnd = left + Number(leftDuration) * 60_000;
  const rightEnd = right + Number(rightDuration) * 60_000;
  const buffer = Number(bufferMinutes) * 60_000;
  return Number.isFinite(left)
    && Number.isFinite(right)
    && Number.isFinite(buffer)
    && buffer >= 0
    && left < rightEnd + buffer
    && right < leftEnd + buffer;
}

/** Vòng đời đặt bàn có chủ đích; trạng thái kết thúc không được mở lại âm thầm. */
export function canTransitionReservation(currentStatus, nextStatus) {
  if (currentStatus === 'booked') return ['seated', 'cancelled', 'no_show'].includes(nextStatus);
  if (currentStatus === 'seated') return nextStatus === 'completed';
  return false;
}
