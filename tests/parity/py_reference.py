"""Referensi Python untuk uji paritas.

Menjalankan kode ASLI dari notebook (sel-sel logika tracking + perekam CSV) pada
fixture sintetis yang sama dengan versi JavaScript, lalu menyimpan output per frame
ke JSON dan CSV-nya ke folder. Tidak butuh kamera maupun model MediaPipe.

Pemakaian:
    python tests/parity/py_reference.py --notebook "Arm_Hand_Finger_Tracking (2).ipynb" \
        --fixture fixture.json --out hasil_py [--swap-hands] [--swap-pose]
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import itertools
import json
import math
import platform
import types
import uuid
import warnings
from collections import Counter, deque
from datetime import datetime, timezone
from importlib import metadata
from pathlib import Path
from types import SimpleNamespace as NS

import numpy as np

# Sel kode notebook yang berisi logika (dipilih berdasarkan id sel, bukan urutan).
CELL_IDS = [
    "d5d6b560",  # konfigurasi + validate_config
    "380a22b0",  # FINGER_IDS, joint_angle
    "c0ee53f3",  # OneEuroFilter, StableLabel
    "e8d62655",  # hand_geometry
    "99ca12f7",  # classify_gesture, unpack_result
    "0fe721fb",  # HandTrack
    "7249934a",  # MultiHandTracker
    "93498532",  # BimanualControl
    "e04b3cd9",  # pose: unpack, arm_geometry, ArmCycleCounter
    "5028402a",  # UpperBodyTracker, associate_hands_with_arms
    "92d85007",  # SessionFiles
    "d49b3158",  # ArmSessionFiles
]
FINGER_KEYS = ["mcp_deg", "pip_deg", "dip_deg", "ip_deg", "bend_deg", "curl_percent",
               "extended", "tip_speed_px_s", "angular_speed_deg_s"]


def load_namespace(notebook: Path) -> dict:
    nb = json.loads(notebook.read_text(encoding="utf-8"))
    by_id = {c.get("id"): "".join(c["source"]) for c in nb["cells"] if c["cell_type"] == "code"}
    missing = [i for i in CELL_IDS if i not in by_id]
    if missing:
        raise SystemExit(f"Sel notebook tidak ditemukan: {missing}. Apakah ini notebook yang benar?")
    try:
        import cv2  # noqa: F401  (hanya dipakai SessionFiles untuk video/versi)
    except Exception:  # pragma: no cover
        cv2 = types.SimpleNamespace(__version__="not-installed")
    g = {"__name__": "notebook_reference", "np": np, "itertools": itertools, "Counter": Counter,
         "deque": deque, "Path": Path, "warnings": warnings, "math": math, "csv": csv, "json": json,
         "hashlib": hashlib, "uuid": uuid, "platform": platform, "metadata": metadata,
         "datetime": datetime, "timezone": timezone, "cv2": cv2}
    for cell_id in CELL_IDS:
        exec(compile(by_id[cell_id], f"<cell {cell_id}>", "exec"), g)
    return g


def hand_result(h: dict):
    xyz = lambda p: NS(x=p["x"], y=p["y"], z=p["z"])
    return NS(
        hand_landmarks=[[xyz(p) for p in hand] for hand in h["landmarks"]],
        hand_world_landmarks=[[xyz(p) for p in hand] for hand in h["worldLandmarks"]],
        handedness=[[NS(category_name=c["categoryName"], score=c["score"]) for c in cats]
                    for cats in h["handedness"]],
    )


def pose_result(p):
    if p is None:
        return NS(pose_landmarks=[], pose_world_landmarks=[])
    mk = lambda q: NS(x=q["x"], y=q["y"], z=q["z"], visibility=q.get("visibility"), presence=q.get("presence"))
    return NS(pose_landmarks=[[mk(q) for q in person] for person in p["landmarks"]],
              pose_world_landmarks=[[mk(q) for q in person] for person in p["worldLandmarks"]])


def clean(value):
    """numpy -> Python, NaN/inf -> None (JSON valid)."""
    if isinstance(value, dict):
        return {str(k): clean(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [clean(v) for v in value]
    if isinstance(value, np.ndarray):
        return clean(value.tolist())
    if isinstance(value, (bool, np.bool_)):
        return bool(value)
    if isinstance(value, (int, np.integer)):
        return int(value)
    if isinstance(value, (float, np.floating)):
        return float(value) if math.isfinite(value) else None
    return value


def track_out(tr) -> dict:
    m = tr.metrics
    return {
        "id": tr.id, "handedness": tr.handedness, "raw_handedness": tr.raw_handedness,
        "score": tr.handedness_score, "gesture": tr.gesture, "raw_gesture": tr.raw_gesture,
        "pinch": bool(tr.pinch), "events": list(tr.events), "palm_speed": tr.palm_speed_px_s,
        "palm_size": m["palm_size_model_m"], "pinch_ratio": m["pinch_ratio"],
        "finger_count": m["finger_count"],
        "fingers": {n: {k: m["fingers"][n][k] for k in FINGER_KEYS} for n in m["fingers"]},
        "points": tr.points, "world": tr.world, "speed": tr.speed_px_s,
        "rel_speed": tr.relative_speed_px_s, "motion": tr.motion_xy,
    }


def pose_out(pose):
    if pose is None:
        return None
    return {"epoch": pose["pose_epoch"], "valid": [bool(v) for v in pose["valid"]],
            "points": pose["points"], "world": pose["world"], "speed": pose["speed_px_s"],
            "arms": pose["arms"], "events": pose["events"]}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--notebook", required=True, type=Path)
    ap.add_argument("--fixture", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--swap-hands", action="store_true")
    ap.add_argument("--swap-pose", action="store_true")
    args = ap.parse_args()

    g = load_namespace(args.notebook)
    cfg = g["current_config"]()
    cfg.update({"save_csv": True, "output_dir": str(args.out / "py_csv"),
                "swap_handedness": args.swap_hands, "swap_pose_sides": args.swap_pose})
    g["validate_config"](cfg)

    frames = json.loads(args.fixture.read_text(encoding="utf-8"))["frames"]
    files = g["ArmSessionFiles"](cfg)
    shape = None
    outputs = []
    for frame_id, fr in enumerate(frames):
        t, w, h = fr["t"], fr["width"], fr["height"]
        if shape != (w, h):  # sama dengan reset saat ukuran frame berubah di notebook
            tracker = g["MultiHandTracker"](cfg)
            body = g["UpperBodyTracker"](cfg)
            bimanual_control = g["BimanualControl"]()
            shape = (w, h)
        detections = g["unpack_result"](hand_result(fr["hand"]), cfg["swap_handedness"])
        tracks = tracker.update(detections, t, w, h)
        pose = body.update(g["unpack_pose_result"](pose_result(fr["pose"]), cfg["swap_pose_sides"]), t, w, h)
        links = g["associate_hands_with_arms"](pose, tracks, cfg, w, h)
        bimanual = bimanual_control.update(tracks, w, h)
        timing = {"hands_ms": fr["hands_ms"], "pose_ms": fr["pose_ms"]}
        files.log_all(frame_id, t, w, h, tracks, fr["fps"], fr["inference_ms"], bimanual, pose, links, timing)
        outputs.append(clean({
            "frame_id": frame_id, "t": t,
            "tracks": [track_out(tr) for tr in tracks],
            "pose": pose_out(pose),
            "links": [{"side": l["side"], "track_id": l["track_id"], "distance_px": l["distance_px"]} for l in links],
            "bimanual": bimanual,
        }))
    files.close({"frames": len(frames)})
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "expected.json").write_text(json.dumps({"outputs": outputs}), encoding="utf-8")
    print(f"Python reference: {len(outputs)} frame, CSV di {files.folder}")
    (args.out / "py_csv_folder.txt").write_text(str(files.folder), encoding="utf-8")


if __name__ == "__main__":
    main()
