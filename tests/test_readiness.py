"""自動化の事前評価のテスト。"""
import json
from pathlib import Path

from backend.workflow.job import run_job
from backend.workflow.readiness import assess

DATA = Path(__file__).resolve().parent.parent / "data"


def job_trace(workflow, catalog, objects, ids):
    job = json.loads((DATA / "job_fixture.json").read_text(encoding="utf-8"))
    return run_job(job, workflow, [objects[i] for i in ids], catalog)


def status(r, oid):
    return next(i["status"] for i in r["items"] if i["object_id"] == oid)


def test_item_statuses_follow_the_trace(workflow, catalog, objects):
    t = job_trace(workflow, catalog, objects, "CEADB")
    r = assess(t, workflow, catalog)
    assert status(r, "A") == "needs_physical_poc"   # 根拠付きの判断で配置。物理は未検証
    assert status(r, "C") == "needs_physical_poc"
    assert status(r, "D") == "needs_physical_poc"
    assert status(r, "B") == "needs_information"    # 動画どおりの暫定動作（重さの基準待ち）
    assert status(r, "E") == "requires_human"       # AIの仮説による暫定動作は人の確認が必要
    assert r["counts"] == {"needs_physical_poc": 3, "needs_information": 1, "requires_human": 1}
    assert "自動化可能率" not in json.dumps(r, ensure_ascii=False)


def test_categories_list_concrete_items(workflow, catalog, objects):
    r = assess(job_trace(workflow, catalog, objects, "CEADB"), workflow, catalog)
    c = r["categories"]
    assert any("重い荷物か" in x for x in c["needs_information"])
    assert any("材質" in x and "E" in x for x in c["needs_information"])
    assert any("重量の計測" in x for x in c["needs_information"])
    assert "軟質物・袋物の把持" in c["needs_physical_poc"]
    assert any("押し込まない" in x for x in c["needs_physical_poc"])
    assert any("荷物E" in x for x in c["requires_human"])
    assert any("配置5個" in x for x in c["workflow_checked"])


def test_handoff_requires_human(workflow, catalog, objects, clone):
    boxes = []
    for n in range(5):
        b = clone(objects["B"])
        b["object_id"] = f"B{n}"
        boxes.append(b)
    job = json.loads((DATA / "job_fixture.json").read_text(encoding="utf-8"))
    r = assess(run_job(job, workflow, boxes, catalog), workflow, catalog)
    assert status(r, "B4") == "requires_human"
    assert any("下段に空きがない" in x for x in r["categories"]["requires_human"])


def test_confirmation_items_are_merged(workflow, catalog, objects):
    items = [{"id": "c1", "kind": "physical_poc", "topic": "柵との干渉", "detail": "実機で確認",
              "related_node_ids": [], "source_evidence": []}]
    r = assess(job_trace(workflow, catalog, objects, "ABCD"), workflow, catalog, items)
    assert "柵との干渉：実機で確認" in r["categories"]["needs_physical_poc"]
