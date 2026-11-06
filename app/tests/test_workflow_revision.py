"""Step 3 の確認・教示：直接編集とClaudeの修正案は、検証に通ったものだけ新しい版として保存し、元の版を残す。"""
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from backend import inputs
from backend import workflow_revision as wr
from backend.ai import extraction, hardware_selection, task_structure
from backend.api.app import app
from backend.workflow import masters
from backend.workflow.job import run_job
from tests.test_extraction_v2 import process_raw

DATA = Path(__file__).resolve().parents[1] / "data"


def load(rel: str) -> dict:
    return json.loads((DATA / rel).read_text(encoding="utf-8"))


@pytest.fixture
def base(monkeypatch, tmp_path):
    """今の動画（v5デモ）から作った抽出の版を1つ置く（中身は手書きの業務定義・ワークフロー）。"""
    monkeypatch.setattr(inputs, "UPLOAD_DIR", tmp_path / "uploads")
    monkeypatch.setattr(extraction, "RECORD_DIR", tmp_path / "ext")
    monkeypatch.setattr(hardware_selection, "RECORD_DIR", tmp_path / "hw")
    monkeypatch.setattr(task_structure, "RECORD_DIR", tmp_path / "tasks")
    monkeypatch.setattr(masters, "REGISTERED_DIR", tmp_path / "masters")
    job, wf = load("scenario_v2/job_fixture.json"), load("scenario_v2/workflow_fixture.json")
    c = job["cart"]
    rec = {
        "created_at": "2026-11-06T10:00:00+09:00",
        "inputs": {"explanation": {"source_type": "spoken_instruction", "segments": []},
                   "observations": {"source_type": "video_observation", "video": inputs.INPUT_VIDEO.name, "segments": []},
                   "attributes": {"cart": {"inner_width_m": c["width_m"], "inner_depth_m": c["depth_m"],
                                           "height_limit_m": c["height_m"], "max_load_kg": c["max_load_kg"]}}},
        "workflow": wf, "job": job, "confirmation_items": [{"id": "c1", "kind": "undefined_condition", "topic": "偏りの許容範囲",
                                                           "detail": "未定義", "related_node_ids": [], "source_evidence": []}],
        "summary": "s", "validation": {"ok": True, "errors": [], "warnings": []},
        "meta": {"scenario": "v2", "model": "m", "usage": [{"input_tokens": 9, "output_tokens": 9}]},
    }
    (tmp_path / "ext").mkdir()
    (tmp_path / "ext" / "extraction_20261106_100000.json").write_text(json.dumps(rec, ensure_ascii=False), encoding="utf-8")
    return tmp_path


def objects():
    m = masters.load_masters()
    objs = {o["object_id"]: o for o in masters.to_objects(masters.parcels_of(m["items"], m["shipments"]))}
    batch = next(b for b in masters.batches_of(m["shipments"]) if b["batch_id"] == "video_batch")
    return [objs[i] for i in batch["object_ids"]]


def test_rule_edit_saves_a_new_version_and_keeps_the_original(base):
    path = wr.save_edits([{"op": "rule", "type": "brick_pattern", "enabled": False},
                          {"op": "rule", "type": "order_by_weight_desc", "note": "15kg以上の箱は必ず下段"}], "現場リーダーに確認")
    f, rec = wr.current_record()
    assert f == path and (base / "ext" / "extraction_20261106_100000.json").exists()
    rules = {r["type"]: r for r in rec["job"]["rules"]}
    assert "brick_pattern" not in rules and rules["order_by_weight_desc"]["note"] == "15kg以上の箱は必ず下段"
    assert rules["order_by_weight_desc"]["source_evidence"][-1] == {"type": "human_confirmed", "note": "現場リーダーに確認"}
    assert rec["meta"]["revision"]["of"] == "extraction_20261106_100000.json" and rec["meta"]["revision"]["by"] == "user"
    assert rec["meta"]["usage"] == []  # 直接編集は課金なし（使用量を二重に数えない）
    # 規則を外すと実行結果が変わる（レンガ積みが適用されない）
    t = run_job(masters.apply_environment(rec["job"], masters.load_masters()["environment"]), rec["workflow"], objects(), load("skill_catalog.json"))
    assert all(r["type"] != "brick_pattern" for r in t["rule_results"])


def test_decision_edit_requires_valid_values(base):
    wr.save_edits([{"op": "decision", "node_id": "is_soft", "definition_status": "needs_confirmation",
                    "confirmation_note": "布製の袋も柔らかい扱いか要確認"}], "")
    n = next(n for n in wr.current_record()[1]["workflow"]["nodes"] if n["id"] == "is_soft")
    assert n["definition_status"] == "needs_confirmation" and n["value"] is None
    before = wr.current_record()[0]
    with pytest.raises(wr.RevisionError) as e:  # 閾値の比較に数値でない値 → 検証に通らず保存しない
        wr.save_edits([{"op": "decision", "node_id": "is_soft", "operator": "ge", "value": "soft", "definition_status": "defined"}], "x")
    assert e.value.errors and wr.current_record()[0] == before
    with pytest.raises(wr.RevisionError):
        wr.save_edits([{"op": "rule", "type": "make_coffee"}], "")


def test_balance_tolerance_makes_the_check_decidable(base):
    wr.save_edits([{"op": "balance_tolerance", "value": 0.1}], "偏りは10cmまで")
    job = wr.current_record()[1]["job"]
    assert job["balance_tolerance_m"] == 0.1 and job["balance_tolerance_evidence"][0]["type"] == "human_confirmed"
    t = run_job(masters.apply_environment(job, masters.load_masters()["environment"]), wr.current_record()[1]["workflow"],
                objects(), load("skill_catalog.json"))
    assert t["checks"]["balance"]["ok"] is not None
    with pytest.raises(wr.RevisionError):
        wr.save_edits([{"op": "balance_tolerance", "value": -1}], "")


def test_criteria_edit_reorders_rewrites_and_keeps_unchanged_evidence(base):
    """タスクの判断条件は並び順＝優先度。書き換えた条件だけ「人が確認」になり、変えない条件の根拠は残る。"""
    f = base / "ext" / "extraction_20261106_100000.json"
    rec = json.loads(f.read_text(encoding="utf-8"))
    rec["process"] = extraction.to_process(process_raw())
    f.write_text(json.dumps(rec, ensure_ascii=False), encoding="utf-8")
    crit = next(n for s in rec["process"]["stages"] if s["id"] == "final" for n in s["nodes"])["criteria"]
    wr.save_edits([{"op": "criteria", "stage_id": "final", "node_id": "check", "criteria": [
        {"name": "高さ", "how": "線1.2mを超えたら上段を下ろす", "rule_refs": ["height_limit"]},   # 書き換えて先頭へ
        {"name": crit[0]["name"], "how": crit[0]["how"], "rule_refs": crit[0]["rule_refs"]},     # そのまま
        {"name": "荷崩れ", "how": "傾いた箱がないか見る", "rule_refs": []},                       # 追加
    ]}], "現場リーダーに確認")
    rec2 = wr.current_record()[1]
    node = next(n for s in rec2["process"]["stages"] if s["id"] == "final" for n in s["nodes"])
    assert [c["name"] for c in node["criteria"]] == ["高さ", "はみ出し", "荷崩れ"]
    assert node["criteria"][0]["basis"] == "human_confirmed" and node["criteria"][1] == crit[0]
    assert node["rule_refs"] == ["height_limit", "overhang_check"] and node["conditions"][2] == "荷崩れ：傾いた箱がないか見る"
    assert rec2["job"] == rec["job"]  # 業務の規則は変えない
    for bad in ({"name": "", "how": "x"}, {"name": "x", "how": "y", "rule_refs": ["make_coffee"]}):
        with pytest.raises(wr.RevisionError):
            wr.save_edits([{"op": "criteria", "stage_id": "final", "node_id": "check", "criteria": [bad]}], "")
    with pytest.raises(wr.RevisionError):
        wr.save_edits([{"op": "criteria", "stage_id": "final", "node_id": "nope", "criteria": []}], "")


def raw_rules(rules: list[dict]) -> list[dict]:
    """Claudeの出力形式の規則（note・根拠は必須項目）。"""
    return [{"type": r["type"], "note": r.get("note", ""), "source_evidence": r.get("source_evidence", [])} for r in rules]


def fake_client(*raws: dict):
    """呼ばれた順に raws を返す偽のクライアント（ワークフロー生成 → 工程の構造）。"""
    msgs = [SimpleNamespace(stop_reason="end_turn", model="claude-opus-5-5", stop_details=None,
                            usage=SimpleNamespace(input_tokens=100, output_tokens=50, iterations=None),
                            content=[SimpleNamespace(type="text", text=json.dumps(r, ensure_ascii=False))]) for r in raws]
    calls = []

    class Stream:
        def __init__(self, msg):
            self.msg = msg

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def get_final_message(self):
            return self.msg

    def stream(**kw):
        calls.append(kw)
        return Stream(msgs[len(calls) - 1])
    return SimpleNamespace(beta=SimpleNamespace(messages=SimpleNamespace(stream=stream))), calls


def test_claude_proposal_shows_a_diff_and_is_saved_only_when_approved(base):
    wr.save_edits([{"op": "balance_tolerance", "value": 0.1}], "偏りは10cmまで")
    f0, rec = wr.current_record()
    job = rec["job"]
    raw = {"start_node_id": rec["workflow"]["start_node_id"], "nodes": rec["workflow"]["nodes"],
           "job": {"rules": raw_rules([r for r in job["rules"] if r["type"] != "full_support"]),
                   "unsupported_rules": job["unsupported_rules"], "end_condition": "all_items_processed", "end_note": ""},
           "confirmation_items": [], "summary": "修正後"}
    client, calls = fake_client(raw, process_raw())
    p = wr.propose("底面全体の支持は求めない", "業務全体：置き場所", client)
    sent = calls[0]["messages"][0]["content"]
    assert "利用者の修正指示" in sent and "底面全体の支持は求めない" in sent and "現在のワークフロー" in sent
    sent2 = calls[1]["messages"][0]["content"]  # 続けて工程の構造を、指示と直した条件に合わせて作り直す
    assert "修正の依頼" in sent2 and "底面全体の支持は求めない" in sent2 and "full_support" not in sent2.split("業務の条件")[1].split("```")[1]
    assert p["diff"]["confirmations_added"] == ["作業前の安全確認の有無"]
    assert [r["type"] for r in p["diff"]["rules_removed"]] == ["full_support"] and p["diff"]["confirmations_resolved"] == ["偏りの許容範囲"]
    assert wr.current_record()[0] == f0  # 承認するまで保存しない
    path = wr.apply_proposal(p["id"])
    rec2 = wr.current_record()[1]
    assert wr.current_record()[0] == path and rec2["meta"]["revision"]["by"] == "claude"
    assert rec2["meta"]["revision"]["instruction"] == "底面全体の支持は求めない"
    assert rec2["job"]["balance_tolerance_m"] == 0.1  # 人が入れた基準は引き継ぐ
    assert [s["id"] for s in rec2["process"]["stages"]] == ["safety", "loading0", "final"]  # 工程の構造も保存
    assert p["diff"]["stages_added"] == ["安全確認", "荷物の積付", "終了前の確認"]  # 元の版には工程の構造がない
    # 1つ前に戻す → さらに戻す → 解析直後の版に戻ると、それ以上は戻せない
    wr.revert()
    assert any(r["type"] == "full_support" for r in wr.current_record()[1]["job"]["rules"])
    wr.revert()
    assert wr.current_record()[1]["job"].get("balance_tolerance_m") is None
    with pytest.raises(wr.RevisionError):
        wr.revert()


def test_proposal_is_refused_when_the_workflow_changed_meanwhile(base):
    f0, rec = wr.current_record()
    raw = {"start_node_id": rec["workflow"]["start_node_id"], "nodes": rec["workflow"]["nodes"],
           "job": {"rules": raw_rules(rec["job"]["rules"]), "unsupported_rules": [], "end_condition": "all_items_processed", "end_note": ""},
           "confirmation_items": [], "summary": "x"}
    p = wr.propose("確認事項をまとめて", "", fake_client(raw, process_raw())[0])
    wr.save_edits([{"op": "rule", "type": "brick_pattern", "enabled": False}], "")
    with pytest.raises(wr.RevisionError):
        wr.apply_proposal(p["id"])


def test_api_edit_and_stale_selection(base):
    client = TestClient(app)
    st = client.get("/api/v2/state").json()
    assert st["extraction"]["record_file"] == "extraction_20261106_100000.json" and not st["selection_stale"]
    hardware_selection.save_selection({"config": {"product_id": "rm_20", "base": "b", "arm": "a", "end_effector": "e",
                                                  "sensors": [], "peripherals": []}, "meta": {},
                                       "source": {"extraction": "extraction_20261106_100000.json", "video": inputs.INPUT_VIDEO.name}})
    assert not client.get("/api/v2/state").json()["selection_stale"]
    r = client.post("/api/v2/workflow/edit", json={"ops": [{"op": "rule", "type": "brick_pattern", "enabled": False}], "reason": "r"})
    assert r.status_code == 200
    st = client.get("/api/v2/state").json()
    assert st["extraction"]["record_file"] == r.json()["record_file"] and st["selection_stale"]  # 直したので再選定が必要
    assert all(x["type"] != "brick_pattern" for x in st["job"]["rules"])
    bad = client.post("/api/v2/workflow/edit", json={"ops": [{"op": "balance_tolerance", "value": 0}]})
    assert bad.status_code == 422 and bad.json()["detail"]["message"]
    assert client.post("/api/v2/workflow/revert").status_code == 200
    st = client.get("/api/v2/state").json()  # 解析直後の版に戻したので、その版から作った仮選定は古くない
    assert st["extraction"]["meta"]["revision"]["by"] == "revert" and not st["selection_stale"]
    assert any(x["type"] == "brick_pattern" for x in st["job"]["rules"])
