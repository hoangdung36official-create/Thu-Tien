# Thiết kế Server Edition

`Next.js` (web + PWA) → HTTP `/api` → `Fastify` (xác thực session + kiểm quyền) → `PostgreSQL/Prisma`.
Worker riêng dùng `BullMQ + Redis` để kiểm tra Google Sheets định kỳ và tiêu thụ outbox.
`Google Sheets API` chỉ do server sử dụng với Service Account có quyền trong spreadsheet được cấu hình.
`Caddy` reverse proxy và HTTPS trên VPS.

- Snapshot tháng, phòng, nhà, tài khoản nằm trong Postgres. API không truy vấn Google ở mỗi lần chuyển tab.
- Mỗi ghi giao dịch thực hiện trong transaction PostgreSQL (kiểm tra công nợ với khóa theo nhà/phòng/tháng) và tạo `Outbox` trong cùng transaction. Trạng thái bắt đầu `PENDING`, chỉ chuyển `SYNCED` sau khi API Google xác nhận.
- Worker retry có backoff, chống ghi trùng bằng mã K, so khớp fingerprint trên phiên bản đã thấy. Dữ liệu khác thì `CONFLICT` và chờ Admin giải quyết, không tự động ghi đè.
- Đồng bộ chiều về nhập `NHẬT KÝ` với K, phát hiện sửa/xóa bằng so sánh fingerprint. Khi outbox đang PENDING, cập nhật ngược không được thắng dữ liệu ứng dụng; hiện xung đột nếu hai phía thay đổi.
- Cần thu luôn chỉ cập nhật từ `NHẬP CẦN THU`, dù source và cache hết hạn; nếu mất kết nối dùng dữ liệu snapshot gần nhất có dấu thời điểm.
- Phiên đăng nhập cookie HttpOnly/SameSite/secure, lưu hash token trong database; mật khẩu Argon2id; giới hạn số lần đăng nhập tại Redis. Admin cấp quyền theo nhà và tài khoản, nhân viên sửa giao dịch do mình tạo.
- Báo cáo PDF/ZIP truy vấn giao dịch PostgreSQL sau khi áp dụng permission filter. Bản ghi hủy không cộng vào tổng. Font Unicode gắn từ máy chủ.

## API

`POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`;
`GET /api/metadata`, `GET /api/dues?month=`, `GET /api/dashboard?month=`;
`GET/POST /api/receipts`, `PATCH/DELETE /api/receipts/:id`;
`GET/POST/PATCH /api/admin/users`, `GET/POST/PATCH /api/admin/houses`, `GET/POST/PATCH /api/admin/accounts`;
`GET /api/reports/transfers` (`format=json|pdf|zip`, lọc tháng/ngày/nhà/phòng/người thu/tài khoản);
`GET /api/admin/sync`, `POST /api/admin/sync/run`, `GET /api/admin/audit`, `POST /api/admin/sync/conflicts/:id/resolve`.

Sửa giao dịch yêu cầu `version` được trả về bởi API để chống ghi đè đồng thời.
V1 không hỗ trợ chủ động thay đổi `GOOGLE_SPREADSHEET_ID` đang chạy; đổi ID ở môi trường mới, database mới, chạy kiểm tra cấu trúc/import rồi mới bật ghi.

## Quản lý rủi ro

Chạy sync đọc-only và kiểm tra đối soát trước khi bật ghi production; sao lưu DB; không mở hai backend với cùng sheet khi chưa khóa ghi phía V6. Khi nguồn không ổn định, đưa giao dịch vào `FAILED` hoặc `CONFLICT`, giữ audit và cho retry thủ công. Tất cả thông tin khóa, mật khẩu, domain và spreadsheet ID chỉ đặt trong env runtime.
