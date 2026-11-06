# VINCENT WEB APP — SERVER EDITION

Ứng dụng quản lý thu tiền nhà/phòng chạy độc lập trên VPS: Next.js (PWA), Fastify, PostgreSQL, Redis/BullMQ, Google Sheets API và Caddy HTTPS. **Google Sheets / NHẬP CẦN THU là nguồn gốc của số tiền phải thu**; PostgreSQL lưu bản chụp đã đối soát, giao dịch, trạng thái đồng bộ và lịch sử sửa đổi. Server Edition không sử dụng Google Apps Script làm backend.

Đây là một **dự án riêng** trong `server-edition/`; không thay thế mã nguồn V6. Đọc [khảo sát V6](docs/01-PHAN-TICH-V6.md) và [thiết kế hệ thống](docs/02-KIEN-TRUC.md) trước khi di chuyển dữ liệu.

**Triển khai Render:** xem [hướng dẫn Render](docs/03-TRIEN-KHAI-RENDER.md). Tệp [`render.yaml`](render.yaml) tạo frontend HTTPS, API nội bộ, worker, PostgreSQL và Key Value tại Singapore. Tính năng thu tiền vẫn khóa cho đến khi đối soát Google Sheets.

**Xem thử trên Vercel miễn phí:** xem [hướng dẫn Vercel Hobby](docs/04-VERCEL-MIEN-PHI.md). Bản này chỉ phù hợp cho mục đích cá nhân, phi thương mại; chưa có máy chủ API sẽ không đăng nhập hoặc ghi nhận thu tiền được.

[**Mở biểu mẫu Deploy to Render cho repository Thu-Tien**](https://render.com/deploy?repo=https://github.com/hoangdung36official-create/Thu-Tien) — đăng nhập Render, kiểm tra phí của 5 dịch vụ và nhập các biến môi trường bí mật trong bảng điều khiển trước khi xác nhận triển khai.

## 1. Cấu trúc

| Vị trí | Nội dung |
|---|---|
| `apps/api/src/index.ts` | REST API, phiên đăng nhập, phân quyền, thu/sửa/hủy, tổng quan, báo cáo |
| `apps/api/src/sheets.ts` | Google Sheets API, bản chụp và ghi đúng ô |
| `apps/api/src/sync.ts` | Đồng bộ hai chiều, outbox, khóa, phát hiện xung đột |
| `apps/api/src/worker.ts` | Worker định kỳ và retry |
| `apps/api/src/reports.ts` | Báo cáo PDF/ZIP chuyển khoản |
| `apps/api/src/import.ts` | Xem trước và nhập dữ liệu lịch sử |
| `apps/api/prisma/` | Schema và migration PostgreSQL |
| `apps/web/` | Next.js responsive, đăng nhập, giao diện quản lý, PWA |
| `docker-compose.yml`, `Caddyfile` | Dịch vụ và HTTPS trên VPS |
| `scripts/` | Backup và restore PostgreSQL |

## 2. Chuẩn bị bảng tính và Google Cloud

1. Chọn **đúng file Google Sheets đang quản lý thu tiền**. Lấy ID từ phần giữa `/spreadsheets/d/` và `/edit` trong URL. Nếu có bản sao Sheets, phải sử dụng ID của bản sao và **database riêng**; ứng dụng từ chối dùng database đã gắn ID khác.
2. Trong Google Cloud Console, tạo project, bật **Google Sheets API**, tạo **Service Account** và tải JSON key của Service Account bằng kênh bảo mật. Không đưa JSON/key lên GitHub.
3. Mở đúng Google Sheets, dùng chức năng Share chia sẻ quyền **Editor** cho email Service Account. Chỉ chia sẻ tệp dự định đồng bộ.
4. Kiểm tra đủ các tab: `NHẬP CẦN THU`, `CẦN THU`, `NHẬT KÝ`, `CÀI ĐẶT`, `TÀI KHOẢN NHẬN`, `PHÂN QUYỀN WEBAPP`, `KIỂM SOÁT WEBAPP`.
5. `NHẬP CẦN THU`: hàng 1 từ cột E là các ngày đại diện tháng; từ hàng 2, B = phòng, C = mã nhà, E+ = tiền phải thu. `NHẬT KÝ`: A ngày thu, B tháng, C nhà, D phòng, E người thu, F tài khoản nhận, G tiền thu, H hình thức, I người nộp, J ghi chú, **K mã giao dịch**, L ngày chuyển khoản, M nội dung chuyển khoản. Ô K1 cần có tiêu đề `Mã giao dịch`. Không tự đổi vị trí cột.
6. Giữ một bản sao dự phòng của Google Sheets và PostgreSQL. Tránh cho V6 và Server Edition cùng ghi vào `NHẬT KÝ` trong lúc chuyển đổi.

Những giao dịch lịch sử không có mã K sẽ được nhập với ID nội bộ dạng `LEGACY-` và chỉ đọc cho đến khi đối soát. Thông tin chủ tài khoản/ngân hàng/số tài khoản không tồn tại thành cột riêng ở danh mục V6; nhập bổ sung qua màn hình quản trị sau khi chuyển đổi.

**Quy tắc bảo vệ dữ liệu khi đọc Sheets:** nếu `NHẬP CẦN THU` không có khoản dương hợp lệ, có cột tháng trùng, phòng trùng hoặc số cần thu âm, lần nhập mới bị từ chối và giữ nguyên dữ liệu cần thu đã nhập trước đó. Tháng chủ đích không phát sinh tiền phải thu cần được kiểm tra và xử lý riêng; ứng dụng không coi bản chụp toàn số 0 là bằng chứng an toàn để xóa công nợ. Dòng `NHẬT KÝ` có tiền thu nhưng thiếu/sai ngày thu hoặc có dữ liệu không đọc được sẽ được báo xung đột để sửa tại nguồn; ứng dụng không tự tạo ngày thu thay thế. Giao dịch đã đồng bộ mà mất khỏi `NHẬT KÝ` cũng chuyển sang `CONFLICT` để quản trị viên xác minh trước khi xác nhận xóa.
Nếu nhà hoặc tài khoản nhận từng có bản ghi trên Sheets bị xóa khi đang có chỉnh sửa chờ ghi từ ứng dụng, hệ thống cũng báo xung đột danh mục để đối soát thủ công.

## 3. Triển khai VPS Linux với Docker

Yêu cầu: Linux VPS có Docker Engine và Docker Compose plugin, tên miền trỏ A/AAAA về máy chủ, cổng 80 và 443 được mở. Trước khi triển khai thật, chuẩn bị bản sao lưu và môi trường thử nghiệm với bản sao Sheets.

Tại thư mục `server-edition/`:

```sh
cp .env.example .env
```

Sửa `.env` và đặt giá trị thực:

- `DOMAIN` = tên miền truy cập (ví dụ `thutien.example.com`), `APP_URL` = `https://` + tên miền.
- `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`; giữ `DATABASE_URL` trỏ tới `postgres:5432`, cùng thông tin tài khoản database và dấu URL-encode với ký tự đặc biệt trong mật khẩu.
- `REDIS_URL=redis://redis:6379`.
- `GOOGLE_SPREADSHEET_ID`, `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY`. Khóa riêng có thể đặt trong chuỗi **trích dẫn kép** chứa `\\n` đại diện xuống dòng: `GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\\n...\\n-----END PRIVATE KEY-----\\n"`. Không dùng dấu `...` làm khóa thật.
- `SESSION_SECRET` là chuỗi ngẫu nhiên dài tối thiểu 32 ký tự, nên dùng `openssl rand -hex 32`. `INITIAL_ADMIN_LOGIN` là số điện thoại (9–15 số), `INITIAL_ADMIN_PASSWORD` tối thiểu 10 ký tự, đặt riêng và bảo mật.
- `COLLECTIONS_ENABLED=false` **bắt buộc giữ nguyên ở giai đoạn kiểm chứng**. `COOKIE_SECURE=true` khi chạy HTTPS.

Không commit `.env`, JSON Service Account, mật khẩu hoặc bản sao lưu. Chạy:

```sh
docker compose build
docker compose up -d postgres redis
docker compose run --rm api npm run db:migrate -w @vincent/api
docker compose run --rm api npm run bootstrap -w @vincent/api
docker compose run --rm api npm run import:sheet -w @vincent/api
```

Lệnh nhập ở trên **chỉ xem trước**: kiểm tra tổng số tháng, phòng phải thu, tổng VND, số giao dịch, ID trùng và dòng lỗi. Nếu khớp Google Sheets, mới chạy:

```sh
docker compose run --rm api npm run import:sheet -w @vincent/api -- --commit
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 api worker
```

Caddy lấy chứng chỉ HTTPS tự động khi DNS và cổng chính xác. Mở `https://<DOMAIN>`, đăng nhập bằng tài khoản quản trị vừa khởi tạo. Trong trang Admin → Đồng bộ: kiểm tra trạng thái đọc, số cần thu theo từng tháng, lịch sử và các xung đột. Có thể kích hoạt chạy đồng bộ thủ công.

**Trước khi mở thu tiền:** so sánh ít nhất các tháng có giao dịch, từng nhà/phòng, số phải thu, số đã thu, tiền mặt/chuyển khoản, tất cả tài khoản nhận và tổng PDF với Google Sheets; xử lý hết mã K trùng/dòng không đọc được. Tạm dừng chức năng ghi của V6 để chỉ có một bên ghi nhật ký. Khi đối soát và backup đạt yêu cầu, thay `COLLECTIONS_ENABLED=true` trong `.env`, sau đó:

```sh
docker compose up -d --force-recreate api worker
```

Ghi giao dịch vào PostgreSQL có trạng thái `PENDING`; `SYNCED` chỉ có sau khi xác nhận trên Sheets. Khi mất mạng, sẽ có `FAILED` và tự thử lại; xung đột có `CONFLICT` để quản trị viên xử lý. Không dùng số phải thu đã cache làm nguồn cập nhật Google Sheets.

## 4. Chạy phát triển trên Windows

Yêu cầu Node.js 22 LTS hoặc tương thích, npm, Docker. Tạo `.env` ở thư mục gốc. Bật PostgreSQL/Redis qua cổng localhost dành cho phát triển:

```powershell
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres redis
npm ci
$env:DATABASE_URL = "postgresql://vincent:YOUR_PASSWORD@127.0.0.1:5432/vincent?schema=public"
$env:REDIS_URL = "redis://127.0.0.1:6379"
$env:APP_URL = "http://localhost:3000"
$env:COOKIE_SECURE = "false"
npm run db:generate -w @vincent/api
npm run db:migrate -w @vincent/api
npm run bootstrap -w @vincent/api
npm run dev:api
```

Mở thêm terminal trong cùng thư mục:

```powershell
npm run dev:web
```

Mặc định web tại `http://localhost:3000`, API tại `http://localhost:4000`. Next.js chuyển tiếp `/api` tới Fastify. Các thao tác đồng bộ thực tế cần credentials và file Sheets thử nghiệm; không chạy import/thu trên dữ liệu thực khi chưa đối soát. Để chạy worker phát triển, mở thêm terminal có cùng biến môi trường và chạy `npm run worker -w @vincent/api`.

## 5. Sao lưu, khôi phục, cập nhật

```sh
sh scripts/backup.sh
```

File `backups/vincent-<UTC>.dump` chứa dữ liệu nhạy cảm, cần mã hóa và chuyển đến vị trí dự phòng **ngoài VPS**, có quy trình kiểm tra khả năng khôi phục. Google Sheets cũng phải được sao lưu độc lập.

Khôi phục vào **đúng spreadsheet/database**: tắt `COLLECTIONS_ENABLED`, dừng thao tác ghi, sao lưu hiện trạng, sau đó:

```sh
RESTORE_CONFIRM=YES sh scripts/restore.sh backups/vincent-YYYYMMDDTHHMMSSZ.dump
```

Kiểm tra `spreadsheetId` trong bảng `SyncState`, tình trạng outbox/đối soát trước khi bật thu trở lại. Bản dump chỉ chứa PostgreSQL; không hoàn tác những thay đổi đã ghi lên Google Sheets.

Khi cập nhật mã nguồn: sao lưu trước, xem migration mới, sau đó `docker compose up -d --build`; API tự chạy `prisma migrate deploy` trước khi khởi động, worker chỉ chạy khi API khỏe. Kiểm tra log, dashboard, vài giao dịch mẫu và PDF.

## 6. Báo cáo, quyền và PWA

Admin xem báo cáo mọi nhà/tài khoản; nhân viên chỉ thấy giao dịch mình tạo tại nhà được giao và tài khoản có quyền. API thực thi kiểm tra quyền ở server. Báo cáo chuyển khoản lọc theo tháng, khoảng ngày chuyển khoản, nhà, phòng, người thu, tài khoản và trạng thái; xuất PDF tổng hợp hoặc ZIP các PDF theo tài khoản. Giao dịch hủy có thể kiểm tra nhưng **không cộng tiền vào tổng**.

Trên Android Chrome: mở trang HTTPS → menu trình duyệt → **Cài đặt ứng dụng** hoặc **Thêm vào màn hình chính**. Trên iPhone Safari: mở trang HTTPS → **Chia sẻ** → **Thêm vào Màn hình chính**. PWA không chủ động cache API tài chính để sử dụng ngoại tuyến.

## 7. Giới hạn xác minh trước production

- Mã nguồn đã có bộ test cho parser dữ liệu Sheets và nghiệp vụ cơ bản, nhưng phải chạy thêm **kiểm thử tích hợp trên PostgreSQL, Redis và bản sao Google Sheets thật** để xác nhận các kịch bản mất kết nối, sửa đồng thời, xóa dòng, duplicate và reconciliation.
- Giải quyết xung đột bằng lựa chọn dữ liệu Sheets có thể xác nhận việc xóa giao dịch. Quản trị viên phải kiểm tra giao dịch và lịch sử thực tế trước khi chọn cách xử lý; khi nhật ký có dòng lỗi, việc xác nhận xóa do thiếu mã K bị chặn.
- Google Sheets API **không hỗ trợ compare-and-swap theo fingerprint hàng**: con người sửa đúng hàng trong khoảng rất ngắn giữa lần kiểm tra và lần ghi vẫn có thể gây xung đột ngoài dự đoán. Tạm dừng ghi trực tiếp cùng một hàng trong giai đoạn đồng bộ và đối soát trên bản sao trước.
- Thời gian phản hồi dưới một giây là mục tiêu cần đo trên VPS và số lượng dữ liệu thật; chưa có benchmark production.
- **Chưa triển khai hay xác nhận hoạt động trên VPS/Sheets thật** nếu chưa cung cấp cấu hình, quyền và môi trường kiểm thử tương ứng.
