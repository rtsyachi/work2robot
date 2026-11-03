"""自動化の事前評価（Automation Readiness）。

業務実行トレース・ワークフロー・スキル一覧・確認事項から、決定的に4つの区分へ整理する
（docs/WORKFLOW_SPEC.md「状態区分」）。単一の「自動化可能率」には集約しない。
"""
from __future__ import annotations

from typing import Any

# 判断に使う属性を、実機で得るための手段の例（模擬荷物マスタの代わり）
SENSING = {
    "material_class": "材質の判定（カメラ画像・出荷データ）",
    "fragile_content": "壊れ物表示の読取（ラベルのOCR・出荷データ）",
    "base_area_m2": "底面寸法の計測（3Dカメラ・寸法計）",
    "weight_kg": "重量の計測（はかり・力覚センサ）",
    "dims_m": "寸法の計測（3Dカメラ・寸法計）",
}
FIELD_LABEL = {
    "material_class": "材質", "fragile_content": "壊れ物", "base_area_m2": "底面積",
    "weight_kg": "重量", "dims_m": "寸法", "object_type": "荷物の種類",
}
STATUS_LABEL = {
    "needs_physical_poc": "論理的に処理可能・実機PoC待ち",
    "needs_information": "暫定動作（基準・情報の確認待ち）",
    "requires_human": "人の確認・引継ぎが必要",
}


def _item_status(item: dict) -> tuple[str, list[str]]:
    trace = item["item_trace"]
    reasons = []
    if item["outcome"] == "handed_off":
        return "requires_human", [f"人へ引継ぎ：{item['handoff_reason']}"]
    for p in trace["provisional_actions"]:
        kinds = {e["type"] for e in p["evidence"]}
        if kinds <= {"ai_hypothesis", "unknown"}:
            return "requires_human", [f"AIの仮説による暫定動作：{p['note']}"]
        reasons.append(f"暫定動作：{p['note']}")
    if reasons:
        return "needs_information", reasons
    return "needs_physical_poc", ["ワークフロー上の判断は根拠付きで確定。物理的な把持・配置は実機で未検証"]


def assess(job_trace: dict, workflow: dict, catalog: dict, confirmation_items: list[dict] | None = None) -> dict:
    skills = {s["name"]: s for s in catalog["skills"]}
    nodes = {n["id"]: n for n in workflow["nodes"]}
    items = job_trace["items"]

    per_item = []
    for it in items:
        status, reasons = _item_status(it)
        per_item.append({"object_id": it["object_id"], "status": status, "label": STATUS_LABEL[status], "reasons": reasons})

    # 1. 論理的に確認できたこと
    decisions = [n for n in workflow["nodes"] if n["type"] == "decision"]
    defined = [n for n in decisions if n.get("definition_status") == "defined"]
    used_edges = {(s["node_id"], s.get("edge")) for it in items for s in it["item_trace"]["steps"] if s["node_type"] == "decision"}
    checked = [
        f"ワークフローの構造を検証（ノード{len(nodes)}個・判断{len(decisions)}個、全ての判断に「不明」の行き先あり）",
        f"業務全体を最後まで実行（荷物{len(items)}個：配置{job_trace['end']['placed']}個・引継ぎ{job_trace['end']['handed_off']}個、積む順番 {' → '.join(job_trace['order'])}）",
        f"根拠付きで定義済みの判断 {len(defined)}個：" + "、".join(n.get("label", n["id"]) for n in defined),
        f"今回の荷物で通った分岐 {len(used_edges)}通り",
    ]

    # 2. 情報不足（基準が未定義・属性が不明・実機での取得手段が必要）
    info: list[str] = []
    for n in decisions:
        if n.get("definition_status") == "needs_confirmation":
            info.append(f"基準が未定義：{n.get('label', n['id'])}（{n.get('confirmation_note', '')}）")
    unknown = sorted({f for it in items for f in it["item_trace"]["unknown_fields"]})
    for f in unknown:
        objs = [it["object_id"] for it in items if f in it["item_trace"]["unknown_fields"]]
        info.append(f"属性が不明：{FIELD_LABEL.get(f, f)}（荷物 {', '.join(objs)}）")
    used_fields = sorted({n["field"] for n in decisions} | {"dims_m"})
    for f in used_fields:
        sources = {it["item_trace"]["steps"][1].get("observed", {}).get(f, {}).get("source") for it in items}
        if "mock_metadata" in sources or f == "dims_m":
            info.append(f"実機では「{FIELD_LABEL.get(f, f)}」の取得手段が必要：{SENSING.get(f, '取得方法を確認')}（今回は模擬荷物マスタ）")

    # 3. 実機PoCで確かめること（使ったスキルの未検証能力）
    poc: list[str] = []
    used_skills = {e["skill"] for it in items for e in it["item_trace"]["skill_events"]}
    for name in sorted(used_skills):
        s = skills.get(name, {})
        status = "未検証（模擬スキル）" if s.get("physical_verification") == "unverified" else s.get("physical_verification", "")
        poc.append(f"{s.get('description', name)}：{status}")
        poc.extend(s.get("poc_checks", []))
    if any(it.get("press_mode") == "no_press" for it in items):
        poc.append("押し込まない置き方の力加減（壊れ物・属性不明の荷物）")
    if any(it.get("placement") and it["placement"].get("support") for it in items):
        supported = [f"{it['object_id']}を{it['placement']['support']}の上" for it in items
                     if it.get("placement") and it["placement"].get("support")]
        poc.append("積み重ねの安定性：" + "、".join(supported))

    # 4. 人の確認・引継ぎが必要
    human = [f"荷物{p['object_id']}：{r}" for p in per_item if p["status"] == "requires_human" for r in p["reasons"]]

    for c in confirmation_items or []:
        line = f"{c['topic']}：{c['detail']}"
        if c["kind"] in ("undefined_condition", "missing_information"):
            info.append(line)
        elif c["kind"] == "physical_poc":
            poc.append(line)
        elif c["kind"] == "provisional_action":
            human.append(line)

    counts = {k: sum(1 for p in per_item if p["status"] == k) for k in STATUS_LABEL}
    return {
        "items": per_item,
        "categories": {
            "workflow_checked": checked,
            "needs_information": list(dict.fromkeys(info)),
            "needs_physical_poc": list(dict.fromkeys(poc)),
            "requires_human": list(dict.fromkeys(human)),
        },
        "counts": counts,
        "note": "仮想環境での作業ロジックの検証結果です。実機の把持・安全性・稼働率は検証していません。",
    }
