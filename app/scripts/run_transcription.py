"""入力動画の音声をローカルのWhisperで文字起こしし、保存する（課金なし。初回はモデルをダウンロード）。

    .venv\\Scripts\\python app\\scripts\\run_transcription.py [動画のパス] [--model medium]
既定の動画：local_media/demo_input_v2/work_video_v2.mp4
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend.ai.transcription import TranscriptionError, save_transcript, transcribe_video  # noqa: E402


def main() -> int:
    args = sys.argv[1:]
    model = "medium"
    if "--model" in args:
        i = args.index("--model")
        model = args[i + 1]
        del args[i:i + 2]
    video = Path(args[0]) if args else ROOT.parent / "local_media" / "demo_input_v2" / "work_video_v2.mp4"
    mix = video.parent / "voice_mix.json"
    voice_note = None
    if mix.exists():
        voice_note = json.loads(mix.read_text(encoding="utf-8")).get("note")
    try:
        tr = transcribe_video(video, model_size=model, voice_note=voice_note)
    except TranscriptionError as e:
        print(f"NG: {e}")
        return 1
    path = save_transcript(tr)
    print(f"保存: {path}")
    if voice_note:
        print(f"音声: {voice_note}")
    for s in tr["segments"]:
        print(f"  {s['id']} {s['t']} ({s['start']:.1f}–{s['end']:.1f}s) {s['text']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
