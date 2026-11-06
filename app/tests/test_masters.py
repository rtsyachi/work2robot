"""マスタ登録（Step 1）：商品マスタ（荷姿・ケースの重量・寸法を含む）・環境マスタ・出荷予定（ヘッダ＋明細）の変換と検証。"""
import copy
import json
from pathlib import Path

import pytest

from backend.workflow import masters
from backend.workflow.job import run_job

ROOT = Path(__file__).resolve().parent.parent
V2 = ROOT / "data" / "scenario_v2"


def load(p):
    return json.loads(Path(p).read_text(encoding="utf-8"))


@pytest.fixture
def m():
    return copy.deepcopy(masters.default_masters())


def msgs(v, kind):
    return " / ".join(e["message"] for e in v[kind])


def test_default_masters_are_valid(m):
    v = masters.validate_masters(m["items"], m["environment"], m["shipments"])
    assert v["ok"], v["errors"]
    # 材質不明の荷物（別の荷物条件用 U1）は警告として残る
    assert "U1" in msgs(v, "warnings")


def test_objects_keep_unknown_values_as_unknown(m):
    objs = {o["object_id"]: o for o in masters.to_objects(masters.parcels_of(m["items"], m["shipments"]))}
    assert objs["H1"]["attributes"]["weight_kg"] == {"value": 18.0, "source": "mock_metadata"}
    assert objs["U1"]["attributes"]["material_class"] == {"value": None, "source": "unknown"}


def test_environment_is_applied_to_job(m):
    job = masters.apply_environment(load(V2 / "job_fixture.json"), m["environment"])
    assert job["cart"] == {"width_m": 1.0, "depth_m": 0.75, "height_m": 1.2, "max_load_kg": 150}
    assert job["staging"]["rows_z_m"] == [0.25, 1.45]


def test_staging_master_changes_where_items_wait(m):
    m["environment"]["staging"].update(rows_z_m=[0.3], first_x_m=-1.5, pitch_m=0.7)
    job = masters.apply_environment(load(V2 / "job_fixture.json"), m["environment"])
    objs = {o["object_id"]: o for o in masters.to_objects(masters.parcels_of(m["items"], m["shipments"]))}
    ids = masters.batches_of(m["shipments"])[0]["object_ids"]
    t = run_job(job, load(V2 / "workflow_fixture.json"), [objs[i] for i in ids], load(ROOT / "data" / "skill_catalog.json"))
    at = {p["object_id"]: p["at"] for p in t["primitives"] if p["kind"] == "recognize"}
    assert at[ids[0]] == [-1.5, 0.0, 0.3] and at[ids[1]] == [-2.2, 0.0, 0.3]
    assert t["staging"]["rows_z_m"] == [0.3]


def test_cart_master_changes_the_result(m):
    m["environment"]["carts"][0]["max_load_kg"] = 60
    job = masters.apply_environment(load(V2 / "job_fixture.json"), m["environment"])
    objs = {o["object_id"]: o for o in masters.to_objects(masters.parcels_of(m["items"], m["shipments"]))}
    ids = masters.batches_of(m["shipments"])[0]["object_ids"]
    t = run_job(job, load(V2 / "workflow_fixture.json"), [objs[i] for i in ids], load(ROOT / "data" / "skill_catalog.json"))
    assert t["end"]["load_kg"] <= 60 and t["end"]["handed_off"] > 0


def test_master_definitions_cover_the_data(m):
    """受け付けるマスタの定義（MASTER_DEFS）：初期値の項目はすべて定義どおりで、必須の項目がそろっている。"""
    tables = {d["table"]: d for d in masters.MASTER_DEFS}
    assert list(tables) == ["products", "carts", "batches", "results"]   # 仮置き場・作業エリアは画面に出さない
    data_of = {**m, **masters.load_reference()}  # 出荷実績は参照のみのデータ
    for d in masters.MASTER_DEFS:
        data = data_of[d["file"]][d["path"]]
        rows = data if d["kind"] == "list" else [data]
        keys = {f["key"] for f in d["fields"]}
        required = {f["key"] for f in d["fields"] if f["need"] == "required"}
        assert rows, d["table"]
        for r in rows:
            assert set(r) <= keys, (d["table"], set(r) - keys)
            assert required <= set(r), (d["table"], required - set(r))
        if d["kind"] == "list":
            assert d["key"] in required


@pytest.mark.parametrize("edit, expected", [
    (lambda m: m["items"]["products"].append(dict(m["items"]["products"][0])), "重複"),
    (lambda m: m["items"]["products"][0].update(dims_m=[0.5, -0.1, 0.3]), "寸法"),
    (lambda m: m["items"]["products"][0].update(material_class="metal"), "材質"),
    (lambda m: m["items"]["products"][0].update(weight_kg=-1), "重量"),
    (lambda m: m["shipments"]["plan"][0].update(product_id="ZZ9"), "ZZ9"),
    (lambda m: m["items"]["products"][1].update(case_qty=0), "ケース入数"),
    (lambda m: m["items"]["products"][1].update(ball_qty=99), "ボール入数"),
    (lambda m: m["shipments"]["plan"][0].update(quantity=0), "数量"),
    (lambda m: m["shipments"]["plan"][1].update(shipped_on="2026-01-01"), "出荷日が違う"),
    (lambda m: m["environment"]["carts"][0].update(inner_width_m=0), "内寸の幅"),
    (lambda m: m["environment"]["carts"][0].update(open_side="side"), "開口面"),
    (lambda m: m["environment"]["staging"].update(rows_z_m=[]), "列"),
    (lambda m: m["environment"]["staging"].update(first_x_m=0.0), "重なっている"),
    (lambda m: m["environment"]["work_area"].update(floor="ice"), "床面"),
    (lambda m: m["items"]["products"][0].update(color="red"), "定義にない項目 color"),
])
def test_validation_errors(m, edit, expected):
    edit(m)
    v = masters.validate_masters(m["items"], m["environment"], m["shipments"])
    assert not v["ok"] and expected in msgs(v, "errors")


def test_validation_warnings(m):
    m["items"]["products"][0].update(dims_m=[1.2, 0.9, 0.3])       # カゴ車に収まらない
    m["items"]["products"][1].update(weight_kg=None)                # 重量の未登録
    m["environment"]["carts"][0]["max_load_kg"] = 100               # 便の合計が上限を超える
    v = masters.validate_masters(m["items"], m["environment"], m["shipments"])
    w = msgs(v, "warnings")
    assert v["ok"] and "収まらない" in w and "重量が未登録" in w and "最大積載" in w


def test_save_and_reset(m, monkeypatch, tmp_path):
    monkeypatch.setattr(masters, "REGISTERED_DIR", tmp_path)
    m["items"]["products"][0]["name"] = "登録した名前"
    out = masters.save_masters(m["items"], m["environment"], m["shipments"])
    assert out["source"] == "registered" and masters.load_masters()["items"]["products"][0]["name"] == "登録した名前"
    bad = copy.deepcopy(m)
    bad["items"]["products"][0]["product_id"] = ""
    with pytest.raises(masters.MasterError):
        masters.save_masters(bad["items"], bad["environment"], bad["shipments"])
    assert masters.load_masters()["items"]["products"][0]["name"] == "登録した名前"  # エラーの登録は反映しない
    assert masters.reset_masters()["source"] == "default"


def test_parcels_are_built_from_shipment_lines(m):
    """出荷明細（商品・荷姿・数量）から荷物を1個ずつ作る：数量1は商品ID、2以上は商品ID＋連番。明細の順が到着順。"""
    b = {x["batch_id"]: x for x in masters.batches_of(m["shipments"])}
    assert len(b["video_batch"]["object_ids"]) == 17 and b["video_batch"]["object_ids"][:3] == ["L1", "H1", "M1"]
    assert [i for i in b["video_batch"]["object_ids"] if i.startswith("M")] == ["M1", "M2", "M3", "M4", "M5", "M6"]
    assert b["alt_batch"]["object_ids"][:4] == ["M1", "M2", "M3", "M4"] and "U1" in b["alt_batch"]["object_ids"]
    parcels = {i["object_id"]: i for i in masters.parcels_of(m["items"], m["shipments"])["items"]}
    assert len(parcels) == 18
    assert parcels["M3"]["product_id"] == "M" and parcels["M3"]["weight_kg"] == 8.0 and parcels["S1"]["material_class"] == "soft"
    assert parcels["M3"]["name"] == "スパゲッティ 500g"   # 食品卸の商品名（架空）
    # 数量を変えると荷物の数が変わる
    next(l for l in m["shipments"]["plan"] if l["shipment_id"] == "video_batch" and l["product_id"] == "M")["quantity"] = 2
    assert len(masters.batches_of(m["shipments"])[0]["object_ids"]) == 13
