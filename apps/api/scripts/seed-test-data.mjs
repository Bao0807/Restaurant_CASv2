import 'dotenv/config';
import { closePool, getPool, initDatabase } from '../src/db.js';
import { calculateTotals, parseJsonColumn, sanitizeSettings } from '../src/domain.js';
import { defaultSettings } from '../src/defaultSettings.js';
import { processKitchenQueue } from '../src/kitchenQueue.js';

const DEMO_TABLES = [
  ['demo-table-101', 101, 2, 'empty', null],
  ['demo-table-102', 102, 4, 'reserved', '19:30'],
  ['demo-table-103', 103, 4, 'waiting', null],
  ['demo-table-104', 104, 6, 'waiting', null],
  ['demo-table-105', 105, 2, 'done', null],
  ['demo-table-106', 106, 8, 'waiting', null],
  ['demo-table-107', 107, 4, 'waiting', null],
  ['demo-table-108', 108, 10, 'empty', null],
];

const DEMO_EMPLOYEES = [
  ['demo-employee-an', 'DEMO01', 'Nguyễn Minh Anh', 'server', '0901 101 001', '07:00', '15:00'],
  ['demo-employee-ha', 'DEMO02', 'Trần Thu Hà', 'server', '0901 101 002', '10:00', '18:00'],
  ['demo-employee-linh', 'DEMO03', 'Lê Gia Linh', 'server', '0901 101 003', '15:00', '23:00'],
];

// Catalog này chỉ được dùng khi database hoàn toàn chưa có món.
const FALLBACK_CATEGORIES = [
  ['sample-pho', 'Phở & Bún', '🍜', 1],
  ['sample-com', 'Cơm', '🍚', 2],
  ['sample-nuong', 'Món nướng', '🔥', 3],
  ['sample-drink', 'Đồ uống', '🥤', 4],
  ['sample-dessert', 'Tráng miệng', '🍮', 5],
];

const FALLBACK_ITEMS = [
  ['sample-pho-bo', 'Phở bò tái', 'Nước dùng trong, bò tái và rau thơm.', 65_000, 'sample-pho', 8, true, false],
  ['sample-bun-bo', 'Bún bò Huế', 'Bún bò cay nhẹ, chả cua và giò heo.', 72_000, 'sample-pho', 10, true, false],
  ['sample-com-suon', 'Cơm sườn nướng', 'Sườn nướng, bì, chả và mỡ hành.', 78_000, 'sample-com', 12, true, false],
  ['sample-com-ga', 'Cơm gà xối mỡ', 'Gà giòn và cơm chiên tỏi.', 82_000, 'sample-com', 10, false, true],
  ['sample-ga-nuong', 'Gà nướng mật ong', 'Gà nướng mật ong dùng kèm rau củ.', 145_000, 'sample-nuong', 15, false, true],
  ['sample-ba-chi', 'Ba chỉ nướng', 'Ba chỉ ướp sả nướng và kim chi.', 118_000, 'sample-nuong', 14, false, false],
  ['sample-tra-dao', 'Trà đào cam sả', 'Trà đào, cam vàng và sả tươi.', 42_000, 'sample-drink', 3, true, false],
  ['sample-ca-phe', 'Cà phê sữa', 'Cà phê rang xay và sữa đặc.', 35_000, 'sample-drink', 2, false, false],
  ['sample-flan', 'Bánh flan', 'Flan trứng phủ caramel.', 32_000, 'sample-dessert', 4, false, false],
  ['sample-che', 'Chè khúc bạch', 'Khúc bạch, nhãn và hạnh nhân.', 45_000, 'sample-dessert', 4, false, true],
];

const DEMO_IMAGE = 'https://images.unsplash.com/photo-1547592180-85f173990554?w=600&q=80';
const demoTableIds = DEMO_TABLES.map(table => table[0]);

async function ensureCatalog(connection) {
  const [counts] = await connection.query('SELECT COUNT(*) AS total FROM menu_items');
  if (Number(counts[0].total) > 0) return;

  for (const category of FALLBACK_CATEGORIES) {
    await connection.query(
      `INSERT INTO menu_categories (id, name, emoji, sort_order, active)
       VALUES (?, ?, ?, ?, TRUE)
       ON DUPLICATE KEY UPDATE name = VALUES(name), emoji = VALUES(emoji), active = TRUE`,
      category,
    );
  }
  for (const item of FALLBACK_ITEMS) {
    await connection.query(
      `INSERT INTO menu_items (
        id, name, description, price, image, category_id, cook_minutes,
        available, is_bestseller, is_new, sizes_json, toppings_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, TRUE, ?, ?, ?, ?)`,
      [
        item[0], item[1], item[2], item[3], DEMO_IMAGE, item[4], item[5], item[6], item[7],
        JSON.stringify([{ label: 'Tiêu chuẩn', extraPrice: 0 }, { label: 'Lớn', extraPrice: 15_000 }]),
        JSON.stringify([{ id: `${item[0]}-extra`, label: 'Phần thêm', price: 12_000 }]),
      ],
    );
  }
}

function menuRowToItem(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    price: Number(row.price),
    image: row.image,
    categoryId: row.categoryId,
    cookMinutes: Number(row.cookMinutes),
    available: true,
    ...(row.isBestseller ? { isBestseller: true } : {}),
    ...(row.isNew ? { isNew: true } : {}),
  };
}

function cartItem(menuRow, suffix, quantity = 1, withOptions = false) {
  const sizes = parseJsonColumn(menuRow.sizes, []);
  const toppings = parseJsonColumn(menuRow.toppings, []);
  return {
    cartId: `demo-cart-${suffix}`,
    menuItem: menuRowToItem(menuRow),
    quantity,
    ...(withOptions && sizes[0] ? { selectedSize: sizes[0] } : {}),
    selectedToppings: withOptions && toppings[0] ? [toppings[0]] : [],
    note: withOptions ? 'Dữ liệu mẫu: ít cay' : '',
  };
}

async function createDemoOrder(connection, tableId, batches) {
  const items = batches.flatMap(batch => batch.items);
  const eta = Math.max(...batches.map(batch => batch.eta));
  const earliestQueueTime = batches.reduce(
    (earliest, batch) => batch.queuedAt < earliest ? batch.queuedAt : earliest,
    batches[0].queuedAt,
  );
  const [orderResult] = await connection.query(
    `INSERT INTO active_orders (table_id, items, queued_at, cooking_started_at, estimated_cook_minutes)
     VALUES (?, ?, ?, NULL, ?)`,
    [tableId, JSON.stringify(items), earliestQueueTime, eta],
  );

  for (const [index, batch] of batches.entries()) {
    await connection.query(
      `INSERT INTO order_batches (
        order_id, table_id, batch_number, items, status, is_addition,
        queued_at, cooking_started_at, completed_at, estimated_cook_minutes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        orderResult.insertId,
        tableId,
        index + 1,
        JSON.stringify(batch.items),
        batch.status,
        index > 0,
        batch.queuedAt,
        batch.cookingStartedAt ?? null,
        batch.completedAt ?? null,
        batch.eta,
      ],
    );
  }

  const nextStatus = batches.some(batch => batch.status === 'cooking')
    ? 'cooking'
    : batches.some(batch => batch.status === 'waiting') ? 'waiting' : 'done';
  await connection.query('UPDATE restaurant_tables SET status = ? WHERE id = ?', [nextStatus, tableId]);
}

function unitPrice(item) {
  return item.menuItem.price
    + (item.selectedSize?.extraPrice ?? 0)
    + item.selectedToppings.reduce((sum, topping) => sum + topping.price, 0);
}

async function createDemoPayment(connection, settings, definition) {
  const totals = calculateTotals(definition.items, settings);
  const itemCount = definition.items.reduce((sum, item) => sum + item.quantity, 0);
  const [result] = await connection.query(
    `INSERT INTO payment_transactions (
      invoice_code, transaction_code, table_id, table_number, payment_method,
      subtotal, discount, service_fee, vat, total, item_count, staff_id,
      staff_name, cashier_name, paid_at, raw_payload
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      definition.invoiceCode,
      `TX-${definition.invoiceCode}`,
      definition.tableId,
      definition.tableNumber,
      definition.method,
      totals.subtotal,
      totals.discount,
      totals.serviceFee,
      totals.vat,
      totals.total,
      itemCount,
      definition.employeeId ?? null,
      definition.staffName ?? settings.staffName,
      settings.cashierName,
      definition.paidAt,
      JSON.stringify({ demo: true }),
    ],
  );

  const categoryIds = [...new Set(definition.items.map(item => item.menuItem.categoryId).filter(Boolean))];
  const categoryNames = new Map();
  if (categoryIds.length > 0) {
    const placeholders = categoryIds.map(() => '?').join(', ');
    const [categories] = await connection.query(
      `SELECT id, name FROM menu_categories WHERE id IN (${placeholders})`,
      categoryIds,
    );
    categories.forEach(category => categoryNames.set(category.id, category.name));
  }
  for (const item of definition.items) {
    await connection.query(
      `INSERT INTO payment_items (
        transaction_id, cart_id, menu_item_id, category_id, category_name,
        name, quantity, price, note, options_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        result.insertId,
        item.cartId,
        item.menuItem.id,
        item.menuItem.categoryId || null,
        categoryNames.get(item.menuItem.categoryId) || 'Khác',
        item.menuItem.name,
        item.quantity,
        unitPrice(item),
        item.note || null,
        JSON.stringify({
          size: item.selectedSize?.label ?? null,
          toppings: item.selectedToppings.map(topping => topping.label),
        }),
      ],
    );
  }
}

async function seed() {
  await initDatabase({ migrate: true });
  const pool = getPool();
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query('SELECT id FROM kitchen_queue_state WHERE id = 1 FOR UPDATE');
    await connection.query("DELETE FROM payment_transactions WHERE invoice_code LIKE 'DEMO-%'");

    for (const demoEmployee of DEMO_EMPLOYEES) {
      await connection.query(
        `INSERT INTO employees (id, employee_code, full_name, role, phone, shift_start, shift_end, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, TRUE)
         ON DUPLICATE KEY UPDATE employee_code = VALUES(employee_code), full_name = VALUES(full_name),
           role = VALUES(role), phone = VALUES(phone), shift_start = VALUES(shift_start),
           shift_end = VALUES(shift_end), active = TRUE`,
        demoEmployee,
      );
    }

    const placeholders = demoTableIds.map(() => '?').join(', ');
    await connection.query(`DELETE FROM active_orders WHERE table_id IN (${placeholders})`, demoTableIds);
    await connection.query(`DELETE FROM restaurant_tables WHERE id IN (${placeholders})`, demoTableIds);
    await ensureCatalog(connection);

    for (const table of DEMO_TABLES) {
      await connection.query(
        `INSERT INTO restaurant_tables (id, table_number, seats, status, reserved_time)
         VALUES (?, ?, ?, ?, ?)`,
        table,
      );
    }

    const [menuRows] = await connection.query(
      `SELECT id, name, description, price, image, category_id AS categoryId,
        cook_minutes AS cookMinutes, is_bestseller AS isBestseller, is_new AS isNew,
        sizes_json AS sizes, toppings_json AS toppings
       FROM menu_items WHERE available = TRUE ORDER BY category_id, id LIMIT 8`,
    );
    if (menuRows.length < 4) throw new Error('Cần ít nhất 4 món đang bán để tạo dữ liệu test.');

    const now = Date.now();
    const queuedAt = offsetSeconds => new Date(now + offsetSeconds * 1_000);
    const minutesAgo = value => new Date(now - value * 60_000);
    const batch = (items, offsetSeconds, status = 'waiting', extra = {}) => ({
      items,
      eta: Math.max(...items.map(item => (Number(item.menuItem.cookMinutes) || 10) * Math.max(1, Number(item.quantity) || 1))),
      queuedAt: queuedAt(offsetSeconds),
      status,
      ...extra,
    });

    await createDemoOrder(connection, 'demo-table-103', [
      batch([cartItem(menuRows[0], '103-a', 1, true)], 0),
    ]);
    await createDemoOrder(connection, 'demo-table-104', [
      batch([cartItem(menuRows[1], '104-a', 2)], 1, 'done', {
        cookingStartedAt: minutesAgo(10), completedAt: minutesAgo(8),
      }),
      batch([cartItem(menuRows[2], '104-b', 1, true)], 2),
    ]);
    await createDemoOrder(connection, 'demo-table-105', [
      batch([cartItem(menuRows[3], '105-a', 1)], 3, 'done', {
        cookingStartedAt: minutesAgo(8), completedAt: minutesAgo(5),
      }),
    ]);
    await createDemoOrder(connection, 'demo-table-106', [
      batch([cartItem(menuRows[4] ?? menuRows[0], '106-a', 3)], 4),
    ]);
    await createDemoOrder(connection, 'demo-table-107', [
      batch([cartItem(menuRows[5] ?? menuRows[1], '107-a', 1)], 5, 'done', {
        cookingStartedAt: minutesAgo(6), completedAt: minutesAgo(4),
      }),
      batch([cartItem(menuRows[6] ?? menuRows[2], '107-b', 2, true)], 6),
    ]);

    const [settingsRows] = await connection.query('SELECT settings FROM restaurant_settings WHERE id = 1 LIMIT 1');
    const settings = sanitizeSettings(parseJsonColumn(settingsRows[0]?.settings, defaultSettings), defaultSettings);
    const dateTag = new Date().toISOString().slice(0, 10).replaceAll('-', '');
    const methods = ['cash', 'card', 'qr', 'cash', 'qr', 'card'];
    for (let index = 0; index < methods.length; index += 1) {
      await createDemoPayment(connection, settings, {
        invoiceCode: `DEMO-${dateTag}-${String(index + 1).padStart(2, '0')}`,
        tableId: `demo-paid-${index + 1}`,
        tableNumber: 91 + index,
        method: methods[index],
        employeeId: DEMO_EMPLOYEES[index % DEMO_EMPLOYEES.length][0],
        staffName: DEMO_EMPLOYEES[index % DEMO_EMPLOYEES.length][2],
        paidAt: new Date(now - (10 + index * 35) * 60_000),
        items: [
          cartItem(menuRows[index % menuRows.length], `paid-${index}-a`, index % 3 + 1, index % 2 === 0),
          cartItem(menuRows[(index + 2) % menuRows.length], `paid-${index}-b`, 1),
        ],
      });
    }

    await connection.commit();
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }

  await processKitchenQueue(pool);
  const [[tableCount], [orderCount], [batchCount], [paymentCount], [employeeCount]] = await Promise.all([
    pool.query("SELECT COUNT(*) AS total FROM restaurant_tables WHERE id LIKE 'demo-table-%'"),
    pool.query("SELECT COUNT(*) AS total FROM active_orders WHERE table_id LIKE 'demo-table-%'"),
    pool.query("SELECT COUNT(*) AS total FROM order_batches WHERE table_id LIKE 'demo-table-%'"),
    pool.query("SELECT COUNT(*) AS total FROM payment_transactions WHERE invoice_code LIKE 'DEMO-%'"),
    pool.query("SELECT COUNT(*) AS total FROM employees WHERE id LIKE 'demo-employee-%' AND active = TRUE"),
  ]);
  console.log(
    `Seed test completed: tables=${tableCount[0].total}, activeOrders=${orderCount[0].total}, batches=${batchCount[0].total}, payments=${paymentCount[0].total}, employees=${employeeCount[0].total}`,
  );
}

try {
  await seed();
} finally {
  await closePool();
}
