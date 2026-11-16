// System monitor: Apple-Watch-style activity rings for CPU / GPU / Memory / Disk,
// plus live network speed with a sparkline. Colours step up with load.
import { motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { isTauri } from "../../bridge";
import { on, send } from "../../lib/native";
import { ModHeader } from "./ui";

export interface Stats {
  cpu: number; // %
  gpu: number | null; // %
  ramUsed: number; // bytes
  ramTotal: number;
  diskUsed: number;
  diskTotal: number;
  diskName: string;
  down: number; // bytes/s
  up: number;
}

export function useStats() {
  const [s, setS] = useState<Stats | null>(null);
  const hist = useRef<{ down: number; up: number; t: number }[]>([]);
  useEffect(() => {
    if (!isTauri) {
      // Preview: plausible wandering numbers.
      let t = 0;
      const id = setInterval(() => {
        t++;
        const next: Stats = {
          cpu: 18 + 14 * Math.sin(t / 3) + Math.random() * 8,
          gpu: 35 + 30 * Math.sin(t / 5),
          ramUsed: 11.2e9 + Math.sin(t / 7) * 0.4e9,
          ramTotal: 16e9,
          diskUsed: 412e9,
          diskTotal: 512e9,
          diskName: "C:",
          down: Math.max(0, 2.4e6 + Math.sin(t / 2) * 2e6),
          up: Math.max(0, 0.3e6 + Math.cos(t / 3) * 0.25e6),
        };
        hist.current = [...hist.current, { down: next.down, up: next.up, t: performance.now() }].slice(-60);
        setS(next);
      }, 500);
      return () => clearInterval(id);
    }
    send("stats_watch", { on: true });
    const un = on<Stats>("stats://update", (next) => {
      hist.current = [...hist.current, { down: next.down, up: next.up, t: performance.now() }].slice(-60);
      setS(next);
    });
    return () => {
      un();
      send("stats_watch", { on: false });
    };
  }, []);
  return { s, hist };
}

const level = (p: number) => (p >= 85 ? "#ff453a" : p >= 60 ? "#ffd60a" : "#30d158");

export function StatsPanel({ width, height }: { width: number; height: number }) {
  const { s, hist } = useStats();
  const ram = s ? (s.ramUsed / s.ramTotal) * 100 : 0;
  const disk = s && s.diskTotal ? (s.diskUsed / s.diskTotal) * 100 : 0;
  return (
    <div className="mod" style={{ width, height }}>
      <ModHeader title="System" />
      <div className="rings">
        <Ring label="CPU" value={s?.cpu ?? 0} ready={!!s} />
        <Ring label="GPU" value={s?.gpu ?? 0} ready={!!s && s.gpu != null} />
        <Ring label="Memory" value={ram} ready={!!s} sub={s ? `${gb(s.ramUsed)}/${gb(s.ramTotal)} GB` : ""} />
        <Ring label={`Disk ${s?.diskName ?? ""}`} value={disk} ready={!!s} sub={s ? `${gb(s.diskTotal - s.diskUsed)} GB free` : ""} />
      </div>
      <div className="net">
        <div className="net-col">
          <span className="net-label">
            <Arrow down /> Download
          </span>
          <span className="net-val">{s ? rate(s.down) : "—"}</span>
        </div>
        <Spark hist={hist} color="#64d2ff" />
        <div className="net-col" style={{ alignItems: "flex-end" }}>
          <span className="net-label">
            <Arrow /> Upload
          </span>
          <span className="net-val">{s ? rate(s.up) : "—"}</span>
        </div>
      </div>
    </div>
  );
}

function Ring({ label, value, ready, sub }: { label: string; value: number; ready: boolean; sub?: string }) {
  const R = 25;
  const C = 2 * Math.PI * R;
  const v = Math.max(0, Math.min(100, value));
  const color = level(v);
  return (
    <div className="ring">
      <svg style={{ display: "block" }} width="62" height="62" viewBox="0 0 62 62">
        <circle cx="31" cy="31" r={R} fill="none" stroke="rgba(118,118,128,0.28)" strokeWidth="6" />
        <motion.circle
          cx="31"
          cy="31"
          r={R}
          fill="none"
          strokeWidth="6"
          strokeLinecap="round"
          transform="rotate(-90 31 31)"
          strokeDasharray={C}
          initial={false}
          animate={{ strokeDashoffset: C * (1 - (ready ? v : 0) / 100), stroke: color }}
          transition={{ type: "spring", stiffness: 120, damping: 22 }}
        />
      </svg>
      <span className="ring-val">{ready ? `${Math.round(v)}%` : "—"}</span>
      <span className="ring-label">{label}</span>
      {sub && <span className="ring-sub">{sub}</span>}
    </div>
  );
}

/**
 * Scrolling sparkline, Activity Monitor-style: drawn every frame from timestamped
 * samples, so the line glides left continuously and each new sample slides in from
 * the right edge (one interval behind real time) instead of the graph jumping.
 * The vertical scale eases towards the new peak.
 */
function Spark({ hist, color }: { hist: React.MutableRefObject<{ down: number; t: number }[]>; color: string }) {
  const W = 120;
  const H = 30;
  const WINDOW = 15_000; // ms of history shown
  const DELAY = 550; // one sample interval: the newest point enters from the right edge
  const line = useRef<SVGPathElement>(null);
  const area = useRef<SVGPathElement>(null);
  const scale = useRef(1);
  useEffect(() => {
    let raf = 0;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const pts = hist.current;
      if (pts.length < 2 || !line.current || !area.current) return;
      const now = performance.now() - DELAY;
      const target = Math.max(1, ...pts.map((p) => p.down)) * 1.15;
      scale.current += (target - scale.current) * 0.06;
      const xy = pts.map((p) => [W - ((now - p.t) / WINDOW) * W, H - 1.5 - (p.down / scale.current) * (H - 4)] as const);
      // Catmull-Rom → cubic Bézier for a soft curve.
      let d = `M${xy[0][0].toFixed(2)},${xy[0][1].toFixed(2)}`;
      for (let i = 0; i < xy.length - 1; i++) {
        const p0 = xy[i - 1] ?? xy[i];
        const p1 = xy[i];
        const p2 = xy[i + 1];
        const p3 = xy[i + 2] ?? p2;
        const c1x = p1[0] + (p2[0] - p0[0]) / 6;
        const c1y = p1[1] + (p2[1] - p0[1]) / 6;
        const c2x = p2[0] - (p3[0] - p1[0]) / 6;
        const c2y = p2[1] - (p3[1] - p1[1]) / 6;
        d += ` C${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${p2[0].toFixed(2)},${p2[1].toFixed(2)}`;
      }
      line.current.setAttribute("d", d);
      area.current.setAttribute("d", `${d} L${xy[xy.length - 1][0].toFixed(2)},${H} L${xy[0][0].toFixed(2)},${H} Z`);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [hist]);
  return (
    <svg width={W} height={H} className="spark">
      <defs>
        <linearGradient id="spk" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.35" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
        <linearGradient id="spk-fade" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor="#fff" stopOpacity="0" />
          <stop offset="0.18" stopColor="#fff" stopOpacity="1" />
          <stop offset="1" stopColor="#fff" stopOpacity="1" />
        </linearGradient>
        <mask id="spk-mask">
          <rect width={W} height={H} fill="url(#spk-fade)" />
        </mask>
      </defs>
      <g mask="url(#spk-mask)">
        <path ref={area} fill="url(#spk)" />
        <path ref={line} fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
      </g>
    </svg>
  );
}

function Arrow({ down }: { down?: boolean }) {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ transform: down ? "rotate(180deg)" : undefined }}>
      <path d="M12 19V5M5.5 11.5L12 5l6.5 6.5" />
    </svg>
  );
}

const gb = (b: number) => (b / 1e9 >= 100 ? (b / 1e9).toFixed(0) : (b / 1e9).toFixed(1));
function rate(bps: number) {
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(1)} MB/s`;
  if (bps >= 1e3) return `${(bps / 1e3).toFixed(0)} KB/s`;
  return `${Math.round(bps)} B/s`;
}
