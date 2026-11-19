"""Frame-exact recorder for the Islander showcase.

Usage: python3 showcase/record.py <scene> [--fps 60] [--from-ms 0] [--to-ms N] [--preview]
Scenes live in showcase/scenes/<name>.py and define SCENE = Timeline(...).
Frames go to /tmp/showcase/<scene>/f_00000.png, then ffmpeg encodes them.
"""
import asyncio, importlib.util, math, os, shutil, subprocess, sys, time, base64
from playwright.async_api import async_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
URL = os.environ.get("STAGE_URL", "http://localhost:1420/showcase/stage.html")
W, H, DPR = 2560, 1440, 1


def ease(t, kind="io"):
    t = max(0.0, min(1.0, t))
    if kind == "linear":
        return t
    if kind == "out":
        return 1 - (1 - t) ** 3
    # smooth, human-ish in-out (quintic-ish)
    return t * t * t * (t * (6 * t - 15) + 10)


class Timeline:
    """A scene: cursor paths and actions at times (ms)."""

    def __init__(self, duration, start=(1500, 500), clip=(640, 0, 1280, 560), setup=""):
        self.duration = duration
        self.events = []  # (t, kind, data)
        self.moves = []  # (t0, t1, (x0,y0), (x1,y1), ease, arc)
        self.start = start
        self.clip = clip  # (x, y, w, h) in CSS px, or None for full
        self.setup = setup
        self.pos = {"xy": start}
        self.t = 0

    # -- authoring helpers (keep a running clock) --
    def at(self, t):
        self.t = t
        return self

    def wait(self, ms):
        self.t += ms
        return self

    def js(self, code, t=None):
        self.events.append((self.t if t is None else t, "js", code))
        return self

    def move(self, x, y=None, ms=700, kind="io", arc=0.12, dx=0, dy=0):
        """Move to (x, y), or to the centre of the element matching selector x (resolved
        when the move starts, so it lands on wherever the element really is)."""
        target = {"sel": x, "dx": dx, "dy": dy} if isinstance(x, str) else {"xy": (x, y)}
        self.moves.append({"t0": self.t, "t1": self.t + ms, "p0": self.pos, "p1": target, "kind": kind, "arc": arc})
        self.pos = target
        self.t += ms
        return self

    def click(self, hold=90):
        self.events.append((self.t, "down", None))
        self.events.append((self.t + hold, "up", None))
        self.t += hold
        return self

    def press(self):
        self.events.append((self.t, "down", None))
        return self

    def release(self):
        self.events.append((self.t, "up", None))
        return self

    def wheel(self, dy, dx=0, steps=1, every=60):
        for i in range(steps):
            self.events.append((self.t + i * every, "wheel", (dx, dy)))
        self.t += steps * every
        return self

    @staticmethod
    def xy(p):
        return p["xy"] if isinstance(p, dict) else p

    def cursor_at(self, t):
        x, y = self.start
        for m in self.moves:
            if t < m["t0"]:
                break
            p0, p1 = self.xy(m["p0"]), self.xy(m["p1"])
            k = ease((t - m["t0"]) / max(1, m["t1"] - m["t0"]), m["kind"])
            dx, dy = p1[0] - p0[0], p1[1] - p0[1]
            bend = math.sin(math.pi * k) * m["arc"]
            x = p0[0] + dx * k - dy * bend
            y = p0[1] + dy * k + dx * bend
        return x, y

    async def resolve(self, pg, t):
        for m in self.moves:
            if m["t0"] <= t and "sel" in m["p1"] and "xy" not in m["p1"]:
                r = await pg.evaluate(
                    "(q)=>{const [s,txt]=q.split('|');const e=[...document.querySelectorAll(s)].find(e=>e.getBoundingClientRect().width>0&&(!txt||e.textContent.includes(txt)));if(!e)return null;const r=e.getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]}",
                    m["p1"]["sel"],
                )
                if r is None:
                    raise SystemExit(f"selector not found at {t:.0f} ms: {m['p1']['sel']}")
                m["p1"]["xy"] = (r[0] + m["p1"]["dx"], r[1] + m["p1"]["dy"])


def load_scene(name):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, "scenes", f"{name}.py"))
    mod = importlib.util.module_from_spec(spec)
    sys.path.insert(0, HERE)
    spec.loader.exec_module(mod)
    return mod.SCENE


async def record(name, fps=60, from_ms=0, to_ms=None, preview=False, out_dir=None):
    sc = load_scene(name)
    out_dir = out_dir or f"/tmp/showcase/{name}"
    shutil.rmtree(out_dir, ignore_errors=True)
    os.makedirs(out_dir)
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--force-color-profile=srgb", "--hide-scrollbars", "--font-render-hinting=none"])
        ctx = await b.new_context(viewport={"width": W, "height": H}, device_scale_factor=DPR)
        await ctx.add_init_script(path=os.path.join(HERE, "vtime.js"))
        pg = await ctx.new_page()
        logs = []
        pg.on("console", lambda m: logs.append(f"{m.type}: {m.text}") if m.type in ("error", "warning") else None)
        pg.on("pageerror", lambda e: logs.append("PAGEERROR " + str(e)))
        await pg.route("**/*open-meteo.com/**", lambda r: r.abort())
        await pg.route("**/geojs.io/**", lambda r: r.abort())
        await pg.goto(URL)
        for _ in range(200):
            if await pg.evaluate("!!window.__stageReady"):
                break
            await asyncio.sleep(0.05)
        else:
            raise SystemExit("stage never became ready:\n" + "\n".join(logs))
        cdp = await ctx.new_cdp_session(pg)
        # settle fonts and first paint (virtual clock still at ~0)
        for _ in range(30):
            await pg.evaluate("__vt.advance(16)")
        if sc.setup:
            await pg.evaluate(sc.setup)
            for _ in range(60):
                await pg.evaluate("__vt.advance(16)")
        dt = 1000.0 / fps
        events = sorted(sc.events, key=lambda e: e[0])
        ei = 0
        last_xy = None
        n_total = int((to_ms or sc.duration) / dt)
        frame = 0
        t0 = time.time()
        clip = sc.clip
        for i in range(n_total + 1):
            t = i * dt
            while ei < len(events) and events[ei][0] <= t:
                _, kind, data = events[ei]
                ei += 1
                if kind == "js":
                    await pg.evaluate(data)
                elif kind == "down":
                    await pg.mouse.down()
                    await pg.evaluate("__stage.cursor(%f,%f,true)" % last_xy)
                elif kind == "up":
                    await pg.mouse.up()
                    await pg.evaluate("__stage.cursor(%f,%f,false)" % last_xy)
                elif kind == "wheel":
                    await pg.mouse.wheel(data[0], data[1])
            await sc.resolve(pg, t)
            x, y = sc.cursor_at(t)
            if last_xy is None or abs(x - last_xy[0]) + abs(y - last_xy[1]) > 0.05:
                await pg.mouse.move(x, y)
                await pg.evaluate("__stage.cursor(%f,%f)" % (x, y))
                last_xy = (x, y)
            await pg.evaluate("__vt.advance(%f)" % (dt if i else 0.0))
            if t < from_ms or (preview and i % int(fps / 4) != 0):
                # Still render: layout callbacks (ResizeObserver etc.) only run when a frame is made.
                await cdp.send("Page.captureScreenshot", {"format": "jpeg", "quality": 1, "clip": {"x": 0, "y": 0, "width": 4, "height": 4, "scale": 1}})
                continue
            params = {"format": "png", "captureBeyondViewport": False}
            if clip:
                params["clip"] = {"x": clip[0], "y": clip[1], "width": clip[2], "height": clip[3], "scale": 1}
            shot = await cdp.send("Page.captureScreenshot", params)
            with open(f"{out_dir}/f_{frame:05d}.png", "wb") as f:
                f.write(base64.b64decode(shot["data"]))
            frame += 1
            if frame % 120 == 0:
                print(f"  {name}: {frame} frames, {time.time() - t0:.0f}s", flush=True)
        if logs:
            print("\n".join(logs[:20]))
        await b.close()
    print(f"{name}: {frame} frames in {time.time() - t0:.0f}s -> {out_dir}")
    return out_dir


if __name__ == "__main__":
    a = sys.argv[1:]
    name = a[0]
    fps = int(a[a.index("--fps") + 1]) if "--fps" in a else 60
    fm = float(a[a.index("--from-ms") + 1]) if "--from-ms" in a else 0
    tm = float(a[a.index("--to-ms") + 1]) if "--to-ms" in a else None
    asyncio.run(record(name, fps, fm, tm, "--preview" in a))
