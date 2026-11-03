"""Claude API クライアントの生成。

APIキーはリポジトリ直下の .env（Git管理外）またはバックエンドの環境変数から読む。
キーの値はログ・画面・ブラウザへ出さない（.claude/rules/ai-extraction.md）。
"""
from __future__ import annotations

import os
from pathlib import Path

import anthropic

MODEL = "claude-opus-5-5"
ENV_FILE = Path(__file__).resolve().parents[2] / ".env"


def load_env(path: Path = ENV_FILE) -> None:
    """.env の KEY=VALUE を環境変数へ読み込む。既に設定済みの環境変数は上書きしない。"""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip().strip('"').strip("'")
        if key and value and key not in os.environ:
            os.environ[key] = value


def make_client() -> anthropic.Anthropic:
    load_env()
    return anthropic.Anthropic()
