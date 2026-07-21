# @cas/web

Frontend React/Vite của Restaurant CASv2, gồm vận hành bàn thống nhất, đặt bàn, gọi món, thanh toán, in hóa đơn, báo cáo và quản trị.

Xem [README gốc](../../README.md) để cài đặt toàn hệ thống, cấu hình API/MySQL, quan hệ database, kiểm thử và triển khai production.

```bash
npm install
npm run dev --workspace @cas/web
```

Nếu chạy riêng trong thư mục này:

```bash
npm install
npm run dev
```

API local mặc định: `http://127.0.0.1:4100`, được Vite chuyển tiếp qua `/api`. `VITE_API_BASE_URL` là biến build-time của frontend; nếu cần đổi đích proxy dev, set `VITE_DEV_API_TARGET` trong environment của tiến trình Vite trước khi chạy.
