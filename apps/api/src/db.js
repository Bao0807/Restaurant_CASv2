import mysql from 'mysql2/promise';
import { defaultSettings } from './defaultSettings.js';

const isProduction = process.env.NODE_ENV === 'production';
const databaseName = process.env.DB_NAME || 'restaurant_casv2';
const autoMigrate = process.env.DB_AUTO_MIGRATE != null
  ? process.env.DB_AUTO_MIGRATE === 'true'
  : !isProduction;

function initialKitchenConcurrency() {
  const value = Number(process.env.KITCHEN_CONCURRENCY || 2);
  return Number.isInteger(value) ? Math.min(Math.max(value, 1), 20) : 2;
}

function initialKitchenStaleMinutes() {
  const value = Number(process.env.KITCHEN_STALE_MINUTES || 120);
  return Number.isInteger(value) ? Math.min(Math.max(value, 15), 1_440) : 120;
}

if (!/^[a-zA-Z0-9_]+$/.test(databaseName)) {
  throw new Error('DB_NAME chỉ được chứa chữ, số và dấu gạch dưới');
}

if (isProduction && (!process.env.DB_USER || process.env.DB_PASSWORD == null)) {
  throw new Error('DB_USER và DB_PASSWORD là bắt buộc trong production');
}

const config = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD ?? '1234',
  database: databaseName,
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 10),
  queueLimit: Number(process.env.DB_QUEUE_LIMIT || 100),
  connectTimeout: Number(process.env.DB_CONNECT_TIMEOUT_MS || 10_000),
  charset: 'utf8mb4',
  timezone: 'Z',
};

if (!isProduction && process.env.DB_PASSWORD == null) {
  console.warn('DB_PASSWORD chưa được cấu hình; đang dùng mật khẩu local legacy. Hãy tạo apps/api/.env.');
}

let pool;

/** Tạo pool và buộc mọi session MySQL dùng UTC cho timer bếp nhất quán. */
function createPool() {
  const nextPool = mysql.createPool(config);
  // mysql2's `timezone` controls Date serialization but does not change the
  // MySQL session. Queue timestamps use CURRENT_TIMESTAMP, so every pooled
  // connection must run in UTC to keep elapsed timers correct on any host.
  nextPool.pool.on('connection', connection => {
    connection.query("SET time_zone = '+00:00'", error => {
      if (error) connection.destroy();
    });
  });
  return nextPool;
}

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS schema_migrations (
    id VARCHAR(120) NOT NULL PRIMARY KEY,
    applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS restaurant_settings (
    id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
    settings JSON NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS restaurant_tables (
    id VARCHAR(32) NOT NULL PRIMARY KEY,
    table_number INT UNSIGNED NOT NULL UNIQUE,
    seats INT UNSIGNED NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'empty',
    reserved_time VARCHAR(10) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT chk_restaurant_table_seats CHECK (seats BETWEEN 1 AND 100),
    CONSTRAINT chk_restaurant_table_status CHECK (status IN ('empty', 'waiting', 'cooking', 'done', 'reserved')),
    INDEX idx_restaurant_table_status (status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS menu_categories (
    id VARCHAR(64) NOT NULL PRIMARY KEY,
    name VARCHAR(120) NOT NULL,
    emoji VARCHAR(16) NOT NULL DEFAULT '🍽️',
    sort_order INT NOT NULL DEFAULT 0,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS menu_items (
    id VARCHAR(64) NOT NULL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description VARCHAR(500) NOT NULL DEFAULT '',
    price INT UNSIGNED NOT NULL,
    image VARCHAR(1000) NOT NULL DEFAULT '',
    category_id VARCHAR(64) NOT NULL,
    cook_minutes INT UNSIGNED NOT NULL DEFAULT 10,
    available BOOLEAN NOT NULL DEFAULT TRUE,
    is_bestseller BOOLEAN NOT NULL DEFAULT FALSE,
    is_new BOOLEAN NOT NULL DEFAULT FALSE,
    sizes_json JSON NOT NULL,
    toppings_json JSON NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_menu_item_category FOREIGN KEY (category_id) REFERENCES menu_categories(id),
    CONSTRAINT chk_menu_item_cook_minutes CHECK (cook_minutes BETWEEN 1 AND 240),
    INDEX idx_menu_item_category (category_id),
    INDEX idx_menu_item_available (available)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS active_orders (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    table_id VARCHAR(32) NOT NULL UNIQUE,
    items JSON NOT NULL,
    queued_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    cooking_started_at DATETIME(3) NULL,
    estimated_cook_minutes INT UNSIGNED NOT NULL DEFAULT 10,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_active_order_table
      FOREIGN KEY (table_id) REFERENCES restaurant_tables(id)
      ON DELETE CASCADE,
    INDEX idx_active_order_queue (queued_at, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS order_batches (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    order_id BIGINT UNSIGNED NOT NULL,
    table_id VARCHAR(32) NOT NULL,
    batch_number INT UNSIGNED NOT NULL,
    items JSON NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'waiting',
    is_addition BOOLEAN NOT NULL DEFAULT FALSE,
    queued_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    cooking_started_at DATETIME(3) NULL,
    completed_at DATETIME(3) NULL,
    estimated_cook_minutes INT UNSIGNED NOT NULL DEFAULT 10,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_order_batch_order FOREIGN KEY (order_id) REFERENCES active_orders(id) ON DELETE CASCADE,
    CONSTRAINT uq_order_batch_number UNIQUE (order_id, batch_number),
    CONSTRAINT chk_order_batch_status CHECK (status IN ('waiting', 'cooking', 'done')),
    CONSTRAINT chk_order_batch_eta CHECK (estimated_cook_minutes BETWEEN 1 AND 23760),
    INDEX idx_order_batch_queue (status, queued_at, id),
    INDEX idx_order_batch_table (table_id, status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS kitchen_queue_state (
    id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
    concurrency INT UNSIGNED NOT NULL DEFAULT 2,
    stale_after_minutes INT UNSIGNED NOT NULL DEFAULT 120,
    automation_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    paused BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS employees (
    id VARCHAR(64) NOT NULL PRIMARY KEY,
    employee_code VARCHAR(24) NOT NULL UNIQUE,
    full_name VARCHAR(120) NOT NULL,
    role VARCHAR(20) NOT NULL DEFAULT 'server',
    phone VARCHAR(32) NOT NULL DEFAULT '',
    shift_start TIME NULL,
    shift_end TIME NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT chk_employee_role CHECK (role IN ('manager', 'cashier', 'server', 'chef')),
    INDEX idx_employee_active_name (active, full_name)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS payment_transactions (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    invoice_code VARCHAR(64) NOT NULL UNIQUE,
    transaction_code VARCHAR(64) NOT NULL,
    table_id VARCHAR(32) NOT NULL,
    table_number INT NOT NULL,
    payment_method VARCHAR(20) NOT NULL,
    subtotal INT NOT NULL DEFAULT 0,
    discount INT NOT NULL DEFAULT 0,
    service_fee INT NOT NULL DEFAULT 0,
    vat INT NOT NULL DEFAULT 0,
    total INT NOT NULL DEFAULT 0,
    item_count INT NOT NULL DEFAULT 0,
    staff_id VARCHAR(64) NULL,
    staff_name VARCHAR(120) NULL,
    cashier_name VARCHAR(120) NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'PAID',
    paid_at DATETIME(3) NOT NULL,
    raw_payload JSON NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_payment_staff FOREIGN KEY (staff_id) REFERENCES employees(id) ON DELETE SET NULL,
    INDEX idx_paid_at (paid_at),
    INDEX idx_table_id (table_id),
    INDEX idx_payment_staff (staff_id, paid_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS payment_items (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    transaction_id BIGINT UNSIGNED NOT NULL,
    cart_id VARCHAR(64) NULL,
    menu_item_id VARCHAR(64) NULL,
    category_id VARCHAR(64) NULL,
    category_name VARCHAR(120) NULL,
    name VARCHAR(255) NOT NULL,
    quantity INT NOT NULL,
    price INT NOT NULL,
    note TEXT NULL,
    options_json JSON NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_payment_items_transaction
      FOREIGN KEY (transaction_id) REFERENCES payment_transactions(id)
      ON DELETE CASCADE,
    INDEX idx_payment_item_transaction (transaction_id),
    INDEX idx_payment_item_category (category_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];

const defaultTables = [
  ['t1', 1, 4], ['t2', 2, 2], ['t3', 3, 6], ['t4', 4, 4],
  ['t5', 5, 4], ['t6', 6, 8], ['t7', 7, 4], ['t8', 8, 2],
  ['t9', 9, 6], ['t10', 10, 4], ['t11', 11, 8], ['t12', 12, 4],
];

const defaultEmployees = [
  ['employee-server-default', 'NV001', 'Nhân viên phục vụ', 'server', '0900 111 001', '08:00', '16:00'],
  ['employee-cashier-default', 'NV002', 'Thu ngân CAS', 'cashier', '0900 111 002', '08:00', '16:00'],
  ['employee-chef-default', 'NV003', 'Bếp trưởng CAS', 'chef', '0900 111 003', '09:00', '17:00'],
  ['employee-manager-default', 'NV004', 'Quản lý CAS', 'manager', '0900 111 004', '09:00', '18:00'],
];

/** Bổ sung liên kết nhân viên cho database cũ mà không làm thay đổi các hóa đơn lịch sử. */
async function ensureEmployeePaymentColumn(connection) {
  const [columns] = await connection.query(
    `SELECT column_name AS columnName FROM information_schema.columns
     WHERE table_schema = ? AND table_name = 'payment_transactions' AND column_name = 'staff_id'`,
    [databaseName],
  );
  if (columns.length === 0) {
    await connection.query(
      `ALTER TABLE payment_transactions
       ADD COLUMN staff_id VARCHAR(64) NULL AFTER item_count,
       ADD INDEX idx_payment_staff (staff_id, paid_at),
       ADD CONSTRAINT fk_payment_staff FOREIGN KEY (staff_id) REFERENCES employees(id) ON DELETE SET NULL`,
    );
  }
}

/** Lưu snapshot danh mục trên dòng hóa đơn để báo cáo lịch sử không đổi theo catalog hiện tại. */
async function ensurePaymentItemCategoryColumns(connection) {
  const migrationId = '20260714_payment_item_category_snapshot';
  const [applied] = await connection.query('SELECT id FROM schema_migrations WHERE id = ? LIMIT 1', [migrationId]);
  if (applied.length > 0) return;

  const [columns] = await connection.query(
    `SELECT column_name AS columnName FROM information_schema.columns
     WHERE table_schema = ? AND table_name = 'payment_items'`,
    [databaseName],
  );
  const columnNames = new Set(columns.map(column => column.columnName));
  if (!columnNames.has('category_id')) {
    await connection.query('ALTER TABLE payment_items ADD COLUMN category_id VARCHAR(64) NULL AFTER menu_item_id');
  }
  if (!columnNames.has('category_name')) {
    await connection.query('ALTER TABLE payment_items ADD COLUMN category_name VARCHAR(120) NULL AFTER category_id');
  }
  const [indexes] = await connection.query(
    `SELECT index_name AS indexName FROM information_schema.statistics
     WHERE table_schema = ? AND table_name = 'payment_items' AND index_name = 'idx_payment_item_category'`,
    [databaseName],
  );
  if (indexes.length === 0) {
    await connection.query('ALTER TABLE payment_items ADD INDEX idx_payment_item_category (category_id)');
  }
  await connection.query(
    `UPDATE payment_items pi
     LEFT JOIN menu_items mi ON mi.id = pi.menu_item_id
     LEFT JOIN menu_categories mc ON mc.id = mi.category_id
     SET pi.category_id = COALESCE(pi.category_id, mi.category_id),
       pi.category_name = COALESCE(pi.category_name, mc.name, 'Khác')
     WHERE pi.category_id IS NULL OR pi.category_name IS NULL`,
  );
  await connection.query('INSERT INTO schema_migrations (id) VALUES (?)', [migrationId]);
}

/** Nâng cấp an toàn database cũ lên schema queue hiện tại và chuyển timestamp legacy về UTC. */
async function ensureKitchenQueueColumns(connection) {
  const [columns] = await connection.query(
    `SELECT column_name AS columnName
     FROM information_schema.columns
     WHERE table_schema = ? AND table_name = 'active_orders'`,
    [databaseName],
  );
  const columnNames = new Set(columns.map(column => column.columnName));

  if (!columnNames.has('queued_at')) {
    await connection.query('ALTER TABLE active_orders ADD COLUMN queued_at DATETIME(3) NULL AFTER items');
    await connection.query('UPDATE active_orders SET queued_at = created_at WHERE queued_at IS NULL');
    await connection.query('ALTER TABLE active_orders MODIFY queued_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)');
  }
  if (!columnNames.has('cooking_started_at')) {
    await connection.query('ALTER TABLE active_orders ADD COLUMN cooking_started_at DATETIME(3) NULL AFTER queued_at');
  }
  if (!columnNames.has('estimated_cook_minutes')) {
    await connection.query('ALTER TABLE active_orders ADD COLUMN estimated_cook_minutes INT UNSIGNED NOT NULL DEFAULT 10 AFTER cooking_started_at');
  }

  const [queueColumns] = await connection.query(
    `SELECT column_name AS columnName FROM information_schema.columns
     WHERE table_schema = ? AND table_name = 'kitchen_queue_state'`,
    [databaseName],
  );
  if (!queueColumns.some(column => column.columnName === 'concurrency')) {
    await connection.query(`ALTER TABLE kitchen_queue_state ADD COLUMN concurrency INT UNSIGNED NOT NULL DEFAULT ${initialKitchenConcurrency()} AFTER id`);
  }
  if (!queueColumns.some(column => column.columnName === 'stale_after_minutes')) {
    await connection.query(`ALTER TABLE kitchen_queue_state ADD COLUMN stale_after_minutes INT UNSIGNED NOT NULL DEFAULT 120 AFTER concurrency`);
  }
  if (!queueColumns.some(column => column.columnName === 'automation_enabled')) {
    await connection.query('ALTER TABLE kitchen_queue_state ADD COLUMN automation_enabled BOOLEAN NOT NULL DEFAULT TRUE AFTER stale_after_minutes');
  }
  if (!queueColumns.some(column => column.columnName === 'paused')) {
    await connection.query('ALTER TABLE kitchen_queue_state ADD COLUMN paused BOOLEAN NOT NULL DEFAULT FALSE AFTER automation_enabled');
  }

  const [indexes] = await connection.query(
    `SELECT index_name AS indexName
     FROM information_schema.statistics
     WHERE table_schema = ? AND table_name = 'active_orders' AND index_name = 'idx_active_order_queue'`,
    [databaseName],
  );
  if (indexes.length === 0) {
    await connection.query('ALTER TABLE active_orders ADD INDEX idx_active_order_queue (queued_at, id)');
  }

  const migrationId = '20260712_kitchen_queue_timestamps_utc';
  const [applied] = await connection.query('SELECT id FROM schema_migrations WHERE id = ? LIMIT 1', [migrationId]);
  if (applied.length === 0) {
    const legacyOffsetMinutes = Number(process.env.LEGACY_TIMEZONE_OFFSET_MINUTES || 420);
    if (Number.isFinite(legacyOffsetMinutes) && legacyOffsetMinutes !== 0) {
      const offset = Math.trunc(legacyOffsetMinutes);
      await connection.query(
        `UPDATE active_orders
         SET queued_at = DATE_SUB(queued_at, INTERVAL ${offset} MINUTE),
             cooking_started_at = CASE
               WHEN cooking_started_at IS NULL THEN NULL
               ELSE DATE_SUB(cooking_started_at, INTERVAL ${offset} MINUTE)
             END`,
      );
    }
    await connection.query('INSERT INTO schema_migrations (id) VALUES (?)', [migrationId]);
  }

  // Mỗi active order cũ trở thành lượt gọi đầu tiên để nâng cấp không mất dữ liệu.
  await connection.query(
    `INSERT INTO order_batches (
      order_id, table_id, batch_number, items, status, is_addition,
      queued_at, cooking_started_at, completed_at, estimated_cook_minutes
    )
    SELECT o.id, o.table_id, 1, o.items,
      CASE WHEN t.status IN ('waiting', 'cooking', 'done') THEN t.status ELSE 'waiting' END,
      FALSE, o.queued_at, o.cooking_started_at,
      CASE WHEN t.status = 'done' THEN o.updated_at ELSE NULL END,
      o.estimated_cook_minutes
    FROM active_orders o
    INNER JOIN restaurant_tables t ON t.id = o.table_id
    LEFT JOIN order_batches b ON b.order_id = o.id
    WHERE b.id IS NULL`,
  );
}

/** Fail-fast khi production tắt auto-migrate nhưng schema chưa đúng phiên bản ứng dụng. */
async function verifyDatabaseSchema(connection) {
  const probes = [
    'SELECT id, settings FROM restaurant_settings LIMIT 0',
    'SELECT id, table_number, seats, status, reserved_time FROM restaurant_tables LIMIT 0',
    'SELECT id, category_id, cook_minutes, available FROM menu_items LIMIT 0',
    'SELECT id, table_id, items, estimated_cook_minutes FROM active_orders LIMIT 0',
    'SELECT id, order_id, table_id, batch_number, items, status, estimated_cook_minutes FROM order_batches LIMIT 0',
    'SELECT id, concurrency, stale_after_minutes, automation_enabled, paused FROM kitchen_queue_state LIMIT 0',
    'SELECT id, employee_code, full_name, role, active FROM employees LIMIT 0',
    'SELECT id, invoice_code, staff_id, paid_at FROM payment_transactions LIMIT 0',
    'SELECT id, transaction_id, category_id, category_name FROM payment_items LIMIT 0',
  ];
  for (const probe of probes) await connection.query(probe);
  const [[settingsRow], [queueRow]] = await Promise.all([
    connection.query('SELECT id FROM restaurant_settings WHERE id = 1 LIMIT 1'),
    connection.query('SELECT id FROM kitchen_queue_state WHERE id = 1 LIMIT 1'),
  ]);
  if (!settingsRow[0] || !queueRow[0]) {
    throw new Error('Database thiếu hàng cấu hình bắt buộc; hãy chạy npm run db:migrate trước khi khởi động.');
  }
}

/** Bootstrap database/pool; production có thể tắt DDL tự động bằng DB_AUTO_MIGRATE=false. */
export async function initDatabase({ migrate = autoMigrate } = {}) {
  if (pool) {
    try {
      await pool.query('SELECT 1');
      return pool;
    } catch {
      await pool.end().catch(() => {});
      pool = undefined;
    }
  }

  if (migrate) {
    let bootstrap;
    try {
      bootstrap = await mysql.createConnection({
        host: config.host,
        port: config.port,
        user: config.user,
        password: config.password,
        charset: config.charset,
        connectTimeout: config.connectTimeout,
      });
      await bootstrap.query(`CREATE DATABASE IF NOT EXISTS \`${databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    } finally {
      await bootstrap?.end().catch(() => {});
    }
  }

  pool = createPool();
  if (migrate) {
    for (const statement of schemaStatements) await pool.query(statement);
    await ensureEmployeePaymentColumn(pool);
    await ensurePaymentItemCategoryColumns(pool);
    await ensureKitchenQueueColumns(pool);

    await pool.query(
      'INSERT IGNORE INTO restaurant_settings (id, settings) VALUES (1, ?)',
      [JSON.stringify(defaultSettings)],
    );

    // Bàn mẫu chỉ được tạo một lần; bàn quản trị đã xóa không xuất hiện lại sau khi restart API.
    const tableSeedMigration = '20260714_seed_default_tables_once';
    const [tableSeedRows] = await pool.query(
      'SELECT id FROM schema_migrations WHERE id = ? LIMIT 1',
      [tableSeedMigration],
    );
    if (tableSeedRows.length === 0) {
      const [tableCounts] = await pool.query('SELECT COUNT(*) AS total FROM restaurant_tables');
      if (Number(tableCounts[0]?.total) === 0) {
        const placeholders = defaultTables.map(() => '(?, ?, ?)').join(', ');
        await pool.query(
          `INSERT INTO restaurant_tables (id, table_number, seats) VALUES ${placeholders}`,
          defaultTables.flat(),
        );
      }
      await pool.query('INSERT INTO schema_migrations (id) VALUES (?)', [tableSeedMigration]);
    }
    await pool.query(
      'INSERT IGNORE INTO kitchen_queue_state (id, concurrency, stale_after_minutes, automation_enabled, paused) VALUES (1, ?, ?, TRUE, FALSE)',
      [initialKitchenConcurrency(), initialKitchenStaleMinutes()],
    );
    const [employeeCounts] = await pool.query('SELECT COUNT(*) AS total FROM employees');
    if (Number(employeeCounts[0].total) === 0) {
      const employeePlaceholders = defaultEmployees.map(() => '(?, ?, ?, ?, ?, ?, ?, TRUE)').join(', ');
      await pool.query(
        `INSERT INTO employees (
          id, employee_code, full_name, role, phone, shift_start, shift_end, active
         ) VALUES ${employeePlaceholders}`,
        defaultEmployees.flat(),
      );
    }
  } else {
    await verifyDatabaseSchema(pool);
  }

  return pool;
}

/** Entry point migration chủ động dùng bởi `npm run db:migrate`. */
export async function migrateDatabase() {
  return initDatabase({ migrate: true });
}

export function getPool() {
  if (!pool) throw new Error('Database pool has not been initialized');
  return pool;
}

export async function closePool() {
  if (!pool) return;
  const currentPool = pool;
  pool = undefined;
  await currentPool.end();
}

export const databaseConfigSummary = {
  host: config.host,
  port: config.port,
  database: config.database,
};
