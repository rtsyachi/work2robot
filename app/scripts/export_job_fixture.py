"""フロントエンドの単体テスト用に、業務実行トレース（mixed_batch）を書き出す。

    .venv\\Scripts\\python app\\scripts\\export_job_fixture.py
バックエンドの業務実行器を変えたら再実行する。
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend.workflow.job import run_job  # noqa: E402


def load(name: str) -> dict:
    return json.loads((ROOT / "data" / name).read_text(encoding="utf-8"))


cases = load("demo_cases.json")
objects = {o["object_id"]: o for o in cases["objects"]}
batch = next(b for b in cases["batches"] if b["batch_id"] == "mixed_batch")
trace = run_job(load("job_fixture.json"), load("workflow_fixture.json"),
                [objects[i] for i in batch["object_ids"]], load("skill_catalog.json"))
out = ROOT / "frontend" / "src" / "lib" / "__fixtures__" / "job_mixed.json"
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps(trace, ensure_ascii=False, indent=1), encoding="utf-8")
print(f"wrote {out}")
