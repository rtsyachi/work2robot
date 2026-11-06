"""トランザクション（作業動画と解析結果）：解析結果が今の作業動画から作られたかの判定（backend/inputs.py）。"""
import json
from pathlib import Path

from backend import inputs
from backend.workflow import masters


def put(media: Path, sub: str, name: str, rec: dict) -> None:
    (media / sub).mkdir(parents=True, exist_ok=True)
    (media / sub / name).write_text(json.dumps(rec, ensure_ascii=False), encoding="utf-8")


def all_from(media: Path, video: str) -> None:
    put(media, "transcripts", "transcript_1.json", {"video": video, "model": "w"})
    put(media, "observations", "observation_1.json", {"video": video, "meta": {"model": "m"}})
    put(media, "extractions", "extraction_1.json", {"inputs": {"observations": {"video": video}}, "meta": {"scenario": "v2"}})
    put(media, "task_structures", "tasks_1.json", {"source": {"video": video}})
    put(media, "hardware_selections", "hardware_1.json", {"source": {"video": video}})


def test_all_analyses_from_the_current_video(tmp_path):
    all_from(tmp_path, "now.mp4")
    s = inputs.analysis_status(Path("now.mp4"), tmp_path)
    assert s["ok"] and not s["mismatch"] and {r["status"] for r in s["items"]} == {"ok"}


def test_results_of_another_video_are_not_used(tmp_path):
    """新しくても別の動画の結果は使わず、今の動画の結果を選ぶ。"""
    all_from(tmp_path, "now.mp4")
    put(tmp_path, "observations", "observation_2.json", {"video": "old.mp4"})  # 最新の観測だけ別の動画
    s = inputs.analysis_status(Path("now.mp4"), tmp_path)
    assert s["ok"] and next(r for r in s["items"] if r["kind"] == "observation")["file"] == "observation_1.json"
    assert inputs.latest_for("observation", Path("old.mp4"), tmp_path)[0].name == "observation_2.json"


def test_missing_and_unrecorded_are_not_guessed(tmp_path):
    """今の動画の結果がない・動画の記録がない結果は、使わずに missing とする（推測しない）。"""
    all_from(tmp_path, "other.mp4")
    put(tmp_path, "hardware_selections", "hardware_2.json", {"meta": {}})       # 動画の記録なし
    s = inputs.analysis_status(Path("now.mp4"), tmp_path)
    assert not s["ok"] and {r["status"] for r in s["items"]} == {"missing"} and len(s["missing"]) == 5


def test_current_video_switch(tmp_path):
    """アップロードした動画を今の動画にし、戻すと v5デモ。ファイルがなければ v5デモ。"""
    assert inputs.current_video(tmp_path) == inputs.INPUT_VIDEO
    up = tmp_path / "upload_1.mp4"
    up.write_bytes(b"x")
    inputs.set_current_video(up, tmp_path)
    assert inputs.current_video(tmp_path) == up
    up.unlink()
    assert inputs.current_video(tmp_path) == inputs.INPUT_VIDEO
    inputs.set_current_video(None, tmp_path)
    assert not (tmp_path / "current.json").exists()


def test_only_v2_extractions_are_used(tmp_path):
    all_from(tmp_path, "now.mp4")
    put(tmp_path, "extractions", "extraction_9.json", {"inputs": {}, "meta": {"scenario": "v1"}})
    s = inputs.analysis_status(Path("now.mp4"), tmp_path)
    assert next(r for r in s["items"] if r["kind"] == "extraction")["file"] == "extraction_1.json"


def test_data_categories():
    """マスタ（荷物・カゴ車）、トランザクション（出荷予定・出荷実績）、その他（倉庫内マップの仮置き場・作業エリア）。"""
    cat = {d["table"]: d["category"] for d in masters.MASTER_DEFS}
    assert cat == {"products": "master", "carts": "master", "batches": "transaction", "results": "transaction"}
    label = {d["table"]: d["label"] for d in masters.MASTER_DEFS}
    assert label["products"] == "商品マスタ" and label["carts"] == "カゴ車マスタ" \
        and label["batches"] == "出荷予定" and label["results"] == "出荷実績"
    assert set(masters.CATEGORIES) == {"master", "transaction", "other"}
    assert all(d.get("who") and d.get("method") for d in masters.MASTER_DEFS)
    assert masters.FILES["shipments"].startswith("transactions/") and masters.FILES["items"].startswith("masters/")


def test_reference_data_is_mock_and_consistent():
    """出荷実績・倉庫内マップ（参照のみ・模擬）：荷物と便はマスタにあり、マップの各要素は根拠（観測／模擬）を持つ。"""
    ref = masters.load_reference()
    m = masters.default_masters()
    product_ids = {p["product_id"] for p in m["items"]["products"]}
    heads = {l["shipment_id"]: l for l in m["shipments"]["plan"]}   # 出荷IDごとの出荷日
    results = ref["shipment_results"]["results"]
    assert results and "模擬" in ref["shipment_results"]["note"]
    for r in results:   # 出荷明細と同じ形（出荷日・出荷ID・商品・数量）
        assert r["product_id"] in product_ids and r["shipment_id"] in heads and r["shipped_on"] == heads[r["shipment_id"]]["shipped_on"]
        assert isinstance(r["quantity"], int) and r["quantity"] > 0
    wm = ref["warehouse_map"]
    kinds = {e["kind"] for e in wm["elements"]}
    assert {"staging", "shelf", "cart", "work_area", "aisle"} <= kinds
    assert all(e["basis"] in ("observed", "mock") and e["dims"] in ("mock", "master") for e in wm["elements"])
    w, h = wm["size"]
    assert all(0 <= e["rect"][0] and e["rect"][0] + e["rect"][2] <= w and 0 <= e["rect"][1] and e["rect"][1] + e["rect"][3] <= h
               for e in wm["elements"])
