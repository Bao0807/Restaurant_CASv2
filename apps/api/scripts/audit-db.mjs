import 'dotenv/config';
import mysql from 'mysql2/promise';

const databaseName = process.env.DB_NAME || 'restaurant_casv2';
if (!/^[a-zA-Z0-9_]+$/.test(databaseName)) {
  throw new Error('DB_NAME chỉ được chứa chữ, số và dấu gạch dưới.');
}

const connectionConfig = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD ?? '1234',
  database: databaseName,
  charset: 'utf8mb4',
  timezone: 'Z',
  connectTimeout: Number(process.env.DB_CONNECT_TIMEOUT_MS || 10_000),
};

const errors = [];
const warnings = [];
const passed = [];
let connection;

function addIssue(severity, title, details = []) {
  const target = severity === 'warning' ? warnings : errors;
  target.push({ title, details });
}

function addPass(title) {
  passed.push(title);
}

function printable(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  return value;
}

function sampleLine(row) {
  return Object.entries(row)
    .map(([key, value]) => `${key}=${printable(value) ?? 'NULL'}`)
    .join(', ');
}

/** Đếm toàn bộ vi phạm nhưng chỉ lấy tối đa 8 dòng mẫu để audit không ngốn bộ nhớ. */
async function checkViolationRows(title, sql, { severity = 'error', params = [] } = {}) {
  try {
    const [countRows] = await connection.query(
      `SELECT COUNT(*) AS total FROM (${sql}) AS audit_violations`,
      params,
    );
    const total = Number(countRows[0]?.total || 0);
    if (total === 0) {
      addPass(title);
      return;
    }
    const [samples] = await connection.query(`${sql} LIMIT 8`, params);
    const details = samples.map(sampleLine);
    if (total > samples.length) details.push(`... và ${total - samples.length} dòng khác`);
    addIssue(severity, `${title}: ${total} vi phạm`, details);
  } catch (error) {
    addIssue('error', `${title}: không thể kiểm tra`, [`${error.code || 'ERROR'} — ${error.message}`]);
  }
}

function indexKey(table, name) {
  return `${table}.${name}`;
}

function normalizeCheckClause(value) {
  return String(value ?? '')
    .toLowerCase()
    .replaceAll('`', '')
    .replaceAll('_utf8mb4', '')
    .replaceAll("\\'", "'")
    .replace(/\s+/g, '');
}

async function auditStructure() {
  const requiredTables = [
    'schema_migrations', 'restaurant_settings', 'restaurant_tables', 'reservations',
    'menu_categories', 'menu_items', 'active_orders', 'order_batches',
    'kitchen_queue_state', 'employees', 'payment_transactions', 'payment_items',
  ];
  const [tableRows] = await connection.query(
    `SELECT table_name AS tableName
     FROM information_schema.tables
     WHERE table_schema = ? AND table_type = 'BASE TABLE'`,
    [databaseName],
  );
  const existingTables = new Set(tableRows.map(row => row.tableName));
  const missingTables = requiredTables.filter(table => !existingTables.has(table));
  if (missingTables.length > 0) {
    addIssue('error', 'Cấu trúc bảng bắt buộc chưa đầy đủ', missingTables.map(table => `thiếu ${table}`));
  } else {
    addPass('Có đầy đủ bảng bắt buộc');
  }

  const [columnRows] = await connection.query(
    `SELECT table_name AS tableName, column_name AS columnName, column_type AS columnType,
       is_nullable AS isNullable, column_default AS columnDefault, extra
     FROM information_schema.columns WHERE table_schema = ?`,
    [databaseName],
  );
  const columns = new Map(columnRows.map(row => [`${row.tableName}.${row.columnName}`, row]));
  const requiredColumnDefinitions = [
    { table: 'reservations', column: 'phone_normalized', type: 'varchar(15)', nullable: 'NO' },
    { table: 'reservations', column: 'ends_at', type: 'datetime(3)', nullable: 'NO' },
    { table: 'reservations', column: 'version', type: 'int unsigned', nullable: 'NO', defaultValue: 1 },
    { table: 'reservations', column: 'seated_table_id', type: 'varchar(32)', nullable: 'YES' },
    { table: 'kitchen_queue_state', column: 'version', type: 'bigint unsigned', nullable: 'NO', defaultValue: 1 },
  ];
  const invalidColumns = [];
  for (const expected of requiredColumnDefinitions) {
    const actual = columns.get(`${expected.table}.${expected.column}`);
    const valid = actual
      && String(actual.columnType).toLowerCase() === expected.type
      && (expected.nullable == null || actual.isNullable === expected.nullable)
      && (expected.defaultValue == null || Number(actual.columnDefault) === expected.defaultValue)
      && (!expected.generated || String(actual.extra).toLowerCase().includes('generated'));
    if (!valid) {
      invalidColumns.push(
        `${expected.table}.${expected.column}: cần ${expected.type}`
        + `${expected.nullable ? ` nullable=${expected.nullable}` : ''}`
        + `${expected.generated ? ' generated' : ''}`,
      );
    }
  }
  if (columns.has('restaurant_tables.reserved_time')) {
    invalidColumns.push('restaurant_tables.reserved_time: cột legacy phải được loại bỏ');
  }
  if (invalidColumns.length > 0) addIssue('error', 'Định nghĩa cột quan trọng chưa đúng', invalidColumns);
  else addPass('Định nghĩa cột nullable/version đúng schema');

  const [indexRows] = await connection.query(
    `SELECT table_name AS tableName, index_name AS indexName, non_unique AS nonUnique,
       seq_in_index AS sequenceNumber, column_name AS columnName, is_visible AS isVisible
     FROM information_schema.statistics
     WHERE table_schema = ?
     ORDER BY table_name, index_name, seq_in_index`,
    [databaseName],
  );
  const indexes = new Map();
  for (const row of indexRows) {
    const key = indexKey(row.tableName, row.indexName);
    const current = indexes.get(key) || {
      table: row.tableName,
      name: row.indexName,
      unique: row.nonUnique === 0,
      visible: row.isVisible === 'YES',
      columns: [],
    };
    current.columns.push(row.columnName);
    indexes.set(key, current);
  }

  const requiredIndexes = [
    { table: 'restaurant_tables', columns: ['id'], unique: true, name: 'PRIMARY' },
    { table: 'restaurant_tables', columns: ['table_number'], unique: true },
    { table: 'restaurant_tables', columns: ['status'], name: 'idx_restaurant_table_status' },
    { table: 'reservations', columns: ['reservation_code'], unique: true },
    { table: 'reservations', columns: ['id', 'table_id'], unique: true, name: 'uq_reservation_id_table' },
    { table: 'reservations', columns: ['seated_table_id'], unique: true, name: 'uq_reservation_seated_table' },
    { table: 'reservations', columns: ['status', 'reserved_at', 'ends_at'], name: 'idx_reservation_schedule' },
    { table: 'reservations', columns: ['table_id', 'status', 'reserved_at', 'ends_at'], name: 'idx_reservation_table_schedule' },
    { table: 'reservations', columns: ['phone_normalized', 'reserved_at'], name: 'idx_reservation_phone' },
    { table: 'active_orders', columns: ['table_id'], unique: true },
    { table: 'active_orders', columns: ['reservation_id'], unique: true, name: 'uq_active_order_reservation' },
    { table: 'active_orders', columns: ['id', 'table_id'], unique: true, name: 'uq_active_order_id_table' },
    { table: 'active_orders', columns: ['queued_at', 'id'], name: 'idx_active_order_queue' },
    { table: 'menu_items', columns: ['category_id'], name: 'idx_menu_item_category' },
    { table: 'menu_items', columns: ['available'], name: 'idx_menu_item_available' },
    { table: 'order_batches', columns: ['order_id', 'batch_number'], unique: true, name: 'uq_order_batch_number' },
    { table: 'order_batches', columns: ['status', 'queued_at', 'id'], name: 'idx_order_batch_queue' },
    { table: 'order_batches', columns: ['table_id', 'status'], name: 'idx_order_batch_table' },
    { table: 'employees', columns: ['employee_code'], unique: true },
    { table: 'employees', columns: ['active', 'full_name'], name: 'idx_employee_active_name' },
    { table: 'payment_transactions', columns: ['invoice_code'], unique: true },
    { table: 'payment_transactions', columns: ['paid_at'], name: 'idx_paid_at' },
    { table: 'payment_transactions', columns: ['table_id'], name: 'idx_table_id' },
    { table: 'payment_transactions', columns: ['staff_id', 'paid_at'], name: 'idx_payment_staff' },
    { table: 'payment_transactions', columns: ['reservation_id', 'paid_at'], name: 'idx_payment_reservation' },
    // MySQL có thể dùng luôn index tự tạo cho foreign key, tên index không ảnh hưởng hiệu lực.
    { table: 'payment_items', columns: ['transaction_id'] },
    { table: 'payment_items', columns: ['category_id'], name: 'idx_payment_item_category' },
  ];
  const missingIndexes = [];
  for (const expected of requiredIndexes) {
    const candidates = [...indexes.values()].filter(index => index.table === expected.table);
    const found = candidates.some(index => {
      if (expected.name && index.name !== expected.name) return false;
      if (expected.unique != null && index.unique !== expected.unique) return false;
      if (!index.visible) return false;
      return index.columns.join(',') === expected.columns.join(',');
    });
    if (!found) {
      missingIndexes.push(
        `${expected.table}.${expected.name || expected.columns.join('+')}`
        + ` (${expected.unique ? 'UNIQUE ' : ''}${expected.columns.join(', ')})`,
      );
    }
  }
  if (missingIndexes.length > 0) addIssue('error', 'Thiếu index/unique key bắt buộc', missingIndexes);
  else addPass('Index và unique key bắt buộc đầy đủ');

  const [foreignKeyRows] = await connection.query(
    `SELECT k.table_name AS tableName, k.constraint_name AS constraintName,
       k.column_name AS columnName, k.ordinal_position AS sequenceNumber,
       k.referenced_table_name AS referencedTable, k.referenced_column_name AS referencedColumn,
       r.delete_rule AS deleteRule
     FROM information_schema.key_column_usage k
     INNER JOIN information_schema.referential_constraints r
       ON r.constraint_schema = k.constraint_schema
      AND r.table_name = k.table_name
      AND r.constraint_name = k.constraint_name
     WHERE k.constraint_schema = ? AND k.referenced_table_name IS NOT NULL
     ORDER BY k.table_name, k.constraint_name, k.ordinal_position`,
    [databaseName],
  );
  const foreignKeys = new Map();
  for (const row of foreignKeyRows) {
    const key = `${row.tableName}.${row.constraintName}`;
    const current = foreignKeys.get(key) || {
      table: row.tableName,
      name: row.constraintName,
      columns: [],
      referencedTable: row.referencedTable,
      referencedColumns: [],
      deleteRule: row.deleteRule,
    };
    current.columns.push(row.columnName);
    current.referencedColumns.push(row.referencedColumn);
    foreignKeys.set(key, current);
  }
  const requiredForeignKeys = [
    { table: 'reservations', name: 'fk_reservation_table', columns: ['table_id'], ref: 'restaurant_tables', refColumns: ['id'], onDelete: 'SET NULL' },
    { table: 'menu_items', name: 'fk_menu_item_category', columns: ['category_id'], ref: 'menu_categories', refColumns: ['id'], onDelete: 'NO ACTION' },
    { table: 'active_orders', name: 'fk_active_order_table', columns: ['table_id'], ref: 'restaurant_tables', refColumns: ['id'], onDelete: 'CASCADE' },
    { table: 'active_orders', name: 'fk_active_order_reservation_table', columns: ['reservation_id', 'table_id'], ref: 'reservations', refColumns: ['id', 'table_id'], onDelete: 'NO ACTION' },
    { table: 'order_batches', name: 'fk_order_batch_order_table', columns: ['order_id', 'table_id'], ref: 'active_orders', refColumns: ['id', 'table_id'], onDelete: 'CASCADE' },
    { table: 'payment_transactions', name: 'fk_payment_staff', columns: ['staff_id'], ref: 'employees', refColumns: ['id'], onDelete: 'SET NULL' },
    { table: 'payment_transactions', name: 'fk_payment_reservation', columns: ['reservation_id'], ref: 'reservations', refColumns: ['id'], onDelete: 'SET NULL' },
    { table: 'payment_items', name: 'fk_payment_items_transaction', columns: ['transaction_id'], ref: 'payment_transactions', refColumns: ['id'], onDelete: 'CASCADE' },
  ];
  const missingForeignKeys = [];
  for (const expected of requiredForeignKeys) {
    const actual = foreignKeys.get(`${expected.table}.${expected.name}`);
    const valid = actual
      && actual.columns.join(',') === expected.columns.join(',')
      && actual.referencedTable === expected.ref
      && actual.referencedColumns.join(',') === expected.refColumns.join(',')
      && actual.deleteRule === expected.onDelete;
    if (!valid) {
      missingForeignKeys.push(
        `${expected.table}.${expected.name}: (${expected.columns.join(', ')}) -> `
        + `${expected.ref}(${expected.refColumns.join(', ')}), ON DELETE ${expected.onDelete}`,
      );
    }
  }
  if (missingForeignKeys.length > 0) addIssue('error', 'Thiếu hoặc sai foreign key bắt buộc', missingForeignKeys);
  else addPass('Foreign key bắt buộc đúng cột và quy tắc xóa');

  const requiredChecks = [
    { table: 'restaurant_settings', name: 'chk_settings_singleton', tokens: ['id=1'] },
    { table: 'restaurant_tables', name: 'chk_restaurant_table_number', tokens: ['table_number', 'between1and999'] },
    { table: 'restaurant_tables', name: 'chk_restaurant_table_seats', tokens: ['seats', 'between1and100'] },
    {
      table: 'restaurant_tables', name: 'chk_restaurant_table_status',
      tokens: ['status', "'empty'", "'waiting'", "'cooking'", "'done'"], forbidden: ["'reserved'"],
    },
    { table: 'reservations', name: 'chk_reservation_phone', tokens: ['regexp_like', 'phone_normalized', '^[0-9]{8,15}$'] },
    { table: 'reservations', name: 'chk_reservation_table_number', tokens: ['table_number', 'between1and999'] },
    { table: 'reservations', name: 'chk_reservation_party_size', tokens: ['party_size', 'between1and100'] },
    { table: 'reservations', name: 'chk_reservation_duration', tokens: ['duration_minutes', 'between30and480'] },
    {
      table: 'reservations', name: 'chk_reservation_status',
      tokens: ['status', "'booked'", "'seated'", "'cancelled'", "'no_show'", "'completed'"],
    },
    { table: 'reservations', name: 'chk_reservation_window', tokens: ['ends_at', 'reserved_at', 'interval', 'duration_minutes', 'minute'] },
    { table: 'reservations', name: 'chk_reservation_version', tokens: ['version>=1'] },
    {
      table: 'reservations', name: 'chk_reservation_lifecycle',
      tokens: ['status', 'seated_at', 'closed_at', "'booked'", "'seated'", "'cancelled'", "'no_show'", "'completed'"],
    },
    { table: 'menu_items', name: 'chk_menu_item_cook_minutes', tokens: ['cook_minutes', 'between1and240'] },
    { table: 'order_batches', name: 'chk_order_batch_status', tokens: ['status', "'waiting'", "'cooking'", "'done'"] },
    { table: 'order_batches', name: 'chk_order_batch_eta', tokens: ['estimated_cook_minutes', 'between1and23760'] },
    { table: 'kitchen_queue_state', name: 'chk_kitchen_singleton', tokens: ['id=1'] },
    { table: 'kitchen_queue_state', name: 'chk_kitchen_concurrency', tokens: ['concurrency', 'between1and20'] },
    { table: 'kitchen_queue_state', name: 'chk_kitchen_stale', tokens: ['stale_after_minutes', 'between15and1440'] },
    { table: 'kitchen_queue_state', name: 'chk_kitchen_flags', tokens: ['automation_enabled', 'paused', 'in(0,1)'] },
    { table: 'kitchen_queue_state', name: 'chk_kitchen_version', tokens: ['version>=1'] },
    { table: 'employees', name: 'chk_employee_role', tokens: ['role', "'manager'", "'cashier'", "'server'", "'chef'"] },
    { table: 'payment_transactions', name: 'chk_payment_guest_count', tokens: ['guest_count', 'between1and100'] },
    {
      table: 'payment_transactions', name: 'chk_payment_reservation_snapshot',
      tokens: ['reservation_code', 'customer_name', 'guest_count'],
    },
  ];
  const [checkRows] = await connection.query(
    `SELECT constraints.table_name AS tableName, constraints.constraint_name AS constraintName,
       checks.check_clause AS checkClause
     FROM information_schema.table_constraints constraints
     INNER JOIN information_schema.check_constraints checks
       ON checks.constraint_schema = constraints.constraint_schema
      AND checks.constraint_name = constraints.constraint_name
     WHERE constraints.constraint_schema = ? AND constraints.constraint_type = 'CHECK'`,
    [databaseName],
  );
  const existingChecks = new Map(checkRows.map(row => [
    `${row.tableName}.${row.constraintName}`,
    normalizeCheckClause(row.checkClause),
  ]));
  const missingChecks = requiredChecks.flatMap(expected => {
    const clause = existingChecks.get(`${expected.table}.${expected.name}`);
    if (!clause) return [`${expected.table}.${expected.name}: thiếu constraint`];
    const missingTokens = expected.tokens
      .map(normalizeCheckClause)
      .filter(token => !clause.includes(token));
    const forbiddenTokens = (expected.forbidden ?? [])
      .map(normalizeCheckClause)
      .filter(token => clause.includes(token));
    return missingTokens.length || forbiddenTokens.length
      ? [`${expected.table}.${expected.name}: biểu thức không đúng (${clause})`]
      : [];
  });
  if (missingChecks.length > 0) addIssue('error', 'Thiếu CHECK constraint bắt buộc', missingChecks);
  else addPass('CHECK constraint bắt buộc đầy đủ');

  return existingTables;
}

async function auditOrdersAndTables(existingTables) {
  if (!['restaurant_tables', 'active_orders', 'order_batches'].every(table => existingTables.has(table))) return;

  await checkViolationRows(
    'Batch không mồ côi và luôn cùng bàn với active order',
    `SELECT b.id AS batchId, b.order_id AS orderId, b.table_id AS batchTableId,
       o.table_id AS orderTableId
     FROM order_batches b
     LEFT JOIN active_orders o ON o.id = b.order_id
     WHERE o.id IS NULL OR b.table_id <> o.table_id`,
  );

  await checkViolationRows(
    'Mốc thời gian và trạng thái phiếu bếp hợp lệ',
    `SELECT id AS batchId, order_id AS orderId, status, queued_at AS queuedAt,
       cooking_started_at AS cookingStartedAt, completed_at AS completedAt,
       estimated_cook_minutes AS estimatedMinutes
     FROM order_batches
     WHERE JSON_TYPE(items) <> 'ARRAY' OR JSON_LENGTH(items) = 0
        OR estimated_cook_minutes NOT BETWEEN 1 AND 23760
        OR (status = 'waiting' AND (cooking_started_at IS NOT NULL OR completed_at IS NOT NULL))
        OR (status = 'cooking' AND (cooking_started_at IS NULL OR completed_at IS NOT NULL))
        OR (status = 'done' AND (cooking_started_at IS NULL OR completed_at IS NULL))
        OR (cooking_started_at IS NOT NULL AND cooking_started_at < queued_at)
        OR (completed_at IS NOT NULL AND (cooking_started_at IS NULL OR completed_at < cooking_started_at))`,
  );

  await checkViolationRows(
    'Active order khớp tổng hợp các batch',
    `SELECT o.id AS orderId, o.table_id AS tableId, JSON_LENGTH(o.items) AS orderLines,
       COUNT(b.id) AS batchCount, COALESCE(SUM(JSON_LENGTH(b.items)), 0) AS batchLines,
       o.estimated_cook_minutes AS orderEta, MAX(b.estimated_cook_minutes) AS batchEta,
       o.queued_at AS orderQueuedAt, MIN(b.queued_at) AS firstBatchQueuedAt
     FROM active_orders o
     LEFT JOIN order_batches b ON b.order_id = o.id
     GROUP BY o.id, o.table_id, o.items, o.estimated_cook_minutes, o.queued_at
     HAVING JSON_TYPE(o.items) <> 'ARRAY' OR JSON_LENGTH(o.items) = 0
        OR COUNT(b.id) = 0
        OR JSON_LENGTH(o.items) <> COALESCE(SUM(JSON_LENGTH(b.items)), 0)
        OR o.estimated_cook_minutes <> MAX(b.estimated_cook_minutes)
        OR o.queued_at <> MIN(b.queued_at)`,
  );

  if (existingTables.has('reservations')) {
    await checkViolationRows(
      'Liên kết active order với reservation đúng bàn và đúng trạng thái',
      `SELECT o.id AS orderId, o.table_id AS orderTableId, o.reservation_id AS reservationId,
         r.table_id AS reservationTableId, r.status AS reservationStatus
       FROM active_orders o
       LEFT JOIN reservations r ON r.id = o.reservation_id
       WHERE o.reservation_id IS NOT NULL
         AND (r.id IS NULL OR r.table_id <> o.table_id OR r.status <> 'seated')`,
    );
  }

  await checkViolationRows(
    'Trạng thái bàn có order khớp trạng thái batch',
    `SELECT t.id AS tableId, t.table_number AS tableNumber, t.status AS actualStatus,
       CASE
         WHEN SUM(b.status = 'cooking') > 0 THEN 'cooking'
         WHEN SUM(b.status = 'waiting') > 0 THEN 'waiting'
         ELSE 'done'
       END AS expectedStatus
     FROM restaurant_tables t
     INNER JOIN active_orders o ON o.table_id = t.id
     INNER JOIN order_batches b ON b.order_id = o.id
     GROUP BY t.id, t.table_number, t.status
     HAVING actualStatus <> expectedStatus`,
  );

  await checkViolationRows(
    'Bàn không có order phải ở trạng thái empty',
    `SELECT t.id AS tableId, t.table_number AS tableNumber, t.status
     FROM restaurant_tables t
     LEFT JOIN active_orders o ON o.table_id = t.id
     WHERE o.id IS NULL AND t.status <> 'empty'`,
  );

  await checkViolationRows(
    'Queue không đảo thứ tự FIFO giữa phiếu chờ và phiếu đang nấu',
    `SELECT w.id AS waitingBatchId, w.queued_at AS waitingQueuedAt,
       c.id AS cookingBatchId, c.queued_at AS cookingQueuedAt
     FROM order_batches w
     INNER JOIN order_batches c ON c.status = 'cooking' AND w.queued_at < c.queued_at
     WHERE w.status = 'waiting'`,
  );
}

async function auditReservations(existingTables) {
  if (!['reservations', 'restaurant_tables'].every(table => existingTables.has(table))) return;

  await checkViolationRows(
    'Reservation đang mở có bàn hợp lệ, đủ chỗ và đúng snapshot số bàn',
    `SELECT r.id AS reservationId, r.reservation_code AS code, r.table_id AS tableId,
       r.table_number AS reservedTableNumber, t.table_number AS currentTableNumber,
       r.party_size AS partySize, t.seats
     FROM reservations r
     LEFT JOIN restaurant_tables t ON t.id = r.table_id
     WHERE r.status IN ('booked', 'seated')
       AND (r.table_id IS NULL OR t.id IS NULL OR r.party_size > t.seats
         OR r.table_number <> t.table_number)`,
  );

  await checkViolationRows(
    'Không có reservation đang mở trùng khung giờ trên cùng bàn',
    `SELECT first.id AS firstReservationId, first.reservation_code AS firstCode,
       second.id AS secondReservationId, second.reservation_code AS secondCode,
       first.table_id AS tableId
     FROM reservations first
     INNER JOIN reservations second
       ON second.table_id = first.table_id AND second.id > first.id
      AND first.reserved_at < second.ends_at AND second.reserved_at < first.ends_at
     WHERE first.status IN ('booked', 'seated')
       AND second.status IN ('booked', 'seated')`,
  );

  await checkViolationRows(
    'Dữ liệu và vòng đời reservation hợp lệ',
    `SELECT id AS reservationId, reservation_code AS code, status, party_size AS partySize,
       duration_minutes AS durationMinutes, reserved_at AS reservedAt, ends_at AS endsAt,
       seated_at AS seatedAt, closed_at AS closedAt, version
     FROM reservations
     WHERE party_size IS NULL OR party_size NOT BETWEEN 1 AND 100
        OR reserved_at IS NULL OR ends_at IS NULL OR duration_minutes IS NULL
        OR duration_minutes NOT BETWEEN 30 AND 480
        OR ends_at <> TIMESTAMPADD(MINUTE, duration_minutes, reserved_at)
        OR version IS NULL OR version < 1
        OR phone_normalized IS NULL OR phone_normalized NOT REGEXP '^[0-9]{8,15}$'
        OR status IS NULL OR status NOT IN ('booked', 'seated', 'cancelled', 'no_show', 'completed')
        OR (status = 'seated' AND (seated_table_id IS NULL OR NOT (seated_table_id <=> table_id)))
        OR (status <> 'seated' AND seated_table_id IS NOT NULL)
        OR (status = 'booked' AND (seated_at IS NOT NULL OR closed_at IS NOT NULL))
        OR (status = 'seated' AND (seated_at IS NULL OR closed_at IS NOT NULL))
        OR (status IN ('cancelled', 'no_show') AND (seated_at IS NOT NULL OR closed_at IS NULL))
        OR (status = 'completed' AND (seated_at IS NULL OR closed_at IS NULL OR closed_at < seated_at))`,
  );

  await checkViolationRows(
    'Mỗi bàn chỉ có tối đa một reservation seated',
    `SELECT table_id AS tableId, COUNT(*) AS seatedCount
     FROM reservations
     WHERE status = 'seated' AND table_id IS NOT NULL
     GROUP BY table_id HAVING COUNT(*) > 1`,
  );

  await checkViolationRows(
    'Reservation booked đã quá giờ kết thúc cần xử lý no-show',
    `SELECT id AS reservationId, reservation_code AS code, table_number AS tableNumber,
       reserved_at AS reservedAt, ends_at AS endsAt
     FROM reservations
     WHERE status = 'booked' AND ends_at < CURRENT_TIMESTAMP(3)`,
    { severity: 'warning' },
  );

  if (existingTables.has('active_orders')) {
    await checkViolationRows(
      'Reservation seated chưa có active order cần nhân viên kiểm tra',
      `SELECT r.id AS reservationId, r.reservation_code AS code, r.table_id AS tableId,
         r.seated_at AS seatedAt
       FROM reservations r
       LEFT JOIN active_orders o ON o.reservation_id = r.id
       WHERE r.status = 'seated' AND o.id IS NULL`,
      { severity: 'warning' },
    );
  }
}

async function auditKitchen(existingTables) {
  if (!existingTables.has('kitchen_queue_state')) return;

  const [rows] = await connection.query(
    `SELECT id, concurrency, stale_after_minutes AS staleMinutes,
       automation_enabled AS automationEnabled, paused, version
     FROM kitchen_queue_state ORDER BY id`,
  );
  if (rows.length !== 1 || Number(rows[0]?.id) !== 1) {
    addIssue('error', 'Cấu hình bếp phải là singleton id=1', [
      `số dòng=${rows.length}, ids=${rows.map(row => row.id).join(', ') || '(trống)'}`,
    ]);
  } else {
    addPass('Cấu hình bếp có đúng một dòng id=1');
  }

  await checkViolationRows(
    'Giới hạn và version cấu hình bếp hợp lệ',
    `SELECT id, concurrency, stale_after_minutes AS staleMinutes,
       automation_enabled AS automationEnabled, paused, version
     FROM kitchen_queue_state
     WHERE id <> 1 OR concurrency NOT BETWEEN 1 AND 20
        OR stale_after_minutes NOT BETWEEN 15 AND 1440
        OR automation_enabled NOT IN (0, 1) OR paused NOT IN (0, 1)
        OR version < 1`,
  );

  if (existingTables.has('order_batches')) {
    await checkViolationRows(
      'Số phiếu đang nấu vượt cấu hình song song',
      `SELECT state.concurrency, COUNT(batch.id) AS cookingCount
       FROM kitchen_queue_state state
       LEFT JOIN order_batches batch ON batch.status = 'cooking'
       WHERE state.id = 1
       GROUP BY state.id, state.concurrency
       HAVING cookingCount > state.concurrency`,
      { severity: 'warning' },
    );
  }
}

async function auditPayments(existingTables) {
  if (!['payment_transactions', 'payment_items'].every(table => existingTables.has(table))) return;

  await checkViolationRows(
    'Tổng tiền và số lượng trên hóa đơn khớp các dòng món',
    `SELECT payment.id AS paymentId, payment.invoice_code AS invoiceCode,
       payment.item_count AS savedItemCount, COALESCE(items.itemCount, 0) AS calculatedItemCount,
       payment.subtotal AS savedSubtotal, COALESCE(items.subtotal, 0) AS calculatedSubtotal,
       payment.total AS savedTotal,
       payment.subtotal - payment.discount + payment.service_fee + payment.vat AS calculatedTotal
     FROM payment_transactions payment
     LEFT JOIN (
       SELECT transaction_id, SUM(quantity) AS itemCount, SUM(quantity * price) AS subtotal
       FROM payment_items GROUP BY transaction_id
     ) items ON items.transaction_id = payment.id
     WHERE items.transaction_id IS NULL
        OR payment.item_count <> items.itemCount
        OR payment.subtotal <> items.subtotal
        OR payment.total <> payment.subtotal - payment.discount + payment.service_fee + payment.vat
        OR payment.discount < 0 OR payment.discount > payment.subtotal
        OR payment.service_fee < 0 OR payment.vat < 0 OR payment.total < 0
        OR payment.payment_method NOT IN ('cash', 'card', 'qr')
        OR payment.status <> 'PAID'`,
  );

  await checkViolationRows(
    'Dòng món đã thanh toán có số lượng và đơn giá hợp lệ',
    `SELECT id AS paymentItemId, transaction_id AS paymentId, quantity, price
     FROM payment_items
     WHERE quantity < 1 OR price < 0 OR name = ''`,
  );

  if (existingTables.has('reservations')) {
    await checkViolationRows(
      'Snapshot reservation trên hóa đơn nhất quán',
      `SELECT payment.id AS paymentId, payment.invoice_code AS invoiceCode,
         payment.reservation_id AS reservationId, payment.reservation_code AS savedReservationCode,
         reservation.reservation_code AS currentReservationCode,
         payment.guest_count AS savedGuestCount, reservation.party_size AS reservationPartySize
       FROM payment_transactions payment
       LEFT JOIN reservations reservation ON reservation.id = payment.reservation_id
       WHERE payment.reservation_id IS NOT NULL
         AND (reservation.id IS NULL
           OR payment.reservation_code <> reservation.reservation_code
           OR payment.customer_name <> reservation.customer_name
           OR payment.guest_count <> reservation.party_size)`,
    );
  }
}

async function auditSingletonSettings(existingTables) {
  if (!existingTables.has('restaurant_settings')) return;
  await checkViolationRows(
    'Cấu hình nhà hàng có đúng singleton id=1 và JSON object',
    `SELECT id, JSON_TYPE(settings) AS settingsType
     FROM restaurant_settings
     WHERE id <> 1 OR JSON_TYPE(settings) <> 'OBJECT'
       OR (SELECT COUNT(*) FROM restaurant_settings) <> 1`,
  );
}

function printReport(meta) {
  console.log(`\nCAS DATABASE AUDIT — ${databaseName}`);
  console.log(`MySQL ${meta.version} · UTC ${new Date().toISOString()}`);
  console.log('Chế độ: READ ONLY (không sửa dữ liệu)\n');

  console.log(`✅ Đạt: ${passed.length} nhóm kiểm tra`);
  for (const title of passed) console.log(`   • ${title}`);

  if (warnings.length > 0) {
    console.log(`\n⚠️  Cảnh báo vận hành: ${warnings.length}`);
    for (const warning of warnings) {
      console.log(`   • ${warning.title}`);
      for (const detail of warning.details) console.log(`     - ${detail}`);
    }
  }

  if (errors.length > 0) {
    console.log(`\n❌ Lỗi toàn vẹn: ${errors.length}`);
    for (const error of errors) {
      console.log(`   • ${error.title}`);
      for (const detail of error.details) console.log(`     - ${detail}`);
    }
    console.log('\nKẾT LUẬN: database CHƯA đạt. Không nên triển khai production trước khi xử lý các lỗi trên.');
  } else {
    console.log('\nKẾT LUẬN: database đạt toàn bộ kiểm tra toàn vẹn bắt buộc.');
  }
}

async function run() {
  connection = await mysql.createConnection(connectionConfig);
  await connection.query("SET time_zone = '+00:00'");
  await connection.query('START TRANSACTION READ ONLY');
  const [[meta]] = await connection.query('SELECT VERSION() AS version');

  const existingTables = await auditStructure();
  await auditSingletonSettings(existingTables);
  await auditOrdersAndTables(existingTables);
  await auditReservations(existingTables);
  await auditKitchen(existingTables);
  await auditPayments(existingTables);

  await connection.rollback();
  printReport(meta);
  if (errors.length > 0) process.exitCode = 1;
}

try {
  await run();
} catch (error) {
  await connection?.rollback().catch(() => {});
  console.error('\n❌ Không thể chạy database audit.');
  console.error(`${error.code || 'ERROR'} — ${error.message}`);
  process.exitCode = 1;
} finally {
  await connection?.end().catch(() => {});
}
