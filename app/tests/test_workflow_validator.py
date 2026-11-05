"""検証器のテスト。"""
from backend.workflow import validate_workflow
from conftest import node


def codes(result) -> set[str]:
    return {i.code for i in result.errors}


def test_fixture_is_valid(workflow, catalog):
    r = validate_workflow(workflow, catalog)
    assert r.ok, r.to_dict()
    assert r.warnings == []


def test_missing_top_level_key(workflow, catalog):
    del workflow["version"]
    assert "missing_top_level_key" in codes(validate_workflow(workflow, catalog))


def test_decision_requires_on_unknown(workflow, catalog):
    del node(workflow, "is_soft")["on_unknown"]
    assert "missing_field" in codes(validate_workflow(workflow, catalog))


def test_dangling_reference(workflow, catalog):
    node(workflow, "is_soft")["on_true"] = "nowhere"
    assert "dangling_reference" in codes(validate_workflow(workflow, catalog))


def test_cycle_is_rejected(workflow, catalog):
    node(workflow, "place_bottom")["next"] = "is_fragile"
    assert "cycle" in codes(validate_workflow(workflow, catalog))


def test_duplicate_id(workflow, catalog, clone):
    workflow["nodes"].append(clone(node(workflow, "end_placed")))
    assert "duplicate_id" in codes(validate_workflow(workflow, catalog))


def test_unknown_node_type(workflow, catalog):
    node(workflow, "end_placed")["type"] = "teleport"
    assert "unknown_node_type" in codes(validate_workflow(workflow, catalog))


def test_operator_whitelist(workflow, catalog):
    node(workflow, "is_large")["operator"] = "python_eval"
    assert "invalid_operator" in codes(validate_workflow(workflow, catalog))


def test_needs_confirmation_must_not_have_threshold(workflow, catalog):
    node(workflow, "is_heavy")["value"] = 10
    assert "value_not_allowed" in codes(validate_workflow(workflow, catalog))


def test_needs_confirmation_requires_note(workflow, catalog):
    del node(workflow, "is_heavy")["confirmation_note"]
    assert "missing_field" in codes(validate_workflow(workflow, catalog))


def test_threshold_requires_human_side_evidence(workflow, catalog):
    node(workflow, "is_large")["source_evidence"] = [{"type": "ai_hypothesis", "note": "推測"}]
    assert "threshold_without_evidence" in codes(validate_workflow(workflow, catalog))


def test_defined_decision_requires_evidence(workflow, catalog):
    node(workflow, "is_soft")["source_evidence"] = []
    assert "missing_evidence" in codes(validate_workflow(workflow, catalog))


def test_threshold_must_be_number(workflow, catalog):
    node(workflow, "is_large")["value"] = "0.15"
    assert "invalid_value_type" in codes(validate_workflow(workflow, catalog))


def test_invalid_evidence_type(workflow, catalog):
    node(workflow, "is_soft")["source_evidence"].append({"type": "rumor"})
    assert "invalid_evidence_type" in codes(validate_workflow(workflow, catalog))


def test_unknown_skill(workflow, catalog):
    node(workflow, "place_top")["skill_name"] = "throw"
    assert "unknown_skill" in codes(validate_workflow(workflow, catalog))


def test_skill_parameter_rules(workflow, catalog):
    node(workflow, "place_top")["parameters"] = {"zone": "roof", "press_mode": "normal", "speed": 3}
    c = codes(validate_workflow(workflow, catalog))
    assert "invalid_parameter" in c
    del node(workflow, "place_bottom")["parameters"]["press_mode"]
    assert "missing_parameter" in codes(validate_workflow(workflow, catalog))


def test_end_result_whitelist(workflow, catalog):
    node(workflow, "end_placed")["result"] = "success"
    assert "invalid_end_result" in codes(validate_workflow(workflow, catalog))


def test_start_node_must_be_start_type(workflow, catalog):
    workflow["start_node_id"] = "observe_attrs"
    assert "invalid_start_node" in codes(validate_workflow(workflow, catalog))


def test_handoff_must_lead_to_end(workflow, catalog):
    workflow["nodes"].append({"id": "ask_human", "type": "handoff", "reason": "確認", "next": "place_top"})
    node(workflow, "is_heavy")["on_false"] = "ask_human"
    assert "handoff_not_to_end" in codes(validate_workflow(workflow, catalog))


def test_provisional_action_requires_note_and_evidence(workflow, catalog):
    n = node(workflow, "place_unknown_provisional")
    del n["provisional_note"]
    n["source_evidence"] = []
    c = codes(validate_workflow(workflow, catalog))
    assert "missing_field" in c and "missing_evidence" in c


def test_provisional_flag_must_be_boolean(workflow, catalog):
    node(workflow, "place_top")["provisional"] = "yes"
    assert "invalid_provisional" in codes(validate_workflow(workflow, catalog))


def test_unreachable_node_is_warning_only(workflow, catalog):
    workflow["nodes"].append({"id": "orphan_end", "type": "end", "result": "placed"})
    r = validate_workflow(workflow, catalog)
    assert r.ok
    assert [w.code for w in r.warnings] == ["unreachable_node"]


def test_not_a_workflow(catalog):
    assert not validate_workflow([], catalog).ok
    assert not validate_workflow({"workflow_id": "x", "version": 1, "start_node_id": "s", "nodes": []}, catalog).ok
