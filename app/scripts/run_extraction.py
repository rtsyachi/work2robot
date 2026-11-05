"""Claudeでワークフローを抽出し、保存して、評価用の期待結果と比べる。

    .venv\\Scripts\\python app\\scripts\\run_extraction.py            # 動画の観測テキストから抽出（課金あり）
    .venv\\Scripts\\python app\\scripts\\run_extraction.py --dev      # 開発用の固定観測テキストから抽出（課金あり）
    .venv\\Scripts\\python app\\scripts\\run_extraction.py --latest   # 保存済みの最新結果を評価するだけ
    .venv\\Scripts\\python app\\scripts\\run_extraction.py --v2       # v2：文字起こし＋動画の観測から業務の規則を抽出（課金あり）
    .venv\\Scripts\\python app\\scripts\\run_extraction.py --v2 --latest
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend.ai.client import make_client  # noqa: E402
from backend.ai.extraction import (  # noqa: E402
    ExtractionError, extract_workflow, latest_record, load_demo_inputs, save_record,
)
from backend.workflow import run_workflow  # noqa: E402


def load(rel: str) -> dict:
    return json.loads((ROOT / rel).read_text(encoding="utf-8"))


def evaluate(workflow: dict, catalog: dict) -> bool:
    """デモ用の荷物を実行し、評価用の期待結果（eval/expected_outcomes.json）と比べる。"""
    expected = load("eval/expected_outcomes.json")["objects"]
    objects = {o["object_id"]: o for o in load("data/demo_cases.json")["objects"]}
    all_ok = True
    for oid, exp in expected.items():
        t = run_workflow(workflow, objects[oid], catalog)
        ev = t["skill_events"][-1] if t["skill_events"] else {}
        got = {
            "zone": ev.get("parameters", {}).get("zone"),
            "press_mode": ev.get("parameters", {}).get("press_mode"),
            "provisional": bool(t["provisional_actions"]),
            "unconfirmed": bool(t["unconfirmed_conditions"]),
            "provisional_evidence": ",".join(sorted({e["type"] for p in t["provisional_actions"] for e in p["evidence"]})),
        }
        diffs = [f"{k}: 期待 {v} / 実際 {got[k]}" for k, v in exp.items()
                 if (v not in got[k].split(",") if k == "provisional_evidence" else got[k] != v)]
        all_ok &= not diffs and t["result"] == "placed"
        route = " → ".join(s["node_id"] for s in t["steps"][2:])
        print(f"[{oid}] {'OK' if not diffs else 'NG'}  {route}  結果={t['result']}")
        for d in diffs:
            print(f"      {d}")
    return all_ok


def evaluate_v2(record: dict, catalog: dict) -> bool:
    """抽出した業務定義（v2）で荷物のまとまりを実行し、eval/expected_outcomes_v2.json と比べる。"""
    from backend.workflow.job import run_job

    exp = load("eval/expected_outcomes_v2.json")
    job, workflow = record["job"], record["workflow"]
    got_rules = [r["type"] for r in job["rules"]]
    print(f"規則: {', '.join(got_rules)}")
    for r in job["rules"]:
        refs = ",".join(e.get("ref") or e["type"] for e in r["source_evidence"])
        print(f"  - {r['type']}：{r.get('note', '')}（根拠 {refs}）")
    for u in job["unsupported_rules"]:
        refs = ",".join(e.get("ref") or e["type"] for e in u["source_evidence"])
        print(f"  - 未対応：{u['text']}（根拠 {refs}）")
    diffs = [f"必要な規則がない：{t}" for t in exp["required_rules"] if t not in got_rules]
    if len(job["unsupported_rules"]) < exp["unsupported_rules_min"]:
        diffs.append("未対応の規則がない")
    from backend.workflow import masters
    cases = masters.default_cases()  # 評価は初期値（模擬）の荷物マスタで行う（期待結果がこの値に対応）
    objs = {o["object_id"]: o for o in cases["objects"]}
    for b in cases["batches"]:
        e = exp["batches"].get(b["batch_id"])
        if not e:
            continue
        t = run_job(job, workflow, [objs[i] for i in b["object_ids"]], catalog)
        status = {r["type"]: r["status"] for r in t["rule_results"]}
        items = {it["object_id"]: it for it in t["items"]}
        above = {s for it in t["items"] if it["placement"] for s in it["placement"]["supporters"]}
        checks = {
            "placed": t["end"]["placed"], "handed_off": t["end"]["handed_off"],
            "last": t["order"][-len(e.get("last", [])):] if e.get("last") else None,
            "first_four_weight_desc": t["order"][:4], "brick_pattern": status.get("brick_pattern"),
            "load_ok": t["checks"]["load"]["ok"], "height_ok": t["checks"]["height"]["ok"],
            "nothing_above": [s for s in e.get("nothing_above", []) if s not in above],
            "provisional": sorted(i for i, it in items.items() if it["provisional"]),
        }
        bd = [f"{b['batch_id']} {k}: 期待 {v} / 実際 {checks[k]}" for k, v in e.items()
              if not k.startswith("_") and checks[k] != v]
        print(f"[{b['batch_id']}] {'OK' if not bd else 'NG'}  順番 {' '.join(t['order'])}  "
              f"配置 {t['end']['placed']}・引継ぎ {t['end']['handed_off']}・{t['end']['load_kg']}kg")
        diffs += bd
    for d in diffs:
        print(f"      {d}")
    return not diffs


def main() -> int:
    catalog = load("data/skill_catalog.json")
    v2 = "--v2" in sys.argv
    if v2:
        from backend.ai.extraction import RECORD_DIR, load_inputs_v2
        if "--latest" in sys.argv:
            files = sorted(RECORD_DIR.glob("extraction_*.json"))
            records = [json.loads(f.read_text(encoding="utf-8")) | {"record_file": f.name} for f in files]
            records = [r for r in records if r.get("meta", {}).get("scenario") == "v2"]
            if not records:
                print("保存済みのv2の抽出結果がありません")
                return 1
            record = records[-1]
            print(f"保存済みの結果を評価: {record['record_file']}（{record['created_at']}）")
        else:
            try:
                inputs = load_inputs_v2()
            except ExtractionError as e:
                print(f"NG: {e}")
                return 1
            print(f"説明: {inputs['explanation']['source_type']}（{len(inputs['explanation']['segments'])}件）"
                  f"  観測: {len(inputs['observations']['segments'])}件")
            try:
                result = extract_workflow(make_client(), inputs, catalog, scenario="v2")
            except ExtractionError as e:
                print(f"NG: {e}  {json.dumps(e.detail, ensure_ascii=False)[:2000]}")
                return 1
            path = save_record(result, inputs)
            record = result.to_dict()
            print(f"保存: {path}")
        meta = record["meta"]
        print(f"モデル: {meta['model']}  試行回数: {meta['attempts']}  使用量: {meta['usage']}")
        print(f"要約: {record['summary']}")
        print(f"ノード数: {len(record['workflow']['nodes'])}  確認事項: {len(record['confirmation_items'])}件")
        for item in record["confirmation_items"]:
            print(f"  - [{item['kind']}] {item['topic']}：{item['detail']}")
        print("--- 評価（eval/expected_outcomes_v2.json）---")
        ok = evaluate_v2(record, catalog)
        print("評価: 全件一致" if ok else "評価: 不一致あり")
        return 0 if ok else 2

    if "--latest" in sys.argv:
        record = latest_record()
        if record is None:
            print("保存済みの抽出結果がありません")
            return 1
        print(f"保存済みの結果を評価: {record['record_file']}（{record['created_at']}）")
    else:
        source = "dev" if "--dev" in sys.argv else "video"
        try:
            inputs = load_demo_inputs(source)
        except ExtractionError as e:
            print(f"NG: {e}")
            return 1
        print(f"観測テキスト: {inputs['observations']['source_type']}（{len(inputs['observations']['segments'])}件）")
        try:
            result = extract_workflow(make_client(), inputs, catalog)
        except ExtractionError as e:
            print(f"NG: {e}  {json.dumps(e.detail, ensure_ascii=False)[:2000]}")
            return 1
        path = save_record(result, inputs)
        record = result.to_dict()
        print(f"保存: {path}")

    meta = record["meta"]
    print(f"モデル: {meta['model']}  試行回数: {meta['attempts']}  フォールバック: {meta['fallback_used']}  使用量: {meta['usage']}")
    print(f"要約: {record['summary']}")
    if "job" in record:
        rule = record["job"]["order_rule"]
        refs = ",".join(e.get("ref", "") for e in rule["source_evidence"])
        print(f"業務全体: 順番 {rule['zones']}（{rule['note']}／根拠 {refs}）・終了条件 {record['job']['end_condition']}")
    print(f"ノード数: {len(record['workflow']['nodes'])}  確認事項: {len(record['confirmation_items'])}件")
    for item in record["confirmation_items"]:
        print(f"  - [{item['kind']}] {item['topic']}：{item['detail']}")
    print("--- 評価（eval/expected_outcomes.json）---")
    ok = evaluate(record["workflow"], catalog)
    print("評価: 全件一致" if ok else "評価: 不一致あり")
    return 0 if ok else 2


if __name__ == "__main__":
    sys.exit(main())
