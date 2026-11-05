"""シナリオv2の手書きワークフロー・業務の規則で業務全体を実行し、結果を表示する。

    .venv\\Scripts\\python app\\scripts\\run_job_v2.py [video_batch|alt_batch]
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend.workflow import masters  # noqa: E402
from backend.workflow.job import run_job  # noqa: E402

V2 = ROOT / "data" / "scenario_v2"


def load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def main() -> int:
    batch_id = sys.argv[1] if len(sys.argv) > 1 else "video_batch"
    m = masters.load_masters()  # Step 0 で登録したマスタ（なければ初期値）
    objects = {o["object_id"]: o for o in masters.to_objects(m["items"])}
    batch = next(b for b in m["items"]["batches"] if b["batch_id"] == batch_id)
    t = run_job(masters.apply_environment(load(V2 / "job_fixture.json"), m["environment"]), load(V2 / "workflow_fixture.json"),
                [objects[i] for i in batch["object_ids"]], load(ROOT / "data" / "skill_catalog.json"))
    print(f"[{batch['label']}]")
    print("到着順:", " ".join(t["arrival"]))
    print("積む順:", " ".join(t["order"]))
    for it in t["items"]:
        if it["placement"]:
            pl = it["placement"]
            x, y, z = pl["position"]
            print(f"  {it['object_id']:3} 置く  高さ{pl['base_height']:.2f}m 中心(x={x:+.3f}, z={z:+.3f}) "
                  f"向き{'縦' if pl['rotated'] else '横'} 支え={pl['support'] or '床'} 規則={','.join(it['applied_rules'])}"
                  f"{' 【暫定】' if it['provisional'] else ''}")
        else:
            print(f"  {it['object_id']:3} 引継ぎ {it['handoff_reason']}")
    print("規則:")
    for r in t["rule_results"]:
        print(f"  [{r['status']}] {r['label']}：{r['detail']}" + (f"  ※{'; '.join(r['notes'])}" if r["notes"] else ""))
    print("確認:", json.dumps(t["checks"], ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
