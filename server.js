require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const WordExtractor = require('word-extractor');
const XLSX = require('xlsx');
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
    const allowed = ['.pdf', '.doc', '.docx', '.xlsx', '.xls', '.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tiff'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Không hỗ trợ định dạng ${ext}. Chấp nhận: PDF, Word, Excel, PNG, JPG, WebP, BMP, TIFF`));
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
 * Call AI API with retry + timeout
 */
async function callAI(messages, options = {}) {
  const apiKey = process.env.AI_API_KEY;
  const apiUrl = process.env.AI_API_URL;
  const model = options.model || process.env.AI_TEXT_MODEL || 'Qwen3-32B';
  const maxRetries = options.retries ?? 2;
  const timeoutMs = options.timeout ?? 90000; // 90s

  console.log(`   🤖 Calling model: ${model}`);

  const body = {
    model,
    messages,
    max_tokens: options.max_tokens || 8192,
    temperature: options.temperature ?? 0.2,
  };

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const resp = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!resp.ok) {
        const errText = await resp.text();
        // Parse clean error message
        let errMsg = `AI API lỗi (${resp.status})`;
        try {
          const errJson = JSON.parse(errText);
          errMsg = errJson.description || errJson.message || errMsg;
        } catch {
          if (errText.includes('timeout') || resp.status === 524) {
            errMsg = 'AI API timeout — server quá tải, thử lại sau';
          } else if (resp.status === 429) {
            errMsg = 'Rate limit — gửi quá nhiều request';
          }
        }

        // Retry on 5xx / 429
        if ((resp.status >= 500 || resp.status === 429) && attempt < maxRetries) {
          const wait = (attempt + 1) * 3000;
          console.warn(`   ⚠️ Retry ${attempt + 1}/${maxRetries} sau ${wait / 1000}s (${resp.status})`);
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }

        throw new Error(errMsg);
      }

      const data = await resp.json();
      let content = data.choices?.[0]?.message?.content || '';
      content = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      return content;
    } catch (err) {
      if (err.name === 'AbortError') {
        if (attempt < maxRetries) {
          console.warn(`   ⚠️ Timeout, retry ${attempt + 1}/${maxRetries}...`);
          continue;
        }
        throw new Error('AI API timeout — hết thời gian chờ');
      }
      if (attempt < maxRetries && !err.message.includes('token')) {
        console.warn(`   ⚠️ Error, retry ${attempt + 1}/${maxRetries}...`);
        await new Promise((r) => setTimeout(r, (attempt + 1) * 2000));
        continue;
      }
      throw err;
    }
  }
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
 * Process scanned PDF: convert pages to images, then OCR each page independently
 */
async function processScannedPDF(buffer, filename) {
  const images = await pdfToImages(buffer);

  if (images.length === 0) {
    throw new Error('Không thể render trang nào từ PDF');
  }

  // OCR each page independently — skip failed pages
  const pageResults = [];

  for (const img of images) {
    console.log(`   🔍 OCR page ${img.pageNum}/${images.length}...`);
    const pageContext = images.length > 1 ? ` (trang ${img.pageNum}/${images.length})` : '';
    try {
      const result = await processImageWithVision(img.base64, img.mime, filename, pageContext);
      pageResults.push({ pageNum: img.pageNum, content: result, ok: true });
    } catch (err) {
      console.warn(`   ⚠️ Page ${img.pageNum} failed: ${err.message}`);
      pageResults.push({ pageNum: img.pageNum, content: `> ⚠️ Trang ${img.pageNum}: Không thể OCR (${err.message})`, ok: false });
    }
  }

  // Check if all pages failed
  const okPages = pageResults.filter((p) => p.ok);
  if (okPages.length === 0) {
    throw new Error('Không thể OCR được trang nào. AI API có thể đang quá tải.');
  }

  if (pageResults.length === 1) {
    return pageResults[0].content;
  }

  return pageResults
    .map((p) => `<!-- Trang ${p.pageNum} -->\n\n${p.content}`)
    .join('\n\n---\n\n');
}

/**
 * Process Word document
 */
async function processWordDoc(filePath, filename) {
  const result = await mammoth.convertToHtml({ path: filePath });
  const html = result.value;

  const TurndownService = require('turndown');
  const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
  });

  let markdown = turndown.turndown(html);

  // Only AI polish if content is moderate size (< 50K chars ~ 40K tokens)
  if (markdown.length > 100 && markdown.length < 50000) {
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
  } else if (markdown.length >= 50000) {
    console.log(`   ⚠️ Doc quá lớn (${markdown.length} chars), skip AI polish`);
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
      // Old .doc binary format — extract text directly (no AI needed)
      method = 'Word (.doc) → Text Extract';
      console.log(`   📝 Word document (.doc)`);
      const extractor = new WordExtractor();
      const extracted = await extractor.extract(filePath);
      const text = extracted.getBody() || '';
      if (text.trim().length < 10) {
        throw new Error('Không thể đọc nội dung từ file .doc này. Vui lòng lưu lại dưới dạng .docx hoặc PDF.');
      }
      // Format text as basic markdown (no AI call = instant + no timeout)
      const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
      markdown = `# ${filename.replace(/\.doc$/i, '')}\n\n${lines.join('\n\n')}`;
    } else if (ext === '.docx') {
      method = 'Word → Markdown';
      console.log(`   📝 Word document (.docx)`);
      markdown = await processWordDoc(filePath, filename);
    } else if (['.xlsx', '.xls'].includes(ext)) {
      // Excel → Markdown tables (no AI needed)
      method = 'Excel → Markdown Table';
      console.log(`   📊 Excel file`);
      const workbook = XLSX.readFile(filePath);
      const sheets = [];
      for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName];
        const data = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
        if (data.length === 0) continue;

        let md = `## ${sheetName}\n\n`;
        // Header row
        const header = data[0].map((c) => String(c).trim());
        md += '| ' + header.join(' | ') + ' |\n';
        md += '| ' + header.map(() => '---').join(' | ') + ' |\n';
        // Data rows
        for (let r = 1; r < data.length; r++) {
          const row = data[r].map((c) => String(c).trim());
          md += '| ' + row.join(' | ') + ' |\n';
        }
        sheets.push(md);
      }
      if (sheets.length === 0) {
        throw new Error('File Excel trống hoặc không đọc được.');
      }
      markdown = `# ${filename.replace(/\.(xlsx|xls)$/i, '')}\n\n${sheets.join('\n\n---\n\n')}`;
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

  const orderedResults = req.files.map((f) => {
    const normalized = f.originalname.normalize('NFC');
    return results.find((r) => r.filename === normalized) || { success: false, filename: normalized, error: 'Unknown error' };
  });

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
