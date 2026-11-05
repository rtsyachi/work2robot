"""音声の文字起こし（backend/ai/transcription.py）。Whisper本体は呼ばず、出力の整形だけを確かめる。"""
from types import SimpleNamespace

import pytest

from backend.ai.transcription import TranscriptionError, latest_transcript, save_transcript, transcribe_video


def fake_runner(segments):
    def run(video, model_size):
        return [SimpleNamespace(start=a, end=b, text=t) for a, b, t in segments], {"language": "ja", "duration": 120.0}
    return run


def test_segments_keep_video_times(tmp_path):
    video = tmp_path / "v.mp4"
    video.write_bytes(b"x")
    tr = transcribe_video(video, runner=fake_runner([(0.6, 4.9, " 重い箱は下に "), (45.1, 52.0, "レンガ積みにしています"), (60, 61, "  ")]))
    assert tr["source_type"] == "spoken_instruction"
    assert [s["id"] for s in tr["segments"]] == ["S1", "S2"]
    assert tr["segments"][0] == {"id": "S1", "t": "00:01", "start": 0.6, "end": 4.9, "text": "重い箱は下に"}
    assert tr["segments"][1]["t"] == "00:45"


def test_long_pause_splits_and_trims_silence(tmp_path):
    video = tmp_path / "v.mp4"
    video.write_bytes(b"x")
    w = lambda a, b, t: SimpleNamespace(start=a, end=b, word=t)  # noqa: E731
    seg = SimpleNamespace(start=10.0, end=84.0, text="荷崩れしにくいようにですね。こっちに重さが",
                          words=[w(50.8, 51.5, "荷崩れ"), w(51.5, 52.5, "しにくいようにですね。"),
                                 w(80.4, 81.0, "こっちに"), w(81.0, 82.0, "重さが")])
    tr = transcribe_video(video, runner=lambda v, m: ([seg], {}))
    assert [(s["start"], s["end"], s["text"]) for s in tr["segments"]] == [
        (50.8, 52.5, "荷崩れしにくいようにですね。"), (80.4, 82.0, "こっちに重さが")]


def test_speech_regions_by_loudness():
    import numpy as np

    from backend.ai.transcription import speech_regions

    rate = 16000
    t = np.arange(rate) / rate
    quiet_start = 0.05 * np.sin(2 * np.pi * 200 * t)   # 小さめの声で始まる発話
    loud = 0.5 * np.sin(2 * np.pi * 200 * t)
    silence = np.zeros(rate * 3)
    audio = np.concatenate([silence, quiet_start, loud, silence, loud, np.zeros(rate)]).astype(np.float32)
    regions = speech_regions(audio, rate)
    assert len(regions) == 2
    assert abs(regions[0][0] - 3.0) < 0.05 and abs(regions[0][1] - 5.0) < 0.05  # 小さい頭も含める
    assert abs(regions[1][0] - 8.0) < 0.05


def test_empty_or_missing_video_is_error(tmp_path):
    with pytest.raises(TranscriptionError):
        transcribe_video(tmp_path / "none.mp4", runner=fake_runner([]))
    video = tmp_path / "v.mp4"
    video.write_bytes(b"x")
    with pytest.raises(TranscriptionError):
        transcribe_video(video, runner=fake_runner([(0, 1, " ")]))


def test_save_and_latest(tmp_path):
    video = tmp_path / "v.mp4"
    video.write_bytes(b"x")
    tr = transcribe_video(video, runner=fake_runner([(1, 2, "完了です")]), voice_note="仮の音声")
    save_transcript(tr, tmp_path)
    got = latest_transcript(tmp_path)
    assert got["segments"][0]["text"] == "完了です"
    assert got["voice_note"] == "仮の音声"
