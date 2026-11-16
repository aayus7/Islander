// Shared iOS-style building blocks for the island's modules.
import { AnimatePresence, motion } from "motion/react";
import { useId, useRef } from "react";

/** iOS segmented control: grey track, a raised thumb that slides between segments. */
export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange(v: T): void }) {
  const id = useId();
  return (
    <div className="seg" onClick={(e) => e.stopPropagation()}>
      {options.map((o) => (
        <button key={o.value} className={`seg-item ${o.value === value ? "on" : ""}`} onClick={() => onChange(o.value)}>
          {o.value === value && <motion.span layoutId={`seg-${id}`} className="seg-thumb" transition={{ type: "spring", stiffness: 500, damping: 38 }} />}
          <span className="seg-label">{o.label}</span>
        </button>
      ))}
    </div>
  );
}

/** Small round icon button (grey glass), used in module headers. */
export function IconButton({ title, onClick, children, tone }: { title: string; onClick(): void; children: React.ReactNode; tone?: "danger" }) {
  return (
    <motion.button
      className={`icon-btn ${tone ?? ""}`}
      title={title}
      whileTap={{ scale: 0.88 }}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      {children}
    </motion.button>
  );
}

/** Module header: title on the left, actions on the right. */
export function ModHeader({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="mod-head">
      <span className="mod-title">{title}</span>
      <div className="row" style={{ gap: 6 }}>
        {children}
      </div>
    </div>
  );
}

export function Empty({ icon, title, sub }: { icon: React.ReactNode; title: string; sub?: string }) {
  return (
    <div className="empty">
      <div className="empty-ic">{icon}</div>
      <div className="col" style={{ gap: 2 }}>
        <span className="empty-title">{title}</span>
        {sub && <span className="empty-sub">{sub}</span>}
      </div>
    </div>
  );
}

/* ---- SF-Symbols-like glyphs (drawn, so they work without Apple fonts) ---- */

type G = { size?: number };
const stroke = (size: number, children: React.ReactNode, sw = 2) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">
    {children}
  </svg>
);

export const Glyph = {
  trash: ({ size = 15 }: G) => stroke(size, <><path d="M4 7h16M9.5 7V4.8h5V7M6.2 7l.9 12.2a1.6 1.6 0 0 0 1.6 1.5h6.6a1.6 1.6 0 0 0 1.6-1.5L17.8 7" /><path d="M10 11v6M14 11v6" /></>),
  x: ({ size = 13 }: G) => stroke(size, <path d="M6 6l12 12M18 6L6 18" />, 2.4),
  pin: ({ size = 14 }: G) => stroke(size, <><path d="M15.5 3.5l5 5-3 1.2-3.6 3.6.4 4.2-1.6 1.6-4-4-4.8 4.8M8.7 11.1l4.2 4.2M14.3 4.7l5 5" /></>),
  pinFill: ({ size = 14 }: G) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M15.2 2.8a1 1 0 0 1 1.4 0l4.6 4.6a1 1 0 0 1 0 1.4l-2.7 1.1-3.3 3.3.3 4a1 1 0 0 1-.3.8l-1 1a1 1 0 0 1-1.4 0l-3.5-3.5-4.6 4.6a1 1 0 0 1-1.4-1.4L8 14.1l-3.5-3.5a1 1 0 0 1 0-1.4l1-1a1 1 0 0 1 .8-.3l4 .3 3.3-3.3z" />
    </svg>
  ),
  copy: ({ size = 14 }: G) => stroke(size, <><rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2.6" /><path d="M15.5 8.5V6.6A2.6 2.6 0 0 0 12.9 4H6.6A2.6 2.6 0 0 0 4 6.6v6.3a2.6 2.6 0 0 0 2.6 2.6h1.9" /></>),
  open: ({ size = 14 }: G) => stroke(size, <><path d="M14 4h6v6M20 4l-8.5 8.5" /><path d="M18 14v4.4a1.6 1.6 0 0 1-1.6 1.6H5.6A1.6 1.6 0 0 1 4 18.4V7.6A1.6 1.6 0 0 1 5.6 6H10" /></>),
  plus: ({ size = 15 }: G) => stroke(size, <path d="M12 5v14M5 12h14" />, 2.4),
  tray: ({ size = 22 }: G) => stroke(size, <><path d="M3.5 13.5l2.6-7.2A2 2 0 0 1 8 5h8a2 2 0 0 1 1.9 1.3l2.6 7.2V18a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" /><path d="M3.5 13.5h4.6l1.4 2.5h5l1.4-2.5h4.6" /></>, 1.8),
  clipboard: ({ size = 22 }: G) => stroke(size, <><rect x="5" y="4.5" width="14" height="16.5" rx="2.6" /><path d="M9 4.5V3.6c0-.6.4-1.1 1-1.1h4c.6 0 1 .5 1 1.1v.9M9 10h6M9 14h6M9 18h3.5" /></>, 1.8),
  doc: ({ size = 18 }: G) => stroke(size, <><path d="M14 3H7.5A2.5 2.5 0 0 0 5 5.5v13A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V8z" /><path d="M14 3v5h5" /></>, 1.8),
  folder: ({ size = 18 }: G) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M3 7.2A2.2 2.2 0 0 1 5.2 5h4.1a2 2 0 0 1 1.5.7l1.3 1.5h6.7A2.2 2.2 0 0 1 21 9.4v8.4a2.2 2.2 0 0 1-2.2 2.2H5.2A2.2 2.2 0 0 1 3 17.8z" />
    </svg>
  ),
  link: ({ size = 16 }: G) => stroke(size, <><path d="M10 14a4.2 4.2 0 0 0 6 0l3.1-3.1a4.2 4.2 0 0 0-6-6L11.6 6.4" /><path d="M14 10a4.2 4.2 0 0 0-6 0l-3.1 3.1a4.2 4.2 0 0 0 6 6l1.5-1.5" /></>),
  text: ({ size = 16 }: G) => stroke(size, <path d="M5 6.5h14M5 11h14M5 15.5h9" />),
  image: ({ size = 16 }: G) => stroke(size, <><rect x="3.5" y="4.5" width="17" height="15" rx="2.6" /><circle cx="9" cy="10" r="1.7" /><path d="M20.5 15.5l-4.6-4.6L7 19.5" /></>),
  check: ({ size = 14 }: G) => stroke(size, <path d="M5 12.5l4.5 4.5L19 7.5" />, 2.6),
  gear: ({ size = 16 }: G) => stroke(size, <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" /></>, 1.7),
};

/**
 * iOS 17 `.contentTransition(.numericText())`: each digit that changes rolls
 * vertically (up when the number grows, down when it shrinks) with a soft blur,
 * while unchanged digits stay perfectly still.
 */
export function NumericText({ value, dir, className, style }: { value: string; dir?: number; className?: string; style?: React.CSSProperties }) {
  const prev = useRef(value);
  const lastDir = useRef(1);
  if (prev.current !== value) {
    if (dir != null) lastDir.current = dir >= 0 ? 1 : -1;
    else {
      const a = parseFloat(prev.current.replace(/[^\d.-]/g, ""));
      const b = parseFloat(value.replace(/[^\d.-]/g, ""));
      if (!Number.isNaN(a) && !Number.isNaN(b) && a !== b) lastDir.current = b > a ? 1 : -1;
    }
    prev.current = value;
  }
  const d = lastDir.current;
  const chars = [...value];
  return (
    <span className={`numeric ${className ?? ""}`} style={style} aria-label={value}>
      {chars.map((ch, i) => {
        // Key from the right so "9" → "10" keeps the ones digit in place.
        const slot = chars.length - i;
        return (
          <span key={slot} className="num-slot">
            <AnimatePresence mode="popLayout" initial={false} custom={d}>
              <motion.span
                key={ch}
                className="num-ch"
                custom={d}
                variants={{
                  enter: (k: number) => ({ y: k > 0 ? "70%" : "-70%", opacity: 0, filter: "blur(3px)" }),
                  center: { y: "0%", opacity: 1, filter: "blur(0px)" },
                  exit: (k: number) => ({ y: k > 0 ? "-70%" : "70%", opacity: 0, filter: "blur(3px)" }),
                }}
                initial="enter"
                animate="center"
                exit="exit"
                transition={{ type: "spring", stiffness: 420, damping: 34, mass: 0.8, opacity: { duration: 0.18 } }}
              >
                {ch}
              </motion.span>
            </AnimatePresence>
          </span>
        );
      })}
    </span>
  );
}
