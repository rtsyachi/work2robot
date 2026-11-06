"""保存したロボット構成（Step 4 で保存 → Step 5 で選ぶ）。"""
import pytest
from fastapi.testclient import TestClient

from backend import inputs
from backend import robot_configs as rc
from backend.ai import extraction, hardware_selection, task_structure
from backend.api.app import app
from backend.workflow import masters


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setattr(rc, "CONFIG_DIR", tmp_path / "robot_configs")
    monkeypatch.setattr(inputs, "UPLOAD_DIR", tmp_path / "uploads")
    monkeypatch.setattr(extraction, "RECORD_DIR", tmp_path / "ext")
    monkeypatch.setattr(hardware_selection, "RECORD_DIR", tmp_path / "hw")
    monkeypatch.setattr(task_structure, "RECORD_DIR", tmp_path / "tasks")
    monkeypatch.setattr(masters, "REGISTERED_DIR", tmp_path / "masters")
    return TestClient(app)


RM20 = {"product_id": "rm_20", "end_effector": "vacuum_gripper", "sensors": ["rgb_camera", "depth_camera"], "peripherals": []}


def test_save_list_and_delete(client):
    assert client.get("/api/v2/robot-configs").json() == []  # Claudeの仮選定もまだない
    r = client.post("/api/v2/robot-configs", json={"name": "RM-20 複合ハンド", "config": RM20})
    assert r.status_code == 200 and r.json()["name"] == "RM-20 複合ハンド"
    listed = client.get("/api/v2/robot-configs").json()
    assert [c["name"] for c in listed] == ["RM-20 複合ハンド"] and listed[0]["config"] == RM20
    # 保存した構成で実行できる（Step 5）
    run = client.post("/api/v2/run", json={"config": {**listed[0]["config"], "label": listed[0]["name"]}, "batch_id": "video_batch"})
    assert run.status_code == 200 and run.json()["job"]["end"]["placed"] + run.json()["job"]["end"]["handed_off"] == 17
    assert client.delete(f"/api/v2/robot-configs/{listed[0]['id']}").json()["ok"]
    assert client.get("/api/v2/robot-configs").json() == []


def test_invalid_configs_are_not_saved(client):
    assert client.post("/api/v2/robot-configs", json={"name": "", "config": RM20}).status_code == 422
    bad = {**RM20, "end_effector": "parallel_gripper"}  # RM-20 では選べない手先
    r = client.post("/api/v2/robot-configs", json={"name": "x", "config": bad})
    assert r.status_code == 422 and "選べない" in r.json()["detail"]["message"]
    assert client.delete("/api/v2/robot-configs/claude").status_code == 422


def test_claude_selection_is_listed_first(client):
    hardware_selection.save_selection({"config": {"product_id": "aw_40f", "base": "fixed_pedestal", "arm": "arm_heavy",
                                                  "end_effector": "vacuum_gripper", "sensors": ["rgb_camera"], "peripherals": []},
                                       "meta": {}, "source": {"extraction": "x.json", "video": inputs.INPUT_VIDEO.name}})
    client.post("/api/v2/robot-configs", json={"name": "比較用", "config": RM20})
    listed = client.get("/api/v2/robot-configs").json()
    # Claudeの仮選定は保存ファイル名（hardware_日時）で識別し、選定に使ったワークフローの版を持つ。削除はできない
    assert listed[0]["id"].startswith("hardware_") and listed[0]["readonly"] and "AW-40F" in listed[0]["name"]
    assert listed[0]["basis"]["workflow_id"] == "x.json"
    assert listed[0]["config"]["product_id"] == "aw_40f" and listed[1]["name"] == "比較用"
    assert client.delete(f"/api/v2/robot-configs/{listed[0]['id']}").status_code == 422


def test_config_records_basis_and_runs_are_traceable(client):
    """保存した構成は選定時のシナリオ・ワークフローの版・出荷予定と照合の件数を持ち、実行結果はそれらで追跡できる。"""
    sc = client.get("/api/v2/state").json()
    assert sc["scenario"]["scenario_id"] == "sc_cage_cart_loading" and sc["refs"]["batch_id"] == "video_batch"
    saved = client.post("/api/v2/robot-configs", json={"name": "RM-20", "config": RM20, "batch_id": "alt_batch"}).json()
    b = saved["basis"]
    assert b["scenario_id"] == "sc_cage_cart_loading" and b["batch_id"] == "alt_batch" and set(b["counts"]) >= {"ok", "ng", "unknown"}
    # 出荷予定を変えても同じシナリオ（IDは変わらない）
    assert client.put("/api/v2/scenario", json={"batch_id": "alt_batch"}).json()["scenario_id"] == "sc_cage_cart_loading"
    assert client.get("/api/v2/state").json()["refs"]["batch_id"] == "alt_batch"
    assert client.put("/api/v2/scenario", json={"batch_id": "nope"}).status_code == 404
    # Step 2：シナリオの名前を付け直せる（IDは変わらない）
    renamed = client.put("/api/v2/scenario", json={"name": "カゴ車積付（A拠点）"}).json()
    assert renamed["name"] == "カゴ車積付（A拠点）" and renamed["scenario_id"] == "sc_cage_cart_loading" and renamed["batch_id"] == "alt_batch"
    assert client.put("/api/v2/scenario", json={"name": " "}).status_code == 422
    # Step 4 の照合と Step 5 の判定は、同じ出荷予定なら同じ要件・同じ結果
    chk = client.post("/api/v2/check", json={"config": RM20, "batch_id": "alt_batch"}).json()["check"]
    run = client.post("/api/v2/run", json={"config": {**RM20, "label": "RM-20"}, "batch_id": "alt_batch", "robot_config_id": saved["id"]}).json()
    assert run["check"] == chk
    e = run["execution"]
    assert e["robot_config_id"] == saved["id"] and e["batch_id"] == "alt_batch" and e["scenario_id"] == "sc_cage_cart_loading"
    # Step 6 は保存した実行結果を参照できる
    latest = client.get("/api/v2/executions/latest", params={"robot_config_id": saved["id"], "batch_id": "alt_batch"}).json()
    assert latest["execution"]["execution_id"] == e["execution_id"] and latest["job"]["end"] == run["job"]["end"]
    assert client.get("/api/v2/executions/latest", params={"robot_config_id": saved["id"], "batch_id": "video_batch"}).json() is None
