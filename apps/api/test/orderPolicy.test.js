import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canCancelOrder,
  canPayOrder,
  isOrderComplete,
  paymentRequiresDepartureConfirmation,
  summarizeOrderBatches,
} from '../src/orderPolicy.js';

test('chỉ cho hủy order khi toàn bộ phiếu bếp còn chờ', () => {
  assert.equal(canCancelOrder([{ status: 'waiting' }, { status: 'waiting' }]), true);
  assert.equal(canCancelOrder([{ status: 'waiting' }, { status: 'done' }]), false);
  assert.equal(canCancelOrder([{ status: 'cooking' }]), false);
  assert.equal(canCancelOrder([]), false);
});

test('cho thanh toán trước khi bếp hoàn tất nhưng từ chối batch không hợp lệ', () => {
  assert.equal(canPayOrder([{ status: 'waiting' }]), true);
  assert.equal(canPayOrder([{ status: 'cooking' }, { status: 'done' }]), true);
  assert.equal(canPayOrder([{ status: 'done' }, { status: 'unknown' }]), false);
  assert.equal(canPayOrder([]), false);
});

test('chỉ đóng order khi toàn bộ phiếu bếp đã xong', () => {
  assert.equal(isOrderComplete([{ status: 'done' }, { status: 'done' }]), true);
  assert.equal(isOrderComplete([{ status: 'done' }, { status: 'waiting' }]), false);
  assert.equal(isOrderComplete([{ status: 'cooking' }]), false);
  assert.equal(isOrderComplete([{ status: 'done' }, { status: 'unknown' }]), false);
  assert.equal(isOrderComplete([]), false);
});

test('giữ bàn theo đúng thời điểm nhân viên bắt đầu thanh toán sớm', () => {
  assert.equal(paymentRequiresDepartureConfirmation([{ status: 'waiting' }]), true);
  assert.equal(paymentRequiresDepartureConfirmation([{ status: 'cooking' }]), true);
  assert.equal(paymentRequiresDepartureConfirmation([{ status: 'done' }]), false);
  assert.equal(paymentRequiresDepartureConfirmation([{ status: 'done' }], true), true);
});

test('tóm tắt batch không tin cậy trạng thái ngoài miền dữ liệu', () => {
  assert.deepEqual(
    summarizeOrderBatches([{ status: 'waiting' }, { status: 'cooking' }, { status: 'done' }, { status: 'other' }]),
    { total: 4, waiting: 1, cooking: 1, done: 1, invalid: 1 },
  );
});
