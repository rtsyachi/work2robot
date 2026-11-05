"""業務全体（Level 1）の規則で動く方式（シナリオv2）のテスト。"""
import copy
import json
from pathlib import Path

import pytest

from backend.workflow import masters, run_workflow, validate_workflow
from backend.workflow.job import JobError, level1_graph, run_job
from backend.workflow.job_rules import brick_slots

ROOT = Path(__file__).resolve().parent.parent
V2 = ROOT / "data" / "scenario_v2"
EPS = 1e-6


def load(p: Path) -> dict:
    return json.loads(p.read_text(encoding="utf-8"))


@pytest.fixture
def wf2():
    return load(V2 / "workflow_fixture.json")


@pytest.fixture
def job2():
    return load(V2 / "job_fixture.json")


@pytest.fixture
def cases2():
    return masters.default_cases()


def objects_of(cases, batch_id):
    objs = {o["object_id"]: o for o in cases["objects"]}
    ids = next(b for b in cases["batches"] if b["batch_id"] == batch_id)["object_ids"]
    return [copy.deepcopy(objs[i]) for i in ids]


def run(job2, wf2, catalog, objects):
    return run_job(job2, wf2, objects, catalog)


def item(t, oid):
    return next(i for i in t["items"] if i["object_id"] == oid)


def boxes(t):
    out = []
    for it in t["items"]:
        if it["placement"]:
            (x, y, z), (w, d, h) = it["placement"]["position"], it["placement"]["dims"]
            out.append((it["object_id"], x - w / 2, x + w / 2, y - h / 2, y + h / 2, z - d / 2, z + d / 2))
    return out


def test_v2_workflow_is_valid(wf2, catalog):
    assert validate_workflow(wf2, catalog).ok


def test_order_heavy_first_soft_last(job2, wf2, catalog, cases2):
    t = run(job2, wf2, catalog, objects_of(cases2, "video_batch"))
    assert t["arrival"][0] == "L1"  # 到着順の先頭は軽い箱
    assert t["order"] == ["H1", "H2", "H3", "H4", "M1", "M2", "M3", "M4", "M5", "M6",
                          "W1", "W2", "L1", "L2", "L3", "S1", "S2"]


def test_heavy_boxes_form_the_base_from_the_back(job2, wf2, catalog, cases2):
    """前面が開口なので各段とも奥から置く。同じ列では重心の偏りが小さい側を選ぶ（途中の偏りは許す）。"""
    t = run(job2, wf2, catalog, objects_of(cases2, "video_batch"))
    pos = {oid: item(t, oid)["placement"]["position"] for oid in ("H1", "H2", "H3", "H4")}
    for oid in pos:
        assert item(t, oid)["placement"]["base_height"] == 0
    assert pos["H1"][2] < 0 and pos["H2"][2] < 0  # 先の2個は奥の列
    assert pos["H3"][2] > 0 and pos["H4"][2] > 0  # 残りは手前の列
    assert pos["H1"][0] < 0 < pos["H2"][0]
    assert pos["H3"][0] > 0 > pos["H4"][0]  # H1（18kg）の左が重いので、H3（15kg）は右、H4は左
    for oid in ("W1", "W2"):
        assert item(t, oid)["placement"]["position"][2] < 0  # 上の段も奥から


def test_back_first_rule_holds_for_every_item(job2, wf2, catalog, cases2):
    """各荷物を置いた時点で、同じ段のより手前に、すでに置いた箱がない（手前を先に埋めない）。"""
    t = run(job2, wf2, catalog, objects_of(cases2, "video_batch"))
    placed = []
    for it in t["items"]:
        p = it["placement"]
        if not p:
            continue
        x, _, z = p["position"]
        w, d, _ = p["dims"]
        for q in placed:
            same_level = abs(q["base_height"] - p["base_height"]) < 1e-6
            overlap_x = min(x + w / 2, q["x1"]) - max(x - w / 2, q["x0"]) > 1e-6
            assert not (same_level and overlap_x and q["z0"] >= z + d / 2 - 1e-6), it["object_id"]
        placed.append({"base_height": p["base_height"], "x0": x - w / 2, "x1": x + w / 2, "z0": p["position"][2] - d / 2})


def test_brick_pattern_mixes_orientations_in_one_layer(job2, wf2, catalog, cases2):
    t = run(job2, wf2, catalog, objects_of(cases2, "video_batch"))
    ms = [item(t, f"M{i}") for i in range(1, 7)]
    assert {m["placement"]["base_height"] for m in ms} == {0.3}
    assert sorted(m["placement"]["rotated"] for m in ms) == [False, False, True, True, True, True]
    assert all("brick_pattern" in m["applied_rules"] for m in ms)
    rr = next(r for r in t["rule_results"] if r["type"] == "brick_pattern")
    assert rr["status"] == "applied" and rr["source_evidence"][0]["ref"] == "E3"


def test_brick_slots_need_matching_dimensions():
    assert len(brick_slots(1.0, 0.75, [0.5, 0.25, 0.2])) == 6
    assert brick_slots(1.0, 0.75, [0.5, 0.375, 0.3]) is None   # 1段を縦横の組み合わせで埋められない
    assert brick_slots(1.0, 0.75, [0.3, 0.3, 0.3]) is None      # 正方形


def test_every_upper_box_is_fully_supported_and_nothing_overlaps(job2, wf2, catalog, cases2):
    t = run(job2, wf2, catalog, objects_of(cases2, "video_batch"))
    bs = boxes(t)
    for a in bs:
        _, ax0, ax1, ay0, _, az0, az1 = a
        if ay0 > EPS:
            area = sum(max(0, min(ax1, b[2]) - max(ax0, b[1])) * max(0, min(az1, b[6]) - max(az0, b[5]))
                       for b in bs if abs(b[4] - ay0) < EPS)
            assert area >= (ax1 - ax0) * (az1 - az0) - 1e-9, a[0]
        for b in bs:
            if a[0] < b[0]:
                ov = [max(0, min(a[i + 1], b[i + 1]) - max(a[i], b[i])) for i in (1, 3, 5)]
                assert min(ov) < EPS, (a[0], b[0])


def test_soft_bags_last_on_top_and_nothing_above(job2, wf2, catalog, cases2):
    t = run(job2, wf2, catalog, objects_of(cases2, "video_batch"))
    for oid in ("S1", "S2"):
        s = item(t, oid)
        assert s["stack_above"] == "forbidden" and s["outcome"] == "placed"
        assert not any(oid in (i["placement"] or {}).get("supporters", []) for i in t["items"])
    assert t["order"][-2:] == ["S1", "S2"]


def test_all_items_processed_and_checks_are_recorded(job2, wf2, catalog, cases2):
    t = run(job2, wf2, catalog, objects_of(cases2, "video_batch"))
    assert t["end"]["placed"] == 17 and t["end"]["handed_off"] == 0
    c = t["checks"]
    assert c["overhang"]["ok"] and c["load"]["ok"] and c["load"]["total_kg"] == 131.0 and c["height"]["ok"]
    assert c["balance"]["ok"] is None and c["balance"]["com_offset_m"] < 0.05  # 許容範囲は未定義
    assert [s["node_id"] for s in t["level1_steps"]][-2:] == ["l1_final_check", "l1_end"]


def test_unsupported_rules_are_not_shown_as_applied(job2, wf2, catalog, cases2):
    t = run(job2, wf2, catalog, objects_of(cases2, "video_batch"))
    un = [r for r in t["rule_results"] if r["status"] == "unsupported"]
    assert [r["label"] for r in un] == ["荷崩れがないか確認する（物理的な安定性）"]
    job2["rules"].append({"type": "fly_items", "text": "荷物を空中に浮かせる"})
    t = run(job2, wf2, catalog, objects_of(cases2, "video_batch"))
    assert "荷物を空中に浮かせる" in [r["label"] for r in t["rule_results"] if r["status"] == "unsupported"]


def test_rules_change_the_result(job2, wf2, catalog, cases2):
    objs = objects_of(cases2, "video_batch")
    base = run(job2, wf2, catalog, objs)
    no_order = copy.deepcopy(job2)
    no_order["rules"] = [r for r in job2["rules"] if r["type"] != "order_by_weight_desc"]
    t = run(no_order, wf2, catalog, objs)
    assert t["order"][0] == "L1"  # 重い順の規則がなければ到着順のまま
    no_brick = copy.deepcopy(job2)
    no_brick["rules"] = [r for r in job2["rules"] if r["type"] != "brick_pattern"]
    t = run(no_brick, wf2, catalog, objs)
    assert not any("brick_pattern" in i["applied_rules"] for i in t["items"])
    assert [item(t, f"M{i}")["placement"]["position"] for i in range(1, 7)] != \
        [item(base, f"M{i}")["placement"]["position"] for i in range(1, 7)]


def test_load_limit_hands_off_when_exceeded(job2, wf2, catalog, cases2):
    job2["cart"]["max_load_kg"] = 100
    t = run(job2, wf2, catalog, objects_of(cases2, "video_batch"))
    over = [i for i in t["items"] if i["handoff_reason"] and "上限" in i["handoff_reason"]]
    assert over and t["checks"]["load"]["total_kg"] <= 100


def test_alt_batch_takes_other_branches(job2, wf2, catalog, cases2):
    t = run(job2, wf2, catalog, objects_of(cases2, "alt_batch"))
    u = item(t, "U1")
    assert u["provisional"] and u["stack_above"] == "forbidden"
    assert u["item_trace"]["unknown_fields"] == ["material_class"]
    rr = next(r for r in t["rule_results"] if r["type"] == "brick_pattern")
    assert rr["status"] == "not_applicable" and rr["notes"]  # 適用できなかった理由を残す


def test_level2_traces_and_determinism(job2, wf2, catalog, cases2):
    objs = objects_of(cases2, "video_batch")
    t = run(job2, wf2, catalog, objs)
    assert t == run(job2, wf2, catalog, objs)
    for it in t["items"]:
        o = next(x for x in objs if x["object_id"] == it["object_id"])
        assert it["item_trace"] == run_workflow(wf2, o, catalog)
    edges = {(e["source"], e["field"]) for e in level1_graph()["edges"]}
    assert all((s["node_id"], s["edge"]) in edges for s in t["level1_steps"] if s["node_id"] != "l1_end")


def test_invalid_rules_job_is_rejected(job2, wf2, catalog, cases2):
    del job2["cart"]["max_load_kg"]
    with pytest.raises(JobError):
        run(job2, wf2, catalog, objects_of(cases2, "video_batch"))
