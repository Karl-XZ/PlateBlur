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
  const BUILTIN_SAMPLES = [
    { id: 'sample-de-crop-01', type: 'image', name: 'DE Crop 01', subtitle: 'Germany close crop', src: 'samples/images/de-crop-01.jpg', thumb: 'samples/images/de-crop-01.jpg' },
    { id: 'sample-de-crop-02', type: 'image', name: 'DE Crop 02', subtitle: 'Germany close crop', src: 'samples/images/de-crop-02.jpg', thumb: 'samples/images/de-crop-02.jpg' },
    { id: 'sample-nl-crop-01', type: 'image', name: 'NL Crop 01', subtitle: 'Netherlands close crop', src: 'samples/images/nl-crop-01.jpg', thumb: 'samples/images/nl-crop-01.jpg' },
    { id: 'sample-nl-crop-02', type: 'image', name: 'NL Crop 02', subtitle: 'Netherlands close crop', src: 'samples/images/nl-crop-02.jpg', thumb: 'samples/images/nl-crop-02.jpg' },
    { id: 'sample-street-scene-01', type: 'image', name: 'Street Scene 01', subtitle: 'Wide road scene', src: 'samples/images/street-scene-01.jpg', thumb: 'samples/images/street-scene-01.jpg' },
    { id: 'sample-street-scene-02', type: 'image', name: 'Street Scene 02', subtitle: 'Wide road scene', src: 'samples/images/street-scene-02.jpg', thumb: 'samples/images/street-scene-02.jpg' },
    { id: 'sample-street-scene-03', type: 'image', name: 'Street Scene 03', subtitle: 'Wide road scene', src: 'samples/images/street-scene-03.jpg', thumb: 'samples/images/street-scene-03.jpg' },
    { id: 'sample-swiss-scene-01', type: 'image', name: 'Swiss Scene 01', subtitle: 'Swiss holdout style scene', src: 'samples/images/swiss-scene-01.png', thumb: 'samples/images/swiss-scene-01.png' },
    { id: 'sample-swiss-scene-02', type: 'image', name: 'Swiss Scene 02', subtitle: 'Swiss holdout style scene', src: 'samples/images/swiss-scene-02.png', thumb: 'samples/images/swiss-scene-02.png' },
    { id: 'sample-swiss-scene-03', type: 'image', name: 'Swiss Scene 03', subtitle: 'Swiss holdout style scene', src: 'samples/images/swiss-scene-03.png', thumb: 'samples/images/swiss-scene-03.png' },
    { id: 'sample-swiss-scene-04', type: 'image', name: 'Swiss Scene 04', subtitle: 'Swiss holdout style scene', src: 'samples/images/swiss-scene-04.png', thumb: 'samples/images/swiss-scene-04.png' },
    {
      id: 'sample-nissan-rear-video',
      type: 'video',
      name: 'Rear Plate Video',
      subtitle: '12s rear plate clip',
      src: 'samples/videos/pexels-nissan-license-plate-30391326.mp4',
      thumb: 'samples/posters/pexels-nissan-license-plate-30391326-frame.jpg',
      durationLabel: '12s',
    },
  ];
  const OCR_ALPHA_REGEX = /[A-Z0-9]/i;
  const OCR_TEXT_STYLES = new Set(['brand', 'logo', 'stripe']);
  const OCR_STRICT_MAX_PASSES = 3;
  const OCR_MAX_EDGE = 2200;
  const OCR_SCRIPT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
  const OCR_WHITELIST = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const DEDICATED_DETECTOR_API = window.SHIELDPLATE_DETECTOR_API || 'http://127.0.0.1:8765';
  const DEDICATED_DETECTOR_TIMEOUT_MS = 120000;
  const DEDICATED_VIDEO_TIMEOUT_MS = 30 * 60 * 1000;
  const OCR_RUNTIME = {
    scriptPromise: null,
    workerPromise: null,
    unavailable: false,
    warned: false,
  };

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
    videoViewMode: 'original',
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
      preferGpu: false,
      videoDeepEveryFrame: false,
      defaultBlur: 10,
      defaultBrandName: 'ShieldPlate',
    },
    imageDrag: null,
    videoDrag: null,
    toastTimer: null,
    videoProcessing: false,
    privacyNoticeShown: false,
    detectorHealth: null,
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

  function withTimeout(taskFactory, timeoutMs, timeoutMessage) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(new Error(timeoutMessage)), timeoutMs);
    return Promise.resolve()
      .then(() => taskFactory(controller.signal))
      .finally(() => window.clearTimeout(timer));
  }

  async function fetchAssetBlob(url) {
    const assetResponse = await fetch(url, { cache: 'no-store' });
    if (!assetResponse.ok) {
      const status = assetResponse.status;
      throw new Error(`Failed to fetch asset: ${status}`);
      throw new Error(`鏃犳硶璇诲彇寰呮娴嬪浘鐗囷細${assetResponse.status}`);
    }
    return assetResponse.blob();
  }

  async function canvasToBlob(canvas, type = 'image/png', quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) {
          resolve(blob);
          return;
        }
        reject(new Error('Failed to serialize the current frame.'));
      }, type, quality);
    });
  }

  function readDownloadNameFromHeaders(headers, fallbackName) {
    const disposition = headers?.get?.('content-disposition') || '';
    const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
    const asciiMatch = disposition.match(/filename=\"?([^\";]+)\"?/i);
    const rawName = utf8Match?.[1] || asciiMatch?.[1] || fallbackName;
    try {
      return decodeURIComponent(rawName).replace(/[\\/:*?"<>|]+/g, '-');
    } catch (error) {
      return String(rawName || fallbackName).replace(/[\\/:*?"<>|]+/g, '-');
    }
  }

  function getDetectorPreferenceEnabled(options = {}) {
    return options.preferGpu ?? state.settings.preferGpu;
  }

  function normalizeDetectorMeta(meta) {
    if (!meta || typeof meta !== 'object') return null;
    return {
      requestedDevice: String(meta.requested_device || meta.requestedDevice || ''),
      actualDevice: String(meta.actual_device || meta.actualDevice || ''),
      gpuRequested: Boolean(meta.gpu_requested ?? meta.gpuRequested ?? false),
      gpuAttempted: Boolean(meta.gpu_attempted ?? meta.gpuAttempted ?? false),
      gpuSupported: Boolean(meta.gpu_supported ?? meta.gpuSupported ?? false),
      gpuAvailable: Boolean(meta.gpu_available ?? meta.gpuAvailable ?? false),
      gpuName: String(meta.gpu_name || meta.gpuName || ''),
      fallback: Boolean(meta.fallback ?? false),
      fallbackReason: String(meta.fallback_reason || meta.fallbackReason || ''),
      message: String(meta.message || ''),
      torchVersion: String(meta.torch_version || meta.torchVersion || ''),
      cudaBuild: String(meta.cuda_build || meta.cudaBuild || ''),
    };
  }

  function normalizeDetectorMetaFromHeaders(headers) {
    if (!headers) return null;
    return normalizeDetectorMeta({
      requested_device: headers.get('X-PlateBlur-Requested-Device') || '',
      actual_device: headers.get('X-PlateBlur-Actual-Device') || '',
      gpu_available: headers.get('X-PlateBlur-GPU-Available') === '1',
      gpu_supported: headers.get('X-PlateBlur-GPU-Supported') === '1',
      gpu_name: headers.get('X-PlateBlur-GPU-Name') || '',
      fallback: headers.get('X-PlateBlur-Fallback') === '1',
      fallback_reason: headers.get('X-PlateBlur-Fallback-Reason') || '',
      message: headers.get('X-PlateBlur-Device-Message') || '',
    });
  }

  function updateDetectorHealth(meta) {
    const normalized = normalizeDetectorMeta(meta);
    if (!normalized) return null;
    state.detectorHealth = {
      gpuSupported: normalized.gpuSupported,
      gpuAvailable: normalized.gpuAvailable,
      gpuName: normalized.gpuName,
      torchVersion: normalized.torchVersion,
      cudaBuild: normalized.cudaBuild,
      message: normalized.message,
    };
    syncDetectorPreferenceHints();
    return normalized;
  }

  function buildDetectorPreferenceHint() {
    const preferGpu = Boolean(state.settings.preferGpu);
    if (!preferGpu) {
      return '关闭时固定使用 CPU。开启后会先尝试 GPU，失败自动回退 CPU。';
    }
    if (!state.detectorHealth) {
      return '已开启 GPU 优先。深度识别会先尝试 GPU，失败时自动回退 CPU。';
    }
    if (state.detectorHealth.gpuAvailable) {
      return `当前检测服务可用 GPU：${state.detectorHealth.gpuName || 'CUDA'}`;
    }
    if (state.detectorHealth.gpuSupported) {
      return '当前未拿到可用 CUDA 设备，深度识别会自动回退 CPU。';
    }
    return '当前 Python 推理环境是 CPU 版 Torch，深度识别会自动回退 CPU。';
  }

  function buildDetectorPreferenceHintLocalized() {
    const preferGpu = Boolean(state.settings.preferGpu);
    if (!preferGpu) {
      return '关闭时固定使用 CPU。开启后会先尝试 GPU，失败后自动回退到 CPU。';
    }
    if (!state.detectorHealth) {
      return '已开启 GPU 优先。深度识别会先尝试 GPU，失败时自动回退到 CPU。';
    }
    if (state.detectorHealth.gpuAvailable) {
      return `当前检测服务可用 GPU：${state.detectorHealth.gpuName || 'CUDA'}`;
    }
    if (state.detectorHealth.gpuSupported) {
      return '当前未检测到可用 CUDA 设备，深度识别会自动回退到 CPU。';
    }
    return '当前 Python 推理环境是 CPU 版 Torch，深度识别会自动回退到 CPU。';
  }

  function syncDetectorPreferenceHints() {
    const hint = buildDetectorPreferenceHintLocalized();
    if ($('#imagePreferGpuHint')) $('#imagePreferGpuHint').textContent = hint;
    if ($('#videoPreferGpuHint')) $('#videoPreferGpuHint').textContent = hint;
    if ($('#setPreferGpuDesc')) $('#setPreferGpuDesc').textContent = hint;
  }

  function syncGpuPreferenceControls() {
    ['imagePreferGpuToggle', 'videoPreferGpuToggle', 'setPreferGpuToggle'].forEach((id) => {
      const input = document.getElementById(id);
      if (input) input.checked = Boolean(state.settings.preferGpu);
    });
    syncDetectorPreferenceHints();
  }

  async function refreshDetectorHealth(force = false) {
    if (state.detectorHealth && !force) {
      syncDetectorPreferenceHints();
      return state.detectorHealth;
    }
    try {
      const response = await withTimeout(async (signal) => fetch(`${DEDICATED_DETECTOR_API}/health`, {
        cache: 'no-store',
        signal,
      }), 12000, 'Detector health check timed out');
      if (!response.ok) {
        throw new Error(`Detector health returned ${response.status}`);
      }
      const payload = await response.json();
      updateDetectorHealth({
        gpu_supported: payload.gpu_supported,
        gpu_available: payload.gpu_available,
        gpu_name: payload.gpu_name,
        torch_version: payload.torch_version,
        cuda_build: payload.cuda_build,
      });
    } catch (error) {
      state.detectorHealth = null;
      syncDetectorPreferenceHints();
    }
    return state.detectorHealth;
  }

  function describeDetectorOutcome(meta) {
    const normalized = normalizeDetectorMeta(meta);
    if (!normalized) return '';
    if (normalized.actualDevice.startsWith('cuda')) {
      return `本次使用 GPU${normalized.gpuName ? `：${normalized.gpuName}` : ''}`;
    }
    if (normalized.requestedDevice === 'gpu' && normalized.fallback) {
      return 'GPU 不可用，已自动回退 CPU';
    }
    return '';
  }

  function describeDetectorOutcomeText(meta) {
    const normalized = normalizeDetectorMeta(meta);
    if (!normalized) return '';
    if (normalized.actualDevice.startsWith('cuda')) {
      return `本次使用 GPU${normalized.gpuName ? `：${normalized.gpuName}` : ''}`;
    }
    if (normalized.requestedDevice === 'gpu') {
      return normalized.message || 'GPU 不可用，已自动回退到 CPU';
    }
    return '';
  }

  function mergeDetectorOutcome(baseText, meta) {
    const outcome = describeDetectorOutcomeText(meta);
    return [baseText, outcome].filter(Boolean).join(' · ');
  }

  async function setGpuPreferenceEnabled(enabled) {
    state.settings.preferGpu = Boolean(enabled);
    persistSettings();
    syncGpuPreferenceControls();

    if (!state.settings.preferGpu) {
      showToast('已切换到 CPU 优先', '深度识别将直接使用 CPU。', 'info');
      return state.detectorHealth;
    }

    const health = await refreshDetectorHealth(true);
    if (!health) {
      showToast('已开启 GPU 优先', '暂时无法读取检测服务状态。深度识别会先尝试 GPU，失败后自动回退到 CPU。', 'warning');
      return null;
    }
    if (health.gpuAvailable) {
      showToast('已开启 GPU 优先', `当前可用 GPU：${health.gpuName || 'CUDA'}`, 'success');
      return health;
    }
    const fallbackHint = health.gpuSupported
      ? '当前没有可用的 CUDA 设备，深度识别会自动回退到 CPU。'
      : '当前推理环境是 CPU 版 Torch，深度识别会自动回退到 CPU。';
    showToast('已开启 GPU 优先', fallbackHint, 'warning');
    return health;
  }

  async function detectWithDedicatedDetector(url, options = {}) {
    const assetBlob = await fetchAssetBlob(url);
    return detectWithDedicatedDetectorBlob(assetBlob, {
      ...options,
      fileName: options.fileName || 'image.png',
    });
  }

  async function detectWithDedicatedDetectorBlob(assetBlob, options = {}) {
    const fileName = options.fileName || 'image.png';
    const form = new FormData();
    form.append('image', assetBlob, fileName);
    if (options.sampleId) {
      form.append('sample_id', options.sampleId);
    }
    form.append('include_text', '1');
    form.append('prefer_gpu', getDetectorPreferenceEnabled(options) ? '1' : '0');

    const payload = await withTimeout(async (signal) => {
      const response = await fetch(`${DEDICATED_DETECTOR_API}/detect/image`, {
        method: 'POST',
        body: form,
        signal,
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(detail || `Dedicated detector returned ${response.status}`);
      }
      return response.json();
    }, DEDICATED_DETECTOR_TIMEOUT_MS, 'Dedicated detector timed out');

    const dedicatedCandidates = Array.isArray(payload?.boxes) ? payload.boxes : [];
    const detector = updateDetectorHealth(payload?.detector);
    const boxes = materializeEntryBoxes(dedicatedCandidates.map((candidate) => ({
      x: Number(candidate.x) || 0,
      y: Number(candidate.y) || 0,
      w: Number(candidate.w) || 0,
      h: Number(candidate.h) || 0,
      confidence: Number(candidate.confidence) || 0.42,
      source: candidate.kind === 'text'
        ? 'ocr'
        : (candidate.source || 'dedicated-detector'),
    })));
    if (options.returnMeta) {
      return { boxes, detector };
    }
    return boxes;
  }

  async function detectWithDedicatedDetectorCanvas(canvas, options = {}) {
    const assetBlob = await canvasToBlob(canvas, 'image/png');
    return detectWithDedicatedDetectorBlob(assetBlob, {
      ...options,
      fileName: options.fileName || 'frame.png',
      sampleId: options.sampleId || '',
    });
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

  function mergeNearbySegments(segments, gap = 0) {
    if (!segments.length) return [];
    const merged = [segments[0]];
    for (let i = 1; i < segments.length; i += 1) {
      const previous = merged[merged.length - 1];
      const current = segments[i];
      if ((current.start - previous.end - 1) <= gap) {
        const prevLength = previous.end - previous.start + 1;
        const currLength = current.end - current.start + 1;
        previous.end = current.end;
        previous.avg = ((previous.avg * prevLength) + (current.avg * currLength)) / Math.max(prevLength + currLength, 1);
      } else {
        merged.push({ ...current });
      }
    }
    return merged;
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

  function candidateIntersectsExpandedSeed(candidate, seed, padX = 0.06, padY = 0.08) {
    const a = boxMetrics(normalizeBox(candidate));
    const b = boxMetrics(expandNormalizedCandidate(normalizeBox(seed), padX, padY));
    return !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
  }

  function filterCandidatesNearSeeds(candidates, seeds, padX = 0.06, padY = 0.08) {
    if (!seeds.length) return candidates;
    return candidates.filter((candidate) => seeds.some((seed) => candidateIntersectsExpandedSeed(candidate, seed, padX, padY)));
  }

  function selectCandidateBoxes(candidates, options = {}) {
    const {
      limit = 12,
      maxIoU = 0.24,
    } = options;
    const selected = [];
    const ordered = [...candidates].sort((a, b) => {
      const sourceBoostA = String(a.source || '').startsWith('plate-yellow') ? 0.12 : 0;
      const sourceBoostB = String(b.source || '').startsWith('plate-yellow') ? 0.12 : 0;
      return ((b.confidence || b.score || 0) + sourceBoostB) - ((a.confidence || a.score || 0) + sourceBoostA);
    });

    ordered.forEach((candidate) => {
      if (selected.length >= limit) return;
      const overlaps = selected.some((existing) => containsIoU(existing, candidate) > maxIoU);
      if (!overlaps) {
        selected.push(normalizeBox(candidate));
      }
    });

    return selected;
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

  function currentVideoSource(entry = currentVideo()) {
    if (!entry) return '';
    return state.videoViewMode === 'processed' && entry.processedUrl ? entry.processedUrl : entry.url;
  }

  function isViewingProcessedVideo(entry = currentVideo()) {
    return Boolean(entry?.processedUrl) && state.videoViewMode === 'processed';
  }

  function syncVideoViewModeControls() {
    const entry = currentVideo();
    const originalBtn = $('#videoOriginalModeBtn');
    const processedBtn = $('#videoProcessedModeBtn');
    if (originalBtn) {
      originalBtn.classList.toggle('active', state.videoViewMode !== 'processed');
    }
    if (processedBtn) {
      processedBtn.disabled = !entry?.processedUrl;
      processedBtn.classList.toggle('active', Boolean(entry?.processedUrl) && state.videoViewMode === 'processed');
    }
  }

  function setVideoViewMode(mode, options = {}) {
    const entry = currentVideo();
    const nextMode = mode === 'processed' && entry?.processedUrl ? 'processed' : 'original';
    if (state.videoViewMode === nextMode && !options.forceRender) {
      syncVideoViewModeControls();
      return;
    }
    state.videoViewMode = nextMode;
    syncVideoViewModeControls();
    renderVideoWorkspace(options);
  }

  function builtinSampleById(sampleId) {
    return BUILTIN_SAMPLES.find((sample) => sample.id === sampleId) || null;
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
      videoDeepEveryFrameToggle: state.settings.videoDeepEveryFrame,
      imagePreferGpuToggle: state.settings.preferGpu,
      videoPreferGpuToggle: state.settings.preferGpu,
      setPreferGpuToggle: state.settings.preferGpu,
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

    syncGpuPreferenceControls();
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

  function getVideoIdleMessage() {
    const gpuHint = state.settings.preferGpu
      ? '已开启 GPU 优先，失败时会自动回退到 CPU。'
      : '当前固定使用 CPU。';
    return isVideoDeepEveryFrameEnabled()
      ? `每帧深度识别已开启，处理视频时会逐帧调用本地专用检测器。${gpuHint}`
      : '快速模式使用追踪点插值；开启每帧深度识别后可直接整段处理。';
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

  function syncMediaBadges() {
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
  }

  function refreshImportedMedia() {
    renderVideoQueue();
    renderImageWorkspace();
    renderVideoWorkspace();
    updateStats();
    syncMediaBadges();
  }

  function focusImportedMedia(preferredTab = 'image') {
    if (preferredTab === 'video' && state.videos.length) {
      switchTab('video');
      return;
    }

    if (state.images.length) {
      switchTab('image');
      return;
    }

    if (state.videos.length) {
      switchTab('video');
    }
  }

  function makeBoxLabel(index, source) {
    if (source === 'manual') return `手动框 ${index + 1}`;
    if (source === 'fallback') return `候选框 ${index + 1}`;
    if (String(source || '').startsWith('ocr')) return `文本框 ${index + 1}`;
    return `识别框 ${index + 1}`;
  }

  function renderSampleLibrary() {
    const grid = $('#sampleLibraryGrid');
    if (!grid) return;

    grid.innerHTML = BUILTIN_SAMPLES.map((sample) => `
      <article class="sample-card" data-sample-id="${sample.id}">
        <div class="sample-card-media">
          <img src="${sample.thumb}" alt="${sample.name}" loading="lazy" />
          <span class="sample-card-type ${sample.type}">${sample.type}</span>
          ${sample.type === 'video' ? `<span class="sample-card-duration">${sample.durationLabel || ''}</span>` : ''}
        </div>
        <div class="sample-card-body">
          <strong>${sample.name}</strong>
          <span>${sample.subtitle}</span>
        </div>
        <button class="btn-secondary sample-card-action" type="button" data-sample-load="${sample.id}">Load Sample</button>
      </article>
    `).join('');

    $$('[data-sample-load]').forEach((button) => {
      button.addEventListener('click', () => {
        importBuiltInSample(button.dataset.sampleLoad);
      });
    });
  }

  function openSampleLibrary() {
    renderSampleLibrary();
    const modal = $('#sampleLibrary');
    if (!modal) return;
    modal.hidden = false;
    document.body.classList.add('sample-library-open');
  }

  function closeSampleLibrary() {
    const modal = $('#sampleLibrary');
    if (!modal) return;
    modal.hidden = true;
    document.body.classList.remove('sample-library-open');
  }

  function focusExistingBuiltInSample(sample) {
    const imageIndex = state.images.findIndex((entry) => entry.sampleId === sample.id);
    if (imageIndex >= 0) {
      loadImage(imageIndex);
      switchTab('image');
      return true;
    }

    const videoIndex = state.videos.findIndex((entry) => entry.sampleId === sample.id);
    if (videoIndex >= 0) {
      loadVideo(videoIndex);
      switchTab('video');
      return true;
    }

    return false;
  }

  async function importBuiltInSample(sampleId) {
    const sample = builtinSampleById(sampleId);
    if (!sample) return;

    if (focusExistingBuiltInSample(sample)) {
      closeSampleLibrary();
      showToast('Sample already loaded', `${sample.name} is already in the workspace.`, 'info');
      return;
    }

    showToast('Loading sample', `Preparing ${sample.name}`, 'progress', true);

    try {
      if (sample.type === 'video') {
        await registerVideoAsset({
          name: sample.name,
          url: sample.src,
          posterUrl: sample.thumb,
          sampleId: sample.id,
        });
      } else {
        await registerImageAsset({
          name: sample.name,
          url: sample.src,
          sampleId: sample.id,
        });
      }

      refreshImportedMedia();
      focusImportedMedia(sample.type === 'video' ? 'video' : 'image');
      closeSampleLibrary();
      showToast('Sample ready', `${sample.name} added to the workspace.`, 'success');
    } catch (error) {
      console.error(error);
      showToast('Sample failed', error?.message || 'Could not load the built-in sample.', 'error');
    }
  }

  function shouldWarnAboutOCR() {
    return !OCR_RUNTIME.warned;
  }

  function markOCRWarningShown() {
    OCR_RUNTIME.warned = true;
  }

  function getPrivacySafeStyle(style) {
    return OCR_TEXT_STYLES.has(style) ? 'block' : style;
  }

  function maybeWarnAboutStrictPrivacyStyle(style) {
    if (OCR_TEXT_STYLES.has(style) && !state.privacyNoticeShown) {
      state.privacyNoticeShown = true;
      showToast('Strict privacy override', 'Text watermark styles are downgraded to solid blocks so OCR can no longer read letters or digits.', 'warning');
    }
  }

  function expandNormalizedCandidate(candidate, padX, padY) {
    return normalizeBox({
      ...candidate,
      x: candidate.x - padX,
      y: candidate.y - padY,
      w: candidate.w + (padX * 2),
      h: candidate.h + (padY * 2),
    });
  }

  function boxMetrics(box) {
    return {
      left: box.x,
      right: box.x + box.w,
      top: box.y,
      bottom: box.y + box.h,
      area: box.w * box.h,
    };
  }

  function boxesShouldMerge(a, b, options = {}) {
    const { loose = true } = options;
    const am = boxMetrics(a);
    const bm = boxMetrics(b);
    const horizontalOverlap = Math.max(0, Math.min(am.right, bm.right) - Math.max(am.left, bm.left));
    const verticalOverlap = Math.max(0, Math.min(am.bottom, bm.bottom) - Math.max(am.top, bm.top));
    const horizontalGap = Math.max(0, Math.max(am.left, bm.left) - Math.min(am.right, bm.right));
    const verticalGap = Math.max(0, Math.max(am.top, bm.top) - Math.min(am.bottom, bm.bottom));
    const overlapRatio = (horizontalOverlap * verticalOverlap) / Math.max(Math.min(am.area, bm.area), 0.0001);
    if (!loose) {
      return overlapRatio > 0.18;
    }
    const lineMerge = verticalOverlap / Math.max(Math.min(a.h, b.h), 0.0001) > 0.42
      && horizontalGap < Math.max(a.h, b.h) * 1.35;
    const columnMerge = horizontalOverlap / Math.max(Math.min(a.w, b.w), 0.0001) > 0.35
      && verticalGap < Math.max(a.h, b.h) * 0.65;

    return overlapRatio > 0.18 || lineMerge || columnMerge;
  }

  function mergeTwoBoxes(a, b) {
    const left = Math.min(a.x, b.x);
    const top = Math.min(a.y, b.y);
    const right = Math.max(a.x + a.w, b.x + b.w);
    const bottom = Math.max(a.y + a.h, b.y + b.h);
    return normalizeBox({
      ...a,
      x: left,
      y: top,
      w: right - left,
      h: bottom - top,
      confidence: Math.max(a.confidence || 0, b.confidence || 0),
      score: Math.max(a.score || 0, b.score || 0),
      source: a.source === 'ocr-verify' || b.source === 'ocr-verify' ? 'ocr-verify' : (a.source || b.source || 'auto'),
    });
  }

  function mergeCandidateBoxes(candidates, options = {}) {
    const {
      padX = 0.028,
      padY = 0.042,
      limit = 32,
      loose = true,
    } = options;

    const working = candidates
      .filter((candidate) => candidate && candidate.w > 0.01 && candidate.h > 0.01)
      .map((candidate) => expandNormalizedCandidate(normalizeBox(candidate), padX, padY))
      .sort((a, b) => (b.confidence || b.score || 0) - (a.confidence || a.score || 0));

    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i < working.length; i += 1) {
        for (let j = i + 1; j < working.length; j += 1) {
          if (boxesShouldMerge(working[i], working[j], { loose })) {
            working[i] = mergeTwoBoxes(working[i], working[j]);
            working.splice(j, 1);
            changed = true;
            break;
          }
        }
        if (changed) break;
      }
    }

    return working
      .sort((a, b) => (b.confidence || b.score || 0) - (a.confidence || a.score || 0))
      .slice(0, limit);
  }

  function isOversizedDetectionCandidate(candidate, options = {}) {
    if (!candidate) return true;
    const source = String(candidate.source || '');
    const isOCRDriven = source.startsWith('ocr');
    const area = candidate.w * candidate.h;
    const maxHeight = options.verification ? 0.28 : (isOCRDriven ? 0.22 : 0.18);
    const maxArea = options.verification ? 0.22 : (isOCRDriven ? 0.16 : 0.11);
    const maxWideWidth = options.verification ? 0.92 : (isOCRDriven ? 0.82 : 0.72);
    const maxWideHeight = options.verification ? 0.22 : 0.13;

    if (candidate.h > maxHeight) return true;
    if (area > maxArea) return true;
    if (candidate.w > maxWideWidth && candidate.h > maxWideHeight) return true;

    return false;
  }

  function filterOversizedDetectionCandidates(candidates, options = {}) {
    return candidates.filter((candidate) => !isOversizedDetectionCandidate(candidate, options));
  }

  function isOversizedVerificationBox(candidate) {
    if (!candidate) return true;
    const area = candidate.w * candidate.h;
    if (candidate.h > 0.2) return true;
    if (area > 0.12) return true;
    if (candidate.w > 0.6 && candidate.h > 0.08) return true;
    return false;
  }

  function unionCandidateBoxes(a, b, source = null) {
    const left = Math.min(a.x, b.x);
    const top = Math.min(a.y, b.y);
    const right = Math.max(a.x + a.w, b.x + b.w);
    const bottom = Math.max(a.y + a.h, b.y + b.h);
    return normalizeBox({
      x: left,
      y: top,
      w: right - left,
      h: bottom - top,
      confidence: Math.max(a.confidence || 0, b.confidence || 0),
      score: Math.max(a.score || 0, b.score || 0),
      source: source || a.source || b.source || 'auto',
    });
  }

  function clusterLinearPlateCandidates(candidates, options = {}) {
    const {
      maxHorizontalGapFactor = 1.9,
      maxVerticalCenterShiftFactor = 0.7,
      minVerticalOverlap = 0.5,
      maxClusterWidth = 0.34,
      maxClusterHeight = 0.12,
      minClusterWidth = 0.11,
    } = options;
    const ordered = selectCandidateBoxes(candidates, {
      limit: 24,
      maxIoU: 0.08,
    }).sort((a, b) => {
      const ay = a.y + (a.h / 2);
      const by = b.y + (b.h / 2);
      if (Math.abs(ay - by) > 0.015) return ay - by;
      return a.x - b.x;
    });
    const used = new Uint8Array(ordered.length);
    const clusters = [];

    for (let i = 0; i < ordered.length; i += 1) {
      if (used[i]) continue;
      used[i] = 1;
      let merged = normalizeBox(ordered[i]);
      let maxConfidence = merged.confidence || merged.score || 0;
      let memberCount = 1;
      let changed = true;

      while (changed) {
        changed = false;
        for (let j = 0; j < ordered.length; j += 1) {
          if (used[j]) continue;
          const candidate = normalizeBox(ordered[j]);
          const mergedMetrics = boxMetrics(merged);
          const candidateMetrics = boxMetrics(candidate);
          const verticalOverlap = Math.max(0, Math.min(mergedMetrics.bottom, candidateMetrics.bottom) - Math.max(mergedMetrics.top, candidateMetrics.top));
          const verticalOverlapRatio = verticalOverlap / Math.max(Math.min(merged.h, candidate.h), 0.0001);
          const horizontalGap = Math.max(0, Math.max(mergedMetrics.left, candidateMetrics.left) - Math.min(mergedMetrics.right, candidateMetrics.right));
          const centerShift = Math.abs((merged.y + (merged.h / 2)) - (candidate.y + (candidate.h / 2)));
          const mergedBox = unionCandidateBoxes(merged, candidate, 'plate-yellow');

          if (verticalOverlapRatio < minVerticalOverlap) continue;
          if (horizontalGap > (Math.max(merged.h, candidate.h) * maxHorizontalGapFactor)) continue;
          if (centerShift > (Math.max(merged.h, candidate.h) * maxVerticalCenterShiftFactor)) continue;
          if (mergedBox.w > maxClusterWidth || mergedBox.h > maxClusterHeight) continue;

          used[j] = 1;
          merged = mergedBox;
          maxConfidence = Math.max(maxConfidence, candidate.confidence || candidate.score || 0);
          memberCount += 1;
          changed = true;
        }
      }

      if (memberCount > 1 || merged.w >= minClusterWidth) {
        clusters.push({
          ...merged,
          confidence: clamp(maxConfidence + (Math.min(memberCount - 1, 4) * 0.03), 0.32, 0.99),
          source: 'plate-yellow',
        });
      }
    }

    return selectCandidateBoxes(clusters, {
      limit: 8,
      maxIoU: 0.16,
    });
  }

  function finalizeOCRCandidates(candidates, options = {}) {
    const verification = Boolean(options.verification);
    const normalized = candidates
      .filter((candidate) => candidate && candidate.w > 0.004 && candidate.h > 0.004)
      .map((candidate) => normalizeBox(candidate))
      .filter((candidate) => (candidate.w * candidate.h) < (verification ? 0.16 : 0.28));

    if (!normalized.length) return [];

    if (verification) {
      return selectCandidateBoxes(
        normalized.map((candidate) => expandNormalizedCandidate(candidate, 0.01, 0.018)),
        {
          limit: 72,
          maxIoU: 0.16,
        }
      ).filter((candidate) => !isOversizedVerificationBox(candidate))
        .map((candidate) => ({
          ...candidate,
          source: 'ocr-verify',
        }));
    }

    const merged = mergeCandidateBoxes(normalized, {
      padX: 0.022,
      padY: 0.034,
      limit: 32,
      loose: false,
    }).filter((candidate) => (candidate.w * candidate.h) < 0.28);

    return merged.map((candidate) => ({
      ...candidate,
      source: 'ocr',
    }));
  }

  function integrateVerificationCandidates(baseCandidates, verificationCandidates, options = {}) {
    const {
      expandPadX = 0.018,
      expandPadY = 0.03,
      limit = 72,
    } = options;
    const result = (baseCandidates || []).map((candidate) => normalizeBox(candidate));
    const orderedVerification = (verificationCandidates || [])
      .map((candidate) => expandNormalizedCandidate(normalizeBox(candidate), expandPadX, expandPadY))
      .filter((candidate) => !isOversizedVerificationBox(candidate))
      .sort((a, b) => (b.confidence || 0) - (a.confidence || 0));

    orderedVerification.forEach((candidate) => {
      let merged = false;
      for (let i = 0; i < result.length; i += 1) {
        const existing = result[i];
        if (!candidateIntersectsExpandedSeed(candidate, existing, 0.01, 0.02)) {
          continue;
        }

        const union = unionCandidateBoxes(existing, candidate, existing.source === 'ocr-verify' ? 'ocr-verify' : existing.source);
        if (isOversizedVerificationBox(union)) {
          continue;
        }
        result[i] = union;
        merged = true;
        break;
      }

      if (!merged) {
        result.push({
          ...candidate,
          source: 'ocr-verify',
        });
      }
    });

    return selectCandidateBoxes(result, {
      limit,
      maxIoU: 0.18,
    });
  }

  function buildOCRVerificationRenderConfig() {
    return {
      template: 'block',
      text: '',
      textColor: '#FFFFFF',
      backgroundColor: '#06070A',
      radius: 8,
      fontSize: 12,
      opacity: 1,
      blurStrength: 14,
    };
  }

  function slidingPositions(length, window, overlap) {
    if (length <= window) return [0];

    const step = Math.max(1, Math.round(window * (1 - overlap)));
    const positions = [];
    for (let pos = 0; pos <= Math.max(length - window, 0); pos += step) {
      positions.push(pos);
    }
    const tail = length - window;
    if (positions[positions.length - 1] !== tail) {
      positions.push(tail);
    }
    return positions;
  }

  function makeOCRTileRects(width, height) {
    const longest = Math.max(width, height);
    if (longest < 900) return [];

    const tile = longest > 1800 ? 1280 : 960;
    const overlap = 0.38;
    const xPositions = slidingPositions(width, Math.min(tile, width), overlap);
    const yPositions = slidingPositions(height, Math.min(tile, height), overlap);

    return yPositions.flatMap((y) => xPositions.map((x) => ({
      x,
      y,
      width: Math.min(tile, width - x),
      height: Math.min(tile, height - y),
    })));
  }

  function cropCanvas(sourceCanvas, rect) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(rect.width));
    canvas.height = Math.max(1, Math.round(rect.height));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(
      sourceCanvas,
      rect.x,
      rect.y,
      rect.width,
      rect.height,
      0,
      0,
      canvas.width,
      canvas.height
    );
    return canvas;
  }

  function buildIntegralImage(values, width, height) {
    const integral = new Float32Array((width + 1) * (height + 1));
    for (let y = 1; y <= height; y += 1) {
      let rowSum = 0;
      for (let x = 1; x <= width; x += 1) {
        rowSum += values[((y - 1) * width) + (x - 1)];
        integral[(y * (width + 1)) + x] = integral[((y - 1) * (width + 1)) + x] + rowSum;
      }
    }
    return integral;
  }

  function integralRegionSum(integral, width, x, y, w, h) {
    const stride = width + 1;
    const x1 = Math.max(0, Math.min(width, x));
    const y1 = Math.max(0, y);
    const x2 = Math.max(x1, Math.min(width, x + w));
    const y2 = Math.max(y1, y + h);
    return integral[(y2 * stride) + x2]
      - integral[(y1 * stride) + x2]
      - integral[(y2 * stride) + x1]
      + integral[(y1 * stride) + x1];
  }

  function collectMaskComponents(mask, width, height, gray, source) {
    const visited = new Uint8Array(mask.length);
    const candidates = [];

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const start = (y * width) + x;
        if (!mask[start] || visited[start]) continue;

        const stack = [start];
        visited[start] = 1;

        let count = 0;
        let minX = x;
        let maxX = x;
        let minY = y;
        let maxY = y;

        while (stack.length) {
          const idx = stack.pop();
          const py = Math.floor(idx / width);
          const px = idx - (py * width);
          count += 1;
          if (px < minX) minX = px;
          if (px > maxX) maxX = px;
          if (py < minY) minY = py;
          if (py > maxY) maxY = py;

          for (let ny = Math.max(0, py - 1); ny <= Math.min(height - 1, py + 1); ny += 1) {
            for (let nx = Math.max(0, px - 1); nx <= Math.min(width - 1, px + 1); nx += 1) {
              const neighbor = (ny * width) + nx;
              if (!mask[neighbor] || visited[neighbor]) continue;
              visited[neighbor] = 1;
              stack.push(neighbor);
            }
          }
        }

        if (count < 24) continue;

        const bboxWidth = maxX - minX + 1;
        const bboxHeight = maxY - minY + 1;
        const bboxArea = bboxWidth * bboxHeight;
        const ratio = bboxWidth / Math.max(bboxHeight, 1);
        const areaRatio = bboxArea / Math.max(width * height, 1);
        const fillRatio = count / Math.max(bboxArea, 1);
        const centerY = (minY + (bboxHeight / 2)) / height;

        if (ratio < 1.8 || ratio > 7.8) continue;
        if (areaRatio < 0.0005 || areaRatio > 0.12) continue;
        if (fillRatio < (source === 'plate-yellow' ? 0.42 : 0.34)) continue;
        if (centerY < 0.34) continue;

        let darkCount = 0;
        let brightCount = 0;
        let edgeCount = 0;
        for (let by = minY; by <= maxY; by += 1) {
          for (let bx = minX; bx <= maxX; bx += 1) {
            const pixel = (by * width) + bx;
            const value = gray[pixel];
            if (value < 118) darkCount += 1;
            if (value > 150) brightCount += 1;
            if (bx > minX) {
              const prev = gray[pixel - 1];
              if (Math.abs(value - prev) > 24) edgeCount += 1;
            }
          }
        }

        const darkRatio = darkCount / Math.max(bboxArea, 1);
        const brightRatio = brightCount / Math.max(bboxArea, 1);
        const edgeRatio = edgeCount / Math.max(bboxArea, 1);

        if (darkRatio < 0.06 || darkRatio > 0.52) continue;
        if (brightRatio < (source === 'plate-yellow' ? 0.2 : 0.32)) continue;
        if (edgeRatio < 0.04) continue;

        const positionBias = clamp((centerY - 0.34) / 0.6, 0, 1);
        const confidenceBase = source === 'plate-yellow' ? 0.68 : 0.58;
        candidates.push({
          x: minX / width,
          y: minY / height,
          w: bboxWidth / width,
          h: bboxHeight / height,
          confidence: clamp(confidenceBase + (fillRatio * 0.1) + (darkRatio * 0.12) + (positionBias * 0.08), 0.28, 0.96),
          source,
        });
      }
    }

    return candidates;
  }

  function detectColorPlateCandidatesFromCanvas(sourceCanvas, sourceWidth, sourceHeight) {
    const maxWidth = 840;
    const scale = Math.min(1, maxWidth / sourceWidth);
    const width = Math.max(96, Math.round(sourceWidth * scale));
    const height = Math.max(96, Math.round(sourceHeight * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(sourceCanvas, 0, 0, width, height);

    const { data } = ctx.getImageData(0, 0, width, height);
    const gray = new Float32Array(width * height);
    const whiteMask = new Uint8Array(width * height);
    const yellowMask = new Uint8Array(width * height);

    for (let i = 0; i < gray.length; i += 1) {
      const idx = i * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const saturation = max - min;
      const value = (r * 0.299) + (g * 0.587) + (b * 0.114);
      gray[i] = value;

      const y = Math.floor(i / width) / height;
      if (y < 0.3) continue;

      if (value > 152 && value < 248 && saturation < 40) {
        whiteMask[i] = 1;
      }

      if (r > 96 && g > 82 && b < 150 && (r - b) > 36 && (g - b) > 18 && value > 88) {
        yellowMask[i] = 1;
      }
    }

    const whiteCandidates = collectMaskComponents(whiteMask, width, height, gray, 'plate-white');
    const yellowCandidates = collectMaskComponents(yellowMask, width, height, gray, 'plate-yellow');
    return mergeCandidateBoxes([...yellowCandidates, ...whiteCandidates], {
      padX: 0.012,
      padY: 0.02,
      limit: 16,
      loose: false,
    });
  }

  function detectYellowProjectionPlateCandidatesFromCanvas(sourceCanvas, sourceWidth, sourceHeight) {
    const maxWidth = 900;
    const scale = Math.min(1, maxWidth / sourceWidth);
    const width = Math.max(120, Math.round(sourceWidth * scale));
    const height = Math.max(120, Math.round(sourceHeight * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(sourceCanvas, 0, 0, width, height);

    const { data } = ctx.getImageData(0, 0, width, height);
    const yellowMask = new Float32Array(width * height);
    const gray = new Float32Array(width * height);

    for (let i = 0; i < gray.length; i += 1) {
      const idx = i * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      const value = (r * 0.299) + (g * 0.587) + (b * 0.114);
      gray[i] = value;

      if (
        r > 70
        && g > 44
        && b < 96
        && (r - b) > 54
        && (g - b) > 24
        && (g / Math.max(r, 1)) > 0.46
        && (r - g) < 82
      ) {
        yellowMask[i] = 1;
      }
    }

    const rowDensity = new Float32Array(height);
    for (let y = 0; y < height; y += 1) {
      let sum = 0;
      for (let x = 0; x < width; x += 1) {
        sum += yellowMask[(y * width) + x];
      }
      rowDensity[y] = sum / width;
    }

    const smoothRows = smoothSignal(rowDensity, 3);
    const rowStats = meanAndStd(Array.from(smoothRows));
    const rowThreshold = Math.max(0.018, rowStats.mean + (rowStats.std * 1.1));
    const rowBands = mergeNearbySegments(
      groupedSegments(smoothRows, rowThreshold, Math.max(4, Math.round(height * 0.012))),
      Math.max(6, Math.round(height * 0.012))
    );
    const candidates = [];

    rowBands.forEach((band) => {
      const y1 = Math.max(0, band.start - 4);
      const y2 = Math.min(height - 1, band.end + 4);
      const bandHeight = y2 - y1 + 1;
      const centerY = (y1 + (bandHeight / 2)) / height;
      if (centerY < 0.55) return;

      const colDensity = new Float32Array(width);
      for (let x = 0; x < width; x += 1) {
        let sum = 0;
        for (let y = y1; y <= y2; y += 1) {
          sum += yellowMask[(y * width) + x];
        }
        colDensity[x] = sum / bandHeight;
      }

      const smoothCols = smoothSignal(colDensity, 2);
      const colStats = meanAndStd(Array.from(smoothCols));
      const colThreshold = Math.max(0.04, colStats.mean + (colStats.std * 0.38));
      const colBands = mergeNearbySegments(
        groupedSegments(smoothCols, colThreshold, Math.max(8, Math.round(width * 0.008))),
        Math.max(10, bandHeight)
      );

      colBands.forEach((colBand) => {
        const x1 = Math.max(0, colBand.start - 4);
        const x2 = Math.min(width - 1, colBand.end + 4);
        const boxWidth = x2 - x1 + 1;
        const ratio = boxWidth / Math.max(bandHeight, 1);
        const areaRatio = (boxWidth * bandHeight) / (width * height);
        const centerX = (x1 + (boxWidth / 2)) / width;

        if (ratio < 2.4 || ratio > 7.6) return;
        if (areaRatio < 0.0005 || areaRatio > 0.06) return;
        if (centerX < 0.12 || centerX > 0.88) return;

        let yellowCount = 0;
        let darkCount = 0;
        let edgeCount = 0;
        for (let y = y1; y <= y2; y += 1) {
          for (let x = x1; x <= x2; x += 1) {
            const pixel = (y * width) + x;
            const value = gray[pixel];
            if (yellowMask[pixel]) yellowCount += 1;
            if (value < 122) darkCount += 1;
            if (x > x1 && Math.abs(value - gray[pixel - 1]) > 22) edgeCount += 1;
          }
        }

        const area = boxWidth * bandHeight;
        const yellowRatio = yellowCount / area;
        const darkRatio = darkCount / area;
        const edgeRatio = edgeCount / area;

        if (yellowRatio < 0.12) return;
        if (darkRatio < 0.08 || darkRatio > 0.45) return;
        if (edgeRatio < 0.03) return;

        const lowerBias = clamp((centerY - 0.55) / 0.35, 0, 1);
        const centerBias = 1 - Math.min(1, Math.abs(centerX - 0.5) / 0.5);
        const confidence = clamp(
          0.42
          + (Math.min(yellowRatio, 0.42) * 0.7)
          + (Math.min(darkRatio, 0.22) * 0.65)
          + (Math.min(edgeRatio, 0.12) * 0.8)
          + (lowerBias * 0.08)
          + (centerBias * 0.08),
          0.34,
          0.99
        );

        candidates.push({
          x: x1 / width,
          y: y1 / height,
          w: boxWidth / width,
          h: bandHeight / height,
          confidence,
          source: 'plate-yellow',
        });
      });
    });

    return selectCandidateBoxes(candidates, {
      limit: 10,
      maxIoU: 0.18,
    });
  }

  function detectYellowSlidingPlateCandidatesFromCanvas(sourceCanvas, sourceWidth, sourceHeight) {
    const maxWidth = 960;
    const scale = Math.min(1, maxWidth / sourceWidth);
    const width = Math.max(140, Math.round(sourceWidth * scale));
    const height = Math.max(140, Math.round(sourceHeight * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(sourceCanvas, 0, 0, width, height);

    const { data } = ctx.getImageData(0, 0, width, height);
    const yellowMask = new Float32Array(width * height);
    const blueMask = new Float32Array(width * height);
    const edgeMask = new Float32Array(width * height);
    const gray = new Float32Array(width * height);

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = (y * width) + x;
        const offset = index * 4;
        const r = data[offset];
        const g = data[offset + 1];
        const b = data[offset + 2];
        const value = (r * 0.299) + (g * 0.587) + (b * 0.114);
        gray[index] = value;

        if (
          r > 68
          && g > 44
          && b < 110
          && (r - b) > 48
          && (g - b) > 20
          && (g / Math.max(r, 1)) > 0.44
          && (r - g) < 88
        ) {
          yellowMask[index] = 1;
        }

        if (b > 44 && b > (r * 1.04) && b > (g * 1.02) && value < 148) {
          blueMask[index] = 1;
        }

        let edge = 0;
        if (x > 0 && Math.abs(value - gray[index - 1]) > 18) edge = 1;
        if (!edge && y > 0 && Math.abs(value - gray[index - width]) > 18) edge = 1;
        edgeMask[index] = edge;
      }
    }

    const yellowIntegral = buildIntegralImage(yellowMask, width, height);
    const blueIntegral = buildIntegralImage(blueMask, width, height);
    const edgeIntegral = buildIntegralImage(edgeMask, width, height);
    const rawCandidates = [];

    const minBoxHeight = Math.max(24, Math.round(height * 0.038));
    const maxBoxHeight = Math.min(Math.round(height * 0.11), 76);
    const heightStep = Math.max(4, Math.round(height * 0.006));
    const ratios = [2.8, 3.2, 3.6, 4.0, 4.4, 4.8, 5.2];
    const startY = Math.round(height * 0.55);
    const endY = Math.round(height * 0.92);
    const xMin = Math.round(width * 0.08);
    const xMax = Math.round(width * 0.9);

    for (let boxHeight = minBoxHeight; boxHeight <= maxBoxHeight; boxHeight += heightStep) {
      for (const ratio of ratios) {
        const boxWidth = Math.round(boxHeight * ratio);
        if (boxWidth < Math.round(width * 0.075) || boxWidth > Math.round(width * 0.34)) continue;

        for (let y = startY; y <= (endY - boxHeight); y += 4) {
          for (let x = xMin; x <= (xMax - boxWidth); x += 4) {
            const area = boxWidth * boxHeight;
            const leftBandWidth = Math.max(8, Math.round(boxWidth * 0.18));
            const innerX = x + Math.max(2, Math.round(boxWidth * 0.08));
            const innerWidth = Math.max(8, boxWidth - Math.max(4, Math.round(boxWidth * 0.16)));
            const yellowRatio = integralRegionSum(yellowIntegral, width, x, y, boxWidth, boxHeight) / area;
            const yellowCoreRatio = integralRegionSum(yellowIntegral, width, innerX, y, innerWidth, boxHeight) / Math.max(innerWidth * boxHeight, 1);
            const blueLeftRatio = integralRegionSum(blueIntegral, width, x, y, leftBandWidth, boxHeight) / Math.max(leftBandWidth * boxHeight, 1);
            const edgeRatio = integralRegionSum(edgeIntegral, width, x, y, boxWidth, boxHeight) / area;
            const centerX = (x + (boxWidth / 2)) / width;
            const centerY = (y + (boxHeight / 2)) / height;

            if (yellowRatio < 0.08) continue;
            if (yellowCoreRatio < 0.1) continue;
            if (edgeRatio < 0.045) continue;
            if (centerX < 0.12 || centerX > 0.88) continue;
            if (centerY < 0.58 || centerY > 0.9) continue;
            if (yellowRatio < 0.11 && blueLeftRatio < 0.015) continue;

            const centerBias = 1 - Math.min(1, Math.abs(centerX - 0.5) / 0.5);
            const lowerBias = clamp((centerY - 0.56) / 0.26, 0, 1);
            const confidence = clamp(
              0.36
              + (Math.min(yellowCoreRatio, 0.72) * 0.72)
              + (Math.min(edgeRatio, 0.18) * 0.58)
              + (Math.min(blueLeftRatio, 0.12) * 0.2)
              + (centerBias * 0.05)
              + (lowerBias * 0.06),
              0.28,
              0.99
            );

            rawCandidates.push({
              x: x / width,
              y: y / height,
              w: boxWidth / width,
              h: boxHeight / height,
              confidence,
              source: 'plate-yellow-window',
            });
          }
        }
      }
    }

    const selectedWindows = selectCandidateBoxes(rawCandidates, {
      limit: 24,
      maxIoU: 0.08,
    });
    const clustered = clusterLinearPlateCandidates(selectedWindows, {
      maxHorizontalGapFactor: 2.1,
      maxVerticalCenterShiftFactor: 0.75,
      minVerticalOverlap: 0.46,
      maxClusterWidth: 0.32,
      maxClusterHeight: 0.12,
      minClusterWidth: 0.12,
    });

    return clustered.length ? clustered : selectedWindows.slice(0, 6);
  }

  function detectRectPlateCandidatesFromCanvas(sourceCanvas, sourceWidth, sourceHeight) {
    const maxWidth = 840;
    const scale = Math.min(1, maxWidth / sourceWidth);
    const width = Math.max(120, Math.round(sourceWidth * scale));
    const height = Math.max(120, Math.round(sourceHeight * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(sourceCanvas, 0, 0, width, height);

    const { data } = ctx.getImageData(0, 0, width, height);
    const yellowMask = new Float32Array(width * height);
    const whiteMask = new Float32Array(width * height);
    const darkMask = new Float32Array(width * height);
    const edgeMask = new Float32Array(width * height);
    const gray = new Float32Array(width * height);

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = (y * width) + x;
        const idx = index * 4;
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const sat = max - min;
        const value = (r * 0.299) + (g * 0.587) + (b * 0.114);
        gray[index] = value;

        if (
          r > 70
          && g > 46
          && b < 170
          && (r - b) > 28
          && (g - b) > 14
          && (r - g) < 88
          && (g / Math.max(r, 1)) > 0.46
        ) {
          yellowMask[index] = 1;
        }
        if (value > 148 && sat < 62) {
          whiteMask[index] = 1;
        }
        if (value < 118) {
          darkMask[index] = 1;
        }
      }
    }

    for (let y = 0; y < height; y += 1) {
      for (let x = 1; x < width; x += 1) {
        const index = (y * width) + x;
        if (Math.abs(gray[index] - gray[index - 1]) > 26) {
          edgeMask[index] = 1;
        }
      }
    }

    const yellowIntegral = buildIntegralImage(yellowMask, width, height);
    const whiteIntegral = buildIntegralImage(whiteMask, width, height);
    const darkIntegral = buildIntegralImage(darkMask, width, height);
    const edgeIntegral = buildIntegralImage(edgeMask, width, height);

    const heights = [18, 24, 30, 36, 42, 48, 54, 60]
      .map((value) => Math.round(value * scale))
      .filter((value, index, list) => value >= 12 && list.indexOf(value) === index);
    const ratios = [3.2, 4.2, 5.2];
    const candidates = [];

    for (const windowHeight of heights) {
      const yStep = Math.max(3, Math.round(windowHeight / 4));
      for (const ratio of ratios) {
        const windowWidth = Math.round(windowHeight * ratio);
        if (windowWidth >= width) continue;
        const xStep = Math.max(3, Math.round(windowHeight / 4));

        for (let y = Math.round(height * 0.52); y <= height - windowHeight; y += yStep) {
          for (let x = 0; x <= width - windowWidth; x += xStep) {
            const area = windowWidth * windowHeight;
            const yellowRatio = integralRegionSum(yellowIntegral, width, x, y, windowWidth, windowHeight) / area;
            const whiteRatio = integralRegionSum(whiteIntegral, width, x, y, windowWidth, windowHeight) / area;
            const darkRatio = integralRegionSum(darkIntegral, width, x, y, windowWidth, windowHeight) / area;
            const edgeRatio = integralRegionSum(edgeIntegral, width, x, y, windowWidth, windowHeight) / area;
            const backgroundRatio = yellowRatio + whiteRatio;

            if (backgroundRatio < 0.16 || backgroundRatio > 0.9) continue;
            if (darkRatio < 0.06 || darkRatio > 0.52) continue;
            if (edgeRatio < 0.045) continue;
            if (yellowRatio < 0.08 && whiteRatio < 0.22) continue;

            const centerY = (y + (windowHeight / 2)) / height;
            const centerX = (x + (windowWidth / 2)) / width;
            if (centerX < 0.08 || centerX > 0.92) continue;
            if (whiteRatio > yellowRatio && (centerX < 0.16 || centerX > 0.84)) continue;
            const lowerBias = clamp((centerY - 0.45) / 0.45, 0, 1);
            const centerBias = 1 - Math.min(1, Math.abs(centerX - 0.5) / 0.5);
            const areaPenalty = clamp(1 - ((windowWidth * windowHeight) / Math.max((width * height * 0.06), 1)), 0, 1);
            const confidence = clamp(
              0.34
              + (Math.min(backgroundRatio, 0.55) * 0.35)
              + (Math.min(darkRatio, 0.24) * 0.65)
              + (Math.min(edgeRatio, 0.18) * 0.7)
              + (yellowRatio > whiteRatio ? 0.14 : 0)
              + (lowerBias * 0.1)
              + (centerBias * 0.08),
              0.24,
              0.98
            ) * (0.78 + (areaPenalty * 0.22));

            candidates.push({
              x: x / width,
              y: y / height,
              w: windowWidth / width,
              h: windowHeight / height,
              confidence: clamp(confidence,
              0.24,
              0.98),
              source: yellowRatio > whiteRatio ? 'plate-yellow' : 'plate-white',
            });
          }
        }
      }
    }

    const yellowPreferred = candidates.filter((candidate) => candidate.source === 'plate-yellow');
    const pool = yellowPreferred.length ? yellowPreferred : candidates;
    return selectCandidateBoxes(pool, {
      limit: 16,
      maxIoU: 0.18,
    });
  }

  function buildOCRVariantCanvas(sourceCanvas, spec) {
    const longest = Math.max(sourceCanvas.width, sourceCanvas.height);
    const targetScale = Math.max(1, spec.scale || 1);
    const maxScale = OCR_MAX_EDGE / Math.max(longest, 1);
    const appliedScale = Math.max(1, Math.min(targetScale, maxScale));
    const width = Math.max(32, Math.round(sourceCanvas.width * appliedScale));
    const height = Math.max(32, Math.round(sourceCanvas.height * appliedScale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(sourceCanvas, 0, 0, width, height);

    if (!spec.grayscale && !spec.threshold && !spec.invert && !spec.contrast) {
      return canvas;
    }

    const imageData = ctx.getImageData(0, 0, width, height);
    const { data } = imageData;
    const grays = new Float32Array(width * height);
    let graySum = 0;

    for (let i = 0; i < grays.length; i += 1) {
      const idx = i * 4;
      let gray = (data[idx] * 0.299) + (data[idx + 1] * 0.587) + (data[idx + 2] * 0.114);
      if (spec.contrast) {
        gray = clamp(((gray - 128) * spec.contrast) + 128, 0, 255);
      }
      grays[i] = gray;
      graySum += gray;
    }

    const mean = graySum / Math.max(grays.length, 1);
    let variance = 0;
    for (let i = 0; i < grays.length; i += 1) {
      variance += (grays[i] - mean) ** 2;
    }
    const std = Math.sqrt(variance / Math.max(grays.length, 1));
    const threshold = spec.threshold
      ? clamp(mean + (std * (spec.thresholdBias ?? 0.1)), 72, 196)
      : null;

    for (let i = 0; i < grays.length; i += 1) {
      const idx = i * 4;
      let gray = grays[i];
      if (threshold !== null) {
        gray = gray >= threshold ? 255 : 0;
      }
      if (spec.invert) {
        gray = 255 - gray;
      }
      if (spec.grayscale || threshold !== null || spec.invert) {
        data[idx] = gray;
        data[idx + 1] = gray;
        data[idx + 2] = gray;
      }
    }

    ctx.putImageData(imageData, 0, 0);
    return canvas;
  }

  function collectOCRNodes(result) {
    const words = Array.isArray(result?.data?.words) ? [...result.data.words] : [];
    const symbols = Array.isArray(result?.data?.symbols) ? [...result.data.symbols] : [];

    words.forEach((word) => {
      if (Array.isArray(word?.symbols)) {
        symbols.push(...word.symbols);
      }
    });

    return [...words, ...symbols];
  }

  function normalizeOCRText(text) {
    return String(text || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  function ocrNodeToCandidate(node, variantCanvas, sourceRect, fullWidth, fullHeight) {
    const bbox = node?.bbox;
    if (!bbox) return null;

    const normalizedText = normalizeOCRText(node.text);
    if (!normalizedText || !OCR_ALPHA_REGEX.test(normalizedText)) {
      return null;
    }

    const left = sourceRect.x + ((bbox.x0 / variantCanvas.width) * sourceRect.width);
    const top = sourceRect.y + ((bbox.y0 / variantCanvas.height) * sourceRect.height);
    const right = sourceRect.x + ((bbox.x1 / variantCanvas.width) * sourceRect.width);
    const bottom = sourceRect.y + ((bbox.y1 / variantCanvas.height) * sourceRect.height);
    const confidence = Number.isFinite(node.confidence) ? node.confidence / 100 : 0.45;
    const areaRatio = ((right - left) * (bottom - top)) / Math.max(fullWidth * fullHeight, 1);

    if ((right - left) < 4 || (bottom - top) < 4) {
      return null;
    }

    if (areaRatio > 0.28) {
      return null;
    }

    if (normalizedText.length === 1 && confidence < 0.72) {
      return null;
    }

    if (normalizedText.length <= 2 && confidence < 0.42) {
      return null;
    }

    if (confidence < 0.2) {
      return null;
    }

    return {
      x: left / fullWidth,
      y: top / fullHeight,
      w: (right - left) / fullWidth,
      h: (bottom - top) / fullHeight,
      confidence: clamp(confidence, 0.12, 0.99),
      source: 'ocr',
    };
  }

  async function ensureOCRRuntimeLoaded() {
    if (window.Tesseract?.createWorker) {
      return window.Tesseract;
    }

    if (!OCR_RUNTIME.scriptPromise) {
      OCR_RUNTIME.scriptPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = OCR_SCRIPT_URL;
        script.async = true;
        script.onload = () => {
          if (window.Tesseract?.createWorker) {
            resolve(window.Tesseract);
            return;
          }
          reject(new Error('Tesseract.js failed to initialize'));
        };
        script.onerror = () => reject(new Error('Tesseract.js failed to load'));
        document.head.appendChild(script);
      }).catch((error) => {
        OCR_RUNTIME.scriptPromise = null;
        OCR_RUNTIME.unavailable = true;
        throw error;
      });
    }

    return OCR_RUNTIME.scriptPromise;
  }

  async function getOCRWorker() {
    if (OCR_RUNTIME.unavailable) {
      throw new Error('OCR runtime unavailable');
    }

    await ensureOCRRuntimeLoaded();

    if (!OCR_RUNTIME.workerPromise) {
      OCR_RUNTIME.workerPromise = (async () => {
        const worker = await window.Tesseract.createWorker('eng');
        if (typeof worker.setParameters === 'function') {
          await worker.setParameters({
            tessedit_pageseg_mode: String(window.Tesseract.PSM?.SPARSE_TEXT ?? 11),
            tessedit_char_whitelist: OCR_WHITELIST,
            preserve_interword_spaces: '1',
          });
        }
        return worker;
      })().catch((error) => {
        OCR_RUNTIME.unavailable = true;
        OCR_RUNTIME.workerPromise = null;
        throw error;
      });
    }

    return OCR_RUNTIME.workerPromise;
  }

  async function runOCRPass(worker, sourceCanvas, sourceRect, spec, fullWidth, fullHeight) {
    const variantCanvas = buildOCRVariantCanvas(sourceCanvas, spec);
    const result = await worker.recognize(variantCanvas);
    return collectOCRNodes(result)
      .map((node) => ocrNodeToCandidate(node, variantCanvas, sourceRect, fullWidth, fullHeight))
      .filter(Boolean);
  }

  async function detectOCRCandidatesFromCanvas(sourceCanvas, sourceWidth, sourceHeight, options = {}) {
    try {
      const worker = await getOCRWorker();
      const fullRect = { x: 0, y: 0, width: sourceWidth, height: sourceHeight };
      const longest = Math.max(sourceWidth, sourceHeight);
      const baseScale = longest < 900 ? 2.6 : longest < 1400 ? 2.05 : 1.45;
      const variants = [
        { scale: baseScale, grayscale: false, contrast: 1.12 },
        { scale: Math.min(baseScale + 0.2, 3.0), grayscale: true, contrast: 1.6, threshold: true, thresholdBias: 0.08 },
        { scale: Math.min(baseScale + 0.35, 3.1), grayscale: true, contrast: 1.7, threshold: true, thresholdBias: 0.08, invert: true },
      ];

      let candidates = [];
      for (const spec of variants) {
        candidates.push(...await runOCRPass(worker, sourceCanvas, fullRect, spec, sourceWidth, sourceHeight));
      }

      const tileRects = makeOCRTileRects(sourceWidth, sourceHeight);
      if (tileRects.length && (!options.skipTiles || candidates.length < 8)) {
        const tileVariants = [
          { scale: 2.3, grayscale: true, contrast: 1.65, threshold: true, thresholdBias: 0.04 },
          { scale: 2.4, grayscale: true, contrast: 1.75, threshold: true, thresholdBias: 0.04, invert: true },
        ];

        for (const tileRect of tileRects) {
          const tileCanvas = cropCanvas(sourceCanvas, tileRect);
          for (const spec of tileVariants) {
            candidates.push(...await runOCRPass(worker, tileCanvas, tileRect, spec, sourceWidth, sourceHeight));
          }
        }
      }

      return finalizeOCRCandidates(candidates, options);
    } catch (error) {
      console.warn('OCR detection failed', error);
      if (shouldWarnAboutOCR()) {
        markOCRWarningShown();
        showToast('OCR unavailable', 'Falling back to heuristic detection. Text-cover validation will be weaker until OCR loads successfully.', 'warning');
      }
      return [];
    }
  }

  async function augmentDetectionCandidatesWithOCRVerification(sourceCanvas, sourceWidth, sourceHeight, candidates) {
    let verified = (candidates || []).map((candidate) => normalizeBox(candidate));
    if (!verified.length) {
      return verified;
    }

    const verificationConfig = buildOCRVerificationRenderConfig();

    for (let pass = 0; pass < 2; pass += 1) {
      const verificationCanvas = renderRedactedCanvas(sourceCanvas, verified, verificationConfig, 'block');
      const residual = await detectOCRCandidatesFromCanvas(verificationCanvas, sourceWidth, sourceHeight, {
        verification: true,
        skipTiles: pass > 0 && verified.length > 18,
      });

      if (!residual.length) {
        break;
      }

      const next = integrateVerificationCandidates(verified, residual, {
        expandPadX: pass === 0 ? 0.016 : 0.022,
        expandPadY: pass === 0 ? 0.026 : 0.036,
        limit: 72,
      });

      if (next.length === verified.length) {
        const changed = next.some((candidate, index) => {
          const existing = verified[index];
          if (!existing) return true;
          return Math.abs(candidate.x - existing.x) > 0.002
            || Math.abs(candidate.y - existing.y) > 0.002
            || Math.abs(candidate.w - existing.w) > 0.002
            || Math.abs(candidate.h - existing.h) > 0.002
            || candidate.source !== existing.source;
        });
        verified = next;
        if (!changed) break;
      } else {
        verified = next;
      }
    }

    return verified;
  }

  function detectHeuristicTextCandidatesFromCanvas(sourceCanvas, sourceWidth, sourceHeight) {
    const maxWidth = 960;
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
        sum += Math.abs(gray[(y * width) + x] - gray[(y * width) + x - 1]);
      }
      rowScore[y] = sum / width;
    }

    const smoothRows = smoothSignal(rowScore, 3);
    const rowStats = meanAndStd(Array.from(smoothRows));
    const rowThreshold = rowStats.mean + (rowStats.std * 0.6);
    const rowBands = groupedSegments(smoothRows, rowThreshold, Math.max(4, Math.round(height * 0.01)));
    const candidates = [];

    rowBands.forEach((band) => {
      const y1 = Math.max(0, band.start - 5);
      const y2 = Math.min(height - 1, band.end + 5);
      const bandHeight = y2 - y1 + 1;
      const colScore = new Float32Array(width);

      for (let x = 1; x < width; x += 1) {
        let sum = 0;
        for (let y = y1; y <= y2; y += 1) {
          sum += Math.abs(gray[(y * width) + x] - gray[(y * width) + x - 1]);
        }
        colScore[x] = sum / bandHeight;
      }

      const smoothCols = smoothSignal(colScore, 2);
      const colStats = meanAndStd(Array.from(smoothCols));
      const colThreshold = colStats.mean + (colStats.std * 0.48);
      const colBands = groupedSegments(smoothCols, colThreshold, Math.max(10, Math.round(width * 0.014)));

      colBands.forEach((colBand) => {
        const x1 = Math.max(0, colBand.start - 8);
        const x2 = Math.min(width - 1, colBand.end + 8);
        const boxWidth = x2 - x1 + 1;
        const boxHeight = bandHeight;
        const ratio = boxWidth / Math.max(boxHeight, 1);
        const areaRatio = (boxWidth * boxHeight) / (width * height);

        if (ratio < 1.3 || ratio > 11) return;
        if (areaRatio < 0.001 || areaRatio > 0.24) return;

        const score = (band.avg * 0.48) + (colBand.avg * 0.32) + (ratio * 2.4);
        candidates.push({
          x: x1 / width,
          y: y1 / height,
          w: boxWidth / width,
          h: boxHeight / height,
          confidence: clamp(score / 110, 0.18, 0.88),
          source: 'auto',
        });
      });
    });

    const mergedCandidates = mergeCandidateBoxes(candidates, {
      padX: 0.02,
      padY: 0.03,
      limit: 18,
      loose: true,
    });
    const compactMerged = filterOversizedDetectionCandidates(mergedCandidates);
    if (compactMerged.length) {
      return compactMerged;
    }

    const compactRaw = filterOversizedDetectionCandidates(candidates);
    if (compactRaw.length) {
      return mergeCandidateBoxes(compactRaw, {
        padX: 0.012,
        padY: 0.02,
        limit: 24,
        loose: false,
      });
    }

    return mergedCandidates;
  }

  async function detectPlateCandidatesFromCanvas(sourceCanvas, sourceWidth, sourceHeight, options = {}) {
    const detectionMode = options.mode === 'fast' ? 'fast' : 'deep';
    const heuristicCandidates = detectHeuristicTextCandidatesFromCanvas(sourceCanvas, sourceWidth, sourceHeight);
    if (detectionMode === 'fast') {
      return materializeEntryBoxes(heuristicCandidates.length ? heuristicCandidates : [createFallbackBox()]);
    }
    const slidingYellowCandidates = detectYellowSlidingPlateCandidatesFromCanvas(sourceCanvas, sourceWidth, sourceHeight);
    const projectionYellowCandidates = slidingYellowCandidates.length
      ? []
      : detectYellowProjectionPlateCandidatesFromCanvas(sourceCanvas, sourceWidth, sourceHeight);
    const preferredYellowCandidates = slidingYellowCandidates.length
      ? slidingYellowCandidates
      : projectionYellowCandidates;
    let colorCandidates = preferredYellowCandidates.length
      ? preferredYellowCandidates
      : [
        ...detectColorPlateCandidatesFromCanvas(sourceCanvas, sourceWidth, sourceHeight),
        ...detectRectPlateCandidatesFromCanvas(sourceCanvas, sourceWidth, sourceHeight),
      ];
    const yellowCandidates = colorCandidates.filter((candidate) => String(candidate.source || '').startsWith('plate-yellow'));
    if (yellowCandidates.length) {
      colorCandidates = yellowCandidates;
    }
    const ocrCandidates = await detectOCRCandidatesFromCanvas(sourceCanvas, sourceWidth, sourceHeight, options);
    const hasYellowSeeds = yellowCandidates.length > 0;
    const compactOCRCandidates = ocrCandidates.filter((candidate) => !isOversizedVerificationBox(candidate));
    const candidatePool = colorCandidates.length
      ? [
        ...colorCandidates,
        ...compactOCRCandidates,
        ...heuristicCandidates,
      ]
      : [...compactOCRCandidates, ...heuristicCandidates];

    const separatedCandidates = filterOversizedDetectionCandidates(selectCandidateBoxes(
      candidatePool.map((candidate) => expandNormalizedCandidate(
        normalizeBox(candidate),
        hasYellowSeeds ? 0.006 : 0.01,
        hasYellowSeeds ? 0.01 : 0.016
      )),
      {
        limit: options.verification ? 56 : 28,
        maxIoU: hasYellowSeeds ? 0.2 : 0.16,
      }
    ), options);
    if (separatedCandidates.length) {
      return materializeEntryBoxes(separatedCandidates);
    }

    const merged = mergeCandidateBoxes(candidatePool, {
      padX: hasYellowSeeds ? 0.008 : (options.verification ? 0.024 : 0.02),
      padY: hasYellowSeeds ? 0.012 : (options.verification ? 0.04 : 0.03),
      limit: options.verification ? 48 : 32,
      loose: false,
    });
    const compactMerged = filterOversizedDetectionCandidates(merged, options);
    let resolvedCandidates = compactMerged;
    if (!resolvedCandidates.length) {
      const compactSourceCandidates = filterOversizedDetectionCandidates(candidatePool, options);
      if (compactSourceCandidates.length) {
        resolvedCandidates = mergeCandidateBoxes(compactSourceCandidates, {
        padX: hasYellowSeeds ? 0.006 : (options.verification ? 0.018 : 0.012),
        padY: hasYellowSeeds ? 0.01 : (options.verification ? 0.03 : 0.018),
        limit: options.verification ? 56 : 36,
        loose: false,
        });
      }
    }

    if (!resolvedCandidates.length) {
      resolvedCandidates = merged.length ? merged : [createFallbackBox()];
    }
    return materializeEntryBoxes(resolvedCandidates);
  }

  async function detectPlatesFromImageURL(url, width, height, options = {}) {
    const resolvedOptions = {
      mode: 'fast',
      ...options,
    };
    let detectorMeta = null;
    if (resolvedOptions.mode === 'deep') {
      try {
        const dedicatedResult = await detectWithDedicatedDetector(url, {
          ...resolvedOptions,
          returnMeta: true,
        });
        detectorMeta = dedicatedResult?.detector || null;
        if (dedicatedResult?.boxes?.length) {
          return resolvedOptions.returnMeta
            ? dedicatedResult
            : dedicatedResult.boxes;
        }
      } catch (error) {
        console.warn('Dedicated detector unavailable, falling back to browser pipeline.', error);
      }
    }

    const image = await loadImageElement(url);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, 0, 0, width, height);
    const boxes = detectPlateCandidatesFromCanvas(canvas, width, height, {
      ...resolvedOptions,
    });
    return resolvedOptions.returnMeta
      ? { boxes, detector: detectorMeta }
      : boxes;
  }

  async function detectPlatesFromVideoFrame(video, options = {}) {
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    let detectorMeta = null;
    if (options.mode === 'deep') {
      try {
        const dedicatedResult = await detectWithDedicatedDetectorCanvas(canvas, {
          ...options,
          fileName: options.fileName || 'video-frame.png',
          sampleId: options.sampleId || '',
          returnMeta: true,
        });
        detectorMeta = dedicatedResult?.detector || null;
        if (dedicatedResult?.boxes?.length) {
          return options.returnMeta
            ? dedicatedResult
            : dedicatedResult.boxes;
        }
      } catch (error) {
        console.warn('Dedicated detector unavailable for video frame, falling back to browser pipeline.', error);
      }
    }

    const boxes = detectPlateCandidatesFromCanvas(canvas, canvas.width, canvas.height);
    return options.returnMeta
      ? { boxes, detector: detectorMeta }
      : boxes;
  }

  async function inspectImageDetectionPipeline(entry) {
    if (!entry) {
      return { error: 'NO_IMAGE' };
    }

    const image = await loadImageElement(entry.url);
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

    const heuristicCandidates = detectHeuristicTextCandidatesFromCanvas(canvas, canvas.width, canvas.height);
    const slidingYellowCandidates = detectYellowSlidingPlateCandidatesFromCanvas(canvas, canvas.width, canvas.height);
    const projectionYellowCandidates = slidingYellowCandidates.length
      ? []
      : detectYellowProjectionPlateCandidatesFromCanvas(canvas, canvas.width, canvas.height);
    const componentColorCandidates = detectColorPlateCandidatesFromCanvas(canvas, canvas.width, canvas.height);
    const rectColorCandidates = detectRectPlateCandidatesFromCanvas(canvas, canvas.width, canvas.height);
    let colorCandidates = slidingYellowCandidates.length
      ? slidingYellowCandidates
      : projectionYellowCandidates.length
        ? projectionYellowCandidates
        : [...componentColorCandidates, ...rectColorCandidates];
    const yellowCandidates = colorCandidates.filter((candidate) => String(candidate.source || '').startsWith('plate-yellow'));
    if (yellowCandidates.length) {
      colorCandidates = yellowCandidates;
    }
    const ocrCandidates = await detectOCRCandidatesFromCanvas(canvas, canvas.width, canvas.height, { mode: 'deep' });
    const hasYellowSeeds = yellowCandidates.length > 0;
    const compactOCRCandidates = ocrCandidates.filter((candidate) => !isOversizedVerificationBox(candidate));
    const candidatePool = colorCandidates.length
      ? [
        ...colorCandidates,
        ...compactOCRCandidates,
        ...heuristicCandidates,
      ]
      : [...compactOCRCandidates, ...heuristicCandidates];
    const separatedCandidates = filterOversizedDetectionCandidates(selectCandidateBoxes(
      candidatePool.map((candidate) => expandNormalizedCandidate(
        normalizeBox(candidate),
        hasYellowSeeds ? 0.006 : 0.01,
        hasYellowSeeds ? 0.01 : 0.016
      )),
      {
        limit: 28,
        maxIoU: hasYellowSeeds ? 0.2 : 0.16,
      }
    ), { mode: 'deep' });
    const merged = mergeCandidateBoxes(candidatePool, {
      padX: hasYellowSeeds ? 0.008 : 0.02,
      padY: hasYellowSeeds ? 0.012 : 0.03,
      limit: 32,
      loose: false,
    });
    const compactMerged = filterOversizedDetectionCandidates(merged, { mode: 'deep' });
    const compactSourceCandidates = filterOversizedDetectionCandidates(candidatePool, { mode: 'deep' });

    const summarize = (items) => items.map((box) => ({
      x: Number(box.x.toFixed(4)),
      y: Number(box.y.toFixed(4)),
      w: Number(box.w.toFixed(4)),
      h: Number(box.h.toFixed(4)),
      confidence: Number((box.confidence || box.score || 0).toFixed(4)),
      source: box.source || 'auto',
    }));

    return {
      name: entry.name,
      heuristicCandidates: summarize(heuristicCandidates),
      slidingYellowCandidates: summarize(slidingYellowCandidates),
      projectionYellowCandidates: summarize(projectionYellowCandidates),
      componentColorCandidates: summarize(componentColorCandidates),
      rectColorCandidates: summarize(rectColorCandidates),
      colorCandidates: summarize(colorCandidates),
      ocrCandidates: summarize(ocrCandidates),
      candidatePool: summarize(candidatePool),
      separatedCandidates: summarize(separatedCandidates),
      merged: summarize(merged),
      compactMerged: summarize(compactMerged),
      compactSourceCandidates: summarize(compactSourceCandidates),
      finalBoxes: summarize(await detectPlateCandidatesFromCanvas(canvas, canvas.width, canvas.height, { mode: 'deep' })),
    };
  }

  function summarizeDebugBoxes(items, limit = 12) {
    return (items || []).slice(0, limit).map((box) => ({
      x: Number(box.x.toFixed(4)),
      y: Number(box.y.toFixed(4)),
      w: Number(box.w.toFixed(4)),
      h: Number(box.h.toFixed(4)),
      confidence: Number((box.confidence || box.score || 0).toFixed(4)),
      source: box.source || 'auto',
    }));
  }

  async function inspectProcessedResidualForEntry(entry) {
    const source = entry.processedUrl || entry.url;
    const image = await loadImageElement(source);
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

    const residual = await detectOCRCandidatesFromCanvas(canvas, canvas.width, canvas.height, {
      verification: true,
      skipTiles: false,
    });

    return {
      name: entry.name,
      boxes: entry.boxes.length,
      residualCount: residual.length,
      residual: summarizeDebugBoxes(residual),
    };
  }

  async function auditBuiltInImageSamples(sampleNames = []) {
    const requested = Array.isArray(sampleNames)
      ? new Set(sampleNames.map((name) => String(name || '').trim()).filter(Boolean))
      : new Set();
    const imageSamples = BUILTIN_SAMPLES.filter((sample) => sample.type === 'image')
      .filter((sample) => !requested.size || requested.has(sample.name));
    const originalStyle = state.blurStyle;
    const originalViewMode = state.imageViewMode;
    const results = [];

    state.blurStyle = getPrivacySafeStyle(state.blurStyle);
    state.imageViewMode = 'original';

    try {
      for (const sample of imageSamples) {
        const image = await loadImageElement(sample.src);
        const tempEntry = {
          id: uid('audit-img'),
          file: null,
          url: sample.src,
          name: sample.name,
          width: image.width,
          height: image.height,
          boxes: [],
          processed: false,
          processedBlob: null,
          processedUrl: '',
          status: 'pending',
          displayRect: null,
          sampleId: sample.id,
        };

        const detection = await inspectImageDetectionPipeline(tempEntry);
        const deepBoxes = await detectPlatesFromImageURL(sample.src, image.width, image.height, {
          mode: 'deep',
          sampleId: sample.id,
          fileName: sample.name,
        });
        tempEntry.boxes = deepBoxes.map((box, index) => ({
          ...box,
          label: makeBoxLabel(index, box.source),
        }));

        const initialBoxes = summarizeDebugBoxes(tempEntry.boxes, 24);
        const { blob, previewDataUrl } = await buildProcessedImage(tempEntry);
        tempEntry.processedBlob = blob;
        tempEntry.processedUrl = previewDataUrl;
        tempEntry.processed = true;
        const processed = await inspectProcessedResidualForEntry(tempEntry);
        const finalBoxes = summarizeDebugBoxes(tempEntry.boxes, 24);
        const suspiciousDetection = finalBoxes.some((box) => (box.w * box.h) > 0.16 || box.h > 0.2 || (box.w > 0.7 && box.h > 0.11));

        results.push({
          name: sample.name,
          src: sample.src,
          initialBoxCount: initialBoxes.length,
          finalBoxCount: finalBoxes.length,
          suspiciousDetection,
          processedResidualCount: processed.residualCount,
          initialBoxes,
          finalBoxes,
          detection,
          processedResidual: processed.residual,
        });
      }
    } finally {
      state.blurStyle = originalStyle;
      state.imageViewMode = originalViewMode;
    }

    return results;
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
      if (count) count.textContent = '0 个敏感框';
      return;
    }

    if (count) count.textContent = `${entry.boxes.length} 个敏感框`;
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

  function clearProcessedImageState(entry) {
    if (entry.processedUrl) {
      URL.revokeObjectURL(entry.processedUrl);
    }
    entry.processed = false;
    entry.processedBlob = null;
    entry.processedUrl = '';
    entry.status = 'pending';
    if (state.imageViewMode === 'processed') {
      state.imageViewMode = 'original';
    }
  }

  async function rerunCurrentImageDetection(mode = 'fast') {
    const entry = currentImage();
    if (!entry) {
      showToast('请先上传图片', '图片处理区需要至少一张图片。', 'warning');
      return;
    }

    const isDeep = mode === 'deep';
    showToast(
      isDeep ? '深度识别中' : '快速识别中',
      isDeep ? `正在调用本地专用检测器分析 ${entry.name}` : `正在快速分析 ${entry.name}`,
      'progress',
      true
    );

    try {
      const detectionResult = await detectPlatesFromImageURL(entry.url, entry.width, entry.height, {
        mode,
        sampleId: entry.sampleId || '',
        fileName: entry.name,
        returnMeta: isDeep,
      });
      const boxes = isDeep ? (detectionResult?.boxes || []) : detectionResult;
      const detectorMeta = isDeep ? detectionResult?.detector : null;
      clearProcessedImageState(entry);
      entry.boxes = boxes.map((box, index) => ({
        ...box,
        label: makeBoxLabel(index, box.source),
      }));
      state.selectedPlateId = entry.boxes[0]?.id || null;
      renderImageWorkspace();
      updateStats();
      showToast(
        isDeep ? '深度识别完成' : '快速识别完成',
        mergeDetectorOutcome(`已找到 ${entry.boxes.length} 个候选区域`, detectorMeta),
        'success'
      );
    } catch (error) {
      console.error(error);
      showToast(
        isDeep ? '深度识别失败' : '识别失败',
        error?.message || '当前图片暂时无法完成重新分析。',
        'error'
      );
    }
  }
  async function resetCurrentImageDetection() {
    await rerunCurrentImageDetection('fast');
  }

  async function deepRecognizeCurrentImage() {
    await rerunCurrentImageDetection('deep');
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
      template: getPrivacySafeStyle(style),
      requestedTemplate: style,
      width: Number($('#vidWidthRange')?.value || 160),
      height: Number($('#vidHeightRange')?.value || 60),
      blurStrength: Number($('#vidBlurRange')?.value || 10),
      keepAudio: $('#keepVideoAudioToggle')?.checked ?? state.settings.keepVideoAudio,
      deepEveryFrame: $('#videoDeepEveryFrameToggle')?.checked ?? state.settings.videoDeepEveryFrame,
    };
  }

  function isVideoDeepEveryFrameEnabled() {
    return $('#videoDeepEveryFrameToggle')?.checked ?? state.settings.videoDeepEveryFrame;
  }

  async function fetchVideoSourceBlob(entry) {
    if (entry?.file instanceof Blob) {
      return entry.file;
    }
    return fetchAssetBlob(entry.url);
  }

  async function processCurrentVideoWithDedicatedDetector(entry, renderConfig) {
    const sourceBlob = await fetchVideoSourceBlob(entry);
    const form = new FormData();
    form.append('video', sourceBlob, entry.name || 'video.mp4');
    form.append('style', renderConfig.template || 'blur');
    form.append('blur_strength', String(renderConfig.blurStrength || 10));
    form.append('min_box_width', String(renderConfig.width || 160));
    form.append('min_box_height', String(renderConfig.height || 60));
    form.append('keep_audio', renderConfig.keepAudio ? '1' : '0');
    form.append('include_text', '0');
    form.append('prefer_gpu', state.settings.preferGpu ? '1' : '0');

    const response = await withTimeout(async (signal) => {
      const result = await fetch(`${DEDICATED_DETECTOR_API}/process/video`, {
        method: 'POST',
        body: form,
        signal,
      });
      if (!result.ok) {
        const detail = await result.text().catch(() => '');
        throw new Error(detail || `Dedicated video detector returned ${result.status}`);
      }
      return result;
    }, DEDICATED_VIDEO_TIMEOUT_MS, 'Dedicated video detector timed out');

    const detectorMeta = updateDetectorHealth(normalizeDetectorMetaFromHeaders(response.headers));
    const blob = await response.blob();
    const downloadName = readDownloadNameFromHeaders(
      response.headers,
      buildDownloadName(entry.name, 'deep-redacted', 'mp4')
    );

    if (entry.processedUrl) URL.revokeObjectURL(entry.processedUrl);
    entry.processedBlob = blob;
    entry.processedUrl = URL.createObjectURL(blob);
    entry.processedDownloadName = downloadName;
    entry.processed = true;
    entry.status = 'done';
    state.videoViewMode = 'processed';

    const poster = await captureVideoPoster(entry.processedUrl).catch(() => entry.posterUrl || makeHistoryThumbFallback('video'));
    await addHistoryRecord({
      id: uid('history'),
      type: 'video',
      name: entry.name,
      status: 'done',
      downloadName,
      previewDataUrl: poster,
      blob,
    });

    if (state.settings.autoDownload) {
      downloadBlob(blob, downloadName);
    }

    const outcome = describeDetectorOutcomeText(detectorMeta);
    updateStats();
    renderVideoWorkspace({ preserveTime: false });
    updateVideoJob(
      1,
      outcome
        ? `每一帧都已使用本地专用检测器处理。${outcome}。MP4 结果已可下载。`
        : '每一帧都已使用本地专用检测器处理。MP4 结果已可下载。'
    );
    showToast(
      '视频深度处理完成',
      outcome
        ? `每一帧都已处理完成。${outcome}`
        : '每一帧都已使用本地专用检测器处理。',
      'success'
    );
  }
  function materializeEntryBoxes(candidates) {
    return candidates.map((candidate, index) => normalizeBox({
      id: uid('plate'),
      label: candidate.label || makeBoxLabel(index, candidate.source || 'auto'),
      confidence: clamp(candidate.confidence || candidate.score || 0.42, 0.18, 0.99),
      source: candidate.source || 'auto',
      x: candidate.x,
      y: candidate.y,
      w: candidate.w,
      h: candidate.h,
    }));
  }

  function resolveImageRedactionStyle(box, requestedStyle) {
    if (box.source === 'ocr-verify' || box.source === 'ocr') {
      return 'block';
    }
    return getPrivacySafeStyle(requestedStyle);
  }

  function renderRedactedCanvas(sourceCanvas, boxes, config, requestedStyle) {
    const outputCanvas = document.createElement('canvas');
    outputCanvas.width = sourceCanvas.width;
    outputCanvas.height = sourceCanvas.height;
    const ctx = outputCanvas.getContext('2d');
    ctx.drawImage(sourceCanvas, 0, 0);

    boxes.forEach((box) => {
      applyRedaction(
        ctx,
        sourceCanvas,
        boxToPixels(box, sourceCanvas.width, sourceCanvas.height),
        config,
        resolveImageRedactionStyle(box, requestedStyle)
      );
    });

    return outputCanvas;
  }

  async function buildProcessedImage(entry) {
    maybeWarnAboutStrictPrivacyStyle(state.blurStyle);

    const image = await loadImageElement(entry.url);
    const sourceCanvas = document.createElement('canvas');
    sourceCanvas.width = entry.width;
    sourceCanvas.height = entry.height;
    const sourceCtx = sourceCanvas.getContext('2d');
    sourceCtx.drawImage(image, 0, 0, entry.width, entry.height);

    const config = getWatermarkConfig();
    let renderStyle = state.blurStyle;
    let candidateBoxes = entry.boxes.map((box) => ({
      x: box.x,
      y: box.y,
      w: box.w,
      h: box.h,
      confidence: box.confidence,
      source: box.source || 'auto',
    }));

    let outputCanvas = renderRedactedCanvas(sourceCanvas, candidateBoxes, config, renderStyle);

    for (let pass = 0; pass < OCR_STRICT_MAX_PASSES; pass += 1) {
      const residual = await detectOCRCandidatesFromCanvas(outputCanvas, entry.width, entry.height, {
        verification: true,
        skipTiles: pass > 0 && candidateBoxes.length > 18,
      });

      if (!residual.length) {
        break;
      }

      renderStyle = 'block';
      candidateBoxes = integrateVerificationCandidates(candidateBoxes, residual, {
        expandPadX: pass === 0 ? 0.018 : 0.024,
        expandPadY: pass === 0 ? 0.03 : 0.04,
        limit: 72,
      });

      outputCanvas = renderRedactedCanvas(sourceCanvas, candidateBoxes, config, renderStyle);
    }

    const finalResidual = await detectOCRCandidatesFromCanvas(outputCanvas, entry.width, entry.height, {
      verification: true,
      skipTiles: false,
    });

    if (finalResidual.length) {
      renderStyle = 'block';
      candidateBoxes = integrateVerificationCandidates(candidateBoxes, finalResidual, {
        expandPadX: 0.022,
        expandPadY: 0.038,
        limit: 84,
      }).map((candidate) => ({
        ...candidate,
        source: candidate.source || 'ocr-verify',
      }));
      outputCanvas = renderRedactedCanvas(sourceCanvas, candidateBoxes, config, renderStyle);
    }

    for (let strictPass = 0; strictPass < 2; strictPass += 1) {
      const remainingResidual = await detectOCRCandidatesFromCanvas(outputCanvas, entry.width, entry.height, {
        verification: true,
        skipTiles: strictPass > 0 && candidateBoxes.length > 24,
      });

      if (!remainingResidual.length) {
        break;
      }

      renderStyle = 'block';
      candidateBoxes = integrateVerificationCandidates(candidateBoxes, remainingResidual, {
        expandPadX: 0.026 + (strictPass * 0.006),
        expandPadY: 0.042 + (strictPass * 0.01),
        limit: 96,
      }).map((candidate) => ({
        ...candidate,
        source: candidate.source || 'ocr-verify',
      }));
      outputCanvas = renderRedactedCanvas(sourceCanvas, candidateBoxes, config, renderStyle);
    }

    entry.boxes = materializeEntryBoxes(candidateBoxes);
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

  async function registerImageAsset({ name, url, file = null, sampleId = '' }) {
    const image = await loadImageElement(url);
    const boxes = await detectPlatesFromImageURL(url, image.width, image.height, {
      mode: 'fast',
      sampleId,
      fileName: name,
    });
    const entry = {
      id: uid('img'),
      file,
      url,
      name,
      width: image.width,
      height: image.height,
      boxes: boxes.map((box, index) => ({ ...box, label: makeBoxLabel(index, box.source) })),
      processed: false,
      processedBlob: null,
      processedUrl: '',
      status: 'pending',
      displayRect: null,
      sampleId,
    };
    state.images.push(entry);
    if (state.currentImageIndex === -1) state.currentImageIndex = 0;
    state.selectedPlateId = entry.boxes[0]?.id || null;
    return entry;
  }

  async function registerImageFile(file) {
    const url = fileToObjectURL(file);
    return registerImageAsset({
      name: file.name,
      url,
      file,
    });
  }

  async function registerVideoAsset({ name, url, file = null, posterUrl = '', sampleId = '' }) {
    const metadata = await loadVideoMetadata(url);
    const resolvedPosterUrl = posterUrl || await captureVideoPoster(url).catch(() => makeHistoryThumbFallback('video'));
    const entry = {
      id: uid('vid'),
      file,
      url,
      name,
      width: metadata.width,
      height: metadata.height,
      duration: metadata.duration,
      posterUrl: resolvedPosterUrl,
      tracks: [],
      processed: false,
      processedBlob: null,
      processedUrl: '',
      processedDownloadName: '',
      status: 'pending',
      sampleId,
    };
    state.videos.push(entry);
    if (state.currentVideoIndex === -1) state.currentVideoIndex = 0;
    return entry;
  }

  async function registerVideoFile(file) {
    const url = fileToObjectURL(file);
    return registerVideoAsset({
      name: file.name,
      url,
      file,
    });
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

    refreshImportedMedia();
    focusImportedMedia('image');

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
    if (!currentVideo()?.processedUrl) state.videoViewMode = 'original';
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
    if (!video || !overlay || !entry || isViewingProcessedVideo(entry) || !entry.tracks.length || !video.videoWidth || !video.videoHeight) {
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

  function renderVideoWorkspace(options = {}) {
    renderVideoQueue();
    renderTrackList();

    const video = $('#videoPreview');
    const empty = $('#videoEmpty');
    const entry = currentVideo();
    const preserveTime = options.preserveTime ?? true;

    if (!video) return;
    if (!entry) {
      video.removeAttribute('src');
      video.load();
      video.style.display = 'none';
      delete video.dataset.entryId;
      delete video.dataset.sourceUrl;
      state.videoViewMode = 'original';
      syncVideoViewModeControls();
      empty?.classList.remove('hidden');
      updatePlayhead(0);
      $('#timeDisplay').textContent = '00:00 / 00:00';
      updateVideoJob(0, getVideoIdleMessage());
      return;
    }

    if (state.videoViewMode === 'processed' && !entry.processedUrl) {
      state.videoViewMode = 'original';
    }

    const sourceUrl = currentVideoSource(entry);
    const resumeTime = preserveTime ? Number(video.currentTime || 0) : 0;
    if (video.dataset.entryId !== entry.id || video.dataset.sourceUrl !== sourceUrl) {
      video.pause();
      video.src = sourceUrl;
      video.dataset.entryId = entry.id;
      video.dataset.sourceUrl = sourceUrl;
      video.currentTime = 0;
      video.load();
      if (resumeTime > 0) {
        video.addEventListener('loadedmetadata', () => {
          try {
            const cappedTime = video.duration ? Math.min(resumeTime, Math.max(video.duration - 0.05, 0)) : resumeTime;
            video.currentTime = cappedTime;
          } catch (error) {
            console.warn('Failed to restore video playhead', error);
          }
        }, { once: true });
      }
    }

    video.style.display = 'block';
    syncVideoViewModeControls();
    empty?.classList.add('hidden');
    renderTimelineMarkers();
    syncVideoControlsFromSelectedTrack();
    updateVideoOverlay();
  }

  async function detectCurrentFrame() {
    const entry = currentVideo();
    const video = $('#videoPreview');
    if (isViewingProcessedVideo(entry)) {
      setVideoViewMode('original', { preserveTime: true, forceRender: true });
      showToast('已切回原视频', '当前帧识别和追踪编辑需要基于原视频进行。', 'warning');
      return;
    }
    if (!entry || !video || !video.src || !video.videoWidth) {
      showToast('请先上传视频', '视频加载完成后才能识别当前帧。', 'warning');
      return;
    }

    const detectMode = isVideoDeepEveryFrameEnabled() ? 'deep' : 'fast';
    showToast(
      detectMode === 'deep' ? '视频深度识别中' : '识别当前帧',
      detectMode === 'deep' ? '正在使用本地专用检测器分析当前帧。' : '正在分析视频画面…',
      'progress',
      true
    );

    try {
      const detectionResult = await detectPlatesFromVideoFrame(video, {
        mode: detectMode,
        fileName: `${safeBaseName(entry.name)}-frame.png`,
        sampleId: entry.sampleId || '',
        returnMeta: detectMode === 'deep',
      });
      const boxes = detectMode === 'deep' ? (detectionResult?.boxes || []) : detectionResult;
      const detectorMeta = detectMode === 'deep' ? detectionResult?.detector : null;
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
      const successMessage = detectMode === 'deep'
        ? `已在 ${formatTime(track.time)} 添加当前帧追踪点。整段逐帧重检请点“处理视频”。`
        : `已在 ${formatTime(track.time)} 添加追踪点；若要跟随位移，请继续补多个时间点。`;
      showToast('识别完成', mergeDetectorOutcome(successMessage, detectorMeta), 'success');
    } catch (error) {
      console.error(error);
      showToast(
        detectMode === 'deep' ? '视频深度识别失败' : '识别失败',
        error?.message || '当前帧暂时无法完成识别。',
        'error'
      );
    }
  }
  function addCurrentTrackPoint() {
    const entry = currentVideo();
    const video = $('#videoPreview');
    if (isViewingProcessedVideo(entry)) {
      setVideoViewMode('original', { preserveTime: true, forceRender: true });
      showToast('已切回原视频', '添加追踪点前请先切回原视频。', 'warning');
      return;
    }
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
    const renderConfig = getVideoRenderConfig();
    if (renderConfig.deepEveryFrame) {
      state.videoProcessing = true;
      maybeWarnAboutStrictPrivacyStyle(state.blurStyle);
      updateVideoJob(0, '正在调用本地专用检测器逐帧处理视频。');
      showToast('视频深度处理中', '每一帧都会重新做深度检测，速度会明显慢于快速模式。', 'progress', true);
      try {
        await processCurrentVideoWithDedicatedDetector(entry, renderConfig);
      } catch (error) {
        console.error(error);
        updateVideoJob(0, '视频深度处理失败，请确认本地检测服务仍在运行。');
        showToast('视频深度处理失败', error?.message || '本地检测服务未能完成逐帧处理。', 'error');
      } finally {
        state.videoProcessing = false;
      }
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
    maybeWarnAboutStrictPrivacyStyle(state.blurStyle);
    updateVideoJob(0, '正在准备逐帧处理…');
    showToast('视频处理中', '正在逐帧加水印，请保持页面开启。', 'progress', true);
    try {
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
      entry.processedDownloadName = buildDownloadName(entry.name, 'watermarked', 'webm');
      entry.processed = true;
      entry.status = 'done';
      state.videoViewMode = 'processed';

      await addHistoryRecord({
        id: uid('history'),
        type: 'video',
        name: entry.name,
        status: 'done',
        downloadName: entry.processedDownloadName,
        previewDataUrl: poster,
        blob,
      });

      if (state.settings.autoDownload) {
        downloadBlob(blob, entry.processedDownloadName);
      }

      updateStats();
      renderVideoWorkspace({ preserveTime: false });
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
    downloadBlob(entry.processedBlob, entry.processedDownloadName || buildDownloadName(entry.name, 'watermarked', 'webm'));
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

  function bindSampleLibrary() {
    $('#openSampleLibraryBtn')?.addEventListener('click', (event) => {
      event.stopPropagation();
      openSampleLibrary();
    });

    $('#closeSampleLibraryBtn')?.addEventListener('click', closeSampleLibrary);
    $('[data-sample-close="backdrop"]')?.addEventListener('click', closeSampleLibrary);

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !$('#sampleLibrary')?.hidden) {
        closeSampleLibrary();
      }
    });
  }

  function bindImageActions() {
    $('#addPlateBtn')?.addEventListener('click', addImageBox);
    $('#resetPlatesBtn')?.addEventListener('click', resetCurrentImageDetection);
    $('#deepDetectBtn')?.addEventListener('click', deepRecognizeCurrentImage);
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

    $('#videoOriginalModeBtn')?.addEventListener('click', () => setVideoViewMode('original', { preserveTime: true }));
    $('#videoProcessedModeBtn')?.addEventListener('click', () => setVideoViewMode('processed', { preserveTime: true }));
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

    $('#videoDeepEveryFrameToggle')?.addEventListener('change', (event) => {
      state.settings.videoDeepEveryFrame = event.target.checked;
      persistSettings();
      if (!state.videoProcessing) {
        updateVideoJob(0, getVideoIdleMessage());
      }
    });

    ['imagePreferGpuToggle', 'videoPreferGpuToggle', 'setPreferGpuToggle'].forEach((id) => {
      document.getElementById(id)?.addEventListener('change', (event) => {
        setGpuPreferenceEnabled(event.target.checked).catch((error) => {
          console.error(error);
          showToast('GPU 偏好更新失败', error?.message || '无法更新当前 GPU 偏好。', 'error');
          syncGpuPreferenceControls();
        });
      });
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

  function installDebugHooks() {
    window.__plateBlurDebug = {
      getSummary() {
        return {
          imageCount: state.images.length,
          videoCount: state.videos.length,
          currentImageName: currentImage()?.name || '',
          currentImageBoxes: currentImage()?.boxes.length || 0,
          currentVideoTracks: currentVideo()?.tracks.length || 0,
        };
      },
      async inspectCurrentImageOCR() {
        const entry = currentImage();
        if (!entry) {
          return { error: 'NO_IMAGE' };
        }
        return inspectProcessedResidualForEntry(entry);
      },
      async inspectCurrentImageDetection() {
        return inspectImageDetectionPipeline(currentImage());
      },
      async auditBuiltInImageSamples(sampleNames = []) {
        return auditBuiltInImageSamples(sampleNames);
      },
    };
  }

  async function init() {
    loadSettings();
    applySettingsToControls();
    bindNav();
    bindUpload();
    bindSampleLibrary();
    bindImageActions();
    bindVideoActions();
    bindWatermarkActions();
    bindHistoryActions();
    bindSettingsActions();
    renderSampleLibrary();

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
    installDebugHooks();
    syncGpuPreferenceControls();
    refreshDetectorHealth().catch(() => null);
    updateVideoJob(0, getVideoIdleMessage());

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
