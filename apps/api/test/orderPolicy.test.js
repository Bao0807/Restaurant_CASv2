import test from 'node:test';
import assert from 'node:assert/strict';
import { canCancelOrder, canSettleOrder, summarizeOrderBatches } from '../src/orderPolicy.js';

test('chỉ cho hủy order khi toàn bộ phiếu bếp còn chờ', () => {
  assert.equal(canCancelOrder([{ status: 'waiting' }, { status: 'waiting' }]), true);
  assert.equal(canCancelOrder([{ status: 'waiting' }, { status: 'done' }]), false);
  assert.equal(canCancelOrder([{ status: 'cooking' }]), false);
  assert.equal(canCancelOrder([]), false);
});

test('chỉ cho thanh toán khi toàn bộ phiếu bếp đã xong', () => {
  assert.equal(canSettleOrder([{ status: 'done' }, { status: 'done' }]), true);
  assert.equal(canSettleOrder([{ status: 'done' }, { status: 'waiting' }]), false);
  assert.equal(canSettleOrder([{ status: 'done' }, { status: 'unknown' }]), false);
  assert.equal(canSettleOrder([]), false);
});

test('tóm tắt batch không tin cậy trạng thái ngoài miền dữ liệu', () => {
  assert.deepEqual(
    summarizeOrderBatches([{ status: 'waiting' }, { status: 'cooking' }, { status: 'done' }, { status: 'other' }]),
    { total: 4, waiting: 1, cooking: 1, done: 1, invalid: 1 },
  );
});
