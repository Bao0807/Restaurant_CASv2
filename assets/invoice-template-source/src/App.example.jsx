import React from "react";
import RestaurantInvoice from "./components/RestaurantInvoice";

const invoiceData = {
  logo: "/logo-cas.svg",
  restaurant: {
    address: "123 Nguyễn Huệ, Quận 1, TP. Hồ Chí Minh",
    phone: "0909 123 456",
    email: "support@cas.vn",
    website: "www.cas.vn",
  },
  invoiceCode: "INV-2026-0705-018",
  date: "05/07/2026",
  time: "19:45",
  table: "B12",
  area: "Tầng 1",
  customerName: "Trần Bảo",
  guestCount: 4,
  staffName: "Nguyễn Linh",
  paymentMethod: "Thẻ",
  paymentStatus: "Đã thanh toán",
  transactionCode: "CASPAY874231",
  discount: 50000,
  serviceFeeRate: 0.05,
  vatRate: 0.08,
  note: "Cảm ơn quý khách đã sử dụng dịch vụ tại Nhà hàng CAS. Hẹn gặp lại!",
  social: { facebook: "/cas.restaurant", instagram: "/cas.restaurant" },
  items: [
    { name: "Bò lúc lắc", quantity: 1, price: 185000 },
    { name: "Cơm chiên hải sản", quantity: 2, price: 95000 },
    { name: "Salad Caesar", quantity: 1, price: 89000 },
    { name: "Cá hồi áp chảo", quantity: 1, price: 225000 },
    { name: "Mì Ý sốt bò bằm", quantity: 1, price: 120000 },
    { name: "Trà đào cam sả", quantity: 3, price: 45000 },
    { name: "Nước suối", quantity: 2, price: 18000 },
    { name: "Tiramisu", quantity: 1, price: 65000 },
  ],
};

export default function App() {
  return <RestaurantInvoice data={invoiceData} />;
}
