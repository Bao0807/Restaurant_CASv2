import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultSettings } from '../src/defaultSettings.js';
import { calculateTotals, createPayment, sanitizeSettings, validateOrderItems } from '../src/domain.js';
import { availableKitchenSlots } from '../src/kitchenQueue.js';
import { estimateCookMinutes, normalizeMenuItem } from '../src/catalog.js';

const rawItems = [{
  cartId: 'cart-1',
  menuItem: {
    id: 'pho-bo',
    name: 'Phở bò',
    description: 'Phở',
    price: 80_000,
    image: '',
    categoryId: 'pho-bun',
    available: true,
  },
  quantity: 2,
  selectedSize: { label: 'Lớn', extraPrice: 10_000 },
  selectedToppings: [{ id: 'trung', label: 'Trứng', price: 8_000 }],
  note: 'Ít hành',
}];

test('chuẩn hóa order và tính tổng từ dữ liệu order phía server', () => {
  const items = validateOrderItems(rawItems);
  const settings = sanitizeSettings({
    ...defaultSettings,
    discountAmount: 10_000,
    serviceFeeRate: 0.05,
    vatRate: 0.1,
  }, defaultSettings);
  const totals = calculateTotals(items, settings);

  assert.deepEqual(totals, {
    subtotal: 196_000,
    discount: 10_000,
    serviceFee: 9_300,
    vat: 19_530,
    total: 214_830,
  });
});

test('payment bỏ qua tổng tiền giả từ client và dùng thời gian server', () => {
  const items = validateOrderItems(rawItems);
  const paidAt = new Date('2026-07-11T10:00:00.000Z');
  const payment = createPayment({
    draft: {
      invoiceCode: 'CAS-260711-ABCDEF1234',
      transactionCode: 'CASH-260711-ABCDEF1234',
      method: 'cash',
      total: -1,
    },
    items,
    settings: defaultSettings,
    table: { id: 't1', number: 1 },
    paidAt,
  });

  assert.equal(payment.subtotal, 196_000);
  assert.equal(payment.total, 226_380);
  assert.equal(payment.paidAt, paidAt.toISOString());
});

test('từ chối quantity và VAT ngoài giới hạn', () => {
  assert.throws(
    () => validateOrderItems([{ ...rawItems[0], quantity: 0 }]),
    error => error.code === 'VALIDATION_ERROR' && error.field === 'items.0.quantity',
  );
  assert.throws(
    () => sanitizeSettings({ ...defaultSettings, vatRate: 2 }, defaultSettings),
    error => error.code === 'VALIDATION_ERROR' && error.field === 'vatRate',
  );
});

test('kitchen queue chỉ lấy số order bằng số slot còn trống', () => {
  assert.equal(availableKitchenSlots(0, 2), 2);
  assert.equal(availableKitchenSlots(1, 2), 1);
  assert.equal(availableKitchenSlots(2, 2), 0);
  assert.equal(availableKitchenSlots(5, 2), 0);
});

test('ETA nhân thời gian món với số lượng rồi lấy dòng lâu nhất', () => {
  const quick = normalizeMenuItem({
    id: 'drink', name: 'Nước ép', price: 30_000, categoryId: 'drink', cookMinutes: 4,
  });
  const slow = normalizeMenuItem({
    id: 'grill', name: 'Món nướng', price: 120_000, categoryId: 'grill', cookMinutes: 25,
  });
  assert.equal(estimateCookMinutes([
    { menuItem: quick, quantity: 3 },
    { menuItem: slow, quantity: 2 },
  ]), 50);
  assert.throws(
    () => normalizeMenuItem({ id: 'bad', name: 'Lỗi', price: 1, categoryId: 'x', cookMinutes: 0 }),
    error => error.code === 'VALIDATION_ERROR' && error.field === 'cookMinutes',
  );
});
