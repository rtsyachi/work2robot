"""入力動画からClaudeで観測テキストを作り、保存する（課金あり）。

    .venv\\Scripts\\python scripts\\run_observation.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.ai.client import make_client  # noqa: E402
from backend.ai.observation import ObservationError, observe_video, save_observation  # noqa: E402


def main() -> int:
    try:
        obs = observe_video(make_client())
    except ObservationError as e:
        print(f"NG: {e}")
        return 1
    path = save_observation(obs)
    print(f"保存: {path}")
    print(f"フレーム {obs['frames']}枚・モデル {obs['meta']['model']}・使用量 {obs['meta']['usage']}")
    for s in obs["segments"]:
        print(f"  {s['id']} {s['t']} {s['text']}")
    if obs["uncertain"]:
        print("判断できなかったこと:")
        for u in obs["uncertain"]:
            print(f"  - {u}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
