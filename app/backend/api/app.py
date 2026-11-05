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
from backend.workflow import WorkflowValidationError, masters, run_workflow, validate_workflow
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


# ---- シナリオv2：業務の規則・ハードウェア構成（docs/ARCHITECTURE.md「API境界の案」） ----
ROOT_DIR = DATA_DIR.parent.parent  # リポジトリのルート（app/ の1つ上）
V2_VIDEO = ROOT_DIR / "materials" / "input_video_v2.mp4"
V2_FIXTURE_NOTICE = "Claudeの保存済みの結果がないため、手書きのテスト用の業務定義を表示しています。"


def _latest_v2_extraction() -> dict | None:
    for f in sorted(extraction.RECORD_DIR.glob("extraction_*.json"), reverse=True):
        rec = json.loads(f.read_text(encoding="utf-8"))
        if rec.get("meta", {}).get("scenario") == "v2":
            return {"source": "saved", "record_file": f.name, **_public(rec)}
    return None


def _v2_context() -> dict:
    """画面とv2の実行で共通に使う：業務（Claudeの保存済み抽出、なければ手書き）・荷物・構成。"""
    from backend.ai.hardware_selection import latest_selection
    from backend.workflow.hardware import compute_requirements

    # Step 0 で登録したマスタ（荷物・カゴ車・仮置き場）を、以降の全ステップの前提として使う
    m = masters.load_masters()
    cases = {"objects": masters.to_objects(m["items"]), "batches": m["items"]["batches"]}
    hw = _load("hardware_catalog.json")
    ext = _latest_v2_extraction()
    job = masters.apply_environment(ext["job"] if ext else _load("scenario_v2/job_fixture.json"), m["environment"])
    workflow = ext["workflow"] if ext else _load("scenario_v2/workflow_fixture.json")
    objects = {o["object_id"]: o for o in cases["objects"]}
    video_batch = next((b for b in cases["batches"] if b["batch_id"] == "video_batch"), cases["batches"][0])
    requirements = compute_requirements(job, workflow, [objects[i] for i in video_batch["object_ids"]], hw)
    sel = latest_selection()
    if sel is not None and not sel.get("config", {}).get("product_id"):
        sel = None  # 部品を自由に組んでいた旧形式の仮選定は、カタログ方式では使わない
    configs = []
    if sel is not None:
        configs.append({**sel["config"], "source": "claude", "created_at": sel.get("created_at")})
    for c in _load("scenario_v2/hardware_configs.json")["configs"]:
        if c["config_id"] == "light_vacuum" or (sel is None and c["config_id"] == "handwritten_medium"):
            configs.append({**c, "source": "handwritten"})
    selection = {k: v for k, v in sel.items() if k != "raw_outputs"} if sel else None
    return {"cases": cases, "objects": objects, "hw": hw, "extraction": ext, "job": job, "workflow": workflow,
            "requirements": requirements, "selection": selection, "configs": configs, "masters": m}


def _masters_public(m: dict) -> dict:
    return {"items": m["items"], "environment": m["environment"], "source": m["source"], "updated_at": m["updated_at"],
            "validation": masters.validate_masters(m["items"], m["environment"])}


@app.get("/api/v2/masters")
def v2_masters() -> dict:
    """Step 0：現在のマスタ（荷物マスタ・環境マスタ）と検証結果。"""
    return _masters_public(masters.load_masters())


class MastersRequest(BaseModel):
    items: dict[str, Any]
    environment: dict[str, Any]


@app.post("/api/v2/masters/validate")
def v2_masters_validate(req: MastersRequest) -> dict:
    """保存せずに検証だけ行う（画面の入力中の確認用）。"""
    return masters.validate_masters(req.items, req.environment)


@app.put("/api/v2/masters")
def v2_masters_save(req: MastersRequest) -> dict:
    """マスタを登録する。エラーがあれば 422 で保存しない。以降のステップはこの値で動く。"""
    try:
        return _masters_public(masters.save_masters(req.items, req.environment))
    except masters.MasterError as e:
        raise HTTPException(status_code=422, detail={"message": str(e), **e.validation}) from e


@app.delete("/api/v2/masters")
def v2_masters_reset() -> dict:
    """登録値を消して初期値（模擬のマスタ）に戻す。"""
    return _masters_public(masters.reset_masters())


@app.get("/api/v2/state")
def v2_state() -> dict:
    """v2の画面の初期表示：入力（文字起こし・観測）、抽出した業務、能力要件、仮選定、比較用の構成。"""
    from backend.ai.task_structure import latest_structure

    ctx = _v2_context()
    # タスク構造は、抽出に使ったのと同じ観測から作ったものだけを使う（食い違う組み合わせは表示しない）
    tasks = latest_structure()
    obs_file = ((ctx["extraction"] or {}).get("inputs") or {}).get("observations", {}).get("record_file")
    if tasks is not None and obs_file and tasks.get("source", {}).get("observation") != obs_file:
        tasks = None
    return {
        "tasks": {k: v for k, v in tasks.items() if k != "raw_outputs"} if tasks else None,
        "notice": None if ctx["extraction"] else V2_FIXTURE_NOTICE,
        "extraction": ctx["extraction"], "job": ctx["job"], "workflow": ctx["workflow"],
        "level1": level1_graph(), "catalog": _catalog(), "hw_catalog": ctx["hw"],
        "objects": ctx["cases"]["objects"], "batches": ctx["cases"]["batches"],
        "requirements": ctx["requirements"], "selection": ctx["selection"], "configs": ctx["configs"],
        "video_url": "/api/media/work_video_v2.mp4",
        "masters": _masters_public(ctx["masters"]),
    }


class V2RunRequest(BaseModel):
    config_id: str | None = None  # None（かつ config なし）なら能力の制約なし（論理だけ）
    config: dict[str, Any] | None = None  # 画面で着せ替えた構成（ベース＋部品）。config_id より優先
    batch_id: str = "video_batch"


COMPONENT_KEYS = ("product_id", "base", "arm", "end_effector", "sensors", "peripherals")


def _same_parts(a: dict, b: dict) -> bool:
    keys = ("product_id", "end_effector", "sensors", "peripherals")
    return all(sorted(a.get(k) or []) == sorted(b.get(k) or []) if k in ("sensors", "peripherals") else a.get(k) == b.get(k)
               for k in keys)


def _pick_config(ctx: dict, config_id: str | None, config: dict | None) -> dict | None:
    """画面から来た構成（機種＋オプション）を決める。組み合わせがClaudeの仮選定と同じなら、その選定理由・未確認の点を使う。"""
    if config is not None:
        out = {"config_id": config.get("config_id") or "custom", "label": config.get("label") or "画面で選んだ構成",
               "source": "custom", **{k: config.get(k) for k in COMPONENT_KEYS if config.get(k) is not None}}
        claude = next((c for c in ctx["configs"] if c.get("source") == "claude"), None)
        if claude and _same_parts(out, claude):
            out["source"] = "claude"
        return out
    if config_id:
        found = next((c for c in ctx["configs"] if c["config_id"] == config_id), None)
        if found is None:
            raise HTTPException(status_code=404, detail={"message": f"構成がありません: {config_id}"})
        return found
    return None


@app.post("/api/v2/run")
def v2_run(req: V2RunRequest) -> dict:
    """選んだ構成で業務を実行し、仕様照合と事前評価（改善余地を含む）を返す。"""
    from backend.workflow.hardware import HardwareError, check_config, resolve_product_config as resolve_config

    ctx = _v2_context()
    batch = next((b for b in ctx["cases"]["batches"] if b["batch_id"] == req.batch_id), None)
    if batch is None:
        raise HTTPException(status_code=404, detail={"message": f"バッチがありません: {req.batch_id}"})
    objs = [ctx["objects"][i] for i in batch["object_ids"]]
    robot, check = None, None
    config = _pick_config(ctx, req.config_id, req.config)
    if config is not None:
        try:
            robot = resolve_config(config, ctx["hw"])
        except HardwareError as e:
            raise HTTPException(status_code=422, detail={"message": str(e)}) from e
        check = check_config(robot, ctx["requirements"], ctx["job"]["cart"])
    try:
        trace = run_job(ctx["job"], ctx["workflow"], objs, _catalog(), robot=robot)
    except (WorkflowValidationError, JobError) as e:
        raise HTTPException(status_code=422, detail={"message": str(e)}) from e
    sel = ctx["selection"] if config and config.get("source") == "claude" else None
    hardware = None
    if check is not None:
        hardware = {"check": check, "label": config.get("label", ""),
                    "unverified_points": sel["unverified_points"] if sel else [],
                    "improvement_hypotheses": sel["improvement_hypotheses"] if sel else [],
                    "product": robot.get("product") if robot else None}
    confirmation = ctx["extraction"]["confirmation_items"] if ctx["extraction"] else []
    return {"job": trace, "check": check,
            "readiness": assess(trace, ctx["workflow"], _catalog(), confirmation, hardware)}


class V2CheckRequest(BaseModel):
    config_id: str | None = None
    config: dict[str, Any] | None = None


@app.post("/api/v2/check")
def v2_check(req: V2CheckRequest) -> dict:
    """構成と能力要件の仕様照合だけを返す（③ロボット構成の画面用。業務は実行しない）。"""
    from backend.workflow.hardware import HardwareError, check_config, resolve_product_config as resolve_config

    ctx = _v2_context()
    config = _pick_config(ctx, req.config_id, req.config)
    if config is None:
        raise HTTPException(status_code=422, detail={"message": "config_id か config を指定してください"})
    try:
        profile = resolve_config(config, ctx["hw"])
    except HardwareError as e:
        raise HTTPException(status_code=422, detail={"message": str(e)}) from e
    from backend.workflow.hardware import profile_summary
    return {"check": check_config(profile, ctx["requirements"], ctx["job"]["cart"]), "profile": profile_summary(profile),
            "source": config.get("source")}


@app.get("/api/media/work_video_v2.mp4")
def work_video_v2() -> FileResponse:
    """入力動画v2（デモ用模擬作業動画＋ユーザーの録音音声）。"""
    if not V2_VIDEO.exists():
        raise HTTPException(status_code=404, detail={"message": "入力動画v2がありません"})
    return FileResponse(V2_VIDEO, media_type="video/mp4")


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
