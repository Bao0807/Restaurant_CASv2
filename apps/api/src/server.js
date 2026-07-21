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
import {
  businessDateFor,
  getDailyMenuAvailability,
  releaseDailyInventory,
  replaceDailyInventory,
  reserveDailyInventory,
} from './dailyInventory.js';
import { isKitchenOrderStale, lockKitchenQueue, processKitchenQueue, promoteKitchenQueue, syncTableStatuses } from './kitchenQueue.js';
import {
  canCancelOrder,
  canPayOrder,
  isOrderComplete,
  paymentRequiresDepartureConfirmation,
} from './orderPolicy.js';
import { canTransitionReservation, normalizeReservation, RESERVATION_STATUSES } from './reservation.js';

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

const DEFAULT_TABLE_AREA = 'Khu vực chung';

function normalizeTableArea(value, fallback = DEFAULT_TABLE_AREA) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string') {
    const error = httpError(400, 'VALIDATION_ERROR', 'Khu vực bàn không hợp lệ.');
    error.field = 'area';
    throw error;
  }
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized || normalized.length > 80) {
    const error = httpError(400, 'VALIDATION_ERROR', 'Tên khu vực cần có từ 1 đến 80 ký tự.');
    error.field = 'area';
    throw error;
  }
  return normalized;
}

function normalizeTablePosition(value, field) {
  if (value === null) return null;
  if (value === '' || typeof value === 'boolean') {
    const error = httpError(400, 'VALIDATION_ERROR', `${field} không hợp lệ.`);
    error.field = field;
    throw error;
  }
  return boundedInteger(value, field, 1, 24);
}

/** Chuẩn hóa vị trí bàn và buộc X/Y cùng có giá trị hoặc cùng để trống. */
function normalizeTableLayout(table, current = {}) {
  const hasPositionX = Object.prototype.hasOwnProperty.call(table ?? {}, 'positionX');
  const hasPositionY = Object.prototype.hasOwnProperty.call(table ?? {}, 'positionY');
  const positionX = hasPositionX
    ? normalizeTablePosition(table.positionX, 'positionX')
    : (current.positionX ?? null);
  const positionY = hasPositionY
    ? normalizeTablePosition(table.positionY, 'positionY')
    : (current.positionY ?? null);
  if ((positionX === null) !== (positionY === null)) {
    const error = httpError(400, 'VALIDATION_ERROR', 'Vị trí bàn cần có đủ cả tọa độ ngang và dọc.');
    error.field = hasPositionX ? 'positionY' : 'positionX';
    throw error;
  }
  return {
    area: normalizeTableArea(table?.area, current.area ?? DEFAULT_TABLE_AREA),
    positionX,
    positionY,
  };
}

function normalizeTableWriteError(error) {
  if (
    error?.code === 'ER_DUP_ENTRY'
    && /uq_restaurant_table_area_position/i.test(`${error.message ?? ''} ${error.sqlMessage ?? ''}`)
  ) {
    return httpError(
      409,
      'TABLE_POSITION_OCCUPIED',
      'Vị trí này đã có bàn khác trong cùng khu vực. Hãy chọn một ô trống.',
    );
  }
  return error;
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
      message: 'Dữ liệu tạm thời chưa sẵn sàng. Vui lòng thử lại sau.',
    });
    return;
  }
  next();
}

function paymentSelect(whereClause) {
  return `SELECT
    id AS databaseId,
    invoice_code AS id,
    invoice_code AS invoiceCode,
    transaction_code AS transactionCode,
    table_id AS tableId,
    table_number AS tableNumber,
    reservation_id AS reservationId,
    reservation_code AS reservationCode,
    customer_name AS customerName,
    guest_count AS guestCount,
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
    service_status AS serviceStatus,
    departure_confirmed_at AS departureConfirmedAt,
    paid_at AS paidAt
  FROM payment_transactions ${whereClause}`;
}

/** Giữ response thanh toán nhất quán cả khi client retry sau timeout. */
function paymentLifecycle(payment) {
  const requiresDepartureConfirmation = payment?.serviceStatus === 'awaiting_departure';
  return { requiresDepartureConfirmation, orderClosed: !requiresDepartureConfirmation };
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

function reservationSelect(whereClause = '') {
  return `SELECT r.id, r.reservation_code AS code, r.table_id AS tableId,
    r.table_number AS tableNumber, r.customer_name AS customerName,
    r.customer_phone AS customerPhone, r.phone_normalized AS phoneNormalized,
    r.party_size AS partySize, r.reserved_at AS reservedAt, r.ends_at AS endsAt,
    r.duration_minutes AS durationMinutes, r.status, r.version, r.notes,
    r.seated_at AS seatedAt, r.closed_at AS closedAt,
    r.created_at AS createdAt, r.updated_at AS updatedAt,
    t.seats AS tableSeats
    FROM reservations r
    LEFT JOIN restaurant_tables t ON t.id = r.table_id ${whereClause}`;
}

function serializeReservation(row) {
  return {
    ...row,
    id: Number(row.id),
    tableNumber: Number(row.tableNumber),
    partySize: Number(row.partySize),
    durationMinutes: Number(row.durationMinutes),
    version: Number(row.version),
    ...(row.tableSeats == null ? {} : { tableSeats: Number(row.tableSeats) }),
    reservedAt: new Date(row.reservedAt).toISOString(),
    endsAt: new Date(row.endsAt).toISOString(),
    ...(row.seatedAt ? { seatedAt: new Date(row.seatedAt).toISOString() } : {}),
    ...(row.closedAt ? { closedAt: new Date(row.closedAt).toISOString() } : {}),
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

/** Khóa bàn và chống hai reservation đang mở giao nhau trên cùng một khung giờ. */
async function assertReservationSlot(connection, reservation, excludeId = null) {
  const [tables] = await connection.query(
    'SELECT id, table_number AS number, seats FROM restaurant_tables WHERE id = ? FOR UPDATE',
    [reservation.tableId],
  );
  const table = tables[0];
  if (!table) throw httpError(404, 'TABLE_NOT_FOUND', 'Không tìm thấy bàn cần đặt.');
  if (reservation.partySize > Number(table.seats)) {
    throw httpError(409, 'TABLE_CAPACITY_EXCEEDED', `Bàn ${table.number} chỉ có ${table.seats} chỗ.`);
  }
  const params = [reservation.tableId, reservation.endsAt, reservation.reservedAt];
  let exclude = '';
  if (excludeId !== null) {
    exclude = 'AND id <> ?';
    params.push(excludeId);
  }
  const [conflicts] = await connection.query(
    `SELECT id, reservation_code AS code FROM reservations
     WHERE table_id = ? AND status IN ('booked', 'seated')
       AND reserved_at < ?
       AND ends_at > ?
       ${exclude}
     LIMIT 1 FOR UPDATE`,
    params,
  );
  if (conflicts[0]) {
    throw httpError(409, 'RESERVATION_CONFLICT', `Khung giờ này trùng với lịch ${conflicts[0].code}.`);
  }
  return table;
}

function reservationCode(reservedAt) {
  const date = reservedAt.toISOString().slice(0, 10).replaceAll('-', '');
  return `RSV-${date}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function parseReservationId(value) {
  return boundedInteger(value, 'reservationId', 1, Number.MAX_SAFE_INTEGER);
}

function parseExpectedVersion(value) {
  return boundedInteger(value, 'expectedVersion', 1, Number.MAX_SAFE_INTEGER);
}

/** Lấy lại một reservation trong transaction để response luôn phản ánh dữ liệu đã ghi. */
async function getReservationById(connection, id) {
  const [rows] = await connection.query(`${reservationSelect('WHERE r.id = ?')} LIMIT 1`, [id]);
  return rows[0] ? serializeReservation(rows[0]) : null;
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
    return callback(httpError(403, 'ORIGIN_NOT_ALLOWED', 'Địa chỉ truy cập này chưa được cho phép.'));
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

/** Danh sách đặt bàn có bộ lọc thời gian, trạng thái, bàn và tìm kiếm khách. */
app.get('/api/reservations', requireDatabase, asyncRoute(async (req, res) => {
  const clauses = [];
  const params = [];
  let parsedFrom = null;
  let parsedTo = null;
  if (req.query.from != null) {
    const from = new Date(String(req.query.from));
    if (Number.isNaN(from.getTime())) throw httpError(400, 'INVALID_DATE_RANGE', 'Ngày bắt đầu không hợp lệ.');
    parsedFrom = from;
    clauses.push('r.ends_at > ?');
    params.push(from);
  }
  if (req.query.to != null) {
    const to = new Date(String(req.query.to));
    if (Number.isNaN(to.getTime())) throw httpError(400, 'INVALID_DATE_RANGE', 'Ngày kết thúc không hợp lệ.');
    parsedTo = to;
    clauses.push('r.reserved_at < ?');
    params.push(to);
  }
  if (parsedFrom && parsedTo && parsedFrom >= parsedTo) {
    throw httpError(400, 'INVALID_DATE_RANGE', 'Ngày kết thúc phải sau ngày bắt đầu.');
  }
  if (req.query.status != null && req.query.status !== 'all') {
    const status = String(req.query.status);
    if (!RESERVATION_STATUSES.has(status)) throw httpError(400, 'VALIDATION_ERROR', 'Trạng thái đặt bàn không hợp lệ.');
    clauses.push('r.status = ?');
    params.push(status);
  }
  if (req.query.tableId != null) {
    const tableId = String(req.query.tableId).trim();
    if (!tableId || tableId.length > 32) throw httpError(400, 'VALIDATION_ERROR', 'Mã bàn không hợp lệ.');
    clauses.push('r.table_id = ?');
    params.push(tableId);
  }
  if (req.query.q != null) {
    const query = String(req.query.q).trim();
    if (query.length > 120) throw httpError(400, 'VALIDATION_ERROR', 'Từ khóa tìm kiếm quá dài.');
    if (query) {
      const phoneQuery = query.replace(/\D/g, '');
      clauses.push(phoneQuery
        ? '(r.reservation_code LIKE ? OR r.customer_name LIKE ? OR r.phone_normalized LIKE ?)'
        : '(r.reservation_code LIKE ? OR r.customer_name LIKE ?)');
      const pattern = `%${query}%`;
      params.push(pattern, pattern);
      if (phoneQuery) params.push(`%${phoneQuery}%`);
    }
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const [rows] = await getPool().query(
    `${reservationSelect(where)} ORDER BY r.reserved_at ASC, r.id ASC LIMIT 1000`,
    params,
  );
  res.json({ reservations: rows.map(serializeReservation) });
}));

/** Gợi ý các bàn đủ chỗ và không giao lịch trong khung giờ yêu cầu. */
app.get('/api/reservations/availability', requireDatabase, asyncRoute(async (req, res) => {
  const reservedAt = new Date(String(req.query.reservedAt ?? ''));
  if (Number.isNaN(reservedAt.getTime())) throw httpError(400, 'VALIDATION_ERROR', 'Ngày giờ đặt bàn không hợp lệ.');
  const durationMinutes = boundedInteger(req.query.durationMinutes ?? 120, 'durationMinutes', 30, 480);
  const partySize = boundedInteger(req.query.partySize, 'partySize', 1, 100);
  const endsAt = new Date(reservedAt.getTime() + durationMinutes * 60_000);
  const [rows] = await getPool().query(
    `SELECT t.id, t.table_number AS number, t.seats
     FROM restaurant_tables t
     WHERE t.seats >= ? AND NOT EXISTS (
       SELECT 1 FROM reservations r
       WHERE r.table_id = t.id AND r.status IN ('booked', 'seated')
         AND r.reserved_at < ? AND r.ends_at > ?
     )
     ORDER BY t.seats, t.table_number`,
    [partySize, endsAt, reservedAt],
  );
  res.json({ tables: rows.map(row => ({ id: row.id, number: Number(row.number), seats: Number(row.seats) })) });
}));

app.post('/api/reservations', requireDatabase, asyncRoute(async (req, res) => {
  const reservation = normalizeReservation(req.body?.reservation);
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    const table = await assertReservationSlot(connection, reservation);
    const [result] = await connection.query(
      `INSERT INTO reservations (
        reservation_code, table_id, table_number, customer_name, customer_phone,
        phone_normalized, party_size, reserved_at, ends_at, duration_minutes, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        reservationCode(reservation.reservedAt), reservation.tableId, table.number,
        reservation.customerName, reservation.customerPhone, reservation.phoneNormalized,
        reservation.partySize, reservation.reservedAt, reservation.endsAt,
        reservation.durationMinutes, reservation.notes,
      ],
    );
    const saved = await getReservationById(connection, result.insertId);
    await connection.commit();
    res.status(201).json({ reservation: saved });
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}));

app.put('/api/reservations/:reservationId', requireDatabase, asyncRoute(async (req, res) => {
  const id = parseReservationId(req.params.reservationId);
  const expectedVersion = parseExpectedVersion(req.body?.expectedVersion);
  const reservation = normalizeReservation(req.body?.reservation);
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    const table = await assertReservationSlot(connection, reservation, id);
    const [rows] = await connection.query(
      'SELECT id, status, version FROM reservations WHERE id = ? FOR UPDATE',
      [id],
    );
    const current = rows[0];
    if (!current) throw httpError(404, 'RESERVATION_NOT_FOUND', 'Không tìm thấy lịch đặt bàn.');
    if (current.status !== 'booked') {
      throw httpError(409, 'RESERVATION_NOT_EDITABLE', 'Chỉ lịch đang chờ khách mới có thể chỉnh sửa.');
    }
    if (Number(current.version) !== expectedVersion) {
      throw httpError(409, 'RESERVATION_CHANGED', 'Lịch đã được thay đổi trên thiết bị khác. Hãy tải lại.');
    }
    await connection.query(
      `UPDATE reservations SET table_id = ?, table_number = ?, customer_name = ?,
        customer_phone = ?, phone_normalized = ?, party_size = ?, reserved_at = ?,
        ends_at = ?, duration_minutes = ?, notes = ?, version = version + 1
       WHERE id = ?`,
      [
        reservation.tableId, table.number, reservation.customerName, reservation.customerPhone,
        reservation.phoneNormalized, reservation.partySize, reservation.reservedAt,
        reservation.endsAt, reservation.durationMinutes, reservation.notes, id,
      ],
    );
    const saved = await getReservationById(connection, id);
    await connection.commit();
    res.json({ reservation: saved });
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}));

app.patch('/api/reservations/:reservationId/status', requireDatabase, asyncRoute(async (req, res) => {
  const id = parseReservationId(req.params.reservationId);
  const expectedVersion = parseExpectedVersion(req.body?.expectedVersion);
  const nextStatus = String(req.body?.status ?? '');
  if (!RESERVATION_STATUSES.has(nextStatus)) {
    throw httpError(400, 'VALIDATION_ERROR', 'Trạng thái đặt bàn không hợp lệ.');
  }
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    const [hints] = await connection.query('SELECT table_id AS tableId FROM reservations WHERE id = ?', [id]);
    if (!hints[0]) throw httpError(404, 'RESERVATION_NOT_FOUND', 'Không tìm thấy lịch đặt bàn.');
    if (hints[0].tableId) {
      await connection.query('SELECT id FROM restaurant_tables WHERE id = ? FOR UPDATE', [hints[0].tableId]);
    }
    const [rows] = await connection.query(
      `SELECT id, table_id AS tableId, status, version, reserved_at AS reservedAt,
        ends_at AS endsAt, CURRENT_TIMESTAMP(3) AS serverNow
       FROM reservations WHERE id = ? FOR UPDATE`,
      [id],
    );
    const current = rows[0];
    if (!current) throw httpError(404, 'RESERVATION_NOT_FOUND', 'Không tìm thấy lịch đặt bàn.');
    if (Number(current.version) !== expectedVersion) {
      throw httpError(409, 'RESERVATION_CHANGED', 'Lịch đã được thay đổi trên thiết bị khác. Hãy tải lại.');
    }
    if (!canTransitionReservation(current.status, nextStatus)) {
      throw httpError(409, 'RESERVATION_TRANSITION_INVALID', 'Không thể chuyển lịch sang trạng thái này.');
    }

    const serverNow = new Date(current.serverNow);
    if (nextStatus === 'seated') {
      if (!current.tableId) throw httpError(409, 'RESERVATION_TABLE_MISSING', 'Lịch không còn liên kết với bàn.');
      if (serverNow.getTime() < new Date(current.reservedAt).getTime() - 60 * 60_000) {
        throw httpError(409, 'RESERVATION_TOO_EARLY', 'Chỉ có thể nhận bàn sớm tối đa 60 phút.');
      }
      if (serverNow >= new Date(current.endsAt)) {
        throw httpError(409, 'RESERVATION_EXPIRED', 'Khung giờ đặt bàn đã kết thúc. Hãy đánh dấu vắng mặt.');
      }
      const [otherSeated] = await connection.query(
        `SELECT id, reservation_code AS code FROM reservations
         WHERE table_id = ? AND status = 'seated' AND id <> ?
         LIMIT 1 FOR UPDATE`,
        [current.tableId, id],
      );
      if (otherSeated[0]) {
        throw httpError(
          409,
          'TABLE_HAS_SEATED_RESERVATION',
          `Bàn vẫn đang phục vụ lịch ${otherSeated[0].code}. Hãy hoàn tất lịch đó trước khi check-in khách mới.`,
        );
      }
      const [orders] = await connection.query(
        'SELECT id FROM active_orders WHERE table_id = ? FOR UPDATE',
        [current.tableId],
      );
      if (orders[0]) throw httpError(409, 'TABLE_HAS_ORDER', 'Bàn đang phục vụ khách khác nên chưa thể nhận lịch này.');
    }
    if (nextStatus === 'no_show' && serverNow.getTime() < new Date(current.reservedAt).getTime() + 15 * 60_000) {
      throw httpError(409, 'RESERVATION_NO_SHOW_TOO_EARLY', 'Chỉ đánh dấu vắng sau giờ hẹn 15 phút.');
    }
    if (nextStatus === 'completed' && current.tableId) {
      const [orders] = await connection.query(
        'SELECT id FROM active_orders WHERE table_id = ? FOR UPDATE',
        [current.tableId],
      );
      if (orders[0]) {
        throw httpError(409, 'RESERVATION_HAS_ORDER', 'Hãy hoàn tất lượt phục vụ của bàn trước khi kết thúc lịch đặt bàn.');
      }
    }

    const isSeated = nextStatus === 'seated';
    const isClosed = ['cancelled', 'no_show', 'completed'].includes(nextStatus);
    await connection.query(
      `UPDATE reservations SET status = ?, version = version + 1,
        seated_at = CASE WHEN ? THEN CURRENT_TIMESTAMP(3) ELSE seated_at END,
        closed_at = CASE WHEN ? THEN CURRENT_TIMESTAMP(3) ELSE closed_at END,
        seated_table_id = CASE WHEN ? THEN table_id WHEN ? THEN NULL ELSE seated_table_id END
       WHERE id = ?`,
      [nextStatus, isSeated, isClosed, isSeated, isClosed, id],
    );
    const saved = await getReservationById(connection, id);
    await connection.commit();
    res.json({ reservation: saved });
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
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
        t.area,
        t.position_x AS positionX,
        t.position_y AS positionY,
        o.id AS orderNumber,
        o.items,
        aop.transaction_id AS paidTransactionId,
        pt.invoice_code AS paymentId,
        pt.paid_at AS paidAt,
        pt.total AS paidTotal
      FROM restaurant_tables t
      LEFT JOIN active_orders o ON o.table_id = t.id
      LEFT JOIN active_order_payments aop ON aop.order_id = o.id
      LEFT JOIN payment_transactions pt ON pt.id = aop.transaction_id
      ORDER BY t.table_number`,
    );
    const [batchRows] = await connection.query(
      `SELECT id AS batchId, order_id AS orderId, table_id AS tableId,
        batch_number AS batchNumber, items, status, is_addition AS isAddition,
        queued_at AS queuedAt, cooking_started_at AS cookingStartedAt,
        completed_at AS completedAt, estimated_cook_minutes AS estimatedCookMinutes,
        DATE_FORMAT(inventory_date, '%Y-%m-%d') AS inventoryDate
       FROM order_batches
       ORDER BY queued_at, id`,
    );
    const [kitchenRows] = await connection.query(
      `SELECT concurrency, stale_after_minutes AS staleAfterMinutes,
        automation_enabled AS automationEnabled, paused, version
       FROM kitchen_queue_state WHERE id = 1 LIMIT 1`,
    );
    const [clockRows] = await connection.query('SELECT CURRENT_TIMESTAMP(3) AS serverNow');
    const [reservationRows] = await connection.query(
      `SELECT id, code, tableId, customerName, partySize, reservedAt, endsAt, status
       FROM (
         SELECT id, reservation_code AS code, table_id AS tableId,
           customer_name AS customerName, party_size AS partySize,
           reserved_at AS reservedAt, ends_at AS endsAt, status,
           ROW_NUMBER() OVER (
             PARTITION BY table_id
             ORDER BY CASE WHEN status = 'seated' THEN 0 ELSE 1 END, reserved_at, id
           ) AS rowNumber
         FROM reservations
         WHERE table_id IS NOT NULL AND status IN ('booked', 'seated')
           AND (
             status = 'seated'
             OR (ends_at > DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 15 MINUTE)
               AND reserved_at < DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 90 DAY))
           )
       ) ranked
      WHERE rowNumber = 1`,
    );
    const menuAvailability = await getDailyMenuAvailability(connection);
    await connection.commit();

    const staleAfterMinutes = Number(kitchenRows[0]?.staleAfterMinutes) || kitchenStaleMinutes;
    const serverNow = new Date(clockRows[0].serverNow);
    const tableOrders = {};
    const waitingBatchesByTable = {};
    const waitingRows = batchRows
      .filter(row => row.status === 'waiting')
      .sort((left, right) => {
        const timeDifference = new Date(left.queuedAt).getTime() - new Date(right.queuedAt).getTime();
        return timeDifference || Number(left.batchId) - Number(right.batchId);
      });
    const queuePositions = new Map(waitingRows.map((row, index) => [Number(row.batchId), index + 1]));
    const tableRowsById = new Map(rows.map(row => [row.id, row]));
    const staleBatches = batchRows
      .filter(batch => batch.status === 'cooking' && isKitchenOrderStale(
        batch.cookingStartedAt,
        Number(batch.estimatedCookMinutes),
        staleAfterMinutes,
        serverNow.getTime(),
      ))
      .map(batch => {
        const tableRow = tableRowsById.get(batch.tableId);
        return {
          batchId: Number(batch.batchId),
          batchNumber: Number(batch.batchNumber),
          tableId: batch.tableId,
          tableNumber: Number(tableRow?.number ?? 0),
          orderNumber: Number(batch.orderId),
          isAddition: Boolean(batch.isAddition),
          cookingStartedAt: new Date(batch.cookingStartedAt).toISOString(),
          estimatedCookMinutes: Number(batch.estimatedCookMinutes),
        };
      });
    const staleTableIds = new Set(staleBatches.map(batch => batch.tableId));
    const batchesByTable = batchRows.reduce((result, batch) => {
      const current = result.get(batch.tableId) ?? [];
      current.push(batch);
      result.set(batch.tableId, current);
      return result;
    }, new Map());
    const reservationsByTable = reservationRows.reduce((result, reservation) => {
      const current = result.get(reservation.tableId) ?? [];
      current.push(reservation);
      result.set(reservation.tableId, current);
      return result;
    }, new Map());
    const tables = rows.map(row => {
      if (row.items != null) tableOrders[row.id] = parseJsonColumn(row.items, []);
      const batches = batchesByTable.get(row.id) ?? [];
      const cookingBatches = batches.filter(batch => batch.status === 'cooking');
      const waitingBatches = batches.filter(batch => batch.status === 'waiting');
      const doneBatches = batches.filter(batch => batch.status === 'done');
      const nextReservationRow = reservationsByTable.get(row.id)?.[0];
      if (waitingBatches.length > 0) {
        waitingBatchesByTable[row.id] = waitingBatches
          .sort((left, right) => Number(left.batchNumber) - Number(right.batchNumber))
          .map(batch => ({
            batchId: Number(batch.batchId),
            batchNumber: Number(batch.batchNumber),
            items: parseJsonColumn(batch.items, []),
            queuedAt: new Date(batch.queuedAt).toISOString(),
            estimatedCookMinutes: Number(batch.estimatedCookMinutes),
            inventoryDate: batch.inventoryDate,
          }));
      }
      const timerBatch = cookingBatches[0] ?? waitingBatches[0];
      const stale = staleTableIds.has(row.id);
      const queuePosition = waitingBatches.length
        ? Math.min(...waitingBatches.map(batch => queuePositions.get(Number(batch.batchId)) ?? Number.MAX_SAFE_INTEGER))
        : undefined;
      const reservationHoldsTable = !row.orderNumber && nextReservationRow && (
        nextReservationRow.status === 'seated'
        || (
          new Date(nextReservationRow.reservedAt).getTime() <= serverNow.getTime() + 15 * 60_000
          && new Date(nextReservationRow.endsAt).getTime() > serverNow.getTime()
        )
      );
      return {
        id: row.id,
        number: Number(row.number),
        seats: Number(row.seats),
        area: row.area,
        positionX: row.positionX == null ? null : Number(row.positionX),
        positionY: row.positionY == null ? null : Number(row.positionY),
        status: reservationHoldsTable ? 'reserved' : row.status === 'reserved' ? 'empty' : row.status,
        ...(nextReservationRow ? {
          nextReservation: {
            id: Number(nextReservationRow.id),
            code: nextReservationRow.code,
            customerName: nextReservationRow.customerName,
            partySize: Number(nextReservationRow.partySize),
            reservedAt: new Date(nextReservationRow.reservedAt).toISOString(),
            endsAt: new Date(nextReservationRow.endsAt).toISOString(),
            status: nextReservationRow.status,
          },
        } : {}),
        ...(row.orderNumber ? { orderNumber: Number(row.orderNumber) } : {}),
        isPaid: Boolean(row.paidTransactionId),
        ...(row.paymentId ? { paymentId: row.paymentId } : {}),
        ...(row.paidAt ? { paidAt: new Date(row.paidAt).toISOString() } : {}),
        ...(row.paidTotal != null ? { paidTotal: Number(row.paidTotal) } : {}),
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
      serverNow: serverNow.toISOString(),
      tables,
      tableOrders,
      waitingBatchesByTable,
      menuAvailability,
      kitchen: {
        concurrency: Number(kitchenRows[0]?.concurrency) || 2,
        cookingCount: batchRows.filter(row => row.status === 'cooking').length,
        waitingCount: waitingRows.length,
        staleCount: staleBatches.length,
        staleBatches,
        staleAfterMinutes,
        automationEnabled: kitchenRows[0]?.automationEnabled !== 0,
        paused: Boolean(kitchenRows[0]?.paused),
        version: Number(kitchenRows[0]?.version) || 1,
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
        o.estimated_cook_minutes AS orderEstimatedCookMinutes,
        aop.transaction_id AS paidTransactionId
       FROM restaurant_tables t
       LEFT JOIN active_orders o ON o.table_id = t.id
       LEFT JOIN active_order_payments aop ON aop.order_id = o.id
       WHERE t.id = ? FOR UPDATE`,
      [req.params.tableId],
    );
    const table = tables[0];
    if (!table) throw httpError(404, 'TABLE_NOT_FOUND', 'Không tìm thấy bàn.');

    if (table.paidTransactionId) {
      throw httpError(409, 'ORDER_ALREADY_PAID', 'Bàn đã thanh toán nên không thể gọi thêm món.');
    }
    if (table.orderId && !append) {
      throw httpError(409, 'ORDER_ALREADY_EXISTS', 'Bàn đã có món. Hãy dùng thao tác gọi thêm món.');
    }

    let reservationId = null;
    if (!table.orderId) {
      const [reservationRows] = await connection.query(
        `SELECT id, reservation_code AS code, status, reserved_at AS reservedAt,
          ends_at AS endsAt, CURRENT_TIMESTAMP(3) AS serverNow
         FROM reservations
         WHERE table_id = ? AND status IN ('booked', 'seated')
         ORDER BY CASE WHEN status = 'seated' THEN 0 ELSE 1 END, reserved_at, id
         FOR UPDATE`,
        [table.id],
      );
      const seatedReservations = reservationRows.filter(reservation => reservation.status === 'seated');
      if (seatedReservations.length > 1) {
        throw httpError(
          409,
          'TABLE_RESERVATION_STATE_INVALID',
          'Bàn có nhiều lịch đang nhận khách. Hãy hoàn tất lịch cũ trước khi gọi món.',
        );
      }
      const seatedReservation = seatedReservations[0];
      const now = new Date(reservationRows[0]?.serverNow ?? Date.now()).getTime();
      const heldBooking = reservationRows.find(reservation => (
        reservation.status === 'booked'
        && new Date(reservation.reservedAt).getTime() <= now + 15 * 60_000
        && new Date(reservation.endsAt).getTime() > now
      ));
      if (heldBooking && seatedReservation) {
        throw httpError(
          409,
          'TABLE_RESERVATION_STATE_INVALID',
          `Bàn vẫn còn lịch ${seatedReservation.code} đang phục vụ trong khi lịch ${heldBooking.code} đã đến giờ. Hãy kết thúc lịch cũ trước.`,
        );
      }
      if (heldBooking && !seatedReservation) {
        throw httpError(
          409,
          'TABLE_RESERVED',
          `Bàn đang được giữ cho lịch ${heldBooking.code}. Hãy check-in khách trước khi gọi món.`,
        );
      }
      reservationId = seatedReservation ? Number(seatedReservation.id) : null;
    }

    const inventoryDate = businessDateFor();
    const items = await canonicalizeOrderItems(connection, validatedItems, { inventoryDate, lock: true });
    const estimatedCookMinutes = estimateCookMinutes(items);
    const [queueClockRows] = await connection.query('SELECT CURRENT_TIMESTAMP(3) AS queuedAt');
    const batchQueuedAt = queueClockRows[0].queuedAt;
    let orderId;
    let batchNumber = 1;
    let existingItems = [];
    const isAddition = Boolean(table.orderId);
    if (table.orderId) {
      existingItems = parseJsonColumn(table.orderItems, []);
      if (existingItems.length + items.length > 500) {
        throw httpError(400, 'ORDER_TOO_LARGE', 'Lượt phục vụ của bàn vượt quá 500 dòng món.');
      }
      const existingCartIds = new Set(existingItems.map(item => item.cartId));
      if (items.some(item => existingCartIds.has(item.cartId))) {
        throw httpError(409, 'DUPLICATE_CART_ITEM', 'Lượt gọi thêm chứa món bị trùng với lượt trước.');
      }
      orderId = Number(table.orderId);
      const [batchNumbers] = await connection.query(
        'SELECT COALESCE(MAX(batch_number), 0) + 1 AS nextBatchNumber FROM order_batches WHERE order_id = ?',
        [orderId],
      );
      batchNumber = Number(batchNumbers[0].nextBatchNumber);
    }

    // Giữ hạn mức trước khi ghi order; mọi thay đổi cùng rollback nếu một món không đủ số phần.
    await reserveDailyInventory(connection, items, inventoryDate);

    if (table.orderId) {
      await connection.query(
        `UPDATE active_orders SET items = ?, estimated_cook_minutes = GREATEST(estimated_cook_minutes, ?),
          updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [JSON.stringify([...existingItems, ...items]), estimatedCookMinutes, orderId],
      );
    } else {
      const [orderResult] = await connection.query(
        `INSERT INTO active_orders (
          table_id, reservation_id, items, queued_at, estimated_cook_minutes
        ) VALUES (?, ?, ?, ?, ?)`,
        [table.id, reservationId, JSON.stringify(items), batchQueuedAt, estimatedCookMinutes],
      );
      orderId = Number(orderResult.insertId);
    }

    const [batchResult] = await connection.query(
      `INSERT INTO order_batches (
        order_id, table_id, batch_number, items, status, is_addition, queued_at,
        estimated_cook_minutes, inventory_date
      ) VALUES (?, ?, ?, ?, 'waiting', ?, ?, ?, ?)`,
      [orderId, table.id, batchNumber, JSON.stringify(items), isAddition, batchQueuedAt, estimatedCookMinutes, inventoryDate],
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
      inventoryDate,
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
      `SELECT t.id, o.id AS orderId, aop.transaction_id AS paidTransactionId
       FROM restaurant_tables t
       LEFT JOIN active_orders o ON o.table_id = t.id
       LEFT JOIN active_order_payments aop ON aop.order_id = o.id
       WHERE t.id = ? FOR UPDATE`,
      [req.params.tableId],
    );
    const table = tables[0];
    if (!table) throw httpError(404, 'TABLE_NOT_FOUND', 'Không tìm thấy bàn.');
    if (!table.orderId) throw httpError(409, 'ORDER_NOT_FOUND', 'Bàn chưa có món đang phục vụ.');
    if (table.paidTransactionId) {
      throw httpError(409, 'ORDER_ALREADY_PAID', 'Bàn đã thanh toán nên không thể sửa món.');
    }

    const [batches] = await connection.query(
      `SELECT id AS batchId, batch_number AS batchNumber, items, status,
        is_addition AS isAddition, queued_at AS queuedAt,
        estimated_cook_minutes AS estimatedCookMinutes,
        DATE_FORMAT(inventory_date, '%Y-%m-%d') AS inventoryDate
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

    const inventoryDate = businessDateFor();
    const items = await canonicalizeOrderItems(connection, validatedItems, { inventoryDate, lock: true });
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
      throw httpError(400, 'ORDER_TOO_LARGE', 'Lượt phục vụ của bàn vượt quá 500 dòng món.');
    }

    const estimatedCookMinutes = estimateCookMinutes(items);
    await replaceDailyInventory(
      connection,
      parseJsonColumn(targetBatch.items, []),
      targetBatch.inventoryDate,
      items,
      inventoryDate,
    );
    await connection.query(
      `UPDATE order_batches SET items = ?, estimated_cook_minutes = ?, inventory_date = ?
       WHERE id = ? AND table_id = ? AND status = 'waiting'`,
      [JSON.stringify(items), estimatedCookMinutes, inventoryDate, batchId, table.id],
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
      inventoryDate,
      items,
    });
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}));

// Optimistic concurrency ngăn hai máy POS ghi đè cấu hình bếp của nhau.
const updateKitchenConfig = asyncRoute(async (req, res) => {
  const expectedVersion = parseExpectedVersion(req.body?.expectedVersion);
  const has = field => Object.prototype.hasOwnProperty.call(req.body ?? {}, field);
  if (!['concurrency', 'staleAfterMinutes', 'automationEnabled', 'paused'].some(has)) {
    throw httpError(400, 'VALIDATION_ERROR', 'Không có thay đổi cấu hình bếp.');
  }
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    const current = await lockKitchenQueue(connection);
    if (current.version !== expectedVersion) {
      throw httpError(409, 'KITCHEN_CONFIG_CHANGED', 'Cấu hình bếp đã đổi trên thiết bị khác. Hãy tải lại.');
    }
    const concurrency = has('concurrency')
      ? boundedInteger(req.body.concurrency, 'concurrency', 1, 20)
      : current.concurrency;
    const staleAfterMinutes = has('staleAfterMinutes')
      ? boundedInteger(req.body.staleAfterMinutes, 'staleAfterMinutes', 15, 1_440)
      : current.staleAfterMinutes;
    const automationEnabled = has('automationEnabled')
      ? booleanValue(req.body.automationEnabled, 'automationEnabled')
      : current.automationEnabled;
    const paused = has('paused') ? booleanValue(req.body.paused, 'paused') : current.paused;
    await connection.query(
      `UPDATE kitchen_queue_state SET concurrency = ?, stale_after_minutes = ?,
        automation_enabled = ?, paused = ?, version = version + 1 WHERE id = 1`,
      [concurrency, staleAfterMinutes, automationEnabled, paused],
    );
    await promoteKitchenQueue(connection);
    const [savedRows] = await connection.query(
      `SELECT concurrency, stale_after_minutes AS staleAfterMinutes,
        automation_enabled AS automationEnabled, paused, version
       FROM kitchen_queue_state WHERE id = 1`,
    );
    await connection.commit();
    const saved = savedRows[0];
    res.json({
      concurrency: Number(saved.concurrency),
      staleAfterMinutes: Number(saved.staleAfterMinutes),
      automationEnabled: Boolean(saved.automationEnabled),
      paused: Boolean(saved.paused),
      version: Number(saved.version),
    });
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
});

app.patch('/api/kitchen/config', requireDatabase, updateKitchenConfig);
app.put('/api/kitchen/config', requireDatabase, updateKitchenConfig);

app.post('/api/kitchen/dispatch-next', requireDatabase, asyncRoute(async (_req, res) => {
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    const state = await lockKitchenQueue(connection);
    if (state.paused) throw httpError(409, 'KITCHEN_PAUSED', 'Bếp đang tạm dừng nhận phiếu mới.');
    if (state.automationEnabled) {
      throw httpError(409, 'KITCHEN_AUTOMATIC', 'Tắt chế độ tự động trước khi điều phối thủ công.');
    }
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
  const layout = normalizeTableLayout(req.body?.table);
  const id = `table-${crypto.randomUUID().slice(0, 8)}`;
  try {
    await getPool().query(
      `INSERT INTO restaurant_tables (
        id, table_number, seats, status, area, position_x, position_y
       ) VALUES (?, ?, ?, 'empty', ?, ?, ?)`,
      [id, number, seats, layout.area, layout.positionX, layout.positionY],
    );
  } catch (error) {
    throw normalizeTableWriteError(error);
  }
  res.status(201).json({ table: { id, number, seats, status: 'empty', ...layout } });
}));

app.put('/api/tables/:tableId', requireDatabase, asyncRoute(async (req, res) => {
  const number = boundedInteger(req.body?.table?.number, 'number', 1, 999);
  const seats = boundedInteger(req.body?.table?.seats, 'seats', 1, 100);
  const status = req.body?.table?.status;
  if (status === 'reserved') {
    throw httpError(400, 'USE_RESERVATIONS', 'Hãy tạo lịch trong mục Đặt bàn thay vì giữ bàn thủ công.');
  }
  const allowedStatuses = new Set(['empty', 'waiting', 'cooking', 'done']);
  if (!allowedStatuses.has(status)) throw httpError(400, 'VALIDATION_ERROR', 'Trạng thái bàn không hợp lệ.');
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    await lockKitchenQueue(connection);
    const [rows] = await connection.query(
      `SELECT t.id, t.table_number AS number, t.seats, t.status, t.area,
         t.position_x AS positionX, t.position_y AS positionY, o.id AS orderId
       FROM restaurant_tables t
       LEFT JOIN active_orders o ON o.table_id = t.id WHERE t.id = ? FOR UPDATE`,
      [req.params.tableId],
    );
    if (!rows[0]) throw httpError(404, 'TABLE_NOT_FOUND', 'Không tìm thấy bàn.');
    const layout = normalizeTableLayout(req.body?.table, rows[0]);
    const hasOrder = Boolean(rows[0].orderId);
    if (hasOrder && (number !== Number(rows[0].number) || seats !== Number(rows[0].seats))) {
      throw httpError(409, 'TABLE_IN_SERVICE_IMMUTABLE', 'Không thể đổi số bàn hoặc số ghế khi bàn đang phục vụ.');
    }
    const [openReservations] = await connection.query(
      `SELECT id, party_size AS partySize FROM reservations
       WHERE table_id = ? AND status IN ('booked', 'seated') FOR UPDATE`,
      [req.params.tableId],
    );
    const largestParty = Math.max(0, ...openReservations.map(reservation => Number(reservation.partySize)));
    if (seats < largestParty) {
      throw httpError(409, 'TABLE_CAPACITY_RESERVED', `Bàn đang có lịch ${largestParty} khách nên không thể giảm còn ${seats} chỗ.`);
    }
    if (hasOrder && !['waiting', 'cooking', 'done'].includes(status)) {
      throw httpError(409, 'TABLE_HAS_ORDER', 'Bàn đang phục vụ nên không thể chuyển sang trạng thái này.');
    }
    if (!hasOrder && ['waiting', 'cooking', 'done'].includes(status)) {
      throw httpError(409, 'ORDER_NOT_FOUND', 'Bàn cần có món trước khi chọn trạng thái phục vụ.');
    }
    if (hasOrder && status !== rows[0].status) {
      throw httpError(
        409,
        'ORDER_STATUS_ACTION_REQUIRED',
        'Trạng thái bàn đang phục vụ được cập nhật tự động từ tiến độ món.',
      );
    }
    if (hasOrder) {
      await connection.query(
        `UPDATE restaurant_tables
         SET table_number = ?, seats = ?, area = ?, position_x = ?, position_y = ?
         WHERE id = ?`,
        [number, seats, layout.area, layout.positionX, layout.positionY, req.params.tableId],
      );
    } else {
      await connection.query(
        `UPDATE restaurant_tables
         SET table_number = ?, seats = ?, status = 'empty', area = ?, position_x = ?, position_y = ?
         WHERE id = ?`,
        [number, seats, layout.area, layout.positionX, layout.positionY, req.params.tableId],
      );
    }
    await connection.query(
      `UPDATE reservations SET table_number = ?, version = version + 1
       WHERE table_id = ? AND status IN ('booked', 'seated') AND table_number <> ?`,
      [number, req.params.tableId, number],
    );
    const [updatedTables] = await connection.query('SELECT status FROM restaurant_tables WHERE id = ?', [req.params.tableId]);
    await connection.commit();
    res.json({
      table: {
        id: req.params.tableId,
        number,
        seats,
        status: updatedTables[0].status,
        ...layout,
      },
    });
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw normalizeTableWriteError(error);
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
    if (rows[0].orderId) throw httpError(409, 'TABLE_HAS_ORDER', 'Không thể xóa bàn đang phục vụ.');
    const [reservations] = await connection.query(
      `SELECT id FROM reservations
       WHERE table_id = ? AND status IN ('booked', 'seated') LIMIT 1 FOR UPDATE`,
      [req.params.tableId],
    );
    if (reservations[0]) {
      throw httpError(409, 'TABLE_HAS_RESERVATION', 'Không thể xóa bàn đang có lịch đặt chưa kết thúc.');
    }
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
    if (!table.orderId) throw httpError(409, 'ORDER_NOT_FOUND', 'Bàn chưa có món đang phục vụ.');
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
      `SELECT o.id, aop.transaction_id AS paidTransactionId
       FROM active_orders o
       LEFT JOIN active_order_payments aop ON aop.order_id = o.id
       WHERE o.table_id = ? FOR UPDATE`,
      [table.id],
    );
    if (!orders[0]) throw httpError(409, 'ORDER_NOT_FOUND', 'Bàn chưa có món đang phục vụ.');
    if (orders[0].paidTransactionId) {
      throw httpError(409, 'ORDER_ALREADY_PAID', 'Bàn đã thanh toán nên không thể hủy món.');
    }
    const [batches] = await connection.query(
      `SELECT id, status, items, DATE_FORMAT(inventory_date, '%Y-%m-%d') AS inventoryDate
       FROM order_batches WHERE table_id = ? ORDER BY id FOR UPDATE`,
      [table.id],
    );
    if (!canCancelOrder(batches)) {
      throw httpError(409, 'ORDER_NOT_WAITING', 'Chỉ có thể hủy khi toàn bộ lượt gọi còn đang chờ.');
    }
    await releaseDailyInventory(connection, batches.map(batch => ({
      inventoryDate: batch.inventoryDate,
      items: parseJsonColumn(batch.items, []),
    })));
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
    if (orders.length === 0) throw httpError(409, 'ORDER_NOT_FOUND', 'Bàn chưa có món đang phục vụ.');
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

/**
 * Đóng một order đã thanh toán sớm sau khi bếp hoàn tất và nhân viên xác nhận khách đã rời bàn.
 * Xóa order, hoàn tất lịch đặt bàn và trả bàn về trống trong cùng một transaction.
 */
app.post('/api/orders/:tableId/confirm-departure', requireDatabase, asyncRoute(async (req, res) => {
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    await lockKitchenQueue(connection);
    const [rows] = await connection.query(
      `SELECT t.id, t.status, o.id AS orderId, o.reservation_id AS reservationId,
        aop.transaction_id AS paidTransactionId, pt.invoice_code AS paymentId,
        pt.service_status AS serviceStatus
       FROM restaurant_tables t
       LEFT JOIN active_orders o ON o.table_id = t.id
       LEFT JOIN active_order_payments aop ON aop.order_id = o.id
       LEFT JOIN payment_transactions pt ON pt.id = aop.transaction_id
       WHERE t.id = ? FOR UPDATE`,
      [req.params.tableId],
    );
    const table = rows[0];
    if (!table) throw httpError(404, 'TABLE_NOT_FOUND', 'Không tìm thấy bàn.');

    // Retry sau khi transaction trước đã commit không được biến thành lỗi giả trên thiết bị POS.
    if (!table.orderId) {
      const [completedPayments] = await connection.query(
        `SELECT invoice_code AS paymentId FROM payment_transactions
         WHERE table_id = ? AND service_status = 'closed' AND departure_confirmed_at IS NOT NULL
         ORDER BY departure_confirmed_at DESC, id DESC LIMIT 1`,
        [table.id],
      );
      if (completedPayments[0]) {
        await connection.commit();
        res.json({
          ok: true,
          idempotent: true,
          paymentId: completedPayments[0].paymentId,
          status: table.status,
          orderClosed: true,
        });
        return;
      }
      throw httpError(409, 'ORDER_NOT_FOUND', 'Bàn không có lượt phục vụ đang chờ xác nhận khách rời.');
    }
    if (!table.paidTransactionId) {
      throw httpError(409, 'ORDER_NOT_PAID', 'Bàn chưa thanh toán nên không thể xác nhận khách rời.');
    }
    if (table.serviceStatus !== 'awaiting_departure') {
      throw httpError(409, 'PAYMENT_LIFECYCLE_INVALID', 'Trạng thái phục vụ của hóa đơn không hợp lệ.');
    }

    const [batches] = await connection.query(
      'SELECT id, status FROM order_batches WHERE order_id = ? ORDER BY id FOR UPDATE',
      [table.orderId],
    );
    if (!isOrderComplete(batches)) {
      throw httpError(
        409,
        'ORDER_NOT_READY_FOR_DEPARTURE',
        'Bếp chưa hoàn tất tất cả lượt gọi nên chưa thể đóng bàn.',
      );
    }

    if (table.reservationId) {
      const [reservations] = await connection.query(
        'SELECT id, status FROM reservations WHERE id = ? FOR UPDATE',
        [table.reservationId],
      );
      if (!reservations[0] || reservations[0].status !== 'seated') {
        throw httpError(409, 'RESERVATION_NOT_SEATED', 'Lịch liên kết không còn ở trạng thái đã nhận bàn.');
      }
      await connection.query(
        `UPDATE reservations SET status = 'completed', closed_at = CURRENT_TIMESTAMP(3),
          seated_table_id = NULL, version = version + 1 WHERE id = ? AND status = 'seated'`,
        [table.reservationId],
      );
    }

    const [closedPayment] = await connection.query(
      `UPDATE payment_transactions
       SET service_status = 'closed', departure_confirmed_at = CURRENT_TIMESTAMP(3)
       WHERE id = ? AND service_status = 'awaiting_departure'`,
      [table.paidTransactionId],
    );
    if (closedPayment.affectedRows !== 1) {
      throw httpError(409, 'PAYMENT_LIFECYCLE_CHANGED', 'Hóa đơn đã được xử lý trên thiết bị khác.');
    }
    await connection.query('DELETE FROM active_orders WHERE id = ?', [table.orderId]);
    await connection.query("UPDATE restaurant_tables SET status = 'empty' WHERE id = ?", [table.id]);
    await promoteKitchenQueue(connection);
    await connection.commit();
    res.json({
      ok: true,
      paymentId: table.paymentId,
      status: 'empty',
      orderClosed: true,
    });
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
    const [dailyRows] = await connection.query(
      `SELECT localDate AS date, COALESCE(SUM(total), 0) AS revenue, COUNT(*) AS orders
       FROM (
         SELECT DATE_FORMAT(DATE_ADD(paid_at, INTERVAL ? MINUTE), '%Y-%m-%d') AS localDate, total
         FROM payment_transactions WHERE paid_at >= ? AND paid_at < ?
       ) scoped
       GROUP BY localDate ORDER BY localDate`,
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
      daily: dailyRows.map(row => ({ date: row.date, revenue: Number(row.revenue), orders: Number(row.orders) })),
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

// Thanh toán luôn chốt hóa đơn; chỉ đóng order ngay khi toàn bộ phiếu bếp đã xong.
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
        res.json({
          ok: true,
          id: Number(existing.databaseId),
          payment: existing,
          idempotent: true,
          ...paymentLifecycle(existing),
        });
        return;
      }
    }

    const [tables] = await connection.query(
      'SELECT id, table_number AS number, status FROM restaurant_tables WHERE id = ? FOR UPDATE',
      [tableId],
    );
    const table = tables[0];
    if (!table) throw httpError(404, 'TABLE_NOT_FOUND', 'Không tìm thấy bàn.');

    const [orders] = await connection.query(
      `SELECT id AS orderId, items, reservation_id AS reservationId
       FROM active_orders WHERE table_id = ? FOR UPDATE`,
      [tableId],
    );
    if (!orders[0]) throw httpError(409, 'ORDER_NOT_FOUND', 'Lượt phục vụ đã được thanh toán hoặc không còn tồn tại.');
    const [batches] = await connection.query(
      'SELECT id, status FROM order_batches WHERE table_id = ? ORDER BY id FOR UPDATE',
      [tableId],
    );
    if (!canPayOrder(batches)) {
      throw httpError(409, 'ORDER_NOT_READY_FOR_PAYMENT', 'Bàn chưa có phiếu món hợp lệ để thanh toán.');
    }
    // Giữ nguyên ý định "trả trước" của thu ngân dù bếp vừa hoàn tất trong lúc modal đang mở.
    const requiresDepartureConfirmation = paymentRequiresDepartureConfirmation(
      batches,
      req.body?.payment?.keepTableOpen,
    );
    const [orderPayments] = await connection.query(
      `SELECT aop.transaction_id AS transactionId, pt.invoice_code AS paymentId
       FROM active_order_payments aop
       INNER JOIN payment_transactions pt ON pt.id = aop.transaction_id
       WHERE aop.order_id = ? FOR UPDATE`,
      [orders[0].orderId],
    );
    if (orderPayments[0]) {
      throw httpError(
        409,
        'ORDER_ALREADY_PAID',
        `Bàn đã được thanh toán bằng hóa đơn ${orderPayments[0].paymentId}.`,
      );
    }
    const items = validateOrderItems(parseJsonColumn(orders[0].items, []), { maxItems: 500 });

    let reservation = null;
    if (orders[0].reservationId) {
      const [reservationRows] = await connection.query(
        `SELECT id, reservation_code AS code, customer_name AS customerName,
          party_size AS partySize, status
         FROM reservations WHERE id = ? FOR UPDATE`,
        [orders[0].reservationId],
      );
      reservation = reservationRows[0] ?? null;
      if (reservation && reservation.status !== 'seated') {
        throw httpError(409, 'RESERVATION_NOT_SEATED', 'Lịch liên kết không còn ở trạng thái đã nhận bàn.');
      }
    }

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
    if (reservation) {
      payment.reservationId = Number(reservation.id);
      payment.reservationCode = reservation.code;
      payment.customerName = reservation.customerName;
      payment.guestCount = Number(reservation.partySize);
    }
    payment.serviceStatus = requiresDepartureConfirmation ? 'awaiting_departure' : 'closed';
    payment.departureConfirmedAt = null;

    const [result] = await connection.query(
      `INSERT INTO payment_transactions (
        invoice_code, transaction_code, table_id, table_number, reservation_id,
        reservation_code, customer_name, guest_count, payment_method,
        subtotal, discount, service_fee, vat, total, item_count, staff_id,
        staff_name, cashier_name, service_status, paid_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        payment.invoiceCode, payment.transactionCode, payment.tableId, payment.tableNumber,
        payment.reservationId ?? null, payment.reservationCode ?? null,
        payment.customerName ?? null, payment.guestCount ?? null, payment.method,
        payment.subtotal, payment.discount, payment.serviceFee, payment.vat, payment.total, payment.itemCount,
        payment.employeeId ?? null,
        payment.staffName, payment.cashierName, payment.serviceStatus, new Date(payment.paidAt),
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

    if (requiresDepartureConfirmation) {
      await connection.query(
        'INSERT INTO active_order_payments (order_id, transaction_id) VALUES (?, ?)',
        [orders[0].orderId, result.insertId],
      );
    } else {
      if (reservation) {
        await connection.query(
          `UPDATE reservations SET status = 'completed', closed_at = CURRENT_TIMESTAMP(3),
            seated_table_id = NULL, version = version + 1 WHERE id = ? AND status = 'seated'`,
          [reservation.id],
        );
      }
      await connection.query('DELETE FROM active_orders WHERE table_id = ?', [tableId]);
      await connection.query("UPDATE restaurant_tables SET status = 'empty' WHERE id = ?", [tableId]);
    }
    await promoteKitchenQueue(connection);
    await connection.commit();
    res.status(201).json({
      ok: true,
      id: result.insertId,
      payment,
      requiresDepartureConfirmation,
      orderClosed: !requiresDepartureConfirmation,
    });
  } catch (error) {
    await connection?.rollback().catch(() => {});
    if (error.code === 'ER_DUP_ENTRY' && draft?.invoiceCode) {
      const [rows] = await getPool().query(`${paymentSelect('WHERE invoice_code = ?')} LIMIT 1`, [draft.invoiceCode]);
      const existing = rows[0];
      const requestedEmployeeId = typeof draft.employeeId === 'string' && draft.employeeId
        ? draft.employeeId
        : null;
      if (existing
        && existing.tableId === tableId
        && existing.method === draft.method
        && existing.transactionCode === draft.transactionCode
        && (existing.employeeId ?? null) === requestedEmployeeId) {
        res.json({
          ok: true,
          id: Number(existing.databaseId),
          payment: existing,
          idempotent: true,
          ...paymentLifecycle(existing),
        });
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
