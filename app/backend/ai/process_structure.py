"""工程の構造（Step 3：Level 1 の工程と、工程ごとの詳細＝Level 2）をClaudeで作る（課金あり・約$0.1〜0.15）。

ワークフロー生成（extraction.extract_workflow）の**あと**に別の呼び出しで作る。生成側は「条件」（業務の規則・
荷物1個の判断・確認事項）を作り、こちらは「構造」（工程とタスク・判断の並び）を作って、各タスク・判断に
規則（type）と確認事項（ID）を参照でぶら下げる。生成の出力形式はAPIの文法の上限に近いため、分けて作る。
結果は同じ抽出の版（record["process"]）に入れ、確認事項の追加分（根拠のない工程など）は confirmation_items に足す。
"""
from __future__ import annotations

import json
from typing import Any

from .client import MODEL
from .extraction import (
    BASIS, STAGE_ROLES, ExtractionResult, process_errors, process_schema, to_process,
)

SYSTEM_PROMPT = """あなたは物流現場の業務分析の専門家です。人の作業動画の観測・作業者の説明と、それから作った「業務の条件」（業務の規則・荷物1個の判断・確認事項）をもとに、画面で業務全体を俯瞰するための「工程の構造」を作ります。

## 工程（stages）
- 業務全体を大きな工程（3〜6個、業務の順番）に分ける。名前と数は観測・説明に合わせて決める（決まった型に当てはめない）。
- 荷物を1個ずつ取り出して積む繰り返しの工程はちょうど1つで、role を item_loop にする。その nodes・edges は空にする（この工程の詳細は、既存の荷物1個の判断と実行器の繰り返しで表す）。
- 積み終わったあとの確認の工程は role を final_check、それ以外は other。

## 工程の詳細（nodes・edges）：タスクの流れと、各タスクの判断ロジックを分ける
- node は**タスク（何をするか）だけ**。label は業務上の行為を動詞で書く（例：「次に積む荷物を決定する」「荷物の配置位置を決定する」「配置結果を確認する」「カゴ車を点検する」）。
- label に判断の基準や性質（重い・柔らかい・壊れやすい・不明・〜の場合）を入れない。判断そのもの（「〜か」）をノードにしない。
  例：「重い箱から積む順番を決める」→ タスク「次に積む荷物を決定する」＋ 判断条件「重量：重い荷物から先に積む」。
  例：「カゴ車は使用可能か」→ タスク「カゴ車を点検する」＋ 判断条件「破損・固定の状態」＋ 分岐「使えないとき → カゴ車を交換・報告する」。
- criteria（判断条件）には、そのタスクで何を基準に判断するかを並べる。name は基準の名前（重量・寸法・材質・破損注意・積付状態・上積みの可否など）、how はその基準をどう使うか（優先順位・例外を含めて1文）。
  rule_refs には、その基準に対応する業務の規則（与えられた規則の type）を入れる。同じ規則を複数のタスクから参照してよい。規則の一覧で表せない基準は rule_refs を空にして how に書く。数値の基準を推測で作らない。
- 条件によって処理が分かれる場合は、edges の label に条件（「使えないとき」「問題があったとき」など）を書いて分岐先のタスクへつなぐ。通常の順番の辺の label は空文字列。前のタスクへ戻る辺で繰り返しを表してよい。
- detail にはやることを1文で書く。confirmation_refs には、そのタスクに関係する確認事項のID（与えられた確認事項、またはあなたが new_confirmation_items に加えたもの）を入れる。

## 根拠の区別
- basis は video_observation（動画で観測）/ spoken_instruction（作業者の説明）/ ai_hypothesis（あなたの補完）。refs に根拠のセグメントID（O… / S…）を入れる（なければ空配列）。
- basis と refs は工程・タスク・判断条件のそれぞれに付ける。
- 動画・説明に根拠がない工程・タスク・判断条件でも、この業務で通常必要なもの（例：作業前の安全確認、積付先の点検）は入れてよい。その場合は basis を ai_hypothesis にし、現場で確かめる事項を new_confirmation_items（id は P1, P2…）に加えて confirmation_refs で参照する。観測・説明にない作業を観測した事実として書かない。
- 仮想実行（決定的な実行器）が動かすのは item_loop の工程と final_check の規則だけ。それ以外の工程の判断は実行されない前提で書く。"""

REVISION_NOTE = """## 修正の依頼
利用者が次の修正を指示しました。業務の条件はすでにこの指示で直してあります（上の「業務の条件」が修正後）。現在の工程の構造を、指示と修正後の条件に合わせて直し、全体を出力し直してください。指示に関係しない工程・ノード（id・名前・根拠）は変えない。利用者の指示で加えたものの basis は根拠に合わせて選ぶ（動画・説明に根拠がなければ ai_hypothesis）。"""


class ProcessStructureError(Exception):
    def __init__(self, message: str, errors: list[dict] | None = None):
        super().__init__(message)
        self.errors = errors or []


def build_user_content(inputs: dict, job: dict, workflow: dict, confirmation_items: list[dict],
                       current: dict | None = None, instruction: str = "") -> str:
    conditions = {
        "rules": [{"type": r["type"], "note": r.get("note", "")} for r in job.get("rules", [])],
        "unsupported_rules": [u["text"] for u in job.get("unsupported_rules", [])],
        "item_workflow": [{"id": n["id"], "type": n["type"], "label": n.get("label", "")} for n in workflow.get("nodes", [])],
        "confirmation_items": [{"id": c["id"], "topic": c["topic"]} for c in confirmation_items],
    }
    seg = lambda k: [{"id": s["id"], "t": s.get("t", ""), "text": s["text"]} for s in inputs.get(k, {}).get("segments", [])]  # noqa: E731
    body = (f"## 作業者の説明（音声の文字起こし）\n```json\n{json.dumps(seg('explanation'), ensure_ascii=False)}\n```\n\n"
            f"## 動画の観測\n```json\n{json.dumps(seg('observations'), ensure_ascii=False)}\n```\n\n"
            f"## 業務の条件（ワークフロー生成の結果）\n```json\n{json.dumps(conditions, ensure_ascii=False, indent=1)}\n```")
    if current is not None:
        body += f"\n\n## 現在の工程の構造\n```json\n{json.dumps(current, ensure_ascii=False, indent=1)}\n```"
    if instruction.strip():  # 修正の依頼（今の版に工程の構造がなくても、指示は伝える）
        body += f"\n\n{REVISION_NOTE}\n\n指示：{instruction.strip()}"
    return body + "\n\n上の入力から、工程の構造を作ってください。"


def structure_process(client: Any, inputs: dict, job: dict, workflow: dict, confirmation_items: list[dict], *,
                      current: dict | None = None, instruction: str = "", effort: str = "medium",
                      max_attempts: int = 2) -> tuple[dict, list[dict], list[dict]]:
    """工程の構造を作り、検査する。戻り値は（工程の構造、加える確認事項、使用量）。"""
    known = {c["id"] for c in confirmation_items}
    messages: list[dict] = [{"role": "user", "content": build_user_content(inputs, job, workflow, confirmation_items, current, instruction)}]
    usage: list[dict] = []
    errors: list[dict] = []
    for _ in range(max_attempts):
        with client.beta.messages.stream(
            model=MODEL, max_tokens=32000, betas=["server-side-fallback-2026-07-01"], fallbacks="default",
            system=SYSTEM_PROMPT,
            output_config={"effort": effort, "format": {"type": "json_schema", "schema": process_schema()}},
            messages=messages,
        ) as stream:
            msg = stream.get_final_message()
        usage.append({"input_tokens": msg.usage.input_tokens, "output_tokens": msg.usage.output_tokens})
        if msg.stop_reason in ("refusal", "max_tokens"):
            raise ProcessStructureError(f"Claudeの応答が途中で終わりました（{msg.stop_reason}）")
        raw = json.loads("".join(b.text for b in msg.content if b.type == "text"))
        process = to_process(raw)
        added = [{**c, "related_node_ids": [], "source_evidence": [{"type": "ai_hypothesis", "note": "工程の構造を作るときにClaudeが補完した"}]}
                 for c in raw["new_confirmation_items"]]
        errors, warnings = process_errors(process, job, known | {c["id"] for c in added})
        if not errors:
            process["warnings"] = warnings
            return process, added, usage
        messages.append({"role": "assistant", "content": msg.content})
        messages.append({"role": "user", "content": "次の点を直して、全体を出力し直してください。\n"
                         + "\n".join(f"- [{e['code']}] {e['node_id']}: {e['message']}" for e in errors)})
    raise ProcessStructureError("検査に通る工程の構造を作れませんでした", errors)


def attach(result: ExtractionResult, client: Any, inputs: dict, *, current: dict | None = None, instruction: str = "") -> ExtractionResult:
    """ワークフロー生成の結果に、工程の構造と追加の確認事項を加える（同じ版に保存するため）。"""
    process, added, usage = structure_process(client, inputs, result.job, result.workflow, result.confirmation_items,
                                              current=current, instruction=instruction)
    result.process = process
    result.confirmation_items = [*result.confirmation_items, *[c for c in added if c["id"] not in {x["id"] for x in result.confirmation_items}]]
    result.meta["process_usage"] = usage
    result.meta["usage"] = [*result.meta.get("usage", []), *usage]  # 使用量の集計に含める
    return result


__all__ = ["BASIS", "STAGE_ROLES", "ProcessStructureError", "attach", "structure_process"]
