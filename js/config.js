/*
 * config.js — alamat pustaka & model. Ubah di sini bila ingin self-host.
 *
 * Default: pustaka MediaPipe dari jsDelivr (versi dipin) dan model .task dari Google.
 * Self-host (offline penuh / jaringan yang memblokir CDN):
 *   1) jalankan  python tools/fetch_assets.py  (mengunduh pustaka + model ke folder proyek)
 *   2) set SELF_HOSTED = true, atau buka app dengan  ?assets=local
 */

export const MEDIAPIPE_VERSION = "1.0.1"; // sama dengan mediapipe==1.0.1 di notebook

export const SELF_HOSTED = false;

const params = new URLSearchParams(globalThis.location ? globalThis.location.search : "");
const useLocal = SELF_HOSTED || params.get("assets") === "local";

const CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}`;
const LOCAL = "./vendor/tasks-vision";

export const MEDIAPIPE = {
  version: MEDIAPIPE_VERSION,
  bundle: useLocal ? new URL(`${LOCAL}/vision_bundle.mjs`, globalThis.location?.href ?? "http://x/").href
    : `${CDN}/vision_bundle.mjs`,
  wasm: useLocal ? `${LOCAL}/wasm` : `${CDN}/wasm`,
  source: useLocal ? "local" : "cdn",
};

const GOOGLE_MODELS = "https://storage.googleapis.com/mediapipe-models";
const LOCAL_MODELS = "./models";
// ?models=local = pakai HANYA model di folder models/ situs ini (pustaka tetap dari CDN).
const onlyLocalModels = useLocal || params.get("models") === "local";

/**
 * Daftar sumber model, dicoba berurutan. Bila Google gagal atau isinya bukan model
 * (mis. jaringan mengganti file dengan halaman web), app mencoba folder models/ di situs ini.
 */
export const MODEL_URLS = {
  hand: onlyLocalModels ? [`${LOCAL_MODELS}/hand_landmarker.task`] : [
    `${GOOGLE_MODELS}/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task`,
    `${LOCAL_MODELS}/hand_landmarker.task`,
  ],
  pose: (variant) => (onlyLocalModels ? [`${LOCAL_MODELS}/pose_landmarker_${variant}.task`] : [
    `${GOOGLE_MODELS}/pose_landmarker/pose_landmarker_${variant}/float16/1/pose_landmarker_${variant}.task`,
    `${LOCAL_MODELS}/pose_landmarker_${variant}.task`,
  ]),
};

export const STORAGE_KEYS = {
  settings: "ahml.settings.v1",
  calibration: "ahml.calibration.v1",
  introSeen: "ahml.intro.v1",
};
