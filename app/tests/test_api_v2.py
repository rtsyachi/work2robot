"""v2のAPI（業務の規則・ハードウェア構成）。保存済みのClaude結果がない状態（手書きの業務・構成）で確かめる。"""
import pytest
from fastapi.testclient import TestClient

from backend.ai import extraction, hardware_selection, task_structure
from backend.api.app import app
from backend.workflow import masters


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setattr(extraction, "RECORD_DIR", tmp_path / "ext")
    monkeypatch.setattr(hardware_selection, "RECORD_DIR", tmp_path / "hw")
    monkeypatch.setattr(task_structure, "RECORD_DIR", tmp_path / "tasks")
    monkeypatch.setattr(masters, "REGISTERED_DIR", tmp_path / "masters")
    return TestClient(app)


def test_masters_default_and_register(client):
    m = client.get("/api/v2/masters").json()
    assert m["source"] == "default" and m["validation"]["ok"]
    assert len(m["items"]["items"]) == 18 and m["environment"]["carts"][0]["max_load_kg"] == 150
    # 登録：H1 を重くし、カゴ車の最大積載を下げる → 以降の照合・実行がその値で動く
    items, env = m["items"], m["environment"]
    next(i for i in items["items"] if i["object_id"] == "H1")["weight_kg"] = 25.0
    env["carts"][0]["max_load_kg"] = 100
    saved = client.put("/api/v2/masters", json={"items": items, "environment": env}).json()
    assert saved["source"] == "registered" and saved["updated_at"]
    st = client.get("/api/v2/state").json()
    assert st["masters"]["source"] == "registered"
    h1 = next(o for o in st["objects"] if o["object_id"] == "H1")
    assert h1["attributes"]["weight_kg"]["value"] == 25.0
    run = client.post("/api/v2/run", json={"config_id": "handwritten_medium"}).json()
    assert run["job"]["cart"]["max_load_kg"] == 100
    assert any("積載重量の上限" in (it["handoff_reason"] or "") for it in run["job"]["items"])
    assert any("可搬重量" in (it["handoff_reason"] or "") for it in run["job"]["items"] if it["object_id"] == "H1")
    # 初期値に戻す
    assert client.delete("/api/v2/masters").json()["source"] == "default"
    assert client.post("/api/v2/run", json={"config_id": "handwritten_medium"}).json()["job"]["end"]["placed"] == 17


def test_masters_with_errors_are_not_saved(client):
    m = client.get("/api/v2/masters").json()
    items = m["items"]
    items["items"].append(dict(items["items"][0]))  # ID の重複
    r = client.put("/api/v2/masters", json={"items": items, "environment": m["environment"]})
    assert r.status_code == 422 and any("重複" in e["message"] for e in r.json()["detail"]["errors"])
    assert client.get("/api/v2/masters").json()["source"] == "default"


def test_task_structure_is_returned(client):
    assert client.get("/api/v2/state").json()["tasks"] is None
    task_structure.save_structure({"major_tasks": [], "speech_links": [], "unresolved": [], "duration": 1.0,
                                   "meta": {"model": "m"}, "raw_outputs": ["x"]}, {"observation": "o.json"})
    got = client.get("/api/v2/state").json()["tasks"]
    assert got["source"]["observation"] == "o.json" and "raw_outputs" not in got


def test_state_falls_back_to_handwritten(client):
    s = client.get("/api/v2/state").json()
    assert s["notice"] and s["extraction"] is None and s["selection"] is None
    assert [c["config_id"] for c in s["configs"]] == ["handwritten_medium", "light_vacuum"]
    assert {r["id"] for r in s["requirements"]} >= {"payload", "reach", "grasp_soft_bag"}
    assert len(s["batches"][0]["object_ids"]) == 17


def test_run_with_capable_and_weak_configs(client):
    good = client.post("/api/v2/run", json={"config_id": "handwritten_medium"}).json()
    assert good["job"]["end"]["placed"] == 17 and good["check"]["counts"]["ng"] == 0
    r = good["readiness"]
    assert r["hardware"]["counts"]["unknown"] >= 1
    assert any("ハードウェア（未確認）" in x for x in r["categories"]["needs_physical_poc"])
    assert any("荷崩れ" in x for x in r["categories"]["requires_human"])  # 未対応の規則は人が行う
    weak = client.post("/api/v2/run", json={"config_id": "light_vacuum"}).json()
    assert weak["job"]["end"]["handed_off"] >= 6 and weak["check"]["counts"]["ng"] >= 1
    kinds = {i["kind"] for i in weak["readiness"]["improvements"]}
    assert "hardware" in kinds
    assert "仮説" in weak["readiness"]["improvements_note"]


def test_check_only(client):
    r = client.post("/api/v2/check", json={"config_id": "light_vacuum"}).json()
    assert r["check"]["counts"]["ng"] >= 1 and r["profile"]["payload_kg"] == 9.2
    assert client.post("/api/v2/check", json={"config_id": "nope"}).status_code == 404


def test_custom_config_swaps_parts_and_changes_results(client):
    base = {"product_id": "rm_20", "end_effector": "vacuum_gripper",
            "sensors": ["rgb_camera", "depth_camera", "wrist_force_sensor"], "peripherals": []}
    ok = client.post("/api/v2/check", json={"config": base}).json()
    st = {r["id"]: r["status"] for r in ok["check"]["results"]}
    assert st["grasp_soft_bag"] == "unknown" and st["place_no_press"] == "unknown" and st["sense_weight"] == "partial"
    # 手先を吸着パッドに替える → 袋はつかめない、Step 4 で S1・S2 が引継ぎ
    vac = {**base, "end_effector": "vacuum"}
    st2 = {r["id"]: r for r in client.post("/api/v2/check", json={"config": vac}).json()["check"]["results"]}
    assert st2["grasp_soft_bag"]["status"] == "ng" and st2["grasp_soft_bag"]["affected"] == ["S1", "S2"]
    run = client.post("/api/v2/run", json={"config": vac}).json()
    assert {i["object_id"] for i in run["job"]["items"] if i["outcome"] == "handed_off"} == {"S1", "S2"}
    # 力覚センサーを外す → 重さの計測は不足
    nofs = {**base, "sensors": ["rgb_camera", "depth_camera"]}
    st3 = {r["id"]: r["status"] for r in client.post("/api/v2/check", json={"config": nofs}).json()["check"]["results"]}
    assert st3["sense_weight"] == "ng"
    for bad in ({**base, "arm": "arm_heavy"},                 # 機種のアーム本体は変えられない
                {**base, "end_effector": "parallel_gripper"},   # この機種に非対応の手先
                {"product_id": "unknown_robot"}):               # カタログにない機種
        assert client.post("/api/v2/check", json={"config": bad}).status_code == 422


def test_three_makers_and_concept_preview(client):
    """3社の機種で構造・能力が変わり、ヒューマノイドは概念プレビューとして評価に出る。"""
    prof = {p: client.post("/api/v2/check", json={"config": {"product_id": p}}).json()["profile"]
            for p in ("aw_40f", "rm_20", "hm_1")}
    assert {p: v["base"] for p, v in prof.items()} == {"aw_40f": "fixed_pedestal", "rm_20": "wheeled_base", "hm_1": "legged_humanoid"}
    run = client.post("/api/v2/run", json={"config": {"product_id": "hm_1"}}).json()
    assert run["job"]["robot"]["product"]["execution"] == "concept"
    assert any("概念プレビュー" in x for x in run["readiness"]["categories"]["needs_physical_poc"])
    fixed = client.post("/api/v2/run", json={"config": {"product_id": "aw_40f"}}).json()
    assert any("AW-40F" in x for x in fixed["readiness"]["categories"]["needs_physical_poc"])   # 機種固有の検証項目


def test_run_without_robot_and_errors(client):
    plain = client.post("/api/v2/run", json={}).json()
    assert plain["job"]["robot"] is None and plain["check"] is None and plain["readiness"]["hardware"] is None
    assert client.post("/api/v2/run", json={"config_id": "nope"}).status_code == 404
    assert client.post("/api/v2/run", json={"batch_id": "nope"}).status_code == 404
