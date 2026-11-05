"""マスタ登録（Step 0）：荷物マスタ・環境マスタの変換と検証（backend/workflow/masters.py）。"""
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
    v = masters.validate_masters(m["items"], m["environment"])
    assert v["ok"], v["errors"]
    # 材質不明の荷物（別の荷物条件用 U1）は警告として残る
    assert "U1" in msgs(v, "warnings")


def test_objects_keep_unknown_values_as_unknown(m):
    objs = {o["object_id"]: o for o in masters.to_objects(m["items"])}
    assert objs["H1"]["attributes"]["weight_kg"] == {"value": 18.0, "source": "mock_metadata"}
    assert objs["U1"]["attributes"]["material_class"] == {"value": None, "source": "unknown"}


def test_environment_is_applied_to_job(m):
    job = masters.apply_environment(load(V2 / "job_fixture.json"), m["environment"])
    assert job["cart"] == {"width_m": 1.0, "depth_m": 0.75, "height_m": 1.2, "max_load_kg": 150}
    assert job["staging"]["rows_z_m"] == [0.25, 1.45]


def test_staging_master_changes_where_items_wait(m):
    m["environment"]["staging"].update(rows_z_m=[0.3], first_x_m=-1.5, pitch_m=0.7)
    job = masters.apply_environment(load(V2 / "job_fixture.json"), m["environment"])
    objs = {o["object_id"]: o for o in masters.to_objects(m["items"])}
    ids = m["items"]["batches"][0]["object_ids"]
    t = run_job(job, load(V2 / "workflow_fixture.json"), [objs[i] for i in ids], load(ROOT / "data" / "skill_catalog.json"))
    at = {p["object_id"]: p["at"] for p in t["primitives"] if p["kind"] == "recognize"}
    assert at[ids[0]] == [-1.5, 0.0, 0.3] and at[ids[1]] == [-2.2, 0.0, 0.3]
    assert t["staging"]["rows_z_m"] == [0.3]


def test_cart_master_changes_the_result(m):
    m["environment"]["carts"][0]["max_load_kg"] = 60
    job = masters.apply_environment(load(V2 / "job_fixture.json"), m["environment"])
    objs = {o["object_id"]: o for o in masters.to_objects(m["items"])}
    ids = m["items"]["batches"][0]["object_ids"]
    t = run_job(job, load(V2 / "workflow_fixture.json"), [objs[i] for i in ids], load(ROOT / "data" / "skill_catalog.json"))
    assert t["end"]["load_kg"] <= 60 and t["end"]["handed_off"] > 0


@pytest.mark.parametrize("edit, expected", [
    (lambda m: m["items"]["items"].append(dict(m["items"]["items"][0])), "重複"),
    (lambda m: m["items"]["items"][0].update(dims_m=[0.5, -0.1, 0.3]), "寸法"),
    (lambda m: m["items"]["items"][0].update(material_class="metal"), "材質"),
    (lambda m: m["items"]["items"][0].update(weight_kg=-1), "重量"),
    (lambda m: m["items"]["batches"][0]["object_ids"].append("ZZ9"), "ZZ9"),
    (lambda m: m["environment"]["carts"][0].update(inner_width_m=0), "内寸の幅"),
    (lambda m: m["environment"]["carts"][0].update(open_side="side"), "開口面"),
    (lambda m: m["environment"]["staging"].update(rows_z_m=[]), "列"),
    (lambda m: m["environment"]["staging"].update(first_x_m=0.0), "重なっている"),
])
def test_validation_errors(m, edit, expected):
    edit(m)
    v = masters.validate_masters(m["items"], m["environment"])
    assert not v["ok"] and expected in msgs(v, "errors")


def test_validation_warnings(m):
    m["items"]["items"][0].update(dims_m=[1.2, 0.9, 0.3])          # カゴ車に収まらない
    m["items"]["items"][1].update(weight_kg=None)                   # 重量の未登録
    m["environment"]["carts"][0]["max_load_kg"] = 100               # 便の合計が上限を超える
    v = masters.validate_masters(m["items"], m["environment"])
    w = msgs(v, "warnings")
    assert v["ok"] and "収まらない" in w and "重量が未登録" in w and "最大積載" in w


def test_save_and_reset(m, monkeypatch, tmp_path):
    monkeypatch.setattr(masters, "REGISTERED_DIR", tmp_path)
    m["items"]["items"][0]["name"] = "登録した名前"
    out = masters.save_masters(m["items"], m["environment"])
    assert out["source"] == "registered" and masters.load_masters()["items"]["items"][0]["name"] == "登録した名前"
    bad = copy.deepcopy(m)
    bad["items"]["items"][0]["object_id"] = ""
    with pytest.raises(masters.MasterError):
        masters.save_masters(bad["items"], bad["environment"])
    assert masters.load_masters()["items"]["items"][0]["name"] == "登録した名前"  # エラーの登録は反映しない
    assert masters.reset_masters()["source"] == "default"
