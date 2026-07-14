import React from "react";
import "./restaurant-invoice.css";

function formatCurrency(value) {
  return new Intl.NumberFormat("vi-VN").format(value) + "đ";
}

export default function RestaurantInvoice({ data }) {
  const subtotal = data.items.reduce(
    (sum, item) => sum + item.quantity * item.price,
    0
  );

  const serviceFee = Math.round(subtotal * data.serviceFeeRate);
  const vat = Math.round(subtotal * data.vatRate);
  const total = subtotal - data.discount + serviceFee + vat;

  return (
    <div className="invoice-page">
      <div className="invoice-card">
        <div className="invoice-header">
          <div className="invoice-brand">
            <img
              src={data.logo || "/logo-cas.svg"}
              alt="CAS Logo"
              className="invoice-logo"
            />

            <div>
              <h1>CAS</h1>
              <p>CORE ADVANCED SOLUTIONS</p>
            </div>
          </div>

          <div className="invoice-header-right">
            <h2>HÓA ĐƠN THANH TOÁN</h2>
            <h3>Nhà hàng CAS</h3>
            <p>Core Advanced Solutions</p>
          </div>
        </div>

        <div className="invoice-contact">
          <div><span>Địa chỉ</span><strong>{data.restaurant.address}</strong></div>
          <div><span>Hotline</span><strong>{data.restaurant.phone}</strong></div>
          <div><span>Email</span><strong>{data.restaurant.email}</strong></div>
          <div><span>Website</span><strong>{data.restaurant.website}</strong></div>
        </div>

        <div className="invoice-info-grid">
          <div className="invoice-info-box icon-box">
            <div className="invoice-receipt-icon">🧾</div>
          </div>
          <div className="invoice-info-box"><span>Mã hóa đơn</span><strong>{data.invoiceCode}</strong></div>
          <div className="invoice-info-box"><span>Ngày</span><strong>{data.date}</strong></div>
          <div className="invoice-info-box"><span>Giờ</span><strong>{data.time}</strong></div>
          <div className="invoice-info-box"><span>Số bàn</span><strong>{data.table}</strong></div>
          <div className="invoice-info-box"><span>Khu vực</span><strong>{data.area}</strong></div>
          <div className="invoice-info-box"><span>Khách hàng</span><strong>{data.customerName}</strong></div>
          <div className="invoice-info-box"><span>Số khách</span><strong>{data.guestCount}</strong></div>
          <div className="invoice-info-box"><span>Thu ngân / Phục vụ</span><strong>{data.staffName}</strong></div>
        </div>

        <div className="invoice-table-wrapper">
          <table className="invoice-table">
            <thead>
              <tr>
                <th>STT</th>
                <th>Món ăn / Đồ uống</th>
                <th>SL</th>
                <th>Đơn giá</th>
                <th>Thành tiền</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((item, index) => (
                <tr key={`${item.name}-${index}`}>
                  <td data-label="STT">{index + 1}</td>
                  <td data-label="Món ăn / Đồ uống">{item.name}</td>
                  <td data-label="SL">{item.quantity}</td>
                  <td data-label="Đơn giá">{new Intl.NumberFormat("vi-VN").format(item.price)}</td>
                  <td data-label="Thành tiền">{new Intl.NumberFormat("vi-VN").format(item.quantity * item.price)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="invoice-bottom-grid">
          <div className="payment-box">
            <h4>Phương thức thanh toán</h4>
            <div className="payment-row"><span>Phương thức:</span><strong>{data.paymentMethod}</strong></div>
            <div className="payment-row"><span>Trạng thái:</span><strong>{data.paymentStatus}</strong></div>
            <div className="payment-row"><span>Mã giao dịch:</span><strong>{data.transactionCode}</strong></div>
          </div>

          <div className="summary-box">
            <div className="summary-row"><span>Tạm tính:</span><strong>{formatCurrency(subtotal)}</strong></div>
            <div className="summary-row discount"><span>Giảm giá thành viên:</span><strong>-{formatCurrency(data.discount)}</strong></div>
            <div className="summary-row"><span>Phí dịch vụ ({Math.round(data.serviceFeeRate * 100)}%):</span><strong>{formatCurrency(serviceFee)}</strong></div>
            <div className="summary-row"><span>VAT ({Math.round(data.vatRate * 100)}%):</span><strong>{formatCurrency(vat)}</strong></div>
            <div className="summary-total"><span>TỔNG CỘNG:</span><strong>{formatCurrency(total)}</strong></div>
          </div>
        </div>

        <div className="invoice-footer">
          <div className="footer-box"><h5>GHI CHÚ</h5><p>{data.note}</p></div>
          <div className="footer-box center-box"><div className="qr-placeholder">QR</div><p>Quét để đánh giá / theo dõi</p></div>
          <div className="footer-box"><h5>KHÁCH HÀNG THÂN THIẾT</h5><p>Tích điểm – Nhận ưu đãi</p><p>Cùng CAS gắn kết lâu dài!</p></div>
        </div>

        <div className="invoice-bottom-bar">
          <span>{data.social.facebook}</span>
          <span>{data.social.instagram}</span>
          <span>{data.restaurant.phone}</span>
          <span>{data.restaurant.website}</span>
        </div>
      </div>
    </div>
  );
}
