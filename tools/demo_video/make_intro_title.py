"""導入画像（人とロボットの写真）にWork2Robotのロゴを重ねて 1920x1080 で書き出す。"""
import re
import subprocess
import sys

import imageio_ffmpeg

FF = imageio_ffmpeg.get_ffmpeg_exe()
REPO = "C:/Users/takada ryoga/Documents/work2robot/work2robot"
SRC = f"{REPO}/materials/humanandrobot2.png"
LOGO = f"{REPO}/app/frontend/public/work2robot_logo.png"
OUT = sys.argv[1] if len(sys.argv) > 1 else f"{REPO}/materials/intro_title.png"


def size(path):
    err = subprocess.run([FF, "-hide_banner", "-i", path], capture_output=True, text=True).stderr
    m = re.search(r"Video: .*?, (\w+)[^,]*, (\d+)x(\d+)", err)
    return m.group(1), int(m.group(2)), int(m.group(3))


print("src", size(SRC))
print("logo", size(LOGO))

W, H = 1920, 1080
LW = 520                      # ロゴの幅
_, lw0, lh0 = size(LOGO)
LH = round(LW * lh0 / lw0)
PW, PH = LW + 72, LH + 40     # 白い下地（上端の中央。人物・ロボット・カゴ車に重ねない）
PX, PY = (W - PW) // 2, 36
fc = (f"[0]scale={W}:{H}:flags=lanczos,format=rgba,"
      f"drawbox=x={PX + 6}:y={PY + 8}:w={PW}:h={PH}:color=black@0.25:t=fill,"
      f"drawbox=x={PX}:y={PY}:w={PW}:h={PH}:color=white:t=fill[bg];"
      f"[1]scale={LW}:-1:flags=lanczos[lg];"
      f"[bg][lg]overlay=x={(W - LW) // 2}:y={PY + (PH - LH) // 2}")
subprocess.run([FF, "-y", "-hide_banner", "-loglevel", "error", "-i", SRC, "-i", LOGO,
                "-filter_complex", fc, "-frames:v", "1", OUT], check=True)
print("saved", OUT, size(OUT))
