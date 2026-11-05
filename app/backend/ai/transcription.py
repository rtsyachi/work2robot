"""動画の音声→文字起こし（docs/DEMO_INPUT.md「説明は音声で動画に入れる」）。

ローカルのWhisper（faster-whisper）で入力動画の音声を文字起こしし、時刻付きのセグメントにする。
根拠の種類は spoken_instruction。時刻は動画の時間軸（解析用の元動画）。
台本（tools/demo_video/script_v2.json）や評価用データは読まない。課金なし（ローカル実行）。
"""
from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable, Iterable

from .observation import fmt_time

ROOT = Path(__file__).resolve().parents[2]
RECORD_DIR = ROOT.parent / "local_media" / "transcripts"
DEFAULT_MODEL = "medium"  # small では「荷崩れ」「レンガ積み」を誤認識した（2026-11-03、仮の音声）


# 物流の積付で一般的に使う用語の一覧（認識の手がかり）。台本の文ではなく、用語だけを与える。
GLOSSARY = ["カゴ車", "積付", "荷崩れ", "レンガ積み", "偏荷重", "上積み厳禁", "重心", "はみ出し", "オーバーハング", "段ボール"]
GLOSSARY_PROMPT = "物流センターでの積付作業の説明。用語：" + "、".join(GLOSSARY) + "。"


class TranscriptionError(Exception):
    pass


PAUSE_SPLIT_S = 1.5  # これより長い無音で発話を分ける


def _utterances(segs: Iterable[Any]) -> list[tuple[float, float, str]]:
    """Whisperのセグメントを発話（開始, 終了, 文）に整える。単語の時刻があれば、
    長い無音で区切り、区間を最初と最後の単語に合わせる（無音を発話の時間に含めない）。"""
    out: list[tuple[float, float, str]] = []
    for s in segs:
        words = [w for w in (getattr(s, "words", None) or []) if getattr(w, "word", "").strip()]
        if not words:
            out.append((float(s.start), float(s.end), s.text))
            continue
        cur = [words[0]]
        for w in words[1:]:
            if float(w.start) - float(cur[-1].end) > PAUSE_SPLIT_S:
                out.append((float(cur[0].start), float(cur[-1].end), "".join(x.word for x in cur)))
                cur = []
            cur.append(w)
        out.append((float(cur[0].start), float(cur[-1].end), "".join(x.word for x in cur)))
    return out


def _decode_audio(video: Path, rate: int = 16000):
    """動画の音声を16kHzモノラルの波形にする（ffmpegで変換。PyAVの版の違いに依存しない）。"""
    import subprocess

    import imageio_ffmpeg
    import numpy as np

    out = subprocess.run(
        [imageio_ffmpeg.get_ffmpeg_exe(), "-loglevel", "error", "-i", str(video), "-vn", "-ac", "1",
         "-ar", str(rate), "-f", "s16le", "-"],
        check=True, capture_output=True,
    ).stdout
    return np.frombuffer(out, dtype=np.int16).astype(np.float32) / 32768.0


def speech_regions(audio, rate: int = 16000, frame_s: float = 0.03, below_peak_db: float = 35.0,
                   min_len_s: float = 0.3) -> list[list[float]]:
    """音量で発話の区間（秒）を見つける。最大音量から below_peak_db 以内のフレームを発話とし、
    PAUSE_SPLIT_S より短い無音はつなぐ。"""
    import numpy as np

    n = int(rate * frame_s)
    frames = len(audio) // n
    if frames == 0:
        return []
    rms = np.sqrt(np.mean(audio[:frames * n].reshape(frames, n) ** 2, axis=1)) + 1e-9
    db = 20 * np.log10(rms)
    active = db > db.max() - below_peak_db
    regions: list[list[float]] = []
    for i in np.flatnonzero(active):
        s, e = i * frame_s, (i + 1) * frame_s
        if regions and s - regions[-1][1] < PAUSE_SPLIT_S:
            regions[-1][1] = e
        else:
            regions.append([s, e])
    return [r for r in regions if r[1] - r[0] >= min_len_s]


def _whisper_segments(video: Path, model_size: str) -> tuple[Iterable[Any], dict]:
    from faster_whisper import WhisperModel  # 重いので使うときだけ読み込む

    audio = _decode_audio(video)
    if audio.size == 0:
        raise TranscriptionError("入力動画に音声がありません")
    model = WhisperModel(model_size, device="cpu", compute_type="int8")
    # 発話の区間を先に見つけ、1区間ずつ文字起こしする。動画全体を一度に渡すと、長い無音の後の
    # 発話の頭が抜けたり（Whisper標準の区間検出）、無音に存在しない文が出たり（区間検出なし）した（2026-11-03）
    rate, pad = 16000, 0.3
    regions = speech_regions(audio, rate)
    segments = []
    for s, e in regions:
        a, b = max(0.0, s - pad), min(len(audio) / rate, e + pad)
        segs, _ = model.transcribe(audio[int(a * rate):int(b * rate)], language="ja", vad_filter=False,
                                   beam_size=5, word_timestamps=True, initial_prompt=GLOSSARY_PROMPT)
        for seg in segs:
            words = [SimpleNamespace(start=w.start + a, end=w.end + a, word=w.word) for w in (seg.words or [])]
            segments.append(SimpleNamespace(start=seg.start + a, end=seg.end + a, text=seg.text, words=words))
    info = {"language": "ja", "duration": round(len(audio) / rate, 2), "glossary": GLOSSARY,
            "speech_regions": [[round(s, 2), round(e, 2)] for s, e in regions]}
    return segments, info


def transcribe_video(
    video: Path,
    *,
    model_size: str = DEFAULT_MODEL,
    runner: Callable[[Path, str], tuple[Iterable[Any], dict]] | None = None,
    voice_note: str | None = None,
) -> dict:
    """入力動画の音声を時刻付きの説明セグメント（S1, S2, ...）にする。"""
    if not video.exists():
        raise TranscriptionError(f"入力動画がありません: {video.name}")
    segs, info = (runner or _whisper_segments)(video, model_size)
    segments = []
    for start, end, text in _utterances(segs):
        text = text.strip()
        if not text:
            continue
        segments.append({
            "id": f"S{len(segments) + 1}",
            "t": fmt_time(start),
            "start": round(start, 2),
            "end": round(end, 2),
            "text": text,
        })
    if not segments:
        raise TranscriptionError("音声から説明を文字起こしできませんでした")
    return {
        "source_type": "spoken_instruction",
        "note": "入力動画の音声をローカルのWhisperで文字起こしした説明。時刻は動画の時刻。誤認識を含むことがある。",
        "voice_note": voice_note,
        "video": video.name,
        "model": f"faster-whisper {model_size}",
        "segments": segments,
        "meta": info,
    }


def save_transcript(tr: dict, directory: Path | None = None) -> Path:
    directory = directory or RECORD_DIR
    directory.mkdir(parents=True, exist_ok=True)
    tr = {"created_at": datetime.now().astimezone().isoformat(timespec="seconds"), **tr}
    path = directory / f"transcript_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    path.write_text(json.dumps(tr, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def latest_transcript(directory: Path | None = None) -> dict | None:
    files = sorted((directory or RECORD_DIR).glob("transcript_*.json"))
    if not files:
        return None
    tr = json.loads(files[-1].read_text(encoding="utf-8"))
    tr["record_file"] = files[-1].name
    return tr
