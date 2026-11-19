// The tab dock: a small capsule that floats just under the open island, with an
// icon per tab (replaces the page dots). Click an icon to jump straight there,
// hover for its name, and drag icons sideways to rearrange the tabs — the new
// order is saved.
import { AnimatePresence, motion, Reorder, type MotionValue } from "motion/react";
import { useEffect, useRef, useState } from "react";
import type { ModuleId as SavedTab } from "../settings-types";
/** A saved tab, or the Downloads page that appears while something downloads. */
type ModuleId = SavedTab | "downloads";

export const DOCK_GAP = 8;
export const DOCK_H = 38;
const ITEM = 30;

const NAMES: Record<ModuleId, string> = {
  ai: "Ask",
  media: "Now Playing",
  controls: "Controls",
  today: "Today",
  weather: "Weather",
  clock: "Clock",
  notes: "Notes",
  shelf: "Shelf",
  clipboard: "Clipboard",
  stats: "Performance",
  downloads: "Downloads",
};

export function TabDock({
  tabs,
  active,
  top,
  fill,
  onSelect,
  onReorder,
  onWheel,
}: {
  tabs: ModuleId[];
  active: ModuleId;
  top: MotionValue<number>;
  fill: string;
  onSelect(t: ModuleId): void;
  onReorder(order: ModuleId[]): void;
  /** Scrolling over the dock flips tabs, whatever the page above is doing. */
  onWheel?(dx: number, dy: number): void;
}) {
  const [order, setOrder] = useState(tabs);
  const [hover, setHover] = useState<ModuleId | null>(null);
  const [dragging, setDragging] = useState<ModuleId | null>(null);
  const moved = useRef(false);
  const orderRef = useRef(order);
  orderRef.current = order;
  // Follow settings changes (tabs turned on/off) unless mid-drag.
  useEffect(() => {
    if (!dragging) setOrder(tabs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs.join()]);

  const label = dragging ? NAMES[dragging] : hover ? NAMES[hover] : null;

  return (
    <motion.div
      className="dock-wrap"
      style={{ top }}
      initial={{ opacity: 0, y: -12, scale: 0.86 }}
      animate={{ opacity: 1, y: 0, scale: 1, transition: { type: "spring", stiffness: 420, damping: 30, delay: 0.08 } }}
      exit={{ opacity: 0, y: -10, scale: 0.9, transition: { duration: 0.14 } }}
      onPointerLeave={() => setHover(null)}
      onWheel={(e) => {
        e.stopPropagation();
        onWheel?.(e.deltaX, e.deltaY);
      }}
    >
      <div className="dock" style={{ background: fill, height: DOCK_H }}>
        {/* The highlight slides between icons (follows its tab while you rearrange). */}
        <motion.span
          className="dock-active"
          style={{ width: ITEM, height: ITEM }}
          initial={false}
          animate={{ x: Math.max(0, order.indexOf(active)) * (ITEM + 2), opacity: order.includes(active) ? 1 : 0 }}
          transition={{ type: "spring", stiffness: 520, damping: 38 }}
        />
        <Reorder.Group
          as="div"
          axis="x"
          values={order}
          onReorder={(o) => {
            moved.current = true;
            setOrder(o);
          }}
          className="dock-row"
        >
          {order.map((t) => (
            <Reorder.Item
              as="div"
              key={t}
              value={t}
              className="dock-item"
              style={{ width: ITEM, height: ITEM }}
              whileDrag={{ scale: 1.22, zIndex: 2 }}
              dragElastic={0.12}
              dragTransition={{ bounceStiffness: 500, bounceDamping: 30 }}
              layout="position"
              transition={{ type: "spring", stiffness: 520, damping: 36 }}
              onDragStart={() => {
                moved.current = false;
                setDragging(t);
              }}
              onDragEnd={() => {
                setDragging(null);
                if (moved.current) onReorder(orderRef.current);
                // Swallow the click that follows a drag.
                window.setTimeout(() => (moved.current = false), 0);
              }}
              onHoverStart={() => setHover(t)}
              onHoverEnd={() => setHover((h) => (h === t ? null : h))}
              onClick={(e) => {
                e.stopPropagation();
                if (!moved.current) onSelect(t);
              }}
            >
              <motion.span
                className="dock-ic"
                animate={{ scale: hover === t && !dragging ? 1.16 : 1, color: t === active ? "#ffffff" : hover === t ? "rgba(235,235,245,0.9)" : "rgba(235,235,245,0.5)" }}
                transition={{ type: "spring", stiffness: 520, damping: 28, color: { duration: 0.15 } }}
              >
                <TabGlyph tab={t} />
              </motion.span>
            </Reorder.Item>
          ))}
        </Reorder.Group>
      </div>
      <AnimatePresence>
        {label && (
          <motion.span
            key="label"
            className="dock-label"
            initial={{ opacity: 0, y: -4, filter: "blur(3px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            exit={{ opacity: 0, y: -4, filter: "blur(3px)", transition: { duration: 0.12 } }}
            transition={{ duration: 0.16 }}
          >
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span key={label} initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -5 }} transition={{ duration: 0.14 }}>
                {dragging ? `Move ${label}` : label}
              </motion.span>
            </AnimatePresence>
          </motion.span>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

/** One glyph per tab, drawn in the same SF-Symbols-like style as the rest. */
export function TabGlyph({ tab, size = 17 }: { tab: ModuleId; size?: number }) {
  const s = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" } as const;
  switch (tab) {
    case "ai":
      return (
        <svg {...s} fill="currentColor" stroke="none">
          <path d="M11 2.5c.5 4.6 2.9 7 7.5 7.5-4.6.5-7 2.9-7.5 7.5-.5-4.6-2.9-7-7.5-7.5 4.6-.5 7-2.9 7.5-7.5z" />
          <path d="M18.5 14.5c.25 2 1.25 3 3.25 3.25-2 .25-3 1.25-3.25 3.25-.25-2-1.25-3-3.25-3.25 2-.25 3-1.25 3.25-3.25z" />
        </svg>
      );
    case "media":
      return (
        <svg {...s}>
          <path d="M9 18V5.5l11-2V16" />
          <circle cx="6.5" cy="18" r="2.6" fill="currentColor" />
          <circle cx="17.5" cy="16" r="2.6" fill="currentColor" />
        </svg>
      );
    case "controls":
      return (
        <svg {...s}>
          <rect x="3" y="4.5" width="18" height="6" rx="3" />
          <circle cx="15" cy="7.5" r="1.6" fill="currentColor" />
          <rect x="3" y="13.5" width="18" height="6" rx="3" />
          <circle cx="9" cy="16.5" r="1.6" fill="currentColor" />
        </svg>
      );
    case "today":
      return (
        <svg {...s}>
          <rect x="3.5" y="5" width="17" height="15.5" rx="3.2" />
          <path d="M3.5 10h17M8 3v4M16 3v4" />
          <circle cx="12" cy="15" r="1.4" fill="currentColor" stroke="none" />
        </svg>
      );
    case "weather":
      return (
        <svg {...s}>
          <circle cx="8.5" cy="8.5" r="3.2" />
          <path d="M8.5 2.5v1M2.5 8.5h1M4.3 4.3l.7.7M12.7 4.3l-.7.7" />
          <path d="M8 19.5h9.5a3.6 3.6 0 0 0 .4-7.2 5.2 5.2 0 0 0-9.9 1.3A3 3 0 0 0 8 19.5z" fill="currentColor" stroke="none" />
        </svg>
      );
    case "clock":
      return (
        <svg {...s}>
          <circle cx="12" cy="13" r="8" />
          <path d="M12 9v4l2.6 2M10 2.5h4" />
        </svg>
      );
    case "notes":
      return (
        <svg {...s}>
          <path d="M9 6.5h11M9 12h11M9 17.5h11" />
          <path d="M3.8 6.6l1.2 1.2 2-2.2" strokeWidth="1.8" />
          <circle cx="5" cy="12" r="1.2" fill="currentColor" stroke="none" />
          <circle cx="5" cy="17.5" r="1.2" fill="currentColor" stroke="none" />
        </svg>
      );
    case "shelf":
      return (
        <svg {...s}>
          <path d="M3.5 13.5l2.6-7.2A2 2 0 0 1 8 5h8a2 2 0 0 1 1.9 1.3l2.6 7.2V18a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
          <path d="M3.5 13.5h4.6l1.4 2.5h5l1.4-2.5h4.6" />
        </svg>
      );
    case "clipboard":
      return (
        <svg {...s}>
          <rect x="5" y="4.5" width="14" height="16.5" rx="2.6" />
          <path d="M9 4.5V3.6c0-.6.4-1.1 1-1.1h4c.6 0 1 .5 1 1.1v.9M9 10h6M9 14h6M9 18h3.5" />
        </svg>
      );
    case "stats":
      return (
        <svg {...s}>
          <path d="M3 12h3.5l2.5-6 4 12 3-8 1.5 2H21" />
        </svg>
      );
    case "downloads":
      return (
        <svg {...s}>
          <path d="M12 3.5v12M6.5 10.5l5.5 5.5 5.5-5.5M5 20.5h14" />
        </svg>
      );
  }
}
