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
 * Đồng bộ trạng thái bàn từ các lượt gọi còn tồn tại.
 * cooking được ưu tiên hơn waiting; chỉ khi mọi lượt hoàn tất bàn mới là done.
 */
export async function syncTableStatuses(connection, tableIds) {
  const uniqueTableIds = [...new Set(tableIds.filter(Boolean))];
  if (uniqueTableIds.length === 0) return;
  const placeholders = uniqueTableIds.map(() => '?').join(', ');
  await connection.query(
    `UPDATE restaurant_tables t
     INNER JOIN (
       SELECT table_id,
         CASE
           WHEN SUM(status = 'cooking') > 0 THEN 'cooking'
           WHEN SUM(status = 'waiting') > 0 THEN 'waiting'
           ELSE 'done'
         END AS nextStatus
       FROM order_batches
       WHERE table_id IN (${placeholders})
       GROUP BY table_id
     ) batches ON batches.table_id = t.id
     SET t.status = batches.nextStatus`,
    uniqueTableIds,
  );
}

/**
 * Hoàn tất các lượt đang nấu đã chạy đủ ETA.
 * Dùng thời gian UTC của MySQL để nhiều API instance không phụ thuộc đồng hồ máy client.
 */
export async function completeExpiredKitchenBatches(connection) {
  const [expired] = await connection.query(
    `SELECT id AS batchId, table_id AS tableId
     FROM order_batches
     WHERE status = 'cooking'
       AND cooking_started_at IS NOT NULL
       AND TIMESTAMPADD(MINUTE, estimated_cook_minutes, cooking_started_at) <= CURRENT_TIMESTAMP(3)
     ORDER BY cooking_started_at ASC, id ASC
     FOR UPDATE`,
  );
  if (expired.length === 0) return [];

  const batchIds = expired.map(batch => batch.batchId);
  const placeholders = batchIds.map(() => '?').join(', ');
  await connection.query(
    `UPDATE order_batches
     SET status = 'done', completed_at = CURRENT_TIMESTAMP(3)
     WHERE id IN (${placeholders}) AND status = 'cooking'`,
    batchIds,
  );
  await syncTableStatuses(connection, expired.map(batch => batch.tableId));
  return expired;
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
    "SELECT COUNT(*) AS cookingCount FROM order_batches WHERE status = 'cooking'",
  );
  const availableSlots = availableKitchenSlots(Number(counts[0]?.cookingCount), activeConcurrency);
  const available = Number.isInteger(options.limit)
    ? Math.min(availableSlots, Math.max(1, options.limit))
    : availableSlots;
  if (available === 0) return [];

  const [waiting] = await connection.query(
    `SELECT id AS batchId, table_id AS tableId
     FROM order_batches
     WHERE status = 'waiting'
     ORDER BY queued_at ASC, id ASC
     LIMIT ${available}
     FOR UPDATE`,
  );
  if (waiting.length === 0) return [];

  const batchIds = waiting.map(batch => batch.batchId);
  const tableIds = waiting.map(order => order.tableId);
  const placeholders = batchIds.map(() => '?').join(', ');
  await connection.query(
    `UPDATE order_batches
     SET status = 'cooking', cooking_started_at = COALESCE(cooking_started_at, CURRENT_TIMESTAMP(3)),
       completed_at = NULL
     WHERE id IN (${placeholders}) AND status = 'waiting'`,
    batchIds,
  );
  await syncTableStatuses(connection, tableIds);

  return waiting;
}

/** Mở transaction độc lập để chạy một vòng điều phối queue an toàn. */
export async function processKitchenQueue(pool, options) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    // Luôn hoàn tất món đã đủ ETA, kể cả khi bếp đang pause/manual.
    await lockKitchenQueue(connection);
    await completeExpiredKitchenBatches(connection);
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
