/*
 * draw.js — menggambar overlay di kanvas (port draw_hand, draw_pose_and_arms,
 * draw_dashed_line, draw_sparkline dari notebook). Warna sama dengan notebook
 * (OpenCV BGR dikonversi ke RGB).
 */
import { FINGER_IDS, FINGER_NAMES, PALM_CONNECTIONS, POSE_CONNECTIONS, POSE_SIDES, SIDE_NAMES } from "./core.js";

export const FINGER_COLORS = {
  Thumb: "rgb(255,185,90)", Index: "rgb(150,245,100)", Middle: "rgb(90,200,255)",
  Ring: "rgb(230,145,230)", Pinky: "rgb(255,120,140)",
};
export const ARM_COLORS = { Left: "rgb(80,190,255)", Right: "rgb(255,220,100)" };
export const SIDE_ID = { Left: "kiri", Right: "kanan", Unknown: "?" };
export const FINGER_ID = { Thumb: "Jempol", Index: "Telunjuk", Middle: "Tengah", Ring: "Manis", Pinky: "Kelingking" };
const PINCH_COLOR = "rgb(255,255,90)";
const LINK_COLOR = "rgb(180,240,180)";
const FONT = "Archivo, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

const withAlpha = (rgb, a) => rgb.replace("rgb(", "rgba(").replace(")", `,${a.toFixed(3)})`);
const fmt = (v, d = 0) => (Number.isFinite(v) ? v.toFixed(d) : "N/A");

/** Konversi titik ternormalisasi ke piksel kanvas; clipping HANYA untuk render. */
function px(p, w, h) {
  return [Math.min(Math.max(p[0] * w, 0), w - 1), Math.min(Math.max(p[1] * h, 0), h - 1)];
}

function outlinedText(ctx, text, x, y, size, color, weight = 600) {
  ctx.font = `${weight} ${size}px ${FONT}`;
  ctx.lineJoin = "round";
  ctx.lineWidth = Math.max(2, size * 0.28);
  ctx.strokeStyle = "rgba(10,14,20,0.85)";
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

function line(ctx, a, b, color, width) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(a[0], a[1]);
  ctx.lineTo(b[0], b[1]);
  ctx.stroke();
}

function dot(ctx, p, r, fill, ring = "rgba(25,25,25,0.9)") {
  ctx.fillStyle = ring;
  ctx.beginPath(); ctx.arc(p[0], p[1], r + 1.2, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = fill;
  ctx.beginPath(); ctx.arc(p[0], p[1], r, 0, Math.PI * 2); ctx.fill();
}

function drawHand(ctx, track, cfg, t, w, h, k) {
  ctx.lineCap = "round";
  const pts = track.points.map((p) => px(p, w, h));
  if (cfg.show_trails) {
    for (const name of FINGER_NAMES) {
      const trail = track.trails[name];
      for (let j = 1; j < trail.length; j++) {
        const strength = 0.25 + (0.65 * j) / Math.max(trail.length - 1, 1);
        line(ctx, px(trail[j - 1][1], w, h), px(trail[j][1], w, h), withAlpha(FINGER_COLORS[name], strength), 2 * k);
      }
    }
  }
  for (const [a, b] of PALM_CONNECTIONS) line(ctx, pts[a], pts[b], "rgba(230,225,220,0.95)", 2 * k);
  for (const name of FINGER_NAMES) {
    const chain = FINGER_IDS[name];
    for (let j = 0; j < 3; j++) line(ctx, pts[chain[j]], pts[chain[j + 1]], FINGER_COLORS[name], 3 * k);
    for (const id of chain) dot(ctx, pts[id], (id === chain[3] ? 6 : 4) * k, FINGER_COLORS[name]);
  }
  dot(ctx, pts[0], 6 * k, "#ffffff");
  if (cfg.show_ids) {
    pts.forEach((p, i) => outlinedText(ctx, String(i), p[0] + 5 * k, p[1] - 5 * k, 10 * k, "#ffffff", 500));
  }
  if (track.pinch) {
    const c = [(pts[4][0] + pts[8][0]) / 2, (pts[4][1] + pts[8][1]) / 2];
    line(ctx, pts[4], pts[8], PINCH_COLOR, 3 * k);
    ctx.strokeStyle = PINCH_COLOR;
    ctx.lineWidth = 2 * k;
    ctx.beginPath(); ctx.arc(c[0], c[1], 17 * k, 0, Math.PI * 2); ctx.stroke();
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of pts) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
  ctx.strokeStyle = "rgba(155,170,185,0.7)";
  ctx.lineWidth = 1 * k;
  ctx.strokeRect(Math.max(minX - 12 * k, 0), Math.max(minY - 12 * k, 0),
    Math.min(maxX + 12 * k, w - 1) - Math.max(minX - 12 * k, 0), Math.min(maxY + 12 * k, h - 1) - Math.max(minY - 12 * k, 0));

  const label = `H${track.id} ${SIDE_ID[track.handedness] ?? track.handedness} | ${track.gesture}`;
  const size = 13 * k;
  ctx.font = `600 ${size}px ${FONT}`;
  const tw = ctx.measureText(label).width + 14 * k;
  const ly = Math.max(24 * k, minY - 18 * k);
  const lx = Math.max(4 * k, Math.min(minX, w - tw - 4 * k));
  ctx.fillStyle = "rgba(28,37,48,0.88)";
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(lx - 3 * k, ly - 18 * k, tw, 25 * k, 5 * k) : ctx.rect(lx - 3 * k, ly - 18 * k, tw, 25 * k);
  ctx.fill();
  ctx.fillStyle = "#EDF1F5";
  ctx.fillText(label, lx + 4 * k, ly);
  if (t - track.lastEventTime < 0.65) {
    outlinedText(ctx, track.lastEventLabel, lx, Math.min(h - 8 * k, maxY + 30 * k), 15 * k, PINCH_COLOR, 700);
  }
}

function dashed(ctx, a, b, color, width, k) {
  ctx.save();
  ctx.setLineDash([5 * k, 5 * k]);
  line(ctx, a, b, color, width);
  ctx.restore();
}

function drawPose(ctx, pose, links, cfg, w, h, k) {
  if (!pose) return;
  const pts = pose.points.map((p) => px(p, w, h));
  const valid = pose.valid;
  ctx.lineCap = "round";
  const context = cfg.show_full_body
    ? POSE_CONNECTIONS.filter(([a, b]) => !((a >= 15 && a <= 22) || (b >= 15 && b <= 22)))
    : [[11, 12], [11, 23], [12, 24], [23, 24]];
  for (const [a, b] of context) if (valid[a] && valid[b]) line(ctx, pts[a], pts[b], "rgba(150,162,175,0.9)", 2 * k);
  if (cfg.show_full_body) {
    for (let i = 0; i < 33; i++) if (valid[i] && !(i >= 15 && i <= 22)) dot(ctx, pts[i], 3 * k, "rgb(210,215,220)", "rgba(0,0,0,0)");
  }
  for (const side of SIDE_NAMES) {
    const color = ARM_COLORS[side];
    const { shoulder: s, elbow: e, wrist: wr } = POSE_SIDES[side];
    if (cfg.show_arm_trails) {
      for (const pid of [e, wr]) {
        const trail = pose.trails[pid] || [];
        for (let j = 1; j < trail.length; j++) {
          line(ctx, px(trail[j - 1][1], w, h), px(trail[j][1], w, h),
            withAlpha(color, 0.25 + (0.55 * j) / Math.max(1, trail.length - 1)), 2 * k);
        }
      }
    }
    for (const [a, b] of [[s, e], [e, wr]]) {
      if (valid[a] && valid[b]) {
        line(ctx, pts[a], pts[b], "rgba(15,20,25,0.9)", 7 * k);
        line(ctx, pts[a], pts[b], color, 4 * k);
      }
    }
    const names = { shoulder: "bahu", elbow: "siku", wrist: "pergelangan" };
    for (const [name, pid] of [["shoulder", s], ["elbow", e], ["wrist", wr]]) {
      if (!valid[pid]) continue;
      dot(ctx, pts[pid], 6 * k, color, "rgba(20,20,20,0.95)");
      if (cfg.show_arm_labels) {
        const tx = Math.max(3 * k, Math.min(pts[pid][0] + 10 * k, w - 110 * k));
        const ty = Math.max(18 * k, Math.min(pts[pid][1] - 10 * k, h - 12 * k));
        outlinedText(ctx, `${names[name]} ${SIDE_ID[side]}`, tx, ty, 11 * k, color, 500);
      }
    }
    if (valid[s] && valid[e] && valid[wr]) {
      const ax = pts[s][0] - pts[e][0], ay = pts[s][1] - pts[e][1];
      const bx = pts[wr][0] - pts[e][0], by = pts[wr][1] - pts[e][1];
      const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
      if (Math.min(la, lb) > 6 * k) {
        const start = Math.atan2(ay, ax) * 180 / Math.PI;
        const end = Math.atan2(by, bx) * 180 / Math.PI;
        const delta = ((((end - start + 180) % 360) + 360) % 360) - 180;
        const lo = Math.min(start, start + delta), hi = Math.max(start, start + delta);
        const r = Math.min(Math.max(Math.min(la, lb) * 0.28, 10 * k), 28 * k);
        ctx.strokeStyle = color;
        ctx.lineWidth = 2 * k;
        ctx.beginPath();
        ctx.arc(pts[e][0], pts[e][1], r, lo * Math.PI / 180, hi * Math.PI / 180);
        ctx.stroke();
        const angle = pose.arms[side].elbow_included_2d_deg;
        const tx = Math.max(3 * k, Math.min(pts[e][0] - 18 * k, w - 80 * k));
        const ty = Math.max(20 * k, Math.min(pts[e][1] + 34 * k, h - 8 * k));
        outlinedText(ctx, `${fmt(angle)}°`, tx, ty, 15 * k, color, 700);
      }
    }
  }
  if (cfg.show_wrist_links) {
    for (const l of links) dashed(ctx, px(l.pose_wrist, w, h), px(l.hand_wrist, w, h), LINK_COLOR, 2 * k, k);
  }
}

/**
 * Gambar satu frame overlay di atas gambar kamera yang sudah ada di kanvas.
 * @param {CanvasRenderingContext2D} ctx kanvas tampilan
 */
export function drawOverlay(ctx, s) {
  const { width: w, height: h } = ctx.canvas;
  const k = Math.max(1, Math.min(w, h) / 480);
  if (s.drawingLayer) ctx.drawImage(s.drawingLayer, 0, 0, w, h);
  drawPose(ctx, s.pose, s.links || [], s.cfg, w, h, k);
  for (const tr of s.tracks) drawHand(ctx, tr, s.cfg, s.t, w, h, k);

  // HUD kecil di kiri atas (ikut terekam di video).
  const hud = `${s.fps.toFixed(1)} fps   tangan ${s.timing.hands_ms.toFixed(0)} ms   pose ${s.timing.pose_ms.toFixed(0)} ms`;
  outlinedText(ctx, hud, 10 * k, 20 * k, 12 * k, "rgba(237,241,245,0.92)", 500);
  if (s.bimanual && s.bimanual.active) {
    outlinedText(ctx, `Dua tangan pinch: skala ×${s.bimanual.scale.toFixed(2)}, rotasi ${s.bimanual.rotation_deg.toFixed(0)}°`,
      10 * k, 38 * k, 12 * k, PINCH_COLOR, 600);
  }
  if (s.health && s.health.near_black) {
    ctx.fillStyle = "rgba(160,30,40,0.85)";
    ctx.fillRect(0, h - 40 * k, w, 40 * k);
    outlinedText(ctx, "Gambar kamera hampir hitam: cek penutup lensa dan cahaya", 12 * k, h - 15 * k, 13 * k, "#ffffff", 600);
  }
  if (s.recording) {
    ctx.fillStyle = "rgb(229,72,77)";
    ctx.beginPath(); ctx.arc(w - 18 * k, 18 * k, 7 * k, 0, Math.PI * 2); ctx.fill();
  }
}

/** Latar mode demo: kisi gelap pengganti gambar kamera. */
export function drawDemoBackground(ctx) {
  const { width: w, height: h } = ctx.canvas;
  ctx.fillStyle = "#1E2833";
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = "rgba(255,255,255,0.05)";
  ctx.lineWidth = 1;
  const step = Math.round(Math.min(w, h) / 12);
  for (let x = 0; x < w; x += step) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
  for (let y = 0; y < h; y += step) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
}

/** Sparkline sudut siku 8 detik terakhir, dengan garis ambang tekuk/lurus. */
export function drawSparkline(canvas, history, color, bent, straight) {
  const ctx = canvas.getContext("2d");
  const dpr = globalThis.devicePixelRatio || 1;
  const cw = canvas.clientWidth || 200, ch = canvas.clientHeight || 40;
  if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cw, ch);
  const y = (v) => ch - (Math.min(Math.max(v, 0), 180) / 180) * ch;
  ctx.strokeStyle = "rgba(147,162,177,0.35)";
  ctx.setLineDash([3, 3]);
  for (const v of [bent, straight]) { ctx.beginPath(); ctx.moveTo(0, y(v)); ctx.lineTo(cw, y(v)); ctx.stroke(); }
  ctx.setLineDash([]);
  if (!history || history.length < 2) return;
  const last = history[history.length - 1][0];
  const span = Math.max(Math.min(last, 8), 0.1);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  let prev = null;
  for (const [t, v] of history) {
    if (!Number.isFinite(v)) { prev = null; continue; }
    const p = [Math.min(Math.max((cw * (t - Math.max(0, last - 8))) / span, 0), cw), y(v)];
    if (prev && t - prev[0] <= 0.35) {
      ctx.beginPath(); ctx.moveTo(prev[1][0], prev[1][1]); ctx.lineTo(p[0], p[1]); ctx.stroke();
    }
    prev = [t, p];
  }
}
