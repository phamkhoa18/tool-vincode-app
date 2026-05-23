/**
 * Vindocs — Frontend Application (Batch support)
 * Handles multi-file upload, conversion, and result display
 */

(function () {
  'use strict';

  // ─── DOM Elements ─────────────────────────────
  const uploadZone = document.getElementById('uploadZone');
  const fileInput = document.getElementById('fileInput');
  const browseBtn = document.getElementById('browseBtn');
  const fileList = document.getElementById('fileList');
  const convertBtn = document.getElementById('convertBtn');
  const convertBtnText = document.getElementById('convertBtnText');
  const progressSection = document.getElementById('progressSection');
  const progressFill = document.getElementById('progressFill');
  const progressText = document.getElementById('progressText');
  const resultsContainer = document.getElementById('resultsContainer');
  const errorSection = document.getElementById('errorSection');
  const errorText = document.getElementById('errorText');

  let selectedFiles = [];

  // Fix Vietnamese filenames (macOS NFD → NFC)
  function normalizeName(name) {
    return name.normalize('NFC');
  }

  // ─── File Selection ───────────────────────────

  browseBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    fileInput.click();
  });

  uploadZone.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      addFiles(Array.from(e.target.files));
    }
  });

  // ─── Drag & Drop ─────────────────────────────

  uploadZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadZone.classList.add('dragover');
  });

  uploadZone.addEventListener('dragleave', (e) => {
    e.preventDefault();
    uploadZone.classList.remove('dragover');
  });

  uploadZone.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadZone.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) {
      addFiles(Array.from(e.dataTransfer.files));
    }
  });

  // ─── File Handling ────────────────────────────

  const ALLOWED = ['.pdf', '.doc', '.docx', '.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tiff'];

  function addFiles(files) {
    hideError();

    for (const file of files) {
      const ext = '.' + file.name.split('.').pop().toLowerCase();
      if (!ALLOWED.includes(ext)) {
        showError(`Bỏ qua ${file.name} — không hỗ trợ định dạng ${ext}`);
        continue;
      }
      // Avoid duplicates
      if (!selectedFiles.find((f) => f.name === file.name && f.size === file.size)) {
        selectedFiles.push(file);
      }
    }

    renderFileList();
    updateConvertBtn();
  }

  function removeFile(index) {
    selectedFiles.splice(index, 1);
    renderFileList();
    updateConvertBtn();
  }

  function clearAllFiles() {
    selectedFiles = [];
    fileInput.value = '';
    renderFileList();
    updateConvertBtn();
  }

  function renderFileList() {
    if (selectedFiles.length === 0) {
      fileList.hidden = true;
      fileList.innerHTML = '';
      return;
    }

    fileList.hidden = false;

    const header =
      selectedFiles.length > 1
        ? `<div class="file-list-header">
            <span class="file-count">${selectedFiles.length} file</span>
            <button class="clear-all-btn" id="clearAllBtn">Xóa tất cả</button>
           </div>`
        : '';

    const items = selectedFiles
      .map(
        (f, i) => `
      <div class="file-item" data-index="${i}">
        <div class="file-item-left">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
          </svg>
          <span class="file-name">${escapeHtml(normalizeName(f.name))}</span>
          <span class="file-size">${formatSize(f.size)}</span>
        </div>
        <button class="remove-btn" data-index="${i}" title="Xóa">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>`
      )
      .join('');

    fileList.innerHTML = header + items;

    // Bind remove buttons
    fileList.querySelectorAll('.remove-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeFile(parseInt(btn.dataset.index));
      });
    });

    // Bind clear all
    const clearAllBtn = document.getElementById('clearAllBtn');
    if (clearAllBtn) {
      clearAllBtn.addEventListener('click', clearAllFiles);
    }
  }

  function updateConvertBtn() {
    const count = selectedFiles.length;
    convertBtn.disabled = count === 0;
    convertBtnText.textContent =
      count <= 1 ? 'Chuyển đổi sang Markdown' : `Chuyển đổi ${count} file sang Markdown`;
  }

  // ─── Convert ─────────────────────────────────

  convertBtn.addEventListener('click', async () => {
    if (selectedFiles.length === 0) return;

    hideError();
    clearResults();
    showProgress();

    try {
      if (selectedFiles.length === 1) {
        await convertSingle(selectedFiles[0]);
      } else {
        await convertBatch(selectedFiles);
      }
    } catch (err) {
      hideProgress();
      showError(err.message);
    }
  });

  async function convertSingle(file) {
    let progress = 0;
    const interval = setInterval(() => {
      progress = Math.min(progress + Math.random() * 8, 85);
      progressFill.style.width = progress + '%';
    }, 500);

    updateProgressText(`Đang xử lý ${normalizeName(file.name)}...`);

    const formData = new FormData();
    formData.append('file', file);

    const resp = await fetch('/api/convert', { method: 'POST', body: formData });
    clearInterval(interval);

    if (!resp.ok) {
      const err = await resp.json();
      throw new Error(err.error || `Lỗi server (${resp.status})`);
    }

    progressFill.style.width = '100%';
    updateProgressText('Hoàn tất!');

    const data = await resp.json();

    setTimeout(() => {
      hideProgress();
      appendResult(data);
    }, 300);
  }

  async function convertBatch(files) {
    updateProgressText(`Đang tải ${files.length} file lên...`);
    progressFill.style.width = '10%';

    const formData = new FormData();
    files.forEach((f) => formData.append('files', f));

    // Fake progress while waiting
    let progress = 10;
    const interval = setInterval(() => {
      progress = Math.min(progress + Math.random() * 3, 85);
      progressFill.style.width = progress + '%';
      const done = Math.floor(progress / (85 / files.length));
      updateProgressText(`Đang xử lý... (~${Math.min(done, files.length)}/${files.length} file)`);
    }, 1000);

    const resp = await fetch('/api/convert-batch', { method: 'POST', body: formData });
    clearInterval(interval);

    if (!resp.ok) {
      const err = await resp.json();
      throw new Error(err.error || `Lỗi server (${resp.status})`);
    }

    progressFill.style.width = '100%';

    const data = await resp.json();

    updateProgressText(`Hoàn tất ${data.successCount}/${data.total} file trong ${data.elapsed}`);

    setTimeout(() => {
      hideProgress();

      // Show each result
      for (const r of data.results) {
        if (r.success) {
          appendResult(r);
        } else {
          appendErrorResult(r);
        }
      }
    }, 400);
  }

  // ─── Progress ─────────────────────────────────

  function showProgress() {
    progressSection.hidden = false;
    progressFill.style.width = '0%';
    convertBtn.disabled = true;
  }

  function hideProgress() {
    progressSection.hidden = true;
    progressFill.style.width = '0%';
    updateConvertBtn();
  }

  function updateProgressText(text) {
    progressText.textContent = text;
  }

  // ─── Results ──────────────────────────────────

  function appendResult(data) {
    const id = 'result-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);

    const baseName = normalizeName(data.filename).replace(/\.[^/.]+$/, '');

    const section = document.createElement('div');
    section.className = 'result-section';
    section.id = id;
    section.innerHTML = `
      <div class="result-toolbar">
        <div class="result-meta">
          <input class="result-filename-input" type="text" value="${escapeHtml(baseName)}" spellcheck="false" />
          <span class="result-ext">.md</span>
          <span class="result-badge">${escapeHtml(data.method)}</span>
          <span class="result-time">${data.elapsed}</span>
        </div>
        <div class="result-actions">
          <button class="action-btn copy-btn" title="Sao chép">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
            </svg>
            <span>Copy</span>
          </button>
          <button class="action-btn download-btn" title="Tải xuống">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            <span>.md</span>
          </button>
          <div class="view-toggle">
            <button class="toggle-btn active raw-btn">Raw</button>
            <button class="toggle-btn preview-btn">Preview</button>
          </div>
        </div>
      </div>
      <div class="result-content">
        <pre class="markdown-raw">${escapeHtml(data.markdown)}</pre>
        <div class="markdown-preview" hidden>${renderMarkdown(data.markdown)}</div>
      </div>
    `;

    resultsContainer.appendChild(section);

    // Bind actions
    const copyBtn = section.querySelector('.copy-btn');
    copyBtn.addEventListener('click', () => {
      copyToClipboard(data.markdown);
      copyBtn.classList.add('copied');
      copyBtn.querySelector('span').textContent = 'Đã copy!';
      showToast('Đã sao chép');
      setTimeout(() => {
        copyBtn.classList.remove('copied');
        copyBtn.querySelector('span').textContent = 'Copy';
      }, 2000);
    });

    const nameInput = section.querySelector('.result-filename-input');

    const dlBtn = section.querySelector('.download-btn');
    dlBtn.addEventListener('click', () => {
      const customName = nameInput.value.trim() || baseName;
      downloadMarkdown(customName, data.markdown);
    });

    const rawBtn = section.querySelector('.raw-btn');
    const prevBtn = section.querySelector('.preview-btn');
    const rawEl = section.querySelector('.markdown-raw');
    const prevEl = section.querySelector('.markdown-preview');

    rawBtn.addEventListener('click', () => {
      rawEl.hidden = false;
      prevEl.hidden = true;
      rawBtn.classList.add('active');
      prevBtn.classList.remove('active');
    });

    prevBtn.addEventListener('click', () => {
      rawEl.hidden = true;
      prevEl.hidden = false;
      prevBtn.classList.add('active');
      rawBtn.classList.remove('active');
    });
  }

  function appendErrorResult(data) {
    const section = document.createElement('div');
    section.className = 'result-error';
    section.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
      </svg>
      <span class="result-error-name">${escapeHtml(data.filename)}</span>
      <span class="result-error-msg">${escapeHtml(data.error)}</span>
    `;
    resultsContainer.appendChild(section);
  }

  function clearResults() {
    resultsContainer.innerHTML = '';
  }

  // ─── Error ────────────────────────────────────

  function showError(msg) {
    errorText.textContent = msg;
    errorSection.hidden = false;
  }

  function hideError() {
    errorSection.hidden = true;
  }

  // ─── Helpers ──────────────────────────────────

  function copyToClipboard(text) {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
  }

  function downloadMarkdown(baseName, markdown) {
    const blob = new Blob([markdown], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${baseName}.md`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Đang tải ' + baseName + '.md');
  }

  function renderMarkdown(md) {
    if (typeof marked !== 'undefined') {
      marked.setOptions({ breaks: true, gfm: true });
      return marked.parse(md);
    }
    return '<pre>' + escapeHtml(md) + '</pre>';
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function showToast(msg) {
    let toast = document.querySelector('.toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'toast';
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2000);
  }
})();
