"""Builds the full showcase video (1920x1080, 60 fps) from the scene masters.
Each master is the 1280x560 top-centre of a 2560x1440 desktop; the video shows the desktop
from x=320 at 1:1, so the island sits at real size at the top and captions go below it."""
import subprocess, os
from PIL import Image, ImageDraw, ImageFont, ImageFilter
M = "/home/claude/media"
T = "/tmp/reel"
WALL = "/home/claude/dynamic-island/showcase/assets/wallpaper.jpg"
FD = "/usr/share/fonts/opentype/inter/"
os.makedirs(T, exist_ok=True)
Image.open(WALL).convert("RGB").crop((320, 0, 2240, 1080)).save(f"{T}/bg.png")

def caption(name, title, sub, big=False, y=620):
    im = Image.new("RGBA", (1920, 1080), (0, 0, 0, 0))
    ft = ImageFont.truetype(FD + "InterDisplay-SemiBold.otf", 128 if big else 74)
    fs = ImageFont.truetype(FD + "InterDisplay-Regular.otf", 40 if big else 31)
    d = ImageDraw.Draw(im)
    tw = d.textlength(title, font=ft); sw = d.textlength(sub, font=fs)
    ty = y; sy = y + (150 if big else 96)
    # soft shadow for legibility over the bright parts of the wallpaper
    sh = Image.new("RGBA", im.size, (0, 0, 0, 0)); ds = ImageDraw.Draw(sh)
    ds.text(((1920 - tw) / 2, ty + 3), title, font=ft, fill=(0, 0, 0, 150))
    ds.text(((1920 - sw) / 2, sy + 2), sub, font=fs, fill=(0, 0, 0, 150))
    sh = sh.filter(ImageFilter.GaussianBlur(14))
    im = Image.alpha_composite(im, sh); d = ImageDraw.Draw(im)
    d.text(((1920 - tw) / 2, ty), title, font=ft, fill=(255, 255, 255, 255))
    d.text(((1920 - sw) / 2, sy), sub, font=fs, fill=(255, 255, 255, 190))
    im.save(f"{T}/cap_{name}.png")

# (name, master, start, end, title, subtitle)
SEG = [
    ("music", "music2_master", 3.4, 15.2, "Your music, front and center.", "Spotify, YouTube and every app that plays — with real album art."),
    ("compact", "music2_master", 38.0, 46.5, "Even when it’s tucked away.", "The cover turns on every skip, and glows in its own colour."),
    ("airdrop", "airdrop_master", 0.4, 21.0, "AirDrop, on Windows.", "Send and receive between your PC and your phone."),
    ("discord", "discord_master", 0.5, 12.6, "Notifications that feel native.", "Discord and every other app — with profile pictures and images."),
    ("downloads", "downloads_master", 0.5, 12.5, "Every download, at a glance.", "Your browser, IDM and Mister Download Manager."),
    ("airpods", "airpods_master", 0.6, 6.2, "Connected.", "AirPods and Beats, in 3D, with battery."),
    ("hud", "hud_master", 0.5, 9.6, "Volume. Brightness. Caps Lock.", "The Windows pop-ups, replaced with something beautiful."),
    ("privacy", "privacy_master", 0.6, 9.6, "Know when you’re on.", "Camera and microphone indicators, just like iPhone."),
    ("weather", "weather_master", 0.6, 13.6, "Weather that moves.", "Live skies, hourly and 7-day forecasts, all in the island."),
    ("timer", "timer_master", 0.6, 11.8, "Live Activities.", "Timers, stopwatches and focus sessions that stay with you."),
    ("tour", "tour_master", 0.8, 18.2, "Everything, one hover away.", "Controls, calendar, notes, shelf, clipboard and system stats."),
]
def run(args):
    subprocess.run(["ffmpeg", "-v", "error", "-y", *args], check=True)

ENC = ["-c:v", "libx264", "-preset", "medium", "-crf", "14", "-pix_fmt", "yuv420p", "-r", "60"]
def seg(name, master, a, b, title, sub):
    caption(name, title, sub)
    dur = b - a
    capf = (f"[2:v]format=rgba,fade=in:st=0.35:d=0.7:alpha=1,fade=out:st={dur - 0.85:.2f}:d=0.55:alpha=1[c];"
            f"[0:v][m]overlay=320:0[b];[b][c]overlay=0:'22*pow(1-min(1,max(0,(t-0.35)/0.8)),3)'")
    run(["-loop", "1", "-framerate", "60", "-t", f"{dur:.3f}", "-i", f"{T}/bg.png",
         "-ss", f"{a}", "-t", f"{dur:.3f}", "-i", f"{M}/{master}.mp4",
         "-loop", "1", "-framerate", "60", "-t", f"{dur:.3f}", "-i", f"{T}/cap_{name}.png",
         "-filter_complex", f"[1:v]setpts=PTS-STARTPTS,format=yuv444p[m];" + capf, *ENC, "-t", f"{dur:.3f}", f"{T}/s_{name}.mp4"])
    return f"{T}/s_{name}.mp4", dur

def card(name, still_master, title, sub, dur):
    caption(name, title, sub, big=True, y=560)
    run(["-ss", "0.25", "-i", f"{M}/{still_master}.mp4", "-frames:v", "1", f"{T}/still_{name}.png"])
    run(["-loop", "1", "-framerate", "60", "-t", f"{dur}", "-i", f"{T}/bg.png",
         "-loop", "1", "-framerate", "60", "-t", f"{dur}", "-i", f"{T}/still_{name}.png",
         "-loop", "1", "-framerate", "60", "-t", f"{dur}", "-i", f"{T}/cap_{name}.png",
         "-filter_complex", f"[0:v][1:v]overlay=320:0[b];[2:v]format=rgba,fade=in:st=0.4:d=0.9:alpha=1,fade=out:st={dur - 0.7}:d=0.6:alpha=1[c];[b][c]overlay=0:'26*pow(1-min(1,max(0,(t-0.4)/1.0)),3)'",
         *ENC, "-t", f"{dur}", f"{T}/s_{name}.mp4"])
    return f"{T}/s_{name}.mp4", dur

if __name__ == "__main__":
    parts = [card("intro", "privacy_master", "Islander", "The Dynamic Island, on Windows.", 3.8)]
    for s in SEG:
        parts.append(seg(*s)); print("built", s[0], flush=True)
    parts.append(card("outro", "privacy_master", "Islander", "The best 1:1 Dynamic Island for Windows.", 4.6))
    # crossfade everything together
    X = 0.45
    inputs = []
    for p, _ in parts:
        inputs += ["-i", p]
    fc = []; last = "0:v"; off = 0.0
    for i in range(1, len(parts)):
        off += parts[i - 1][1] - X
        out = f"x{i}"
        fc.append(f"[{last}][{i}:v]xfade=transition=fade:duration={X}:offset={off:.3f}[{out}]")
        last = out
    run([*inputs, "-filter_complex", ";".join(fc), "-map", f"[{last}]", "-c:v", "libx264", "-preset", "slow", "-crf", "17", "-pix_fmt", "yuv420p", "-movflags", "+faststart", f"{M}/islander-showcase.mp4"])
    print("done", sum(d for _, d in parts) - X * (len(parts) - 1), "s")
