/*
 * viewer3d.js — tampilan 3D ringan (pengganti show_hand_3d / show_pose_3d di notebook).
 * Proyeksi ortografis, geser dengan jari/mouse untuk memutar. Koordinat world tangan
 * dan pose TIDAK digabung (asal koordinatnya berbeda), jadi ditampilkan bergantian.
 */
import { FINGER_IDS, FINGER_NAMES, PALM_CONNECTIONS, POSE_SIDES, SIDE_NAMES } from "./core.js";
import { FINGER_COLORS, ARM_COLORS } from "./draw.js";

const UPPER_BODY = [[11, 12], [11, 23], [12, 24], [23, 24]];

export class Viewer3D {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.yaw = -0.6;
    this.pitch = 0.35;
    this.mode = "hand";
    let drag = null;
    canvas.addEventListener("pointerdown", (e) => { drag = [e.clientX, e.clientY]; canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener("pointermove", (e) => {
      if (!drag) return;
      this.yaw += (e.clientX - drag[0]) * 0.01;
      this.pitch = Math.max(-1.4, Math.min(1.4, this.pitch + (e.clientY - drag[1]) * 0.01));
      drag = [e.clientX, e.clientY];
      if (this.lastArgs) this.render(...this.lastArgs);
    });
    const end = () => { drag = null; };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
  }

  project(p, center, scale, w, h) {
    const x = p[0] - center[0], y = p[1] - center[1], z = p[2] - center[2];
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw), cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const x1 = cy * x + sy * z, z1 = -sy * x + cy * z;
    const y2 = cp * y - sp * z1;
    return [w / 2 + x1 * scale, h / 2 + y2 * scale];
  }

  render(hand, pose) {
    this.lastArgs = [hand, pose];
    const dpr = globalThis.devicePixelRatio || 1;
    const cw = this.canvas.clientWidth || 300, ch = this.canvas.clientHeight || 220;
    if (this.canvas.width !== Math.round(cw * dpr)) { this.canvas.width = Math.round(cw * dpr); this.canvas.height = Math.round(ch * dpr); }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    ctx.lineCap = "round";
    let pts = null, segments = [], center = [0, 0, 0];
    if (this.mode === "hand" && hand) {
      pts = hand.world;
      center = pts[0];
      for (const [a, b] of PALM_CONNECTIONS) segments.push([a, b, "rgba(230,225,220,0.9)"]);
      for (const n of FINGER_NAMES) {
        const c = FINGER_IDS[n];
        for (let j = 0; j < 3; j++) segments.push([c[j], c[j + 1], FINGER_COLORS[n]]);
      }
    } else if (this.mode === "body" && pose) {
      pts = pose.world;
      const used = [11, 12, 13, 14, 15, 16, 23, 24].filter((i) => pose.valid[i]);
      if (used.length) center = [0, 1, 2].map((d) => used.reduce((s, i) => s + pts[i][d], 0) / used.length);
      for (const [a, b] of UPPER_BODY) if (pose.valid[a] && pose.valid[b]) segments.push([a, b, "rgba(150,162,175,0.9)"]);
      for (const side of SIDE_NAMES) {
        const { shoulder: s, elbow: e, wrist: w } = POSE_SIDES[side];
        for (const [a, b] of [[s, e], [e, w]]) if (pose.valid[a] && pose.valid[b]) segments.push([a, b, ARM_COLORS[side]]);
      }
    }
    if (!pts || !segments.length) {
      ctx.fillStyle = "rgba(147,162,177,0.9)";
      ctx.font = "500 13px Archivo, system-ui, sans-serif";
      ctx.fillText(this.mode === "hand" ? "Belum ada tangan terdeteksi." : "Belum ada bahu/lengan terdeteksi.", 12, 24);
      return;
    }
    const idx = [...new Set(segments.flatMap(([a, b]) => [a, b]))];
    const extent = Math.max(...idx.map((i) => Math.hypot(pts[i][0] - center[0], pts[i][1] - center[1], pts[i][2] - center[2])), 1e-6);
    const scale = (Math.min(cw, ch) * 0.42) / extent;
    for (const [a, b, color] of segments) {
      const pa = this.project(pts[a], center, scale, cw, ch), pb = this.project(pts[b], center, scale, cw, ch);
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(pa[0], pa[1]); ctx.lineTo(pb[0], pb[1]); ctx.stroke();
    }
    ctx.fillStyle = "rgba(147,162,177,0.9)";
    ctx.font = "500 11px Archivo, system-ui, sans-serif";
    ctx.fillText(this.mode === "hand" ? `H${hand.id}: koordinat model, berpusat di pergelangan` : "Tubuh atas: koordinat model, berpusat di pinggul",
      10, ch - 10);
  }
}
