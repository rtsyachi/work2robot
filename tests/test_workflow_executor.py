"""実行器のテスト。期待する経路はここ（評価側）に置き、入力データには含めない。"""
import pytest

from backend.workflow import WorkflowValidationError, run_workflow
from conftest import node


def path(trace: dict) -> list[str]:
    return [s["node_id"] for s in trace["steps"]]


def test_large_rigid_box_goes_to_bottom(workflow, catalog, objects):
    t = run_workflow(workflow, objects["A"], catalog)
    assert path(t) == ["start", "observe_attrs", "is_fragile", "is_soft", "is_large", "place_bottom", "end_placed"]
    assert t["skill_events"] == [{
        "seq": 0, "node_id": "place_bottom", "skill": "pick_place",
        "parameters": {"zone": "bottom", "press_mode": "normal"}, "provisional": False,
    }]
    assert t["result"] == "placed"
    assert t["provisional_actions"] == [] and t["unconfirmed_conditions"] == []
    large = next(s for s in t["steps"] if s["node_id"] == "is_large")
    assert large["input"]["value"] == 0.20 and large["result"] == "true"
    assert large["rule_evidence"][0]["type"] == "provided_text"  # 閾値の根拠は説明テキスト


def test_soft_bag_goes_to_top(workflow, catalog, objects):
    t = run_workflow(workflow, objects["C"], catalog)
    assert path(t)[-2:] == ["place_top", "end_placed"]
    assert t["skill_events"][0]["parameters"] == {"zone": "top", "press_mode": "normal"}


def test_fragile_bag_goes_to_top_without_pressing(workflow, catalog, objects):
    t = run_workflow(workflow, objects["D"], catalog)
    assert path(t) == ["start", "observe_attrs", "is_fragile", "place_top_gentle", "end_placed"]
    assert t["skill_events"][0]["parameters"] == {"zone": "top", "press_mode": "no_press"}
    assert t["handoffs"] == [] and t["result"] == "placed"


def test_unconfirmed_heavy_rule_completes_with_video_based_provisional_action(workflow, catalog, objects):
    t = run_workflow(workflow, objects["B"], catalog)
    heavy = next(s for s in t["steps"] if s["node_id"] == "is_heavy")
    # 要確認の条件は「はい／いいえ」に確定させない
    assert heavy["result"] == "unknown" and heavy["edge"] == "on_unknown"
    assert "未定義" in heavy["reason"]
    assert t["unconfirmed_conditions"] == ["is_heavy"]
    # 動画どおり下段に置く暫定動作で完了し、確認事項を残す
    assert t["skill_events"][0]["parameters"] == {"zone": "bottom", "press_mode": "normal"}
    assert t["skill_events"][0]["provisional"] is True
    [prov] = t["provisional_actions"]
    assert prov["node_id"] == "place_heavy_provisional"
    assert {e["type"] for e in prov["evidence"]} == {"video_observation", "provided_text"}
    assert t["handoffs"] == [] and t["result"] == "placed"


def test_unknown_material_completes_with_ai_hypothesis_action(workflow, catalog, objects):
    t = run_workflow(workflow, objects["E"], catalog)
    assert path(t)[-3:] == ["is_soft", "place_unknown_provisional", "end_placed"]
    assert t["unknown_fields"] == ["material_class"]
    assert t["skill_events"][0]["parameters"] == {"zone": "top", "press_mode": "no_press"}
    [prov] = t["provisional_actions"]
    assert [e["type"] for e in prov["evidence"]] == ["ai_hypothesis"]  # 仮説であることを明示
    observe = t["steps"][1]
    assert observe["missing_fields"] == ["material_class", "weight_kg"]


def test_each_demo_object_takes_a_different_path(workflow, catalog, objects):
    paths = {oid: tuple(path(run_workflow(workflow, o, catalog))) for oid, o in objects.items()}
    assert len(set(paths.values())) == len(paths)


def test_trace_is_deterministic_and_input_is_not_mutated(workflow, catalog, objects, clone):
    before = clone(objects["B"])
    t1 = run_workflow(workflow, objects["B"], catalog)
    t2 = run_workflow(workflow, objects["B"], catalog)
    assert t1 == t2
    assert objects["B"] == before


def test_edges_follow_the_steps(workflow, catalog, objects):
    t = run_workflow(workflow, objects["A"], catalog)
    ids = path(t)
    assert [(e["from"], e["to"]) for e in t["edges"]] == list(zip(ids, ids[1:]))


def test_branching_depends_on_attributes_not_object_id(workflow, catalog, objects, clone):
    renamed = clone(objects["A"])
    renamed["object_id"] = "Z"
    assert path(run_workflow(workflow, renamed, catalog)) == path(run_workflow(workflow, objects["A"], catalog))
    small = clone(objects["A"])
    small["attributes"]["base_area_m2"]["value"] = 0.10
    assert "is_heavy" in path(run_workflow(workflow, small, catalog))


def test_needs_confirmation_ignores_any_weight(workflow, catalog, objects, clone):
    for w in (0.1, 12.0, 999.0):
        b = clone(objects["B"])
        b["attributes"]["weight_kg"]["value"] = w
        assert path(run_workflow(workflow, b, catalog))[-2] == "place_heavy_provisional"


def test_unknown_source_counts_as_unknown(workflow, catalog, objects, clone):
    a = clone(objects["A"])
    a["attributes"]["fragile_content"]["source"] = "unknown"
    t = run_workflow(workflow, a, catalog)
    assert t["unknown_fields"] == ["fragile_content"]
    assert t["provisional_actions"][0]["node_id"] == "place_unknown_provisional"


def test_handoff_node_is_still_supported(workflow, catalog, objects):
    workflow["nodes"].append({"id": "end_handoff", "type": "end", "result": "handed_off"})
    workflow["nodes"].append({"id": "ask_human", "type": "handoff", "reason": "安全のため人が積む", "next": "end_handoff"})
    node(workflow, "is_fragile")["on_true"] = "ask_human"
    t = run_workflow(workflow, objects["D"], catalog)
    assert t["handoffs"] == [{"node_id": "ask_human", "reason": "安全のため人が積む"}]
    assert t["skill_events"] == [] and t["result"] == "handed_off"


def test_type_mismatch_is_unknown(workflow, catalog, objects, clone):
    a = clone(objects["A"])
    a["attributes"]["base_area_m2"]["value"] = "large"
    t = run_workflow(workflow, a, catalog)
    step = next(s for s in t["steps"] if s["node_id"] == "is_large")
    assert step["result"] == "unknown"
    b = clone(objects["A"])
    b["attributes"]["fragile_content"]["value"] = 1  # 真偽値と数値を同一視しない
    step = next(s for s in run_workflow(workflow, b, catalog)["steps"] if s["node_id"] == "is_fragile")
    assert step["result"] == "unknown"


def test_is_known_operator(workflow, catalog, objects, clone):
    wf = clone(workflow)
    n = node(wf, "is_fragile")
    n.update({"operator": "is_known", "value": None})
    t = run_workflow(wf, objects["E"], catalog)  # fragile_content は既知
    assert t["steps"][2]["result"] == "true"


def test_invalid_workflow_is_not_executed(workflow, catalog, objects):
    del node(workflow, "is_large")["on_unknown"]
    with pytest.raises(WorkflowValidationError):
        run_workflow(workflow, objects["A"], catalog)
