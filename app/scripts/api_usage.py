"""保存済みの観測・抽出の記録から、Claude APIの使用量と概算の料金を集計する（課金なし）。

    .venv\\Scripts\\python app\\scripts\\api_usage.py

記録に残る呼び出し（local_media/observations・extractions）だけを数える。接続確認や保存しなかった呼び出しは含まない。
クレジットの正確な残高は Anthropic Console の Billing で確認する。
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PRICE_IN, PRICE_OUT = 4.0, 20.0  # claude-opus-5-5、100万トークンあたりのドル


def usages(record: dict) -> list[dict]:
    u = record.get("meta", {}).get("usage")
    return u if isinstance(u, list) else [u] if isinstance(u, dict) else []


def main() -> None:
    total_in = total_out = 0
    for kind in ("observations", "extractions", "hardware_selections", "task_structures"):
        for f in sorted((ROOT.parent / "local_media" / kind).glob("*.json")):
            rec = json.loads(f.read_text(encoding="utf-8"))
            i = sum(u.get("input_tokens", 0) for u in usages(rec))
            o = sum(u.get("output_tokens", 0) for u in usages(rec))
            total_in += i
            total_out += o
            cost = i / 1e6 * PRICE_IN + o / 1e6 * PRICE_OUT
            print(f"{kind[:-1]:12s} {f.name:40s} 入力 {i:>8,} 出力 {o:>7,}  約${cost:.2f}")
    cost = total_in / 1e6 * PRICE_IN + total_out / 1e6 * PRICE_OUT
    print(f"合計  入力 {total_in:,}  出力 {total_out:,}  約${cost:.2f}（記録に残る呼び出しのみ）")


if __name__ == "__main__":
    main()
