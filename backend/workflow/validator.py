"""ワークフローJSONの検証器。

ワークフローが「実行してよい形」かを決定的に判定する。業務上の正しさは判断せず、
エラー箇所を自動で補完もしない（docs/ARCHITECTURE.md「検証器」）。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

NODE_TYPES = {"start", "observe", "decision", "skill", "handoff", "end"}
OPERATORS = {"eq", "ge", "lt", "is_known"}
VALUE_OPERATORS = {"eq", "ge", "lt"}
THRESHOLD_OPERATORS = {"ge", "lt"}
DEFINITION_STATUSES = {"defined", "needs_confirmation"}
EVIDENCE_TYPES = {
    "video_observation",
    "spoken_instruction",
    "provided_text",
    "mock_metadata",
    "ai_hypothesis",
    "human_confirmed",
    "unknown",
}
THRESHOLD_EVIDENCE_TYPES = {"provided_text", "spoken_instruction", "human_confirmed"}
END_RESULTS = {"placed", "handed_off"}
TOP_LEVEL_KEYS = ("workflow_id", "version", "start_node_id", "nodes")
EDGE_FIELDS: dict[str, tuple[str, ...]] = {
    "start": ("next",),
    "observe": ("next",),
    "decision": ("on_true", "on_false", "on_unknown"),
    "skill": ("next",),
    "handoff": ("next",),
    "end": (),
}


@dataclass(frozen=True)
class Issue:
    code: str
    message: str
    node_id: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {"code": self.code, "message": self.message, "node_id": self.node_id}


@dataclass
class ValidationResult:
    errors: list[Issue] = field(default_factory=list)
    warnings: list[Issue] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.errors

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "errors": [i.to_dict() for i in self.errors],
            "warnings": [i.to_dict() for i in self.warnings],
        }


def _is_number(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _is_nonempty_str(v: Any) -> bool:
    return isinstance(v, str) and v.strip() != ""


def _skill_index(catalog: Any, res: ValidationResult) -> dict[str, dict]:
    skills = catalog.get("skills") if isinstance(catalog, dict) else None
    if not isinstance(skills, list):
        res.errors.append(Issue("invalid_catalog", "スキル一覧に skills 配列がない"))
        return {}
    return {s["name"]: s for s in skills if isinstance(s, dict) and "name" in s}


def _check_evidence(node: dict, nid: str, res: ValidationResult) -> list[dict]:
    ev = node.get("source_evidence", [])
    if not isinstance(ev, list):
        res.errors.append(Issue("invalid_evidence", "source_evidence は配列であること", nid))
        return []
    valid = []
    for e in ev:
        if not isinstance(e, dict) or e.get("type") not in EVIDENCE_TYPES:
            res.errors.append(Issue("invalid_evidence_type", f"根拠の type が不正: {e!r}", nid))
        else:
            valid.append(e)
    return valid


def _check_decision(node: dict, nid: str, res: ValidationResult) -> None:
    if not _is_nonempty_str(node.get("field")):
        res.errors.append(Issue("missing_field", "decision に field がない", nid))
    op = node.get("operator")
    if op not in OPERATORS:
        res.errors.append(Issue("invalid_operator", f"許可されていない演算子: {op!r}", nid))
    status = node.get("definition_status")
    if status not in DEFINITION_STATUSES:
        res.errors.append(Issue("invalid_definition_status", f"definition_status が不正: {status!r}", nid))
    evidence = _check_evidence(node, nid, res)
    value = node.get("value")

    if status == "needs_confirmation":
        if value is not None:
            res.errors.append(Issue(
                "value_not_allowed", "要確認の判断に閾値を入れない（推測値で埋めない）", nid))
        if not _is_nonempty_str(node.get("confirmation_note")):
            res.errors.append(Issue("missing_field", "要確認の判断に confirmation_note がない", nid))
        return

    if status != "defined" or op not in OPERATORS:
        return
    if op == "is_known":
        if value is not None:
            res.errors.append(Issue("value_not_allowed", "is_known は value を持たない", nid))
    elif value is None:
        res.errors.append(Issue("missing_field", f"{op} に value がない", nid))
    elif op in THRESHOLD_OPERATORS and not _is_number(value):
        res.errors.append(Issue("invalid_value_type", f"{op} の value は数値であること", nid))

    if not evidence:
        res.errors.append(Issue("missing_evidence", "定義済みの判断に根拠（source_evidence）がない", nid))
        return
    types = {e["type"] for e in evidence}
    if op in THRESHOLD_OPERATORS and not types & THRESHOLD_EVIDENCE_TYPES:
        res.errors.append(Issue(
            "threshold_without_evidence",
            "閾値の根拠が説明・発話・人の確認のいずれでもない（Claudeが閾値を生成しない）", nid))
    if types <= {"ai_hypothesis", "unknown"}:
        res.warnings.append(Issue("ai_hypothesis_only", "根拠がAIの推測・不明のみ", nid))


def _check_skill(node: dict, nid: str, skills: dict[str, dict], res: ValidationResult) -> None:
    name = node.get("skill_name")
    skill = skills.get(name) if isinstance(name, str) else None
    if skill is None:
        res.errors.append(Issue("unknown_skill", f"スキル一覧にないスキル: {name!r}", nid))
        return
    params = node.get("parameters", {})
    if not isinstance(params, dict):
        res.errors.append(Issue("invalid_parameter", "parameters はオブジェクトであること", nid))
        return
    spec = skill.get("parameters", {})
    for key, val in params.items():
        if key not in spec:
            res.errors.append(Issue("invalid_parameter", f"定義にないパラメータ: {key}", nid))
        elif "values" in spec[key] and val not in spec[key]["values"]:
            res.errors.append(Issue("invalid_parameter", f"{key} に許可されていない値: {val!r}", nid))
    for key, s in spec.items():
        if s.get("required") and key not in params:
            res.errors.append(Issue("missing_parameter", f"必須パラメータがない: {key}", nid))


def _check_provisional(node: dict, nid: str, res: ValidationResult) -> None:
    """暫定動作は、理由（provisional_note）と根拠（動画どおり／AIの仮説など）を必ず持つ。"""
    flag = node.get("provisional", False)
    if not isinstance(flag, bool):
        res.errors.append(Issue("invalid_provisional", "provisional は真偽値であること", nid))
        return
    if not flag:
        return
    if not _is_nonempty_str(node.get("provisional_note")):
        res.errors.append(Issue("missing_field", "暫定動作に provisional_note がない", nid))
    if not _check_evidence(node, nid, res):
        res.errors.append(Issue("missing_evidence", "暫定動作に根拠（source_evidence）がない", nid))


def _check_node(node: dict, nid: str, ntype: str, skills: dict[str, dict], res: ValidationResult) -> None:
    for f in EDGE_FIELDS[ntype]:
        if not _is_nonempty_str(node.get(f)):
            res.errors.append(Issue("missing_field", f"{ntype} に {f} がない", nid))
    if ntype == "observe":
        rf = node.get("required_fields")
        if not isinstance(rf, list) or not rf or not all(_is_nonempty_str(x) for x in rf):
            res.errors.append(Issue("missing_field", "observe の required_fields が空または不正", nid))
    elif ntype == "decision":
        _check_decision(node, nid, res)
    elif ntype == "skill":
        _check_skill(node, nid, skills, res)
        _check_provisional(node, nid, res)
        if node.get("provisional") is True:
            return  # 根拠は _check_provisional で検証済み
    elif ntype == "handoff":
        if not _is_nonempty_str(node.get("reason")):
            res.errors.append(Issue("missing_field", "handoff に reason がない", nid))
    elif ntype == "end":
        if node.get("result") not in END_RESULTS:
            res.errors.append(Issue("invalid_end_result", f"end の result が不正: {node.get('result')!r}", nid))
    if ntype != "decision" and "source_evidence" in node:
        _check_evidence(node, nid, res)


def _find_cycle(nodes: dict[str, dict]) -> str | None:
    WHITE, GRAY, BLACK = 0, 1, 2
    color = {nid: WHITE for nid in nodes}

    def visit(nid: str) -> str | None:
        color[nid] = GRAY
        for f in EDGE_FIELDS[nodes[nid]["type"]]:
            nxt = nodes[nid][f]
            if color[nxt] == GRAY:
                return nxt
            if color[nxt] == WHITE:
                found = visit(nxt)
                if found:
                    return found
        color[nid] = BLACK
        return None

    for nid in nodes:
        if color[nid] == WHITE:
            found = visit(nid)
            if found:
                return found
    return None


def _reachable(nodes: dict[str, dict], start: str) -> set[str]:
    seen, stack = set(), [start]
    while stack:
        nid = stack.pop()
        if nid in seen:
            continue
        seen.add(nid)
        stack.extend(nodes[nid][f] for f in EDGE_FIELDS[nodes[nid]["type"]])
    return seen


def validate_workflow(workflow: Any, catalog: Any) -> ValidationResult:
    """ワークフローJSONとスキル一覧を受け取り、検証結果を返す。"""
    res = ValidationResult()
    if not isinstance(workflow, dict):
        res.errors.append(Issue("invalid_workflow", "ワークフローがオブジェクトではない"))
        return res
    for key in TOP_LEVEL_KEYS:
        if key not in workflow:
            res.errors.append(Issue("missing_top_level_key", f"トップレベルに {key} がない"))
    raw_nodes = workflow.get("nodes")
    if not isinstance(raw_nodes, list) or not raw_nodes:
        res.errors.append(Issue("invalid_nodes", "nodes は空でない配列であること"))
        return res

    skills = _skill_index(catalog, res)
    nodes: dict[str, dict] = {}
    for node in raw_nodes:
        if not isinstance(node, dict) or not _is_nonempty_str(node.get("id")):
            res.errors.append(Issue("invalid_node", f"id のないノード: {node!r}"))
            continue
        nid = node["id"]
        if nid in nodes:
            res.errors.append(Issue("duplicate_id", f"ノードIDが重複: {nid}", nid))
            continue
        ntype = node.get("type")
        if ntype not in NODE_TYPES:
            res.errors.append(Issue("unknown_node_type", f"不明なノード型: {ntype!r}", nid))
            continue
        nodes[nid] = node
        _check_node(node, nid, ntype, skills, res)

    start = workflow.get("start_node_id")
    if start not in nodes or nodes[start]["type"] != "start":
        res.errors.append(Issue("invalid_start_node", f"start_node_id が start 型のノードを指していない: {start!r}"))

    refs_ok = True
    for nid, node in nodes.items():
        for f in EDGE_FIELDS[node["type"]]:
            target = node.get(f)
            if _is_nonempty_str(target) and target not in nodes:
                res.errors.append(Issue("dangling_reference", f"{f} の参照先がない: {target}", nid))
                refs_ok = False
            elif not _is_nonempty_str(target):
                refs_ok = False
        if node["type"] == "handoff" and nodes.get(node.get("next"), {}).get("type") not in (None, "end"):
            res.errors.append(Issue("handoff_not_to_end", "handoff の next は end を指すこと", nid))

    if refs_ok:
        cycle_at = _find_cycle(nodes)
        if cycle_at:
            res.errors.append(Issue("cycle", f"循環がある（{cycle_at} を含む）", cycle_at))
        elif start in nodes:
            for nid in sorted(set(nodes) - _reachable(nodes, start)):
                res.warnings.append(Issue("unreachable_node", "開始ノードから到達できない", nid))
    return res
