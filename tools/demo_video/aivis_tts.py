"""AivisSpeech Engine（http://127.0.0.1:10101）で日本語の音声を作る小さな補助。

  synth(text, style_id, speed=1.0, ...) -> bytes（WAV）
text には読み上げ用の文字列（英字・型番をカタカナにしたもの）を渡す。表示・字幕用の文とは分けて管理する。
"""
from __future__ import annotations

import io
import json
import urllib.parse
import urllib.request
import wave

ENGINE = "http://127.0.0.1:10101"


def _post(path: str, params: dict, body: bytes | None = None, ctype: str = "application/json") -> bytes:
    url = f"{ENGINE}{path}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, data=body if body is not None else b"", method="POST", headers={"Content-Type": ctype})
    with urllib.request.urlopen(req, timeout=300) as r:
        return r.read()


def synth(text: str, style_id: int, speed: float = 1.0, intonation: float = 1.0, tempo_dynamics: float = 1.0,
          volume: float = 1.0, pre: float = 0.05, post: float = 0.1, rate: int = 48000) -> bytes:
    q = json.loads(_post("/audio_query", {"text": text, "speaker": style_id}))
    q.update(speedScale=speed, intonationScale=intonation, tempoDynamicsScale=tempo_dynamics, volumeScale=volume,
             prePhonemeLength=pre, postPhonemeLength=post, outputSamplingRate=rate, outputStereo=False, kana=text)
    return _post("/synthesis", {"speaker": style_id}, json.dumps(q, ensure_ascii=False).encode("utf-8"))


def wav_duration(data: bytes) -> float:
    with wave.open(io.BytesIO(data)) as w:
        return w.getnframes() / w.getframerate()
