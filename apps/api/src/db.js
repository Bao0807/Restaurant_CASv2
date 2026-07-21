import mysql from 'mysql2/promise';
import { defaultSettings } from './defaultSettings.js';
import { businessDateFor } from './dailyInventory.js';

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
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT chk_settings_singleton CHECK (id = 1)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS restaurant_tables (
    id VARCHAR(32) NOT NULL PRIMARY KEY,
    table_number INT UNSIGNED NOT NULL UNIQUE,
    seats INT UNSIGNED NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'empty',
    area VARCHAR(80) NOT NULL DEFAULT 'Khu vực chung',
    position_x INT UNSIGNED NULL,
    position_y INT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT chk_restaurant_table_number CHECK (table_number BETWEEN 1 AND 999),
    CONSTRAINT chk_restaurant_table_seats CHECK (seats BETWEEN 1 AND 100),
    CONSTRAINT chk_restaurant_table_status CHECK (status IN ('empty', 'waiting', 'cooking', 'done')),
    CONSTRAINT chk_restaurant_table_area CHECK (CHAR_LENGTH(TRIM(area)) BETWEEN 1 AND 80),
    CONSTRAINT chk_restaurant_table_position CHECK (
      (position_x IS NULL AND position_y IS NULL)
      OR (position_x BETWEEN 1 AND 24 AND position_y BETWEEN 1 AND 24)
    ),
    INDEX idx_restaurant_table_status (status),
    CONSTRAINT uq_restaurant_table_area_position UNIQUE (area, position_x, position_y)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS reservations (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    reservation_code VARCHAR(32) NOT NULL UNIQUE,
    table_id VARCHAR(32) NULL,
    table_number INT UNSIGNED NOT NULL,
    customer_name VARCHAR(120) NOT NULL,
    customer_phone VARCHAR(32) NOT NULL,
    phone_normalized VARCHAR(15) NOT NULL,
    party_size INT UNSIGNED NOT NULL,
    reserved_at DATETIME(3) NOT NULL,
    ends_at DATETIME(3) NOT NULL,
    duration_minutes INT UNSIGNED NOT NULL DEFAULT 120,
    status VARCHAR(20) NOT NULL DEFAULT 'booked',
    seated_table_id VARCHAR(32) NULL,
    version INT UNSIGNED NOT NULL DEFAULT 1,
    notes VARCHAR(500) NOT NULL DEFAULT '',
    seated_at DATETIME(3) NULL,
    closed_at DATETIME(3) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_reservation_table FOREIGN KEY (table_id) REFERENCES restaurant_tables(id) ON DELETE SET NULL,
    CONSTRAINT chk_reservation_phone CHECK (phone_normalized REGEXP '^[0-9]{8,15}$'),
    CONSTRAINT chk_reservation_table_number CHECK (table_number BETWEEN 1 AND 999),
    CONSTRAINT chk_reservation_party_size CHECK (party_size BETWEEN 1 AND 100),
    CONSTRAINT chk_reservation_duration CHECK (duration_minutes BETWEEN 30 AND 480),
    CONSTRAINT chk_reservation_status CHECK (status IN ('booked', 'seated', 'cancelled', 'no_show', 'completed')),
    CONSTRAINT chk_reservation_window CHECK (ends_at = TIMESTAMPADD(MINUTE, duration_minutes, reserved_at)),
    CONSTRAINT chk_reservation_version CHECK (version >= 1),
    CONSTRAINT chk_reservation_lifecycle CHECK (
      (status = 'booked' AND seated_at IS NULL AND closed_at IS NULL)
      OR (status = 'seated' AND seated_at IS NOT NULL AND closed_at IS NULL)
      OR (status IN ('cancelled', 'no_show') AND seated_at IS NULL AND closed_at IS NOT NULL)
      OR (status = 'completed' AND seated_at IS NOT NULL AND closed_at IS NOT NULL AND closed_at >= seated_at)
    ),
    CONSTRAINT uq_reservation_id_table UNIQUE (id, table_id),
    CONSTRAINT uq_reservation_seated_table UNIQUE (seated_table_id),
    INDEX idx_reservation_schedule (status, reserved_at, ends_at),
    INDEX idx_reservation_table_schedule (table_id, status, reserved_at, ends_at),
    INDEX idx_reservation_phone (phone_normalized, reserved_at)
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
    daily_limit INT UNSIGNED NULL,
    available BOOLEAN NOT NULL DEFAULT TRUE,
    is_bestseller BOOLEAN NOT NULL DEFAULT FALSE,
    is_new BOOLEAN NOT NULL DEFAULT FALSE,
    sizes_json JSON NOT NULL,
    toppings_json JSON NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_menu_item_category FOREIGN KEY (category_id) REFERENCES menu_categories(id),
    CONSTRAINT chk_menu_item_cook_minutes CHECK (cook_minutes BETWEEN 1 AND 240),
    CONSTRAINT chk_menu_item_daily_limit CHECK (daily_limit IS NULL OR daily_limit <= 1000000),
    INDEX idx_menu_item_category (category_id),
    INDEX idx_menu_item_available (available)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS menu_item_daily_usage (
    menu_item_id VARCHAR(64) NOT NULL,
    business_date DATE NOT NULL,
    used_quantity INT UNSIGNED NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (menu_item_id, business_date),
    CONSTRAINT fk_daily_usage_menu_item FOREIGN KEY (menu_item_id) REFERENCES menu_items(id) ON DELETE CASCADE,
    CONSTRAINT chk_daily_usage_quantity CHECK (used_quantity <= 2000000000),
    INDEX idx_daily_usage_date (business_date, menu_item_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS active_orders (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    table_id VARCHAR(32) NOT NULL UNIQUE,
    reservation_id BIGINT UNSIGNED NULL,
    items JSON NOT NULL,
    queued_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    cooking_started_at DATETIME(3) NULL,
    estimated_cook_minutes INT UNSIGNED NOT NULL DEFAULT 10,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_active_order_table
      FOREIGN KEY (table_id) REFERENCES restaurant_tables(id)
      ON DELETE CASCADE,
    CONSTRAINT fk_active_order_reservation_table
      FOREIGN KEY (reservation_id, table_id) REFERENCES reservations(id, table_id),
    CONSTRAINT uq_active_order_reservation UNIQUE (reservation_id),
    CONSTRAINT uq_active_order_id_table UNIQUE (id, table_id),
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
    inventory_date DATE NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_order_batch_order_table FOREIGN KEY (order_id, table_id) REFERENCES active_orders(id, table_id) ON DELETE CASCADE,
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
    version BIGINT UNSIGNED NOT NULL DEFAULT 1,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT chk_kitchen_singleton CHECK (id = 1),
    CONSTRAINT chk_kitchen_concurrency CHECK (concurrency BETWEEN 1 AND 20),
    CONSTRAINT chk_kitchen_stale CHECK (stale_after_minutes BETWEEN 15 AND 1440),
    CONSTRAINT chk_kitchen_flags CHECK (automation_enabled IN (0, 1) AND paused IN (0, 1)),
    CONSTRAINT chk_kitchen_version CHECK (version >= 1)
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
    reservation_id BIGINT UNSIGNED NULL,
    reservation_code VARCHAR(32) NULL,
    customer_name VARCHAR(120) NULL,
    guest_count INT UNSIGNED NULL,
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
    service_status VARCHAR(32) NOT NULL DEFAULT 'closed',
    departure_confirmed_at DATETIME(3) NULL,
    paid_at DATETIME(3) NOT NULL,
    raw_payload JSON NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_payment_staff FOREIGN KEY (staff_id) REFERENCES employees(id) ON DELETE SET NULL,
    CONSTRAINT fk_payment_reservation FOREIGN KEY (reservation_id) REFERENCES reservations(id) ON DELETE SET NULL,
    CONSTRAINT chk_payment_guest_count CHECK (guest_count IS NULL OR guest_count BETWEEN 1 AND 100),
    CONSTRAINT chk_payment_reservation_snapshot CHECK (
      (reservation_code IS NULL AND customer_name IS NULL AND guest_count IS NULL)
      OR (reservation_code IS NOT NULL AND customer_name IS NOT NULL AND guest_count IS NOT NULL)
    ),
    CONSTRAINT chk_payment_service_status CHECK (service_status IN ('awaiting_departure', 'closed')),
    CONSTRAINT chk_payment_service_lifecycle CHECK (
      service_status = 'closed' OR departure_confirmed_at IS NULL
    ),
    INDEX idx_paid_at (paid_at),
    INDEX idx_table_id (table_id),
    INDEX idx_payment_staff (staff_id, paid_at),
    INDEX idx_payment_reservation (reservation_id, paid_at),
    INDEX idx_payment_service (service_status, table_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS active_order_payments (
    order_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
    transaction_id BIGINT UNSIGNED NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_active_order_payment_order
      FOREIGN KEY (order_id) REFERENCES active_orders(id)
      ON DELETE CASCADE,
    CONSTRAINT fk_active_order_payment_transaction
      FOREIGN KEY (transaction_id) REFERENCES payment_transactions(id)
      ON DELETE RESTRICT
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
  ['t1', 1, 4, 'Khu vực trong nhà', 1, 1],
  ['t2', 2, 2, 'Khu vực trong nhà', 2, 1],
  ['t3', 3, 6, 'Khu vực trong nhà', 1, 2],
  ['t4', 4, 4, 'Khu vực trong nhà', 2, 2],
  ['t5', 5, 4, 'Khu vực cửa sổ', 1, 1],
  ['t6', 6, 8, 'Khu vực cửa sổ', 2, 1],
  ['t7', 7, 4, 'Khu vực cửa sổ', 1, 2],
  ['t8', 8, 2, 'Khu vực cửa sổ', 2, 2],
  ['t9', 9, 6, 'Sân ngoài trời', 1, 1],
  ['t10', 10, 4, 'Sân ngoài trời', 2, 1],
  ['t11', 11, 8, 'Sân ngoài trời', 1, 2],
  ['t12', 12, 4, 'Sân ngoài trời', 2, 2],
];

const defaultEmployees = [
  ['employee-server-default', 'NV001', 'Nhân viên phục vụ', 'server', '', '08:00', '16:00'],
  ['employee-cashier-default', 'NV002', 'Thu ngân', 'cashier', '', '08:00', '16:00'],
  ['employee-chef-default', 'NV003', 'Nhân viên bếp', 'chef', '', '09:00', '17:00'],
  ['employee-manager-default', 'NV004', 'Quản lý', 'manager', '', '09:00', '18:00'],
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

/**
 * Bổ sung vòng đời phục vụ sau thanh toán sớm và liên kết 1-1 giữa order đang mở với hóa đơn.
 * Các hóa đơn cũ mặc định `closed`, vì trước tính năng này thanh toán luôn giải phóng bàn ngay.
 */
async function ensureEarlyPaymentLifecycle(connection) {
  const migrationId = '20260720_early_payment_lifecycle';
  const [columns] = await connection.query(
    `SELECT column_name AS columnName FROM information_schema.columns
     WHERE table_schema = ? AND table_name = 'payment_transactions'`,
    [databaseName],
  );
  const columnNames = new Set(columns.map(column => column.columnName));
  if (!columnNames.has('service_status')) {
    await connection.query(
      "ALTER TABLE payment_transactions ADD COLUMN service_status VARCHAR(32) NOT NULL DEFAULT 'closed' AFTER status",
    );
  }
  if (!columnNames.has('departure_confirmed_at')) {
    await connection.query(
      'ALTER TABLE payment_transactions ADD COLUMN departure_confirmed_at DATETIME(3) NULL AFTER service_status',
    );
  }

  const [invalidPayments] = await connection.query(
    `SELECT id FROM payment_transactions
     WHERE service_status NOT IN ('awaiting_departure', 'closed')
       OR (service_status = 'awaiting_departure' AND departure_confirmed_at IS NOT NULL)
     ORDER BY id LIMIT 10`,
  );
  if (invalidPayments.length > 0) {
    throw new Error(`Không thể migrate vòng đời thanh toán tại id ${invalidPayments.map(row => row.id).join(', ')}.`);
  }

  const [indexes] = await connection.query(
    `SELECT index_name AS indexName,
       GROUP_CONCAT(column_name ORDER BY seq_in_index SEPARATOR ',') AS columns
     FROM information_schema.statistics
     WHERE table_schema = ? AND table_name = 'payment_transactions'
       AND index_name = 'idx_payment_service'
     GROUP BY index_name`,
    [databaseName],
  );
  if (indexes.length === 0) {
    await connection.query(
      'ALTER TABLE payment_transactions ADD INDEX idx_payment_service (service_status, table_id)',
    );
  } else if (indexes[0].columns !== 'service_status,table_id') {
    throw new Error('Index idx_payment_service có định nghĩa không đúng; cần kiểm tra thủ công.');
  }

  const [checks] = await connection.query(
    `SELECT constraint_name AS constraintName FROM information_schema.table_constraints
     WHERE constraint_schema = ? AND table_name = 'payment_transactions' AND constraint_type = 'CHECK'`,
    [databaseName],
  );
  const checkNames = new Set(checks.map(constraint => constraint.constraintName));
  if (!checkNames.has('chk_payment_service_status')) {
    await connection.query(
      `ALTER TABLE payment_transactions ADD CONSTRAINT chk_payment_service_status
       CHECK (service_status IN ('awaiting_departure', 'closed'))`,
    );
  }
  if (!checkNames.has('chk_payment_service_lifecycle')) {
    await connection.query(
      `ALTER TABLE payment_transactions ADD CONSTRAINT chk_payment_service_lifecycle
       CHECK (service_status = 'closed' OR departure_confirmed_at IS NULL)`,
    );
  }

  // Hai INSERT của phiên bản cũ có thể lệch nhau 1 ms dù cùng một lượt gọi đầu tiên.
  await connection.query(
    `UPDATE active_orders activeOrder
     INNER JOIN (
       SELECT order_id, MIN(queued_at) AS firstQueuedAt
       FROM order_batches GROUP BY order_id
     ) batches ON batches.order_id = activeOrder.id
     SET activeOrder.queued_at = batches.firstQueuedAt
     WHERE activeOrder.queued_at <> batches.firstQueuedAt`,
  );

  // CREATE TABLE trong schemaStatements đã tạo bảng và cả hai FK trước khi hàm này chạy.
  await connection.query('INSERT IGNORE INTO schema_migrations (id) VALUES (?)', [migrationId]);
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

/** Bổ sung đầy đủ liên kết reservation cho database đã tồn tại trước tính năng đặt bàn. */
async function ensureReservationLinks(connection) {
  const [reservationColumns] = await connection.query(
    `SELECT column_name AS columnName, is_nullable AS isNullable, column_type AS columnType,
       column_default AS columnDefault, extra
     FROM information_schema.columns
     WHERE table_schema = ? AND table_name = 'reservations'`,
    [databaseName],
  );
  const reservationColumnsByName = new Map(reservationColumns.map(column => [column.columnName, column]));
  const phoneColumn = reservationColumnsByName.get('phone_normalized');
  if (!phoneColumn) {
    await connection.query('ALTER TABLE reservations ADD COLUMN phone_normalized VARCHAR(15) NULL AFTER customer_phone');
  }
  // Luôn chạy lại backfill/MODIFY để tự phục hồi nếu process cũ chết giữa ADD COLUMN và ALTER NOT NULL.
  await connection.query(
    `UPDATE reservations
     SET phone_normalized = LEFT(REGEXP_REPLACE(customer_phone, '[^0-9]', ''), 15)
     WHERE phone_normalized IS NULL OR phone_normalized NOT REGEXP '^[0-9]{8,15}$'`,
  );
  const [invalidPhones] = await connection.query(
    `SELECT id FROM reservations
     WHERE phone_normalized IS NULL OR phone_normalized NOT REGEXP '^[0-9]{8,15}$'
     ORDER BY id LIMIT 10`,
  );
  if (invalidPhones.length > 0) {
    throw new Error(`Không thể migrate reservation: số điện thoại không hợp lệ tại id ${invalidPhones.map(row => row.id).join(', ')}.`);
  }
  if (!phoneColumn || phoneColumn.isNullable !== 'NO' || String(phoneColumn.columnType).toLowerCase() !== 'varchar(15)') {
    await connection.query('ALTER TABLE reservations MODIFY phone_normalized VARCHAR(15) NOT NULL');
  }

  const endsAtColumn = reservationColumnsByName.get('ends_at');
  if (!endsAtColumn) {
    await connection.query('ALTER TABLE reservations ADD COLUMN ends_at DATETIME(3) NULL AFTER reserved_at');
  }
  const [invalidDurations] = await connection.query(
    `SELECT id FROM reservations
     WHERE reserved_at IS NULL OR duration_minutes IS NULL OR duration_minutes NOT BETWEEN 30 AND 480
     ORDER BY id LIMIT 10`,
  );
  if (invalidDurations.length > 0) {
    throw new Error(`Không thể migrate reservation: thời gian giữ bàn không hợp lệ tại id ${invalidDurations.map(row => row.id).join(', ')}.`);
  }
  await connection.query(
    `UPDATE reservations
     SET ends_at = TIMESTAMPADD(MINUTE, duration_minutes, reserved_at)
     WHERE ends_at IS NULL OR ends_at <> TIMESTAMPADD(MINUTE, duration_minutes, reserved_at)`,
  );
  if (!endsAtColumn || endsAtColumn.isNullable !== 'NO' || String(endsAtColumn.columnType).toLowerCase() !== 'datetime(3)') {
    await connection.query('ALTER TABLE reservations MODIFY ends_at DATETIME(3) NOT NULL');
  }

  const versionColumn = reservationColumnsByName.get('version');
  if (!versionColumn) {
    await connection.query('ALTER TABLE reservations ADD COLUMN version INT UNSIGNED NOT NULL DEFAULT 1 AFTER status');
  }
  await connection.query('UPDATE reservations SET version = 1 WHERE version IS NULL OR version < 1');
  if (!versionColumn || versionColumn.isNullable !== 'NO'
    || String(versionColumn.columnType).toLowerCase() !== 'int unsigned'
    || Number(versionColumn.columnDefault) !== 1) {
    await connection.query('ALTER TABLE reservations MODIFY version INT UNSIGNED NOT NULL DEFAULT 1');
  }

  const [currentReservationColumns] = await connection.query(
    `SELECT column_name AS columnName, column_type AS columnType, is_nullable AS isNullable, extra
     FROM information_schema.columns
     WHERE table_schema = ? AND table_name = 'reservations'`,
    [databaseName],
  );
  const seatedTableColumn = currentReservationColumns.find(column => column.columnName === 'seated_table_id');
  if (!seatedTableColumn) {
    // MySQL không rebuild được bảng cha khi còn inbound FK. Drop theo tên rồi các
    // bước idempotent bên dưới sẽ tạo lại, kể cả khi process chết giữa migration.
    const [inboundReservationFks] = await connection.query(
      `SELECT table_name AS tableName, constraint_name AS constraintName
       FROM information_schema.referential_constraints
       WHERE constraint_schema = ? AND referenced_table_name = 'reservations'
         AND constraint_name IN ('fk_active_order_reservation_table', 'fk_payment_reservation')`,
      [databaseName],
    );
    for (const foreignKey of inboundReservationFks) {
      await connection.query(
        `ALTER TABLE \`${foreignKey.tableName}\` DROP FOREIGN KEY \`${foreignKey.constraintName}\``,
      );
    }
    await connection.query('ALTER TABLE reservations ADD COLUMN seated_table_id VARCHAR(32) NULL');
  } else if (String(seatedTableColumn.extra).toLowerCase().includes('generated')) {
    throw new Error('reservations.seated_table_id dạng generated không tương thích FK ON DELETE SET NULL; cần đổi thành VARCHAR(32) thường.');
  } else if (String(seatedTableColumn.columnType).toLowerCase() !== 'varchar(32)' || seatedTableColumn.isNullable !== 'YES') {
    await connection.query('ALTER TABLE reservations MODIFY seated_table_id VARCHAR(32) NULL');
  }
  const [duplicateSeatedTables] = await connection.query(
    `SELECT table_id AS tableId, COUNT(*) AS total FROM reservations
     WHERE status = 'seated' AND table_id IS NOT NULL
     GROUP BY table_id HAVING COUNT(*) > 1 LIMIT 10`,
  );
  if (duplicateSeatedTables.length > 0) {
    throw new Error(`Không thể migrate reservation: nhiều lịch seated trên bàn ${duplicateSeatedTables.map(row => row.tableId).join(', ')}.`);
  }
  await connection.query(
    `UPDATE reservations
     SET seated_table_id = CASE WHEN status = 'seated' THEN table_id ELSE NULL END
     WHERE NOT (seated_table_id <=> CASE WHEN status = 'seated' THEN table_id ELSE NULL END)`,
  );
  const [seatedIndexes] = await connection.query(
    `SELECT index_name AS indexName, non_unique AS nonUnique,
       GROUP_CONCAT(column_name ORDER BY seq_in_index SEPARATOR ',') AS columns
     FROM information_schema.statistics
     WHERE table_schema = ? AND table_name = 'reservations'
       AND index_name = 'uq_reservation_seated_table'
     GROUP BY index_name, non_unique`,
    [databaseName],
  );
  if (seatedIndexes.length === 0) {
    await connection.query('ALTER TABLE reservations ADD CONSTRAINT uq_reservation_seated_table UNIQUE (seated_table_id)');
  } else if (Number(seatedIndexes[0].nonUnique) !== 0 || seatedIndexes[0].columns !== 'seated_table_id') {
    throw new Error('Index uq_reservation_seated_table có định nghĩa không đúng; cần kiểm tra thủ công.');
  }

  const [reservationIndexes] = await connection.query(
    `SELECT index_name AS indexName,
       GROUP_CONCAT(column_name ORDER BY seq_in_index SEPARATOR ',') AS columns
     FROM information_schema.statistics
     WHERE table_schema = ? AND table_name = 'reservations'
       AND index_name IN ('idx_reservation_schedule', 'idx_reservation_table_schedule', 'idx_reservation_phone')
     GROUP BY index_name`,
    [databaseName],
  );
  const reservationIndexColumns = new Map(
    reservationIndexes.map(index => [index.indexName, index.columns]),
  );
  const requiredReservationIndexes = [
    ['idx_reservation_schedule', 'status,reserved_at,ends_at'],
    ['idx_reservation_table_schedule', 'table_id,status,reserved_at,ends_at'],
    ['idx_reservation_phone', 'phone_normalized,reserved_at'],
  ];
  for (const [name, columns] of requiredReservationIndexes) {
    const currentColumns = reservationIndexColumns.get(name);
    if (currentColumns && currentColumns !== columns) {
      if (name === 'idx_reservation_table_schedule') {
        const [temporaryIndexes] = await connection.query(
          `SELECT index_name FROM information_schema.statistics
           WHERE table_schema = ? AND table_name = 'reservations'
             AND index_name = 'idx_reservation_table_fk_tmp' LIMIT 1`,
          [databaseName],
        );
        if (temporaryIndexes.length === 0) {
          await connection.query('ALTER TABLE reservations ADD INDEX idx_reservation_table_fk_tmp (table_id)');
        }
      }
      await connection.query(`ALTER TABLE reservations DROP INDEX ${name}`);
    }
    if (currentColumns !== columns) {
      await connection.query(`ALTER TABLE reservations ADD INDEX ${name} (${columns})`);
    }
    if (name === 'idx_reservation_table_schedule') {
      const [temporaryIndexes] = await connection.query(
        `SELECT index_name FROM information_schema.statistics
         WHERE table_schema = ? AND table_name = 'reservations'
           AND index_name = 'idx_reservation_table_fk_tmp' LIMIT 1`,
        [databaseName],
      );
      if (temporaryIndexes.length > 0) {
        await connection.query('ALTER TABLE reservations DROP INDEX idx_reservation_table_fk_tmp');
      }
    }
  }

  const [activeOrderColumns] = await connection.query(
    `SELECT column_name AS columnName FROM information_schema.columns
     WHERE table_schema = ? AND table_name = 'active_orders'`,
    [databaseName],
  );
  if (!activeOrderColumns.some(column => column.columnName === 'reservation_id')) {
    await connection.query('ALTER TABLE active_orders ADD COLUMN reservation_id BIGINT UNSIGNED NULL AFTER table_id');
  }
  const [activeReservationIndex] = await connection.query(
    `SELECT index_name AS indexName FROM information_schema.statistics
     WHERE table_schema = ? AND table_name = 'active_orders'
       AND column_name = 'reservation_id' AND non_unique = 0 LIMIT 1`,
    [databaseName],
  );
  if (activeReservationIndex.length === 0) {
    await connection.query('ALTER TABLE active_orders ADD CONSTRAINT uq_active_order_reservation UNIQUE (reservation_id)');
  }
  const [paymentColumns] = await connection.query(
    `SELECT column_name AS columnName FROM information_schema.columns
     WHERE table_schema = ? AND table_name = 'payment_transactions'`,
    [databaseName],
  );
  const paymentColumnNames = new Set(paymentColumns.map(column => column.columnName));
  if (!paymentColumnNames.has('reservation_id')) {
    await connection.query('ALTER TABLE payment_transactions ADD COLUMN reservation_id BIGINT UNSIGNED NULL AFTER table_number');
  }
  if (!paymentColumnNames.has('reservation_code')) {
    await connection.query('ALTER TABLE payment_transactions ADD COLUMN reservation_code VARCHAR(32) NULL AFTER reservation_id');
  }
  if (!paymentColumnNames.has('customer_name')) {
    await connection.query('ALTER TABLE payment_transactions ADD COLUMN customer_name VARCHAR(120) NULL AFTER reservation_code');
  }
  if (!paymentColumnNames.has('guest_count')) {
    await connection.query('ALTER TABLE payment_transactions ADD COLUMN guest_count INT UNSIGNED NULL AFTER customer_name');
  }
  const [paymentReservationIndex] = await connection.query(
    `SELECT index_name AS indexName FROM information_schema.statistics
     WHERE table_schema = ? AND table_name = 'payment_transactions'
       AND index_name = 'idx_payment_reservation'`,
    [databaseName],
  );
  if (paymentReservationIndex.length === 0) {
    await connection.query('ALTER TABLE payment_transactions ADD INDEX idx_payment_reservation (reservation_id, paid_at)');
  }
  const [paymentReservationFk] = await connection.query(
    `SELECT constraint_name AS constraintName FROM information_schema.referential_constraints
     WHERE constraint_schema = ? AND table_name = 'payment_transactions'
       AND constraint_name = 'fk_payment_reservation'`,
    [databaseName],
  );
  if (paymentReservationFk.length === 0) {
    await connection.query(
      `ALTER TABLE payment_transactions ADD CONSTRAINT fk_payment_reservation
      FOREIGN KEY (reservation_id) REFERENCES reservations(id) ON DELETE SET NULL`,
    );
  }
  const [paymentChecks] = await connection.query(
    `SELECT constraint_name AS constraintName FROM information_schema.table_constraints
     WHERE constraint_schema = ? AND table_name = 'payment_transactions' AND constraint_type = 'CHECK'`,
    [databaseName],
  );
  if (!paymentChecks.some(constraint => constraint.constraintName === 'chk_payment_guest_count')) {
    await connection.query(
      `ALTER TABLE payment_transactions ADD CONSTRAINT chk_payment_guest_count
       CHECK (guest_count IS NULL OR guest_count BETWEEN 1 AND 100)`,
    );
  }

  // Trạng thái đặt trước legacy không có ngày/khách nên không thể giữ bàn vô thời hạn.
  await connection.query(
    `UPDATE restaurant_tables
     SET status = 'empty'
     WHERE status = 'reserved'`,
  );
  await connection.query('INSERT IGNORE INTO schema_migrations (id) VALUES (?)', ['20260715_reservation_links']);
}

/** Ràng buộc batch phải cùng bàn với order và bảo đảm reservation đang mở còn bàn hợp lệ. */
async function ensureReservationAndOrderIntegrity(connection) {
  const migrationId = '20260715_reservations_and_order_batch_integrity';

  // Sửa dữ liệu legacy theo active order là nguồn sự thật trước khi thêm composite FK.
  await connection.query(
    `UPDATE order_batches b
     INNER JOIN active_orders o ON o.id = b.order_id
     SET b.table_id = o.table_id
     WHERE b.table_id <> o.table_id`,
  );

  // Liên kết reservation của order phải thuộc chính bàn đó; link legacy sai được bỏ thay vì đoán lại.
  await connection.query(
    `UPDATE active_orders o
     LEFT JOIN reservations r ON r.id = o.reservation_id AND r.table_id = o.table_id
     SET o.reservation_id = NULL
     WHERE o.reservation_id IS NOT NULL AND r.id IS NULL`,
  );

  const [reservationIndexes] = await connection.query(
    `SELECT index_name AS indexName FROM information_schema.statistics
     WHERE table_schema = ? AND table_name = 'reservations'
       AND index_name = 'uq_reservation_id_table'`,
    [databaseName],
  );
  if (reservationIndexes.length === 0) {
    await connection.query('ALTER TABLE reservations ADD CONSTRAINT uq_reservation_id_table UNIQUE (id, table_id)');
  }

  const [legacyReservationConstraints] = await connection.query(
    `SELECT constraint_name AS constraintName FROM information_schema.referential_constraints
     WHERE constraint_schema = ? AND table_name = 'active_orders'
       AND constraint_name = 'fk_active_order_reservation'`,
    [databaseName],
  );
  if (legacyReservationConstraints.length > 0) {
    await connection.query('ALTER TABLE active_orders DROP FOREIGN KEY fk_active_order_reservation');
  }
  const [reservationOrderConstraints] = await connection.query(
    `SELECT constraint_name AS constraintName FROM information_schema.referential_constraints
     WHERE constraint_schema = ? AND table_name = 'active_orders'
       AND constraint_name = 'fk_active_order_reservation_table'`,
    [databaseName],
  );
  if (reservationOrderConstraints.length === 0) {
    await connection.query(
      `ALTER TABLE active_orders ADD CONSTRAINT fk_active_order_reservation_table
       FOREIGN KEY (reservation_id, table_id) REFERENCES reservations(id, table_id)`,
    );
  }

  const [activeOrderIndexes] = await connection.query(
    `SELECT index_name AS indexName FROM information_schema.statistics
     WHERE table_schema = ? AND table_name = 'active_orders'
       AND index_name = 'uq_active_order_id_table'`,
    [databaseName],
  );
  if (activeOrderIndexes.length === 0) {
    await connection.query('ALTER TABLE active_orders ADD CONSTRAINT uq_active_order_id_table UNIQUE (id, table_id)');
  }

  const [batchConstraints] = await connection.query(
    `SELECT constraint_name AS constraintName FROM information_schema.referential_constraints
     WHERE constraint_schema = ? AND table_name = 'order_batches'
       AND constraint_name = 'fk_order_batch_order_table'`,
    [databaseName],
  );
  if (batchConstraints.length === 0) {
    await connection.query(
      `ALTER TABLE order_batches
       ADD CONSTRAINT fk_order_batch_order_table
      FOREIGN KEY (order_id, table_id) REFERENCES active_orders(id, table_id) ON DELETE CASCADE`,
    );
  }

  const [legacyBatchConstraints] = await connection.query(
    `SELECT constraint_name AS constraintName FROM information_schema.referential_constraints
     WHERE constraint_schema = ? AND table_name = 'order_batches'
       AND constraint_name = 'fk_order_batch_order'`,
    [databaseName],
  );
  if (legacyBatchConstraints.length > 0) {
    await connection.query('ALTER TABLE order_batches DROP FOREIGN KEY fk_order_batch_order');
  }

  await connection.query('INSERT IGNORE INTO schema_migrations (id) VALUES (?)', [migrationId]);
}

/** Nâng cấp an toàn database cũ lên schema queue hiện tại và chuyển timestamp legacy về UTC. */
/**
 * Thay CHECK theo tên trong một migration có marker. DDL của MySQL tự commit, vì vậy mỗi lần chạy dở
 * vẫn tự phục hồi: constraint đã thêm sẽ được drop/re-add, marker chỉ ghi sau khi toàn bộ hoàn tất.
 */
async function replaceCheckConstraints(connection, tableName, definitions) {
  const [rows] = await connection.query(
    `SELECT constraint_name AS constraintName
     FROM information_schema.table_constraints
     WHERE constraint_schema = ? AND table_name = ? AND constraint_type = 'CHECK'`,
    [databaseName, tableName],
  );
  const existing = new Set(rows.map(row => row.constraintName));
  for (const [name, expression] of definitions) {
    if (existing.has(name)) {
      await connection.query(`ALTER TABLE \`${tableName}\` DROP CHECK \`${name}\``);
    }
    await connection.query(`ALTER TABLE \`${tableName}\` ADD CONSTRAINT \`${name}\` CHECK (${expression})`);
  }
}

/**
 * Bổ sung khu vực và tọa độ cho sơ đồ bàn trên database cũ.
 * Tọa độ là chỉ số cột/hàng của lưới sơ đồ, trong khoảng 1..24;
 * cả hai tọa độ phải cùng có giá trị hoặc cùng NULL để tránh một vị trí nửa vời.
 */
async function ensureRestaurantTableLayout(connection) {
  const migrationId = '20260720_restaurant_table_layout_v2';
  const [applied] = await connection.query(
    'SELECT id FROM schema_migrations WHERE id = ? LIMIT 1',
    [migrationId],
  );
  if (applied.length > 0) return;

  const [columnRows] = await connection.query(
    `SELECT column_name AS columnName
     FROM information_schema.columns
     WHERE table_schema = ? AND table_name = 'restaurant_tables'`,
    [databaseName],
  );
  const columns = new Set(columnRows.map(column => column.columnName));
  if (!columns.has('area')) {
    await connection.query(
      "ALTER TABLE restaurant_tables ADD COLUMN area VARCHAR(80) NOT NULL DEFAULT 'Khu vực chung' AFTER status",
    );
  }
  if (!columns.has('position_x')) {
    await connection.query('ALTER TABLE restaurant_tables ADD COLUMN position_x INT UNSIGNED NULL AFTER area');
  }
  if (!columns.has('position_y')) {
    await connection.query('ALTER TABLE restaurant_tables ADD COLUMN position_y INT UNSIGNED NULL AFTER position_x');
  }

  await connection.query(
    "UPDATE restaurant_tables SET area = 'Khu vực chung' WHERE area IS NULL OR TRIM(area) = ''",
  );
  await connection.query(
    `UPDATE restaurant_tables SET position_x = NULL, position_y = NULL
     WHERE (position_x IS NULL AND position_y IS NOT NULL)
        OR (position_x IS NOT NULL AND position_y IS NULL)`,
  );
  const [legacyLayoutRows] = await connection.query(
    "SELECT id FROM schema_migrations WHERE id = '20260720_restaurant_table_layout' LIMIT 1",
  );
  const legacyLayoutApplied = legacyLayoutRows.length > 0;
  // Chỉ bố trí bàn mẫu chưa có vị trí; nhánh legacy sửa lại bản migration thử nghiệm dùng thang 0..10000.
  for (const [id, , , area, positionX, positionY] of defaultTables) {
    await connection.query(
      `UPDATE restaurant_tables SET area = ?, position_x = ?, position_y = ?
       WHERE id = ? AND (
         (area = 'Khu vực chung' AND position_x IS NULL AND position_y IS NULL)
         OR (? = TRUE AND area = ?)
       )`,
      [area, positionX, positionY, id, legacyLayoutApplied, area],
    );
  }
  const [invalidRows] = await connection.query(
    `SELECT id FROM restaurant_tables
     WHERE CHAR_LENGTH(TRIM(area)) NOT BETWEEN 1 AND 80
        OR (position_x IS NOT NULL AND position_x NOT BETWEEN 1 AND 24)
        OR (position_y IS NOT NULL AND position_y NOT BETWEEN 1 AND 24)
     ORDER BY id LIMIT 10`,
  );
  if (invalidRows.length > 0) {
    throw new Error(`Không thể thêm sơ đồ bàn; dữ liệu vị trí sai tại id ${invalidRows.map(row => row.id).join(', ')}.`);
  }
  await connection.query(
    `ALTER TABLE restaurant_tables
     MODIFY area VARCHAR(80) NOT NULL DEFAULT 'Khu vực chung',
     MODIFY position_x INT UNSIGNED NULL,
     MODIFY position_y INT UNSIGNED NULL`,
  );

  const [indexRows] = await connection.query(
    `SELECT index_name AS indexName,
       non_unique AS nonUnique,
       GROUP_CONCAT(column_name ORDER BY seq_in_index SEPARATOR ',') AS columns
     FROM information_schema.statistics
     WHERE table_schema = ? AND table_name = 'restaurant_tables'
       AND index_name IN ('idx_restaurant_table_area_position', 'uq_restaurant_table_area_position')
     GROUP BY index_name, non_unique`,
    [databaseName],
  );
  let validUniqueIndex = false;
  for (const index of indexRows) {
    const valid = index.indexName === 'uq_restaurant_table_area_position'
      && Number(index.nonUnique) === 0
      && index.columns === 'area,position_x,position_y';
    if (valid) {
      validUniqueIndex = true;
    } else {
      await connection.query(`ALTER TABLE restaurant_tables DROP INDEX \`${index.indexName}\``);
    }
  }
  const [duplicatePositions] = await connection.query(
    `SELECT area, position_x AS positionX, position_y AS positionY, COUNT(*) AS total
     FROM restaurant_tables
     WHERE position_x IS NOT NULL AND position_y IS NOT NULL
     GROUP BY area, position_x, position_y
     HAVING COUNT(*) > 1
     LIMIT 10`,
  );
  if (duplicatePositions.length > 0) {
    throw new Error('Không thể thêm sơ đồ bàn vì có nhiều bàn trùng vị trí trong cùng khu vực.');
  }
  if (!validUniqueIndex) {
    await connection.query(
      `ALTER TABLE restaurant_tables
       ADD CONSTRAINT uq_restaurant_table_area_position UNIQUE (area, position_x, position_y)`,
    );
  }

  await replaceCheckConstraints(connection, 'restaurant_tables', [
    ['chk_restaurant_table_area', 'CHAR_LENGTH(TRIM(area)) BETWEEN 1 AND 80'],
    ['chk_restaurant_table_position', `
      (position_x IS NULL AND position_y IS NULL)
      OR (position_x BETWEEN 1 AND 24 AND position_y BETWEEN 1 AND 24)
    `],
  ]);

  await connection.query('INSERT INTO schema_migrations (id) VALUES (?)', [migrationId]);
}

/**
 * Bổ sung hạn mức món theo ngày. Ledger giữ từng ngày nên sang ngày mới tự có tồn mới;
 * `inventory_date` trên batch giúp sửa/hủy đúng bucket dù phiếu đã được requeue.
 */
async function ensureDailyMenuInventory(connection) {
  const migrationId = '20260721_daily_menu_inventory';
  const [menuColumns] = await connection.query(
    `SELECT column_name AS columnName FROM information_schema.columns
     WHERE table_schema = ? AND table_name = 'menu_items'`,
    [databaseName],
  );
  if (!menuColumns.some(column => column.columnName === 'daily_limit')) {
    await connection.query('ALTER TABLE menu_items ADD COLUMN daily_limit INT UNSIGNED NULL AFTER cook_minutes');
  }

  await connection.query(
    `CREATE TABLE IF NOT EXISTS menu_item_daily_usage (
      menu_item_id VARCHAR(64) NOT NULL,
      business_date DATE NOT NULL,
      used_quantity INT UNSIGNED NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (menu_item_id, business_date),
      CONSTRAINT fk_daily_usage_menu_item FOREIGN KEY (menu_item_id) REFERENCES menu_items(id) ON DELETE CASCADE,
      CONSTRAINT chk_daily_usage_quantity CHECK (used_quantity <= 2000000000),
      INDEX idx_daily_usage_date (business_date, menu_item_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  );

  const [batchColumns] = await connection.query(
    `SELECT column_name AS columnName, is_nullable AS isNullable
     FROM information_schema.columns
     WHERE table_schema = ? AND table_name = 'order_batches'`,
    [databaseName],
  );
  let inventoryColumn = batchColumns.find(column => column.columnName === 'inventory_date');
  if (!inventoryColumn) {
    await connection.query('ALTER TABLE order_batches ADD COLUMN inventory_date DATE NULL AFTER estimated_cook_minutes');
    inventoryColumn = { isNullable: 'YES' };
  }

  const [missingInventoryDates] = await connection.query(
    'SELECT id, queued_at AS queuedAt FROM order_batches WHERE inventory_date IS NULL ORDER BY id',
  );
  for (const batch of missingInventoryDates) {
    await connection.query(
      'UPDATE order_batches SET inventory_date = ? WHERE id = ? AND inventory_date IS NULL',
      [businessDateFor(batch.queuedAt), batch.id],
    );
  }

  const [applied] = await connection.query(
    'SELECT id FROM schema_migrations WHERE id = ? LIMIT 1',
    [migrationId],
  );
  if (applied.length === 0) {
    // Active batch được tính một lần để hủy/sửa ngay sau nâng cấp không làm ledger thiếu số lượng.
    await connection.query(
      `INSERT INTO menu_item_daily_usage (menu_item_id, business_date, used_quantity)
       SELECT extracted.menu_item_id, batch.inventory_date, SUM(extracted.quantity)
       FROM order_batches batch
       INNER JOIN JSON_TABLE(
         batch.items,
         '$[*]' COLUMNS (
           menu_item_id VARCHAR(64) PATH '$.menuItem.id' NULL ON ERROR,
           quantity INT PATH '$.quantity' NULL ON ERROR
         )
       ) extracted
       INNER JOIN menu_items item ON item.id = extracted.menu_item_id COLLATE utf8mb4_unicode_ci
       WHERE extracted.menu_item_id IS NOT NULL AND extracted.quantity > 0
       GROUP BY extracted.menu_item_id, batch.inventory_date
       ON DUPLICATE KEY UPDATE used_quantity = GREATEST(used_quantity, VALUES(used_quantity))`,
    );
  }

  if (inventoryColumn.isNullable !== 'NO') {
    await connection.query('ALTER TABLE order_batches MODIFY inventory_date DATE NOT NULL');
  }

  const [menuChecks] = await connection.query(
    `SELECT constraint_name AS constraintName FROM information_schema.table_constraints
     WHERE constraint_schema = ? AND table_name = 'menu_items' AND constraint_type = 'CHECK'`,
    [databaseName],
  );
  if (!menuChecks.some(check => check.constraintName === 'chk_menu_item_daily_limit')) {
    await connection.query(
      `ALTER TABLE menu_items ADD CONSTRAINT chk_menu_item_daily_limit
       CHECK (daily_limit IS NULL OR daily_limit <= 1000000)`,
    );
  }

  await connection.query('INSERT IGNORE INTO schema_migrations (id) VALUES (?)', [migrationId]);
}

/** Gia cố invariant đơn giản ở tầng MySQL; invariant liên bảng/phạm vi thời gian vẫn do transaction API quản lý. */
async function ensureDatabaseIntegrityConstraints(connection) {
  const migrationId = '20260715_database_integrity_constraints_v3';
  const [applied] = await connection.query(
    'SELECT id FROM schema_migrations WHERE id = ? LIMIT 1',
    [migrationId],
  );
  if (applied.length > 0) return;

  const [invalidSettings] = await connection.query('SELECT id FROM restaurant_settings WHERE id <> 1 LIMIT 10');
  if (invalidSettings.length > 0) {
    throw new Error(`restaurant_settings chỉ được có id=1; tìm thấy ${invalidSettings.map(row => row.id).join(', ')}.`);
  }

  await connection.query("UPDATE restaurant_tables SET status = 'empty' WHERE status = 'reserved'");
  const [legacyReservationColumns] = await connection.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = ? AND table_name = 'restaurant_tables' AND column_name = 'reserved_time'`,
    [databaseName],
  );
  if (legacyReservationColumns.length > 0) {
    await connection.query('ALTER TABLE restaurant_tables DROP COLUMN reserved_time');
  }
  const [invalidTables] = await connection.query(
    `SELECT id FROM restaurant_tables
     WHERE table_number NOT BETWEEN 1 AND 999
        OR seats NOT BETWEEN 1 AND 100
        OR status NOT IN ('empty', 'waiting', 'cooking', 'done')
     ORDER BY id LIMIT 10`,
  );
  if (invalidTables.length > 0) {
    throw new Error(`Không thể gia cố restaurant_tables; dữ liệu sai tại id ${invalidTables.map(row => row.id).join(', ')}.`);
  }

  const [invalidReservations] = await connection.query(
    `SELECT id FROM reservations
     WHERE table_number NOT BETWEEN 1 AND 999
        OR phone_normalized IS NULL OR phone_normalized NOT REGEXP '^[0-9]{8,15}$'
        OR party_size IS NULL OR party_size NOT BETWEEN 1 AND 100
        OR reserved_at IS NULL OR ends_at IS NULL OR duration_minutes IS NULL
        OR duration_minutes NOT BETWEEN 30 AND 480
        OR ends_at <> TIMESTAMPADD(MINUTE, duration_minutes, reserved_at)
        OR status IS NULL OR status NOT IN ('booked', 'seated', 'cancelled', 'no_show', 'completed')
        OR version IS NULL OR version < 1
        OR (status = 'seated' AND (seated_table_id IS NULL OR NOT (seated_table_id <=> table_id)))
        OR (status <> 'seated' AND seated_table_id IS NOT NULL)
        OR (status = 'booked' AND (seated_at IS NOT NULL OR closed_at IS NOT NULL))
        OR (status = 'seated' AND (seated_at IS NULL OR closed_at IS NOT NULL))
        OR (status IN ('cancelled', 'no_show') AND (seated_at IS NOT NULL OR closed_at IS NULL))
        OR (status = 'completed' AND (seated_at IS NULL OR closed_at IS NULL OR closed_at < seated_at))
     ORDER BY id LIMIT 10`,
  );
  if (invalidReservations.length > 0) {
    throw new Error(`Không thể gia cố reservations; vòng đời sai tại id ${invalidReservations.map(row => row.id).join(', ')}.`);
  }

  await connection.query('UPDATE kitchen_queue_state SET version = 1 WHERE version IS NULL OR version < 1');
  const [invalidKitchenRows] = await connection.query(
    `SELECT id FROM kitchen_queue_state
     WHERE id <> 1 OR concurrency NOT BETWEEN 1 AND 20
        OR stale_after_minutes NOT BETWEEN 15 AND 1440
        OR automation_enabled NOT IN (0, 1) OR paused NOT IN (0, 1)
     LIMIT 10`,
  );
  if (invalidKitchenRows.length > 0) {
    throw new Error(`Không thể gia cố kitchen_queue_state tại id ${invalidKitchenRows.map(row => row.id).join(', ')}.`);
  }
  await connection.query(
    `UPDATE payment_transactions payment
     INNER JOIN reservations reservation ON reservation.id = payment.reservation_id
     SET payment.reservation_code = COALESCE(payment.reservation_code, reservation.reservation_code),
       payment.customer_name = COALESCE(payment.customer_name, reservation.customer_name),
       payment.guest_count = COALESCE(payment.guest_count, reservation.party_size)
     WHERE payment.reservation_id IS NOT NULL
       AND (payment.reservation_code IS NULL OR payment.customer_name IS NULL OR payment.guest_count IS NULL)`,
  );
  const [invalidPaymentSnapshots] = await connection.query(
    `SELECT id FROM payment_transactions
     WHERE (reservation_id IS NOT NULL
       AND (reservation_code IS NULL OR customer_name IS NULL OR guest_count IS NULL))
       OR NOT (
         (reservation_code IS NULL AND customer_name IS NULL AND guest_count IS NULL)
         OR (reservation_code IS NOT NULL AND customer_name IS NOT NULL AND guest_count IS NOT NULL)
       )
     ORDER BY id LIMIT 10`,
  );
  if (invalidPaymentSnapshots.length > 0) {
    throw new Error(`Không thể gia cố payment snapshot tại id ${invalidPaymentSnapshots.map(row => row.id).join(', ')}.`);
  }

  await replaceCheckConstraints(connection, 'restaurant_settings', [
    ['chk_settings_singleton', 'id = 1'],
  ]);
  await replaceCheckConstraints(connection, 'restaurant_tables', [
    ['chk_restaurant_table_number', 'table_number BETWEEN 1 AND 999'],
    ['chk_restaurant_table_status', "status IN ('empty', 'waiting', 'cooking', 'done')"],
  ]);
  await replaceCheckConstraints(connection, 'reservations', [
    ['chk_reservation_phone', "phone_normalized REGEXP '^[0-9]{8,15}$'"],
    ['chk_reservation_table_number', 'table_number BETWEEN 1 AND 999'],
    ['chk_reservation_party_size', 'party_size BETWEEN 1 AND 100'],
    ['chk_reservation_duration', 'duration_minutes BETWEEN 30 AND 480'],
    ['chk_reservation_status', "status IN ('booked', 'seated', 'cancelled', 'no_show', 'completed')"],
    ['chk_reservation_window', 'ends_at = TIMESTAMPADD(MINUTE, duration_minutes, reserved_at)'],
    ['chk_reservation_version', 'version >= 1'],
    ['chk_reservation_lifecycle', `
      (status = 'booked' AND seated_at IS NULL AND closed_at IS NULL)
      OR (status = 'seated' AND seated_at IS NOT NULL AND closed_at IS NULL)
      OR (status IN ('cancelled', 'no_show') AND seated_at IS NULL AND closed_at IS NOT NULL)
      OR (status = 'completed' AND seated_at IS NOT NULL AND closed_at IS NOT NULL AND closed_at >= seated_at)
    `],
  ]);
  await replaceCheckConstraints(connection, 'kitchen_queue_state', [
    ['chk_kitchen_singleton', 'id = 1'],
    ['chk_kitchen_concurrency', 'concurrency BETWEEN 1 AND 20'],
    ['chk_kitchen_stale', 'stale_after_minutes BETWEEN 15 AND 1440'],
    ['chk_kitchen_flags', 'automation_enabled IN (0, 1) AND paused IN (0, 1)'],
    ['chk_kitchen_version', 'version >= 1'],
  ]);
  await replaceCheckConstraints(connection, 'payment_transactions', [
    ['chk_payment_guest_count', 'guest_count IS NULL OR guest_count BETWEEN 1 AND 100'],
    ['chk_payment_reservation_snapshot', `
      (reservation_code IS NULL AND customer_name IS NULL AND guest_count IS NULL)
      OR (reservation_code IS NOT NULL AND customer_name IS NOT NULL AND guest_count IS NOT NULL)
    `],
  ]);

  await connection.query('INSERT INTO schema_migrations (id) VALUES (?)', [migrationId]);
}

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
  if (!queueColumns.some(column => column.columnName === 'version')) {
    await connection.query('ALTER TABLE kitchen_queue_state ADD COLUMN version BIGINT UNSIGNED NOT NULL DEFAULT 1 AFTER paused');
  }

  const [kitchenChecks] = await connection.query(
    `SELECT constraint_name AS constraintName FROM information_schema.table_constraints
     WHERE constraint_schema = ? AND table_name = 'kitchen_queue_state' AND constraint_type = 'CHECK'`,
    [databaseName],
  );
  const kitchenCheckNames = new Set(kitchenChecks.map(constraint => constraint.constraintName));
  if (!kitchenCheckNames.has('chk_kitchen_singleton')) {
    await connection.query('ALTER TABLE kitchen_queue_state ADD CONSTRAINT chk_kitchen_singleton CHECK (id = 1)');
  }
  if (!kitchenCheckNames.has('chk_kitchen_concurrency')) {
    await connection.query('ALTER TABLE kitchen_queue_state ADD CONSTRAINT chk_kitchen_concurrency CHECK (concurrency BETWEEN 1 AND 20)');
  }
  if (!kitchenCheckNames.has('chk_kitchen_stale')) {
    await connection.query('ALTER TABLE kitchen_queue_state ADD CONSTRAINT chk_kitchen_stale CHECK (stale_after_minutes BETWEEN 15 AND 1440)');
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
    await connection.beginTransaction();
    try {
      // UPDATE và marker phải commit cùng nhau; crash không thể làm trừ timezone lần thứ hai.
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
      await connection.commit();
    } catch (error) {
      await connection.rollback().catch(() => {});
      throw error;
    }
  }

  // Mỗi active order cũ trở thành lượt gọi đầu tiên để nâng cấp không mất dữ liệu.
  const [batchInventoryColumns] = await connection.query(
    `SELECT column_name AS columnName FROM information_schema.columns
     WHERE table_schema = ? AND table_name = 'order_batches' AND column_name = 'inventory_date'`,
    [databaseName],
  );
  const hasInventoryDate = batchInventoryColumns.length > 0;
  const legacyBusinessOffset = Number.isFinite(Number(process.env.LEGACY_TIMEZONE_OFFSET_MINUTES))
    ? Math.trunc(Number(process.env.LEGACY_TIMEZONE_OFFSET_MINUTES))
    : 420;
  await connection.query(
    `INSERT INTO order_batches (
      order_id, table_id, batch_number, items, status, is_addition,
      queued_at, cooking_started_at, completed_at, estimated_cook_minutes
      ${hasInventoryDate ? ', inventory_date' : ''}
    )
    SELECT o.id, o.table_id, 1, o.items,
      CASE WHEN t.status IN ('waiting', 'cooking', 'done') THEN t.status ELSE 'waiting' END,
      FALSE, o.queued_at, o.cooking_started_at,
      CASE WHEN t.status = 'done' THEN o.updated_at ELSE NULL END,
      o.estimated_cook_minutes
      ${hasInventoryDate ? `, DATE(DATE_ADD(o.queued_at, INTERVAL ${legacyBusinessOffset} MINUTE))` : ''}
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
    'SELECT id, table_number, seats, status, area, position_x, position_y FROM restaurant_tables LIMIT 0',
    'SELECT id, reservation_code, table_id, table_number, customer_name, customer_phone, phone_normalized, party_size, reserved_at, ends_at, duration_minutes, status, seated_table_id, version FROM reservations LIMIT 0',
    'SELECT id, category_id, cook_minutes, daily_limit, available FROM menu_items LIMIT 0',
    'SELECT menu_item_id, business_date, used_quantity FROM menu_item_daily_usage LIMIT 0',
    'SELECT id, table_id, reservation_id, items, estimated_cook_minutes FROM active_orders LIMIT 0',
    'SELECT id, order_id, table_id, batch_number, items, status, estimated_cook_minutes, inventory_date FROM order_batches LIMIT 0',
    'SELECT id, concurrency, stale_after_minutes, automation_enabled, paused, version FROM kitchen_queue_state LIMIT 0',
    'SELECT id, employee_code, full_name, role, active FROM employees LIMIT 0',
    `SELECT id, invoice_code, reservation_id, reservation_code, customer_name, guest_count,
      staff_id, service_status, departure_confirmed_at, paid_at FROM payment_transactions LIMIT 0`,
    'SELECT order_id, transaction_id FROM active_order_payments LIMIT 0',
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
  const [[mismatchedBatch], [detachedReservation]] = await Promise.all([
    connection.query(
      `SELECT b.id FROM order_batches b
       INNER JOIN active_orders o ON o.id = b.order_id
       WHERE b.table_id <> o.table_id LIMIT 1`,
    ),
    connection.query(
      `SELECT id FROM reservations
       WHERE status IN ('booked', 'seated') AND table_id IS NULL LIMIT 1`,
    ),
  ]);
  if (mismatchedBatch[0] || detachedReservation[0]) {
    throw new Error('Database có dữ liệu quan hệ không toàn vẹn; hãy chạy migration/audit trước khi khởi động.');
  }
  const [constraints] = await connection.query(
    `SELECT constraint_name AS constraintName FROM information_schema.referential_constraints
     WHERE constraint_schema = ? AND constraint_name IN (
       'fk_reservation_table', 'fk_active_order_reservation_table',
        'fk_order_batch_order_table', 'fk_payment_reservation',
        'fk_active_order_payment_order', 'fk_active_order_payment_transaction',
        'fk_daily_usage_menu_item'
     )`,
    [databaseName],
  );
  const existingConstraints = new Set(constraints.map(constraint => constraint.constraintName));
  const missingConstraints = [
    'fk_reservation_table',
    'fk_active_order_reservation_table',
    'fk_order_batch_order_table',
    'fk_payment_reservation',
    'fk_active_order_payment_order',
    'fk_active_order_payment_transaction',
    'fk_daily_usage_menu_item',
  ].filter(constraint => !existingConstraints.has(constraint));
  if (missingConstraints.length > 0) {
    throw new Error(`Database thiếu ràng buộc ${missingConstraints.join(', ')}; hãy chạy migration trước khi khởi động.`);
  }
  const [criticalChecks] = await connection.query(
    `SELECT table_name AS tableName, constraint_name AS constraintName
     FROM information_schema.table_constraints
     WHERE constraint_schema = ? AND constraint_type = 'CHECK'
       AND constraint_name IN (
         'chk_restaurant_table_area', 'chk_restaurant_table_position',
         'chk_reservation_phone', 'chk_reservation_window',
         'chk_reservation_version', 'chk_reservation_lifecycle',
         'chk_kitchen_flags', 'chk_kitchen_version',
          'chk_payment_reservation_snapshot', 'chk_payment_service_status',
          'chk_payment_service_lifecycle', 'chk_menu_item_daily_limit',
          'chk_daily_usage_quantity'
       )`,
    [databaseName],
  );
  const criticalCheckNames = new Set(criticalChecks.map(check => check.constraintName));
  const requiredCheckNames = [
    'chk_restaurant_table_area', 'chk_restaurant_table_position',
    'chk_reservation_phone', 'chk_reservation_window',
    'chk_reservation_version', 'chk_reservation_lifecycle',
    'chk_kitchen_flags', 'chk_kitchen_version',
    'chk_payment_reservation_snapshot',
    'chk_payment_service_status', 'chk_payment_service_lifecycle',
    'chk_menu_item_daily_limit', 'chk_daily_usage_quantity',
  ];
  const missingChecks = requiredCheckNames.filter(name => !criticalCheckNames.has(name));
  const [seatedIndexes] = await connection.query(
    `SELECT non_unique AS nonUnique,
       GROUP_CONCAT(column_name ORDER BY seq_in_index SEPARATOR ',') AS columns
     FROM information_schema.statistics
     WHERE table_schema = ? AND table_name = 'reservations'
       AND index_name = 'uq_reservation_seated_table'
     GROUP BY non_unique`,
    [databaseName],
  );
  const seatedIndex = seatedIndexes[0];
  const [layoutIndexes] = await connection.query(
    `SELECT non_unique AS nonUnique,
       GROUP_CONCAT(column_name ORDER BY seq_in_index SEPARATOR ',') AS columns
     FROM information_schema.statistics
     WHERE table_schema = ? AND table_name = 'restaurant_tables'
       AND index_name = 'uq_restaurant_table_area_position'
     GROUP BY non_unique`,
    [databaseName],
  );
  const layoutIndex = layoutIndexes[0];
  if (missingChecks.length > 0 || !seatedIndex
    || Number(seatedIndex.nonUnique) !== 0 || seatedIndex.columns !== 'seated_table_id') {
    throw new Error(
      `Database thiếu constraint phiên bản mới${missingChecks.length ? `: ${missingChecks.join(', ')}` : ''}; `
      + 'hãy chạy npm run db:migrate trước khi khởi động.',
    );
  }
  if (!layoutIndex || Number(layoutIndex.nonUnique) !== 0
    || layoutIndex.columns !== 'area,position_x,position_y') {
    throw new Error('Database thiếu ràng buộc vị trí bàn; hãy chạy npm run db:migrate trước khi khởi động.');
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
    const migrationConnection = await pool.getConnection();
    const lockName = `${databaseName}:schema-migration`;
    let lockAcquired = false;
    let migrationError;
    try {
      const [lockRows] = await migrationConnection.query('SELECT GET_LOCK(?, 30) AS acquired', [lockName]);
      lockAcquired = Number(lockRows[0]?.acquired) === 1;
      if (!lockAcquired) throw new Error('Không thể lấy advisory lock để migrate database sau 30 giây.');

      for (const statement of schemaStatements) await migrationConnection.query(statement);
      await ensureEmployeePaymentColumn(migrationConnection);
      await ensureEarlyPaymentLifecycle(migrationConnection);
      await ensurePaymentItemCategoryColumns(migrationConnection);
      await ensureKitchenQueueColumns(migrationConnection);
      await ensureReservationLinks(migrationConnection);
      await ensureReservationAndOrderIntegrity(migrationConnection);
      await ensureRestaurantTableLayout(migrationConnection);
      await ensureDailyMenuInventory(migrationConnection);

      await migrationConnection.query(
        'INSERT IGNORE INTO restaurant_settings (id, settings) VALUES (1, ?)',
        [JSON.stringify(defaultSettings)],
      );
      await migrationConnection.query(
        `UPDATE restaurant_settings
         SET settings = JSON_SET(settings, '$.tagline', ?)
         WHERE id = 1 AND JSON_UNQUOTE(JSON_EXTRACT(settings, '$.tagline')) = 'Restaurant Order Management'`,
        [defaultSettings.tagline],
      );
      const legacyDemoSettings = [
        ['legalName', 'Core Advanced Solutions'],
        ['tagline', 'Giải pháp vận hành nhà hàng'],
        ['address', '127 Nguyễn Văn Linh, Quận 7, TP. Hồ Chí Minh'],
        ['phone', '0900 123 456'],
        ['email', 'hello@cas.vn'],
        ['website', 'cas.vn'],
        ['cashierName', 'Thu ngân CAS'],
      ];
      for (const [field, legacyValue] of legacyDemoSettings) {
        await migrationConnection.query(
          `UPDATE restaurant_settings
           SET settings = JSON_SET(settings, '$.${field}', ?)
           WHERE id = 1 AND JSON_UNQUOTE(JSON_EXTRACT(settings, '$.${field}')) = ?`,
          [defaultSettings[field], legacyValue],
        );
      }

      // Bàn mẫu chỉ được tạo một lần; bàn quản trị đã xóa không xuất hiện lại sau khi restart API.
      const tableSeedMigration = '20260714_seed_default_tables_once';
      const [tableSeedRows] = await migrationConnection.query(
        'SELECT id FROM schema_migrations WHERE id = ? LIMIT 1',
        [tableSeedMigration],
      );
      if (tableSeedRows.length === 0) {
        const [tableCounts] = await migrationConnection.query('SELECT COUNT(*) AS total FROM restaurant_tables');
        if (Number(tableCounts[0]?.total) === 0) {
          const placeholders = defaultTables.map(() => '(?, ?, ?, ?, ?, ?)').join(', ');
          await migrationConnection.query(
            `INSERT INTO restaurant_tables (
              id, table_number, seats, area, position_x, position_y
             ) VALUES ${placeholders}`,
            defaultTables.flat(),
          );
        }
        await migrationConnection.query('INSERT INTO schema_migrations (id) VALUES (?)', [tableSeedMigration]);
      }
      await migrationConnection.query(
        'INSERT IGNORE INTO kitchen_queue_state (id, concurrency, stale_after_minutes, automation_enabled, paused) VALUES (1, ?, ?, TRUE, FALSE)',
        [initialKitchenConcurrency(), initialKitchenStaleMinutes()],
      );
      const [employeeCounts] = await migrationConnection.query('SELECT COUNT(*) AS total FROM employees');
      if (Number(employeeCounts[0].total) === 0) {
        const employeePlaceholders = defaultEmployees.map(() => '(?, ?, ?, ?, ?, ?, ?, TRUE)').join(', ');
        await migrationConnection.query(
          `INSERT INTO employees (
            id, employee_code, full_name, role, phone, shift_start, shift_end, active
           ) VALUES ${employeePlaceholders}`,
          defaultEmployees.flat(),
        );
      }
      const legacyDemoEmployees = [
        ['employee-server-default', 'Nhân viên phục vụ', '0900 111 001', 'Nhân viên phục vụ'],
        ['employee-cashier-default', 'Thu ngân CAS', '0900 111 002', 'Thu ngân'],
        ['employee-chef-default', 'Bếp trưởng CAS', '0900 111 003', 'Nhân viên bếp'],
        ['employee-manager-default', 'Quản lý CAS', '0900 111 004', 'Quản lý'],
      ];
      for (const [id, legacyName, legacyPhone, nextName] of legacyDemoEmployees) {
        await migrationConnection.query(
          `UPDATE employees SET full_name = ?, phone = ''
           WHERE id = ? AND full_name = ? AND phone = ?`,
          [nextName, id, legacyName, legacyPhone],
        );
      }
      await ensureDatabaseIntegrityConstraints(migrationConnection);
    } catch (error) {
      await migrationConnection.rollback().catch(() => {});
      migrationError = error;
    } finally {
      if (lockAcquired) await migrationConnection.query('SELECT RELEASE_LOCK(?)', [lockName]).catch(() => {});
      migrationConnection.release();
    }
    if (migrationError) {
      const failedPool = pool;
      pool = undefined;
      await failedPool.end().catch(() => {});
      throw migrationError;
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
