"""Replace the desktop behind a real island recording with another wallpaper.

The recording's wallpaper must be static. A clean plate (the desktop with no island over
it) is taken from given frames; each pixel's alpha comes from how far it differs from the
plate and how much darker it is (the island is black, so its antialiased edge and shadow
are a darkening of the plate). out = frame + (1 - a) * (new - plate).
"""
import subprocess, sys, json
import numpy as np
from PIL import Image
from scipy.ndimage import binary_fill_holes, binary_opening

def read_frame(src, t, crop):
    x, y, w, h = crop
    raw = subprocess.run(["ffmpeg", "-v", "error", "-ss", str(t), "-i", src, "-frames:v", "1", "-vf", f"crop={w}:{h}:{x}:{y}", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(h, w, 3).astype(np.float32)

def build_plate(src, crop, base_t, patches):
    """patches: [(t, x0, y0, x1, y1)] regions (crop coords) taken from another frame."""
    p = read_frame(src, base_t, crop)
    for t, x0, y0, x1, y1 in patches:
        if t == "shift":  # fill what's under the island in the plate from a little lower
            dy = y1 - y0 + 12
            from scipy.ndimage import binary_dilation
            reg = p[y0:y1, x0:x1]
            m = binary_dilation(reg.max(2) < 75, iterations=2) | binary_dilation(reg[..., 1] > reg[..., 0] + 40, iterations=8)
            reg[m] = p[y0 + dy:y1 + dy, x0:x1][m]
        else:
            p[y0:y1, x0:x1] = read_frame(src, t, crop)[y0:y1, x0:x1]
    return p

def key(C, P, Wn):
    # Darkening model: C = k * P (the black island over the plate, partially covering).
    k = np.clip((C * P).sum(2) / ((P * P).sum(2) + 1), 0, 1)
    resid = np.abs(C - k[..., None] * P).max(2)
    a_dark = np.clip((1 - k - 0.07) / 0.93, 0, 1)
    a_other = np.clip((resid - 20) / 36, 0, 1)  # colour that darkening can't explain
    a = np.maximum(a_dark, a_other)
    solid = binary_fill_holes(binary_opening(a > 0.6, iterations=1))
    a = np.where(solid & (a > 0.25), 1.0, a)
    # The island and its tab dock: big solid shapes (not the cursor or the camera dot).
    from scipy.ndimage import label
    lab, n = label(binary_fill_holes(a > 0.97))
    sizes = np.bincount(lab.ravel())
    big = np.nonzero(sizes > 3000)[0]
    inner = np.isin(lab, big[big != 0])
    a = np.where(inner, np.maximum(a, 0.999), a)
    # Nothing outside the island's surroundings except the cursor: kills compression specks.
    from scipy.ndimage import binary_dilation as _dil
    keep = _dil(inner, iterations=7) | _dil(a_other > 0.5, iterations=3)
    a = np.where(keep, a, 0.0)
    # The camera dot (OBS had the camera open): not part of this demo, take it out.
    green = (C[..., 1] > C[..., 0] + 50) & (C[..., 1] > C[..., 2] + 30) & ~inner
    out = C + (1 - a)[..., None] * (Wn - P)
    if green.any():
        from scipy.ndimage import binary_dilation
        gone = binary_dilation(green, iterations=10) & ~binary_dilation(inner, iterations=2)
        out = np.where(gone[..., None], Wn, out)
    return np.clip(out, 0, 255).astype(np.uint8), a

if __name__ == "__main__":
    cfg = json.loads(sys.argv[1])
    src, crop = cfg["src"], cfg["crop"]
    P = build_plate(src, crop, cfg["plate_t"], cfg.get("patches", []))
    Wimg = Image.open(cfg["wallpaper"]).convert("RGB").resize(tuple(cfg["wall_size"]), Image.LANCZOS)
    wx, wy = cfg.get("wall_offset", [crop[0], crop[1]])
    Wn = np.asarray(Wimg, np.float32)[wy:wy + crop[3], wx:wx + crop[2]]
    if cfg.get("test"):
        for t in cfg["test"]:
            o, a = key(read_frame(src, t, crop), P, Wn)
            Image.fromarray(o).save(f"/tmp/uv/k_{t}.png")
            Image.fromarray((a * 255).astype(np.uint8)).save(f"/tmp/uv/a_{t}.png")
        sys.exit()
    x, y, w, h = crop
    t0, t1 = cfg["range"]
    dec = subprocess.Popen(["ffmpeg", "-v", "error", "-ss", str(t0), "-to", str(t1), "-i", src, "-vf", f"crop={w}:{h}:{x}:{y}", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], stdout=subprocess.PIPE)
    enc = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}", "-r", "60", "-i", "-", "-c:v", "libx264", "-preset", "slow", "-crf", "10", "-pix_fmt", "yuv444p", cfg["out"]], stdin=subprocess.PIPE)
    n = 0
    while True:
        buf = dec.stdout.read(w * h * 3)
        if len(buf) < w * h * 3:
            break
        o, _ = key(np.frombuffer(buf, np.uint8).reshape(h, w, 3).astype(np.float32), P, Wn)
        enc.stdin.write(o.tobytes())
        n += 1
    enc.stdin.close(); enc.wait()
    print("frames", n)
