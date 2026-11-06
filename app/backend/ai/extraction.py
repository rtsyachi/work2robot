"""Claudeによるワークフロー抽出（docs/ARCHITECTURE.md「抽出」、docs/WORKFLOW_SPEC.md「抽出結果」）。

入力はテキストのみ（観測テキスト・説明テキスト・属性定義）。Claudeの出力は未検証の草案として扱い、
検証器を通ったものだけを返す。検証エラーがあれば、エラー内容を伝えて作り直しを依頼する。
評価用の正解データ（eval/）は読まない。
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from backend.workflow import validate_workflow
from backend.workflow.validator import EVIDENCE_TYPES, NODE_TYPES

from .client import MODEL

ROOT = Path(__file__).resolve().parents[2]
INPUT_DIR = ROOT / "data" / "demo_input"
RECORD_DIR = ROOT.parent / "local_media" / "extractions"
WORKFLOW_ID = "claude_extracted"
CONFIRMATION_KINDS = ["undefined_condition", "missing_information", "provisional_action", "physical_poc"]

SYSTEM_PROMPT = """あなたは物流現場の作業分析の専門家です。人の作業を記録した観測テキストと、作業者による説明テキストから、ロボットが「荷物1個」を処理するための分岐付きワークフローをJSONで作ります。出力はそのまま検証器と決定的な実行器にかけられ、仮想ロボットの動作になります。

## 構造
- 荷物1個の処理を表す有向非巡回グラフ。ノード型は start / observe / decision / skill / handoff / end のみ。
- start → observe（判断に使う属性を確認）→ decision … → skill → end の形にする。複数荷物の順番はグラフの外で扱うので表現しない。
- id は英小文字のスネークケースで一意。label は画面に出す短い日本語。
- そのノード型で使わない項目は、文字列なら空文字列 ""、配列なら空配列、provisional は false、value は null にする。
- end の result は placed。人へ引き継ぐ場合だけ handoff → end(result=handed_off) を使う。

## 判断ノード（decision）
- field は属性定義にある名前だけを使う。荷物のIDやタグ（A, B…）で分岐しない。
- operator は eq / ge / lt / is_known のみ。on_true・on_false・on_unknown をすべて指定する。
- 説明テキストに基準が明示されている条件だけ definition_status を defined にし、value に入れる。数値の閾値には、その基準を述べた説明テキストのセグメントを必ず source_evidence に含める。
- 基準が示されていない条件（例：何kg以上が「重い」かが示されていない）は definition_status を needs_confirmation、value を null とし、何が未定義かを confirmation_note に書く。閾値を推測で作らない。

## 不明・要確認のときの暫定動作
- 属性が不明な場合や needs_confirmation の判断でも、原則として人へ引き継がずに「暫定動作」で積付を完了させる。暫定動作は skill ノードで provisional を true にし、provisional_note（なぜ暫定か）と source_evidence を必ず書く。
- 観測・説明に人の作業例があれば、それと同じ結果になる動作にし、その観測・説明のセグメントを根拠にする。
- 作業例がなければ、根拠の type を ai_hypothesis とした仮説の動作にし、仮説であることを provisional_note に書く。壊れ物や柔らかい物の可能性がある場合は、潰さない慎重な置き方を優先する。
- handoff は、安全上ロボットに任せられないと判断できる場合だけ使う。

## 動作ノード（skill）
- スキル一覧にある skill_name と、その定義にある parameters の値だけを使う。暫定動作でない skill は provisional を false にする。
- label は動作（行為）だけを書く（例：「最上段に押し込まずに置く」「規則に従って置く」「慎重に置く（暫定）」）。どの荷物の場合か（柔らかい・重い・材質や重さが不明など）は手前の判断ノードの分岐で表し、label に入れない。

## 根拠（source_evidence）
- type は、説明テキストならその source_type、観測テキストならその source_type、属性定義なら mock_metadata、あなたの推測なら ai_hypothesis。
- ref には根拠にしたセグメントID（例: "E2", "S3", "O5"）を入れる。該当がなければ空文字列。
- 観測・説明にない分岐を、観測した事実として扱わない。

{job_section}

## 確認事項（confirmation_items）
現場担当者や実機PoCで確かめるべきことを挙げる。kind は undefined_condition（基準が未定義の条件）、missing_information（判断に必要だが入手方法が分からない情報）、provisional_action（暫定動作の妥当性）、physical_poc（実機で確かめるべき把持・干渉・力加減など）。detail は現場担当者が読んで分かる日本語で書く。

## summary
抽出したワークフローの要点を日本語で3文以内にまとめる。"""

JOB_SECTION_V1 = """## 業務全体（job）
カゴ車1台分の業務として、荷物をどの区画から先に積むか（order_zones。例: ["bottom", "top"]＝下段に置く荷物を先に）と、その根拠（order_evidence）、終了条件（end_condition）をまとめる。荷物ごとに上のワークフローを繰り返し実行する前提とする。順番の根拠が観測・説明にない場合は ai_hypothesis とし、確認事項にも挙げる。"""

JOB_SECTION_V2 = """## 業務全体（job）
カゴ車1台分の業務として、業務の規則（rules）を下の「規則の一覧」から選ぶ。荷物ごとに上のワークフローを繰り返し実行し、積む順番・置き場所・終了前の確認は、選んだ規則に従って決定的な実行器が決める。段（下段・上段）や置き場所は荷物1個のワークフローではなく規則で表す（skill の zone は auto、上積み禁止の荷物は top）。

規則の一覧（type：意味）:
{rules}

- 観測・説明・カゴ車の仕様（属性定義の cart）に根拠がある規則だけを選び、source_evidence に根拠を書く（説明のセグメント S…／E…、観測のセグメント O…、仕様なら type を mock_metadata）。根拠のない規則は選ばない。note には、その規則を現場の言葉で1文で書く。
- 説明や観測にある業務上の注意のうち、一覧にないもの・一覧の規則では表せないもの（例：物理的な安定性の確認、設備の操作）は unsupported_rules に text と根拠を書く。一覧の規則に無理に当てはめない。実行器はこれらを「未対応」と表示する。
- 数値の基準（積載重量の上限・積付高さの上限）は、カゴ車の仕様にある値だけを使う（実行器は仕様の値を使う）。説明にない許容範囲（重さの偏りの許容範囲など）は作らず、確認事項にする。
- end_condition は all_items_processed。"""


def system_prompt(scenario: str = "v1") -> str:
    if scenario == "v2":
        from backend.workflow.job_rules import SUPPORTED_RULES

        rules = "\n".join(f"- {k}：{v}" for k, v in SUPPORTED_RULES.items())
        return SYSTEM_PROMPT.replace("{job_section}", JOB_SECTION_V2.replace("{rules}", rules))
    return SYSTEM_PROMPT.replace("{job_section}", JOB_SECTION_V1)


def _str(values: list[str] | None = None) -> dict:
    """文字列項目。使わないときは空文字列（null を許す項目はAPIの上限があるため使わない）。"""
    return {"type": "string"} if values is None else {"type": "string", "enum": ["", *values]}


EVIDENCE_SCHEMA = {
    "type": "object",
    "properties": {
        "type": {"type": "string", "enum": sorted(EVIDENCE_TYPES)},
        "note": {"type": "string"},
        "ref": _str(),
    },
    "required": ["type", "note", "ref"],
    "additionalProperties": False,
}


def job_schema_v2() -> dict:
    from backend.workflow.job_rules import SUPPORTED_RULES

    rule = {
        "type": "object",
        "properties": {
            "type": {"type": "string", "enum": list(SUPPORTED_RULES)},
            "note": {"type": "string"},
            "source_evidence": {"type": "array", "items": EVIDENCE_SCHEMA},
        },
        "required": ["type", "note", "source_evidence"],
        "additionalProperties": False,
    }
    unsupported = {
        "type": "object",
        "properties": {"text": {"type": "string"}, "source_evidence": {"type": "array", "items": EVIDENCE_SCHEMA}},
        "required": ["text", "source_evidence"],
        "additionalProperties": False,
    }
    return {
        "type": "object",
        "properties": {
            "rules": {"type": "array", "items": rule},
            "unsupported_rules": {"type": "array", "items": unsupported},
            "end_condition": {"type": "string", "enum": ["all_items_processed"]},
            "end_note": {"type": "string"},
        },
        "required": ["rules", "unsupported_rules", "end_condition", "end_note"],
        "additionalProperties": False,
    }


STAGE_ROLES = ["item_loop", "final_check", "other"]
BASIS = ["video_observation", "spoken_instruction", "ai_hypothesis"]


def process_schema() -> dict:
    """工程の構造（Level 1 の工程と、工程ごとの詳細＝Level 2）の出力形式（ai/process_structure.py の呼び出しで使う）。
    表示・確認用で、item_loop 以外は実行しない。根拠は refs（観測・説明のセグメントID）と basis（根拠の種類）で表す。
    ノードは**タスク（何をするか）だけ**。判断条件はタスクの中の criteria（基準名・使い方・参照する業務の規則）に入れ、
    条件による分岐は edges の label（「○○のとき」）で表す。判断そのものをノードにしない。
    confirmation_refs は確認事項のID（ワークフロー生成で作ったもの、またはこの呼び出しで加える new_confirmation_items のID）。"""
    from backend.workflow.job_rules import SUPPORTED_RULES

    s = {"type": "string"}
    ids = {"type": "array", "items": s}
    basis = {"type": "string", "enum": BASIS}
    criterion = {
        "type": "object",
        "properties": {"name": s, "how": s, "rule_refs": {"type": "array", "items": {"type": "string", "enum": list(SUPPORTED_RULES)}},
                       "basis": basis, "refs": ids},
        "required": ["name", "how", "rule_refs", "basis", "refs"],
        "additionalProperties": False,
    }
    node = {
        "type": "object",
        "properties": {"id": s, "label": s, "detail": s, "criteria": {"type": "array", "items": criterion},
                       "confirmation_refs": ids, "basis": basis, "refs": ids},
        "required": ["id", "label", "detail", "criteria", "confirmation_refs", "basis", "refs"],
        "additionalProperties": False,
    }
    edge = {"type": "object", "properties": {"source": s, "target": s, "label": s},
            "required": ["source", "target", "label"], "additionalProperties": False}
    stage = {
        "type": "object",
        "properties": {"id": s, "name": s, "purpose": s, "role": {"type": "string", "enum": STAGE_ROLES}, "basis": basis, "refs": ids,
                       "nodes": {"type": "array", "items": node}, "edges": {"type": "array", "items": edge}},
        "required": ["id", "name", "purpose", "role", "basis", "refs", "nodes", "edges"],
        "additionalProperties": False,
    }
    item = {"type": "object",
            "properties": {"id": s, "kind": {"type": "string", "enum": CONFIRMATION_KINDS}, "topic": s, "detail": s},
            "required": ["id", "kind", "topic", "detail"], "additionalProperties": False}
    return {"type": "object",
            "properties": {"stages": {"type": "array", "items": stage}, "new_confirmation_items": {"type": "array", "items": item}},
            "required": ["stages", "new_confirmation_items"], "additionalProperties": False}


def _basis_evidence(basis: str, refs: list[str]) -> list[dict]:
    return [{"type": basis, "ref": r} for r in refs if r] or [{"type": basis}]


def to_process(raw: dict) -> dict:
    """工程の構造を表示用に整える（根拠は source_evidence の形にする）。ノードはすべてタスク。
    rule_refs（タスクで使う規則の和集合）と conditions（判断条件を1行ずつ）は、判断条件（criteria）から作る。"""
    stages = []
    for st in raw.get("stages", []):
        nodes = []
        for n in st["nodes"]:
            crit = [{**{k: v for k, v in c.items() if k != "refs"}, "source_evidence": _basis_evidence(c["basis"], c["refs"])}
                    for c in n.get("criteria", [])]
            nodes.append({**{k: v for k, v in n.items() if k not in ("refs", "criteria")}, "type": "task", "criteria": crit,
                          "rule_refs": list(dict.fromkeys(t for c in crit for t in c["rule_refs"])),
                          "conditions": [f"{c['name']}：{c['how']}" for c in crit],
                          "source_evidence": _basis_evidence(n["basis"], n["refs"])})
        stages.append({**{k: v for k, v in st.items() if k != "refs"},
                       "source_evidence": _basis_evidence(st["basis"], st["refs"]), "nodes": nodes})
    return {"stages": stages}


# タスク名に入れない判断の基準（荷物の性質・状態）。これらは criteria に入れる
CRITERIA_WORDS = ("重い", "軽い", "柔らか", "硬い", "壊れ", "大きい", "小さい", "不明", "の場合", "ならば")


def task_label_problem(label: str) -> str | None:
    """タスク名が業務上の行為になっていない理由（判断をノードにしている・基準が混ざっている）。問題なければ None。"""
    text = label.strip()
    if text.endswith(("か", "か？", "?", "？")):
        return "は判断（〜か）になっている"
    hit = next((w for w in CRITERIA_WORDS if w in text), None)
    return f"に判断の基準（{hit}）が入っている" if hit else None


def process_errors(process: dict, job: dict, confirmation_ids: set[str] | None = None) -> tuple[list[dict], list[dict]]:
    """工程の構造の検査（エラー＝作り直させる、注意＝表示する）。"""
    errors: list[dict] = []
    warnings: list[dict] = []
    stages = process.get("stages", [])
    if not stages:
        errors.append({"code": "process_empty", "node_id": "process", "message": "工程（stages）がない"})
    ids = [s["id"] for s in stages]
    if len(ids) != len(set(ids)):
        errors.append({"code": "process_duplicate", "node_id": "process", "message": "工程の id が重複している"})
    loops = [s for s in stages if s["role"] == "item_loop"]
    if len(loops) != 1:
        errors.append({"code": "process_item_loop", "node_id": "process",
                       "message": f"荷物を積む繰り返しの工程（role=item_loop）はちょうど1つにする（今は{len(loops)}個）"})
    from backend.workflow.job_rules import SUPPORTED_RULES

    selected = {r["type"] for r in job.get("rules", [])}
    for s in stages:
        where = s["id"]
        if s["role"] not in STAGE_ROLES:
            errors.append({"code": "process_role", "node_id": where, "message": f"role は {STAGE_ROLES} のどれか（今は {s['role']!r}）"})
        for item in [s, *s["nodes"]]:
            if item["basis"] not in BASIS:
                errors.append({"code": "process_basis", "node_id": where, "message": f"basis は {BASIS} のどれか（今は {item['basis']!r}）"})
        for n in s["nodes"]:
            bad = task_label_problem(n["label"])
            if bad:
                errors.append({"code": "process_task_label", "node_id": f"{where}.{n['id']}",
                               "message": f"タスク名「{n['label']}」{bad}。タスク名は業務上の行為（例：次に積む荷物を決定する）にし、判断の基準は criteria に入れる"})
            for t in n["rule_refs"]:
                if t not in SUPPORTED_RULES:
                    errors.append({"code": "process_rule", "node_id": f"{where}.{n['id']}",
                                   "message": f"rule_refs の {t!r} は規則の一覧にない（一覧で表せない条件は criteria の how に書く）"})
        nids = [n["id"] for n in s["nodes"]]
        if len(nids) != len(set(nids)):
            errors.append({"code": "process_duplicate", "node_id": s["id"], "message": f"工程 {s['id']} のノード id が重複している"})
        for e in s["edges"]:
            if e["source"] not in nids or e["target"] not in nids:
                errors.append({"code": "process_edge", "node_id": s["id"],
                               "message": f"工程 {s['id']} の辺 {e['source']}→{e['target']} が存在しないノードを指している"})
        for n in s["nodes"]:
            for t in n["rule_refs"]:
                if t in SUPPORTED_RULES and t not in selected:
                    warnings.append({"code": "rule_not_selected", "node_id": f"{s['id']}.{n['id']}",
                                     "message": f"規則 {t} は業務の規則に選ばれていない（実行では使われない）"})
            if confirmation_ids is not None:
                for c in n.get("confirmation_refs", []):
                    if c not in confirmation_ids:
                        errors.append({"code": "process_confirmation", "node_id": f"{where}.{n['id']}",
                                       "message": f"confirmation_refs の {c!r} はどの確認事項のIDでもない"})
    return errors, warnings


def output_schema(catalog: dict, scenario: str = "v1") -> dict:
    """抽出結果のJSONスキーマ。ノードは全項目を持つ平坦な形（不要な項目は空文字列・空配列）。"""
    params: dict[str, dict] = {}
    for skill in catalog["skills"]:
        for name, spec in skill["parameters"].items():
            params[name] = _str(spec["values"])
    node = {
        "type": "object",
        "properties": {
            "id": {"type": "string"},
            "type": {"type": "string", "enum": sorted(NODE_TYPES)},
            "label": {"type": "string"},
            "next": _str(),
            "required_fields": {"type": "array", "items": {"type": "string"}},
            "field": _str(),
            "operator": _str(["eq", "ge", "lt", "is_known"]),
            # 判断の閾値。null は「閾値なし（要確認・is_known）」を意味するため、唯一 null を許す
            "value": {"anyOf": [{"type": "string"}, {"type": "number"}, {"type": "boolean"}, {"type": "null"}]},
            "definition_status": _str(["defined", "needs_confirmation"]),
            "confirmation_note": _str(),
            "on_true": _str(),
            "on_false": _str(),
            "on_unknown": _str(),
            "skill_name": _str([s["name"] for s in catalog["skills"]]),
            "parameters": {
                "type": "object",
                "properties": params,
                "required": sorted(params),
                "additionalProperties": False,
            },
            "provisional": {"type": "boolean"},
            "provisional_note": _str(),
            "reason": _str(),
            "result": _str(["placed", "handed_off"]),
            "source_evidence": {"type": "array", "items": EVIDENCE_SCHEMA},
        },
        "additionalProperties": False,
    }
    node["required"] = sorted(node["properties"])
    item = {
        "type": "object",
        "properties": {
            "id": {"type": "string"},
            "kind": {"type": "string", "enum": CONFIRMATION_KINDS},
            "topic": {"type": "string"},
            "detail": {"type": "string"},
            "related_node_ids": {"type": "array", "items": {"type": "string"}},
            "source_evidence": {"type": "array", "items": EVIDENCE_SCHEMA},
        },
        "required": ["id", "kind", "topic", "detail", "related_node_ids", "source_evidence"],
        "additionalProperties": False,
    }
    job = {
        "type": "object",
        "properties": {
            "order_zones": {"type": "array", "items": {"type": "string", "enum": ["bottom", "top"]}},
            "order_note": {"type": "string"},
            "order_evidence": {"type": "array", "items": EVIDENCE_SCHEMA},
            "end_condition": {"type": "string", "enum": ["all_items_processed"]},
            "end_note": {"type": "string"},
        },
        "required": ["order_zones", "order_note", "order_evidence", "end_condition", "end_note"],
        "additionalProperties": False,
    }
    return {
        "type": "object",
        "properties": {
            "start_node_id": {"type": "string"},
            "nodes": {"type": "array", "items": node},
            "job": job_schema_v2() if scenario == "v2" else job,
            "confirmation_items": {"type": "array", "items": item},
            "summary": {"type": "string"},
        },
        "required": ["start_node_id", "nodes", "job", "confirmation_items", "summary"],
        "additionalProperties": False,
    }


# ノード型ごとに残す項目（docs/WORKFLOW_SPEC.md「ノードの詳細」）
_KEEP = {
    "start": {"next"},
    "observe": {"required_fields", "next"},
    "decision": {"field", "operator", "value", "definition_status", "confirmation_note",
                 "on_true", "on_false", "on_unknown", "source_evidence"},
    "skill": {"skill_name", "parameters", "provisional", "provisional_note", "source_evidence", "next"},
    "handoff": {"reason", "next", "source_evidence"},
    "end": {"result"},
}


def _unused(v: Any) -> bool:
    return v is None or v == "" or v == [] or v == {}


def normalize_node(raw: dict) -> dict:
    """平坦な出力ノードを、ワークフロー仕様の形（型ごとの項目のみ、未使用の値を除く）に整える。"""
    ntype = raw.get("type")
    node: dict[str, Any] = {"id": raw.get("id"), "type": ntype}
    if raw.get("label"):
        node["label"] = raw["label"]
    for key in sorted(_KEEP.get(ntype, set())):
        value = raw.get(key)
        if key == "value":
            node["value"] = value  # null は「閾値なし」の意味を持つので残す
        elif key == "provisional":
            node["provisional"] = bool(value)
        elif key == "source_evidence":
            evidence = [{k: v for k, v in e.items() if not _unused(v)} for e in value or []]
            if evidence:
                node["source_evidence"] = evidence
        elif not _unused(value):
            node[key] = value
    if ntype == "skill" and isinstance(node.get("parameters"), dict):
        node["parameters"] = {k: v for k, v in node["parameters"].items() if not _unused(v)}
    if ntype == "skill" and not node.get("provisional"):
        node.pop("provisional_note", None)
    return node


def to_workflow(raw: dict) -> dict:
    return {
        "workflow_id": WORKFLOW_ID,
        "version": 1,
        "start_node_id": raw["start_node_id"],
        "nodes": [normalize_node(n) for n in raw["nodes"]],
    }


def to_job(raw: dict) -> dict:
    """抽出した業務全体（Level 1）を業務定義の形にする。カゴ車の寸法は設備情報として手書き定義から使う。"""
    base = json.loads((ROOT / "data" / "job_fixture.json").read_text(encoding="utf-8"))
    j = raw["job"]
    zones = list(dict.fromkeys(j["order_zones"])) or ["bottom", "top"]
    return {
        "job_id": "claude_extracted_job",
        "label": "カゴ車1台の積付",
        "order_rule": {
            "type": "zone_priority",
            "zones": zones + [z for z in ("bottom", "top") if z not in zones],
            "note": j["order_note"],
            "source_evidence": [{k: v for k, v in e.items() if not _unused(v)} for e in j["order_evidence"]],
        },
        "end_condition": j["end_condition"],
        "end_note": j["end_note"],
        "cart": base["cart"],
    }


def _evidence(items: list[dict]) -> list[dict]:
    return [{k: v for k, v in e.items() if not _unused(v)} for e in items]


def to_job_v2(raw: dict, attributes: dict) -> dict:
    """抽出した業務の規則（シナリオv2）を業務定義の形にする。カゴ車の寸法・上限は設備の仕様（模擬）から使う。"""
    j = raw["job"]
    cart = attributes["cart"]
    rules, seen = [], set()
    for r in j["rules"]:
        if r["type"] in seen:
            continue
        seen.add(r["type"])
        rules.append({"type": r["type"], "note": r["note"], "source_evidence": _evidence(r["source_evidence"])})
    return {
        "job_id": "claude_extracted_job_v2",
        "label": "カゴ車1台の積付（1便分）",
        "cart": {"width_m": cart["inner_width_m"], "depth_m": cart["inner_depth_m"],
                 "height_m": cart["height_limit_m"], "max_load_kg": cart["max_load_kg"]},
        "rules": rules,
        "unsupported_rules": [{"text": u["text"], "source_evidence": _evidence(u["source_evidence"])}
                              for u in j["unsupported_rules"]],
        "balance_tolerance_m": None,  # 説明に基準がないため作らない
        "end_condition": j["end_condition"],
        "end_note": j["end_note"],
    }


def job_errors_v2(job: dict) -> list[dict]:
    """業務定義（v2）の検査。実行器に渡せない形や、根拠のない規則をエラーにする。"""
    from backend.workflow.job_rules import JobRulesError, validate_job_rules

    errors = []
    try:
        validate_job_rules(job)
    except JobRulesError as e:
        errors.append({"code": "invalid_job", "node_id": "job", "message": str(e)})
    for r in job["rules"]:
        if not r["source_evidence"]:
            errors.append({"code": "missing_evidence", "node_id": f"job.{r['type']}",
                           "message": "規則に根拠（source_evidence）がない"})
    return errors


def load_inputs_v2() -> dict:
    """シナリオv2の抽出への入力：動画の音声の文字起こし・動画の観測テキスト・属性定義（カゴ車の仕様を含む）。"""
    from backend import inputs as inputs_mod
    from . import observation, transcription

    # 今の作業動画（Step 2 でアップロードした動画、なければ v5デモ）の最新の文字起こし・観測を使う
    video = inputs_mod.current_video()
    hit_t = inputs_mod.latest_for("transcript", video, directory=transcription.RECORD_DIR)
    hit_o = inputs_mod.latest_for("observation", video, directory=observation.RECORD_DIR)
    tr = {**hit_t[1], "record_file": hit_t[0].name} if hit_t else None
    obs = {**hit_o[1], "record_file": hit_o[0].name} if hit_o else None
    if tr is None:
        raise ExtractionError("説明の文字起こしがありません。先に scripts/run_transcription.py を実行してください")
    if obs is None or obs.get("video") != tr.get("video"):
        raise ExtractionError("文字起こしと同じ動画の観測テキストがありません。先に動画の観測を実行してください")
    keep = ("source_type", "note", "voice_note", "video", "segments", "uncertain", "created_at", "record_file")
    explanation = {k: tr[k] for k in keep if k in tr}
    explanation["segments"] = [{k: s[k] for k in ("id", "t", "text")} for s in tr["segments"]]
    from backend.workflow import masters
    attributes = json.loads((ROOT / "data" / "scenario_v2" / "attribute_schema.json").read_text(encoding="utf-8"))
    attributes["cart"] = masters.cart_spec(masters.load_masters()["environment"])  # カゴ車の仕様は環境マスタから
    return {
        "explanation": explanation,
        "observations": {k: obs[k] for k in keep if k in obs},
        "attributes": attributes,
    }


def load_demo_inputs(observations: str = "dev") -> dict:
    """抽出への入力（シナリオv1）。observations="video" なら保存済みの動画観測テキスト、"dev" なら開発用の固定テキスト。"""
    def load(name: str) -> dict:
        return json.loads((INPUT_DIR / name).read_text(encoding="utf-8"))

    if observations == "video":
        from .observation import latest_observation
        obs = latest_observation()
        if obs is None:
            raise ExtractionError("動画の観測テキストがありません。先に動画の観測を実行してください")
        observed = {k: obs[k] for k in ("source_type", "note", "video", "segments", "uncertain", "created_at", "record_file")
                    if k in obs}
    else:
        observed = load("observations_dev.json")
    return {
        "explanation": load("explanation_text.json"),
        "observations": observed,
        "attributes": load("attribute_schema.json"),
    }


def build_user_content(inputs: dict, catalog: dict) -> str:
    sections = [
        ("属性定義（模擬荷物マスタ）", inputs["attributes"]),
        ("スキル一覧（模擬ロボット）", catalog),
        ("説明（動画の音声の文字起こし）" if inputs["explanation"].get("source_type") == "spoken_instruction"
         else "説明テキスト", inputs["explanation"]),
        ("観測テキスト", inputs["observations"]),
    ]
    if inputs.get("supplement"):  # Step 2 で利用者が入力した補足（入力がないときは従来と同じ入力）
        sections.append(("利用者の補足（未検証。動画・発話の根拠ではない。これだけを根拠にした条件は確認事項に入れる）",
                         inputs["supplement"]))
    body = "\n\n".join(f"## {title}\n```json\n{json.dumps(data, ensure_ascii=False, indent=2)}\n```"
                       for title, data in sections)
    return f"次の入力から、荷物1個を処理する分岐付きワークフローと確認事項を作ってください。\n\n{body}"


class ExtractionError(Exception):
    def __init__(self, message: str, detail: dict | None = None):
        super().__init__(message)
        self.detail = detail or {}


@dataclass
class ExtractionResult:
    workflow: dict
    job: dict
    confirmation_items: list[dict]
    summary: str
    validation: dict
    meta: dict
    raw_outputs: list[str]
    process: dict | None = None  # 工程の構造（v2。ai/process_structure.py の別の呼び出しで作って加える）

    def to_dict(self) -> dict:
        out = {
            "workflow": self.workflow,
            "job": self.job,
            "confirmation_items": self.confirmation_items,
            "summary": self.summary,
            "validation": self.validation,
            "meta": self.meta,
        }
        if self.process is not None:
            out["process"] = self.process
        return out


def _repair_message(errors: list[dict]) -> str:
    lines = "\n".join(f"- [{e['code']}] {e.get('node_id') or '-'}: {e['message']}" for e in errors)
    return f"出力したワークフローは検証エラーになりました。次の点を直して、全体を出力し直してください。\n{lines}"


REVISION_GUIDE = """## 修正の依頼（Step 3：利用者の確認・教示）
上の入力から作った「現在のワークフロー」を、利用者の修正指示に従って直し、全体を同じ形式で出力し直してください。
- 指示に関係しない部分（ノードのid・label・条件・根拠、規則、確認事項）は変えない。
- 工程の構造（工程・タスクの並び）への指示はこのあと別に反映するので、ここでは規則・判断条件・確認事項に関係する部分だけを直す。
- 指示を根拠にする条件・規則・閾値は、source_evidence に type=human_confirmed（note に指示の要点、ref は空文字列）を入れる。人の確認がある数値の閾値は definition_status=defined にしてよい。
- 指示で解決した確認事項は confirmation_items から外す。指示が曖昧で決められない点は確認事項に残す。
- 指示が実行器の規則の一覧や属性定義で表せない場合は、無理に当てはめず unsupported_rules か確認事項にする。
- summary は修正後の内容で書き直す。"""


def build_revision_content(current: dict, instruction: str, focus: str = "") -> str:
    """修正依頼の追記：現在のワークフロー（利用者が確認中の版）と、利用者の指示。"""
    body = (f"{REVISION_GUIDE}\n\n## 現在のワークフロー\n```json\n{json.dumps(current, ensure_ascii=False, indent=1)}\n```\n\n"
            f"## 利用者の修正指示\n{instruction.strip()}")
    if focus:
        body += f"\n\n（利用者が画面で選んでいた箇所：{focus}）"
    return body


def extract_workflow(client: Any, inputs: dict, catalog: dict, *,
                     effort: str = "high", max_attempts: int = 2, scenario: str = "v1",
                     revision: str | None = None) -> ExtractionResult:
    """Claudeでワークフロー案を作り、検証器に通る形で返す。scenario="v2" なら業務の規則の一覧から選ばせる。
    revision を渡すと（build_revision_content の文）、現在のワークフローを利用者の指示で直した全体を作る。"""
    schema = output_schema(catalog, scenario)
    content = build_user_content(inputs, catalog) + (f"\n\n{revision}" if revision else "")
    messages: list[dict] = [{"role": "user", "content": content}]
    usage, raw_outputs, fallback_used = [], [], False
    last_errors: list[dict] = []

    for attempt in range(1, max_attempts + 1):
        with client.beta.messages.stream(
            model=MODEL,
            max_tokens=64000,
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            system=system_prompt(scenario),
            output_config={"effort": effort, "format": {"type": "json_schema", "schema": schema}},
            messages=messages,
        ) as stream:
            msg = stream.get_final_message()

        usage.append({"input_tokens": msg.usage.input_tokens, "output_tokens": msg.usage.output_tokens})
        iterations = getattr(msg.usage, "iterations", None) or []
        fallback_used = fallback_used or any(getattr(i, "type", None) == "fallback_message" for i in iterations)
        if msg.stop_reason == "refusal":
            raise ExtractionError("Claudeが応答を拒否しました", {"stop_details": str(getattr(msg, "stop_details", ""))})
        if msg.stop_reason == "max_tokens":
            raise ExtractionError("出力が上限で途切れました")

        text = "".join(b.text for b in msg.content if b.type == "text")
        raw_outputs.append(text)
        try:
            raw = json.loads(text)
        except json.JSONDecodeError as e:
            raise ExtractionError("出力がJSONとして読めません", {"error": str(e)}) from e

        workflow = to_workflow(raw)
        job = to_job_v2(raw, inputs["attributes"]) if scenario == "v2" else to_job(raw)
        validation = validate_workflow(workflow, catalog).to_dict()
        if scenario == "v2":
            job_errs = job_errors_v2(job)
            validation["errors"] = validation["errors"] + job_errs
            validation["ok"] = validation["ok"] and not job_errs
            # 動作名に判断の基準が混ざっていないか（注意として表示。分岐は判断ノードで表す）
            for n in workflow["nodes"]:
                bad = task_label_problem(n.get("label", "")) if n["type"] == "skill" else None
                if bad:
                    validation["warnings"].append({"code": "skill_label_mixed", "node_id": n["id"], "message": f"動作名「{n['label']}」{bad}"})
        meta = {
            "model": msg.model,
            "requested_model": MODEL,
            "effort": effort,
            "scenario": scenario,
            "explanation_source": inputs["explanation"].get("source_type"),
            "attempts": attempt,
            "usage": usage,
            "fallback_used": fallback_used,
            "observation_source": inputs["observations"]["source_type"],
            "input_ids": {k: [s["id"] for s in inputs[k]["segments"]] for k in ("explanation", "observations")},
        }
        if validation["ok"]:
            return ExtractionResult(workflow, job, raw["confirmation_items"], raw["summary"], validation, meta, raw_outputs)

        last_errors = validation["errors"]
        messages.append({"role": "assistant", "content": msg.content})
        messages.append({"role": "user", "content": _repair_message(last_errors)})

    raise ExtractionError("検証に通るワークフローを生成できませんでした", {"errors": last_errors})


def save_record(result: ExtractionResult, inputs: dict, directory: Path | None = None) -> Path:
    """実際のClaude応答を保存する（docs/ACCEPTANCE.md A01 の証拠）。"""
    directory = directory or RECORD_DIR
    directory.mkdir(parents=True, exist_ok=True)
    created = datetime.now().astimezone().isoformat(timespec="seconds")
    path = directory / f"extraction_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    record = {"created_at": created, "inputs": inputs, **result.to_dict(), "raw_outputs": result.raw_outputs}
    path.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def latest_record(directory: Path | None = None) -> dict | None:
    files = sorted((directory or RECORD_DIR).glob("extraction_*.json"))
    if not files:
        return None
    record = json.loads(files[-1].read_text(encoding="utf-8"))
    record["record_file"] = files[-1].name
    return record
