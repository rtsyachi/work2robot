"""保存したロボット構成（Step 4 で名前を付けて保存し、Step 5 で選んで使う）。

構成＝機種と、その機種が認めるオプション（手先・センサー・周辺設備）。local_media/robot_configs/ に1構成1ファイルで保存する。
Claudeの仮選定（今の動画のワークフローから作ったもの）は、保存しなくても一覧の先頭に「Claudeの仮選定」として出す（削除できない）。
"""
from __future__ import annotations

import json
import re
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONFIG_DIR = ROOT.parent / "local_media" / "robot_configs"
KEYS = ("product_id", "end_effector", "sensors", "peripherals")


class RobotConfigError(Exception):
    pass


def _clean(config: dict) -> dict:
    missing = [k for k in KEYS if k not in config]
    if missing:
        raise RobotConfigError(f"構成に {', '.join(missing)} がありません")
    return {"product_id": str(config["product_id"]), "end_effector": str(config["end_effector"]),
            "sensors": [str(x) for x in config["sensors"]], "peripherals": [str(x) for x in config["peripherals"]]}


def list_configs(selection: dict | None, hw_catalog: dict) -> list[dict]:
    """一覧（Claudeの仮選定 → 保存した構成の新しい順）。Claudeの仮選定は保存ファイル名（hardware_日時）をIDにする
    （仮選定をやり直すと別のIDになる）。basis＝選定時のワークフローの版・出荷予定（照合の件数は保存した構成だけ）。"""
    out = []
    sel_cfg = (selection or {}).get("config") or {}
    if sel_cfg.get("product_id") and sel_cfg.get("end_effector"):
        name = next((p["name"] for p in hw_catalog.get("products", []) if p["id"] == sel_cfg["product_id"]), sel_cfg["product_id"])
        sid = Path(selection.get("record_file") or "hardware_selection").stem
        out.append({"id": sid, "name": f"Claudeの仮選定（{name.split(' ')[0]}）", "source": "claude", "readonly": True,
                    "saved_at": selection.get("created_at"), "config": _clean(sel_cfg),
                    "basis": {"workflow_id": (selection.get("source") or {}).get("extraction"), "batch_id": "video_batch"}})
    if CONFIG_DIR.exists():
        for f in sorted(CONFIG_DIR.glob("*.json"), reverse=True):
            rec = json.loads(f.read_text(encoding="utf-8"))
            out.append({**rec, "id": f.stem, "source": "saved", "readonly": False})
    return out


def save_config(name: str, config: dict, hw_catalog: dict, basis: dict | None = None) -> dict:
    """名前を付けて保存する。機種がカタログにない・オプションが機種の認めるものでなければ保存しない。"""
    name = name.strip()
    if not name:
        raise RobotConfigError("構成の名前を入力してください")
    cfg = _clean(config)
    prod = next((p for p in hw_catalog.get("products", []) if p["id"] == cfg["product_id"]), None)
    if prod is None:
        raise RobotConfigError(f"カタログにない機種です：{cfg['product_id']}")
    opts = prod["options"]
    bad = ([cfg["end_effector"]] if cfg["end_effector"] not in opts["end_effector"] else []) \
        + [s for s in cfg["sensors"] if s not in opts["sensors"]] + [p for p in cfg["peripherals"] if p not in opts["peripherals"]]
    if bad:
        raise RobotConfigError(f"この機種では選べない部品があります：{', '.join(bad)}")
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    slug = re.sub(r"[^0-9A-Za-z_-]", "", name)[:20]
    path = CONFIG_DIR / f"robot_{stamp}{('_' + slug) if slug else ''}.json"
    i = 2
    while path.exists():
        path = path.with_name(f"{path.stem}_{i}.json")
        i += 1
    rec = {"name": name, "saved_at": datetime.now().astimezone().isoformat(timespec="seconds"), "config": cfg}
    if basis:
        rec["basis"] = basis  # 選定時のシナリオ・ワークフローの版・出荷予定と、その要件での照合の件数
    path.write_text(json.dumps(rec, ensure_ascii=False, indent=2), encoding="utf-8")
    return {**rec, "id": path.stem, "source": "saved", "readonly": False}


def delete_config(config_id: str) -> None:
    if config_id == "claude" or config_id.startswith("hardware_"):
        raise RobotConfigError("Claudeの仮選定は削除できません")
    path = CONFIG_DIR / f"{config_id}.json"
    if not re.fullmatch(r"[0-9A-Za-z_-]+", config_id) or not path.exists():
        raise RobotConfigError("構成が見つかりません")
    path.unlink()
