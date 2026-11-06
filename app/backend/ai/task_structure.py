"""作業動画の時間軸に沿ったタスク構造（Step 2「シナリオ作成」）。

動画の観測テキスト（O…）と音声の文字起こし（S…）から、Claudeが大タスク・小タスク・判断条件（作業ルール候補）を
まとめる。Claudeには時刻を書かせず、観測ID・発話IDの範囲だけを選ばせる。時刻は元の観測・発話の時刻から
決定的に計算する（根拠のない時刻を作らない）。業務ワークフロー（Step 3）とは別物で、時間順の作業の理解に使う。
"""
from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any

from backend.workflow.job_rules import SUPPORTED_RULES

from .client import MODEL
from .observation import fmt_time

ROOT = Path(__file__).resolve().parents[2]
RECORD_DIR = ROOT.parent / "local_media" / "task_structures"
RULE_KINDS = ["spoken", "observed", "ai_hypothesis"]
DEMONSTRATED = ["observed", "not_observed", "unclear"]

SYSTEM_PROMPT = """あなたは物流現場の作業分析の専門家です。人の作業動画を観測したテキスト（O…、時刻付き）と、作業者の説明音声の文字起こし（S…、時刻付き）から、動画の時間軸に沿って「今、何の作業をしていて、具体的に何をしていて、なぜそうしているか」をまとめます。結果は動画の再生位置に合わせて画面に表示されます。

## 大タスク（major_tasks）
- 業務の目的や作業段階に基づくまとまり（例：作業準備、下段の土台づくり など。これは例であり、実際の観測に合わせて名前と数を決める）。3〜8個程度。
- name は短い日本語、purpose はその段階の目的を1文で。
- 時刻は書かない。start_obs・end_obs に観測IDを入れる（この大タスクに含まれる最初と最後の観測）。大タスクは時刻順に並べ、範囲を重ねない。全ての観測をどれかの大タスクに含める（最初・最後の状態の観測を含む）。

## 小タスク（subtasks）
- 大タスクを構成する具体的な作業。利用者が理解しやすい粒度にまとめる（例：「箱H1を床の奥左に置く」。Pick/Move/Placeを個別に分けない）。
- start_obs・end_obs は親の大タスクの範囲内。objects は扱った荷物のタグ（観測に書かれたもの）。

## 判断条件・作業ルール（rules）
- その大タスクの判断理由・配置の制約。作業者の説明に根拠があれば kind=spoken とし speech_ids に発話ID。説明はないが映像から読み取れる作業のやり方なら kind=observed。どちらにも根拠がなくあなたの推測なら kind=ai_hypothesis。
- obs_ids には、そのルールが実際の作業として見えている観測IDを入れる。説明はあるが動画でその作業が確認できない場合は demonstrated=not_observed（実演済みとして扱わない）、確認できれば observed、判別できなければ unclear。
- 説明に数値の基準がない条件（何kg以上が「重い」か等）は definition_status=needs_confirmation とし、confirmation_note に何が未定義かを書く。数値を補わない。
- rule_type は、次の業務の規則の一覧に当てはまればその type、当てはまらなければ other：{rule_types}

## 発話との対応（speech_links）
- 全ての発話IDについて、どの大タスクの説明かを task_id に入れる。発話の時刻と作業の時刻はずれることがある（例：作業の前や後に説明する）。relation は during（その作業中に話した）／before（これから行う作業の説明）／after（終わった作業の説明）／general（業務全体の説明）。どの作業にも対応しない場合は task_id を空文字列にし、note に理由を書く。

## 未確認事項（unresolved）
- 映像から判断できなかったこと、説明と映像が一致しないこと（説明された作業が映っていない、映っている作業の理由が説明されていない等）を、関係する観測ID・発話IDとともに書く。"""


def output_schema() -> dict:
    s = {"type": "string"}
    ids = {"type": "array", "items": s}
    rule = {
        "type": "object",
        "properties": {
            "text": s, "kind": {"type": "string", "enum": RULE_KINDS},
            "rule_type": {"type": "string", "enum": [*SUPPORTED_RULES, "other"]},
            "definition_status": {"type": "string", "enum": ["defined", "needs_confirmation"]},
            "confirmation_note": s, "demonstrated": {"type": "string", "enum": DEMONSTRATED},
            "speech_ids": ids, "obs_ids": ids,
        },
        "required": ["text", "kind", "rule_type", "definition_status", "confirmation_note", "demonstrated", "speech_ids", "obs_ids"],
        "additionalProperties": False,
    }
    sub = {
        "type": "object",
        "properties": {"name": s, "start_obs": s, "end_obs": s, "objects": ids},
        "required": ["name", "start_obs", "end_obs", "objects"], "additionalProperties": False,
    }
    major = {
        "type": "object",
        "properties": {"name": s, "purpose": s, "start_obs": s, "end_obs": s,
                       "subtasks": {"type": "array", "items": sub}, "rules": {"type": "array", "items": rule}},
        "required": ["name", "purpose", "start_obs", "end_obs", "subtasks", "rules"], "additionalProperties": False,
    }
    link = {
        "type": "object",
        "properties": {"speech_id": s, "task_id": s,
                       "relation": {"type": "string", "enum": ["during", "before", "after", "general"]}, "note": s},
        "required": ["speech_id", "task_id", "relation", "note"], "additionalProperties": False,
    }
    unresolved = {
        "type": "object", "properties": {"text": s, "obs_ids": ids, "speech_ids": ids},
        "required": ["text", "obs_ids", "speech_ids"], "additionalProperties": False,
    }
    return {
        "type": "object",
        "properties": {"major_tasks": {"type": "array", "items": major},
                       "speech_links": {"type": "array", "items": link},
                       "unresolved": {"type": "array", "items": unresolved}},
        "required": ["major_tasks", "speech_links", "unresolved"], "additionalProperties": False,
    }


def _sec(t: str) -> float:
    m, s = t.split(":")
    return int(m) * 60 + int(s)


class TaskStructureError(Exception):
    def __init__(self, message: str, errors: list[str] | None = None):
        super().__init__(message)
        self.errors = errors or []


def build(raw: dict, observations: list[dict], speech: list[dict], duration: float) -> tuple[dict, list[str]]:
    """Claudeの出力（IDの範囲）を検査し、時刻を観測・発話から計算した構造にする。戻り値は（構造, エラー）。"""
    order = {o["id"]: i for i, o in enumerate(observations)}
    times = [_sec(o["t"]) for o in observations]
    sids = {s["id"] for s in speech}
    errors: list[str] = []

    def idx(oid: str, where: str) -> int | None:
        if oid not in order:
            errors.append(f"{where}：観測ID {oid} がない")
            return None
        return order[oid]

    def end_time(i: int) -> float:
        # 範囲の終わり＝次の観測の時刻（最後の観測なら動画の終わり）
        nxt = [times[j] for j in range(i + 1, len(times)) if times[j] > times[i]]
        return float(nxt[0]) if nxt else float(duration)

    majors, prev_end = [], -1
    for mi, m in enumerate(raw["major_tasks"]):
        tid = f"T{mi + 1}"
        a, b = idx(m["start_obs"], tid), idx(m["end_obs"], tid)
        if a is None or b is None:
            continue
        if a > b:
            errors.append(f"{tid}：start_obs が end_obs より後")
            continue
        if a <= prev_end:
            errors.append(f"{tid}：前の大タスクと範囲が重なる（{m['start_obs']}）")
        prev_end = b
        subs = []
        for si, s in enumerate(m["subtasks"]):
            sid = f"{tid}.{si + 1}"
            sa, sb = idx(s["start_obs"], sid), idx(s["end_obs"], sid)
            if sa is None or sb is None:
                continue
            if not (a <= sa <= sb <= b):
                errors.append(f"{sid}：小タスクの範囲が親の大タスクの外、または逆順")
                continue
            subs.append({"id": sid, "name": s["name"], "objects": s["objects"],
                         "obs_ids": [observations[k]["id"] for k in range(sa, sb + 1)],
                         "start": float(times[sa]), "end": end_time(sb)})
        rules = []
        for ri, r in enumerate(m["rules"]):
            bad = [x for x in r["speech_ids"] if x not in sids] + [x for x in r["obs_ids"] if x not in order]
            if bad:
                errors.append(f"{tid}.R{ri + 1}：存在しないID {', '.join(bad)}")
            if r["kind"] == "spoken" and not r["speech_ids"]:
                errors.append(f"{tid}.R{ri + 1}：kind=spoken なのに発話IDがない")
            rules.append({"id": f"{tid}.R{ri + 1}", **r})
        majors.append({"id": tid, "name": m["name"], "purpose": m["purpose"],
                       "obs_ids": [observations[k]["id"] for k in range(a, b + 1)],
                       "start": float(times[a]), "end": end_time(b), "subtasks": subs, "rules": rules})
    linked = {ln["speech_id"] for ln in raw["speech_links"]}
    missing = sorted(sids - linked)
    if missing:
        errors.append(f"speech_links に発話 {', '.join(missing)} がない")
    task_ids = {m["id"] for m in majors}
    for ln in raw["speech_links"]:
        if ln["task_id"] and ln["task_id"] not in task_ids:
            errors.append(f"speech_links：{ln['speech_id']} の task_id {ln['task_id']} がない（大タスクは T1 から順に番号を振る）")
    speech_by = {s["id"]: s for s in speech}
    links = [{**ln, "start": speech_by[ln["speech_id"]]["start"], "end": speech_by[ln["speech_id"]]["end"]}
             for ln in raw["speech_links"] if ln["speech_id"] in speech_by]
    return {"major_tasks": majors, "speech_links": links, "unresolved": raw["unresolved"], "duration": duration}, errors


SUPPLEMENT_NOTE = ("利用者が画面で入力した補足（未検証）。動画・発話の根拠ではない。補足だけを根拠にした判断条件は "
                   "kind=ai_hypothesis・definition_status=needs_confirmation とし、confirmation_note に「補足のみ」と書く。")


def build_user_content(observations: list[dict], speech: list[dict], supplement: str = "") -> str:
    obs = [{"id": o["id"], "t": o["t"], "text": o["text"], "objects": o.get("objects", [])} for o in observations]
    sp = [{"id": s["id"], "start": fmt_time(s["start"]), "end": fmt_time(s["end"]), "text": s["text"]} for s in speech]
    body = ("次の観測と発話から、動画の時間軸に沿った大タスク・小タスク・判断条件をまとめてください。"
            "大タスクには出力順に T1, T2, … の番号が付きます（speech_links の task_id もこの番号）。\n\n"
            f"## 動画の観測（Claudeがフレームから作成）\n```json\n{json.dumps(obs, ensure_ascii=False, indent=1)}\n```\n\n"
            f"## 作業者の説明（音声の文字起こし）\n```json\n{json.dumps(sp, ensure_ascii=False, indent=1)}\n```")
    if supplement.strip():  # 入力がないときは従来と同じ入力（v5の結果・評価を変えない）
        body += f"\n\n## 利用者の補足（未検証）\n{SUPPLEMENT_NOTE}\n\n{supplement.strip()}"
    return body


def structure_tasks(client: Any, observations: list[dict], speech: list[dict], duration: float, *,
                    effort: str = "high", max_attempts: int = 2, supplement: str = "") -> dict:
    """Claudeでタスク構造を作り、IDと範囲を検査して時刻を付ける。検査に通らなければ内容を伝えて作り直させる。"""
    rule_types = "、".join(SUPPORTED_RULES)
    messages: list[dict] = [{"role": "user", "content": build_user_content(observations, speech, supplement)}]
    usage, raw_outputs, errors = [], [], []
    for attempt in range(1, max_attempts + 1):
        with client.beta.messages.stream(
            model=MODEL, max_tokens=32000, betas=["server-side-fallback-2026-07-01"], fallbacks="default",
            system=SYSTEM_PROMPT.replace("{rule_types}", rule_types),
            output_config={"effort": effort, "format": {"type": "json_schema", "schema": output_schema()}},
            messages=messages,
        ) as stream:
            msg = stream.get_final_message()
        usage.append({"input_tokens": msg.usage.input_tokens, "output_tokens": msg.usage.output_tokens})
        if msg.stop_reason in ("refusal", "max_tokens"):
            raise TaskStructureError(f"Claudeの応答が途中で終わりました（{msg.stop_reason}）")
        text = "".join(b.text for b in msg.content if b.type == "text")
        raw_outputs.append(text)
        result, errors = build(json.loads(text), observations, speech, duration)
        if not errors:
            return {**result, "meta": {"model": msg.model, "effort": effort, "attempts": attempt, "usage": usage},
                    "raw_outputs": raw_outputs}
        messages.append({"role": "assistant", "content": msg.content})
        messages.append({"role": "user", "content": "次の点が観測・発話と合いません。直して全体を出力し直してください。\n"
                         + "\n".join(f"- {e}" for e in errors)})
    raise TaskStructureError("観測・発話と整合するタスク構造を作れませんでした", errors)


def save_structure(rec: dict, source: dict, directory: Path | None = None) -> Path:
    directory = directory or RECORD_DIR
    directory.mkdir(parents=True, exist_ok=True)
    out = {"created_at": datetime.now().astimezone().isoformat(timespec="seconds"), "source": source, **rec}
    path = directory / f"tasks_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    path.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def latest_structure(directory: Path | None = None) -> dict | None:
    files = sorted((directory or RECORD_DIR).glob("tasks_*.json"))
    if not files:
        return None
    rec = json.loads(files[-1].read_text(encoding="utf-8"))
    rec["record_file"] = files[-1].name
    return rec
