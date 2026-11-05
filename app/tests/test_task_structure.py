"""作業動画のタスク構造（backend/ai/task_structure.py）。Claude APIは呼ばず、偽のクライアントで確かめる。"""
import json

import pytest

from backend.ai import task_structure as ts
from tests.test_extraction import FakeClient, count_unions, message

OBS = [
    {"id": "O1", "t": "00:00", "text": "最初の状態", "objects": []},
    {"id": "O2", "t": "00:08", "text": "H1を床の奥左に置いた", "objects": ["H1"]},
    {"id": "O3", "t": "00:15", "text": "H2を床の奥右に置いた", "objects": ["H2"]},
    {"id": "O4", "t": "00:40", "text": "M1を2段目に置いた", "objects": ["M1"]},
    {"id": "O5", "t": "01:50", "text": "最後の状態", "objects": []},
]
SPEECH = [
    {"id": "S1", "t": "00:01", "start": 0.9, "end": 5.4, "text": "こちらでは荷物を積んでいます"},
    {"id": "S2", "t": "00:06", "start": 5.7, "end": 10.9, "text": "重い箱はなるべく下に置いています"},
    {"id": "S3", "t": "00:37", "start": 36.6, "end": 43.1, "text": "レンガ積みにしています"},
]


def rule(text, kind="spoken", speech=("S2",), obs=("O2",), demonstrated="observed", status="needs_confirmation"):
    return {"text": text, "kind": kind, "rule_type": "order_by_weight_desc", "definition_status": status,
            "confirmation_note": "何kg以上が重いかは説明にない" if status == "needs_confirmation" else "",
            "demonstrated": demonstrated, "speech_ids": list(speech), "obs_ids": list(obs)}


def output(**over):
    raw = {
        "major_tasks": [
            {"name": "下段の土台づくり", "purpose": "重い箱で下段を作る", "start_obs": "O1", "end_obs": "O3",
             "subtasks": [{"name": "H1を床の奥左に置く", "start_obs": "O2", "end_obs": "O2", "objects": ["H1"]},
                          {"name": "H2を床の奥右に置く", "start_obs": "O3", "end_obs": "O3", "objects": ["H2"]}],
             "rules": [rule("重い箱を下段に置く")]},
            {"name": "2段目", "purpose": "箱を積み重ねる", "start_obs": "O4", "end_obs": "O5",
             "subtasks": [{"name": "M1を2段目に置く", "start_obs": "O4", "end_obs": "O4", "objects": ["M1"]}],
             "rules": [rule("同じサイズの箱をレンガ積みにする", speech=("S3",), obs=(), demonstrated="not_observed",
                            status="defined")]},
        ],
        "speech_links": [
            {"speech_id": "S1", "task_id": "", "relation": "general", "note": "業務全体の紹介"},
            {"speech_id": "S2", "task_id": "T1", "relation": "before", "note": ""},
            {"speech_id": "S3", "task_id": "T2", "relation": "during", "note": ""},
        ],
        "unresolved": [{"text": "箱の向きは映像から判別できない", "obs_ids": ["O4"], "speech_ids": ["S3"]}],
    }
    raw.update(over)
    return json.dumps(raw, ensure_ascii=False)


def test_schema_within_union_limit():
    assert count_unions(ts.output_schema()) <= 16


def test_times_come_from_observation_and_speech_ids():
    rec = ts.structure_tasks(FakeClient(message(output())), OBS, SPEECH, 114.0)
    t1, t2 = rec["major_tasks"]
    assert (t1["start"], t1["end"]) == (0.0, 40.0)        # O1〜O3：次の観測（O4）の時刻で終わる
    assert (t2["start"], t2["end"]) == (40.0, 114.0)      # 最後の観測を含む：動画の終わりまで
    assert t1["subtasks"][0] == {"id": "T1.1", "name": "H1を床の奥左に置く", "objects": ["H1"],
                                 "obs_ids": ["O2"], "start": 8.0, "end": 15.0}
    assert rec["speech_links"][1]["start"] == 5.7 and rec["speech_links"][1]["relation"] == "before"


def test_spoken_but_not_demonstrated_and_undefined_threshold_are_kept():
    rec = ts.structure_tasks(FakeClient(message(output())), OBS, SPEECH, 114.0)
    brick = rec["major_tasks"][1]["rules"][0]
    assert brick["demonstrated"] == "not_observed" and brick["obs_ids"] == []
    heavy = rec["major_tasks"][0]["rules"][0]
    assert heavy["definition_status"] == "needs_confirmation" and heavy["confirmation_note"]
    assert rec["unresolved"][0]["speech_ids"] == ["S3"]
    assert rec["speech_links"][0]["task_id"] == ""   # どの作業にも対応しない発話はそのまま残す


def test_bad_ids_are_sent_back_then_fail():
    raw = json.loads(output())
    raw["major_tasks"][0]["end_obs"] = "O9"
    raw["major_tasks"][1]["subtasks"][0]["start_obs"] = "O2"   # 親の範囲外
    raw["speech_links"] = raw["speech_links"][:2]              # S3 の対応がない
    bad = json.dumps(raw, ensure_ascii=False)
    client = FakeClient(message(bad), message(output()))
    rec = ts.structure_tasks(client, OBS, SPEECH, 114.0)
    assert rec["meta"]["attempts"] == 2
    repair = client.calls[1]["messages"][-1]["content"]
    assert "O9" in repair and "S3" in repair
    with pytest.raises(ts.TaskStructureError) as e:
        ts.structure_tasks(FakeClient(message(bad), message(bad)), OBS, SPEECH, 114.0)
    assert e.value.errors


def test_overlapping_majors_and_spoken_rule_without_speech_are_errors():
    raw = json.loads(output())
    raw["major_tasks"][1]["start_obs"] = "O3"
    raw["major_tasks"][0]["rules"][0]["speech_ids"] = []
    _, errors = ts.build(raw, OBS, SPEECH, 114.0)
    assert any("重なる" in e for e in errors) and any("発話IDがない" in e for e in errors)


def test_save_and_latest(tmp_path):
    rec = ts.structure_tasks(FakeClient(message(output())), OBS, SPEECH, 114.0)
    ts.save_structure(rec, {"observation": "observation_x.json"}, tmp_path)
    got = ts.latest_structure(tmp_path)
    assert got["source"]["observation"] == "observation_x.json" and len(got["major_tasks"]) == 2
