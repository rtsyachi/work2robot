"""動画→観測テキスト変換のテスト。Claude APIは呼ばない。フレーム抽出は実際の入力動画で確かめる。"""
import json

import pytest

from backend.ai import observation as ob
from test_extraction import FakeClient, message


def test_frames_are_extracted_once_per_second():
    frames = ob.extract_frames(fps=1.0)
    assert 20 <= len(frames) <= 30  # 入力動画は約25秒
    assert frames[0][0] == "00:00" and frames[5][0] == "00:05"
    assert frames[0][1][:2] == b"\xff\xd8"  # JPEG


def test_observe_builds_timed_image_request_and_ids():
    out = {"segments": [{"t": "00:00", "text": "空のカゴ車", "objects": []},
                        {"t": "00:02", "text": "箱Aを下段左に置いた", "objects": ["A"]}],
           "uncertain": ["速度は不明"]}
    client = FakeClient(message(json.dumps(out, ensure_ascii=False)))
    obs = ob.observe_video(client, fps=0.5)
    assert obs["source_type"] == "video_observation"
    assert [s["id"] for s in obs["segments"]] == ["O1", "O2"]
    assert obs["segments"][1]["objects"] == ["A"]
    content = client.calls[0]["messages"][0]["content"]
    assert content[1] == {"type": "text", "text": "t=00:00"}
    assert content[2]["type"] == "image" and content[2]["source"]["media_type"] == "image/jpeg"


def test_missing_video_is_an_error(tmp_path):
    with pytest.raises(ob.ObservationError):
        ob.extract_frames(tmp_path / "none.mp4")


def test_refusal_is_an_error():
    with pytest.raises(ob.ObservationError):
        ob.observe_video(FakeClient(message("", stop_reason="refusal")), fps=0.2)
