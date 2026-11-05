"""マスタ登録（Step 0）：荷物マスタと環境マスタの読み込み・検証・保存（docs/WORKFLOW_SPEC.md「マスタ」）。

業務の解析・ワークフロー・能力照合・仮想実行は、ここで登録したマスタの値を使う。
- 荷物マスタ：荷物ID・名称・種類・材質・重量・寸法・破損注意・取扱メモ、便（荷物の組み合わせ）
- 環境マスタ：積付先のカゴ車（内寸・積付高さの上限・最大積載・開口面）、仮置き場（列・間隔）、作業エリア
初期値は data/masters/（模擬）。画面から登録した値は local_media/masters/ に保存し、初期値より優先する
（リポジトリのデータは書き換えない。初期値に戻すと登録値を消す）。検証は決定的なコードで行う。
"""
from __future__ import annotations

import json
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DIR = ROOT / "data" / "masters"
REGISTERED_DIR = ROOT.parent / "local_media" / "masters"
FILES = {"items": "item_master.json", "environment": "environment_master.json"}
MATERIALS = ("rigid", "soft")
OPEN_SIDES = ("front",)  # 実行器が扱える開口面（前面のみ）
EPS = 1e-9


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
    """テスト・スクリプト用：初期値の荷物マスタを、実行器へ渡す荷物の形（objects・batches）にする。"""
    m = default_masters()
    return {"objects": to_objects(m["items"]), "batches": m["items"]["batches"]}


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
    """業務定義のカゴ車・仮置き場を環境マスタの値にする（業務の規則は変えない）。"""
    return {**job, "cart": to_job_cart(env), "staging": to_staging(env)}


# ---- 検証 ----
def _num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def validate_masters(items: Any, env: Any) -> dict:
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

    # 荷物マスタ
    if not isinstance(items, dict) or not isinstance(items.get("items"), list):
        err("items", "荷物マスタの形が正しくない")
        return {"ok": False, "errors": errors, "warnings": warnings}
    seen: set[str] = set()
    weight: dict[str, float | None] = {}
    for n, it in enumerate(items["items"], 1):
        oid = str(it.get("object_id") or "").strip()
        tgt = f"item:{oid or n}"
        if not oid:
            err(tgt, f"{n}行目：荷物IDが空")
            continue
        if oid in seen:
            err(tgt, f"荷物ID {oid} が重複している")
        seen.add(oid)
        mat = it.get("material_class")
        if mat is not None and mat not in MATERIALS:
            err(tgt, f"{oid}：材質は rigid（硬い）／soft（柔らかい）／未登録（null）のいずれか")
        elif mat is None:
            warn(tgt, f"{oid}：材質が未登録（ワークフローでは「不明」として扱い、人へ引継ぎや確認事項になる）")
        wkg = it.get("weight_kg")
        if wkg is not None and (not _num(wkg) or wkg < 0):
            err(tgt, f"{oid}：重量は0以上の数（不明なら空欄）")
            wkg = None
        elif wkg is None:
            warn(tgt, f"{oid}：重量が未登録（重い順の判断・可搬重量の照合ができない）")
        weight[oid] = wkg
        dims = it.get("dims_m")
        if dims is None:
            warn(tgt, f"{oid}：寸法が未登録（置き場所を決められず人へ引継ぎになる）")
        elif not (isinstance(dims, list) and len(dims) == 3 and all(_num(v) and v > 0 for v in dims)):
            err(tgt, f"{oid}：寸法は [幅, 奥行, 高さ]（m、正の数）")
        elif cart and all(_num(cart.get(k)) for k in ("inner_width_m", "inner_depth_m", "height_limit_m")):
            w_, d_, h_ = dims
            fits = (w_ <= cart["inner_width_m"] + EPS and d_ <= cart["inner_depth_m"] + EPS) or \
                   (d_ <= cart["inner_width_m"] + EPS and w_ <= cart["inner_depth_m"] + EPS)
            if not fits:
                warn(tgt, f"{oid}：カゴ車の内寸に収まらない大きさ（人へ引継ぎになる）")
            if h_ > cart["height_limit_m"] + EPS:
                warn(tgt, f"{oid}：高さが積付高さの上限を超える（人へ引継ぎになる）")
        if wkg is not None and cart and _num(cart.get("max_load_kg")) and wkg > cart["max_load_kg"]:
            warn(tgt, f"{oid}：1個でカゴ車の最大積載を超える")
        if it.get("fragile_content") not in (True, False, None):
            err(tgt, f"{oid}：破損注意は はい／いいえ／未登録")

    # 便（荷物の組み合わせ）
    batches = items.get("batches")
    if not isinstance(batches, list) or not batches:
        err("batches", "便（荷物の組み合わせ）を1つ以上登録する")
    else:
        bids = [b.get("batch_id") for b in batches]
        if len(bids) != len(set(bids)) or any(not b for b in bids):
            err("batches", "便のIDが空か重複している")
        for b in batches:
            bid = b.get("batch_id") or "?"
            ids = b.get("object_ids") or []
            if not ids:
                err(f"batch:{bid}", f"便 {bid}：荷物が1つもない")
            missing = [i for i in ids if i not in seen]
            if missing:
                err(f"batch:{bid}", f"便 {bid}：荷物マスタにないID {', '.join(missing)}")
            if len(ids) != len(set(ids)):
                err(f"batch:{bid}", f"便 {bid}：同じ荷物IDが2回入っている")
            total = sum(weight.get(i) or 0.0 for i in ids)
            if cart and _num(cart.get("max_load_kg")) and total > cart["max_load_kg"] + EPS:
                warn(f"batch:{bid}", f"便 {bid}：合計{total:.1f}kgがカゴ車の最大積載{cart['max_load_kg']}kgを超える（一部は積めない）")
    return {"ok": not errors, "errors": errors, "warnings": warnings}


def save_masters(items: dict, env: dict) -> dict:
    """検証を通ったマスタを登録値として保存する。エラーがあれば保存しない。"""
    v = validate_masters(items, env)
    if not v["ok"]:
        raise MasterError("マスタにエラーがあるため保存しません", v)
    REGISTERED_DIR.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
    for k, data in (("items", items), ("environment", env)):
        out = {**data, "updated_at": now}
        (REGISTERED_DIR / FILES[k]).write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    return {**load_masters(), "validation": v}


def reset_masters() -> dict:
    """登録値を消して初期値（模擬）に戻す。"""
    for f in FILES.values():
        (REGISTERED_DIR / f).unlink(missing_ok=True)
    return load_masters()
