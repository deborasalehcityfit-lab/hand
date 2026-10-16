/*
 * Uji unit tanpa kamera (jalankan: npm test  atau  node tests/core.test.mjs).
 * Bagian pertama menyalin "Camera-free checks" dan "Arm/camera guardrail checks"
 * dari notebook; sisanya menguji hal khusus versi web.
 */
import assert from "node:assert/strict";
import {
  jointAngle, OneEuroFilter, StableLabel, validateConfig, makeConfig, MultiHandTracker,
  frameHealth, poseValidMask, ArmCycleCounter, associateHandsWithArms, effectiveSwaps,
  pyMod, MotionPipeline,
} from "../js/core.js";
import { pyFloat, formatCell, crc32Update, ZipEntryStream, buildZip, SessionLog } from "../js/recorder.js";
import { SyntheticScene } from "../js/demo.js";

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; console.log(`ok  - ${name}`); }
  catch (e) { console.error(`GAGAL - ${name}\n${e.stack}`); process.exitCode = 1; }
};

/* --- salinan cek notebook --- */
test("joint_angle 180 / 90 / NaN", () => {
  assert.ok(Math.abs(jointAngle([-1, 0, 0], [0, 0, 0], [1, 0, 0]) - 180) < 1e-6);
  assert.ok(Math.abs(jointAngle([1, 0, 0], [0, 0, 0], [0, 1, 0]) - 90) < 1e-6);
  assert.ok(Number.isNaN(jointAngle([0, 0, 0], [0, 0, 0], [1, 1, 1])));
});
test("OneEuroFilter konstan tetap konstan", () => {
  const f = new OneEuroFilter();
  for (let i = 0; i < 15; i++) {
    const out = f.filter(new Float64Array(63).fill(0.25), (0.5 * i) / 14);
    assert.ok(out.every((v) => Math.abs(v - 0.25) < 1e-12));
  }
});
test("StableLabel menahan label 0.18 s", () => {
  const s = new StableLabel(0.18);
  assert.equal(s.update("FIST", 0.0), "...");
  assert.equal(s.update("FIST", 0.2), "FIST");
});
test("validate_config default lolos & tracker kosong", () => {
  validateConfig(makeConfig());
  assert.deepEqual(new MultiHandTracker(makeConfig()).update([], 0.0, 640, 480), []);
});
test("frame_health mendeteksi frame hitam", () => {
  const black = new Uint8ClampedArray(40 * 40 * 4);
  const gray = new Uint8ClampedArray(40 * 40 * 4).fill(100);
  assert.ok(frameHealth(black).near_black);
  assert.ok(!frameHealth(gray).near_black);
});
test("pose_valid_mask menolak titik di luar frame", () => {
  const pts = Array.from({ length: 33 }, () => [0.5, 0.5, 0]);
  const q = new Array(33).fill(1);
  assert.ok(poseValidMask(pts, q, q, 0.55).every(Boolean));
  pts[13][0] = 1.2;
  assert.ok(!poseValidMask(pts, q, q, 0.55)[13]);
});
test("ArmCycleCounter menghitung satu siklus", () => {
  const c = new ArmCycleCounter(75, 155, 0.20);
  for (const [t, a] of [[0, 170], [0.21, 170], [0.25, 60], [0.46, 60], [0.50, 170], [0.71, 170]]) c.update(a, t);
  assert.equal(c.count, 1);
  assert.deepEqual(associateHandsWithArms(null, [], makeConfig(), 640, 480), []);
});

/* --- khusus web --- */
test("validate_config menolak nilai salah", () => {
  assert.throws(() => validateConfig(makeConfig({ pinch_on: 0.5, pinch_off: 0.4 })));
  assert.throws(() => validateConfig(makeConfig({ num_hands: 3 })));
  assert.throws(() => validateConfig(makeConfig({ rep_bent: 160 })));
});
test("effectiveSwaps: mirror otomatis + kalibrasi", () => {
  const cfg = makeConfig();
  assert.deepEqual(effectiveSwaps(cfg, true), { swapHands: false, swapPose: true });
  assert.deepEqual(effectiveSwaps(cfg, false), { swapHands: true, swapPose: false });
  assert.deepEqual(effectiveSwaps(cfg, true, { hands: true, pose: true }), { swapHands: true, swapPose: false });
  assert.deepEqual(effectiveSwaps(makeConfig({ swap_handedness: true }), true), { swapHands: true, swapPose: true });
});
test("pyMod mengikuti Python", () => {
  assert.equal(pyMod(-30, 360), 330);
  assert.equal(pyMod(370, 360), 10);
  assert.equal(pyMod(-360, 360), 0);
});
test("pyFloat sama dengan repr() Python", () => {
  const cases = [[0, "0.0"], [1, "1.0"], [100, "100.0"], [0.1, "0.1"], [123.456, "123.456"],
    [0.0001, "0.0001"], [0.00001, "1e-05"], [1.5e-7, "1.5e-07"], [-2.5, "-2.5"], [1e16, "1e+16"],
    [1e15, "1000000000000000.0"], [12345678.9, "12345678.9"], [-0.000123, "-0.000123"]];
  for (const [v, s] of cases) assert.equal(pyFloat(v), s, `pyFloat(${v})`);
  assert.equal(formatCell(NaN, "f"), "");
  assert.equal(formatCell(true, "b"), "True");
  assert.equal(formatCell(null, "i"), "");
  assert.equal(formatCell("a,b", "s"), '"a,b"');
});
test("CRC32 vektor standar", () => {
  assert.equal(crc32Update(0, new TextEncoder().encode("123456789")), 0xcbf43926);
});
test("ZIP: struktur dasar valid", async () => {
  const e = new ZipEntryStream("a.txt");
  e.write("halo\r\n");
  const blob = buildZip([e]);
  assert.ok(blob.size > 30 + 5 + 6 + 46 + 22);
});
test("Pipeline demo: dua tangan, pose, tautan, CSV", () => {
  const cfg = makeConfig({ save_csv: true });
  const scene = new SyntheticScene({ seed: 3 });
  const pipe = new MotionPipeline(cfg);
  const log = new SessionLog(cfg);
  let linked = 0;
  for (let i = 0; i < 90; i++) {
    const t = i / 30;
    const fr = scene.frame(t, 640, 480);
    const r = pipe.step({ handResult: fr.hand, poseResult: fr.pose, t, width: 640, height: 480 });
    linked += r.links.length;
    log.logAll(i, t, 640, 480, r.tracks, 30, 10, r.bimanual, r.pose, r.links, { hands_ms: 5, pose_ms: 5 });
  }
  assert.ok(linked > 150, `tautan pergelangan terlalu sedikit: ${linked}`);
  assert.ok(log.rowCounts.hands > 40 && log.rowCounts.pose_landmarks > 600);
});

console.log(`\n${passed} uji lolos${process.exitCode ? ", ADA YANG GAGAL" : ""}.`);
