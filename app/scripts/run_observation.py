"""入力動画からClaudeで観測テキストを作り、保存する（課金あり）。

    .venv\\Scripts\\python app\\scripts\\run_observation.py         # v1（data/demo_input/work_video.mp4）
    .venv\\Scripts\\python app\\scripts\\run_observation.py --v2    # 入力の作業動画（backend/inputs.py の INPUT_VIDEO、60枚ずつ分割）
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend.ai.client import make_client  # noqa: E402
from backend.ai.observation import ObservationError, observe_video, save_observation  # noqa: E402
from backend.inputs import INPUT_VIDEO as V2_VIDEO  # noqa: E402  入力の作業動画（backend/inputs.py）


def main() -> int:
    try:
        if "--v2" in sys.argv:
            obs = observe_video(make_client(), V2_VIDEO, width=1024, chunk=60)
        else:
            obs = observe_video(make_client())
    except ObservationError as e:
        print(f"NG: {e}")
        return 1
    path = save_observation(obs)
    print(f"保存: {path}")
    print(f"フレーム {obs['frames']}枚（{obs['chunks']}回に分割）・モデル {obs['meta']['model']}・使用量 {obs['meta']['usage']}")
    for s in obs["segments"]:
        print(f"  {s['id']} {s['t']} {s['text']}")
    if obs["uncertain"]:
        print("判断できなかったこと:")
        for u in obs["uncertain"]:
            print(f"  - {u}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
