"""Bandingkan CSV hasil notebook (Python) dengan CSV di dalam ZIP buatan app (JavaScript).

Pemakaian:
    python tests/parity/compare_csv.py --zip sesi_js.zip --pydir folder_csv_python
Keluar dengan kode 1 bila ada perbedaan header, jumlah baris, atau nilai.
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import math
import sys
import zipfile
from pathlib import Path

FILES = ["frames", "hands", "landmarks", "events", "pose_frames", "arms", "pose_landmarks", "arm_events"]


def as_float(text: str):
    try:
        return float(text)
    except ValueError:
        return None


def close(a: float, b: float) -> bool:
    if math.isnan(a) and math.isnan(b):
        return True
    return abs(a - b) <= 1e-6 * max(1.0, abs(a), abs(b))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--zip", required=True, type=Path)
    ap.add_argument("--pydir", required=True, type=Path)
    args = ap.parse_args()

    problems = []
    report = {}
    with zipfile.ZipFile(args.zip) as archive:
        bad = archive.testzip()
        if bad is not None:
            problems.append(f"ZIP rusak pada entri {bad}")
        names = set(archive.namelist())
        if "session.json" not in names:
            problems.append("session.json tidak ada di ZIP")
        else:
            json.loads(archive.read("session.json").decode("utf-8"))
        for name in FILES:
            js_bytes = archive.read(f"{name}.csv")
            py_bytes = (args.pydir / f"{name}.csv").read_bytes()
            js_rows = list(csv.reader(io.StringIO(js_bytes.decode("utf-8"), newline="")))
            py_rows = list(csv.reader(io.StringIO(py_bytes.decode("utf-8"), newline="")))
            stats = {"rows_js": len(js_rows) - 1, "rows_py": len(py_rows) - 1, "cells": 0,
                     "identical_cells": 0, "numeric_close": 0, "mismatch": 0,
                     "byte_identical": js_bytes == py_bytes}
            if js_rows[0] != py_rows[0]:
                problems.append(f"{name}.csv: header berbeda")
            if len(js_rows) != len(py_rows):
                problems.append(f"{name}.csv: jumlah baris {len(js_rows) - 1} (JS) vs {len(py_rows) - 1} (Python)")
            for r, (jr, pr) in enumerate(zip(js_rows[1:], py_rows[1:]), start=1):
                if len(jr) != len(pr):
                    problems.append(f"{name}.csv baris {r}: jumlah kolom berbeda")
                    continue
                for c, (jv, pv) in enumerate(zip(jr, pr)):
                    stats["cells"] += 1
                    if jv == pv:
                        stats["identical_cells"] += 1
                        continue
                    jf, pf = as_float(jv), as_float(pv)
                    if jf is not None and pf is not None and close(jf, pf):
                        stats["numeric_close"] += 1
                        continue
                    stats["mismatch"] += 1
                    if stats["mismatch"] <= 3:
                        problems.append(f"{name}.csv baris {r} kolom {js_rows[0][c]}: JS={jv!r} Python={pv!r}")
            report[name] = stats
    for name, s in report.items():
        print(f"  {name:15s} baris JS/Py={s['rows_js']}/{s['rows_py']}  sel={s['cells']}  "
              f"identik={s['identical_cells']}  beda-pembulatan={s['numeric_close']}  "
              f"beda={s['mismatch']}  byte-identik={s['byte_identical']}")
    if problems:
        print("MASALAH:")
        for p in problems[:30]:
            print("  -", p)
        return 1
    print("CSV cocok.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
