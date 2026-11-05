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
RECORD_DIR = ROOT.parent / "local_media" / "observations"

SYSTEM_PROMPT = """あなたは作業動画の観測者です。時刻付きのフレーム画像の列から、目に見える事実だけを時刻付きの短い日本語の文にします。この観測テキストは、後で業務ワークフローを作るための根拠として使われます。

- 1つの動作や状態の変化ごとに1つのセグメントにする。最初の状態（何がどこにあるか）と、最後の状態（どこに何が積まれたか）も書く。
- 誰が、どの荷物（タグの文字・形・色・材質の見た目）を、どこから、どこへ（カゴ車の何段目か、左右・奥／手前、どの荷物の上か、カゴ車以外の台など）、どのように（持ち上げた高さ、止めた、ゆっくり下ろした、上から押さえた／押さえなかった など）動かしたかを書く。
- カゴ車に置いた箱の向き（長い辺がカゴ車の幅方向＝横向き、奥行方向＝縦向き）が分かれば書く。
- 作業者が荷物以外（カゴ車の表示、線、周囲）を指したり見回したりした動作も書く。表示の文字が読めればその文字を書く。
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


def build_content(frames: list[tuple[str, bytes]], part: tuple[int, int] | None = None) -> list[dict]:
    head = f"作業動画のフレーム {len(frames)} 枚（1秒ごと）です。観測テキストを作ってください。"
    if part:
        head = (f"作業動画の一部（{part[0]}/{part[1]}、{frames[0][0]}〜{frames[-1][0]}）のフレーム {len(frames)} 枚（1秒ごと）です。"
                "この区間の観測テキストを作ってください。区間の最初の状態と最後の状態も書いてください。")
    content: list[dict] = [{"type": "text", "text": head}]
    for t, data in frames:
        content.append({"type": "text", "text": f"t={t}"})
        content.append({"type": "image", "source": {
            "type": "base64", "media_type": "image/jpeg", "data": base64.standard_b64encode(data).decode("ascii"),
        }})
    return content


def _observe_chunk(client: Any, frames: list[tuple[str, bytes]], part: tuple[int, int] | None,
                   effort: str) -> tuple[dict, Any]:
    with client.beta.messages.stream(
        model=MODEL,
        max_tokens=32000,
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
        system=SYSTEM_PROMPT,
        output_config={"effort": effort, "format": {"type": "json_schema", "schema": OUTPUT_SCHEMA}},
        messages=[{"role": "user", "content": build_content(frames, part)}],
    ) as stream:
        msg = stream.get_final_message()
    if msg.stop_reason == "refusal":
        raise ObservationError("Claudeが応答を拒否しました")
    if msg.stop_reason == "max_tokens":
        raise ObservationError("出力が上限で途切れました")
    return json.loads("".join(b.text for b in msg.content if b.type == "text")), msg


def observe_video(client: Any, video: Path = VIDEO_PATH, *, fps: float = 1.0, effort: str = "high",
                  width: int = 768, chunk: int = 0) -> dict:
    """入力動画から観測テキスト（抽出モジュールへの入力形式）を作る。
    chunk > 0 なら、フレームをその枚数ずつに分けて送り（1回の画像数の上限と精度のため）、時刻順につなぐ。"""
    frames = extract_frames(video, fps, width)
    n = -(-len(frames) // chunk) if chunk > 0 else 1  # 枚数を均等に分ける（端数だけの呼び出しを作らない）
    size = -(-len(frames) // n)
    parts = [frames[i:i + size] for i in range(0, len(frames), size)]
    segments, uncertain, usage, model = [], [], [], None
    for k, fr in enumerate(parts):
        raw, msg = _observe_chunk(client, fr, (k + 1, len(parts)) if len(parts) > 1 else None, effort)
        model = msg.model
        usage.append({"input_tokens": msg.usage.input_tokens, "output_tokens": msg.usage.output_tokens})
        for s in raw["segments"]:
            segments.append({"id": f"O{len(segments) + 1}", "t": s["t"], "text": s["text"], "objects": s["objects"]})
        uncertain.extend(raw["uncertain"])
    if not segments:
        raise ObservationError("観測テキストが空です")
    return {
        "source_type": "video_observation",
        "note": "入力動画（デモ用模擬作業動画）のフレームからClaudeが生成した観測テキスト。時刻は動画の時刻。",
        "video": video.name,
        "fps": fps,
        "frames": len(frames),
        "chunks": len(parts),
        "segments": segments,
        "uncertain": uncertain,
        "meta": {"model": model, "usage": usage[0] if len(usage) == 1 else usage},
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
