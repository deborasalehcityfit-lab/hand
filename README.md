# Motion Lab: lengan, tangan, dan jari di HP

Versi web (PWA) dari notebook **Full Arm, Hand and Finger Motion Lab**. Jalan di Chrome (Android) dan Safari (iPhone) memakai kamera HP sendiri. Semua inferensi MediaPipe terjadi di perangkat; video tidak dikirim ke server.

Logika tracking (filter One Euro, sudut jari, gestur, pinch, swipe, tracking dua tangan, sudut siku, hitungan siklus, tautan pergelangan) adalah port 1:1 dari notebook dan sudah diuji frame-per-frame terhadap kode Python aslinya. CSV yang direkam punya nama file dan kolom yang sama dengan notebook.

## Mulai cepat (GitHub Pages, gratis, HTTPS)

1. Buat repositori baru di GitHub (Public).
2. **Add file → Upload files**, seret seluruh isi folder ini (bukan foldernya), lalu **Commit changes**.
3. **Settings → Pages → Build and deployment → Source: Deploy from a branch**, pilih `main` dan `/ (root)`, **Save**.
4. Tunggu sekitar satu menit, lalu buka `https://USERNAME.github.io/NAMA-REPO/` di HP dan izinkan kamera.
5. Opsional: pasang ke layar utama (Android: menu Chrome → *Install app*; iPhone: Bagikan → *Tambahkan ke Layar Utama*).

## Uji di laptop

```bash
python -m http.server 8000
```

- `http://localhost:8000` memakai webcam laptop (localhost dianggap aman oleh browser).
- `http://localhost:8000/?demo=1` menjalankan data gerakan sintetis tanpa kamera.
- Untuk membuka server laptop dari HP butuh HTTPS, misalnya `cloudflared tunnel --url http://localhost:8000` (lihat panduan).

## Isi folder

| Berkas | Isi |
| --- | --- |
| `index.html`, `styles.css` | Tampilan app |
| `js/core.js` | Port logika tracking notebook (tanpa DOM, bisa diuji di Node) |
| `js/recorder.js` | Perekam CSV format notebook + pembuat ZIP |
| `js/app.js` | Kamera, MediaPipe, loop frame, panel, ekspor, kalibrasi kiri/kanan |
| `js/draw.js`, `js/viewer3d.js` | Overlay kerangka dan tampilan 3D |
| `js/demo.js` | Adegan sintetis untuk mode demo dan uji paritas |
| `js/config.js` | Versi MediaPipe (1.0.1), alamat pustaka/model, sakelar self-host |
| `sw.js`, `manifest.webmanifest`, `icons/` | PWA: bisa dipasang dan dibuka offline |
| `tests/` | Uji unit dan uji paritas dengan notebook |
| `tools/fetch_assets.py` | Unduh pustaka + model untuk self-host/offline penuh |
| `python/phone_camera_cell.py` | Sel notebook: pakai kamera HP via Wi-Fi untuk notebook Python |

## Data hasil sesi

Aktifkan **Pengaturan → Data → Rekam data CSV**. Saat sesi dihentikan, app menawarkan satu ZIP berisi `frames.csv`, `hands.csv`, `landmarks.csv`, `events.csv`, `pose_frames.csv`, `arms.csv`, `pose_landmarks.csv`, `arm_events.csv`, dan `session.json`. Ekstrak di laptop, lalu pakai fungsi notebook yang sudah ada:

```python
folder = Path("motionlab_20261015_101500_ab12cd")
plot_saved_arm(folder / "arms.csv", side="Left", metric="elbow_included_2d_deg")
plot_saved_bend(folder / "hands.csv", track_id=1, finger="Index")
```

## Tes

```bash
npm test                                                     # uji unit (Node 18+)
node tests/parity/run_parity.mjs --notebook "Arm_Hand_Finger_Tracking (2).ipynb"   # paritas vs notebook (butuh Python + numpy)
```

## Self-host / offline penuh

```bash
python tools/fetch_assets.py            # pustaka MediaPipe + model tangan + pose lite
```

Lalu buka app dengan `?assets=local`, atau set `SELF_HOSTED = true` di `js/config.js`, dan unggah ulang ke GitHub.

## Batasan

Sudut, kecepatan, dan koordinat 3D adalah estimasi model, bukan pengukuran klinis. Satu orang saja; ID tangan bersifat sementara. Label kiri/kanan sebaiknya diverifikasi sekali per kamera dengan **Pengaturan → Kalibrasi kiri/kanan**.
