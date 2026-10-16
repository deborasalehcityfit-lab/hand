/*
 * Service worker: membuat app bisa dibuka offline setelah kunjungan pertama.
 * - Berkas app sendiri: network-first (perubahan kode langsung terambil saat online).
 * - Pustaka MediaPipe, model .task, font: cache-first (URL-nya berversi, tidak berubah).
 * Naikkan VERSION bila ingin memaksa cache lama dibuang.
 */
const VERSION = "motionlab-v1.0.1";
const SHELL = [
  "./", "./index.html", "./styles.css", "./manifest.webmanifest",
  "./js/app.js", "./js/core.js", "./js/draw.js", "./js/recorder.js", "./js/demo.js",
  "./js/viewer3d.js", "./js/config.js",
  "./icons/icon-192.png", "./icons/icon-512.png", "./icons/apple-touch-icon.png",
];
const IMMUTABLE_HOSTS = ["cdn.jsdelivr.net", "storage.googleapis.com", "fonts.googleapis.com", "fonts.gstatic.com"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
          return res;
        })
        .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match("./index.html"))),
    );
    return;
  }

  if (IMMUTABLE_HOSTS.includes(url.hostname)) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        // Jangan simpan halaman web (mis. halaman blokir/login Wi-Fi) sebagai pengganti pustaka atau model.
        const html = (res.headers.get("content-type") || "").includes("text/html");
        if ((res.ok && !html) || res.type === "opaque") { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
        return res;
      })),
    );
  }
});
