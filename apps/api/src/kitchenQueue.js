const configuredConcurrency = Number(process.env.KITCHEN_CONCURRENCY || 2);

export const kitchenConcurrency = Number.isInteger(configuredConcurrency)
  ? Math.min(Math.max(configuredConcurrency, 1), 20)
  : 2;

/** Trả về số slot bếp còn trống, luôn không âm. */
export function availableKitchenSlots(cookingCount, concurrency = kitchenConcurrency) {
  return Math.max(0, concurrency - Math.max(0, Number(cookingCount) || 0));
}

/** Xác định order nấu quá ngưỡng để Dashboard cảnh báo can thiệp. */
export function isKitchenOrderStale(startedAt, staleAfterMinutes = 120, now = Date.now()) {
  if (!startedAt) return false;
  const started = new Date(startedAt).getTime();
  const threshold = Number(staleAfterMinutes) * 60_000;
  return Number.isFinite(started) && Number.isFinite(threshold) && threshold > 0 && now - started >= threshold;
}

/** Khóa hàng cấu hình duy nhất để mọi client cùng điều phối trên một queue. */
export async function lockKitchenQueue(connection) {
  const [rows] = await connection.query(
    `SELECT id, concurrency, automation_enabled AS automationEnabled, paused
     FROM kitchen_queue_state WHERE id = 1 FOR UPDATE`,
  );
  return {
    concurrency: Number(rows[0]?.concurrency) || kitchenConcurrency,
    automationEnabled: rows[0]?.automationEnabled !== 0,
    paused: Boolean(rows[0]?.paused),
  };
}

/**
 * Promote waiting orders using a database-backed FIFO queue.
 * The queue-state row is locked until the caller commits, serializing dispatch
 * across concurrent POS clients without relying on in-memory state.
 */
export async function promoteKitchenQueue(connection, options = {}) {
  const state = await lockKitchenQueue(connection);
  const activeConcurrency = Number.isInteger(options.concurrency)
    ? Math.min(Math.max(options.concurrency, 1), 20)
    : state.concurrency;
  if (state.paused || (!state.automationEnabled && !options.force)) return [];

  const [counts] = await connection.query(
    `SELECT COUNT(*) AS cookingCount
     FROM restaurant_tables t
     INNER JOIN active_orders o ON o.table_id = t.id
     WHERE t.status = 'cooking'`,
  );
  const availableSlots = availableKitchenSlots(Number(counts[0]?.cookingCount), activeConcurrency);
  const available = Number.isInteger(options.limit)
    ? Math.min(availableSlots, Math.max(1, options.limit))
    : availableSlots;
  if (available === 0) return [];

  const [waiting] = await connection.query(
    `SELECT o.id, o.table_id AS tableId
     FROM active_orders o
     INNER JOIN restaurant_tables t ON t.id = o.table_id
     WHERE t.status = 'waiting'
     ORDER BY o.queued_at ASC, o.id ASC
     LIMIT ${available}
     FOR UPDATE`,
  );
  if (waiting.length === 0) return [];

  const tableIds = waiting.map(order => order.tableId);
  const placeholders = tableIds.map(() => '?').join(', ');
  await connection.query(
    `UPDATE active_orders
     SET cooking_started_at = COALESCE(cooking_started_at, CURRENT_TIMESTAMP(3))
     WHERE table_id IN (${placeholders})`,
    tableIds,
  );
  await connection.query(
    `UPDATE restaurant_tables SET status = 'cooking'
     WHERE id IN (${placeholders}) AND status = 'waiting'`,
    tableIds,
  );

  return tableIds;
}

/** Mở transaction độc lập để chạy một vòng điều phối queue an toàn. */
export async function processKitchenQueue(pool, options) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const promoted = await promoteKitchenQueue(connection, options);
    await connection.commit();
    return promoted;
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}
