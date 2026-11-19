// Timer · Stopwatch · Focus — styled after iOS Clock: segmented control, large thin
// tabular digits, and the round tinted Start/Pause/Cancel buttons.
import { AnimatePresence, motion } from "motion/react";
import { useNow } from "../../lib/hooks";
import { gestureOf, markScrolled } from "../../lib/wheel";
import { clockActions, display, fmtClock, totalMs, useClock, type ClockKind } from "../../lib/timer";
import { ModeSwitch, NumericText, Segmented } from "./ui";

const ORANGE = "#ff9f0a";
const GREEN = "#30d158";
const RED = "#ff453a";
const PRESETS = [1, 3, 5, 10, 15, 25, 45];

export function ClockPanel({ width, height }: { width: number; height: number }) {
  const s = useClock();
  useNow(s.running, s.kind === "stopwatch" ? 50 : 200);
  const ms = display(s);
  const idle = !s.running && s.banked === 0;
  const color = s.kind === "stopwatch" ? "#fff" : s.kind === "focus" && s.phase === "break" ? GREEN : ORANGE;

  return (
    <div className="mod" style={{ width, height }}>
      <Segmented<ClockKind>
        value={s.kind}
        onChange={clockActions.setKind}
        options={[
          { value: "timer", label: "Timer" },
          { value: "stopwatch", label: "Stopwatch" },
          { value: "focus", label: "Focus" },
        ]}
      />

      <ModeSwitch k={s.kind} index={["timer", "stopwatch", "focus"].indexOf(s.kind)}>
        <div className="clock-main">
          <div className="col" style={{ minWidth: 0 }}>
            <span className="clock-caption">
              {s.kind === "timer" ? (idle ? "Ready" : "Timer") : s.kind === "stopwatch" ? (s.laps.length ? `Lap ${s.laps.length + 1}` : "Stopwatch") : s.phase === "focus" ? "Focus" : "Break"}
            </span>
            <motion.span className="clock-digits" animate={{ color: idle && s.kind !== "stopwatch" ? "#fff" : color }} transition={{ duration: 0.3 }}>
              <NumericText value={fmtClock(ms, { tenths: s.kind === "stopwatch" })} dir={s.kind === "stopwatch" ? 1 : s.running ? -1 : undefined} />
            </motion.span>
          </div>
          <div className="row" style={{ gap: 12 }}>
            {s.kind === "stopwatch" ? (
              <RoundButton tone="grey" disabled={idle} onClick={() => (s.running ? clockActions.lap() : clockActions.reset())}>
                {s.running || idle ? "Lap" : "Reset"}
              </RoundButton>
            ) : s.kind === "focus" ? (
              <RoundButton tone="grey" disabled={idle && s.rounds === 0} onClick={() => (s.running ? clockActions.skip() : clockActions.reset())}>
                {s.running ? "Skip" : "Reset"}
              </RoundButton>
            ) : (
              <RoundButton tone="grey" disabled={idle} onClick={clockActions.reset}>
                Cancel
              </RoundButton>
            )}
            <RoundButton tone={s.running ? (s.kind === "stopwatch" ? "red" : "orange") : "green"} onClick={clockActions.toggle}>
              {s.running ? (s.kind === "stopwatch" ? "Stop" : "Pause") : idle ? "Start" : "Resume"}
            </RoundButton>
          </div>
        </div>

        <div className="clock-foot">
          {s.kind === "timer" && (
            <div className="chips" {...hScroll}>
              {PRESETS.map((m) => (
                <motion.button
                  key={m}
                  className={`chip ${s.timerMs === m * 60_000 ? "on" : ""}`}
                  whileTap={{ scale: 0.92 }}
                  onClick={(e) => {
                    e.stopPropagation();
                    clockActions.setTimer(m * 60_000);
                  }}
                >
                  {m} min
                </motion.button>
              ))}
            </div>
          )}
          {s.kind === "stopwatch" && (
            <div className="laps">
              {s.laps.length === 0 ? (
                <span className="dim">Laps appear here</span>
              ) : (
                s.laps.slice(0, 3).map((t, i) => (
                  <span key={s.laps.length - i} className="lap">
                    <span className="dim">Lap {s.laps.length - i}</span>
                    <span>{fmtClock(t - (s.laps[i + 1] ?? 0), { tenths: true })}</span>
                  </span>
                ))
              )}
            </div>
          )}
          {s.kind === "focus" && (
            <div className="row" style={{ gap: 10, width: "100%" }}>
              <div className="row" style={{ gap: 6 }}>
                {[0, 1, 2, 3].map((i) => (
                  <motion.span
                    key={i}
                    className="round-dot"
                    animate={{ backgroundColor: i < s.rounds % 4 || (s.rounds > 0 && s.rounds % 4 === 0 && s.phase === "break") ? ORANGE : "rgba(118,118,128,0.4)" }}
                  />
                ))}
              </div>
              <span className="dim" style={{ fontSize: 13, fontWeight: 500 }}>
                {s.focusMin} min focus · {s.breakMin} min break
              </span>
            </div>
          )}
        </div>
      </ModeSwitch>
    </div>
  );
}

/**
 * Horizontal scrolling for chip rows: the mouse wheel scrolls sideways (instead of
 * switching island tabs), and you can click-drag the row like a touch list.
 */
const hScroll = {
  "data-no-lift": "",
  onWheel(e: React.WheelEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    if (el.scrollWidth <= el.clientWidth) return;
    const atStart = el.scrollLeft <= 0 && e.deltaY < 0;
    const atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 1 && e.deltaY > 0;
    if (atStart || atEnd) return; // let the island switch tabs at the ends
    e.stopPropagation();
    markScrolled(e);
    const d = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    // A touchpad is already smooth: follow it 1:1. Easing every tiny event lags behind.
    if (gestureOf(e).touchpad) el.scrollLeft += d;
    else el.scrollBy({ left: d * 0.8, behavior: "smooth" });
  },
  onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    const x0 = e.clientX;
    const s0 = el.scrollLeft;
    let moved = false;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - x0;
      if (Math.abs(dx) > 4) moved = true;
      el.scrollLeft = s0 - dx;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (moved) {
        // Swallow the click that ends a drag so it doesn't pick a chip.
        const block = (ev: MouseEvent) => {
          ev.stopPropagation();
          ev.preventDefault();
        };
        el.addEventListener("click", block, { capture: true, once: true });
        setTimeout(() => el.removeEventListener("click", block, { capture: true }), 50);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  },
};

function RoundButton({ tone, disabled, onClick, children }: { tone: "grey" | "green" | "orange" | "red"; disabled?: boolean; onClick(): void; children: React.ReactNode }) {
  const c = { grey: "#fff", green: GREEN, orange: ORANGE, red: RED }[tone];
  const bg = { grey: "rgba(118,118,128,0.3)", green: "rgba(48,209,88,0.2)", orange: "rgba(255,159,10,0.2)", red: "rgba(255,69,58,0.2)" }[tone];
  return (
    <motion.button
      className="round-btn"
      disabled={disabled}
      style={{ color: c, backgroundColor: bg }}
      whileTap={disabled ? undefined : { scale: 0.9 }}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={String(children)}
          initial={{ opacity: 0, filter: "blur(3px)" }}
          animate={{ opacity: 1, filter: "blur(0px)" }}
          exit={{ opacity: 0, filter: "blur(3px)" }}
          transition={{ duration: 0.16 }}
        >
          {children}
        </motion.span>
      </AnimatePresence>
    </motion.button>
  );
}

/* ---------- live activity (collapsed) ---------- */

export function ClockCompact({ width, height }: { width: number; height: number }) {
  const s = useClock();
  useNow(s.running, s.kind === "stopwatch" ? 100 : 250);
  const color = s.kind === "stopwatch" ? "#fff" : s.kind === "focus" && s.phase === "break" ? GREEN : ORANGE;
  return (
    <div className="row" style={{ width, height, padding: "0 16px 0 12px", justifyContent: "space-between" }}>
      <span className="row" style={{ gap: 7, color }}>
        <ClockGlyph kind={s.kind} size={17} />
        {!s.running && <span style={{ fontSize: 13, fontWeight: 600, opacity: 0.8 }}>Paused</span>}
      </span>
      <span className="clock-compact-digits" style={{ color }}>
        <NumericText value={fmtClock(display(s), { tenths: false })} dir={s.kind === "stopwatch" ? 1 : -1} />
      </span>
    </div>
  );
}

/**
 * Second-activity bubble, Apple Watch complication-style: a progress ring with the
 * minutes left inside (seconds in the last minute). The stopwatch shows its glyph.
 */
export function ClockMinimal() {
  const s = useClock();
  useNow(s.running, 250);
  const total = totalMs(s);
  const left = display(s);
  const p = s.kind === "stopwatch" || !total ? 1 : Math.max(0, Math.min(1, left / total));
  const color = s.kind === "focus" && s.phase === "break" ? GREEN : s.kind === "stopwatch" ? "#fff" : ORANGE;
  const R = 12.5;
  const C = 2 * Math.PI * R;
  const label = left >= 60_000 ? String(Math.ceil(left / 60_000)) : String(Math.ceil(left / 1000));
  return (
    <span style={{ position: "relative", display: "flex", width: 31, height: 31 }}>
      <svg width="31" height="31" viewBox="0 0 31 31">
        <circle cx="15.5" cy="15.5" r={R} fill="none" stroke={color} strokeOpacity="0.25" strokeWidth="3" />
        <circle
          cx="15.5"
          cy="15.5"
          r={R}
          fill="none"
          stroke={color}
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={`${C * p} ${C}`}
          transform="rotate(-90 15.5 15.5)"
          style={{ transition: "stroke-dasharray 0.3s linear" }}
        />
      </svg>
      <span className="clock-mini-label" style={{ color }}>
        {s.kind === "stopwatch" ? <ClockGlyph kind="stopwatch" size={13} /> : <NumericText value={label} dir={-1} />}
      </span>
    </span>
  );
}

export function ClockGlyph({ kind, size = 16 }: { kind: ClockKind; size?: number }) {
  if (kind === "focus")
    // A timer with a leaf: "focus session", without looking like a target.
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="13.5" r="8" />
        <path d="M9.5 2.5h5" />
        <path d="M12 17.5c-2.4-.6-3.4-2.6-2.6-5.2 2.6-.2 4.4.9 4.8 3.3-.5 1.2-1.2 1.7-2.2 1.9z" fill="currentColor" stroke="none" />
      </svg>
    );
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="13.5" r="8" />
      <path d="M12 9.5v4l2.6 1.6M9.5 2.5h5" />
      {kind === "stopwatch" && <path d="M19.2 5.8l1.3-1.3" />}
    </svg>
  );
}
