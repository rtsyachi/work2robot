"""決定的なワークフロー実行器。

検証済みワークフローと荷物1個の属性から通る経路を決め、実行トレースを返す。
同じワークフロー版・入力・スキル一覧なら常に同じトレースになる（docs/WORKFLOW_SPEC.md「実行トレース」）。
Claudeの呼び出し、描画、物理計算、複数荷物の順序決めはしない。
"""
from __future__ import annotations

import copy
from typing import Any

from .validator import ValidationResult, validate_workflow

TRACE_VERSION = 1
_EDGE_BY_OUTCOME = {"true": "on_true", "false": "on_false", "unknown": "on_unknown"}


class WorkflowValidationError(Exception):
    """検証に通らないワークフローは実行しない。"""

    def __init__(self, result: ValidationResult):
        self.result = result
        codes = ", ".join(i.code for i in result.errors)
        super().__init__(f"ワークフローの検証エラー: {codes}")


def _known_attr(attrs: dict, name: str) -> dict | None:
    """値と入手元が分かっている属性だけを返す。欠損・null・source=unknown は不明（None）。"""
    a = attrs.get(name)
    if not isinstance(a, dict):
        return None
    if a.get("value") is None or a.get("source") in (None, "unknown"):
        return None
    return {"value": a["value"], "source": a["source"]}


def _is_number(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _evaluate(node: dict, attrs: dict) -> tuple[str, str | None]:
    """判断ノードを3値（true/false/unknown）で評価し、不明の理由を返す。"""
    field = node["field"]
    if node["definition_status"] == "needs_confirmation":
        return "unknown", f"判断基準が未定義：{node['confirmation_note']}"
    a = _known_attr(attrs, field)
    op = node["operator"]
    if op == "is_known":
        return ("true" if a else "false"), None
    if a is None:
        return "unknown", f"属性「{field}」が不明"
    v, target = a["value"], node["value"]
    if op == "eq":
        if isinstance(v, bool) != isinstance(target, bool):
            return "unknown", f"属性「{field}」の型が判断条件と一致しない"
        return ("true" if v == target else "false"), None
    if not (_is_number(v) and _is_number(target)):
        return "unknown", f"属性「{field}」が数値ではない"
    ok = v >= target if op == "ge" else v < target
    return ("true" if ok else "false"), None


def run_workflow(workflow: dict, obj: dict, catalog: dict) -> dict:
    """荷物1個についてワークフローを実行し、実行トレースを返す。"""
    result = validate_workflow(workflow, catalog)
    if not result.ok:
        raise WorkflowValidationError(result)

    nodes = {n["id"]: n for n in workflow["nodes"]}
    attrs = obj.get("attributes", {}) or {}
    trace: dict[str, Any] = {
        "trace_version": TRACE_VERSION,
        "workflow_id": workflow["workflow_id"],
        "workflow_version": workflow["version"],
        "object_id": obj.get("object_id"),
        "steps": [],
        "edges": [],
        "skill_events": [],
        "handoffs": [],
        "unknown_fields": [],
        "unconfirmed_conditions": [],
        "provisional_actions": [],
        "result": None,
    }

    current = workflow["start_node_id"]
    for index in range(len(nodes)):  # 検証済みのDAGなので、ノード数以内で必ず end に達する
        node = nodes[current]
        ntype = node["type"]
        step: dict[str, Any] = {"index": index, "node_id": current, "node_type": ntype}
        if "label" in node:
            step["label"] = node["label"]
        label = "next"

        if ntype == "observe":
            observed, missing = {}, []
            for f in node["required_fields"]:
                a = _known_attr(attrs, f)
                if a is None:
                    missing.append(f)
                else:
                    observed[f] = a
            step["observed"] = observed
            step["missing_fields"] = missing
        elif ntype == "decision":
            outcome, reason = _evaluate(node, attrs)
            label = _EDGE_BY_OUTCOME[outcome]
            raw = attrs.get(node["field"])
            step.update({
                "field": node["field"],
                "operator": node["operator"],
                "value": node.get("value"),
                "input": copy.deepcopy(raw) if isinstance(raw, dict) else None,
                "definition_status": node["definition_status"],
                "result": outcome,
                "edge": label,
            })
            if reason:
                step["reason"] = reason
            if node["definition_status"] == "defined":
                step["rule_evidence"] = copy.deepcopy(node.get("source_evidence", []))
            else:
                trace["unconfirmed_conditions"].append(current)
            if outcome == "unknown" and node["definition_status"] == "defined" \
                    and node["field"] not in trace["unknown_fields"]:
                trace["unknown_fields"].append(node["field"])
        elif ntype == "skill":
            provisional = node.get("provisional", False)
            event = {
                "seq": len(trace["skill_events"]),
                "node_id": current,
                "skill": node["skill_name"],
                "parameters": copy.deepcopy(node.get("parameters", {})),
                "provisional": provisional,
            }
            trace["skill_events"].append(event)
            step["skill_event"] = event
            if provisional:
                trace["provisional_actions"].append({
                    "node_id": current,
                    "note": node["provisional_note"],
                    "evidence": copy.deepcopy(node["source_evidence"]),
                })
        elif ntype == "handoff":
            trace["handoffs"].append({"node_id": current, "reason": node["reason"]})
            step["reason"] = node["reason"]
        elif ntype == "end":
            step["result"] = node["result"]
            trace["result"] = node["result"]
            trace["steps"].append(step)
            return trace

        trace["steps"].append(step)
        nxt = node[label]
        trace["edges"].append({"from": current, "to": nxt, "label": label})
        current = nxt

    raise RuntimeError("end に到達しなかった（検証器の不具合）")
