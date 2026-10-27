# Kế hoạch phát triển Thunderbird add-on: Unicode Highlighter

## 1. Mục tiêu

Tạo một add-on cho Thunderbird để **nhận diện và tô màu các ký tự Unicode không thuộc hệ chữ Latin trong nội dung email**, giúp phát hiện ký tự lạ, chữ giả mạo và các trường hợp trộn nhiều hệ chữ trong cùng một câu.

### Phạm vi chức năng

| Chức năng | Mô tả | Ưu tiên |
|---|---|---|
| Tô màu ký tự ngoài Latin | Tô màu chữ Hy Lạp, Cyrillic, Ả Rập, Hebrew, v.v. | P0 |
| Giữ nguyên tiếng Việt | Không đánh dấu chữ Latin có dấu như `ế`, `ộ`, `đ` | P0 |
| Hỗ trợ email HTML | Đánh dấu ký tự trong nội dung HTML mà không phá định dạng | P0 |
| Hỗ trợ email plain text | Đánh dấu ký tự trong email văn bản thuần | P0 |
| Phát hiện ký tự đồng hình | Đánh dấu Cyrillic `а` nằm giữa các chữ Latin để phát hiện giả mạo | P1 |
| Tùy chỉnh màu | Cho phép chọn màu chữ và màu nền | P1 |
| Bật/tắt nhanh | Tạm tắt đánh dấu khi cần | P1 |
| Tùy chỉnh hệ chữ | Chọn hệ chữ cần đánh dấu | P2 |
| Cấu hình riêng cho từng email | Bật/tắt đánh dấu cho email đang mở | P2 |

**Nguyên tắc:** Không sửa nội dung email gốc, không gửi dữ liệu ra ngoài và không yêu cầu quyền truy cập hộp thư vượt quá mức cần thiết.

## 2. Công nghệ và kiến trúc

Sử dụng **Thunderbird MailExtension**, không dùng legacy/XUL extension.

| Thành phần | Công nghệ |
|---|---|
| Extension API | Thunderbird WebExtensions |
| Xử lý nội dung | JavaScript thuần |
| Nhận diện Unicode | Unicode Script properties, Unicode code points |
| Tô màu | CSS |
| Lưu cấu hình | `storage.local` |
| Giao diện cài đặt | HTML/CSS/JavaScript |
| Build | Đóng gói ZIP thành `.xpi` |

Thunderbird có API để chèn JavaScript/CSS vào email đang hiển thị. Cần chọn đúng API và manifest version theo phiên bản Thunderbird mục tiêu; kiểm tra tài liệu API trước khi triển khai.

Tài liệu:
- [Thunderbird MailExtension API](https://developer.thunderbird.net/add-ons/mailextensions/supported-webextension-api)
- [Thunderbird message display APIs](https://webextension-api.thunderbird.net/en/mv3/messageDisplayScripts.html)

### Cấu trúc dự kiến

```text
ThunderbirdUnicodeHighlight/
├── manifest.json
├── background.js
├── content/
│   ├── scanner.js
│   ├── highlighter.js
│   └── styles.css
├── options/
│   ├── options.html
│   ├── options.js
│   └── options.css
└── icons/
```

### Luồng xử lý

1. Người dùng mở email.
2. Extension xử lý DOM đã render; không phân tích lại MIME hoặc tải email từ máy chủ.
3. Scanner tìm các ký tự cần đánh dấu.
4. Highlighter đánh dấu các text node cần thiết.
5. CSS tô màu mà không làm thay đổi bố cục email.
6. Cấu hình được lưu cục bộ bằng `storage.local`.

## 3. Thiết kế bộ nhận diện Unicode

Không nên coi mọi ký tự ngoài Latin là nguy hiểm: email đa ngôn ngữ có thể hoàn toàn hợp lệ.

### Phân loại ký tự

| Nhóm | Ví dụ | Mặc định |
|---|---|---|
| Latin | `Hello`, `ế`, `đ` | Không đánh dấu |
| Greek | `Ελληνικά`, `ο` | Đánh dấu |
| Cyrillic | `Привет`, `а` | Đánh dấu |
| Arabic | `مرحبا` | Đánh dấu |
| Hebrew | `שלום` | Đánh dấu |
| CJK | `日本語`, `中文` | Đánh dấu hoặc tùy chỉnh |
| Emoji | `😀` | Không đánh dấu |
| Ký tự điều khiển Unicode | Bidi controls, zero-width characters | Đánh dấu theo chế độ riêng |

Nên dùng Unicode Script properties thay vì kiểm tra các khoảng mã Unicode cố định. Cần lưu ý rằng một số ký tự thuộc `Common` hoặc `Inherited`, như dấu câu và dấu kết hợp, không nên tự động bị coi là chữ ngoài Latin.

### Ba chế độ hoạt động

**Mode 1 — Non-Latin**

Đánh dấu các chữ cái thuộc hệ chữ không phải Latin.

**Mode 2 — Mixed-script**

Tập trung vào từ hoặc cụm từ trộn nhiều hệ chữ, ví dụ:
- `раypal.com`: có ký tự Cyrillic trông giống chữ Latin.
- `microsοft.com`: chữ `ο` là Greek.

**Mode 3 — Security**

Ngoài hai nhóm trên, phát hiện ký tự điều khiển hướng chữ và ký tự vô hình có thể khiến nội dung hiển thị khác thứ tự thực tế.

Mixed-script chỉ là tín hiệu cảnh báo, không phải bằng chứng email độc hại.

## 4. Thiết kế giao diện

### Nút trên thanh công cụ

Tên: `Unicode Highlight`

Khi nhấn, bật/tắt đánh dấu cho email đang xem.

### Trang Options

- Bật/tắt tính năng.
- Chế độ: Non-Latin / Mixed-script / Security.
- Màu chữ và màu nền.
- Chọn hệ chữ cần đánh dấu.
- Bỏ qua email hoặc domain đáng tin cậy (nên cân nhắc kỹ vì có thể tạo điểm mù bảo mật).
- Khôi phục cấu hình mặc định.

Mặc định nên dùng chữ đỏ đậm và nền đỏ nhạt, đủ tương phản với giao diện sáng và tối.

## 5. Các vấn đề kỹ thuật cần xử lý

### Không phá HTML

Không lấy toàn bộ `innerHTML`, thay chuỗi rồi ghi ngược lại. Cách đó có thể làm hỏng HTML, liên kết, định dạng hoặc cấu trúc email.

Thay vào đó, duyệt text node và chỉ thay đổi những node cần thiết. Bỏ qua `script`, `style`, `textarea`, `input`, `select`, `option` và các vùng không cần xử lý.

### Không tô lại nhiều lần

- Không bọc một ký tự nhiều lần.
- Đánh dấu các node đã xử lý.
- Chỉ theo dõi thay đổi DOM khi thực sự cần thiết.
- Tránh dùng `MutationObserver` trên toàn trang nếu không cần.

### Email lớn

Với email HTML lớn, cần giới hạn số node và tránh quét toàn bộ nội dung nhiều lần. Có thể đặt ngưỡng kích thước và thông báo nếu vượt ngưỡng xử lý.

### Plain text

Kiểm thử riêng email plain text vì cách Thunderbird hiển thị có thể khác email HTML. Không giả định hai loại thư dùng cùng cấu trúc DOM.

### Tương thích API

Trước khi viết code, xác nhận phiên bản Thunderbird mục tiêu và API hiển thị thư tương ứng. Không trộn cú pháp Manifest V2 và Manifest V3; khai báo đúng quyền tối thiểu cần thiết.

## 6. Kế hoạch triển khai

| Giai đoạn | Công việc | Kết quả |
|---|---|---|
| P1 | Khởi tạo MailExtension, đăng ký script | Add-on nạp được |
| P2 | Scanner Unicode và tô màu | Đánh dấu ký tự ngoài Latin |
| P3 | Hỗ trợ HTML và plain text | Hiển thị ổn định |
| P4 | Phát hiện mixed-script và ký tự vô hình | Chế độ bảo mật |
| P5 | Options và nút bật/tắt | Có thể tùy chỉnh |
| P6 | Kiểm thử và tối ưu | Bản dùng hằng ngày |
| P7 | Đóng gói XPI | Cài đặt được trên Thunderbird |

### Bộ kiểm thử bắt buộc

1. Email tiếng Việt có dấu.
2. Email tiếng Anh thông thường.
3. Email tiếng Nga và tiếng Hy Lạp.
4. Email tiếng Nhật và tiếng Trung.
5. Email HTML có bảng, liên kết, ảnh và CSS.
6. Email plain text.
7. Email có `раypal.com` hoặc `microsοft.com`.
8. Email chứa ký tự vô hình và Unicode bidi.
9. Email dài hàng MB.
10. Thunderbird giao diện sáng và tối.

## 7. Tiêu chí hoàn thành

- Tô màu đúng các chữ cái ngoài Latin.
- Không đánh dấu nhầm chữ tiếng Việt có dấu.
- Không sửa nội dung email gốc.
- Không làm hỏng liên kết hoặc HTML.
- Không gửi nội dung email ra ngoài.
- Có thể bật/tắt và đổi màu.
- Hoạt động với cả email HTML và plain text trên phiên bản Thunderbird mục tiêu.

## 8. Phạm vi MVP đề xuất

MVP nên dừng ở P1–P3:
- Tô màu Unicode ngoài Latin.
- Hỗ trợ email HTML và plain text.
- Không phá nội dung hoặc định dạng.
- Có bật/tắt cơ bản.

Sau khi ổn định mới bổ sung phát hiện ký tự đồng hình, ký tự vô hình và giao diện tùy chỉnh.
