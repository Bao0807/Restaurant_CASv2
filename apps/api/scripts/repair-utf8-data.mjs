import 'dotenv/config';
import mysql from 'mysql2/promise';
import { defaultSettings } from '../src/defaultSettings.js';

const applyChanges = process.argv.includes('--apply');
const databaseName = process.env.DB_NAME || 'restaurant_casv2';

if (!/^[a-zA-Z0-9_]+$/.test(databaseName)) {
  throw new Error('DB_NAME chỉ được chứa chữ, số và dấu gạch dưới.');
}

const connection = await mysql.createConnection({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD ?? '1234',
  database: databaseName,
  charset: 'utf8mb4',
  timezone: 'Z',
  connectTimeout: Number(process.env.DB_CONNECT_TIMEOUT_MS || 10_000),
});

// Đây là đúng các giá trị bị hỏng đã quan sát được. So khớp chính xác để không
// ghi đè lên cấu hình hợp lệ mà người quản lý đã tự chỉnh.
const corruptedSettings = {
  email: 'Chua c?p nh?t',
  phone: 'Chua c?p nh?t',
  address: 'Chua c?p nh?t d?a ch?',
  tagline: 'Ph?c v? t?n t\uFFFDm',
  website: 'Chua c?p nh?t',
  staffName: 'Nh\uFFFDn vi\uFFFDn ph?c v?',
  cashierName: 'Thu ng\uFFFDn',
  defaultArea: 'S?nh ch\uFFFDnh',
  invoiceNote: 'C?m on qu\uFFFD kh\uFFFDch. H?n g?p l?i!',
  customerName: 'Kh\uFFFDch l?',
  restaurantName: 'Nh\uFFFD h\uFFFDng CAS',
};

function parseJson(value, fallback = {}) {
  if (value && typeof value === 'object') return structuredClone(value);
  if (typeof value !== 'string') return structuredClone(fallback);
  try {
    return JSON.parse(value);
  } catch {
    return structuredClone(fallback);
  }
}

function repairKnownStrings(target) {
  const repairedFields = [];
  for (const [field, corruptedValue] of Object.entries(corruptedSettings)) {
    if (target?.[field] !== corruptedValue || typeof defaultSettings[field] !== 'string') continue;
    target[field] = defaultSettings[field];
    repairedFields.push(field);
  }
  return repairedFields;
}

try {
  await connection.beginTransaction();

  const [settingsRows] = await connection.query(
    'SELECT settings, version FROM restaurant_settings WHERE id = 1 FOR UPDATE',
  );
  if (!settingsRows[0]) throw new Error('Không tìm thấy restaurant_settings id=1.');

  const settings = parseJson(settingsRows[0].settings, defaultSettings);
  const repairedSettingFields = repairKnownStrings(settings);

  const [paymentRows] = await connection.query(
    'SELECT id, invoice_code AS invoiceCode, cashier_name AS cashierName, raw_payload AS rawPayload FROM payment_transactions FOR UPDATE',
  );
  const repairedPayments = [];

  for (const row of paymentRows) {
    const rawPayload = parseJson(row.rawPayload);
    const snapshot = rawPayload.invoiceSnapshot && typeof rawPayload.invoiceSnapshot === 'object'
      ? rawPayload.invoiceSnapshot
      : null;
    const repairedSnapshotFields = snapshot ? repairKnownStrings(snapshot) : [];
    const cashierName = row.cashierName === corruptedSettings.cashierName
      ? defaultSettings.cashierName
      : row.cashierName;
    const cashierChanged = cashierName !== row.cashierName;

    if (!cashierChanged && repairedSnapshotFields.length === 0) continue;
    repairedPayments.push({
      id: Number(row.id),
      invoiceCode: row.invoiceCode,
      cashierChanged,
      snapshotFields: repairedSnapshotFields,
    });

    if (applyChanges) {
      await connection.query(
        'UPDATE payment_transactions SET cashier_name = ?, raw_payload = ? WHERE id = ?',
        [cashierName, JSON.stringify(rawPayload), row.id],
      );
    }
  }

  const plan = {
    mode: applyChanges ? 'apply' : 'dry-run',
    settingsVersionBefore: Number(settingsRows[0].version),
    repairedSettingFields,
    repairedPayments,
  };

  if (!applyChanges) {
    await connection.rollback();
    console.log(JSON.stringify(plan, null, 2));
  } else {
    if (repairedSettingFields.length > 0) {
      await connection.query(
        `UPDATE restaurant_settings
         SET settings = ?, version = version + 1, updated_at = CURRENT_TIMESTAMP
         WHERE id = 1`,
        [JSON.stringify(settings)],
      );
    }

    if (repairedSettingFields.length > 0 || repairedPayments.length > 0) {
      await connection.query(
        `INSERT INTO audit_events (
          request_id, actor_username, actor_role, action, entity_type, entity_id, metadata
        ) VALUES (?, ?, 'manager', 'repair.utf8_encoding', 'maintenance', 'restaurant-data', ?)`,
        [
          `utf8-repair-${Date.now()}`,
          'codex-maintenance',
          JSON.stringify({
            repairedSettingFields,
            repairedPayments: repairedPayments.map(payment => ({
              invoiceCode: payment.invoiceCode,
              cashierChanged: payment.cashierChanged,
              snapshotFields: payment.snapshotFields,
            })),
          }),
        ],
      );
    }

    await connection.commit();
    console.log(JSON.stringify({ ...plan, committed: true }, null, 2));
  }
} catch (error) {
  await connection.rollback().catch(() => {});
  throw error;
} finally {
  await connection.end();
}
