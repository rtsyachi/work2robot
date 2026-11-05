"""ハードウェア構成：能力要件の計算・仕様照合・実行器への能力制約（backend/workflow/hardware.py）。"""
import json
from pathlib import Path

import pytest

from backend.workflow.hardware import (
    HardwareError, check_config, compute_requirements, item_check, resolve_config, resolve_product_config,
)
from backend.workflow import masters
from backend.workflow.job import run_job

ROOT = Path(__file__).resolve().parent.parent
V2 = ROOT / "data" / "scenario_v2"


def load(p):
    return json.loads(Path(p).read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def hw():
    return load(ROOT / "data" / "hardware_catalog.json")


@pytest.fixture(scope="module")
def v2():
    cases = masters.default_cases()
    objs = {o["object_id"]: o for o in cases["objects"]}
    batch = {b["batch_id"]: [objs[i] for i in b["object_ids"]] for b in cases["batches"]}
    return {"job": load(V2 / "job_fixture.json"), "wf": load(V2 / "workflow_fixture.json"), "batch": batch,
            "configs": {c["config_id"]: c for c in load(V2 / "hardware_configs.json")["configs"]}}


def profile(v2, hw, cid):
    return resolve_product_config(v2["configs"][cid], hw)


def test_products_fix_structure_and_limit_options(hw):
    """機種ごとに移動方式・アーム本体は固定で、オプションはメーカーが認めるものだけ。"""
    a = resolve_product_config({"product_id": "aw_40f"}, hw)
    b = resolve_product_config({"product_id": "rm_20"}, hw)
    c = resolve_product_config({"product_id": "hm_1"}, hw)
    assert (a["parts"]["base"], b["parts"]["base"], c["parts"]["base"]) == ("fixed_pedestal", "wheeled_base", "legged_humanoid")
    assert a["payload_kg"] > b["payload_kg"] > c["payload_kg"]
    assert c["product"]["execution"] == "concept"
    with pytest.raises(HardwareError, match="固定"):
        resolve_product_config({"product_id": "aw_40f", "base": "legged_humanoid"}, hw)   # 固定式に脚は付けられない
    with pytest.raises(HardwareError, match="装着できない"):
        resolve_product_config({"product_id": "rm_20", "end_effector": "parallel_gripper"}, hw)  # 非対応の手先
    with pytest.raises(HardwareError, match="カタログにない"):
        resolve_product_config({"product_id": "real_robot_x"}, hw)
    with pytest.raises(HardwareError, match="対応しない"):
        resolve_product_config({"product_id": "rm_10", "sensors": ["wrist_force_sensor"]}, hw)


def test_humanoid_is_concept_preview_not_success(v2, hw):
    """実行器が表現できない二足歩行・双腕の運搬は、成功に見せず未確認（概念プレビュー）の印を付ける。"""
    t = run_job(v2["job"], v2["wf"], v2["batch"]["video_batch"], load(ROOT / "data" / "skill_catalog.json"),
                robot=resolve_product_config({"product_id": "hm_1"}, hw))
    assert t["robot"]["product"]["execution"] == "concept"
    placed = [i for i in t["items"] if i["outcome"] == "placed"]
    assert all(any("概念プレビュー" in u for u in i["capability"]["unverified"]) for i in placed)
    reasons = [i["handoff_reason"] for i in t["items"] if i["outcome"] == "handed_off"]
    assert any("可搬重量不足" in r for r in reasons)       # 両腕で可搬10kg：重い箱は持てない
    assert any("リーチ" in r for r in reasons)              # リーチ0.8m：カゴ車の奥・下段に届かない


def test_requirements_are_computed_from_job_and_master(v2, hw):
    reqs = {r["id"]: r for r in compute_requirements(v2["job"], v2["wf"], v2["batch"]["video_batch"], hw)}
    assert reqs["payload"]["value"] == 18.0 and "H1" in reqs["payload"]["basis"]
    assert reqs["object_size"]["value"] == 0.375          # 底面の短い辺（手先でつかむ幅）
    assert {"kind": "rule", "id": "brick_pattern"} in reqs["rotate_90"]["links"]   # Step 2 の規則が由来
    assert reqs["grasp_soft_bag"]["objects"] == ["S1", "S2"]
    assert reqs["reach"]["value"] == {"depth_m": 0.75, "height_m": 1.2}
    for cid in ("grasp_box", "grasp_soft_bag", "rotate_90", "mobility", "sense_weight", "sense_material", "sense_id"):
        assert cid in reqs, cid
    job = {**v2["job"], "rules": [r for r in v2["job"]["rules"] if r["type"] != "brick_pattern"]}
    assert "rotate_90" not in {r["id"] for r in compute_requirements(job, v2["wf"], v2["batch"]["video_batch"], hw)}


def test_unknown_component_or_bad_mount_is_rejected(hw):
    with pytest.raises(HardwareError):
        resolve_config({"base": "wheeled_base", "arm": "arm_x", "end_effector": "vacuum"}, hw)
    with pytest.raises(HardwareError):
        resolve_config({"base": "wheeled_base", "arm": "arm_heavy", "end_effector": "vacuum"}, hw)


def test_spec_matching_ok_ng_unknown(v2, hw):
    reqs = compute_requirements(v2["job"], v2["wf"], v2["batch"]["video_batch"], hw)
    good = {r["id"]: r for r in check_config(profile(v2, hw, "handwritten_medium"), reqs, v2["job"]["cart"])["results"]}
    assert good["payload"]["status"] == "ok"           # 20 − 1.6 = 18.4kg ≥ 18kg
    assert good["reach"]["status"] == "ok"
    assert good["grasp_soft_bag"]["status"] == "unknown"  # 未確認は未確認のまま
    assert good["sense_weight"]["status"] == "partial"      # 力覚センサーは持ち上げた後にしか測れない
    light = {r["id"]: r for r in check_config(profile(v2, hw, "light_vacuum"), reqs, v2["job"]["cart"])["results"]}
    assert light["payload"]["status"] == "partial"           # 一部の荷物だけ持てない
    assert light["payload"]["affected"] == ["H1", "H2", "H3", "H4"]
    assert light["grasp_soft_bag"]["status"] == "ng" and light["grasp_soft_bag"]["affected"] == ["S1", "S2"]
    assert light["sense_weight"]["status"] == "ng"


def test_item_check(v2, hw):
    objs = {o["object_id"]: o for o in v2["batch"]["video_batch"]}
    light = profile(v2, hw, "light_vacuum")
    assert item_check(light, objs["H1"])["status"] == "ng"
    assert item_check(light, objs["M1"])["status"] == "ok"
    assert item_check(light, objs["S1"])["status"] == "ng"
    medium = profile(v2, hw, "handwritten_medium")
    assert item_check(medium, objs["H1"])["status"] == "ok"
    assert item_check(medium, objs["S1"])["status"] == "unknown"


def test_capable_config_completes_the_job(v2, hw):
    t = run_job(v2["job"], v2["wf"], v2["batch"]["video_batch"], load(ROOT / "data" / "skill_catalog.json"),
                robot=profile(v2, hw, "handwritten_medium"))
    assert t["end"]["placed"] == 17 and t["end"]["handed_off"] == 0
    assert t["robot"]["arm"] == "arm_medium"
    s1 = next(i for i in t["items"] if i["object_id"] == "S1")
    assert s1["capability"]["unverified"]  # 袋の把持は未確認のまま印が付く
    picks = [p for p in t["primitives"] if p["kind"] == "pick"]
    assert all(p["end_effector"] == "vacuum_gripper" for p in picks)


def test_weak_config_does_not_lift_what_it_cannot(v2, hw):
    t = run_job(v2["job"], v2["wf"], v2["batch"]["video_batch"], load(ROOT / "data" / "skill_catalog.json"),
                robot=profile(v2, hw, "light_vacuum"))
    handed = {i["object_id"]: i["handoff_reason"] for i in t["items"] if i["outcome"] == "handed_off"}
    for oid in ("H1", "H2", "H3", "H4"):
        assert "可搬重量不足" in handed[oid]
    assert "手先が非対応" in handed["S1"]
    for oid, reason in handed.items():
        kinds = [p["kind"] for p in t["primitives"] if p["object_id"] == oid]
        assert "pick" not in kinds  # 持ち上げない
        if "この構成では扱えない" in reason:
            assert "check" in kinds  # 近づいて確認してから引き継ぐ
    # リーチ1.0mではカゴ車の奥の床に届かず、置ける荷物も手前に寄る
    placed = [i["placement"]["position"] for i in t["items"] if i["placement"]]
    assert all(z > -0.2 for _, _, z in placed)
    assert any("リーチ" in r for r in handed.values())


def test_without_robot_behaviour_is_unchanged(v2):
    t = run_job(v2["job"], v2["wf"], v2["batch"]["video_batch"], load(ROOT / "data" / "skill_catalog.json"))
    assert t["robot"] is None and t["end"]["placed"] == 17
