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

let table;
try {
  const health = await request('/health');
  if (!health.ok) throw new Error('API health không sẵn sàng');
  const [catalog, operations] = await Promise.all([request('/catalog'), request('/operations')]);
  if (catalog.items.length === 0 || catalog.categories.length === 0) throw new Error('Catalog đang trống');

  const usedNumbers = new Set(operations.tables.map(item => item.number));
  const tableNumber = Array.from({ length: 100 }, (_, index) => 999 - index).find(number => !usedNumbers.has(number));
  if (!tableNumber) throw new Error('Không còn số bàn smoke test');

  table = (await request('/tables', {
    method: 'POST', body: JSON.stringify({ table: { number: tableNumber, seats: 2 } }),
  })).table;
  const menuItem = catalog.items.find(item => item.available);
  const order = await request(`/orders/${table.id}`, {
    method: 'PUT',
    body: JSON.stringify({ items: [{ cartId: 'smoke-cart', menuItem, quantity: 2, selectedToppings: [], note: 'smoke-test' }] }),
  });
  if (!['waiting', 'cooking'].includes(order.status)) throw new Error(`Trạng thái order bất thường: ${order.status}`);
  if (order.estimatedCookMinutes !== (menuItem.cookMinutes || 10) * 2) throw new Error('ETA chưa nhân đúng số lượng món');
  if (order.status === 'cooking') {
    await request(`/orders/${table.id}/requeue`, { method: 'POST' });
    const refreshed = await request('/operations');
    const refreshedTable = refreshed.tables.find(item => item.id === table.id);
    if (!['waiting', 'cooking'].includes(refreshedTable?.status)) throw new Error('Requeue không giữ order trong queue');
    if (refreshedTable.status === 'cooking') {
      await request(`/tables/${table.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: 'done' }) });
    }
  }
  await request(`/orders/${table.id}`, { method: 'DELETE' });
  await request(`/tables/${table.id}`, { method: 'DELETE' });
  table = null;
  console.log(`Smoke passed: catalog=${catalog.items.length}, tables=${operations.tables.length}, order=${order.orderNumber}`);
} finally {
  if (table) {
    const latest = await request('/operations').catch(() => null);
    const current = latest?.tables.find(item => item.id === table.id);
    if (current?.status === 'cooking') {
      await request(`/tables/${table.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: 'done' }) }).catch(() => {});
    }
    await request(`/orders/${table.id}`, { method: 'DELETE' }).catch(() => {});
    await request(`/tables/${table.id}`, { method: 'DELETE' }).catch(() => {});
  }
}
