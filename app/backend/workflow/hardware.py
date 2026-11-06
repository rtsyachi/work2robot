"""ロボットのハードウェア構成：能力要件の計算・仕様照合・荷物ごとの判定（決定的なコード）。

docs/WORKFLOW_SPEC.md「ハードウェア構成と能力要件」。部品一覧（data/hardware_catalog.json）は模擬で、
実在の機種・実機の動作を表さない。能力は supported／unsupported／unverified の3値で扱い、
unverified は「実行はするが実機PoCで確かめる」として残す。
"""
from __future__ import annotations

import math
from typing import Any

STANDOFF_M = 0.35   # ロボットの肩（台車の前端）からカゴ車の開口までの距離（模擬）
RANK = {"supported": 3, "partial": 2, "unverified": 1, "unsupported": 0}
STATUS_OF = {"supported": "ok", "partial": "partial", "unverified": "unknown", "unsupported": "ng"}


class HardwareError(Exception):
    pass


def _find(catalog: dict, kind: str, cid: str | None) -> dict | None:
    return next((c for c in catalog["components"].get(kind, []) if c["id"] == cid), None)


def resolve_config(config: dict, hw_catalog: dict) -> dict:
    """構成（部品IDの組み合わせ）を、照合と実行に使う能力プロファイルにする。"""
    errors = []
    base = _find(hw_catalog, "base", config.get("base"))
    arm = _find(hw_catalog, "arm", config.get("arm"))
    ee = _find(hw_catalog, "end_effector", config.get("end_effector"))
    sensors = [_find(hw_catalog, "sensor", s) for s in config.get("sensors", [])]
    peripherals = [_find(hw_catalog, "peripheral", s) for s in config.get("peripherals", [])]
    for kind, got, want in (("base", base, config.get("base")), ("arm", arm, config.get("arm")),
                            ("end_effector", ee, config.get("end_effector"))):
        if got is None:
            errors.append(f"{kind} が部品一覧にない：{want}")
    errors += [f"sensor が部品一覧にない：{s}" for s, c in zip(config.get("sensors", []), sensors) if c is None]
    errors += [f"peripheral が部品一覧にない：{s}" for s, c in zip(config.get("peripherals", []), peripherals) if c is None]
    if base and arm and arm["id"] not in base.get("mounts", []):
        errors.append(f"{base['label']}には{arm['label']}を載せられない")
    if errors:
        raise HardwareError("；".join(errors))
    caps: dict[str, dict] = {}
    for comp in [base, arm, ee, *sensors, *peripherals]:
        for cap, st in comp.get("capabilities", {}).items():
            cur = caps.get(cap)
            if cur is None or RANK[st] > RANK[cur["status"]]:
                caps[cap] = {"status": st, "by": comp["id"], "label": comp["label"],
                             "note": comp.get("cap_notes", {}).get(cap, "")}
    for cap in hw_catalog["capabilities"]:
        caps.setdefault(cap, {"status": "unsupported", "by": None, "label": "該当する部品なし"})
    return {
        "config_id": config.get("config_id", "config"),
        "label": config.get("label", ""),
        "components": {"base": base, "arm": arm, "end_effector": ee, "sensors": sensors, "peripherals": peripherals},
        "payload_kg": round(arm["payload_kg"] - ee["mass_kg"], 2),
        "reach_m": arm["reach_m"],
        "shoulder_height_m": base["shoulder_height_m"],
        "max_object_m": ee["max_object_m"],
        "capabilities": caps,
        "verification": "mock",
    }


def find_product(hw_catalog: dict, product_id: str | None) -> dict | None:
    return next((p for p in hw_catalog.get("products", []) if p["id"] == product_id), None)


def resolve_product_config(config: dict, hw_catalog: dict) -> dict:
    """機種（メーカーの製品）とオプションの組み合わせを検査し、能力プロファイルにする。
    機種に固定された構造（移動方式・アーム本体）は変更できず、オプションはその機種が認めるものだけ。"""
    product = find_product(hw_catalog, config.get("product_id"))
    if product is None:
        raise HardwareError(f"カタログにない機種：{config.get('product_id')}")
    errors = []
    for k in ("base", "arm"):
        if config.get(k) and config[k] != product["fixed"][k]:
            errors.append(f"{product['name']}の{'移動方式' if k == 'base' else 'アーム本体'}は固定で、変更できない（{config[k]}）")
    opt = product["options"]
    ee = config.get("end_effector") or product["default"]["end_effector"]
    if ee not in opt["end_effector"]:
        note = product.get("option_notes", {}).get(ee, "メーカーが対応オプションとして提供していない")
        errors.append(f"{product['name']}には手先 {ee} を装着できない（{note}）")
    sensors = list(config.get("sensors") if config.get("sensors") is not None else product["default"]["sensors"])
    peripherals = list(config.get("peripherals") if config.get("peripherals") is not None else product["default"]["peripherals"])
    errors += [f"{product['name']}はセンサー {s} に対応しない" for s in sensors if s not in opt["sensors"]]
    errors += [f"{product['name']}は周辺設備 {s} に対応しない" for s in peripherals if s not in opt["peripherals"]]
    if errors:
        raise HardwareError("；".join(errors))
    maker = next((m for m in hw_catalog.get("manufacturers", []) if m["id"] == product["maker_id"]), {})
    parts = {"config_id": config.get("config_id", product["id"]), "label": config.get("label") or product["name"],
             **product["fixed"], "end_effector": ee, "sensors": sensors, "peripherals": peripherals}
    profile = resolve_config(parts, hw_catalog)
    profile["product"] = {
        "id": product["id"], "name": product["name"], "type": product["type"],
        "maker_id": product["maker_id"], "maker_name": maker.get("name", ""),
        "execution": product.get("execution", "supported"), "execution_note": product.get("execution_note", ""),
        "verification": product.get("verification", []),
    }
    profile["parts"] = {k: parts[k] for k in ("base", "arm", "end_effector", "sensors", "peripherals")}
    return profile


def reach_needed(profile: dict, cart: dict, x_center: float, z_center: float, y_top: float) -> float:
    """カゴ車の前に立った肩から、荷物の上面中央までの距離（台車は左右に動けるので横方向は0とみなす）。
    固定台座は左右に動けないため、横方向のずれも含める。"""
    dz = cart["depth_m"] / 2 + STANDOFF_M - z_center
    dx = 0.0 if profile["capabilities"]["mobility"]["by"] in ("wheeled_base", "legged_humanoid") else x_center
    return math.sqrt(dx * dx + dz * dz + (y_top - profile["shoulder_height_m"]) ** 2)


def compute_requirements(job: dict, workflow: dict, objects: list[dict], hw_catalog: dict) -> list[dict]:
    """業務定義・ワークフロー・模擬の商品・荷姿マスタから、能力要件を決定的に計算する（source=computed）。"""
    caps = hw_catalog["capabilities"]
    rules = {r["type"] for r in job.get("rules", [])}
    cart = job["cart"]

    def attr(o: dict, k: str):
        return o.get("attributes", {}).get(k, {}).get("value")

    reqs: list[dict] = []
    # links：この要求の由来（Step 3 の業務の規則・ワークフローのノード・荷物）
    rule_link = lambda *ts: [{"kind": "rule", "id": t} for t in ts if t in rules]  # noqa: E731
    node_link = lambda pred: [{"kind": "node", "id": n["id"]} for n in workflow["nodes"] if pred(n)]  # noqa: E731
    weights = {o["object_id"]: attr(o, "weight_kg") for o in objects if isinstance(attr(o, "weight_kg"), (int, float))}
    if weights:
        oid = max(weights, key=weights.get)
        unknown = [o["object_id"] for o in objects if o["object_id"] not in weights]
        reqs.append({"id": "payload", "label": "重い箱を持てる（可搬重量）", "kind": "numeric", "value": weights[oid], "unit": "kg",
                     "basis": f"最も重い荷物 {oid}（模擬の商品・荷姿マスタ）" + (f"。重さ不明：{', '.join(unknown)}" if unknown else ""),
                     "per_object": weights, "links": [{"kind": "object", "id": oid}]})
    # 手先で挟む・吸う幅は、荷物の底面の短い辺（item_check と同じ基準）
    widths = {o["object_id"]: min(attr(o, "dims_m")[:2]) for o in objects if isinstance(attr(o, "dims_m"), list)}
    if widths:
        oid = max(widths, key=widths.get)
        reqs.append({"id": "object_size", "label": "荷物の大きさに手先が合う（つかむ幅）", "kind": "numeric",
                     "value": widths[oid], "unit": "m", "basis": f"底面の短い辺が最も長い荷物 {oid}（模擬の商品・荷姿マスタ）",
                     "per_object": widths, "links": [{"kind": "object", "id": oid}]})
    reqs.append({"id": "reach", "label": "カゴ車の上段・奥まで届く（リーチ）", "kind": "geometry",
                 "value": {"depth_m": cart["depth_m"], "height_m": cart["height_m"]},
                 "basis": f"カゴ車の奥行{cart['depth_m']}m・積付高さの上限{cart['height_m']}m（前面の開口から置く）",
                 "links": rule_link("height_limit") + node_link(lambda n: n.get("type") == "skill")})

    def cap(cid: str, basis: str, links: list[dict], objs: list[str] | None = None) -> None:
        r = {"id": cid, "label": caps[cid], "kind": "capability", "basis": basis, "links": links}
        if objs is not None:
            r["objects"] = objs
        reqs.append(r)

    mat = {o["object_id"]: attr(o, "material_class") for o in objects}
    soft_nodes = node_link(lambda n: n.get("type") == "decision" and n.get("field") == "material_class")
    if "rigid" in mat.values():
        cap("grasp_box", "硬い箱がある（模擬の商品・荷姿マスタ）", soft_nodes, [k for k, v in mat.items() if v == "rigid"])
    bags = [k for k, v in mat.items() if v != "rigid"]
    if bags:
        cap("grasp_soft_bag", "柔らかいバッグ（または材質が不明な荷物）がある（模擬の商品・荷姿マスタ）",
            soft_nodes + rule_link("no_stack_last"), bags)
    if "brick_pattern" in rules:
        cap("rotate_90", "レンガ積み（業務の規則）で箱の向きを変える", rule_link("brick_pattern"))
    no_press = node_link(lambda n: n.get("type") == "skill" and n.get("parameters", {}).get("press_mode") == "no_press")
    if no_press:
        cap("place_no_press", "押し込まずに置く動作がある（ワークフロー）", no_press)
    floor = (job.get("work_area") or {}).get("floor", "flat")
    if floor == "step":
        reqs.append({"id": "mobility", "label": caps["mobility"], "kind": "capability", "terrain": "step", "links": [],
                     "basis": "仮置き場とカゴ車が離れていて、パレットゾーンとカゴ車ゾーンの間に段差がある（環境マスタの作業エリア）"})
    else:
        cap("mobility", "仮置き場とカゴ車が離れている", [])
    cap("sense_id", "荷物を見分けて、どの荷物かを特定する", node_link(lambda n: n.get("type") == "observe"))
    cap("sense_dims", "置き場所・はみ出しを判断するのに寸法・位置が要る",
        rule_link("brick_pattern", "full_support", "overhang_check", "height_limit"))
    # 重さは荷姿マスタにあればそれを使う。計測（ロボット側の能力）が要るのは、マスタに重さがない荷物があるときだけ
    weight_rules = rule_link("order_by_weight_desc", "load_limit", "balance_load", "balance_check")
    no_weight = [o["object_id"] for o in objects if o["object_id"] not in weights]
    if weight_rules and no_weight:
        cap("sense_weight", f"重い順・積載上限・偏荷重の判断に重さが要るが、荷姿マスタに重さがない荷物がある：{', '.join(no_weight)}",
            weight_rules, no_weight)
    if soft_nodes:
        cap("sense_material", "材質で分岐する判断がある（今回は模擬の商品・荷姿マスタ）", soft_nodes)
    return reqs


def _numeric(r: dict, have: float, label: str) -> dict:
    """数値の要求：全ての荷物を満たせば ok、一部の荷物だけ満たせば partial、どれも満たせなければ ng。"""
    per = r.get("per_object") or {}
    over = sorted(k for k, v in per.items() if v > have + 1e-9)
    if not over:
        status, extra = "ok", ""
    elif len(over) < len(per):
        status, extra = "partial", f"。扱えない荷物：{', '.join(over)}（人へ引継ぎになる見込み）"
    else:
        status, extra = "ng", "。全ての荷物が対象外"
    return {**r, "status": status, "affected": over,
            "detail": f"{label} {have}{r['unit']} {'≥' if status == 'ok' else '<'} {r['value']}{r['unit']}{extra}"}


def check_config(profile: dict, requirements: list[dict], cart: dict) -> dict:
    """能力要件と構成の仕様を照合する。ok（仕様上対応）／partial（一部対応）／unknown（未確認）／ng（不足）。"""
    results = []
    for r in requirements:
        if r["id"] == "payload":
            res = _numeric(r, profile["payload_kg"], "実効可搬")
            results.append({**res, "provided": f"{profile['payload_kg']}kg（アーム可搬 − 手先の重さ）"})
        elif r["id"] == "object_size":
            res = _numeric(r, profile["max_object_m"], "手先がつかめる幅")
            results.append({**res, "provided": f"{profile['max_object_m']}m"})
        elif r["id"] == "reach":
            need = max(reach_needed(profile, cart, x, -cart["depth_m"] / 2 + 0.1, y)
                       for x in (0.0, -cart["width_m"] / 2 + 0.15) for y in (0.2, cart["height_m"]))
            ok = profile["reach_m"] >= need
            results.append({**r, "status": "ok" if ok else "ng", "provided": f"{profile['reach_m']}m",
                            "detail": f"必要 約{need:.2f}m（肩の高さ{profile['shoulder_height_m']}m）{'≤' if ok else '>'} リーチ {profile['reach_m']}m"})
        elif r["id"] == "mobility" and r.get("terrain") == "step":
            # 段差を越えて移動する：車輪の台車は越えられない。二足歩行は越えられる想定だが未確認。固定式は移動できない
            c = profile["capabilities"].get("mobility", {"status": "unsupported", "label": "該当する部品なし", "by": None})
            if c.get("by") == "wheeled_base":
                status, detail = "ng", "不足：車輪の台車は段差を越えられない"
            elif c["status"] == "unsupported":
                status, detail = "ng", "不足（移動できる部品がない）"
            else:
                status = STATUS_OF[c["status"]]
                detail = {"ok": "仕様上対応（段差を越えて移動）", "partial": "一部対応", "unknown": "未確認（段差を越える歩行は実機PoCで確かめる）",
                          "ng": "不足"}[status]
            results.append({**r, "status": status, "provided": c["label"], "detail": detail, "affected": []})
        else:
            c = profile["capabilities"].get(r["id"], {"status": "unsupported", "label": "該当する部品なし"})
            status = STATUS_OF[c["status"]]
            detail = {"ok": "仕様上対応", "partial": "一部対応", "unknown": "未確認（実機PoCで確かめる）", "ng": "不足（該当する能力の部品がない）"}[status]
            if c.get("note"):
                detail += f"：{c['note']}"
            affected = r.get("objects", []) if status == "ng" else []
            if affected:
                detail += f"。扱えない荷物：{', '.join(affected)}"
            results.append({**r, "status": status, "provided": c["label"], "detail": detail, "affected": affected})
    counts = {k: sum(1 for x in results if x["status"] == k) for k in ("ok", "partial", "unknown", "ng")}
    return {"config_id": profile["config_id"], "results": results, "counts": counts,
            "note": "模擬の部品一覧による仕様上の照合。実機での動作は検証していない。"}


def item_check(profile: dict, obj: dict) -> dict:
    """この構成で荷物を扱えるか（持ち上げる前の判定）。ng なら持ち上げずに人へ引き継ぐ。"""
    a = obj.get("attributes", {})
    weight = a.get("weight_kg", {}).get("value")
    material = a.get("material_class", {}).get("value")
    dims = a.get("dims_m", {}).get("value")
    ng, unknown = [], []
    if isinstance(weight, (int, float)):
        if weight > profile["payload_kg"]:
            ng.append(f"可搬重量不足（{weight}kg > {profile['payload_kg']}kg）")
    else:
        unknown.append("重さが不明（可搬重量を確認できない）")
    if isinstance(dims, list) and min(dims[:2]) > profile["max_object_m"]:
        ng.append(f"手先でつかめない大きさ（{min(dims[:2])}m > {profile['max_object_m']}m）")
    cap_id = {"rigid": "grasp_box", "soft": "grasp_soft_bag"}.get(material, "grasp_soft_bag")
    st = profile["capabilities"][cap_id]["status"]
    label = "材質不明のため柔らかい物として" if material not in ("rigid", "soft") else ""
    if st == "unsupported":
        ng.append(f"{label}手先が非対応（{profile['capabilities'][cap_id]['label']}：{cap_id}）")
    elif st in ("unverified", "partial"):
        unknown.append(f"{label}把持が未確認（{cap_id}）")
    if profile.get("product", {}).get("execution") == "concept":
        unknown.append("二足歩行・双腕での運搬は概念プレビュー（このシミュレータでは表現していない）")
    return {"status": "ng" if ng else "unknown" if unknown else "ok", "ng": ng, "unverified": unknown,
            "end_effector": profile["components"]["end_effector"]["id"]}


def profile_summary(profile: dict) -> dict:
    """実行トレースに残す構成の要約。"""
    comp = profile["components"]
    return {
        "config_id": profile["config_id"], "label": profile["label"],
        "base": comp["base"]["id"], "arm": comp["arm"]["id"], "end_effector": comp["end_effector"]["id"],
        "sensors": [s["id"] for s in comp["sensors"]], "peripherals": [s["id"] for s in comp["peripherals"]],
        "labels": {"base": comp["base"]["label"], "arm": comp["arm"]["label"],
                   "end_effector": comp["end_effector"]["label"]},
        "payload_kg": profile["payload_kg"], "reach_m": profile["reach_m"],
        "shoulder_height_m": profile["shoulder_height_m"], "standoff_m": STANDOFF_M,
        "verification": "mock",
        "product": profile.get("product"),
    }
