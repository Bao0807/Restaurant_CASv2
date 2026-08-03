const ORDER_BATCH_STATUSES = new Set(['waiting', 'cooking', 'done', 'served']);

/**
 * So sánh ý định gọi món thay vì các snapshot giá/catalog do server ghi đè.
 * `cartId` ổn định trong suốt một lần xác nhận nên một PUT bị gửi lại sau khi
 * response thất lạc có thể nhận lại phiếu cũ mà không tạo món hai lần.
 */
export function isSameOrderSubmission(incomingItems, persistedItems) {
  if (!Array.isArray(incomingItems) || !Array.isArray(persistedItems)) return false;
  if (incomingItems.length === 0 || incomingItems.length !== persistedItems.length) return false;

  const normalize = items => items.map(item => ({
    cartId: typeof item?.cartId === 'string' ? item.cartId : '',
    menuItemId: typeof item?.menuItem?.id === 'string' ? item.menuItem.id : '',
    quantity: Number(item?.quantity),
    size: typeof item?.selectedSize?.label === 'string' ? item.selectedSize.label : null,
    toppings: Array.isArray(item?.selectedToppings)
      ? item.selectedToppings.map(topping => topping?.id).sort()
      : [],
    note: typeof item?.note === 'string' ? item.note : '',
  })).sort((left, right) => (
    left.cartId.localeCompare(right.cartId)
    || left.menuItemId.localeCompare(right.menuItemId)
    || left.quantity - right.quantity
  ));

  return JSON.stringify(normalize(incomingItems)) === JSON.stringify(normalize(persistedItems));
}

/**
 * Tóm tắt trạng thái các phiếu bếp để mọi endpoint dùng chung một quy tắc nghiệp vụ.
 * Dữ liệu lạ được xem là không an toàn, vì vậy không thể hủy, thanh toán hoặc đóng order.
 */
export function summarizeOrderBatches(batches) {
  const summary = { total: 0, waiting: 0, cooking: 0, done: 0, served: 0, invalid: 0 };
  for (const batch of Array.isArray(batches) ? batches : []) {
    summary.total += 1;
    const status = batch?.status;
    if (ORDER_BATCH_STATUSES.has(status)) summary[status] += 1;
    else summary.invalid += 1;
  }
  return summary;
}

/** Chỉ order có ít nhất một phiếu và toàn bộ phiếu còn chờ mới được hủy. */
export function canCancelOrder(batches) {
  const summary = summarizeOrderBatches(batches);
  return summary.total > 0 && summary.waiting === summary.total && summary.invalid === 0;
}

/** Có thể thanh toán ngay khi order đã có ít nhất một phiếu bếp hợp lệ. */
export function canPayOrder(batches) {
  const summary = summarizeOrderBatches(batches);
  return summary.total > 0 && summary.invalid === 0;
}

/** Chỉ đóng order khi toàn bộ phiếu đã được mang ra phục vụ. */
export function isOrderComplete(batches) {
  const summary = summarizeOrderBatches(batches);
  return summary.total > 0 && summary.served === summary.total && summary.invalid === 0;
}

/**
 * Thanh toán trước khi mọi món được phục vụ phải giữ bàn tới lúc nhân viên xác nhận khách rời.
 * `keepTableOpen` còn giữ đúng ý định đó nếu bếp vừa hoàn tất trong lúc màn thanh toán đang mở.
 */
export function paymentRequiresDepartureConfirmation(batches, keepTableOpen = false) {
  return keepTableOpen === true || !isOrderComplete(batches);
}
