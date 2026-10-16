/*
 * core.js — port logika tracking dari notebook "Full Arm, Hand and Finger Motion Lab"
 * (Python/NumPy) ke JavaScript murni.
 *
 * Modul ini sengaja TIDAK menyentuh DOM, kamera, atau MediaPipe, supaya:
 *   1) bisa diuji di Node (npm test), dan
 *   2) bisa dibandingkan frame-per-frame dengan kode Python asli (tests/parity).
 *
 * Nama metrik & kunci konfigurasi sengaja memakai snake_case yang sama dengan
 * notebook, sehingga CSV dari HP punya kolom yang identik dengan CSV dari laptop.
 */

export const APP_VERSION = "1.0.1";

/* ------------------------------------------------------------------ */
/* Konfigurasi                                                         */
/* ------------------------------------------------------------------ */

export const DEFAULT_CONFIG = Object.freeze({
  // Kamera & tampilan (khusus web)
  camera_facing: "user",        // "user" = kamera depan, "environment" = kamera belakang
  mirror_mode: "auto",          // "auto" (mirror kamera depan saja), "on", "off"
  process_long_side: 640,       // sisi terpanjang gambar yang diproses model (px)
  display_long_side: 1280,      // sisi terpanjang kanvas tampilan (px)
  max_seconds: 0,               // 0 = tanpa batas
  delegate: "GPU",              // "GPU" (otomatis jatuh ke CPU bila gagal) atau "CPU"
  ui_hz: 8,                     // refresh kartu statistik (Hz)

  // Sama dengan notebook (section 3)
  num_hands: 2,
  detection_confidence: 0.55,
  presence_confidence: 0.55,
  tracking_confidence: 0.55,
  smooth: true,
  min_cutoff: 1.5,
  beta: 8.0,
  pinch_on: 0.28,
  pinch_off: 0.40,
  gesture_hold: 0.18,
  track_ttl: 0.55,
  trail_seconds: 1.2,
  show_ids: false,
  show_trails: true,
  draw_with_pinch: false,
  save_csv: false,
  csv_hz: 10,
  video_fps: 30,
  swap_handedness: false,

  enable_pose: true,
  pose_variant: "lite",
  pose_visibility: 0.55,
  pose_confidence: 0.50,
  swap_pose_sides: false,
  show_full_body: false,
  show_arm_labels: true,
  show_arm_trails: true,
  show_wrist_links: true,
  pose_ttl: 0.65,
  reject_black: true,
  association_max_diag: 0.12,
  association_ambiguity: 0.18,
  rep_bent: 75.0,
  rep_straight: 155.0,
  rep_hold: 0.20,
});

export function makeConfig(overrides = {}) {
  return { ...DEFAULT_CONFIG, ...overrides };
}

const isFiniteNum = (v) => typeof v === "number" && Number.isFinite(v);

/** Port validate_config(): melempar Error berbahasa Indonesia bila ada nilai tidak valid. */
export function validateConfig(cfg) {
  const fail = (msg) => { throw new Error(msg); };
  if (!["user", "environment"].includes(cfg.camera_facing)) fail("camera_facing harus 'user' atau 'environment'.");
  if (!["auto", "on", "off"].includes(cfg.mirror_mode)) fail("mirror_mode harus 'auto', 'on', atau 'off'.");
  if (![1, 2].includes(cfg.num_hands)) fail("num_hands harus 1 atau 2.");
  for (const key of ["process_long_side", "display_long_side", "csv_hz", "video_fps", "min_cutoff",
    "gesture_hold", "track_ttl", "trail_seconds", "ui_hz"]) {
    if (!isFiniteNum(cfg[key]) || cfg[key] <= 0) fail(`${key} harus positif dan berhingga.`);
  }
  if (cfg.process_long_side < 320) fail("process_long_side minimal 320 px.");
  for (const key of ["detection_confidence", "presence_confidence", "tracking_confidence",
    "pose_visibility", "pose_confidence", "association_ambiguity"]) {
    if (!isFiniteNum(cfg[key]) || cfg[key] < 0 || cfg[key] > 1) fail(`${key} harus di antara 0 dan 1.`);
  }
  if (!(cfg.pinch_on > 0 && cfg.pinch_on < cfg.pinch_off)) fail("Gunakan 0 < pinch_on < pinch_off.");
  if (!isFiniteNum(cfg.beta) || cfg.beta < 0) fail("beta harus berhingga dan tidak negatif.");
  if (!isFiniteNum(cfg.max_seconds) || cfg.max_seconds < 0) fail("max_seconds harus >= 0 (0 = tanpa batas).");
  if (!["lite", "full", "heavy"].includes(cfg.pose_variant)) fail("pose_variant harus lite, full, atau heavy.");
  for (const key of ["pose_ttl", "association_max_diag", "rep_hold"]) {
    if (!isFiniteNum(cfg[key]) || cfg[key] <= 0) fail(`${key} harus positif dan berhingga.`);
  }
  if (!(cfg.rep_bent > 0 && cfg.rep_bent < cfg.rep_straight && cfg.rep_straight < 180)) {
    fail("Gunakan 0 < rep_bent < rep_straight < 180.");
  }
  if (!["GPU", "CPU"].includes(cfg.delegate)) fail("delegate harus GPU atau CPU.");
}

/**
 * Koreksi kiri/kanan.
 * - Tangan: MediaPipe menentukan handedness dengan ASUMSI gambar di-mirror (kamera selfie).
 *   Jadi bila gambar yang diproses TIDAK di-mirror, label harus ditukar.
 * - Pose: label left_/right_ mengikuti tubuh yang tampak di gambar; pada gambar mirror,
 *   sisi itu terbalik terhadap anatomi asli. Default ini HARUS diverifikasi dengan
 *   tombol kalibrasi (calibFlip menyimpan koreksi tambahan per kamera).
 */
export function effectiveSwaps(cfg, mirrored, calibFlip = { hands: false, pose: false }) {
  const swapHands = (!mirrored) !== Boolean(cfg.swap_handedness) !== Boolean(calibFlip.hands);
  const swapPose = Boolean(mirrored) !== Boolean(cfg.swap_pose_sides) !== Boolean(calibFlip.pose);
  return { swapHands, swapPose };
}

/* ------------------------------------------------------------------ */
/* Konstanta landmark tangan                                           */
/* ------------------------------------------------------------------ */

export const FINGER_IDS = {
  Thumb: [1, 2, 3, 4], Index: [5, 6, 7, 8], Middle: [9, 10, 11, 12],
  Ring: [13, 14, 15, 16], Pinky: [17, 18, 19, 20],
};
export const FINGER_NAMES = Object.keys(FINGER_IDS);
export const PALM_IDS = [0, 5, 9, 13, 17];
export const PALM_CONNECTIONS = [[0, 1], [0, 5], [5, 9], [9, 13], [13, 17], [17, 0]];
export const HAND_CONNECTIONS = PALM_CONNECTIONS.concat(
  FINGER_NAMES.flatMap((n) => [0, 1, 2].map((j) => [FINGER_IDS[n][j], FINGER_IDS[n][j + 1]])),
);
export const LANDMARK_NAMES = [
  "wrist", "thumb_cmc", "thumb_mcp", "thumb_ip", "thumb_tip",
  "index_mcp", "index_pip", "index_dip", "index_tip",
  "middle_mcp", "middle_pip", "middle_dip", "middle_tip",
  "ring_mcp", "ring_pip", "ring_dip", "ring_tip",
  "pinky_mcp", "pinky_pip", "pinky_dip", "pinky_tip",
];
export const FINGER_METRICS = ["mcp_deg", "pip_deg", "dip_deg", "ip_deg", "bend_deg", "curl_percent",
  "extended", "tip_speed_px_s", "angular_speed_deg_s"];

/* ------------------------------------------------------------------ */
/* Utilitas numerik                                                    */
/* ------------------------------------------------------------------ */

const RAD2DEG = 180 / Math.PI;

export function norm(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  return Math.sqrt(s);
}

export function dist(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; }
  return Math.sqrt(s);
}

/** Sudut ABC dalam derajat (sendi lurus ≈ 180). Bekerja untuk vektor 2D maupun 3D. */
export function jointAngle(a, b, c) {
  let dot = 0, nu = 0, nv = 0;
  for (let i = 0; i < a.length; i++) {
    const u = a[i] - b[i], v = c[i] - b[i];
    dot += u * v; nu += u * u; nv += v * v;
  }
  const denom = Math.sqrt(nu) * Math.sqrt(nv);
  if (denom < 1e-10) return NaN;
  const cosine = Math.min(Math.max(dot / denom, -1), 1);
  return Math.acos(cosine) * RAD2DEG;
}

/** Modulo ala Python (hasil bertanda sama dengan pembagi). */
export function pyMod(a, n) {
  let m = a % n;
  if (m !== 0 && (m < 0) !== (n < 0)) m += n;
  return m === 0 ? 0 : m;
}

const clip = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const allFinite = (rows) => rows.every((r) => r.every((x) => Number.isFinite(x)));
const flatten = (rows) => {
  const out = new Float64Array(rows.length * 3);
  rows.forEach((r, i) => { out[3 * i] = r[0]; out[3 * i + 1] = r[1]; out[3 * i + 2] = r[2]; });
  return out;
};
const unflatten = (flat) => {
  const rows = new Array(flat.length / 3);
  for (let i = 0; i < rows.length; i++) rows[i] = [flat[3 * i], flat[3 * i + 1], flat[3 * i + 2]];
  return rows;
};
const cloneRows = (rows) => rows.map((r) => r.slice());

function pushBounded(arr, item, maxlen) {
  arr.push(item);
  if (arr.length > maxlen) arr.shift();
}

/** Counter(...).most_common(1)[0][0]: nilai terbanyak; seri dimenangkan yang muncul pertama. */
function mostCommon(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  let best = null, bestN = -1;
  for (const [k, n] of counts) if (n > bestN) { best = k; bestN = n; }
  return best;
}

/** itertools.product(pool, repeat=n) dengan urutan yang sama. */
function* product(pool, repeat) {
  if (repeat === 0) { yield []; return; }
  const idx = new Array(repeat).fill(0);
  while (true) {
    yield idx.map((i) => pool[i]);
    let k = repeat - 1;
    while (k >= 0) {
      idx[k] += 1;
      if (idx[k] < pool.length) break;
      idx[k] = 0;
      k -= 1;
    }
    if (k < 0) return;
  }
}

/* ------------------------------------------------------------------ */
/* Filter                                                              */
/* ------------------------------------------------------------------ */

/** One Euro Filter tervektorisasi (port kelas OneEuroFilter). Input: Float64Array/array datar. */
export class OneEuroFilter {
  constructor(minCutoff = 1.5, beta = 8.0, derivativeCutoff = 1.0) {
    this.minCutoff = Number(minCutoff);
    this.beta = Number(beta);
    this.derivativeCutoff = Number(derivativeCutoff);
    this.previousRaw = null;
    this.filtered = null;
    this.derivative = null;
    this.lastTime = null;
  }

  static alpha(cutoff, dt) {
    return 1.0 / (1.0 + 1.0 / (2.0 * Math.PI * cutoff * dt));
  }

  filter(value, t) {
    const n = value.length;
    if (this.lastTime === null || t - this.lastTime > 0.25) {
      this.previousRaw = Float64Array.from(value);
      this.filtered = Float64Array.from(value);
      this.derivative = new Float64Array(n);
      this.lastTime = t;
      return Float64Array.from(value);
    }
    const dt = Math.max(t - this.lastTime, 1e-5);
    const aD = OneEuroFilter.alpha(this.derivativeCutoff, dt);
    for (let i = 0; i < n; i++) {
      const rawDerivative = (value[i] - this.previousRaw[i]) / dt;
      this.derivative[i] += aD * (rawDerivative - this.derivative[i]);
      const cutoff = this.minCutoff + this.beta * Math.abs(this.derivative[i]);
      const a = OneEuroFilter.alpha(cutoff, dt);
      this.filtered[i] += a * (value[i] - this.filtered[i]);
      this.previousRaw[i] = value[i];
    }
    this.lastTime = t;
    return Float64Array.from(this.filtered);
  }
}

/** Debounce label berbasis waktu (port StableLabel). */
export class StableLabel {
  constructor(holdSeconds = 0.18) {
    this.holdSeconds = holdSeconds;
    this.current = "...";
    this.candidate = null;
    this.candidateSince = 0.0;
  }

  update(label, t) {
    if (label !== this.candidate) { this.candidate = label; this.candidateSince = t; }
    if (t - this.candidateSince >= this.holdSeconds) this.current = label;
    return this.current;
  }
}

/* ------------------------------------------------------------------ */
/* Geometri tangan & gestur                                            */
/* ------------------------------------------------------------------ */

/**
 * Port hand_geometry(): estimasi teknik dari koordinat 3D lokal model.
 * Bukan sudut sendi terkalibrasi klinis. Ibu jari punya MCP/IP, bukan PIP/DIP.
 */
export function handGeometry(world) {
  const palmSize = Math.max(0.5 * (dist(world[5], world[17]) + dist(world[0], world[9])), 1e-6);
  const fingers = {};
  for (const name of FINGER_NAMES) {
    const [p0, p1, p2, p3] = FINGER_IDS[name];
    let extended, included;
    if (name === "Thumb") {
      const mcp = jointAngle(world[p0], world[p1], world[p2]);
      const ip = jointAngle(world[p1], world[p2], world[p3]);
      const spread = dist(world[4], world[9]) / palmSize;
      extended = mcp > 145 && ip > 150 && spread > 0.95;
      included = 0.35 * mcp + 0.65 * ip;
      fingers[name] = { mcp_deg: mcp, pip_deg: NaN, dip_deg: NaN, ip_deg: ip };
    } else {
      const mcp = jointAngle(world[0], world[p0], world[p1]);
      const pip = jointAngle(world[p0], world[p1], world[p2]);
      const dip = jointAngle(world[p1], world[p2], world[p3]);
      const tipReach = dist(world[p3], world[0]);
      const pipReach = dist(world[p1], world[0]);
      extended = pip > 155 && dip > 145 && tipReach > 1.04 * pipReach;
      included = 0.65 * pip + 0.35 * dip;
      fingers[name] = { mcp_deg: mcp, pip_deg: pip, dip_deg: dip, ip_deg: NaN };
    }
    const bend = 180.0 - included;
    Object.assign(fingers[name], {
      extended: Boolean(extended), bend_deg: bend, curl_percent: clip(bend, 0, 100),
    });
  }
  return {
    fingers,
    palm_size_model_m: palmSize,
    pinch_ratio: dist(world[4], world[8]) / palmSize,
    finger_count: FINGER_NAMES.reduce((s, n) => s + (fingers[n].extended ? 1 : 0), 0),
  };
}

/** Port classify_gesture(): aturan eksplisit kecil, bukan pengenal bahasa isyarat. */
export function classifyGesture(metrics, imagePoints, pinch) {
  const [thumb, index, middle, ring, pinky] = FINGER_NAMES.map((n) => metrics.fingers[n].extended);
  if (pinch) return middle && ring && pinky ? "OK" : "PINCH";
  if (thumb && index && middle && ring && pinky) return "OPEN PALM";
  if (!(thumb || index || middle || ring || pinky)) return "FIST";
  if (index && middle && !ring && !pinky) return "PEACE";
  if (index && !(thumb || middle || ring || pinky)) return "POINT";
  if (thumb && !(index || middle || ring || pinky)) {
    const dx = imagePoints[4][0] - imagePoints[2][0];
    const dy = imagePoints[4][1] - imagePoints[2][1];
    if (Math.abs(dy) > Math.abs(dx)) return dy < 0 ? "THUMB UP" : "THUMB DOWN";
    return "THUMB OUT";
  }
  return `${metrics.finger_count} FINGERS`;
}

/**
 * Port unpack_result() untuk bentuk hasil MediaPipe Tasks versi Web:
 * { landmarks: [[{x,y,z}...21]], worldLandmarks: [...], handedness: [[{categoryName, score}]] }
 */
export function unpackHandResult(result, swapHandedness = false) {
  const detections = [];
  if (!result) return detections;
  const hands = result.landmarks || [];
  const worlds = result.worldLandmarks || [];
  const handed = result.handedness || result.handednesses || [];
  for (let i = 0; i < hands.length; i++) {
    if (i >= worlds.length) continue;
    const points = hands[i].map((p) => [p.x, p.y, p.z]);
    const world = worlds[i].map((p) => [p.x, p.y, p.z]);
    if (points.length !== 21 || world.length !== 21 || !allFinite(points) || !allFinite(world)) continue;
    let side = "Unknown", score = NaN;
    if (i < handed.length && handed[i] && handed[i].length) {
      const category = handed[i][0];
      side = category.categoryName || "Unknown";
      score = Number(category.score);
    }
    if (swapHandedness) side = side === "Left" ? "Right" : side === "Right" ? "Left" : side;
    detections.push({ points, world, handedness: side, handedness_score: score });
  }
  return detections;
}

/* ------------------------------------------------------------------ */
/* Tracking tangan                                                     */
/* ------------------------------------------------------------------ */

export class HandTrack {
  constructor(trackId, cfg) {
    this.id = trackId;
    this.cfg = cfg;
    this.points = null;
    this.world = null;
    this.rawPoints = null;
    this.rawWorld = null;
    this.lastSeen = null;
    this.handedness = "Unknown";
    this.rawHandedness = "Unknown";
    this.handednessScore = NaN;
    this.sideHistory = [];
    this.motionXY = [0, 0];
    this.missing = false;
    this.metrics = null;
    this.events = [];
    this.gesture = "...";
    this.rawGesture = "...";
    this.palmSpeedPxS = 0;
    this.resetTemporal();
  }

  resetTemporal() {
    const c = this.cfg;
    this.imageFilter = new OneEuroFilter(c.min_cutoff, c.beta);
    this.worldFilter = new OneEuroFilter(c.min_cutoff, c.beta);
    this.gestureFilter = new StableLabel(c.gesture_hold);
    this.pinch = false;
    this.trails = Object.fromEntries(FINGER_NAMES.map((n) => [n, []]));
    this.palmHistory = [];
    this.lastSwipeTime = -100.0;
    this.lastEventLabel = "";
    this.lastEventTime = -100.0;
    this.drawPrevious = null;
    this.speedPxS = new Float64Array(21);
    this.relativeSpeedPxS = new Float64Array(21);
    this.motionXY = [0, 0];
  }

  markMissing() {
    this.missing = true;
    this.drawPrevious = null;
    this.pinch = false;
  }

  predictWrist(t) {
    const gap = Math.min(Math.max(t - this.lastSeen, 0.0), 0.15);
    return [this.points[0][0] + this.motionXY[0] * gap, this.points[0][1] + this.motionXY[1] * gap];
  }

  update(detection, t, width, height) {
    const cfg = this.cfg;
    const oldPoints = this.points;
    const oldMetrics = this.metrics;
    const dt = this.lastSeen === null ? null : t - this.lastSeen;
    const discontinuity = this.missing || dt === null || dt <= 0 || dt > 0.25;
    if (discontinuity) this.resetTemporal();

    this.rawPoints = cloneRows(detection.points);
    this.rawWorld = cloneRows(detection.world);
    if (cfg.smooth) {
      this.points = unflatten(this.imageFilter.filter(flatten(this.rawPoints), t));
      this.world = unflatten(this.worldFilter.filter(flatten(this.rawWorld), t));
    } else {
      this.points = cloneRows(this.rawPoints);
      this.world = cloneRows(this.rawWorld);
    }
    pushBounded(this.sideHistory, detection.handedness, 12);
    this.handedness = mostCommon(this.sideHistory);
    // Skor milik kategori mentah SAAT INI, bukan label hasil voting.
    this.rawHandedness = detection.handedness;
    this.handednessScore = detection.handedness_score;
    this.metrics = handGeometry(this.world);

    this.palmSpeedPxS = 0.0;
    if (!discontinuity) {
      const speed = new Float64Array(21);
      const relative = new Float64Array(21);
      let palmDx = 0, palmDy = 0;
      const cx0 = this.points[0][0], cy0 = this.points[0][1];
      const ox0 = oldPoints[0][0], oy0 = oldPoints[0][1];
      for (let i = 0; i < 21; i++) {
        const dx = (this.points[i][0] - oldPoints[i][0]) * width;
        const dy = (this.points[i][1] - oldPoints[i][1]) * height;
        const vx = dx / dt, vy = dy / dt;
        speed[i] = Math.sqrt(vx * vx + vy * vy);
        const rx = (((this.points[i][0] - cx0) - (oldPoints[i][0] - ox0)) * width) / dt;
        const ry = (((this.points[i][1] - cy0) - (oldPoints[i][1] - oy0)) * height) / dt;
        relative[i] = Math.sqrt(rx * rx + ry * ry);
        if (PALM_IDS.includes(i)) { palmDx += dx; palmDy += dy; }
      }
      for (let i = 0; i < 21; i++) {
        this.speedPxS[i] = 0.4 * speed[i] + 0.6 * this.speedPxS[i];
        this.relativeSpeedPxS[i] = 0.4 * relative[i] + 0.6 * this.relativeSpeedPxS[i];
      }
      const px = (palmDx / PALM_IDS.length) / dt, py = (palmDy / PALM_IDS.length) / dt;
      this.palmSpeedPxS = Math.sqrt(px * px + py * py);
      const ix = (this.points[0][0] - oldPoints[0][0]) / dt;
      const iy = (this.points[0][1] - oldPoints[0][1]) / dt;
      this.motionXY = [0.5 * this.motionXY[0] + 0.5 * ix, 0.5 * this.motionXY[1] + 0.5 * iy];
    }
    for (const name of FINGER_NAMES) {
      const ids = FINGER_IDS[name];
      const finger = this.metrics.fingers[name];
      finger.tip_speed_px_s = this.speedPxS[ids[3]];
      finger.angular_speed_deg_s = !discontinuity && oldMetrics !== null
        ? (finger.bend_deg - oldMetrics.fingers[name].bend_deg) / dt
        : 0.0;
    }

    const previousPinch = this.pinch;
    const ratio = this.metrics.pinch_ratio;
    this.pinch = ratio < (this.pinch ? cfg.pinch_off : cfg.pinch_on);
    this.events = [];
    if (this.pinch !== previousPinch) this.events.push(this.pinch ? "PINCH_START" : "PINCH_END");
    const rawGesture = classifyGesture(this.metrics, this.points, this.pinch);
    this.gesture = this.gestureFilter.update(rawGesture, t);
    this.rawGesture = rawGesture;

    let palmX = 0, palmY = 0;
    for (const i of PALM_IDS) { palmX += this.points[i][0]; palmY += this.points[i][1]; }
    const palm = [palmX / PALM_IDS.length, palmY / PALM_IDS.length];
    pushBounded(this.palmHistory, [t, palm.slice()], 100);
    while (this.palmHistory.length && t - this.palmHistory[0][0] > 0.45) this.palmHistory.shift();

    // Swipe: tangan terbuka harus bergerak cukup jauh dalam 0.45 s (arah gambar).
    const fourOpen = ["Index", "Middle", "Ring", "Pinky"].every((n) => this.metrics.fingers[n].extended);
    if (fourOpen && !this.pinch && this.palmHistory.length > 1 && t - this.lastSwipeTime > 0.8) {
      const elapsed = t - this.palmHistory[0][0];
      const dx = palm[0] - this.palmHistory[0][1][0];
      const dy = palm[1] - this.palmHistory[0][1][1];
      let swipe = null;
      if (elapsed >= 0.15) {
        if (Math.abs(dx) > 0.18 && Math.abs(dx) > 1.7 * Math.abs(dy)) swipe = dx > 0 ? "SWIPE RIGHT" : "SWIPE LEFT";
        else if (Math.abs(dy) > 0.18 && Math.abs(dy) > 1.7 * Math.abs(dx)) swipe = dy > 0 ? "SWIPE DOWN" : "SWIPE UP";
      }
      if (swipe) {
        this.events.push(swipe);
        this.lastSwipeTime = t;
        this.palmHistory = [];
      }
    }
    if (this.events.length) {
      this.lastEventLabel = this.events[this.events.length - 1];
      this.lastEventTime = t;
    }
    for (const name of FINGER_NAMES) {
      const tip = this.points[FINGER_IDS[name][3]];
      const trail = this.trails[name];
      pushBounded(trail, [t, [tip[0], tip[1]]], 240);
      while (trail.length && t - trail[0][0] > cfg.trail_seconds) trail.shift();
    }
    this.lastSeen = t;
    this.missing = false;
    return this.snapshot();
  }

  snapshot() {
    return {
      track_id: this.id, time_s: this.lastSeen,
      handedness: this.handedness, raw_handedness: this.rawHandedness,
      handedness_score: this.handednessScore,
      points: this.points, world: this.world,
      raw_points: this.rawPoints, raw_world: this.rawWorld,
      gesture: this.gesture, raw_gesture: this.rawGesture,
      pinch: this.pinch, metrics: this.metrics,
      palm_speed_px_s: this.palmSpeedPxS,
    };
  }
}

/** Penugasan global berpagar untuk ≤2 deteksi (tanpa jaminan identitas). */
export class MultiHandTracker {
  constructor(cfg) {
    this.cfg = cfg;
    this.tracks = new Map();
    this.nextId = 1;
  }

  update(detections, t, width, height) {
    const kept = new Map();
    for (const [id, tr] of this.tracks) if (t - tr.lastSeen <= this.cfg.track_ttl) kept.set(id, tr);
    // Batasi kandidat bila visibilitas buruk berulang kali membuat track baru.
    const candidates = [...kept.keys()]
      .sort((a, b) => kept.get(b).lastSeen - kept.get(a).lastSeen) // stabil, menurun
      .slice(0, 8);
    this.tracks = new Map(candidates.map((id) => [id, kept.get(id)]));

    const costs = new Map();
    const aspectY = height / width;
    detections.forEach((det, d) => {
      for (const tid of candidates) {
        const tr = this.tracks.get(tid);
        const sx = tr.points[5][0] - tr.points[17][0];
        const sy = (tr.points[5][1] - tr.points[17][1]) * aspectY;
        const palmScale = Math.max(Math.sqrt(sx * sx + sy * sy), 0.06);
        const pw = tr.predictWrist(t);
        const dx = det.points[0][0] - pw[0];
        const dy = (det.points[0][1] - pw[1]) * aspectY;
        const distance = Math.sqrt(dx * dx + dy * dy) / palmScale;
        const sidePenalty = det.handedness !== tr.handedness && det.handedness_score > 0.8 ? 0.35 : 0.0;
        costs.set(`${d}|${tid}`, distance < 2.5 ? distance + sidePenalty : Infinity);
      }
    });

    let bestAssignment = detections.map(() => null);
    let bestCost = Infinity;
    for (const assignment of product([null, ...candidates], detections.length)) {
      const used = assignment.filter((tid) => tid !== null);
      if (new Set(used).size !== used.length) continue;
      let cost = 0;
      assignment.forEach((tid, d) => { cost += tid === null ? 2.2 : costs.get(`${d}|${tid}`); });
      if (cost < bestCost) { bestAssignment = assignment; bestCost = cost; }
    }

    const visible = [];
    const seen = new Set();
    detections.forEach((det, d) => {
      let tid = bestAssignment[d];
      if (tid === null) {
        tid = this.nextId;
        this.nextId += 1;
        this.tracks.set(tid, new HandTrack(tid, this.cfg));
      }
      const track = this.tracks.get(tid);
      track.update(det, t, width, height);
      visible.push(track);
      seen.add(tid);
    });
    for (const [tid, track] of this.tracks) if (!seen.has(tid)) track.markMissing();
    return visible.sort((a, b) => a.id - b.id);
  }
}

/** Dua pinch membentuk gestur skala/rotasi relatif (hanya di dalam app). */
export class BimanualControl {
  constructor() { this.baseline = null; }

  update(tracks, width, height) {
    const active = tracks.filter((tr) => tr.pinch).sort((a, b) => a.id - b.id);
    if (active.length !== 2) {
      this.baseline = null;
      return { active: false, scale: null, rotation_deg: null };
    }
    const centers = active.map((tr) => [
      0.5 * (tr.points[4][0] + tr.points[8][0]) * width,
      0.5 * (tr.points[4][1] + tr.points[8][1]) * height,
    ]);
    const vx = centers[1][0] - centers[0][0], vy = centers[1][1] - centers[0][1];
    const distance = Math.sqrt(vx * vx + vy * vy);
    if (distance < 30) {
      this.baseline = null;
      return { active: false, scale: null, rotation_deg: null };
    }
    const angle = Math.atan2(vy, vx) * RAD2DEG;
    const ids = `${active[0].id},${active[1].id}`;
    if (this.baseline === null || this.baseline.ids !== ids) this.baseline = { ids, distance, angle };
    return {
      active: true,
      scale: distance / this.baseline.distance,
      rotation_deg: pyMod(angle - this.baseline.angle + 180, 360) - 180,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Pose & lengan                                                       */
/* ------------------------------------------------------------------ */

export const POSE_NAMES = [
  "nose", "left_eye_inner", "left_eye", "left_eye_outer", "right_eye_inner", "right_eye",
  "right_eye_outer", "left_ear", "right_ear", "mouth_left", "mouth_right",
  "left_shoulder", "right_shoulder", "left_elbow", "right_elbow", "left_wrist", "right_wrist",
  "left_pinky", "right_pinky", "left_index", "right_index", "left_thumb", "right_thumb",
  "left_hip", "right_hip", "left_knee", "right_knee", "left_ankle", "right_ankle",
  "left_heel", "right_heel", "left_foot_index", "right_foot_index",
];
export const POSE_SIDES = {
  Left: { shoulder: 11, elbow: 13, wrist: 15, hip: 23 },
  Right: { shoulder: 12, elbow: 14, wrist: 16, hip: 24 },
};
export const SIDE_NAMES = ["Left", "Right"];
export const POSE_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 7], [0, 4], [4, 5], [5, 6], [6, 8], [9, 10],
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [15, 17], [15, 19], [15, 21], [17, 19], [16, 18], [16, 20], [16, 22], [18, 20],
  [11, 23], [12, 24], [23, 24], [23, 25], [24, 26], [25, 27], [26, 28],
  [27, 29], [28, 30], [29, 31], [30, 32], [27, 31], [28, 32],
];
export const POSE_METRIC_FIELDS = [
  "elbow_included_2d_deg", "elbow_included_model3d_deg", "elbow_bend_2d_deg",
  "trunk_arm_2d_deg", "trunk_arm_model3d_deg", "wrist_deflection_2d_deg",
  "elbow_speed_px_s", "wrist_speed_px_s", "wrist_shoulder_relative_speed_px_s",
  "elbow_bend_velocity_deg_s", "upper_arm_length_px", "forearm_length_px",
];

const POSE_SWAP_ORDER = (() => {
  const order = Array.from({ length: 33 }, (_, i) => i);
  const pairs = [[1, 4], [2, 5], [3, 6], [7, 8], [9, 10]];
  for (let i = 11; i < 33; i += 2) pairs.push([i, i + 1]);
  for (const [a, b] of pairs) { const tmp = order[a]; order[a] = order[b]; order[b] = tmp; }
  return order;
})();

/**
 * Port unpack_pose_result() untuk hasil PoseLandmarker versi Web. Satu orang saja.
 * Bila API tidak menyediakan `presence`, nilainya NaN dan gerbang presence dilewati
 * (presence_available=false) — dicatat di session.json.
 */
export function unpackPoseResult(result, swapSides = false) {
  if (!result || !result.landmarks || !result.landmarks.length) return null;
  if (!result.worldLandmarks || !result.worldLandmarks.length) return null;
  const marks = result.landmarks[0], world = result.worldLandmarks[0];
  if (!marks || !world || marks.length !== 33 || world.length !== 33) return null;
  let points = marks.map((p) => [p.x, p.y, p.z]);
  let coords = world.map((p) => [p.x, p.y, p.z]);
  // Kualitas yang hilang = tidak diketahui, BUKAN dianggap tinggi.
  const quality = (p, key) => (typeof p[key] === "number" && Number.isFinite(p[key]) ? p[key] : 0.0);
  const presenceAvailable = marks.some((p) => typeof p.presence === "number");
  let visibility = marks.map((p) => quality(p, "visibility"));
  let presence = presenceAvailable ? marks.map((p) => quality(p, "presence")) : marks.map(() => NaN);
  if (!allFinite(points) || !allFinite(coords)) return null;
  if (swapSides) {
    const o = POSE_SWAP_ORDER;
    points = o.map((i) => points[i]);
    coords = o.map((i) => coords[i]);
    visibility = o.map((i) => visibility[i]);
    presence = o.map((i) => presence[i]);
  }
  return { points, world: coords, visibility, presence, presence_available: presenceAvailable };
}

export function poseValidMask(points, visibility, presence, threshold, presenceAvailable = true) {
  return points.map((p, i) => (
    visibility[i] >= threshold
    && (presenceAvailable ? presence[i] >= threshold : true)
    && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Number.isFinite(p[2])
    && p[0] >= 0 && p[0] <= 1 && p[1] >= 0 && p[1] <= 1
  ));
}

const allValid = (valid, ids) => ids.every((i) => valid[i]);

/** Port arm_geometry(). */
export function armGeometry(points, world, valid, side, width, height) {
  const { shoulder: s, elbow: e, wrist: w, hip } = POSE_SIDES[side];
  const px = (i) => [points[i][0] * width, points[i][1] * height];
  const metrics = Object.fromEntries(POSE_METRIC_FIELDS.map((k) => [k, NaN]));
  Object.assign(metrics, {
    arm_visible: allValid(valid, [s, e, w]),
    raised_2d: null, matched_hand_id: null,
    association_distance_px: NaN, rep_count: 0, rep_phase: "WAIT",
  });
  if (allValid(valid, [s, e])) metrics.upper_arm_length_px = dist(px(e), px(s));
  if (allValid(valid, [e, w])) metrics.forearm_length_px = dist(px(w), px(e));
  if (allValid(valid, [s, e, w])) {
    const a2 = jointAngle(px(s), px(e), px(w));
    metrics.elbow_included_2d_deg = a2;
    metrics.elbow_included_model3d_deg = jointAngle(world[s], world[e], world[w]);
    metrics.elbow_bend_2d_deg = 180.0 - a2;
  }
  if (allValid(valid, [hip, s, e])) {
    metrics.trunk_arm_2d_deg = jointAngle(px(hip), px(s), px(e));
    metrics.trunk_arm_model3d_deg = jointAngle(world[hip], world[s], world[e]);
  }
  if (allValid(valid, [s, w])) {
    // Relasi tinggi di gambar, bukan kejadian 3D terkalibrasi gravitasi.
    metrics.raised_2d = px(w)[1] < px(s)[1] - height * 0.04;
  }
  return metrics;
}

/** Siklus heuristik lurus -> tekuk -> lurus; bukan penilaian latihan klinis. */
export class ArmCycleCounter {
  constructor(bent = 75.0, straight = 155.0, hold = 0.20) {
    this.bent = bent;
    this.straight = straight;
    this.hold = hold;
    this.count = 0;
    this.phase = "WAIT";
    this.candidate = null;
    this.candidateSince = null;
    this.lastValid = null;
  }

  update(angle, t) {
    let event = null;
    if (!Number.isFinite(angle)) {
      this.candidate = null;
      if (this.lastValid !== null && t - this.lastValid > 0.35) this.phase = "WAIT";
      return event;
    }
    if (this.lastValid !== null && t - this.lastValid > 0.35) { this.phase = "WAIT"; this.candidate = null; }
    this.lastValid = t;
    const label = angle <= this.bent ? "BENT" : angle >= this.straight ? "STRAIGHT" : "MID";
    if (label !== this.candidate) { this.candidate = label; this.candidateSince = t; }
    if (t - this.candidateSince < this.hold) return event;
    if (label === "STRAIGHT") {
      if (this.phase === "BENT") { this.count += 1; event = "ELBOW_CYCLE_COMPLETE"; }
      this.phase = "STRAIGHT";
    } else if (label === "BENT" && this.phase === "STRAIGHT") {
      this.phase = "BENT";
    }
    return event;
  }
}

const TRAIL_POSE_IDS = [11, 12, 13, 14, 15, 16];

/** Heuristik kontinuitas satu orang, terpisah dari ID tangan. */
export class UpperBodyTracker {
  constructor(cfg) {
    this.cfg = cfg;
    this.epoch = 0;
    this.last = null;
    this.imageFilters = [];
    this.worldFilters = [];
    this.trails = {};
    this.counters = {};
    this.angleHistory = {};
    this.lastSeen = null;
    this.wasMissing = true;
    this.lastCenter = null;
  }

  newFilter() { return new OneEuroFilter(this.cfg.min_cutoff, this.cfg.beta); }

  reset() {
    this.epoch += 1;
    this.last = null;
    this.imageFilters = Array.from({ length: 33 }, () => this.newFilter());
    this.worldFilters = Array.from({ length: 33 }, () => this.newFilter());
    this.trails = Object.fromEntries(TRAIL_POSE_IDS.map((i) => [i, []]));
    this.counters = Object.fromEntries(SIDE_NAMES.map((s) => [s,
      new ArmCycleCounter(this.cfg.rep_bent, this.cfg.rep_straight, this.cfg.rep_hold)]));
    this.angleHistory = Object.fromEntries(SIDE_NAMES.map((s) => [s, []]));
    this.lastSeen = null;
    this.lastCenter = null;
  }

  update(detection, t, width, height) {
    const cfg = this.cfg;
    if (detection === null) {
      this.wasMissing = true;
      for (const counter of Object.values(this.counters)) counter.update(NaN, t);
      for (const entries of Object.values(this.trails)) entries.length = 0;
      return null; // Jangan pernah melukis tubuh basi di atas frame baru.
    }
    const raw = detection.points, world = detection.world;
    const { visibility, presence } = detection;
    const presenceAvailable = detection.presence_available !== false;
    const valid = poseValidMask(raw, visibility, presence, cfg.pose_visibility, presenceAvailable);
    const center = valid[11] && valid[12]
      ? [(raw[11][0] + raw[12][0]) / 2, (raw[11][1] + raw[12][1]) / 2] : null;
    const gap = this.lastSeen === null ? null : t - this.lastSeen;
    const jump = center !== null && this.lastCenter !== null && dist(center, this.lastCenter) > 0.32;
    if (this.epoch === 0 || (gap !== null && gap > cfg.pose_ttl) || jump) this.reset();

    const old = this.last;
    const dt = old === null ? null : t - old.time_s;
    const continuous = !this.wasMissing && dt !== null && dt > 0 && dt <= 0.25;
    const points = cloneRows(raw);
    const smoothWorld = cloneRows(world);
    const speed = new Array(33).fill(NaN);
    for (let i = 0; i < 33; i++) {
      const priorValid = Boolean(old !== null && old.valid[i]);
      if (!valid[i] || !priorValid || !continuous) {
        this.imageFilters[i] = this.newFilter();
        this.worldFilters[i] = this.newFilter();
      }
      if (valid[i] && cfg.smooth) {
        points[i] = Array.from(this.imageFilters[i].filter(raw[i], t));
        smoothWorld[i] = Array.from(this.worldFilters[i].filter(world[i], t));
      }
      if (valid[i] && priorValid && continuous) {
        const dx = (points[i][0] - old.points[i][0]) * width;
        const dy = (points[i][1] - old.points[i][1]) * height;
        speed[i] = Math.sqrt(dx * dx + dy * dy) / dt;
      }
      if (i in this.trails) {
        const trail = this.trails[i];
        if (!valid[i] || !priorValid || !continuous) trail.length = 0;
        if (valid[i]) pushBounded(trail, [t, [points[i][0], points[i][1]]], 200);
        while (trail.length && t - trail[0][0] > cfg.trail_seconds) trail.shift();
      }
    }

    const arms = {};
    const events = [];
    for (const side of SIDE_NAMES) {
      const { shoulder: s, elbow: e, wrist: w } = POSE_SIDES[side];
      const m = armGeometry(points, smoothWorld, valid, side, width, height);
      m.elbow_speed_px_s = speed[e];
      m.wrist_speed_px_s = speed[w];
      if (continuous && valid[s] && valid[w] && old.valid[s] && old.valid[w]) {
        const rx = ((points[w][0] - points[s][0]) - (old.points[w][0] - old.points[s][0])) * width;
        const ry = ((points[w][1] - points[s][1]) - (old.points[w][1] - old.points[s][1])) * height;
        m.wrist_shoulder_relative_speed_px_s = Math.sqrt(rx * rx + ry * ry) / dt;
      }
      if (continuous && Number.isFinite(m.elbow_bend_2d_deg)) {
        const prior = old.arms[side].elbow_bend_2d_deg;
        if (Number.isFinite(prior)) m.elbow_bend_velocity_deg_s = (m.elbow_bend_2d_deg - prior) / dt;
      }
      const counter = this.counters[side];
      const event = counter.update(m.elbow_included_2d_deg, t);
      m.rep_count = counter.count;
      m.rep_phase = counter.phase;
      if (event) events.push({ side, event, count: counter.count });
      const history = this.angleHistory[side];
      pushBounded(history, [t, m.elbow_included_2d_deg], 240);
      while (history.length && t - history[0][0] > 8) history.shift();
      arms[side] = m;
    }
    const snap = {
      time_s: t, pose_epoch: this.epoch, points, world: smoothWorld,
      raw_points: cloneRows(raw), raw_world: cloneRows(world),
      visibility: visibility.slice(), presence: presence.slice(),
      presence_available: presenceAvailable, valid, speed_px_s: speed,
      arms, events, trails: this.trails, angle_history: this.angleHistory,
      width, height,
    };
    this.last = snap;
    this.lastSeen = t;
    this.wasMissing = false;
    if (center !== null) this.lastCenter = center.slice();
    return snap;
  }
}

/**
 * Pencocokan pergelangan 2D satu-ke-satu yang konservatif. Persilangan ambigu dibiarkan
 * tidak cocok. Jangan pernah menjumlahkan koordinat world tangan dengan world pose.
 */
export function associateHandsWithArms(pose, tracks, cfg, width, height) {
  if (pose === null || !tracks.length) return [];
  const body = pose.points.map((p) => [p[0] * width, p[1] * height]);
  const valid = pose.valid;
  const sides = SIDE_NAMES.filter((s) => {
    const ids = POSE_SIDES[s];
    return valid[ids.shoulder] && valid[ids.elbow] && valid[ids.wrist];
  });
  if (!sides.length) return [];
  const gates = {}, costs = new Map(), distances = new Map();
  const diagonal = Math.hypot(width, height);
  for (const side of sides) {
    const ids = POSE_SIDES[side];
    const forearm = dist(body[ids.elbow], body[ids.wrist]);
    gates[side] = Math.min(cfg.association_max_diag * diagonal, Math.max(25.0, forearm * 0.55));
  }
  tracks.forEach((hand, i) => {
    const hw = [hand.points[0][0] * width, hand.points[0][1] * height];
    for (const side of sides) {
      const distance = dist(hw, body[POSE_SIDES[side].wrist]);
      distances.set(`${i}|${side}`, distance);
      costs.set(`${i}|${side}`, distance <= gates[side] ? distance / gates[side] : Infinity);
    }
    const feasible = sides.map((s) => costs.get(`${i}|${s}`)).filter((c) => Number.isFinite(c))
      .sort((a, b) => a - b);
    if (feasible.length === 2 && feasible[1] - feasible[0] < cfg.association_ambiguity) {
      for (const side of sides) costs.set(`${i}|${side}`, Infinity);
    }
  });
  let best = tracks.map(() => null), bestCost = Infinity;
  for (const assignment of product([null, ...sides], tracks.length)) {
    const used = assignment.filter((s) => s !== null);
    if (new Set(used).size !== used.length) continue;
    let cost = 0;
    assignment.forEach((s, i) => { cost += s === null ? 1.15 : costs.get(`${i}|${s}`); });
    if (cost < bestCost) { best = assignment; bestCost = cost; }
  }
  const links = [];
  best.forEach((side, i) => {
    if (side === null) return;
    const hand = tracks[i], ids = POSE_SIDES[side];
    const hw = [hand.points[0][0] * width, hand.points[0][1] * height];
    const fingerBase = [hand.points[9][0] * width, hand.points[9][1] * height];
    // Proksi defleksi 2D terproyeksi, bukan fleksi pergelangan anatomis yang terisolasi.
    const deflection = 180.0 - jointAngle(body[ids.elbow], hw, fingerBase);
    Object.assign(pose.arms[side], {
      matched_hand_id: hand.id,
      association_distance_px: distances.get(`${i}|${side}`),
      wrist_deflection_2d_deg: deflection,
    });
    links.push({
      side, track_id: hand.id, distance_px: distances.get(`${i}|${side}`),
      pose_wrist: [pose.points[ids.wrist][0], pose.points[ids.wrist][1]],
      hand_wrist: [hand.points[0][0], hand.points[0][1]],
    });
  });
  return links;
}

/* ------------------------------------------------------------------ */
/* Pipeline per frame (urutan sama dengan run_arm_hand_tracker)        */
/* ------------------------------------------------------------------ */

export class MotionPipeline {
  constructor(cfg) {
    this.cfg = cfg;
    this.reset();
  }

  reset() {
    this.hands = new MultiHandTracker(this.cfg);
    this.body = new UpperBodyTracker(this.cfg);
    this.bimanualControl = new BimanualControl();
  }

  step({ handResult, poseResult, t, width, height, swapHands = false, swapPose = false }) {
    const detections = unpackHandResult(handResult, swapHands);
    const tracks = this.hands.update(detections, t, width, height);
    const pose = this.body.update(unpackPoseResult(poseResult, swapPose), t, width, height);
    const links = associateHandsWithArms(pose, tracks, this.cfg, width, height);
    const bimanual = this.bimanualControl.update(tracks, width, height);
    return { detections, tracks, pose, links, bimanual };
  }
}

/* ------------------------------------------------------------------ */
/* Kesehatan frame (heuristik gelap)                                   */
/* ------------------------------------------------------------------ */

/**
 * Heuristik frame hampir hitam dari data RGBA (mis. ImageData.data kanvas kecil).
 * BUKAN bukti kerusakan hardware. Ambang sama dengan notebook: mean < 2 dan p99 < 5.
 */
export function frameHealth(rgba) {
  if (!rgba || !rgba.length) return { readable: false, near_black: true, mean: 0, p99: 0, std: 0 };
  const n = rgba.length / 4;
  const hist = new Uint32Array(256);
  let sum = 0, sumSq = 0;
  for (let i = 0; i < n; i++) {
    const y = Math.round(0.299 * rgba[4 * i] + 0.587 * rgba[4 * i + 1] + 0.114 * rgba[4 * i + 2]);
    hist[y] += 1; sum += y; sumSq += y * y;
  }
  const mean = sum / n;
  const std = Math.sqrt(Math.max(sumSq / n - mean * mean, 0));
  let acc = 0, p99 = 255;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= 0.99 * n) { p99 = v; break; } }
  return { readable: true, near_black: mean < 2.0 && p99 < 5.0, mean, p99, std };
}
