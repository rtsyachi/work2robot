"""業務全体（Level 1）の実行器。

荷物ごとの判断は Level 2 の実行器（run_workflow）に任せ、ここでは積む順番・カゴ車の状態・
置き場所の探索・繰り返し・終了条件を決定的に扱う（docs/WORKFLOW_SPEC.md「ワークフローの3階層」）。
3Dビューやグラフは、この業務実行トレースを再生するだけで、判断はしない。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .executor import run_workflow

JOB_TRACE_VERSION = 1
SUPPORT_RATIO = 0.5          # 上段に載せるとき、底面の何割以上が支えられている必要があるか
STAGING_X0 = -1.0            # 仮置き台の最初の荷物のx座標（カゴ車の外）
STAGING_PITCH = 0.55
APPROACH_HEIGHT = 0.25       # Move で荷物を置き場所の上空へ運ぶときの余裕

# Level 1 の流れ図（業務全体）。繰り返しを含むため描画用で、実行は下の run_job が行う。
LEVEL1_NODES = [
    {"id": "l1_start", "type": "start", "label": "積付を開始"},
    {"id": "l1_list", "type": "observe", "label": "荷物一覧を確認"},
    {"id": "l1_order", "type": "decision", "label": "積む順番を決める（下段→上段）"},
    {"id": "l1_take_next", "type": "skill", "label": "次の荷物を取り出す"},
    {"id": "l1_item_workflow", "type": "decision", "label": "荷物1個のワークフロー（Level 2）"},
    {"id": "l1_check_space", "type": "decision", "label": "カゴ車に置き場所があるか"},
    {"id": "l1_place", "type": "skill", "label": "Pick → Move → Place"},
    {"id": "l1_handoff", "type": "handoff", "label": "人へ引継ぎ"},
    {"id": "l1_update", "type": "observe", "label": "カゴ車の状態を更新"},
    {"id": "l1_more", "type": "decision", "label": "残りの荷物があるか"},
    {"id": "l1_end", "type": "end", "label": "積付を終了"},
]
LEVEL1_EDGES = [
    ("l1_start", "l1_list", "next"),
    ("l1_list", "l1_order", "next"),
    ("l1_order", "l1_take_next", "next"),
    ("l1_take_next", "l1_item_workflow", "next"),
    ("l1_item_workflow", "l1_check_space", "placed"),
    ("l1_item_workflow", "l1_handoff", "handed_off"),
    ("l1_check_space", "l1_place", "on_true"),
    ("l1_check_space", "l1_handoff", "on_false"),
    ("l1_place", "l1_update", "next"),
    ("l1_handoff", "l1_update", "next"),
    ("l1_update", "l1_more", "next"),
    ("l1_more", "l1_take_next", "on_true"),
    ("l1_more", "l1_end", "on_false"),
]


class JobError(Exception):
    pass


@dataclass
class Placement:
    object_id: str
    zone: str
    x: float          # 中心
    z: float
    y0: float         # 底面の高さ
    w: float          # x方向の幅
    d: float          # z方向の奥行
    h: float
    support: str | None
    covered: bool = False

    @property
    def top(self) -> float:
        return self.y0 + self.h

    def to_dict(self, rotated: bool) -> dict:
        return {
            "position": [round(self.x, 4), round(self.y0 + self.h / 2, 4), round(self.z, 4)],
            "dims": [self.w, self.d, self.h],
            "rotated": rotated,
            "support": self.support,
        }


@dataclass
class Cart:
    width: float
    depth: float
    height: float
    placements: list[Placement] = field(default_factory=list)
    rows: list[dict] = field(default_factory=list)   # 下段の列：{z0, depth, used}

    def place_bottom(self, oid: str, w: float, d: float, h: float) -> tuple[Placement, bool] | None:
        for rotated, (pw, pd) in ((False, (w, d)), (True, (d, w))):
            for row in self.rows:
                if row["used"] + pw <= self.width + 1e-9 and pd <= row["depth"] + 1e-9:
                    return self._add_bottom(oid, row, pw, pd, h), rotated
        for rotated, (pw, pd) in ((False, (w, d)), (True, (d, w))):
            z0 = sum(r["depth"] for r in self.rows)
            if pw <= self.width + 1e-9 and z0 + pd <= self.depth + 1e-9 and h <= self.height:
                row = {"z0": z0, "depth": pd, "used": 0.0}
                self.rows.append(row)
                return self._add_bottom(oid, row, pw, pd, h), rotated
        return None

    def _add_bottom(self, oid: str, row: dict, w: float, d: float, h: float) -> Placement:
        p = Placement(oid, "bottom", -self.width / 2 + row["used"] + w / 2,
                      -self.depth / 2 + row["z0"] + d / 2, 0.0, w, d, h, None)
        row["used"] += w
        self.placements.append(p)
        return p

    def place_top(self, oid: str, w: float, d: float, h: float) -> tuple[Placement, bool] | None:
        best: tuple[float, float, int, Placement] | None = None
        for i, s in enumerate(self.placements):
            if s.covered or s.top + h > self.height + 1e-9:
                continue
            support = min(w * d, s.w * s.d)
            if support / (w * d) < SUPPORT_RATIO:
                continue
            key = (support, -s.top, -i)
            if best is None or key > best[:3]:
                best = (*key, s)
        if best is None:
            return None
        s = best[3]
        s.covered = True
        p = Placement(oid, "top", s.x, s.z, s.top, w, d, h, s.object_id)
        self.placements.append(p)
        return p, False

    def summary(self) -> dict:
        return {
            "bottom": [p.object_id for p in self.placements if p.zone == "bottom"],
            "top": [p.object_id for p in self.placements if p.zone == "top"],
            "height_used_m": round(max((p.top for p in self.placements), default=0.0), 4),
        }


def validate_job(job: Any) -> None:
    if not isinstance(job, dict):
        raise JobError("業務定義がオブジェクトではない")
    rule = job.get("order_rule", {})
    if rule.get("type") != "zone_priority" or not set(rule.get("zones", [])) <= {"bottom", "top"}:
        raise JobError("order_rule は zone_priority（bottom/top）であること")
    if job.get("end_condition") != "all_items_processed":
        raise JobError("end_condition は all_items_processed のみ対応")
    cart = job.get("cart", {})
    if not all(isinstance(cart.get(k), (int, float)) and cart[k] > 0 for k in ("width_m", "depth_m", "height_m")):
        raise JobError("cart の寸法が不正")


def _dims(obj: dict) -> list[float] | None:
    a = obj.get("attributes", {}).get("dims_m")
    if not isinstance(a, dict) or a.get("source") in (None, "unknown"):
        return None
    v = a.get("value")
    if isinstance(v, list) and len(v) == 3 and all(isinstance(x, (int, float)) and x > 0 for x in v):
        return [float(x) for x in v]
    return None


def run_job(job: dict, workflow: dict, objects: list[dict], catalog: dict) -> dict:
    """荷物の一覧（到着順）を受け取り、業務全体を実行して業務実行トレースを返す。"""
    validate_job(job)
    cart_spec = job["cart"]
    cart = Cart(cart_spec["width_m"], cart_spec["depth_m"], cart_spec["height_m"])
    zones = job["order_rule"]["zones"]

    # 1. 全ての荷物に Level 2 を実行して置く区画を決める（実行器が唯一の判断元）
    planned = []
    for arrival, obj in enumerate(objects):
        trace = run_workflow(workflow, obj, catalog)
        last = trace["skill_events"][-1] if trace["skill_events"] else None
        zone = last["parameters"].get("zone") if last else None
        rank = zones.index(zone) if zone in zones else len(zones)
        planned.append({"arrival": arrival, "obj": obj, "trace": trace, "event": last, "zone": zone, "rank": rank})

    # 2. 積む順番：区画の優先順 → 到着順。引継ぎになる荷物は最後
    planned.sort(key=lambda p: (p["rank"], p["arrival"]))
    staging = {p["obj"]["object_id"]: [STAGING_X0 - p["arrival"] * STAGING_PITCH, 0.0, 0.0] for p in planned}

    steps: list[dict] = []
    primitives: list[dict] = []
    items: list[dict] = []

    def step(node_id: str, edge: str = "next", object_id: str | None = None, **extra) -> None:
        steps.append({"seq": len(steps), "node_id": node_id, "object_id": object_id, "edge": edge, **extra})

    def prim(kind: str, oid: str, **extra) -> None:
        primitives.append({"seq": len(primitives), "object_id": oid, "kind": kind, **extra})

    step("l1_start")
    step("l1_list", count=len(objects))
    step("l1_order", order=[p["obj"]["object_id"] for p in planned])

    # 3〜5. 順番に処理し、カゴ車の状態を更新しながら繰り返す
    for i, p in enumerate(planned):
        oid = p["obj"]["object_id"]
        trace, event = p["trace"], p["event"]
        item = {
            "object_id": oid, "seq": i, "item_trace": trace, "outcome": None, "dims": _dims(p["obj"]),
            "zone": p["zone"], "press_mode": event["parameters"].get("press_mode") if event else None,
            "provisional": bool(event and event.get("provisional")),
            "placement": None, "handoff_reason": None,
        }
        step("l1_take_next", object_id=oid)
        prim("recognize", oid, at=staging[oid])

        if event is None:
            reason = trace["handoffs"][0]["reason"] if trace["handoffs"] else "荷物のワークフローで動作が決まらなかった"
            step("l1_item_workflow", edge="handed_off", object_id=oid)
        else:
            step("l1_item_workflow", edge="placed", object_id=oid)
            dims = _dims(p["obj"])
            result = None
            if dims is None:
                reason = "荷物の寸法が不明なため置き場所を決められない"
            else:
                w, d, h = dims
                result = (cart.place_bottom if p["zone"] == "bottom" else cart.place_top)(oid, w, d, h)
                reason = None if result else ("下段に空きがない" if p["zone"] == "bottom" else "上段に載せられる場所がない")
            if result:
                placement, rotated = result
                step("l1_check_space", edge="on_true", object_id=oid)
                pos = placement.to_dict(rotated)
                prim("pick", oid, **{"from": staging[oid]})
                prim("move", oid, to=[pos["position"][0], placement.top + APPROACH_HEIGHT, pos["position"][2]])
                prim("place", oid, position=pos["position"], rotated=rotated, zone=p["zone"],
                     press_mode=item["press_mode"], provisional=item["provisional"])
                step("l1_place", object_id=oid)
                item.update(outcome="placed", placement=pos)
            else:
                step("l1_check_space", edge="on_false", object_id=oid)

        if item["outcome"] is None:
            prim("handoff", oid, reason=reason)
            step("l1_handoff", object_id=oid, reason=reason)
            item.update(outcome="handed_off", handoff_reason=reason)

        step("l1_update", object_id=oid, cart=cart.summary())
        item["cart_after"] = cart.summary()
        items.append(item)
        step("l1_more", edge="on_true" if i < len(planned) - 1 else "on_false", object_id=oid)

    step("l1_end")
    placed = sum(1 for it in items if it["outcome"] == "placed")
    return {
        "job_trace_version": JOB_TRACE_VERSION,
        "job_id": job["job_id"],
        "workflow_id": workflow["workflow_id"],
        "workflow_version": workflow["version"],
        "cart": dict(cart_spec),
        "arrival": [o["object_id"] for o in objects],
        "order": [p["obj"]["object_id"] for p in planned],
        "items": items,
        "level1_steps": steps,
        "primitives": primitives,
        "end": {"reason": job["end_condition"], "placed": placed, "handed_off": len(items) - placed,
                "cart": cart.summary()},
    }


def level1_graph() -> dict:
    """Level 1 の流れ図（描画用）。"""
    return {"nodes": LEVEL1_NODES, "edges": [{"source": s, "target": t, "field": f} for s, t, f in LEVEL1_EDGES]}
