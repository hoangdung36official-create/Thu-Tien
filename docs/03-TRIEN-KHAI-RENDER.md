# Triển khai Vincent Server Edition lên Render

`render.yaml` nằm ở **gốc repository** `server-edition/`, tạo 5 tài nguyên tại Singapore:

| Tên | Dịch vụ | Vai trò |
| --- | --- | --- |
| `vincent-web` | Web service (Starter) | Giao diện HTTPS, PWA, trung chuyển `/api/*` |
| `vincent-api` | Private service (Starter) | Fastify, quản lý dữ liệu và kiểm tra quyền |
| `vincent-worker` | Background worker (Starter) | Đồng bộ Sheets định kỳ |
| `vincent-db` | PostgreSQL (0.5c/1 GB) | Lịch sử thu, công nợ, kiểm toán |
| `vincent-queue` | Key Value (256 MB) | Redis/BullMQ, `noeviction`, lưu journal + snapshot |

**Đây là các gói trả phí**, có thể phát sinh phí hàng tháng. Xem mức giá hiện tại trong bước xác nhận tài nguyên của Render trước khi triển khai. Không dùng PostgreSQL/Key Value miễn phí để chứa số liệu tài chính vận hành vì giới hạn thời gian lưu và độ bền.

## 1. Chuẩn bị Git và Google Sheets

1. Đưa **chỉ nội dung thư mục `server-edition/`** lên repository GitHub/GitLab/Bitbucket, để `render.yaml` nằm ở gốc repository. Nên đặt chế độ **private** với dự án tài chính; nếu repository đang public, tuyệt đối không đưa dữ liệu thật hoặc khóa bí mật lên Git. Không đưa các file của V6 hoặc thư mục `node_modules` lên repo này. `.gitignore` đã loại `.env` và một số loại tệp chứa bí mật phổ biến.
   Nếu chưa có repository local, ở thư mục `server-edition/` có thể chạy `git init -b main`, `git add .`, `git commit -m "Prepare Vincent Render deployment"`, `git remote add origin <PRIVATE_REPOSITORY_URL>`, rồi `git push -u origin main`. Cần có quyền push lên repository và cấu hình tên/email Git trước khi commit.
2. Chuẩn bị đúng ID Google Sheets ở đường dẫn `/spreadsheets/d/<ID>/edit`. **Nếu dùng bản sao, dùng ID của bản sao** và database riêng để không ghi nhầm vào file gốc.
3. Tạo Service Account của Google Cloud, bật Google Sheets API, cấp quyền **Editor** cho email Service Account trên đúng bảng tính. Chuẩn bị email và private key trong JSON key; không đưa key lên Git.
4. Tạo số điện thoại admin (9–15 chữ số) và mật khẩu đủ mạnh (ít nhất 10 ký tự). Không dùng tài khoản V6 cũ chưa được cấp mật khẩu mới.

## 2. Tạo Blueprint

1. Đăng nhập [Render Dashboard](https://dashboard.render.com/) → **New → Blueprint** → kết nối repository private `server-edition` → chọn nhánh chính và file `render.yaml`.
2. Xem lại chi phí trước khi bấm **Deploy Blueprint**. Nhập các biến Render yêu cầu (`sync: false`) vào **vincent-api**:

   | Biến | Giá trị cần cung cấp |
   | --- | --- |
   | `GOOGLE_SPREADSHEET_ID` | ID Sheets chính xác |
   | `GOOGLE_SERVICE_ACCOUNT_EMAIL` | `client_email` của Service Account |
   | `GOOGLE_PRIVATE_KEY` | Giá trị `private_key` đầy đủ, có `-----BEGIN PRIVATE KEY-----` và `-----END PRIVATE KEY-----`; có thể dùng chuỗi `\n` từ JSON |
   | `INITIAL_ADMIN_LOGIN` | Số điện thoại quản trị |
   | `INITIAL_ADMIN_PASSWORD` | Mật khẩu quản trị từ 10 ký tự |

   `SESSION_SECRET` được Render sinh ngẫu nhiên. Liên kết PostgreSQL, Key Value và URL nội bộ được cấu hình tự động. Không điền `DATABASE_URL`, `REDIS_URL` bằng tay. `APP_URL` của API lấy từ URL HTTPS của `vincent-web`.
3. Đợi tất cả dịch vụ chuyển sang trạng thái chạy. Ở `vincent-api`, bước **pre-deploy** sẽ chạy Prisma migration và tạo tài khoản quản trị **một lần**. Những lần triển khai sau sẽ giữ nguyên mật khẩu đã thiết lập.
4. Mở URL `https://<vincent-web>.onrender.com/api/health`. Kết quả mong đợi là `{"ok":true,"service":"vincent-api"}`. Mở trang gốc và đăng nhập bằng số điện thoại/mật khẩu quản trị.

Nếu `/api/health` trả về 502, kiểm tra log `vincent-api`, kết nối PostgreSQL, biến môi trường và địa chỉ nội bộ `API_INTERNAL_HOSTPORT`. Nếu dịch vụ API báo thiếu cấu hình, cập nhật biến trong **Environment** rồi deploy lại.

## 3. Đối soát trước khi mở thu tiền

Khi mới tạo, **`COLLECTIONS_ENABLED=false` ở cả API và worker**. Người dùng có thể đăng nhập và xem dữ liệu sau đồng bộ nhưng các thao tác ghi từ giao diện và worker sang Google Sheets đều bị khóa.

1. Kiểm tra `NHẬP CẦN THU`, `CẦN THU`, `NHẬT KÝ`, danh mục nhà, tài khoản nhận, phân quyền; tránh cho V6 và Server Edition ghi đồng thời.
2. Dùng **Shell của vincent-api** để chạy `npm run import:sheet -w @vincent/api` (chỉ xem trước). Kiểm tra từng tháng/nhà/phòng, tổng phải thu, tổng đã thu, tiền mặt/chuyển khoản, mã K trùng và dòng lỗi. Nếu số liệu phù hợp, chạy `npm run import:sheet -w @vincent/api -- --commit`. Đồng bộ nền cũng có thể đã đọc dữ liệu vào PostgreSQL; cần đối chiếu với nguồn Sheets trước khi thu thật.
3. Trong giao diện quản trị, kiểm tra xung đột đồng bộ và báo cáo chuyển khoản. Tạo bản sao lưu Google Sheets và cơ sở dữ liệu PostgreSQL; kiểm tra khả năng khôi phục.
4. Khi đã thống nhất chỉ Server Edition ghi vào `NHẬT KÝ`, sửa **cả hai** mục `COLLECTIONS_ENABLED` thành `"true"` trong `render.yaml`, commit, push và đồng bộ lại Blueprint. Kiểm tra API trả `collectionsEnabled: true` sau đăng nhập, đồng thời kiểm tra log worker và giao dịch mẫu an toàn.

**Lưu ý vận hành:** thay đổi biến `COLLECTIONS_ENABLED` của API và worker phải đồng bộ. Khi muốn tạm dừng ghi, đặt cả hai về `false` và deploy lại. Kiểm tra báo cáo/đối soát đầy đủ trước mỗi lần mở lại thu tiền.

## 4. Cập nhật và sự cố

- Mọi lần push code mới sẽ triển khai từ Git tùy cấu hình auto-deploy trong Render. `vincent-api` chạy migration an toàn ở bước pre-deploy; tuyệt đối không sửa migration đã áp dụng cho production.
- Khi deploy sau, `INITIAL_ADMIN_PASSWORD` không tự đổi mật khẩu admin. Dùng chức năng quản trị để đổi mật khẩu, hoặc quy trình khôi phục có kiểm soát.
- Mở URL web và `/api/health` để kiểm tra frontend, reverse proxy, backend và database. Dùng `vincent-api` logs để xem lỗi biến môi trường hoặc migration; dùng `vincent-worker` logs để phát hiện lỗi Google Sheets API, xung đột và retry.
- Lập lịch sao lưu PostgreSQL và lưu bản backup **ngoài Render**, kiểm tra được bản phục hồi. Bản sao lưu Sheets cần thực hiện độc lập.
- Nếu đổi sang **một file Sheets khác**, sử dụng **database khác**, vì ứng dụng chặn kết nối database đã gắn ID Sheets cũ.

Giá trị riêng tư (key JSON, mật khẩu, token, connection string) chỉ nhập trong Render Dashboard; không chụp hoặc gửi lên chat công khai.
