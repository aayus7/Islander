// Live sky renderer for the Weather tab (one canvas, ~60 fps, only while visible).
//
// Layers, back to front:
//   sky gradient (slowly breathing) → stars + shooting stars / sun bloom, god-rays
//   and lens flare / moon + halo → volumetric clouds in depth layers (pre-shaded
//   sprites, drifting with the wind, gently breathing) → fog banks → lightning
//   (branching bolts + sky flash) → rain (3 depths + splashes) / bokeh snow →
//   droplets on the "glass" that slide down and leave trails → legibility shade.
// Everything nudges with the mouse for a little parallax depth.
import type { Sky } from "../../lib/weather";

export interface SkyOptions {
  kind: Sky;
  isDay: boolean;
  golden: boolean;
  wind: number;
}

type RGB = [number, number, number];
const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const rgba = (c: RGB, a: number) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const rand = (a: number, b: number) => a + Math.random() * (b - a);

const SKIES: Record<string, [string, string, string]> = {
  sun: ["#1665c9", "#3f93e3", "#8cc6f4"],
  moon: ["#030716", "#0b1636", "#1b2a57"],
  partly: ["#2c69b4", "#5a92cc", "#9cbcdc"],
  partlyNight: ["#070f26", "#152043", "#2a3659"],
  cloud: ["#4f5f74", "#6f7e92", "#909cac"],
  cloudNight: ["#12182a", "#1e2638", "#2d3648"],
  fog: ["#68717c", "#8b939c", "#aab0b6"],
  fogNight: ["#1d2229", "#2b3139", "#3b424b"],
  rain: ["#2c3a4f", "#415268", "#5a6a80"],
  rainNight: ["#0b111c", "#161e2c", "#232d3d"],
  snow: ["#647d9e", "#8aa1bf", "#b9c8da"],
  snowNight: ["#172033", "#253046", "#37435a"],
  storm: ["#13151f", "#212234", "#34324b"],
  golden: ["#28468e", "#a8607a", "#f4a259"],
};

function skyKey(o: SkyOptions) {
  if (o.golden) return "golden";
  if (!o.isDay && ["cloud", "fog", "rain", "snow"].includes(o.kind)) return `${o.kind}Night`;
  return o.kind;
}

/* ---------- cloud sprites ---------- */

interface CloudLook {
  top: RGB;
  body: RGB;
  under: RGB;
}

function cloudLook(o: SkyOptions): CloudLook {
  if (o.kind === "storm") return { top: hex("#5d6275"), body: hex("#3a3e50"), under: hex("#1c1e2a") };
  if (!o.isDay) return { top: hex("#4c5770"), body: hex("#2f374b"), under: hex("#1a2030") };
  if (o.kind === "rain") return { top: hex("#a7b0bd"), body: hex("#7b8696"), under: hex("#4c5566") };
  if (o.golden) return { top: hex("#fff1e0"), body: hex("#f0c4b0"), under: hex("#9c6f8a") };
  if (o.kind === "cloud" || o.kind === "snow") return { top: hex("#f4f6f9"), body: hex("#cfd6df"), under: hex("#97a2b1") };
  return { top: hex("#ffffff"), body: hex("#f1f5fa"), under: hex("#b9c6d6") };
}

/** A soft, shaded cumulus drawn once to an offscreen canvas (padded so no puff is ever clipped). */
function makeCloud(w: number, h: number, look: CloudLook, dpr: number): { img: HTMLCanvasElement; pad: number } {
  const pad = Math.ceil(h * 0.7);
  const c = document.createElement("canvas");
  c.width = Math.ceil((w + pad * 2) * dpr);
  c.height = Math.ceil((h + pad * 2) * dpr);
  const g = c.getContext("2d")!;
  g.scale(dpr, dpr);
  g.translate(pad, pad);
  const puff = (x: number, y: number, r: number, a: number) => {
    const grd = g.createRadialGradient(x - r * 0.35, y - r * 0.45, r * 0.05, x, y, r);
    grd.addColorStop(0, rgba(look.top, a));
    grd.addColorStop(0.5, rgba(look.body, a * 0.92));
    grd.addColorStop(1, rgba(look.body, 0));
    g.fillStyle = grd;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  };
  g.filter = "blur(1.6px)";
  // Big body puffs along a hump…
  const puffs = 10 + Math.floor(Math.random() * 6);
  const base = h * 0.78;
  for (let i = 0; i < puffs; i++) {
    const t = i / (puffs - 1);
    const hump = Math.sin(t * Math.PI);
    const r = h * (0.22 + 0.3 * hump) * rand(0.82, 1.12);
    puff(w * (0.1 + 0.8 * t) + rand(-6, 6), base - r * rand(0.35, 0.7) - hump * h * 0.14, r, 1);
  }
  // …and small detail puffs on the top edge for a billowy outline.
  for (let i = 0; i < 14; i++) {
    const t = rand(0.12, 0.88);
    const hump = Math.sin(t * Math.PI);
    const r = h * rand(0.08, 0.16);
    puff(w * t, base - h * (0.35 + 0.55 * hump) + rand(-4, 6), r, 0.9);
  }
  g.filter = "none";
  // Flatter, shaded underside.
  const under = g.createLinearGradient(0, h * 0.3, 0, h + pad * 0.5);
  under.addColorStop(0, rgba(look.under, 0));
  under.addColorStop(1, rgba(look.under, 0.8));
  g.globalCompositeOperation = "source-atop";
  g.fillStyle = under;
  g.fillRect(-pad, -pad, w + pad * 2, h + pad * 2);
  return { img: c, pad };
}

/* ---------- the renderer ---------- */

export function startSky(canvas: HTMLCanvasElement, width: number, height: number, o: SkyOptions): () => void {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext("2d")!;
  ctx.scale(dpr, dpr);
  const W = width;
  const H = height;
  const k = o.kind;
  const night = !o.isDay;
  const sky = SKIES[skyKey(o)] ?? SKIES.cloud;
  const skyRGB = sky.map(hex) as [RGB, RGB, RGB];
  const windDir = 1; // clouds drift left → right
  const windSpeed = Math.min(1.8, 0.35 + o.wind / 30);

  // ---- clouds ----
  const look = cloudLook(o);
  const cloudCount = { sun: 1, moon: 1, partly: 4, partlyNight: 4, cloud: 8, fog: 0, rain: 8, snow: 7, storm: 9 }[k] ?? 3;
  const overcast = cloudCount >= 7;
  const clouds = Array.from({ length: cloudCount }, (_, i) => {
    const z = overcast ? 0.35 + (i / cloudCount) * 0.65 : rand(0.45, 1);
    const cw = (overcast ? rand(190, 300) : k === "sun" || k === "moon" ? rand(110, 150) : rand(140, 220)) * (0.6 + z * 0.5);
    const ch = cw * rand(0.36, 0.46);
    // Small wisps on clear skies stay low and faint.
    const y = overcast ? rand(-ch * 0.45, H * 0.55) : k === "sun" || k === "moon" ? rand(H * 0.35, H * 0.6) : rand(-ch * 0.2, H * 0.5);
    const sprite = makeCloud(cw, ch, look, dpr);
    return {
      img: sprite.img,
      pad: sprite.pad,
      w: cw,
      h: ch,
      x: rand(-cw, W),
      y,
      z,
      speed: (5 + 13 * z) * windSpeed,
      bob: rand(0, Math.PI * 2),
      alpha: (k === "sun" || k === "moon" ? 0.45 : overcast ? 0.92 : 0.95) * (0.55 + 0.45 * z),
    };
  }).sort((a, b) => a.z - b.z);

  // ---- stars ----
  const stars = night && (k === "moon" || k === "partlyNight" || k === "cloud")
    ? Array.from({ length: 140 }, () => ({ x: rand(0, W), y: rand(0, H * 0.75), r: rand(0.35, 1.35), p: rand(0, 6.28), s: rand(0.7, 2.2), z: rand(0.2, 1) }))
    : [];
  let shooting: { x: number; y: number; vx: number; vy: number; life: number } | null = null;
  let nextShoot = performance.now() + rand(3000, 9000);

  // ---- rain / snow ----
  const raining = k === "rain" || k === "storm";
  const snowing = k === "snow";
  const slant = Math.min(0.45, o.wind / 90) * windDir;
  const drops = raining
    ? Array.from({ length: k === "storm" ? 220 : 150 }, () => {
        const z = Math.random() < 0.55 ? rand(0.2, 0.45) : Math.random() < 0.7 ? rand(0.45, 0.75) : rand(0.75, 1);
        return { x: rand(-40, W + 40), y: rand(-H, H), z, v: rand(560, 760) * (0.6 + z * 0.7) };
      })
    : [];
  const splashes: { x: number; y: number; vx: number; vy: number; life: number }[] = [];
  const flakes = snowing
    ? Array.from({ length: 110 }, () => {
        const z = Math.random() < 0.6 ? rand(0.15, 0.5) : rand(0.5, 1);
        return { x: rand(0, W), y: rand(-H, H), z, p: rand(0, 6.28), sp: rand(0.6, 1.4) };
      })
    : [];

  // ---- droplets on the glass ----
  const glass: { x: number; y: number; r: number; vy: number; sliding: boolean; trail: number }[] = [];
  const residue: { x: number; y: number; r: number; life: number }[] = [];

  // ---- fog ----
  const fog = k === "fog" || (raining && night)
    ? Array.from({ length: k === "fog" ? 7 : 3 }, (_, i) => ({ x: rand(-W * 0.3, W), y: H * (0.15 + (i / 7) * 0.85), rx: rand(160, 280), ry: rand(30, 60), speed: rand(4, 12) * (i % 2 ? 1 : -1), p: rand(0, 6.28) }))
    : [];

  // ---- lightning ----
  let bolt: { pts: [number, number][][]; born: number } | null = null;
  let flash = 0;
  let nextBolt = performance.now() + rand(1500, 4500);
  const makeBolt = () => {
    const branches: [number, number][][] = [];
    const grow = (x: number, y: number, len: number, depth: number) => {
      const pts: [number, number][] = [[x, y]];
      let cx = x;
      let cy = y;
      const steps = Math.floor(len / 9);
      for (let i = 0; i < steps; i++) {
        cx += rand(-9, 9);
        cy += rand(6, 12);
        pts.push([cx, cy]);
        if (depth < 2 && Math.random() < 0.12) grow(cx, cy, len * rand(0.25, 0.45), depth + 1);
      }
      branches.push(pts);
    };
    grow(rand(W * 0.2, W * 0.8), rand(-10, 20), rand(H * 0.5, H * 0.8), 0);
    return branches;
  };

  // ---- parallax ----
  let mx = 0;
  let my = 0;
  let px = 0;
  let py = 0;
  // Mouse in canvas units, for the sun/moon's playful pull (null = not over the sky).
  let cursor: { x: number; y: number } | null = null;
  const onMove = (e: MouseEvent) => {
    const r = canvas.getBoundingClientRect();
    mx = Math.max(-1, Math.min(1, (e.clientX - (r.left + r.width / 2)) / (r.width / 2)));
    my = Math.max(-1, Math.min(1, (e.clientY - (r.top + r.height / 2)) / (r.height / 2)));
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    cursor = inside ? { x: ((e.clientX - r.left) * W) / r.width, y: ((e.clientY - r.top) * H) / r.height } : null;
  };
  const onLeave = () => (cursor = null);
  window.addEventListener("mousemove", onMove);
  document.addEventListener("mouseleave", onLeave);

  // Magnetic sun/moon: within reach, it leans toward the cursor and swells a touch; let
  // go and it springs back with a small wobble. (Spring: stiffness 150, light damping.)
  const mag = { ox: 0, oy: 0, vx: 0, vy: 0, s: 1, vs: 0 };
  const REACH = 130;
  const magnet = (bx: number, by: number, dt: number) => {
    let tx = 0;
    let ty = 0;
    let ts = 1;
    if (cursor) {
      const dx = cursor.x - bx;
      const dy = cursor.y - by;
      const d = Math.hypot(dx, dy);
      if (d < REACH) {
        const pull = Math.pow(1 - d / REACH, 1.6);
        const lean = Math.min(16, d * 0.32 * pull);
        tx = d > 0.01 ? (dx / d) * lean : 0;
        ty = d > 0.01 ? (dy / d) * lean : 0;
        ts = 1 + 0.12 * pull;
      }
    }
    const k = 150;
    const c = 10;
    const steps = Math.max(1, Math.ceil(dt / 0.008));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      mag.vx += (k * (tx - mag.ox) - c * mag.vx) * h;
      mag.vy += (k * (ty - mag.oy) - c * mag.vy) * h;
      mag.vs += (k * (ts - mag.s) - c * mag.vs) * h;
      mag.ox += mag.vx * h;
      mag.oy += mag.vy * h;
      mag.s += mag.vs * h;
    }
    return { x: bx + mag.ox, y: by + mag.oy, s: mag.s };
  };

  // Celestial positions.
  const sunX = W - 76;
  const sunY = o.golden ? H * 0.42 : 58;
  const moonX = W - 70;
  const moonY = 56;

  let raf = 0;
  let last = performance.now();
  const t0 = last;

  const frame = (now: number) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const t = (now - t0) / 1000;
    px += (mx - px) * Math.min(1, dt * 3);
    py += (my - py) * Math.min(1, dt * 3);

    // Sky gradient with a slow, barely-there breathing.
    const breathe = Math.sin(t * 0.25) * 0.04;
    const sg = ctx.createLinearGradient(0, 0, 0, H);
    const lift = (c: RGB, f: number) => [c[0] * (1 + f), c[1] * (1 + f), c[2] * (1 + f)].map((v) => Math.min(255, Math.round(v))) as RGB;
    sg.addColorStop(0, rgba(lift(skyRGB[0], breathe), 1));
    sg.addColorStop(0.55, rgba(lift(skyRGB[1], -breathe * 0.5), 1));
    sg.addColorStop(1, rgba(skyRGB[2], 1));
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.fillStyle = sg;
    ctx.fillRect(0, 0, W, H);

    // Stars.
    for (const s of stars) {
      // Noticeable but gentle twinkle: dims to about a quarter, then brightens.
      const w = 0.5 + 0.5 * Math.sin(t * s.s + s.p);
      const tw = Math.pow(w, 1.6);
      const a = (0.22 + 0.78 * tw) * (0.5 + 0.5 * s.z);
      const x = s.x - px * 3 * s.z;
      const y = s.y - py * 2 * s.z;
      ctx.fillStyle = `rgba(255,255,255,${a})`;
      ctx.beginPath();
      ctx.arc(x, y, s.r * (0.9 + 0.2 * tw), 0, Math.PI * 2);
      ctx.fill();
      // Only the few brightest get a faint glow at their peak.
      if (s.z > 0.85 && tw > 0.7) {
        const glow = ctx.createRadialGradient(x, y, 0, x, y, s.r * 3.5);
        glow.addColorStop(0, `rgba(220,230,255,${0.18 * ((tw - 0.7) / 0.3)})`);
        glow.addColorStop(1, "rgba(220,230,255,0)");
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(x, y, s.r * 3.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    if (stars.length) {
      if (!shooting && now > nextShoot) {
        shooting = { x: rand(W * 0.1, W * 0.7), y: rand(0, H * 0.3), vx: rand(260, 380), vy: rand(80, 140), life: 1 };
        nextShoot = now + rand(5000, 12000);
      }
      if (shooting) {
        const s = shooting;
        s.x += s.vx * dt;
        s.y += s.vy * dt;
        s.life -= dt * 1.4;
        const tail = ctx.createLinearGradient(s.x, s.y, s.x - s.vx * 0.18, s.y - s.vy * 0.18);
        tail.addColorStop(0, `rgba(255,255,255,${0.9 * Math.max(0, s.life)})`);
        tail.addColorStop(1, "rgba(255,255,255,0)");
        ctx.strokeStyle = tail;
        ctx.lineWidth = 1.6;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(s.x - s.vx * 0.18, s.y - s.vy * 0.18);
        ctx.stroke();
        if (s.life <= 0 || s.x > W + 50) shooting = null;
      }
    }

    // Sun: bloom, god-rays, core, lens flare.
    if (k === "sun" || k === "partly") {
      const m = magnet(sunX - px * 6, sunY - py * 4, dt);
      const sx = m.x;
      const sy = m.y;
      const warm: RGB = o.golden ? [255, 170, 90] : [255, 236, 170];
      const bloom = ctx.createRadialGradient(sx, sy, 0, sx, sy, o.golden ? 230 : 190);
      bloom.addColorStop(0, rgba(warm, 0.55));
      bloom.addColorStop(0.25, rgba(warm, 0.22));
      bloom.addColorStop(1, rgba(warm, 0));
      ctx.fillStyle = bloom;
      ctx.fillRect(0, 0, W, H);
      // Rays: soft wedges slowly turning and shimmering.
      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(t * 0.05);
      ctx.globalCompositeOperation = "lighter";
      for (let i = 0; i < 14; i++) {
        const a = (i / 14) * Math.PI * 2;
        const len = 150 + 50 * Math.sin(t * 0.7 + i * 1.7);
        const op = 0.05 + 0.05 * (0.5 + 0.5 * Math.sin(t * 1.1 + i * 2.3));
        const rg = ctx.createLinearGradient(0, 0, Math.cos(a) * len, Math.sin(a) * len);
        rg.addColorStop(0, rgba(warm, op * 2));
        rg.addColorStop(1, rgba(warm, 0));
        ctx.fillStyle = rg;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(Math.cos(a - 0.06) * len, Math.sin(a - 0.06) * len);
        ctx.lineTo(Math.cos(a + 0.06) * len, Math.sin(a + 0.06) * len);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
      const pulse = (1 + 0.04 * Math.sin(t * 1.3)) * m.s;
      const core = ctx.createRadialGradient(sx - 4, sy - 4, 2, sx, sy, 26 * pulse);
      core.addColorStop(0, "#fffef5");
      core.addColorStop(0.55, o.golden ? "#ffc06a" : "#ffe680");
      core.addColorStop(0.85, rgba(o.golden ? [255, 150, 70] : [255, 214, 90], 0.6));
      core.addColorStop(1, rgba(warm, 0));
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.arc(sx, sy, 26 * pulse, 0, Math.PI * 2);
      ctx.fill();
      // Lens flare along the line through the centre, moving opposite to the mouse.
      ctx.globalCompositeOperation = "lighter";
      const fx = W / 2 + px * 14;
      const fy = H / 2 + py * 10;
      [
        [0.35, 10, 0.1, [255, 220, 150]],
        [0.6, 5, 0.12, [180, 220, 255]],
        [0.95, 18, 0.06, [200, 255, 220]],
        [1.25, 8, 0.08, [255, 200, 180]],
      ].forEach(([f, r, a, c]) => {
        const x = sx + (fx - sx) * (f as number);
        const y = sy + (fy - sy) * (f as number);
        const gg = ctx.createRadialGradient(x, y, 0, x, y, r as number);
        gg.addColorStop(0, rgba(c as RGB, a as number));
        gg.addColorStop(1, rgba(c as RGB, 0));
        ctx.fillStyle = gg;
        ctx.beginPath();
        ctx.arc(x, y, r as number, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.globalCompositeOperation = "source-over";
    }

    // Moon with halo.
    if (k === "moon" || k === "partlyNight") {
      const m = magnet(moonX - px * 5, moonY - py * 3 + Math.sin(t * 0.6) * 1.5, dt);
      const x = m.x;
      const y = m.y;
      const glow = 1 + (m.s - 1) * 4; // the halo brightens as it's drawn to you
      const halo = ctx.createRadialGradient(x, y, 10, x, y, 110 * (1 + (m.s - 1) * 1.5));
      halo.addColorStop(0, `rgba(220,228,255,${0.32 * glow})`);
      halo.addColorStop(0.3, `rgba(200,212,255,${0.1 * glow})`);
      halo.addColorStop(1, "rgba(200,212,255,0)");
      ctx.fillStyle = halo;
      ctx.fillRect(0, 0, W, H);
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(m.s, m.s);
      ctx.translate(-x, -y);
      const body = ctx.createRadialGradient(x - 6, y - 6, 2, x, y, 18);
      body.addColorStop(0, "#fdfdf6");
      body.addColorStop(1, "#c8ccd8");
      ctx.fillStyle = body;
      ctx.beginPath();
      ctx.arc(x, y, 18, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(90,95,120,0.13)";
      for (const [cx, cy, r] of [
        [-6, -4, 3.6],
        [5, 6, 4.6],
        [6, -8, 2.2],
        [-3, 9, 1.8],
      ]) {
        ctx.beginPath();
        ctx.arc(x + cx, y + cy, r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    // Lightning flash lights the sky *behind* the clouds, so they silhouette.
    if (k === "storm") {
      if (now > nextBolt) {
        bolt = { pts: makeBolt(), born: now };
        flash = 1;
        nextBolt = now + rand(2500, 7000);
      }
      if (flash > 0) {
        ctx.fillStyle = `rgba(190,200,255,${0.55 * flash})`;
        ctx.fillRect(0, 0, W, H);
      }
    }

    // Clouds.
    for (const c of clouds) {
      c.x += c.speed * dt;
      if (c.x > W + 20) {
        c.x = -c.w - rand(0, 60);
        c.y = overcast ? rand(-c.h * 0.45, H * 0.55) : c.y;
      }
      const breathe = 1 + 0.015 * Math.sin(t * 0.4 + c.bob);
      const x = c.x - px * 10 * c.z;
      const y = c.y + Math.sin(t * 0.3 + c.bob) * 2 - py * 6 * c.z;
      ctx.globalAlpha = c.alpha;
      ctx.drawImage(c.img, x - c.pad * breathe, y - c.pad * breathe, (c.w + c.pad * 2) * breathe, (c.h + c.pad * 2) * breathe);
    }
    ctx.globalAlpha = 1;

    // Bolt in front of the clouds.
    if (bolt) {
      const age = (now - bolt.born) / 1000;
      const a = age < 0.08 ? 1 : age < 0.14 ? 0.3 : age < 0.22 ? 0.9 : Math.max(0, 1 - (age - 0.22) * 4);
      if (a <= 0) bolt = null;
      else {
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        ctx.shadowColor = "rgba(190,200,255,0.9)";
        ctx.shadowBlur = 16;
        bolt.pts.forEach((pts, i) => {
          ctx.strokeStyle = `rgba(235,240,255,${a * (i === bolt!.pts.length - 1 ? 1 : 0.6)})`;
          ctx.lineWidth = i === bolt!.pts.length - 1 ? 2 : 1;
          ctx.beginPath();
          pts.forEach(([x, y], j) => (j ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
          ctx.stroke();
        });
        ctx.restore();
      }
      flash = Math.max(0, flash - dt * 3.2);
    }

    // Fog banks.
    for (const f of fog) {
      f.x += f.speed * dt;
      if (f.x > W + f.rx) f.x = -f.rx;
      if (f.x < -f.rx) f.x = W + f.rx;
      const a = (k === "fog" ? 0.3 : 0.14) + 0.08 * Math.sin(t * 0.5 + f.p);
      ctx.save();
      ctx.translate(f.x - px * 8, f.y - py * 4);
      ctx.scale(1, f.ry / f.rx);
      const fg = ctx.createRadialGradient(0, 0, 0, 0, 0, f.rx);
      fg.addColorStop(0, `rgba(235,238,242,${a})`);
      fg.addColorStop(1, "rgba(235,238,242,0)");
      ctx.fillStyle = fg;
      ctx.beginPath();
      ctx.arc(0, 0, f.rx, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // Rain: three depths, motion-blurred, with little splashes at the bottom.
    if (raining) {
      ctx.lineCap = "round";
      for (const d of drops) {
        d.y += d.v * dt;
        d.x += d.v * dt * slant;
        const len = 8 + 18 * d.z;
        if (d.y > H + len) {
          if (d.z > 0.7 && Math.random() < 0.6)
            for (let i = 0; i < 2; i++) splashes.push({ x: d.x, y: H - rand(2, 10), vx: rand(-40, 40), vy: rand(-90, -50), life: 1 });
          d.y = rand(-60, -10);
          d.x = rand(-40, W + 40);
        }
        const x = d.x - px * 12 * d.z;
        ctx.strokeStyle = `rgba(210,225,245,${0.12 + d.z * 0.42})`;
        ctx.lineWidth = 0.6 + d.z * 1.1;
        ctx.beginPath();
        ctx.moveTo(x, d.y);
        ctx.lineTo(x - len * slant, d.y - len);
        ctx.stroke();
      }
      for (let i = splashes.length - 1; i >= 0; i--) {
        const s = splashes[i];
        s.vy += 380 * dt;
        s.x += s.vx * dt;
        s.y += s.vy * dt;
        s.life -= dt * 2.6;
        if (s.life <= 0) {
          splashes.splice(i, 1);
          continue;
        }
        ctx.fillStyle = `rgba(220,232,250,${0.5 * s.life})`;
        ctx.beginPath();
        ctx.arc(s.x, s.y, 1, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Snow: far flakes small and sharp, near ones big and soft (bokeh).
    if (snowing) {
      for (const f of flakes) {
        f.p += dt * f.sp;
        f.y += (18 + 46 * f.z) * dt;
        f.x += (Math.sin(f.p) * (10 + 18 * f.z) + o.wind * 0.5) * dt;
        if (f.y > H + 8) {
          f.y = rand(-30, -6);
          f.x = rand(-10, W);
        }
        if (f.x > W + 10) f.x = -10;
        const x = f.x - px * 12 * f.z;
        const r = 0.8 + f.z * 3.2;
        if (f.z > 0.6) {
          const gg = ctx.createRadialGradient(x, f.y, 0, x, f.y, r * 1.6);
          gg.addColorStop(0, `rgba(255,255,255,${0.75 * f.z})`);
          gg.addColorStop(1, "rgba(255,255,255,0)");
          ctx.fillStyle = gg;
          ctx.beginPath();
          ctx.arc(x, f.y, r * 1.6, 0, Math.PI * 2);
        } else {
          ctx.fillStyle = `rgba(255,255,255,${0.4 + f.z * 0.5})`;
          ctx.beginPath();
          ctx.arc(x, f.y, r, 0, Math.PI * 2);
        }
        ctx.fill();
      }
    }

    // Droplets on the glass (rain only): they land, some slide down leaving trails.
    if (raining) {
      if (glass.length < (k === "storm" ? 34 : 24) && Math.random() < dt * (k === "storm" ? 9 : 5))
        glass.push({ x: rand(4, W - 4), y: rand(4, H - 30), r: rand(1.2, 3.6), vy: 0, sliding: false, trail: 0 });
      for (let i = glass.length - 1; i >= 0; i--) {
        const d = glass[i];
        if (!d.sliding && d.r > 2.6 && Math.random() < dt * 0.25) d.sliding = true;
        if (d.sliding) {
          d.vy = Math.min(90, d.vy + 140 * dt);
          d.y += d.vy * dt;
          d.x += Math.sin(d.y * 0.08) * 0.15;
          d.trail += d.vy * dt;
          if (d.trail > 9) {
            d.trail = 0;
            residue.push({ x: d.x, y: d.y - d.r - 1, r: rand(0.5, 1.1), life: 1 });
          }
          if (d.y > H + 6) {
            glass.splice(i, 1);
            continue;
          }
        }
        drawDrop(ctx, d.x, d.y, d.r);
      }
      for (let i = residue.length - 1; i >= 0; i--) {
        const r = residue[i];
        r.life -= dt * 0.35;
        if (r.life <= 0) {
          residue.splice(i, 1);
          continue;
        }
        ctx.globalAlpha = r.life;
        drawDrop(ctx, r.x, r.y, r.r);
        ctx.globalAlpha = 1;
      }
    }

    // Legibility: a soft shadow pool behind the big temperature on bright skies…
    if (o.isDay && (overcast || k === "fog" || k === "partly")) {
      const hp = ctx.createRadialGradient(W / 2, 82, 10, W / 2, 82, 150);
      hp.addColorStop(0, "rgba(20,30,50,0.2)");
      hp.addColorStop(1, "rgba(20,30,50,0)");
      ctx.fillStyle = hp;
      ctx.fillRect(0, 0, W, H);
    }
    // …and a touch darker at the top and bottom.
    const sh = ctx.createLinearGradient(0, 0, 0, H);
    sh.addColorStop(0, "rgba(0,0,0,0.08)");
    sh.addColorStop(0.35, "rgba(0,0,0,0)");
    sh.addColorStop(1, "rgba(0,0,0,0.22)");
    ctx.fillStyle = sh;
    ctx.fillRect(0, 0, W, H);

    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseleave", onLeave);
  };
}

/** A water droplet: a slightly darker lens with a bright highlight and rim. */
function drawDrop(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  const g = ctx.createRadialGradient(x - r * 0.3, y - r * 0.4, 0, x, y, r);
  g.addColorStop(0, "rgba(255,255,255,0.35)");
  g.addColorStop(0.6, "rgba(255,255,255,0.08)");
  g.addColorStop(1, "rgba(0,0,0,0.18)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(x, y, r, r * 1.12, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.7)";
  ctx.beginPath();
  ctx.arc(x - r * 0.35, y - r * 0.4, Math.max(0.4, r * 0.25), 0, Math.PI * 2);
  ctx.fill();
}
