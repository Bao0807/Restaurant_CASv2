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
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT chk_settings_singleton CHECK (id = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS restaurant_tables (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS reservations (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS menu_item_daily_usage (
  menu_item_id VARCHAR(64) NOT NULL,
  business_date DATE NOT NULL,
  used_quantity INT UNSIGNED NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (menu_item_id, business_date),
  CONSTRAINT fk_daily_usage_menu_item FOREIGN KEY (menu_item_id) REFERENCES menu_items(id) ON DELETE CASCADE,
  CONSTRAINT chk_daily_usage_quantity CHECK (used_quantity <= 2000000000),
  INDEX idx_daily_usage_date (business_date, menu_item_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS active_orders (
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
  inventory_date DATE NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_order_batch_order_table FOREIGN KEY (order_id, table_id) REFERENCES active_orders(id, table_id) ON DELETE CASCADE,
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
  version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT chk_kitchen_singleton CHECK (id = 1),
  CONSTRAINT chk_kitchen_concurrency CHECK (concurrency BETWEEN 1 AND 20),
  CONSTRAINT chk_kitchen_stale CHECK (stale_after_minutes BETWEEN 15 AND 1440),
  CONSTRAINT chk_kitchen_flags CHECK (automation_enabled IN (0, 1) AND paused IN (0, 1)),
  CONSTRAINT chk_kitchen_version CHECK (version >= 1)
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS active_order_payments (
  order_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  transaction_id BIGINT UNSIGNED NOT NULL UNIQUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_active_order_payment_order
    FOREIGN KEY (order_id) REFERENCES active_orders(id)
    ON DELETE CASCADE,
  CONSTRAINT fk_active_order_payment_transaction
    FOREIGN KEY (transaction_id) REFERENCES payment_transactions(id)
    ON DELETE RESTRICT
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
    'legalName', 'CAS Restaurant',
    'tagline', 'Phục vụ tận tâm',
    'address', 'Chưa cập nhật địa chỉ',
    'phone', 'Chưa cập nhật',
    'email', 'Chưa cập nhật',
    'website', 'Chưa cập nhật',
    'defaultArea', 'Sảnh chính',
    'staffName', 'Nhân viên phục vụ',
    'cashierName', 'Thu ngân',
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

INSERT IGNORE INTO restaurant_tables (
  id, table_number, seats, area, position_x, position_y
) VALUES
  ('t1', 1, 4, 'Khu vực trong nhà', 1, 1),
  ('t2', 2, 2, 'Khu vực trong nhà', 2, 1),
  ('t3', 3, 6, 'Khu vực trong nhà', 1, 2),
  ('t4', 4, 4, 'Khu vực trong nhà', 2, 2),
  ('t5', 5, 4, 'Khu vực cửa sổ', 1, 1),
  ('t6', 6, 8, 'Khu vực cửa sổ', 2, 1),
  ('t7', 7, 4, 'Khu vực cửa sổ', 1, 2),
  ('t8', 8, 2, 'Khu vực cửa sổ', 2, 2),
  ('t9', 9, 6, 'Sân ngoài trời', 1, 1),
  ('t10', 10, 4, 'Sân ngoài trời', 2, 1),
  ('t11', 11, 8, 'Sân ngoài trời', 1, 2),
  ('t12', 12, 4, 'Sân ngoài trời', 2, 2);

INSERT IGNORE INTO kitchen_queue_state (id) VALUES (1);

INSERT IGNORE INTO employees (
  id, employee_code, full_name, role, phone, shift_start, shift_end, active
) VALUES
  ('employee-server-default', 'NV001', 'Nhân viên phục vụ', 'server', '', '08:00', '16:00', TRUE),
  ('employee-cashier-default', 'NV002', 'Thu ngân', 'cashier', '', '08:00', '16:00', TRUE),
  ('employee-chef-default', 'NV003', 'Nhân viên bếp', 'chef', '', '09:00', '17:00', TRUE),
  ('employee-manager-default', 'NV004', 'Quản lý', 'manager', '', '09:00', '18:00', TRUE);
