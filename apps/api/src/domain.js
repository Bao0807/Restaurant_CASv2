const PAYMENT_METHODS = new Set(['cash', 'card', 'qr']);
const EMPLOYEE_ROLES = new Set(['manager', 'cashier', 'server', 'chef']);
const PAYMENT_CODE_PATTERN = /^[A-Z0-9-]{8,64}$/;
const EMPLOYEE_CODE_PATTERN = /^[A-Z0-9_-]{2,24}$/;
const MAX_MONEY = 2_000_000_000;

function invalid(message, field) {
  const error = new Error(message);
  error.status = 400;
  error.code = 'VALIDATION_ERROR';
  error.field = field;
  return error;
}

function requiredString(value, field, maxLength) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    throw invalid(`${field} không hợp lệ`, field);
  }
  return value.trim();
}

function optionalString(value, field, maxLength) {
  if (value == null || value === '') return '';
  if (typeof value !== 'string' || value.length > maxLength) {
    throw invalid(`${field} không hợp lệ`, field);
  }
  return value.trim();
}

function integer(value, field, min, max) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < min || normalized > max) {
    throw invalid(`${field} không hợp lệ`, field);
  }
  return normalized;
}

function rate(value, field) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized < 0 || normalized > 1) {
    throw invalid(`${field} phải nằm trong khoảng 0 đến 1`, field);
  }
  return normalized;
}

function allowedArray(value, field, allowed, fallback) {
  if (!Array.isArray(value)) return fallback;
  const normalized = [...new Set(value.filter(item => allowed.has(item)))];
  if (normalized.length === 0) throw invalid(`${field} không hợp lệ`, field);
  return normalized;
}

function optionalTime(value, field) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw invalid(`${field} phải có định dạng HH:mm`, field);
  }
  return value;
}

/** Chuẩn hóa hồ sơ nhân viên để API tạo/cập nhật dùng chung một bộ quy tắc. */
export function normalizeEmployee(input, fallback = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw invalid('Hồ sơ nhân viên không hợp lệ', 'employee');
  }
  const source = { role: 'server', phone: '', shiftStart: null, shiftEnd: null, active: true, ...fallback, ...input };
  const code = requiredString(source.code, 'code', 24).toUpperCase();
  if (!EMPLOYEE_CODE_PATTERN.test(code)) {
    throw invalid('Mã nhân viên chỉ gồm chữ in hoa, số, _ hoặc -', 'code');
  }
  if (!EMPLOYEE_ROLES.has(source.role)) throw invalid('Vai trò nhân viên không hợp lệ', 'role');
  if (typeof source.active !== 'boolean') throw invalid('Trạng thái nhân viên không hợp lệ', 'active');

  const phone = optionalString(source.phone, 'phone', 32);
  if (phone && !/^[0-9+().\s-]+$/.test(phone)) throw invalid('Số điện thoại không hợp lệ', 'phone');

  return {
    code,
    name: requiredString(source.name, 'name', 120),
    role: source.role,
    phone,
    shiftStart: optionalTime(source.shiftStart, 'shiftStart'),
    shiftEnd: optionalTime(source.shiftEnd, 'shiftEnd'),
    active: source.active,
  };
}

/** Chuẩn hóa toàn bộ cấu hình thương hiệu/hóa đơn tại ranh giới API. */
export function sanitizeSettings(input, fallback) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw invalid('Cấu hình nhà hàng không hợp lệ', 'settings');
  }

  const source = { ...fallback, ...input };
  const widgetIds = new Set(['revenue', 'orders', 'paymentMix', 'topItems', 'staff']);

  return {
    restaurantName: requiredString(source.restaurantName, 'restaurantName', 160),
    legalName: requiredString(source.legalName, 'legalName', 200),
    tagline: optionalString(source.tagline, 'tagline', 200),
    address: requiredString(source.address, 'address', 300),
    phone: optionalString(source.phone, 'phone', 40),
    email: optionalString(source.email, 'email', 160),
    website: optionalString(source.website, 'website', 160),
    defaultArea: requiredString(source.defaultArea, 'defaultArea', 120),
    staffName: requiredString(source.staffName, 'staffName', 120),
    cashierName: requiredString(source.cashierName, 'cashierName', 120),
    customerName: requiredString(source.customerName, 'customerName', 120),
    guestCount: integer(source.guestCount, 'guestCount', 1, 100),
    vatRate: rate(source.vatRate, 'vatRate'),
    serviceFeeRate: rate(source.serviceFeeRate, 'serviceFeeRate'),
    discountAmount: integer(source.discountAmount, 'discountAmount', 0, MAX_MONEY),
    invoiceNote: optionalString(source.invoiceNote, 'invoiceNote', 500),
    activePaymentMethods: allowedArray(source.activePaymentMethods, 'activePaymentMethods', PAYMENT_METHODS, fallback.activePaymentMethods),
    visibleDashboardWidgets: allowedArray(source.visibleDashboardWidgets, 'visibleDashboardWidgets', widgetIds, fallback.visibleDashboardWidgets),
  };
}

/** Kiểm tra cấu trúc order và đặt giới hạn an toàn trước khi truy vấn catalog. */
export function validateOrderItems(input, { maxItems = 100 } = {}) {
  if (!Array.isArray(input) || input.length === 0 || input.length > maxItems) {
    throw invalid(`Order phải có từ 1 đến ${maxItems} dòng món`, 'items');
  }

  return input.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw invalid(`Món thứ ${index + 1} không hợp lệ`, `items.${index}`);
    }

    const menuItem = item.menuItem;
    if (!menuItem || typeof menuItem !== 'object') {
      throw invalid(`Thông tin món thứ ${index + 1} không hợp lệ`, `items.${index}.menuItem`);
    }

    const selectedSize = item.selectedSize == null ? undefined : {
      label: requiredString(item.selectedSize.label, `items.${index}.selectedSize.label`, 80),
      extraPrice: integer(item.selectedSize.extraPrice, `items.${index}.selectedSize.extraPrice`, 0, MAX_MONEY),
    };

    const toppings = Array.isArray(item.selectedToppings) ? item.selectedToppings : [];
    if (toppings.length > 20) throw invalid('Một món không được có quá 20 topping', `items.${index}.selectedToppings`);

    return {
      cartId: requiredString(item.cartId, `items.${index}.cartId`, 64),
      menuItem: {
        id: requiredString(menuItem.id, `items.${index}.menuItem.id`, 64),
        name: requiredString(menuItem.name, `items.${index}.menuItem.name`, 255),
        description: optionalString(menuItem.description, `items.${index}.menuItem.description`, 500),
        price: integer(menuItem.price, `items.${index}.menuItem.price`, 0, MAX_MONEY),
        image: optionalString(menuItem.image, `items.${index}.menuItem.image`, 1000),
        categoryId: requiredString(menuItem.categoryId, `items.${index}.menuItem.categoryId`, 64),
        cookMinutes: integer(menuItem.cookMinutes ?? 10, `items.${index}.menuItem.cookMinutes`, 1, 240),
        available: menuItem.available !== false,
        ...(menuItem.isBestseller ? { isBestseller: true } : {}),
        ...(menuItem.isNew ? { isNew: true } : {}),
      },
      quantity: integer(item.quantity, `items.${index}.quantity`, 1, 99),
      selectedSize,
      selectedToppings: toppings.map((topping, toppingIndex) => ({
        id: requiredString(topping.id, `items.${index}.selectedToppings.${toppingIndex}.id`, 64),
        label: requiredString(topping.label, `items.${index}.selectedToppings.${toppingIndex}.label`, 80),
        price: integer(topping.price, `items.${index}.selectedToppings.${toppingIndex}.price`, 0, MAX_MONEY),
      })),
      note: optionalString(item.note, `items.${index}.note`, 500),
    };
  });
}

/** Tính lại tiền ở server; không sử dụng bất kỳ tổng tiền nào client gửi lên. */
export function calculateTotals(items, settings) {
  const subtotal = items.reduce((sum, item) => {
    const unitPrice = item.menuItem.price
      + (item.selectedSize?.extraPrice ?? 0)
      + item.selectedToppings.reduce((toppingSum, topping) => toppingSum + topping.price, 0);
    const lineTotal = unitPrice * item.quantity;
    if (!Number.isSafeInteger(lineTotal) || sum + lineTotal > MAX_MONEY) {
      throw invalid('Tổng tiền order vượt giới hạn', 'items');
    }
    return sum + lineTotal;
  }, 0);

  const discount = Math.min(settings.discountAmount, subtotal);
  const taxableBase = subtotal - discount;
  const serviceFee = Math.round(taxableBase * settings.serviceFeeRate);
  const vat = Math.round((taxableBase + serviceFee) * settings.vatRate);
  const total = taxableBase + serviceFee + vat;

  if (!Number.isSafeInteger(total) || total > MAX_MONEY) {
    throw invalid('Tổng thanh toán vượt giới hạn', 'total');
  }

  return { subtotal, discount, serviceFee, vat, total };
}

/** Tạo bản ghi thanh toán chuẩn từ order, cấu hình và thời gian của server. */
export function createPayment({ draft, items, settings, table, paidAt = new Date() }) {
  if (!draft || typeof draft !== 'object') throw invalid('Thanh toán không hợp lệ', 'payment');
  if (!PAYMENT_METHODS.has(draft.method) || !settings.activePaymentMethods.includes(draft.method)) {
    throw invalid('Phương thức thanh toán không được phép', 'payment.method');
  }

  const invoiceCode = requiredString(draft.invoiceCode, 'payment.invoiceCode', 64);
  const transactionCode = requiredString(draft.transactionCode, 'payment.transactionCode', 64);
  if (!PAYMENT_CODE_PATTERN.test(invoiceCode) || !PAYMENT_CODE_PATTERN.test(transactionCode)) {
    throw invalid('Mã giao dịch không đúng định dạng', 'payment.invoiceCode');
  }

  const totals = calculateTotals(items, settings);
  return {
    id: invoiceCode,
    invoiceCode,
    transactionCode,
    tableId: table.id,
    tableNumber: table.number,
    method: draft.method,
    ...totals,
    itemCount: items.reduce((sum, item) => sum + item.quantity, 0),
    paidAt: paidAt.toISOString(),
    staffName: settings.staffName,
    cashierName: settings.cashierName,
  };
}

export function parseJsonColumn(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'string') return JSON.parse(value);
  return value;
}
