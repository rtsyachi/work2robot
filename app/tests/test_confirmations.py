"""ワークフロー確認（Step 3）：確認事項の消込（対応済みにする／戻す）。シナリオに確認事項IDごとに記録する。"""
import pytest
from fastapi.testclient import TestClient

from backend import scenario
from backend.api import app as app_mod


def test_resolve_and_undo():
    sc = scenario.resolve_confirmation("c1", True, " 現場リーダーに確認 ")
    assert sc["resolved_confirmations"]["c1"]["note"] == "現場リーダーに確認" and sc["resolved_confirmations"]["c1"]["at"]
    assert scenario.load()["resolved_confirmations"].keys() == {"c1"}
    assert scenario.load()["scenario_id"] == "sc_cage_cart_loading"          # シナリオの他の値は変えない
    assert scenario.resolve_confirmation("c1", False)["resolved_confirmations"] == {}
    with pytest.raises(scenario.ScenarioError):
        scenario.resolve_confirmation(" ", True)


def test_api_resolves_only_existing_items(monkeypatch):
    ext = {"confirmation_items": [{"id": "c1", "topic": "t", "detail": "d"}]}
    monkeypatch.setattr(app_mod, "_latest_v2_extraction", lambda: ext)
    client = TestClient(app_mod.app)
    r = client.put("/api/v2/confirmations/c1", json={"resolved": True})
    assert r.status_code == 200 and "c1" in r.json()["resolved_confirmations"]
    assert client.put("/api/v2/confirmations/zz", json={"resolved": True}).status_code == 404   # 今のワークフローにない確認事項
    assert client.put("/api/v2/confirmations/c1", json={"resolved": False}).json()["resolved_confirmations"] == {}
