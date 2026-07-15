const ORDER_BATCH_STATUSES = new Set(['waiting', 'cooking', 'done']);

/**
 * Tóm tắt trạng thái các phiếu bếp để mọi endpoint dùng chung một quy tắc nghiệp vụ.
 * Dữ liệu lạ được xem là không an toàn, vì vậy không thể hủy hoặc thanh toán.
 */
export function summarizeOrderBatches(batches) {
  const summary = { total: 0, waiting: 0, cooking: 0, done: 0, invalid: 0 };
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

/** Thanh toán giải phóng bàn nên chỉ hợp lệ sau khi toàn bộ phiếu bếp đã hoàn tất. */
export function canSettleOrder(batches) {
  const summary = summarizeOrderBatches(batches);
  return summary.total > 0 && summary.done === summary.total && summary.invalid === 0;
}

