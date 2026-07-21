import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aggregateMenuQuantities,
  businessDateFor,
  releaseDailyInventory,
  replaceDailyInventory,
  reserveDailyInventory,
} from '../src/dailyInventory.js';

function item(id, quantity, name = id) {
  return { cartId: `${id}-${quantity}`, menuItem: { id, name }, quantity, selectedToppings: [], note: '' };
}

function inventoryConnection(initialRows) {
  const rows = initialRows.map(row => ({ ...row }));
  const updates = [];
  return {
    rows,
    updates,
    async query(sql, params = []) {
      if (sql.includes('INSERT INTO menu_item_daily_usage')) return [{ affectedRows: 1 }];
      if (sql.includes('FROM menu_item_daily_usage daily_usage')) return [rows];
      if (sql.includes('UPDATE menu_item_daily_usage SET used_quantity')) {
        updates.push(params);
        return [{ affectedRows: 1 }];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
}

test('ngày kinh doanh Asia/Ho_Chi_Minh đổi bucket đúng lúc 00:00 địa phương', () => {
  assert.equal(businessDateFor('2026-07-20T16:59:59.999Z'), '2026-07-20');
  assert.equal(businessDateFor('2026-07-20T17:00:00.000Z'), '2026-07-21');
});

test('gộp mọi dòng size/topping của cùng món trước khi giữ số lượng', () => {
  assert.deepEqual(aggregateMenuQuantities([item('m1', 2), item('m1', 3), item('m2', 1)]), [
    { id: 'm1', name: 'm1', quantity: 5 },
    { id: 'm2', name: 'm2', quantity: 1 },
  ]);
});

test('giữ đúng phần còn lại và cho phép món không giới hạn', async () => {
  const connection = inventoryConnection([
    { menuItemId: 'limited', inventoryDate: '2026-07-21', dailyUsed: 7, dailyLimit: 10, name: 'Món giới hạn' },
    { menuItemId: 'open', inventoryDate: '2026-07-21', dailyUsed: 99, dailyLimit: null, name: 'Món mở' },
  ]);
  await reserveDailyInventory(connection, [item('limited', 1), item('limited', 2), item('open', 5)], '2026-07-21');
  assert.deepEqual(connection.updates, [
    [10, 'limited', '2026-07-21'],
    [104, 'open', '2026-07-21'],
  ]);
});

test('vượt một phần trả conflict và không cập nhật dở dang', async () => {
  const connection = inventoryConnection([
    { menuItemId: 'm1', inventoryDate: '2026-07-21', dailyUsed: 8, dailyLimit: 10, name: 'Phở bò' },
  ]);
  await assert.rejects(
    reserveDailyInventory(connection, [item('m1', 3)], '2026-07-21'),
    error => error.status === 409 && error.code === 'MENU_ITEM_DAILY_LIMIT_EXCEEDED',
  );
  assert.deepEqual(connection.updates, []);
});

test('sửa phiếu cùng ngày chỉ áp dụng chênh lệch, sửa qua ngày chuyển sang bucket mới', async () => {
  const sameDay = inventoryConnection([
    { menuItemId: 'm1', inventoryDate: '2026-07-21', dailyUsed: 5, dailyLimit: 10, name: 'Món 1' },
  ]);
  await replaceDailyInventory(sameDay, [item('m1', 3)], '2026-07-21', [item('m1', 2)], '2026-07-21');
  assert.deepEqual(sameDay.updates, [[4, 'm1', '2026-07-21']]);

  const nextDay = inventoryConnection([
    { menuItemId: 'm1', inventoryDate: '2026-07-20', dailyUsed: 3, dailyLimit: 10, name: 'Món 1' },
    { menuItemId: 'm1', inventoryDate: '2026-07-21', dailyUsed: 1, dailyLimit: 10, name: 'Món 1' },
  ]);
  await replaceDailyInventory(nextDay, [item('m1', 3)], '2026-07-20', [item('m1', 2)], '2026-07-21');
  assert.deepEqual(nextDay.updates, [
    [0, 'm1', '2026-07-20'],
    [3, 'm1', '2026-07-21'],
  ]);
});

test('hủy nhiều phiếu chờ hoàn đúng bucket và không làm số đã dùng âm', async () => {
  const connection = inventoryConnection([
    { menuItemId: 'm1', inventoryDate: '2026-07-21', dailyUsed: 4, dailyLimit: 10, name: 'Món 1' },
  ]);
  await releaseDailyInventory(connection, [
    { inventoryDate: '2026-07-21', items: [item('m1', 3)] },
    { inventoryDate: '2026-07-21', items: [item('m1', 5)] },
  ]);
  assert.deepEqual(connection.updates, [[0, 'm1', '2026-07-21']]);
});
