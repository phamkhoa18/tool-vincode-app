# Vincode Tools

Bộ công cụ tiện ích miễn phí — xử lý tài liệu, chuyển đổi file bằng AI.

🌐 **Live:** [tool.vincode.xyz](https://tool.vincode.xyz)

---

## Tính năng

### Vindocs — Document → Markdown

Chuyển đổi tài liệu sang Markdown chuẩn với AI.

- **PDF (text)** — Trích xuất text trực tiếp, AI format thành Markdown
- **PDF (scan/hình)** — Render từng trang thành PNG, OCR bằng Vision AI
- **Word (.docx)** — Chuyển qua HTML → Markdown, AI chỉnh sửa cấu trúc
- **Word (.doc)** — Trích xuất text từ file Word cũ, AI format
- **Hình ảnh** (PNG, JPG, WebP, BMP, TIFF) — Vision AI OCR
- **Batch upload** — Tải lên nhiều file cùng lúc, xử lý song song

## Tech Stack

| Layer | Công nghệ |
|-------|-----------|
| Server | Node.js, Express |
| AI | OpenAI-compatible API (text + vision models) |
| PDF Parse | pdf-parse (text), mupdf WASM (render to PNG) |
| Word | mammoth (.docx), word-extractor (.doc) |
| Security | helmet, express-rate-limit, cors |
| Frontend | Vanilla HTML/CSS/JS, Inter font |

## Cài đặt

```bash
# Clone repo
git clone https://github.com/vincode-xyz/vincode-tools.git
cd vincode-tools

# Cài dependencies
npm install

# Tạo file .env
cp .env.example .env
# Sửa .env với API key của bạn
```

## Cấu hình

Tạo file `.env`:

```env
# AI Configuration (OpenAI-compatible endpoint)
AI_API_KEY=your-api-key-here
AI_TEXT_MODEL=Qwen3-32B
AI_VISION_MODEL=gemma-4-31B-it
AI_API_URL=https://your-ai-api.com/v1/chat/completions

# Server
PORT=3456
```

## Chạy

```bash
# Development (auto-restart với nodemon)
npm run dev

# Production
npm start
```

## Deploy (Production)

### Với PM2

```bash
# Cài PM2
npm install -g pm2

# Start
pm2 start server.js --name vincode-tools -i 1
pm2 save
pm2 startup
```

### Nginx Reverse Proxy

```nginx
server {
    listen 80;
    server_name tool.vincode.xyz;

    client_max_body_size 50M;

    location / {
        proxy_pass http://127.0.0.1:3456;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 120s;
    }
}
```

```bash
# Enable site & reload nginx
sudo ln -s /etc/nginx/sites-available/vincode-tools /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# SSL với Certbot
sudo certbot --nginx -d tool.vincode.xyz
```

## Cấu trúc dự án

```
├── server.js              # Express server + AI logic
├── package.json
├── .env                   # Config (không commit)
├── .gitignore
├── public/
│   ├── index.html         # Trang chủ — danh sách tools
│   ├── style.css          # CSS chung
│   ├── app.js             # JS cho Vindocs
│   └── vindocs/
│       └── index.html     # Trang Vindocs converter
└── uploads/               # Thư mục tạm (auto-clean)
```

## Bảo mật

- **Helmet** — HTTP security headers, CSP
- **Rate Limit** — 30 convert/phút, 120 request/phút
- **CORS** — Production chỉ cho phép `tool.vincode.xyz`
- **File Validation** — Chỉ chấp nhận định dạng cho phép, giới hạn 50MB
- **No Info Leak** — API key, model name không lộ ra client
- **Auto Cleanup** — File upload tự xóa sau khi xử lý

## API

### `POST /api/convert`

Upload 1 file.

```bash
curl -X POST -F "file=@document.pdf" https://tool.vincode.xyz/api/convert
```

### `POST /api/convert-batch`

Upload nhiều file (tối đa 20).

```bash
curl -X POST \
  -F "files=@file1.pdf" \
  -F "files=@file2.png" \
  https://tool.vincode.xyz/api/convert-batch
```

### `GET /api/health`

```json
{ "status": "ok" }
```

## License

© 2026 [vincode.xyz](https://vincode.xyz). All rights reserved.
