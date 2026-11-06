"""データ確認（Step 1）：マスタ・トランザクション・その他の読み込み・検証・保存（docs/WORKFLOW_SPEC.md「入力データの区分」「マスタ」）。

業務の解析・ワークフロー・能力照合・仮想実行は、ここで登録した値を使う。
- マスタ：商品マスタ（商品ID・商品名・荷姿・材質・ケース入数・ボール入数・ケースの重量・寸法・取扱注意・取扱メモ）、
  カゴ車マスタ（内寸・積付高さの上限・最大積載・開口面）
- トランザクション：出荷予定（1行＝出荷の商品1つ：出荷日・出荷ID・出荷先・商品・数量（ケース））、出荷実績（参照のみ・模擬）
  実行器へは、明細から組み立てた荷物（1個ずつ。荷物IDは商品ID、数量が2以上なら商品ID＋連番）と、明細の順の到着順を渡す
- その他：倉庫内マップ（平面図・参照のみ・模擬）
  ※ 仮置き場（列・間隔）・作業エリアは環境マスタに持ち、仮想実行が使うが、データ確認の画面には出さない
  ※ 商品は product_master.json、カゴ車・仮置き場・作業エリアは environment_master.json、出荷予定は shipment_plan.json
初期値は data/masters/・data/transactions/（模擬）。画面から登録した値は local_media/masters/・local_media/transactions/
に保存し、初期値より優先する（リポジトリのデータは書き換えない。初期値に戻すと登録値を消す）。検証は決定的なコードで行う。
"""
from __future__ import annotations

import json
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DIR = ROOT / "data"                   # 初期値（模擬）
REGISTERED_DIR = ROOT.parent / "local_media"   # 画面・SEが登録した値
# 区分ごとのフォルダ：マスタは masters/、トランザクション（便情報）は transactions/
FILES = {"items": "masters/product_master.json", "environment": "masters/environment_master.json",
         "shipments": "transactions/shipment_plan.json"}
CATEGORIES = {
    "master": {"label": "マスタ", "note": "業務の前提として繰り返し使うデータ（商品・カゴ車）。SEが登録し、画面で確認・修正する。"},
    "transaction": {"label": "トランザクション", "note": "出荷ごとに発生するデータ（出荷予定・出荷実績）。作業動画は Step 2 で入力し、解析結果は各ステップで扱う。"},
    "other": {"label": "その他", "note": "倉庫内マップ（仮置き場・商品棚・カゴ車・作業エリア・通路の位置関係）。仮置き場・作業エリアの設定を含む。"},
}
# 参照のみのデータ（画面では編集しない・模擬）。登録値（local_media/ の同じ場所）があればそちらを使う
REFERENCE_FILES = {"shipment_results": "transactions/shipment_results.json", "warehouse_map": "other/warehouse_map.json"}
MATERIALS = ("rigid", "soft")
OPEN_SIDES = ("front",)  # 実行器が扱える開口面（前面のみ）
FLOORS = ("flat", "slope", "step")  # 作業エリアの床面（画面には出さないが環境マスタで検証する）
EPS = 1e-9


# ---- 受け付ける構造化データの定義（正本：docs/WORKFLOW_SPEC.md「入力データの区分」「マスタ」。画面のツリー・一覧・詳細欄もこの定義から作る）----
# category: master／transaction（CATEGORIES）。who＝登録する人、method＝登録方法。
# kind: list＝複数行のテーブル（key が行のID）、single＝1件だけの設定。path はファイル内の場所。
# field の need: required＝必須（空はエラー）、nullable＝未登録（null）可（ワークフローでは「不明」、注意）、optional＝表示用（空でよい）。
# field の type: text／number（unit・min・gt0）／enum（values）／bool／dims（[幅, 奥行, 高さ] m）／ids（荷物IDの並び）／numbers（数の並び）。
MASTER_DEFS: list[dict] = [
    {"table": "products", "category": "master", "who": "SE（拠点の品目・設備データから作る）", "method": "SEがシステムの外でまとめて登録（JSONを local_media/masters/ に置く）。画面では確認と1件ずつの修正", "group": "商品マスタ", "label": "商品マスタ", "file": "items", "path": "products", "kind": "list", "key": "product_id",
     "purpose": "出荷する商品と、その荷姿（出荷単位＝1ケースの形・材質・重量・寸法）。荷物ごとの判断（材質・重さ・大きさ）と積付に使う。",
     "used_in": ["Step 3：材質・重量・寸法で荷物ごとの判断", "Step 4：可搬重量・つかむ幅の要件", "Step 5：積付の実行"],
     "fields": [
         {"key": "product_id", "label": "商品ID", "type": "text", "need": "required", "note": "重複不可。出荷明細から荷物IDを振るときの元になる"},
         {"key": "name", "label": "商品名", "type": "text", "need": "optional"},
         {"key": "packing_type", "label": "荷姿", "type": "text", "need": "optional", "note": "段ボールケース・米袋など（表示用）"},
         {"key": "material_class", "label": "材質", "type": "enum", "need": "nullable",
          "values": [{"value": "rigid", "label": "硬い"}, {"value": "soft", "label": "柔らかい"}]},
         {"key": "case_qty", "label": "ケース入数", "type": "number", "unit": "個", "gt0": True, "need": "nullable", "note": "1ケースに入る商品の数"},
         {"key": "ball_qty", "label": "ボール入数", "type": "number", "unit": "個", "gt0": True, "need": "optional", "note": "1ボール（内箱）に入る数。ボールがなければ空欄"},
         {"key": "weight_kg", "label": "重量（1ケース）", "type": "number", "unit": "kg", "min": 0, "need": "nullable"},
         {"key": "dims_m", "label": "寸法（1ケース：幅×奥行×高さ）", "type": "dims", "unit": "m", "need": "nullable"},
         {"key": "fragile_content", "label": "取扱注意", "type": "bool", "need": "nullable"},
         {"key": "handling_note", "label": "取扱メモ", "type": "text", "need": "optional"},
     ]},
    {"table": "carts", "category": "master", "who": "SE（拠点の品目・設備データから作る）", "method": "SEがシステムの外でまとめて登録（JSONを local_media/masters/ に置く）。画面では確認と1件ずつの修正", "group": "カゴ車マスタ", "label": "カゴ車マスタ", "file": "environment", "path": "carts", "kind": "list", "key": "cart_id",
     "active": "active_cart_id",
     "purpose": "積付先のカゴ車。使用中の1台（★）の内寸・高さの上限・最大積載で積付を実行する。",
     "used_in": ["Step 2：抽出へのカゴ車の仕様", "Step 4：リーチの要件", "Step 5：内寸・高さ・積載上限で積付"],
     "fields": [
         {"key": "cart_id", "label": "カゴ車ID", "type": "text", "need": "required"},
         {"key": "name", "label": "名称", "type": "text", "need": "optional"},
         {"key": "inner_width_m", "label": "内寸の幅", "type": "number", "unit": "m", "gt0": True, "need": "required"},
         {"key": "inner_depth_m", "label": "内寸の奥行", "type": "number", "unit": "m", "gt0": True, "need": "required"},
         {"key": "height_limit_m", "label": "積付高さの上限", "type": "number", "unit": "m", "gt0": True, "need": "required"},
         {"key": "max_load_kg", "label": "最大積載", "type": "number", "unit": "kg", "gt0": True, "need": "required"},
         {"key": "open_side", "label": "開口面", "type": "enum", "need": "required",
          "values": [{"value": "front", "label": "前面"}], "note": "実行器は前面からの積付のみ対応"},
         {"key": "note", "label": "メモ", "type": "text", "need": "optional"},
     ]},
    {"table": "batches", "category": "transaction", "who": "SE（将来は出荷システム・WMSから）", "method": "SEがシステムの外で登録（JSONを local_media/transactions/ に置く）。画面では確認と1件ずつの修正", "group": "出荷予定", "label": "出荷予定", "file": "shipments", "path": "plan", "kind": "list", "key": "line_id",
     "purpose": "1行＝出荷の商品1つ（出荷日・出荷ID・出荷先・商品・数量）。同じ出荷IDの行の並び順が仮置き場への到着順で、荷物IDは商品ID（数量が2以上なら商品ID＋連番）で振る。",
     "used_in": ["Step 2：シナリオの対象", "Step 3〜5：実行する荷物と到着順"],
     "fields": [
         {"key": "line_id", "label": "明細ID", "type": "text", "need": "required"},
         {"key": "shipped_on", "label": "出荷日", "type": "text", "need": "required", "note": "YYYY-MM-DD"},
         {"key": "shipment_id", "label": "出荷ID", "type": "text", "need": "required", "note": "同じ出荷IDの行が1台のカゴ車に積む単位"},
         {"key": "destination", "label": "出荷先", "type": "text", "need": "optional"},
         {"key": "product_id", "label": "商品ID", "type": "text", "need": "required"},
         {"key": "quantity", "label": "数量（ケース）", "type": "number", "need": "required", "gt0": True},
     ]},
    {"table": "results", "category": "transaction", "readonly": True, "who": "現場（将来は出荷システム・WMSから）",
     "method": "参照のみ（この画面では編集しない）。今は模擬のデータ（app/data/transactions/shipment_results.json）",
     "group": "出荷実績", "label": "出荷実績", "file": "shipment_results", "path": "results", "kind": "list", "key": "result_id",
     "purpose": "出荷予定どおりに積んで出荷した記録。出荷明細と同じ形（出荷日・出荷ID・商品・数量）で持つ（模擬）。",
     "used_in": ["参照：出荷予定と実際の出荷の対応"],
     "fields": [
         {"key": "result_id", "label": "実績明細ID", "type": "text", "need": "required"},
         {"key": "shipped_on", "label": "出荷日", "type": "text", "need": "required"},
         {"key": "shipment_id", "label": "出荷ID", "type": "text", "need": "required"},
         {"key": "product_id", "label": "商品ID", "type": "text", "need": "required"},
         {"key": "quantity", "label": "数量（ケース）", "type": "number", "need": "required", "gt0": True},
     ]},
]


def load_reference() -> dict:
    """参照のみのデータ（出荷実績・倉庫内マップ。模擬）。登録値があればそちらを使う。"""
    out = {}
    for k, f in REFERENCE_FILES.items():
        p = REGISTERED_DIR / f
        out[k] = _read(p if p.exists() else DEFAULT_DIR / f)
    return out


class MasterError(Exception):
    def __init__(self, message: str, validation: dict | None = None):
        super().__init__(message)
        self.validation = validation or {}


def _read(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def default_masters() -> dict:
    """リポジトリにある初期値（模擬のマスタ）。"""
    return {k: _read(DEFAULT_DIR / f) for k, f in FILES.items()}


def load_masters() -> dict:
    """現在のマスタ。画面から登録した値があればそれを、なければ初期値を返す。"""
    out = default_masters()
    source, updated_at = "default", None
    for k, f in FILES.items():
        p = REGISTERED_DIR / f
        if p.exists():
            data = _read(p)
            out[k] = data
            source = "registered"
            updated_at = max(updated_at or "", data.get("updated_at") or "") or None
    return {**out, "source": source, "updated_at": updated_at}


def default_cases() -> dict:
    """テスト・スクリプト用：初期値のマスタを、実行器へ渡す荷物の形（objects・batches）にする。"""
    m = default_masters()
    return {"objects": to_objects(parcels_of(m["items"], m["shipments"])), "batches": batches_of(m["shipments"])}


def cases_of(m: dict) -> dict:
    """読み込んだマスタ（load_masters）→ 実行器へ渡す荷物（objects）と便（batches）。"""
    return {"objects": to_objects(parcels_of(m["items"], m["shipments"])), "batches": batches_of(m["shipments"])}


# ---- 出荷明細 → 荷物（1個ずつ）と便 ----
def _ordered_lines(shipments: dict, sid: str) -> list[dict]:
    return [l for l in shipments.get("plan", []) if l.get("shipment_id") == sid]   # 並び順＝到着順


def labels_of(shipments: dict, sid: str) -> list[tuple[str, dict]]:
    """出荷の荷物ID（到着順）と、その明細。数量の合計が1の商品は商品ID、2以上は商品ID＋連番。"""
    lines = _ordered_lines(shipments, sid)
    total: dict[str, int] = {}
    for l in lines:
        total[l["product_id"]] = total.get(l["product_id"], 0) + int(l.get("quantity") or 0)
    seen: dict[str, int] = {}
    out = []
    for l in lines:
        for _ in range(int(l.get("quantity") or 0)):
            pid = l["product_id"]
            seen[pid] = seen.get(pid, 0) + 1
            out.append((pid if total[pid] == 1 else f"{pid}{seen[pid]}", l))
    return out


def shipment_ids(shipments: dict) -> list[str]:
    """出荷予定に出てくる出荷ID（最初に出てくる順）。"""
    return list(dict.fromkeys(l.get("shipment_id") for l in shipments.get("plan", []) if l.get("shipment_id")))


def batches_of(shipments: dict) -> list[dict]:
    """出荷予定 → 便（batch_id＝出荷ID・名称＝出荷日・出荷先・ケース数・荷物IDの到着順）。"""
    out = []
    for sid in shipment_ids(shipments):
        rows = _ordered_lines(shipments, sid)
        ids = [oid for oid, _ in labels_of(shipments, sid)]
        dest = next((r.get("destination") for r in rows if r.get("destination")), "")
        out.append({"batch_id": sid, "label": f"{rows[0].get('shipped_on', '')} {dest}（{len(ids)}ケース）".replace("  ", " ").strip(), "object_ids": ids})
    return out


def parcels_of(items: dict, shipments: dict) -> dict:
    """商品・出荷明細 → 荷物1個（1ケース）ずつ（実行器・照合が使う形）。同じ荷物IDは全ての出荷で同じ商品。"""
    prods = {p["product_id"]: p for p in items.get("products", [])}
    out: dict[str, dict] = {}
    for sid in shipment_ids(shipments):
        for oid, l in labels_of(shipments, sid):
            if oid in out:
                continue
            pr = prods.get(l["product_id"], {})
            out[oid] = {"object_id": oid, "name": pr.get("name") or oid, "object_type": pr.get("packing_type"),
                        "material_class": pr.get("material_class"), "weight_kg": pr.get("weight_kg"), "dims_m": pr.get("dims_m"),
                        "fragile_content": pr.get("fragile_content"), "handling_note": pr.get("handling_note", ""),
                        "product_id": l["product_id"]}
    return {"items": list(out.values())}


# ---- 実行器へ渡す形への変換 ----
def _attr(value: Any) -> dict:
    return {"value": value, "source": "mock_metadata" if value is not None else "unknown"}


def to_objects(items: dict) -> list[dict]:
    """荷物マスタ → 実行器の入力（docs/WORKFLOW_SPEC.md「入力の契約」の荷物）。値が null の属性は「不明」。"""
    out = []
    for it in items["items"]:
        out.append({
            "object_id": it["object_id"],
            "description": it.get("name") or it["object_id"],
            "attributes": {
                "material_class": _attr(it.get("material_class")),
                "fragile_content": _attr(it.get("fragile_content")),
                "weight_kg": _attr(it.get("weight_kg")),
                "dims_m": _attr(it.get("dims_m")),
            },
        })
    return out


def active_cart(env: dict) -> dict:
    cid = env.get("active_cart_id")
    return next((c for c in env.get("carts", []) if c.get("cart_id") == cid), (env.get("carts") or [{}])[0])


def to_job_cart(env: dict) -> dict:
    """環境マスタ → 業務定義の cart（実行器・能力照合が使う形）。"""
    c = active_cart(env)
    return {"width_m": c["inner_width_m"], "depth_m": c["inner_depth_m"], "height_m": c["height_limit_m"],
            "max_load_kg": c["max_load_kg"]}


def cart_spec(env: dict) -> dict:
    """抽出（Claude）への入力に渡すカゴ車の仕様（設備情報）。"""
    c = active_cart(env)
    return {"note": f"環境マスタに登録したカゴ車の仕様（{c.get('name', c['cart_id'])}）。{c.get('note', '')}".rstrip(),
            **{k: c[k] for k in ("inner_width_m", "inner_depth_m", "max_load_kg", "height_limit_m")}}


def to_staging(env: dict) -> dict:
    s = env["staging"]
    return {"first_x_m": s["first_x_m"], "pitch_m": s["pitch_m"], "rows_z_m": list(s["rows_z_m"])}


def apply_environment(job: dict, env: dict) -> dict:
    """業務定義のカゴ車・仮置き場・作業エリア（床面）を環境マスタの値にする（業務の規則は変えない）。"""
    w = env.get("work_area") or {}
    return {**job, "cart": to_job_cart(env), "staging": to_staging(env),
            "work_area": {"floor": w.get("floor", "flat"), "note": w.get("note", "")}}


# ---- 検証 ----
def _num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def validate_masters(items: Any, env: Any, shipments: Any) -> dict:
    """マスタの検査。errors があると保存しない（実行器に渡せない）。warnings は保存できるが、結果に影響する注意。"""
    errors: list[dict] = []
    warnings: list[dict] = []

    def err(target: str, msg: str) -> None:
        errors.append({"target": target, "message": msg})

    def warn(target: str, msg: str) -> None:
        warnings.append({"target": target, "message": msg})

    # 環境マスタ
    cart = None
    if not isinstance(env, dict):
        err("environment", "環境マスタの形が正しくない")
    else:
        carts = env.get("carts")
        if not isinstance(carts, list) or not carts:
            err("carts", "カゴ車が1台も登録されていない")
        else:
            ids = [c.get("cart_id") for c in carts if isinstance(c, dict)]
            if len(ids) != len(set(ids)) or any(not i for i in ids):
                err("carts", "カゴ車のIDが空か重複している")
            for c in carts:
                cid = c.get("cart_id") or "?"
                for k, label in (("inner_width_m", "内寸の幅"), ("inner_depth_m", "内寸の奥行"), ("height_limit_m", "積付高さの上限"),
                                 ("max_load_kg", "最大積載")):
                    if not _num(c.get(k)) or c[k] <= 0:
                        err(f"cart:{cid}", f"{label}は正の数で登録する")
                if c.get("open_side") not in OPEN_SIDES:
                    err(f"cart:{cid}", "開口面は前面（front）のみ対応（実行器が前面から積む）")
            if env.get("active_cart_id") not in ids:
                err("carts", "使用するカゴ車（active_cart_id）が登録されていない")
            else:
                cart = active_cart(env)
        s = env.get("staging")
        if not isinstance(s, dict):
            err("staging", "仮置き場が登録されていない")
        else:
            rows = s.get("rows_z_m")
            if not isinstance(rows, list) or not rows or not all(_num(z) for z in rows):
                err("staging", "仮置き場の列（z座標）を1つ以上登録する")
            if not _num(s.get("pitch_m")) or s["pitch_m"] <= 0:
                err("staging", "荷物の間隔は正の数で登録する")
            if not _num(s.get("first_x_m")):
                err("staging", "先頭の荷物の位置（x）を数で登録する")
            elif cart and _num(cart.get("inner_width_m")) and s["first_x_m"] > -cart["inner_width_m"] / 2:
                err("staging", "仮置き場がカゴ車と重なっている（先頭の位置をカゴ車の左側に）")
        w = env.get("work_area")
        if isinstance(w, dict) and w.get("aisle_width_m") is not None and (not _num(w["aisle_width_m"]) or w["aisle_width_m"] <= 0):
            err("work_area", "通路幅は正の数で登録する")

    # 商品マスタ（荷姿・ケースの重量・寸法を含む）
    if not isinstance(items, dict) or not isinstance(items.get("products"), list):
        err("products", "商品マスタの形が正しくない")
        return {"ok": False, "errors": errors, "warnings": warnings}
    prods: dict[str, dict] = {}
    for n, pr in enumerate(items["products"], 1):
        pid = str(pr.get("product_id") or "").strip()
        tgt = f"product:{pid or n}"
        if not pid:
            err(tgt, f"商品マスタ {n}行目：商品IDが空")
            continue
        if pid in prods:
            err(tgt, f"商品ID {pid} が重複している")
        prods[pid] = pr
        if pr.get("fragile_content") not in (True, False, None):
            err(tgt, f"{pid}：取扱注意は TRUE／FALSE／未登録")
        for k, label in (("case_qty", "ケース入数"), ("ball_qty", "ボール入数")):
            v = pr.get(k)
            if v is not None and not (isinstance(v, int) and not isinstance(v, bool) and v > 0):
                err(tgt, f"{pid}：{label}は1以上の整数（なければ空欄）")
        if isinstance(pr.get("case_qty"), int) and isinstance(pr.get("ball_qty"), int) and pr["ball_qty"] > pr["case_qty"]:
            err(tgt, f"{pid}：ボール入数がケース入数より多い")
        mat = pr.get("material_class")
        if mat is not None and mat not in MATERIALS:
            err(tgt, f"{pid}：材質は rigid（硬い）／soft（柔らかい）／未登録（null）のいずれか")
        elif mat is None:
            warn(tgt, f"{pid}：材質が未登録（ワークフローでは「不明」として扱い、人へ引継ぎや確認事項になる）")
        wkg = pr.get("weight_kg")
        if wkg is not None and (not _num(wkg) or wkg < 0):
            err(tgt, f"{pid}：重量は0以上の数（不明なら空欄）")
        elif wkg is None:
            warn(tgt, f"{pid}：重量が未登録（重い順の判断・可搬重量の照合ができない）")
        elif cart and _num(cart.get("max_load_kg")) and wkg > cart["max_load_kg"]:
            warn(tgt, f"{pid}：1ケースでカゴ車の最大積載を超える")
        dims = pr.get("dims_m")
        if dims is None:
            warn(tgt, f"{pid}：寸法が未登録（置き場所を決められず人へ引継ぎになる）")
        elif not (isinstance(dims, list) and len(dims) == 3 and all(_num(v) and v > 0 for v in dims)):
            err(tgt, f"{pid}：寸法は [幅, 奥行, 高さ]（m、正の数）")
        elif cart and all(_num(cart.get(k)) for k in ("inner_width_m", "inner_depth_m", "height_limit_m")):
            w_, d_, h_ = dims
            fits = (w_ <= cart["inner_width_m"] + EPS and d_ <= cart["inner_depth_m"] + EPS) or \
                   (d_ <= cart["inner_width_m"] + EPS and w_ <= cart["inner_depth_m"] + EPS)
            if not fits:
                warn(tgt, f"{pid}：カゴ車の内寸に収まらない大きさ（人へ引継ぎになる）")
            if h_ > cart["height_limit_m"] + EPS:
                warn(tgt, f"{pid}：高さが積付高さの上限を超える（人へ引継ぎになる）")

    # 出荷予定（1行＝出荷の商品1つ）
    plan = shipments.get("plan") if isinstance(shipments, dict) else None
    if not isinstance(plan, list) or not plan:
        err("batches", "出荷予定を1行以上登録する")
    else:
        lids = [l.get("line_id") for l in plan]
        if len(lids) != len(set(lids)) or any(not x for x in lids):
            err("batches", "明細IDが空か重複している")
        for l in plan:
            lid = l.get("line_id") or "?"
            tgt = f"line:{lid}"
            if not str(l.get("shipment_id") or "").strip():
                err(tgt, f"明細 {lid}：出荷IDが空")
            if not str(l.get("shipped_on") or "").strip():
                err(tgt, f"明細 {lid}：出荷日が空")
            if l.get("product_id") not in prods:
                err(tgt, f"明細 {lid}：商品マスタにない商品ID {l.get('product_id')}")
            q = l.get("quantity")
            if not (isinstance(q, int) and not isinstance(q, bool) and q > 0):
                err(tgt, f"明細 {lid}：数量は1以上の整数")
        for sid in shipment_ids(shipments):
            mine = _ordered_lines(shipments, sid)
            if len({r.get("shipped_on") for r in mine}) > 1:
                err(f"line:{mine[0].get('line_id')}", f"出荷 {sid}：同じ出荷IDで出荷日が違う行がある")
            if errors:
                continue  # 明細・マスタにエラーがあるときは合計を出さない
            total = sum((prods[r["product_id"]].get("weight_kg") or 0.0) * int(r["quantity"]) for r in mine)
            if cart and _num(cart.get("max_load_kg")) and total > cart["max_load_kg"] + EPS:
                warn(f"line:{mine[0].get('line_id')}", f"出荷 {sid}：合計{total:.1f}kgがカゴ車の最大積載{cart['max_load_kg']}kgを超える（一部は積めない）")
        # 同じ荷物IDが出荷によって別の商品にならないこと（動画のタグと照合するID）
        if not errors:
            owner: dict[str, str] = {}
            for sid in shipment_ids(shipments):
                for oid, l in labels_of(shipments, sid):
                    if owner.setdefault(oid, l["product_id"]) != l["product_id"]:
                        err(f"line:{l.get('line_id')}", f"荷物ID {oid} が出荷によって別の商品になる")

    # 定義にない項目・選択肢（受け付けるマスタは MASTER_DEFS のとおり）
    if isinstance(env, dict):
        w = env.get("work_area")
        floors = list(FLOORS)
        if isinstance(w, dict) and w.get("floor") not in floors:
            err("work_area", f"床面は {'／'.join(floors)} のいずれか")
    for d in MASTER_DEFS:
        if d.get("readonly"):
            continue  # 参照のみのデータ（出荷実績）は保存しないので検証しない
        src = {"items": items, "environment": env, "shipments": shipments}[d["file"]]
        data = src.get(d["path"]) if isinstance(src, dict) else None
        rows = data if isinstance(data, list) else [data] if isinstance(data, dict) else []
        allowed = {f["key"] for f in d["fields"]}
        for r in rows:
            extra = sorted(set(r) - allowed) if isinstance(r, dict) else []
            if extra:
                rid = r.get(d["key"]) if d["kind"] == "list" else None
                err(_target(d["table"], rid), f"{d['label']}{' ' + str(rid) if rid else ''}：定義にない項目 {', '.join(extra)}")
    return {"ok": not errors, "errors": errors, "warnings": warnings}


def _field(table: str, key: str) -> dict:
    return next(f for d in MASTER_DEFS if d["table"] == table for f in d["fields"] if f["key"] == key)


def _target(table: str, rid: Any) -> str:
    """検証結果の target（画面が該当する行・テーブルへ移動するのに使う）。"""
    prefix = {"products": "product", "batches": "line", "carts": "cart"}.get(table)
    return f"{prefix}:{rid}" if prefix and rid else table


def save_masters(items: dict, env: dict, shipments: dict) -> dict:
    """検証を通ったマスタを登録値として保存する。エラーがあれば保存しない。"""
    v = validate_masters(items, env, shipments)
    if not v["ok"]:
        raise MasterError("マスタにエラーがあるため保存しません", v)
    now = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
    for k, data in (("items", items), ("environment", env), ("shipments", shipments)):
        out = {**data, "updated_at": now}
        p = REGISTERED_DIR / FILES[k]
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    return {**load_masters(), "validation": v}


def reset_masters() -> dict:
    """登録値を消して初期値（模擬）に戻す。"""
    for f in FILES.values():
        (REGISTERED_DIR / f).unlink(missing_ok=True)
    return load_masters()
