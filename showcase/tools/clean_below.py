"""Paint the original wallpaper over everything below a line (other windows on the desktop),
keeping the island area above it. Recording and wallpaper must be pixel-aligned (Fill, same size).
clean_below.py <src> <t0> <t1> <line_y> <out>"""
import subprocess, sys
import numpy as np
from PIL import Image
src, t0, t1, line, out = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]), sys.argv[5]
X, Y, Wd, Ht = 640, 0, 1280, 560
wall = np.asarray(Image.open("/home/claude/dynamic-island/showcase/assets/wallpaper.jpg").convert("RGB"), np.float32)[Y:Y + Ht, X:X + Wd] - 1.0
ys = np.arange(Ht, dtype=np.float32)[:, None, None]
a = np.clip((ys - (line - 14)) / 14, 0, 1)  # 0 above, 1 below, 14 px feather
dec = subprocess.Popen(["ffmpeg", "-v", "error", "-ss", t0, "-to", t1, "-i", src, "-vf", f"crop={Wd}:{Ht}:{X}:{Y}", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], stdout=subprocess.PIPE)
enc = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{Wd}x{Ht}", "-r", "60", "-i", "-", "-c:v", "libx264", "-preset", "slow", "-crf", "10", "-pix_fmt", "yuv444p", out], stdin=subprocess.PIPE)
n = 0
while True:
    buf = dec.stdout.read(Wd * Ht * 3)
    if len(buf) < Wd * Ht * 3:
        break
    f = np.frombuffer(buf, np.uint8).reshape(Ht, Wd, 3).astype(np.float32)
    enc.stdin.write(np.clip(f * (1 - a) + wall * a, 0, 255).astype(np.uint8).tobytes())
    n += 1
enc.stdin.close(); enc.wait()
print("frames", n)
