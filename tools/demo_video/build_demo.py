"""提出動画（3分デモ・ナレーションなし版）の組み立て。

素材：
  - 入力動画 materials/input_video_v5.mp4（模擬作業動画＋作業者の説明音声）
  - アプリの実画面 local_media/demo_build/shots/*.png と 3D再生のコマ frames/*.png
    （app/frontend で `node scripts/demo_capture.mjs` を実行して撮る。Claude API は呼ばない）
  - 導入画像 materials/intro_title.png・ロゴ materials/work2robot.png
出力（materials/demo/）：
  - demo_no_voiceover.mp4      発表ナレーションなし・作業者の音声あり・作業者の発話字幕のみ
  - demo_guide_with_narration_subs.mp4  台本どおりのナレーション字幕を焼き込んだ確認用
  - narration_guide.srt         ナレーション字幕（台本・区間の目安）
  - scene_manifest.json / narration_cues.csv / youtube_thumbnail.png
実行： .venv/Scripts/python -X utf8 tools/demo_video/build_demo.py
台本（ナレーション・場面の時刻）は docs/DEMO.md と同じ内容をこのファイルの SCENES に持つ。
"""
from __future__ import annotations

import csv
import json
import math
import shutil
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
FFMPEG = REPO / "tools/demo_video/node_modules/ffmpeg-static/ffmpeg.exe"
BUILD = REPO / "local_media/demo_build"
SHOTS = BUILD / "shots"
FRAMES = BUILD / "frames"
SEGS = BUILD / "segs"
TXT = BUILD / "txt"
OUT = REPO / "materials/demo"
V5 = REPO / "materials/input_video_v5.mp4"
INTRO = REPO / "materials/intro_title.png"
LOGO = REPO / "materials/work2robot.png"
HUMAN_ROBOT = REPO / "materials/humanandrobot2.png"   # 文字の入っていない人・ロボットの比較画像
FONT_B = "C\\:/Windows/Fonts/YuGothB.ttc"
FONT_M = "C\\:/Windows/Fonts/YuGothM.ttc"
FPS = 30

# 画面の配置：アプリ画面・動画は 1696×954（16:9）で上に置き、下の帯（y=962〜1080）を字幕用に空ける
OX, OY, CW, CH = 112, 8, 1696, 954
S = CW / 1920
NAVY, TEAL, TEAL_D = "0x061F43", "0x00C6A0", "0x007F6D"


def M(x, y, w, h):
    """撮影画像（1920×1080）上の矩形 → 完成映像上の矩形"""
    return round(OX + x * S), round(OY + y * S), round(w * S), round(h * S)


def ts(sec):
    m, s = divmod(int(sec), 60)
    return f"{m}:{s:02d}"


# ---------------------------------------------------------------- 台本（docs/DEMO.md と同じ）
# 各場面：id・名前・ナレーション（None＝発表ナレーションなし）・ナレーション開始（場面の頭からの秒）・セグメント
SCENES = [
    dict(id="S01", name="導入", vo="労働力不足が深刻化する中、物流現場でも、デジタル化に加えて、ロボットによる物理的な作業の自動化に期待が高まっています。", vo_at=1.0, segs=[
        dict(kind="still", src="intro", dur=15.0, zoom=dict(cx=960, cy=540, z=1.06, t=15.0), notice="導入画像（イメージ）・アプリの入力ではありません"),
    ]),
    dict(id="S02", name="現場の作業動画", vo=None, segs=[
        dict(kind="video", start=8.8, end=15.3, speed=1, audio=True, label="元動画 0:08〜0:15　等速", chip="重い箱は下に、重心を低く"),
        dict(kind="video", start=15.3, end=36.5, speed=4, audio=False, label="早送り 4×　元動画 0:15〜0:36", ff=True),
        dict(kind="video", start=71.8, end=82.0, speed=1, audio=True, label="元動画 1:11〜1:22　等速", chip="同じサイズの箱はレンガ積み"),
    ]),
    dict(id="S03", name="問題提起", vo="こうした人の仕事を、ロボットに置き換えられるのでしょうか。必要な能力や業務要件は何か。どんな動きになるのか。導入前に具体的に検討することは、簡単ではありません。", vo_at=0.8, segs=[
        dict(kind="video", start=133.6, end=169.6, speed=2, audio=False, label="早送り 2×　元動画 2:13〜2:49", ff=True, chip="この判断を、ロボットに置き換えられるか？", chip_at=(9.0, 18.0)),
    ]),
    dict(id="S04", name="紹介・入力", vo="そこで開発したのが、Work2Robotです。商品マスタや出荷予定など、既存システムにあるデータに加えて、新たに用意するのは現場の作業動画だけです。", vo_at=0.6, segs=[
        dict(kind="logo", dur=2.5),
        dict(kind="still", src="s4_products", dur=4.0, card=["① データ確認", "商品マスタ", "（模擬データ）"], spot=[(612, 185, 870, 440, 0.3, 4.0)]),
        dict(kind="still", src="s4_plan", dur=2.5, card=["① データ確認", "出荷予定"]),
        dict(kind="still", src="s4_scenario", dur=5.0, card=["② シナリオ作成", "新たに用意するのは", "作業動画だけ"], spot=[(1025, 60, 885, 540, 0.5, 5.0)]),
    ]),
    dict(id="S05", name="業務理解", vo="Claudeが動画から作業を読み取り、業務の流れ、タスク、判断条件をワークフローとして構造化します。判断の根拠を動画で確かめられるだけでなく、定義が曖昧な条件など、現場に確認すべき事項も洗い出し、確認したら消し込めます。", vo_at=0.6, segs=[
        dict(kind="still", src="s5_overview", dur=4.0, card=["③ ワークフロー確認", "Claudeが動画から", "工程を構造化"], spot=[(340, 395, 1100, 385, 0.5, 4.0)]),
        dict(kind="still", src="s5_level1", dur=6.0, card=["判断条件を", "優先度順に"], spot=[(605, 297, 786, 243, 0.4, 6.0)]),
        dict(kind="still", src="s5_level2", dur=6.0, card=["荷物1個の判断", "S1（柔らかい）", "が通った分岐"], spot=[(660, 245, 712, 745, 0.4, 6.0)]),
        dict(kind="still", src="s5_evidence", dur=5.0, card=["根拠と", "現場への確認事項"], spot=[(1458, 455, 430, 400, 0.4, 5.0)]),
        dict(kind="still", src="s5_resolved", dur=3.0, card=["確認したら", "消込"], spot=[(1458, 715, 430, 140, 0.2, 3.0)]),
    ]),
    dict(id="S06", name="構成の仮選定", vo="次に、業務に必要な可搬重量やリーチ、把持方式などを整理し、仮想の製品カタログから構成を提案します。作業エリアに段差があるため、Claudeは車輪型ではなく、二足歩行のHM-2を推奨しました。", vo_at=0.5, segs=[
        dict(kind="still", src="s6_hm2", dur=7.0, card=["④ ロボット構成", "仮想カタログ", "（模擬の機種）"], spot=[(586, 229, 870, 225, 0.5, 3.8), (335, 560, 245, 92, 3.8, 7.0)]),
        dict(kind="still", src="s6_reqs", dur=12.0, card=["業務要件との照合", "対応不可 0"], zoom=dict(cx=1110, cy=400, z=1.22, t=2.5), spot_after_zoom=None),
    ]),
    dict(id="S07", name="仮想実行", vo="この構成で業務を仮想実行します。ワークフローに従い、荷物ごとに置き場所を判断して、カゴ車へ積み付けます。あらかじめ用意した動画ではなく、実行結果から動きを再生しています。", vo_at=0.4, segs=[
        dict(kind="still", src="s7_setup", dur=1.5, card=["⑤ シミュレーション実行"], spot=[(905, 88, 235, 44, 0.0, 1.5)], notice_kind="sim"),
        dict(kind="still", src="s7_running", dur=1.5, card=["⑤ シミュレーション実行"], notice_kind="sim"),
        dict(kind="frames", ranges=[(0, 331, "3D再生　等速"), (331, 268, "早送り 4×"), (692, 151, "早送り 4×　積み終わり")], card=["実行結果から", "動きを再生", "（仮想・模擬仕様）"]),
    ]),
    dict(id="S08", name="構成の比較", vo="軽いHM-1に替えると、可搬重量とリーチが足りません。業務要件を満たさない構成は、実行前に止めます。", vo_at=0.4, segs=[
        dict(kind="compare", dur=6.0),
        dict(kind="still", src="s8_hm1_blocked", dur=6.0, card=["要件を満たさない", "構成は実行しない"], spot=[(325, 165, 1572, 92, 0.3, 6.0)]),
    ]),
    dict(id="S09", name="シミュレーション評価", vo="最後に、達成状況と効果の見通し、残る課題を整理します。仮想実行ではわからない把持性能や安全性など、実機PoCで確かめるべき点も明確になります。", vo_at=0.5, segs=[
        dict(kind="still", src="s9_summary", dur=10.0, card=["⑥ シミュレーション評価", "サマリと", "主要KPI"], spot=[(315, 170, 1595, 165, 0.3, 5.2), (310, 345, 1600, 158, 5.2, 10.0)]),
        dict(kind="still", src="s9_issues", dur=10.0, card=["課題と", "実機PoCで", "確かめる点"], spot=[(330, 600, 1565, 470, 0.3, 10.0)]),
    ]),
    dict(id="S10", name="締め", vo="人の仕事を、ロボットの仕事へ。Work2Robot。", vo_at=0.4, segs=[
        dict(kind="grid", dur=5.0),
    ]),
]

# ナレーション版（--narrated）：入力動画の元の音声は使わず、AivisSpeech の発表ナレーション（narration_aivis.py）を全編に入れる。
# S02 は発表ナレーションの文に合わせて、判断の場面（重い箱・レンガ積み・柔らかいバッグ）を等速で並べ直す。
NARRATED = "--narrated" in sys.argv
NARRATED_S02 = [
    # 2026-11-07 改訂：冒頭の2文（「実際の作業を見ていきましょう」「現場では、人が…」）の間は2倍速で作業全体を見せる
    dict(kind="video", start=0.0, end=8.8, speed=2, audio=False, label="早送り 2×　元動画 0:00〜0:09", ff=True),
    dict(kind="video", start=9.0, end=15.0, speed=1, audio=False, label="元動画 0:09〜0:15　等速", chip="重い箱は下に、重心を低く"),
    dict(kind="video", start=72.0, end=77.6, speed=1, audio=False, label="元動画 1:12〜1:18　等速", chip="同じ大きさの箱はレンガ積み"),
    dict(kind="video", start=169.5, end=175.5, speed=1, audio=False, label="元動画 2:49〜2:55　等速", chip="柔らかいバッグは最後に一番上"),
]
NARRATION_DIR = REPO / "materials/demo/narration"
INTRO_SEC_NARRATED = 7.0   # 2026-11-07：導入を15秒→7秒に短縮（全体169秒。narration_aivis.py の SCENE_TIMES と同じ）

# 作業者の発話（v5 の文字起こし local_media/transcripts/transcript_20261106_112317.json より）
WORKER_SPEECH = [
    (9.2, 15.0, "重い箱はなるべく下に置いて、全体の重心が低くなるようにしています。"),
    (72.0, 78.6, "もし同じようなサイズの箱がたくさんあったら、|こんな風に向きを変えてレンガ積みにしています。"),
    (79.5, 81.8, "荷崩れをしにくいようにするためです。"),
]

NOTICE = {
    "app": "画面：Work2Robot の実際の操作画面（データは模擬・Claudeの結果は保存済みのもの）",
    "video": "模擬作業動画（CGアニメーション）・アプリの入力動画",
    "sim": "仮想実行の3D再生（模擬仕様に基づく。実機での動作は保証しません）",
}
CPS = 7.0   # ナレーションの読み上げ速度の目安（文字/秒）

# ---------------------------------------------------------------- ffmpeg 補助
_txt_n = 0


def text_file(s: str) -> str:
    global _txt_n
    _txt_n += 1
    p = TXT / f"{_txt_n:04d}.txt"
    p.write_text(s, encoding="utf-8")
    return f"txt/{p.name}"


def dt(text, x, y, size, color="white", font=FONT_B, enable=None, box=None):
    s = f"drawtext=fontfile='{font}':textfile='{text_file(text)}':fontsize={size}:fontcolor={color}:x={x}:y={y}"
    if box:
        s += f":box=1:boxcolor={box}:boxborderw=12"
    if enable:
        s += f":enable='{enable}'"
    return s


def rect(x, y, w, h, color, t="fill", enable=None):
    s = f"drawbox=x={x}:y={y}:w={w}:h={h}:color={color}:t={t}"
    if enable:
        s += f":enable='{enable}'"
    return s


def spotlight(x, y, w, h, t0, t1):
    X, Y, W, H = M(x, y, w, h)
    en = f"between(t,{t0},{t1})"
    dim = "black@0.42"
    out = [
        rect(OX, OY, CW, max(0, Y - OY), dim, enable=en),
        rect(OX, Y + H, CW, max(0, OY + CH - Y - H), dim, enable=en),
        rect(OX, Y, max(0, X - OX), H, dim, enable=en),
        rect(X + W, Y, max(0, OX + CW - X - W), H, dim, enable=en),
        rect(X - 4, Y - 4, W + 8, H + 8, TEAL, t="5", enable=en),
    ]
    return out


def card(lines, kind="side", enable=None):
    if not lines:
        return []
    if kind == "side":   # アプリ画面の左の工程メニューの下（空いている所）
        x, y, w = 124, 470, 242
        lh, fs = 36, 24
        h = 22 + lh * len(lines)
        out = [rect(x, y, w, h, f"{NAVY}@0.94", enable=enable), rect(x, y, 6, h, TEAL, enable=enable)]
        for i, ln in enumerate(lines):
            out.append(dt(ln, x + 18, y + 14 + i * lh, fs if i else fs + 2, "white" if i else "0x6FF0D2", enable=enable))
        return out
    # 動画の上：左下の帯
    x, y = OX + 36, OY + CH - 120
    return [dt(lines[0], x, y, 40, "white", enable=enable, box=f"{NAVY}@0.88")]


def run(args, cwd=BUILD):
    r = subprocess.run([str(FFMPEG), "-hide_banner", "-loglevel", "error", "-y", *args], cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0:
        print(r.stderr[-3000:])
        raise SystemExit(f"ffmpeg failed: {args[-1]}")


ENC = ["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-r", str(FPS),
       "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2"]


def render_segment(i, seg, out_path):
    """1セグメント → 1920×1080・30fps・ステレオ音声の mp4（長さはコマ数で正確に揃える）"""
    inputs, chain, post = [], [], []
    dur = seg.get("dur")
    kind = seg["kind"]
    notice = seg.get("notice") or NOTICE[seg.get("notice_kind", "video" if kind == "video" else "app")]
    audio_from_video = False
    if kind in ("still",):
        src = INTRO if seg["src"] == "intro" else SHOTS / f"{seg['src']}.png"
        inputs += ["-loop", "1", "-framerate", str(FPS), "-t", f"{dur}", "-i", str(src)]
        z = seg.get("zoom")
        if z:
            nz = int(z["t"] * FPS)
            ease = f"(1-cos(PI*min(on/{nz},1)))/2"
            zexp = f"1+({z['z']}-1)*{ease}"
            chain.append(f"[0:v]scale=3840:2160,zoompan=z='{zexp}':x='max(0,min(iw-iw/zoom,{z['cx'] * 2}-iw/zoom/2))':y='max(0,min(ih-ih/zoom,{z['cy'] * 2}-ih/zoom/2))':d=1:s={CW}x{CH}:fps={FPS}[c]")
        else:
            chain.append(f"[0:v]scale={CW}:{CH}:flags=lanczos[c]")
    elif kind == "logo":
        inputs += ["-f", "lavfi", "-t", f"{dur}", "-i", f"color=c=white:s={CW}x{CH}:r={FPS}", "-loop", "1", "-framerate", str(FPS), "-t", f"{dur}", "-i", str(LOGO)]
        chain.append("[1:v]scale=1150:-1[lg]")
        chain.append("[0:v][lg]overlay=x=(W-w)/2:y=(H-h)/2-30[c0]")
        chain.append("[c0]" + dt("Built with Claude: Japan 2026", "(w-text_w)/2", 700, 36, "0x64748B", FONT_M) + "[c]")
        notice = "Work2Robot"
    elif kind == "video":
        dur = (seg["end"] - seg["start"]) / seg["speed"]
        inputs += ["-ss", f"{seg['start']}", "-t", f"{seg['end'] - seg['start']}", "-i", str(V5)]
        chain.append(f"[0:v]setpts=PTS/{seg['speed']},fps={FPS},scale={CW}:{CH}[c]")
        audio_from_video = seg["audio"]
        post.append(dt(seg["label"], OX + CW - 36 - 14 * 26, OY + 70, 28, "white", box=(f"{TEAL_D}@0.92" if not seg.get("ff") else "0xC2410C@0.92")))
        if seg.get("chip"):
            a, b = seg.get("chip_at", (0.4, dur))
            post += card([seg["chip"]], kind="video", enable=f"between(t,{a},{b})")
    elif kind == "frames":
        sel = BUILD / "sel"
        if sel.exists():
            shutil.rmtree(sel)
        sel.mkdir()
        n = 0
        labels = []
        for start, count, label in seg["ranges"]:
            labels.append((n, n + count, label))
            for k in range(start, start + count):
                shutil.copyfile(FRAMES / f"s7_{k:05d}.png", sel / f"{n:05d}.png")
                n += 1
        dur = n / FPS
        seg["dur"] = dur
        seg["_labels"] = [(a / FPS, b / FPS, lb) for a, b, lb in labels]
        inputs += ["-framerate", str(FPS), "-i", str(sel / "%05d.png")]
        chain.append(f"[0:v]scale={CW}:{CH}:flags=lanczos[c]")
        for a, b, lb in seg["_labels"]:
            ff = lb.startswith("早送り")
            post.append(dt(lb, OX + CW - 400, OY + 300, 30, "white", box=("0xC2410C@0.92" if ff else f"{TEAL_D}@0.92"), enable=f"between(t,{a:.3f},{b:.3f})"))
        notice = NOTICE["sim"]
    elif kind == "compare":
        a_, b_ = SHOTS / "s6_reqs.png", SHOTS / "s8_hm1_reqs.png"
        inputs += ["-loop", "1", "-framerate", str(FPS), "-t", f"{dur}", "-i", str(a_), "-loop", "1", "-framerate", str(FPS), "-t", f"{dur}", "-i", str(b_)]
        chain.append("[0:v]crop=1600:470:310:155[a]")
        chain.append("[1:v]crop=1600:470:310:155[b]")
        chain.append(f"[a][b]vstack=inputs=2,pad={CW}:{CH}:48:7:color=0xF5F7FA[c]")
        post.append(rect(OX + 48, OY + 7 + 470, 1600, 3, NAVY))
        post.append(dt("Before：HM-2（Claudeの推奨）", OX + CW - 560, OY + 22, 30, "white", box=f"{TEAL_D}@0.95"))
        post.append(dt("After：HM-1（軽量）に替えると", OX + CW - 560, OY + 7 + 470 + 15, 30, "white", box="0xC92A2A@0.95"))
        # After 側の「1 対応不可 6 判断不可 4 対応可能」を枠で示す（切り出し画像上 x130〜500・y10〜55 → 完成映像の座標）
        post.append(rect(OX + 48 + 126, OY + 7 + 470 + 6, 380, 54, TEAL, t="5", enable="between(t,1.0,6.0)"))
    elif kind == "grid":
        v5f = BUILD / "v5_75s.png"
        run(["-ss", "75", "-i", str(V5), "-frames:v", "1", str(v5f)])
        srcs = [v5f, SHOTS / "s5_level1.png", FRAMES / "s7_00250.png", SHOTS / "s9_summary.png"]
        for s_ in srcs:
            inputs += ["-loop", "1", "-framerate", str(FPS), "-t", f"{dur}", "-i", str(s_)]
        inputs += ["-loop", "1", "-framerate", str(FPS), "-t", f"{dur}", "-i", str(LOGO)]
        for k in range(4):
            chain.append(f"[{k}:v]scale=840:472[g{k}]")
        chain.append(f"[g0][g1][g2][g3]xstack=inputs=4:layout=0_0|840_0|0_472|840_472,pad={CW}:{CH}:8:5:color={NAVY}[gr]")
        chain.append(f"[gr]drawbox=x=348:y=297:w=1000:h=360:color=white@0.97:t=fill[gb]")
        chain.append("[4:v]scale=820:-1[lg]")
        chain.append("[gb][lg]overlay=x=(W-w)/2:y=315[c0]")
        chain.append("[c0]" + dt("人の仕事を、ロボットの仕事へ。", "(w-text_w)/2", 590, 44, NAVY) + "[c]")
        labels = ["作業動画", "ワークフロー", "仮想ロボット", "シミュレーション評価"]
        pos = [(0, 0), (840, 0), (0, 472 + 400), (840, 472 + 400)]   # 下の2枚は左下に置き、中央のロゴと重ねない
        for lb, (px, py) in zip(labels, pos):
            post.append(dt(lb, OX + 8 + px + 16, OY + 5 + py + 14, 26, "white", box=f"{NAVY}@0.9"))
        notice = "Work2Robot"
    else:
        raise ValueError(kind)

    nframes = round(dur * FPS)
    seg["dur"] = nframes / FPS
    # 共通：紺の地に配置 → 注目枠 → 説明カード → 帯の注記
    base = [f"[c]pad=1920:1080:{OX}:{OY}:color={NAVY}"]
    for sp in seg.get("spot", []):
        base += spotlight(*sp)
    base += post
    base += card(seg.get("card"), kind="side", enable=None)
    base.append(dt(notice, f"w-text_w-28", 1046, 20, "0x9FB3C8", FONT_M))
    base.append("format=yuv420p[v]")
    graph = ";".join(chain) + ";" + ",".join(base)
    if audio_from_video:
        graph += f";[0:a]aresample=48000,pan=stereo|c0=c0|c1=c0,apad,atrim=0:{seg['dur']:.4f}[a]"
        amap = "[a]"
    else:
        inputs += ["-f", "lavfi", "-t", f"{seg['dur']:.4f}", "-i", "anullsrc=r=48000:cl=stereo"]
        an = sum(1 for k in inputs if k == "-i") - 1
        graph += f";[{an}:a]atrim=0:{seg['dur']:.4f}[a]"
        amap = "[a]"
    gfile = BUILD / f"graph_{i:02d}.txt"
    gfile.write_text(graph, encoding="utf-8")
    run([*inputs, "-filter_complex_script", gfile.name, "-map", "[v]", "-map", amap, "-frames:v", str(nframes), *ENC, "-shortest", str(out_path)])
    return seg["dur"]


# ---------------------------------------------------------------- 字幕
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


def timed_chunks(text, t0, t1, limit=30):
    cs = chunks(text, limit)
    total = sum(len(c) for c in cs)
    out, t = [], t0
    for c in cs:
        d = (t1 - t0) * len(c) / total
        out.append((t, t + d, c))
        t += d
    return out


def srt_time(t):
    ms = int(round(t * 1000))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def main():
    for d in (SEGS, TXT):
        if d.exists():
            shutil.rmtree(d)
        d.mkdir(parents=True)
    OUT.mkdir(parents=True, exist_ok=True)
    assert (SHOTS / "s9_issues.png").exists() and (FRAMES / "s7_00842.png").exists(), "先に demo_capture.mjs で画面を撮る"
    if NARRATED:
        assert (NARRATION_DIR / "subtitles.json").exists(), "先に narration_aivis.py でナレーションを作る"
        SCENES[0]["segs"][0].update(dur=INTRO_SEC_NARRATED, zoom=dict(cx=960, cy=540, z=1.04, t=INTRO_SEC_NARRATED))
        SCENES[1]["segs"] = NARRATED_S02
        NOTICE["video"] = "模擬作業動画（CGアニメーション）・アプリの入力動画（元の音声は使っていません）"
        for sc in SCENES:
            for seg in sc["segs"]:
                if seg["kind"] == "video":
                    seg["audio"] = False

    # 1) セグメントを描画
    t = 0.0
    seg_files, manifest_scenes = [], []
    idx = 0
    for sc in SCENES:
        sc["start"] = t
        for seg in sc["segs"]:
            f = SEGS / f"seg_{idx:02d}.mp4"
            d = render_segment(idx, seg, f)
            seg["t0"], seg["t1"] = t, t + d
            t += d
            seg_files.append(f)
            print(f"{sc['id']} seg{idx:02d} {seg['kind']:8s} {seg['t0']:7.2f}–{seg['t1']:7.2f}")
            idx += 1
        sc["end"] = t
    total = t

    # 2) つなぐ（同じ形式なので再エンコードしない）
    lst = BUILD / "concat.txt"
    lst.write_text("".join(f"file 'segs/{f.name}'\n" for f in seg_files), encoding="utf-8")
    joined = BUILD / "joined.mp4"
    run(["-f", "concat", "-safe", "0", "-i", lst.name, "-c", "copy", str(joined)])

    # 3) 字幕：作業者の発話（元動画の時刻 → 編集後の時刻）と、ナレーション（台本の目安）
    worker_subs = []
    for sc in SCENES:
        for seg in sc["segs"]:
            if seg["kind"] == "video" and seg["audio"]:
                for a, b, text in WORKER_SPEECH:
                    if a >= seg["start"] and b <= seg["end"]:
                        ea = seg["t0"] + (a - seg["start"]) / seg["speed"]
                        eb = seg["t0"] + (b - seg["start"]) / seg["speed"]
                        pieces = text.split("|")
                        tot = sum(len(p) for p in pieces)
                        tt = ea
                        for p in pieces:
                            d = (eb - ea) * len(p) / tot
                            worker_subs.append((tt, tt + d, p))
                            tt += d
    narr_subs, cues = [], []
    for sc in SCENES:
        if NARRATED:   # ナレーション版の時刻・長さは narration_aivis.py が検査する
            continue
        if sc["vo"]:
            a = sc["start"] + sc["vo_at"]
            need = len(sc["vo"]) / CPS
            b = a + need
            limit = sc["end"] - 0.3
            assert b <= limit + 1e-6, f"{sc['id']} のナレーションが場面に収まらない（{b:.1f} > {limit:.1f}）"
            narr_subs += timed_chunks(sc["vo"], a, b)
            cues.append(dict(scene_id=sc["id"], name=sc["name"], scene_start=sc["start"], scene_end=sc["end"], vo=True, vo_start=a, vo_end=b, limit=limit, text=sc["vo"], chars=len(sc["vo"])))
        else:
            cues.append(dict(scene_id=sc["id"], name=sc["name"], scene_start=sc["start"], scene_end=sc["end"], vo=False, vo_start=None, vo_end=None, limit=None, text="", chars=0))

    def sub_filters(items, prefix=None, color="white"):
        fs = []
        for a, b, text in items:
            en = f"between(t,{a:.3f},{b:.3f})"
            if prefix:
                fs.append(dt(prefix + text, "(w-text_w)/2", 984, 38, color, enable=en))
            else:
                fs.append(dt(text, "(w-text_w)/2", 984, 40, color, enable=en))
        return fs

    def burn(items_filters, out_file, audio=None):
        g = ",".join(["[0:v]null", *items_filters]) + "[v]"
        gf = BUILD / "graph_subs.txt"
        gf.write_text(g, encoding="utf-8")
        ain = ["-i", str(audio)] if audio else []
        run(["-i", joined.name, *ain, "-filter_complex_script", gf.name, "-map", "[v]", "-map", "1:a" if audio else "0:a",
             "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-r", str(FPS), "-profile:v", "high",
             "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart", "-t", f"{total:.3f}", str(out_file)])

    if NARRATED:
        nar = json.loads((NARRATION_DIR / "subtitles.json").read_text(encoding="utf-8"))
        nsubs = [(s["start"], s["end"], s["text"]) for s in nar["subtitles"]]
        burn(sub_filters(nsubs), OUT / "demo_with_narration.mp4", audio=NARRATION_DIR / "narration_full.wav")
        srt = [f"{k}\n{srt_time(a)} --> {srt_time(b)}\n{x}\n" for k, (a, b, x) in enumerate(nsubs, 1)]
        (OUT / "narration_final.srt").write_text("\n".join(srt), encoding="utf-8")
    else:
        wf = sub_filters(worker_subs, prefix="作業者：", color="0xBDF5E8")
        burn(wf, OUT / "demo_no_voiceover.mp4")
        burn(wf + sub_filters(narr_subs), OUT / "demo_guide_with_narration_subs.mp4")

    # 4) 字幕ファイル・キュー表・マニフェスト
    if not NARRATED:
        write_guide_files(narr_subs, worker_subs, cues)
    write_manifest(total, worker_subs)


def write_guide_files(narr_subs, worker_subs, cues):
    srt = []
    for k, (a, b, text) in enumerate(sorted(narr_subs + [(a, b, "作業者：" + x) for a, b, x in worker_subs]), 1):
        srt.append(f"{k}\n{srt_time(a)} --> {srt_time(b)}\n{text}\n")
    (OUT / "narration_guide.srt").write_text("\n".join(srt), encoding="utf-8")

    with (OUT / "narration_cues.csv").open("w", encoding="utf-8-sig", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["scene_id", "scene_name", "scene_start", "scene_end", "voiceover", "vo_start", "vo_end_target", "vo_latest_end", "read_sec_target", "text", "record_filename", "notes"])
        for c in cues:
            note = ""
            if c["scene_id"] == "S02":
                note = "発表ナレーションなし。作業者の説明音声（元動画）をそのまま使う"
            elif c["scene_id"] == "S07":
                note = f"ナレーション後 {c['vo_end']:.1f}秒〜{c['scene_end']:.1f}秒はロボットの動きだけを見せる（無音）"
            elif c["scene_id"] == "S10":
                note = "最後の「Work2Robot。」はロゴ表示中に"
            w.writerow([c["scene_id"], c["name"], f"{c['scene_start']:.2f}", f"{c['scene_end']:.2f}", "yes" if c["vo"] else "no",
                        "" if not c["vo"] else f"{c['vo_start']:.2f}", "" if not c["vo"] else f"{c['vo_end']:.2f}",
                        "" if not c["vo"] else f"{c['limit']:.2f}", "" if not c["vo"] else f"{c['chars'] / CPS:.1f}",
                        c["text"], f"vo_{c['scene_id']}.wav" if c["vo"] else "", note])


def write_manifest(total, worker_subs):
    def seg_manifest(seg):
        m = dict(kind=seg["kind"], edited_start=round(seg["t0"], 3), edited_end=round(seg["t1"], 3))
        if seg["kind"] == "video":
            m.update(source="materials/input_video_v5.mp4", source_start=seg["start"], source_end=seg["end"], speed=seg["speed"],
                     audio="作業者の説明音声（元動画）" if seg["audio"] else "元の音声は使わない（ミュート）", label=seg["label"], callout=seg.get("chip"),
                     time_map=dict(formula="edited = edited_start + (source - source_start) / speed"))
        elif seg["kind"] == "still":
            m.update(source="materials/intro_title.png" if seg["src"] == "intro" else f"local_media/demo_build/shots/{seg['src']}.png", audio="無音",
                     callout=seg.get("card"), zoom=seg.get("zoom"),
                     spotlight=[dict(rect_in_screenshot=list(s[:4]), from_sec=s[4], to_sec=s[5]) for s in seg.get("spot", [])])
        elif seg["kind"] == "frames":
            m.update(source="local_media/demo_build/frames/s7_*.png（Step 5 の3D再生。再生位置を1コマずつ進めて撮影）", audio="無音",
                     ranges=[dict(edited_from=round(seg["t0"] + a, 3), edited_to=round(seg["t0"] + b, 3), label=lb) for a, b, lb in seg["_labels"]],
                     playback_map="等速区間＝3D再生 0〜11秒、早送り 4×＝3D再生 11〜46.7秒、終盤 4×＝3D再生 198.6〜218.6秒（積み終わり）", callout=seg.get("card"))
        elif seg["kind"] == "compare":
            m.update(source=["shots/s6_reqs.png（HM-2）", "shots/s8_hm1_reqs.png（HM-1）"], crop="1600x470+310+155", label="Before/After", audio="無音")
        elif seg["kind"] == "grid":
            m.update(source=["input_video_v5.mp4 @75s", "shots/s5_level1.png", "frames/s7_00250.png", "shots/s9_summary.png", "materials/work2robot.png"], audio="無音")
        elif seg["kind"] == "logo":
            m.update(source="materials/work2robot.png", audio="無音")
        return m

    if NARRATED:
        nar = json.loads((NARRATION_DIR / "subtitles.json").read_text(encoding="utf-8"))
        narration = {k: [dict(text=s["disp"], speak=s["speak"], start=round(s["start"], 3), end=round(s["end"], 3)) for s in v]
                     for k, v in nar["sentences"].items()}
        manifest = dict(
            output="materials/demo/demo_with_narration.mp4", duration_sec=round(total, 3), resolution="1920x1080", fps=FPS,
            layout=dict(content_box=[OX, OY, CW, CH], subtitle_band="y=962〜1080（ナレーション字幕）"),
            audio=f"発表ナレーションのみ（AivisSpeech・{nar['voice']['name']}・話速{nar['speed']}）。入力動画の元の音声・BGMは使っていない",
            scenes=[dict(id=sc["id"], name=sc["name"], start=round(sc["start"], 3), end=round(sc["end"], 3),
                         narration=narration.get(sc["id"]), segments=[seg_manifest(s) for s in sc["segs"]]) for sc in SCENES],
        )
        (OUT / "scene_manifest_narrated.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"total {total:.2f}s")
        return
    manifest = dict(
        output="materials/demo/demo_no_voiceover.mp4", duration_sec=round(total, 3), resolution="1920x1080", fps=FPS,
        layout=dict(content_box=[OX, OY, CW, CH], subtitle_band="y=962〜1080（字幕・注記用に空けている）"),
        audio="作業者の説明音声（S02 の等速区間のみ）。BGM・発表ナレーションなし",
        scenes=[dict(id=sc["id"], name=sc["name"], start=round(sc["start"], 3), end=round(sc["end"], 3),
                     narration=sc["vo"], segments=[seg_manifest(s) for s in sc["segs"]]) for sc in SCENES],
        worker_subtitles=[dict(edited_start=round(a, 3), edited_end=round(b, 3), text=x) for a, b, x in worker_subs],
    )
    (OUT / "scene_manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

    # 5) サムネイル（人とロボットの比較画像＋ロゴ＋一文）
    g = (f"[0:v]scale=1280:720,setsar=1[bg];[1:v]scale=480:-1[lg];[bg]drawbox=x=340:y=24:w=500:h=180:color=white@0.97:t=fill[b1];"
         f"[b1][lg]overlay=x=350:y=24+(180-h)/2[b2];[b2]drawbox=x=0:y=578:w=1280:h=142:color={NAVY}@0.92:t=fill,"
         + dt("人の作業動画から、ロボットの仕事へ", "(w-text_w)/2", 600, 54, "white") + ","
         + dt("Claudeが業務を構造化し、仮想ロボットで検証", "(w-text_w)/2", 668, 30, "0x6FF0D2", FONT_M) + "[v]")
    gf = BUILD / "graph_thumb.txt"
    gf.write_text(g, encoding="utf-8")
    run(["-i", str(HUMAN_ROBOT), "-i", str(LOGO), "-filter_complex_script", gf.name, "-map", "[v]", "-frames:v", "1", str(OUT / "youtube_thumbnail.png")])
    print(f"total {total:.2f}s")


if __name__ == "__main__":
    main()
