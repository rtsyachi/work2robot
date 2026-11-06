"""ロボットの作業時間の推定（模擬の速度仕様から決定的に計算）。"""
import json
from pathlib import Path

from backend.workflow import masters
from backend.workflow.hardware import resolve_product_config
from backend.workflow.job import run_job
from backend.workflow.time_estimate import estimate_robot_time

DATA = Path(__file__).resolve().parents[1] / "data"


def load(rel):
    return json.loads((DATA / rel).read_text(encoding="utf-8"))


def run(config):
    hw, cat = load("hardware_catalog.json"), load("skill_catalog.json")
    m = masters.default_masters()
    objs = {o["object_id"]: o for o in masters.to_objects(masters.parcels_of(m["items"], m["shipments"]))}
    batch = next(b for b in masters.batches_of(m["shipments"]) if b["batch_id"] == "video_batch")
    job = masters.apply_environment(load("scenario_v2/job_fixture.json"), m["environment"])
    trace = run_job(job, load("scenario_v2/workflow_fixture.json"), [objs[i] for i in batch["object_ids"]], cat,
                    robot=resolve_product_config(config, hw))
    return trace, estimate_robot_time(trace, config, hw), hw


def test_mobile_counts_travel_and_arm_and_is_deterministic():
    cfg = {"product_id": "rm_20", "base": "wheeled_base", "arm": "arm_medium", "end_effector": "vacuum_gripper",
           "sensors": ["rgb_camera", "depth_camera"], "peripherals": []}
    trace, est, hw = run(cfg)
    t = hw["timing"]
    assert est["basis"] == "mock_spec" and len(est["items"]) == 17
    placed = [i for i in est["items"] if i["outcome"] == "placed"]
    assert all(i["travel_s"] > 0 for i in placed)  # 台車は仮置き場とカゴ車を往復する
    arm = t["arm"]["arm_medium"]
    first = placed[0]
    assert first["seconds"] >= t["recognize_s"] + arm["pick_s"] + arm["move_s"] + arm["place_s"] + first["travel_s"] - 0.11
    assert abs(est["total_s"] - (sum(i["seconds"] for i in est["items"]) + t["final_check_s"])) < 0.5
    assert run(cfg)[1] == est  # 同じ入力なら同じ推定


def test_fixed_has_no_travel_and_handoffs_exclude_human_work():
    fixed = {"product_id": "aw_40f", "base": "fixed_pedestal", "arm": "arm_heavy", "end_effector": "vacuum_gripper",
             "sensors": ["rgb_camera", "depth_camera"], "peripherals": []}
    _, est, hw = run(fixed)
    assert all(i["travel_s"] == 0 for i in est["items"])
    light = {"product_id": "rm_10", "base": "wheeled_base", "arm": "arm_light", "end_effector": "vacuum",
             "sensors": ["rgb_camera"], "peripherals": []}
    trace, est2, _ = run(light)
    handed = [i for i in est2["items"] if i["outcome"] == "handed_off"]
    assert handed and "人の作業時間" in est2["excludes"][0]
    assert all(i["seconds"] <= hw["timing"]["recognize_s"] + hw["timing"]["check_s"] + hw["timing"]["handoff_s"] for i in handed)


def test_base_and_arm_come_from_the_product_when_omitted():
    """画面からの構成（機種＋オプションだけ）でも、機種の固定構造から推定する。"""
    full = {"product_id": "aw_40f", "base": "fixed_pedestal", "arm": "arm_heavy", "end_effector": "vacuum_gripper",
            "sensors": ["rgb_camera", "depth_camera"], "peripherals": []}
    trace, est, hw = run(full)
    short = {k: v for k, v in full.items() if k not in ("base", "arm")}
    assert estimate_robot_time(trace, short, hw) == est


def test_no_estimate_without_speed_spec():
    hw = load("hardware_catalog.json")
    assert estimate_robot_time({"primitives": []}, {"base": "legged_humanoid", "arm": "arm_unknown"}, hw) is None
    assert estimate_robot_time({"primitives": []}, None, hw) is None
