"""ロボットの作業時間の推定（Step 6）。決定的な計算で、Claudeは使わない。

仮想実行の動作（primitives：認識・確認・つかむ・運ぶ・置く・引継ぎ）の回数と移動距離に、
機種カタログの模擬の速度仕様（hardware_catalog.json の timing。仮の値）を掛けて足す。
- 移動式（台車）：仮置き場からカゴ車までの水平距離を往復で走行し、アームのつかむ・運ぶ・置くを足す。
- 固定式：コンベヤが1個ずつ手元へ送る時間とアームの動作のうち長い方（並行して動く前提）。
- 人へ引き継いだ荷物は、ロボットの確認と引継ぎの時間だけを数え、人の作業時間は含めない。
推定できない構成（速度仕様のない移動方式・アーム、概念プレビューの機種）は None を返す。
"""
from __future__ import annotations

import math
from typing import Any


def estimate_robot_time(trace: dict, config: dict | None, hw_catalog: dict) -> dict | None:
    timing = hw_catalog.get("timing")
    if not timing or not config:
        return None
    # 画面からの構成は機種＋オプションだけのことがある。台車・アームは機種の固定構造から引く
    product = next((p for p in hw_catalog.get("products", []) if p["id"] == config.get("product_id")), None)
    fixed = (product or {}).get("fixed", {})
    config = {**config, "base": config.get("base") or fixed.get("base"), "arm": config.get("arm") or fixed.get("arm")}
    base = timing["base"].get(config.get("base") or "")
    arm = timing["arm"].get(config.get("arm") or "")
    if base is None or arm is None:
        return None
    prims = trace.get("primitives", [])
    by_item: dict[str, list[dict]] = {}
    for p in prims:
        by_item.setdefault(p["object_id"], []).append(p)
    items, total = [], 0.0
    for oid, ps in by_item.items():
        kinds = {p["kind"]: p for p in ps}
        t = timing["recognize_s"] if "recognize" in kinds else 0.0
        travel = 0.0
        if "pick" in kinds and "place" in kinds:
            arm_s = arm["pick_s"] + arm["move_s"] + arm["place_s"] + (timing["rotate_s"] if kinds["place"].get("rotated") else 0.0)
            if "travel_mps" in base:
                a, b = kinds["pick"]["from"], kinds["place"]["position"]
                dist = math.hypot(b[0] - a[0], b[2] - a[2])
                travel = 2 * dist / base["travel_mps"]  # 行って戻る
                t += arm_s + travel
            else:
                t += max(arm_s, base.get("conveyor_feed_s", 0.0))
            outcome = "placed"
        else:
            t += (timing["check_s"] if "check" in kinds else 0.0) + (timing["handoff_s"] if "handoff" in kinds else 0.0)
            outcome = "handed_off"
        items.append({"object_id": oid, "seconds": round(t, 1), "travel_s": round(travel, 1), "outcome": outcome})
        total += t
    total += timing["final_check_s"]
    handed = [i["object_id"] for i in items if i["outcome"] == "handed_off"]
    return {
        "total_s": round(total, 1),
        "items": items,
        "final_check_s": timing["final_check_s"],
        "basis": "mock_spec",
        "note": timing["note"],
        "excludes": ([f"人へ引き継いだ{len(handed)}個（{'・'.join(handed)}）の人の作業時間"] if handed else []) + ["加減速・待ち・段取り替え・故障"],
        "params": {"base": config.get("base"), "arm": config.get("arm"), **base, **arm},
    }
