"""Step 2：動画のアップロードと「解析開始」（既存の解析処理を順に呼ぶ）。Claudeは呼ばず、処理を差し替えて確かめる。"""
import subprocess
import time

import imageio_ffmpeg
import pytest
from fastapi.testclient import TestClient

from backend import analysis_job, inputs
from backend.ai import extraction, hardware_selection, task_structure
from backend.api.app import app


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setattr(inputs, "UPLOAD_DIR", tmp_path / "uploads")
    monkeypatch.setattr(extraction, "RECORD_DIR", tmp_path / "ext")
    monkeypatch.setattr(hardware_selection, "RECORD_DIR", tmp_path / "hw")
    monkeypatch.setattr(task_structure, "RECORD_DIR", tmp_path / "tasks")
    monkeypatch.setattr(analysis_job, "_status", dict(analysis_job._status, state="idle", error=None))
    return TestClient(app)


def wait_done() -> dict:
    for _ in range(100):
        s = analysis_job.status()
        if s["state"] != "running":
            return s
        time.sleep(0.02)
    raise AssertionError("終わらない")


def test_runs_existing_steps_in_order_and_stops_on_failure():
    called = []
    steps = [(n, lambda n=n: called.append(n)) for n in analysis_job.STAGES]
    assert analysis_job.start(inputs.INPUT_VIDEO, "", steps)
    assert wait_done()["state"] == "done" and called == analysis_job.STAGES

    def boom():
        raise RuntimeError("APIエラー")
    called.clear()
    steps = [("文字起こし", lambda: called.append("t")), ("動画の観測", boom), ("タスク構造", lambda: called.append("x"))]
    analysis_job.start(inputs.INPUT_VIDEO, "", steps)
    s = wait_done()
    assert s["state"] == "error" and "動画の観測で失敗しました" in s["error"] and called == ["t"]  # 失敗したら先へ進まない


def test_analyze_api(client, monkeypatch):
    got = {}
    monkeypatch.setattr(analysis_job, "_steps", lambda v, sup: [("文字起こし", lambda: got.update(video=v.name, sup=sup))])
    r = client.post("/api/v2/analyze", json={"supplement": "重い箱は15kg以上"})
    assert r.status_code == 200 and r.json()["state"] in ("running", "done")  # 差し替えた処理はすぐ終わる
    wait_done()
    assert got == {"video": inputs.INPUT_VIDEO.name, "sup": "重い箱は15kg以上"}
    assert client.get("/api/v2/analyze").json()["state"] == "done"


def test_supplement_is_added_only_when_given():
    """補足がなければ従来と同じ入力。あれば「未検証の補足」として加える。"""
    obs, sp = [{"id": "O1", "t": "0:01", "text": "箱"}], [{"id": "S1", "start": 1.0, "end": 2.0, "text": "重い"}]
    assert task_structure.build_user_content(obs, sp) == task_structure.build_user_content(obs, sp, "  ")
    assert "利用者の補足（未検証）" in task_structure.build_user_content(obs, sp, "重い箱は15kg以上")
    base = {"attributes": {}, "explanation": {"source_type": "spoken_instruction"}, "observations": {}}
    assert "利用者の補足" not in extraction.build_user_content(base, {})
    assert "15kg" in extraction.build_user_content({**base, "supplement": {"text": "重い箱は15kg以上"}}, {})


def test_upload_rejects_non_video(client, tmp_path):
    assert client.post("/api/v2/video?name=a.txt", content=b"x").status_code == 422
    r = client.post("/api/v2/video?name=a.mp4", content=b"not a video")
    assert r.status_code == 422 and "読めません" in r.json()["detail"]["message"]
    assert not list((tmp_path / "uploads").glob("upload_*.mp4"))  # 受け付けない動画は残さない
    assert client.get("/api/v2/state").json()["inputs"]["is_demo"]


def test_upload_makes_it_current_and_reset_returns_to_demo(client, tmp_path):
    src = tmp_path / "in.mp4"
    subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), "-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=gray:s=160x90:d=1",
                    "-f", "lavfi", "-i", "sine=d=1", "-shortest", "-pix_fmt", "yuv420p", str(src)], check=True)
    r = client.post("/api/v2/video?name=work.mp4", content=src.read_bytes())
    assert r.status_code == 200 and not r.json()["is_demo"] and r.json()["video"]["has_audio"]
    st = client.get("/api/v2/state").json()
    name = st["inputs"]["video"]["file"]
    assert name.startswith("upload_") and name[:-4] in st["video_url"]
    assert st["tasks"] is None and st["selection"] is None and st["extraction"] is None  # v5の結果は表示しない
    assert set(st["inputs"]["analysis"]["missing"]) and client.get("/api/media/input_video.mp4").status_code == 200
    assert client.delete("/api/v2/video").json()["is_demo"]
    assert (tmp_path / "uploads" / name).exists()  # 戻してもアップロードした動画は消さない
