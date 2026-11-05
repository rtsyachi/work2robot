"""Claudeによるロボット能力要件の抽出とハードウェア構成の仮選定（docs/WORKFLOW_SPEC.md「ハードウェア構成と能力要件」）。

入力：抽出済みの業務（規則・ワークフロー・確認事項）、コードで計算した能力要件、模擬の部品一覧。
Claudeは部品一覧の中からだけ選ぶ（出力の形式で部品IDを一覧に制限する）。仕様の照合は決定的なコード
（backend/workflow/hardware.py）で行い、照合で ng があればその内容を伝えて選び直させる。
"""
from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any

from backend.workflow.hardware import HardwareError, check_config, resolve_product_config

from .client import MODEL
from .extraction import EVIDENCE_SCHEMA, _evidence

ROOT = Path(__file__).resolve().parents[2]
RECORD_DIR = ROOT.parent / "local_media" / "hardware_selections"
IMPROVEMENT_KINDS = ["order", "pattern", "hardware", "peripheral", "operation"]

SYSTEM_PROMPT = """あなたは物流現場へのロボット導入を検討する技術者です。人の作業から抽出した業務（規則・荷物1個のワークフロー・確認事項）と、コードで計算した能力要件をもとに、この業務に必要なロボットの能力を整理し、仮想メーカーの製品カタログ（products）から機種を1つ選び、その機種が認めるオプションを選んで仮選定します。結果は決定的なコードで互換性と仕様を照合され、選んだ構成で仮想ロボットが業務を実行します。

## 能力要件（capability_requirements）
- カタログの capabilities にある能力のうち、この業務に必要なものを挙げ、なぜ必要かを reason に書く。
- source_evidence には業務の根拠（説明のセグメント S…、観測 O…、模擬荷物マスタなら mock_metadata）を書く。根拠がなく推測で必要と判断したものは type を ai_hypothesis にする。
- 数値の要件（可搬重量・大きさ・リーチ）はコードで計算済み。あなたは数値を作らない。

## 構成（config）
- product_id はカタログの products の id だけ。機種の移動方式・アーム本体（fixed）は変えられない。
- end_effector・sensors・peripherals は、選んだ機種の options に含まれる id だけを使う（他の機種のオプションは付けられない）。
- 機種の可搬（アームの可搬から手先の重さを引いた値）・リーチ・移動能力と、必要な能力を比べて選ぶ。どの機種も全ての要件を満たさない場合は、最も適した機種を選び、満たせない点を unverified_points と alternatives に正直に書く。適合したことにしない。
- execution が concept の機種（このシミュレータで動作を表現できない）を選ぶ場合は、その旨を unverified_points に書く。
- カタログで unverified（未確認）の能力は、未確認のまま扱う。実機で動くと断定しない。

## 選定理由・代わりの候補・未確認の点
- rationale：選んだ機種と各オプションについて、どの要件・業務の根拠に対応するかを短く書く（component には機種IDまたは部品IDを入れる）。
- alternatives：検討した他の機種・オプションと、選ばなかった理由（例：可搬重量が足りない、袋をつかめない、移動できない）。
- unverified_points：この構成で実機PoCで確かめるべき点（未確認の能力、センサーで取れるか分からない情報、干渉・安全）。

## 改善の仮説（improvement_hypotheses）
- 作業・積付順序、積付パターン、ロボット構成、周辺設備、運用の見直しについて、効果が確認されていない仮説として挙げる。kind は order／pattern／hardware／peripheral／operation。
- 「改善できる」と断定せず、何を確かめれば判断できるかを含める。

## summary
選定した構成と理由を日本語で2文以内にまとめる。"""


def output_schema(hw_catalog: dict) -> dict:
    comps = hw_catalog["components"]
    ids = lambda kind: [c["id"] for c in comps[kind]]  # noqa: E731
    products = [p["id"] for p in hw_catalog.get("products", [])]
    all_ids = products + [c["id"] for kind in comps for c in comps[kind]]
    return {
        "type": "object",
        "properties": {
            "capability_requirements": {"type": "array", "items": {
                "type": "object",
                "properties": {"capability": {"type": "string", "enum": list(hw_catalog["capabilities"])},
                               "reason": {"type": "string"},
                               "source_evidence": {"type": "array", "items": EVIDENCE_SCHEMA}},
                "required": ["capability", "reason", "source_evidence"], "additionalProperties": False}},
            "config": {
                "type": "object",
                "properties": {"product_id": {"type": "string", "enum": products},
                               "end_effector": {"type": "string", "enum": ids("end_effector")},
                               "sensors": {"type": "array", "items": {"type": "string", "enum": ids("sensor")}},
                               "peripherals": {"type": "array", "items": {"type": "string", "enum": ids("peripheral")}}},
                "required": ["product_id", "end_effector", "sensors", "peripherals"], "additionalProperties": False},
            "rationale": {"type": "array", "items": {
                "type": "object", "properties": {"component": {"type": "string", "enum": all_ids}, "text": {"type": "string"}},
                "required": ["component", "text"], "additionalProperties": False}},
            "alternatives": {"type": "array", "items": {
                "type": "object", "properties": {"component": {"type": "string", "enum": all_ids}, "reason": {"type": "string"}},
                "required": ["component", "reason"], "additionalProperties": False}},
            "unverified_points": {"type": "array", "items": {"type": "string"}},
            "improvement_hypotheses": {"type": "array", "items": {
                "type": "object", "properties": {"kind": {"type": "string", "enum": IMPROVEMENT_KINDS}, "text": {"type": "string"}},
                "required": ["kind", "text"], "additionalProperties": False}},
            "summary": {"type": "string"},
        },
        "required": ["capability_requirements", "config", "rationale", "alternatives", "unverified_points",
                     "improvement_hypotheses", "summary"],
        "additionalProperties": False,
    }


class HardwareSelectionError(Exception):
    def __init__(self, message: str, detail: dict | None = None):
        super().__init__(message)
        self.detail = detail or {}


def build_user_content(extraction: dict, requirements: list[dict], hw_catalog: dict) -> str:
    business = {"job": extraction["job"], "workflow": extraction["workflow"],
                "confirmation_items": extraction.get("confirmation_items", []), "summary": extraction.get("summary", "")}
    sections = [("抽出済みの業務", business), ("コードで計算した能力要件", requirements), ("仮想メーカーの製品カタログ", hw_catalog)]
    body = "\n\n".join(f"## {t}\n```json\n{json.dumps(d, ensure_ascii=False, indent=2)}\n```" for t, d in sections)
    return f"次の業務に必要なロボットの能力を整理し、カタログの機種とそのオプションから構成を1つ仮選定してください。\n\n{body}"


def _repair(errors: list[str]) -> str:
    return "選んだ構成は次の点で要件を満たしませんでした。部品一覧の中で満たせる構成に選び直し、全体を出力し直してください。\n" + \
        "\n".join(f"- {e}" for e in errors)


def select_hardware(client: Any, extraction: dict, requirements: list[dict], hw_catalog: dict, cart: dict, *,
                    effort: str = "high", max_attempts: int = 2) -> dict:
    """Claudeで構成を仮選定し、決定的な仕様照合の結果と合わせて返す。"""
    schema = output_schema(hw_catalog)
    messages: list[dict] = [{"role": "user", "content": build_user_content(extraction, requirements, hw_catalog)}]
    usage, raw_outputs = [], []
    result = None
    for attempt in range(1, max_attempts + 1):
        with client.beta.messages.stream(
            model=MODEL, max_tokens=32000, betas=["server-side-fallback-2026-07-01"], fallbacks="default",
            system=SYSTEM_PROMPT,
            output_config={"effort": effort, "format": {"type": "json_schema", "schema": schema}},
            messages=messages,
        ) as stream:
            msg = stream.get_final_message()
        usage.append({"input_tokens": msg.usage.input_tokens, "output_tokens": msg.usage.output_tokens})
        if msg.stop_reason == "refusal":
            raise HardwareSelectionError("Claudeが応答を拒否しました")
        if msg.stop_reason == "max_tokens":
            raise HardwareSelectionError("出力が上限で途切れました")
        text = "".join(b.text for b in msg.content if b.type == "text")
        raw_outputs.append(text)
        raw = json.loads(text)
        config = {"config_id": "claude_selected", "label": "Claudeが仮選定した構成", **raw["config"]}
        errors: list[str] = []
        check = None
        try:
            profile = resolve_product_config(config, hw_catalog)   # カタログ外の機種・非対応オプションはここで弾く
            config.update(profile["parts"])
            check = check_config(profile, requirements, cart)
            errors = [f"{r['label']}：{r['detail']}" for r in check["results"] if r["status"] in ("ng", "partial")
                      and r["kind"] != "capability" or r["status"] == "ng"]
        except HardwareError as e:
            errors = [str(e)]
        result = {
            "config": config,
            "capability_requirements": [{**c, "source_evidence": _evidence(c["source_evidence"])}
                                        for c in raw["capability_requirements"]],
            "rationale": raw["rationale"], "alternatives": raw["alternatives"],
            "unverified_points": raw["unverified_points"], "improvement_hypotheses": raw["improvement_hypotheses"],
            "summary": raw["summary"], "check": check, "errors": errors,
            "meta": {"model": msg.model, "effort": effort, "attempts": attempt, "usage": usage},
            "raw_outputs": raw_outputs,
        }
        if not errors:
            return result
        messages.append({"role": "assistant", "content": msg.content})
        messages.append({"role": "user", "content": _repair(errors)})
    if result is not None and result["check"] is not None:
        return result  # 一覧の中で満たせる構成がない場合も、ng を残したまま返す（画面で ng と表示する）
    raise HardwareSelectionError("部品一覧にある構成を選べませんでした", {"errors": result["errors"] if result else []})


def save_selection(sel: dict, directory: Path | None = None) -> Path:
    directory = directory or RECORD_DIR
    directory.mkdir(parents=True, exist_ok=True)
    rec = {"created_at": datetime.now().astimezone().isoformat(timespec="seconds"), **sel}
    path = directory / f"hardware_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    path.write_text(json.dumps(rec, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def latest_selection(directory: Path | None = None) -> dict | None:
    files = sorted((directory or RECORD_DIR).glob("hardware_*.json"))
    if not files:
        return None
    rec = json.loads(files[-1].read_text(encoding="utf-8"))
    rec["record_file"] = files[-1].name
    return rec
