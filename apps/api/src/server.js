import 'dotenv/config';
import crypto from 'node:crypto';
import cors from 'cors';
import express from 'express';
import { defaultSettings } from './defaultSettings.js';
import { closePool, databaseConfigSummary, getPool, initDatabase } from './db.js';
import {
  createPayment,
  normalizeEmployee,
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
import { isKitchenOrderStale, lockKitchenQueue, processKitchenQueue, promoteKitchenQueue, syncTableStatuses } from './kitchenQueue.js';
import { canCancelOrder, canSettleOrder } from './orderPolicy.js';

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
let kitchenCycleRunning = false;

const databaseConnectivityErrorCodes = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'PROTOCOL_CONNECTION_LOST',
  'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR',
  'ER_SERVER_SHUTDOWN',
]);

function isDatabaseConnectivityError(error) {
  return databaseConnectivityErrorCodes.has(error?.code)
    || /pool is closed|connection.*closed|read ECONNRESET/i.test(error?.message || '');
}

function markDatabaseUnavailable(error) {
  dbReady = false;
  dbError = error;
}

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
    staff_id AS employeeId,
    staff_name AS staffName,
    cashier_name AS cashierName,
    paid_at AS paidAt
  FROM payment_transactions ${whereClause}`;
}

function employeeSelect(whereClause = '') {
  return `SELECT id, employee_code AS code, full_name AS name, role, phone,
    TIME_FORMAT(shift_start, '%H:%i') AS shiftStart,
    TIME_FORMAT(shift_end, '%H:%i') AS shiftEnd,
    active, created_at AS createdAt, updated_at AS updatedAt
    FROM employees ${whereClause}`;
}

function serializeEmployee(row) {
  return { ...row, active: Boolean(row.active) };
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

app.get('/api/health', asyncRoute(async (_req, res) => {
  if (dbReady) {
    try {
      await getPool().query({ sql: 'SELECT 1', timeout: 2_000 });
    } catch (error) {
      markDatabaseUnavailable(error);
    }
  }
  res.status(dbReady ? 200 : 503).json({
    ok: dbReady,
    database: dbReady ? 'connected' : 'unavailable',
  });
}));

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

/** Danh sách nhân sự dùng chung cho quản trị, phân công phục vụ và báo cáo. */
app.get('/api/employees', requireDatabase, asyncRoute(async (req, res) => {
  const activeOnly = req.query.active === 'true';
  const [rows] = await getPool().query(
    `${employeeSelect(activeOnly ? 'WHERE active = TRUE' : '')} ORDER BY active DESC, full_name, employee_code`,
  );
  res.json({ employees: rows.map(serializeEmployee) });
}));

app.post('/api/employees', requireDatabase, asyncRoute(async (req, res) => {
  const employee = normalizeEmployee(req.body?.employee);
  const [duplicates] = await getPool().query('SELECT id FROM employees WHERE employee_code = ? LIMIT 1', [employee.code]);
  if (duplicates[0]) throw httpError(409, 'EMPLOYEE_CODE_EXISTS', 'Mã nhân viên đã tồn tại.');
  const id = `employee-${crypto.randomUUID()}`;
  await getPool().query(
    `INSERT INTO employees (id, employee_code, full_name, role, phone, shift_start, shift_end, active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, employee.code, employee.name, employee.role, employee.phone, employee.shiftStart, employee.shiftEnd, employee.active],
  );
  const [rows] = await getPool().query(`${employeeSelect('WHERE id = ?')} LIMIT 1`, [id]);
  res.status(201).json({ employee: serializeEmployee(rows[0]) });
}));

app.put('/api/employees/:employeeId', requireDatabase, asyncRoute(async (req, res) => {
  const [currentRows] = await getPool().query(`${employeeSelect('WHERE id = ?')} LIMIT 1`, [req.params.employeeId]);
  if (!currentRows[0]) throw httpError(404, 'EMPLOYEE_NOT_FOUND', 'Không tìm thấy nhân viên.');
  const employee = normalizeEmployee(req.body?.employee, serializeEmployee(currentRows[0]));
  const [duplicates] = await getPool().query(
    'SELECT id FROM employees WHERE employee_code = ? AND id <> ? LIMIT 1',
    [employee.code, req.params.employeeId],
  );
  if (duplicates[0]) throw httpError(409, 'EMPLOYEE_CODE_EXISTS', 'Mã nhân viên đã tồn tại.');
  await getPool().query(
    `UPDATE employees SET employee_code = ?, full_name = ?, role = ?, phone = ?,
       shift_start = ?, shift_end = ?, active = ? WHERE id = ?`,
    [employee.code, employee.name, employee.role, employee.phone, employee.shiftStart, employee.shiftEnd, employee.active, req.params.employeeId],
  );
  const [rows] = await getPool().query(`${employeeSelect('WHERE id = ?')} LIMIT 1`, [req.params.employeeId]);
  res.json({ employee: serializeEmployee(rows[0]) });
}));

// Không xóa vật lý để hóa đơn cũ vẫn giữ được lịch sử nhân sự.
app.delete('/api/employees/:employeeId', requireDatabase, asyncRoute(async (req, res) => {
  const [result] = await getPool().query('UPDATE employees SET active = FALSE WHERE id = ?', [req.params.employeeId]);
  if (result.affectedRows === 0) throw httpError(404, 'EMPLOYEE_NOT_FOUND', 'Không tìm thấy nhân viên.');
  res.json({ ok: true });
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
  const connection = await getPool().getConnection();
  try {
    // Một repeatable-read snapshot tránh ghép trạng thái bàn cũ với queue mới giữa chu kỳ bếp.
    await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await connection.query('START TRANSACTION READ ONLY');
    const [rows] = await connection.query(
      `SELECT
        t.id,
        t.table_number AS number,
        t.seats,
        t.status,
        t.reserved_time AS reservedTime,
        o.id AS orderNumber,
        o.items
      FROM restaurant_tables t
      LEFT JOIN active_orders o ON o.table_id = t.id
      ORDER BY t.table_number`,
    );
    const [batchRows] = await connection.query(
      `SELECT id AS batchId, order_id AS orderId, table_id AS tableId,
        batch_number AS batchNumber, items, status, is_addition AS isAddition,
        queued_at AS queuedAt, cooking_started_at AS cookingStartedAt,
        completed_at AS completedAt, estimated_cook_minutes AS estimatedCookMinutes
       FROM order_batches
       ORDER BY queued_at, id`,
    );
    const [kitchenRows] = await connection.query(
      `SELECT concurrency, stale_after_minutes AS staleAfterMinutes,
        automation_enabled AS automationEnabled, paused
       FROM kitchen_queue_state WHERE id = 1 LIMIT 1`,
    );
    await connection.commit();

    const staleAfterMinutes = Number(kitchenRows[0]?.staleAfterMinutes) || kitchenStaleMinutes;
    const tableOrders = {};
    const waitingBatchesByTable = {};
    const waitingRows = batchRows
      .filter(row => row.status === 'waiting')
      .sort((left, right) => {
        const timeDifference = new Date(left.queuedAt).getTime() - new Date(right.queuedAt).getTime();
        return timeDifference || Number(left.batchId) - Number(right.batchId);
      });
    const queuePositions = new Map(waitingRows.map((row, index) => [Number(row.batchId), index + 1]));
    const batchesByTable = batchRows.reduce((result, batch) => {
      const current = result.get(batch.tableId) ?? [];
      current.push(batch);
      result.set(batch.tableId, current);
      return result;
    }, new Map());
    const tables = rows.map(row => {
      if (row.items != null) tableOrders[row.id] = parseJsonColumn(row.items, []);
      const batches = batchesByTable.get(row.id) ?? [];
      const cookingBatches = batches.filter(batch => batch.status === 'cooking');
      const waitingBatches = batches.filter(batch => batch.status === 'waiting');
      const doneBatches = batches.filter(batch => batch.status === 'done');
      if (waitingBatches.length > 0) {
        waitingBatchesByTable[row.id] = waitingBatches
          .sort((left, right) => Number(left.batchNumber) - Number(right.batchNumber))
          .map(batch => ({
            batchId: Number(batch.batchId),
            batchNumber: Number(batch.batchNumber),
            items: parseJsonColumn(batch.items, []),
            queuedAt: new Date(batch.queuedAt).toISOString(),
            estimatedCookMinutes: Number(batch.estimatedCookMinutes),
          }));
      }
      const timerBatch = cookingBatches[0] ?? waitingBatches[0];
      const stale = cookingBatches.some(batch => isKitchenOrderStale(batch.cookingStartedAt, staleAfterMinutes));
      const queuePosition = waitingBatches.length
        ? Math.min(...waitingBatches.map(batch => queuePositions.get(Number(batch.batchId)) ?? Number.MAX_SAFE_INTEGER))
        : undefined;
      return {
        id: row.id,
        number: Number(row.number),
        seats: Number(row.seats),
        status: row.status,
        ...(row.reservedTime ? { reservedTime: row.reservedTime } : {}),
        ...(row.orderNumber ? { orderNumber: Number(row.orderNumber) } : {}),
        ...(timerBatch?.queuedAt ? { queuedAt: new Date(timerBatch.queuedAt).toISOString() } : {}),
        ...(timerBatch?.cookingStartedAt ? { cookingStartedAt: new Date(timerBatch.cookingStartedAt).toISOString() } : {}),
        ...(timerBatch?.estimatedCookMinutes ? { estimatedCookMinutes: Number(timerBatch.estimatedCookMinutes) } : {}),
        ...(cookingBatches[0]?.batchId ? { cookingBatchId: Number(cookingBatches[0].batchId) } : {}),
        ...(stale ? { kitchenStale: true } : {}),
        ...(queuePosition && queuePosition !== Number.MAX_SAFE_INTEGER ? { queuePosition } : {}),
        batchCount: batches.length,
        additionalBatchCount: batches.filter(batch => Boolean(batch.isAddition)).length,
        waitingBatchCount: waitingBatches.length,
        cookingBatchCount: cookingBatches.length,
        doneBatchCount: doneBatches.length,
        latestBatchNumber: batches.length ? Math.max(...batches.map(batch => Number(batch.batchNumber))) : 0,
      };
    });
    res.json({
      tables,
      tableOrders,
      waitingBatchesByTable,
      kitchen: {
        concurrency: Number(kitchenRows[0]?.concurrency) || 2,
        cookingCount: batchRows.filter(row => row.status === 'cooking').length,
        waitingCount: waitingRows.length,
        staleCount: tables.filter(table => table.kitchenStale).length,
        staleAfterMinutes,
        automationEnabled: kitchenRows[0]?.automationEnabled !== 0,
        paused: Boolean(kitchenRows[0]?.paused),
      },
    });
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}));

// Lưu order, chuẩn hóa catalog và điều phối FIFO trong cùng một transaction.
app.put('/api/orders/:tableId', requireDatabase, asyncRoute(async (req, res) => {
  const validatedItems = validateOrderItems(req.body?.items);
  const append = req.body?.append === true;
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    await lockKitchenQueue(connection);
    const [tables] = await connection.query(
      `SELECT t.id, t.status, o.id AS orderId, o.items AS orderItems,
        o.estimated_cook_minutes AS orderEstimatedCookMinutes
       FROM restaurant_tables t
       LEFT JOIN active_orders o ON o.table_id = t.id
       WHERE t.id = ? FOR UPDATE`,
      [req.params.tableId],
    );
    const table = tables[0];
    if (!table) throw httpError(404, 'TABLE_NOT_FOUND', 'Không tìm thấy bàn.');
    if (table.status === 'reserved') throw httpError(409, 'TABLE_RESERVED', 'Bàn đang được đặt trước.');

    if (table.orderId && !append) {
      throw httpError(409, 'ORDER_ALREADY_EXISTS', 'Bàn đã có order. Hãy dùng chế độ gọi thêm món.');
    }

    const items = await canonicalizeOrderItems(connection, validatedItems);
    const estimatedCookMinutes = estimateCookMinutes(items);
    let orderId;
    let batchNumber = 1;
    const isAddition = Boolean(table.orderId);
    if (table.orderId) {
      const existingItems = parseJsonColumn(table.orderItems, []);
      if (existingItems.length + items.length > 500) {
        throw httpError(400, 'ORDER_TOO_LARGE', 'Order của bàn vượt quá 500 dòng món.');
      }
      const existingCartIds = new Set(existingItems.map(item => item.cartId));
      if (items.some(item => existingCartIds.has(item.cartId))) {
        throw httpError(409, 'DUPLICATE_CART_ITEM', 'Lượt gọi thêm chứa món đã có trong order trước.');
      }
      orderId = Number(table.orderId);
      const [batchNumbers] = await connection.query(
        'SELECT COALESCE(MAX(batch_number), 0) + 1 AS nextBatchNumber FROM order_batches WHERE order_id = ?',
        [orderId],
      );
      batchNumber = Number(batchNumbers[0].nextBatchNumber);
      await connection.query(
        `UPDATE active_orders SET items = ?, estimated_cook_minutes = GREATEST(estimated_cook_minutes, ?),
          updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [JSON.stringify([...existingItems, ...items]), estimatedCookMinutes, orderId],
      );
    } else {
      const [orderResult] = await connection.query(
        'INSERT INTO active_orders (table_id, items, estimated_cook_minutes) VALUES (?, ?, ?)',
        [table.id, JSON.stringify(items), estimatedCookMinutes],
      );
      orderId = Number(orderResult.insertId);
    }

    const [batchResult] = await connection.query(
      `INSERT INTO order_batches (
        order_id, table_id, batch_number, items, status, is_addition, estimated_cook_minutes
      ) VALUES (?, ?, ?, ?, 'waiting', ?, ?)`,
      [orderId, table.id, batchNumber, JSON.stringify(items), isAddition, estimatedCookMinutes],
    );
    await promoteKitchenQueue(connection);
    await syncTableStatuses(connection, [table.id]);
    const [batches] = await connection.query(
      `SELECT status, queued_at AS queuedAt, cooking_started_at AS cookingStartedAt
       FROM order_batches WHERE id = ?`,
      [batchResult.insertId],
    );
    await connection.commit();
    res.json({
      ok: true,
      orderNumber: orderId,
      batchId: Number(batchResult.insertId),
      batchNumber,
      isAddition,
      status: batches[0].status,
      queuedAt: new Date(batches[0].queuedAt).toISOString(),
      ...(batches[0].cookingStartedAt ? { cookingStartedAt: new Date(batches[0].cookingStartedAt).toISOString() } : {}),
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

// Chỉ sửa đúng một phiếu bếp còn chờ; các phiếu đã nấu và vị trí FIFO được giữ nguyên.
app.put('/api/orders/:tableId/batches/:batchId', requireDatabase, asyncRoute(async (req, res) => {
  const validatedItems = validateOrderItems(req.body?.items);
  const batchId = boundedInteger(req.params.batchId, 'batchId', 1, Number.MAX_SAFE_INTEGER);
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    await lockKitchenQueue(connection);
    const [tables] = await connection.query(
      `SELECT t.id, o.id AS orderId
       FROM restaurant_tables t
       LEFT JOIN active_orders o ON o.table_id = t.id
       WHERE t.id = ? FOR UPDATE`,
      [req.params.tableId],
    );
    const table = tables[0];
    if (!table) throw httpError(404, 'TABLE_NOT_FOUND', 'Không tìm thấy bàn.');
    if (!table.orderId) throw httpError(409, 'ORDER_NOT_FOUND', 'Bàn chưa có order.');

    const [batches] = await connection.query(
      `SELECT id AS batchId, batch_number AS batchNumber, items, status,
        is_addition AS isAddition, queued_at AS queuedAt,
        estimated_cook_minutes AS estimatedCookMinutes
       FROM order_batches
       WHERE order_id = ? AND table_id = ?
       ORDER BY batch_number, id FOR UPDATE`,
      [table.orderId, table.id],
    );
    const targetBatch = batches.find(batch => Number(batch.batchId) === batchId);
    if (!targetBatch) throw httpError(404, 'ORDER_BATCH_NOT_FOUND', 'Không tìm thấy phiếu bếp của bàn này.');
    if (targetBatch.status !== 'waiting') {
      throw httpError(409, 'ORDER_BATCH_NOT_WAITING', 'Phiếu bếp đã bắt đầu nấu hoặc đã xong nên không thể sửa.');
    }

    const items = await canonicalizeOrderItems(connection, validatedItems);
    const incomingCartIds = new Set();
    for (const item of items) {
      if (incomingCartIds.has(item.cartId)) {
        throw httpError(409, 'DUPLICATE_CART_ITEM', 'Phiếu bếp chứa mã dòng món bị trùng.');
      }
      incomingCartIds.add(item.cartId);
    }
    const otherItems = batches
      .filter(batch => Number(batch.batchId) !== batchId)
      .flatMap(batch => parseJsonColumn(batch.items, []));
    const otherCartIds = new Set(otherItems.map(item => item.cartId));
    if (items.some(item => otherCartIds.has(item.cartId))) {
      throw httpError(409, 'DUPLICATE_CART_ITEM', 'Phiếu sửa chứa món đã thuộc một lượt gọi khác.');
    }
    if (otherItems.length + items.length > 500) {
      throw httpError(400, 'ORDER_TOO_LARGE', 'Order của bàn vượt quá 500 dòng món.');
    }

    const estimatedCookMinutes = estimateCookMinutes(items);
    await connection.query(
      `UPDATE order_batches SET items = ?, estimated_cook_minutes = ?
       WHERE id = ? AND table_id = ? AND status = 'waiting'`,
      [JSON.stringify(items), estimatedCookMinutes, batchId, table.id],
    );
    const aggregateItems = batches.flatMap(batch => (
      Number(batch.batchId) === batchId ? items : parseJsonColumn(batch.items, [])
    ));
    const aggregateEta = Math.max(
      estimatedCookMinutes,
      ...batches
        .filter(batch => Number(batch.batchId) !== batchId)
        .map(batch => Number(batch.estimatedCookMinutes) || 1),
    );
    await connection.query(
      'UPDATE active_orders SET items = ?, estimated_cook_minutes = ? WHERE id = ?',
      [JSON.stringify(aggregateItems), aggregateEta, table.orderId],
    );
    await syncTableStatuses(connection, [table.id]);
    await connection.commit();
    res.json({
      ok: true,
      edited: true,
      orderNumber: Number(table.orderId),
      batchId,
      batchNumber: Number(targetBatch.batchNumber),
      isAddition: Boolean(targetBatch.isAddition),
      status: 'waiting',
      queuedAt: new Date(targetBatch.queuedAt).toISOString(),
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
      `SELECT t.id, t.status, t.reserved_time AS reservedTime, o.id AS orderId FROM restaurant_tables t
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
    if (hasOrder && status !== rows[0].status) {
      throw httpError(
        409,
        'ORDER_STATUS_ACTION_REQUIRED',
        'Trạng thái order do hàng đợi bếp quản lý. Hãy dùng thao tác hoàn tất hoặc đưa lại vào hàng chờ.',
      );
    }
    if (hasOrder) {
      await connection.query(
        'UPDATE restaurant_tables SET table_number = ?, seats = ? WHERE id = ?',
        [number, seats, req.params.tableId],
      );
    } else {
      await connection.query(
        'UPDATE restaurant_tables SET table_number = ?, seats = ?, status = ?, reserved_time = ? WHERE id = ?',
        [number, seats, status, reservedTime, req.params.tableId],
      );
    }
    const [updatedTables] = await connection.query('SELECT status FROM restaurant_tables WHERE id = ?', [req.params.tableId]);
    await connection.commit();
    const effectiveReservedTime = hasOrder ? rows[0].reservedTime : reservedTime;
    res.json({ table: { id: req.params.tableId, number, seats, status: updatedTables[0].status, ...(effectiveReservedTime ? { reservedTime: effectiveReservedTime } : {}) } });
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}));

app.delete('/api/tables/:tableId', requireDatabase, asyncRoute(async (req, res) => {
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    await lockKitchenQueue(connection);
    const [rows] = await connection.query(
      `SELECT t.id, o.id AS orderId
       FROM restaurant_tables t
       LEFT JOIN active_orders o ON o.table_id = t.id
       WHERE t.id = ? FOR UPDATE`,
      [req.params.tableId],
    );
    if (!rows[0]) throw httpError(404, 'TABLE_NOT_FOUND', 'Không tìm thấy bàn.');
    if (rows[0].orderId) throw httpError(409, 'TABLE_HAS_ORDER', 'Không thể xóa bàn đang có order.');
    await connection.query('DELETE FROM restaurant_tables WHERE id = ?', [req.params.tableId]);
    await connection.commit();
    res.json({ ok: true });
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}));

app.post('/api/orders/:tableId/requeue', requireDatabase, asyncRoute(async (req, res) => {
  const expectedBatchId = boundedInteger(req.body?.expectedBatchId, 'expectedBatchId', 1, Number.MAX_SAFE_INTEGER);
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    await lockKitchenQueue(connection);
    const [rows] = await connection.query(
      `SELECT t.id, o.id AS orderId FROM restaurant_tables t
       LEFT JOIN active_orders o ON o.table_id = t.id WHERE t.id = ? FOR UPDATE`,
      [req.params.tableId],
    );
    const table = rows[0];
    if (!table) throw httpError(404, 'TABLE_NOT_FOUND', 'Không tìm thấy bàn.');
    if (!table.orderId) throw httpError(409, 'ORDER_NOT_FOUND', 'Bàn chưa có order.');
    const [cookingBatches] = await connection.query(
      `SELECT id FROM order_batches
       WHERE table_id = ? AND id = ? AND status = 'cooking' FOR UPDATE`,
      [table.id, expectedBatchId],
    );
    if (!cookingBatches[0]) {
      throw httpError(409, 'ORDER_BATCH_CHANGED', 'Phiếu đang nấu đã thay đổi. Hãy tải lại trạng thái bàn.');
    }
    await connection.query(
      `UPDATE order_batches SET status = 'waiting', queued_at = CURRENT_TIMESTAMP(3),
        cooking_started_at = NULL, completed_at = NULL WHERE id = ?`,
      [cookingBatches[0].id],
    );
    await promoteKitchenQueue(connection);
    await syncTableStatuses(connection, [table.id]);
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
    const [orders] = await connection.query(
      'SELECT id FROM active_orders WHERE table_id = ? FOR UPDATE',
      [table.id],
    );
    if (!orders[0]) throw httpError(409, 'ORDER_NOT_FOUND', 'Bàn chưa có order.');
    const [batches] = await connection.query(
      'SELECT id, status FROM order_batches WHERE table_id = ? ORDER BY id FOR UPDATE',
      [table.id],
    );
    if (!canCancelOrder(batches)) {
      throw httpError(409, 'ORDER_NOT_WAITING', 'Chỉ có thể hủy khi toàn bộ lượt gọi của order còn đang chờ.');
    }
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
  if (nextStatus !== 'done') throw httpError(400, 'VALIDATION_ERROR', 'Chỉ hỗ trợ hoàn tất lượt đang nấu.');
  const expectedBatchId = boundedInteger(req.body?.expectedBatchId, 'expectedBatchId', 1, Number.MAX_SAFE_INTEGER);
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
    const [orders] = await connection.query('SELECT id FROM active_orders WHERE table_id = ?', [table.id]);
    if (orders.length === 0) throw httpError(409, 'ORDER_NOT_FOUND', 'Bàn chưa có order.');
    const [batches] = await connection.query(
      `SELECT id FROM order_batches
       WHERE table_id = ? AND id = ? AND status = 'cooking' FOR UPDATE`,
      [table.id, expectedBatchId],
    );
    if (!batches[0]) {
      throw httpError(409, 'ORDER_BATCH_CHANGED', 'Phiếu đang nấu đã thay đổi. Hãy tải lại trạng thái bàn.');
    }
    await connection.query(
      "UPDATE order_batches SET status = 'done', completed_at = CURRENT_TIMESTAMP(3) WHERE id = ?",
      [batches[0].id],
    );
    await promoteKitchenQueue(connection);
    await syncTableStatuses(connection, [table.id]);
    const [updatedTables] = await connection.query('SELECT status FROM restaurant_tables WHERE id = ?', [table.id]);
    await connection.commit();
    res.json({ ok: true, status: updatedTables[0].status, completedBatchId: Number(batches[0].id) });
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}));

/** Tổng hợp trực tiếp trên hóa đơn đã thanh toán, không dùng order đang mở làm số liệu bán hàng. */
app.get('/api/reports/summary', requireDatabase, asyncRoute(async (req, res) => {
  if (typeof req.query.from !== 'string' || typeof req.query.to !== 'string') {
    throw httpError(400, 'INVALID_DATE_RANGE', 'Khoảng thời gian báo cáo không hợp lệ.');
  }
  const from = new Date(req.query.from);
  const to = new Date(req.query.to);
  const duration = to.getTime() - from.getTime();
  const timezoneOffsetMinutes = req.query.timezoneOffsetMinutes == null
    ? 0
    : boundedInteger(req.query.timezoneOffsetMinutes, 'timezoneOffsetMinutes', -840, 840);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || duration <= 0 || duration > 366 * 24 * 60 * 60 * 1000) {
    throw httpError(400, 'INVALID_DATE_RANGE', 'Khoảng báo cáo phải lớn hơn 0 và không vượt quá 366 ngày.');
  }

  const connection = await getPool().getConnection();
  try {
    await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await connection.query('START TRANSACTION READ ONLY');
    const range = [from, to];
    const [totalRows] = await connection.query(
      `SELECT COALESCE(SUM(total), 0) AS revenue, COUNT(*) AS orders,
        COALESCE(SUM(item_count), 0) AS itemCount
       FROM payment_transactions WHERE paid_at >= ? AND paid_at < ?`,
      range,
    );
    const [hourlyRows] = await connection.query(
      `SELECT localHour AS hour, COALESCE(SUM(total), 0) AS revenue, COUNT(*) AS orders
       FROM (
         SELECT HOUR(DATE_ADD(paid_at, INTERVAL ? MINUTE)) AS localHour, total
         FROM payment_transactions WHERE paid_at >= ? AND paid_at < ?
       ) scoped
       GROUP BY localHour ORDER BY localHour`,
      [timezoneOffsetMinutes, ...range],
    );
    const [methodRows] = await connection.query(
      `SELECT payment_method AS method, COALESCE(SUM(total), 0) AS revenue, COUNT(*) AS orders
       FROM payment_transactions WHERE paid_at >= ? AND paid_at < ?
       GROUP BY payment_method ORDER BY revenue DESC`,
      range,
    );
    const [topItemRows] = await connection.query(
      `SELECT COALESCE(pi.menu_item_id, CONCAT('legacy:', pi.name)) AS id, pi.name,
        SUM(pi.quantity) AS quantity, SUM(pi.quantity * pi.price) AS revenue
       FROM payment_items pi
       INNER JOIN payment_transactions pt ON pt.id = pi.transaction_id
       WHERE pt.paid_at >= ? AND pt.paid_at < ?
       GROUP BY COALESCE(pi.menu_item_id, CONCAT('legacy:', pi.name)), pi.name
       ORDER BY quantity DESC, revenue DESC, pi.name LIMIT 10`,
      range,
    );
    const [categoryRows] = await connection.query(
      `SELECT COALESCE(pi.category_id, 'uncategorized') AS id,
        COALESCE(pi.category_name, 'Khác') AS name,
        SUM(pi.quantity) AS quantity, SUM(pi.quantity * pi.price) AS revenue
       FROM payment_items pi
       INNER JOIN payment_transactions pt ON pt.id = pi.transaction_id
       WHERE pt.paid_at >= ? AND pt.paid_at < ?
       GROUP BY COALESCE(pi.category_id, 'uncategorized'), COALESCE(pi.category_name, 'Khác')
       ORDER BY revenue DESC, quantity DESC, name`,
      range,
    );
    const [staffRows] = await connection.query(
      `SELECT pt.staff_id AS employeeId,
        CASE WHEN pt.staff_id IS NULL THEN 'Chưa gán nhân viên'
          ELSE COALESCE(MAX(e.full_name), MAX(NULLIF(pt.staff_name, '')), 'Nhân viên') END AS name,
        COALESCE(SUM(pt.total), 0) AS revenue, COUNT(*) AS orders,
        COALESCE(SUM(pt.item_count), 0) AS itemCount
       FROM payment_transactions pt
       LEFT JOIN employees e ON e.id = pt.staff_id
       WHERE pt.paid_at >= ? AND pt.paid_at < ?
       GROUP BY pt.staff_id
       ORDER BY revenue DESC, orders DESC, name`,
      range,
    );
    await connection.commit();

    const totals = {
      revenue: Number(totalRows[0]?.revenue) || 0,
      orders: Number(totalRows[0]?.orders) || 0,
      itemCount: Number(totalRows[0]?.itemCount) || 0,
    };
    res.json({
      range: { from: from.toISOString(), to: to.toISOString(), timezoneOffsetMinutes },
      totals: {
        ...totals,
        averageBill: totals.orders ? Math.round(totals.revenue / totals.orders) : 0,
      },
      hourly: hourlyRows.map(row => ({ hour: Number(row.hour), revenue: Number(row.revenue), orders: Number(row.orders) })),
      paymentMethods: methodRows.map(row => ({ method: row.method, revenue: Number(row.revenue), orders: Number(row.orders) })),
      topItems: topItemRows.map(row => ({ id: row.id, name: row.name, quantity: Number(row.quantity), revenue: Number(row.revenue) })),
      categories: categoryRows.map(row => ({ id: row.id, name: row.name, quantity: Number(row.quantity), revenue: Number(row.revenue) })),
      staff: staffRows.map(row => ({
        ...(row.employeeId ? { employeeId: row.employeeId } : {}),
        name: row.name,
        revenue: Number(row.revenue),
        orders: Number(row.orders),
        itemCount: Number(row.itemCount),
      })),
    });
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

    // Retry sau timeout phải trả đúng giao dịch đã commit, kể cả active order đã được đóng.
    if (typeof draft?.invoiceCode === 'string' && draft.invoiceCode) {
      const [existingRows] = await connection.query(
        `${paymentSelect('WHERE invoice_code = ?')} LIMIT 1 FOR UPDATE`,
        [draft.invoiceCode],
      );
      const existing = existingRows[0];
      if (existing) {
        const requestedEmployeeId = typeof draft.employeeId === 'string' && draft.employeeId
          ? draft.employeeId
          : null;
        const sameRequest = existing.tableId === tableId
          && existing.method === draft.method
          && existing.transactionCode === draft.transactionCode
          && (existing.employeeId ?? null) === requestedEmployeeId;
        if (!sameRequest) throw httpError(409, 'DUPLICATE_INVOICE', 'Mã hóa đơn đã được dùng cho một giao dịch khác.');
        await connection.commit();
        res.json({ ok: true, id: existing.id, payment: existing, idempotent: true });
        return;
      }
    }

    const [tables] = await connection.query(
      'SELECT id, table_number AS number, status FROM restaurant_tables WHERE id = ? FOR UPDATE',
      [tableId],
    );
    const table = tables[0];
    if (!table) throw httpError(404, 'TABLE_NOT_FOUND', 'Không tìm thấy bàn.');

    const [orders] = await connection.query('SELECT items FROM active_orders WHERE table_id = ? FOR UPDATE', [tableId]);
    if (!orders[0]) throw httpError(409, 'ORDER_NOT_FOUND', 'Order đã được thanh toán hoặc không còn tồn tại.');
    const [batches] = await connection.query(
      'SELECT id, status FROM order_batches WHERE table_id = ? ORDER BY id FOR UPDATE',
      [tableId],
    );
    if (!canSettleOrder(batches)) {
      throw httpError(409, 'ORDER_NOT_READY_FOR_PAYMENT', 'Chỉ thanh toán sau khi bếp hoàn tất tất cả lượt gọi của bàn.');
    }
    const items = validateOrderItems(parseJsonColumn(orders[0].items, []), { maxItems: 500 });

    const [settingsRows] = await connection.query('SELECT settings FROM restaurant_settings WHERE id = 1 LIMIT 1');
    const settings = sanitizeSettings(parseJsonColumn(settingsRows[0]?.settings, defaultSettings), defaultSettings);
    let selectedEmployee = null;
    if (typeof draft?.employeeId === 'string' && draft.employeeId) {
      const [employeeRows] = await connection.query(
        'SELECT id, full_name AS name, role, active FROM employees WHERE id = ? LIMIT 1',
        [draft.employeeId],
      );
      selectedEmployee = employeeRows[0];
      if (!selectedEmployee || !selectedEmployee.active) {
        throw httpError(409, 'EMPLOYEE_UNAVAILABLE', 'Nhân viên phục vụ không tồn tại hoặc đã ngừng làm việc.');
      }
      if (selectedEmployee.role !== 'server') {
        throw httpError(409, 'EMPLOYEE_ROLE_INVALID', 'Chỉ nhân viên có vai trò Phục vụ mới được gán cho bàn.');
      }
    }
    const payment = createPayment({
      draft,
      items,
      settings: selectedEmployee ? { ...settings, staffName: selectedEmployee.name } : settings,
      table,
    });
    if (selectedEmployee) payment.employeeId = selectedEmployee.id;

    const [result] = await connection.query(
      `INSERT INTO payment_transactions (
        invoice_code, transaction_code, table_id, table_number, payment_method,
        subtotal, discount, service_fee, vat, total, item_count, staff_id,
        staff_name, cashier_name, paid_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        payment.invoiceCode, payment.transactionCode, payment.tableId, payment.tableNumber, payment.method,
        payment.subtotal, payment.discount, payment.serviceFee, payment.vat, payment.total, payment.itemCount,
        payment.employeeId ?? null,
        payment.staffName, payment.cashierName, new Date(payment.paidAt),
      ],
    );

    const categoryIds = [...new Set(items.map(item => item.menuItem.categoryId).filter(Boolean))];
    const categoryNames = new Map();
    if (categoryIds.length > 0) {
      const categoryPlaceholders = categoryIds.map(() => '?').join(', ');
      const [categoryRows] = await connection.query(
        `SELECT id, name FROM menu_categories WHERE id IN (${categoryPlaceholders})`,
        categoryIds,
      );
      categoryRows.forEach(category => categoryNames.set(category.id, category.name));
    }
    const itemPlaceholders = items.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
    const itemValues = items.flatMap(item => [
      result.insertId,
      item.cartId,
      item.menuItem.id,
      item.menuItem.categoryId || null,
      categoryNames.get(item.menuItem.categoryId) || 'Khác',
      item.menuItem.name,
      item.quantity,
      item.menuItem.price + (item.selectedSize?.extraPrice ?? 0)
        + item.selectedToppings.reduce((sum, topping) => sum + topping.price, 0),
      item.note || null,
      JSON.stringify({ size: item.selectedSize?.label ?? null, toppings: item.selectedToppings.map(topping => topping.label) }),
    ]);
    await connection.query(
      `INSERT INTO payment_items (
        transaction_id, cart_id, menu_item_id, category_id, category_name,
        name, quantity, price, note, options_json
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
  if (isDatabaseConnectivityError(error)) markDatabaseUnavailable(error);
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
    markDatabaseUnavailable(error);
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

/**
 * Đồng hồ bếp phía server: tự hoàn tất batch đủ ETA và cấp slot FIFO kế tiếp.
 * Guard trong RAM chỉ chống chồng vòng tại một process; khóa MySQL vẫn bảo vệ nhiều instance.
 */
const kitchenCycleTimer = setInterval(async () => {
  if (!dbReady || kitchenCycleRunning) return;
  kitchenCycleRunning = true;
  try {
    await processKitchenQueue(getPool());
  } catch (error) {
    if (isDatabaseConnectivityError(error)) markDatabaseUnavailable(error);
    console.warn(`Kitchen timer cycle failed: ${error.message}`);
  } finally {
    kitchenCycleRunning = false;
  }
}, 1_000);
kitchenCycleTimer.unref();

/** Dừng nhận request mới và đóng pool trước khi thoát tiến trình. */
async function shutdown(signal) {
  console.log(`${signal} received, shutting down.`);
  clearInterval(retryTimer);
  clearInterval(kitchenCycleTimer);
  server.close(async () => {
    await closePool().catch(error => console.error(error));
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

export { app };
