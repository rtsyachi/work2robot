"""手書きのワークフローとデモ用荷物を実行し、荷物ごとの経路を一覧表示する。

    python scripts/run_cases.py           # 一覧
    python scripts/run_cases.py --json B  # 荷物Bの実行トレース全体
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend.workflow import run_workflow, validate_workflow  # noqa: E402


def load(name: str) -> dict:
    return json.loads((ROOT / "data" / name).read_text(encoding="utf-8"))


def main() -> int:
    workflow, catalog = load("workflow_fixture.json"), load("skill_catalog.json")
    objects = {o["object_id"]: o for o in load("demo_cases.json")["objects"]}

    if len(sys.argv) == 3 and sys.argv[1] == "--json":
        print(json.dumps(run_workflow(workflow, objects[sys.argv[2]], catalog), ensure_ascii=False, indent=2))
        return 0

    v = validate_workflow(workflow, catalog)
    print(f"検証: {'OK' if v.ok else 'NG'}  エラー {len(v.errors)} / 警告 {len(v.warnings)}")
    if not v.ok:
        for e in v.errors:
            print(f"  - [{e.code}] {e.node_id}: {e.message}")
        return 1
    for oid, obj in objects.items():
        t = run_workflow(workflow, obj, catalog)
        route = " → ".join(s["node_id"] for s in t["steps"][2:])
        detail = ", ".join(
            f"{e['skill']}{e['parameters']}{'（暫定）' if e['provisional'] else ''}" for e in t["skill_events"]
        ) or " / ".join(h["reason"] for h in t["handoffs"])
        print(f"[{oid}] {obj['description']}\n    経路: {route}\n    結果: {t['result']}  {detail}")
        for p in t["provisional_actions"]:
            kinds = "・".join(e["type"] for e in p["evidence"])
            print(f"    確認事項: {p['note']}（根拠: {kinds}）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
