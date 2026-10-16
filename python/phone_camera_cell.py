"""Sel tambahan untuk notebook Python: pakai kamera HP lewat Wi-Fi (URL stream).

Cara pakai
----------
1. Pasang app kamera-IP di HP (contoh: "IP Webcam" di Android, atau DroidCam di
   Android/iPhone). Jalankan servernya; app menampilkan alamat seperti
   http://192.168.1.23:8080 . HP dan laptop harus di Wi-Fi yang sama.
2. Di notebook, tempel SELURUH isi file ini sebagai sel baru TEPAT SETELAH sel
   section 4 (fungsi camera_backends/open_camera), lalu jalankan.
3. Di sel pengaturan (section 3) isi CAMERA_INDEX dengan URL stream, misalnya:
       CAMERA_INDEX = "http://192.168.1.23:8080/video"     # IP Webcam (Android)
       CAMERA_INDEX = "http://192.168.1.23:4747/video"     # DroidCam
   lalu jalankan sel pengaturan dan sel START seperti biasa.

Catatan: bila app di HP memasang driver webcam virtual di Windows (DroidCam
Client, Iriun, Camo, atau fitur "Use as a connected camera" Windows 11), kamera HP
muncul sebagai webcam biasa: cukup ganti CAMERA_INDEX = 1 / 2 (cek dengan
scan_cameras()), sel ini tidak diperlukan.
"""
import time

import cv2
import numpy as np

# Simpan fungsi asli sekali saja (aman bila sel ini dijalankan berulang kali).
if not getattr(open_camera, "_phone_wrapper", False):          # noqa: F821
    _original_open_camera = open_camera                        # noqa: F821
if not getattr(validate_config, "_phone_wrapper", False):      # noqa: F821
    _original_validate_config = validate_config                # noqa: F821


def validate_config(cfg):
    """Izinkan CAMERA_INDEX berupa URL string; sisanya divalidasi seperti biasa."""
    if isinstance(cfg.get("camera_index"), str):
        if not cfg["camera_index"].startswith(("http://", "https://", "rtsp://")):
            raise ValueError("URL kamera harus diawali http://, https://, atau rtsp://")
        cfg = dict(cfg, camera_index=0)
    return _original_validate_config(cfg)


def open_camera(index, backend="auto", width=640, height=480, fps=30, reject_black=True, warmup_seconds=4.0):
    """Sama seperti open_camera() asli, ditambah dukungan URL stream (MJPEG/RTSP)."""
    if not isinstance(index, str):
        return _original_open_camera(index, backend, width, height, fps, reject_black, warmup_seconds)
    print(f"Kamera URL {index}: membuka ...", flush=True)
    cap = cv2.VideoCapture(index, cv2.CAP_FFMPEG)
    if not cap.isOpened():
        cap.release()
        cap = cv2.VideoCapture(index)
    if not cap.isOpened():
        cap.release()
        raise RuntimeError(f"Tidak bisa membuka {index}. Cek alamat di app HP, Wi-Fi yang sama, dan firewall.")
    cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
    started, good, health = time.monotonic(), 0, None
    while time.monotonic() - started < warmup_seconds:
        ok, frame = cap.read()
        if not ok or frame is None or not frame.size:
            good = 0
            time.sleep(0.03)
            continue
        frame = bgr_camera_frame(frame)            # noqa: F821
        health = frame_health(frame)               # noqa: F821
        good = good + 1 if (not reject_black or not health["near_black"]) else 0
        if good >= 3:
            print(f"  Stream OK: {frame.shape[1]}x{frame.shape[0]}, mean={health['mean']:.1f}")
            return cap, frame, "url"
    cap.release()
    raise RuntimeError(f"Stream {index} tidak mengirim gambar yang terbaca dalam {warmup_seconds:.0f} s "
                       f"(terakhir: {health}).")


validate_config._phone_wrapper = True
open_camera._phone_wrapper = True
print("Sumber kamera URL aktif. Isi CAMERA_INDEX dengan URL stream dari HP.")
