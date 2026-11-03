"""Work2Robot のHTTP API（docs/ARCHITECTURE.md「API境界の案」）。

起動：.venv\\Scripts\\python -m uvicorn backend.api.app:app --port 8000
判定・実行は backend.workflow に任せ、このモジュールは受け渡しだけを行う。
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import anthropic
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from backend.ai import extraction, observation
from backend.ai.client import make_client
from backend.workflow import WorkflowValidationError, run_workflow, validate_workflow
from backend.workflow.job import JobError, level1_graph, run_job
from backend.workflow.readiness import assess

DATA_DIR = Path(__file__).resolve().parents[2] / "data"
FIXTURE_NOTICE = "手書きのテスト用ワークフローと架空の模擬荷物です。Claudeが生成した結果ではありません。"

app = FastAPI(title="Work2Robot API")


def _load(name: str) -> Any:
    return json.loads((DATA_DIR / name).read_text(encoding="utf-8"))


def _catalog() -> dict:
    return _load("skill_catalog.json")


class ValidateRequest(BaseModel):
    workflow: dict[str, Any]


class RunRequest(BaseModel):
    workflow: dict[str, Any]
    object: dict[str, Any]  # 荷物1個（docs/WORKFLOW_SPEC.md「入力の契約」）


@app.get("/api/health")
def health() -> dict:
    return {"ok": True}


@app.get("/api/demo/fixtures")
def demo_fixtures() -> dict:
    """画面の初期表示用：手書きワークフロー・スキル一覧・模擬荷物。"""
    cases = _load("demo_cases.json")
    return {
        "notice": FIXTURE_NOTICE,
        "workflow": _load("workflow_fixture.json"),
        "job": _load("job_fixture.json"),
        "level1": level1_graph(),
        "catalog": _catalog(),
        "objects": cases["objects"],
        "batches": cases["batches"],
    }


class JobRunRequest(BaseModel):
    workflow: dict[str, Any]
    batch_id: str
    job: dict[str, Any] | None = None


@app.post("/api/jobs/run")
def run_job_endpoint(req: JobRunRequest) -> dict:
    """荷物のまとまり（バッチ）で業務全体を実行し、業務実行トレースを返す。"""
    cases = _load("demo_cases.json")
    batch = next((b for b in cases["batches"] if b["batch_id"] == req.batch_id), None)
    if batch is None:
        raise HTTPException(status_code=404, detail={"message": f"バッチがありません: {req.batch_id}"})
    objects = {o["object_id"]: o for o in cases["objects"]}
    try:
        return run_job(req.job or _load("job_fixture.json"), req.workflow,
                       [objects[i] for i in batch["object_ids"]], _catalog())
    except WorkflowValidationError as e:
        raise HTTPException(status_code=422, detail=e.result.to_dict()) from e
    except JobError as e:
        raise HTTPException(status_code=422, detail={"message": str(e)}) from e


class ReadinessRequest(BaseModel):
    workflow: dict[str, Any]
    job_trace: dict[str, Any]
    confirmation_items: list[dict[str, Any]] = []


@app.post("/api/readiness")
def readiness(req: ReadinessRequest) -> dict:
    """業務実行トレースから自動化の事前評価を作る（決定的）。"""
    return assess(req.job_trace, req.workflow, _catalog(), req.confirmation_items)


@app.get("/api/demo/inputs")
def demo_inputs() -> dict:
    """抽出モジュールへの入力（説明テキスト・開発用観測テキスト・属性定義）。根拠の表示にも使う。"""
    return extraction.load_demo_inputs()


@app.get("/api/media/work_video.mp4")
def work_video() -> FileResponse:
    """入力動画（デモ用模擬作業動画）。"""
    if not observation.VIDEO_PATH.exists():
        raise HTTPException(status_code=404, detail={"message": "入力動画がありません"})
    return FileResponse(observation.VIDEO_PATH, media_type="video/mp4")


@app.post("/api/observe")
def observe() -> dict:
    """入力動画からClaudeで観測テキストを作る（課金あり・数十秒）。結果は保存する。"""
    try:
        obs = observation.observe_video(make_client())
    except observation.ObservationError as e:
        raise HTTPException(status_code=502, detail={"message": str(e)}) from e
    except anthropic.APIError as e:
        raise HTTPException(status_code=502, detail={"message": f"Claude APIエラー: {e}"}) from e
    path = observation.save_observation(obs)
    return {"source": "live", **json.loads(path.read_text(encoding="utf-8")), "record_file": path.name}


@app.get("/api/observe/latest")
def observe_latest() -> dict:
    obs = observation.latest_observation()
    if obs is None:
        raise HTTPException(status_code=404, detail={"message": "保存済みの観測テキストがありません"})
    return {"source": "saved", **obs}


class ExtractRequest(BaseModel):
    observations: str = "video"  # "video"（動画から作った観測テキスト）または "dev"（開発用固定テキスト）


@app.post("/api/extract")
def extract(req: ExtractRequest | None = None) -> dict:
    """Claudeでワークフローを生成する（課金あり・1〜2分程度）。結果は保存し、検証済みのものだけ返す。"""
    req = req or ExtractRequest()
    try:
        inputs = extraction.load_demo_inputs(req.observations)
    except extraction.ExtractionError as e:
        raise HTTPException(status_code=409, detail={"message": str(e)}) from e
    try:
        result = extraction.extract_workflow(make_client(), inputs, _catalog())
    except extraction.ExtractionError as e:
        raise HTTPException(status_code=502, detail={"message": str(e), **e.detail}) from e
    except anthropic.APIError as e:
        raise HTTPException(status_code=502, detail={"message": f"Claude APIエラー: {e}"}) from e
    path = extraction.save_record(result, inputs)
    record = json.loads(path.read_text(encoding="utf-8"))
    return {"source": "live", "record_file": path.name, **_public(record)}


@app.get("/api/extract/latest")
def extract_latest() -> dict:
    """保存済みの最新の抽出結果（実際のClaude応答）を返す。再生成はしない。"""
    record = extraction.latest_record()
    if record is None:
        raise HTTPException(status_code=404, detail={"message": "保存済みの抽出結果がありません"})
    return {"source": "saved", **_public(record)}


def _public(record: dict) -> dict:
    """画面へ返す内容。生の出力は除き、根拠の表示に使う入力テキスト（説明・観測）は含める。"""
    out = {k: v for k, v in record.items() if k != "raw_outputs"}
    if "inputs" in out:
        out["inputs"] = {k: out["inputs"][k] for k in ("explanation", "observations") if k in out["inputs"]}
    return out


@app.post("/api/workflows/validate")
def validate(req: ValidateRequest) -> dict:
    return validate_workflow(req.workflow, _catalog()).to_dict()


@app.post("/api/workflows/run")
def run(req: RunRequest) -> dict:
    """荷物1個の実行トレースを返す。検証エラーのワークフローは 422 で拒否する。"""
    try:
        return run_workflow(req.workflow, req.object, _catalog())
    except WorkflowValidationError as e:
        raise HTTPException(status_code=422, detail=e.result.to_dict()) from e
