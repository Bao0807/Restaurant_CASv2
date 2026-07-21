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
let dailyStockMenuItem;
let fallbackUnlimitedMenuItem;

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

async function finishAllBatches(tableId) {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const snapshot = await request('/operations');
    const current = snapshot.tables.find(item => item.id === tableId);
    if (current?.status === 'done') return current;
    if (current?.cookingBatchId) {
      await request(`/tables/${tableId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'done', expectedBatchId: current.cookingBatchId }),
      });
    }
  }
  throw new Error('Không thể hoàn tất các phiếu bếp trong thời gian smoke test');
}
try {
  const health = await request('/health');
  if (!health.ok) throw new Error('API health không sẵn sàng');
  const [catalog, operations] = await Promise.all([request('/catalog'), request('/operations')]);
  if (catalog.items.length === 0 || catalog.categories.length === 0) throw new Error('Catalog đang trống');
  if (!Array.isArray(operations.kitchen.staleBatches)) throw new Error('Snapshot bếp thiếu danh sách phiếu quá hạn');
  if (!Array.isArray(operations.menuAvailability)) {
    throw new Error('Operations snapshot is missing daily menu availability');
  }
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
  const availableNumbers = Array.from({ length: 100 }, (_, index) => 999 - index)
    .filter(number => !usedNumbers.has(number));
  const [tableNumber, duplicatePositionTableNumber] = availableNumbers;
  if (!tableNumber || !duplicatePositionTableNumber) throw new Error('Không còn đủ số bàn smoke test');

  table = (await request('/tables', {
    method: 'POST',
    body: JSON.stringify({
      table: {
        number: tableNumber,
        seats: 2,
        area: 'Khu vực smoke',
        positionX: 1,
        positionY: 1,
      },
    }),
  })).table;
  if (table.area !== 'Khu vực smoke' || table.positionX !== 1 || table.positionY !== 1) {
    throw new Error('Tạo bàn chưa lưu hoặc chưa trả đúng khu vực/tọa độ');
  }
  await expectApiError('/tables', 409, 'TABLE_POSITION_OCCUPIED', {
    method: 'POST',
    body: JSON.stringify({
      table: {
        number: duplicatePositionTableNumber,
        seats: 2,
        area: '  Khu vực   smoke  ',
        positionX: 1,
        positionY: 1,
      },
    }),
  });
  await expectApiError('/tables', 400, 'VALIDATION_ERROR', {
    method: 'POST',
    body: JSON.stringify({ table: { number: tableNumber - 1, seats: 2, positionX: 5 } }),
  });
  const smokeCategory = catalog.categories.find(category => category.active !== false && category.id !== 'all');
  if (!smokeCategory) throw new Error('Smoke test requires an active menu category');

  // Keep the existing end-to-end order flow independent from daily stock limits.
  let menuItem = catalog.items.find(item => item.available && item.dailyLimit == null);
  if (!menuItem) {
    fallbackUnlimitedMenuItem = (await request('/menu-items', {
      method: 'POST',
      body: JSON.stringify({
        item: {
          id: 'smoke-unlimited-item',
          name: 'Smoke unlimited item',
          description: 'Created and deactivated automatically by the smoke test',
          price: 10_000,
          image: '',
          categoryId: smokeCategory.id,
          cookMinutes: 1,
          dailyLimit: null,
          available: true,
          sizes: [],
          toppings: [],
        },
      }),
    })).item;
    menuItem = fallbackUnlimitedMenuItem;
  }
  if (menuItem.dailyLimit != null) throw new Error('The legacy smoke flow must use an unlimited menu item');

  // Exercise the complete daily-stock lifecycle while the kitchen is paused so cancellation is allowed.
  dailyStockMenuItem = (await request('/menu-items', {
    method: 'POST',
    body: JSON.stringify({
      item: {
        id: 'smoke-daily-stock-item',
        name: 'Smoke daily stock item',
        description: 'Created and deactivated automatically by the smoke test',
        price: 12_000,
        image: '',
        categoryId: smokeCategory.id,
        cookMinutes: 1,
        dailyLimit: 3,
        available: true,
        sizes: [],
        toppings: [],
      },
    }),
  })).item;

  const limitedOrder = await request(`/orders/${table.id}`, {
    method: 'PUT',
    body: JSON.stringify({
      items: [{
        cartId: 'smoke-daily-stock-cart',
        menuItem: dailyStockMenuItem,
        quantity: 2,
        selectedToppings: [],
      }],
    }),
  });
  if (limitedOrder.status !== 'waiting') throw new Error('Daily-stock test order did not remain waiting');

  const afterLimitedOrder = await request('/operations');
  const afterOrderStock = afterLimitedOrder.menuAvailability.find(item => item.id === dailyStockMenuItem.id);
  if (afterOrderStock?.dailyLimit !== 3 || afterOrderStock.dailyUsed !== 2 || afterOrderStock.dailyRemaining !== 1) {
    throw new Error(`Daily stock was not reduced from 3 to 1: ${JSON.stringify(afterOrderStock)}`);
  }

  // Hai máy POS cùng giành phần cuối: transaction/row lock phải chỉ cho đúng một request thành công.
  const concurrentFinalPortion = await Promise.all(['a', 'b'].map(suffix => requestResult(`/orders/${table.id}`, {
    method: 'PUT',
    body: JSON.stringify({
      append: true,
      items: [{
        cartId: `smoke-daily-stock-concurrent-${suffix}`,
        menuItem: dailyStockMenuItem,
        quantity: 1,
        selectedToppings: [],
      }],
    }),
  })));
  const successfulFinalPortion = concurrentFinalPortion.filter(result => result.status === 200);
  const rejectedFinalPortion = concurrentFinalPortion.filter(result => (
    result.status === 409 && result.body.error === 'MENU_ITEM_DAILY_LIMIT_EXCEEDED'
  ));
  if (successfulFinalPortion.length !== 1 || rejectedFinalPortion.length !== 1) {
    throw new Error(`Concurrent final portion was not serialized correctly: ${JSON.stringify(concurrentFinalPortion)}`);
  }
  const afterConcurrentStock = (await request('/operations')).menuAvailability
    .find(item => item.id === dailyStockMenuItem.id);
  if (afterConcurrentStock?.dailyUsed !== 3 || afterConcurrentStock.dailyRemaining !== 0) {
    throw new Error(`Concurrent final portion oversold daily stock: ${JSON.stringify(afterConcurrentStock)}`);
  }

  await request(`/orders/${table.id}`, { method: 'DELETE' });
  const afterConcurrentCancel = await request('/operations');
  const restoredAfterConcurrency = afterConcurrentCancel.menuAvailability
    .find(item => item.id === dailyStockMenuItem.id);
  if (restoredAfterConcurrency?.dailyUsed !== 0 || restoredAfterConcurrency.dailyRemaining !== 3) {
    throw new Error(`Daily stock was not restored after concurrent test: ${JSON.stringify(restoredAfterConcurrency)}`);
  }

  const editLimitedOrder = await request(`/orders/${table.id}`, {
    method: 'PUT',
    body: JSON.stringify({
      items: [{
        cartId: 'smoke-daily-stock-cart',
        menuItem: dailyStockMenuItem,
        quantity: 2,
        selectedToppings: [],
      }],
    }),
  });
  const beforeLimitedEdit = await request('/operations');
  const limitedBatch = beforeLimitedEdit.waitingBatchesByTable[table.id]
    ?.find(batch => batch.batchId === editLimitedOrder.batchId);
  if (!limitedBatch) throw new Error('The waiting daily-stock batch is missing from operations');

  await request(`/orders/${table.id}/batches/${limitedBatch.batchId}`, {
    method: 'PUT',
    body: JSON.stringify({
      items: [{
        cartId: 'smoke-daily-stock-cart',
        menuItem: dailyStockMenuItem,
        quantity: 3,
        selectedToppings: [],
      }],
    }),
  });
  const afterLimitedEdit = await request('/operations');
  const afterEditStock = afterLimitedEdit.menuAvailability.find(item => item.id === dailyStockMenuItem.id);
  if (afterEditStock?.dailyUsed !== 3 || afterEditStock.dailyRemaining !== 0) {
    throw new Error(`Daily stock was not exhausted after editing to 3 portions: ${JSON.stringify(afterEditStock)}`);
  }
  if (afterEditStock.inventoryDate !== limitedBatch.inventoryDate) {
    throw new Error('Menu availability and the kitchen batch use different inventory dates');
  }

  await expectApiError(`/orders/${table.id}`, 409, 'MENU_ITEM_DAILY_LIMIT_EXCEEDED', {
    method: 'PUT',
    body: JSON.stringify({
      append: true,
      items: [{
        cartId: 'smoke-daily-stock-over-limit',
        menuItem: dailyStockMenuItem,
        quantity: 1,
        selectedToppings: [],
      }],
    }),
  });

  await request(`/orders/${table.id}`, { method: 'DELETE' });
  const afterLimitedCancel = await request('/operations');
  const afterCancelStock = afterLimitedCancel.menuAvailability.find(item => item.id === dailyStockMenuItem.id);
  const afterCancelTable = afterLimitedCancel.tables.find(item => item.id === table.id);
  if (afterCancelStock?.dailyUsed !== 0 || afterCancelStock.dailyRemaining !== 3) {
    throw new Error(`Daily stock was not restored after cancelling a waiting order: ${JSON.stringify(afterCancelStock)}`);
  }
  if (afterCancelTable?.status !== 'empty' || afterCancelTable.orderNumber) {
    throw new Error('The table did not return to empty after the daily-stock test order was cancelled');
  }

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
  const movedTable = (await request(`/tables/${table.id}`, {
    method: 'PUT',
    body: JSON.stringify({
      table: {
        number: table.number,
        seats: table.seats,
        status: order.status,
        area: 'Sân smoke',
        positionX: 2,
        positionY: 2,
      },
    }),
  })).table;
  if (movedTable.area !== 'Sân smoke' || movedTable.positionX !== 2 || movedTable.positionY !== 2) {
    throw new Error('Không thể đổi khu vực/tọa độ khi bàn đang phục vụ');
  }
  const movedOperationsTable = (await request('/operations')).tables.find(item => item.id === table.id);
  if (
    movedOperationsTable?.area !== 'Sân smoke'
    || movedOperationsTable?.positionX !== 2
    || movedOperationsTable?.positionY !== 2
  ) {
    throw new Error('Operations chưa trả đúng khu vực/tọa độ bàn');
  }
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

  const extraItem = catalog.items.find(item => (
    item.available && item.dailyLimit == null && item.id !== menuItem.id
  )) || menuItem;
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

  const paymentSuffix = Date.now();
  const earlyPaymentDraft = {
    tableId: table.id,
    invoiceCode: `SMOKE-${paymentSuffix}`,
    transactionCode: `SMOKE-TXN-${paymentSuffix}`,
    method: 'cash',
  };
  const earlyPayment = await request('/payments', {
    method: 'POST',
    body: JSON.stringify({ payment: earlyPaymentDraft }),
  });
  if (!earlyPayment.requiresDepartureConfirmation || earlyPayment.orderClosed) {
    throw new Error('Thanh toán sớm chưa giữ order để bếp tiếp tục phục vụ');
  }
  const retriedEarlyPayment = await request('/payments', {
    method: 'POST',
    body: JSON.stringify({ payment: earlyPaymentDraft }),
  });
  if (!retriedEarlyPayment.idempotent || !retriedEarlyPayment.requiresDepartureConfirmation) {
    throw new Error('Retry thanh toán sớm chưa giữ đúng vòng đời order');
  }

  const paidOperations = await request('/operations');
  const paidTable = paidOperations.tables.find(item => item.id === table.id);
  if (!paidTable?.isPaid || paidTable.paymentId !== earlyPaymentDraft.invoiceCode || !paidTable.paidAt) {
    throw new Error('Snapshot bàn chưa hiển thị trạng thái đã thanh toán');
  }
  await expectApiError(`/orders/${table.id}`, 409, 'ORDER_ALREADY_PAID', {
    method: 'PUT',
    body: JSON.stringify({
      append: true,
      items: [{ cartId: 'smoke-after-paid', menuItem, quantity: 1, selectedToppings: [] }],
    }),
  });
  await expectApiError(`/orders/${table.id}/batches/${editableBatch.batchId}`, 409, 'ORDER_ALREADY_PAID', {
    method: 'PUT',
    body: JSON.stringify({ items: [{ cartId: 'smoke-cart', menuItem, quantity: 1, selectedToppings: [] }] }),
  });
  await expectApiError(`/orders/${table.id}`, 409, 'ORDER_ALREADY_PAID', { method: 'DELETE' });
  await expectApiError(`/orders/${table.id}/confirm-departure`, 409, 'ORDER_NOT_READY_FOR_DEPARTURE', { method: 'POST' });

  const kitchenForCompletion = (await request('/operations')).kitchen;
  await request('/kitchen/config', {
    method: 'PATCH',
    body: JSON.stringify({
      expectedVersion: kitchenForCompletion.version,
      concurrency: 20,
      automationEnabled: true,
      paused: false,
    }),
  });
  await finishAllBatches(table.id);
  const readyToLeave = (await request('/operations')).tables.find(item => item.id === table.id);
  if (readyToLeave?.status !== 'done' || !readyToLeave.isPaid) {
    throw new Error('Bếp chưa hoàn tất order đã thanh toán sớm hoặc làm mất cờ đã thanh toán');
  }
  const departure = await request(`/orders/${table.id}/confirm-departure`, { method: 'POST' });
  if (!departure.orderClosed || departure.status !== 'empty') throw new Error('Xác nhận khách rời chưa đóng bàn');
  const retriedDeparture = await request(`/orders/${table.id}/confirm-departure`, { method: 'POST' });
  if (!retriedDeparture.idempotent || !retriedDeparture.orderClosed) {
    throw new Error('Retry xác nhận khách rời chưa idempotent');
  }
  const afterDeparture = (await request('/operations')).tables.find(item => item.id === table.id);
  if (afterDeparture?.status !== 'empty' || afterDeparture.orderNumber || afterDeparture.isPaid) {
    throw new Error('Bàn chưa trở về trống sau khi nhân viên xác nhận khách rời');
  }


  // Mô phỏng bếp vừa hoàn tất sau khi thu ngân đã mở màn trả trước: ý định giữ bàn phải được bảo toàn.
  await request(`/orders/${table.id}`, {
    method: 'PUT',
    body: JSON.stringify({ items: [{ cartId: 'smoke-race-cart', menuItem, quantity: 1, selectedToppings: [] }] }),
  });
  await finishAllBatches(table.id);
  const raceSuffix = Date.now();
  const racePayment = await request('/payments', {
    method: 'POST',
    body: JSON.stringify({ payment: {
      tableId: table.id,
      invoiceCode: `SMOKE-RACE-${raceSuffix}`,
      transactionCode: `SMOKE-RACE-TXN-${raceSuffix}`,
      method: 'cash',
      keepTableOpen: true,
    } }),
  });
  if (!racePayment.requiresDepartureConfirmation || racePayment.orderClosed) {
    throw new Error('Ý định thanh toán sớm bị mất khi bếp hoàn tất trước lúc gửi thanh toán');
  }
  const raceTable = (await request('/operations')).tables.find(item => item.id === table.id);
  if (raceTable?.status !== 'done' || !raceTable.isPaid) {
    throw new Error('Bàn thanh toán sớm không giữ trạng thái đã xong và đã thanh toán');
  }
  await request(`/orders/${table.id}/confirm-departure`, { method: 'POST' });

  // Luồng cũ vẫn giữ nguyên: nếu bắt đầu thanh toán sau khi món đã xong thì đóng bàn ngay.
  await request(`/orders/${table.id}`, {
    method: 'PUT',
    body: JSON.stringify({ items: [{ cartId: 'smoke-late-cart', menuItem, quantity: 1, selectedToppings: [] }] }),
  });
  await finishAllBatches(table.id);
  const lateSuffix = Date.now();
  const latePayment = await request('/payments', {
    method: 'POST',
    body: JSON.stringify({ payment: {
      tableId: table.id,
      invoiceCode: `SMOKE-LATE-${lateSuffix}`,
      transactionCode: `SMOKE-LATE-TXN-${lateSuffix}`,
      method: 'cash',
    } }),
  });
  if (latePayment.requiresDepartureConfirmation || !latePayment.orderClosed) {
    throw new Error('Thanh toán sau khi món hoàn tất không đóng bàn theo luồng cũ');
  }
  const afterLatePayment = (await request('/operations')).tables.find(item => item.id === table.id);
  if (afterLatePayment?.status !== 'empty' || afterLatePayment.orderNumber || afterLatePayment.isPaid) {
    throw new Error('Thanh toán sau khi món hoàn tất chưa trả bàn về trống');
  }

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
  if (dailyStockMenuItem) {
    await request(`/menu-items/${dailyStockMenuItem.id}`, { method: 'DELETE' }).catch(() => {});
  }
  if (fallbackUnlimitedMenuItem) {
    await request(`/menu-items/${fallbackUnlimitedMenuItem.id}`, { method: 'DELETE' }).catch(() => {});
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
