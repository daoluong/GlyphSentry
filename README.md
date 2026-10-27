# GlyphSentry — lính gác ký tự cho Thunderbird

**GlyphSentry** phát hiện và tô màu **ký tự Unicode không thuộc hệ chữ Latin** trong email, phát hiện
**ký tự đồng hình (homoglyph)** và **ký tự vô hình/bidi**, cảnh báo **domain lạ**, đồng thời **ép địa
chỉ email, URL và tên miền về font monospace** để dễ soi ký tự giả mạo.

Không đọc nội dung thô của thư, không gửi dữ liệu ra ngoài, không sửa email gốc — chỉ thao tác trên
DOM đã render của khung xem thư.

## Tính năng

- Tô màu chữ ngoài hệ Latin (Greek, Cyrillic, Arabic, Hebrew, CJK…); tiếng Việt có dấu giữ nguyên.
- Ba chế độ: **Non-Latin**, **Mixed-script** (chỉ tô ký tự ngoại lai trong từ có lẫn chữ Latin), **Security** (thêm ký tự vô hình/bidi).
- Ép email, URL và tên miền về monospace để dễ soi ký tự giả mạo.
- Cảnh báo domain ngoài và địa chỉ chứa ký tự non-Latin; banner cảnh báo người gửi.
- Bật/tắt riêng cho từng email; tuỳ chỉnh màu sắc và hệ chữ cần đánh dấu trong Options.

## Cài đặt

- **Dùng thử**: Thunderbird → **Tools → Developer Tools → Debug Add-ons** → **Load Temporary Add-on…** → chọn `manifest.json`.
- **Đóng gói**: chạy `pwsh -File .\build.ps1` → `dist/glyphsentry.xpi`, cài qua **Tools → Add-ons and Themes → ⚙ → Install Add-on From File…**.

## Cấu trúc

- `background.js` — đăng ký message display script, xử lý nút toolbar.
- `content/` — scanner (nhận diện Unicode), highlighter (bọc span), styles.
- `options/` — trang cài đặt.
- `tests/` — unit test cho scanner.

## Kiểm thử

```powershell
node tests/scanner.test.js
```

## Quyền

`storage`, `messagesRead`, `accountsRead`, `scripting`.
