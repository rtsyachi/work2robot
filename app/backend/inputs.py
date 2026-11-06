"""トランザクション：入力の作業動画（説明音声を含む）と、その解析結果の状況（docs/WORKFLOW_SPEC.md「入力データの区分」）。

- 今の作業動画は current_video() で決める。Step 2 でアップロードした動画があればそれ、なければ INPUT_VIDEO（v5デモ）。
  アプリ（再生）・文字起こし・観測はすべてこの動画を使う。
- 画面が使う保存済みの解析結果は、記録された動画名が今の動画と同じものだけ（latest_for）。別の動画の結果は表示しない。
  analysis_status() は、今の動画の結果が種類ごとにあるか（ok／missing）を返す。
"""
from __future__ import annotations

import json
import re
import subprocess
from functools import lru_cache
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MEDIA = ROOT.parent / "local_media"
# 2026-11-06：v5（倉庫・棚・パレット3台のCG、3分17秒）に変更。それまでは materials/input_video_v2.mp4
INPUT_VIDEO = ROOT.parent / "materials" / "input_video_v5.mp4"
UPLOAD_DIR = MEDIA / "uploads"          # Step 2 でアップロードした動画（upload_日時.mp4）
CURRENT_FILE = UPLOAD_DIR / "current.json"  # 今の解析対象にしたアップロード動画の名前。なければ v5デモ


def current_video(upload_dir: Path | None = None) -> Path:
    """今の作業動画。アップロードして選んだ動画があればそれ、なければ v5デモ（INPUT_VIDEO）。"""
    d = upload_dir or UPLOAD_DIR
    try:
        name = json.loads((d / "current.json").read_text(encoding="utf-8")).get("video")
    except (OSError, ValueError):
        return INPUT_VIDEO
    p = d / name if name else None
    return p if p is not None and p.exists() else INPUT_VIDEO


def set_current_video(video: Path | None, upload_dir: Path | None = None) -> None:
    """アップロードした動画を今の作業動画にする。None なら v5デモに戻す（アップロード済みの動画と解析結果は消さない）。"""
    d = upload_dir or UPLOAD_DIR
    if video is None:
        (d / "current.json").unlink(missing_ok=True)
        return
    d.mkdir(parents=True, exist_ok=True)
    (d / "current.json").write_text(json.dumps({"video": video.name}, ensure_ascii=False), encoding="utf-8")

# 画面が使う保存済みの解析結果（各フォルダの最新）と、動画名の記録場所
ANALYSES = [
    {"kind": "transcript", "label": "文字起こし（説明音声）", "step": 1, "dir": "transcripts", "glob": "transcript_*.json",
     "engine": "ローカルのWhisper（課金なし）", "command": r".venv\Scripts\python app\scripts\run_transcription.py"},
    {"kind": "observation", "label": "観測テキスト（映像）", "step": 1, "dir": "observations", "glob": "observation_*.json",
     "engine": "Claude（課金あり）", "command": r".venv\Scripts\python app\scripts\run_observation.py --v2"},
    {"kind": "extraction", "label": "業務定義・ワークフローの抽出", "step": 2, "dir": "extractions", "glob": "extraction_*.json",
     "engine": "Claude（課金あり）", "command": r".venv\Scripts\python app\scripts\run_extraction.py --v2"},
    {"kind": "task_structure", "label": "作業のタスク構造", "step": 1, "dir": "task_structures", "glob": "tasks_*.json",
     "engine": "Claude（課金あり）", "command": r".venv\Scripts\python app\scripts\run_task_structure.py"},
    {"kind": "hardware_selection", "label": "ハードウェアの仮選定", "step": 3, "dir": "hardware_selections", "glob": "hardware_*.json",
     "engine": "Claude（課金あり）", "command": r".venv\Scripts\python app\scripts\run_hardware_selection.py"},
]


def _ffmpeg() -> str:
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


@lru_cache(maxsize=8)
def _probe(path: str, mtime: float) -> dict:
    """ffmpeg のヘッダ情報から長さ・解像度・音声の有無を読む（動画は解読しない）。"""
    try:
        err = subprocess.run([_ffmpeg(), "-hide_banner", "-i", path], capture_output=True, text=True,
                             encoding="utf-8", errors="replace", timeout=20).stderr
    except (OSError, subprocess.SubprocessError):
        return {}
    out: dict = {}
    m = re.search(r"Duration: (\d+):(\d+):([\d.]+)", err)
    if m:
        out["duration_s"] = round(int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3)), 2)
    v = re.search(r"Video: .*?, (\d{3,5})x(\d{3,5})", err)
    if v:
        out["resolution"] = f"{v.group(1)}×{v.group(2)}"
    fps = re.search(r"([\d.]+) fps", err)
    if fps:
        out["fps"] = float(fps.group(1))
    out["has_audio"] = "Audio:" in err
    return out


def video_info(video: Path | None = None) -> dict:
    p = video or current_video()
    if not p.exists():
        return {"file": p.name, "exists": False}
    st = p.stat()
    return {"file": p.name, "exists": True, "size_mb": round(st.st_size / 1e6, 1), **_probe(str(p), st.st_mtime)}


def _record_video(kind: str, rec: dict) -> str | None:
    """解析結果の記録に残っている入力動画のファイル名（記録がなければ None）。"""
    if kind in ("transcript", "observation"):
        return rec.get("video")
    if kind == "extraction":
        inputs = rec.get("inputs") or {}
        return (inputs.get("observations") or {}).get("video") or (inputs.get("explanation") or {}).get("video")
    return (rec.get("source") or {}).get("video")


def latest_for(kind: str, video: Path | None = None, media: Path | None = None,
               directory: Path | None = None) -> tuple[Path, dict] | None:
    """その種類の保存済み結果のうち、記録された動画名が今の動画と同じ最新のもの（なければ None）。"""
    a = next(x for x in ANALYSES if x["kind"] == kind)
    name = (video or current_video()).name
    for f in sorted((directory or (media or MEDIA) / a["dir"]).glob(a["glob"]), reverse=True):
        rec = json.loads(f.read_text(encoding="utf-8"))
        if kind == "extraction" and (rec.get("meta") or {}).get("scenario") != "v2":
            continue  # 画面が使うのはシナリオv2の抽出
        if _record_video(kind, rec) == name:
            return f, rec
    return None


def analysis_status(video: Path | None = None, media: Path | None = None) -> dict:
    """今の作業動画から作った解析結果が、種類ごとにあるか（画面は今の動画の結果だけを表示する）。"""
    name = (video or current_video()).name
    rows = []
    for a in ANALYSES:
        hit = latest_for(a["kind"], video or current_video(), media)
        row = {k: a[k] for k in ("kind", "label", "step", "engine", "command")}
        if hit is None:
            rows.append({**row, "status": "missing", "file": None, "created_at": None, "model": None, "video": None})
            continue
        f, rec = hit
        meta = rec.get("meta") or {}
        rows.append({**row, "file": f.name, "created_at": rec.get("created_at"), "video": name,
                     "model": meta.get("model") or rec.get("model"), "status": "ok"})
    return {"video": name, "items": rows, "ok": all(r["status"] == "ok" for r in rows),
            "mismatch": [], "missing": [r["label"] for r in rows if r["status"] == "missing"]}
