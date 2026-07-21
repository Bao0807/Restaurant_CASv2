import crypto from 'node:crypto';
import { parseJsonColumn } from './domain.js';
import { businessDateFor } from './dailyInventory.js';

function validationError(message, field) {
  const error = new Error(message);
  error.status = 400;
  error.code = 'VALIDATION_ERROR';
  error.field = field;
  return error;
}

function text(value, field, maxLength, { optional = false } = {}) {
  if (optional && (value == null || value === '')) return '';
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw validationError(`${field} không hợp lệ`, field);
  }
  return value.trim();
}

function integer(value, field, min, max) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < min || normalized > max) {
    throw validationError(`${field} không hợp lệ`, field);
  }
  return normalized;
}

function normalizeSizes(value) {
  if (!Array.isArray(value)) return [];
  if (value.length > 20) throw validationError('Một món chỉ được có tối đa 20 kích cỡ', 'sizes');
  return value.map((size, index) => ({
    label: text(size?.label, `sizes.${index}.label`, 80),
    extraPrice: integer(size?.extraPrice, `sizes.${index}.extraPrice`, 0, 2_000_000_000),
  }));
}

function normalizeToppings(value) {
  if (!Array.isArray(value)) return [];
  if (value.length > 50) throw validationError('Một món chỉ được có tối đa 50 topping', 'toppings');
  return value.map((topping, index) => ({
    id: text(topping?.id || `tp-${crypto.randomUUID().slice(0, 8)}`, `toppings.${index}.id`, 64),
    label: text(topping?.label, `toppings.${index}.label`, 80),
    price: integer(topping?.price, `toppings.${index}.price`, 0, 2_000_000_000),
  }));
}

/** Chuẩn hóa danh mục và sinh id ổn định khi tạo mới. */
export function normalizeCategory(input, fallbackId) {
  return {
    id: text(input?.id || fallbackId || `cat-${crypto.randomUUID().slice(0, 8)}`, 'id', 64),
    name: text(input?.name, 'name', 120),
    emoji: text(input?.emoji || '🍽️', 'emoji', 16),
    sortOrder: integer(input?.sortOrder ?? 0, 'sortOrder', -10_000, 10_000),
    active: input?.active !== false,
  };
}

/** Chuẩn hóa và giới hạn dữ liệu món trước khi ghi xuống catalog. */
export function normalizeMenuItem(input, fallbackId) {
  const dailyLimit = input?.dailyLimit == null || input.dailyLimit === ''
    ? null
    : integer(input.dailyLimit, 'dailyLimit', 0, 1_000_000);
  return {
    id: text(input?.id || fallbackId || `dish-${crypto.randomUUID().slice(0, 8)}`, 'id', 64),
    name: text(input?.name, 'name', 255),
    description: text(input?.description, 'description', 500, { optional: true }),
    price: integer(input?.price, 'price', 0, 2_000_000_000),
    image: text(input?.image, 'image', 1000, { optional: true }),
    categoryId: text(input?.categoryId, 'categoryId', 64),
    cookMinutes: integer(input?.cookMinutes ?? 10, 'cookMinutes', 1, 240),
    dailyLimit,
    available: input?.available !== false,
    isBestseller: input?.isBestseller === true,
    isNew: input?.isNew === true,
    sizes: normalizeSizes(input?.sizes),
    toppings: normalizeToppings(input?.toppings),
  };
}

export function mapMenuRow(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description || '',
    price: Number(row.price),
    image: row.image || '',
    categoryId: row.categoryId,
    cookMinutes: Number(row.cookMinutes),
    dailyLimit: row.dailyLimit == null ? null : Number(row.dailyLimit),
    dailyUsed: Number(row.dailyUsed ?? 0),
    dailyRemaining: row.dailyRemaining == null ? null : Number(row.dailyRemaining),
    inventoryDate: row.inventoryDate ?? businessDateFor(),
    available: Boolean(row.available),
    ...(row.isBestseller ? { isBestseller: true } : {}),
    ...(row.isNew ? { isNew: true } : {}),
    sizes: parseJsonColumn(row.sizes, []),
    toppings: parseJsonColumn(row.toppings, []),
  };
}

/** Đọc catalog đầy đủ và chuyển JSON/BOOLEAN MySQL về kiểu dữ liệu API. */
export async function getCatalog(connection, inventoryDate = businessDateFor()) {
  const [categoryRows] = await connection.query(
    `SELECT id, name, emoji, sort_order AS sortOrder, active
     FROM menu_categories ORDER BY sort_order, name`,
  );
  const [itemRows] = await connection.query(
    `SELECT item.id, item.name, item.description, item.price, item.image,
      item.category_id AS categoryId, item.cook_minutes AS cookMinutes,
      item.daily_limit AS dailyLimit, COALESCE(daily_usage.used_quantity, 0) AS dailyUsed,
      CASE WHEN item.daily_limit IS NULL THEN NULL
        ELSE GREATEST(item.daily_limit - COALESCE(daily_usage.used_quantity, 0), 0)
      END AS dailyRemaining,
      ? AS inventoryDate, item.available, item.is_bestseller AS isBestseller,
      item.is_new AS isNew, item.sizes_json AS sizes, item.toppings_json AS toppings
     FROM menu_items item
     LEFT JOIN menu_item_daily_usage daily_usage
       ON daily_usage.menu_item_id = item.id AND daily_usage.business_date = ?
     ORDER BY item.name`,
    [inventoryDate, inventoryDate],
  );
  return {
    categories: categoryRows.map(row => ({ ...row, sortOrder: Number(row.sortOrder), active: Boolean(row.active) })),
    items: itemRows.map(mapMenuRow),
  };
}

/** Tạo hoặc cập nhật danh mục theo id trong một câu lệnh upsert. */
export async function saveCategory(connection, input, fallbackId) {
  const category = normalizeCategory(input, fallbackId);
  await connection.query(
    `INSERT INTO menu_categories (id, name, emoji, sort_order, active)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE name = VALUES(name), emoji = VALUES(emoji),
       sort_order = VALUES(sort_order), active = VALUES(active)`,
    [category.id, category.name, category.emoji, category.sortOrder, category.active],
  );
  return category;
}

/** Tạo/cập nhật món sau khi xác nhận danh mục cha còn tồn tại. */
export async function saveMenuItem(connection, input, fallbackId) {
  const item = normalizeMenuItem(input, fallbackId);
  const [categories] = await connection.query('SELECT id FROM menu_categories WHERE id = ? LIMIT 1', [item.categoryId]);
  if (!categories[0]) throw validationError('Danh mục món không tồn tại', 'categoryId');
  await connection.query(
    `INSERT INTO menu_items (
      id, name, description, price, image, category_id, cook_minutes, daily_limit,
      available, is_bestseller, is_new, sizes_json, toppings_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE name = VALUES(name), description = VALUES(description),
      price = VALUES(price), image = VALUES(image), category_id = VALUES(category_id),
      cook_minutes = VALUES(cook_minutes), daily_limit = VALUES(daily_limit), available = VALUES(available),
      is_bestseller = VALUES(is_bestseller), is_new = VALUES(is_new),
      sizes_json = VALUES(sizes_json), toppings_json = VALUES(toppings_json)`,
    [
      item.id, item.name, item.description, item.price, item.image, item.categoryId,
      item.cookMinutes, item.dailyLimit, item.available, item.isBestseller, item.isNew,
      JSON.stringify(item.sizes), JSON.stringify(item.toppings),
    ],
  );
  return item;
}

/** Chỉ seed catalog mẫu khi database chưa có món, tránh ghi đè dữ liệu vận hành. */
export async function bootstrapCatalog(connection, categoryInputs, itemInputs) {
  const [counts] = await connection.query('SELECT COUNT(*) AS count FROM menu_items');
  if (Number(counts[0]?.count) > 0) return getCatalog(connection);
  if (!Array.isArray(categoryInputs) || !Array.isArray(itemInputs) || itemInputs.length === 0) {
    throw validationError('Dữ liệu khởi tạo thực đơn không hợp lệ', 'catalog');
  }
  for (let index = 0; index < categoryInputs.length; index += 1) {
    const category = categoryInputs[index];
    if (category?.id === 'all') continue;
    await saveCategory(connection, { ...category, sortOrder: category.sortOrder ?? index });
  }
  for (const item of itemInputs) await saveMenuItem(connection, item);
  return getCatalog(connection);
}

/**
 * Thay dữ liệu giá/tùy chọn do client gửi bằng bản catalog đang có trong MySQL.
 * Đây là ranh giới tin cậy giúp order không thể giả giá, size hoặc topping.
 */
export async function canonicalizeOrderItems(
  connection,
  items,
  { inventoryDate = businessDateFor(), lock = false } = {},
) {
  const ids = [...new Set(items.map(item => item.menuItem.id))].sort();
  const placeholders = ids.map(() => '?').join(', ');
  const [rows] = await connection.query(
    `SELECT item.id, item.name, item.description, item.price, item.image,
      item.category_id AS categoryId, item.cook_minutes AS cookMinutes,
      item.daily_limit AS dailyLimit, COALESCE(daily_usage.used_quantity, 0) AS dailyUsed,
      CASE WHEN item.daily_limit IS NULL THEN NULL
        ELSE GREATEST(item.daily_limit - COALESCE(daily_usage.used_quantity, 0), 0)
      END AS dailyRemaining,
      ? AS inventoryDate, item.available, item.is_bestseller AS isBestseller,
      item.is_new AS isNew, item.sizes_json AS sizes, item.toppings_json AS toppings
     FROM menu_items item
     LEFT JOIN menu_item_daily_usage daily_usage
       ON daily_usage.menu_item_id = item.id AND daily_usage.business_date = ?
     WHERE item.id IN (${placeholders})
     ORDER BY item.id${lock ? ' FOR UPDATE' : ''}`,
    [inventoryDate, inventoryDate, ...ids],
  );
  const catalog = new Map(rows.map(row => [row.id, mapMenuRow(row)]));
  return items.map((item, index) => {
    const menuItem = catalog.get(item.menuItem.id);
    if (!menuItem || !menuItem.available) {
      throw validationError(`Món thứ ${index + 1} hiện không phục vụ`, `items.${index}.menuItem.id`);
    }
    let selectedSize;
    if (item.selectedSize) {
      selectedSize = menuItem.sizes.find(size => size.label === item.selectedSize.label);
      if (!selectedSize) throw validationError('Kích cỡ món không còn hợp lệ', `items.${index}.selectedSize`);
    }
    const selectedToppings = item.selectedToppings.map(selected => {
      const topping = menuItem.toppings.find(option => option.id === selected.id);
      if (!topping) throw validationError('Topping không còn hợp lệ', `items.${index}.selectedToppings`);
      return topping;
    });
    return { ...item, menuItem, selectedSize, selectedToppings };
  });
}

/**
 * Tính ETA bếp của order: mỗi dòng món được tính tuần tự theo số lượng,
 * còn các dòng món khác nhau được giả định có thể chế biến song song.
 */
export function estimateCookMinutes(items) {
  return Math.max(1, ...items.map(item => {
    const cookMinutes = Number(item.menuItem.cookMinutes) || 10;
    const quantity = Number(item.quantity) || 1;
    return cookMinutes * quantity;
  }));
}
