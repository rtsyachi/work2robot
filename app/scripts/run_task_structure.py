"""保存済みの観測（O…）と文字起こし（S…）から、Claudeで大タスク・小タスク・判断条件をまとめて保存する（課金あり）。

    .venv\\Scripts\\python app\\scripts\\run_task_structure.py
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend.ai.client import make_client  # noqa: E402
from backend.ai.task_structure import TaskStructureError, save_structure, structure_tasks  # noqa: E402
from backend.ai.observation import fmt_time  # noqa: E402


def main() -> int:
    from backend import inputs
    from backend.ai import observation, transcription
    v = inputs.current_video()  # 今の作業動画の最新の文字起こし・観測
    ht = inputs.latest_for("transcript", v, directory=transcription.RECORD_DIR)
    ho = inputs.latest_for("observation", v, directory=observation.RECORD_DIR)
    tr = {**ht[1], "record_file": ht[0].name} if ht else None
    obs = {**ho[1], "record_file": ho[0].name} if ho else None
    if tr is None or obs is None or tr.get("video") != obs.get("video"):
        print("同じ動画の文字起こしと観測がありません（run_transcription.py・run_observation.py --v2 を先に実行）")
        return 1
    duration = float(tr.get("meta", {}).get("duration") or 0) or None
    try:
        rec = structure_tasks(make_client(), obs["segments"], tr["segments"], duration or 0.0)
    except TaskStructureError as e:
        print(f"NG: {e}")
        for x in e.errors:
            print(f"  - {x}")
        return 1
    path = save_structure(rec, {"video": obs["video"], "observation": obs["record_file"], "transcript": tr["record_file"]})
    print(f"保存: {path}")
    print(f"モデル: {rec['meta']['model']}  試行回数: {rec['meta']['attempts']}  使用量: {rec['meta']['usage']}")
    for m in rec["major_tasks"]:
        print(f"[{m['id']}] {fmt_time(m['start'])}–{fmt_time(m['end'])} {m['name']}：{m['purpose']}")
        for s in m["subtasks"]:
            print(f"    {s['id']} {fmt_time(s['start'])}–{fmt_time(s['end'])} {s['name']} {s['objects']}")
        for r in m["rules"]:
            print(f"    ・{r['text']}（{r['kind']}・{r['rule_type']}・実演 {r['demonstrated']}・{r['definition_status']}"
                  f"・発話 {','.join(r['speech_ids']) or '-'}・観測 {','.join(r['obs_ids'][:4]) or '-'}）")
    for ln in rec["speech_links"]:
        print(f"  {ln['speech_id']} → {ln['task_id'] or '対応なし'}（{ln['relation']}）{ln['note']}")
    for u in rec["unresolved"]:
        print(f"  未確認：{u['text']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
