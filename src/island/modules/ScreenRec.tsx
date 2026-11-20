// Screen recording in the island, like iPhone: a 3-2-1 countdown, then a red rim with the
// running time; hover the island for Pause / Resume and Stop.
import { AnimatePresence, motion } from "motion/react";
import { cancelCountdown, fmtElapsed, pauseRecording, resumeRecording, stopRecording, useScreenRec, type RecState } from "../../lib/screenrec";
import { NumericText } from "./ui";

export const REC_RED = "#ff3b30";
/** The hover card while recording. */
export const REC_PANEL = { w: 330, h: 78, r: 39 };
export const COMPACT_REC = { w: 204, h: 37, r: 18.5 };

/** Screen Recording glyph (ring with a dot), as in iOS Control Center. */
export function RecordGlyph({ size = 18, dot = "currentColor" }: { size?: number; dot?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9.2" stroke="currentColor" strokeWidth="2" />
      <circle cx="12" cy="12" r="5.2" fill={dot} />
    </svg>
  );
}

/** Red dot that breathes while recording; pause bars while paused. */
function Dot({ s, size = 10 }: { s: RecState; size?: number }) {
  if (s.phase === "paused")
    return (
      <svg width={size + 2} height={size + 2} viewBox="0 0 12 12">
        <rect x="2" y="1.5" width="2.8" height="9" rx="1" fill={REC_RED} />
        <rect x="7.2" y="1.5" width="2.8" height="9" rx="1" fill={REC_RED} />
      </svg>
    );
  return (
    <motion.span
      style={{ width: size, height: size, borderRadius: "50%", background: REC_RED, display: "block", boxShadow: `0 0 8px ${REC_RED}` }}
      animate={s.phase === "recording" ? { opacity: [1, 0.35, 1] } : { opacity: 1 }}
      transition={s.phase === "recording" ? { duration: 1.6, repeat: Infinity, ease: "easeInOut" } : { duration: 0.2 }}
    />
  );
}

/** The second-activity bubble while recording next to music: the breathing red dot. */
export function RecMinimal() {
  const s = useScreenRec();
  return <Dot s={s} size={12} />;
}

/** Big countdown digit that drops in, iOS-style. */
function Count({ n, size }: { n: number; size: number }) {
  return (
    <span style={{ position: "relative", display: "inline-flex", width: size * 0.7, height: size * 1.2, alignItems: "center", justifyContent: "center" }}>
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={n}
          style={{ fontSize: size, fontWeight: 700, color: REC_RED, fontVariantNumeric: "tabular-nums", lineHeight: 1 }}
          initial={{ opacity: 0, scale: 1.6, filter: "blur(6px)" }}
          animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
          exit={{ opacity: 0, scale: 0.6, filter: "blur(4px)" }}
          transition={{ type: "spring", stiffness: 420, damping: 28 }}
        >
          {n}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

/** The collapsed island while recording (or counting down). */
export function RecCompact({ width, height }: { width: number; height: number }) {
  const s = useScreenRec();
  return (
    <div className="row" style={{ width, height, padding: "0 16px 0 14px", justifyContent: "space-between" }}>
      <span className="row" style={{ gap: 8, color: REC_RED }}>
        {s.phase === "countdown" || s.phase === "starting" ? <RecordGlyph size={17} dot={REC_RED} /> : <Dot s={s} />}
        {s.phase === "paused" && <span style={{ fontSize: 13, fontWeight: 600, opacity: 0.85 }}>Paused</span>}
        {s.phase === "saving" && <span style={{ fontSize: 13, fontWeight: 600, opacity: 0.85 }}>Saving…</span>}
      </span>
      {s.phase === "countdown" ? (
        <Count n={s.count} size={17} />
      ) : (
        <span className="clock-compact-digits" style={{ color: REC_RED }}>
          <NumericText value={fmtElapsed(s.elapsedMs)} dir={1} />
        </span>
      )}
    </div>
  );
}

/** Hovering the island while recording: the time, Pause / Resume and Stop. */
export function RecPanel() {
  const s = useScreenRec();
  const counting = s.phase === "countdown" || s.phase === "starting";
  return (
    <div className="rec-panel" style={{ width: REC_PANEL.w, height: REC_PANEL.h }}>
      <div className="rec-info">
        <span className="rec-title">
          {counting ? <RecordGlyph size={13} dot={REC_RED} /> : <Dot s={s} size={8} />}
          {counting ? "Starting recording" : s.phase === "paused" ? "Paused" : s.phase === "saving" ? "Saving…" : "Screen Recording"}
        </span>
        {s.phase === "countdown" ? (
          <span className="rec-time">
            <Count n={s.count} size={26} />
          </span>
        ) : (
          <span className="rec-time" style={{ color: s.phase === "paused" ? "rgba(255,255,255,0.55)" : "#fff" }}>
            <NumericText value={fmtElapsed(s.elapsedMs)} dir={1} />
          </span>
        )}
      </div>
      <div className="rec-buttons">
        {counting ? (
          <motion.button className="rec-btn wide" whileTap={{ scale: 0.92 }} onClick={(e) => (e.stopPropagation(), cancelCountdown())} title="Cancel">
            Cancel
          </motion.button>
        ) : (
          <>
            <motion.button
              className="rec-btn"
              whileTap={{ scale: 0.88 }}
              disabled={s.phase === "saving"}
              title={s.phase === "paused" ? "Resume" : "Pause"}
              onClick={(e) => {
                e.stopPropagation();
                if (s.phase === "paused") resumeRecording();
                else pauseRecording();
              }}
            >
              {s.phase === "paused" ? (
                <svg width="16" height="16" viewBox="0 0 24 24">
                  <path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.6-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" fill="#fff" />
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24">
                  <rect x="6" y="4.5" width="4.2" height="15" rx="1.4" fill="#fff" />
                  <rect x="13.8" y="4.5" width="4.2" height="15" rx="1.4" fill="#fff" />
                </svg>
              )}
            </motion.button>
            <motion.button className="rec-btn stop" whileTap={{ scale: 0.88 }} disabled={s.phase === "saving"} title="Stop and save" onClick={(e) => (e.stopPropagation(), void stopRecording())}>
              <svg width="14" height="14" viewBox="0 0 24 24">
                <rect x="4" y="4" width="16" height="16" rx="3.5" fill="#fff" />
              </svg>
            </motion.button>
          </>
        )}
      </div>
    </div>
  );
}
