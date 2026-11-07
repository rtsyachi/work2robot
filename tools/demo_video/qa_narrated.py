"""ナレーション版（materials/demo/demo_with_narration.mp4）の品質確認：形式・長さ・音量・無音区間・確認用のコマ一覧。
  実行：.venv/Scripts/python -X utf8 tools/demo_video/qa_narrated.py
"""
import json
import re
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
F = str(REPO / "tools/demo_video/node_modules/ffmpeg-static/ffmpeg.exe")
V = REPO / "materials/demo/demo_with_narration.mp4"
Q = REPO / "local_media/demo_build/qa"
Q.mkdir(parents=True, exist_ok=True)


def ff(*args):
    return subprocess.run([F, "-hide_banner", *args], capture_output=True, text=True, encoding="utf-8", errors="replace").stderr


info = ff("-i", str(V))
print("\n".join(l.strip() for l in info.splitlines() if "Duration" in l or "Stream" in l))
ln = ff("-i", str(V), "-af", "loudnorm=print_format=json", "-vn", "-f", "null", "-")
j = json.loads(ln[ln.rindex("{"):ln.rindex("}") + 1])
print("loudness", j["input_i"], "LUFS / true peak", j["input_tp"], "dBTP")


def maxvol(a, d):
    s = ff("-ss", str(a), "-t", str(d), "-i", str(V), "-af", "volumedetect", "-vn", "-f", "null", "-")
    m = re.search(r"max_volume: ([-0-9.]+) dB", s)
    return float(m[1]) if m else None


import csv  # noqa: E402
TOTAL = float(re.search(r"Duration: (\d+):(\d+):([\d.]+)", info).group(3)) + 60 * int(re.search(r"Duration: (\d+):(\d+)", info).group(2))
rows = {r["scene_id"]: r for r in csv.DictReader((REPO / "materials/demo/narration_timing.csv").open(encoding="utf-8-sig"))}
nar = json.loads((REPO / "materials/demo/narration/subtitles.json").read_text(encoding="utf-8"))
sens = [(s["start"], s["end"]) for v in nar["sentences"].values() for s in v]
# 文と文の間（0.3秒以上空いている所）が無音か
gaps = []
prev = 0.0
for a, b in sorted(sens):
    if a - prev > 0.6:
        gaps.append((prev + 0.15, a - prev - 0.3))
    prev = b
if TOTAL - prev > 0.4:
    gaps.append((prev + 0.15, TOTAL - prev - 0.2))
loud = [(round(a, 2), round(d, 2), maxvol(a, d)) for a, d in gaps]
bad = [g for g in loud if g[2] is not None and g[2] > -60]
print("全体", TOTAL, "秒")
print("無音であるべき区間", len(loud), "件・音ありの区間", bad)
a7, b7 = float(rows["S07"]["vo_end"]) + 0.15, float(rows["S07"]["scene_end"]) - 0.1
print(f"S07 ロボットだけの区間 {a7:.1f}–{b7:.1f} 秒（{b7 - a7:.1f}秒）の最大音量", maxvol(a7, b7 - a7), "dB")
# 確認用のコマ一覧（場面の頭からの位置で選ぶ）
s = {k: float(r["scene_start"]) for k, r in rows.items()}
ts = [round(x, 2) for x in (3, s["S02"] + 4.5, s["S02"] + 12, s["S02"] + 18, s["S03"] + 8, s["S07"] + 8, s["S07"] + 23,
                            s["S08"] + 5, s["S10"] + 2)]
for t in ts:
    ff("-loglevel", "error", "-y", "-ss", str(t), "-i", str(V), "-frames:v", "1", "-vf", "scale=640:360", str(Q / f"n_{t}.png"))
inputs = sum((["-i", str(Q / f"n_{t}.png")] for t in ts), [])
ff("-loglevel", "error", "-y", *inputs, "-filter_complex",
   "xstack=inputs=9:layout=0_0|640_0|1280_0|0_360|640_360|1280_360|0_720|640_720|1280_720", str(Q / "narrated_sheet.png"))
print("sheet", Q / "narrated_sheet.png")
