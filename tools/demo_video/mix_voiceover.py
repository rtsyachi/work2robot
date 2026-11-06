"""収録したナレーションを、場面ごとの開始時刻に置いて提出動画を仕上げる。

  録音の置き場所： local_media/voice/demo/vo_S01.wav … vo_S10.wav（.wav/.m4a/.mp3 可。S02 は不要）
  実行：           .venv/Scripts/python -X utf8 tools/demo_video/mix_voiceover.py [--subs]
  出力：           materials/demo/demo_final.mp4
    --subs を付けると、ナレーション字幕を焼き込んだ版（demo_guide_with_narration_subs.mp4）の映像を使う。

時刻は materials/demo/narration_cues.csv（build_demo.py が出力）の vo_start。
録音が場面の終わり（vo_latest_end）を超える場合は警告する（重なりを防ぐため、その場合は録り直すか読む速さを上げる）。
作業者の音声（S02）とは時間が重ならない。BGM は入れない。
"""
from __future__ import annotations

import csv
import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
FFMPEG = REPO / "tools/demo_video/node_modules/ffmpeg-static/ffmpeg.exe"
DEMO = REPO / "materials/demo"
VOICE = REPO / "local_media/voice/demo"
VO_GAIN_DB = 0.0   # ナレーションの音量調整（dB）


def duration(path: Path) -> float:
    r = subprocess.run([str(FFMPEG), "-hide_banner", "-i", str(path)], capture_output=True, text=True, encoding="utf-8", errors="replace")
    m = re.search(r"Duration: (\d+):(\d+):([\d.]+)", r.stderr)
    if not m:
        raise SystemExit(f"長さを読めない: {path}")
    return int(m[1]) * 3600 + int(m[2]) * 60 + float(m[3])


def main():
    global VOICE
    VOICE = Path(next((a.split("=", 1)[1] for a in sys.argv if a.startswith("--voice=")), VOICE))
    out_name = next((a.split("=", 1)[1] for a in sys.argv if a.startswith("--out=")), "demo_final.mp4")
    base = DEMO / ("demo_guide_with_narration_subs.mp4" if "--subs" in sys.argv else "demo_no_voiceover.mp4")
    cues = list(csv.DictReader((DEMO / "narration_cues.csv").open(encoding="utf-8-sig")))
    inputs, parts, missing, warn = ["-i", str(base)], [], [], []
    for c in cues:
        if c["voiceover"] != "yes":
            continue
        stem = Path(c["record_filename"]).stem
        f = next((p for ext in (".wav", ".m4a", ".mp3") if (p := VOICE / f"{stem}{ext}").exists()), None)
        if not f:
            missing.append(c["record_filename"])
            continue
        start, latest = float(c["vo_start"]), float(c["vo_latest_end"])
        d = duration(f)
        if start + d > latest:
            warn.append(f"{c['scene_id']}: 録音 {d:.1f}秒 → {start + d:.1f}秒で終わる（場面の上限 {latest:.1f}秒を {start + d - latest:.1f}秒超える）")
        k = len(inputs) // 2
        inputs += ["-i", str(f)]
        ms = int(round(start * 1000))
        parts.append(f"[{k}:a]aresample=48000,aformat=channel_layouts=stereo,volume={VO_GAIN_DB}dB,adelay={ms}|{ms}[v{k}]")
    if missing:
        print("録音がない場面（無音のまま）：", ", ".join(missing))
    for w in warn:
        print("警告：", w)
    if not parts:
        raise SystemExit(f"録音が見つからない（{VOICE}）")
    labels = "".join(f"[v{i + 1}]" for i in range(len(parts)))
    graph = ";".join(parts) + f";[0:a]{labels}amix=inputs={len(parts) + 1}:normalize=0:duration=first[a]"
    out = Path(out_name) if Path(out_name).is_absolute() else DEMO / out_name
    r = subprocess.run([str(FFMPEG), "-hide_banner", "-loglevel", "error", "-y", *inputs, "-filter_complex", graph,
                        "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
                        "-movflags", "+faststart", str(out)], capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode:
        print(r.stderr[-2000:])
        raise SystemExit("ffmpeg failed")
    print(f"出力：{out}（{duration(out):.2f}秒）")


if __name__ == "__main__":
    main()
