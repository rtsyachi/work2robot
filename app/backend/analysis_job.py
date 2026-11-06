"""Step 2「解析開始」：既存の解析処理を、今の作業動画に対して順に呼び出す（課金あり・6〜7分程度）。

文字起こし → 動画の観測 → タスク構造 → ワークフロー生成（抽出v2） → ハードウェアの仮選定。
各処理は scripts/run_*.py と同じ関数・設定を使い、結果は各フォルダに保存する（画面は今の動画の最新結果を表示する）。
同時に動かすのは1件だけ。状態は簡易表示用（待機・解析中・完了・失敗）で、途中からの再実行はしない。
"""
from __future__ import annotations

import json
import threading
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

ROOT = Path(__file__).resolve().parents[1]
STAGES = ["文字起こし", "動画の観測", "タスク構造", "ワークフロー生成", "ロボット構成の仮選定"]

_lock = threading.Lock()
_status: dict[str, Any] = {"state": "idle", "stage": None, "stages": STAGES, "video": None,
                           "error": None, "started_at": None, "finished_at": None}


def _now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def status() -> dict:
    with _lock:
        return dict(_status)


def _set(**kw: Any) -> None:
    with _lock:
        _status.update(kw)


def _steps(video: Path, supplement: str) -> list[tuple[str, Callable[[], None]]]:
    """既存の関数を、scripts/run_*.py と同じ設定で順に呼ぶ処理の一覧。"""
    from backend.ai import extraction, observation, task_structure, transcription
    from backend.ai.client import make_client

    note = supplement.strip()

    def transcribe() -> None:
        transcription.save_transcript(transcription.transcribe_video(video))

    def observe() -> None:
        observation.save_observation(observation.observe_video(make_client(), video, width=1024, chunk=60))

    def tasks() -> None:
        from backend import inputs
        ht = inputs.latest_for("transcript", video, directory=transcription.RECORD_DIR)
        ho = inputs.latest_for("observation", video, directory=observation.RECORD_DIR)
        tr, obs = {**ht[1], "record_file": ht[0].name}, {**ho[1], "record_file": ho[0].name}
        duration = float(tr.get("meta", {}).get("duration") or 0)
        rec = task_structure.structure_tasks(make_client(), obs["segments"], tr["segments"], duration, supplement=note)
        source = {"video": obs["video"], "observation": obs["record_file"], "transcript": tr["record_file"]}
        if note:
            source["supplement"] = note
        task_structure.save_structure(rec, source)

    def workflow() -> None:
        inputs = extraction.load_inputs_v2()
        if note:
            inputs["supplement"] = {"source_type": "user_supplement", "note": "利用者が画面で入力した補足（未検証）", "text": note}
        catalog = json.loads((ROOT / "data" / "skill_catalog.json").read_text(encoding="utf-8"))
        from backend.ai.process_structure import attach
        client = make_client()
        result = extraction.extract_workflow(client, inputs, catalog, scenario="v2")
        extraction.save_record(attach(result, client, inputs), inputs)  # 条件（生成）と構造（工程）を同じ版に

    return list(zip(STAGES, [transcribe, observe, tasks, workflow, lambda: select_hardware(video)]))


def select_hardware(video: Path) -> None:
    """今の動画の最新のワークフロー（直した版を含む）から、Claudeで仮選定する（scripts/run_hardware_selection.py と同じ）。"""
    from backend import inputs
    from backend.ai import extraction, hardware_selection
    from backend.ai.client import make_client
    from backend.workflow import masters
    from backend.workflow.hardware import compute_requirements

    hit = inputs.latest_for("extraction", video, directory=extraction.RECORD_DIR)
    if hit is None:
        raise RuntimeError("この動画のワークフローがありません")
    f, ext = hit
    ext = ext | {"record_file": f.name}
    hw = json.loads((ROOT / "data" / "hardware_catalog.json").read_text(encoding="utf-8"))
    m = masters.load_masters()
    cases = masters.cases_of(m)
    objs = {o["object_id"]: o for o in cases["objects"]}
    batch = next(b for b in cases["batches"] if b["batch_id"] == "video_batch")
    ext["job"] = masters.apply_environment(ext["job"], m["environment"])
    reqs = compute_requirements(ext["job"], ext["workflow"], [objs[i] for i in batch["object_ids"]], hw)
    sel = hardware_selection.select_hardware(make_client(), ext, reqs, hw, ext["job"]["cart"])
    sel["source"] = {"extraction": f.name, "video": ext["inputs"]["observations"].get("video")}
    hardware_selection.save_selection(sel)


def run(video: Path, supplement: str = "", steps: list[tuple[str, Callable[[], None]]] | None = None) -> None:
    """順に実行し、状態を更新する（失敗したらそこで止め、理由を残す。保存済みの結果は消さない）。"""
    for name, fn in steps if steps is not None else _steps(video, supplement):
        _set(stage=name)
        try:
            fn()
        except Exception as e:  # noqa: BLE001  画面に理由を出す
            _set(state="error", error=f"{name}で失敗しました：{e}", finished_at=_now())
            return
    _set(state="done", stage=None, finished_at=_now())


def start(video: Path, supplement: str = "", steps: list[tuple[str, Callable[[], None]]] | None = None) -> bool:
    """裏で解析を始める。すでに解析中なら False。"""
    with _lock:
        if _status["state"] == "running":
            return False
        _status.update(state="running", stage=None, video=video.name, error=None, started_at=_now(), finished_at=None)
    threading.Thread(target=run, args=(video, supplement, steps), daemon=True).start()
    return True
