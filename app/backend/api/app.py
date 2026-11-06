"""Work2Robot のHTTP API（docs/ARCHITECTURE.md「API境界の案」）。

起動：.venv\\Scripts\\python -m uvicorn backend.api.app:app --port 8000
判定・実行は backend.workflow に任せ、このモジュールは受け渡しだけを行う。
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import anthropic
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel

from backend import analysis_job
from backend import inputs as inputs_mod
from backend import scenario as scenario_mod
from backend.ai import extraction, observation
from backend.ai.client import make_client
from backend.inputs import current_video
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
V2_FIXTURE_NOTICE = "今の作業動画から作ったClaudeの保存済みの結果がないため、手書きのテスト用の業務定義を表示しています（Step 2 で「解析開始」）。"


def _latest_v2_extraction() -> dict | None:
    """今の作業動画から作ったv2の抽出の最新（別の動画の結果は使わない）。"""
    hit = inputs_mod.latest_for("extraction", current_video(), directory=extraction.RECORD_DIR)
    if hit is None:
        return None
    f, rec = hit
    return {"source": "saved", "record_file": f.name, **_public(rec)}


def _v2_context() -> dict:
    """画面とv2の実行で共通に使う：業務（Claudeの保存済み抽出、なければ手書き）・荷物・構成。"""
    from backend.ai.hardware_selection import RECORD_DIR as HW_DIR
    from backend.workflow.hardware import compute_requirements

    # Step 1 で登録したマスタ（荷物・カゴ車・仮置き場）を、以降の全ステップの前提として使う
    m = masters.load_masters()
    cases = masters.cases_of(m)  # 出荷明細から組み立てた荷物（1個ずつ）と便
    hw = _load("hardware_catalog.json")
    ext = _latest_v2_extraction()
    job = masters.apply_environment(ext["job"] if ext else _load("scenario_v2/job_fixture.json"), m["environment"])
    workflow = ext["workflow"] if ext else _load("scenario_v2/workflow_fixture.json")
    objects = {o["object_id"]: o for o in cases["objects"]}
    sc = scenario_mod.load()
    # 業務要件は、シナリオの対象の出荷予定から導く（Step 4 の照合と Step 5 の判定で同じ要件を使う）
    batch = next((b for b in cases["batches"] if b["batch_id"] == sc["batch_id"]), None) \
        or next((b for b in cases["batches"] if b["batch_id"] == "video_batch"), cases["batches"][0])
    requirements = compute_requirements(job, workflow, [objects[i] for i in batch["object_ids"] if i in objects], hw)
    hit = inputs_mod.latest_for("hardware_selection", current_video(), directory=HW_DIR)  # 今の動画の業務から作った仮選定だけ
    sel = {**hit[1], "record_file": hit[0].name} if hit else None
    if sel is not None and not sel.get("config", {}).get("product_id"):
        sel = None  # 部品を自由に組んでいた旧形式の仮選定は、カタログ方式では使わない
    configs = []
    if sel is not None:
        configs.append({**sel["config"], "source": "claude", "created_at": sel.get("created_at")})
    for c in _load("scenario_v2/hardware_configs.json")["configs"]:
        if c["config_id"] == "light_vacuum" or (sel is None and c["config_id"] == "handwritten_medium"):
            configs.append({**c, "source": "handwritten"})
    selection = {k: v for k, v in sel.items() if k != "raw_outputs"} if sel else None
    # シナリオに紐づくデータの参照（既存のファイル名をIDとして使う）
    refs = {"scenario_id": sc["scenario_id"], "video_id": current_video().name, "batch_id": batch["batch_id"],
            "workflow_id": ext["record_file"] if ext else None,
            "selection_id": Path(sel["record_file"]).stem if sel else None}
    return {"cases": cases, "objects": objects, "hw": hw, "extraction": ext, "job": job, "workflow": workflow,
            "requirements": requirements, "selection": selection, "configs": configs, "masters": m,
            "scenario": sc, "refs": refs}


def _requirements_for(ctx: dict, batch_id: str | None) -> list[dict]:
    """その出荷予定の荷物で導いた業務要件（シナリオの対象の出荷予定なら計算済みのもの）。"""
    from backend.workflow.hardware import compute_requirements

    if not batch_id or batch_id == ctx["refs"]["batch_id"]:
        return ctx["requirements"]
    batch = next((b for b in ctx["cases"]["batches"] if b["batch_id"] == batch_id), None)
    if batch is None:
        raise HTTPException(status_code=404, detail={"message": f"出荷予定がありません: {batch_id}"})
    return compute_requirements(ctx["job"], ctx["workflow"], [ctx["objects"][i] for i in batch["object_ids"] if i in ctx["objects"]], ctx["hw"])


def _masters_public(m: dict) -> dict:
    ref = masters.load_reference()  # 出荷実績・倉庫内マップ（参照のみ・模擬）
    return {"items": m["items"], "environment": m["environment"], "source": m["source"], "shipments": m["shipments"], "updated_at": m["updated_at"],
            "shipment_results": ref["shipment_results"], "warehouse_map": ref["warehouse_map"],
            # 出荷明細から組み立てた荷物（1個ずつ）と便（画面の参照用。保存はしない）
            "parcels": masters.parcels_of(m["items"], m["shipments"])["items"], "batches": masters.batches_of(m["shipments"]),
            "definitions": masters.MASTER_DEFS, "categories": masters.CATEGORIES, "validation": masters.validate_masters(m["items"], m["environment"], m["shipments"])}


@app.get("/api/v2/masters")
def v2_masters() -> dict:
    """Step 1：現在のマスタ（荷姿マスタ・環境マスタ）・便情報と検証結果。"""
    return _masters_public(masters.load_masters())


class MastersRequest(BaseModel):
    items: dict[str, Any]
    environment: dict[str, Any]
    shipments: dict[str, Any]


@app.post("/api/v2/masters/validate")
def v2_masters_validate(req: MastersRequest) -> dict:
    """保存せずに検証だけ行う（画面の入力中の確認用）。"""
    return masters.validate_masters(req.items, req.environment, req.shipments)


@app.put("/api/v2/masters")
def v2_masters_save(req: MastersRequest) -> dict:
    """マスタを登録する。エラーがあれば 422 で保存しない。以降のステップはこの値で動く。"""
    try:
        return _masters_public(masters.save_masters(req.items, req.environment, req.shipments))
    except masters.MasterError as e:
        raise HTTPException(status_code=422, detail={"message": str(e), **e.validation}) from e


@app.delete("/api/v2/masters")
def v2_masters_reset() -> dict:
    """登録値を消して初期値（模擬のマスタ）に戻す。"""
    return _masters_public(masters.reset_masters())


@app.get("/api/v2/state")
def v2_state() -> dict:
    """v2の画面の初期表示：入力（文字起こし・観測）、抽出した業務、能力要件、仮選定、比較用の構成。"""
    from backend.ai.task_structure import RECORD_DIR as TASK_DIR

    ctx = _v2_context()
    # タスク構造は、今の動画から作り、抽出に使ったのと同じ観測から作ったものだけを使う（食い違う組み合わせは表示しない）
    hit = inputs_mod.latest_for("task_structure", current_video(), directory=TASK_DIR)
    tasks = hit[1] if hit else None
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
        "selection_stale": _selection_stale(ctx),
        "scenario": ctx["scenario"], "refs": ctx["refs"],
        "video_url": f"/api/media/input_video.mp4?v={current_video().stem}",
        "masters": _masters_public(ctx["masters"]),
        "inputs": _inputs_public(),
    }


def _selection_stale(ctx: dict) -> bool:
    """仮選定が、今のワークフローとは別の版から作られている（Step 3 で直したあと）。
    前の版に戻した版は、戻し先の版と同じ内容として扱う。"""
    sel, ext = ctx["selection"], ctx["extraction"]
    if not sel or not ext:
        return False
    rev = ext.get("meta", {}).get("revision") or {}
    effective = rev["to"] if rev.get("by") == "revert" and rev.get("to") else ext["record_file"]
    return (sel.get("source") or {}).get("extraction") != effective


def _inputs_public() -> dict:
    """トランザクションの作業動画と、画面が表示する解析結果の状況（今の動画から作ったものか）。"""
    v = current_video()
    return {"video": inputs_mod.video_info(v), "analysis": inputs_mod.analysis_status(v),
            "is_demo": v == inputs_mod.INPUT_VIDEO, "job": analysis_job.status()}


@app.get("/api/v2/inputs")
def v2_inputs() -> dict:
    """Step 1：作業動画（ファイル名・長さ・解像度・音声の有無）と、解析結果の状況。"""
    return _inputs_public()


MAX_UPLOAD_S = 600  # 解析の費用と時間を抑えるため、10分を超える動画は受け付けない


@app.post("/api/v2/video")
async def v2_video_upload(request: Request, name: str = "video.mp4") -> dict:
    """Step 2：作業動画（説明音声を含むmp4）をそのまま受け取り、保存して今の作業動画にする。解析はしない。"""
    if analysis_job.status()["state"] == "running":
        raise HTTPException(status_code=409, detail={"message": "解析中は動画を変更できません"})
    if not name.lower().endswith(".mp4"):
        raise HTTPException(status_code=422, detail={"message": "mp4ファイルを選んでください"})
    from datetime import datetime
    inputs_mod.UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    path = inputs_mod.UPLOAD_DIR / f"upload_{datetime.now().strftime('%Y%m%d_%H%M%S')}.mp4"
    with path.open("wb") as f:
        async for chunk in request.stream():
            f.write(chunk)
    info = inputs_mod.video_info(path)
    problem = ("動画として読めません" if not info.get("duration_s") else
               "音声がありません（説明音声を含む動画が必要です）" if not info.get("has_audio") else
               f"動画が長すぎます（{MAX_UPLOAD_S // 60}分まで）" if info["duration_s"] > MAX_UPLOAD_S else None)
    if problem:
        path.unlink(missing_ok=True)
        raise HTTPException(status_code=422, detail={"message": problem})
    inputs_mod.set_current_video(path)
    return {**_inputs_public(), "original_name": name}


@app.delete("/api/v2/video")
def v2_video_reset() -> dict:
    """v5デモの動画に戻す（アップロード済みの動画と解析結果は消さない）。"""
    if analysis_job.status()["state"] == "running":
        raise HTTPException(status_code=409, detail={"message": "解析中は動画を変更できません"})
    inputs_mod.set_current_video(None)
    return _inputs_public()


class AnalyzeRequest(BaseModel):
    supplement: str = ""  # 任意の補足（未検証の補足としてClaudeに渡す）


@app.post("/api/v2/analyze")
def v2_analyze(req: AnalyzeRequest | None = None) -> dict:
    """Step 2「解析開始」：今の作業動画で、文字起こし → 観測 → タスク構造 → ワークフロー生成 → 仮選定 を裏で順に実行（課金あり）。"""
    req = req or AnalyzeRequest()
    v = current_video()
    if not v.exists():
        raise HTTPException(status_code=404, detail={"message": f"作業動画がありません（{v.name}）"})
    if not analysis_job.start(v, req.supplement):
        raise HTTPException(status_code=409, detail={"message": "すでに解析中です"})
    return analysis_job.status()


@app.get("/api/v2/analyze")
def v2_analyze_status() -> dict:
    return analysis_job.status()


# ---- Step 3：ワークフローの確認・教示（backend/workflow_revision.py） ----
class EditRequest(BaseModel):
    ops: list[dict[str, Any]]
    reason: str = ""


class ProposeRequest(BaseModel):
    instruction: str
    focus: str = ""


def _revision_error(e: Exception) -> HTTPException:
    from backend.workflow_revision import RevisionError
    if isinstance(e, RevisionError):
        return HTTPException(status_code=422, detail={"message": str(e), "errors": e.errors})
    if isinstance(e, anthropic.APIError):
        return HTTPException(status_code=502, detail={"message": f"Claude APIエラー: {e}"})
    raise e


@app.post("/api/v2/workflow/edit")
def v2_workflow_edit(req: EditRequest) -> dict:
    """直接編集（規則・判断の基準・偏りの許容範囲）を検証して新しい版として保存する。"""
    from backend import workflow_revision as wr
    try:
        return {"record_file": wr.save_edits(req.ops, req.reason).name}
    except (wr.RevisionError, anthropic.APIError) as e:
        raise _revision_error(e) from e


@app.post("/api/v2/workflow/propose")
def v2_workflow_propose(req: ProposeRequest) -> dict:
    """Claudeへの修正指示から修正案（差分つき）を作る。保存はしない（課金あり・1〜2分）。"""
    from backend import workflow_revision as wr
    try:
        return wr.propose(req.instruction, req.focus)
    except (wr.RevisionError, anthropic.APIError) as e:
        raise _revision_error(e) from e


@app.post("/api/v2/workflow/proposals/{pid}/apply")
def v2_workflow_apply(pid: str) -> dict:
    from backend import workflow_revision as wr
    try:
        return {"record_file": wr.apply_proposal(pid).name}
    except wr.RevisionError as e:
        raise _revision_error(e) from e


@app.delete("/api/v2/workflow/proposals/{pid}")
def v2_workflow_discard(pid: str) -> dict:
    from backend import workflow_revision as wr
    wr.discard_proposal(pid)
    return {"ok": True}


@app.post("/api/v2/workflow/revert")
def v2_workflow_revert() -> dict:
    """1つ前の版に戻す（今の版も残す）。"""
    from backend import workflow_revision as wr
    try:
        return {"record_file": wr.revert().name}
    except wr.RevisionError as e:
        raise _revision_error(e) from e


@app.post("/api/v2/hardware/reselect")
def v2_hardware_reselect() -> dict:
    """Step 4：今のワークフロー（直した版）で、Claudeの仮選定をやり直す（課金あり・約1分。状態は /api/v2/analyze）。"""
    v = current_video()
    if not analysis_job.start(v, steps=[("ロボット構成の仮選定", lambda: analysis_job.select_hardware(v))]):
        raise HTTPException(status_code=409, detail={"message": "解析中です"})
    return analysis_job.status()


# ---- 保存したロボット構成（Step 4 で保存 → Step 5 で選ぶ。backend/robot_configs.py） ----
class RobotConfigRequest(BaseModel):
    name: str
    config: dict[str, Any]
    batch_id: str | None = None  # 選定時に業務要件を導いた出荷予定（省略時はシナリオの対象）


@app.get("/api/v2/robot-configs")
def v2_robot_configs() -> list[dict]:
    from backend import robot_configs as rc
    ctx = _v2_context()
    return rc.list_configs(ctx["selection"], ctx["hw"])


@app.post("/api/v2/robot-configs")
def v2_robot_config_save(req: RobotConfigRequest) -> dict:
    """構成を保存する。選定時のシナリオ・ワークフローの版・出荷予定と、その要件での照合の件数を記録する。"""
    from backend import robot_configs as rc
    from backend.workflow.hardware import HardwareError, check_config, resolve_product_config

    ctx = _v2_context()
    batch_id = req.batch_id or ctx["refs"]["batch_id"]
    basis = {"scenario_id": ctx["refs"]["scenario_id"], "workflow_id": ctx["refs"]["workflow_id"], "batch_id": batch_id}
    try:
        counts = check_config(resolve_product_config(req.config, ctx["hw"]), _requirements_for(ctx, batch_id), ctx["job"]["cart"])["counts"]
        basis["counts"] = counts
    except HardwareError:
        pass  # 構成の誤りは save_config が理由つきで断る
    try:
        return rc.save_config(req.name, req.config, ctx["hw"], basis=basis)
    except rc.RobotConfigError as e:
        raise HTTPException(status_code=422, detail={"message": str(e)}) from e


class ScenarioRequest(BaseModel):
    batch_id: str | None = None
    name: str | None = None


@app.put("/api/v2/scenario")
def v2_scenario_set(req: ScenarioRequest) -> dict:
    """シナリオの名前・対象の出荷予定を変える（Step 2。シナリオIDは変わらない）。"""
    ctx = _v2_context()
    try:
        return scenario_mod.update(ctx["cases"]["batches"], batch_id=req.batch_id, name=req.name)
    except scenario_mod.ScenarioError as e:
        raise HTTPException(status_code=404 if req.batch_id else 422, detail={"message": str(e)}) from e


class ConfirmationRequest(BaseModel):
    resolved: bool
    note: str = ""


@app.put("/api/v2/confirmations/{cid}")
def v2_confirmation_resolve(cid: str, req: ConfirmationRequest) -> dict:
    """ワークフロー確認（Step 3）：確認事項を消し込む（対応済みにする）／戻す。今のワークフローにない確認事項は 404。"""
    ext = _latest_v2_extraction()
    ids = {c.get("id") for c in (ext or {}).get("confirmation_items", [])}
    if cid not in ids:
        raise HTTPException(status_code=404, detail={"message": f"確認事項がありません: {cid}"})
    try:
        return scenario_mod.resolve_confirmation(cid, req.resolved, req.note)
    except scenario_mod.ScenarioError as e:
        raise HTTPException(status_code=422, detail={"message": str(e)}) from e


@app.get("/api/v2/executions/latest")
def v2_execution_latest(robot_config_id: str, batch_id: str) -> dict | None:
    """保存した実行結果のうち、今のシナリオ・ワークフローの版で、この構成・出荷予定の最新（Step 6 が参照）。なければ null。"""
    ctx = _v2_context()
    return scenario_mod.latest_execution(ctx["refs"]["scenario_id"], ctx["refs"]["workflow_id"], robot_config_id, batch_id)


@app.delete("/api/v2/robot-configs/{config_id}")
def v2_robot_config_delete(config_id: str) -> dict:
    from backend import robot_configs as rc
    try:
        rc.delete_config(config_id)
    except rc.RobotConfigError as e:
        raise HTTPException(status_code=422, detail={"message": str(e)}) from e
    return {"ok": True}


class V2RunRequest(BaseModel):
    config_id: str | None = None  # None（かつ config なし）なら能力の制約なし（論理だけ）
    config: dict[str, Any] | None = None  # 画面で着せ替えた構成（ベース＋部品）。config_id より優先
    batch_id: str = "video_batch"
    robot_config_id: str | None = None  # Step 4 で保存した構成のID（指定すれば実行結果を保存し、Step 6 が参照する）


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
        check = check_config(robot, _requirements_for(ctx, req.batch_id), ctx["job"]["cart"])  # Step 4 と同じ要件・同じ照合
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
    from backend.workflow.time_estimate import estimate_robot_time
    result = {"job": trace, "check": check,
              "readiness": assess(trace, ctx["workflow"], _catalog(), confirmation, hardware),
              # 模擬の速度仕様からの作業時間の推定（Step 6。構成なし・速度仕様のない構成は None＝未算出）
              "time_estimate": estimate_robot_time(trace, config, ctx["hw"]) if config is not None else None}
    if req.robot_config_id and config is not None:
        # 実行結果を保存し、シナリオ・動画・ワークフローの版・構成・出荷予定で追跡できるようにする
        refs = {k: ctx["refs"][k] for k in ("scenario_id", "video_id", "workflow_id")}
        result["execution"] = scenario_mod.save_execution(
            {**refs, "robot_config_id": req.robot_config_id, "robot_config_name": config.get("label", ""), "batch_id": req.batch_id,
             "placed": trace["end"]["placed"], "handed_off": trace["end"]["handed_off"]}, result)
    return result


class V2CheckRequest(BaseModel):
    config_id: str | None = None
    config: dict[str, Any] | None = None
    batch_id: str | None = None  # 業務要件を導く出荷予定（省略時はシナリオの対象）


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
    return {"check": check_config(profile, _requirements_for(ctx, req.batch_id), ctx["job"]["cart"]), "profile": profile_summary(profile),
            "source": config.get("source")}


@app.get("/api/media/input_video.mp4")
def input_video() -> FileResponse:
    """今の作業動画（Step 2 でアップロードした動画、なければ v5デモ）。"""
    v = current_video()
    if not v.exists():
        raise HTTPException(status_code=404, detail={"message": f"入力動画がありません（{v.name}）"})
    return FileResponse(v, media_type="video/mp4")


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
