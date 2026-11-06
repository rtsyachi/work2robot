"""v2のAPI（業務の規則・ハードウェア構成）。保存済みのClaude結果がない状態（手書きの業務・構成）で確かめる。"""
import pytest
from fastapi.testclient import TestClient

from backend import inputs
from backend.ai import extraction, hardware_selection, task_structure
from backend.api.app import app
from backend.inputs import current_video
from backend.workflow import masters


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setattr(inputs, "UPLOAD_DIR", tmp_path / "uploads")  # 今の動画は v5デモ（アップロードなし）
    monkeypatch.setattr(extraction, "RECORD_DIR", tmp_path / "ext")
    monkeypatch.setattr(hardware_selection, "RECORD_DIR", tmp_path / "hw")
    monkeypatch.setattr(task_structure, "RECORD_DIR", tmp_path / "tasks")
    monkeypatch.setattr(masters, "REGISTERED_DIR", tmp_path / "masters")
    return TestClient(app)


def test_masters_default_and_register(client):
    m = client.get("/api/v2/masters").json()
    assert m["source"] == "default" and m["validation"]["ok"]
    assert len(m["parcels"]) == 18 and len(m["items"]["products"]) == 13 and m["environment"]["carts"][0]["max_load_kg"] == 150
    # 登録：H1 を重くし、カゴ車の最大積載を下げる → 以降の照合・実行がその値で動く
    items, env = m["items"], m["environment"]
    next(k for k in items["products"] if k["product_id"] == "H1")["weight_kg"] = 25.0
    env["carts"][0]["max_load_kg"] = 100
    saved = client.put("/api/v2/masters", json={"items": items, "environment": env, "shipments": m["shipments"]}).json()
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
    items["products"].append(dict(items["products"][0]))  # ID の重複
    r = client.put("/api/v2/masters", json={"items": items, "environment": m["environment"], "shipments": m["shipments"]})
    assert r.status_code == 422 and any("重複" in e["message"] for e in r.json()["detail"]["errors"])
    assert client.get("/api/v2/masters").json()["source"] == "default"


def test_task_structure_is_returned(client):
    assert client.get("/api/v2/state").json()["tasks"] is None
    rec = {"major_tasks": [], "speech_links": [], "unresolved": [], "duration": 1.0, "meta": {"model": "m"}, "raw_outputs": ["x"]}
    task_structure.save_structure(rec, {"observation": "o.json", "video": "other.mp4"})
    assert client.get("/api/v2/state").json()["tasks"] is None  # 別の動画から作ったタスク構造は表示しない
    task_structure.save_structure(rec, {"observation": "o.json", "video": current_video().name})
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
    assert good["job"]["end"]["placed"] == 17
    # 現場の条件（作業エリアに段差）では、車輪の台車は移動が対応不可。それ以外の要件は満たす
    ng = [x for x in good["check"]["results"] if x["status"] == "ng"]
    assert [x["id"] for x in ng] == ["mobility"] and "段差" in ng[0]["detail"]
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
    assert st["grasp_soft_bag"] == "unknown" and st["place_no_press"] == "unknown" and "sense_weight" not in st
    # 手先を吸着パッドに替える → 袋はつかめない、Step 5 で S1・S2 が引継ぎ
    vac = {**base, "end_effector": "vacuum"}
    st2 = {r["id"]: r for r in client.post("/api/v2/check", json={"config": vac}).json()["check"]["results"]}
    assert st2["grasp_soft_bag"]["status"] == "ng" and st2["grasp_soft_bag"]["affected"] == ["S1", "S2"]
    run = client.post("/api/v2/run", json={"config": vac}).json()
    assert {i["object_id"] for i in run["job"]["items"] if i["outcome"] == "handed_off"} == {"S1", "S2"}
    # 力覚センサーを外しても、重さは荷姿マスタにあるので重さの計測は要件に出ない
    nofs = {**base, "sensors": ["rgb_camera", "depth_camera"]}
    st3 = {r["id"]: r["status"] for r in client.post("/api/v2/check", json={"config": nofs}).json()["check"]["results"]}
    assert "sense_weight" not in st3
    for bad in ({**base, "arm": "arm_heavy"},                 # 機種のアーム本体は変えられない
                {**base, "end_effector": "parallel_gripper"},   # この機種に非対応の手先
                {"product_id": "unknown_robot"}):               # カタログにない機種
        assert client.post("/api/v2/check", json={"config": bad}).status_code == 422


def test_three_makers_and_concept_preview(client):
    """3社の機種で構造・能力が変わる。ヒューマノイド（HM-1）は二足歩行で描くが、可搬・リーチが足りず照合で対応不可になる。"""
    prof = {p: client.post("/api/v2/check", json={"config": {"product_id": p}}).json()["profile"]
            for p in ("aw_40f", "rm_20", "hm_1")}
    assert {p: v["base"] for p, v in prof.items()} == {"aw_40f": "fixed_pedestal", "rm_20": "wheeled_base", "hm_1": "legged_humanoid"}
    run = client.post("/api/v2/run", json={"config": {"product_id": "hm_1"}}).json()
    assert run["job"]["robot"]["product"]["execution"] == "supported"
    assert not any("概念プレビュー" in x for x in run["readiness"]["categories"]["needs_physical_poc"])
    hm1 = {r["id"]: r["status"] for r in client.post("/api/v2/check", json={"config": {"product_id": "hm_1"}}).json()["check"]["results"]}
    assert hm1["payload"] == "partial" and hm1["reach"] == "ng"   # 18kg の箱を持てず、奥・下段に届かない
    # 高可搬・長リーチのヒューマノイド（HM-2）は業務要件に対応不可がなく、仮想実行で全量を配置できる（把持・歩行は未検証のまま）
    hm2 = client.post("/api/v2/check", json={"config": {"product_id": "hm_2"}}).json()
    assert hm2["check"]["counts"]["ng"] == 0 and hm2["profile"]["payload_kg"] >= 18
    run2 = client.post("/api/v2/run", json={"config": {"product_id": "hm_2"}}).json()
    assert run2["job"]["robot"]["product"]["execution"] == "supported"
    assert run2["job"]["end"]["placed"] == len(run2["job"]["items"]) and run2["job"]["end"]["handed_off"] == 0
    assert run2["time_estimate"] and run2["time_estimate"]["params"]["base"] == "legged_humanoid"
    fixed = client.post("/api/v2/run", json={"config": {"product_id": "aw_40f"}}).json()
    assert any("AW-40F" in x for x in fixed["readiness"]["categories"]["needs_physical_poc"])   # 機種固有の検証項目


def test_run_without_robot_and_errors(client):
    plain = client.post("/api/v2/run", json={}).json()
    assert plain["job"]["robot"] is None and plain["check"] is None and plain["readiness"]["hardware"] is None
    assert client.post("/api/v2/run", json={"config_id": "nope"}).status_code == 404
    assert client.post("/api/v2/run", json={"batch_id": "nope"}).status_code == 404
