"""業務全体（Level 1）の実行器：規則の一覧（rules）で動く方式（シナリオv2）。

荷物ごとの判断は Level 2 の実行器（run_workflow）に任せ、ここでは業務の規則を決定的に適用する
（docs/WORKFLOW_SPEC.md「業務の規則」）。
- 積む順番：重い順（order_by_weight_desc）、上積み禁止の荷物を最後に（no_stack_last）
- 置き場所：レンガ積み（brick_pattern）、偏荷重の回避（balance_load）、底面の全面支持（full_support）
- 確認：オーバーハング・積載重量・高さ・重心のずれ
実行器が扱えない規則は適用したことにせず、rule_results に「未対応」として返す。
物理計算はしない（耐圧・摩擦・揺れは対象外。支持は幾何学的な確認のみ、重心は荷物の中心に重量がある仮定）。
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

from .executor import run_workflow

JOB_TRACE_VERSION = 2
EPS = 1e-6
APPROACH_HEIGHT = 0.25
# 仮置き場の既定値（業務定義に staging がないとき。環境マスタの staging と同じ形）
DEFAULT_STAGING = {"first_x_m": -1.0, "pitch_m": 0.6, "rows_z_m": [0.25, 1.45]}
DEFAULT_SUPPORT_RATIO = 0.5   # full_support 規則がないときの最低限の支持割合

SUPPORTED_RULES = {
    "order_by_weight_desc": "重い荷物から先に、下の段から積む",
    "no_stack_last": "上積み禁止の荷物は最後に積み、その上には何も置かない",
    "brick_pattern": "同じ寸法の箱は、同じ段で縦横を組み合わせて置く（レンガ積み）",
    "balance_load": "重心の偏りが小さくなる位置に置く（偏荷重の回避）",
    "full_support": "底面全体が下の硬い箱の上面で支えられる位置にだけ置く",
    "load_limit": "積載重量の上限を超えない",
    "height_limit": "積付高さの上限を超えない",
    "overhang_check": "終了前に、はみ出し（オーバーハング）がないか確認する",
    "balance_check": "終了前に、重さが偏っていないか確認する",
}


class JobRulesError(Exception):
    pass


@dataclass
class Box:
    object_id: str
    x0: float
    x1: float
    z0: float
    z1: float
    y0: float
    y1: float
    weight: float | None
    rigid: bool
    stack_ok: bool
    rotated: bool

    @property
    def cx(self) -> float:
        return (self.x0 + self.x1) / 2

    @property
    def cz(self) -> float:
        return (self.z0 + self.z1) / 2


def _ov(a0: float, a1: float, b0: float, b1: float) -> float:
    return max(0.0, min(a1, b1) - max(a0, b0))


@dataclass
class Cart:
    width: float
    depth: float
    height: float
    boxes: list[Box] = field(default_factory=list)

    def inside(self, x0: float, x1: float, z0: float, z1: float, y1: float) -> bool:
        return (x0 >= -self.width / 2 - EPS and x1 <= self.width / 2 + EPS
                and z0 >= -self.depth / 2 - EPS and z1 <= self.depth / 2 + EPS and y1 <= self.height + EPS)

    def rest_height(self, x0: float, x1: float, z0: float, z1: float) -> float:
        tops = [b.y1 for b in self.boxes if _ov(x0, x1, b.x0, b.x1) > EPS and _ov(z0, z1, b.z0, b.z1) > EPS]
        return max(tops, default=0.0)

    def support(self, x0: float, x1: float, z0: float, z1: float, y0: float) -> tuple[float, list[Box]]:
        """底面を支える面積と、支えている箱（同じ高さの上面）を返す。床なら全面。"""
        if y0 < EPS:
            return (x1 - x0) * (z1 - z0), []
        sup = [b for b in self.boxes if abs(b.y1 - y0) < EPS
               and _ov(x0, x1, b.x0, b.x1) > EPS and _ov(z0, z1, b.z0, b.z1) > EPS]
        area = sum(_ov(x0, x1, b.x0, b.x1) * _ov(z0, z1, b.z0, b.z1) for b in sup)
        return area, sup

    def com(self, extra: tuple[float, float, float] | None = None) -> tuple[float, float, float]:
        """重心の水平位置（x, z）と合計重量。重量不明の荷物は0kgとして扱う。"""
        items = [(b.weight or 0.0, b.cx, b.cz) for b in self.boxes]
        if extra:
            items.append(extra)
        total = sum(w for w, _, _ in items)
        if total <= 0:
            return 0.0, 0.0, 0.0
        return sum(w * x for w, x, _ in items) / total, sum(w * z for w, _, z in items) / total, total

    @property
    def load(self) -> float:
        return sum(b.weight or 0.0 for b in self.boxes)


@dataclass
class Plan:
    arrival: int
    obj: dict
    trace: dict
    event: dict | None
    dims: list[float] | None
    weight: float | None
    rigid: bool

    @property
    def object_id(self) -> str:
        return self.obj["object_id"]

    @property
    def params(self) -> dict:
        return self.event["parameters"] if self.event else {}

    @property
    def zone(self) -> str | None:
        return self.params.get("zone")

    @property
    def stack_forbidden(self) -> bool:
        return self.params.get("stack_above") == "forbidden"


def _attr_value(obj: dict, name: str) -> Any:
    a = obj.get("attributes", {}).get(name)
    if not isinstance(a, dict) or a.get("source") in (None, "unknown"):
        return None
    return a.get("value")


def _dims(obj: dict) -> list[float] | None:
    v = _attr_value(obj, "dims_m")
    if isinstance(v, list) and len(v) == 3 and all(isinstance(x, (int, float)) and x > 0 for x in v):
        return [float(x) for x in v]
    return None


def validate_job_rules(job: Any) -> tuple[list[dict], list[dict]]:
    """対応する規則と、対応外の規則（未対応として表示する）に分ける。"""
    if not isinstance(job, dict) or not isinstance(job.get("rules"), list):
        raise JobRulesError("業務定義に rules 配列がない")
    cart = job.get("cart", {})
    for k in ("width_m", "depth_m", "height_m"):
        if not isinstance(cart.get(k), (int, float)) or cart[k] <= 0:
            raise JobRulesError(f"cart.{k} が不正")
    if job.get("end_condition") != "all_items_processed":
        raise JobRulesError("end_condition は all_items_processed のみ対応")
    supported, unsupported = [], list(job.get("unsupported_rules", []))
    for r in job["rules"]:
        if isinstance(r, dict) and r.get("type") in SUPPORTED_RULES:
            supported.append(r)
        else:
            unsupported.append({"text": str(r.get("text") or r.get("type")) if isinstance(r, dict) else str(r),
                                "source_evidence": r.get("source_evidence", []) if isinstance(r, dict) else []})
    if any(r["type"] == "load_limit" for r in supported) and not isinstance(cart.get("max_load_kg"), (int, float)):
        raise JobRulesError("load_limit には cart.max_load_kg が必要")
    return supported, unsupported


def brick_slots(width: float, depth: float, dims: list[float]) -> list[tuple[float, float, float, float, bool]] | None:
    """同じ寸法の箱1段分のレンガ積み（同じ段で縦横を組み合わせる）の配置。合わなければ None。

    奥側に横向き（長辺が幅方向）の列を k 列、残りの手前側に縦向きの列を並べ、カゴ車の床をちょうど埋める。
    戻り値は (x0, z0, 幅, 奥行, 元の向きから回転したか) の並び（奥の列 → 手前の列、左 → 右）。
    """
    w, d = dims[0], dims[1]
    long_, short = max(w, d), min(w, d)
    if long_ - short < EPS:
        return None  # 正方形の箱は向きを変えても同じ
    n_long, n_short = width / long_, width / short
    if abs(n_long - round(n_long)) > EPS or abs(n_short - round(n_short)) > EPS:
        return None
    for k in range(1, int(depth / short + EPS) + 1):
        if abs(depth - k * short - long_) < EPS:
            slots = []
            for r in range(k):
                for c in range(round(n_long)):
                    slots.append((-width / 2 + c * long_, -depth / 2 + r * short, long_, short, w < d))
            for c in range(round(n_short)):
                slots.append((-width / 2 + c * short, -depth / 2 + k * short, short, long_, w >= d))
            return slots
    return None


def _order(plans: list[Plan], rules: set[str]) -> list[Plan]:
    placeable = [p for p in plans if p.event is not None]
    handoff = [p for p in plans if p.event is None]

    def by_weight(ps: list[Plan]) -> list[Plan]:
        if "order_by_weight_desc" not in rules:
            return sorted(ps, key=lambda p: p.arrival)
        return sorted(ps, key=lambda p: (p.weight is None, -(p.weight or 0.0), p.arrival))

    if "no_stack_last" in rules:
        last = [p for p in placeable if p.stack_forbidden or p.zone == "top"]
        first = [p for p in placeable if p not in last]
        ordered = by_weight(first) + by_weight(last)
    else:
        ordered = by_weight(placeable)
    return ordered + sorted(handoff, key=lambda p: p.arrival)


def run_job_rules(job: dict, workflow: dict, objects: list[dict], catalog: dict,
                  robot: dict | None = None) -> dict:
    """robot（hardware.resolve_config の能力プロファイル）があれば、その構成で扱えない荷物は持ち上げずに
    人へ引き継ぎ、リーチの外には置かない。なければ能力の制約なし（論理だけの実行）。"""
    from .hardware import item_check, profile_summary, reach_needed

    rules_list, unsupported = validate_job_rules(job)
    rules = {r["type"] for r in rules_list}
    c = job["cart"]
    cart = Cart(c["width_m"], c["depth_m"], c["height_m"] if "height_limit" in rules else c["height_m"] + 10.0)
    max_load = c.get("max_load_kg") if "load_limit" in rules else None
    usage: dict[str, list[str]] = {t: [] for t in rules}
    notes: dict[str, list[str]] = {t: [] for t in rules}

    plans = []
    for arrival, obj in enumerate(objects):
        trace = run_workflow(workflow, obj, catalog)
        event = trace["skill_events"][-1] if trace["skill_events"] else None
        weight = _attr_value(obj, "weight_kg")
        plans.append(Plan(arrival, obj, trace, event, _dims(obj),
                          float(weight) if isinstance(weight, (int, float)) else None,
                          _attr_value(obj, "material_class") == "rigid"))
    ordered = _order(plans, rules)
    # 仮置き場（環境マスタ）：カゴ車の左側に列を作り、到着順に列へ交互に並ぶ
    st = {**DEFAULT_STAGING, **(job.get("staging") or {})}
    rows = st["rows_z_m"]
    staging = {p.object_id: [round(st["first_x_m"] - (p.arrival // len(rows)) * st["pitch_m"], 4), 0.0,
                             rows[p.arrival % len(rows)]] for p in plans}

    steps: list[dict] = []
    primitives: list[dict] = []
    items: list[dict] = []
    brick_queue: list[tuple[float, float, float, float, bool, float]] = []
    brick_dims: list[float] | None = None
    brick_checked: set[tuple] = set()   # レンガ積みを検討済みの寸法（同じ寸法で何度も判定しない）

    def step(node_id: str, edge: str = "next", object_id: str | None = None, **extra) -> None:
        steps.append({"seq": len(steps), "node_id": node_id, "object_id": object_id, "edge": edge, **extra})

    def prim(kind: str, oid: str, **extra) -> None:
        primitives.append({"seq": len(primitives), "object_id": oid, "kind": kind, **extra})

    def valid(p: Plan, x0: float, z0: float, pw: float, pd: float, h: float) -> tuple[bool, float, list[Box]]:
        x1, z1 = x0 + pw, z0 + pd
        y0 = cart.rest_height(x0, x1, z0, z1)
        if not cart.inside(x0, x1, z0, z1, y0 + h):
            return False, y0, []
        area, sup = cart.support(x0, x1, z0, z1, y0)
        if any(not b.stack_ok for b in sup):
            return False, y0, sup  # 上積み禁止の荷物の上には置かない
        if "full_support" in rules:
            if area < pw * pd - 1e-9 or any(not b.rigid for b in sup):
                return False, y0, sup
        elif area < DEFAULT_SUPPORT_RATIO * pw * pd:
            return False, y0, sup
        if robot is not None and reach_needed(robot, c, x0 + pw / 2, z0 + pd / 2, y0 + h) > robot["reach_m"] + EPS:
            return False, y0, sup  # アームが届かない
        return True, y0, sup

    def candidates(p: Plan) -> list[dict]:
        w, d, h = p.dims  # type: ignore[misc]
        out = []
        orients = [(w, d, False)] + ([(d, w, True)] if abs(w - d) > EPS else [])
        for pw, pd, rotated in orients:
            xs = {-cart.width / 2, cart.width / 2 - pw} | {b.x1 for b in cart.boxes} | {b.x0 - pw for b in cart.boxes}
            zs = {-cart.depth / 2, cart.depth / 2 - pd} | {b.z1 for b in cart.boxes} | {b.z0 - pd for b in cart.boxes}
            for x0 in sorted(xs):
                for z0 in sorted(zs):
                    ok, y0, sup = valid(p, x0, z0, pw, pd, h)
                    if ok:
                        out.append({"x0": x0, "z0": z0, "pw": pw, "pd": pd, "rotated": rotated, "y0": y0, "sup": sup})
        return out

    def choose(p: Plan, cands: list[dict]) -> dict | None:
        if p.zone == "bottom":
            cands = [cd for cd in cands if cd["y0"] < EPS]
        if not cands:
            return None
        high = p.zone == "top"

        def contacts(cd: dict) -> int:
            """4つの側面のうち、カゴ車の壁か既に置いた箱に接している面の数（隙間を作らない置き方の目安）。"""
            x0, x1, z0, z1 = cd["x0"], cd["x0"] + cd["pw"], cd["z0"], cd["z0"] + cd["pd"]
            y0, y1 = cd["y0"], cd["y0"] + p.dims[2]  # type: ignore[index]
            near = [b for b in cart.boxes if _ov(y0, y1, b.y0, b.y1) > EPS]
            left = abs(x0 + cart.width / 2) < EPS or any(abs(b.x1 - x0) < EPS and _ov(z0, z1, b.z0, b.z1) > EPS for b in near)
            right = abs(x1 - cart.width / 2) < EPS or any(abs(b.x0 - x1) < EPS and _ov(z0, z1, b.z0, b.z1) > EPS for b in near)
            back = abs(z0 + cart.depth / 2) < EPS or any(abs(b.z1 - z0) < EPS and _ov(x0, x1, b.x0, b.x1) > EPS for b in near)
            # 前面は開口なので、手前の縁は壁として数えない
            front = any(abs(b.z0 - z1) < EPS and _ov(x0, x1, b.x0, b.x1) > EPS for b in near)
            return int(left) + int(right) + int(back) + int(front)

        def side_contact(cd: dict) -> bool:
            """左右のどちらかが壁か既に置いた箱に接している（列の途中に置いて空きを分断しない）。"""
            x0, x1, z0, z1 = cd["x0"], cd["x0"] + cd["pw"], cd["z0"], cd["z0"] + cd["pd"]
            y0, y1 = cd["y0"], cd["y0"] + p.dims[2]  # type: ignore[index]
            near = [b for b in cart.boxes if _ov(y0, y1, b.y0, b.y1) > EPS]
            return (abs(x0 + cart.width / 2) < EPS or abs(x1 - cart.width / 2) < EPS
                    or any((abs(b.x1 - x0) < EPS or abs(b.x0 - x1) < EPS) and _ov(z0, z1, b.z0, b.z1) > EPS for b in near))

        def key(cd: dict) -> tuple:
            # 1. 低い段から（上段指定なら最も高い面）
            # 2. 奥から：前面が開口なので、手前を先に埋めると奥に置けなくなる
            # 3. 壁や箱に寄せる：角に収まる程度（2面以上の接触）を同じ扱いにし、中央に置いて場所を分断しない
            # 4. 偏荷重の回避：同じ列の中で、重心のずれが小さい側（途中の偏りは許し、最終形を終了前に確認する）
            # 5. 左から、回転しない向きを優先
            offset = 0.0
            if "balance_load" in rules:
                cx, cz, _ = cart.com((p.weight or 0.0, cd["x0"] + cd["pw"] / 2, cd["z0"] + cd["pd"] / 2))
                offset = round(math.hypot(cx, cz), 6)
            # 奥からの比較は箱の手前の端で行う（奥の壁に付けても、縦にして手前まで張り出す置き方を先にしない）
            return (-cd["y0"] if high else cd["y0"], round(cd["z0"] + cd["pd"], 6), not side_contact(cd),
                    -min(contacts(cd), 2), offset,
                    round(cd["x0"], 6), cd["rotated"])

        return min(cands, key=key)

    step("l1_start")
    step("l1_list", count=len(objects))
    step("l1_order", order=[p.object_id for p in ordered])

    for i, p in enumerate(ordered):
        oid = p.object_id
        item: dict[str, Any] = {
            "object_id": oid, "seq": i, "item_trace": p.trace, "outcome": None, "dims": p.dims,
            "weight_kg": p.weight, "zone": p.zone, "press_mode": p.params.get("press_mode"),
            "stack_above": p.params.get("stack_above", "allowed"),
            "provisional": bool(p.event and p.event.get("provisional")),
            "placement": None, "handoff_reason": None, "applied_rules": [],
        }
        step("l1_take_next", object_id=oid)
        prim("recognize", oid, at=staging[oid])
        reason = None

        if p.event is None:
            reason = p.trace["handoffs"][0]["reason"] if p.trace["handoffs"] else "荷物のワークフローで動作が決まらなかった"
            step("l1_item_workflow", edge="handed_off", object_id=oid)
        else:
            step("l1_item_workflow", edge="placed", object_id=oid)
            chosen = None
            cap = item_check(robot, p.obj) if robot is not None else None
            if cap is not None:
                item["capability"] = cap
            if cap is not None and cap["status"] == "ng":
                # 能力が足りない荷物は持ち上げない（近づいて確認し、人へ引き継ぐ）
                reason = "この構成では扱えない：" + "、".join(cap["ng"])
                prim("check", oid, result="ng", reason=reason, at=staging[oid])
            elif p.dims is None:
                reason = "荷物の寸法が不明なため置き場所を決められない"
            elif max_load is not None and cart.load + (p.weight or 0.0) > max_load + EPS:
                reason = f"積載重量の上限（{max_load}kg）を超える"
                usage["load_limit"].append(oid)
            else:
                # レンガ積み：同じ寸法の箱が続くとき、1段分の配置を先に決めて順に埋める
                if brick_queue and p.dims != brick_dims:
                    brick_queue = []  # 寸法の違う箱が来たら、残りの枠は使わない
                if "brick_pattern" in rules and not brick_queue and tuple(p.dims) not in brick_checked:
                    brick_checked.add(tuple(p.dims))
                    group = [q for q in ordered[i:] if q.event is not None and q.dims == p.dims]
                    slots = brick_slots(cart.width, cart.depth, p.dims) if len(group) >= 2 else None
                    if slots:
                        heights = {round(cart.rest_height(x0, x0 + pw, z0, z0 + pd), 6) for x0, z0, pw, pd, _ in slots}
                        ok = len(heights) == 1 and all(valid(p, x0, z0, pw, pd, p.dims[2])[0]
                                                       for x0, z0, pw, pd, _ in slots)
                        if ok:
                            h0 = next(iter(heights))
                            brick_queue = [(*s, h0) for s in slots[:len(group)]]
                            brick_dims = p.dims
                        else:
                            notes["brick_pattern"].append(f"{oid}：その高さに平らな面がそろっていないため未適用")
                    elif len(group) >= 2:
                        notes["brick_pattern"].append(f"{oid}など：寸法がカゴ車の床に合わないため未適用")
                if brick_queue and p.dims is not None:
                    x0, z0, pw, pd, rotated, _ = brick_queue.pop(0)
                    ok, y0, sup = valid(p, x0, z0, pw, pd, p.dims[2])
                    if ok:
                        chosen = {"x0": x0, "z0": z0, "pw": pw, "pd": pd, "rotated": rotated, "y0": y0, "sup": sup}
                        usage["brick_pattern"].append(oid)
                    else:
                        brick_queue = []
                if chosen is None:
                    chosen = choose(p, candidates(p))
                    if chosen and "balance_load" in rules:
                        usage["balance_load"].append(oid)
                if chosen is None:
                    reason = ("カゴ車に置ける場所がない（支持・高さ・はみ出し" + ("・リーチ" if robot else "")
                              + "の条件を満たす位置がない）")

            if chosen:
                x0, z0, pw, pd, y0 = chosen["x0"], chosen["z0"], chosen["pw"], chosen["pd"], chosen["y0"]
                h = p.dims[2]  # type: ignore[index]
                box = Box(oid, x0, x0 + pw, z0, z0 + pd, y0, y0 + h, p.weight, p.rigid,
                          p.params.get("stack_above") != "forbidden", chosen["rotated"])
                cart.boxes.append(box)
                if "full_support" in rules and y0 > EPS:
                    usage["full_support"].append(oid)
                if p.stack_forbidden and "no_stack_last" in rules:
                    usage["no_stack_last"].append(oid)
                pos = [round(box.cx, 4), round(y0 + h / 2, 4), round(box.cz, 4)]
                supporters = [b.object_id for b in chosen["sup"]]
                step("l1_check_space", edge="on_true", object_id=oid)
                ee = cap["end_effector"] if cap else None
                prim("pick", oid, **{"from": staging[oid]}, end_effector=ee)
                prim("move", oid, to=[pos[0], y0 + h + APPROACH_HEIGHT, pos[2]])
                prim("place", oid, position=pos, rotated=chosen["rotated"], zone=p.zone,
                     press_mode=item["press_mode"], provisional=item["provisional"], end_effector=ee,
                     unverified=cap["unverified"] if cap else [])
                step("l1_place", object_id=oid)
                item.update(outcome="placed", placement={
                    "position": pos, "dims": [round(pw, 4), round(pd, 4), h], "rotated": chosen["rotated"],
                    "support": "+".join(supporters) or None, "supporters": supporters, "base_height": round(y0, 4),
                })
                item["applied_rules"] = [t for t in ("brick_pattern", "balance_load", "full_support", "no_stack_last")
                                         if oid in usage.get(t, [])]
            else:
                step("l1_check_space", edge="on_false", object_id=oid)

        if item["outcome"] is None:
            prim("handoff", oid, reason=reason)
            step("l1_handoff", object_id=oid, reason=reason)
            item.update(outcome="handed_off", handoff_reason=reason)

        cx, cz, total = cart.com()
        item["cart_after"] = {"count": len(cart.boxes), "load_kg": round(total, 2),
                              "com_offset_m": round(math.hypot(cx, cz), 4)}
        step("l1_update", object_id=oid, cart=item["cart_after"])
        items.append(item)
        step("l1_more", edge="on_true" if i < len(ordered) - 1 else "on_false", object_id=oid)

    # 終了前の確認
    cx, cz, total = cart.com()
    checks = {
        "overhang": {"ok": all(cart.inside(b.x0, b.x1, b.z0, b.z1, b.y0) for b in cart.boxes), "checked": "overhang_check" in rules},
        "load": {"total_kg": round(total, 2), "max_kg": c.get("max_load_kg"),
                 "ok": (total <= c["max_load_kg"] + EPS) if isinstance(c.get("max_load_kg"), (int, float)) else None},
        "height": {"max_m": round(max((b.y1 for b in cart.boxes), default=0.0), 4), "limit_m": c["height_m"],
                   "ok": max((b.y1 for b in cart.boxes), default=0.0) <= c["height_m"] + EPS},
        "balance": {"com_offset_m": round(math.hypot(cx, cz), 4), "com": [round(cx, 4), round(cz, 4)],
                    "tolerance_m": job.get("balance_tolerance_m"),
                    "ok": (math.hypot(cx, cz) <= job["balance_tolerance_m"] + EPS) if isinstance(job.get("balance_tolerance_m"), (int, float)) else None,
                    "checked": "balance_check" in rules},
        "unknown_weight": [p.object_id for p in plans if p.weight is None],
    }
    step("l1_final_check", checks={k: v.get("ok") if isinstance(v, dict) else v for k, v in checks.items()})
    step("l1_end")

    rule_results = []
    for r in rules_list:
        t = r["type"]
        if t in ("overhang_check", "balance_check", "load_limit", "height_limit", "order_by_weight_desc"):
            status = "applied"
        else:
            status = "applied" if usage.get(t) else "not_applicable"
        used = usage.get(t, [])
        detail = {
            "order_by_weight_desc": f"積む順番：{' → '.join(p.object_id for p in ordered)}",
            "no_stack_last": f"最後に積んだ上積み禁止の荷物：{', '.join(used) or 'なし'}",
            "brick_pattern": f"レンガ積みで置いた荷物：{', '.join(used) or 'なし'}",
            "balance_load": f"重心の偏りで位置を選んだ荷物：{len(used)}個",
            "full_support": f"底面の全面支持を確認して上段に置いた荷物：{len(used)}個",
            "load_limit": f"積載重量 {checks['load']['total_kg']}kg／上限 {c.get('max_load_kg')}kg" + (
                f"（上限超過で引継ぎ：{', '.join(usage['load_limit'])}）" if usage.get("load_limit") else ""),
            "height_limit": f"最高 {checks['height']['max_m']}m／上限 {c['height_m']}m",
            "overhang_check": "はみ出しなし" if checks["overhang"]["ok"] else "はみ出しあり",
            "balance_check": f"重心のずれ {checks['balance']['com_offset_m']}m" + (
                "（許容範囲が未定義のため合否は判定しない）" if checks["balance"]["tolerance_m"] is None else ""),
        }[t]
        rule_results.append({"type": t, "label": SUPPORTED_RULES[t], "status": status, "detail": detail,
                             "notes": notes.get(t, []), "source_evidence": r.get("source_evidence", [])})
    for u in unsupported:
        rule_results.append({"type": "unsupported", "label": u.get("text", ""), "status": "unsupported",
                             "detail": "実行器が対応していない規則のため、適用していない", "notes": [],
                             "source_evidence": u.get("source_evidence", [])})

    placed = sum(1 for it in items if it["outcome"] == "placed")
    return {
        "job_trace_version": JOB_TRACE_VERSION,
        "job_id": job["job_id"],
        "robot": profile_summary(robot) if robot is not None else None,
        "workflow_id": workflow["workflow_id"],
        "workflow_version": workflow["version"],
        "cart": dict(c),
        "staging": {k: st[k] for k in ("first_x_m", "pitch_m", "rows_z_m")},
        "arrival": [o["object_id"] for o in objects],
        "order": [p.object_id for p in ordered],
        "items": items,
        "level1_steps": steps,
        "primitives": primitives,
        "rule_results": rule_results,
        "checks": checks,
        "end": {"reason": job["end_condition"], "placed": placed, "handed_off": len(items) - placed,
                "load_kg": round(total, 2)},
        "limitations": "支持状態は幾何学的な確認のみで、箱の耐圧・摩擦・走行中の揺れは計算していない。重心は荷物の中心に重量がある仮定の概算。"
                       + ("ロボットの構成は模擬の部品一覧による仕様上の照合で、把持力・関節の可動域・動的な安定性・柵との干渉・安全性は検証していない。"
                          if robot is not None else "ロボットの能力の制約は考慮していない（論理だけの実行）。"),
    }
