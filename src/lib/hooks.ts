import { useEffect, useState } from "react";
import type { MediaSession } from "../bridge";

/** Re-render on an interval (only while `active`). */
export function useNow(active: boolean, ms = 250) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [active, ms]);
  return now;
}

export function livePosition(s: MediaSession, now: number) {
  const p = s.playing ? s.position + ((now - s.sampledAt) / 1000) * (s.rate ?? 1) : s.position;
  return s.duration > 0 ? Math.min(Math.max(p, 0), s.duration) : Math.max(p, 0);
}

export function fmtTime(sec: number) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

const colorCache = new Map<string, string>();

/** A pleasant, stable colour per app when there's no artwork to sample. */
function seedColor(seed: string) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  return `hsl(${hue}, 75%, 66%)`;
}

/**
 * The waveform takes its colour from the album art, like iOS.
 * Picks a saturated, reasonably bright average and lifts it so it reads on black.
 * Falls back to a per-app colour (never a shared grey), so switching sources always
 * changes the colour.
 */
export function useArtColor(src: string | null, seed = "") {
  const fallback = seedColor(seed || "media");
  const [color, setColor] = useState(() => (src && colorCache.get(src)) || fallback);
  useEffect(() => {
    if (!src) return setColor(fallback);
    const cached = colorCache.get(src);
    if (cached) return setColor(cached);
    let alive = true;
    const img = new Image();
    img.onload = () => {
      let out = fallback;
      try {
        const N = 24;
        const c = document.createElement("canvas");
        c.width = c.height = N;
        const ctx = c.getContext("2d", { willReadFrequently: true });
        if (ctx) {
          ctx.drawImage(img, 0, 0, N, N);
          const d = ctx.getImageData(0, 0, N, N).data;
          let r = 0, g = 0, b = 0, wsum = 0;
          for (let i = 0; i < d.length; i += 4) {
            const R = d[i], G = d[i + 1], B = d[i + 2], A = d[i + 3] / 255;
            const max = Math.max(R, G, B), min = Math.min(R, G, B);
            const sat = max === 0 ? 0 : (max - min) / max;
            // Transparent pixels (app icons) don't count.
            const w = (0.05 + sat * sat * (max / 255)) * A;
            r += R * w; g += G * w; b += B * w; wsum += w;
          }
          if (wsum > 0) {
            r /= wsum; g /= wsum; b /= wsum;
            // Lift brightness so the bars stay visible on pure black.
            const max = Math.max(r, g, b, 1);
            const lift = Math.max(1, 200 / max);
            out = `rgb(${Math.min(255, r * lift) | 0}, ${Math.min(255, g * lift) | 0}, ${Math.min(255, b * lift) | 0})`;
          }
        }
      } catch {
        // unreadable image → keep the per-app fallback
      }
      colorCache.set(src, out);
      if (alive) setColor(out);
    };
    img.onerror = () => alive && setColor(fallback);
    img.src = src;
    return () => {
      alive = false;
    };
  }, [src, fallback]);
  return color;
}
