// Live download progress — from the browser extension, Mister Download Manager and
// Internet Download Manager: the file's tile, name, speed and a progress ring while
// collapsed, then a "Download complete" banner that opens the folder on click.
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { on, send } from "../../lib/native";
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
  /** Bytes per second (download managers report it). */
  speed?: number;
}

/* Cancelled downloads disappear at once, before the source confirms. */
const cancelled = new Set<string>();
const cancelListeners = new Set<() => void>();
const keyOf = (d: Download) => `${d.browser}:${d.id}`;
export function cancelDownload(d: Download) {
  cancelled.add(keyOf(d));
  cancelListeners.forEach((l) => l());
  send("download_cancel", { id: d.id, browser: d.browser, name: d.name });
}

export function useDownloads() {
  const [raw, setItems] = useState<Download[]>([]);
  const [, bump] = useState(0);
  useEffect(() => {
    const l = () => bump((n) => n + 1);
    cancelListeners.add(l);
    return () => void cancelListeners.delete(l);
  }, []);
  const items = raw.filter((d) => !cancelled.has(keyOf(d)));
  const announced = useRef(new Set<string>());
  useEffect(
    () =>
      on<Download[]>("downloads://update", (list) => {
        setItems(list);
        for (const d of list) {
          const key = `${d.browser}:${d.id}`;
          if (d.state === "complete" && !announced.current.has(key) && !cancelled.has(key)) {
            announced.current.add(key);
            const sentTo = d.browser.startsWith("to:") ? d.browser.slice(3) : null;
            const from = d.browser.startsWith("from:") ? d.browser.slice(5) : null;
            pushBanner({
              id: `dl-${key}`,
              app: sentTo ? `Sent to ${sentTo}` : from ? `Received from ${from}` : "Download complete",
              title: d.name,
              body: [d.total ? fmtBytes(d.total) : "", d.path ? (from ? "Added to Shelf · click to show in folder" : "Click to show in folder") : sentTo ? "" : sourceName(d.browser)].filter(Boolean).join(" · "),
              icon: null,
              glyph: "download",
              file: d.name,
              reveal: d.path || undefined,
              ttl: 7000,
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

/* ---------- file kinds: a coloured tile with a glyph, like Files on iOS ---------- */

type Kind = "video" | "audio" | "image" | "archive" | "pdf" | "doc" | "sheet" | "app" | "torrent" | "file";
const EXT: Record<string, Kind> = {};
const add = (k: Kind, list: string) => list.split(" ").forEach((e) => (EXT[e] = k));
add("video", "mp4 mkv mov avi webm m4v wmv flv ts m2ts 3gp mpg mpeg");
add("audio", "mp3 wav flac m4a aac ogg opus wma alac aiff");
add("image", "jpg jpeg png gif webp heic heif bmp tif tiff svg avif raw psd");
add("archive", "zip rar 7z tar gz bz2 xz tgz zst iso cab");
add("pdf", "pdf");
add("doc", "doc docx txt rtf odt md epub pages ppt pptx key odp");
add("sheet", "xls xlsx csv ods numbers");
add("app", "exe msi msix appx apk dmg pkg deb rpm bat cmd");
add("torrent", "torrent");

const KIND_STYLE: Record<Kind, { from: string; to: string; tint: string }> = {
  video: { from: "#c86bff", to: "#7b3cf0", tint: "#bf5af2" },
  audio: { from: "#ff6482", to: "#e0234d", tint: "#ff375f" },
  image: { from: "#ffb340", to: "#ff7a00", tint: "#ff9f0a" },
  archive: { from: "#c9a26b", to: "#8e6a3d", tint: "#d0a46a" },
  pdf: { from: "#ff6b5e", to: "#d81f13", tint: "#ff453a" },
  doc: { from: "#4ba3ff", to: "#0a63e0", tint: "#0a84ff" },
  sheet: { from: "#3fd06a", to: "#16a34a", tint: "#30d158" },
  app: { from: "#9a9aa2", to: "#5b5b63", tint: "#a1a1aa" },
  torrent: { from: "#5ad8b8", to: "#16a085", tint: "#40c8a0" },
  file: { from: "#5f9bff", to: "#3a5bdc", tint: "#5e8bff" },
};

export function kindOf(name: string): Kind {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return name.includes(".") ? (EXT[ext] ?? "file") : "file";
}
export const tintOf = (name: string) => KIND_STYLE[kindOf(name)].tint;

function KindGlyph({ kind, size }: { kind: Kind; size: number }) {
  const p = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "#fff", strokeWidth: 2.2, strokeLinecap: "round", strokeLinejoin: "round" } as const;
  switch (kind) {
    case "video":
      return (
        <svg {...p}>
          <path d="M8 5.5v13l10.5-6.5z" fill="#fff" />
        </svg>
      );
    case "audio":
      return (
        <svg {...p}>
          <path d="M9.5 17.5V6l9-2v11.5" />
          <circle cx="7" cy="17.5" r="2.5" fill="#fff" stroke="none" />
          <circle cx="16" cy="15.5" r="2.5" fill="#fff" stroke="none" />
        </svg>
      );
    case "image":
      return (
        <svg {...p}>
          <rect x="3.5" y="5" width="17" height="14" rx="3" />
          <circle cx="9" cy="10" r="1.7" fill="#fff" stroke="none" />
          <path d="M4 17l5-4.5 3.5 3 3-2.5 4.5 4" />
        </svg>
      );
    case "archive":
      return (
        <svg {...p} strokeWidth={2}>
          <rect x="5" y="4.5" width="14" height="15" rx="3" />
          <path d="M12 4.5v1.6M12 8.2v1.6M12 11.9v1.6" strokeWidth={2.2} />
          <rect x="10.3" y="13.6" width="3.4" height="3.6" rx="1" fill="#fff" stroke="none" />
        </svg>
      );
    case "pdf":
      return (
        <svg width={size} height={size} viewBox="0 0 24 24">
          <text x="12" y="16" textAnchor="middle" fontSize="8.6" fontWeight="800" fill="#fff" fontFamily="var(--font)" letterSpacing="-0.3">
            PDF
          </text>
        </svg>
      );
    case "doc":
      return (
        <svg {...p}>
          <path d="M7 7h10M7 11h10M7 15h6" />
        </svg>
      );
    case "sheet":
      return (
        <svg {...p} strokeWidth={1.9}>
          <rect x="4.5" y="5" width="15" height="14" rx="2.5" />
          <path d="M4.5 10h15M4.5 14.5h15M10 5v14" />
        </svg>
      );
    case "app":
      return (
        <svg {...p}>
          <rect x="5" y="5" width="6" height="6" rx="1.6" fill="#fff" stroke="none" />
          <rect x="13" y="5" width="6" height="6" rx="1.6" fill="#fff" stroke="none" opacity=".7" />
          <rect x="5" y="13" width="6" height="6" rx="1.6" fill="#fff" stroke="none" opacity=".7" />
          <rect x="13" y="13" width="6" height="6" rx="1.6" fill="#fff" stroke="none" />
        </svg>
      );
    case "torrent":
      return (
        <svg {...p}>
          <path d="M6 4v7a6 6 0 0 0 12 0V4M6 8h3M15 8h3" />
        </svg>
      );
    default:
      return (
        <svg {...p}>
          <path d="M12 5v11M7 11.5l5 5 5-5" />
        </svg>
      );
  }
}

/** The file's tile: rounded square in its kind's colour, with a soft top light. */
export function FileTile({ name, size, done }: { name: string; size: number; done?: boolean }) {
  const kind = kindOf(name);
  const st = KIND_STYLE[kind];
  return (
    <span className="dl-tile" style={{ width: size, height: size, borderRadius: size * 0.28, background: `linear-gradient(160deg, ${st.from}, ${st.to})`, boxShadow: `0 ${size * 0.08}px ${size * 0.35}px ${st.tint}55, inset 0 0.5px 0 rgba(255,255,255,.45)` }}>
      <KindGlyph kind={kind} size={size * 0.6} />
      {done && (
        <motion.span
          className="dl-check"
          style={{ width: size * 0.42, height: size * 0.42 }}
          initial={{ scale: 0, rotate: -40 }}
          animate={{ scale: 1, rotate: 0 }}
          transition={{ type: "spring", stiffness: 520, damping: 22, delay: 0.18 }}
        >
          <svg viewBox="0 0 24 24" width="62%" height="62%" fill="none" stroke="#fff" strokeWidth="3.6" strokeLinecap="round" strokeLinejoin="round">
            <motion.path d="M5 12.5l4.5 4.5L19 7.5" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.35, delay: 0.32, ease: [0.3, 0, 0.2, 1] }} />
          </svg>
        </motion.span>
      )}
    </span>
  );
}

const SOURCE: Record<string, string> = { MDM: "Mister Download Manager", IDM: "Internet Download Manager" };
export const sourceName = (b: string) =>
  b.startsWith("from:") ? `From ${b.slice(5)}` : b.startsWith("to:") ? `To ${b.slice(3)}` : (SOURCE[b] ?? (b ? b[0].toUpperCase() + b.slice(1) : "Browser"));

/* ---------- collapsed island: the file, its name, and a progress ring ---------- */

export function DownloadCompact({ active, width, height }: { active: Download[]; width: number; height: number }) {
  const p = progressOf(active);
  const first = active[0];
  const many = active.length > 1;
  const tint = many ? "#0a84ff" : tintOf(first?.name ?? "");
  const speed = active.reduce((a, d) => a + (d.speed || 0), 0);
  return (
    <div className="row dl-compact" style={{ width, height }}>
      <span className="dl-stack">
        {active.slice(0, many ? 2 : 1).map((d, i) => (
          <span key={d.id} className={many ? "dl-stacked" : undefined} style={{ marginLeft: i ? -11 : 0, zIndex: 2 - i }}>
            <FileTile name={d.name} size={23} />
          </span>
        ))}
      </span>
      <span className="dl-meta">
        <span className="dl-name">{many ? `${active.length} downloads` : first?.name}</span>
        {speed > 0 && <span className="dl-speed">{fmtBytes(speed)}/s</span>}
      </span>
      <span className="row" style={{ gap: 7, flexShrink: 0 }}>
        {p != null && <NumericText className="dl-pct" value={`${Math.floor(p * 100)}%`} dir={1} />}
        <Ring p={p} size={21} color={tint} />
      </span>
    </div>
  );
}

export function DownloadMinimal({ active }: { active: Download[] }) {
  const tint = active.length > 1 ? "#0a84ff" : tintOf(active[0]?.name ?? "");
  return (
    <span style={{ position: "relative", display: "flex" }}>
      <Ring p={progressOf(active)} size={27} color={tint} />
      <span style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: tint }}>
        <ArrowDown size={11} />
      </span>
    </span>
  );
}

function Ring({ p, size, color }: { p: number | null; size: number; color: string }) {
  const sw = 2.8;
  const r = size / 2 - sw / 2 - 0.5;
  const C = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className={p == null ? "spin" : undefined} style={{ overflow: "visible", filter: `drop-shadow(0 0 3px ${color}88)` }}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.14)" strokeWidth={sw} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={sw}
        strokeLinecap="round"
        strokeDasharray={`${C * Math.max(0.02, p ?? 0.25)} ${C}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: "stroke-dasharray 0.6s cubic-bezier(.2,.8,.2,1), stroke 0.3s" }}
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

export function fmtBytes(b: number) {
  if (b >= 1e9) return `${(b / 1e9).toFixed(1)} GB`;
  if (b >= 1e6) return `${(b / 1e6).toFixed(1)} MB`;
  if (b >= 1e3) return `${Math.round(b / 1e3)} KB`;
  return `${b} B`;
}

/* ---------- the open island while downloading: every download, with Cancel ---------- */

const ROW_H = 62;
const HEAD_H = 40;
export function downloadsPanelHeight(n: number) {
  return HEAD_H + Math.min(Math.max(n, 1), 3) * ROW_H + 14;
}

function fmtLeft(sec: number) {
  if (!isFinite(sec) || sec <= 0) return "";
  if (sec < 60) return `${Math.max(1, Math.round(sec))} s left`;
  if (sec < 3600) return `${Math.round(sec / 60)} min left`;
  const h = Math.floor(sec / 3600);
  return `${h} h ${Math.round((sec % 3600) / 60)} min left`;
}

export function DownloadsPanel({ items, width, height }: { items: Download[]; width: number; height: number }) {
  const speed = items.reduce((a, d) => a + (d.state === "in_progress" ? d.speed || 0 : 0), 0);
  const running = items.filter((d) => d.state === "in_progress").length;
  return (
    <div className="dlp" style={{ width, height }}>
      <div className="dlp-head">
        <span className="dlp-title">Downloads</span>
        <span className="dlp-sum">
          {running ? `${running} active` : "Done"}
          {speed > 0 && ` · ${fmtBytes(speed)}/s`}
        </span>
      </div>
      <div className="dlp-list" data-tab-zone="">
        <AnimatePresence initial={false}>
          {items.map((d) => (
            <DownloadRow key={keyOf(d)} d={d} />
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}

function DownloadRow({ d }: { d: Download }) {
  const done = d.state === "complete";
  const pctOnly = d.browser === "IDM"; // IDM reports a percentage, not bytes
  const p = d.total ? Math.min(1, d.received / d.total) : null;
  const tint = tintOf(d.name);
  const left = !done && d.speed && d.total && !pctOnly ? fmtLeft((d.total - d.received) / d.speed) : "";
  const sub = done
    ? [d.total ? fmtBytes(d.total) : "", "Complete"].filter(Boolean).join(" · ")
    : [
        pctOnly ? (p != null ? `${Math.floor(p * 100)}%` : "") : d.total ? `${fmtBytes(d.received)} of ${fmtBytes(d.total)}` : fmtBytes(d.received),
        d.speed ? `${fmtBytes(d.speed)}/s` : "",
        left,
      ]
        .filter(Boolean)
        .join(" · ");
  return (
    <motion.div
      className="dlp-row"
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: -24, transition: { duration: 0.2 } }}
      transition={{ type: "spring", stiffness: 420, damping: 36 }}
      onClick={() => done && d.path && send("reveal_path", { path: d.path })}
      style={{ cursor: done && d.path ? "pointer" : "default" }}
    >
      <FileTile name={d.name} size={40} done={done} />
      <div className="dlp-text">
        <span className="dlp-name">{d.name}</span>
        <span className="dlp-sub">{sub}</span>
        {!done && (
          <span className="dlp-bar">
            <span className={p == null ? "dlp-fill indet" : "dlp-fill"} style={{ width: p == null ? "30%" : `${Math.max(2, p * 100)}%`, background: tint, boxShadow: `0 0 8px ${tint}99` }} />
          </span>
        )}
      </div>
      {done ? (
        d.path && (
          <button
            className="dlp-btn"
            title="Show in folder"
            onClick={(e) => {
              e.stopPropagation();
              send("reveal_path", { path: d.path });
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
              <path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.2h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
            </svg>
          </button>
        )
      ) : (
        <button
          className="dlp-btn cancel"
          title="Cancel download"
          onClick={(e) => {
            e.stopPropagation();
            cancelDownload(d);
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      )}
    </motion.div>
  );
}
