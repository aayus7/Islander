// The full-screen layer shown while you move the island: a soft dim, and glowing spots
// along every edge where it can dock. The spot nearest the cursor lights up; let go to
// drop the island there (Esc cancels).
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { on } from "./lib/native";
import type { Dock, DockAlong } from "./settings-types";

type Spot = { dock: Dock; along: DockAlong };
const SPOTS: Spot[] = (["top", "bottom", "left", "right"] as Dock[]).flatMap((dock) => (["start", "center", "end"] as DockAlong[]).map((along) => ({ dock, along })));

export function Zones() {
  const [active, setActive] = useState<Spot | null>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const a = on<Spot>("move://zone", (z) => {
      setActive(z);
      setShown(true);
    });
    const b = on("move://begin", () => setShown(true));
    const c = on("move://end", () => {
      setShown(false);
      setActive(null);
    });
    return () => {
      a();
      b();
      c();
    };
  }, []);

  // Work area (above the taskbar) inside this full-display window.
  const top = Math.max(0, (window.screen as Screen & { availTop?: number }).availTop ?? 0) - (window.screenTop ?? 0);
  const W = window.innerWidth;
  const H = window.innerHeight;
  const workBottom = Math.min(H, top + window.screen.availHeight);
  const M = 16;
  const LONG = 126;
  const THICK = 37;

  const place = ({ dock, along }: Spot) => {
    const horiz = dock === "top" || dock === "bottom";
    const w = horiz ? LONG : THICK;
    const h = horiz ? THICK : LONG;
    const span = horiz ? W : workBottom - top;
    const at = along === "start" ? M : along === "end" ? span - M - (horiz ? w : h) : (span - (horiz ? w : h)) / 2;
    if (dock === "top") return { left: at, top: 8, w, h };
    if (dock === "bottom") return { left: at, top: workBottom - 8 - h, w, h };
    if (dock === "left") return { left: 8, top: top + at, w, h };
    return { left: W - 8 - w, top: top + at, w, h };
  };

  return (
    <AnimatePresence>
      {shown && (
        <motion.div className="zones" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
          {SPOTS.map((sp) => {
            const p = place(sp);
            const on = active?.dock === sp.dock && active?.along === sp.along;
            return (
              <motion.span
                key={`${sp.dock}-${sp.along}`}
                className={`zone-spot ${on ? "on" : ""}`}
                style={{ left: p.left, top: p.top, width: p.w, height: p.h, borderRadius: Math.min(p.w, p.h) / 2 }}
                initial={false}
                animate={{ scale: on ? 1.12 : 1, opacity: on ? 1 : 0.55 }}
                transition={{ type: "spring", stiffness: 500, damping: 30 }}
              />
            );
          })}
          <div className="zones-hint-wrap">
            <motion.div className="zones-hint" initial={{ y: 10, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ delay: 0.1, type: "spring", stiffness: 300, damping: 26 }}>
              Drop the island on a glowing spot · <b>Esc</b> to cancel
            </motion.div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
