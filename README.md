# Restaurant CASv2

Hệ thống POS và điều phối vận hành nhà hàng: đặt bàn, gọi món theo bàn, hàng đợi bếp FIFO, thanh toán, in phiếu/hóa đơn, báo cáo và quản trị. MySQL là nguồn dữ liệu nghiệp vụ; backend xác thực lại giá, tùy chọn món, ETA, tổng tiền và quan hệ đặt bàn trước khi ghi dữ liệu.

> **Mức độ hoàn thiện:** phù hợp pilot và vận hành production nội bộ sau khi hoàn thành checklist triển khai. Session cookie, RBAC, CI, audit log và quality gate đã có; trước khi mở trực tiếp ra Internet vẫn cần hoàn thành các mục phụ thuộc hạ tầng/nhà cung cấp trong [Giới hạn và việc cần làm trước production](#giới-hạn-và-việc-cần-làm-trước-production).

## Mục lục

- [Bắt đầu nhanh](#bắt-đầu-nhanh)
- [Tính năng chính](#tính-năng-chính)
- [Kiến trúc](#kiến-trúc)
- [Cấu trúc thư mục](#cấu-trúc-thư-mục)
- [Cấu hình môi trường](#cấu-hình-môi-trường)
- [Database và quan hệ dữ liệu](#database-và-quan-hệ-dữ-liệu)
- [Luồng nghiệp vụ](#luồng-nghiệp-vụ)
- [API chính](#api-chính)
- [Scripts và kiểm thử](#scripts-và-kiểm-thử)
- [Triển khai production](#triển-khai-production)
- [Giới hạn và việc cần làm trước production](#giới-hạn-và-việc-cần-làm-trước-production)
- [Xử lý lỗi thường gặp](#xử-lý-lỗi-thường-gặp)

## Bắt đầu nhanh

Yêu cầu: Node.js `>=24.15.0`, npm `11.x` (repository khóa metadata ở `npm@11.13.0`) và MySQL `8.x`.

```powershell
npm install
Copy-Item apps/api/.env.example apps/api/.env
Copy-Item apps/web/.env.example apps/web/.env
```

Trên macOS/Linux, thay hai lệnh `Copy-Item` bằng:

```bash
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env
```

Sau đó cập nhật ít nhất `DB_PASSWORD`, `AUTH_USERNAME` và `AUTH_PASSWORD` trong `apps/api/.env`, rồi chạy:

```powershell
npm run db:migrate
npm run dev:api
```

Mở terminal thứ hai:

```powershell
npm run dev:web
```

- Web: `http://localhost:5173`
- API health: `http://127.0.0.1:4100/api/health`
- Dữ liệu demo: chạy `npm run db:seed:test` **chỉ trên database development/test**.

## Tổng quan

| Thành phần | Công nghệ | Vai trò |
|---|---|---|
| Web | React 18, TypeScript, Vite | Đặt bàn, gọi món, bếp, thanh toán, báo cáo và quản trị |
| API | Node.js, Express | Xác thực, validation, transaction, đặt bàn và nghiệp vụ queue |
| Database | MySQL 8, InnoDB | Catalog, bàn, lịch đặt, order đang mở, cấu hình và giao dịch |
| Biểu đồ | Recharts, lazy-loaded | Báo cáo doanh thu và hóa đơn theo giờ/ngày/tuần |
| Giao diện | CSS responsive, Lucide | Desktop, tablet, mobile, phiếu bếp 80 mm và hóa đơn A4/80 mm |

| Quality gate gần nhất | Kết quả ngày 03/08/2026 |
|---|---:|
| Unit test backend | `40/40` đạt |
| Unit/a11y test frontend | `10/10` đạt |
| Browser E2E Chromium | `2/2` đạt |
| Database audit read-only | `33/33` nhóm đạt |
| ESLint | Đạt, không warning |
| TypeScript | Đạt |
| Production build | Đạt |
| Dependency audit | `0` cảnh báo |
| Smoke test API/MySQL | Đạt trên database test |

Các kết quả trên có thể tái lập bằng lệnh trong [Scripts và kiểm thử](#scripts-và-kiểm-thử). Workflow `.github/workflows/ci.yml` chạy lại quality gate, migration, database audit, API smoke và Chromium E2E trên database MySQL cô lập.

## Ảnh giao diện

![Màn hình vận hành bàn](docs/screenshots/02-table-overview-desktop.png)

<details>
<summary>Xem toàn bộ ảnh desktop/mobile</summary>

### Đăng nhập

![Màn hình đăng nhập CAS](docs/screenshots/01-login-desktop.png)

### Sơ đồ mặt bằng

![Sơ đồ mặt bằng bàn theo khu vực và tọa độ](docs/screenshots/09-floor-plan-desktop.png)

### Gọi món và ETA trên mobile

<p align="center">
  <img src="docs/screenshots/03-order-eta-mobile.png" alt="Xác nhận order và ETA trên mobile" width="390" />
</p>

### Modal bàn trên mobile

<p align="center">
  <img src="docs/screenshots/06-table-modal-mobile.png" alt="Modal quản lý bàn phủ đủ viewport trên mobile" width="390" />
</p>

### Điều phối bếp và quản trị

![Dashboard quản trị bếp và nhân viên](docs/screenshots/04-kitchen-dashboard-desktop.png)

### Báo cáo

![Báo cáo tháng CAS với trục theo tuần](docs/screenshots/05-reports-desktop.png)

### Thanh toán

![Hàng chờ thanh toán và các bàn đã thanh toán nhưng chưa giải phóng](docs/screenshots/10-payment-desktop.png)

### Đặt bàn

![Quản lý đặt bàn CAS trên desktop](docs/screenshots/07-reservations-desktop.png)

<p align="center">
  <img src="docs/screenshots/08-reservations-mobile.png" alt="Quản lý đặt bàn CAS trên mobile" width="390" />
</p>

</details>

## Tính năng chính

- **Vận hành bàn:** một màn hình thống nhất để tìm/lọc bàn, xem lưới hoặc sơ đồ khu vực, gọi món, gọi thêm và theo dõi trạng thái bếp/đã thanh toán.
- **Đặt bàn:** chọn giờ theo mốc 15 phút, kiểm tra sức chứa và chồng/sát lịch trong transaction; hỗ trợ `booked`, `seated`, `completed`, `cancelled` và `no_show`.
- **Order theo lượt:** `active_orders` giữ bill tổng hợp, còn mỗi lần gọi tạo một `order_batch` FIFO riêng để sửa, in và điều phối bếp.
- **Hạn mức món theo ngày:** giữ số phần khi gửi bếp, cập nhật chênh lệch khi sửa phiếu chờ, hoàn khi hủy order toàn `waiting` và tự dùng bucket mới theo `BUSINESS_TIME_ZONE`.
- **Bếp:** FIFO, giới hạn số batch nấu song song, tự động/thủ công/tạm dừng, ETA chỉ dùng cảnh báo; bếp xác nhận hoàn tất và phục vụ xác nhận đã mang món bằng `batchId/version`.
- **ETA tin cậy:** backend tính từ catalog MySQL theo `cookMinutes × quantity`; timer giao diện hiệu chỉnh bằng `serverNow`.
- **Thanh toán:** tiền mặt và ghi nhận nội bộ phương thức thẻ/QR; trả sau khi món đã phục vụ sẽ đóng bàn, trả trước giữ queue và bàn đến khi nhân viên xác nhận khách rời.
- **In ấn:** phiếu bếp 80 mm riêng cho từng lượt gọi; hóa đơn thanh toán hỗ trợ A4 và cuộn nhiệt 80 mm, có thể mở/in lại từ lịch sử.
- **Bảo mật vận hành:** session cookie `HttpOnly/Secure/SameSite`, thời hạn phiên, giới hạn đăng nhập sai theo IP và RBAC `manager/cashier/server/chef`.
- **Quản trị:** bàn/khu vực, thực đơn, hạn mức ngày, thời gian nấu, nhân viên/ca, cấu hình bếp và thương hiệu.
- **Báo cáo:** Ngày–Tuần–Tháng theo kỳ lịch sử, KPI, phương thức, món, danh mục và nhân viên từ hóa đơn đã thanh toán.
- **Đa thiết bị và responsive:** polling có timeout, dừng khi tab ẩn, Browser Back/Forward cho các bước chính, touch target 44 px và hỗ trợ `prefers-reduced-motion`.

## Công thức ETA

Với mỗi dòng giỏ hàng:

```text
ETA dòng món = thời gian nấu một phần × số lượng
ETA order     = max(ETA của các dòng món)
```

Ví dụ:

```text
Phở bò: 12 phút × 3 = 36 phút
Gà nướng: 25 phút × 2 = 50 phút
ETA order = max(36, 50) = 50 phút
```

Công thức giả định các loại món khác nhau có thể được chế biến song song, nhưng nhiều phần giống nhau trên cùng một dòng cần thêm thời gian tuyến tính. Frontend chỉ hiển thị preview; backend tính lại ETA từ catalog MySQL và số lượng đã validation.

## Kiến trúc

```mermaid
flowchart LR
  U[Trình duyệt POS] -->|HTTPS + session cookie| A[Express API]
  A -->|Pool / transaction| D[(MySQL 8)]
  A --> C[Catalog validation]
  A --> Q[Kitchen FIFO theo order batch]
  A --> R[Reservation + availability]
  A --> P[Payment + report service]
  A --> L[Structured log + audit_events]
  Q --> D
  R --> D
  P --> D
  D -->|Snapshot operations| A
  A -->|Bàn + order tổng hợp + từng lượt queue| U
```

Các nguyên tắc chính:

1. MySQL là nguồn sự thật; UI polling snapshot `/api/operations` mỗi 3 giây.
2. `active_orders` giữ giỏ hàng tổng hợp của bàn; `order_batches` giữ từng lượt gọi độc lập để điều phối và in phiếu bếp.
3. Những thao tác thay đổi order, queue hoặc payment đều khóa dữ liệu cần thiết bằng transaction InnoDB.
4. Queue được đồng bộ bằng khóa `kitchen_queue_state FOR UPDATE`, không phụ thuộc state trong RAM của một API instance.
5. Toàn bộ timestamp queue và đặt bàn được lưu, so sánh theo UTC; `/api/operations` trả thêm `serverNow` để UI hiệu chỉnh đồng hồ hiển thị.
6. Giá, tùy chọn món, tổng thanh toán và ETA đều được backend tính lại.
7. Lịch đặt bàn chống chồng lấn bằng validation, index và khóa transaction; lịch tương lai chỉ xuất hiện dưới dạng `nextReservation`, không chiếm bàn cả ngày.
8. `/api/operations` đọc bàn/order/batch/config/đặt bàn gần nhất trong một repeatable-read snapshot duy nhất.
9. Thanh toán trước được liên kết 1–1 với active order qua `active_order_payments`; hóa đơn đã chốt không thay đổi trong khi queue bếp tiếp tục hoàn tất các batch còn lại.
10. Hạn mức món được khóa theo cặp `(menu_item_id, business_date)` trong cùng transaction tạo/sửa/hủy order. Cách khóa theo thứ tự ngày và id ngăn hai máy POS cùng bán phần cuối; `/api/operations` đồng bộ phần còn lại giữa các thiết bị mà không phải tải lại toàn bộ catalog.
11. Mỗi request có `X-Request-Id` và log JSON; mutation thành công được ghi vào `audit_events` với tài khoản, vai trò, action và entity nhưng không sao chép body nhạy cảm.

## Cấu trúc thư mục

```text
Restaurant_CASv2/
├─ apps/
│  ├─ api/
│  │  ├─ src/
│  │  │  ├─ server.js            # HTTP, endpoint và transaction orchestration
│  │  │  ├─ auth.js              # Session cookie, tài khoản môi trường, RBAC và rate limit
│  │  │  ├─ logger.js            # Request ID và structured JSON logging
│  │  │  ├─ db.js                # Pool, bootstrap schema và migration tương thích
│  │  │  ├─ domain.js            # Validation order/settings và công thức payment
│  │  │  ├─ catalog.js           # Catalog, canonicalization và ETA
│  │  │  ├─ dailyInventory.js     # Hạn mức món theo ngày, giữ/hoàn số phần trong transaction
│  │  │  ├─ kitchenQueue.js      # Điều phối FIFO có khóa database
│  │  │  ├─ reservation.js       # Chuẩn hóa, overlap và vòng đời đặt bàn
│  │  │  ├─ orderPolicy.js       # Quy tắc hủy order và thanh toán theo batch
│  │  │  └─ defaultSettings.js
│  │  ├─ scripts/
│  │  │  ├─ smoke.mjs            # Smoke test qua API + MySQL thật
│  │  │  ├─ seed-test-data.mjs   # Dữ liệu demo idempotent cho dev/test
│  │  │  └─ audit-db.mjs         # Audit toàn vẹn 33 nhóm ở chế độ READ ONLY
│  │  └─ test/                    # Unit test nghiệp vụ
│  └─ web/
│     ├─ public/brand/            # Asset được Vite phục vụ trực tiếp
│     └─ src/
│        ├─ app/App.tsx           # Điều phối state, polling và navigation
│        ├─ app/data.ts           # Type, seed catalog và helper giỏ hàng
│        ├─ app/reporting.ts      # Dựng timeline giờ/ngày/tuần và báo cáo nhân viên
│        ├─ app/services/api.ts   # HTTP client có auth, timeout và chuẩn hóa lỗi
│        ├─ app/config/           # Brand/settings dùng chung
│        ├─ app/components/       # Màn hình nghiệp vụ
│        │  ├─ ReservationsPage.tsx # Quản lý lịch đặt bàn và check-in
│        │  └─ payment/           # Khối lịch sử/chi tiết tách khỏi PaymentPage
│        └─ styles/                # Theme, responsive và hiệu ứng
├─ e2e/                            # Chromium E2E và script chụp ảnh README
├─ .github/workflows/ci.yml        # Quality gate trên MySQL cô lập
├─ eslint.config.mjs               # Lint JavaScript/TypeScript/React
├─ playwright.config.ts            # Cấu hình browser E2E
├─ database/schema.sql            # Schema bootstrap thủ công
├─ docs/screenshots/              # Ảnh thật dùng trong README
├─ assets/brand/                   # Asset thương hiệu gốc/chất lượng nguồn
├─ assets/invoice-template-source/ # Bản nguồn tham khảo của mẫu hóa đơn
├─ package.json                    # npm workspaces
└─ README.md
```

### Quy ước source

- `apps/api` và `apps/web` là hai workspace backend/frontend độc lập.
- Module API được tách theo nghiệp vụ (`catalog`, `dailyInventory`, `kitchenQueue`, `reservation`, `orderPolicy`); `server.js` chỉ điều phối HTTP và transaction.
- `assets/brand` chứa nguồn thương hiệu; `apps/web/public/brand` chứa bản được Vite phục vụ runtime.
- Khi component vượt quá một feature rõ ràng, ưu tiên tách theo feature thay vì tạo thư mục tiện ích chung không có chủ sở hữu.

## Cấu hình môi trường

### Yêu cầu

- Node.js `>= 24.15.0`
- npm `11.x`; phiên bản khai báo trong repository là `11.13.0`
- MySQL `8.x`
- Windows, macOS hoặc Linux

### Cài đặt chi tiết

Tại thư mục gốc:

```powershell
npm install
Copy-Item apps/api/.env.example apps/api/.env
Copy-Item apps/web/.env.example apps/web/.env
```

Chỉnh `apps/api/.env` trước khi chạy. Không commit `.env`; các file này đã nằm trong `.gitignore`.

### Biến môi trường API

| Biến | Mặc định mẫu | Ý nghĩa |
|---|---:|---|
| `NODE_ENV` | `development` khi không đặt | Dùng `production` khi deploy; production bắt buộc cấu hình auth và mặc định không tự migrate |
| `PORT` | `4100` | Cổng API |
| `HOST` | `0.0.0.0` | Cho phép máy khác trong LAN kết nối |
| `CORS_ORIGIN` | `http://localhost:5173` | Allowlist origin production, phân cách bằng dấu phẩy |
| `CORS_ALLOW_PRIVATE_NETWORK` | `true` | Chỉ development: cho localhost/IPv6/IP LAN riêng |
| `AUTH_USERNAME` | `admin` | Tài khoản tương thích cũ; được ánh xạ thành vai trò `manager` |
| `AUTH_PASSWORD` | bắt buộc đổi | Mật khẩu dài và ngẫu nhiên của tài khoản tương thích |
| `AUTH_USERS_JSON` | để trống | Danh sách `{ username, password, role }`; khi có sẽ thay cặp tài khoản tương thích |
| `AUTH_SESSION_SECRET` | bắt buộc production | Chuỗi ngẫu nhiên tối thiểu 32 ký tự dùng ký session cookie |
| `AUTH_SESSION_HOURS` | `8` | Thời hạn phiên, từ 1 giờ đến 30 ngày |
| `TRUST_PROXY` | để trống | Đặt `loopback` khi API chạy sau reverse proxy cùng máy; quyết định IP dùng cho rate limit/log |
| `KITCHEN_CONCURRENCY` | `2` | Công suất bếp khởi tạo |
| `KITCHEN_STALE_MINUTES` | `120` | Khoảng gia hạn sau ETA trước khi batch đang nấu được gắn cảnh báo quá hạn |
| `BUSINESS_TIME_ZONE` | `Asia/Ho_Chi_Minh` | Múi giờ xác định ngày kinh doanh và thời điểm đặt lại số phần món |
| `DB_HOST` | `127.0.0.1` | Máy chủ MySQL |
| `DB_PORT` | `3306` | Cổng MySQL |
| `DB_USER` | `root` | User MySQL local |
| `DB_PASSWORD` | bắt buộc đổi | Mật khẩu MySQL |
| `DB_NAME` | `restaurant_casv2` | Tên database |
| `DB_AUTO_MIGRATE` | `true` | Tự bootstrap/migrate khi phát triển |
| `DB_CONNECTION_LIMIT` | `10` | Số connection tối đa trong pool |
| `DB_QUEUE_LIMIT` | `100` | Số request chờ connection |
| `DB_CONNECT_TIMEOUT_MS` | `10000` | Timeout mở kết nối MySQL, tính bằng mili giây |
| `LEGACY_TIMEZONE_OFFSET_MINUTES` | `420` | Chỉ dùng một lần khi đổi timestamp legacy sang UTC |

Đặt cùng một `BUSINESS_TIME_ZONE` cho mọi API instance của nhà hàng. Ngày kinh doanh được tính ở backend theo biến này, không theo múi giờ của máy POS hoặc MySQL session; mỗi ngày có một dòng usage riêng nên không cần tiến trình reset chạy lúc nửa đêm.

`AUTH_USERS_JSON` hỗ trợ các vai trò `manager`, `cashier`, `server`, `chef`. Ví dụ:

```json
[
  { "username": "quanly", "password": "mat-khau-dai-ngau-nhien", "role": "manager" },
  { "username": "thungan", "password": "mat-khau-dai-ngau-nhien", "role": "cashier" }
]
```

Trong production hãy cấp JSON và secret bằng secret manager, không ghi trực tiếp vào repository.

### Biến môi trường web

| Biến | Giá trị | Ý nghĩa |
|---|---|---|
| `VITE_API_BASE_URL` | để trống | Dùng `/api` cùng domain hoặc Vite proxy |
| `VITE_DEV_API_TARGET` | `http://127.0.0.1:4100` | Đích proxy dev; cấu hình hiện đọc từ environment của tiến trình Vite, vì vậy hãy export/set biến trước khi chạy nếu cần đổi |

## Database và quan hệ dữ liệu

### Migration

`db:migrate` là lệnh chuẩn cho cả database mới và database đang nâng cấp. Hãy backup trước khi chạy trên môi trường có dữ liệu thật; migration có thể chuẩn hóa dữ liệu và loại bỏ cột legacy không còn dùng.

```powershell
npm run db:migrate
```

`db:schema` chỉ bootstrap thủ công một database **mới** tên `restaurant_casv2` bằng MySQL CLI:

```powershell
npm run db:schema
```

Lệnh này hỏi mật khẩu tương tác và không đặt mật khẩu trên command line. Do `schema.sql` dùng `CREATE TABLE IF NOT EXISTS`, nó không thay thế migration/backfill cho database hiện hữu và không tôn trọng `DB_NAME` tùy chỉnh.

### Backup và restore drill an toàn

Repository có cặp công cụ backup/khôi phục để kiểm chứng trước khi migration. Máy chạy lệnh cần có MySQL 8 CLI (`mysqldump` và `mysql`) trong `PATH`, hoặc truyền đường dẫn executable bằng tham số như ví dụ Windows bên dưới. Công cụ đọc kết nối từ `apps/api/.env` hoặc các biến `DB_*`; mật khẩu chỉ được truyền qua environment của child process, không xuất hiện trong command line.

Tạo thư mục backup **ngoài repository**, giới hạn quyền truy cập, rồi tạo một file mới:

```powershell
$backupDirectory = Join-Path $env:USERPROFILE 'RestaurantCASBackups'
New-Item -ItemType Directory -Force -Path $backupDirectory
$backupFile = Join-Path $backupDirectory "restaurant_casv2-$(Get-Date -Format 'yyyyMMdd-HHmmss').sql"
npm run db:backup -- --output $backupFile
```

Nếu MySQL 8 trên Windows chưa có trong `PATH`:

```powershell
$mysqldump = 'C:\Program Files\MySQL\MySQL Server 8.0\bin\mysqldump.exe'
npm run db:backup -- --output $backupFile --mysqldump-bin $mysqldump
```

```bash
mkdir -p "$HOME/restaurant-cas-backups"
chmod 700 "$HOME/restaurant-cas-backups"
npm run db:backup -- --output "$HOME/restaurant-cas-backups/restaurant_casv2-20260803-120000.sql"
```

Lệnh backup dùng snapshot `--single-transaction`, không khóa bảng InnoDB và không ghi database nguồn. Nó không ghi đè file đã tồn tại, đồng thời tạo file SHA-256 cạnh dump, ví dụ `restaurant_casv2-20260803-120000.sql.sha256`. Phải lưu cả hai file. Ứng dụng hiện không dùng stored routine, event hoặc trigger, nên công cụ cố ý loại các object có thể thực thi này và chỉ sao lưu schema + dữ liệu ứng dụng.

Có thể kiểm tra tham số mà không kết nối MySQL hoặc tạo file:

```powershell
npm run db:backup -- --output C:\Backups\restaurant-casv2-check.sql --dry-run
```

Định kỳ khôi phục vào một database drill **mới, riêng biệt**. Tên đích bắt buộc chứa từ `restore_drill`, không được trùng `DB_NAME`/database nguồn và không được tồn tại trước đó:

```powershell
npm run db:restore:drill -- --backup $backupFile --target-db restaurant_casv2_restore_drill_20260803
```

Trên Windows có thể chỉ rõ MySQL client:

```powershell
$mysql = 'C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe'
npm run db:restore:drill -- --backup $backupFile --target-db restaurant_casv2_restore_drill_20260803 --mysql-bin $mysql
```

```bash
npm run db:restore:drill -- \
  --backup "$HOME/restaurant-cas-backups/restaurant_casv2-20260803-120000.sql" \
  --target-db restaurant_casv2_restore_drill_20260803
```

Chỉ restore file do chính `db:backup` tạo, giữ cả dump/checksum trong thư mục NTFS riêng tư (và mã hóa ổ đĩa nếu có dữ liệu thật); checksum phát hiện file bị thay đổi nhưng không thay thế chữ ký số. Nếu user runtime không có quyền `CREATE DATABASE`, cấp riêng `RESTORE_DB_USER` và `RESTORE_DB_PASSWORD` qua secret của terminal/CI. Ưu tiên một MySQL staging tách biệt hoặc tài khoản drill có quyền tối thiểu; không dùng tài khoản production đặc quyền để nhập dump không tin cậy. Có thể dùng `RESTORE_DB_HOST` và `RESTORE_DB_PORT` cho máy staging. Script kiểm tra checksum, chặn thêm các lệnh cấp database/tài khoản/server và tham chiếu ghi chéo database phổ biến, từ chối mọi database đích đã tồn tại, tạo database drill đúng một lần, restore rồi tự chạy `db:audit` ở chế độ READ ONLY. Các kiểm tra văn bản là lớp phòng vệ bổ sung, không phải SQL sandbox. Script **không bao giờ chạy `DROP DATABASE`** và để database drill lại cho DBA kiểm tra/xóa thủ công sau đó.

Kiểm tra toàn bộ file và kế hoạch mà không kết nối hoặc restore:

```powershell
npm run db:restore:drill -- --backup $backupFile --target-db restaurant_casv2_restore_drill_check --dry-run
```

Đây chỉ là tooling theo yêu cầu, **không phải lịch backup tự động** và không tự xóa bản cũ. Chính sách tối thiểu đề xuất là backup hằng ngày, backup riêng trước mọi migration, giữ 7 bản ngày + 4 bản tuần + 6 bản tháng, mã hóa và sao chép sang thiết bị/vị trí khác. Với backup hằng ngày, RPO tốt nhất chỉ là tối đa khoảng 24 giờ; nếu nghiệp vụ chấp nhận mất tối đa 15 phút dữ liệu thì phải bổ sung backup/binlog liên tục tương ứng. Chạy restore drill ít nhất mỗi tháng và ghi nhận thời gian thực tế làm RTO thay vì chỉ tuyên bố một con số chưa kiểm chứng.

### Nạp dữ liệu đầy đủ để test

```powershell
npm run db:seed:test
```

Script chỉ làm mới dữ liệu sở hữu bởi tiền tố `demo-` và có thể chạy lại nhiều lần. Tuy vậy, đây vẫn là script ghi dữ liệu: chỉ dùng trên development/staging hoặc một database test riêng, không chạy trên production.

| Dữ liệu mẫu | Nội dung |
|---|---|
| Bàn `101–108` | Bàn trống và bàn có order ở nhiều trạng thái; lịch đặt được lưu riêng, không giả lập bằng trạng thái bàn |
| Đặt bàn | Lịch demo đủ các trạng thái `booked`, `seated`, `completed`, `cancelled`, `no_show`, gồm lịch sắp tới để test `nextReservation` |
| Order | 5 order đang mở, 7 batch, gồm 2 bàn có lượt gọi thêm |
| Queue | ETA tính từ `cookMinutes × quantity`, gồm batch chờ, đã xong và lượt gọi thêm |
| Thanh toán | 6 hóa đơn gần thời điểm hiện tại, đủ tiền mặt, thẻ và QR |
| Nhân viên | 3 nhân viên phục vụ demo theo các ca khác nhau; hóa đơn được gán nhân viên |
| Catalog | Nhóm `Món demo số lượng` có 8 món không giới hạn cho các luồng order, một món giới hạn 20 phần/còn 6 và một món giới hạn 8 phần/đã hết để kiểm thử UI còn hàng–hết hàng |

### Quan hệ dữ liệu

```mermaid
erDiagram
  RESTAURANT_TABLES ||--o| ACTIVE_ORDERS : "có order mở"
  RESTAURANT_TABLES o|--o{ RESERVATIONS : "được gán bàn"
  RESERVATIONS o|--o| ACTIVE_ORDERS : "check-in liên kết"
  RESERVATIONS o|--o{ PAYMENT_TRANSACTIONS : "được snapshot khi trả"
  ACTIVE_ORDERS ||--|{ ORDER_BATCHES : "gồm các lượt gọi (*)"
  ACTIVE_ORDERS ||--o| ACTIVE_ORDER_PAYMENTS : "liên kết khi trả trước"
  PAYMENT_TRANSACTIONS ||--o| ACTIVE_ORDER_PAYMENTS : "giữ hóa đơn của order mở"
  MENU_CATEGORIES ||--o{ MENU_ITEMS : "phân loại"
  MENU_ITEMS ||--o{ MENU_ITEM_DAILY_USAGE : "ghi nhận theo ngày"
  EMPLOYEES o|--o{ PAYMENT_TRANSACTIONS : "phục vụ"
  PAYMENT_TRANSACTIONS ||--|{ PAYMENT_ITEMS : "gồm (*)"
```

`(*)` biểu thị invariant 1..n do transaction API và `db:audit` duy trì; bản thân FK chỉ ngăn child mồ côi. `restaurant_settings` và `kitchen_queue_state` là hai singleton độc lập với `id=1`, không có self-reference.

| Bảng | Vai trò | Ràng buộc/index đáng chú ý |
|---|---|---|
| `restaurant_tables` | Số bàn, ghế, trạng thái, khu vực và tọa độ `X/Y` dùng dựng sơ đồ mặt bằng | PK `id`, unique `table_number`, index `status`; `X/Y` cùng để trống hoặc trong `1..24`, unique `(area, position_x, position_y)` chống hai bàn trùng ô |
| `reservations` | Khách, điện thoại chuẩn hóa, số khách, bàn, thời điểm bắt đầu/kết thúc và vòng đời đặt bàn | FK bàn, unique marker `seated_table_id` bảo đảm tối đa một lịch đang nhận khách/bàn, CHECK thời lượng/vòng đời, `version` optimistic và index lịch |
| `active_orders` | Giỏ hàng tổng hợp đang mở của mỗi bàn, dùng khi thanh toán | unique `table_id`, optional unique `reservation_id`, FK bàn/đặt bàn; xóa order sẽ cascade các batch |
| `order_batches` | Từng lượt gọi/gọi thêm và trạng thái bếp riêng | unique `(order_id, batch_number)`, index FIFO `(status, queued_at, id)`; `inventory_date` cố định bucket ngày đã giữ số phần |
| `kitchen_queue_state` | Công suất/chế độ queue và phiên bản cấu hình | Một hàng `id=1`, `version` optimistic, khóa bằng `FOR UPDATE` |
| `menu_categories` | Danh mục món | PK `id`, thứ tự và trạng thái active |
| `menu_items` | Giá, ETA, size, topping và hạn mức số phần/ngày | FK category, index category/available; `daily_limit` nullable, `NULL` nghĩa là không giới hạn |
| `menu_item_daily_usage` | Số phần đã giữ của từng món theo ngày kinh doanh | PK `(menu_item_id, business_date)`, FK món `ON DELETE CASCADE`, index `(business_date, menu_item_id)` |
| `restaurant_settings` | Thương hiệu và hóa đơn | JSON, một hàng `id=1`; `version` optimistic chống hai quản lý ghi đè nhau |
| `employees` | Hồ sơ, vai trò, số điện thoại và ca làm | unique `employee_code`, soft deactivate |
| `payment_transactions` | Header hóa đơn đã trả, snapshot nhân viên/khách và trạng thái phục vụ sau thanh toán | unique `invoice_code`, `service_status` chỉ nhận `awaiting_departure/closed`, `departure_confirmed_at`, optional FK đặt bàn, index `paid_at/staff_id` và `(service_status, table_id)` |
| `active_order_payments` | Liên kết tạm hóa đơn trả trước với order vẫn đang phục vụ | PK/FK `order_id`, unique/FK `transaction_id`; một order và một hóa đơn chỉ có tối đa một liên kết |
| `payment_items` | Chi tiết món và snapshot danh mục đã thanh toán | FK transaction, index category, `ON DELETE CASCADE` |
| `schema_migrations` | Đánh dấu migration dữ liệu | PK migration id |

### Chính sách quan hệ và dữ liệu lịch sử

- `reservations.table_id` dùng `ON DELETE SET NULL`; `table_number` vẫn giữ snapshot để lịch sử còn đọc được sau khi bàn bị xóa.
- `active_orders → order_batches` và `payment_transactions → payment_items` dùng `ON DELETE CASCADE` vì child không có ý nghĩa độc lập. API chặn xóa bàn đang phục vụ hoặc còn lịch mở; không nên thao tác xóa trực tiếp bằng SQL.
- `active_order_payments` là quan hệ 1–1: xóa order sẽ xóa liên kết, còn xóa payment đang được liên kết bị `RESTRICT`.
- `payment_transactions.table_id/table_number` và `payment_items.menu_item_id/category_id` là snapshot lịch sử có chủ ý, không FK tới bàn/catalog để hóa đơn không hỏng khi cấu hình thay đổi.
- `reservations.seated_table_id` là unique marker, không phải FK. API và `db:audit` buộc nó bằng `table_id` khi trạng thái là `seated` và đặt `NULL` ở trạng thái khác.
- Chồng lịch không thể biểu diễn bằng FK/CHECK MySQL; API khóa hàng bàn bằng transaction khi kiểm tra khoảng thời gian, còn audit phát hiện mọi lịch mở bị giao nhau.

### Kết quả rà soát database

Ngày 03/08/2026, database MySQL `8.0.46` đạt toàn bộ `33/33` nhóm kiểm tra bắt buộc ở chế độ `READ ONLY`: không có bản ghi mồ côi, batch gắn sai bàn, order lệch tổng hợp, lịch mở chồng nhau, hóa đơn trả trước mất liên kết, sai vòng đời `waiting → cooking → done → served` hoặc ledger món thấp hơn số phần đang hoạt động. Trạng thái dữ liệu vận hành thay đổi theo thời gian, vì vậy hãy chạy lại `npm run db:audit` thay vì dựa vào snapshot này.

Các giới hạn cấu trúc đã biết nhưng **không gây corruption trong dữ liệu hiện tại**:

1. CHECK reservation chưa tự buộc `seated_table_id = table_id`; invariant này hiện do API và audit giữ.
2. Audit tự động so số dòng/ETA của `active_orders.items` với batch, chưa so toàn bộ nội dung từng option; lần rà soát này đã đối chiếu nội dung riêng và đạt.
3. `verifyDatabaseSchema()` khi `DB_AUTO_MIGRATE=false` chưa kiểm tra mọi FK/CHECK mà `db:audit` kiểm tra. Vì vậy deploy phải chạy cả `db:migrate` **và** `db:audit`.
4. `menu_item_daily_usage` là số tổng hợp theo ngày, chưa phải immutable movement ledger; phù hợp hạn mức thành phẩm nhưng chưa thay thế kiểm toán tồn kho nguyên liệu.

Script audit chỉ đọc, lấy tối đa tám mẫu cho mỗi loại vi phạm và trả exit code khác `0` nếu phát hiện lỗi.

## Chạy development

Mở hai terminal:

```powershell
npm run dev:api
```

```powershell
npm run dev:web
```

- Web: `http://localhost:5173`
- API health: `http://127.0.0.1:4100/api/health`

## Dùng trên điện thoại hoặc máy khác trong Wi-Fi

1. Chạy API và web như trên.
2. Dùng `ipconfig` để lấy IPv4 của máy chạy dự án.
3. Mở `http://<IPv4>:5173` trên thiết bị khác.
4. Cho phép Node.js qua Windows Firewall ở mạng Private nếu được hỏi.

Development cho phép `localhost`, `127.x`, IPv6 loopback, `10.x`, `192.168.x` và `172.16-31.x` khi `CORS_ALLOW_PRIVATE_NETWORK=true`. Production luôn yêu cầu origin nằm chính xác trong `CORS_ORIGIN`.

## Luồng nghiệp vụ

### Gọi món và queue bếp

1. Nhân viên tìm/lọc bàn trên màn **Vận hành bàn**, dùng lưới hoặc sơ đồ theo khu vực rồi mở cùng một modal thao tác. Client gửi danh sách món và số lượng; `append=false` tạo lượt đầu, `append=true` tạo lượt gọi thêm.
2. Backend validation giới hạn 1–100 dòng, mỗi dòng 1–99 phần.
3. Backend tải lại catalog theo id, thay toàn bộ giá/size/topping client bằng dữ liệu MySQL.
4. Trong cùng transaction gửi bếp, backend gộp số lượng theo `menuItem.id`, khóa bucket của ngày kinh doanh hiện tại và giữ số phần. Nếu không đủ, toàn bộ request rollback với `409 MENU_ITEM_DAILY_LIMIT_EXCEEDED`; hai máy POS không thể cùng nhận phần cuối.
5. Backend tính `ETA dòng = cookMinutes × quantity` và lấy dòng lâu nhất.
6. Backend nối món vào `active_orders` để giữ tổng bill và tạo một dòng `order_batches` chỉ chứa món của lượt mới; batch lưu `inventory_date` để mọi lần điều chỉnh dùng đúng bucket ngày.
7. Phiếu bếp của lượt mới có thể in riêng; batch được xếp cuối queue bằng `queued_at, id`.
8. Queue khóa `kitchen_queue_state`, đếm slot trống và lấy batch FIFO.
9. Batch được lấy chuyển `waiting → cooking` và ghi `cooking_started_at`; trạng thái bàn được suy ra từ tất cả batch của bàn.
10. ETA chỉ tạo cảnh báo quá thời gian; batch chỉ chuyển `cooking → done` khi bếp xác nhận món thực sự hoàn tất.
11. Queue tự lấy batch FIFO tiếp theo nếu đang ở chế độ tự động. `done` nghĩa là cần mang món; nhân viên phục vụ xác nhận `done → served`. Khi pause/manual, món đang nấu không tự hoàn tất và queue không tự lấy món mới.
12. Khi sửa, client gửi đúng `batchId`; transaction chỉ chấp nhận batch vẫn `waiting`, canonicalize lại món/ETA, điều chỉnh số phần theo chênh lệch và rebuild giỏ tổng từ toàn bộ batch. Nếu phiếu chờ được sửa sau khi đã sang ngày mới, phần cũ được trả về bucket cũ và nội dung mới được giữ ở bucket ngày hiện tại.
13. Hủy order chỉ hợp lệ khi tất cả batch còn `waiting`; transaction hoàn lại số phần đã giữ theo `inventory_date`. Batch đã `cooking`, `done` hoặc `served` không được hoàn hạn mức.
14. Trạng thái order không được ép qua CRUD bàn; mọi chuyển trạng thái phải đi qua action queue để không vượt công suất bếp.
15. Hoàn tất/đưa lại hàng chờ phải gửi đúng `expectedBatchId`; retry, bấm kép hoặc client dùng snapshot cũ không thể tác động nhầm phiếu kế tiếp.
16. Cấu hình bếp được cập nhật từng phần bằng `PATCH` kèm `expectedVersion`; backend khóa singleton và trả `409` nếu máy POS đang dùng phiên bản cũ, tránh ghi đè công suất/chế độ vừa được máy khác thay đổi.
17. Mỗi snapshot trả `serverNow`; frontend dùng đồng hồ server đã hiệu chỉnh cho timer. API chỉ dùng ETA và `KITCHEN_STALE_MINUTES` để đánh dấu gần trễ/quá hạn; polling giữ nhịp 3 giây và không tự đổi `cooking → done`.

### Đặt bàn trước

1. Nhân viên nhập tên, điện thoại, số khách, ngày/giờ, thời lượng 30–480 phút, bàn và ghi chú; giao diện chỉ đề xuất bàn đủ sức chứa và còn trống trong toàn bộ khoảng thời gian.
2. `POST /api/reservations` chuẩn hóa điện thoại, tính `ends_at` và kiểm tra overlap trong transaction. Hai máy đặt cùng một bàn/khung giờ đồng thời không thể cùng thành công.
3. Chỉ lịch `booked` được sửa; client gửi `expectedVersion`, vì vậy bản ghi cũ nhận `409` thay vì ghi đè thay đổi mới hơn.
4. Vòng đời hợp lệ là `booked → seated → completed` hoặc `booked → cancelled/no_show`. Check-in được phép sớm tối đa 60 phút; đánh dấu `no_show` sau 15 phút kể từ giờ hẹn.
5. Check-in chuyển lịch sang `seated`, mở đúng bàn để gọi món và liên kết `reservation_id` với active order. Không thể hoàn tất lịch `seated` khi bàn vẫn còn order mở.
6. Thanh toán luôn lưu snapshot mã đặt bàn, tên khách và số khách vào hóa đơn. Nếu trả sau khi mọi món đã được phục vụ (`served`), lịch `seated` hoàn tất ngay; nếu trả trước, lịch vẫn giữ `seated` cho đến khi món được mang ra và nhân viên xác nhận khách đã rời.
7. Lịch tương lai chỉ hiển thị trên thẻ bàn bằng `nextReservation`. Bàn chỉ được giữ khi khách đã `seated` hoặc lịch `booked` còn không quá 15 phút; lịch buổi tối không khóa bàn từ đầu ngày.
8. Phạm vi **Cần xử lý** liệt kê lịch `booked` đã qua giờ kết thúc để nhân viên xác nhận `no_show` hoặc hủy; hệ thống không tự đóng lịch và không tự thay đổi dữ liệu khách.

### Thanh toán

1. Client bật thanh toán cho mọi bàn có active order chưa trả tiền, kể cả khi batch còn `waiting` hoặc `cooking`; nhân viên chọn người phục vụ và client giữ ổn định mã idempotency trong mọi lần retry.
2. Backend kiểm tra giao dịch cùng mã đã tồn tại trước khi yêu cầu active order; retry sau timeout nhận lại kết quả cũ.
3. Backend khóa bàn/order/batch, từ chối order đã có hóa đơn và xác định có cần giữ bàn hay không. Cờ `payment.keepTableOpen` giữ nguyên ý định trả trước nếu bếp vừa hoàn tất trong lúc màn thanh toán đang mở.
4. Backend xác thực nhân viên còn hoạt động đúng vai trò Phục vụ, đọc settings và tính subtotal, discount, service fee, VAT, total.
5. Tất cả món từ mọi lượt gọi được ghi vào cùng header; item lưu snapshot danh mục để báo cáo lịch sử không đổi theo catalog. Nếu order đến từ đặt bàn, header đồng thời lưu snapshot khách và lịch đặt.
6. **Trả sau:** nếu mọi batch đã `served` và không yêu cầu giữ bàn, giao dịch nhận `service_status=closed`; active order bị xóa, lịch `seated` liên quan chuyển `completed` và bàn về `empty` trong cùng transaction.
7. **Trả trước:** khi còn batch `waiting/cooking`, hoặc client đã mở luồng trả trước với `keepTableOpen=true`, giao dịch nhận `service_status=awaiting_departure` và được liên kết với active order trong `active_order_payments`. Bàn tiếp tục ở trạng thái bếp thực tế, queue vẫn chạy, UI hiển thị **Đã thanh toán** và backend khóa gọi thêm, sửa hoặc hủy order.
8. Khi bếp xác nhận `done`, nhân viên phục vụ gọi `POST /api/orders/:tableId/serve-ready` để ghi nhận món đã được mang ra. Chỉ khi tất cả batch đã `served`, nhân viên mới gọi `POST /api/orders/:tableId/confirm-departure`; backend đổi giao dịch sang `closed`, ghi `departure_confirmed_at`, hoàn tất lịch `seated`, xóa active order và đưa bàn về `empty`. Cả hai action đều kiểm tra snapshot để chống bấm kép và xử lý đồng thời.
9. Response thanh toán trả `requiresDepartureConfirmation` và `orderClosed` để UI phân biệt hai nhánh. Chỉ sau khi transaction thanh toán commit thành công frontend mới tải snapshot chính thức từ `GET /api/payments/:invoiceCode`, cho in hóa đơn A4 hoặc 80 mm và giữ bản local làm fallback nếu lần tải chi tiết tạm thời thất bại.

### Báo cáo

| Kỳ | Khoảng dữ liệu | Trục hoành | Ví dụ nhãn |
|---|---|---|---|
| `Ngày` | 00:00–24:00 của ngày được chọn | 24 giờ | `00h`, `08h`, `16h`, `23h` |
| `Tuần` | Thứ Hai–Chủ nhật của tuần được chọn | 7 ngày | `T2 13/07`, `T3 14/07`, … |
| `Tháng` | Ngày đầu–cuối tháng được chọn | 4–6 tuần lịch, cắt đúng biên tháng | `01–05/07`, `06–12/07`, … |

- Người dùng chọn `Ngày`, `Tuần` hoặc `Tháng`, sau đó chọn trực tiếp một ngày/tuần/tháng lịch sử bất kỳ; các nút kỳ trước, kỳ sau và kỳ hiện tại hỗ trợ tra cứu nhanh. Tiêu đề luôn hiển thị rõ ngày đơn, khoảng đầu–cuối tuần hoặc tháng đang được tổng hợp.
- Mỗi lựa chọn gửi đúng biên `from/to` của kỳ đang chọn tới API, không phụ thuộc ngày hiện tại.
- Bucket tương lai để trống thay vì ghi `0`; tooltip luôn hiển thị đầy đủ giờ/ngày hoặc khoảng tuần và tên chỉ số tiếng Việt.
- Frontend gửi biên ngày địa phương dưới dạng UTC và `timezoneOffsetMinutes` để bucket giờ/ngày đúng múi giờ thiết bị POS.
- API trả đồng thời `hourly[]` và `daily[]` được aggregate trực tiếp từ `payment_transactions`; frontend zero-fill các mốc đã qua và gom `daily[]` thành tuần lịch cho kỳ Tháng.
- Tổng doanh thu/số hóa đơn của `daily[]` được smoke test đối chiếu với KPI; báo cáo không phụ thuộc danh sách payment giới hạn hoặc order đang mở.
- Danh mục/món dùng snapshot đã thanh toán; doanh thu nhân viên dùng header hóa đơn và `staff_id`.
- Biểu đồ Recharts chỉ được tải khi người dùng mở trang Báo cáo.
- Kỳ lịch sử đang xem được giữ nguyên khi trang mở xuyên nửa đêm; hệ thống không tự nhảy về hiện tại và làm mất ngữ cảnh tra cứu của nhân viên.

## API chính

Mọi endpoint `/api/*`, trừ health, login và logout, đều yêu cầu session cookie hợp lệ. Frontend không giữ mật khẩu trong Web Storage. Backend áp dụng quyền theo vai trò; tài khoản tương thích `AUTH_USERNAME/AUTH_PASSWORD` có vai trò `manager`.

| Method | Endpoint | Chức năng |
|---|---|---|
| `GET` | `/api/health` | Kiểm tra API/MySQL |
| `POST` | `/api/auth/login` | Xác thực và cấp session cookie |
| `POST` | `/api/auth/logout` | Thu hồi cookie trên trình duyệt |
| `GET` | `/api/auth/session` | Kiểm tra phiên và trả username/role |
| `GET/PUT` | `/api/settings` | Đọc/lưu cấu hình nhà hàng; PUT bắt buộc `expectedVersion`, bản cũ nhận `409 SETTINGS_CHANGED` |
| `GET/POST` | `/api/employees` | Danh sách hoặc tạo nhân viên |
| `PUT/DELETE` | `/api/employees/:employeeId` | Sửa hoặc ngừng hoạt động nhân viên |
| `GET` | `/api/reservations?from=&to=&status=&q=&tableId=` | Tìm/lọc lịch đặt bàn trong khoảng thời gian |
| `GET` | `/api/reservations/availability?reservedAt=&durationMinutes=&partySize=` | Tìm bàn đủ sức chứa và không chồng lịch |
| `POST` | `/api/reservations` | Tạo lịch `booked` sau khi khóa và kiểm tra overlap |
| `PUT` | `/api/reservations/:reservationId` | Sửa lịch còn `booked` với `expectedVersion` |
| `PATCH` | `/api/reservations/:reservationId/status` | Check-in, hoàn tất, hủy hoặc đánh dấu vắng mặt theo vòng đời hợp lệ |
| `GET` | `/api/catalog` | Lấy danh mục/món; mỗi món trả `dailyLimit`, `dailyUsed`, `dailyRemaining` và `inventoryDate` của ngày kinh doanh hiện tại |
| `POST` | `/api/catalog/bootstrap` | Seed catalog nếu database trống |
| `POST` | `/api/categories` | Tạo danh mục |
| `PUT/DELETE` | `/api/categories/:categoryId` | Sửa hoặc ngừng dùng danh mục |
| `POST` | `/api/menu-items` | Tạo món |
| `PUT/DELETE` | `/api/menu-items/:itemId` | Sửa/ngừng bán món và cấu hình `dailyLimit` (`null` = không giới hạn, `0..1000000` = hạn mức/ngày) |
| `GET` | `/api/operations` | Promote FIFO theo công suất rồi trả snapshot nhất quán gồm `serverNow`, bàn/`nextReservation`, order, batch, cảnh báo ETA, cấu hình bếp, thanh toán và `menuAvailability[]` |
| `PUT` | `/api/orders/:tableId` | Tạo lượt đầu hoặc gọi thêm với body `{ items, append }`; giữ số phần theo ngày trong transaction |
| `PUT` | `/api/orders/:tableId/batches/:batchId` | Sửa đúng một phiếu bếp còn chờ, không đổi FIFO và cập nhật chênh lệch số phần |
| `POST` | `/api/orders/:tableId/requeue` | Đưa đúng `expectedBatchId` đang nấu về cuối queue |
| `POST` | `/api/orders/:tableId/serve-ready` | Nhân viên phục vụ xác nhận chính xác danh sách batch `done` đã được mang ra bàn (`served`) |
| `DELETE` | `/api/orders/:tableId` | Hủy khi toàn bộ batch của order còn chờ và hoàn số phần theo bucket ngày của từng batch |
| `POST` | `/api/orders/:tableId/confirm-departure` | Xác nhận khách của order trả trước đã rời sau khi mọi batch `served`; đóng giao dịch/lịch đặt và giải phóng bàn, hỗ trợ retry idempotent |
| `PATCH/PUT` | `/api/kitchen/config` | Cập nhật công suất/chế độ/pause với `expectedVersion` |
| `POST` | `/api/kitchen/dispatch-next` | Lấy một order đầu queue |
| `POST` | `/api/tables` | Tạo bàn với số ghế, khu vực và tọa độ `positionX/positionY` |
| `PUT/DELETE` | `/api/tables/:tableId` | Sửa hoặc xóa bàn; trùng ô trong cùng khu vực trả `409 TABLE_POSITION_OCCUPIED` |
| `PATCH` | `/api/tables/:tableId/status` | Hoàn tất đúng `expectedBatchId` đang nấu; chống bấm lặp/client stale |
| `GET` | `/api/payments?from=&to=` | Giao dịch trong khoảng thời gian |
| `GET` | `/api/payments/:invoiceCode` | Tải snapshot hóa đơn và dòng món để xem/in lại |
| `POST` | `/api/payments` | Thanh toán active order ở trạng thái chờ/nấu/đã xong; hỗ trợ `payment.keepTableOpen`, idempotent theo invoice và trả `requiresDepartureConfirmation`, `orderClosed` |
| `GET` | `/api/reports/summary?from=&to=&timezoneOffsetMinutes=` | Aggregate KPI, `hourly[]`, `daily[]`, phương thức, món, danh mục và nhân viên |

## Scripts và kiểm thử

| Lệnh | Tác dụng |
|---|---|
| `npm run dev:api` | API với Node watch mode |
| `npm run dev:web` | Vite dev server trên `0.0.0.0` |
| `npm run start:api` | Chạy API không watch, dùng cho process manager production |
| `npm run db:migrate` | Bootstrap/migrate MySQL |
| `npm run db:schema` | Bootstrap thủ công database mới `restaurant_casv2`; không nâng cấp DB cũ |
| `npm run db:seed:test` | Ghi/làm mới dữ liệu demo trên database development/test |
| `npm run db:audit` | Kiểm tra 33 nhóm ràng buộc và toàn vẹn ở chế độ READ ONLY |
| `npm run db:backup -- --output <file.sql>` | Tạo dump nhất quán và file SHA-256 mới; không ghi/khóa bảng nguồn |
| `npm run db:restore:drill -- --backup <file.sql> --target-db <new_restore_drill_db>` | Restore vào database drill mới rồi chạy audit; từ chối database đã tồn tại |
| `npm run lint` | ESLint cho backend JavaScript và frontend TypeScript/React |
| `npm run typecheck` | TypeScript strict check |
| `npm test` | Unit test backend và frontend/a11y |
| `npm run test:e2e` | Chromium E2E cho đăng nhập/session, điều hướng RBAC và hàng chờ thanh toán |
| `npm run screenshots:update` | Chụp lại ảnh desktop/mobile trong `docs/screenshots` từ giao diện thật |
| `npm run test:smoke` | Test end-to-end qua API đang chạy; có ghi dữ liệu test |
| `npm run build` | Build frontend production |
| `npm run check` | Lint + typecheck + unit/a11y test + build |
| `npm audit --audit-level=moderate` | Audit toàn bộ dependency |

### Quality gates không ghi dữ liệu nghiệp vụ

```powershell
npm run check
npm run db:audit
npm audit --audit-level=moderate
```

`npm run check` gồm lint, typecheck, unit/a11y test và production build. `db:audit` chỉ đọc database. CI chạy thêm dependency audit, MySQL migration/audit, API smoke và Chromium E2E.

Phạm vi unit test hiện tại:

- `40/40` test backend và `10/10` test frontend/a11y đang đạt.
- Auth test bao phủ session cookie `HttpOnly/SameSite`, thời hạn phiên, cấu hình nhiều tài khoản và RBAC.
- Frontend test kiểm tra điều hướng theo vai trò và accessibility tự động của màn đăng nhập.
- Browser E2E kiểm tra semantics tab/filter, vùng chạm, responsive/overflow và xác nhận khách rời tại hàng chờ thanh toán.
- Canonicalization catalog và chống giả giá/topping.
- Validation category, menu, quantity, VAT và thời gian nấu.
- Hạn mức món theo ngày: xác định ngày kinh doanh, gộp số lượng cùng món, giữ đúng phần cuối, từ chối vượt mức, điều chỉnh khi sửa phiếu chờ và hoàn khi hủy.
- ETA theo số lượng và lấy dòng lâu nhất.
- Queue batch đủ slot, pause, manual và automatic.
- ETA chỉ dùng để cảnh báo; bếp phải xác nhận `cooking → done`, sau đó nhân viên phục vụ xác nhận `done → served` trước khi kết thúc lượt bàn.
- Queue không tự hoàn tất theo ETA; batch chỉ sang `done` khi bếp xác nhận và chỉ sang `served` khi nhân viên mang món ra bàn.
- Công thức payment và thời gian server.
- Validation nhân viên, vai trò, ca làm và mã nhân viên.
- Chuẩn hóa lịch đặt bàn, số điện thoại, thời lượng, sức chứa, phát hiện overlap và các chuyển trạng thái hợp lệ/không hợp lệ.
- Policy chỉ hủy order toàn-waiting; xác định đúng khi nào thanh toán cần giữ bàn, gồm trường hợp `keepTableOpen=true` cho tới khi mọi batch đã `served`.

### Smoke test API/MySQL

Smoke test tạo bàn, reservation, order, payment và tạm thay đổi cấu hình bếp. Cleanup khôi phục cấu hình và xóa dữ liệu có thể xóa, nhưng một phần lịch sử payment/reservation vẫn được giữ để kiểm tra báo cáo. **Chỉ chạy trên database test riêng; không chạy trên production.**

1. Chạy `npm run db:migrate` và bảo đảm catalog có dữ liệu, hoặc chạy `npm run db:seed:test`.
2. Mở API trong terminal riêng bằng `npm run dev:api`.
3. Chạy:

```powershell
$env:SMOKE_API_URL='http://127.0.0.1:4100/api'
npm run test:smoke
```

Trên macOS/Linux:

```bash
SMOKE_API_URL=http://127.0.0.1:4100/api npm run test:smoke
```

Smoke test bao phủ cạnh tranh đặt bàn, optimistic version bếp, FIFO/ETA, sửa phiếu chờ, hai request cùng giành phần cuối của món, thanh toán trước/sau, idempotency và đối chiếu báo cáo.

## Hiệu năng và giao diện

Kích thước từ `npm run build` ngày 30/07/2026; đây là số artifact, không phải SLA runtime:

| Artifact | Kích thước / gzip |
|---|---:|
| Main JS | `231,28 KB / 71,97 KB` |
| CSS dùng chung | `84,16 KB / 16,46 KB` |
| Chunk biểu đồ, chỉ tải khi mở Báo cáo | `395,08 KB / 108,86 KB` |
| Chunk Đặt bàn JS | `21,10 KB / 6,96 KB` |
| Chunk Đặt bàn CSS | `10,81 KB / 2,63 KB` |
| Chunk Thanh toán JS | `39,25 KB / 10,95 KB` |
| Chunk Thanh toán CSS | `20,98 KB / 4,45 KB` |

- Các trang nghiệp vụ lớn và Recharts được lazy-load; ảnh menu ngoài viewport dùng lazy decoding.
- Polling dừng khi tab ẩn, không cho request chồng nhau và timeout sau 12 giây.
- Snapshot `/api/operations` dùng repeatable-read transaction; queue và báo cáo có index tương ứng.
- Giao diện dùng grid responsive, touch target chính tối thiểu 44 px, portal cho modal và hỗ trợ `prefers-reduced-motion`.
- Phiếu bếp giữ khổ 80 mm; hóa đơn có hai định dạng A4 và cuộn nhiệt 80 mm.

Repository chưa có Lighthouse CI, benchmark tải hoặc SLA. Trước production cần đo lại trên URL deploy thật và thiết bị POS/máy in mục tiêu, gồm Lighthouse, WCAG contrast, bàn phím, CPU/RAM API và p95 dưới tải đồng thời.

## Triển khai production

Repository không kèm Dockerfile hoặc cấu hình cloud. Mô hình được hỗ trợ trực tiếp là: host tĩnh `apps/web/dist`, chạy API Node.js bằng process manager và dùng MySQL 8 riêng.

### 1. Chuẩn bị release

```bash
npm ci
npm run check
```

Tạo `apps/api/.env` bằng secret của môi trường deploy. Các giá trị tối thiểu cần rà soát:

```dotenv
NODE_ENV=production
HOST=127.0.0.1
PORT=4100
CORS_ORIGIN=https://pos.example.com
AUTH_USERNAME=replace-me
AUTH_PASSWORD=replace-with-a-long-random-secret
AUTH_SESSION_SECRET=replace-with-at-least-32-random-characters
AUTH_SESSION_HOURS=8
TRUST_PROXY=loopback
BUSINESS_TIME_ZONE=Asia/Ho_Chi_Minh
DB_HOST=private-mysql-host
DB_PORT=3306
DB_USER=restaurant_app
DB_PASSWORD=replace-me
DB_NAME=restaurant_casv2
DB_AUTO_MIGRATE=false
```

Không commit file này. `AUTH_PASSWORD`, `AUTH_USERS_JSON`, `AUTH_SESSION_SECRET` và tài khoản MySQL phải được cấp qua secret manager của hạ tầng.

### 2. Backup, migrate và audit

1. Tạo backup mới ở vùng lưu trữ ngoài repository:

```bash
npm run db:backup -- --output /var/backups/restaurant-cas/restaurant_casv2-20260803-120000.sql
```

2. Trước lần triển khai đầu tiên và định kỳ theo chính sách vận hành, xác minh file đó có thể restore vào database drill mới. Dùng tài khoản restore tách biệt có quyền `CREATE DATABASE`, không dùng database production làm đích:

```bash
npm run db:restore:drill -- \
  --backup /var/backups/restaurant-cas/restaurant_casv2-20260803-120000.sql \
  --target-db restaurant_casv2_restore_drill_20260803
```

3. Chỉ sau khi backup và drill đạt, chạy migration bằng user MySQL tạm thời có quyền DDL:

```bash
npm run db:migrate
npm run db:audit
```

4. Sau khi đạt audit, chạy API bằng user MySQL runtime quyền tối thiểu và giữ `DB_AUTO_MIGRATE=false`.

Không chạy `db:seed:test`, `test:smoke` hoặc restore drill với database production làm đích. Các script trên không tự lên lịch, mã hóa, chuyển backup sang máy khác hoặc áp dụng retention; hạ tầng vận hành phải cấu hình các phần đó riêng.

### 3. Build và phục vụ frontend

Cùng domain là cấu hình đơn giản nhất: để `VITE_API_BASE_URL` trống, sau đó chạy `npm run build` và phục vụ thư mục `apps/web/dist`. Static server phải fallback mọi route frontend về `index.html`.

Ví dụ Nginx tối thiểu:

```nginx
server {
  listen 443 ssl;
  server_name pos.example.com;
  root /srv/restaurant-cas/apps/web/dist;

  location / {
    try_files $uri $uri/ /index.html;
  }

  location /api/ {
    proxy_pass http://127.0.0.1:4100;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

Nếu frontend và API khác domain, đặt `VITE_API_BASE_URL=https://api.example.com/api` **trước lúc build** và thêm đúng origin frontend vào `CORS_ORIGIN`.

### 4. Chạy API và xác minh

Chạy API bằng systemd, PM2 hoặc process manager tương đương:

```bash
npm run start:api
```

Sau deploy, kiểm tra:

```text
GET https://pos.example.com/api/health  -> 200, { ok: true, database: "connected" }
```

Sau đó đăng nhập, thực hiện một luồng thử trên dữ liệu kiểm thử được kiểm soát và kiểm tra log/monitor. Giữ release frontend trước để rollback nhanh; thay đổi database hiện chưa có migration rollback tự động nên backup là bắt buộc.

## Giới hạn và việc cần làm trước production

Giới hạn hiện tại:

- Thanh toán thẻ/QR là ghi nhận nội bộ, chưa tích hợp terminal/callback đối soát, void hoặc hoàn tiền.
- Repository đã có CI, API smoke, frontend unit/a11y và Chromium E2E cơ bản nhưng chưa có Lighthouse CI, benchmark tải, Dockerfile/Compose hay cấu hình cloud cụ thể.
- Schema được mô tả ở cả `db.js` và `database/schema.sql`; thay đổi lớn có nguy cơ drift nếu không cập nhật đồng thời.
- Order/batch lưu item dạng JSON và hạn mức món dùng ledger tổng hợp; chưa có movement ledger bất biến hoặc tồn kho nguyên liệu.
- Frontend đồng bộ bằng polling 3 giây; chưa có offline queue hoặc cơ chế phục hồi khi mạng nội bộ mất lâu.
- Session hiện là token ký HMAC từ cấu hình môi trường; thay đổi/xóa tài khoản sẽ chặn phiên ở request tiếp theo, nhưng triển khai nhiều chi nhánh/public quy mô lớn nên chuyển sang OIDC hoặc identity store tập trung.

Ưu tiên bắt buộc trước khi mở ra Internet:

1. Tích hợp payment gateway/POS thật, idempotency key phía nhà cung cấp, callback xác minh, đối soát và quy trình hoàn tiền.
2. Dùng migration tool có version/rollback; lên lịch, mã hóa và lưu backup ngoài máy chủ, đồng thời vận hành restore drill định kỳ bằng tooling đã cung cấp.
3. Thiết lập log tập trung, metrics/cảnh báo, SLA và benchmark tải trên thiết bị/mạng POS thực tế.
4. Chạy Lighthouse/WCAG đầy đủ trên URL deploy và kiểm tra bản in A4/80 mm bằng máy in mục tiêu.
5. Cân nhắc OIDC/identity store tập trung nếu hệ thống mở ra Internet, chạy nhiều chi nhánh hoặc cần thu hồi phiên tức thời trên nhiều instance.

Mở rộng nghiệp vụ khi cần: chuẩn hóa `active_order_items`, tồn kho nguyên liệu/định mức, chuyển hoặc ghép bàn, tách/gộp hóa đơn, chia thanh toán, waitlist và SMS/Zalo nhắc lịch. Khi số client tăng, cân nhắc SSE/WebSocket; nếu POS phải chạy khi mất mạng, cần PWA/offline queue có chiến lược giải quyết xung đột.

## Bảo mật production

- Chạy API sau HTTPS/reverse proxy để cookie production luôn có thuộc tính `Secure`.
- Đặt `NODE_ENV=production`, password/secret qua secret manager.
- Production phải đặt allowlist `CORS_ORIGIN` cụ thể; không bật private-network wildcard.
- Đặt `TRUST_PROXY=loopback` khi reverse proxy chạy cùng máy; không dùng `true` nếu topology proxy chưa được kiểm soát.
- Chạy migration bằng user có quyền DDL, sau đó đặt `DB_AUTO_MIGRATE=false`.
- API runtime nên dùng MySQL user quyền tối thiểu.
- Thiết lập backup, restore drill, log tập trung và monitor `/api/health`.
- Giới hạn truy cập MySQL ở private network và bật firewall.

## Xử lý lỗi thường gặp

### Vite báo `proxy error` hoặc `ECONNREFUSED 127.0.0.1:4100`

Frontend đang chạy nhưng không kết nối được API tại đích proxy.

1. Mở terminal khác và chạy `npm run dev:api`.
2. Kiểm tra `http://127.0.0.1:4100/api/health` trả `200`.
3. Nếu API dùng port khác, set `VITE_DEV_API_TARGET` trong environment của tiến trình Vite rồi restart `npm run dev:web`.
4. Nếu API dừng vì MySQL, xử lý lỗi database trước; Vite chỉ chuyển tiếp request và không tự khởi động backend.

### `Origin không được phép`

- Development: kiểm tra `CORS_ALLOW_PRIVATE_NETWORK=true`, restart API và chắc chắn origin thuộc localhost/IP LAN riêng.
- Production: thêm chính xác protocol, host và port frontend vào `CORS_ORIGIN`, ví dụ `https://pos.example.com`.
- Nếu dùng Vite proxy và `VITE_API_BASE_URL` để trống, trình duyệt chỉ gọi cùng origin `/api`, thường không cần CORS trực tiếp.

### API trả `503 DATABASE_UNAVAILABLE`

- Kiểm tra MySQL đang chạy.
- Kiểm tra `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`.
- Chạy `npm run db:migrate` và xem log API.

### Đăng nhập luôn thất bại

- Kiểm tra `AUTH_USERS_JSON` hoặc `AUTH_USERNAME`, `AUTH_PASSWORD` trong `apps/api/.env`.
- Production phải có `AUTH_SESSION_SECRET` dài tối thiểu 32 ký tự và truy cập qua HTTPS.
- Restart API sau khi đổi `.env`.
- Session nằm trong cookie `HttpOnly`; không thể đọc từ JavaScript. Nếu đổi secret hoặc tài khoản, hãy đăng nhập lại.

### Điện thoại không mở được web

- Dùng IPv4 của máy chạy Vite, không dùng `localhost` trên điện thoại.
- Cả hai thiết bị phải cùng mạng.
- Cho phép Node.js qua firewall mạng Private.

## Quy trình đóng góp

- Tạo thay đổi nhỏ, tách biệt và không commit `.env`, secret hoặc dữ liệu production.
- Mọi thay đổi schema phải cập nhật đồng thời `database/schema.sql`, migration idempotent trong `apps/api/src/db.js`, `audit-db.mjs`, test liên quan và phần database của README.
- Trước khi bàn giao, chạy `npm run check` và `npm run db:audit`. Chỉ chạy smoke trên database test riêng.
- Không sửa trạng thái order, queue, ledger hoặc payment trực tiếp bằng SQL; đi qua API transaction để giữ invariant liên bảng.

## Giấy phép

Repository hiện chưa có file `LICENSE`; mặc định đây là mã nguồn nội bộ, không tự động được cấp phép như MIT/Apache. Chủ dự án cần chọn và bổ sung giấy phép trước khi phân phối công khai.

## Credits

- Asset thương hiệu CAS nằm trong `assets/brand`.
- Ảnh món mẫu dùng nguồn Unsplash; xem [ATTRIBUTIONS.md](apps/web/ATTRIBUTIONS.md).
- Icon giao diện dùng Lucide.
