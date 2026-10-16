"""Unduh pustaka MediaPipe Tasks Vision + model .task ke folder proyek (self-host).

Berguna bila:
  - jaringan (kampus/kantor) memblokir cdn.jsdelivr.net atau storage.googleapis.com,
  - ingin app benar-benar offline dan versinya terkunci di repo sendiri.

Pemakaian (dari folder proyek):
    python tools/fetch_assets.py                 # pustaka + model tangan + pose lite
    python tools/fetch_assets.py --pose lite full heavy
Lalu buka app dengan ?assets=local, atau ubah SELF_HOSTED = true di js/config.js.

Hanya memakai pustaka standar Python 3.9+.
"""
from __future__ import annotations

import argparse
import io
import sys
import tarfile
import urllib.request
import zipfile
from pathlib import Path

VERSION = "1.0.1"
REGISTRY = "https://registry.npmjs.org"
MODELS = "https://storage.googleapis.com/mediapipe-models"
ROOT = Path(__file__).resolve().parent.parent


def fetch(url: str, limit: int = 150_000_000) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "motionlab-fetch-assets"})
    with urllib.request.urlopen(req, timeout=120) as res:
        data = res.read(limit + 1)
    if len(data) > limit:
        raise RuntimeError(f"Unduhan terlalu besar dari {url}")
    return data


def valid_task(data: bytes) -> bool:
    """Sama dengan valid_task_file() di notebook: arsip zip berisi >= 2 file .tflite."""
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            return sum(n.endswith(".tflite") for n in z.namelist()) >= 2 and z.testzip() is None
    except zipfile.BadZipFile:
        return False


def fetch_library(version: str, registry: str, dest: Path) -> list[str]:
    url = f"{registry}/@mediapipe/tasks-vision/-/tasks-vision-{version}.tgz"
    print(f"Mengunduh pustaka {url}")
    blob = fetch(url)
    written = []
    with tarfile.open(fileobj=io.BytesIO(blob), mode="r:gz") as tar:
        for member in tar.getmembers():
            name = member.name
            if not member.isfile() or ".." in name.split("/"):
                continue
            if name == "package/vision_bundle.mjs" or (name.startswith("package/wasm/") and name.count("/") == 2):
                rel = name[len("package/"):]
                target = dest / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(tar.extractfile(member).read())
                written.append(rel)
    if "vision_bundle.mjs" not in written or not any(w.endswith(".wasm") for w in written):
        raise RuntimeError("Tarball tidak berisi vision_bundle.mjs dan berkas wasm yang diharapkan.")
    return written


def fetch_model(url: str, target: Path) -> None:
    if target.exists() and valid_task(target.read_bytes()):
        print(f"  {target.name} sudah ada, dilewati")
        return
    print(f"Mengunduh model {url}")
    data = fetch(url)
    if not valid_task(data):
        raise RuntimeError(f"{url} bukan arsip MediaPipe .task yang valid.")
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(".task.part")
    tmp.write_bytes(data)
    tmp.replace(target)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--version", default=VERSION, help="versi @mediapipe/tasks-vision (default %(default)s)")
    ap.add_argument("--pose", nargs="*", default=["lite"], choices=["lite", "full", "heavy"],
                    help="varian model pose yang diunduh (default: lite)")
    ap.add_argument("--registry-base", default=REGISTRY, help=argparse.SUPPRESS)
    ap.add_argument("--models-base", default=MODELS, help=argparse.SUPPRESS)
    ap.add_argument("--root", type=Path, default=ROOT, help=argparse.SUPPRESS)
    args = ap.parse_args()

    vendor = args.root / "vendor" / "tasks-vision"
    models = args.root / "models"
    try:
        files = fetch_library(args.version, args.registry_base, vendor)
        print(f"  {len(files)} berkas pustaka -> {vendor}")
        fetch_model(f"{args.models_base}/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
                    models / "hand_landmarker.task")
        for variant in args.pose:
            fetch_model(f"{args.models_base}/pose_landmarker/pose_landmarker_{variant}/float16/1/"
                        f"pose_landmarker_{variant}.task", models / f"pose_landmarker_{variant}.task")
    except Exception as exc:  # noqa: BLE001
        print(f"GAGAL: {exc}\nCoba jaringan lain, atau unduh berkas lewat browser lalu taruh di folder yang sama.",
              file=sys.stderr)
        return 1
    print("\nSelesai. Buka app dengan ?assets=local, atau set SELF_HOSTED = true di js/config.js.")
    print("Ingat: versi di js/config.js (MEDIAPIPE_VERSION) harus sama dengan --version yang diunduh.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
