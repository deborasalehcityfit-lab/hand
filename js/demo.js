/*
 * demo.js — adegan sintetis (tubuh + dua tangan beranimasi) dalam bentuk hasil
 * MediaPipe Tasks versi Web. Dipakai untuk:
 *   - Mode demo tanpa kamera (buka index.html?demo=1)
 *   - Uji paritas Python ↔ JavaScript (tests/parity), dengan opsi stress=true
 *
 * frame(t, width, height) adalah fungsi murni dari waktu: tidak ada state tersembunyi.
 * Konvensi: gambar dianggap SUDAH di-mirror (seperti kamera depan). Sisi pose "left"
 * diletakkan di kanan gambar, dan tangan di lengan itu berlabel "Right".
 */

const TAU = Math.PI * 2;

/** Noise deterministik dalam [-1, 1] dari (seed, i, k, t). */
function noise(seed, i, k, t) {
  let h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b);
  h ^= Math.imul(i + 1, 0xc2b2ae35);
  h ^= Math.imul(k + 7, 0x27d4eb2f);
  h ^= Math.imul(Math.round(t * 1000) + 13, 0x165667b1);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12; h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return ((h >>> 0) / 4294967295) * 2 - 1;
}

const smooth01 = (x) => { const c = Math.min(Math.max(x, 0), 1); return c * c * (3 - 2 * c); };
const inWin = (t, a, b) => t >= a && t < b;
const dir = (deg) => [Math.cos(deg * Math.PI / 180), Math.sin(deg * Math.PI / 180)];

// Konfigurasi tekukan (derajat) per jari: [mcp, pip, dip]; ibu jari: [flex] tunggal.
const POSES = {
  open: { thumb: 0, f: [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]] },
  fist: { thumb: 55, f: [[70, 95, 60], [72, 98, 62], [74, 96, 60], [72, 94, 58]] },
  point: { thumb: 55, f: [[0, 0, 0], [72, 98, 62], [74, 96, 60], [72, 94, 58]] },
  peace: { thumb: 55, f: [[0, 0, 0], [0, 0, 0], [74, 96, 60], [72, 94, 58]] },
  thumb: { thumb: 0, f: [[70, 95, 60], [72, 98, 62], [74, 96, 60], [72, 94, 58]] },
  three: { thumb: 55, f: [[0, 0, 0], [0, 0, 0], [0, 0, 0], [72, 94, 58]] },
  ok: { thumb: 20, f: [[22, 25, 12], [0, 0, 0], [0, 0, 0], [0, 0, 0]], pinch: true },
};
const SEQUENCE = ["open", "fist", "point", "peace", "thumb", "three", "ok"];
const STEP = 1.6, BLEND = 0.35;

// Model tangan lokal (satuan = panjang telapak). a = maju, b = lateral (dikali `side`).
const MCP_LOCAL = [[1.0, 0.30], [1.02, 0.10], [0.98, -0.10], [0.90, -0.28]];
const SEG_LEN = [[0.42, 0.25, 0.20], [0.46, 0.28, 0.21], [0.43, 0.26, 0.20], [0.34, 0.20, 0.18]];
const THUMB_LOCAL = [[0.22, 0.30], [0.40, 0.58], [0.55, 0.80], [0.68, 0.98]]; // cmc, mcp, ip, tip

function gestureAt(t, phase, forceOpen) {
  if (forceOpen) return { ...POSES.open, pinchWeight: 0 };
  const u = (t + phase) / STEP;
  const k = Math.floor(u);
  const frac = u - k;
  const a = POSES[SEQUENCE[((k % SEQUENCE.length) + SEQUENCE.length) % SEQUENCE.length]];
  const b = POSES[SEQUENCE[(((k + 1) % SEQUENCE.length) + SEQUENCE.length) % SEQUENCE.length]];
  const w = smooth01((frac - (1 - BLEND / STEP)) / (BLEND / STEP));
  const mix = (x, y) => x + (y - x) * w;
  return {
    thumb: mix(a.thumb, b.thumb),
    f: a.f.map((row, i) => row.map((v, j) => mix(v, b.f[i][j]))),
    pinchWeight: mix(a.pinch ? 1 : 0, b.pinch ? 1 : 0),
  };
}

/** Bangun 21 titik tangan lokal (a, b, c) dalam satuan panjang telapak. */
function buildHandLocal(g, side, forcePinch) {
  const pts = new Array(21);
  pts[0] = [0, 0, 0];
  // Jari 2..5
  for (let f = 0; f < 4; f++) {
    const [ma, mb] = MCP_LOCAL[f];
    const base = [ma, mb * side, 0];
    const len = Math.hypot(ma, mb);
    const d0 = [ma / len, (mb * side) / len, 0];
    let theta = 0;
    let p = base;
    const ids = [5 + 4 * f, 6 + 4 * f, 7 + 4 * f, 8 + 4 * f];
    pts[ids[0]] = base.slice();
    for (let s = 0; s < 3; s++) {
      theta += g.f[f][s] * Math.PI / 180;
      const d = [Math.cos(theta) * d0[0], Math.cos(theta) * d0[1], -Math.sin(theta)];
      p = [p[0] + SEG_LEN[f][s] * d[0], p[1] + SEG_LEN[f][s] * d[1], p[2] + SEG_LEN[f][s] * d[2]];
      pts[ids[s + 1]] = p;
    }
  }
  // Ibu jari 1..4: cmc tetap, segmen berikutnya menekuk ke arah telapak.
  const tl = THUMB_LOCAL.map(([a, b]) => [a, b * side, 0]);
  pts[1] = tl[0];
  pts[2] = tl[1];
  const flex = g.thumb * Math.PI / 180;
  const inward = [0.35, -0.55 * side, -0.75];
  let p = tl[1];
  for (let s = 0; s < 2; s++) {
    const seg = [tl[s + 2][0] - tl[s + 1][0], tl[s + 2][1] - tl[s + 1][1], 0];
    const L = Math.hypot(seg[0], seg[1]);
    const d = [seg[0] / L, seg[1] / L, 0];
    const th = flex * (s + 1) * 0.6;
    const n = Math.hypot(inward[0], inward[1], inward[2]);
    const v = [
      Math.cos(th) * d[0] + Math.sin(th) * inward[0] / n,
      Math.cos(th) * d[1] + Math.sin(th) * inward[1] / n,
      Math.cos(th) * d[2] + Math.sin(th) * inward[2] / n,
    ];
    const vn = Math.hypot(v[0], v[1], v[2]);
    p = [p[0] + L * v[0] / vn, p[1] + L * v[1] / vn, p[2] + L * v[2] / vn];
    pts[3 + s] = p;
  }
  const pinch = forcePinch || g.pinchWeight > 0.5;
  if (pinch) {
    const tip = pts[8];
    pts[4] = [tip[0] - 0.02, tip[1] + 0.025 * side, tip[2] - 0.01];
    pts[3] = [(pts[2][0] + pts[4][0]) / 2 + 0.05, (pts[2][1] + pts[4][1]) / 2 + 0.06 * side, pts[4][2] / 2];
  }
  return pts;
}

export class SyntheticScene {
  /**
   * @param {object} o
   * @param {number} o.seed  benih noise
   * @param {boolean} o.stress  aktifkan kejadian sulit (hilang, lompat, label terbalik, ambigu)
   */
  constructor({ seed = 7, stress = false, scale = 1 } = {}) {
    this.seed = seed;
    this.stress = stress;
    this.scale = scale; // angka, atau "auto" (lebih besar di layar potret)
  }

  frame(t, width = 640, height = 480) {
    const st = this.stress;
    const hIso = height / width;                 // tinggi gambar dalam satuan lebar
    const boost = this.scale === "auto" ? (hIso > 1 ? 1.45 : 1.1) : this.scale;
    const s = Math.min(1, hIso / 0.75) * boost;  // skala tubuh
    const jump = st && t >= 14.0 ? -0.34 : 0;
    const cx = 0.5 + 0.03 * Math.sin(0.4 * t) + jump;
    const shoulderY = 0.45 * hIso;
    const hipY = shoulderY + 0.30 * s;
    const L1 = 0.13 * s, L2 = 0.12 * s;

    const bothBent = st && inWin(t, 13.0, 13.4);
    const arm = (sideSign, period, phase) => {
      // sideSign +1 = lengan di kanan gambar (pose "left"), -1 = kiri gambar (pose "right")
      const shoulder = [cx + sideSign * 0.11 * s, shoulderY];
      const sway = 20 * Math.sin(TAU * t / (period * 1.7) + phase);
      const phi = 90 - sideSign * (25 + sway);
      const theta = bothBent ? 55 : 112 + 62 * Math.cos(TAU * t / period + phase);
      const elbow = [shoulder[0] + L1 * dir(phi)[0], shoulder[1] + L1 * dir(phi)[1]];
      const psi = sideSign > 0 ? phi + 180 - theta : phi + 180 + theta;
      const wrist = [elbow[0] + L2 * dir(psi)[0], elbow[1] + L2 * dir(psi)[1]];
      return { shoulder, elbow, wrist, psi, theta };
    };
    const armL = arm(+1, 3.2, 0.0);   // pose "left" (indeks 11/13/15)
    const armR = arm(-1, 4.1, 1.3);   // pose "right" (indeks 12/14/16)

    /* ---------------- Pose ---------------- */
    let pose = null;
    const poseMissing = st && (inWin(t, 6.0, 6.35) || inWin(t, 11.0, 11.9));
    if (!poseMissing) {
      const iso = new Array(33);
      const head = shoulderY - 0.17 * s;
      iso[0] = [cx, head];
      iso[1] = [cx + 0.02 * s, head - 0.02 * s]; iso[2] = [cx + 0.03 * s, head - 0.021 * s];
      iso[3] = [cx + 0.04 * s, head - 0.02 * s]; iso[4] = [cx - 0.02 * s, head - 0.02 * s];
      iso[5] = [cx - 0.03 * s, head - 0.021 * s]; iso[6] = [cx - 0.04 * s, head - 0.02 * s];
      iso[7] = [cx + 0.065 * s, head - 0.005 * s]; iso[8] = [cx - 0.065 * s, head - 0.005 * s];
      iso[9] = [cx + 0.025 * s, head + 0.03 * s]; iso[10] = [cx - 0.025 * s, head + 0.03 * s];
      iso[11] = armL.shoulder; iso[12] = armR.shoulder;
      iso[13] = armL.elbow; iso[14] = armR.elbow;
      iso[15] = armL.wrist; iso[16] = armR.wrist;
      const fingerish = (a, sign, offs) => offs.map(([ang, len]) => {
        const d = dir(a.psi + sign * ang);
        return [a.wrist[0] + len * s * d[0], a.wrist[1] + len * s * d[1]];
      });
      const fl = fingerish(armL, -1, [[20, 0.035], [-5, 0.04], [-35, 0.03]]);
      const fr = fingerish(armR, +1, [[20, 0.035], [-5, 0.04], [-35, 0.03]]);
      iso[17] = fl[0]; iso[18] = fr[0]; iso[19] = fl[1]; iso[20] = fr[1]; iso[21] = fl[2]; iso[22] = fr[2];
      iso[23] = [cx + 0.08 * s, hipY]; iso[24] = [cx - 0.08 * s, hipY];
      iso[25] = [cx + 0.085 * s, hipY + 0.32 * s]; iso[26] = [cx - 0.085 * s, hipY + 0.32 * s];
      iso[27] = [cx + 0.09 * s, hipY + 0.62 * s]; iso[28] = [cx - 0.09 * s, hipY + 0.62 * s];
      iso[29] = [cx + 0.095 * s, hipY + 0.66 * s]; iso[30] = [cx - 0.095 * s, hipY + 0.66 * s];
      iso[31] = [cx + 0.07 * s, hipY + 0.69 * s]; iso[32] = [cx - 0.07 * s, hipY + 0.69 * s];

      const hipC = [(iso[23][0] + iso[24][0]) / 2, (iso[23][1] + iso[24][1]) / 2];
      const depth = (i) => {
        if (i === 13 || i === 14) return -0.08;
        if (i >= 15 && i <= 22) return -0.12 - 0.05 * Math.sin(TAU * t / 3.5 + i);
        if (i <= 10) return -0.05;
        return 0.0;
      };
      const landmarks = [], world = [];
      for (let i = 0; i < 33; i++) {
        const [xi, yi] = iso[i];
        const x = xi + 0.0012 * noise(this.seed, i, 0, t);
        const y = yi / hIso + 0.0012 * noise(this.seed, i, 1, t);
        let vis = i <= 24 ? 0.97 : 0.35;
        if (st && i === 13 && inWin(t, 3.0, 3.6)) vis = 0.3;
        if (st && i === 16 && inWin(t, 8.2, 8.8)) vis = 0.3;
        const pres = i <= 24 ? 0.98 : 0.4;
        landmarks.push({ x, y, z: depth(i) * 0.5, visibility: vis, presence: pres });
        world.push({
          x: (xi - hipC[0]) * 1.6 + 0.002 * noise(this.seed, i, 2, t),
          y: (yi - hipC[1]) * 1.6 + 0.002 * noise(this.seed, i, 3, t),
          z: depth(i) + 0.002 * noise(this.seed, i, 4, t),
          visibility: vis, presence: pres,
        });
      }
      pose = { landmarks: [landmarks], worldLandmarks: [world] };
    }

    /* ---------------- Tangan ---------------- */
    const makeHand = (armInfo, side, label, phase, key) => {
      const forceOpen = st && key === "A" && inWin(t, 9.8, 10.5);
      const forcePinch = st && inWin(t, 15.0, 16.5);
      const g = gestureAt(t, phase, forceOpen);
      const local = buildHandLocal(g, side, forcePinch);
      const wob = 12 * Math.sin(TAU * t / 2.3 + phase);
      const f = dir(armInfo.psi + wob);
      const l = [-f[1], f[0]];
      const Lp = 0.065 * Math.max(s, 0.7);
      let wristIso = [armInfo.wrist[0] + 0.01 * f[0], armInfo.wrist[1] + 0.01 * f[1]];
      if (st && key === "A" && inWin(t, 10.0, 10.35)) wristIso[0] += 0.30 * smooth01((t - 10.0) / 0.3);
      if (st && key === "B" && inWin(t, 13.0, 13.4)) {
        wristIso = [(armL.wrist[0] + armR.wrist[0]) / 2, (armL.wrist[1] + armR.wrist[1]) / 2];
      }
      const center = [(local[0][0] + local[9][0]) / 2, (local[0][1] + local[9][1]) / 2, 0];
      const landmarks = [], world = [];
      for (let i = 0; i < 21; i++) {
        const [a, b, c] = local[i];
        const xi = wristIso[0] + Lp * (a * f[0] + b * l[0]);
        const yi = wristIso[1] + Lp * (a * f[1] + b * l[1]);
        landmarks.push({
          x: xi + 0.0015 * noise(this.seed + 11, i, 0, t),
          y: yi / hIso + 0.0015 * noise(this.seed + 11, i, 1, t),
          z: c * Lp * 0.9,
          visibility: 0,
        });
        const wa = (a - center[0]) * 0.085, wb = (b - center[1]) * 0.085;
        world.push({
          x: wa * f[0] + wb * l[0] + 0.0012 * noise(this.seed + 23, i, 2, t),
          y: wa * f[1] + wb * l[1] + 0.0012 * noise(this.seed + 23, i, 3, t),
          z: c * 0.085 + 0.0012 * noise(this.seed + 23, i, 4, t),
          visibility: 0,
        });
      }
      let category = [{ categoryName: label, displayName: "", score: 0.97, index: label === "Left" ? 0 : 1 }];
      if (st && key === "A" && inWin(t, 2.0, 2.25)) category = [{ ...category[0], categoryName: label === "Left" ? "Right" : "Left", score: 0.62 }];
      if (st && key === "A" && inWin(t, 7.0, 7.2)) category = [{ ...category[0], categoryName: label === "Left" ? "Right" : "Left", score: 0.93 }];
      if (st && key === "A" && inWin(t, 12.5, 12.7)) category = [];
      return { landmarks, world, category };
    };

    const hands = [];
    hands.push(makeHand(armL, +1, "Right", 0.0, "A"));
    const bMissing = st && (inWin(t, 4.5, 5.3) || inWin(t, 9.0, 9.3));
    if (!bMissing) hands.push(makeHand(armR, -1, "Left", 0.8, "B"));
    if (st && Math.floor(t / 0.7) % 2 === 1) hands.reverse();

    const hand = {
      landmarks: hands.map((h) => h.landmarks),
      worldLandmarks: hands.map((h) => h.world),
      handedness: hands.map((h) => h.category),
    };
    return { hand, pose };
  }
}
