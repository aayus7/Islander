// File Shelf: drop files/folders/images on the island to stash them, then drag them
// out into any app. Like macOS's Dropover / the iPad shelf, in the island's style.
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { bridge, isTauri } from "../../bridge";
import { call, on, send } from "../../lib/native";
import { Empty, Glyph, IconButton, ModHeader } from "./ui";
import { startDragOut } from "./drag";

export interface ShelfItem {
  id: string;
  path: string;
  name: string;
  kind: "file" | "folder" | "image";
  size: number;
  /** Image thumbnail or the file type's icon (data: URL). */
  thumb: string | null;
  ext: string;
}

const MOCK: ShelfItem[] = [
  { id: "1", path: "C:\\Users\\you\\Pictures\\sunset.png", name: "sunset.png", kind: "image", size: 2_400_000, thumb: null, ext: "png" },
  { id: "2", path: "C:\\Users\\you\\Documents\\Invoice March.pdf", name: "Invoice March.pdf", kind: "file", size: 180_000, thumb: null, ext: "pdf" },
  { id: "3", path: "C:\\Users\\you\\Projects", name: "Projects", kind: "folder", size: 0, thumb: null, ext: "" },
];

let cache: ShelfItem[] = isTauri ? [] : MOCK;
const subs = new Set<(i: ShelfItem[]) => void>();
let wired = false;
function wire() {
  if (wired) return;
  wired = true;
  call<ShelfItem[]>("shelf_list", undefined, MOCK).then(set).catch(console.error);
  on<ShelfItem[]>("shelf://changed", set);
}
function set(items: ShelfItem[]) {
  cache = items;
  subs.forEach((s) => s(items));
}
export function useShelf() {
  const [items, setItems] = useState(cache);
  useEffect(() => {
    wire();
    subs.add(setItems);
    setItems(cache);
    return () => void subs.delete(setItems);
  }, []);
  return items;
}

/**
 * Native file drops onto the island window. Returns true while files hover over it.
 * `onEnter` lets the island open the shelf as soon as something is dragged over it.
 */
export function useShelfDrop(onEnter: () => void) {
  const [over, setOver] = useState(false);
  useEffect(() => {
    if (!isTauri) return;
    let un: (() => void) | undefined;
    let alive = true;
    import("@tauri-apps/api/webview").then(({ getCurrentWebview }) => {
      getCurrentWebview()
        .onDragDropEvent((e) => {
          const p = e.payload;
          if (p.type !== "over") bridge.log(`shelf drag ${p.type}${"paths" in p ? ` (${p.paths.length} item(s))` : ""}`);
          if (p.type === "enter") {
            setOver(true);
            onEnter();
          } else if (p.type === "leave") {
            setOver(false);
          } else if (p.type === "drop") {
            setOver(false);
            if (p.paths.length) {
              // The Controls tab turns drops into launcher pins; everywhere else they go to the shelf.
              const handled = !window.dispatchEvent(new CustomEvent("island:drop", { detail: p.paths, cancelable: true }));
              if (!handled) send("shelf_add", { paths: p.paths });
            }
          }
        })
        .then((u) => (alive ? (un = u) : u()));
    });
    return () => {
      alive = false;
      un?.();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return over;
}

export function ShelfPanel({ width, height, dragging }: { width: number; height: number; dragging: boolean }) {
  const items = useShelf();
  const [actionsFor, setActionsFor] = useState<string | null>(null);
  const target = items.find((i) => i.id === actionsFor) ?? null;
  const [elevated, setElevated] = useState(false);
  useEffect(() => {
    call<boolean>("shelf_elevated", undefined, false).then(setElevated).catch(() => {});
  }, []);
  return (
    <div className="mod" style={{ width, height }}>
      <ModHeader title="Shelf">
        {items.length > 0 && (
          <IconButton title="Clear shelf" onClick={() => send("shelf_clear")}>
            <Glyph.trash size={14} />
          </IconButton>
        )}
      </ModHeader>
      <div className={`shelf-zone ${dragging ? "over" : ""}`}>
        <AnimatePresence>
          {dragging && (
            <motion.div
              className="drop-hint"
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.96 }}
              transition={{ type: "spring", stiffness: 420, damping: 32 }}
            >
              <Glyph.tray size={26} />
              <span>Drop to add to Shelf</span>
            </motion.div>
          )}
        </AnimatePresence>
        {items.length === 0 && !dragging ? (
          elevated ? (
            <Empty icon={<Glyph.tray />} title="Drops are blocked" sub="Island is running as administrator, and Windows blocks drag-and-drop into admin apps. Restart it normally." />
          ) : (
            <Empty icon={<Glyph.tray />} title="Drop files here" sub="Stash files, folders or images, then drag them out anywhere." />
          )
        ) : (
          <div className="shelf-strip">
            <AnimatePresence initial={false}>
              {items.map((it) => (
                <ShelfTile key={it.id} it={it} onMore={() => setActionsFor(it.id)} />
              ))}
            </AnimatePresence>
          </div>
        )}
        <AnimatePresence>{target && <ActionSheet it={target} onClose={() => setActionsFor(null)} />}</AnimatePresence>
      </div>
    </div>
  );
}

/**
 * Actions for one shelf item, as a sheet that covers the shelf (it can't be cut off by
 * the scrolling row or the island's edge): the file up top, then rounded action buttons.
 */
export function ActionSheet({ it, onClose }: { it: ShelfItem; onClose(): void }) {
  const isImg = it.kind === "image";
  const act = (cmd: string, args: Record<string, unknown> = {}) => {
    send(cmd, { id: it.id, ...args });
    onClose();
  };
  return (
    <motion.div
      className="sheet"
      initial={{ opacity: 0, y: 14, scale: 0.97, filter: "blur(6px)" }}
      animate={{ opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }}
      exit={{ opacity: 0, y: 10, scale: 0.98, filter: "blur(4px)", transition: { duration: 0.14 } }}
      transition={{ type: "spring", stiffness: 420, damping: 34, opacity: { duration: 0.18 } }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="sheet-head">
        <div className="sheet-thumb">
          {it.thumb ? <img src={it.thumb} alt="" draggable={false} /> : it.kind === "folder" ? <span style={{ color: "#64d2ff" }}><Glyph.folder size={22} /></span> : <FileBadge ext={it.ext} />}
        </div>
        <span className="sheet-name">{it.name}</span>
        <button
          className="sheet-close"
          title="Close"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
        >
          <Glyph.x size={10} />
        </button>
      </div>
      <div className="sheet-actions">
        <SheetButton label="Open" onClick={() => act("shelf_open")} />
        <SheetButton label="Show in Explorer" onClick={() => act("shelf_reveal")} />
        {isImg && it.ext !== "jpg" && it.ext !== "jpeg" && <SheetButton label="To JPG" onClick={() => act("shelf_convert", { format: "jpg" })} />}
        {isImg && it.ext !== "png" && <SheetButton label="To PNG" onClick={() => act("shelf_convert", { format: "png" })} />}
        {isImg && it.ext !== "webp" && <SheetButton label="To WebP" onClick={() => act("shelf_convert", { format: "webp" })} />}
        <SheetButton label="Remove" danger onClick={() => act("shelf_remove")} />
      </div>
    </motion.div>
  );
}

function SheetButton({ label, onClick, danger }: { label: string; onClick(): void; danger?: boolean }) {
  return (
    <motion.button
      className={`sheet-btn ${danger ? "danger" : ""}`}
      whileTap={{ scale: 0.94 }}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      {label}
    </motion.button>
  );
}

function ShelfTile({ it, onMore }: { it: ShelfItem; onMore(): void }) {
  const isImg = it.kind === "image";
  return (
    <motion.div
      layout
      className="tile"
      initial={{ opacity: 0, scale: 0.6, filter: "blur(6px)" }}
      animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
      exit={{ opacity: 0, scale: 0.6, filter: "blur(6px)", transition: { duration: 0.18 } }}
      transition={{ type: "spring", stiffness: 380, damping: 28 }}
      onPointerDown={(e) => startDragOut(e, { files: [it.path] })}
      onDoubleClick={() => send("shelf_open", { id: it.id })}
      title={it.path}
    >
      <div className={`tile-thumb ${isImg ? "img" : ""}`}>
        {it.thumb ? <img src={it.thumb} alt="" draggable={false} /> : it.kind === "folder" ? <span style={{ color: "#64d2ff" }}><Glyph.folder size={34} /></span> : <FileBadge ext={it.ext} />}
      </div>
      <span className="tile-name">{it.name}</span>

      {/* hover actions */}
      <div className="tile-actions">
        <button
          className="tile-act"
          title="Remove"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            send("shelf_remove", { id: it.id });
          }}
        >
          <Glyph.x size={9} />
        </button>
        <button
          className="tile-act"
          title="Actions"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onMore();
          }}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="5" cy="12" r="2.2" />
            <circle cx="12" cy="12" r="2.2" />
            <circle cx="19" cy="12" r="2.2" />
          </svg>
        </button>
      </div>
    </motion.div>
  );
}

/** Generic document icon with the extension, like Finder/Files when there's no thumbnail. */
export function FileBadge({ ext }: { ext: string }) {
  const hue = [...ext].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 210);
  return (
    <svg width="34" height="42" viewBox="0 0 34 42">
      <path d="M4 0h18l12 12v26a4 4 0 0 1-4 4H4a4 4 0 0 1-4-4V4a4 4 0 0 1 4-4z" fill="#f2f2f7" />
      <path d="M22 0l12 12h-8a4 4 0 0 1-4-4z" fill="#c7c7cc" />
      <rect x="4" y="26" width="26" height="11" rx="3" fill={`hsl(${hue}, 70%, 52%)`} />
      <text x="17" y="34.2" textAnchor="middle" fontSize="7.4" fontWeight="700" fill="#fff" fontFamily="-apple-system, Inter, Segoe UI, sans-serif">
        {(ext || "FILE").slice(0, 4).toUpperCase()}
      </text>
    </svg>
  );
}
