// Clipboard history: recent text, links and images. Click to copy again, drag out
// into any app, pin the ones you keep, delete or clear the rest.
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { isTauri } from "../../bridge";
import { call, on, send } from "../../lib/native";
import { useSettings } from "../../lib/settings";
import { startDragOut } from "./drag";
import { Empty, Glyph, IconButton, ModHeader } from "./ui";

export interface ClipItem {
  id: string;
  kind: "text" | "link" | "image" | "files";
  text: string;
  /** Image thumbnail (data: URL). */
  thumb: string | null;
  /** Full-size image on disk (for dragging out). */
  path: string | null;
  files: string[];
  pinned: boolean;
  at: number;
}

const now = Date.now();
const MOCK: ClipItem[] = [
  { id: "a", kind: "link", text: "https://developer.apple.com/design/human-interface-guidelines/live-activities", thumb: null, path: null, files: [], pinned: true, at: now - 3_600_000 },
  { id: "b", kind: "text", text: "Meeting moved to 3:30 — bring the Q4 numbers and the updated deck.", thumb: null, path: null, files: [], pinned: false, at: now - 60_000 },
  { id: "c", kind: "image", text: "Image · 1920×1080", thumb: null, path: null, files: [], pinned: false, at: now - 300_000 },
  { id: "d", kind: "files", text: "report-final.docx", thumb: null, path: null, files: ["C:\\report-final.docx"], pinned: false, at: now - 900_000 },
];

let cache: ClipItem[] = isTauri ? [] : MOCK;
const subs = new Set<(i: ClipItem[]) => void>();
let wired = false;
function wire() {
  if (wired) return;
  wired = true;
  call<ClipItem[]>("clip_list", undefined, MOCK).then(set).catch(console.error);
  on<ClipItem[]>("clip://changed", set);
}
function set(items: ClipItem[]) {
  cache = items;
  subs.forEach((s) => s(items));
}
export function useClips() {
  const [items, setItems] = useState(cache);
  useEffect(() => {
    wire();
    subs.add(setItems);
    setItems(cache);
    return () => void subs.delete(setItems);
  }, []);
  return items;
}

export function ClipboardPanel({ width, height }: { width: number; height: number }) {
  const { settings } = useSettings();
  const items = useClips();
  const sorted = [...items.filter((i) => i.pinned), ...items.filter((i) => !i.pinned)];
  return (
    <div className="mod" style={{ width, height }}>
      <ModHeader title="Clipboard">
        {items.some((i) => !i.pinned) && (
          <IconButton title="Clear (keeps pinned)" onClick={() => send("clip_clear")}>
            <Glyph.trash size={14} />
          </IconButton>
        )}
      </ModHeader>
      {!settings.clipboardHistory ? (
        <Empty icon={<Glyph.clipboard />} title="Clipboard history is off" sub="Turn it on in Settings → Workspace." />
      ) : sorted.length === 0 ? (
        <Empty icon={<Glyph.clipboard />} title="Nothing copied yet" sub="Text, links and images you copy show up here." />
      ) : (
        <div className="clip-list fade-y">
          <AnimatePresence initial={false}>
            {sorted.map((c) => (
              <ClipRow key={c.id} c={c} />
            ))}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}

function ago(t: number) {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function ClipRow({ c }: { c: ClipItem }) {
  const [copied, setCopied] = useState(false);
  const icon = c.kind === "link" ? <Glyph.link /> : c.kind === "image" ? <Glyph.image /> : c.kind === "files" ? <Glyph.doc size={16} /> : <Glyph.text />;
  const tint = c.kind === "link" ? "#0a84ff" : c.kind === "image" ? "#bf5af2" : c.kind === "files" ? "#64d2ff" : "#8e8e93";
  return (
    <motion.div
      layout
      className="clip-row"
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: -24, transition: { duration: 0.16 } }}
      transition={{ type: "spring", stiffness: 420, damping: 34 }}
      data-no-lift="" onPointerDown={(e) =>
        startDragOut(e, c.kind === "image" && c.path ? { files: [c.path] } : c.kind === "files" ? { files: c.files } : { text: c.text })
      }
      onClick={() => {
        send("clip_copy", { id: c.id });
        setCopied(true);
        setTimeout(() => setCopied(false), 1100);
      }}
      title="Click to copy · drag into any app"
    >
      {c.kind === "image" && c.thumb ? (
        <img className="clip-thumb" src={c.thumb} alt="" draggable={false} />
      ) : (
        <span className="clip-ic" style={{ color: tint }}>
          {icon}
        </span>
      )}
      <span className="clip-text">{c.kind === "link" ? c.text.replace(/^https?:\/\/(www\.)?/, "") : c.text}</span>
      <span className="clip-meta">
        <AnimatePresence mode="popLayout" initial={false}>
          {copied ? (
            <motion.span key="ok" className="clip-copied" initial={{ opacity: 0, scale: 0.6 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}>
              <Glyph.check size={11} /> Copied
            </motion.span>
          ) : (
            <motion.span key="t" className="clip-ago" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              {c.pinned ? (
                <span style={{ color: "#ff9f0a" }}>
                  <Glyph.pinFill size={11} />
                </span>
              ) : (
                ago(c.at)
              )}
            </motion.span>
          )}
        </AnimatePresence>
      </span>
      <span className="clip-actions">
        <button
          className="clip-act"
          title={c.pinned ? "Unpin" : "Pin"}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            send("clip_pin", { id: c.id, pinned: !c.pinned });
          }}
        >
          {c.pinned ? <Glyph.pinFill size={12} /> : <Glyph.pin size={12} />}
        </button>
        <button
          className="clip-act"
          title="Delete"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            send("clip_delete", { id: c.id });
          }}
        >
          <Glyph.x size={10} />
        </button>
      </span>
    </motion.div>
  );
}
