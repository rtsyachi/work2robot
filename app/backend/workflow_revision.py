"""Step 3：ワークフローの確認・教示（直接編集とClaudeへの修正指示）。

- 直した結果は、抽出結果（local_media/extractions）の**新しい版**として保存する。元の版は消さない。
  画面・実行は「今の動画の最新の抽出」を使うので、Step 4〜6 にもそのまま反映される。
- 版には meta.revision に、元の版・直し方（user／claude／revert）・内容（操作や指示文）を残す。
- 直接編集できるのは、業務の規則（有効・無効と注記）、判断ノードの条件と基準値・定義状態、重さの偏りの許容範囲、
  工程のタスクの判断条件（基準名・使い方・優先度＝並び順・追加・削除）。
  構造（判断・分岐の追加や削除）は Claude への指示で直し、差分を見て利用者が承認したものだけ保存する。
- どちらも保存の前に検証器（validate_workflow・業務定義の検査）に通す。通らなければ保存しない。
"""
from __future__ import annotations

import copy
import json
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

from backend import inputs as inputs_mod
from backend.ai import extraction
from backend.workflow import validate_workflow
from backend.workflow.job_rules import SUPPORTED_RULES, JobRulesError, validate_job_rules
from backend.workflow.validator import OPERATORS

ROOT = Path(__file__).resolve().parents[1]
_proposals: dict[str, dict] = {}  # Claudeの修正案（承認待ち。保存していない）


class RevisionError(Exception):
    def __init__(self, message: str, errors: list[dict] | None = None):
        super().__init__(message)
        self.errors = errors or []


def _catalog() -> dict:
    return json.loads((ROOT / "data" / "skill_catalog.json").read_text(encoding="utf-8"))


def current_record() -> tuple[Path, dict]:
    """今の動画から作った最新の抽出（直した版を含む）。"""
    hit = inputs_mod.latest_for("extraction", inputs_mod.current_video(), directory=extraction.RECORD_DIR)
    if hit is None:
        raise RevisionError("今の作業動画のワークフローがありません。Step 2 で解析してください")
    return hit


def check(job: dict, workflow: dict) -> list[dict]:
    """保存してよい形か（ワークフローの検証器・業務定義の検査）。エラーの一覧（空なら保存してよい）。"""
    errors = list(validate_workflow(workflow, _catalog()).to_dict()["errors"])
    errors += extraction.job_errors_v2(job)
    try:
        validate_job_rules(job)
    except JobRulesError as e:
        errors.append({"code": "invalid_job", "node_id": "job", "message": str(e)})
    return errors


def _human(note: str) -> list[dict]:
    return [{"type": "human_confirmed", "note": note}]


def apply_edits(job: dict, workflow: dict, ops: list[dict], reason: str) -> tuple[dict, dict]:
    """直接編集の操作を当てた業務定義とワークフロー（元は変えない）。判断・規則に人の確認を根拠として残す。"""
    job, workflow = copy.deepcopy(job), copy.deepcopy(workflow)
    why = reason.strip() or "利用者が画面で確認・修正"
    nodes = {n["id"]: n for n in workflow["nodes"]}
    for op in ops:
        kind = op.get("op")
        if kind == "rule":
            t = op.get("type")
            if t not in SUPPORTED_RULES:
                raise RevisionError(f"規則の一覧にない規則です：{t}")
            cur = next((r for r in job["rules"] if r["type"] == t), None)
            if not op.get("enabled", True):
                job["rules"] = [r for r in job["rules"] if r["type"] != t]
            elif cur is None:
                job["rules"].append({"type": t, "note": (op.get("note") or SUPPORTED_RULES[t]).strip(), "source_evidence": _human(why)})
            elif op.get("note") is not None and op["note"].strip() != cur.get("note", ""):
                cur["note"] = op["note"].strip()
                cur["source_evidence"] = [*cur.get("source_evidence", []), *_human(why)]
        elif kind == "decision":
            n = nodes.get(op.get("node_id"))
            if n is None or n["type"] != "decision":
                raise RevisionError(f"判断ノードがありません：{op.get('node_id')}")
            if op.get("operator") is not None:
                if op["operator"] not in OPERATORS:
                    raise RevisionError(f"使えない比較です：{op['operator']}")
                n["operator"] = op["operator"]
            status = op.get("definition_status", n.get("definition_status"))
            n["definition_status"] = status
            if status == "needs_confirmation":
                n["value"] = None
                n["confirmation_note"] = (op.get("confirmation_note") or n.get("confirmation_note") or why).strip()
            else:
                n.pop("confirmation_note", None)
                n["value"] = None if n["operator"] == "is_known" else op.get("value", n.get("value"))
            n["source_evidence"] = [*n.get("source_evidence", []), *_human(why)]
        elif kind == "criteria":
            continue  # 工程の構造（タスクの判断条件）は apply_process_edits で当てる
        elif kind == "balance_tolerance":
            v = op.get("value")
            if v is not None and (not isinstance(v, (int, float)) or isinstance(v, bool) or v <= 0):
                raise RevisionError("重さの偏りの許容範囲は正の数（m）で入れてください")
            job["balance_tolerance_m"] = v
            job["balance_tolerance_evidence"] = _human(why) if v is not None else []
        else:
            raise RevisionError(f"扱えない編集です：{kind}")
    return job, workflow


def apply_process_edits(process: dict | None, ops: list[dict], reason: str) -> dict | None:
    """タスクの判断条件の書き換え（op=criteria）。並び順＝優先度。変わらない条件は元の根拠を残し、
    書き換え・追加した条件は「人が確認」を根拠にする。タスクの規則の参照（rule_refs）は判断条件から作り直す。"""
    edits = [op for op in ops if op.get("op") == "criteria"]
    if not edits:
        return None
    process = copy.deepcopy(process or {"stages": []})
    why = reason.strip() or "利用者が画面で確認・修正"
    for op in edits:
        stage = next((s for s in process.get("stages", []) if s["id"] == op.get("stage_id")), None)
        node = next((n for n in (stage or {}).get("nodes", []) if n["id"] == op.get("node_id")), None)
        if node is None:
            raise RevisionError(f"タスクがありません：{op.get('stage_id')}.{op.get('node_id')}")
        old = {(c["name"], c["how"]): c for c in node.get("criteria", [])}
        new = []
        for c in op.get("criteria") or []:
            name, how = str(c.get("name", "")).strip(), str(c.get("how", "")).strip()
            if not name or not how:
                raise RevisionError("判断条件は基準名と使い方の両方を入れてください")
            refs = [t for t in c.get("rule_refs") or []]
            bad = [t for t in refs if t not in SUPPORTED_RULES]
            if bad:
                raise RevisionError(f"規則の一覧にない規則です：{', '.join(bad)}")
            prev = old.get((name, how))
            if prev is not None and prev.get("rule_refs", []) == refs:
                new.append(prev)
            else:
                new.append({"name": name, "how": how, "rule_refs": refs, "basis": "human_confirmed", "source_evidence": _human(why)})
        node["criteria"] = new
        node["rule_refs"] = list(dict.fromkeys(t for c in new for t in c["rule_refs"]))
        node["conditions"] = [f"{c['name']}：{c['how']}" for c in new]
    return process


def _save(base: dict, base_file: str, job: dict, workflow: dict, revision: dict,
          confirmation_items: list | None = None, summary: str | None = None, usage: Any = None,
          of: str | None = None, process: dict | None = None) -> Path:
    rec = {k: v for k, v in base.items() if k not in ("raw_outputs", "record_file")}
    rec["created_at"] = datetime.now().astimezone().isoformat(timespec="seconds")
    rec["job"], rec["workflow"] = job, workflow
    if process is not None:
        rec["process"] = process
    if confirmation_items is not None:
        rec["confirmation_items"] = confirmation_items
    if summary is not None:
        rec["summary"] = summary
    rec["validation"] = {"ok": True, "errors": [], "warnings": validate_workflow(workflow, _catalog()).to_dict()["warnings"]}
    rec["meta"] = {**base.get("meta", {}), "revision": {"of": of if of is not None else base_file, "from": base_file, **revision}}
    rec["meta"]["usage"] = usage if usage is not None else []  # 使用量の集計で元の版の分を二重に数えない
    d = extraction.RECORD_DIR
    d.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    path, i = d / f"extraction_{stamp}.json", 2
    while path.exists():  # 同じ秒に保存しても上書きしない（名前順で後ろになる）
        path, i = d / f"extraction_{stamp}_{i}.json", i + 1
    path.write_text(json.dumps(rec, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def save_edits(ops: list[dict], reason: str = "") -> Path:
    """直接編集を当てて検証し、新しい版として保存する。"""
    f, rec = current_record()
    job, workflow = apply_edits(rec["job"], rec["workflow"], ops, reason)
    process = apply_process_edits(rec.get("process"), ops, reason)
    errors = check(job, workflow)
    if errors:
        raise RevisionError("検証に通らないため保存しませんでした", errors)
    return _save(rec, f.name, job, workflow, {"by": "user", "ops": ops, "reason": reason.strip()}, process=process)


def diff(old_job: dict, old_wf: dict, new_job: dict, new_wf: dict, old_items: list, new_items: list) -> dict:
    """利用者が承認するための差分（規則・ノード・確認事項）。"""
    orules, nrules = {r["type"]: r for r in old_job["rules"]}, {r["type"]: r for r in new_job["rules"]}
    onodes, nnodes = {n["id"]: n for n in old_wf["nodes"]}, {n["id"]: n for n in new_wf["nodes"]}
    strip = lambda n: {k: v for k, v in n.items() if k != "source_evidence"}  # noqa: E731
    label = lambda t: SUPPORTED_RULES.get(t, t)  # noqa: E731
    note = lambda r: r.get("note", "")  # noqa: E731
    return {
        "rules_added": [{"type": t, "label": label(t), "note": note(nrules[t])} for t in nrules if t not in orules],
        "rules_removed": [{"type": t, "label": label(t), "note": note(orules[t])} for t in orules if t not in nrules],
        "rules_changed": [{"type": t, "label": label(t), "before": note(orules[t]), "after": note(nrules[t])}
                          for t in nrules if t in orules and note(nrules[t]) != note(orules[t])],
        "nodes_added": [{"id": i, "label": nnodes[i].get("label", i), "type": nnodes[i]["type"]} for i in nnodes if i not in onodes],
        "nodes_removed": [{"id": i, "label": onodes[i].get("label", i), "type": onodes[i]["type"]} for i in onodes if i not in nnodes],
        "nodes_changed": [{"id": i, "label": nnodes[i].get("label", i), "before": strip(onodes[i]), "after": strip(nnodes[i])}
                          for i in nnodes if i in onodes and strip(nnodes[i]) != strip(onodes[i])],
        "unsupported_before": [u["text"] for u in old_job.get("unsupported_rules", [])],
        "unsupported_after": [u["text"] for u in new_job.get("unsupported_rules", [])],
        "confirmations_resolved": [c["topic"] for c in old_items if c["topic"] not in {x["topic"] for x in new_items}],
        "confirmations_added": [c["topic"] for c in new_items if c["topic"] not in {x["topic"] for x in old_items}],
    }


def propose(instruction: str, focus: str = "", client: Any = None) -> dict:
    """Claudeに修正案を作らせる（課金あり・1〜2分）。保存はせず、差分と一緒に承認待ちとして返す。"""
    if not instruction.strip():
        raise RevisionError("修正の指示を入力してください")
    from backend.ai.client import make_client
    f, rec = current_record()
    current = {"workflow": rec["workflow"], "job": {k: rec["job"].get(k) for k in ("rules", "unsupported_rules", "end_note")},
               "confirmation_items": rec.get("confirmation_items", []), "summary": rec.get("summary", "")}
    from backend.ai.process_structure import ProcessStructureError, attach
    client = client or make_client()
    try:
        result = extraction.extract_workflow(client, rec["inputs"], _catalog(), scenario="v2",
                                             revision=extraction.build_revision_content(current, instruction, focus))
        # 工程の構造も、指示と直した条件に合わせて作り直す（別の呼び出し。同じ修正案に入れる）
        result = attach(result, client, rec["inputs"], current=rec.get("process"), instruction=f"{instruction}（対象：{focus}）" if focus else instruction)
    except extraction.ExtractionError as e:
        raise RevisionError(f"Claudeが検証に通る修正案を作れませんでした：{e}", e.detail.get("errors", [])) from e
    except ProcessStructureError as e:
        raise RevisionError(f"Claudeが検査に通る工程の構造を作れませんでした：{e}", e.errors) from e
    job = result.job
    for k in ("balance_tolerance_m", "balance_tolerance_evidence"):  # 人が直接入れた基準は引き継ぐ（Claudeの出力形式にない）
        if rec["job"].get(k) is not None:
            job[k] = rec["job"][k]
    errors = check(job, result.workflow)
    if errors:
        raise RevisionError("修正案が検証に通りませんでした", errors)
    pid = uuid.uuid4().hex[:12]
    d = diff(rec["job"], rec["workflow"], job, result.workflow, rec.get("confirmation_items", []), result.confirmation_items)
    d.update(process_diff(rec.get("process"), result.process))
    p = {"id": pid, "base": f.name, "instruction": instruction.strip(), "focus": focus, "job": job, "workflow": result.workflow,
         "process": result.process, "confirmation_items": result.confirmation_items, "summary": result.summary,
         "usage": result.meta.get("usage"), "model": result.meta.get("model"), "diff": d}
    _proposals[pid] = p
    return {k: v for k, v in p.items() if k not in ("job", "workflow", "process")}


def process_diff(old: dict | None, new: dict | None) -> dict:
    """工程の構造の差分（工程の追加・削除、工程ごとのタスク・判断の追加・削除・変更）。"""
    os_, ns = {s["id"]: s for s in (old or {}).get("stages", [])}, {s["id"]: s for s in (new or {}).get("stages", [])}
    changed = []
    for sid in ns:
        if sid not in os_:
            continue
        on, nn = {n["id"]: n for n in os_[sid]["nodes"]}, {n["id"]: n for n in ns[sid]["nodes"]}
        strip = lambda n: {k: v for k, v in n.items() if k != "source_evidence"}  # noqa: E731
        added = [nn[i]["label"] for i in nn if i not in on]
        removed = [on[i]["label"] for i in on if i not in nn]
        mod = [nn[i]["label"] for i in nn if i in on and strip(nn[i]) != strip(on[i])]
        if added or removed or mod:
            changed.append({"stage": ns[sid]["name"], "added": added, "removed": removed, "changed": mod})
    return {"stages_added": [ns[i]["name"] for i in ns if i not in os_],
            "stages_removed": [os_[i]["name"] for i in os_ if i not in ns],
            "stages_changed": changed}


def apply_proposal(pid: str) -> Path:
    """承認した修正案を新しい版として保存する（作ったあとで版が変わっていれば保存しない）。"""
    p = _proposals.get(pid)
    if p is None:
        raise RevisionError("修正案が見つかりません（APIを起動し直した場合は作り直してください）")
    f, rec = current_record()
    if f.name != p["base"]:
        raise RevisionError("修正案を作ったあとにワークフローが変わったため反映できません。作り直してください")
    path = _save(rec, f.name, p["job"], p["workflow"], {"by": "claude", "instruction": p["instruction"], "focus": p["focus"],
                                                        "model": p["model"]},
                 p["confirmation_items"], p["summary"], p["usage"], process=p["process"])
    _proposals.pop(pid, None)
    return path


def discard_proposal(pid: str) -> None:
    _proposals.pop(pid, None)


def revert() -> Path:
    """1つ前の版に戻す（今の版も消さず、前の版の内容を新しい版として保存する）。
    戻した版の「前の版」は、戻し先のさらに前（続けて戻すと順にさかのぼる）。"""
    f, rec = current_record()
    prev = (rec.get("meta", {}).get("revision") or {}).get("of")
    if not prev or not (extraction.RECORD_DIR / prev).exists():
        raise RevisionError("戻せる前の版がありません（解析した直後の版です）")
    old = json.loads((extraction.RECORD_DIR / prev).read_text(encoding="utf-8"))
    before = (old.get("meta", {}).get("revision") or {}).get("of") or ""
    return _save(rec, f.name, old["job"], old["workflow"], {"by": "revert", "to": prev},
                 old.get("confirmation_items", []), old.get("summary", ""), of=before, process=old.get("process") or {"stages": []})  # 工程の構造がない版に戻すときは空（画面は既定の表示）
