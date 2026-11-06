# Vercel miễn phí: xem thử giao diện Vincent

Vercel Hobby miễn phí chỉ dành cho **sử dụng cá nhân, phi thương mại**. Ứng dụng quản lý thu tiền nhà/phòng phục vụ vận hành thực tế có thể thuộc mục đích thương mại. Chỉ dùng hướng dẫn này để kiểm tra giao diện trên dữ liệu thử nghiệm phù hợp với điều khoản Vercel. Không sử dụng bản Hobby để thu tiền thật.

## 1. Triển khai giao diện Next.js

1. Đăng nhập Vercel bằng tài khoản cá nhân và chọn **Add New → Project**.
2. Import Git repository `hoangdung36official-create/Thu-Tien`.
3. Tại **Root Directory**, chọn `apps/web` (repository đang chứa mã nguồn của Server Edition trực tiếp tại thư mục gốc). Framework Preset là **Next.js**.
4. Dùng cấu hình build/install mặc định của Vercel. Không nhập biến môi trường chứa khóa Google hay mật khẩu vào frontend.
5. Deploy; sau đó mở URL được cấp để xem giao diện. Với bản chưa có backend, yêu cầu `/api/*` sẽ trả mã `503` và thông báo thiếu kết nối máy chủ; đăng nhập và nghiệp vụ thu tiền chưa hoạt động.

> Nếu repository sau này được đặt trong thư mục `server-edition/` thay vì ở gốc Git, cần điều chỉnh Root Directory thành `server-edition/apps/web`.

## 2. Muốn dùng hệ thống đầy đủ

Server Edition gồm **Next.js, Fastify API, PostgreSQL, Redis/BullMQ, worker đồng bộ Google Sheets**. Vercel chỉ phù hợp để chạy phần Next.js của cấu trúc hiện tại. Vercel Hobby không cung cấp tiến trình worker chạy liên tục: Cron trên Hobby tối đa **một lần mỗi ngày**, trong khi hệ thống được thiết kế đồng bộ khoảng **60 giây**.

Khi có backend **HTTPS công khai** và hạ tầng được phép dùng thương mại, đặt biến server-side `API_INTERNAL_URL` của dự án Next.js trên Vercel thành URL gốc của backend, ví dụ `https://api.example.com` (**không** thêm `/api`, không dùng tên DNS riêng của Render). Redeploy sau khi đổi biến. Proxy giữ cookie, thông tin đăng nhập, đường dẫn, truy vấn và tệp tải xuống; triển khai thật cần kiểm thử bảo mật cookie và các API với URL thực.

Backend cần có database, Redis, worker và biến môi trường bảo mật riêng, được cấu hình theo [README](../README.md) và [hướng dẫn Render](03-TRIEN-KHAI-RENDER.md) hoặc VPS. Không đưa `DATABASE_URL`, `GOOGLE_PRIVATE_KEY`, `SESSION_SECRET`, hay tài khoản admin vào Git hoặc môi trường biến công khai `NEXT_PUBLIC_*`.

Giữ `COLLECTIONS_ENABLED=false` cho đến khi nhập dữ liệu thử, đối soát công nợ, báo cáo, bản sao Google Sheets và kiểm tra các xung đột. Chỉ bật sau khi đã sao lưu và đủ điều kiện vận hành.

Tham khảo: [Vercel Hobby](https://vercel.com/docs/plans/hobby), [Vercel Monorepos](https://vercel.com/docs/monorepos), [Cron Jobs](https://vercel.com/docs/cron-jobs/usage-and-pricing).
