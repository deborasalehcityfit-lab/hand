/*
 * app.js — pengendali aplikasi: kamera, model MediaPipe, loop frame, panel, ekspor.
 * Logika tracking ada di core.js (identik dengan notebook); file ini hanya "kabel".
 */
import { MEDIAPIPE, MODEL_URLS, STORAGE_KEYS } from "./config.js";
import {
  APP_VERSION, DEFAULT_CONFIG, makeConfig, validateConfig, effectiveSwaps, MotionPipeline,
  frameHealth, FINGER_NAMES, SIDE_NAMES,
} from "./core.js";
import { SessionLog, sessionStamp } from "./recorder.js";
import { drawOverlay, drawDemoBackground, drawSparkline, FINGER_COLORS, ARM_COLORS, SIDE_ID, FINGER_ID } from "./draw.js";
import { Viewer3D } from "./viewer3d.js";
import { SyntheticScene } from "./demo.js";

const $ = (sel) => document.querySelector(sel);
const params = new URLSearchParams(location.search);

class AppError extends Error {}

/* ------------------------------------------------------------------ */
/* Penyimpanan lokal                                                   */
/* ------------------------------------------------------------------ */
function readJSON(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function writeJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* mode privat: abaikan */ }
}
function loadSettings() {
  const stored = readJSON(STORAGE_KEYS.settings, {});
  const known = Object.fromEntries(Object.entries(stored).filter(([k]) => k in DEFAULT_CONFIG));
  const cfg = makeConfig(known);
  try { validateConfig(cfg); return cfg; } catch { return makeConfig(); }
}

const state = {
  cfg: loadSettings(),
  calib: readJSON(STORAGE_KEYS.calibration, {}),
  demo: params.has("demo"),
  running: false,
  busy: false,
  stream: null,
  mp: null,
  vision: null,
  hand: null,
  pose: null,
  modelKey: null,
  delegateUsed: null,
  modelSha: {},
  lastTs: 0,
  session: null,
  wakeLock: null,
  installEvent: null,
  lastObserved: { hand: null, pose: null },
};

/* ------------------------------------------------------------------ */
/* Elemen                                                              */
/* ------------------------------------------------------------------ */
const video = $("#video");
const view = $("#view");
const vctx = view.getContext("2d");
const healthCanvas = document.createElement("canvas");
healthCanvas.width = 64; healthCanvas.height = 48;
const hctx = healthCanvas.getContext("2d", { willReadFrequently: true });
const viewer = new Viewer3D($("#view3d"));

/* ------------------------------------------------------------------ */
/* Utilitas UI                                                         */
/* ------------------------------------------------------------------ */
let toastTimer = null;
function toast(message, ms = 4000) {
  const el = $("#toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

function showLoading(text, fraction = null) {
  $("#loading").hidden = false;
  $("#loading-text").textContent = text;
  const bar = $("#loading-bar");
  bar.style.width = fraction === null ? "100%" : `${Math.round(fraction * 100)}%`;
  bar.classList.toggle("indeterminate", fraction === null);
}
function hideLoading() { $("#loading").hidden = true; }

function setStatus(text, tone = "idle") {
  const el = $("#status");
  el.textContent = text;
  el.dataset.tone = tone;
}

const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;
const fmt = (v, d = 0) => (Number.isFinite(v) ? v.toFixed(d) : "—");

function describeError(err) {
  if (err instanceof AppError) return err.message;
  const name = err && err.name;
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Izin kamera ditolak. Izinkan kamera untuk situs ini di pengaturan browser, lalu coba lagi.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") return "Kamera yang diminta tidak ditemukan di perangkat ini.";
  if (name === "NotReadableError" || name === "AbortError") {
    return "Kamera sedang dipakai aplikasi lain. Tutup aplikasi kamera/video call lalu coba lagi.";
  }
  return `${name || "Error"}: ${err && err.message ? err.message : String(err)}`;
}

function showError(err) {
  console.error(err);
  hideLoading();
  setStatus("Berhenti", "error");
  $("#intro-error").textContent = describeError(err);
  $("#intro-error").hidden = false;
  showIntro(true);
}

/* ------------------------------------------------------------------ */
/* MediaPipe                                                           */
/* ------------------------------------------------------------------ */
async function loadLibrary() {
  if (state.vision) return;
  showLoading("Memuat pustaka MediaPipe…");
  let mod;
  try {
    mod = await import(MEDIAPIPE.bundle);
  } catch (err) {
    throw new AppError(`Pustaka MediaPipe gagal dimuat dari ${MEDIAPIPE.source === "cdn" ? "cdn.jsdelivr.net" : "folder vendor/"}. `
      + "Periksa koneksi internet, atau gunakan mode self-host (lihat panduan).");
  }
  state.mp = mod.FilesetResolver ? mod : mod.default;
  state.vision = await state.mp.FilesetResolver.forVisionTasks(MEDIAPIPE.wasm);
}

async function sha256Hex(bytes) {
  if (!crypto.subtle) return null;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Arsip .task adalah ZIP. Sama seperti zipfile di Python (dan valid_task_file di notebook),
 * cari tanda akhir ZIP ("PK\x05\x06") di ujung berkas, bukan hanya di byte pertama.
 */
function looksLikeTask(bytes) {
  if (bytes.length < 1_000_000) return false;
  const stop = Math.max(0, bytes.length - 65557);
  for (let i = bytes.length - 22; i >= stop; i--) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) return true;
  }
  return false;
}

function describeBytes(bytes, type) {
  const head = Array.from(bytes.slice(0, 40), (b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : ".")).join("");
  return `${mb(bytes.length)}, tipe ${type || "tidak diketahui"}, awal "${head}"`;
}

/** Buang salinan rusak dari cache service worker supaya percobaan berikutnya mengunduh ulang. */
async function forgetCached(url) {
  try {
    const abs = new URL(url, location.href).href;
    for (const key of await caches.keys()) await (await caches.open(key)).delete(abs);
  } catch { /* cache tidak tersedia: abaikan */ }
}

const sourceName = (url) => (/^https?:/.test(url) ? new URL(url).host : "folder models/ di situs ini");

async function downloadBytes(url, label) {
  const res = await fetch(url, { mode: "cors" });
  if (!res.ok) throw new Error(`HTTP ${res.status}${res.status === 404 && !/^https?:/.test(url) ? " (berkas belum diunggah)" : ""}`);
  const type = res.headers.get("content-type") || "";
  const total = Number(res.headers.get("content-length")) || 0;
  if (!res.body || !res.body.getReader) return { bytes: new Uint8Array(await res.arrayBuffer()), type };
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    showLoading(`Mengunduh ${label}… ${mb(received)}${total ? ` dari ${mb(total)}` : ""}`, total ? received / total : null);
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) { bytes.set(c, offset); offset += c.length; }
  return { bytes, type };
}

/** Coba setiap sumber model berurutan; tolak berkas yang bukan arsip .task (mis. halaman blokir/login Wi-Fi). */
async function fetchModel(urls, label) {
  const problems = [];
  for (const url of urls) {
    try {
      const { bytes, type } = await downloadBytes(url, label);
      if (looksLikeTask(bytes)) return bytes;
      await forgetCached(url);
      problems.push(`${sourceName(url)} mengirim berkas yang bukan model (${describeBytes(bytes, type)})`);
    } catch (err) {
      problems.push(`${sourceName(url)}: ${err && err.message ? err.message : err}`);
    }
  }
  throw new AppError(`Gagal mendapatkan ${label}. ${problems.join("; ")}. `
    + "Biasanya jaringan Wi-Fi kampus/kantor, antivirus, atau halaman login Wi-Fi menghalangi berkas model. "
    + "Coba pakai data seluler, atau unggah folder models dari laptop ke repositori GitHub (lihat panduan).");
}

async function createTask(Task, bytes, options, label) {
  const order = state.cfg.delegate === "GPU" ? ["GPU", "CPU"] : ["CPU"];
  let lastErr = null;
  for (const delegate of order) {
    try {
      showLoading(`Menyiapkan ${label} (${delegate})…`);
      const task = await Task.createFromOptions(state.vision, {
        ...options, baseOptions: { modelAssetBuffer: bytes.slice(), delegate },
      });
      return { task, delegate };
    } catch (err) {
      console.warn(`${label} gagal dengan delegate ${delegate}`, err);
      lastErr = err;
    }
  }
  throw new AppError(`${label} gagal disiapkan: ${lastErr && lastErr.message ? lastErr.message : lastErr}`);
}

function handOptions(cfg) {
  return {
    runningMode: "VIDEO",
    numHands: cfg.num_hands,
    minHandDetectionConfidence: cfg.detection_confidence,
    minHandPresenceConfidence: cfg.presence_confidence,
    minTrackingConfidence: cfg.tracking_confidence,
  };
}
function poseOptions(cfg) {
  return {
    runningMode: "VIDEO",
    numPoses: 1,
    minPoseDetectionConfidence: cfg.pose_confidence,
    minPosePresenceConfidence: cfg.pose_confidence,
    minTrackingConfidence: cfg.pose_confidence,
    outputSegmentationMasks: false,
  };
}

/** Muat/siapkan model sebelum kamera dibuka (seperti notebook: gagal setup = kamera tidak terbuka). */
async function ensureModels(cfg) {
  await loadLibrary();
  const key = `${cfg.delegate}|${cfg.enable_pose ? cfg.pose_variant : "none"}`;
  if (state.modelKey !== key) {
    for (const t of [state.hand, state.pose]) { try { t && t.close(); } catch { /* abaikan */ } }
    state.hand = null; state.pose = null; state.modelKey = null;
    const handBytes = await fetchModel(MODEL_URLS.hand, "model tangan");
    state.modelSha.hand = await sha256Hex(handBytes);
    const h = await createTask(state.mp.HandLandmarker, handBytes, handOptions(cfg), "Model tangan");
    state.hand = h.task;
    state.delegateUsed = h.delegate;
    if (cfg.enable_pose) {
      const poseBytes = await fetchModel(MODEL_URLS.pose(cfg.pose_variant), `model pose ${cfg.pose_variant}`);
      state.modelSha.pose = await sha256Hex(poseBytes);
      const p = await createTask(state.mp.PoseLandmarker, poseBytes, poseOptions(cfg), "Model pose");
      state.pose = p.task;
      if (p.delegate !== h.delegate) state.delegateUsed = `${h.delegate}+${p.delegate}`;
    } else {
      state.modelSha.pose = null;
    }
    state.modelKey = key;
    if (cfg.delegate === "GPU" && !String(state.delegateUsed).startsWith("GPU")) {
      toast("GPU tidak tersedia, memakai CPU (lebih lambat).");
    }
  } else {
    await state.hand.setOptions(handOptions(cfg));
    if (state.pose) await state.pose.setOptions(poseOptions(cfg));
  }
  hideLoading();
}

/* ------------------------------------------------------------------ */
/* Kamera                                                              */
/* ------------------------------------------------------------------ */
async function openCamera(cfg) {
  showLoading("Membuka kamera…");
  const ideal = { facingMode: { ideal: cfg.camera_facing }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } };
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: ideal });
  } catch (err) {
    if (err && err.name === "OverconstrainedError") {
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: cfg.camera_facing } });
    } else {
      throw err;
    }
  }
  state.stream = stream;
  video.srcObject = stream;
  video.muted = true;
  video.setAttribute("playsinline", "");
  await video.play();
  const t0 = performance.now();
  while (!video.videoWidth && performance.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 50));
  if (!video.videoWidth) throw new AppError("Kamera terbuka tetapi tidak mengirim gambar. Tutup aplikasi lain yang memakai kamera lalu coba lagi.");
  hideLoading();
}

function stopCamera() {
  if (state.stream) for (const tr of state.stream.getTracks()) tr.stop();
  state.stream = null;
  video.srcObject = null;
}

async function requestWakeLock() {
  try { if ("wakeLock" in navigator) state.wakeLock = await navigator.wakeLock.request("screen"); } catch { /* opsional */ }
}
function releaseWakeLock() {
  try { state.wakeLock && state.wakeLock.release(); } catch { /* abaikan */ }
  state.wakeLock = null;
}

/* ------------------------------------------------------------------ */
/* Sesi                                                                */
/* ------------------------------------------------------------------ */
const fitLong = (w, h, long) => {
  const s = Math.min(1, long / Math.max(w, h));
  return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))];
};

function demoSize() {
  return innerHeight > innerWidth ? [720, 960] : [960, 720];
}

async function startSession() {
  if (state.running || state.busy) return;
  state.busy = true;
  $("#intro-error").hidden = true;
  refreshControls();
  const cfg = { ...state.cfg };
  try {
    validateConfig(cfg);
    if (!state.demo) {
      if (!window.isSecureContext) {
        throw new AppError("Kamera hanya bisa dipakai lewat HTTPS (atau localhost). Buka app dari alamat https://, misalnya GitHub Pages.");
      }
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new AppError("Browser ini tidak memberi akses kamera. Buka di Chrome (Android) atau Safari (iPhone), bukan di browser bawaan aplikasi chat.");
      }
      setStatus("Memuat model", "busy");
      await ensureModels(cfg);
      await openCamera(cfg);
    }
    beginSession(cfg);
  } catch (err) {
    stopCamera();
    showError(err);
  } finally {
    state.busy = false;
    refreshControls();
  }
}

function beginSession(cfg) {
  const settings = state.stream ? state.stream.getVideoTracks()[0].getSettings() : {};
  const facing = state.demo ? "user" : settings.facingMode || cfg.camera_facing;
  const mirrored = cfg.mirror_mode === "on" || (cfg.mirror_mode === "auto" && facing === "user");
  const calibKey = `${facing}|${mirrored ? "mirror" : "normal"}`;
  const calibFlip = state.calib[calibKey] || { hands: false, pose: false };
  const swaps = effectiveSwaps(cfg, mirrored, calibFlip);
  const logCfg = {
    ...cfg, mirror_view: mirrored, effective_swap_handedness: swaps.swapHands,
    effective_swap_pose_sides: swaps.swapPose, calibration_flip: calibFlip, camera_facing_used: facing,
    camera_label: state.stream ? state.stream.getVideoTracks()[0].label : "demo",
    platform: "web", user_agent: navigator.userAgent, demo: state.demo,
    mediapipe_tasks_vision: MEDIAPIPE.version, mediapipe_source: MEDIAPIPE.source,
    delegate_used: state.demo ? "none (demo)" : state.delegateUsed,
  };
  const proc = document.createElement("canvas");
  state.session = {
    cfg, logCfg, facing, mirrored, swaps, calibKey,
    pipeline: new MotionPipeline(cfg),
    log: new SessionLog(logCfg),
    stamp: sessionStamp(),
    startPerf: performance.now(),
    frameId: 0, frameTimes: [], inferenceTimes: [],
    framesWithHands: 0, framesWithPose: 0,
    width: 0, height: 0, dispW: 0, dispH: 0,
    proc, pctx: proc.getContext("2d"),
    drawing: null, health: null, lastHealthAt: -Infinity, lastUiAt: -Infinity,
    lastVideoTime: -1, lastFrameAt: performance.now(),
    scene: state.demo ? new SyntheticScene({ seed: 7, scale: "auto" }) : null,
    recorder: null, recordings: [], calibration: null,
    cameraFps: settings.frameRate || null,
    captureSize: state.stream ? [video.videoWidth, video.videoHeight] : demoSize(),
  };
  $("#readouts").classList.toggle("reversed", !mirrored);
  state.running = true;
  showIntro(false);
  setStatus(state.demo ? "Demo berjalan" : "Berjalan", "live");
  requestWakeLock();
  refreshControls();
  scheduleNext();
}

function scheduleNext() {
  if (!state.running) return;
  if (!state.demo && typeof video.requestVideoFrameCallback === "function") {
    video.requestVideoFrameCallback(() => { tick(); scheduleNext(); });
  } else {
    requestAnimationFrame(() => { tick(); scheduleNext(); });
  }
}

function tick() {
  const S = state.session;
  if (!S || !state.running) return;
  const now = performance.now();
  if (state.demo) {
    if (now - S.lastFrameAt < 30) return;              // ~30 fps
  } else if (typeof video.requestVideoFrameCallback !== "function") {
    if (video.currentTime === S.lastVideoTime) return;  // belum ada frame baru
    S.lastVideoTime = video.currentTime;
  }
  S.lastFrameAt = now;
  try {
    processFrame(S, now);
  } catch (err) {
    stopSession(`error: ${err.name}: ${err.message}`);
    showError(err);
  }
}

function processFrame(S, now) {
  const cfg = S.cfg;
  const [vw, vh] = state.demo ? demoSize() : [video.videoWidth, video.videoHeight];
  if (!vw || !vh) return;
  const [pw, ph] = fitLong(vw, vh, cfg.process_long_side);
  const [dw, dh] = fitLong(vw, vh, cfg.display_long_side);
  if (pw !== S.width || ph !== S.height || dw !== S.dispW || dh !== S.dispH) {
    // Ukuran frame berubah (mis. HP diputar): reset tracker seperti di notebook.
    S.width = pw; S.height = ph; S.dispW = dw; S.dispH = dh;
    S.proc.width = pw; S.proc.height = ph;
    view.width = dw; view.height = dh;
    S.drawing = document.createElement("canvas");
    S.drawing.width = dw; S.drawing.height = dh;
    S.pipeline.reset();
  }
  const t = (now - S.startPerf) / 1000;

  if (state.demo) {
    drawDemoBackground(vctx);
  } else {
    const m = S.mirrored;
    S.pctx.setTransform(m ? -1 : 1, 0, 0, 1, m ? pw : 0, 0);
    S.pctx.drawImage(video, 0, 0, pw, ph);
    vctx.setTransform(m ? -1 : 1, 0, 0, 1, m ? dw : 0, 0);
    vctx.drawImage(video, 0, 0, dw, dh);
    vctx.setTransform(1, 0, 0, 1, 0, 0);
    if (cfg.reject_black && now - S.lastHealthAt > 500) {
      hctx.drawImage(video, 0, 0, 64, 48);
      S.health = frameHealth(hctx.getImageData(0, 0, 64, 48).data);
      S.lastHealthAt = now;
    }
  }

  // Timestamp MediaPipe harus naik terus sepanjang umur model (lintas sesi).
  const tsMs = Math.max(state.lastTs + 1, Math.round(now));
  state.lastTs = tsMs;
  let handResult, poseResult = null, handsMs = 0, poseMs = 0;
  if (state.demo) {
    const fr = S.scene.frame(t, pw, ph);
    handResult = {
      landmarks: fr.hand.landmarks.slice(0, cfg.num_hands),
      worldLandmarks: fr.hand.worldLandmarks.slice(0, cfg.num_hands),
      handedness: fr.hand.handedness.slice(0, cfg.num_hands),
    };
    poseResult = cfg.enable_pose ? fr.pose : null;
  } else {
    let t0 = performance.now();
    handResult = state.hand.detectForVideo(S.proc, tsMs);
    handsMs = performance.now() - t0;
    if (state.pose && cfg.enable_pose) {
      t0 = performance.now();
      poseResult = state.pose.detectForVideo(S.proc, tsMs);
      poseMs = performance.now() - t0;
    }
  }
  const inferenceMs = handsMs + poseMs;
  S.inferenceTimes.push(inferenceMs);
  if (S.inferenceTimes.length > 200) S.inferenceTimes.shift();

  const r = S.pipeline.step({
    handResult, poseResult, t, width: pw, height: ph,
    swapHands: S.swaps.swapHands, swapPose: S.swaps.swapPose,
  });
  if (r.pose) { S.framesWithPose += 1; state.lastObserved.pose = r.pose; }
  if (r.tracks.length) { S.framesWithHands += 1; state.lastObserved.hand = r.tracks[0]; }

  // Menggambar dengan pinch (hanya di dalam app).
  const dctx = S.drawing.getContext("2d");
  for (const tr of r.tracks) {
    if (cfg.draw_with_pinch && tr.pinch) {
      const p = [0.5 * (tr.points[4][0] + tr.points[8][0]) * dw, 0.5 * (tr.points[4][1] + tr.points[8][1]) * dh];
      if (tr.drawPrevious) {
        dctx.strokeStyle = FINGER_COLORS.Index;
        dctx.lineWidth = Math.max(4, dw / 160);
        dctx.lineCap = "round";
        dctx.beginPath(); dctx.moveTo(tr.drawPrevious[0], tr.drawPrevious[1]); dctx.lineTo(p[0], p[1]); dctx.stroke();
      }
      tr.drawPrevious = p;
    } else {
      tr.drawPrevious = null;
    }
  }

  S.frameTimes.push(now);
  if (S.frameTimes.length > 40) S.frameTimes.shift();
  const span = (S.frameTimes[S.frameTimes.length - 1] - S.frameTimes[0]) / 1000;
  const fps = S.frameTimes.length > 1 && span > 0 ? (S.frameTimes.length - 1) / span : 0;
  const timing = { hands_ms: handsMs, pose_ms: poseMs };

  drawOverlay(vctx, {
    tracks: r.tracks, pose: r.pose, links: r.links, cfg, t, fps, timing, bimanual: r.bimanual,
    health: S.health, drawingLayer: S.drawing, recording: Boolean(S.recorder),
  });
  S.log.logAll(S.frameId, t, pw, ph, r.tracks, fps, inferenceMs, r.bimanual, r.pose, r.links, timing);

  if (S.calibration) stepCalibration(S, r, t);
  if (now - S.lastUiAt >= 1000 / cfg.ui_hz) {
    S.lastUiAt = now;
    updatePanels(S, r, fps, timing);
  }
  S.frameId += 1;
  if (cfg.max_seconds > 0 && t >= cfg.max_seconds) stopSession("time limit");
}

async function stopSession(reason = "stopped by user") {
  const S = state.session;
  if (!S) return;
  state.running = false;
  state.session = null;
  const items = [];
  if (S.recorder) {
    const clip = await finishRecording(S);
    if (clip) items.push(clip);
  }
  releaseWakeLock();
  stopCamera();
  const elapsed = Math.max((performance.now() - S.startPerf) / 1000, 1e-6);
  const summary = {
    frames: S.frameId, elapsed_seconds: elapsed, average_processed_fps: S.frameId / elapsed,
    frames_with_hands: S.framesWithHands, frames_with_pose: S.framesWithPose,
    pose_enabled: S.cfg.enable_pose, pose_variant: S.cfg.pose_variant,
    last_200_frames_mean_inference_ms: S.inferenceTimes.length
      ? S.inferenceTimes.reduce((a, b) => a + b, 0) / S.inferenceTimes.length : null,
    backend_used: state.demo ? "demo (synthetic)" : `MediaPipe Tasks Web ${MEDIAPIPE.version}, delegate ${state.delegateUsed}`,
    camera_reported_fps: S.cameraFps, capture_size: S.captureSize, processed_size: [S.width, S.height],
    stop_reason: reason,
  };
  if (S.log.enabled) {
    const zip = S.log.finalize({
      summary,
      versions: { mediapipe_tasks_vision: MEDIAPIPE.version, user_agent: navigator.userAgent },
      modelSha256: state.demo ? null : state.modelSha.hand || null,
      poseModelSha256: state.demo ? null : state.modelSha.pose || null,
      extra: { recordings: S.recordings, payload: { platform: "web" } },
    });
    items.unshift({ label: "Data sesi (CSV + session.json)", blob: zip, filename: `motionlab_${S.stamp}.zip` });
  }
  setStatus("Siap", "idle");
  refreshControls();
  showIntro(true, true);
  const minutes = elapsed / 60;
  const text = `${S.frameId} frame dalam ${elapsed < 120 ? `${elapsed.toFixed(1)} detik` : `${minutes.toFixed(1)} menit`}, `
    + `rata-rata ${summary.average_processed_fps.toFixed(1)} fps. Tangan terlihat di ${S.framesWithHands} frame, `
    + `tubuh di ${S.framesWithPose} frame.`;
  openExport("Sesi selesai", text + (S.log.enabled ? "" : " Data tidak direkam: aktifkan “Rekam data CSV” di Pengaturan."), items);
}

/* ------------------------------------------------------------------ */
/* Video & foto                                                        */
/* ------------------------------------------------------------------ */
function pickMime() {
  const options = ["video/mp4;codecs=avc1.42E01E", "video/mp4", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
  return options.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) || "";
}

function startRecording() {
  const S = state.session;
  if (!S || S.recorder) return;
  if (!window.MediaRecorder || !view.captureStream) { toast("Browser ini belum mendukung perekaman video kanvas."); return; }
  const mime = pickMime();
  const stream = view.captureStream(S.cfg.video_fps);
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 5_000_000 } : undefined);
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  rec.start(1000);
  S.recorder = { rec, chunks, stream, mime: rec.mimeType || mime || "video/webm", start: (performance.now() - S.startPerf) / 1000 };
  setStatus("Merekam", "rec");
  refreshControls();
}

function finishRecording(S) {
  const R = S.recorder;
  S.recorder = null;
  if (!R) return Promise.resolve(null);
  return new Promise((resolve) => {
    R.rec.onstop = () => {
      R.stream.getTracks().forEach((tr) => tr.stop());
      const blob = new Blob(R.chunks, { type: R.mime });
      const ext = R.mime.includes("mp4") ? "mp4" : "webm";
      const filename = `motionlab_${S.stamp}_video${S.recordings.length + 1}.${ext}`;
      S.recordings.push({ path: filename, start_time_s: R.start, fps: S.cfg.video_fps, mime: R.mime,
        last_frame_time_s: (performance.now() - S.startPerf) / 1000 });
      resolve({ label: `Video (${mb(blob.size)})`, blob, filename });
    };
    try { R.rec.stop(); } catch { resolve(null); }
  });
}

async function toggleRecording() {
  const S = state.session;
  if (!S) return;
  if (S.recorder) {
    const item = await finishRecording(S);
    if (state.running) setStatus(state.demo ? "Demo berjalan" : "Berjalan", "live");
    refreshControls();
    if (item) openExport("Video tersimpan sementara", "Simpan sekarang; video hilang bila halaman ditutup.", [item]);
  } else {
    startRecording();
  }
}

function takeSnapshot() {
  if (!view.width) return;
  view.toBlob((blob) => {
    if (!blob) { toast("Foto gagal dibuat."); return; }
    const stamp = state.session ? state.session.stamp : sessionStamp();
    openExport("Foto layar", "Gambar kamera beserta overlay pelacakan.", [{ label: `Foto PNG (${mb(blob.size)})`, blob, filename: `motionlab_${stamp}_foto.png` }]);
  }, "image/png");
}

/* ------------------------------------------------------------------ */
/* Ekspor: bagikan / unduh                                             */
/* ------------------------------------------------------------------ */
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function shareBlob(blob, filename) {
  const file = new File([blob], filename, { type: blob.type || "application/octet-stream" });
  try {
    await navigator.share({ files: [file], title: filename });
  } catch (err) {
    if (err && err.name !== "AbortError") { toast("Gagal membagikan; file diunduh sebagai gantinya."); downloadBlob(blob, filename); }
  }
}

function canShareFile(blob, filename) {
  try {
    return Boolean(navigator.canShare && navigator.canShare({ files: [new File([blob], filename, { type: blob.type })] }));
  } catch { return false; }
}

function openExport(title, text, items) {
  $("#export-title").textContent = title;
  $("#export-text").textContent = text;
  const list = $("#export-items");
  list.replaceChildren();
  for (const item of items) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.className = "export-name";
    name.textContent = item.label;
    const file = document.createElement("span");
    file.className = "export-file";
    file.textContent = item.filename;
    const actions = document.createElement("span");
    actions.className = "export-actions";
    if (canShareFile(item.blob, item.filename)) {
      const share = document.createElement("button");
      share.type = "button"; share.className = "btn"; share.textContent = "Bagikan";
      share.addEventListener("click", () => shareBlob(item.blob, item.filename));
      actions.append(share);
    }
    const dl = document.createElement("button");
    dl.type = "button"; dl.className = "btn btn-primary"; dl.textContent = "Unduh";
    dl.addEventListener("click", () => downloadBlob(item.blob, item.filename));
    actions.append(dl);
    li.append(name, file, actions);
    list.append(li);
  }
  $("#export-empty").hidden = items.length > 0;
  openDialog($("#export"));
}

function openDialog(d) {
  if (typeof d.showModal === "function") { if (!d.open) d.showModal(); } else d.setAttribute("open", "");
}
function closeDialog(d) {
  if (typeof d.close === "function") d.close(); else d.removeAttribute("open");
}

/* ------------------------------------------------------------------ */
/* Kalibrasi kiri/kanan                                                */
/* ------------------------------------------------------------------ */
function startCalibration() {
  const S = state.session;
  if (!S) { toast("Mulai kamera dulu, lalu jalankan kalibrasi."); return; }
  if (state.demo) { toast("Kalibrasi butuh kamera sungguhan; tidak tersedia di mode demo."); return; }
  S.calibration = { started: (performance.now() - S.startPerf) / 1000, candidate: null, since: null };
  $("#calib").hidden = false;
  $("#calib-text").textContent = "Angkat tangan KANAN Anda lebih tinggi dari bahu dan tahan. Tangan kiri tetap di bawah.";
  $("#calib-bar").style.width = "0%";
}

function stepCalibration(S, r, t) {
  const C = S.calibration;
  const HOLD = 1.5, TIMEOUT = 15;
  let side = null, handLabel = null;
  if (r.pose) {
    const raised = SIDE_NAMES.filter((s) => r.pose.arms[s].raised_2d === true);
    if (raised.length === 1) {
      side = raised[0];
      const link = r.links.find((l) => l.side === side);
      const track = link ? r.tracks.find((tr) => tr.id === link.track_id) : null;
      handLabel = track ? track.handedness : null;
    }
  } else if (r.tracks.length === 1) {
    side = "hand-only";
    handLabel = r.tracks[0].handedness;
  }
  const key = side ? `${side}|${handLabel}` : null;
  if (key !== C.candidate) { C.candidate = key; C.since = t; }
  const held = key ? t - C.since : 0;
  $("#calib-bar").style.width = `${Math.min(100, (held / HOLD) * 100)}%`;
  if (key && held >= HOLD) {
    const flip = { ...(state.calib[S.calibKey] || { hands: false, pose: false }) };
    const notes = [];
    if (side === "Left") { flip.pose = !flip.pose; notes.push("sisi lengan ditukar"); }
    if (handLabel === "Left") { flip.hands = !flip.hands; notes.push("label tangan ditukar"); }
    if (side === "Right" && handLabel === null) notes.push("label tangan belum diperiksa (tangan tidak tertaut)");
    state.calib[S.calibKey] = flip;
    writeJSON(STORAGE_KEYS.calibration, state.calib);
    S.swaps = effectiveSwaps(S.cfg, S.mirrored, flip);
    S.pipeline.reset();
    S.calibration = null;
    $("#calib").hidden = true;
    toast(`Kalibrasi tersimpan untuk kamera ${S.facing === "user" ? "depan" : "belakang"}: ${notes.length ? notes.join(", ") : "sudah benar, tidak ada yang ditukar"}.`, 6000);
  } else if (t - C.started > TIMEOUT) {
    S.calibration = null;
    $("#calib").hidden = true;
    toast("Kalibrasi dibatalkan: tidak ada satu lengan terangkat yang terdeteksi selama 15 detik.", 6000);
  }
}

/* ------------------------------------------------------------------ */
/* Panel statistik                                                     */
/* ------------------------------------------------------------------ */
const PHASE_ID = { WAIT: "menunggu", STRAIGHT: "lurus", BENT: "tekuk" };

function buildPanels() {
  for (const slot of [0, 1]) {
    const card = $(`#hand-${slot}`);
    const tbody = card.querySelector("tbody");
    for (const name of FINGER_NAMES) {
      const tr = document.createElement("tr");
      tr.dataset.finger = name;
      tr.innerHTML = `<th scope="row"><i class="swatch"></i><span></span></th><td class="num bend">—</td>`
        + `<td class="bar-cell"><span class="bar"><i></i></span></td><td class="num tip">—</td><td class="ext"><i></i></td>`;
      tr.querySelector(".swatch").style.background = FINGER_COLORS[name];
      tr.querySelector("th span").textContent = FINGER_ID[name];
      tr.querySelector(".bar i").style.background = FINGER_COLORS[name];
      tr.querySelector(".ext i").style.background = FINGER_COLORS[name];
      tbody.append(tr);
    }
  }
  for (const side of SIDE_NAMES) {
    document.querySelector(`.gauge[data-side="${side}"]`).style.setProperty("--arm", ARM_COLORS[side]);
    $(`#arm-${side}`).style.setProperty("--arm", ARM_COLORS[side]);
  }
  setGaugeTicks();
}

function arcPath(v) {
  const r = 50, cx = 60, cy = 60;
  const th = Math.PI - (Math.min(Math.max(v, 0), 180) * Math.PI) / 180;
  return `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${(cx + r * Math.cos(th)).toFixed(2)} ${(cy - r * Math.sin(th)).toFixed(2)}`;
}
function tickLine(el, v) {
  const th = Math.PI - (v * Math.PI) / 180;
  el.setAttribute("x1", (60 + 43 * Math.cos(th)).toFixed(2));
  el.setAttribute("y1", (60 - 43 * Math.sin(th)).toFixed(2));
  el.setAttribute("x2", (60 + 57 * Math.cos(th)).toFixed(2));
  el.setAttribute("y2", (60 - 57 * Math.sin(th)).toFixed(2));
}
function setGaugeTicks() {
  for (const g of document.querySelectorAll(".gauge")) {
    tickLine(g.querySelector(".tick-bent"), state.cfg.rep_bent);
    tickLine(g.querySelector(".tick-straight"), state.cfg.rep_straight);
  }
}

function updatePanels(S, r, fps, timing) {
  for (const side of SIDE_NAMES) {
    const g = document.querySelector(`.gauge[data-side="${side}"]`);
    const m = r.pose ? r.pose.arms[side] : null;
    const angle = m ? m.elbow_included_2d_deg : NaN;
    g.querySelector(".value").setAttribute("d", Number.isFinite(angle) ? arcPath(angle) : "");
    g.querySelector(".deg").textContent = Number.isFinite(angle) ? `${angle.toFixed(0)}°` : "—";
    g.querySelector(".sub").textContent = m
      ? `${m.rep_count} siklus, ${PHASE_ID[m.rep_phase] || m.rep_phase}` : (S.cfg.enable_pose ? "tidak terlihat" : "pose mati");
    updateArmCard(side, m, r.pose, S.cfg);
  }
  for (const slot of [0, 1]) updateHandCard(slot, r.tracks[slot] || null, S.cfg);
  const sessionStats = [
    ["Kecepatan", `${fps.toFixed(1)} fps`],
    ["Inferensi", `${timing.hands_ms.toFixed(0)} + ${timing.pose_ms.toFixed(0)} ms`],
    ["Akselerasi", state.demo ? "demo" : state.delegateUsed || "—"],
    ["Resolusi proses", `${S.width} × ${S.height}`],
    ["Tangan / tertaut", `${r.tracks.length} / ${r.links.length}`],
    ["Data CSV", S.log.enabled ? `${S.log.rowCounts.frames} sampel` : "mati"],
    ["Kiri/kanan", `${S.mirrored ? "cermin" : "normal"}${state.calib[S.calibKey] ? ", terkalibrasi" : ", belum dikalibrasi"}`],
  ];
  const dl = $("#session-stats");
  dl.replaceChildren(...sessionStats.flatMap(([k, v]) => {
    const dt = document.createElement("dt"); dt.textContent = k;
    const dd = document.createElement("dd"); dd.textContent = v;
    return [dt, dd];
  }));
  if (!$("#card-3d").hidden) {
    viewer.render(state.lastObserved.hand ? { id: state.lastObserved.hand.id, world: state.lastObserved.hand.world } : null, state.lastObserved.pose);
  }
}

function updateHandCard(slot, tr, cfg) {
  const card = $(`#hand-${slot}`);
  card.classList.toggle("empty", !tr);
  if (!tr) {
    card.querySelector(".side-chip").textContent = `Slot ${slot + 1}`;
    card.querySelector(".gesture").textContent = "Tidak ada tangan";
    card.querySelector(".meta").textContent = "Tunjukkan telapak dan kelima ujung jari.";
    for (const row of card.querySelectorAll("tbody tr")) {
      row.querySelector(".bend").textContent = "—";
      row.querySelector(".tip").textContent = "—";
      row.querySelector(".bar i").style.width = "0%";
      row.classList.remove("extended");
    }
    card.querySelector(".foot").textContent = "";
    return;
  }
  const m = tr.metrics;
  card.querySelector(".side-chip").textContent = `H${tr.id} ${SIDE_ID[tr.handedness] ?? tr.handedness}`;
  card.querySelector(".gesture").textContent = tr.gesture;
  card.querySelector(".meta").textContent = `${m.finger_count}/5 jari lurus. Pinch ${tr.pinch ? "aktif" : "tidak"} `
    + `(rasio ${m.pinch_ratio.toFixed(2)}). Telapak ${tr.palmSpeedPxS.toFixed(0)} px/s.`;
  for (const row of card.querySelectorAll("tbody tr")) {
    const f = m.fingers[row.dataset.finger];
    row.querySelector(".bend").textContent = `${f.bend_deg.toFixed(0)}°`;
    row.querySelector(".tip").textContent = f.tip_speed_px_s.toFixed(0);
    row.querySelector(".bar i").style.width = `${Number.isFinite(f.curl_percent) ? f.curl_percent : 0}%`;
    row.classList.toggle("extended", f.extended);
  }
  card.querySelector(".foot").textContent = `Label mentah ${SIDE_ID[tr.rawHandedness] ?? tr.rawHandedness}, skor ${fmt(tr.handednessScore, 2)}. `
    + "Tekuk = rata-rata berbobot sendi, 0° = lurus.";
}

function updateArmCard(side, m, pose, cfg) {
  const card = $(`#arm-${side}`);
  const rows = card.querySelector(".metrics");
  if (!m) {
    card.querySelector(".state").textContent = cfg.enable_pose ? "tidak terdeteksi" : "pose mati";
    rows.replaceChildren();
    drawSparkline(card.querySelector("canvas"), [], ARM_COLORS[side], cfg.rep_bent, cfg.rep_straight);
    return;
  }
  card.querySelector(".state").textContent = `${m.arm_visible ? "terlihat" : "sebagian/tersembunyi"}, `
    + `tangan ${m.matched_hand_id !== null ? `H${m.matched_hand_id}` : "tidak tertaut"}`;
  const items = [
    ["Siku 2D / 3D", `${fmt(m.elbow_included_2d_deg)}° / ${fmt(m.elbow_included_model3d_deg)}°`],
    ["Batang tubuh–lengan", `${fmt(m.trunk_arm_2d_deg)}°`],
    ["Defleksi pergelangan", `${fmt(m.wrist_deflection_2d_deg)}°`],
    ["Siku / pergelangan", `${fmt(m.elbow_speed_px_s)} / ${fmt(m.wrist_speed_px_s)} px/s`],
    ["Pergelangan relatif bahu", `${fmt(m.wrist_shoulder_relative_speed_px_s)} px/s`],
    ["Laju tekuk siku", `${fmt(m.elbow_bend_velocity_deg_s)}°/s`],
    ["Siklus", `${m.rep_count} (${PHASE_ID[m.rep_phase] || m.rep_phase})`],
  ];
  rows.replaceChildren(...items.flatMap(([k, v]) => {
    const dt = document.createElement("dt"); dt.textContent = k;
    const dd = document.createElement("dd"); dd.textContent = v;
    return [dt, dd];
  }));
  drawSparkline(card.querySelector("canvas"), pose.angle_history[side], ARM_COLORS[side], cfg.rep_bent, cfg.rep_straight);
}

/* ------------------------------------------------------------------ */
/* Pengaturan                                                          */
/* ------------------------------------------------------------------ */
const LIVE_KEYS = new Set(["show_trails", "show_arm_trails", "show_arm_labels", "show_wrist_links", "show_full_body",
  "show_ids", "draw_with_pinch", "ui_hz", "reject_black"]);

const SCHEMA = [
  { section: "Kamera" },
  { key: "camera_facing", label: "Kamera", type: "select", options: [["user", "Depan (selfie)"], ["environment", "Belakang"]] },
  { key: "mirror_mode", label: "Tampilan cermin", type: "select", options: [["auto", "Otomatis"], ["on", "Selalu"], ["off", "Tidak pernah"]] },
  { key: "process_long_side", label: "Resolusi yang diproses model", type: "select", number: true, options: [[480, "480 px, paling ringan"], [640, "640 px, disarankan"], [960, "960 px"], [1280, "1280 px, berat"]] },
  { key: "max_seconds", label: "Batas durasi sesi", type: "select", number: true, options: [[0, "Tanpa batas"], [30, "30 detik"], [60, "1 menit"], [120, "2 menit"], [300, "5 menit"], [600, "10 menit"]] },
  { section: "Model" },
  { key: "num_hands", label: "Jumlah tangan", type: "select", number: true, options: [[1, "1 tangan"], [2, "2 tangan"]] },
  { key: "enable_pose", label: "Lacak lengan & bahu (Pose)", type: "toggle" },
  { key: "pose_variant", label: "Model pose", type: "select", options: [["lite", "Lite, tercepat"], ["full", "Full"], ["heavy", "Heavy, terberat"]] },
  { key: "delegate", label: "Akselerasi", type: "select", options: [["GPU", "GPU, cadangan CPU"], ["CPU", "CPU saja"]] },
  { section: "Tampilan" },
  { key: "show_trails", label: "Jejak ujung jari", type: "toggle" },
  { key: "show_arm_trails", label: "Jejak siku & pergelangan", type: "toggle" },
  { key: "show_arm_labels", label: "Label sendi lengan", type: "toggle" },
  { key: "show_wrist_links", label: "Garis tautan pergelangan", type: "toggle" },
  { key: "show_full_body", label: "Tampilkan seluruh tubuh", type: "toggle" },
  { key: "show_ids", label: "Nomor landmark tangan", type: "toggle" },
  { key: "draw_with_pinch", label: "Menggambar dengan pinch", type: "toggle" },
  { action: "clear-drawing", label: "Hapus coretan" },
  { section: "Data" },
  { key: "save_csv", label: "Rekam data CSV (format notebook)", type: "toggle" },
  { key: "csv_hz", label: "Laju sampel CSV", type: "select", number: true, options: [[5, "5 Hz"], [10, "10 Hz"], [15, "15 Hz"], [30, "30 Hz"]] },
  { key: "video_fps", label: "FPS video rekaman", type: "select", number: true, options: [[15, "15"], [20, "20"], [30, "30"]] },
  { section: "Kiri dan kanan" },
  { action: "calibrate", label: "Kalibrasi kiri/kanan sekarang" },
  { action: "reset-calibration", label: "Hapus semua kalibrasi" },
  { key: "swap_handedness", label: "Tukar label tangan (manual)", type: "toggle" },
  { key: "swap_pose_sides", label: "Tukar sisi lengan (manual)", type: "toggle" },
  { section: "Ambang batas (lanjutan)", advanced: true },
  ...[
    ["detection_confidence", "Deteksi tangan minimum", 0.05], ["presence_confidence", "Kehadiran tangan minimum", 0.05],
    ["tracking_confidence", "Tracking tangan minimum", 0.05], ["pose_confidence", "Kepercayaan pose minimum", 0.05],
    ["pose_visibility", "Visibilitas sendi minimum", 0.05], ["min_cutoff", "Filter: min cutoff", 0.1],
    ["beta", "Filter: beta", 0.5], ["pinch_on", "Pinch aktif di bawah rasio", 0.01], ["pinch_off", "Pinch lepas di atas rasio", 0.01],
    ["gesture_hold", "Tahan label gestur (s)", 0.01], ["track_ttl", "Umur track tangan (s)", 0.05],
    ["trail_seconds", "Panjang jejak (s)", 0.1], ["pose_ttl", "Umur epoch pose (s)", 0.05],
    ["association_max_diag", "Gerbang tautan (× diagonal)", 0.01], ["association_ambiguity", "Ambang ambiguitas tautan", 0.01],
    ["rep_bent", "Siku dianggap tekuk ≤ (°)", 1], ["rep_straight", "Siku dianggap lurus ≥ (°)", 1],
    ["rep_hold", "Tahan fase siklus (s)", 0.01], ["ui_hz", "Refresh panel (Hz)", 1],
  ].map(([key, label, step]) => ({ key, label, type: "number", step, advanced: true })),
  { action: "reset-settings", label: "Kembalikan semua pengaturan ke default", advanced: true },
];

function buildSettings() {
  const form = $("#settings-form");
  form.replaceChildren();
  let group = form;
  let details = null;
  for (const item of SCHEMA) {
    if (item.section) {
      const fs = document.createElement("fieldset");
      const lg = document.createElement("legend");
      lg.textContent = item.section;
      fs.append(lg);
      if (item.advanced) {
        details = document.createElement("details");
        const sm = document.createElement("summary");
        sm.textContent = item.section;
        details.append(sm, fs);
        lg.hidden = true;
        form.append(details);
      } else {
        form.append(fs);
      }
      group = fs;
      continue;
    }
    if (item.action) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn btn-quiet";
      b.dataset.action = item.action;
      b.textContent = item.label;
      group.append(b);
      continue;
    }
    const id = `set-${item.key}`;
    const row = document.createElement("div");
    row.className = `field field-${item.type}`;
    const label = document.createElement("label");
    label.htmlFor = id;
    label.textContent = item.label;
    let input;
    if (item.type === "select") {
      input = document.createElement("select");
      for (const [value, text] of item.options) {
        const o = document.createElement("option");
        o.value = String(value); o.textContent = text;
        input.append(o);
      }
      input.value = String(state.cfg[item.key]);
    } else if (item.type === "toggle") {
      input = document.createElement("input");
      input.type = "checkbox";
      input.role = "switch";
      input.checked = Boolean(state.cfg[item.key]);
    } else {
      input = document.createElement("input");
      input.type = "number";
      input.inputMode = "decimal";
      input.step = String(item.step);
      input.value = String(state.cfg[item.key]);
    }
    input.id = id;
    input.dataset.key = item.key;
    input.dataset.kind = item.number || item.type === "number" ? "number" : item.type;
    row.append(label, input);
    group.append(row);
  }
}

function applySetting(input) {
  const key = input.dataset.key;
  const kind = input.dataset.kind;
  const value = kind === "toggle" ? input.checked : kind === "number" ? Number(input.value) : input.value;
  const next = { ...state.cfg, [key]: value };
  try {
    validateConfig(next);
  } catch (err) {
    $("#settings-error").textContent = err.message;
    $("#settings-error").hidden = false;
    input.value = String(state.cfg[key]);
    if (kind === "toggle") input.checked = Boolean(state.cfg[key]);
    return;
  }
  $("#settings-error").hidden = true;
  state.cfg = next;
  writeJSON(STORAGE_KEYS.settings, state.cfg);
  if (state.session && LIVE_KEYS.has(key)) state.session.cfg[key] = value;
  if (key === "rep_bent" || key === "rep_straight") setGaugeTicks();
  if (state.session && !LIVE_KEYS.has(key)) $("#settings-note").hidden = false;
}

function handleAction(action) {
  if (action === "calibrate") { closeDialog($("#settings")); startCalibration(); }
  if (action === "reset-calibration") {
    state.calib = {};
    writeJSON(STORAGE_KEYS.calibration, state.calib);
    toast("Semua kalibrasi kiri/kanan dihapus. Berlaku di sesi berikutnya.");
  }
  if (action === "clear-drawing" && state.session && state.session.drawing) {
    const d = state.session.drawing;
    d.getContext("2d").clearRect(0, 0, d.width, d.height);
    for (const tr of state.session.pipeline.hands.tracks.values()) tr.drawPrevious = null;
    toast("Coretan dihapus.");
  }
  if (action === "reset-settings") {
    state.cfg = makeConfig();
    writeJSON(STORAGE_KEYS.settings, state.cfg);
    buildSettings();
    setGaugeTicks();
    toast("Pengaturan dikembalikan ke default.");
  }
  if (action === "install" && state.installEvent) {
    state.installEvent.prompt();
    state.installEvent = null;
    $("#install-row").hidden = true;
  }
}

/* ------------------------------------------------------------------ */
/* Kontrol                                                             */
/* ------------------------------------------------------------------ */
function showIntro(visible, afterSession = false) {
  $("#intro").hidden = !visible;
  if (visible && afterSession) $("#intro-title").textContent = state.demo ? "Demo berhenti" : "Kamera dimatikan";
}

function refreshControls() {
  const running = state.running;
  const shutter = $("#btn-start");
  shutter.dataset.state = state.busy ? "busy" : running ? "running" : "idle";
  shutter.setAttribute("aria-label", running ? "Hentikan" : state.demo ? "Mulai demo" : "Mulai kamera");
  shutter.disabled = state.busy;
  const recording = Boolean(state.session && state.session.recorder);
  $("#btn-record").disabled = !running;
  $("#btn-record").dataset.on = String(recording);
  $("#btn-record").setAttribute("aria-label", recording ? "Hentikan rekaman video" : "Rekam video");
  $("#btn-snapshot").disabled = !running;
  $("#btn-flip").disabled = state.busy || state.demo;
}

async function flipCamera() {
  state.cfg = { ...state.cfg, camera_facing: state.cfg.camera_facing === "user" ? "environment" : "user" };
  writeJSON(STORAGE_KEYS.settings, state.cfg);
  buildSettings();
  if (state.running) {
    await stopSession("camera switch");
    await startSession();
  } else {
    toast(`Kamera ${state.cfg.camera_facing === "user" ? "depan" : "belakang"} dipilih.`);
  }
}

function wire() {
  $("#btn-start").addEventListener("click", () => (state.running ? stopSession() : startSession()));
  $("#intro-start").addEventListener("click", () => startSession());
  $("#btn-record").addEventListener("click", toggleRecording);
  $("#btn-snapshot").addEventListener("click", takeSnapshot);
  $("#btn-flip").addEventListener("click", flipCamera);
  $("#btn-settings").addEventListener("click", () => { $("#settings-note").hidden = true; buildSettings(); openDialog($("#settings")); });
  $("#settings-close").addEventListener("click", () => closeDialog($("#settings")));
  $("#export-close").addEventListener("click", () => closeDialog($("#export")));
  $("#calib-cancel").addEventListener("click", () => { if (state.session) state.session.calibration = null; $("#calib").hidden = true; });
  $("#settings-form").addEventListener("change", (e) => { if (e.target.dataset.key) applySetting(e.target); });
  $("#settings").addEventListener("click", (e) => {
    const action = e.target.closest("[data-action]");
    if (action) handleAction(action.dataset.action);
  });
  for (const tab of document.querySelectorAll("[data-view3d]")) {
    tab.addEventListener("click", () => {
      viewer.mode = tab.dataset.view3d;
      for (const t of document.querySelectorAll("[data-view3d]")) t.setAttribute("aria-pressed", String(t === tab));
      viewer.render(state.lastObserved.hand ? { id: state.lastObserved.hand.id, world: state.lastObserved.hand.world } : null, state.lastObserved.pose);
    });
  }
  $("#toggle-3d").addEventListener("click", () => {
    const card = $("#card-3d");
    card.hidden = !card.hidden;
    $("#toggle-3d").setAttribute("aria-expanded", String(!card.hidden));
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.running) requestWakeLock();
  });
  addEventListener("pagehide", () => stopCamera());
  addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    state.installEvent = e;
    $("#install-row").hidden = false;
  });
  setInterval(() => {
    const S = state.session;
    if (S && state.running && !state.demo && document.visibilityState === "visible"
      && performance.now() - S.lastFrameAt > 5000) {
      toast("Kamera berhenti mengirim gambar. Mungkin dipakai aplikasi lain; hentikan lalu mulai lagi.");
      S.lastFrameAt = performance.now();
    }
  }, 2000);
}

function init() {
  document.documentElement.dataset.demo = String(state.demo);
  if (state.demo) {
    $("#intro-title").textContent = "Mode demo";
    $("#intro-text").textContent = "Gerakan sintetis tanpa kamera, untuk mencoba tampilan, pengaturan, dan ekspor data.";
    $("#intro-start").textContent = "Mulai demo";
    $("#intro-alt").textContent = "Kembali ke kamera";
    $("#intro-alt").href = "./";
  }
  $("#app-version").textContent = `Versi ${APP_VERSION}, MediaPipe Tasks Web ${MEDIAPIPE.version}`;
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  $("#ios-hint").hidden = !ios;
  buildPanels();
  buildSettings();
  wire();
  refreshControls();
  setStatus("Siap", "idle");
  if ("serviceWorker" in navigator && window.isSecureContext && !params.has("nosw")) {
    navigator.serviceWorker.register("./sw.js").catch((err) => console.warn("Service worker:", err));
  }
  if (params.has("autostart")) startSession();
}

init();

// Akses untuk debugging di konsol browser.
globalThis.motionLab = { state, startSession, stopSession };
