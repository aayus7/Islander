// The island's vertical form, for when it lives on the left or right edge of the screen:
// the collapsed live activities stacked top-to-bottom in a slim pill. (Opened panels,
// banners and AI keep their normal layout and slide out from that edge.)
import { motion } from "motion/react";
import type { MediaSession } from "../bridge";
import { useArtColor, useNow } from "../lib/hooks";
import { display, fmtClock, useClock } from "../lib/timer";
import { ClockMinimal } from "./modules/Clock";
import { fmtElapsed, useScreenRec } from "../lib/screenrec";
import { RecordGlyph, REC_RED } from "./modules/ScreenRec";
import { DownloadMinimal, FileTile, progressOf, type Download } from "./modules/Downloads";
import { Speaker, Sun, type HudData } from "./modules/Hud";
import { Artwork, Waveform } from "./parts";

/** Sizes of the vertical pill (w × h) for each collapsed form. */
export const SIDE = {
  compact: { w: 37, h: 112, r: 18.5 },
  hud: { w: 37, h: 168, r: 18.5 },
  pill: { w: 37, h: 110, r: 18.5 },
};

export function MediaCompactV({ session }: { session: MediaSession }) {
  const color = useArtColor(session.artwork ?? session.icon ?? null, session.app);
  return (
    <div className="side-col" style={{ width: SIDE.compact.w, height: SIDE.compact.h }}>
      <Artwork src={session.artwork} size={25} radius={7} />
      <Waveform playing={session.playing} color={color} bars={5} height={15} barWidth={2.6} gap={2} />
    </div>
  );
}

export function ClockCompactV() {
  const s = useClock();
  useNow(s.running, 250);
  const color = s.kind === "stopwatch" ? "#ffd60a" : s.kind === "focus" && s.phase === "break" ? "#30d158" : "#ff9f0a";
  const t = fmtClock(display(s), { tenths: false });
  return (
    <div className="side-col" style={{ width: SIDE.compact.w, height: SIDE.compact.h }}>
      <ClockMinimal />
      <span className="side-time" style={{ color }}>
        {t.split(":").map((part, i) => (
          <span key={i}>{part}</span>
        ))}
      </span>
    </div>
  );
}

export function DownloadCompactV({ active }: { active: Download[] }) {
  const p = progressOf(active);
  return (
    <div className="side-col" style={{ width: SIDE.compact.w, height: SIDE.compact.h }}>
      <FileTile name={active[0]?.name ?? ""} size={24} />
      <span className="side-pct">{p == null ? "…" : `${Math.floor(p * 100)}`}</span>
      <DownloadMinimal active={active} />
    </div>
  );
}

/** Volume / brightness: the icon on top, a vertical level bar filling upward. */
export function HudV({ hud }: { hud: HudData }) {
  const v = hud.kind === "volume" && hud.on ? 0 : hud.value;
  return (
    <div className="side-col" style={{ width: SIDE.hud.w, height: SIDE.hud.h, justifyContent: "flex-start", gap: 12, paddingTop: 12 }}>
      <span className="hud-icon">{hud.kind === "volume" ? <Speaker level={v} muted={hud.on} /> : <Sun />}</span>
      <div className="side-bar">
        <motion.div className="side-fill" initial={false} animate={{ height: `${Math.round(v * 100)}%` }} transition={{ type: "spring", stiffness: 600, damping: 40 }} />
      </div>
    </div>
  );
}

/** Screen recording on a side edge: the record glyph over the running time (or countdown). */
export function RecCompactV() {
  const s = useScreenRec();
  const t = s.phase === "countdown" ? String(s.count) : fmtElapsed(s.elapsedMs);
  return (
    <div className="side-col" style={{ width: SIDE.compact.w, height: SIDE.compact.h, color: REC_RED }}>
      <RecordGlyph size={19} dot={REC_RED} />
      <span className="side-time" style={{ color: REC_RED }}>
        {t.split(":").map((part, i) => (
          <span key={i}>{part}</span>
        ))}
      </span>
    </div>
  );
}
