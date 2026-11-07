"""提出動画の発表ナレーションを AivisSpeech で作り、場面の時刻に並べる。

  前提：AivisSpeech Engine（http://127.0.0.1:10101）が起動し、音声モデル Lux がインストール済み
  実行：.venv/Scripts/python -X utf8 tools/demo_video/narration_aivis.py
  出力：materials/demo/narration/narration_01.wav〜10.wav・narration_full.wav・narration_preview.mp3・subtitles.json
        materials/demo/narration_timing.csv
文は1文ずつ合成して長さを測り、場面の中に並べる（場面の終わり−0.3秒を超えたらエラー）。
表示・字幕用の文（disp）と読み上げ用の文（speak）は分けて持つ。
"""
from __future__ import annotations

import csv
import io
import json
import subprocess
import sys
import wave
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from aivis_tts import synth, wav_duration  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
FFMPEG = REPO / "tools/demo_video/node_modules/ffmpeg-static/ffmpeg.exe"
OUT = REPO / "materials/demo"
NDIR = OUT / "narration"
RATE = 48000
TOTAL = 169.0
VOICE = dict(name="Lux", model_uuid="3dabea2b-cc10-41da-955b-4618ce84e716", style="ノーマル", style_id=2031733024, license="ACML 1.0")
SPEED = 1.05          # 全編で同じ話速
GAP = 0.35            # 文と文の間（秒）

# 場面の時刻（build_demo.py の SCENES と同じ）
# 2026-11-07：導入（S01）を15秒→7秒に短縮し、以降を8秒前倒し（全体169秒）
SCENE_TIMES = {"S01": (0, 7), "S02": (7, 29), "S03": (29, 47), "S04": (47, 61), "S05": (61, 85),
               "S06": (85, 104), "S07": (104, 132), "S08": (132, 144), "S09": (144, 164), "S10": (164, 169)}
# S07 は後半約10秒をロボットの動きだけにする（場面の頭から18.5秒までに話し終える）。
# S01 は7秒と短いので、次の場面の頭の0.15秒前までに話し終えればよい（S02 のナレーションは 0.3秒後から）
LIMIT = {"S07": 18.5, "S01": 6.85}

# ベース原稿（依頼時の原稿。長さの計測用）
BASE = {
    "S01": "人手不足が深刻化する物流現場では、ロボットによる作業の自動化に期待が高まっています。",
    "S02": "実際の積付作業の様子を見ていきます。人間は、荷物の特徴などから多くの判断をして、複数の小さなタスクを組み合わせて、積付を行っています。重い箱は下段に置いて、重心を低くする。荷崩れを防ぐために向きを変えてレンガ積みにする。柔らかいバッグは最後に積む。現場では、荷物の特性や環境に応じて判断をしながら作業しているのです。",
    "S03": "では、この仕事をロボットに任せられるのでしょうか。実際どのような業務要件があり、ロボットはそれを満たせるのか。実際のロボットが動いたら人間と比べてどんな違いが生じるのか。導入前にそれらを具体化し、検証するのは簡単ではありません。",
    "S04": "そこで開発したのが、Work2Robotというツールです。商品マスタや出荷実績などの一般的なデータに加えて、現場の作業動画さえあれば、検証が可能です。",
    "S05": "Claudeが作業の流れや判断条件を読み取り、業務全体から個々の作業まで、ワークフローとして構造化します。判断の根拠は、元の動画や説明にさかのぼって確認できます。さらに、曖昧な業務条件を確認事項として洗い出し、確認結果を反映できます。",
    "S06": "次に、可搬重量やリーチ、把持方式などの必要能力を整理し、仮想カタログからロボット構成を提案します。今回は、作業経路に段差があることを考慮して、二足歩行型のHM-2を仮選定しました。",
    "S07": "選んだ構成で、業務を仮想実行します。ワークフローに従って荷物ごとの配置を判断し、カゴ車へ積み付けていきます。これは固定のロボット動画ではなく、実行エンジンの結果に連動した動作プレビューです。",
    "S08": "軽量なHM-1に変更すると、可搬重量とリーチが不足します。対応できない作業は実行せず、その理由を表示します。",
    "S09": "最後に、シミュレーションの実行結果から、自動化可能な範囲と検討すべき課題を整理します。業務ルールの未確定事項や、把持性能・安全性など、実機PoCで確認すべき点も明確になります。ロボット導入へのもう一歩を踏み出しやすくなるのです。",
    "S10": "人の仕事を、ロボットの仕事へ。Work2Robot。",
}

# 読み上げ用に置き換える語（表示用の文 → 読み上げ用の文）
READING = [("Work2Robot", "ワークトゥーロボット"), ("Claude", "クロード"), ("HM-1", "エイチエム・ワン"), ("HM-2", "エイチエム・ツー"),
           ("PoC", "ピーオーシー"), ("可搬重量", "かはん重量"), ("把持", "はじ"), ("レンガ積み", "レンガづみ"),
           ("消し込め", "けしこめ"), ("仮選定", "かりせんてい")]


def speak_text(disp: str) -> str:
    s = disp
    for a, b in READING:
        s = s.replace(a, b)
    return s


# 最終原稿：場面ごとの文。at＝場面の頭からの開始秒（指定なしは前の文の後に GAP をあけて続ける）
FINAL = {
    "S01": [dict(disp="人手不足が深刻化する物流現場では、ロボットによる作業の自動化に期待が高まっています。", at=0.2)],
    # S02 の映像（build_demo.py）：0〜4.4 早送り2×（作業全体）／4.4〜10.4 重い箱を下段に（等速）／10.4〜16.0 レンガ積み（等速）／16.0〜22.0 柔らかいバッグを最後に（等速）
    "S02": [dict(disp="実際の作業を見ていきましょう。", at=0.2),
            dict(disp="現場では、人が荷物ごとに判断しながら積んでいます。"),
            dict(disp="重い箱は下に置いて、重心を低くします。", at=6.9),
            dict(disp="同じ大きさの箱は、向きを変えて、レンガ積みにします。", at=10.7),
            dict(disp="柔らかいバッグは、最後に一番上に置きます。", at=16.4)],
    "S03": [dict(disp="では、この仕事をロボットに任せられるのでしょうか。", at=0.6),
            dict(disp="どんな業務要件があり、ロボットはそれを満たせるのか。"),
            dict(disp="人とはどう違う動きになるのか。"),
            dict(disp="導入前にそれを具体的に確かめるのは、簡単ではありません。")],
    "S04": [dict(disp="そこで開発したのが、Work2Robotです。", at=0.5),
            dict(disp="商品マスタや出荷実績などの一般的なデータに加えて、現場の作業動画があれば、検証を始められます。")],
    "S05": [dict(disp="まず、Claudeが、作業の流れや判断条件を読み取り、業務全体から個々の作業まで、ワークフローとして構造化します。", at=0.5),
            dict(disp="判断の根拠は、元の動画や説明にさかのぼって確認できます。"),
            dict(disp="曖昧な条件は確認事項として洗い出し、確認できたものは消し込めます。")],
    "S06": [dict(disp="次に、取り扱う重量や作業環境などから必要な能力を整理し、カタログからロボット構成を提案します。", at=0.5),
            dict(disp="今回は作業エリアの段差を考慮して、二足歩行のHM-2を仮選定しました。")],
    "S07": [dict(disp="選んだロボット構成で、業務シミュレーションを実行します。", at=0.4),
            dict(disp="Claudeが生成したワークフローに従って、荷物ごとの置き場所を判断し、カゴ車へ積み付けていきます。"),
            dict(disp="このように、人間の作業から抽出した業務ルールを、ロボットの動きとして可視化できます。")],
    "S08": [dict(disp="軽いHM-1に替えると、可搬重量とリーチが足りません。", at=0.4),
            dict(disp="要件を満たさない構成は実行せず、その理由を示します。")],
    "S09": [dict(disp="最後に、シミュレーション実行で対応できた範囲と、残る課題を整理します。", at=0.5),
            dict(disp="未確定の業務ルールや、把持性能・安全性など、実機PoCで確かめるべき点も明確になり、導入への一歩を踏み出しやすくなります。")],
    "S10": [dict(disp="人の仕事を、ロボットの仕事へ。", at=0.3),
            dict(disp="Work2Robot。")],
}


def to_array(data: bytes) -> np.ndarray:
    with wave.open(io.BytesIO(data)) as w:
        assert w.getframerate() == RATE and w.getsampwidth() == 2 and w.getnchannels() == 1
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32)


def write_wav(path: Path, arr: np.ndarray):
    a = np.clip(arr, -32768, 32767).astype(np.int16)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(a.tobytes())


def chunks(text, limit=30):
    parts, buf = [], ""
    for piece in text.replace("。", "。|").replace("、", "、|").split("|"):
        if not piece:
            continue
        if buf and len(buf) + len(piece) > limit:
            parts.append(buf)
            buf = piece
        else:
            buf += piece
    if buf:
        parts.append(buf)
    return parts


# テイクの選び方：同じ文を TAKES 回合成し（合成は毎回少し違う）、ローカルの文字起こし（faster-whisper medium）で
# 原稿に最も近いものを使う。同音の表記ゆれ（可搬／過半、把持／端、積み／済み など）は同じとみなす。
TAKES = 4
SAME = [("可搬", "カハン"), ("過半", "カハン"), ("下半", "カハン"), ("把持", "ハジ"), ("端", "ハジ"), ("恥", "ハジ"),
        ("積み", "ツミ"), ("済み", "ツミ"), ("カゴ社", "カゴ車"), ("二足", "ニソク"), ("2足", "ニソク"), ("マスター", "マスタ"),
        ("Claude", "クロード"), ("HM-2", "HM2"), ("HM-1", "HM1"), ("PoC", "POC"), ("Work2Robot", "ワークトゥーロボット"),
        ("Work to robot", "ワークトゥーロボット"), ("替え", "変え"), ("遡", "さかのぼ")]
_model = None


def norm(s: str) -> str:
    for a, b in SAME:
        s = s.replace(a, b)
    return "".join(ch for ch in s if ch not in "、。・,.?？!！ 　")


def best_take(disp: str, sid: int):
    global _model
    import difflib
    import tempfile
    if _model is None:
        sys.path.insert(0, str(REPO / "app"))
        from faster_whisper import WhisperModel
        _model = WhisperModel("medium", device="cpu", compute_type="int8")
    from backend.ai.transcription import _decode_audio
    best = None
    for k in range(TAKES * 2):
        if k >= TAKES and best[2] >= 0.95:   # 4テイクで一致度0.95以上ならそこで終える。足りなければ最大4テイク追加
            break
        data = synth(speak_text(disp), sid, speed=SPEED)
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            f.write(data)
            tmp = Path(f.name)
        segs, _ = _model.transcribe(_decode_audio(tmp), language="ja")
        tmp.unlink()
        heard = "".join(s.text for s in segs)
        score = difflib.SequenceMatcher(None, norm(disp), norm(heard)).ratio()
        if best is None or score > best[2]:
            best = (data, heard, score)
        if score >= 0.999:
            break
    return best


def main():
    NDIR.mkdir(parents=True, exist_ok=True)
    sid = VOICE["style_id"]
    # 1) ベース原稿の長さ（話速1.0）
    base_len = {k: wav_duration(synth(speak_text(v), sid, speed=1.0)) for k, v in BASE.items()}
    # 2) 最終原稿を1文ずつ合成して並べる
    timeline = np.zeros(int(TOTAL * RATE), dtype=np.float32)
    rows, subs, problems = [], [], []
    for scene, sentences in FINAL.items():
        s0, s1 = SCENE_TIMES[scene]
        limit = s0 + LIMIT.get(scene, s1 - s0 - 0.3)
        t = None
        first = last = None
        for sen in sentences:
            data, heard, score = best_take(sen["disp"], sid)
            sen.update(heard=heard, score=round(score, 3))
            print(f"  {scene} {score:.2f} {sen['disp'][:24]} → {heard[:30]}", flush=True)
            arr = to_array(data)
            d = len(arr) / RATE
            start = s0 + sen["at"] if "at" in sen else t + GAP
            if t is not None and start < t:
                problems.append(f"{scene}: 「{sen['disp'][:12]}…」が前の文と重なる（{start:.2f} < {t:.2f}）")
            i = int(round(start * RATE))
            timeline[i:i + len(arr)] += arr
            t = start + d
            first = start if first is None else first
            last = t
            sen.update(start=start, end=t, dur=d, speak=speak_text(sen["disp"]))
            cs = chunks(sen["disp"])
            tot = sum(len(c) for c in cs)
            tt = start
            for c in cs:
                cd = d * len(c) / tot
                subs.append(dict(start=round(tt, 3), end=round(tt + cd, 3), text=c, scene=scene))
                tt += cd
        if last > limit + 1e-6:
            problems.append(f"{scene}: {last:.2f}秒で終わり、上限 {limit:.2f}秒を {last - limit:.2f}秒超える")
        rows.append(dict(scene=scene, start=s0, end=s1, vo_start=first, vo_end=last, limit=limit,
                         base=base_len[scene], final=last - first, margin=limit - last))
    raw = NDIR / "_raw_full.wav"
    write_wav(raw, timeline)
    # 3) 音量をそろえる（話し声のラウドネス −16 LUFS、ピーク −1.5 dBTP）
    full = NDIR / "narration_full.wav"
    subprocess.run([str(FFMPEG), "-hide_banner", "-loglevel", "error", "-y", "-i", str(raw), "-af",
                    "loudnorm=I=-16:TP=-1.5:LRA=7", "-ar", str(RATE), "-ac", "1", "-c:a", "pcm_s16le", str(full)], check=True)
    raw.unlink()
    subprocess.run([str(FFMPEG), "-hide_banner", "-loglevel", "error", "-y", "-i", str(full), "-c:a", "libmp3lame", "-b:a", "192k",
                    str(NDIR / "narration_preview.mp3")], check=True)
    # 場面ごとの音声＝通し音声を場面の区間で切り出したもの（音量は通しと同じ）
    with wave.open(str(full)) as w:
        allf = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32)
    for k, (scene, (s0, s1)) in enumerate(SCENE_TIMES.items(), 1):
        write_wav(NDIR / f"narration_{k:02d}.wav", allf[int(s0 * RATE):int(s1 * RATE)])
    (NDIR / "subtitles.json").write_text(json.dumps(dict(voice=VOICE, speed=SPEED, subtitles=subs,
                                                        sentences={k: v for k, v in FINAL.items()}), ensure_ascii=False, indent=1), encoding="utf-8")
    with (OUT / "narration_timing.csv").open("w", encoding="utf-8-sig", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["scene_id", "scene_start", "scene_end", "vo_start", "vo_end", "vo_latest_end", "base_script_sec(speed1.0)", "final_sec", "speed", "margin_sec", "file"])
        for k, r in enumerate(rows, 1):
            w.writerow([r["scene"], f"{r['start']:.2f}", f"{r['end']:.2f}", f"{r['vo_start']:.2f}", f"{r['vo_end']:.2f}", f"{r['limit']:.2f}",
                        f"{r['base']:.2f}", f"{r['final']:.2f}", SPEED, f"{r['margin']:.2f}", f"narration/narration_{k:02d}.wav"])
    for r in rows:
        print(f"{r['scene']} base {r['base']:5.2f}s  final {r['final']:5.2f}s  {r['vo_start']:6.2f}–{r['vo_end']:6.2f}  margin {r['margin']:+.2f}")
    for p in problems:
        print("NG:", p)
    if problems:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
