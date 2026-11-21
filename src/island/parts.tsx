import { motion, useAnimationControls, useMotionValue, useSpring } from "motion/react";
import { levels, startAudio } from "../lib/audio";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";

/* ---------- Artwork ---------- */

export function Artwork({ src, size, height, radius, style }: { src: string | null; size: number; height?: number; radius: number; style?: CSSProperties }) {
  return (
    <div
      className="artwork"
      style={{ width: size, height: height ?? size, borderRadius: radius, ...style }}
    >
      {src ? (
        <img src={src} alt="" draggable={false} />
      ) : (
        <NoteIcon size={size * 0.5} />
      )}
    </div>
  );
}

/* ---------- Artwork shape ---------- */

const sizes = new Map<string, { w: number; h: number }>(); // src → natural size

/** Natural pixel size of an image (null until it has loaded). */
export function useArtSize(src: string | null): { w: number; h: number } | null {
  const [sz, setSz] = useState(() => (src ? sizes.get(src) ?? null : null));
  useEffect(() => {
    if (!src) return setSz(null);
    const hit = sizes.get(src);
    if (hit) return setSz(hit);
    setSz(null);
    let alive = true;
    const img = new Image();
    img.onload = () => {
      const v = { w: img.naturalWidth || 1, h: img.naturalHeight || 1 };
      sizes.set(src, v);
      if (sizes.size > 60) sizes.delete(sizes.keys().next().value!);
      if (alive) setSz(v);
    };
    img.src = src;
    return () => {
      alive = false;
    };
  }, [src]);
  return sz;
}

/**
 * Height ÷ width of an image (1 until it has loaded). Lets tall artwork — movie posters —
 * be shown whole at its own shape instead of cropped into a square.
 */
export function useArtAspect(src: string | null): number {
  const sz = useArtSize(src);
  return sz ? sz.h / sz.w : 1;
}

/* ---------- Waveform: driven by what the PC is actually playing ---------- */

// Bars aren't laid out low→high frequency (that reads as a staircase); iOS mixes them.
const BAND_ORDER: Record<number, number[]> = {
  4: [1, 3, 0, 2],
  5: [1, 3, 0, 4, 2],
  6: [1, 3, 0, 4, 2, 5],
};

export function Waveform({
  playing, color, bars = 4, height = 14, barWidth = 3, gap = 2,
}: { playing: boolean; color: string; bars?: number; height?: number; barWidth?: number; gap?: number }) {
  useEffect(startAudio, []);
  const order = BAND_ORDER[bars] ?? BAND_ORDER[4];
  const shades = useMemo(() => gradientStops(color, bars), [color, bars]);
  return (
    <div style={{ display: "flex", alignItems: "center", gap, height }}>
      {order.slice(0, bars).map((band, i) => (
        <Bar key={i} band={band} playing={playing} color={shades[i]} height={height} width={barWidth} />
      ))}
    </div>
  );
}

/** iOS-style waveform gradient: the artwork colour on the left, easing to a soft
 *  near-white on the right. */
let probe: CanvasRenderingContext2D | null = null;
function toRgb(c: string): [number, number, number] {
  try {
    probe ??= document.createElement("canvas").getContext("2d");
    if (probe) {
      probe.fillStyle = "#000";
      probe.fillStyle = c; // the browser normalises hsl()/rgb()/named colours to #rrggbb
      const hex = String(probe.fillStyle);
      if (/^#[0-9a-f]{6}$/i.test(hex)) return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
    }
  } catch {}
  return [255, 255, 255];
}
function luminance([r, g, b]: [number, number, number]) {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/**
 * Black or white glyph for this background. Plain WCAG ratios pick black far too
 * eagerly on saturated mid-tones (black on royal blue or red looks muddy), so like
 * iOS we keep white until the colour is genuinely light.
 */
export function readableOn(color: string): "#000" | "#fff" {
  return luminance(toRgb(color)) > 0.4 ? "#000" : "#fff";
}

/** The same hue, lifted just enough to stand out on the black island. */
export function visibleOnBlack(color: string): string {
  let c = toRgb(color);
  for (let i = 0; i < 12 && luminance(c) < 0.3; i++) c = c.map((v) => v + (255 - v) * 0.15) as [number, number, number];
  return `rgb(${c.map(Math.round).join(", ")})`;
}

export function gradientStops(color: string, n: number): string[] {
  const [r, g, b] = toRgb(color);
  // Fade toward a pale tint of the *same* colour (not a shared grey), so every source
  // keeps its own clearly different gradient.
  const end: [number, number, number] = [r + (255 - r) * 0.72, g + (255 - g) * 0.72, b + (255 - b) * 0.72];
  return Array.from({ length: n }, (_, i) => {
    const t = n > 1 ? i / (n - 1) : 0;
    const mix = (a: number, z: number) => Math.round(a + (z - a) * t);
    return `rgb(${mix(r, end[0])}, ${mix(g, end[1])}, ${mix(b, end[2])})`;
  });
}

function Bar({ band, playing, color, height, width }: { band: number; playing: boolean; color: string; height: number; width: number }) {
  // Heights come straight from the audio analysis — no extra smoothing, so the bars move
  // on the same frame as the sound. (A very stiff spring only for play/pause transitions.)
  const target = useMotionValue(width);
  const h = useSpring(target, { stiffness: 2400, damping: 70, mass: 0.35 });

  useEffect(() => {
    const lv = levels[band];
    const toPx = (v: number) => width + Math.pow(Math.max(0, Math.min(1, v)), 0.85) * (height - width);
    if (!playing) {
      target.set(width); // paused → dots, even if another app is making sound
      return;
    }
    target.set(toPx(lv.get()));
    return lv.on("change", (v) => target.set(toPx(v)));
  }, [band, playing, height, width, target]);

  // Colour cross-fades when you switch source (or the track's artwork changes).
  return (
    <motion.div
      style={{ width, height: h, borderRadius: width }}
      initial={false}
      animate={{ backgroundColor: color }}
      transition={{ duration: 0.6, ease: [0.4, 0, 0.2, 1] }}
    />
  );
}

/* ---------- Marquee: long titles pan like iOS ---------- */

export function Marquee({ text, className }: { text: string; className?: string }) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = useState(0);
  const controls = useAnimationControls();

  // Re-measure whenever either box changes size (island growing, font finishing loading…).
  // Only scroll when the title is clearly too long; tiny overflows just fade at the edge.
  useLayoutEffect(() => {
    const o = outer.current, i = inner.current;
    if (!o || !i) return;
    const measure = () => {
      const over = i.getBoundingClientRect().width - o.getBoundingClientRect().width;
      setOverflow(over > 6 ? Math.ceil(over) : 0);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(o);
    ro.observe(i);
    document.fonts?.ready.then(measure).catch(() => {});
    return () => ro.disconnect();
  }, [text]);

  useEffect(() => {
    controls.stop();
    controls.set({ x: 0 });
    if (overflow <= 0) return;
    const dist = overflow + 24;
    const dur = dist / 28; // ~28 px/s
    const total = dur + 4;
    controls.start({
      x: [0, 0, -dist, -dist, 0],
      transition: { duration: total, times: [0, 2 / total, (2 + dur) / total, (3.6 + dur) / total, 1], repeat: Infinity, ease: "easeInOut" },
    });
  }, [overflow, text, controls]);

  return (
    <div ref={outer} className={`marquee ${overflow > 0 ? "fade" : ""} ${className ?? ""}`}>
      <motion.span ref={inner} animate={controls} style={{ display: "inline-block", whiteSpace: "nowrap" }}>
        {text}
      </motion.span>
    </div>
  );
}

/* ---------- Icons (simple filled glyphs) ---------- */

export function PlayIcon({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 30 30">
      <path d="M8.5 5.6c0-1.5 1.6-2.4 2.9-1.6l14.3 8.9c1.2.8 1.2 2.6 0 3.3L11.4 25c-1.3.8-2.9-.1-2.9-1.6z" fill="currentColor" />
    </svg>
  );
}

export function PauseIcon({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 30 30">
      <rect x="6.5" y="4.5" width="6" height="21" rx="1.8" fill="currentColor" />
      <rect x="17.5" y="4.5" width="6" height="21" rx="1.8" fill="currentColor" />
    </svg>
  );
}

export function SkipIcon({ size = 30, dir }: { size?: number; dir: 1 | -1 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 30 30" style={{ transform: dir < 0 ? "scaleX(-1)" : undefined }}>
      <path d="M2.5 9.1c0-1.3 1.4-2 2.4-1.3l8.4 5.9c.9.6.9 1.9 0 2.6l-8.4 5.9c-1 .7-2.4 0-2.4-1.3z" fill="currentColor" />
      <path d="M14.5 9.1c0-1.3 1.4-2 2.4-1.3l8.4 5.9c.9.6.9 1.9 0 2.6l-8.4 5.9c-1 .7-2.4 0-2.4-1.3z" fill="currentColor" />
    </svg>
  );
}

export function NoteIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24">
      <path d="M19 3.5v11.3a3.2 3.2 0 1 1-1.8-2.9V7.6l-8.4 1.9v7.8a3.2 3.2 0 1 1-1.8-2.9V6.2c0-.6.4-1 .9-1.2l9.9-2.2c.6-.1 1.2.3 1.2.9z" fill="rgba(255,255,255,.55)" />
    </svg>
  );
}

export function ChevronIcon({ size = 10 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 10 10">
      <path d="M3.5 1.8 6.7 5 3.5 8.2" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
