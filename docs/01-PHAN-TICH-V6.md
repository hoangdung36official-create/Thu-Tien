# VINCENT V6 — khảo sát nghiệp vụ và rủi ro chuyển đổi

Nguồn: `../Vincent_WebApp_V6.gs` (phần mã trước `VW_HTML_`),
`../Vincent_WebApp_V6.html`, `../client-v6-functions.js`,
`../upgrade-client-v6.js`, `../test-v6.js`, `../test-v6-client.js`.
Các tệp V5 không có trong thư mục bàn giao. Không có dữ liệu thật hoặc quyền Google API
trong thư mục, nên cần kiểm tra trực tiếp bảng tính trước khi chạy nhập liệu.

## Bản đồ trang tính hiện hành

| Trang | Vùng đọc/ghi được xác nhận | Ý nghĩa |
|---|---|---|
| `NHẬP CẦN THU` | hàng 1, từ E về sau = ô ngày đầu tháng; từ hàng 2: B phòng, C nhà, E+ số cần thu theo tháng | **Nguồn gốc duy nhất của số phải thu** |
| `CẦN THU` | B2 = tháng đang chọn; từ hàng 5, A nhà, B phòng, C cần thu, D đã thu, E còn lại | Bảng xem tháng hiện hành; dự phòng khi `NHẬP CẦN THU` không có cột tháng |
| `NHẬT KÝ` | A ngày thu, B tháng, C nhà, D phòng, E người thu, F tài khoản nhận, G số tiền, H hình thức, I người nộp, J ghi chú, K mã, L ngày chuyển khoản, M nội dung chuyển khoản | Lịch sử giao dịch |
| `CÀI ĐẶT` | A mã nhà, K trạng thái (`NGỪNG DÙNG`), L tên, M ghi chú | Danh mục nhà. Cột B:J có dữ liệu khác: không ghi đè |
| `TÀI KHOẢN NHẬN` | A tên, B `ĐANG DÙNG`/`NGỪNG DÙNG`, C ghi chú | Danh mục tài khoản; **không có cột riêng cho ngân hàng/chủ/số tài khoản trong V6** |
| `PHÂN QUYỀN WEBAPP` | A login, B tên, C CSV nhà, D CSV tài khoản, E trạng thái, F `ADMIN`/`NV`, G salt, H hash, I session version, J ngày tạo | Nhân viên và quyền V6 |
| `KIỂM SOÁT WEBAPP` | A thời điểm, B actor, C action, D chi tiết, E transaction id | Audit V6 |

## Quy tắc đã xác nhận

- Tháng là `yyyy-MM`, định dạng nguồn là giá trị ngày, theo múi giờ Việt Nam.
- Tổng phải thu = tổng cột tháng được chọn của `NHẬP CẦN THU`; đã thu = tổng cột G của `NHẬT KÝ` theo tháng/nhà/phòng. Còn lại = `max(0, phải thu - đã thu)`.
- Phòng có khoản phải thu > 0 mới được thu; chỉ cho thu số nguyên VND > 0, <= 1 tỷ và <= số còn lại. Có thể thu nhiều lần/thu một phần.
- Hình thức là `Tiền mặt` (F trống) hoặc `Chuyển khoản` (F phải là tài khoản có quyền, L ngày `dd/MM/yyyy`, M nội dung bắt buộc).
- Mã giao dịch dạng `VW-<UUID>` ở K. Gửi lại cùng mã và cùng dữ liệu là idempotent; cùng mã khác dữ liệu bị chặn.
- V6 cảnh báo giao dịch chuyển khoản cùng tháng/nhà/phòng/số tiền/tài khoản/ngày/nội dung; tiền mặt giống nhau trong 15 phút.
- Admin xem/sửa tất cả; nhân viên chỉ xem/sửa giao dịch do mình ghi (liên kết qua audit `THU TIỀN`) và thuộc nhà được giao. Danh mục tài khoản được giới hạn theo quyền.
- V6 **xóa hẳn dòng nhật ký** khi hủy và lưu snapshot ở audit; Server Edition giữ xóa mềm trong PostgreSQL và đồng bộ xóa dòng K tương ứng về Sheets có kiểm tra xung đột.
- V6 dùng `LockService`, CacheService và một phần `NHẬT KÝ` được quét lại theo lần đọc. Giới hạn: độ trễ Apps Script, truy vấn sheet nhiều lần, không có phân trang DB, khả năng tranh chấp và lỗi sửa bằng số dòng.
- Mật khẩu V6 dùng 600 vòng SHA-256 với pepper cứng trong mã. Server Edition dùng Argon2id. Chỉ hỗ trợ chuyển tài khoản cũ qua quy trình nhập thông tin hash/salt có kiểm soát nếu cần; không nhúng pepper V6 vào mã mới.
- V6 bật chế độ ghi thu thủ công sau khi thay mật khẩu quản trị. Bản mới mặc định khóa ghi (`COLLECTIONS_ENABLED=false`) cho tới khi quản trị bật trong cấu hình triển khai.

## Bất biến khi di chuyển

1. Mọi bản ghi gắn với một `GOOGLE_SPREADSHEET_ID`; **không fallback** sang ID khác. Bộ nhớ cache/outbox phân vùng theo ID.
2. Không ghi từ PostgreSQL vào `NHẬP CẦN THU`. Đọc định kỳ và tính lại dashboard từ bản chụp nguồn. `CẦN THU` là bảng xem, không phải nơi ghi số gốc.
3. Khi đồng bộ `NHẬT KÝ`, dùng mã K và kiểm tra fingerprint của cả hàng A:M trước khi sửa/xóa; nếu 2 bên đã sửa thì đánh dấu xung đột cho Admin xử lý.
4. Giao dịch không có mã K được nhập với ID nội bộ có dấu vết dòng và nội dung; có thể gây không chắc chắn khi người quản lý sắp xếp lại sheet. Không tự ghi mã vào K hoặc ghi đè dòng có sẵn.
5. Dữ liệu tài khoản nhận về chủ tài khoản/ngân hàng/số tài khoản không có sẵn trong cột V6: bổ sung trong PostgreSQL và cho quản trị viên nhập, không suy diễn từ ghi chú.
6. Không thể kiểm chứng tổng tiền thực tế, quyền Service Account, hay thời gian đáp ứng trước khi có bảng tính/secret và server thật.

## Các module Server Edition

Đăng nhập/phiên, người dùng/quyền, nhà/phòng, tài khoản nhận, cần thu, xác nhận/sửa/hủy thu, lịch sử có phân trang, dashboard, báo cáo chuyển khoản, đồng bộ/đối soát, audit, PWA và triển khai Docker. Mọi phép tính công nợ sử dụng số nguyên VND ở backend.
