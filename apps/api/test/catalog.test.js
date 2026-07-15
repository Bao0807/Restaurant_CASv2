import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalizeOrderItems, estimateCookMinutes, normalizeCategory, normalizeMenuItem } from '../src/catalog.js';
import { completeExpiredKitchenBatches, isKitchenOrderStale, promoteKitchenQueue } from '../src/kitchenQueue.js';

const catalogRow = {
  id: 'm1', name: 'Phở bò', description: 'Món thử', price: 65_000, image: '',
  categoryId: 'pho', cookMinutes: 12, available: 1, isBestseller: 1, isNew: 0,
  sizes: JSON.stringify([{ label: 'Lớn', extraPrice: 10_000 }]),
  toppings: JSON.stringify([{ id: 'egg', label: 'Trứng', price: 8_000 }]),
};

function catalogConnection(rows = [catalogRow]) {
  return {
    async query(sql) {
      assert.match(sql, /FROM menu_items WHERE id IN/);
      return [rows];
    },
  };
}

test('catalog ghi đè giá và tùy chọn giả từ client bằng dữ liệu MySQL', async () => {
  const items = await canonicalizeOrderItems(catalogConnection(), [{
    cartId: 'cart-1', quantity: 3, note: '',
    menuItem: { id: 'm1', price: 1 },
    selectedSize: { label: 'Lớn', extraPrice: 1 },
    selectedToppings: [{ id: 'egg', label: 'Giả', price: 1 }],
  }]);
  assert.equal(items[0].menuItem.price, 65_000);
  assert.equal(items[0].selectedSize.extraPrice, 10_000);
  assert.equal(items[0].selectedToppings[0].price, 8_000);
  assert.equal(estimateCookMinutes(items), 36);
});

test('catalog từ chối món ngừng phục vụ và tùy chọn không tồn tại', async () => {
  await assert.rejects(
    canonicalizeOrderItems(catalogConnection([{ ...catalogRow, available: 0 }]), [{
      cartId: 'x', quantity: 1, note: '', menuItem: { id: 'm1' }, selectedToppings: [],
    }]),
    error => error.code === 'VALIDATION_ERROR',
  );
  await assert.rejects(
    canonicalizeOrderItems(catalogConnection(), [{
      cartId: 'x', quantity: 1, note: '', menuItem: { id: 'm1' },
      selectedToppings: [{ id: 'missing' }],
    }]),
    error => error.field === 'items.0.selectedToppings',
  );
});

test('chuẩn hóa danh mục, món và giới hạn thời gian nấu', () => {
  const category = normalizeCategory({ id: 'nuong', name: 'Nướng', emoji: '🔥', sortOrder: 2 });
  const item = normalizeMenuItem({ id: 'ga', name: 'Gà nướng', price: 100_000, categoryId: category.id, cookMinutes: 30 });
  assert.equal(category.active, true);
  assert.equal(item.cookMinutes, 30);
  assert.throws(
    () => normalizeMenuItem({ id: 'x', name: 'X', price: 1, categoryId: 'x', cookMinutes: 241 }),
    error => error.field === 'cookMinutes',
  );
});

test('phát hiện order bếp quá hạn theo ngưỡng cấu hình', () => {
  const now = Date.parse('2026-07-14T12:00:00.000Z');
  assert.equal(isKitchenOrderStale('2026-07-14T09:59:59.000Z', 120, now), true);
  assert.equal(isKitchenOrderStale('2026-07-14T10:30:00.000Z', 120, now), false);
  assert.equal(isKitchenOrderStale(null, 120, now), false);
});

test('tự hoàn tất mọi batch đã chạy đủ ETA và đồng bộ trạng thái bàn', async () => {
  const calls = [];
  const connection = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('SELECT id AS batchId')) {
        return [[
          { batchId: 21, tableId: 't1' },
          { batchId: 22, tableId: 't2' },
        ]];
      }
      if (sql.includes('UPDATE order_batches')) return [{ affectedRows: 2 }];
      if (sql.includes('UPDATE restaurant_tables')) return [{ affectedRows: 2 }];
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };

  const completed = await completeExpiredKitchenBatches(connection);
  assert.deepEqual(completed.map(batch => batch.batchId), [21, 22]);
  assert.deepEqual(calls[1].params, [21, 22]);
  assert.match(calls[2].sql, /SUM\(status = 'cooking'\)/);
});

test('queue không tự lấy món khi tạm dừng hoặc chuyển sang thủ công', async () => {
  for (const state of [
    { concurrency: 2, automationEnabled: 1, paused: 1 },
    { concurrency: 2, automationEnabled: 0, paused: 0 },
  ]) {
    let calls = 0;
    const connection = { async query() { calls += 1; return [[state]]; } };
    assert.deepEqual(await promoteKitchenQueue(connection), []);
    assert.equal(calls, 1);
  }
});

test('điều phối thủ công có thể lấy order khi chế độ tự động đang tắt', async () => {
  const connection = {
    async query(sql) {
      if (sql.includes('FROM kitchen_queue_state')) return [[{ concurrency: 2, automationEnabled: 0, paused: 0 }]];
      if (sql.includes('COUNT(*)')) return [[{ cookingCount: 0 }]];
      if (sql.includes('SELECT id AS batchId')) return [[]];
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  assert.deepEqual(await promoteKitchenQueue(connection, { force: true, limit: 1 }), []);
});
