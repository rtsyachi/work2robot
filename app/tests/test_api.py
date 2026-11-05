"""APIのテスト。判定ロジックは実行器のテストで確認済みなので、受け渡しの正しさを見る。"""
import pytest
from fastapi.testclient import TestClient

from backend.api.app import app
from backend.workflow import run_workflow
from conftest import node


@pytest.fixture
def client():
    return TestClient(app)


def test_fixtures_are_labeled_as_handwritten(client):
    body = client.get("/api/demo/fixtures").json()
    assert "Claudeが生成した結果ではありません" in body["notice"]
    assert body["workflow"]["workflow_id"] == "cage_loading_fixture"
    assert [o["object_id"] for o in body["objects"]] == ["A", "B", "C", "D", "E"]
    assert body["catalog"]["skills"][0]["name"] == "pick_place"


def test_validate(client, workflow):
    assert client.post("/api/workflows/validate", json={"workflow": workflow}).json()["ok"] is True
    del node(workflow, "is_large")["on_unknown"]
    body = client.post("/api/workflows/validate", json={"workflow": workflow}).json()
    assert body["ok"] is False and body["errors"][0]["node_id"] == "is_large"


def test_run_returns_same_trace_as_executor(client, workflow, catalog, objects):
    res = client.post("/api/workflows/run", json={"workflow": workflow, "object": objects["B"]})
    assert res.status_code == 200
    assert res.json() == run_workflow(workflow, objects["B"], catalog)


def test_run_rejects_invalid_workflow(client, workflow, objects):
    node(workflow, "is_large")["operator"] = "python_eval"
    res = client.post("/api/workflows/run", json={"workflow": workflow, "object": objects["A"]})
    assert res.status_code == 422
    assert res.json()["detail"]["errors"][0]["code"] == "invalid_operator"


def test_run_requires_object(client, workflow):
    assert client.post("/api/workflows/run", json={"workflow": workflow}).status_code == 422


def test_job_run(client, workflow):
    fx = client.get("/api/demo/fixtures").json()
    assert fx["job"]["job_id"] == "cage_cart_loading" and fx["level1"]["nodes"][0]["id"] == "l1_start"
    t = client.post("/api/jobs/run", json={"workflow": workflow, "batch_id": "mixed_batch"}).json()
    assert t["order"] == ["A", "B", "C", "E", "D"] and t["end"]["placed"] == 5
    assert client.post("/api/jobs/run", json={"workflow": workflow, "batch_id": "nope"}).status_code == 404
    del node(workflow, "is_large")["on_unknown"]
    assert client.post("/api/jobs/run", json={"workflow": workflow, "batch_id": "video_batch"}).status_code == 422


def test_readiness(client, workflow):
    t = client.post("/api/jobs/run", json={"workflow": workflow, "batch_id": "mixed_batch"}).json()
    r = client.post("/api/readiness", json={"workflow": workflow, "job_trace": t}).json()
    assert r["counts"]["requires_human"] == 1 and r["categories"]["needs_physical_poc"]


def test_demo_inputs(client):
    body = client.get("/api/demo/inputs").json()
    assert body["explanation"]["source_type"] == "provided_text"
    assert [s["id"] for s in body["observations"]["segments"]][0] == "O1"


def test_extract_saves_and_returns_live_result(client, workflow, monkeypatch, tmp_path):
    from backend.api import app as app_module
    from backend.ai import extraction as ex
    from test_extraction import FakeClient, flat_output, message
    import json

    monkeypatch.setattr(ex, "RECORD_DIR", tmp_path)
    monkeypatch.setattr(app_module, "make_client",
                        lambda: FakeClient(message(json.dumps(flat_output(workflow)))))
    assert client.get("/api/extract/latest").status_code == 404
    live = client.post("/api/extract", json={"observations": "dev"}).json()
    assert live["source"] == "live" and live["validation"]["ok"]
    assert "raw_outputs" not in live and set(live["inputs"]) == {"explanation", "observations"}
    assert live["job"]["order_rule"]["zones"] == ["bottom", "top"]
    saved = client.get("/api/extract/latest").json()
    assert saved["source"] == "saved" and saved["workflow"] == live["workflow"]


def test_extract_reports_failure(client, monkeypatch, tmp_path):
    from backend.api import app as app_module
    from backend.ai import extraction as ex
    from test_extraction import FakeClient, message

    monkeypatch.setattr(ex, "RECORD_DIR", tmp_path)
    monkeypatch.setattr(app_module, "make_client", lambda: FakeClient(message("", stop_reason="refusal")))
    res = client.post("/api/extract", json={"observations": "dev"})
    assert res.status_code == 502 and "拒否" in res.json()["detail"]["message"]


def test_extract_from_video_needs_observation(client, monkeypatch, tmp_path):
    from backend.ai import observation as ob

    monkeypatch.setattr(ob, "RECORD_DIR", tmp_path)
    res = client.post("/api/extract", json={"observations": "video"})
    assert res.status_code == 409 and "観測" in res.json()["detail"]["message"]
    assert client.get("/api/observe/latest").status_code == 404


def test_work_video_is_served(client):
    res = client.get("/api/media/work_video.mp4")
    assert res.status_code == 200 and res.headers["content-type"] == "video/mp4"
