import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canCancelOrder,
  canPayOrder,
  isSameOrderSubmission,
  isOrderComplete,
  paymentRequiresDepartureConfirmation,
  summarizeOrderBatches,
} from '../src/orderPolicy.js';

const submittedItem = (overrides = {}) => ({
  cartId: 'cart-1',
  menuItem: { id: 'm1', name: 'Tên phía client', price: 1 },
  quantity: 2,
  selectedSize: { label: 'Vừa', extraPrice: 1 },
  selectedToppings: [{ id: 't2', label: 'Client 2', price: 1 }, { id: 't1', label: 'Client 1', price: 1 }],
  note: 'Ít cay',
  ...overrides,
});

test('nhận diện request tạo order gửi lại dù snapshot giá và thứ tự topping khác nhau', () => {
  const persisted = submittedItem({
    menuItem: { id: 'm1', name: 'Tên chuẩn', price: 65_000, cookMinutes: 12 },
    selectedSize: { label: 'Vừa', extraPrice: 10_000 },
    selectedToppings: [{ id: 't1', label: 'Chuẩn 1', price: 5_000 }, { id: 't2', label: 'Chuẩn 2', price: 8_000 }],
  });
  assert.equal(isSameOrderSubmission([submittedItem()], [persisted]), true);
});

test('không coi request đổi món, số lượng hoặc ghi chú là retry idempotent', () => {
  const persisted = [submittedItem()];
  assert.equal(isSameOrderSubmission([submittedItem({ quantity: 3 })], persisted), false);
  assert.equal(isSameOrderSubmission([submittedItem({ menuItem: { id: 'm2' } })], persisted), false);
  assert.equal(isSameOrderSubmission([submittedItem({ note: 'Không cay' })], persisted), false);
  assert.equal(isSameOrderSubmission([], persisted), false);
});

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
