/*
 * Uji paritas Python ↔ JavaScript.
 *
 * 1) Membuat fixture sintetis yang "sulit" (tangan hilang, label terbalik, pose hilang,
 *    lompatan pose, celah waktu, ganti resolusi, pinch dua tangan, asosiasi ambigu).
 * 2) Menjalankan KODE ASLI notebook (py_reference.py) pada fixture itu.
 * 3) Menjalankan core.js + recorder.js pada fixture yang sama.
 * 4) Membandingkan output per frame dan seluruh CSV (compare_csv.py).
 *
 * Pemakaian:
 *   node tests/parity/run_parity.mjs --notebook "path/ke/Arm_Hand_Finger_Tracking (2).ipynb"
 *   (opsional: --python python3 --out folder_hasil)
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

import { MotionPipeline, makeConfig, FINGER_NAMES } from "../../js/core.js";
import { SessionLog } from "../../js/recorder.js";
import { SyntheticScene } from "../../js/demo.js";

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : "1"]);
  return acc;
}, []));
const notebook = args.notebook || process.env.NOTEBOOK;
if (!notebook || !existsSync(notebook)) {
  console.error("Beri path notebook: --notebook \"Arm_Hand_Finger_Tracking (2).ipynb\"");
  process.exit(2);
}
const python = args.python || process.env.PYTHON || "python3";
const outRoot = resolve(args.out || join(tmpdir(), "ahml-parity"));
mkdirSync(outRoot, { recursive: true });

/* ---------- 1. fixture ---------- */
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let r = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
const scene = new SyntheticScene({ seed: 7, stress: true });
const rand = mulberry32(42);
const frames = [];
let t = 0;
let gap1 = false, gap2 = false;
while (t < 18.5) {
  const [width, height] = t < 17.0 ? [640, 480] : [480, 640];
  const fr = scene.frame(t, width, height);
  frames.push({
    t, width, height, hand: fr.hand, pose: fr.pose,
    fps: 25 + 5 * Math.sin(t), hands_ms: 8 + 2 * Math.cos(t), pose_ms: 6 + Math.sin(2 * t),
    inference_ms: 8 + 2 * Math.cos(t) + 6 + Math.sin(2 * t),
  });
  t += 0.028 + 0.012 * rand();
  if (!gap1 && t > 5.8) { t += 0.30; gap1 = true; }   // celah proses > 0.25 s
  if (!gap2 && t > 12.0) { t += 0.45; gap2 = true; }
}
const fixturePath = join(outRoot, "fixture.json");
writeFileSync(fixturePath, JSON.stringify({ frames }));
console.log(`Fixture: ${frames.length} frame (${(JSON.stringify({ frames }).length / 1e6).toFixed(1)} MB)`);

/* ---------- 2–4. jalankan & bandingkan ---------- */
const cleanJs = (v) => {
  if (v instanceof Float64Array) return Array.from(v, cleanJs);
  if (Array.isArray(v)) return v.map(cleanJs);
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cleanJs(x)]));
  return v;
};
const FINGER_KEYS = ["mcp_deg", "pip_deg", "dip_deg", "ip_deg", "bend_deg", "curl_percent",
  "extended", "tip_speed_px_s", "angular_speed_deg_s"];

function runJs(swapHands, swapPose, zipPath) {
  const cfg = makeConfig({ save_csv: true, swap_handedness: swapHands, swap_pose_sides: swapPose });
  const log = new SessionLog(cfg);
  let pipeline = null, shape = null;
  const outputs = frames.map((fr, frameId) => {
    if (shape !== `${fr.width}x${fr.height}`) { pipeline = new MotionPipeline(cfg); shape = `${fr.width}x${fr.height}`; }
    const r = pipeline.step({ handResult: fr.hand, poseResult: fr.pose, t: fr.t, width: fr.width,
      height: fr.height, swapHands, swapPose });
    log.logAll(frameId, fr.t, fr.width, fr.height, r.tracks, fr.fps, fr.inference_ms, r.bimanual, r.pose,
      r.links, { hands_ms: fr.hands_ms, pose_ms: fr.pose_ms });
    return cleanJs({
      frame_id: frameId, t: fr.t,
      tracks: r.tracks.map((tr) => ({
        id: tr.id, handedness: tr.handedness, raw_handedness: tr.rawHandedness, score: tr.handednessScore,
        gesture: tr.gesture, raw_gesture: tr.rawGesture, pinch: tr.pinch, events: tr.events,
        palm_speed: tr.palmSpeedPxS, palm_size: tr.metrics.palm_size_model_m, pinch_ratio: tr.metrics.pinch_ratio,
        finger_count: tr.metrics.finger_count,
        fingers: Object.fromEntries(FINGER_NAMES.map((n) => [n,
          Object.fromEntries(FINGER_KEYS.map((k) => [k, tr.metrics.fingers[n][k]]))])),
        points: tr.points, world: tr.world, speed: tr.speedPxS, rel_speed: tr.relativeSpeedPxS, motion: tr.motionXY,
      })),
      pose: r.pose === null ? null : {
        epoch: r.pose.pose_epoch, valid: r.pose.valid, points: r.pose.points, world: r.pose.world,
        speed: r.pose.speed_px_s, arms: r.pose.arms, events: r.pose.events,
      },
      links: r.links.map((l) => ({ side: l.side, track_id: l.track_id, distance_px: l.distance_px })),
      bimanual: r.bimanual,
    });
  });
  return { outputs, log, zipPath };
}

function compare(expected, actual) {
  const mismatches = [];
  let numbers = 0, maxRel = 0;
  const walk = (e, a, path) => {
    if (mismatches.length > 25) return;
    if (e === null || a === null || typeof e !== "object" || typeof a !== "object") {
      if (typeof e === "number" && typeof a === "number") {
        numbers += 1;
        const rel = Math.abs(e - a) / Math.max(1, Math.abs(e), Math.abs(a));
        maxRel = Math.max(maxRel, rel);
        if (rel > 1e-6) mismatches.push(`${path}: Python=${e} JS=${a}`);
      } else if (e !== a) {
        mismatches.push(`${path}: Python=${JSON.stringify(e)} JS=${JSON.stringify(a)}`);
      }
      return;
    }
    if (Array.isArray(e) !== Array.isArray(a)) { mismatches.push(`${path}: tipe berbeda`); return; }
    const keys = new Set([...Object.keys(e), ...Object.keys(a)]);
    for (const k of keys) {
      if (!(k in e) || !(k in a)) { mismatches.push(`${path}.${k}: hanya ada di ${k in e ? "Python" : "JS"}`); continue; }
      walk(e[k], a[k], `${path}.${k}`);
    }
  };
  if (expected.length !== actual.length) mismatches.push(`jumlah frame ${expected.length} vs ${actual.length}`);
  for (let i = 0; i < Math.min(expected.length, actual.length); i++) walk(expected[i], actual[i], `frame[${i}]`);
  return { mismatches, numbers, maxRel };
}

let failed = false;
const coverage = { events: new Set(), gestures: new Set(), epochs: new Set(), maxTrackId: 0, linksAmbiguousFrames: 0,
  reps: 0, bimanualFrames: 0 };
for (const [label, swapHands, swapPose] of [["tanpa-tukar", false, false], ["tukar-sisi", true, true]]) {
  const dir = join(outRoot, label);
  mkdirSync(dir, { recursive: true });
  const py = spawnSync(python, [join(here, "py_reference.py"), "--notebook", notebook, "--fixture", fixturePath,
    "--out", dir, ...(swapHands ? ["--swap-hands"] : []), ...(swapPose ? ["--swap-pose"] : [])],
  { encoding: "utf-8" });
  if (py.status !== 0) { console.error(py.stdout, py.stderr); process.exit(1); }
  const expected = JSON.parse(readFileSync(join(dir, "expected.json"), "utf-8")).outputs;
  const zipPath = join(dir, "sesi_js.zip");
  const { outputs, log } = runJs(swapHands, swapPose, zipPath);
  const blob = log.finalize({ summary: { frames: frames.length } });
  writeFileSync(zipPath, Buffer.from(await blob.arrayBuffer()));
  const res = compare(expected, outputs);
  console.log(`\n[${label}] ${res.numbers} angka dibandingkan, selisih relatif maks ${res.maxRel.toExponential(2)}`);
  if (res.mismatches.length) { failed = true; console.log("BEDA:\n  " + res.mismatches.slice(0, 25).join("\n  ")); }
  else console.log("Output per frame identik (dalam toleransi 1e-6).");
  const pyDir = readFileSync(join(dir, "py_csv_folder.txt"), "utf-8").trim();
  const csvRes = spawnSync(python, [join(here, "compare_csv.py"), "--zip", zipPath, "--pydir", pyDir], { encoding: "utf-8" });
  console.log(csvRes.stdout.trimEnd());
  if (csvRes.status !== 0) { failed = true; console.log(csvRes.stderr); }
  for (const o of outputs) {
    for (const tr of o.tracks) {
      tr.events.forEach((e) => coverage.events.add(e));
      coverage.gestures.add(tr.gesture);
      coverage.maxTrackId = Math.max(coverage.maxTrackId, tr.id);
    }
    if (o.pose) { coverage.epochs.add(o.pose.epoch); o.pose.events.forEach(() => { coverage.reps += 1; }); }
    if (o.pose && o.tracks.length && o.links.length < o.tracks.length) coverage.linksAmbiguousFrames += 1;
    if (o.bimanual.active) coverage.bimanualFrames += 1;
  }
}
console.log("\nCakupan skenario:", {
  events: [...coverage.events], gestures: [...coverage.gestures], pose_epochs: [...coverage.epochs],
  max_track_id: coverage.maxTrackId, frames_with_unmatched_hand: coverage.linksAmbiguousFrames,
  elbow_cycles: coverage.reps, bimanual_frames: coverage.bimanualFrames,
});
console.log(failed ? "\nHASIL: ADA PERBEDAAN" : "\nHASIL: PARITAS OK");
process.exit(failed ? 1 : 0);
