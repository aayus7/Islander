// Live progress for browser downloads (reported by the Island browser extension):
// a compact pill with a progress ring while collapsed, and a "Downloaded" banner.
import { useEffect, useRef, useState } from "react";
import { on } from "../../lib/native";
import { pushBanner } from "./Banners";
import { NumericText } from "./ui";

export interface Download {
  id: string;
  name: string;
  path: string;
  received: number;
  total: number;
  state: "in_progress" | "complete" | "interrupted";
  browser: string;
}

const BLUE = "#0a84ff";

export function useDownloads() {
  const [items, setItems] = useState<Download[]>([]);
  const announced = useRef(new Set<string>());
  useEffect(
    () =>
      on<Download[]>("downloads://update", (list) => {
        setItems(list);
        for (const d of list) {
          const key = `${d.browser}:${d.id}`;
          if (d.state === "complete" && !announced.current.has(key)) {
            announced.current.add(key);
            pushBanner({
              id: `dl-${key}`,
              app: "Downloaded",
              title: d.name,
              body: d.total ? fmtBytes(d.total) : "",
              icon: null,
              glyph: "download",
              tint: BLUE,
              reveal: d.path,
              ttl: 4500,
            });
          }
        }
      }),
    [],
  );
  const active = items.filter((d) => d.state === "in_progress");
  return { active, items };
}

/** Overall progress (0..1) across active downloads; null if sizes are unknown. */
export function progressOf(active: Download[]) {
  const total = active.reduce((a, d) => a + (d.total || 0), 0);
  if (!total) return null;
  return Math.min(1, active.reduce((a, d) => a + d.received, 0) / total);
}

export function DownloadCompact({ active, width, height }: { active: Download[]; width: number; height: number }) {
  const p = progressOf(active);
  return (
    <div className="row" style={{ width, height, padding: "0 12px 0 13px", justifyContent: "space-between", gap: 10 }}>
      <span className="row" style={{ gap: 7, minWidth: 0 }}>
        <span style={{ color: BLUE, display: "flex" }}>
          <ArrowDown />
        </span>
        <span className="dl-name">{active.length > 1 ? `${active.length} downloads` : active[0]?.name}</span>
      </span>
      <span className="row" style={{ gap: 6 }}>
        {p != null && <NumericText className="dl-pct" value={`${Math.round(p * 100)}%`} dir={1} />}
        <Ring p={p} size={20} />
      </span>
    </div>
  );
}

export function DownloadMinimal({ active }: { active: Download[] }) {
  return (
    <span style={{ position: "relative", display: "flex" }}>
      <Ring p={progressOf(active)} size={27} />
      <span style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: BLUE }}>
        <ArrowDown size={12} />
      </span>
    </span>
  );
}

function Ring({ p, size }: { p: number | null; size: number }) {
  const sw = 2.6;
  const r = size / 2 - sw;
  const C = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className={p == null ? "spin" : undefined}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(10,132,255,0.28)" strokeWidth={sw} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={BLUE}
        strokeWidth={sw}
        strokeLinecap="round"
        strokeDasharray={`${C * (p ?? 0.25)} ${C}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: "stroke-dasharray 0.45s cubic-bezier(.2,.8,.2,1)" }}
      />
    </svg>
  );
}

export function ArrowDown({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 4v13M6 11.5l6 6 6-6" />
      <path d="M5 21h14" />
    </svg>
  );
}

function fmtBytes(b: number) {
  if (b >= 1e9) return `${(b / 1e9).toFixed(1)} GB`;
  if (b >= 1e6) return `${(b / 1e6).toFixed(1)} MB`;
  if (b >= 1e3) return `${Math.round(b / 1e3)} KB`;
  return `${b} B`;
}
