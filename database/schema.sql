CREATE DATABASE IF NOT EXISTS restaurant_casv2
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE restaurant_casv2;

CREATE TABLE IF NOT EXISTS schema_migrations (
  id VARCHAR(120) NOT NULL PRIMARY KEY,
  applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS restaurant_settings (
  id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  settings JSON NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS restaurant_tables (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS menu_categories (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  emoji VARCHAR(16) NOT NULL DEFAULT '🍽️',
  sort_order INT NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS menu_items (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS active_orders (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS order_batches (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS kitchen_queue_state (
  id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  concurrency INT UNSIGNED NOT NULL DEFAULT 2,
  stale_after_minutes INT UNSIGNED NOT NULL DEFAULT 120,
  automation_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  paused BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS employees (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS payment_transactions (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS payment_items (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO restaurant_settings (id, settings)
VALUES (
  1,
  JSON_OBJECT(
    'restaurantName', 'Nhà hàng CAS',
    'legalName', 'Core Advanced Solutions',
    'tagline', 'Restaurant Order Management',
    'address', '127 Nguyễn Văn Linh, Quận 7, TP. Hồ Chí Minh',
    'phone', '0900 123 456',
    'email', 'hello@cas.vn',
    'website', 'cas.vn',
    'defaultArea', 'Sảnh chính',
    'staffName', 'Nhân viên phục vụ',
    'cashierName', 'Thu ngân CAS',
    'customerName', 'Khách lẻ',
    'guestCount', 2,
    'vatRate', 0.1,
    'serviceFeeRate', 0.05,
    'discountAmount', 0,
    'invoiceNote', 'Cảm ơn quý khách. Hẹn gặp lại!',
    'activePaymentMethods', JSON_ARRAY('cash', 'card', 'qr'),
    'visibleDashboardWidgets', JSON_ARRAY('revenue', 'orders', 'paymentMix', 'topItems', 'staff')
  )
);

INSERT IGNORE INTO restaurant_tables (id, table_number, seats) VALUES
  ('t1', 1, 4), ('t2', 2, 2), ('t3', 3, 6), ('t4', 4, 4),
  ('t5', 5, 4), ('t6', 6, 8), ('t7', 7, 4), ('t8', 8, 2),
  ('t9', 9, 6), ('t10', 10, 4), ('t11', 11, 8), ('t12', 12, 4);

INSERT IGNORE INTO kitchen_queue_state (id) VALUES (1);

INSERT IGNORE INTO employees (
  id, employee_code, full_name, role, phone, shift_start, shift_end, active
) VALUES
  ('employee-server-default', 'NV001', 'Nhân viên phục vụ', 'server', '0900 111 001', '08:00', '16:00', TRUE),
  ('employee-cashier-default', 'NV002', 'Thu ngân CAS', 'cashier', '0900 111 002', '08:00', '16:00', TRUE),
  ('employee-chef-default', 'NV003', 'Bếp trưởng CAS', 'chef', '0900 111 003', '09:00', '17:00', TRUE),
  ('employee-manager-default', 'NV004', 'Quản lý CAS', 'manager', '0900 111 004', '09:00', '18:00', TRUE);
