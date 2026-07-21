import 'dotenv/config';
import { closePool, getPool, initDatabase } from '../src/db.js';
import { calculateTotals, parseJsonColumn, sanitizeSettings } from '../src/domain.js';
import { defaultSettings } from '../src/defaultSettings.js';
import { aggregateMenuQuantities, businessDateFor } from '../src/dailyInventory.js';

const DEMO_TABLES = [
  ['demo-table-101', 101, 2, 'empty', 'Tầng trệt', 1, 1],
  ['demo-table-102', 102, 4, 'empty', 'Tầng trệt', 2, 1],
  ['demo-table-103', 103, 4, 'waiting', 'Tầng trệt', 1, 2],
  ['demo-table-104', 104, 6, 'waiting', 'Sân vườn', 1, 1],
  ['demo-table-105', 105, 2, 'done', 'Sân vườn', 2, 1],
  ['demo-table-106', 106, 8, 'waiting', 'Sân vườn', 1, 2],
  ['demo-table-107', 107, 4, 'waiting', 'Phòng riêng', 1, 1],
  ['demo-table-108', 108, 10, 'empty', 'Phòng riêng', 2, 1],
];

const DEMO_RESERVATION_CODES = [
  'DEMO-RSV-TODAY-101',
  'DEMO-RSV-UPCOMING-102',
  'DEMO-RSV-SEATED-103',
  'DEMO-RSV-CANCELLED-108',
  'DEMO-RSV-COMPLETED-108',
  'DEMO-RSV-NOSHOW-108',
];
const DEMO_SEED_MARKER = 'restaurant-casv2';

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
const DEMO_MENU_ITEMS = [
  ['demo-menu-core-pho', 'Phở bò demo', 65_000, 8],
  ['demo-menu-core-bun', 'Bún bò demo', 72_000, 10],
  ['demo-menu-core-com', 'Cơm sườn demo', 78_000, 12],
  ['demo-menu-core-ga', 'Cơm gà demo', 82_000, 10],
  ['demo-menu-core-nuong', 'Gà nướng demo', 145_000, 15],
  ['demo-menu-core-heo', 'Ba chỉ nướng demo', 118_000, 14],
  ['demo-menu-core-tra', 'Trà đào demo', 42_000, 3],
  ['demo-menu-core-flan', 'Bánh flan demo', 32_000, 4],
];
const DEMO_LIMITED_ITEMS = [
  ['demo-menu-limited', 'Món giới hạn trong ngày', 88_000, 10, 20, 14],
  ['demo-menu-soldout', 'Món đã hết hôm nay', 95_000, 12, 8, 8],
];
const demoMenuIds = [...DEMO_MENU_ITEMS, ...DEMO_LIMITED_ITEMS].map(item => item[0]);

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

/** Catalog namespace demo tách khỏi món thật; gồm món còn hàng và hết hàng để kiểm thử UI số lượng. */
async function ensureDemoCatalog(connection) {
  await connection.query(
    `INSERT INTO menu_categories (id, name, emoji, sort_order, active)
     VALUES ('demo-daily-stock', 'Món demo số lượng', '🧪', 9000, TRUE)
     ON DUPLICATE KEY UPDATE name = VALUES(name), emoji = VALUES(emoji), active = TRUE`,
  );
  for (const [id, name, price, cookMinutes] of DEMO_MENU_ITEMS) {
    await connection.query(
      `INSERT INTO menu_items (
        id, name, description, price, image, category_id, cook_minutes, daily_limit,
        available, is_bestseller, is_new, sizes_json, toppings_json
      ) VALUES (?, ?, 'Dữ liệu tự động phục vụ kiểm thử nghiệp vụ.', ?, ?, 'demo-daily-stock', ?, NULL,
        TRUE, FALSE, FALSE, ?, ?)
      ON DUPLICATE KEY UPDATE name = VALUES(name), price = VALUES(price), image = VALUES(image),
        category_id = VALUES(category_id), cook_minutes = VALUES(cook_minutes), daily_limit = NULL,
        available = TRUE`,
      [id, name, price, DEMO_IMAGE, cookMinutes, JSON.stringify([]), JSON.stringify([])],
    );
  }
  for (const [id, name, price, cookMinutes, dailyLimit] of DEMO_LIMITED_ITEMS) {
    await connection.query(
      `INSERT INTO menu_items (
        id, name, description, price, image, category_id, cook_minutes, daily_limit,
        available, is_bestseller, is_new, sizes_json, toppings_json
      ) VALUES (?, ?, 'Dùng kiểm thử số phần tự đặt lại qua ngày.', ?, ?, 'demo-daily-stock', ?, ?,
        TRUE, FALSE, TRUE, ?, ?)
      ON DUPLICATE KEY UPDATE name = VALUES(name), price = VALUES(price), image = VALUES(image),
        category_id = VALUES(category_id), cook_minutes = VALUES(cook_minutes),
        daily_limit = VALUES(daily_limit), available = TRUE`,
      [id, name, price, DEMO_IMAGE, cookMinutes, dailyLimit, JSON.stringify([]), JSON.stringify([])],
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
    dailyLimit: row.dailyLimit == null ? null : Number(row.dailyLimit),
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

async function createDemoOrder(connection, tableId, batches, reservationId = null) {
  const items = batches.flatMap(batch => batch.items);
  const eta = Math.max(...batches.map(batch => batch.eta));
  const earliestQueueTime = batches.reduce(
    (earliest, batch) => batch.queuedAt < earliest ? batch.queuedAt : earliest,
    batches[0].queuedAt,
  );
  const [orderResult] = await connection.query(
    `INSERT INTO active_orders (
      table_id, reservation_id, items, queued_at, cooking_started_at, estimated_cook_minutes
     ) VALUES (?, ?, ?, ?, NULL, ?)`,
    [tableId, reservationId, JSON.stringify(items), earliestQueueTime, eta],
  );

  for (const [index, batch] of batches.entries()) {
    const inventoryDate = businessDateFor(batch.queuedAt);
    await connection.query(
      `INSERT INTO order_batches (
        order_id, table_id, batch_number, items, status, is_addition,
        queued_at, cooking_started_at, completed_at, estimated_cook_minutes, inventory_date
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        inventoryDate,
      ],
    );
    for (const item of aggregateMenuQuantities(batch.items)) {
      await connection.query(
        `INSERT INTO menu_item_daily_usage (menu_item_id, business_date, used_quantity)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE used_quantity = used_quantity + VALUES(used_quantity)`,
        [item.id, inventoryDate, item.quantity],
      );
    }
  }

  const nextStatus = batches.some(batch => batch.status === 'cooking')
    ? 'cooking'
    : batches.some(batch => batch.status === 'waiting') ? 'waiting' : 'done';
  await connection.query('UPDATE restaurant_tables SET status = ? WHERE id = ?', [nextStatus, tableId]);
}

/** Tạo đủ trạng thái đặt bàn trong namespace DEMO-RSV-* để kiểm thử UI và nghiệp vụ. */
async function createDemoReservations(connection, now) {
  const offsetMinutes = value => new Date(now + value * 60_000);
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const todayPoint = fraction => new Date(
    todayStart.getTime() + Math.floor((now - todayStart.getTime()) * fraction),
  );
  const definitions = [
    {
      code: 'DEMO-RSV-TODAY-101', tableId: 'demo-table-101', tableNumber: 101,
      name: 'Khách demo hôm nay', phone: '0901101101', partySize: 2,
      reservedAt: offsetMinutes(0), duration: 90, status: 'booked',
      notes: 'Đặt gần giờ để kiểm thử nhắc bàn và nhận khách.',
    },
    {
      code: 'DEMO-RSV-UPCOMING-102', tableId: 'demo-table-102', tableNumber: 102,
      name: 'Khách demo ngày mai', phone: '0901101102', partySize: 4,
      reservedAt: offsetMinutes(24 * 60), duration: 120, status: 'booked',
      notes: 'Đặt trước cho nhóm 4 khách.',
    },
    {
      code: 'DEMO-RSV-SEATED-103', tableId: 'demo-table-103', tableNumber: 103,
      name: 'Khách demo đã nhận bàn', phone: '0901101103', partySize: 3,
      reservedAt: offsetMinutes(-30), duration: 120, status: 'seated',
      seatedAt: offsetMinutes(-25), notes: 'Đã nhận bàn và có order đang hoạt động.',
    },
    {
      code: 'DEMO-RSV-CANCELLED-108', tableId: 'demo-table-108', tableNumber: 108,
      name: 'Khách demo đã hủy', phone: '0901101104', partySize: 6,
      reservedAt: offsetMinutes(-48 * 60), duration: 90, status: 'cancelled',
      closedAt: offsetMinutes(-49 * 60), notes: 'Lịch sử đặt bàn đã hủy.',
    },
    {
      code: 'DEMO-RSV-COMPLETED-108', tableId: 'demo-table-108', tableNumber: 108,
      name: 'Khách demo đã hoàn tất', phone: '0901101105', partySize: 5,
      reservedAt: todayPoint(0.1), duration: 120, status: 'completed',
      seatedAt: todayPoint(0.15), closedAt: todayPoint(0.45),
      notes: 'Lịch sử khách đặt bàn đã dùng bữa và thanh toán.',
    },
    {
      code: 'DEMO-RSV-NOSHOW-108', tableId: 'demo-table-108', tableNumber: 108,
      name: 'Khách demo không đến', phone: '0901101106', partySize: 4,
      reservedAt: offsetMinutes(-96 * 60), duration: 90, status: 'no_show',
      closedAt: offsetMinutes(-96 * 60 + 30), notes: 'Lịch sử khách không đến.',
    },
  ];

  const created = new Map();
  for (const definition of definitions) {
    const endsAt = new Date(definition.reservedAt.getTime() + definition.duration * 60_000);
    const [result] = await connection.query(
      `INSERT INTO reservations (
        reservation_code, table_id, table_number, customer_name, customer_phone,
        phone_normalized, party_size, reserved_at, ends_at, duration_minutes,
        status, seated_table_id, version, notes, seated_at, closed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      [
        definition.code, definition.tableId, definition.tableNumber, definition.name,
        definition.phone, definition.phone, definition.partySize, definition.reservedAt,
        endsAt, definition.duration, definition.status,
        definition.status === 'seated' ? definition.tableId : null, definition.notes,
        definition.seatedAt ?? null, definition.closedAt ?? null,
      ],
    );
    created.set(definition.code, { id: result.insertId, ...definition, endsAt });
  }
  return created;
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
      staff_name, cashier_name, paid_at, raw_payload, reservation_id,
      reservation_code, customer_name, guest_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      JSON.stringify({ demo: true, demoSeed: DEMO_SEED_MARKER }),
      definition.reservationId ?? null,
      definition.reservationCode ?? null,
      definition.customerName ?? null,
      definition.guestCount ?? null,
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
    for (const demoEmployee of DEMO_EMPLOYEES) {
      const [updated] = await connection.query(
        `UPDATE employees SET employee_code = ?, full_name = ?, role = ?, phone = ?,
           shift_start = ?, shift_end = ?, active = TRUE WHERE id = ?`,
        [...demoEmployee.slice(1), demoEmployee[0]],
      );
      if (updated.affectedRows === 0) {
        // INSERT cố ý fail khi mã DEMOxx đã bị một bản ghi ngoài namespace chiếm dụng.
        await connection.query(
          `INSERT INTO employees (id, employee_code, full_name, role, phone, shift_start, shift_end, active)
           VALUES (?, ?, ?, ?, ?, ?, ?, TRUE)`,
          demoEmployee,
        );
      }
    }

    const placeholders = demoTableIds.map(() => '?').join(', ');
    await connection.query(`DELETE FROM active_orders WHERE table_id IN (${placeholders})`, demoTableIds);
    // Active order phải xóa trước vì hóa đơn thanh toán sớm được FK RESTRICT bảo vệ khỏi xóa nhầm.
    await connection.query(
      `DELETE FROM payment_transactions
       WHERE JSON_UNQUOTE(JSON_EXTRACT(raw_payload, '$.demoSeed')) = ?
          OR (invoice_code LIKE 'DEMO-%'
            AND JSON_UNQUOTE(JSON_EXTRACT(raw_payload, '$.demo')) = 'true')`,
      [DEMO_SEED_MARKER],
    );
    const reservationPlaceholders = DEMO_RESERVATION_CODES.map(() => '?').join(', ');
    await connection.query(
      `DELETE FROM reservations WHERE reservation_code IN (${reservationPlaceholders})`,
      DEMO_RESERVATION_CODES,
    );
    await ensureCatalog(connection);
    await ensureDemoCatalog(connection);
    const demoMenuPlaceholders = demoMenuIds.map(() => '?').join(', ');
    await connection.query(
      `DELETE FROM menu_item_daily_usage WHERE menu_item_id IN (${demoMenuPlaceholders})`,
      demoMenuIds,
    );
    const seedInventoryDate = businessDateFor();
    for (const [id, , , , , usedQuantity] of DEMO_LIMITED_ITEMS) {
      await connection.query(
        `INSERT INTO menu_item_daily_usage (menu_item_id, business_date, used_quantity)
         VALUES (?, ?, ?)`,
        [id, seedInventoryDate, usedQuantity],
      );
    }

    for (const table of DEMO_TABLES) {
      const [updated] = await connection.query(
        `UPDATE restaurant_tables
         SET table_number = ?, seats = ?, status = ?, area = ?, position_x = ?, position_y = ?
         WHERE id = ?`,
        [table[1], table[2], table[3], table[4], table[5], table[6], table[0]],
      );
      if (updated.affectedRows === 0) {
        // Không dùng ON DUPLICATE KEY: nếu số bàn trùng dữ liệu thật thì rollback thay vì sửa nhầm dòng đó.
        await connection.query(
          `INSERT INTO restaurant_tables (
            id, table_number, seats, status, area, position_x, position_y
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          table,
        );
      }
    }

    const now = Date.now();
    const reservations = await createDemoReservations(connection, now);

    const [menuRows] = await connection.query(
      `SELECT id, name, description, price, image, category_id AS categoryId,
        cook_minutes AS cookMinutes, daily_limit AS dailyLimit,
        is_bestseller AS isBestseller, is_new AS isNew,
        sizes_json AS sizes, toppings_json AS toppings
       FROM menu_items
       WHERE available = TRUE AND id LIKE 'demo-menu-core-%'
       ORDER BY id LIMIT 8`,
    );
    if (menuRows.length < 4) throw new Error('Cần ít nhất 4 món đang bán để tạo dữ liệu test.');

    // Mọi timestamp demo đều tương đối với cùng một mốc để lần seed luôn cho trạng thái xác định.
    const queuedAt = offsetSeconds => new Date(now - 10_000 + offsetSeconds * 1_000);
    const minutesAgo = value => new Date(now - value * 60_000);
    const batch = (items, offsetSeconds, status = 'waiting', extra = {}) => ({
      items,
      eta: Math.max(...items.map(item => (Number(item.menuItem.cookMinutes) || 10) * Math.max(1, Number(item.quantity) || 1))),
      queuedAt: queuedAt(offsetSeconds),
      status,
      ...extra,
    });

    await createDemoOrder(connection, 'demo-table-103', [
      batch([cartItem(menuRows[0], '103-a', 1, true)], 0, 'cooking', {
        queuedAt: minutesAgo(4), cookingStartedAt: minutesAgo(3),
      }),
    ], reservations.get('DEMO-RSV-SEATED-103').id);
    await createDemoOrder(connection, 'demo-table-104', [
      batch([cartItem(menuRows[1], '104-a', 2)], 1, 'done', {
        queuedAt: minutesAgo(15), cookingStartedAt: minutesAgo(10), completedAt: minutesAgo(8),
      }),
      batch([cartItem(menuRows[2], '104-b', 1, true)], 2, 'cooking', {
        queuedAt: minutesAgo(3), cookingStartedAt: minutesAgo(2),
      }),
    ]);
    await createDemoOrder(connection, 'demo-table-105', [
      batch([cartItem(menuRows[3], '105-a', 1)], 3, 'done', {
        queuedAt: minutesAgo(12), cookingStartedAt: minutesAgo(8), completedAt: minutesAgo(5),
      }),
    ]);
    await createDemoOrder(connection, 'demo-table-106', [
      batch([cartItem(menuRows[4] ?? menuRows[0], '106-a', 3)], 4),
    ]);
    await createDemoOrder(connection, 'demo-table-107', [
      batch([cartItem(menuRows[5] ?? menuRows[1], '107-a', 1)], 5, 'done', {
        queuedAt: minutesAgo(10), cookingStartedAt: minutesAgo(6), completedAt: minutesAgo(4),
      }),
      batch([cartItem(menuRows[6] ?? menuRows[2], '107-b', 2, true)], 6),
    ]);

    const [settingsRows] = await connection.query('SELECT settings FROM restaurant_settings WHERE id = 1 LIMIT 1');
    const settings = sanitizeSettings(parseJsonColumn(settingsRows[0]?.settings, defaultSettings), defaultSettings);
    const localSeedDate = new Date(now);
    const dateTag = [
      localSeedDate.getFullYear(),
      String(localSeedDate.getMonth() + 1).padStart(2, '0'),
      String(localSeedDate.getDate()).padStart(2, '0'),
    ].join('');
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const paymentPoint = index => new Date(
      todayStart.getTime()
      + Math.floor((now - todayStart.getTime()) * ((index + 1) / (methods.length + 1))),
    );
    const methods = ['cash', 'card', 'qr', 'cash', 'qr', 'card'];
    for (let index = 0; index < methods.length; index += 1) {
      const completedReservation = index === 0
        ? reservations.get('DEMO-RSV-COMPLETED-108')
        : null;
      await createDemoPayment(connection, settings, {
        invoiceCode: `DEMO-SEED-${dateTag}-${String(index + 1).padStart(2, '0')}`,
        tableId: completedReservation?.tableId ?? `demo-paid-${index + 1}`,
        tableNumber: completedReservation?.tableNumber ?? 91 + index,
        method: methods[index],
        employeeId: DEMO_EMPLOYEES[index % DEMO_EMPLOYEES.length][0],
        staffName: DEMO_EMPLOYEES[index % DEMO_EMPLOYEES.length][2],
        paidAt: completedReservation?.closedAt ?? paymentPoint(index),
        reservationId: completedReservation?.id,
        reservationCode: completedReservation?.code,
        customerName: completedReservation?.name,
        guestCount: completedReservation?.partySize,
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

  const [[tableCount], [orderCount], [batchCount], [paymentCount], [employeeCount], [reservationCount], [queueCounts]] = await Promise.all([
    pool.query("SELECT COUNT(*) AS total FROM restaurant_tables WHERE id LIKE 'demo-table-%'"),
    pool.query("SELECT COUNT(*) AS total FROM active_orders WHERE table_id LIKE 'demo-table-%'"),
    pool.query("SELECT COUNT(*) AS total FROM order_batches WHERE table_id LIKE 'demo-table-%'"),
    pool.query("SELECT COUNT(*) AS total FROM payment_transactions WHERE JSON_UNQUOTE(JSON_EXTRACT(raw_payload, '$.demoSeed')) = ?", [DEMO_SEED_MARKER]),
    pool.query("SELECT COUNT(*) AS total FROM employees WHERE id LIKE 'demo-employee-%' AND active = TRUE"),
    pool.query(`SELECT COUNT(*) AS total FROM reservations WHERE reservation_code IN (${DEMO_RESERVATION_CODES.map(() => '?').join(', ')})`, DEMO_RESERVATION_CODES),
    pool.query("SELECT SUM(status = 'cooking') AS cooking, SUM(status = 'waiting') AS waiting, SUM(status = 'done') AS done FROM order_batches WHERE table_id LIKE 'demo-table-%'"),
  ]);
  console.log(
    `Seed test completed: tables=${tableCount[0].total}, reservations=${reservationCount[0].total}, activeOrders=${orderCount[0].total}, batches=${batchCount[0].total}, cooking=${queueCounts[0].cooking}, waiting=${queueCounts[0].waiting}, done=${queueCounts[0].done}, payments=${paymentCount[0].total}, employees=${employeeCount[0].total}`,
  );
}

try {
  await seed();
} finally {
  await closePool();
}
