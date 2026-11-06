"""シナリオ（業務単位）と、仮想実行の結果の簡易保存。

- シナリオ＝「カゴ車への混載荷物積付」のような業務の単位。scenario_id は動画名とは独立に付ける。
  作業動画（inputs.current_video()）と対象の出荷予定（batch_id）はシナリオに紐づくデータで、IDには含めない。
  動画を変えても、別の便で検証しても、同じシナリオとして扱う。今回は 1シナリオ・1動画。
  保存先は local_media/scenario.json（なければ既定のシナリオを作る）。
- 実行結果＝シナリオ×ワークフローの版×ロボット構成×出荷予定の仮想実行。local_media/executions/exec_日時.json に保存し、
  Step 6 が参照する（評価がどの版・構成・実行に基づくかを追跡できるようにする）。

キーは既存のものを流用する：video_id＝動画のファイル名、workflow_id＝抽出の版のファイル名（extraction_*.json）、
robot_config_id＝保存した構成のファイル名（robot_*）または Claude の仮選定のファイル名（hardware_*）。
"""
from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MEDIA = ROOT.parent / "local_media"
SCENARIO_FILE = MEDIA / "scenario.json"
EXEC_DIR = MEDIA / "executions"

DEFAULT = {"scenario_id": "sc_cage_cart_loading", "type": "cage_cart_loading", "name": "カゴ車への混載荷物積付",
           "batch_id": "video_batch"}


class ScenarioError(Exception):
    pass


def load(path: Path | None = None) -> dict:
    """今のシナリオ（なければ既定）。"""
    p = path or SCENARIO_FILE
    if p.exists():
        return {**DEFAULT, **json.loads(p.read_text(encoding="utf-8"))}
    return dict(DEFAULT)


def update(batches: list[dict], batch_id: str | None = None, name: str | None = None, path: Path | None = None) -> dict:
    """シナリオの名前・対象の出荷予定を変える（Step 2 で作成・紐づけ。Step 3〜6 が使う。シナリオIDは変わらない）。"""
    sc = load(path)
    if batch_id is not None:
        if not any(b["batch_id"] == batch_id for b in batches):
            raise ScenarioError(f"出荷予定がありません：{batch_id}")
        sc["batch_id"] = batch_id
    if name is not None:
        if not name.strip():
            raise ScenarioError("シナリオの名前を入力してください")
        sc["name"] = name.strip()
    sc["updated_at"] = datetime.now().astimezone().isoformat(timespec="seconds")
    p = path or SCENARIO_FILE
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(sc, ensure_ascii=False, indent=2), encoding="utf-8")
    return sc


def resolve_confirmation(cid: str, resolved: bool, note: str = "", path: Path | None = None) -> dict:
    """ワークフロー確認の確認事項を消し込む（対応済みにする）／戻す。シナリオに確認事項IDごとに記録する
    （ワークフローの版を作り直しても、同じIDの確認事項なら消込を引き継ぐ）。"""
    if not cid.strip():
        raise ScenarioError("確認事項のIDが空です")
    sc = load(path)
    done = dict(sc.get("resolved_confirmations") or {})
    if resolved:
        done[cid] = {"at": datetime.now().astimezone().isoformat(timespec="seconds"), "note": note.strip()}
    else:
        done.pop(cid, None)
    sc["resolved_confirmations"] = done
    p = path or SCENARIO_FILE
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(sc, ensure_ascii=False, indent=2), encoding="utf-8")
    return sc


def save_execution(refs: dict, result: dict, directory: Path | None = None) -> dict:
    """仮想実行の結果を保存し、execution（ID と参照）を返す。"""
    d = directory or EXEC_DIR
    d.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    path, i = d / f"exec_{stamp}.json", 2
    while path.exists():
        path, i = d / f"exec_{stamp}_{i}.json", i + 1
    execution = {"execution_id": path.stem, "created_at": datetime.now().astimezone().isoformat(timespec="seconds"), **refs}
    path.write_text(json.dumps({"execution": execution, "result": result}, ensure_ascii=False), encoding="utf-8")
    return execution


def latest_execution(scenario_id: str, workflow_id: str | None, robot_config_id: str, batch_id: str,
                     directory: Path | None = None) -> dict | None:
    """同じシナリオ・ワークフローの版・構成・出荷予定の最新の実行結果（なければ None）。"""
    d = directory or EXEC_DIR
    if not d.exists():
        return None
    for f in sorted(d.glob("exec_*.json"), reverse=True):
        rec = json.loads(f.read_text(encoding="utf-8"))
        e = rec["execution"]
        if (e.get("scenario_id"), e.get("workflow_id"), e.get("robot_config_id"), e.get("batch_id")) == \
                (scenario_id, workflow_id, robot_config_id, batch_id):
            return {**rec["result"], "execution": e}
    return None
