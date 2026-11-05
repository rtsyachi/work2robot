"""Claude API に接続できるかを最小のリクエストで確認する（少額の課金が発生する）。

    .venv\\Scripts\\python app\\scripts\\check_claude_api.py
"""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import anthropic  # noqa: E402

from backend.ai.client import ENV_FILE, MODEL, load_env, make_client  # noqa: E402


def main() -> int:
    load_env()
    key = os.environ.get("ANTHROPIC_API_KEY", "")
    print(f".env: {'あり' if ENV_FILE.exists() else 'なし'}")
    print(f"ANTHROPIC_API_KEY: {'設定あり' if key else '未設定'}")  # 値は表示しない
    if not key:
        return 1

    client = make_client()
    try:
        response = client.messages.create(
            model=MODEL,
            max_tokens=1024,
            output_config={"effort": "low"},
            messages=[{"role": "user", "content": "接続テストです。「接続OK」とだけ返してください。"}],
        )
    except anthropic.AuthenticationError:
        print("NG: APIキーが無効です（401）")
        return 1
    except anthropic.PermissionDeniedError:
        print("NG: このキーにはモデルの利用権限がありません（403）")
        return 1
    except anthropic.NotFoundError:
        print(f"NG: モデル {MODEL} が見つかりません（404）")
        return 1
    except anthropic.RateLimitError:
        print("NG: レート制限・利用上限に達しています（429）")
        return 1
    except anthropic.APIStatusError as e:
        print(f"NG: APIエラー {e.status_code}: {e.message}")
        return 1
    except anthropic.APIConnectionError:
        print("NG: ネットワークに接続できません")
        return 1

    text = "".join(b.text for b in response.content if b.type == "text")
    print(f"モデル: {response.model}")
    print(f"stop_reason: {response.stop_reason}")
    print(f"応答: {text}")
    print(f"トークン: 入力 {response.usage.input_tokens} / 出力 {response.usage.output_tokens}")
    ok = response.stop_reason == "end_turn" and bool(text)
    print("OK: Claude API を利用できます" if ok else "要確認: 応答が想定と異なります")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
