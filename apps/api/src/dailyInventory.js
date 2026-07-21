const DEFAULT_BUSINESS_TIME_ZONE = 'Asia/Ho_Chi_Minh';
const MAX_DAILY_QUANTITY = 2_000_000_000;

export const businessTimeZone = process.env.BUSINESS_TIME_ZONE?.trim() || DEFAULT_BUSINESS_TIME_ZONE;

let businessDateFormatter;
try {
  businessDateFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: businessTimeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  businessDateFormatter.format(new Date());
} catch {
  throw new Error(`BUSINESS_TIME_ZONE không hợp lệ: ${businessTimeZone}`);
}

/** Trả về ngày kinh doanh YYYY-MM-DD theo múi giờ của nhà hàng, không phụ thuộc máy POS hay session MySQL UTC. */
export function businessDateFor(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('Không thể xác định ngày kinh doanh từ thời gian không hợp lệ.');
  const parts = new Map(businessDateFormatter.formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.get('year')}-${parts.get('month')}-${parts.get('day')}`;
}

/** Gộp mọi biến thể size/topping của cùng một món trước khi giữ hoặc hoàn hạn mức. */
export function aggregateMenuQuantities(items) {
  const quantities = new Map();
  for (const item of items ?? []) {
    const menuItemId = item?.menuItem?.id;
    const quantity = Number(item?.quantity);
    if (typeof menuItemId !== 'string' || !menuItemId || !Number.isSafeInteger(quantity) || quantity <= 0) continue;
    const current = quantities.get(menuItemId) ?? { id: menuItemId, name: item.menuItem.name || menuItemId, quantity: 0 };
    current.quantity += quantity;
    quantities.set(menuItemId, current);
  }
  return [...quantities.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function addDelta(deltas, inventoryDate, item, multiplier) {
  const key = `${inventoryDate}\u0000${item.id}`;
  const current = deltas.get(key) ?? {
    inventoryDate,
    menuItemId: item.id,
    menuItemName: item.name,
    delta: 0,
  };
  current.delta += item.quantity * multiplier;
  deltas.set(key, current);
}

function dailyLimitError(row, requested, remaining) {
  const error = new Error(
    `Món “${row.name}” chỉ còn ${remaining} phần trong ngày; lượt gọi cần thêm ${requested} phần.`,
  );
  error.status = 409;
  error.code = 'MENU_ITEM_DAILY_LIMIT_EXCEEDED';
  error.field = 'items';
  error.details = {
    menuItemId: row.menuItemId,
    dailyLimit: row.dailyLimit == null ? null : Number(row.dailyLimit),
    dailyUsed: Number(row.dailyUsed),
    dailyRemaining: remaining,
    requested,
    inventoryDate: row.inventoryDate,
  };
  return error;
}

/**
 * Áp dụng nhiều thay đổi tồn kho trong một transaction.
 * Toàn bộ bucket được khóa theo thứ tự ngày/id để hai máy POS không thể cùng bán phần cuối.
 */
async function applyInventoryDeltas(connection, entries) {
  const changes = entries
    .filter(entry => entry.delta !== 0)
    .sort((left, right) => (
      left.inventoryDate.localeCompare(right.inventoryDate)
      || left.menuItemId.localeCompare(right.menuItemId)
    ));
  if (changes.length === 0) return new Map();

  for (const change of changes) {
    await connection.query(
      `INSERT INTO menu_item_daily_usage (menu_item_id, business_date, used_quantity)
       SELECT id, ?, 0 FROM menu_items WHERE id = ?
       ON DUPLICATE KEY UPDATE menu_item_id = VALUES(menu_item_id)`,
      [change.inventoryDate, change.menuItemId],
    );
  }

  const clauses = changes.map(() => '(daily_usage.business_date = ? AND daily_usage.menu_item_id = ?)').join(' OR ');
  const params = changes.flatMap(change => [change.inventoryDate, change.menuItemId]);
  const [rows] = await connection.query(
    `SELECT daily_usage.menu_item_id AS menuItemId,
      DATE_FORMAT(daily_usage.business_date, '%Y-%m-%d') AS inventoryDate,
      daily_usage.used_quantity AS dailyUsed,
      item.daily_limit AS dailyLimit,
      item.name
     FROM menu_item_daily_usage daily_usage
     INNER JOIN menu_items item ON item.id = daily_usage.menu_item_id
     WHERE ${clauses}
     ORDER BY daily_usage.business_date, daily_usage.menu_item_id
     FOR UPDATE`,
    params,
  );
  const rowsByKey = new Map(rows.map(row => [`${row.inventoryDate}\u0000${row.menuItemId}`, row]));

  for (const change of changes) {
    const key = `${change.inventoryDate}\u0000${change.menuItemId}`;
    const row = rowsByKey.get(key);
    if (!row) {
      const error = new Error(`Món “${change.menuItemName}” không còn tồn tại trong thực đơn.`);
      error.status = 409;
      error.code = 'MENU_ITEM_NOT_FOUND';
      throw error;
    }
    const used = Number(row.dailyUsed);
    const nextUsed = Math.max(0, used + change.delta);
    if (!Number.isSafeInteger(nextUsed) || nextUsed > MAX_DAILY_QUANTITY) {
      throw new Error(`Số lượng theo ngày của món “${row.name}” vượt giới hạn hệ thống.`);
    }
    const limit = row.dailyLimit == null ? null : Number(row.dailyLimit);
    if (change.delta > 0 && limit != null && nextUsed > limit) {
      throw dailyLimitError(row, change.delta, Math.max(0, limit - used));
    }
    row.nextDailyUsed = nextUsed;
  }

  for (const change of changes) {
    const row = rowsByKey.get(`${change.inventoryDate}\u0000${change.menuItemId}`);
    await connection.query(
      `UPDATE menu_item_daily_usage SET used_quantity = ?
       WHERE menu_item_id = ? AND business_date = ?`,
      [row.nextDailyUsed, change.menuItemId, change.inventoryDate],
    );
  }
  return rowsByKey;
}

/** Giữ số phần của một lượt gọi mới trong bucket ngày hiện tại. */
export async function reserveDailyInventory(connection, items, inventoryDate = businessDateFor()) {
  const deltas = aggregateMenuQuantities(items).map(item => ({
    inventoryDate,
    menuItemId: item.id,
    menuItemName: item.name,
    delta: item.quantity,
  }));
  await applyInventoryDeltas(connection, deltas);
  return inventoryDate;
}

/**
 * Sửa phiếu chờ: hoàn toàn bộ phần giữ cũ rồi giữ lại nội dung mới.
 * Nếu sửa qua ngày mới, phiếu được chuyển sang bucket của ngày hiện tại thay vì dùng hạn mức hôm qua.
 */
export async function replaceDailyInventory(
  connection,
  previousItems,
  previousInventoryDate,
  nextItems,
  nextInventoryDate = businessDateFor(),
) {
  const deltas = new Map();
  for (const item of aggregateMenuQuantities(previousItems)) addDelta(deltas, previousInventoryDate, item, -1);
  for (const item of aggregateMenuQuantities(nextItems)) addDelta(deltas, nextInventoryDate, item, 1);
  await applyInventoryDeltas(connection, [...deltas.values()]);
  return nextInventoryDate;
}

/** Hoàn số lượng của các phiếu còn chờ trước khi hủy order; món đã nấu/xong không gọi hàm này. */
export async function releaseDailyInventory(connection, batches) {
  const deltas = new Map();
  for (const batch of batches) {
    for (const item of aggregateMenuQuantities(batch.items)) {
      addDelta(deltas, batch.inventoryDate, item, -1);
    }
  }
  await applyInventoryDeltas(connection, [...deltas.values()]);
}

/** Snapshot nhỏ để `/operations` đồng bộ số còn lại giữa nhiều thiết bị mà không tải lại ảnh/catalog. */
export async function getDailyMenuAvailability(connection, inventoryDate = businessDateFor()) {
  const [rows] = await connection.query(
    `SELECT item.id,
      item.daily_limit AS dailyLimit,
      COALESCE(daily_usage.used_quantity, 0) AS dailyUsed,
      CASE WHEN item.daily_limit IS NULL THEN NULL
        ELSE GREATEST(item.daily_limit - COALESCE(daily_usage.used_quantity, 0), 0)
      END AS dailyRemaining,
      ? AS inventoryDate
     FROM menu_items item
     LEFT JOIN menu_item_daily_usage daily_usage
       ON daily_usage.menu_item_id = item.id AND daily_usage.business_date = ?
     ORDER BY item.id`,
    [inventoryDate, inventoryDate],
  );
  return rows.map(row => ({
    id: row.id,
    dailyLimit: row.dailyLimit == null ? null : Number(row.dailyLimit),
    dailyUsed: Number(row.dailyUsed),
    dailyRemaining: row.dailyRemaining == null ? null : Number(row.dailyRemaining),
    inventoryDate: row.inventoryDate,
  }));
}
