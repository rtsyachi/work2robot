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
    unverified = item.get("capability", {}).get("unverified", [])
    for p in trace["provisional_actions"]:
        kinds = {e["type"] for e in p["evidence"]}
        if kinds <= {"ai_hypothesis", "unknown"}:
            return "requires_human", [f"AIの仮説による暫定動作：{p['note']}"]
        reasons.append(f"暫定動作：{p['note']}")
    if reasons:
        return "needs_information", reasons + [f"この構成で未確認：{u}" for u in unverified]
    return "needs_physical_poc", ["ワークフロー上の判断は根拠付きで確定。物理的な把持・配置は実機で未検証"] + \
        [f"この構成で未確認：{u}" for u in unverified]


def _hardware_section(job_trace: dict, hardware: dict) -> tuple[dict, list[dict], list[str], list[str]]:
    """ハードウェアの照合結果を、区分・改善余地（仮説）・PoC項目・情報不足に振り分ける。"""
    check = hardware["check"]
    results = check["results"]
    robot = job_trace.get("robot") or {}
    section = {
        "config_label": hardware.get("label") or robot.get("label", ""),
        "counts": check["counts"],
        "ng": [f"{r['label']}：{r['detail']}" for r in results if r["status"] == "ng"],
        "partial": [f"{r['label']}：{r['detail']}" for r in results if r["status"] == "partial"],
        "unknown": [f"{r['label']}：{r['provided']}（{r['detail']}）" for r in results if r["status"] == "unknown"],
        "ok": [f"{r['label']}：{r['detail']}" for r in results if r["status"] == "ok"],
    }
    improvements: list[dict] = []
    handed = [it for it in job_trace["items"] if it["outcome"] == "handed_off"]
    payload = [it["object_id"] for it in handed if "可搬重量不足" in (it.get("handoff_reason") or "")]
    if payload:
        improvements.append({"kind": "hardware", "source": "computed",
                             "text": f"可搬重量が足りず {', '.join(payload)} を持ち上げられない。可搬重量の大きいアームへの変更、"
                                     "または重い荷物だけ人が積む分担が考えられる"})
    grasp = [it["object_id"] for it in handed if "手先が非対応" in (it.get("handoff_reason") or "")]
    if grasp:
        improvements.append({"kind": "hardware", "source": "computed",
                             "text": f"手先が {', '.join(grasp)} をつかめない。袋をつかめる手先（挟み込み・複合ハンド）への変更が考えられる"})
    reach = [it["object_id"] for it in handed if "リーチ" in (it.get("handoff_reason") or "")]
    if reach:
        improvements.append({"kind": "hardware", "source": "computed",
                             "text": f"アームがカゴ車の奥・上段に届かず {', '.join(reach)} を置けない。リーチの長いアーム、"
                                     "またはカゴ車の向き・位置の見直しが考えられる"})
    for r in results:
        if r["status"] == "ng" and r["kind"] == "capability" and r["id"].startswith("sense_"):
            improvements.append({"kind": "peripheral", "source": "computed",
                                 "text": f"{r['label']}手段がない。センサーや計測設備（例：計量台）の追加が考えられる"})
    for h in hardware.get("improvement_hypotheses", []):
        improvements.append({"kind": h["kind"], "source": "claude", "text": h["text"]})
    product = hardware.get("product") or {}
    section["product"] = product
    poc = [f"ハードウェア（未確認）：{x}" for x in section["unknown"]] + \
          [f"ハードウェア：{u}" for u in hardware.get("unverified_points", [])] + \
          [f"機種（{product.get('name', '')}）の検証：{v}" for v in product.get("verification", [])]
    info = [f"仕様の照合で不足：{x}" for x in section["ng"]] + [f"仕様の照合で一部対応：{x}" for x in section["partial"]]
    if product.get("execution") == "concept":
        poc.insert(0, f"概念プレビュー：{product.get('execution_note', '')}（仮想実行の結果は動作の成立を示さない）")
    return section, improvements, poc, info


def assess(job_trace: dict, workflow: dict, catalog: dict, confirmation_items: list[dict] | None = None,
           hardware: dict | None = None) -> dict:
    """hardware（仕様照合 check と、Claudeの仮選定の unverified_points・improvement_hypotheses）があれば、
    ハードウェアの区分と改善余地（仮説）も出す。"""
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

    hw_section, improvements = None, []
    if hardware is not None:
        hw_section, improvements, hw_poc, hw_info = _hardware_section(job_trace, hardware)
        poc.extend(hw_poc)
        info.extend(hw_info)
    for rr in job_trace.get("rule_results", []):
        if rr["status"] == "unsupported":
            human.append(f"実行器が対応していない業務の注意（人が行う）：{rr['label']}")
        if rr.get("type") == "balance_check" and job_trace.get("checks", {}).get("balance", {}).get("tolerance_m") is None:
            info.append(f"重さの偏りの許容範囲が未定義（最終形の重心のずれ {job_trace['checks']['balance']['com_offset_m']}m は合否を判定していない）")

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
        "hardware": hw_section,
        "improvements": improvements,
        "improvements_note": "改善余地はすべて仮説です。効果は確認していません（構成を替えた再実行の差は仮想環境での結果です）。",
        "note": "仮想環境での作業ロジックの検証結果です。実機の把持・安全性・稼働率は検証していません。",
    }
