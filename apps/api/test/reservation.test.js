import test from 'node:test';
import assert from 'node:assert/strict';
import { canTransitionReservation, normalizeReservation, reservationIntervalsOverlap } from '../src/reservation.js';

const now = new Date('2026-07-15T02:00:00.000Z');

test('chuẩn hóa đặt bàn và lưu thời điểm dưới Date UTC', () => {
  const result = normalizeReservation({
    tableId: 't1', customerName: ' Nguyễn An ', customerPhone: '0901 234 567',
    partySize: 4, reservedAt: '2026-07-15T12:30:00.000Z', durationMinutes: 90, notes: ' Gần cửa sổ ',
  }, { now });
  assert.equal(result.customerName, 'Nguyễn An');
  assert.equal(result.phoneNormalized, '0901234567');
  assert.equal(result.reservedAt.toISOString(), '2026-07-15T12:30:00.000Z');
  assert.equal(result.endsAt.toISOString(), '2026-07-15T14:00:00.000Z');
  assert.equal(result.notes, 'Gần cửa sổ');
});

test('từ chối số điện thoại, quá khứ và thời lượng không hợp lệ', () => {
  assert.throws(() => normalizeReservation({ tableId: 't1', customerName: 'A', customerPhone: '123', partySize: 2, reservedAt: '2026-07-15T12:30:00Z' }, { now }), /Số điện thoại/);
  assert.throws(() => normalizeReservation({ tableId: 't1', customerName: 'A', customerPhone: '0901234567', partySize: 2, reservedAt: '2026-07-14T12:30:00Z' }, { now }), /quá khứ/);
  assert.throws(() => normalizeReservation({ tableId: 't1', customerName: 'A', customerPhone: '0901234567', partySize: 2, reservedAt: '2026-07-15T12:30:00Z', durationMinutes: 10 }, { now }), /30–480/);
});

test('phát hiện giao khung giờ nhưng cho phép hai lịch chạm biên', () => {
  assert.equal(reservationIntervalsOverlap('2026-07-15T10:00:00Z', 120, '2026-07-15T11:59:00Z', 60), true);
  assert.equal(reservationIntervalsOverlap('2026-07-15T10:00:00Z', 120, '2026-07-15T12:00:00Z', 60), false);
});

test('vòng đời đặt bàn chỉ cho phép chuyển trạng thái hợp lệ', () => {
  assert.equal(canTransitionReservation('booked', 'seated'), true);
  assert.equal(canTransitionReservation('booked', 'cancelled'), true);
  assert.equal(canTransitionReservation('seated', 'completed'), true);
  assert.equal(canTransitionReservation('completed', 'booked'), false);
  assert.equal(canTransitionReservation('cancelled', 'seated'), false);
});
