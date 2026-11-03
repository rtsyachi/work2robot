"""動画→観測テキスト変換（docs/ARCHITECTURE.md「観測」）。

入力動画から一定間隔でフレームを取り出し、Claudeの画像入力で「目に見える事実」だけを
時刻付きの観測テキストにする。重量・中身・意図など見えないことは書かせない。
動画生成用の台本・シーン定義（tools/demo_video/）や評価用データは読まない。
"""
from __future__ import annotations

import base64
import json
import subprocess
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any

import imageio_ffmpeg

from .client import MODEL

ROOT = Path(__file__).resolve().parents[2]
VIDEO_PATH = ROOT / "data" / "demo_input" / "work_video.mp4"
RECORD_DIR = ROOT / "local_media" / "observations"

SYSTEM_PROMPT = """あなたは作業動画の観測者です。時刻付きのフレーム画像の列から、目に見える事実だけを時刻付きの短い日本語の文にします。この観測テキストは、後で業務ワークフローを作るための根拠として使われます。

- 1つの動作や状態の変化ごとに1つのセグメントにする。最初の状態（何がどこにあるか）と、最後の状態（どこに何が積まれたか）も書く。
- 誰が、どの荷物（タグの文字・形・色・材質の見た目）を、どこから、どこへ（カゴ車の下段／上段、左右、どの荷物の上か）、どのように（持ち上げた高さ、止めた、ゆっくり下ろした、上から押さえた／押さえなかった など）動かしたかを書く。
- タグやラベルの文字は、読み取れた場合だけ書く。
- 重さ、中身、作業者の意図など、映像から確定できないことは書かない。推測しない。
- t はそのセグメントの開始時刻（フレームの時刻、MM:SS）。画面右上の時刻表示と、画面左上の透かしの文言は観測対象にしない。
- objects には、そのセグメントで動かした・触れた荷物のタグの文字（例: "A"）を入れる。最初と最後の状態のセグメントは空配列にする。タグが読めなければ空配列。
- 映像から判断できなかったことは uncertain に書く。"""

OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "segments": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "t": {"type": "string"},
                    "text": {"type": "string"},
                    "objects": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["t", "text", "objects"],
                "additionalProperties": False,
            },
        },
        "uncertain": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["segments", "uncertain"],
    "additionalProperties": False,
}


class ObservationError(Exception):
    pass


def fmt_time(seconds: float) -> str:
    s = int(round(seconds))
    return f"{s // 60:02d}:{s % 60:02d}"


def extract_frames(video: Path = VIDEO_PATH, fps: float = 1.0, width: int = 768) -> list[tuple[str, bytes]]:
    """動画から fps 間隔でJPEGフレームを取り出す。戻り値は（時刻, 画像）の列。"""
    if not video.exists():
        raise ObservationError(f"入力動画がありません: {video.name}")
    exe = imageio_ffmpeg.get_ffmpeg_exe()
    with tempfile.TemporaryDirectory() as d:
        subprocess.run(
            [exe, "-loglevel", "error", "-i", str(video), "-vf", f"fps={fps},scale={width}:-2",
             "-q:v", "4", str(Path(d) / "f%04d.jpg")],
            check=True,
        )
        files = sorted(Path(d).glob("f*.jpg"))
        return [(fmt_time(i / fps), f.read_bytes()) for i, f in enumerate(files)]


def build_content(frames: list[tuple[str, bytes]]) -> list[dict]:
    content: list[dict] = [{"type": "text", "text": f"作業動画のフレーム {len(frames)} 枚（1秒ごと）です。観測テキストを作ってください。"}]
    for t, data in frames:
        content.append({"type": "text", "text": f"t={t}"})
        content.append({"type": "image", "source": {
            "type": "base64", "media_type": "image/jpeg", "data": base64.standard_b64encode(data).decode("ascii"),
        }})
    return content


def observe_video(client: Any, video: Path = VIDEO_PATH, *, fps: float = 1.0, effort: str = "high") -> dict:
    """入力動画から観測テキスト（抽出モジュールへの入力形式）を作る。"""
    frames = extract_frames(video, fps)
    with client.beta.messages.stream(
        model=MODEL,
        max_tokens=32000,
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
        system=SYSTEM_PROMPT,
        output_config={"effort": effort, "format": {"type": "json_schema", "schema": OUTPUT_SCHEMA}},
        messages=[{"role": "user", "content": build_content(frames)}],
    ) as stream:
        msg = stream.get_final_message()
    if msg.stop_reason == "refusal":
        raise ObservationError("Claudeが応答を拒否しました")
    if msg.stop_reason == "max_tokens":
        raise ObservationError("出力が上限で途切れました")
    raw = json.loads("".join(b.text for b in msg.content if b.type == "text"))
    segments = [{"id": f"O{i + 1}", "t": s["t"], "text": s["text"], "objects": s["objects"]}
                for i, s in enumerate(raw["segments"])]
    if not segments:
        raise ObservationError("観測テキストが空です")
    return {
        "source_type": "video_observation",
        "note": "入力動画（デモ用模擬作業動画）のフレームからClaudeが生成した観測テキスト。時刻は動画の時刻。",
        "video": video.name,
        "fps": fps,
        "frames": len(frames),
        "segments": segments,
        "uncertain": raw["uncertain"],
        "meta": {"model": msg.model, "usage": {"input_tokens": msg.usage.input_tokens,
                                                "output_tokens": msg.usage.output_tokens}},
    }


def save_observation(obs: dict, directory: Path | None = None) -> Path:
    directory = directory or RECORD_DIR
    directory.mkdir(parents=True, exist_ok=True)
    obs = {"created_at": datetime.now().astimezone().isoformat(timespec="seconds"), **obs}
    path = directory / f"observation_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    path.write_text(json.dumps(obs, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def latest_observation(directory: Path | None = None) -> dict | None:
    files = sorted((directory or RECORD_DIR).glob("observation_*.json"))
    if not files:
        return None
    obs = json.loads(files[-1].read_text(encoding="utf-8"))
    obs["record_file"] = files[-1].name
    return obs
