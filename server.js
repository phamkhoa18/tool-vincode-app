require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const WordExtractor = require('word-extractor');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3456;
const isProd = process.env.NODE_ENV === 'production';

// ─── Security Middleware ───────────────────────

// Trust proxy (nginx reverse proxy)
app.set('trust proxy', 1);

// Helmet: secure HTTP headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "cdn.jsdelivr.net"],
      styleSrc: ["'self'", "'unsafe-inline'", "fonts.googleapis.com"],
      fontSrc: ["'self'", "fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// CORS
const corsOrigins = isProd
  ? ['https://tool.vincode.xyz', 'https://vincode.xyz']
  : ['http://localhost:3456', 'http://127.0.0.1:3456'];
app.use(cors({ origin: corsOrigins }));

// Rate limiting: convert API
const convertLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Bạn đang gửi quá nhiều request. Vui lòng chờ 1 phút.' },
});

// General rate limit
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(generalLimiter);

// Body size limit
app.use(express.json({ limit: '1mb' }));

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Multer config
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1e6)}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  defParamCharset: 'utf8', // Fix Vietnamese filename encoding
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.doc', '.docx', '.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tiff'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Không hỗ trợ định dạng ${ext}. Chấp nhận: PDF, Word, PNG, JPG, WebP, BMP, TIFF`));
    }
  },
});

// Serve static files with cache
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: isProd ? '1d' : 0,
  etag: true,
}));

// ─── Lazy-load mupdf (ESM module) ─────────────────────────

let _mupdf = null;
async function getMupdf() {
  if (!_mupdf) {
    _mupdf = await import('mupdf');
  }
  return _mupdf;
}

// ─── Helpers ───────────────────────────────────────────────

/**
 * Call AI API (OpenAI-compatible endpoint)
 */
async function callAI(messages, options = {}) {
  const apiKey = process.env.AI_API_KEY;
  const apiUrl = process.env.AI_API_URL;
  const model = options.model || process.env.AI_TEXT_MODEL || 'Qwen3-32B';

  console.log(`   🤖 Calling model: ${model}`);

  const body = {
    model,
    messages,
    max_tokens: options.max_tokens || 8192,
    temperature: options.temperature ?? 0.2,
  };

  const resp = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`AI API error (${resp.status}): ${errText}`);
  }

  const data = await resp.json();
  let content = data.choices?.[0]?.message?.content || '';

  // Strip <think>...</think> blocks from reasoning models
  content = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

  return content;
}

/**
 * Check if PDF has extractable text
 */
async function pdfHasText(buffer) {
  try {
    const data = await pdfParse(buffer);
    const text = (data.text || '').trim();
    // If text is very short relative to pages, it's likely scanned
    const avgCharsPerPage = text.length / (data.numpages || 1);
    return { hasText: avgCharsPerPage > 50, text: data.text, numpages: data.numpages };
  } catch {
    return { hasText: false, text: '', numpages: 0 };
  }
}

/**
 * Convert PDF pages to PNG images using mupdf (WASM)
 * Returns array of { base64: string, mime: string, pageNum: number }
 */
async function pdfToImages(buffer, maxPages = 10) {
  const mupdf = await getMupdf();

  // Open the PDF document from buffer
  const doc = mupdf.Document.openDocument(buffer, 'application/pdf');
  const pageCount = doc.countPages();
  const pagesToRender = Math.min(pageCount, maxPages);

  console.log(`   📄 PDF has ${pageCount} pages, rendering ${pagesToRender} as images`);

  const images = [];

  for (let i = 0; i < pagesToRender; i++) {
    const page = doc.loadPage(i);

    // Render at 200 DPI (scale factor ~2.78 from default 72 DPI)
    const scale = 200 / 72;
    const matrix = [scale, 0, 0, scale, 0, 0];

    const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true);
    const pngData = pixmap.asPNG();

    // pngData is a Uint8Array containing PNG bytes
    const base64 = Buffer.from(pngData).toString('base64');

    images.push({
      base64,
      mime: 'image/png',
      pageNum: i + 1,
    });

    console.log(`   ✅ Page ${i + 1}/${pagesToRender} rendered (${Math.round(base64.length / 1024)}KB)`);
  }

  return images;
}

/**
 * Convert image file to base64
 */
function imageToBase64(filePath) {
  const buffer = fs.readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mimeMap = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.tiff': 'image/tiff',
  };
  const mime = mimeMap[ext] || 'image/png';
  return { base64: buffer.toString('base64'), mime };
}

/**
 * Process text-based PDF: extract text and format as Markdown using AI
 */
async function processTextPDF(text, filename) {
  const messages = [
    {
      role: 'system',
      content: `Bạn là một chuyên gia chuyển đổi văn bản thành Markdown chuẩn. 
Hãy chuyển đổi nội dung sau thành Markdown có cấu trúc rõ ràng:
- Giữ nguyên nội dung gốc, không thêm hay bớt thông tin
- Sử dụng heading (#, ##, ###) phù hợp cho tiêu đề
- Sử dụng danh sách (-, 1.) cho các mục liệt kê
- Sử dụng **bold**, *italic* khi phù hợp
- Sử dụng bảng markdown cho dữ liệu dạng bảng
- Sử dụng code blocks cho code
- Giữ đúng thứ tự và cấu trúc của tài liệu gốc
- Chỉ trả về nội dung Markdown, không thêm giải thích`,
    },
    {
      role: 'user',
      content: `Chuyển đổi nội dung tài liệu "${filename}" sau thành Markdown chuẩn:\n\n${text}`,
    },
  ];

  return await callAI(messages);
}

/**
 * Process a single image with Vision AI
 * Accepts base64 PNG/JPG image data
 */
async function processImageWithVision(base64, mime, filename, context = '') {
  const messages = [
    {
      role: 'system',
      content: `Bạn là một chuyên gia OCR và chuyển đổi tài liệu. 
Hãy đọc toàn bộ nội dung trong hình ảnh và chuyển thành Markdown chuẩn:
- Trích xuất tất cả văn bản trong hình
- Giữ nguyên cấu trúc và bố cục tài liệu
- Sử dụng heading (#, ##, ###) cho tiêu đề
- Sử dụng bảng markdown cho dữ liệu dạng bảng
- Hỗ trợ tiếng Việt đầy đủ
- Chỉ trả về nội dung Markdown, không thêm giải thích`,
    },
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `Hãy đọc và chuyển đổi toàn bộ nội dung trong hình ảnh "${filename}"${context} thành Markdown chuẩn.`,
        },
        {
          type: 'image_url',
          image_url: {
            url: `data:${mime};base64,${base64}`,
          },
        },
      ],
    },
  ];

  const visionModel = process.env.AI_VISION_MODEL || 'gemma-4-31B-it';

  return await callAI(messages, {
    max_tokens: 8192,
    model: visionModel,
  });
}

/**
 * Process scanned PDF: convert pages to images, then OCR each page
 */
async function processScannedPDF(buffer, filename) {
  // Step 1: Convert PDF pages to PNG images
  const images = await pdfToImages(buffer);

  if (images.length === 0) {
    throw new Error('Không thể render trang nào từ PDF');
  }

  // Step 2: OCR each page with vision model
  const pageResults = [];

  for (const img of images) {
    console.log(`   🔍 OCR page ${img.pageNum}/${images.length}...`);
    const pageContext = images.length > 1 ? ` (trang ${img.pageNum}/${images.length})` : '';
    const result = await processImageWithVision(img.base64, img.mime, filename, pageContext);
    pageResults.push(result);
  }

  // Step 3: Combine results
  if (pageResults.length === 1) {
    return pageResults[0];
  }

  // Multiple pages: combine with page separators
  return pageResults
    .map((content, i) => {
      if (images.length > 1) {
        return `<!-- Trang ${i + 1} -->\n\n${content}`;
      }
      return content;
    })
    .join('\n\n---\n\n');
}

/**
 * Process Word document
 */
async function processWordDoc(filePath, filename) {
  const result = await mammoth.convertToHtml({ path: filePath });
  const html = result.value;

  // Use Turndown to convert HTML to Markdown
  const TurndownService = require('turndown');
  const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
  });

  let markdown = turndown.turndown(html);

  // If content is substantial, use AI to polish
  if (markdown.length > 100) {
    try {
      const messages = [
        {
          role: 'system',
          content: `Bạn là chuyên gia chỉnh sửa Markdown. Hãy cải thiện cấu trúc Markdown sau:
- Sửa heading levels cho phù hợp
- Đảm bảo bảng hiển thị đúng
- Giữ nguyên toàn bộ nội dung
- Chỉ trả về Markdown đã chỉnh sửa`,
        },
        {
          role: 'user',
          content: `Chỉnh sửa Markdown từ tài liệu "${filename}":\n\n${markdown}`,
        },
      ];
      markdown = await callAI(messages);
    } catch (e) {
      console.warn('   ⚠️ AI polish failed, using raw conversion:', e.message);
    }
  }

  return markdown;
}

// ─── Core: process a single file (reusable) ───────────────

async function processOneFile(file) {
  const startTime = Date.now();
  const filePath = file.path;
  // Normalize Unicode (macOS uses NFD → fix Vietnamese chars)
  const filename = file.originalname.normalize('NFC');
  const ext = path.extname(filename).toLowerCase();

  console.log(`\n📥 Processing: ${filename} (${(file.size / 1024).toFixed(1)}KB)`);

  try {
    let markdown = '';
    let method = '';

    if (ext === '.pdf') {
      const buffer = fs.readFileSync(filePath);
      const { hasText, text, numpages } = await pdfHasText(buffer);

      if (hasText && text.trim().length > 100) {
        method = 'PDF Text → AI Format';
        console.log(`   📄 Text PDF (${numpages} pages, ${text.length} chars)`);
        markdown = await processTextPDF(text, filename);
      } else {
        method = 'PDF Scan → PNG → Vision AI';
        console.log(`   🖼️ Scanned PDF, converting to images...`);
        markdown = await processScannedPDF(buffer, filename);
      }
    } else if (ext === '.doc') {
      // Old .doc binary format — use word-extractor
      method = 'Word (.doc) → AI Format';
      console.log(`   📝 Word document (.doc)`);
      const extractor = new WordExtractor();
      const extracted = await extractor.extract(filePath);
      const text = extracted.getBody() || '';
      if (text.trim().length < 10) {
        throw new Error('Không thể đọc nội dung từ file .doc này. Vui lòng lưu lại dưới dạng .docx hoặc PDF.');
      }
      markdown = await processTextPDF(text, filename);
    } else if (ext === '.docx') {
      method = 'Word → Markdown';
      console.log(`   📝 Word document (.docx)`);
      markdown = await processWordDoc(filePath, filename);
    } else if (['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tiff'].includes(ext)) {
      method = 'Image → Vision AI OCR';
      console.log(`   🖼️ Image file`);
      const { base64, mime } = imageToBase64(filePath);
      markdown = await processImageWithVision(base64, mime, filename);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`   ✅ Done: ${filename} in ${elapsed}s`);

    fs.unlink(filePath, () => {});

    return { success: true, markdown, filename, method, elapsed: `${elapsed}s` };
  } catch (err) {
    console.error(`   ❌ Error [${filename}]:`, err.message);
    fs.unlink(filePath, () => {});
    return { success: false, filename, error: err.message };
  }
}

// ─── API Routes ────────────────────────────────────────────

// Single file (rate limited)
app.post('/api/convert', convertLimiter, upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Vui lòng chọn file để chuyển đổi' });
  }
  const result = await processOneFile(req.file);
  if (result.success) {
    res.json(result);
  } else {
    res.status(500).json({ error: result.error });
  }
});

// Batch: multiple files, process 2 concurrently (rate limited)
app.post('/api/convert-batch', convertLimiter, upload.array('files', 20), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'Vui lòng chọn ít nhất 1 file' });
  }

  const startTime = Date.now();
  const total = req.files.length;
  console.log(`\n📦 Batch: ${total} files received`);

  // Process with concurrency limit of 2
  const CONCURRENCY = 2;
  const results = [];
  const queue = [...req.files];

  async function worker() {
    while (queue.length > 0) {
      const file = queue.shift();
      if (file) {
        const result = await processOneFile(file);
        results.push(result);
      }
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(CONCURRENCY, total); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  const orderedResults = req.files.map((f) =>
    results.find((r) => r.filename === f.originalname) || { success: false, filename: f.originalname, error: 'Unknown error' }
  );

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const successCount = orderedResults.filter((r) => r.success).length;
  console.log(`\n📦 Batch done: ${successCount}/${total} OK in ${elapsed}s\n`);

  res.json({
    success: true,
    total,
    successCount,
    elapsed: `${elapsed}s`,
    results: orderedResults,
  });
});

// Health check (no sensitive info)
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// ─── Error handler ─────────────────────────────────────────

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'File quá lớn. Giới hạn 50MB.' });
    }
    return res.status(400).json({ error: err.message });
  }
  if (err) {
    return res.status(400).json({ error: err.message });
  }
  next();
});

app.listen(PORT, () => {
  console.log(`\n🚀 Vincode Tools running at http://localhost:${PORT}`);
  console.log(`   Mode: ${isProd ? 'production' : 'development'}\n`);
});
