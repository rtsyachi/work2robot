"""1本の録音を台詞ごと（E1〜E6）のファイルに切り分ける（動画制作用。課金なし）。

    .venv\\Scripts\\python tools\\demo_video\\split_voice.py <録音ファイル>

録音をローカルのWhisperで文字起こしし、発話の区間を台本（script_v2.json）の順に対応づけて
local_media/voice/E1.wav … に書き出す。台詞ごとの実際の文言は local_media/voice/lines.json に残す。
"""
import difflib
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(ROOT / "app"))

import imageio_ffmpeg  # noqa: E402

from backend.ai.transcription import transcribe_video  # noqa: E402

PAD = 0.25  # 発話の前後に残す余白（秒）


def align(segs: list[dict], lines: list[dict]) -> list[list[dict]]:
    """発話の列を、順序を保ったまま台詞の数のまとまりに分ける（文言の近さが最大になる分け方）。"""
    n, m = len(segs), len(lines)
    if n < m:
        raise SystemExit(f"発話が{n}個しか見つからず、台詞{m}個に足りません")
    sim = lambda a, b: difflib.SequenceMatcher(None, a, b).ratio()  # noqa: E731
    best = {(0, 0): (0.0, [])}
    for j in range(1, m + 1):
        for i in range(j, n - (m - j) + 1):
            cands = []
            for k in range(j - 1, i):
                if (k, j - 1) in best:
                    score, cut = best[(k, j - 1)]
                    text = "".join(s["text"] for s in segs[k:i])
                    cands.append((score + sim(text, lines[j - 1]["text"]), cut + [(k, i)]))
            if cands:
                best[(i, j)] = max(cands, key=lambda c: c[0])
    _, cut = best[(n, m)]
    return [segs[a:b] for a, b in cut]


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    src = Path(sys.argv[1])
    lines = json.loads((HERE / "script_v2.json").read_text(encoding="utf-8"))["lines"]
    tr = transcribe_video(src)
    groups = align(tr["segments"], lines)
    out = ROOT / "local_media" / "voice"
    out.mkdir(parents=True, exist_ok=True)
    result = []
    for line, g in zip(lines, groups):
        start, end = max(0.0, g[0]["start"] - PAD), g[-1]["end"] + PAD
        f = out / f"{line['id']}.wav"
        subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), "-y", "-loglevel", "error", "-i", str(src),
                        "-ss", f"{start:.2f}", "-to", f"{end:.2f}", "-ac", "1", "-ar", "48000", str(f)], check=True)
        spoken = "".join(s["text"] for s in g)
        result.append({"id": line["id"], "spoken": spoken, "script": line["text"], "source_start": round(start, 2),
                       "duration": round(end - start, 2)})
        print(f"{line['id']} {end - start:4.1f}s  {spoken}")
    (out / "lines.json").write_text(json.dumps({"source": src.name, "lines": result}, ensure_ascii=False, indent=2),
                                    encoding="utf-8")
    print("voice=" + ",".join(f"{r['id']}:{r['duration'] - 2 * PAD:.1f}" for r in result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
