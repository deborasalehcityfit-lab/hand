/*
 * recorder.js — perekam data sesi (CSV) dan pembuat ZIP, tanpa DOM.
 *
 * Port SessionFiles + ArmSessionFiles dari notebook:
 *   frames.csv, hands.csv, landmarks.csv, events.csv,
 *   pose_frames.csv, arms.csv, pose_landmarks.csv, arm_events.csv, session.json
 * Nama file, urutan kolom, dan format angka sengaja dibuat identik dengan CSV Python
 * (float ala repr Python, True/False, akhir baris \r\n) supaya fungsi plot_saved_arm()
 * dan plot_saved_bend() di notebook bisa langsung membaca data dari HP.
 *
 * Data disimpan bertahap sebagai potongan byte (bukan satu string raksasa) dan CRC32
 * dihitung sambil jalan, sehingga ZIP bisa dirakit tanpa membaca ulang semua data.
 */

import {
  APP_VERSION, FINGER_IDS, FINGER_NAMES, FINGER_METRICS, LANDMARK_NAMES,
  POSE_METRIC_FIELDS, POSE_NAMES,
} from "./core.js";

/* ------------------------------------------------------------------ */
/* Format nilai ala modul csv Python                                    */
/* ------------------------------------------------------------------ */

/** repr(float) Python: digit terpendek, notasi tetap untuk 1e-4 <= |x| < 1e16. */
export function pyFloat(v) {
  if (Number.isNaN(v)) return "nan";
  if (v === Infinity) return "inf";
  if (v === -Infinity) return "-inf";
  if (v === 0) return Object.is(v, -0) ? "-0.0" : "0.0";
  const [mant, expStr] = v.toExponential().split("e");
  const exp = parseInt(expStr, 10);
  const neg = mant.startsWith("-");
  const digits = mant.replace("-", "").replace(".", "");
  let body;
  if (exp >= -4 && exp < 16) {
    if (exp >= 0) {
      body = digits.length <= exp + 1
        ? `${digits}${"0".repeat(exp + 1 - digits.length)}.0`
        : `${digits.slice(0, exp + 1)}.${digits.slice(exp + 1)}`;
    } else {
      body = `0.${"0".repeat(-exp - 1)}${digits}`;
    }
  } else {
    const m = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    body = `${m}e${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(2, "0")}`;
  }
  return (neg ? "-" : "") + body;
}

function quoteIfNeeded(s) {
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * kind: "i" = int, "f" = float, "b" = bool, "s" = teks.
 * null/undefined/NaN/Infinity -> "" (seperti clean_row() di notebook).
 */
export function formatCell(value, kind) {
  if (value === null || value === undefined) return "";
  switch (kind) {
    case "f": {
      const v = Number(value);
      return Number.isFinite(v) ? pyFloat(v) : "";
    }
    case "i": {
      const v = Number(value);
      return Number.isFinite(v) ? String(Math.trunc(v)) : "";
    }
    case "b":
      return value ? "True" : "False";
    default:
      return quoteIfNeeded(String(value));
  }
}

/* ------------------------------------------------------------------ */
/* Skema CSV (urutan kolom = notebook)                                  */
/* ------------------------------------------------------------------ */

const FINGER_METRIC_KINDS = {
  mcp_deg: "f", pip_deg: "f", dip_deg: "f", ip_deg: "f", bend_deg: "f", curl_percent: "f",
  extended: "b", tip_speed_px_s: "f", angular_speed_deg_s: "f",
};
const XYZ = ["x", "y", "z"];

export const CSV_SCHEMAS = {
  frames: [["frame_id", "i"], ["time_s", "f"], ["width", "i"], ["height", "i"], ["hand_count", "i"],
    ["processed_fps", "f"], ["inference_ms", "f"], ["bimanual_active", "b"], ["bimanual_scale", "f"],
    ["bimanual_rotation_deg", "f"]],
  hands: [["frame_id", "i"], ["time_s", "f"], ["track_id", "i"], ["handedness", "s"],
    ["raw_handedness", "s"], ["handedness_score", "f"], ["gesture", "s"], ["raw_gesture", "s"],
    ["finger_count", "i"], ["pinch_active", "b"], ["pinch_ratio", "f"], ["palm_speed_px_s", "f"],
    ...FINGER_NAMES.flatMap((n) => FINGER_METRICS.map((m) => [`${n.toLowerCase()}_${m}`, FINGER_METRIC_KINDS[m]]))],
  landmarks: [["frame_id", "i"], ["time_s", "f"], ["track_id", "i"], ["landmark_id", "i"], ["landmark_name", "s"],
    ...["raw_image", "smooth_image", "raw_world", "smooth_world"].flatMap((prefix) => XYZ.map((a) => [
      `${prefix}_${a}${prefix.includes("world") ? "_model_m" : ""}`, "f"])),
    ["image_speed_px_s", "f"], ["wrist_relative_image_speed_px_s", "f"]],
  events: [["frame_id", "i"], ["time_s", "f"], ["track_id", "i"], ["event", "s"]],
  pose_frames: [["frame_id", "i"], ["time_s", "f"], ["pose_detected", "b"], ["pose_epoch", "i"],
    ["valid_landmarks", "i"], ["hands_ms", "f"], ["pose_ms", "f"], ["wrist_links", "i"]],
  arms: [["frame_id", "i"], ["time_s", "f"], ["pose_epoch", "i"], ["side", "s"], ["arm_visible", "b"],
    ["matched_hand_id", "i"], ["association_distance_px", "f"], ["raised_2d", "b"], ["rep_count", "i"],
    ["rep_phase", "s"], ...POSE_METRIC_FIELDS.map((f) => [f, "f"])],
  pose_landmarks: [["frame_id", "i"], ["time_s", "f"], ["pose_epoch", "i"], ["landmark_id", "i"],
    ["landmark_name", "s"], ["visibility", "f"], ["presence", "f"], ["valid_for_measurement", "b"],
    ["speed_px_s", "f"],
    ...["raw_image", "smooth_image", "raw_world", "smooth_world"].flatMap((kind) => XYZ.map((a) => [
      `${kind}_${a}${kind.includes("world") ? "_model_m" : ""}`, "f"]))],
  arm_events: [["frame_id", "i"], ["time_s", "f"], ["pose_epoch", "i"], ["side", "s"], ["event", "s"],
    ["count", "i"]],
};

/* ------------------------------------------------------------------ */
/* CRC32 + ZIP (metode "store", tanpa kompresi)                         */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32Update(crc, bytes) {
  let c = crc ^ 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const encoder = new TextEncoder();

/** Satu file di dalam ZIP, ditulis bertahap. */
export class ZipEntryStream {
  constructor(name) {
    this.name = name;
    this.parts = [];
    this.crc = 0;
    this.size = 0;
    this.pending = [];
    this.pendingChars = 0;
  }

  write(text) {
    this.pending.push(text);
    this.pendingChars += text.length;
    if (this.pendingChars > 262144) this.flush();
  }

  flush() {
    if (!this.pending.length) return;
    const bytes = encoder.encode(this.pending.join(""));
    this.pending = [];
    this.pendingChars = 0;
    this.crc = crc32Update(this.crc, bytes);
    this.size += bytes.length;
    this.parts.push(typeof Blob !== "undefined" ? new Blob([bytes]) : bytes);
  }
}

function dosDateTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((Math.max(date.getFullYear(), 1980) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

/** Rakit ZIP dari daftar ZipEntryStream. Mengembalikan Blob (application/zip). */
export function buildZip(entries, date = new Date()) {
  const { time, day } = dosDateTime(date);
  const out = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    e.flush();
    const name = encoder.encode(e.name);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true);
    local.setUint16(8, 0, true);
    local.setUint16(10, time, true);
    local.setUint16(12, day, true);
    local.setUint32(14, e.crc, true);
    local.setUint32(18, e.size, true);
    local.setUint32(22, e.size, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    out.push(new Uint8Array(local.buffer), name, ...e.parts);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, time, true);
    cd.setUint16(14, day, true);
    cd.setUint32(16, e.crc, true);
    cd.setUint32(20, e.size, true);
    cd.setUint32(24, e.size, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + e.size;
  }
  const cdSize = central.reduce((s, part) => s + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...out, ...central, new Uint8Array(end.buffer)], { type: "application/zip" });
}

/* ------------------------------------------------------------------ */
/* Catatan session.json (disalin dari notebook + catatan khusus web)   */
/* ------------------------------------------------------------------ */

export const SESSION_NOTES = {
  units_note: "Image xy normalized; image z wrist-relative. World xyz are model-estimated local meters, not camera distance. Speed is processed-image pixels/s.",
  confidence_note: "handedness_score is the current raw left/right classification score, not pose or individual-landmark confidence.",
  sampling_note: "frames/hands/landmarks are sampled at up to CSV_HZ; events are recorded on every processed frame. Missing hands have no fabricated landmark rows.",
  pose_coordinate_note: "Pose image z and world xyz are hip-centered model estimates. Hand world xyz are hand-centered. They are not fused into one calibrated 3D space.",
  mirror_note: "Both models infer on the same image, mirrored first when mirror_view=True. Exported image coordinates refer to that processed image. Side swap settings are recorded in config_at_start.",
  arm_metrics_note: "Included elbow angle: straight=180 degrees. Bend=180-included. Trunk-arm is hip-shoulder-elbow angle, not isolated anatomical abduction. Wrist deflection is a 2D proxy requiring an unambiguous wrist link. All speeds are processed-image px/s or deg/s.",
  pose_quality_note: "Pose measurements require sufficient visibility, presence and in-frame joints. Invalid/missing metrics are blank in CSV. Invalid pose coordinates may still be exported, explicitly flagged valid_for_measurement=False.",
  identity_note: "Single-person pose only. pose_epoch resets after loss/jump; hand track IDs are temporary. Wrist proximity is not guaranteed anatomical association. No identity recognition.",
  web_note: "Recorded in a mobile/desktop browser with MediaPipe Tasks for Web. time_s is a performance.now() host receipt time, not a sensor exposure timestamp. If presence_available=false, the web API did not report pose presence and only visibility + in-frame checks gated pose validity.",
};

/* ------------------------------------------------------------------ */
/* SessionLog: port log() + log_all()                                   */
/* ------------------------------------------------------------------ */

export class SessionLog {
  constructor(cfg) {
    this.cfg = { ...cfg };
    this.lastCsvTime = -Infinity;
    this.streams = {};
    this.rowCounts = {};
    if (this.cfg.save_csv) {
      for (const [name, schema] of Object.entries(CSV_SCHEMAS)) {
        const stream = new ZipEntryStream(`${name}.csv`);
        stream.write(`${schema.map(([f]) => f).join(",")}\r\n`);
        this.streams[name] = stream;
        this.rowCounts[name] = 0;
      }
    }
  }

  get enabled() { return Boolean(this.cfg.save_csv); }

  writeRow(name, row) {
    const schema = CSV_SCHEMAS[name];
    this.streams[name].write(`${schema.map(([f, kind]) => formatCell(row[f], kind)).join(",")}\r\n`);
    this.rowCounts[name] += 1;
  }

  /** Port SessionFiles.log(). */
  log(frameId, t, width, height, tracks, fps, inferenceMs, bimanual) {
    if (!this.enabled) return;
    // Event tidak pernah didesimasi oleh csv_hz.
    for (const tr of tracks) {
      for (const event of tr.events) this.writeRow("events", { frame_id: frameId, time_s: t, track_id: tr.id, event });
    }
    if (t - this.lastCsvTime < 1.0 / this.cfg.csv_hz) return;
    this.lastCsvTime = t;
    this.writeRow("frames", {
      frame_id: frameId, time_s: t, width, height, hand_count: tracks.length,
      processed_fps: fps, inference_ms: inferenceMs, bimanual_active: bimanual.active,
      bimanual_scale: bimanual.scale, bimanual_rotation_deg: bimanual.rotation_deg,
    });
    for (const tr of tracks) {
      const row = {
        frame_id: frameId, time_s: t, track_id: tr.id, handedness: tr.handedness,
        raw_handedness: tr.rawHandedness, handedness_score: tr.handednessScore, gesture: tr.gesture,
        raw_gesture: tr.rawGesture, finger_count: tr.metrics.finger_count, pinch_active: tr.pinch,
        pinch_ratio: tr.metrics.pinch_ratio, palm_speed_px_s: tr.palmSpeedPxS,
      };
      for (const name of FINGER_NAMES) {
        const finger = tr.metrics.fingers[name];
        for (const key of FINGER_METRICS) row[`${name.toLowerCase()}_${key}`] = finger[key];
      }
      this.writeRow("hands", row);
      for (let i = 0; i < 21; i++) {
        const lm = {
          frame_id: frameId, time_s: t, track_id: tr.id, landmark_id: i, landmark_name: LANDMARK_NAMES[i],
          image_speed_px_s: tr.speedPxS[i], wrist_relative_image_speed_px_s: tr.relativeSpeedPxS[i],
        };
        const sources = [["raw_image", tr.rawPoints], ["smooth_image", tr.points],
          ["raw_world", tr.rawWorld], ["smooth_world", tr.world]];
        for (const [prefix, values] of sources) {
          XYZ.forEach((axis, j) => {
            lm[`${prefix}_${axis}${prefix.includes("world") ? "_model_m" : ""}`] = values[i][j];
          });
        }
        this.writeRow("landmarks", lm);
      }
    }
  }

  /** Port ArmSessionFiles.log_all(). */
  logAll(frameId, t, width, height, tracks, fps, inferenceMs, bimanual, pose, links, timing) {
    if (!this.enabled) return;
    const sampleDue = t - this.lastCsvTime >= 1.0 / this.cfg.csv_hz;
    this.log(frameId, t, width, height, tracks, fps, inferenceMs, bimanual);
    if (pose !== null) {
      for (const ev of pose.events) {
        this.writeRow("arm_events", { frame_id: frameId, time_s: t, pose_epoch: pose.pose_epoch, ...ev });
      }
    }
    if (!sampleDue) return;
    this.writeRow("pose_frames", {
      frame_id: frameId, time_s: t, pose_detected: pose !== null,
      pose_epoch: pose !== null ? pose.pose_epoch : null,
      valid_landmarks: pose !== null ? pose.valid.filter(Boolean).length : 0,
      hands_ms: timing.hands_ms, pose_ms: timing.pose_ms, wrist_links: links.length,
    });
    if (pose === null) return;
    for (const [side, m] of Object.entries(pose.arms)) {
      this.writeRow("arms", { frame_id: frameId, time_s: t, pose_epoch: pose.pose_epoch, side, ...m });
    }
    for (let i = 0; i < POSE_NAMES.length; i++) {
      const row = {
        frame_id: frameId, time_s: t, pose_epoch: pose.pose_epoch, landmark_id: i,
        landmark_name: POSE_NAMES[i], visibility: pose.visibility[i], presence: pose.presence[i],
        valid_for_measurement: pose.valid[i], speed_px_s: pose.speed_px_s[i],
      };
      const sources = [["raw_image", pose.raw_points], ["smooth_image", pose.points],
        ["raw_world", pose.raw_world], ["smooth_world", pose.world]];
      for (const [prefix, values] of sources) {
        XYZ.forEach((axis, j) => {
          row[`${prefix}_${axis}${prefix.includes("world") ? "_model_m" : ""}`] = values[i][j];
        });
      }
      this.writeRow("pose_landmarks", row);
    }
  }

  /** Tutup sesi: tambah session.json dan kembalikan Blob ZIP. */
  finalize({ summary, versions = {}, modelSha256 = null, poseModelSha256 = null, extra = {} } = {}) {
    if (!this.enabled) return null;
    const payload = {
      created_utc: new Date().toISOString(),
      config_at_start: this.cfg,
      versions: { app: APP_VERSION, ...versions },
      model_sha256: modelSha256,
      summary,
      recordings: extra.recordings || [],
      row_counts: this.rowCounts,
      ...SESSION_NOTES,
      pose_model_sha256: poseModelSha256,
      ...extra.payload,
    };
    const json = new ZipEntryStream("session.json");
    json.write(JSON.stringify(payload, (k, v) => (typeof v === "number" && !Number.isFinite(v) ? null : v), 2));
    return buildZip([...Object.values(this.streams), json]);
  }
}

/** Nama file sesi seperti notebook: YYYYmmdd_HHMMSS_xxxxxx. */
export function sessionStamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  const rand = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0");
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}_${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}_${rand}`;
}

export { FINGER_IDS };
