"""抽出（シナリオv2：業務の規則）のテスト。Claude APIは呼ばず、偽のクライアントで確かめる。"""
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from backend.ai import extraction as ex
from backend.ai import observation as ob
from backend.workflow import masters
from backend.workflow.job import run_job
from tests.test_extraction import FakeClient, count_unions, message, to_flat

ROOT = Path(__file__).resolve().parent.parent
V2 = ROOT / "data" / "scenario_v2"


def load(name):
    return json.loads((V2 / name).read_text(encoding="utf-8"))


@pytest.fixture
def v2_inputs():
    return {
        "explanation": {"source_type": "spoken_instruction", "note": "文字起こし", "video": "work_video_v2.mp4",
                        "segments": [{"id": "S2", "t": "00:06", "text": "重い箱はなるべく下に置いて"}]},
        "observations": {"source_type": "video_observation", "note": "観測", "video": "work_video_v2.mp4",
                         "segments": [{"id": "O3", "t": "00:20", "text": "H1をカゴ車の床に置いた", "objects": ["H1"]}],
                         "uncertain": []},
        "attributes": {**load("attribute_schema.json"),
                       "cart": masters.cart_spec(masters.default_masters()["environment"])},
    }


def flat_v2(rules=None, unsupported=None):
    wf = load("workflow_fixture.json")
    job = load("job_fixture.json")
    rules = rules if rules is not None else [
        {"type": r["type"], "note": r["type"], "source_evidence": [{"ref": "", **e} for e in r["source_evidence"]]}
        for r in job["rules"]]
    return {
        "start_node_id": wf["start_node_id"],
        "nodes": [to_flat(n) | {"parameters": {"zone": "", "press_mode": "", "stack_above": "",
                                               **n.get("parameters", {})}} for n in wf["nodes"]],
        "job": {"rules": rules,
                "unsupported_rules": unsupported if unsupported is not None else [
                    {"text": "荷崩れがないか確認する", "source_evidence": [{"type": "spoken_instruction", "note": "n", "ref": "S8"}]}],
                "end_condition": "all_items_processed", "end_note": "全部積んだら完了"},
        "confirmation_items": [],
        "summary": "テスト用",
    }


def test_v2_schema_and_prompt(catalog):
    schema = ex.output_schema(catalog, "v2")
    assert count_unions(schema) <= 16
    assert "brick_pattern" in schema["properties"]["job"]["properties"]["rules"]["items"]["properties"]["type"]["enum"]
    prompt = ex.system_prompt("v2")
    assert "brick_pattern" in prompt and "unsupported_rules" in prompt and "{rules}" not in prompt
    assert "order_zones" not in prompt
    assert "order_zones" in ex.system_prompt("v1")


def test_extracted_rules_drive_the_job_executor(catalog, v2_inputs):
    client = FakeClient(message(json.dumps(flat_v2(), ensure_ascii=False)))
    result = ex.extract_workflow(client, v2_inputs, catalog, scenario="v2")
    assert result.validation["ok"]
    job = result.job
    assert job["cart"] == {"width_m": 1.0, "depth_m": 0.75, "height_m": 1.2, "max_load_kg": 150}
    assert job["balance_tolerance_m"] is None
    user = client.calls[0]["messages"][0]["content"]
    assert "説明（動画の音声の文字起こし）" in user and "S2" in user
    cases = masters.default_cases()
    objs = {o["object_id"]: o for o in cases["objects"]}
    batch = next(b for b in cases["batches"] if b["batch_id"] == "video_batch")
    t = run_job(job, result.workflow, [objs[i] for i in batch["object_ids"]], catalog)
    assert t["order"][-2:] == ["S1", "S2"]
    statuses = {r["type"]: r["status"] for r in t["rule_results"] if "type" in r}
    assert statuses.get("brick_pattern") == "applied"
    assert any(r.get("status") == "unsupported" for r in t["rule_results"])


def test_eval_v2_passes_for_handwritten_fixture(catalog, capsys):
    import importlib.util

    spec = importlib.util.spec_from_file_location("run_extraction", ROOT / "scripts" / "run_extraction.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    record = {"job": load("job_fixture.json"), "workflow": load("workflow_fixture.json")}
    assert mod.evaluate_v2(record, catalog), capsys.readouterr().out
    record["job"] = {**record["job"], "rules": [r for r in record["job"]["rules"] if r["type"] != "brick_pattern"]}
    assert not mod.evaluate_v2(record, catalog)


def test_rule_without_evidence_is_sent_back_for_repair(catalog, v2_inputs):
    bad = flat_v2(rules=[{"type": "order_by_weight_desc", "note": "重い順", "source_evidence": []}])
    good = flat_v2()
    client = FakeClient(message(json.dumps(bad)), message(json.dumps(good)))
    result = ex.extract_workflow(client, v2_inputs, catalog, scenario="v2")
    assert result.meta["attempts"] == 2
    assert "job.order_by_weight_desc" in client.calls[1]["messages"][-1]["content"]


def test_v2_inputs_require_matching_transcript_and_observation(monkeypatch, tmp_path):
    from backend.ai import transcription as tr

    monkeypatch.setattr(tr, "RECORD_DIR", tmp_path / "t")
    monkeypatch.setattr(ob, "RECORD_DIR", tmp_path / "o")
    with pytest.raises(ex.ExtractionError):
        ex.load_inputs_v2()
    tr.save_transcript({"source_type": "spoken_instruction", "note": "n", "video": "work_video_v2.mp4",
                        "segments": [{"id": "S1", "t": "00:01", "start": 0.8, "end": 5.1, "text": "こちらでは"}]})
    with pytest.raises(ex.ExtractionError):
        ex.load_inputs_v2()
    ob.save_observation({"source_type": "video_observation", "note": "n", "video": "work_video_v2.mp4",
                         "segments": [{"id": "O1", "t": "00:00", "text": "空のカゴ車", "objects": []}], "uncertain": []})
    inputs = ex.load_inputs_v2()
    assert inputs["explanation"]["segments"] == [{"id": "S1", "t": "00:01", "text": "こちらでは"}]
    assert inputs["attributes"]["cart"]["max_load_kg"] == 150


def test_observation_is_split_into_chunks_and_renumbered(monkeypatch):
    frames = [(ob.fmt_time(i), b"jpg") for i in range(5)]
    monkeypatch.setattr(ob, "extract_frames", lambda video, fps, width=768: frames)
    outs = [
        {"segments": [{"t": "00:00", "text": "最初の状態", "objects": []}, {"t": "00:01", "text": "H1を持ち上げた", "objects": ["H1"]}], "uncertain": ["a"]},
        {"segments": [{"t": "00:03", "text": "H1を置いた", "objects": ["H1"]}], "uncertain": []},
        {"segments": [{"t": "00:04", "text": "最後の状態", "objects": []}], "uncertain": ["b"]},
    ]
    client = FakeClient(*[message(json.dumps(o, ensure_ascii=False)) for o in outs])
    obs = ob.observe_video(client, Path(__file__), chunk=2)
    assert obs["chunks"] == 3 and len(client.calls) == 3
    assert [s["id"] for s in obs["segments"]] == ["O1", "O2", "O3", "O4"]
    assert obs["uncertain"] == ["a", "b"]
    assert "1/3" in client.calls[0]["messages"][0]["content"][0]["text"]
