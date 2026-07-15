import 'dotenv/config';

const baseUrl = process.env.SMOKE_API_URL || `http://127.0.0.1:${process.env.PORT || 4100}/api`;
const authorization = process.env.AUTH_USERNAME && process.env.AUTH_PASSWORD
  ? `Basic ${Buffer.from(`${process.env.AUTH_USERNAME}:${process.env.AUTH_PASSWORD}`).toString('base64')}`
  : null;

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(authorization ? { authorization } : {}),
      ...options.headers,
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${path}: ${response.status} ${body.message || ''}`);
  return body;
}

async function requestResult(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(authorization ? { authorization } : {}),
      ...options.headers,
    },
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

async function expectApiError(path, expectedStatus, expectedCode, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(authorization ? { authorization } : {}),
      ...options.headers,
    },
  });
  const body = await response.json().catch(() => ({}));
  if (response.status !== expectedStatus || body.error !== expectedCode) {
    throw new Error(`${options.method || 'GET'} ${path}: expected ${expectedStatus}/${expectedCode}, got ${response.status}/${body.error || 'NO_CODE'}`);
  }
  return body;
}

let table;
let originalKitchen;
let primaryReservation;
let followupReservation;

async function closeOpenReservations(tableId) {
  const query = new URLSearchParams({ tableId });
  const { reservations = [] } = await request(`/reservations?${query}`);
  for (const reservation of reservations) {
    if (reservation.status !== 'booked' && reservation.status !== 'seated') continue;
    const status = reservation.status === 'seated' ? 'completed' : 'cancelled';
    await request(`/reservations/${reservation.id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status, expectedVersion: reservation.version }),
    });
  }
}
try {
  const health = await request('/health');
  if (!health.ok) throw new Error('API health không sẵn sàng');
  const [catalog, operations] = await Promise.all([request('/catalog'), request('/operations')]);
  if (catalog.items.length === 0 || catalog.categories.length === 0) throw new Error('Catalog đang trống');
  if (!Array.isArray(operations.kitchen.staleBatches)) throw new Error('Snapshot bếp thiếu danh sách phiếu quá hạn');
  const paymentHistory = await request('/payments');
  if (paymentHistory.payments[0]) {
    const retried = await request('/payments', {
      method: 'POST',
      body: JSON.stringify({ payment: paymentHistory.payments[0] }),
    });
    if (!retried.idempotent || retried.payment.invoiceCode !== paymentHistory.payments[0].invoiceCode) {
      throw new Error('Retry payment chưa trả lại giao dịch đã commit');
    }
  }
  const reportFrom = new Date();
  reportFrom.setHours(0, 0, 0, 0);
  const reportTo = new Date(reportFrom);
  reportTo.setDate(reportTo.getDate() + 1);
  const reportQuery = new URLSearchParams({
    from: reportFrom.toISOString(),
    to: reportTo.toISOString(),
    timezoneOffsetMinutes: String(-reportFrom.getTimezoneOffset()),
  });
  const report = await request(`/reports/summary?${reportQuery}`);
  if (!Array.isArray(report.hourly) || !Array.isArray(report.daily) || !Array.isArray(report.topItems) || !Array.isArray(report.categories) || !Array.isArray(report.staff)) {
    throw new Error('API tổng hợp báo cáo thiếu nhóm dữ liệu bắt buộc');
  }
  if (report.daily.some(row => !/^\d{4}-\d{2}-\d{2}$/.test(row.date))) {
    throw new Error('Bucket ngày của báo cáo không đúng định dạng địa phương YYYY-MM-DD');
  }
  const dailyRevenue = report.daily.reduce((sum, row) => sum + Number(row.revenue), 0);
  const dailyOrders = report.daily.reduce((sum, row) => sum + Number(row.orders), 0);
  if (Math.abs(dailyRevenue - Number(report.totals.revenue)) > 0.001 || dailyOrders !== Number(report.totals.orders)) {
    throw new Error('Tổng bucket ngày không khớp KPI báo cáo');
  }
  const activeTable = operations.tables.find(item => item.orderNumber);
  if (activeTable) {
    const forcedStatus = ['waiting', 'cooking', 'done'].find(status => status !== activeTable.status);
    await expectApiError(`/tables/${activeTable.id}`, 409, 'ORDER_STATUS_ACTION_REQUIRED', {
      method: 'PUT',
      body: JSON.stringify({ table: { ...activeTable, status: forcedStatus } }),
    });
  }
  const cookingTable = operations.tables.find(item => item.status === 'cooking' && item.cookingBatchId);
  if (cookingTable) {
    const staleBatchId = Number(cookingTable.cookingBatchId) + 1_000_000_000;
    await expectApiError(`/tables/${cookingTable.id}/status`, 409, 'ORDER_BATCH_CHANGED', {
      method: 'PATCH',
      body: JSON.stringify({ status: 'done', expectedBatchId: staleBatchId }),
    });
    await expectApiError(`/orders/${cookingTable.id}/requeue`, 409, 'ORDER_BATCH_CHANGED', {
      method: 'POST',
      body: JSON.stringify({ expectedBatchId: staleBatchId }),
    });
  }
  originalKitchen = operations.kitchen;
  const pausedKitchen = await request('/kitchen/config', {
    method: 'PATCH',
    body: JSON.stringify({
      expectedVersion: originalKitchen.version,
      paused: true,
    }),
  });
  if (
    pausedKitchen.concurrency !== originalKitchen.concurrency
    || pausedKitchen.staleAfterMinutes !== originalKitchen.staleAfterMinutes
    || pausedKitchen.automationEnabled !== originalKitchen.automationEnabled
    || pausedKitchen.paused !== true
  ) throw new Error('PATCH cấu hình bếp một phần đã ghi đè trường không gửi');
  await expectApiError('/kitchen/dispatch-next', 409, 'KITCHEN_PAUSED', { method: 'POST' });
  await expectApiError('/kitchen/config', 409, 'KITCHEN_CONFIG_CHANGED', {
    method: 'PATCH',
    body: JSON.stringify({ expectedVersion: originalKitchen.version, paused: false }),
  });
  const usedNumbers = new Set(operations.tables.map(item => item.number));
  const tableNumber = Array.from({ length: 100 }, (_, index) => 999 - index).find(number => !usedNumbers.has(number));
  if (!tableNumber) throw new Error('Không còn số bàn smoke test');

  table = (await request('/tables', {
    method: 'POST', body: JSON.stringify({ table: { number: tableNumber, seats: 2 } }),
  })).table;
  const menuItem = catalog.items.find(item => item.available);

  const firstReservedAt = new Date(Date.now() + 10 * 60_000);
  const nextReservedAt = new Date(Date.now() + 45 * 60_000);
  const reservationPayload = {
    tableId: table.id,
    customerName: 'Khách smoke test',
    customerPhone: '0901234567',
    partySize: 2,
    reservedAt: firstReservedAt.toISOString(),
    durationMinutes: 30,
    notes: 'Tự động xóa sau smoke test',
  };
  primaryReservation = (await request('/reservations', {
    method: 'POST', body: JSON.stringify({ reservation: reservationPayload }),
  })).reservation;
  await expectApiError('/reservations', 409, 'RESERVATION_CONFLICT', {
    method: 'POST', body: JSON.stringify({ reservation: { ...reservationPayload, customerName: 'Khách trùng giờ' } }),
  });
  followupReservation = (await request('/reservations', {
    method: 'POST',
    body: JSON.stringify({ reservation: {
      ...reservationPayload,
      customerName: 'Khách lượt kế tiếp',
      customerPhone: '0912345678',
      reservedAt: nextReservedAt.toISOString(),
    } }),
  })).reservation;
  const concurrentReservedAt = new Date(Date.now() + 90 * 60_000).toISOString();
  const concurrentPayload = {
    ...reservationPayload,
    customerName: 'Khách đồng thời A',
    customerPhone: '0923456789',
    reservedAt: concurrentReservedAt,
  };
  const concurrentResults = await Promise.all([
    requestResult('/reservations', { method: 'POST', body: JSON.stringify({ reservation: concurrentPayload }) }),
    requestResult('/reservations', { method: 'POST', body: JSON.stringify({ reservation: { ...concurrentPayload, customerName: 'Khách đồng thời B' } }) }),
  ]);
  const concurrentCreated = concurrentResults.filter(result => result.status === 201).length;
  const concurrentConflicts = concurrentResults.filter(result => result.status === 409 && result.body.error === 'RESERVATION_CONFLICT').length;
  if (concurrentCreated !== 1 || concurrentConflicts !== 1) {
    throw new Error(`Khóa đặt bàn đồng thời sai: created=${concurrentCreated}, conflicts=${concurrentConflicts}`);
  }
  await expectApiError(`/orders/${table.id}`, 409, 'TABLE_RESERVED', {
    method: 'PUT',
    body: JSON.stringify({ items: [{ cartId: 'smoke-reserved-cart', menuItem, quantity: 1, selectedToppings: [] }] }),
  });
  primaryReservation = (await request(`/reservations/${primaryReservation.id}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'seated', expectedVersion: primaryReservation.version }),
  })).reservation;
  await expectApiError(`/reservations/${followupReservation.id}/status`, 409, 'TABLE_HAS_SEATED_RESERVATION', {
    method: 'PATCH',
    body: JSON.stringify({ status: 'seated', expectedVersion: followupReservation.version }),
  });

  const order = await request(`/orders/${table.id}`, {
    method: 'PUT',
    body: JSON.stringify({ items: [{ cartId: 'smoke-cart', menuItem, quantity: 2, selectedToppings: [], note: 'smoke-test' }] }),
  });
  if (order.status !== 'waiting') throw new Error(`Bếp đã pause nhưng order không ở trạng thái chờ: ${order.status}`);
  if (order.estimatedCookMinutes !== (menuItem.cookMinutes || 10) * 2) throw new Error('ETA chưa nhân đúng số lượng món');
  if (order.batchNumber !== 1 || order.isAddition) throw new Error('Lượt gọi đầu tiên không đúng');
  const beforeEdit = await request('/operations');
  const editableBatch = beforeEdit.waitingBatchesByTable[table.id]?.[0];
  if (!editableBatch || editableBatch.batchId !== order.batchId) throw new Error('API chưa trả đúng phiếu chờ có thể sửa');
  const edited = await request(`/orders/${table.id}/batches/${editableBatch.batchId}`, {
    method: 'PUT',
    body: JSON.stringify({
      items: [{ cartId: 'smoke-cart', menuItem, quantity: 3, selectedToppings: [], note: 'smoke-edited' }],
    }),
  });
  if (!edited.edited || edited.batchNumber !== 1 || edited.queuedAt !== editableBatch.queuedAt) {
    throw new Error('Sửa phiếu chờ đã làm thay đổi định danh hoặc vị trí FIFO');
  }
  if (edited.estimatedCookMinutes !== (menuItem.cookMinutes || 10) * 3) throw new Error('ETA phiếu sửa chưa được tính lại');

  await expectApiError('/payments', 409, 'ORDER_NOT_READY_FOR_PAYMENT', {
    method: 'POST',
    body: JSON.stringify({ payment: {
      tableId: table.id,
      invoiceCode: 'SMOKE-WAITING-INVOICE',
      transactionCode: 'SMOKE-WAITING-TRANSACTION',
      method: 'cash',
    } }),
  });
  const extraItem = catalog.items.find(item => item.available && item.id !== menuItem.id) || menuItem;
  const addition = await request(`/orders/${table.id}`, {
    method: 'PUT',
    body: JSON.stringify({
      append: true,
      items: [{ cartId: 'smoke-cart-extra', menuItem: extraItem, quantity: 1, selectedToppings: [], note: 'smoke-addition' }],
    }),
  });
  if (!addition.isAddition || addition.batchNumber !== 2) throw new Error('Lượt gọi thêm không tạo batch FIFO riêng');
  const withAddition = await request('/operations');
  const additionTable = withAddition.tables.find(item => item.id === table.id);
  if (additionTable?.additionalBatchCount !== 1 || additionTable?.batchCount !== 2) throw new Error('Bàn chưa hiển thị lượt gọi thêm');
  if (withAddition.tableOrders[table.id]?.length !== 2) throw new Error('Order tổng hợp chưa chứa đủ hai lượt gọi');
  if (withAddition.waitingBatchesByTable[table.id]?.length !== 2) throw new Error('Các lượt chờ chưa được tách riêng để chỉnh sửa');
  await request(`/orders/${table.id}`, { method: 'DELETE' });
  await closeOpenReservations(table.id);
  await request(`/tables/${table.id}`, { method: 'DELETE' });
  table = null;
  console.log(`Smoke passed: catalog=${catalog.items.length}, tables=${operations.tables.length}, reservation=${primaryReservation.code}, order=${order.orderNumber}`);
} finally {
  if (table) {
    await request(`/orders/${table.id}`, { method: 'DELETE' }).catch(() => {});
    await closeOpenReservations(table.id).catch(() => {});
    await request(`/tables/${table.id}`, { method: 'DELETE' }).catch(() => {});
  }
  if (originalKitchen) {
    const currentKitchen = (await request('/operations')).kitchen;
    await request('/kitchen/config', {
      method: 'PATCH',
      body: JSON.stringify({
        expectedVersion: currentKitchen.version,
        concurrency: originalKitchen.concurrency,
        staleAfterMinutes: originalKitchen.staleAfterMinutes,
        automationEnabled: originalKitchen.automationEnabled,
        paused: originalKitchen.paused,
      }),
    });
  }
}
