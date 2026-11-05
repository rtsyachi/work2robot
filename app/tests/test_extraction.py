"""抽出モジュールのテスト。Claude APIは呼ばず、偽のクライアントで受け渡しと検証・修正の流れを確かめる。"""
import json
from types import SimpleNamespace

import pytest

from backend.ai import extraction as ex
from backend.workflow import run_workflow, validate_workflow


def to_flat(node: dict) -> dict:
    """ワークフロー仕様のノードを、Claudeの出力形式（全項目あり・未使用は空）に変換する。"""
    return {
        "id": node["id"], "type": node["type"], "label": node.get("label", ""),
        "next": node.get("next", ""), "required_fields": node.get("required_fields", []),
        "field": node.get("field", ""), "operator": node.get("operator", ""), "value": node.get("value"),
        "definition_status": node.get("definition_status", ""),
        "confirmation_note": node.get("confirmation_note", ""),
        "on_true": node.get("on_true", ""), "on_false": node.get("on_false", ""),
        "on_unknown": node.get("on_unknown", ""), "skill_name": node.get("skill_name", ""),
        "parameters": {"zone": "", "press_mode": "", **node.get("parameters", {})},
        "provisional": node.get("provisional", False), "provisional_note": node.get("provisional_note", ""),
        "reason": node.get("reason", ""), "result": node.get("result", ""),
        "source_evidence": [{"ref": "", **e} for e in node.get("source_evidence", [])],
    }


def flat_output(workflow: dict) -> dict:
    return {
        "start_node_id": workflow["start_node_id"],
        "nodes": [to_flat(n) for n in workflow["nodes"]],
        "job": {
            "order_zones": ["bottom", "top"], "order_note": "下段を先に",
            "order_evidence": [{"type": "provided_text", "note": "硬い箱から先に", "ref": "E2"}],
            "end_condition": "all_items_processed", "end_note": "全部積んだら終了",
        },
        "confirmation_items": [{
            "id": "c1", "kind": "undefined_condition", "topic": "重さの基準", "detail": "未定義",
            "related_node_ids": ["is_heavy"], "source_evidence": [],
        }],
        "summary": "テスト用",
    }


def message(text: str, stop_reason: str = "end_turn"):
    return SimpleNamespace(
        stop_reason=stop_reason, model=ex.MODEL, stop_details=None,
        usage=SimpleNamespace(input_tokens=10, output_tokens=20, iterations=None),
        content=[SimpleNamespace(type="text", text=text)],
    )


class FakeClient:
    def __init__(self, *outputs):
        self.outputs, self.calls = list(outputs), []
        self.beta = SimpleNamespace(messages=SimpleNamespace(stream=self._stream))

    def _stream(self, **kwargs):
        self.calls.append(json.loads(json.dumps(kwargs, default=str)))
        msg = self.outputs.pop(0)

        class Stream:
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def get_final_message(self):
                return msg

        return Stream()


@pytest.fixture
def inputs():
    return ex.load_demo_inputs()


def count_unions(schema) -> int:
    if isinstance(schema, dict):
        own = 1 if "anyOf" in schema or isinstance(schema.get("type"), list) else 0
        return own + sum(count_unions(v) for v in schema.values())
    if isinstance(schema, list):
        return sum(count_unions(v) for v in schema)
    return 0


def test_schema_stays_within_api_union_limit(catalog):
    assert count_unions(ex.output_schema(catalog)) <= 16  # APIの上限（16）を超えると400になる


def test_flat_output_roundtrips_to_valid_workflow(workflow, catalog, objects):
    wf = ex.to_workflow(flat_output(workflow))
    assert validate_workflow(wf, catalog).ok
    for oid, obj in objects.items():
        got = [s["node_id"] for s in run_workflow(wf, obj, catalog)["steps"]]
        want = [s["node_id"] for s in run_workflow(workflow, obj, catalog)["steps"]]
        assert got == want, oid


def test_extract_sends_inputs_with_structured_output_and_fallback(workflow, catalog, inputs):
    client = FakeClient(message(json.dumps(flat_output(workflow), ensure_ascii=False)))
    result = ex.extract_workflow(client, inputs, catalog)
    assert result.validation["ok"] and result.meta["attempts"] == 1
    call = client.calls[0]
    assert call["model"] == "claude-opus-5-5"
    assert call["fallbacks"] == "default"
    assert call["output_config"]["format"]["type"] == "json_schema"
    user = call["messages"][0]["content"]
    assert "底面が0.15平方メートル以上" in user and "O5" in user
    assert "expected" not in user and "期待" not in user  # 評価用の正解データを入力に混ぜない


def test_invalid_output_is_repaired_with_validation_errors(workflow, catalog, inputs):
    broken = flat_output(workflow)
    next(n for n in broken["nodes"] if n["id"] == "is_large")["on_unknown"] = ""
    client = FakeClient(message(json.dumps(broken)), message(json.dumps(flat_output(workflow))))
    result = ex.extract_workflow(client, inputs, catalog)
    assert result.meta["attempts"] == 2
    repair = client.calls[1]["messages"][-1]["content"]
    assert "検証エラー" in repair and "is_large" in repair


def test_gives_up_when_still_invalid(workflow, catalog, inputs):
    broken = flat_output(workflow)
    next(n for n in broken["nodes"] if n["id"] == "is_large")["value"] = None  # 閾値の欠落
    client = FakeClient(message(json.dumps(broken)), message(json.dumps(broken)))
    with pytest.raises(ex.ExtractionError) as e:
        ex.extract_workflow(client, inputs, catalog)
    assert e.value.detail["errors"]


def test_refusal_is_reported(catalog, inputs):
    with pytest.raises(ex.ExtractionError):
        ex.extract_workflow(FakeClient(message("", stop_reason="refusal")), inputs, catalog)


def test_extracted_job_runs_with_the_job_runner(workflow, catalog, inputs, objects):
    from backend.workflow.job import run_job

    result = ex.extract_workflow(FakeClient(message(json.dumps(flat_output(workflow)))), inputs, catalog)
    assert result.job["order_rule"]["zones"] == ["bottom", "top"]
    assert result.job["order_rule"]["source_evidence"][0]["ref"] == "E2"
    t = run_job(result.job, result.workflow, [objects[i] for i in "CEADB"], catalog)
    assert t["order"] == ["A", "B", "C", "E", "D"]


def test_video_observations_are_used_when_requested(monkeypatch, tmp_path):
    from backend.ai import observation as ob

    monkeypatch.setattr(ob, "RECORD_DIR", tmp_path)
    with pytest.raises(ex.ExtractionError):
        ex.load_demo_inputs("video")
    ob.save_observation({"source_type": "video_observation", "note": "n", "video": "v.mp4",
                         "segments": [{"id": "O1", "t": "00:00", "text": "空のカゴ車", "objects": []}],
                         "uncertain": []})
    inputs = ex.load_demo_inputs("video")
    assert inputs["observations"]["source_type"] == "video_observation"
    assert inputs["observations"]["segments"][0]["id"] == "O1"


def test_record_is_saved_and_loaded(workflow, catalog, inputs, tmp_path):
    result = ex.extract_workflow(FakeClient(message(json.dumps(flat_output(workflow)))), inputs, catalog)
    ex.save_record(result, inputs, tmp_path)
    record = ex.latest_record(tmp_path)
    assert record["workflow"] == result.workflow and record["raw_outputs"]
    assert ex.latest_record(tmp_path / "none") is None
