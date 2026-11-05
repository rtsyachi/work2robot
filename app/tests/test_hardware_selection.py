"""ハードウェア仮選定（backend/ai/hardware_selection.py）。Claude APIは呼ばず、偽のクライアントで確かめる。"""
import json
from pathlib import Path

import pytest

from backend.ai import hardware_selection as hs
from backend.workflow import masters
from backend.workflow.hardware import compute_requirements
from tests.test_extraction import FakeClient, count_unions, message

ROOT = Path(__file__).resolve().parent.parent


def load(rel):
    return json.loads((ROOT / rel).read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def ctx():
    hw = load("data/hardware_catalog.json")
    cases = masters.default_cases()
    objs = {o["object_id"]: o for o in cases["objects"]}
    batch = [objs[i] for i in cases["batches"][0]["object_ids"]]
    ext = {"job": load("data/scenario_v2/job_fixture.json"), "workflow": load("data/scenario_v2/workflow_fixture.json"),
           "confirmation_items": [], "summary": "s"}
    return hw, ext, compute_requirements(ext["job"], ext["workflow"], batch, hw)


def output(product="rm_20", ee="vacuum_gripper", sensors=("rgb_camera", "depth_camera", "wrist_force_sensor")):
    return json.dumps({
        "capability_requirements": [{"capability": "grasp_soft_bag", "reason": "柔らかいバッグを最後に積む",
                                     "source_evidence": [{"type": "spoken_instruction", "note": "n", "ref": "S6"}]}],
        "config": {"product_id": product, "end_effector": ee, "sensors": list(sensors), "peripherals": []},
        "rationale": [{"component": product, "text": "18kgの箱を持ち、仮置き場とカゴ車を移動する"}],
        "alternatives": [{"component": "rm_10", "reason": "可搬重量が足りない"}],
        "unverified_points": ["袋の把持"],
        "improvement_hypotheses": [{"kind": "peripheral", "text": "計量台を置けば重さを事前に測れるかもしれない"}],
        "summary": "s",
    }, ensure_ascii=False)


def test_schema_limits_choice_to_catalog_products(ctx):
    hw, _, _ = ctx
    schema = hs.output_schema(hw)
    assert count_unions(schema) <= 16
    cfg = schema["properties"]["config"]["properties"]
    assert cfg["product_id"]["enum"] == ["aw_40f", "rm_20", "rm_10", "hm_1"]   # カタログの機種だけ
    assert "base" not in cfg and "arm" not in cfg                                 # 固定構造は選ばせない


def test_selection_is_checked_by_code(ctx):
    hw, ext, reqs = ctx
    client = FakeClient(message(output()))
    sel = hs.select_hardware(client, ext, reqs, hw, ext["job"]["cart"])
    assert sel["errors"] == [] and sel["meta"]["attempts"] == 1
    assert sel["config"]["product_id"] == "rm_20" and sel["config"]["arm"] == "arm_medium"
    status = {r["id"]: r["status"] for r in sel["check"]["results"]}
    assert status["payload"] == "ok" and status["grasp_soft_bag"] == "unknown"
    user = client.calls[0]["messages"][0]["content"]
    assert "可搬重量" in user and "rm_20" in user


def test_unsupported_option_is_rejected_and_sent_back(ctx):
    """機種が認めないオプション（RM-20に挟み込みグリッパー）は、コードで弾いて選び直させる。"""
    hw, ext, reqs = ctx
    client = FakeClient(message(output(ee="parallel_gripper")), message(output()))
    sel = hs.select_hardware(client, ext, reqs, hw, ext["job"]["cart"])
    assert sel["meta"]["attempts"] == 2 and not sel["errors"]
    assert "装着できない" in client.calls[1]["messages"][-1]["content"]


def test_insufficient_product_is_sent_back_then_kept_if_still_insufficient(ctx):
    hw, ext, reqs = ctx
    weak = output(product="rm_10", ee="vacuum", sensors=("rgb_camera", "depth_camera"))
    client = FakeClient(message(weak), message(output()))
    sel = hs.select_hardware(client, ext, reqs, hw, ext["job"]["cart"])
    assert sel["meta"]["attempts"] == 2 and not sel["errors"]
    assert "可搬重量" in client.calls[1]["messages"][-1]["content"]
    sel = hs.select_hardware(FakeClient(message(weak), message(weak)), ext, reqs, hw, ext["job"]["cart"])
    assert sel["errors"] and sel["check"]["counts"]["ng"] >= 1   # 不足を隠さずに返す（適合したことにしない）


def test_invalid_twice_is_an_error(ctx):
    hw, ext, reqs = ctx
    bad = output(ee="parallel_gripper")
    with pytest.raises(hs.HardwareSelectionError):
        hs.select_hardware(FakeClient(message(bad), message(bad)), ext, reqs, hw, ext["job"]["cart"])


def test_save_and_latest(ctx, tmp_path):
    hw, ext, reqs = ctx
    sel = hs.select_hardware(FakeClient(message(output())), ext, reqs, hw, ext["job"]["cart"])
    hs.save_selection(sel, tmp_path)
    assert hs.latest_selection(tmp_path)["config"]["product_id"] == "rm_20"
