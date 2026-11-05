"""抽出済みの業務（v2）から、Claudeでロボットの能力要件と構成を仮選定し、仕様照合・業務実行まで行う（課金あり）。

    .venv\\Scripts\\python app\\scripts\\run_hardware_selection.py           # Claudeで仮選定（課金あり）
    .venv\\Scripts\\python app\\scripts\\run_hardware_selection.py --latest  # 保存済みの結果で照合・実行だけ
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend.ai.client import make_client  # noqa: E402
from backend.ai.hardware_selection import (  # noqa: E402
    HardwareSelectionError, latest_selection, save_selection, select_hardware,
)
from backend.workflow import masters  # noqa: E402
from backend.workflow.hardware import compute_requirements, resolve_product_config as resolve_config  # noqa: E402
from backend.workflow.job import run_job  # noqa: E402


def load(rel: str) -> dict:
    return json.loads((ROOT / rel).read_text(encoding="utf-8"))


def latest_v2_extraction() -> dict | None:
    for f in sorted((ROOT.parent / "local_media" / "extractions").glob("extraction_*.json"), reverse=True):
        rec = json.loads(f.read_text(encoding="utf-8"))
        if rec.get("meta", {}).get("scenario") == "v2":
            return rec | {"record_file": f.name}
    return None


def main() -> int:
    ext = latest_v2_extraction()
    if ext is None:
        print("v2の抽出結果がありません。先に scripts/run_extraction.py --v2 を実行してください")
        return 1
    hw = load("data/hardware_catalog.json")
    m = masters.load_masters()  # Step 0 で登録したマスタ（なければ初期値）
    objs = {o["object_id"]: o for o in masters.to_objects(m["items"])}
    batch = [objs[i] for i in next(b for b in m["items"]["batches"] if b["batch_id"] == "video_batch")["object_ids"]]
    ext["job"] = masters.apply_environment(ext["job"], m["environment"])
    reqs = compute_requirements(ext["job"], ext["workflow"], batch, hw)
    print(f"業務: {ext['record_file']}")
    if "--latest" in sys.argv:
        sel = latest_selection()
        if sel is None:
            print("保存済みの仮選定がありません")
            return 1
        print(f"保存済みの仮選定: {sel['record_file']}")
    else:
        try:
            sel = select_hardware(make_client(), ext, reqs, hw, ext["job"]["cart"])
        except HardwareSelectionError as e:
            print(f"NG: {e} {e.detail}")
            return 1
        print(f"保存: {save_selection(sel)}")
        print(f"モデル: {sel['meta']['model']}  試行回数: {sel['meta']['attempts']}  使用量: {sel['meta']['usage']}")
    c = sel["config"]
    print(f"要約: {sel['summary']}")
    print(f"構成: 機種 {c.get('product_id')}（{c['base']} / {c['arm']}）・手先 {c['end_effector']}・センサー {c['sensors']}・周辺設備 {c['peripherals']}")
    for r in sel["capability_requirements"]:
        refs = ",".join(e.get("ref") or e["type"] for e in r["source_evidence"])
        print(f"  能力 {r['capability']}：{r['reason']}（根拠 {refs}）")
    print("仕様照合:")
    for r in sel["check"]["results"]:
        print(f"  [{r['status']}] {r['label']}：{r['detail']}")
    for a in sel["alternatives"]:
        print(f"  候補外 {a['component']}：{a['reason']}")
    for u in sel["unverified_points"]:
        print(f"  未確認：{u}")
    for h in sel["improvement_hypotheses"]:
        print(f"  改善の仮説[{h['kind']}]：{h['text']}")
    catalog = load("data/skill_catalog.json")
    configs = [sel["config"]] + [x for x in load("data/scenario_v2/hardware_configs.json")["configs"]
                                 if x["config_id"] == "light_vacuum"]
    for cfg in configs:
        t = run_job(ext["job"], ext["workflow"], batch, catalog, robot=resolve_config(cfg, hw))
        print(f"[{cfg['config_id']}] 配置 {t['end']['placed']}・引継ぎ {t['end']['handed_off']}")
        for it in t["items"]:
            if it["outcome"] == "handed_off":
                print(f"    {it['object_id']}：{it['handoff_reason']}")
    return 0 if not sel["errors"] else 2


if __name__ == "__main__":
    sys.exit(main())
