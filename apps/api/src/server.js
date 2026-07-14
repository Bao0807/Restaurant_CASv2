import 'dotenv/config';
import crypto from 'node:crypto';
import cors from 'cors';
import express from 'express';
import { defaultSettings } from './defaultSettings.js';
import { closePool, databaseConfigSummary, getPool, initDatabase } from './db.js';
import {
  createPayment,
  parseJsonColumn,
  sanitizeSettings,
  validateOrderItems,
} from './domain.js';
import {
  bootstrapCatalog,
  canonicalizeOrderItems,
  estimateCookMinutes,
  getCatalog,
  saveCategory,
  saveMenuItem,
} from './catalog.js';
import { isKitchenOrderStale, lockKitchenQueue, processKitchenQueue, promoteKitchenQueue } from './kitchenQueue.js';

const app = express();
const isProduction = process.env.NODE_ENV === 'production';
const port = Number(process.env.PORT || 4100);
const host = process.env.HOST || (isProduction ? '0.0.0.0' : '127.0.0.1');
const allowedOrigins = new Set(
  (process.env.CORS_ORIGIN || 'http://localhost:5173,http://127.0.0.1:5173')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean),
);
const allowPrivateNetworkOrigins = !isProduction && process.env.CORS_ALLOW_PRIVATE_NETWORK !== 'false';
const authUsername = process.env.AUTH_USERNAME;
const authPassword = process.env.AUTH_PASSWORD;
const authConfigured = Boolean(authUsername && authPassword);
const authRequired = process.env.NODE_ENV === 'production' || authConfigured;
const authAttempts = new Map();
const configuredStaleMinutes = Number(process.env.KITCHEN_STALE_MINUTES || 120);
const kitchenStaleMinutes = Number.isInteger(configuredStaleMinutes)
  ? Math.min(Math.max(configuredStaleMinutes, 15), 1_440)
  : 120;

let dbReady = false;
let dbError = null;
let connecting = false;

/** Chuyển lỗi từ route async về error middleware chung của Express. */
function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function httpError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function boundedInteger(value, field, min, max) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < min || normalized > max) {
    const error = httpError(400, 'VALIDATION_ERROR', `${field} không hợp lệ.`);
    error.field = field;
    throw error;
  }
  return normalized;
}

function booleanValue(value, field) {
  if (typeof value !== 'boolean') {
    const error = httpError(400, 'VALIDATION_ERROR', `${field} không hợp lệ.`);
    error.field = field;
    throw error;
  }
  return value;
}

function isPrivateNetworkHostname(hostname) {
  if (hostname === 'localhost' || hostname === '::1' || hostname === '[::1]' || hostname.startsWith('127.')) return true;
  if (hostname.startsWith('10.') || hostname.startsWith('192.168.')) return true;
  const match = hostname.match(/^172\.(\d{1,3})\./);
  return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31);
}

/** Production dùng allowlist chính xác; development có thể cho phép origin mạng riêng. */
function isAllowedOrigin(origin) {
  if (!origin || allowedOrigins.has(origin)) return true;
  if (!allowPrivateNetworkOrigins) return false;
  try {
    const parsed = new URL(origin);
    return ['http:', 'https:'].includes(parsed.protocol) && isPrivateNetworkHostname(parsed.hostname);
  } catch {
    return false;
  }
}

function safeEqual(actual, expected) {
  const actualBuffer = Buffer.from(actual || '');
  const expectedBuffer = Buffer.from(expected || '');
  return actualBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

/** Xác thực Basic Auth và giới hạn 10 lần sai/IP/phút. */
function requireAuth(req, res, next) {
  if (!authRequired) {
    next();
    return;
  }
  if (!authConfigured) {
    res.status(503).json({ error: 'AUTH_NOT_CONFIGURED', message: 'Xác thực production chưa được cấu hình.' });
    return;
  }

  const attemptKey = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const previousAttempt = authAttempts.get(attemptKey);
  const attempt = previousAttempt && previousAttempt.resetAt > now
    ? previousAttempt
    : { count: 0, resetAt: now + 60_000 };
  if (attempt.count >= 10) {
    res.set('Retry-After', String(Math.ceil((attempt.resetAt - now) / 1000)));
    res.status(429).json({ error: 'TOO_MANY_AUTH_ATTEMPTS', message: 'Quá nhiều lần đăng nhập sai. Vui lòng thử lại sau.' });
    return;
  }

  const authorization = req.get('authorization') || '';
  const [scheme, encoded] = authorization.split(' ');
  let username = '';
  let password = '';
  if (scheme?.toLowerCase() === 'basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator >= 0) {
      username = decoded.slice(0, separator);
      password = decoded.slice(separator + 1);
    }
  }

  if (!safeEqual(username, authUsername) || !safeEqual(password, authPassword)) {
    attempt.count += 1;
    authAttempts.set(attemptKey, attempt);
    res.status(401).json({ error: 'UNAUTHORIZED', message: 'Tên đăng nhập hoặc mật khẩu không đúng.' });
    return;
  }

  authAttempts.delete(attemptKey);
  req.user = { username, role: 'admin' };
  next();
}

/** Trả 503 rõ ràng trong thời gian API đang kết nối lại MySQL. */
function requireDatabase(_req, res, next) {
  if (!dbReady) {
    res.status(503).json({
      error: 'DATABASE_UNAVAILABLE',
      message: 'MySQL chưa sẵn sàng. Vui lòng thử lại sau.',
    });
    return;
  }
  next();
}

function paymentSelect(whereClause) {
  return `SELECT
    invoice_code AS id,
    invoice_code AS invoiceCode,
    transaction_code AS transactionCode,
    table_id AS tableId,
    table_number AS tableNumber,
    payment_method AS method,
    subtotal,
    discount,
    service_fee AS serviceFee,
    vat,
    total,
    item_count AS itemCount,
    staff_name AS staffName,
    cashier_name AS cashierName,
    paid_at AS paidAt
  FROM payment_transactions ${whereClause}`;
}

app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  });
  next();
});
app.use(cors({
  origin(origin, callback) {
    if (isAllowedOrigin(origin)) return callback(null, true);
    return callback(httpError(403, 'ORIGIN_NOT_ALLOWED', 'Origin không được phép.'));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json({ limit: '256kb' }));

app.get('/api/health', (_req, res) => {
  res.status(dbReady ? 200 : 503).json({
    ok: dbReady,
    database: dbReady ? 'connected' : 'unavailable',
  });
});

app.get('/api/auth/session', requireAuth, (req, res) => {
  res.json({
    ok: true,
    authRequired,
    user: req.user ?? { username: 'local-development', role: 'admin' },
  });
});

app.use('/api', requireAuth);

app.get('/api/settings', requireDatabase, asyncRoute(async (_req, res) => {
  const [rows] = await getPool().query('SELECT settings FROM restaurant_settings WHERE id = 1 LIMIT 1');
  const settings = parseJsonColumn(rows[0]?.settings, defaultSettings);
  res.json({ settings: sanitizeSettings(settings, defaultSettings) });
}));

app.put('/api/settings', requireDatabase, asyncRoute(async (req, res) => {
  const [rows] = await getPool().query('SELECT settings FROM restaurant_settings WHERE id = 1 LIMIT 1');
  const current = sanitizeSettings(parseJsonColumn(rows[0]?.settings, defaultSettings), defaultSettings);
  const settings = sanitizeSettings(req.body?.settings, current);

  await getPool().query(
    `INSERT INTO restaurant_settings (id, settings)
     VALUES (1, ?)
     ON DUPLICATE KEY UPDATE settings = VALUES(settings), updated_at = CURRENT_TIMESTAMP`,
    [JSON.stringify(settings)],
  );
  res.json({ settings });
}));

app.get('/api/catalog', requireDatabase, asyncRoute(async (_req, res) => {
  res.json(await getCatalog(getPool()));
}));

app.post('/api/catalog/bootstrap', requireDatabase, asyncRoute(async (req, res) => {
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    const catalog = await bootstrapCatalog(connection, req.body?.categories, req.body?.items);
    await connection.commit();
    res.status(201).json(catalog);
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}));

app.post('/api/categories', requireDatabase, asyncRoute(async (req, res) => {
  const category = await saveCategory(getPool(), req.body?.category);
  res.status(201).json({ category });
}));

app.put('/api/categories/:categoryId', requireDatabase, asyncRoute(async (req, res) => {
  const category = await saveCategory(getPool(), req.body?.category, req.params.categoryId);
  res.json({ category });
}));

app.delete('/api/categories/:categoryId', requireDatabase, asyncRoute(async (req, res) => {
  const [items] = await getPool().query('SELECT id FROM menu_items WHERE category_id = ? LIMIT 1', [req.params.categoryId]);
  if (items[0]) throw httpError(409, 'CATEGORY_IN_USE', 'Danh mục vẫn còn món ăn.');
  const [result] = await getPool().query('DELETE FROM menu_categories WHERE id = ?', [req.params.categoryId]);
  if (result.affectedRows === 0) throw httpError(404, 'CATEGORY_NOT_FOUND', 'Không tìm thấy danh mục.');
  res.json({ ok: true });
}));

app.post('/api/menu-items', requireDatabase, asyncRoute(async (req, res) => {
  const item = await saveMenuItem(getPool(), req.body?.item);
  res.status(201).json({ item });
}));

app.put('/api/menu-items/:itemId', requireDatabase, asyncRoute(async (req, res) => {
  const item = await saveMenuItem(getPool(), req.body?.item, req.params.itemId);
  res.json({ item });
}));

app.delete('/api/menu-items/:itemId', requireDatabase, asyncRoute(async (req, res) => {
  const [result] = await getPool().query('UPDATE menu_items SET available = FALSE WHERE id = ?', [req.params.itemId]);
  if (result.affectedRows === 0) throw httpError(404, 'MENU_ITEM_NOT_FOUND', 'Không tìm thấy món.');
  res.json({ ok: true });
}));

// Snapshot này là nguồn sự thật duy nhất để UI đồng bộ bàn, order và queue.
app.get('/api/operations', requireDatabase, asyncRoute(async (_req, res) => {
  const [rows] = await getPool().query(
    `SELECT
      t.id,
      t.table_number AS number,
      t.seats,
      t.status,
      t.reserved_time AS reservedTime,
      o.id AS orderNumber,
      o.items,
      o.queued_at AS queuedAt,
      o.cooking_started_at AS cookingStartedAt,
      o.estimated_cook_minutes AS estimatedCookMinutes
    FROM restaurant_tables t
    LEFT JOIN active_orders o ON o.table_id = t.id
    ORDER BY t.table_number`,
  );
  const [kitchenRows] = await getPool().query(
    `SELECT concurrency, stale_after_minutes AS staleAfterMinutes,
      automation_enabled AS automationEnabled, paused
     FROM kitchen_queue_state WHERE id = 1 LIMIT 1`,
  );
  const staleAfterMinutes = Number(kitchenRows[0]?.staleAfterMinutes) || kitchenStaleMinutes;

  const tableOrders = {};
  const waitingRows = rows
    .filter(row => row.status === 'waiting' && row.orderNumber)
    .sort((left, right) => {
      const timeDifference = new Date(left.queuedAt).getTime() - new Date(right.queuedAt).getTime();
      return timeDifference || Number(left.orderNumber) - Number(right.orderNumber);
    });
  const queuePositions = new Map(waitingRows.map((row, index) => [row.id, index + 1]));
  const tables = rows.map(row => {
    if (row.items != null) tableOrders[row.id] = parseJsonColumn(row.items, []);
    const stale = row.status === 'cooking'
      && isKitchenOrderStale(row.cookingStartedAt, staleAfterMinutes);
    return {
      id: row.id,
      number: Number(row.number),
      seats: Number(row.seats),
      status: row.status,
      ...(row.reservedTime ? { reservedTime: row.reservedTime } : {}),
      ...(row.orderNumber ? { orderNumber: Number(row.orderNumber) } : {}),
      ...(row.queuedAt ? { queuedAt: new Date(row.queuedAt).toISOString() } : {}),
      ...(row.cookingStartedAt ? { cookingStartedAt: new Date(row.cookingStartedAt).toISOString() } : {}),
      ...(row.estimatedCookMinutes ? { estimatedCookMinutes: Number(row.estimatedCookMinutes) } : {}),
      ...(stale ? { kitchenStale: true } : {}),
      ...(queuePositions.has(row.id) ? { queuePosition: queuePositions.get(row.id) } : {}),
    };
  });
  res.json({
    tables,
    tableOrders,
    kitchen: {
      concurrency: Number(kitchenRows[0]?.concurrency) || 2,
      cookingCount: rows.filter(row => row.status === 'cooking').length,
      waitingCount: waitingRows.length,
      staleCount: tables.filter(table => table.kitchenStale).length,
      staleAfterMinutes,
      automationEnabled: kitchenRows[0]?.automationEnabled !== 0,
      paused: Boolean(kitchenRows[0]?.paused),
    },
  });
}));

// Lưu order, chuẩn hóa catalog và điều phối FIFO trong cùng một transaction.
app.put('/api/orders/:tableId', requireDatabase, asyncRoute(async (req, res) => {
  const validatedItems = validateOrderItems(req.body?.items);
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    await lockKitchenQueue(connection);
    const [tables] = await connection.query(
      'SELECT id, status FROM restaurant_tables WHERE id = ? FOR UPDATE',
      [req.params.tableId],
    );
    const table = tables[0];
    if (!table) throw httpError(404, 'TABLE_NOT_FOUND', 'Không tìm thấy bàn.');
    if (table.status === 'reserved') throw httpError(409, 'TABLE_RESERVED', 'Bàn đang được đặt trước.');

    const items = await canonicalizeOrderItems(connection, validatedItems);
    const estimatedCookMinutes = estimateCookMinutes(items);
    await connection.query(
      `INSERT INTO active_orders (table_id, items, estimated_cook_minutes) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE items = VALUES(items),
         estimated_cook_minutes = VALUES(estimated_cook_minutes), updated_at = CURRENT_TIMESTAMP`,
      [table.id, JSON.stringify(items), estimatedCookMinutes],
    );
    if (table.status !== 'waiting' && table.status !== 'cooking') {
      await connection.query(
        'UPDATE active_orders SET queued_at = CURRENT_TIMESTAMP(3), cooking_started_at = NULL WHERE table_id = ?',
        [table.id],
      );
    }
    const nextStatus = table.status === 'cooking' ? 'cooking' : 'waiting';
    await connection.query('UPDATE restaurant_tables SET status = ? WHERE id = ?', [nextStatus, table.id]);
    await promoteKitchenQueue(connection);
    const [orders] = await connection.query(
      `SELECT o.id, t.status, o.queued_at AS queuedAt, o.cooking_started_at AS cookingStartedAt
       FROM active_orders o INNER JOIN restaurant_tables t ON t.id = o.table_id
       WHERE o.table_id = ?`,
      [table.id],
    );
    await connection.commit();
    res.json({
      ok: true,
      orderNumber: Number(orders[0].id),
      status: orders[0].status,
      queuedAt: new Date(orders[0].queuedAt).toISOString(),
      ...(orders[0].cookingStartedAt ? { cookingStartedAt: new Date(orders[0].cookingStartedAt).toISOString() } : {}),
      estimatedCookMinutes,
      items,
    });
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}));

// Mọi thay đổi chế độ bếp đều khóa hàng queue để tránh tranh chấp giữa client.
app.put('/api/kitchen/config', requireDatabase, asyncRoute(async (req, res) => {
  const concurrency = boundedInteger(req.body?.concurrency, 'concurrency', 1, 20);
  const staleAfterMinutes = boundedInteger(req.body?.staleAfterMinutes, 'staleAfterMinutes', 15, 1_440);
  const automationEnabled = booleanValue(req.body?.automationEnabled, 'automationEnabled');
  const paused = booleanValue(req.body?.paused, 'paused');
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    await lockKitchenQueue(connection);
    await connection.query(
      `UPDATE kitchen_queue_state SET concurrency = ?, stale_after_minutes = ?,
        automation_enabled = ?, paused = ? WHERE id = 1`,
      [concurrency, staleAfterMinutes, automationEnabled, paused],
    );
    await promoteKitchenQueue(connection);
    await connection.commit();
    res.json({ concurrency, staleAfterMinutes, automationEnabled, paused });
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}));

app.post('/api/kitchen/dispatch-next', requireDatabase, asyncRoute(async (_req, res) => {
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    const promoted = await promoteKitchenQueue(connection, { force: true, limit: 1 });
    await connection.commit();
    res.json({ promoted, count: promoted.length });
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}));

app.post('/api/tables', requireDatabase, asyncRoute(async (req, res) => {
  const number = boundedInteger(req.body?.table?.number, 'number', 1, 999);
  const seats = boundedInteger(req.body?.table?.seats, 'seats', 1, 100);
  const id = `table-${crypto.randomUUID().slice(0, 8)}`;
  await getPool().query(
    `INSERT INTO restaurant_tables (id, table_number, seats, status) VALUES (?, ?, ?, 'empty')`,
    [id, number, seats],
  );
  res.status(201).json({ table: { id, number, seats, status: 'empty' } });
}));

app.put('/api/tables/:tableId', requireDatabase, asyncRoute(async (req, res) => {
  const number = boundedInteger(req.body?.table?.number, 'number', 1, 999);
  const seats = boundedInteger(req.body?.table?.seats, 'seats', 1, 100);
  const status = req.body?.table?.status;
  const allowedStatuses = new Set(['empty', 'waiting', 'cooking', 'done', 'reserved']);
  if (!allowedStatuses.has(status)) throw httpError(400, 'VALIDATION_ERROR', 'Trạng thái bàn không hợp lệ.');
  const reservedTime = status === 'reserved' && typeof req.body?.table?.reservedTime === 'string'
    ? req.body.table.reservedTime.slice(0, 10)
    : null;
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    await lockKitchenQueue(connection);
    const [rows] = await connection.query(
      `SELECT t.id, o.id AS orderId FROM restaurant_tables t
       LEFT JOIN active_orders o ON o.table_id = t.id WHERE t.id = ? FOR UPDATE`,
      [req.params.tableId],
    );
    if (!rows[0]) throw httpError(404, 'TABLE_NOT_FOUND', 'Không tìm thấy bàn.');
    const hasOrder = Boolean(rows[0].orderId);
    if (hasOrder && !['waiting', 'cooking', 'done'].includes(status)) {
      throw httpError(409, 'TABLE_HAS_ORDER', 'Bàn đang có order nên không thể chuyển sang trạng thái này.');
    }
    if (!hasOrder && ['waiting', 'cooking', 'done'].includes(status)) {
      throw httpError(409, 'ORDER_NOT_FOUND', 'Cần có order trước khi chọn trạng thái phục vụ.');
    }
    await connection.query(
      'UPDATE restaurant_tables SET table_number = ?, seats = ?, status = ?, reserved_time = ? WHERE id = ?',
      [number, seats, status, reservedTime, req.params.tableId],
    );
    if (hasOrder && status === 'cooking') {
      await connection.query(
        'UPDATE active_orders SET cooking_started_at = COALESCE(cooking_started_at, CURRENT_TIMESTAMP(3)) WHERE table_id = ?',
        [req.params.tableId],
      );
    }
    if (hasOrder && status === 'waiting') {
      await connection.query('UPDATE active_orders SET cooking_started_at = NULL WHERE table_id = ?', [req.params.tableId]);
    }
    await promoteKitchenQueue(connection);
    await connection.commit();
    res.json({ table: { id: req.params.tableId, number, seats, status, ...(reservedTime ? { reservedTime } : {}) } });
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}));

app.delete('/api/tables/:tableId', requireDatabase, asyncRoute(async (req, res) => {
  const [orders] = await getPool().query('SELECT id FROM active_orders WHERE table_id = ? LIMIT 1', [req.params.tableId]);
  if (orders[0]) throw httpError(409, 'TABLE_HAS_ORDER', 'Không thể xóa bàn đang có order.');
  const [result] = await getPool().query('DELETE FROM restaurant_tables WHERE id = ?', [req.params.tableId]);
  if (result.affectedRows === 0) throw httpError(404, 'TABLE_NOT_FOUND', 'Không tìm thấy bàn.');
  res.json({ ok: true });
}));

app.post('/api/orders/:tableId/requeue', requireDatabase, asyncRoute(async (req, res) => {
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    await lockKitchenQueue(connection);
    const [rows] = await connection.query(
      `SELECT t.id, t.status, o.id AS orderId FROM restaurant_tables t
       LEFT JOIN active_orders o ON o.table_id = t.id
       WHERE t.id = ? FOR UPDATE`,
      [req.params.tableId],
    );
    const table = rows[0];
    if (!table) throw httpError(404, 'TABLE_NOT_FOUND', 'Không tìm thấy bàn.');
    if (!table.orderId) throw httpError(409, 'ORDER_NOT_FOUND', 'Bàn chưa có order.');
    if (table.status !== 'cooking') {
      throw httpError(409, 'ORDER_NOT_COOKING', 'Chỉ có thể đưa order đang nấu về hàng chờ.');
    }
    await connection.query(
      `UPDATE active_orders SET queued_at = CURRENT_TIMESTAMP(3), cooking_started_at = NULL
       WHERE table_id = ?`,
      [table.id],
    );
    await connection.query("UPDATE restaurant_tables SET status = 'waiting' WHERE id = ?", [table.id]);
    await promoteKitchenQueue(connection);
    await connection.commit();
    res.json({ ok: true });
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}));

app.delete('/api/orders/:tableId', requireDatabase, asyncRoute(async (req, res) => {
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    await lockKitchenQueue(connection);
    const [tables] = await connection.query(
      'SELECT id, status FROM restaurant_tables WHERE id = ? FOR UPDATE',
      [req.params.tableId],
    );
    const table = tables[0];
    if (!table) throw httpError(404, 'TABLE_NOT_FOUND', 'Không tìm thấy bàn.');
    if (table.status === 'cooking') throw httpError(409, 'ORDER_COOKING', 'Không thể hủy order đang nấu.');
    await connection.query('DELETE FROM active_orders WHERE table_id = ?', [table.id]);
    await connection.query("UPDATE restaurant_tables SET status = 'empty' WHERE id = ?", [table.id]);
    await promoteKitchenQueue(connection);
    await connection.commit();
    res.json({ ok: true });
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}));

app.patch('/api/tables/:tableId/status', requireDatabase, asyncRoute(async (req, res) => {
  const nextStatus = req.body?.status;
  const transitions = { cooking: 'done' };
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    await lockKitchenQueue(connection);
    const [tables] = await connection.query(
      'SELECT id, status FROM restaurant_tables WHERE id = ? FOR UPDATE',
      [req.params.tableId],
    );
    const table = tables[0];
    if (!table) throw httpError(404, 'TABLE_NOT_FOUND', 'Không tìm thấy bàn.');
    if (transitions[table.status] !== nextStatus) {
      throw httpError(409, 'INVALID_STATUS_TRANSITION', `Không thể chuyển từ ${table.status} sang ${nextStatus}.`);
    }
    const [orders] = await connection.query('SELECT id FROM active_orders WHERE table_id = ?', [table.id]);
    if (orders.length === 0) throw httpError(409, 'ORDER_NOT_FOUND', 'Bàn chưa có order.');
    await connection.query('UPDATE restaurant_tables SET status = ? WHERE id = ?', [nextStatus, table.id]);
    await promoteKitchenQueue(connection);
    await connection.commit();
    res.json({ ok: true, status: nextStatus });
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}));

app.get('/api/payments', requireDatabase, asyncRoute(async (req, res) => {
  const hasRange = req.query.from != null || req.query.to != null;
  if (hasRange && (typeof req.query.from !== 'string' || typeof req.query.to !== 'string')) {
    throw httpError(400, 'INVALID_DATE_RANGE', 'Khoảng thời gian báo cáo không hợp lệ.');
  }
  const from = hasRange ? new Date(req.query.from) : null;
  const to = hasRange ? new Date(req.query.to) : null;
  if (hasRange && (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to)) {
    throw httpError(400, 'INVALID_DATE_RANGE', 'Khoảng thời gian báo cáo không hợp lệ.');
  }

  const [rows] = hasRange
    ? await getPool().query(
      `${paymentSelect('WHERE paid_at >= ? AND paid_at < ?')} ORDER BY paid_at DESC LIMIT 1000`,
      [from, to],
    )
    : await getPool().query(`${paymentSelect('')} ORDER BY paid_at DESC LIMIT 100`);
  res.json({ payments: rows });
}));

// Thanh toán, lưu chi tiết món, xóa order và giải phóng bàn là một transaction.
app.post('/api/payments', requireDatabase, asyncRoute(async (req, res) => {
  const draft = req.body?.payment;
  const tableId = typeof draft?.tableId === 'string' ? draft.tableId : '';
  if (!tableId) throw httpError(400, 'INVALID_PAYMENT', 'Thiếu mã bàn thanh toán.');

  let connection;
  try {
    connection = await getPool().getConnection();
    await connection.beginTransaction();
    await lockKitchenQueue(connection);

    const [tables] = await connection.query(
      'SELECT id, table_number AS number, status FROM restaurant_tables WHERE id = ? FOR UPDATE',
      [tableId],
    );
    const table = tables[0];
    if (!table) throw httpError(404, 'TABLE_NOT_FOUND', 'Không tìm thấy bàn.');

    const [orders] = await connection.query('SELECT items FROM active_orders WHERE table_id = ? FOR UPDATE', [tableId]);
    if (!orders[0]) throw httpError(409, 'ORDER_NOT_FOUND', 'Order đã được thanh toán hoặc không còn tồn tại.');
    const items = validateOrderItems(parseJsonColumn(orders[0].items, []));

    const [settingsRows] = await connection.query('SELECT settings FROM restaurant_settings WHERE id = 1 LIMIT 1');
    const settings = sanitizeSettings(parseJsonColumn(settingsRows[0]?.settings, defaultSettings), defaultSettings);
    const payment = createPayment({ draft, items, settings, table });

    const [result] = await connection.query(
      `INSERT INTO payment_transactions (
        invoice_code, transaction_code, table_id, table_number, payment_method,
        subtotal, discount, service_fee, vat, total, item_count,
        staff_name, cashier_name, paid_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        payment.invoiceCode, payment.transactionCode, payment.tableId, payment.tableNumber, payment.method,
        payment.subtotal, payment.discount, payment.serviceFee, payment.vat, payment.total, payment.itemCount,
        payment.staffName, payment.cashierName, new Date(payment.paidAt),
      ],
    );

    const itemPlaceholders = items.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
    const itemValues = items.flatMap(item => [
      result.insertId,
      item.cartId,
      item.menuItem.id,
      item.menuItem.name,
      item.quantity,
      item.menuItem.price + (item.selectedSize?.extraPrice ?? 0)
        + item.selectedToppings.reduce((sum, topping) => sum + topping.price, 0),
      item.note || null,
      JSON.stringify({ size: item.selectedSize?.label ?? null, toppings: item.selectedToppings.map(topping => topping.label) }),
    ]);
    await connection.query(
      `INSERT INTO payment_items (
        transaction_id, cart_id, menu_item_id, name, quantity, price, note, options_json
      ) VALUES ${itemPlaceholders}`,
      itemValues,
    );

    await connection.query('DELETE FROM active_orders WHERE table_id = ?', [tableId]);
    await connection.query("UPDATE restaurant_tables SET status = 'empty' WHERE id = ?", [tableId]);
    await promoteKitchenQueue(connection);
    await connection.commit();
    res.status(201).json({ ok: true, id: result.insertId, payment });
  } catch (error) {
    await connection?.rollback().catch(() => {});
    if (error.code === 'ER_DUP_ENTRY' && draft?.invoiceCode) {
      const [rows] = await getPool().query(`${paymentSelect('WHERE invoice_code = ?')} LIMIT 1`, [draft.invoiceCode]);
      if (rows[0] && rows[0].tableId === tableId && rows[0].method === draft.method) {
        res.json({ ok: true, payment: rows[0], idempotent: true });
        return;
      }
      throw httpError(409, 'DUPLICATE_INVOICE', 'Mã hóa đơn đã được sử dụng.');
    }
    throw error;
  } finally {
    connection?.release();
  }
}));

app.use('/api', (_req, res) => res.status(404).json({ error: 'NOT_FOUND' }));

app.use((error, _req, res, _next) => {
  const databaseConflict = error.code === 'ER_DUP_ENTRY';
  const status = Number(error.status) || (databaseConflict ? 409 : error instanceof SyntaxError ? 400 : 500);
  const code = error.code && typeof error.code === 'string' && !error.code.startsWith('ER_')
    ? error.code
    : (databaseConflict ? 'DUPLICATE_DATA' : status === 400 ? 'INVALID_JSON' : 'INTERNAL_ERROR');
  if (status >= 500) console.error(error);
  res.status(status).json({
    error: code,
    message: databaseConflict ? 'Số bàn hoặc mã dữ liệu đã tồn tại.' : status >= 500 ? 'Đã xảy ra lỗi nội bộ.' : error.message,
    ...(error.field ? { field: error.field } : {}),
  });
});

/** Kết nối/reconnect MySQL và tiếp tục queue còn dang dở sau khi API khởi động. */
async function connectDatabase() {
  if (connecting || dbReady) return;
  connecting = true;
  try {
    await initDatabase();
    const promoted = await processKitchenQueue(getPool());
    dbReady = true;
    dbError = null;
    console.log(`MySQL connected: ${databaseConfigSummary.host}:${databaseConfigSummary.port}/${databaseConfigSummary.database}`);
    if (promoted.length > 0) console.log(`Kitchen queue promoted ${promoted.length} order(s).`);
  } catch (error) {
    dbReady = false;
    dbError = error;
    console.warn(`MySQL unavailable: ${error.message}`);
  } finally {
    connecting = false;
  }
}

const server = app.listen(port, host, () => {
  console.log(`CAS API listening on http://${host}:${port}`);
  void connectDatabase();
});

const retryTimer = setInterval(() => {
  if (!dbReady) void connectDatabase();
}, 10_000);
retryTimer.unref();

/** Dừng nhận request mới và đóng pool trước khi thoát tiến trình. */
async function shutdown(signal) {
  console.log(`${signal} received, shutting down.`);
  clearInterval(retryTimer);
  server.close(async () => {
    await closePool().catch(error => console.error(error));
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

export { app };
