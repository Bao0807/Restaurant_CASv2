import test from 'node:test';
import assert from 'node:assert/strict';
import { availableKitchenSlots, isKitchenOrderStale } from '../src/kitchenQueue.js';

test('số slot bếp không âm khi đang nấu vượt cấu hình mới', () => {
  assert.equal(availableKitchenSlots(3, 2), 0);
  assert.equal(availableKitchenSlots(1, 3), 2);
});

test('chỉ cảnh báo phiếu sau ETA cộng thời gian gia hạn', () => {
  const startedAt = '2026-07-15T02:00:00.000Z';
  const etaMinutes = 30;
  const graceMinutes = 15;
  assert.equal(
    isKitchenOrderStale(startedAt, etaMinutes, graceMinutes, new Date('2026-07-15T02:44:59.000Z').getTime()),
    false,
  );
  assert.equal(
    isKitchenOrderStale(startedAt, etaMinutes, graceMinutes, new Date('2026-07-15T02:45:00.000Z').getTime()),
    true,
  );
});
