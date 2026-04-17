/**
 * ShieldPlate · Web workstation
 * Real browser-side image redaction + frame-by-frame video watermarking.
 */

(function () {
  'use strict';

  const HISTORY_DB = 'shieldplate-history-v1';
  const HISTORY_STORE = 'records';
  const SETTINGS_KEY = 'shieldplate-settings-v1';
  const DEFAULT_IMAGE_BOX = { x: 0.36, y: 0.66, w: 0.24, h: 0.09 };

  const state = {
    activeTab: 'upload',
    images: [],
    videos: [],
    currentImageIndex: -1,
    currentVideoIndex: -1,
    blurStyle: 'blur',
    blurIntensity: 6,
    selectedPlateId: null,
    selectedTrackId: null,
    imageViewMode: 'original',
    history: [],
    stats: { processed: 0, batch: 0, detect: 0 },
    db: null,
    historyFilter: '全部',
    historyQuery: '',
    settings: {
      autoDownload: false,
      keepExif: true,
      concurrency: 2,
      keepVideoAudio: true,
      defaultBlur: 10,
      defaultBrandName: 'ShieldPlate',
    },
    imageDrag: null,
    videoDrag: null,
    toastTimer: null,
    videoProcessing: false,
  };

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));

  function uid(prefix = 'id') {
    return `${prefix}-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function formatTime(seconds) {
    const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
    const m = Math.floor(safe / 60);
    const s = Math.floor(safe % 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function formatDateTime(ts) {
    return new Intl.DateTimeFormat('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(ts));
  }

  function safeBaseName(fileName) {
    return fileName.replace(/\.[^/.]+$/, '');
  }

  function buildDownloadName(fileName, suffix, extension) {
    return `${safeBaseName(fileName)}-${suffix}.${extension}`;
  }

  function getDevicePixelRatio() {
    return window.devicePixelRatio || 1;
  }

  function debounce(fn, wait) {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), wait);
    };
  }

  function containsIoU(a, b) {
    const ax2 = a.x + a.w;
    const ay2 = a.y + a.h;
    const bx2 = b.x + b.w;
    const by2 = b.y + b.h;

    const interX1 = Math.max(a.x, b.x);
    const interY1 = Math.max(a.y, b.y);
    const interX2 = Math.min(ax2, bx2);
    const interY2 = Math.min(ay2, by2);
    const interW = Math.max(0, interX2 - interX1);
    const interH = Math.max(0, interY2 - interY1);
    const interArea = interW * interH;
    const unionArea = a.w * a.h + b.w * b.h - interArea;
    return unionArea > 0 ? interArea / unionArea : 0;
  }

  function roundRectPath(ctx, x, y, w, h, r) {
    const radius = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + w - radius, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
    ctx.lineTo(x + w, y + h - radius);
    ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
    ctx.lineTo(x + radius, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
  }

  function groupedSegments(arr, threshold, minLength) {
    const segments = [];
    let start = -1;
    let sum = 0;
    let count = 0;

    for (let i = 0; i < arr.length; i += 1) {
      if (arr[i] >= threshold) {
        if (start === -1) {
          start = i;
          sum = 0;
          count = 0;
        }
        sum += arr[i];
        count += 1;
      } else if (start !== -1) {
        if ((i - start) >= minLength) {
          segments.push({ start, end: i - 1, avg: sum / Math.max(count, 1) });
        }
        start = -1;
      }
    }

    if (start !== -1 && (arr.length - start) >= minLength) {
      segments.push({ start, end: arr.length - 1, avg: sum / Math.max(count, 1) });
    }

    return segments;
  }

  function meanAndStd(values) {
    if (!values.length) return { mean: 0, std: 0 };
    const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
    const variance = values.reduce((sum, v) => sum + ((v - mean) ** 2), 0) / values.length;
    return { mean, std: Math.sqrt(variance) };
  }

  function smoothSignal(values, radius = 2) {
    const out = new Float32Array(values.length);
    for (let i = 0; i < values.length; i += 1) {
      let sum = 0;
      let count = 0;
      for (let j = Math.max(0, i - radius); j <= Math.min(values.length - 1, i + radius); j += 1) {
        sum += values[j];
        count += 1;
      }
      out[i] = sum / Math.max(count, 1);
    }
    return out;
  }

  function createFallbackBox() {
    return {
      id: uid('plate'),
      label: '手动候选',
      confidence: 0.35,
      source: 'fallback',
      ...DEFAULT_IMAGE_BOX,
    };
  }

  function normalizeBox(box) {
    return {
      ...box,
      x: clamp(box.x, 0, 1),
      y: clamp(box.y, 0, 1),
      w: clamp(box.w, 0.04, 1),
      h: clamp(box.h, 0.03, 1),
    };
  }

  function fitContainRect(sourceWidth, sourceHeight, targetWidth, targetHeight) {
    const ratio = Math.min(targetWidth / sourceWidth, targetHeight / sourceHeight);
    const width = sourceWidth * ratio;
    const height = sourceHeight * ratio;
    return {
      x: (targetWidth - width) / 2,
      y: (targetHeight - height) / 2,
      width,
      height,
    };
  }

  function boxToPixels(box, mediaWidth, mediaHeight) {
    return {
      x: Math.round(box.x * mediaWidth),
      y: Math.round(box.y * mediaHeight),
      w: Math.round(box.w * mediaWidth),
      h: Math.round(box.h * mediaHeight),
    };
  }

  function currentImage() {
    return state.currentImageIndex >= 0 ? state.images[state.currentImageIndex] : null;
  }

  function currentVideo() {
    return state.currentVideoIndex >= 0 ? state.videos[state.currentVideoIndex] : null;
  }

  function syncStyleSelections() {
    $$('.style-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.style === state.blurStyle);
    });
    const slider = $('#intensitySlider');
    const val = $('#intensityVal');
    if (slider) slider.value = String(state.blurIntensity);
    if (val) val.textContent = String(state.blurIntensity);
    const videoSelect = $('#videoStyleSelect');
    if (videoSelect) videoSelect.value = state.blurStyle;
  }

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      state.settings = { ...state.settings, ...saved };
      if (saved.defaultBlur) state.blurIntensity = saved.defaultBlur;
    } catch (error) {
      console.warn('Failed to load settings', error);
    }
  }

  function persistSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
    } catch (error) {
      console.warn('Failed to persist settings', error);
    }
  }

  function applySettingsToControls() {
    const map = {
      setAutoDl: state.settings.autoDownload,
      setExif: state.settings.keepExif,
      keepVideoAudioToggle: state.settings.keepVideoAudio,
    };
    Object.entries(map).forEach(([id, checked]) => {
      const input = document.getElementById(id);
      if (input) input.checked = checked;
    });

    const blurDefault = $('#setBlurDefault');
    if (blurDefault) blurDefault.value = String(state.settings.defaultBlur);
    const blurVal = $('#setBlurVal');
    if (blurVal) blurVal.textContent = String(state.settings.defaultBlur);

    const concurrency = $('#setConcurrency');
    if (concurrency) concurrency.value = String(state.settings.concurrency);

    const brand = $('#setBrandName');
    if (brand) brand.value = state.settings.defaultBrandName;

    const wmText = $('#wmText');
    if (wmText && !wmText.value) wmText.value = state.settings.defaultBrandName;

    syncStyleSelections();
  }

  async function openHistoryDB() {
    if (!('indexedDB' in window)) return null;

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(HISTORY_DB, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(HISTORY_STORE)) {
          const store = db.createObjectStore(HISTORY_STORE, { keyPath: 'id' });
          store.createIndex('createdAt', 'createdAt');
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function historyStorePut(record) {
    if (!state.db) return;
    await new Promise((resolve, reject) => {
      const tx = state.db.transaction(HISTORY_STORE, 'readwrite');
      tx.objectStore(HISTORY_STORE).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function historyStoreDelete(id) {
    if (!state.db) return;
    await new Promise((resolve, reject) => {
      const tx = state.db.transaction(HISTORY_STORE, 'readwrite');
      tx.objectStore(HISTORY_STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function historyStoreClear() {
    if (!state.db) return;
    await new Promise((resolve, reject) => {
      const tx = state.db.transaction(HISTORY_STORE, 'readwrite');
      tx.objectStore(HISTORY_STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function historyStoreReadAll() {
    if (!state.db) return [];
    return new Promise((resolve, reject) => {
      const tx = state.db.transaction(HISTORY_STORE, 'readonly');
      const request = tx.objectStore(HISTORY_STORE).getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }

  async function hydrateHistory() {
    try {
      state.history = await historyStoreReadAll();
      state.history.sort((a, b) => b.createdAt - a.createdAt);
      renderHistory();
    } catch (error) {
      console.warn('Failed to load history', error);
    }
  }

  function makeHistoryThumbFallback(type) {
    return type === 'video'
      ? 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(`
        <svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180">
          <rect width="320" height="180" rx="18" fill="#151823"/>
          <rect x="92" y="48" width="122" height="84" rx="16" fill="none" stroke="#00B0FF" stroke-width="6"/>
          <path d="M214 76l42-22v72l-42-22" fill="none" stroke="#00B0FF" stroke-width="6" stroke-linejoin="round"/>
        </svg>`)
      : 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(`
        <svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180">
          <rect width="320" height="180" rx="18" fill="#151823"/>
          <rect x="70" y="42" width="180" height="96" rx="16" fill="none" stroke="#FF6B00" stroke-width="6"/>
          <rect x="106" y="82" width="108" height="30" rx="8" fill="#FF6B00" opacity=".28"/>
        </svg>`);
  }

  async function addHistoryRecord(record) {
    const next = {
      ...record,
      createdAt: record.createdAt || Date.now(),
      previewDataUrl: record.previewDataUrl || makeHistoryThumbFallback(record.type),
    };
    state.history = [next, ...state.history.filter((item) => item.id !== next.id)];
    await historyStorePut(next);
    renderHistory();
  }

  async function deleteHistoryRecord(id) {
    state.history = state.history.filter((item) => item.id !== id);
    await historyStoreDelete(id);
    renderHistory();
  }

  function updateStats() {
    const processed = [
      ...state.images.filter((item) => item.processed),
      ...state.videos.filter((item) => item.processed),
    ].length;

    state.stats.processed = processed;
    state.stats.batch = state.images.length + state.videos.length;
    state.stats.detect = state.images.reduce((sum, item) => sum + item.boxes.length, 0)
      + state.videos.reduce((sum, item) => sum + item.tracks.length, 0);

    const map = {
      statProcessed: state.stats.processed,
      statBatch: state.stats.batch,
      statDetect: state.stats.detect,
    };
    Object.entries(map).forEach(([id, value]) => {
      const el = document.getElementById(id);
      if (el) el.textContent = String(value);
    });
  }

  function showToast(title, sub = '', type = 'info', sticky = false) {
    const toast = $('#toast');
    if (!toast) return;

    const titleEl = $('#toastTitle');
    const subEl = $('#toastSub');
    const iconEl = $('#toastIcon');
    const progressWrap = $('#toastProgressWrap');
    const progress = $('#toastProgress');

    if (titleEl) titleEl.textContent = title;
    if (subEl) subEl.textContent = sub;
    if (progressWrap) progressWrap.style.display = type === 'progress' ? '' : 'none';
    if (progress) progress.style.width = '0%';

    const icons = {
      success: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" stroke="#00C853" stroke-width="1.5"/><path d="M5 8.5l2 2 4-4" stroke="#00C853" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      error: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" stroke="#FF1744" stroke-width="1.5"/><path d="M5 5l6 6M11 5l-6 6" stroke="#FF1744" stroke-width="1.5" stroke-linecap="round"/></svg>',
      warning: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 2.2L14.5 13H1.5L8 2.2z" stroke="#FFB300" stroke-width="1.5" stroke-linejoin="round"/><path d="M8 6v3.8M8 11.4v.6" stroke="#FFB300" stroke-width="1.5" stroke-linecap="round"/></svg>',
      progress: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" style="animation:spin 1s linear infinite"><circle cx="8" cy="8" r="7" stroke="#FF6B00" stroke-width="1.5" stroke-dasharray="20 28"/></svg>',
      info: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" stroke="#00E5FF" stroke-width="1.5"/><path d="M8 7v4M8 4.6v.6" stroke="#00E5FF" stroke-width="1.5" stroke-linecap="round"/></svg>',
    };
    if (iconEl) iconEl.innerHTML = icons[type] || icons.info;

    toast.style.display = 'flex';
    clearTimeout(state.toastTimer);
    if (!sticky && type !== 'progress') {
      state.toastTimer = setTimeout(() => {
        toast.style.display = 'none';
      }, 2600);
    }
  }

  function updateToastProgress(progressRatio, text) {
    const bar = $('#toastProgress');
    const sub = $('#toastSub');
    if (bar) bar.style.width = `${Math.round(progressRatio * 100)}%`;
    if (sub && text) sub.textContent = text;
  }

  function updateVideoJob(progressRatio, text) {
    const fill = $('#videoJobFill');
    const pct = $('#videoJobPct');
    const sub = $('#videoJobSub');
    if (fill) fill.style.width = `${Math.round(progressRatio * 100)}%`;
    if (pct) pct.textContent = `${Math.round(progressRatio * 100)}%`;
    if (sub && text) sub.textContent = text;
  }

  function switchTab(tab) {
    state.activeTab = tab;
    $$('.nav-item').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    $$('.panel').forEach((panel) => {
      panel.classList.toggle('active', panel.id === `panel-${tab}`);
    });

    const names = {
      upload: '上传素材',
      image: '图片处理',
      video: '视频处理',
      watermark: '水印模板',
      history: '处理历史',
      settings: '设置',
    };
    const tabName = $('#tabName');
    if (tabName) tabName.textContent = names[tab] || tab;

    const dot = $('.tab-dot');
    if (dot) {
      dot.style.background = tab === 'video' ? 'var(--accent2)' : 'var(--accent)';
    }

    if (tab === 'image') renderImageWorkspace();
    if (tab === 'video') renderVideoWorkspace();
    if (tab === 'history') renderHistory();
  }

  function createEmptyCanvasState(iconMarkup, text) {
    return `
      <div class="canvas-empty">
        ${iconMarkup}
        <p>${text}</p>
      </div>
    `;
  }

  function createCanvasStage(container, mode) {
    const isVideo = mode === 'video';
    container.innerHTML = `
      <div class="canvas-stage ${isVideo ? 'video-stage' : 'image-stage'}">
        ${!isVideo ? `
          <div class="canvas-toolbar">
            <button class="canvas-mode-btn ${state.imageViewMode === 'original' ? 'active' : ''}" data-mode="original">原图与框</button>
            <button class="canvas-mode-btn ${state.imageViewMode === 'processed' ? 'active' : ''}" data-mode="processed">打码结果</button>
          </div>
        ` : ''}
        <canvas class="media-canvas" id="${isVideo ? 'videoStageCanvas' : 'imageStageCanvas'}"></canvas>
        <div class="canvas-overlay ${isVideo ? 'video-overlay-layer' : ''}" id="${isVideo ? 'videoOverlayLayer' : 'imageOverlayLayer'}"></div>
      </div>
    `;
  }

  function fileToObjectURL(file) {
    return URL.createObjectURL(file);
  }

  async function loadImageElement(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  async function loadVideoMetadata(src) {
    return new Promise((resolve, reject) => {
      const video = document.createElement('video');
      video.preload = 'metadata';
      video.src = src;
      video.muted = true;
      video.playsInline = true;
      video.onloadedmetadata = () => {
        resolve({
          duration: video.duration || 0,
          width: video.videoWidth || 1280,
          height: video.videoHeight || 720,
        });
      };
      video.onerror = reject;
    });
  }

  async function captureVideoPoster(src, time = 0.1) {
    return new Promise((resolve, reject) => {
      const video = document.createElement('video');
      video.preload = 'auto';
      video.src = src;
      video.muted = true;
      video.playsInline = true;
      video.onloadeddata = async () => {
        const seekTime = clamp(time, 0, Math.max((video.duration || 0) - 0.05, 0));
        const finalize = () => {
          const canvas = document.createElement('canvas');
          canvas.width = video.videoWidth || 960;
          canvas.height = video.videoHeight || 540;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/jpeg', 0.82));
        };
        if (Number.isFinite(video.duration) && video.duration > 0) {
          video.currentTime = seekTime;
          video.onseeked = finalize;
        } else {
          finalize();
        }
      };
      video.onerror = reject;
    });
  }

  async function dataUrlFromBlob(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  function makeBoxLabel(index, source) {
    if (source === 'manual') return `手动框 ${index + 1}`;
    if (source === 'fallback') return `候选框 ${index + 1}`;
    return `识别框 ${index + 1}`;
  }

  function detectPlateCandidatesFromCanvas(sourceCanvas, sourceWidth, sourceHeight) {
    const maxWidth = 720;
    const scale = Math.min(1, maxWidth / sourceWidth);
    const width = Math.max(64, Math.round(sourceWidth * scale));
    const height = Math.max(64, Math.round(sourceHeight * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(sourceCanvas, 0, 0, width, height);

    const { data } = ctx.getImageData(0, 0, width, height);
    const gray = new Float32Array(width * height);
    for (let i = 0; i < gray.length; i += 1) {
      const idx = i * 4;
      gray[i] = data[idx] * 0.299 + data[idx + 1] * 0.587 + data[idx + 2] * 0.114;
    }

    const rowScore = new Float32Array(height);
    for (let y = 0; y < height; y += 1) {
      let sum = 0;
      for (let x = 1; x < width; x += 1) {
        sum += Math.abs(gray[y * width + x] - gray[y * width + x - 1]);
      }
      rowScore[y] = sum / width;
    }

    const smoothRows = smoothSignal(rowScore, 3);
    const rowStats = meanAndStd(Array.from(smoothRows));
    const rowThreshold = rowStats.mean + (rowStats.std * 0.75);
    const rowBands = groupedSegments(smoothRows, rowThreshold, Math.max(4, Math.round(height * 0.012)));

    const candidates = [];

    rowBands.forEach((band) => {
      const y1 = Math.max(0, band.start - 4);
      const y2 = Math.min(height - 1, band.end + 4);
      const bandHeight = y2 - y1 + 1;
      const colScore = new Float32Array(width);

      for (let x = 1; x < width; x += 1) {
        let sum = 0;
        for (let y = y1; y <= y2; y += 1) {
          sum += Math.abs(gray[y * width + x] - gray[y * width + x - 1]);
        }
        colScore[x] = sum / bandHeight;
      }

      const smoothCols = smoothSignal(colScore, 2);
      const colStats = meanAndStd(Array.from(smoothCols));
      const colThreshold = colStats.mean + (colStats.std * 0.55);
      const colBands = groupedSegments(smoothCols, colThreshold, Math.max(10, Math.round(width * 0.018)));

      colBands.forEach((colBand) => {
        const x1 = Math.max(0, colBand.start - 6);
        const x2 = Math.min(width - 1, colBand.end + 6);
        const boxWidth = x2 - x1 + 1;
        const boxHeight = bandHeight;
        const ratio = boxWidth / Math.max(boxHeight, 1);
        const areaRatio = (boxWidth * boxHeight) / (width * height);
        const centerY = (y1 + y2) / 2 / height;
        const centerBias = 1 - Math.abs(centerY - 0.68);

        if (ratio < 2 || ratio > 7) return;
        if (areaRatio < 0.002 || areaRatio > 0.16) return;

        let brightnessSum = 0;
        let brightnessCount = 0;
        for (let y = y1; y <= y2; y += 2) {
          for (let x = x1; x <= x2; x += 2) {
            brightnessSum += gray[y * width + x];
            brightnessCount += 1;
          }
        }
        const brightness = brightnessSum / Math.max(brightnessCount, 1);
        const brightnessScore = brightness > 70 && brightness < 220 ? 1 : 0.5;

        const score = ((band.avg * 0.45) + (colBand.avg * 0.35) + (centerBias * 40) + (brightnessScore * 18));
        candidates.push({
          x: x1 / width,
          y: y1 / height,
          w: boxWidth / width,
          h: boxHeight / height,
          score,
        });
      });
    });

    candidates.sort((a, b) => b.score - a.score);
    const deduped = [];
    candidates.forEach((candidate) => {
      if (deduped.length >= 3) return;
      const overlap = deduped.some((existing) => containsIoU(existing, candidate) > 0.34);
      if (!overlap) deduped.push(candidate);
    });

    const finalBoxes = (deduped.length ? deduped : [createFallbackBox()]).map((candidate, index) => normalizeBox({
      id: uid('plate'),
      label: candidate.label || makeBoxLabel(index, deduped.length ? 'auto' : 'fallback'),
      confidence: clamp((candidate.score || 42) / 120, 0.35, 0.99),
      source: deduped.length ? 'auto' : 'fallback',
      x: candidate.x,
      y: candidate.y,
      w: candidate.w,
      h: candidate.h,
    }));

    return finalBoxes;
  }

  async function detectPlatesFromImageURL(url, width, height) {
    const image = await loadImageElement(url);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, 0, 0, width, height);
    return detectPlateCandidatesFromCanvas(canvas, width, height);
  }

  async function detectPlatesFromVideoFrame(video) {
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return detectPlateCandidatesFromCanvas(canvas, canvas.width, canvas.height);
  }

  function addImageEntryThumbHandlers() {
    $$('.thumb-item').forEach((item) => {
      item.addEventListener('click', () => {
        const index = Number(item.dataset.index);
        loadImage(index);
      });
    });
  }

  function renderImageThumbs() {
    const scroll = $('#thumbScroll');
    const count = $('#thumbCount');
    const badge = $('#imgBadge');
    if (!scroll) return;

    if (count) count.textContent = String(state.images.length);
    if (badge) {
      badge.textContent = String(state.images.length);
      badge.style.display = state.images.length ? '' : 'none';
    }

    scroll.innerHTML = state.images.map((entry, index) => `
      <div class="thumb-item ${state.currentImageIndex === index ? 'active' : ''}" data-index="${index}">
        <img src="${entry.url}" alt="${entry.name}" />
        <div class="thumb-status ${entry.status}"></div>
      </div>
    `).join('');
    addImageEntryThumbHandlers();
  }

  function renderDetectionList() {
    const list = $('#detectionList');
    const count = $('#plateCount');
    const entry = currentImage();
    if (!list) return;

    if (!entry) {
      list.innerHTML = `
        <div class="detection-empty">
          <svg width="40" height="40" viewBox="0 0 40 40" fill="none"><circle cx="20" cy="20" r="18" stroke="#333" stroke-width="1.5" stroke-dasharray="3 3"/><path d="M14 20h12M20 14v12" stroke="#333" stroke-width="1.5" stroke-linecap="round"/></svg>
          <p>暂无检测结果</p>
        </div>`;
      if (count) count.textContent = '0 个车牌';
      return;
    }

    if (count) count.textContent = `${entry.boxes.length} 个车牌`;
    list.innerHTML = entry.boxes.length ? entry.boxes.map((box, index) => `
      <div class="detection-item ${state.selectedPlateId === box.id ? 'selected' : ''}" data-box-id="${box.id}">
        <div class="detection-icon">${String(index + 1).padStart(2, '0')}</div>
        <div class="detection-info">
          <div class="detection-plate">${box.label || makeBoxLabel(index, box.source)}</div>
          <div class="detection-meta">${box.source === 'manual' ? '手动框' : '自动候选'} · 置信度 ${Math.round((box.confidence || 0.86) * 100)}%</div>
        </div>
        <div class="detection-actions">
          <button class="detection-action-btn edit" data-action="focus" data-box-id="${box.id}" title="定位">定位</button>
          <button class="detection-action-btn delete" data-action="delete" data-box-id="${box.id}" title="删除">×</button>
        </div>
      </div>
    `).join('') : `
      <div class="detection-empty">
        <svg width="40" height="40" viewBox="0 0 40 40" fill="none"><circle cx="20" cy="20" r="18" stroke="#333" stroke-width="1.5" stroke-dasharray="3 3"/><path d="M14 20h12M20 14v12" stroke="#333" stroke-width="1.5" stroke-linecap="round"/></svg>
        <p>暂无检测结果</p>
      </div>`;

    $$('.detection-item').forEach((item) => {
      item.addEventListener('click', (event) => {
        const boxId = item.dataset.boxId;
        const action = event.target.closest('[data-action]')?.dataset.action;
        if (action === 'delete') {
          removeCurrentImageBox(boxId);
          return;
        }
        state.selectedPlateId = boxId;
        renderDetectionList();
        renderImageWorkspace();
      });
    });
  }

  function renderImageWorkspace() {
    renderImageThumbs();
    renderDetectionList();

    const wrap = $('#imageCanvas');
    const entry = currentImage();
    if (!wrap) return;

    if (!entry) {
      wrap.innerHTML = createEmptyCanvasState(
        '<svg width="64" height="64" viewBox="0 0 64 64" fill="none"><rect x="4" y="8" width="56" height="48" rx="6" stroke="#333" stroke-width="1.5" stroke-dasharray="4 4"/><path d="M24 32h16M32 24v16" stroke="#333" stroke-width="1.5" stroke-linecap="round"/></svg>',
        '上传图片后在画布中预览并调整'
      );
      return;
    }

    createCanvasStage(wrap, 'image');
    const originalBtn = wrap.querySelector('[data-mode="original"]');
    const processedBtn = wrap.querySelector('[data-mode="processed"]');
    if (processedBtn) processedBtn.disabled = !entry.processedUrl;
    originalBtn?.addEventListener('click', () => {
      state.imageViewMode = 'original';
      renderImageWorkspace();
    });
    processedBtn?.addEventListener('click', () => {
      if (!entry.processedUrl) return;
      state.imageViewMode = 'processed';
      renderImageWorkspace();
    });

    drawImageStage(entry).catch((error) => {
      console.error(error);
      wrap.innerHTML = createEmptyCanvasState(
        '<svg width="64" height="64" viewBox="0 0 64 64" fill="none"><circle cx="32" cy="32" r="28" stroke="#FF1744" stroke-width="1.5" stroke-dasharray="4 4"/><path d="M24 24l16 16M40 24L24 40" stroke="#FF1744" stroke-width="1.5" stroke-linecap="round"/></svg>',
        '图片预览失败，请重新上传'
      );
    });
  }

  async function drawImageStage(entry) {
    const wrap = $('#imageCanvas');
    const canvas = $('#imageStageCanvas');
    const overlay = $('#imageOverlayLayer');
    if (!wrap || !canvas || !overlay) return;

    const source = state.imageViewMode === 'processed' && entry.processedUrl
      ? await loadImageElement(entry.processedUrl)
      : await loadImageElement(entry.url);

    const stageWidth = Math.max(320, wrap.clientWidth - 2);
    const stageHeight = Math.max(320, wrap.clientHeight - 2);
    const fit = fitContainRect(source.width, source.height, stageWidth, stageHeight);
    entry.displayRect = fit;

    const dpr = getDevicePixelRatio();
    canvas.width = stageWidth * dpr;
    canvas.height = stageHeight * dpr;
    canvas.style.width = `${stageWidth}px`;
    canvas.style.height = `${stageHeight}px`;

    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, stageWidth, stageHeight);
    ctx.fillStyle = '#0A0A0D';
    ctx.fillRect(0, 0, stageWidth, stageHeight);
    ctx.drawImage(source, fit.x, fit.y, fit.width, fit.height);

    overlay.innerHTML = '';
    if (state.imageViewMode === 'original') {
      entry.boxes.forEach((box, index) => {
        const el = document.createElement('div');
        el.className = `plate-box ${state.selectedPlateId === box.id ? 'selected' : ''}`;
        el.dataset.boxId = box.id;
        el.style.left = `${fit.x + fit.width * box.x}px`;
        el.style.top = `${fit.y + fit.height * box.y}px`;
        el.style.width = `${fit.width * box.w}px`;
        el.style.height = `${fit.height * box.h}px`;
        el.innerHTML = `
          <div class="plate-box-label">${box.label || makeBoxLabel(index, box.source)}</div>
          <button class="plate-box-delete" title="删除" data-box-id="${box.id}">×</button>
          <span class="plate-box-handle" data-handle="resize"></span>
        `;
        el.addEventListener('pointerdown', (event) => beginImageBoxDrag(event, box.id, event.target.dataset.handle === 'resize' ? 'resize' : 'move'));
        overlay.appendChild(el);
      });

      overlay.querySelectorAll('.plate-box-delete').forEach((button) => {
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          removeCurrentImageBox(button.dataset.boxId);
        });
      });
    }
  }

  function beginImageBoxDrag(event, boxId, mode) {
    const entry = currentImage();
    const overlay = $('#imageOverlayLayer');
    if (!entry || !overlay) return;
    const box = entry.boxes.find((item) => item.id === boxId);
    if (!box) return;

    const rect = overlay.getBoundingClientRect();
    state.selectedPlateId = boxId;
    state.imageDrag = {
      boxId,
      mode,
      startX: event.clientX,
      startY: event.clientY,
      startBox: { ...box },
      overlayRect: rect,
      displayRect: entry.displayRect,
    };
    window.addEventListener('pointermove', onImageBoxDrag);
    window.addEventListener('pointerup', endImageBoxDrag);
    renderDetectionList();
    renderImageWorkspace();
  }

  function onImageBoxDrag(event) {
    if (!state.imageDrag) return;
    const entry = currentImage();
    if (!entry) return;
    const box = entry.boxes.find((item) => item.id === state.imageDrag.boxId);
    if (!box) return;

    const { displayRect, startBox, mode, startX, startY } = state.imageDrag;
    const dx = (event.clientX - startX) / displayRect.width;
    const dy = (event.clientY - startY) / displayRect.height;

    if (mode === 'resize') {
      box.w = clamp(startBox.w + dx, 0.04, 1 - startBox.x);
      box.h = clamp(startBox.h + dy, 0.03, 1 - startBox.y);
    } else {
      box.x = clamp(startBox.x + dx, 0, 1 - startBox.w);
      box.y = clamp(startBox.y + dy, 0, 1 - startBox.h);
    }

    renderImageWorkspace();
  }

  function endImageBoxDrag() {
    window.removeEventListener('pointermove', onImageBoxDrag);
    window.removeEventListener('pointerup', endImageBoxDrag);
    state.imageDrag = null;
  }

  function loadImage(index) {
    if (index < 0 || index >= state.images.length) return;
    state.currentImageIndex = index;
    const entry = currentImage();
    state.selectedPlateId = entry?.boxes[0]?.id || null;
    renderImageWorkspace();
  }

  function removeCurrentImageBox(boxId) {
    const entry = currentImage();
    if (!entry) return;
    entry.boxes = entry.boxes.filter((item) => item.id !== boxId);
    state.selectedPlateId = entry.boxes[0]?.id || null;
    renderImageWorkspace();
    updateStats();
  }

  function addImageBox() {
    const entry = currentImage();
    if (!entry) {
      showToast('请先上传图片', '图片处理区需要至少一张图片。', 'warning');
      return;
    }

    const box = {
      id: uid('plate'),
      label: `手动框 ${entry.boxes.length + 1}`,
      confidence: 0.5,
      source: 'manual',
      x: DEFAULT_IMAGE_BOX.x,
      y: DEFAULT_IMAGE_BOX.y,
      w: DEFAULT_IMAGE_BOX.w,
      h: DEFAULT_IMAGE_BOX.h,
    };
    entry.boxes.push(box);
    state.selectedPlateId = box.id;
    renderImageWorkspace();
    updateStats();
  }

  async function resetCurrentImageDetection() {
    const entry = currentImage();
    if (!entry) return;
    showToast('重新识别中', `正在分析 ${entry.name}`, 'progress', true);
    const boxes = await detectPlatesFromImageURL(entry.url, entry.width, entry.height);
    entry.boxes = boxes.map((box, index) => ({
      ...box,
      label: makeBoxLabel(index, box.source),
    }));
    state.selectedPlateId = entry.boxes[0]?.id || null;
    renderImageWorkspace();
    updateStats();
    showToast('识别完成', `已找到 ${entry.boxes.length} 个候选区域`, 'success');
  }

  function getWatermarkConfig() {
    const opacityInput = $('#wmOpacity');
    const opacity = opacityInput ? Number(opacityInput.value || 85) / 100 : 0.85;
    return {
      template: state.wmTemplate,
      text: ($('#wmText')?.value || state.settings.defaultBrandName || 'ShieldPlate').trim(),
      textColor: $('#wmColor')?.value || '#FF6B00',
      backgroundColor: $('#wmBgColor')?.value || '#111111',
      radius: Number($('#wmRadius')?.value || 4),
      fontSize: Number($('#wmFontSize')?.value || 12),
      opacity,
      blurStrength: state.blurIntensity,
    };
  }

  function getVideoRenderConfig() {
    const style = $('#videoStyleSelect')?.value || state.blurStyle;
    return {
      ...getWatermarkConfig(),
      template: style,
      width: Number($('#vidWidthRange')?.value || 160),
      height: Number($('#vidHeightRange')?.value || 60),
      blurStrength: Number($('#vidBlurRange')?.value || 10),
      keepAudio: $('#keepVideoAudioToggle')?.checked ?? state.settings.keepVideoAudio,
    };
  }

  async function buildProcessedImage(entry) {
    const image = await loadImageElement(entry.url);
    const sourceCanvas = document.createElement('canvas');
    sourceCanvas.width = entry.width;
    sourceCanvas.height = entry.height;
    const sourceCtx = sourceCanvas.getContext('2d');
    sourceCtx.drawImage(image, 0, 0, entry.width, entry.height);

    const outputCanvas = document.createElement('canvas');
    outputCanvas.width = entry.width;
    outputCanvas.height = entry.height;
    const ctx = outputCanvas.getContext('2d');
    ctx.drawImage(sourceCanvas, 0, 0);

    entry.boxes.forEach((box) => {
      applyRedaction(ctx, sourceCanvas, boxToPixels(box, entry.width, entry.height), getWatermarkConfig(), state.blurStyle);
    });

    const blob = await new Promise((resolve) => outputCanvas.toBlob(resolve, 'image/jpeg', 0.92));
    const previewDataUrl = outputCanvas.toDataURL('image/jpeg', 0.72);
    return { blob, previewDataUrl };
  }

  function applyRedaction(ctx, sourceCanvas, rect, config, style) {
    const x = clamp(Math.round(rect.x), 0, sourceCanvas.width - 1);
    const y = clamp(Math.round(rect.y), 0, sourceCanvas.height - 1);
    const w = clamp(Math.round(rect.w), 8, sourceCanvas.width - x);
    const h = clamp(Math.round(rect.h), 8, sourceCanvas.height - y);
    const radius = Math.max(6, Math.round(Math.min(w, h) * 0.12));

    if (style === 'blur') {
      const pad = Math.max(6, config.blurStrength * 2);
      const sx = clamp(x - pad, 0, sourceCanvas.width);
      const sy = clamp(y - pad, 0, sourceCanvas.height);
      const sw = clamp(w + pad * 2, 1, sourceCanvas.width - sx);
      const sh = clamp(h + pad * 2, 1, sourceCanvas.height - sy);
      ctx.save();
      roundRectPath(ctx, x, y, w, h, radius);
      ctx.clip();
      ctx.filter = `blur(${Math.max(3, config.blurStrength * 1.35)}px)`;
      ctx.drawImage(sourceCanvas, sx, sy, sw, sh, sx, sy, sw, sh);
      ctx.filter = 'none';
      ctx.restore();
      ctx.save();
      ctx.strokeStyle = `rgba(255,255,255,${Math.min(0.4, config.opacity)})`;
      ctx.lineWidth = 1;
      roundRectPath(ctx, x, y, w, h, radius);
      ctx.stroke();
      ctx.restore();
      return;
    }

    if (style === 'mosaic') {
      const mosaic = document.createElement('canvas');
      const scale = clamp(Math.round(config.blurStrength), 4, 18);
      mosaic.width = Math.max(6, Math.round(w / scale));
      mosaic.height = Math.max(4, Math.round(h / scale));
      const mctx = mosaic.getContext('2d');
      mctx.drawImage(sourceCanvas, x, y, w, h, 0, 0, mosaic.width, mosaic.height);
      ctx.save();
      roundRectPath(ctx, x, y, w, h, radius);
      ctx.clip();
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(mosaic, 0, 0, mosaic.width, mosaic.height, x, y, w, h);
      ctx.imageSmoothingEnabled = true;
      ctx.restore();
      return;
    }

    if (style === 'block' || style === 'solid') {
      ctx.save();
      ctx.globalAlpha = Math.max(0.72, config.opacity);
      ctx.fillStyle = config.backgroundColor;
      roundRectPath(ctx, x, y, w, h, radius);
      ctx.fill();
      ctx.restore();
      return;
    }

    drawWatermarkBadge(ctx, { x, y, w, h }, config, style);
  }

  function drawWatermarkBadge(ctx, rect, config, style) {
    const { x, y, w, h } = rect;
    const radius = Math.max(6, Math.min(config.radius * 2, h / 2, 18));
    const text = config.text || 'ShieldPlate';

    ctx.save();
    roundRectPath(ctx, x, y, w, h, radius);
    ctx.clip();

    if (style === 'brand') {
      const grad = ctx.createLinearGradient(x, y, x + w, y + h);
      grad.addColorStop(0, config.backgroundColor);
      grad.addColorStop(1, '#FF6B00');
      ctx.globalAlpha = config.opacity;
      ctx.fillStyle = grad;
      ctx.fillRect(x, y, w, h);
    } else if (style === 'logo') {
      ctx.globalAlpha = config.opacity;
      ctx.fillStyle = config.backgroundColor;
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = config.textColor;
      ctx.lineWidth = 2;
      ctx.strokeRect(x + 10, y + 10, Math.min(20, w * 0.18), Math.min(20, h * 0.5));
    } else {
      ctx.globalAlpha = config.opacity;
      ctx.fillStyle = config.backgroundColor;
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = config.textColor;
      ctx.fillRect(x, y + h * 0.28, w, h * 0.44);
    }

    ctx.globalAlpha = 1;
    ctx.fillStyle = style === 'stripe' ? '#FFFFFF' : config.textColor;
    ctx.font = `700 ${Math.max(12, Math.min(config.fontSize + h * 0.2, h * 0.46))}px system-ui`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x + w / 2, y + h / 2, w - 12);
    ctx.restore();
  }

  async function processImages() {
    if (!state.images.length) {
      showToast('请先上传图片', '图片处理区需要至少一张图片。', 'warning');
      return;
    }

    showToast('批量处理中', `准备处理 ${state.images.length} 张图片`, 'progress', true);
    let finished = 0;

    for (const entry of state.images) {
      const { blob, previewDataUrl } = await buildProcessedImage(entry);

      if (entry.processedUrl) URL.revokeObjectURL(entry.processedUrl);
      entry.processedBlob = blob;
      entry.processedUrl = URL.createObjectURL(blob);
      entry.processed = true;
      entry.status = 'done';

      await addHistoryRecord({
        id: uid('history'),
        type: 'image',
        name: entry.name,
        status: 'done',
        downloadName: buildDownloadName(entry.name, 'blurred', 'jpg'),
        previewDataUrl,
        blob,
      });

      if (state.settings.autoDownload) {
        downloadBlob(blob, buildDownloadName(entry.name, 'blurred', 'jpg'));
      }

      finished += 1;
      updateToastProgress(finished / state.images.length, `已处理 ${finished} / ${state.images.length} 张图片`);
      updateStats();
      renderImageThumbs();
      await sleep(20);
    }

    const current = currentImage();
    if (current?.processedUrl) {
      state.imageViewMode = 'processed';
      renderImageWorkspace();
    }
    showToast('图片处理完成', `共生成 ${finished} 张打码结果`, 'success');
  }

  async function downloadCurrentImage() {
    const entry = currentImage();
    if (!entry) {
      showToast('暂无图片', '请先上传图片。', 'warning');
      return;
    }

    if (!entry.processedBlob) {
      const { blob, previewDataUrl } = await buildProcessedImage(entry);
      entry.processedBlob = blob;
      if (entry.processedUrl) URL.revokeObjectURL(entry.processedUrl);
      entry.processedUrl = URL.createObjectURL(blob);
      entry.processed = true;
      entry.status = 'done';
      await addHistoryRecord({
        id: uid('history'),
        type: 'image',
        name: entry.name,
        status: 'done',
        downloadName: buildDownloadName(entry.name, 'blurred', 'jpg'),
        previewDataUrl,
        blob,
      });
      updateStats();
    }

    downloadBlob(entry.processedBlob, buildDownloadName(entry.name, 'blurred', 'jpg'));
    state.imageViewMode = 'processed';
    renderImageWorkspace();
    showToast('已开始下载', '当前图片的打码结果已导出。', 'success');
  }

  function downloadBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  async function registerImageFile(file) {
    const url = fileToObjectURL(file);
    const image = await loadImageElement(url);
    const boxes = await detectPlatesFromImageURL(url, image.width, image.height);
    const entry = {
      id: uid('img'),
      file,
      url,
      name: file.name,
      width: image.width,
      height: image.height,
      boxes: boxes.map((box, index) => ({ ...box, label: makeBoxLabel(index, box.source) })),
      processed: false,
      processedBlob: null,
      processedUrl: '',
      status: 'pending',
      displayRect: null,
    };
    state.images.push(entry);
    if (state.currentImageIndex === -1) state.currentImageIndex = 0;
    state.selectedPlateId = entry.boxes[0]?.id || null;
  }

  async function registerVideoFile(file) {
    const url = fileToObjectURL(file);
    const metadata = await loadVideoMetadata(url);
    const posterUrl = await captureVideoPoster(url).catch(() => makeHistoryThumbFallback('video'));
    const entry = {
      id: uid('vid'),
      file,
      url,
      name: file.name,
      width: metadata.width,
      height: metadata.height,
      duration: metadata.duration,
      posterUrl,
      tracks: [],
      processed: false,
      processedBlob: null,
      processedUrl: '',
      status: 'pending',
    };
    state.videos.push(entry);
    if (state.currentVideoIndex === -1) state.currentVideoIndex = 0;
  }

  async function handleFiles(event) {
    const files = Array.from(event?.target?.files || []);
    if (!files.length) return;

    showToast('上传中', `正在读取 ${files.length} 个文件`, 'progress', true);
    let completed = 0;

    for (const file of files) {
      if (file.type.startsWith('video/')) {
        await registerVideoFile(file);
      } else if (file.type.startsWith('image/')) {
        await registerImageFile(file);
      }
      completed += 1;
      updateToastProgress(completed / files.length, `已导入 ${completed} / ${files.length}`);
    }

    renderVideoQueue();
    renderImageWorkspace();
    renderVideoWorkspace();
    updateStats();

    const imgBadge = $('#imgBadge');
    const vidBadge = $('#vidBadge');
    if (imgBadge) {
      imgBadge.textContent = String(state.images.length);
      imgBadge.style.display = state.images.length ? '' : 'none';
    }
    if (vidBadge) {
      vidBadge.textContent = String(state.videos.length);
      vidBadge.style.display = state.videos.length ? '' : 'none';
    }

    if (state.images.length) {
      switchTab('image');
    } else if (state.videos.length) {
      switchTab('video');
    }

    showToast('上传成功', `已添加 ${files.length} 个素材`, 'success');
  }

  function renderVideoQueue() {
    const queue = $('#videoQueue');
    const count = $('#videoQueueCount');
    const badge = $('#vidBadge');
    if (!queue) return;

    if (count) count.textContent = `${state.videos.length} 个视频`;
    if (badge) {
      badge.textContent = String(state.videos.length);
      badge.style.display = state.videos.length ? '' : 'none';
    }

    if (!state.videos.length) {
      queue.innerHTML = `
        <div class="track-empty">
          <p>上传视频后可在这里切换当前任务</p>
        </div>`;
      return;
    }

    queue.innerHTML = state.videos.map((entry, index) => `
      <button class="video-queue-item ${state.currentVideoIndex === index ? 'active' : ''}" data-video-index="${index}">
        <img class="video-queue-thumb" src="${entry.posterUrl}" alt="${entry.name}" />
        <span class="video-queue-name">${entry.name}</span>
        <span class="video-queue-meta">${formatTime(entry.duration)}</span>
      </button>
    `).join('');

    $$('.video-queue-item').forEach((button) => {
      button.addEventListener('click', () => {
        loadVideo(Number(button.dataset.videoIndex));
      });
    });
  }

  function loadVideo(index) {
    if (index < 0 || index >= state.videos.length) return;
    state.currentVideoIndex = index;
    state.selectedTrackId = currentVideo()?.tracks[0]?.id || null;
    renderVideoQueue();
    syncVideoControlsFromSelectedTrack();
    renderVideoWorkspace();
  }

  function renderTrackList() {
    const list = $('#trackList');
    const count = $('#plateTrackCount');
    const entry = currentVideo();
    if (!list) return;

    if (!entry || !entry.tracks.length) {
      list.innerHTML = `
        <div class="track-empty">
          <p>识别当前帧后，可拖拽追踪框并逐帧导出</p>
        </div>`;
      if (count) count.textContent = '0 个追踪点';
      return;
    }

    if (count) count.textContent = `${entry.tracks.length} 个追踪点`;
    list.innerHTML = entry.tracks
      .sort((a, b) => a.time - b.time)
      .map((track, index) => `
        <div class="track-item ${state.selectedTrackId === track.id ? 'selected-track' : ''}" data-track-id="${track.id}">
          <span class="track-num">#${index + 1}</span>
          <span class="track-time">${formatTime(track.time)}</span>
          <span class="track-plate">${track.label}</span>
          <button class="track-del" data-track-del="${track.id}" title="删除">×</button>
        </div>
      `).join('');

    $$('.track-item').forEach((item) => {
      item.addEventListener('click', (event) => {
        const deleteId = event.target.closest('[data-track-del]')?.dataset.trackDel;
        if (deleteId) {
          removeCurrentTrack(deleteId);
          return;
        }
        state.selectedTrackId = item.dataset.trackId;
        renderTrackList();
        syncVideoControlsFromSelectedTrack();
        updateVideoOverlay();
      });
    });
  }

  function removeCurrentTrack(trackId) {
    const entry = currentVideo();
    if (!entry) return;
    entry.tracks = entry.tracks.filter((track) => track.id !== trackId);
    state.selectedTrackId = entry.tracks[0]?.id || null;
    renderTrackList();
    renderTimelineMarkers();
    syncVideoControlsFromSelectedTrack();
    updateVideoOverlay();
    updateStats();
  }

  function ensureVideoOverlay() {
    const wrap = $('.video-canvas-wrap');
    const video = $('#videoPreview');
    if (!wrap || !video) return null;
    let overlay = $('#videoOverlayLayer');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'videoOverlayLayer';
      overlay.className = 'canvas-overlay video-overlay-layer';
      wrap.appendChild(overlay);
    }
    return overlay;
  }

  function updateVideoOverlay() {
    const video = $('#videoPreview');
    const overlay = ensureVideoOverlay();
    const entry = currentVideo();
    if (!video || !overlay || !entry || !entry.tracks.length || !video.videoWidth || !video.videoHeight) {
      if (overlay) overlay.innerHTML = '';
      return;
    }

    const wrapRect = $('.video-canvas-wrap').getBoundingClientRect();
    const videoRect = video.getBoundingClientRect();
    overlay.style.left = `${videoRect.left - wrapRect.left}px`;
    overlay.style.top = `${videoRect.top - wrapRect.top}px`;
    overlay.style.width = `${videoRect.width}px`;
    overlay.style.height = `${videoRect.height}px`;

    const fit = fitContainRect(video.videoWidth, video.videoHeight, video.clientWidth, video.clientHeight);
    const current = interpolateTrackAt(entry, video.currentTime || 0);
    if (!current) {
      overlay.innerHTML = '';
      return;
    }

    const style = $('#videoStyleSelect')?.value || state.blurStyle;
    overlay.innerHTML = `
      <div class="plate-box video-box ${state.selectedTrackId === current.id ? 'selected' : ''} preview-${style}"
        data-track-id="${current.id}"
        style="
          left:${fit.x + fit.width * current.x}px;
          top:${fit.y + fit.height * current.y}px;
          width:${fit.width * current.w}px;
          height:${fit.height * current.h}px;">
        <div class="plate-box-label">${current.label}</div>
        <span class="plate-box-handle" data-handle="resize"></span>
      </div>
    `;

    const boxEl = overlay.querySelector('.video-box');
    boxEl?.addEventListener('pointerdown', (event) => {
      beginVideoTrackDrag(event, current.id, event.target.dataset.handle === 'resize' ? 'resize' : 'move', fit);
    });
  }

  function interpolateTrackAt(entry, time) {
    if (!entry.tracks.length) return null;
    const tracks = [...entry.tracks].sort((a, b) => a.time - b.time);
    if (tracks.length === 1) return tracks[0];
    if (time <= tracks[0].time) return tracks[0];
    if (time >= tracks[tracks.length - 1].time) return tracks[tracks.length - 1];

    for (let i = 0; i < tracks.length - 1; i += 1) {
      const left = tracks[i];
      const right = tracks[i + 1];
      if (time >= left.time && time <= right.time) {
        const ratio = (time - left.time) / Math.max(right.time - left.time, 0.001);
        return {
          ...left,
          x: left.x + (right.x - left.x) * ratio,
          y: left.y + (right.y - left.y) * ratio,
          w: left.w + (right.w - left.w) * ratio,
          h: left.h + (right.h - left.h) * ratio,
        };
      }
    }
    return tracks[0];
  }

  function findTrackById(entry, trackId) {
    return entry.tracks.find((track) => track.id === trackId);
  }

  function syncVideoControlsFromSelectedTrack() {
    const entry = currentVideo();
    const track = entry ? findTrackById(entry, state.selectedTrackId) : null;
    if (!entry || !track) return;

    const widthInput = $('#vidWidthRange');
    const heightInput = $('#vidHeightRange');
    const widthVal = $('#vidWidthVal');
    const heightVal = $('#vidHeightVal');
    const widthPx = Math.round(track.w * entry.width);
    const heightPx = Math.round(track.h * entry.height);

    if (widthInput) {
      const next = clamp(widthPx, Number(widthInput.min), Number(widthInput.max));
      widthInput.value = String(next);
      if (widthVal) widthVal.textContent = `${next}px`;
    }
    if (heightInput) {
      const next = clamp(heightPx, Number(heightInput.min), Number(heightInput.max));
      heightInput.value = String(next);
      if (heightVal) heightVal.textContent = `${next}px`;
    }
  }

  function applySelectedTrackSizeFromControls() {
    const entry = currentVideo();
    const track = entry ? findTrackById(entry, state.selectedTrackId) : null;
    if (!entry || !track) return;

    const widthPx = Number($('#vidWidthRange')?.value || 160);
    const heightPx = Number($('#vidHeightRange')?.value || 60);
    const centerX = track.x + (track.w / 2);
    const centerY = track.y + (track.h / 2);
    const nextW = clamp(widthPx / entry.width, 0.05, 1);
    const nextH = clamp(heightPx / entry.height, 0.04, 1);

    track.w = nextW;
    track.h = nextH;
    track.x = clamp(centerX - (nextW / 2), 0, 1 - nextW);
    track.y = clamp(centerY - (nextH / 2), 0, 1 - nextH);

    renderTrackList();
    updateVideoOverlay();
  }

  function beginVideoTrackDrag(event, trackId, mode, displayRect) {
    const entry = currentVideo();
    if (!entry) return;
    const track = findTrackById(entry, trackId);
    if (!track) return;

    state.selectedTrackId = trackId;
    state.videoDrag = {
      trackId,
      mode,
      startX: event.clientX,
      startY: event.clientY,
      startTrack: { ...track },
      displayRect,
    };
    window.addEventListener('pointermove', onVideoTrackDrag);
    window.addEventListener('pointerup', endVideoTrackDrag);
    renderTrackList();
    syncVideoControlsFromSelectedTrack();
  }

  function onVideoTrackDrag(event) {
    if (!state.videoDrag) return;
    const entry = currentVideo();
    if (!entry) return;
    const track = findTrackById(entry, state.videoDrag.trackId);
    if (!track) return;

    const { displayRect, startTrack, startX, startY, mode } = state.videoDrag;
    const dx = (event.clientX - startX) / displayRect.width;
    const dy = (event.clientY - startY) / displayRect.height;

    if (mode === 'resize') {
      track.w = clamp(startTrack.w + dx, 0.05, 1 - startTrack.x);
      track.h = clamp(startTrack.h + dy, 0.04, 1 - startTrack.y);
    } else {
      track.x = clamp(startTrack.x + dx, 0, 1 - startTrack.w);
      track.y = clamp(startTrack.y + dy, 0, 1 - startTrack.h);
    }
    if (mode === 'resize') syncVideoControlsFromSelectedTrack();
    updateVideoOverlay();
  }

  function endVideoTrackDrag() {
    window.removeEventListener('pointermove', onVideoTrackDrag);
    window.removeEventListener('pointerup', endVideoTrackDrag);
    state.videoDrag = null;
  }

  function renderTimelineMarkers() {
    const markers = $('#timelineMarkers');
    const entry = currentVideo();
    if (!markers || !entry || !entry.duration) {
      if (markers) markers.innerHTML = '';
      return;
    }
    markers.innerHTML = entry.tracks.map((track) => `
      <div class="timeline-marker" style="left:${(track.time / entry.duration) * 100}%"></div>
    `).join('');
  }

  function updatePlayhead(progress) {
    const playhead = $('#timelinePlayhead');
    const fill = $('#timelineProgress');
    if (playhead) playhead.style.left = `${progress * 100}%`;
    if (fill) fill.style.width = `${progress * 100}%`;
  }

  function renderVideoWorkspace() {
    renderVideoQueue();
    renderTrackList();

    const video = $('#videoPreview');
    const empty = $('#videoEmpty');
    const entry = currentVideo();

    if (!video) return;
    if (!entry) {
      video.removeAttribute('src');
      video.load();
      video.style.display = 'none';
      empty?.classList.remove('hidden');
      updatePlayhead(0);
      $('#timeDisplay').textContent = '00:00 / 00:00';
      updateVideoJob(0, '上传视频并添加追踪点后，可逐帧加水印并导出结果。');
      return;
    }

    if (video.dataset.entryId !== entry.id) {
      video.src = entry.url;
      video.dataset.entryId = entry.id;
      video.currentTime = 0;
    }

    video.style.display = 'block';
    empty?.classList.add('hidden');
    renderTimelineMarkers();
    syncVideoControlsFromSelectedTrack();
    updateVideoOverlay();
  }

  async function detectCurrentFrame() {
    const entry = currentVideo();
    const video = $('#videoPreview');
    if (!entry || !video || !video.src || !video.videoWidth) {
      showToast('请先上传视频', '视频加载完成后才能识别当前帧。', 'warning');
      return;
    }

    showToast('识别当前帧', '正在分析视频画面…', 'progress', true);
    const boxes = await detectPlatesFromVideoFrame(video);
    const top = boxes[0] || createFallbackBox();
    const track = {
      id: uid('track'),
      label: `追踪点 ${entry.tracks.length + 1}`,
      time: Number(video.currentTime || 0),
      x: top.x,
      y: top.y,
      w: top.w,
      h: top.h,
    };

    entry.tracks.push(track);
    entry.tracks.sort((a, b) => a.time - b.time);
    state.selectedTrackId = track.id;
    renderTrackList();
    renderTimelineMarkers();
    syncVideoControlsFromSelectedTrack();
    updateVideoOverlay();
    updateStats();
    showToast('识别完成', `已在 ${formatTime(track.time)} 添加追踪点`, 'success');
  }

  function addCurrentTrackPoint() {
    const entry = currentVideo();
    const video = $('#videoPreview');
    if (!entry || !video || !video.src) {
      showToast('请先上传视频', '视频加载完成后才能添加追踪点。', 'warning');
      return;
    }

    const interpolated = interpolateTrackAt(entry, video.currentTime || 0);
    const base = interpolated || createFallbackBox();
    const track = {
      id: uid('track'),
      label: `追踪点 ${entry.tracks.length + 1}`,
      time: Number(video.currentTime || 0),
      x: base.x,
      y: base.y,
      w: base.w,
      h: base.h,
    };
    entry.tracks.push(track);
    entry.tracks.sort((a, b) => a.time - b.time);
    state.selectedTrackId = track.id;
    renderTrackList();
    renderTimelineMarkers();
    syncVideoControlsFromSelectedTrack();
    updateVideoOverlay();
    updateStats();
    showToast('追踪点已添加', `时间 ${formatTime(track.time)}`, 'success');
  }

  function chooseVideoMimeType() {
    const candidates = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ];
    return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || '';
  }

  async function processCurrentVideo() {
    const entry = currentVideo();
    if (!entry) {
      showToast('请先上传视频', '视频处理区需要至少一个视频文件。', 'warning');
      return;
    }
    if (!entry.tracks.length) {
      showToast('请先添加追踪点', '至少需要一个追踪点才能处理视频。', 'warning');
      return;
    }
    if (!window.MediaRecorder) {
      showToast('当前浏览器不支持', '请使用 Chrome / Edge 等支持 MediaRecorder 的浏览器。', 'error');
      return;
    }

    const mimeType = chooseVideoMimeType();
    if (!mimeType) {
      showToast('当前浏览器不支持导出', '没有可用的视频编码格式。', 'error');
      return;
    }

    state.videoProcessing = true;
    updateVideoJob(0, '正在准备逐帧处理…');
    showToast('视频处理中', '正在逐帧加水印，请保持页面开启。', 'progress', true);
    try {
      const renderConfig = getVideoRenderConfig();
      const sourceVideo = document.createElement('video');
      sourceVideo.src = entry.url;
      sourceVideo.crossOrigin = 'anonymous';
      sourceVideo.preload = 'auto';
      sourceVideo.playsInline = true;
      sourceVideo.muted = true;
      await new Promise((resolve, reject) => {
        sourceVideo.onloadedmetadata = resolve;
        sourceVideo.onerror = reject;
      });

      const fps = 25;
      const canvas = document.createElement('canvas');
      canvas.width = sourceVideo.videoWidth || entry.width;
      canvas.height = sourceVideo.videoHeight || entry.height;
      const ctx = canvas.getContext('2d');
      const frameCanvas = document.createElement('canvas');
      frameCanvas.width = canvas.width;
      frameCanvas.height = canvas.height;
      const frameCtx = frameCanvas.getContext('2d');

      const stream = canvas.captureStream(fps);
      if (renderConfig.keepAudio && typeof sourceVideo.captureStream === 'function') {
        try {
          const audioStream = sourceVideo.captureStream();
          audioStream.getAudioTracks().forEach((track) => stream.addTrack(track));
        } catch (error) {
          console.warn('Audio capture unavailable', error);
        }
      }

      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const chunks = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };

      const stopPromise = new Promise((resolve) => {
        recorder.onstop = resolve;
      });

      recorder.start(250);
      await sourceVideo.play();

      await new Promise((resolve) => {
        const draw = () => {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          frameCtx.clearRect(0, 0, frameCanvas.width, frameCanvas.height);
          frameCtx.drawImage(sourceVideo, 0, 0, frameCanvas.width, frameCanvas.height);
          ctx.drawImage(frameCanvas, 0, 0, canvas.width, canvas.height);

          const box = interpolateTrackAt(entry, sourceVideo.currentTime || 0);
          if (box) {
            applyRedaction(
              ctx,
              frameCanvas,
              boxToPixels(box, canvas.width, canvas.height),
              {
                ...getWatermarkConfig(),
                ...renderConfig,
                blurStrength: renderConfig.blurStrength,
              },
              renderConfig.template
            );
          }

          const progress = sourceVideo.duration ? sourceVideo.currentTime / sourceVideo.duration : 0;
          updateVideoJob(progress, `正在处理 ${formatTime(sourceVideo.currentTime)} / ${formatTime(sourceVideo.duration || 0)}`);
          updateToastProgress(progress, `逐帧处理 ${Math.round(progress * 100)}%`);

          if (sourceVideo.ended) {
            resolve();
            return;
          }
          requestAnimationFrame(draw);
        };
        sourceVideo.onended = () => resolve();
        draw();
      });

      await sleep(150);
      if (recorder.state !== 'inactive') recorder.stop();
      await stopPromise;

      const blob = new Blob(chunks, { type: mimeType || 'video/webm' });
      const poster = canvas.toDataURL('image/jpeg', 0.76);

      if (entry.processedUrl) URL.revokeObjectURL(entry.processedUrl);
      entry.processedBlob = blob;
      entry.processedUrl = URL.createObjectURL(blob);
      entry.processed = true;
      entry.status = 'done';

      await addHistoryRecord({
        id: uid('history'),
        type: 'video',
        name: entry.name,
        status: 'done',
        downloadName: buildDownloadName(entry.name, 'watermarked', 'webm'),
        previewDataUrl: poster,
        blob,
      });

      if (state.settings.autoDownload) {
        downloadBlob(blob, buildDownloadName(entry.name, 'watermarked', 'webm'));
      }

      updateStats();
      updateVideoJob(1, '处理完成，可直接下载 WebM 结果。');
      showToast('视频处理完成', '逐帧加水印结果已生成。', 'success');
    } catch (error) {
      console.error(error);
      updateVideoJob(0, '视频处理失败，请重新加载素材后再试。');
      showToast('视频处理失败', error?.message || '浏览器中断了导出流程。', 'error');
    } finally {
      state.videoProcessing = false;
    }
  }

  async function downloadCurrentVideo() {
    const entry = currentVideo();
    if (!entry) {
      showToast('暂无视频', '请先上传视频素材。', 'warning');
      return;
    }
    if (!entry.processedBlob) {
      showToast('还没有处理结果', '请先运行视频处理。', 'warning');
      return;
    }
    downloadBlob(entry.processedBlob, buildDownloadName(entry.name, 'watermarked', 'webm'));
    showToast('已开始下载', '当前视频的处理结果已导出。', 'success');
  }

  function renderHistory() {
    const grid = $('#historyGrid');
    if (!grid) return;

    const filtered = state.history.filter((record) => {
      if (state.historyFilter === '图片' && record.type !== 'image') return false;
      if (state.historyFilter === '视频' && record.type !== 'video') return false;
      if (state.historyFilter === '失败' && record.status !== 'fail') return false;
      if (state.historyQuery && !record.name.toLowerCase().includes(state.historyQuery.toLowerCase())) return false;
      return true;
    });

    if (!filtered.length) {
      grid.innerHTML = `
        <div class="history-empty">
          <svg width="64" height="64" viewBox="0 0 64 64" fill="none">
            <circle cx="32" cy="32" r="28" stroke="#333" stroke-width="1.5" stroke-dasharray="4 4"/>
            <path d="M32 20v14l8 8" stroke="#333" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
          <p>暂无处理记录</p>
          <p class="history-empty-sub">完成图片或视频处理后，结果会保存在浏览器本地。</p>
        </div>`;
      return;
    }

    grid.innerHTML = filtered.map((record) => `
      <div class="history-card">
        <div class="history-card-actions">
          <button class="hc-action" data-history-download="${record.id}" title="下载">↓</button>
          <button class="hc-action" data-history-delete="${record.id}" title="删除">×</button>
        </div>
        <div class="history-thumb" style="background-image:url('${record.previewDataUrl}');background-size:cover;background-position:center;"></div>
        <div class="history-info">
          <div class="history-name">${record.name}</div>
          <div class="history-meta">
            <span class="history-time">${formatDateTime(record.createdAt)}</span>
            <span class="history-status ${record.status === 'done' ? 'done' : 'fail'}">${record.type === 'video' ? '视频' : '图片'}</span>
          </div>
        </div>
      </div>
    `).join('');

    $$('[data-history-delete]').forEach((button) => {
      button.addEventListener('click', async () => {
        await deleteHistoryRecord(button.dataset.historyDelete);
        showToast('记录已删除', '', 'success');
      });
    });

    $$('[data-history-download]').forEach((button) => {
      button.addEventListener('click', async () => {
        const record = state.history.find((item) => item.id === button.dataset.historyDownload);
        if (!record?.blob) {
          showToast('当前记录不可下载', '这个条目缺少输出文件。', 'warning');
          return;
        }
        downloadBlob(record.blob, record.downloadName || record.name);
      });
    });
  }

  function updateWMPreview() {
    const text = ($('#wmText')?.value || state.settings.defaultBrandName || 'ShieldPlate').trim();
    const color = $('#wmColor')?.value || '#FF6B00';
    const bg = $('#wmBgColor')?.value || '#111111';
    const size = Number($('#wmFontSize')?.value || 12);
    const radius = Number($('#wmRadius')?.value || 4);
    const opacity = Number($('#wmOpacity')?.value || 85);

    const badge = $('#wmBadge');
    const badgeText = $('#wmBadgeText');
    const opacityVal = $('#wmOpacityVal');
    const colorHex = $('#wmColorHex');
    const bgHex = $('#wmBgColorHex');

    if (badge) {
      badge.style.background = bg;
      badge.style.borderRadius = `${radius}px`;
      badge.style.opacity = opacity / 100;
    }
    if (badgeText) {
      badgeText.textContent = text || 'ShieldPlate';
      badgeText.style.color = color;
      badgeText.style.fontSize = `${size}px`;
    }
    if (opacityVal) opacityVal.textContent = `${opacity}%`;
    if (colorHex) colorHex.value = color;
    if (bgHex) bgHex.value = bg;
  }

  function bindNav() {
    $$('.nav-item').forEach((button) => {
      button.addEventListener('click', () => switchTab(button.dataset.tab));
    });
    $$('.qa-card[data-jump]').forEach((card) => {
      card.addEventListener('click', () => switchTab(card.dataset.jump));
    });
  }

  function bindUpload() {
    const dropZone = $('#dropZone');
    const browse = $('#browseBtn');
    const fileInput = $('#fileInput');

    browse?.addEventListener('click', (event) => {
      event.stopPropagation();
      fileInput?.click();
    });
    fileInput?.addEventListener('change', handleFiles);
    dropZone?.addEventListener('click', () => fileInput?.click());
    dropZone?.addEventListener('dragover', (event) => {
      event.preventDefault();
      dropZone.classList.add('drag-over');
    });
    dropZone?.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
    dropZone?.addEventListener('drop', (event) => {
      event.preventDefault();
      dropZone.classList.remove('drag-over');
      handleFiles({ target: { files: event.dataTransfer.files } });
    });
  }

  function bindImageActions() {
    $('#addPlateBtn')?.addEventListener('click', addImageBox);
    $('#resetPlatesBtn')?.addEventListener('click', resetCurrentImageDetection);
    $('#processImagesBtn')?.addEventListener('click', processImages);
    $('#downloadCurrentImageBtn')?.addEventListener('click', downloadCurrentImage);

    $$('.style-btn').forEach((button) => {
      button.addEventListener('click', () => {
        state.blurStyle = button.dataset.style;
        syncStyleSelections();
        renderImageWorkspace();
        updateVideoOverlay();
      });
    });

    $('#intensitySlider')?.addEventListener('input', (event) => {
      state.blurIntensity = Number(event.target.value);
      const value = $('#intensityVal');
      if (value) value.textContent = String(state.blurIntensity);
    });
  }

  function bindVideoActions() {
    const video = $('#videoPreview');
    const timeline = $('#timelineTrack');

    $('#detectCurrentFrameBtn')?.addEventListener('click', detectCurrentFrame);
    $('#addTrackBtn')?.addEventListener('click', addCurrentTrackPoint);
    $('#processVideoBtn')?.addEventListener('click', processCurrentVideo);
    $('#downloadCurrentVideoBtn')?.addEventListener('click', downloadCurrentVideo);

    $('#videoStyleSelect')?.addEventListener('change', (event) => {
      state.blurStyle = event.target.value;
      syncStyleSelections();
      updateVideoOverlay();
    });

    ['vidWidthRange', 'vidHeightRange', 'vidBlurRange'].forEach((id) => {
      const input = document.getElementById(id);
      input?.addEventListener('input', (event) => {
        const suffix = id === 'vidBlurRange' ? '' : 'px';
        const target = document.getElementById(id.replace('Range', 'Val'));
        if (target) target.textContent = `${event.target.value}${suffix}`;
        if (id === 'vidWidthRange' || id === 'vidHeightRange') {
          applySelectedTrackSizeFromControls();
        }
      });
    });

    timeline?.addEventListener('click', (event) => {
      if (!video?.duration) return;
      const rect = timeline.getBoundingClientRect();
      const ratio = clamp((event.clientX - rect.left) / rect.width, 0, 1);
      video.currentTime = ratio * video.duration;
      updatePlayhead(ratio);
      updateVideoOverlay();
    });

    $('#playBtn')?.addEventListener('click', async () => {
      if (!video?.src) return;
      await video.play();
      $('#playBtn').style.display = 'none';
      $('#pauseBtn').style.display = '';
    });
    $('#pauseBtn')?.addEventListener('click', () => {
      if (!video?.src) return;
      video.pause();
      $('#playBtn').style.display = '';
      $('#pauseBtn').style.display = 'none';
    });
    $('#stopBtn')?.addEventListener('click', () => {
      if (!video?.src) return;
      video.pause();
      video.currentTime = 0;
      $('#playBtn').style.display = '';
      $('#pauseBtn').style.display = 'none';
      updateVideoOverlay();
    });

    video?.addEventListener('loadedmetadata', () => {
      $('#timeDisplay').textContent = `00:00 / ${formatTime(video.duration || 0)}`;
      updateVideoOverlay();
    });
    video?.addEventListener('timeupdate', () => {
      const progress = video.duration ? (video.currentTime / video.duration) : 0;
      $('#timeDisplay').textContent = `${formatTime(video.currentTime || 0)} / ${formatTime(video.duration || 0)}`;
      updatePlayhead(progress);
      updateVideoOverlay();
    });
    video?.addEventListener('seeked', updateVideoOverlay);
    video?.addEventListener('loadeddata', updateVideoOverlay);
    video?.addEventListener('pause', () => {
      $('#playBtn').style.display = '';
      $('#pauseBtn').style.display = 'none';
      updateVideoOverlay();
    });
  }

  function bindWatermarkActions() {
    $$('.template-card').forEach((card) => {
      card.addEventListener('click', () => {
        $$('.template-card').forEach((item) => item.classList.remove('active'));
        card.classList.add('active');
        state.wmTemplate = card.dataset.tpl;
        updateWMPreview();
      });
    });

    ['wmText', 'wmColor', 'wmBgColor', 'wmFontSize', 'wmRadius', 'wmOpacity', 'wmColorHex', 'wmBgColorHex']
      .forEach((id) => {
        document.getElementById(id)?.addEventListener('input', (event) => {
          if (id === 'wmColorHex') {
            const picker = $('#wmColor');
            if (picker) picker.value = event.target.value;
          }
          if (id === 'wmBgColorHex') {
            const picker = $('#wmBgColor');
            if (picker) picker.value = event.target.value;
          }
          updateWMPreview();
        });
      });

    $('#saveTemplateBtn')?.addEventListener('click', () => {
      state.settings.defaultBrandName = ($('#wmText')?.value || state.settings.defaultBrandName).trim();
      persistSettings();
      showToast('模板已保存', '当前品牌水印已保存到本地设置。', 'success');
    });

    $('#applyWMBtn')?.addEventListener('click', () => {
      state.blurStyle = state.wmTemplate;
      syncStyleSelections();
      updateVideoOverlay();
      showToast('已应用当前模板', '图片和视频处理会按当前模板渲染。', 'success');
    });
  }

  function bindHistoryActions() {
    $$('.filter-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        $$('.filter-tab').forEach((button) => button.classList.remove('active'));
        tab.classList.add('active');
        state.historyFilter = tab.textContent.trim();
        renderHistory();
      });
    });

    $('#exportAllBtn')?.addEventListener('click', () => {
      if (!state.history.length) {
        showToast('暂无可导出的记录', '', 'warning');
        return;
      }
      state.history.forEach((record, index) => {
        if (record.blob) {
          setTimeout(() => downloadBlob(record.blob, record.downloadName || record.name), index * 250);
        }
      });
      showToast('批量导出已开始', '浏览器会依次触发下载。', 'success');
    });

    $('#clearHistoryBtn')?.addEventListener('click', async () => {
      state.history = [];
      await historyStoreClear();
      renderHistory();
      showToast('历史已清空', '', 'success');
    });

    $('.search-input')?.addEventListener('input', (event) => {
      state.historyQuery = event.target.value.trim();
      if (state.activeTab === 'history') renderHistory();
    });
  }

  function bindSettingsActions() {
    $('#setBlurDefault')?.addEventListener('input', (event) => {
      state.settings.defaultBlur = Number(event.target.value);
      state.blurIntensity = state.settings.defaultBlur;
      $('#setBlurVal').textContent = String(state.settings.defaultBlur);
      syncStyleSelections();
      persistSettings();
    });

    $('#setAutoDl')?.addEventListener('change', (event) => {
      state.settings.autoDownload = event.target.checked;
      persistSettings();
    });

    $('#setExif')?.addEventListener('change', (event) => {
      state.settings.keepExif = event.target.checked;
      persistSettings();
    });

    $('#keepVideoAudioToggle')?.addEventListener('change', (event) => {
      state.settings.keepVideoAudio = event.target.checked;
      persistSettings();
    });

    $('#setConcurrency')?.addEventListener('change', (event) => {
      state.settings.concurrency = Number(event.target.value);
      persistSettings();
    });

    $('#setBrandName')?.addEventListener('input', (event) => {
      state.settings.defaultBrandName = event.target.value.trim();
      persistSettings();
      if ($('#wmText') && !$('#wmText').value) $('#wmText').value = state.settings.defaultBrandName;
      updateWMPreview();
    });
  }

  async function init() {
    loadSettings();
    applySettingsToControls();
    bindNav();
    bindUpload();
    bindImageActions();
    bindVideoActions();
    bindWatermarkActions();
    bindHistoryActions();
    bindSettingsActions();

    state.db = await openHistoryDB().catch((error) => {
      console.warn('History DB unavailable', error);
      return null;
    });
    await hydrateHistory();

    updateWMPreview();
    renderImageWorkspace();
    renderVideoWorkspace();
    updateStats();
    syncStyleSelections();
    updateVideoJob(0, '上传视频并添加追踪点后，可逐帧加水印并导出结果。');

    window.addEventListener('resize', debounce(() => {
      renderImageWorkspace();
      updateVideoOverlay();
    }, 120));

    const style = document.createElement('style');
    style.textContent = '@keyframes spin { to { transform: rotate(360deg); } }';
    document.head.appendChild(style);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
