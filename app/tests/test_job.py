"""業務全体（Level 1）の実行器のテスト。"""
import json
from pathlib import Path

import pytest

from backend.workflow import run_workflow
from backend.workflow.job import JobError, level1_graph, run_job

DATA = Path(__file__).resolve().parent.parent / "data"


@pytest.fixture
def job():
    return json.loads((DATA / "job_fixture.json").read_text(encoding="utf-8"))


@pytest.fixture
def batches():
    return {b["batch_id"]: b["object_ids"] for b in json.loads((DATA / "demo_cases.json").read_text(encoding="utf-8"))["batches"]}


def batch(objects, ids):
    return [objects[i] for i in ids]


def item(trace, oid):
    return next(i for i in trace["items"] if i["object_id"] == oid)


def test_video_batch_matches_human_work(job, workflow, catalog, objects, batches):
    t = run_job(job, workflow, batch(objects, batches["video_batch"]), catalog)
    assert t["order"] == ["A", "B", "C", "D"]  # 下段（A,B）→ 上段（C,D）
    assert [i["outcome"] for i in t["items"]] == ["placed"] * 4
    assert item(t, "A")["placement"]["support"] is None and item(t, "B")["placement"]["support"] is None
    assert item(t, "C")["placement"]["support"] == "A"   # 動画と同じく C は A の上
    assert item(t, "D")["placement"]["support"] == "C"   # D は C の上
    assert item(t, "D")["press_mode"] == "no_press"
    assert item(t, "B")["provisional"] is True
    assert t["end"] == {"reason": "all_items_processed", "placed": 4, "handed_off": 0,
                        "cart": {"bottom": ["A", "B"], "top": ["C", "D"], "height_used_m": 0.7}}


def test_positions_stay_inside_the_cart(job, workflow, catalog, objects, batches):
    t = run_job(job, workflow, batch(objects, batches["mixed_batch"]), catalog)
    cart = t["cart"]
    for it in t["items"]:
        (x, y, z), (w, d, h) = it["placement"]["position"], it["placement"]["dims"]
        assert abs(x) + w / 2 <= cart["width_m"] / 2 + 1e-6
        assert abs(z) + d / 2 <= cart["depth_m"] / 2 + 1e-6
        assert y + h / 2 <= cart["height_m"] + 1e-6


def test_other_conditions_take_different_branches(job, workflow, catalog, objects, batches):
    video = run_job(job, workflow, batch(objects, batches["video_batch"]), catalog)
    mixed = run_job(job, workflow, batch(objects, batches["mixed_batch"]), catalog)
    assert mixed["arrival"] == ["C", "E", "A", "D", "B"]
    assert mixed["order"] == ["A", "B", "C", "E", "D"]  # 到着順が違っても下段が先
    e = item(mixed, "E")
    assert e["provisional"] and e["press_mode"] == "no_press"
    assert e["item_trace"]["unknown_fields"] == ["material_class"]
    # 作業状態（既に積んだ荷物）によって置き場所が変わる：E が C の上に載るため、D は E の上になる
    assert item(mixed, "D")["placement"]["support"] == "E"
    assert item(video, "D")["placement"]["support"] == "C"


def test_level2_traces_come_from_the_item_executor(job, workflow, catalog, objects, batches):
    t = run_job(job, workflow, batch(objects, batches["mixed_batch"]), catalog)
    for it in t["items"]:
        assert it["item_trace"] == run_workflow(workflow, objects[it["object_id"]], catalog)


def test_loop_and_primitives_are_consistent(job, workflow, catalog, objects, batches):
    t = run_job(job, workflow, batch(objects, batches["mixed_batch"]), catalog)
    nodes = [s["node_id"] for s in t["level1_steps"]]
    assert nodes[:3] == ["l1_start", "l1_list", "l1_order"] and nodes[-1] == "l1_end"
    assert nodes.count("l1_take_next") == 5  # 荷物の数だけ繰り返す
    more = [s["edge"] for s in t["level1_steps"] if s["node_id"] == "l1_more"]
    assert more == ["on_true"] * 4 + ["on_false"]
    for it in t["items"]:
        kinds = [p["kind"] for p in t["primitives"] if p["object_id"] == it["object_id"]]
        assert kinds == ["recognize", "pick", "move", "place"]
        place = next(p for p in t["primitives"] if p["object_id"] == it["object_id"] and p["kind"] == "place")
        assert place["position"] == it["placement"]["position"]
    # 実行トレースに含まれる辺は、すべて Level 1 の流れ図に存在する
    edges = {(e["source"], e["field"]) for e in level1_graph()["edges"]}
    assert all((s["node_id"], s["edge"]) in edges for s in t["level1_steps"] if s["node_id"] != "l1_end")


def test_no_space_hands_off(job, workflow, catalog, objects, clone):
    boxes = []
    for n in range(5):  # 0.30×0.25m の箱は、0.80×0.60m の床に2列×2個＝4個まで
        b = clone(objects["B"])
        b["object_id"] = f"B{n}"
        boxes.append(b)
    t = run_job(job, workflow, boxes, catalog)
    outcomes = [i["outcome"] for i in t["items"]]
    assert outcomes == ["placed"] * 4 + ["handed_off"]
    assert t["items"][4]["handoff_reason"] == "下段に空きがない"
    assert [p["kind"] for p in t["primitives"] if p["object_id"] == "B4"] == ["recognize", "handoff"]
    assert t["end"]["handed_off"] == 1


def test_unknown_dims_hand_off(job, workflow, catalog, objects, clone):
    a = clone(objects["A"])
    del a["attributes"]["dims_m"]
    t = run_job(job, workflow, [a], catalog)
    assert t["items"][0]["outcome"] == "handed_off" and "寸法" in t["items"][0]["handoff_reason"]


def test_deterministic(job, workflow, catalog, objects, batches):
    b = batch(objects, batches["mixed_batch"])
    assert run_job(job, workflow, b, catalog) == run_job(job, workflow, b, catalog)


def test_invalid_job_is_rejected(job, workflow, catalog, objects):
    job["order_rule"]["zones"] = ["roof"]
    with pytest.raises(JobError):
        run_job(job, workflow, [objects["A"]], catalog)
