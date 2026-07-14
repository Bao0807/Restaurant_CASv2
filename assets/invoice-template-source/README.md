# CAS Restaurant Invoice Source

Bộ file này dùng để thêm mẫu hóa đơn nhà hàng CAS vào dự án React.

## Cấu trúc

```txt
src/
  components/
    RestaurantInvoice.jsx
    restaurant-invoice.css
  App.example.jsx

public/
  logo-cas.svg
```

## Cách dùng nhanh

1. Copy thư mục `components` vào `src/components`.
2. Copy `logo-cas.svg` vào thư mục `public`.
3. Import component:

```jsx
import RestaurantInvoice from "./components/RestaurantInvoice";
```

4. Truyền dữ liệu đơn hàng:

```jsx
<RestaurantInvoice data={invoiceData} />
```

## Dữ liệu có thể đổi động

- Mã hóa đơn, ngày giờ, số bàn, khu vực
- Khách hàng, số khách, thu ngân / phục vụ
- Danh sách món ăn
- Giảm giá, phí dịch vụ, VAT, tổng tiền
- Phương thức thanh toán, trạng thái thanh toán, mã giao dịch

## In hóa đơn

CSS đã có `@media print`, nên có thể dùng:

```js
window.print();
```

Để xuất PDF trong trình duyệt, bấm `Ctrl + P` rồi chọn `Save as PDF`.
