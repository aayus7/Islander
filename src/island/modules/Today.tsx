// Today: an iOS-widget-style month calendar (flip through months), the date at a
// glance with how much of the day is left, and your reminders — tick them off
// right here.
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { useNow } from "../../lib/hooks";
import { useStore } from "../../lib/persist";
import type { Sky } from "../../lib/weather";
import { todoStore, notesStore } from "./Notes";

const RED = "#ff453a";
const stop = (e: React.SyntheticEvent) => e.stopPropagation();

export function TodayPanel({ width, height }: { width: number; height: number }) {
  const now = new Date(useNow(true, 30_000));
  return (
    <div className="today2" style={{ width, height }}>
      <MonthGrid now={now} />
      <div className="today-side">
        <DateGlance now={now} />
        <UpNext />
      </div>
    </div>
  );
}

function MonthGrid({ now }: { now: Date }) {
  const [offset, setOffset] = useState(0);
  const [dir, setDir] = useState(1);
  const view = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  const y = view.getFullYear();
  const m = view.getMonth();
  const lead = (view.getDay() + 6) % 7; // Monday first
  const days = new Date(y, m + 1, 0).getDate();
  const cells: (number | null)[] = [...Array(lead).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];
  while (cells.length % 7) cells.push(null);
  const heads = Array.from({ length: 7 }, (_, i) => new Date(2024, 0, 1 + i).toLocaleDateString(undefined, { weekday: "narrow" }));
  const isThisMonth = offset === 0;
  const go = (d: number) => {
    setDir(d);
    setOffset((o) => o + d);
  };
  return (
    <div className="cal">
      <div className="cal-top">
        <button className="cal-month" style={{ color: isThisMonth ? RED : "#fff" }} onClick={(e) => (stop(e), setDir(offset > 0 ? -1 : 1), setOffset(0))} title="Back to today">
          {view.toLocaleDateString(undefined, { month: "long", ...(y !== now.getFullYear() ? { year: "numeric" } : {}) }).toUpperCase()}
        </button>
        <span className="cal-nav">
          <button onClick={(e) => (stop(e), go(-1))} title="Previous month">
            <Chev left />
          </button>
          <button onClick={(e) => (stop(e), go(1))} title="Next month">
            <Chev />
          </button>
        </span>
      </div>
      <div className="cal-clip">
        <AnimatePresence mode="popLayout" initial={false} custom={dir}>
          <motion.div
            key={`${y}-${m}`}
            className="cal-grid"
            custom={dir}
            variants={{
              in: (d: number) => ({ x: d * 40, opacity: 0, filter: "blur(4px)" }),
              show: { x: 0, opacity: 1, filter: "blur(0px)" },
              out: (d: number) => ({ x: d * -40, opacity: 0, filter: "blur(4px)" }),
            }}
            initial="in"
            animate="show"
            exit="out"
            transition={{ type: "spring", stiffness: 420, damping: 36, opacity: { duration: 0.18 } }}
          >
            {heads.map((h, i) => (
              <span key={`h${i}`} className="cal-head">
                {h}
              </span>
            ))}
            {cells.map((d, i) => (
              <span key={i} className={`cal-day ${isThisMonth && d === now.getDate() ? "is-today" : ""} ${i % 7 >= 5 ? "weekend" : ""}`}>
                {d ?? ""}
              </span>
            ))}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

/** Big date, week/day of year, and a bar showing how much of today is left. */
function DateGlance({ now }: { now: Date }) {
  const start = new Date(now.getFullYear(), 0, 1);
  const dayOfYear = Math.floor((now.getTime() - start.getTime()) / 86_400_000) + 1;
  const week = isoWeek(now);
  const mins = now.getHours() * 60 + now.getMinutes();
  const left = 1440 - mins;
  const frac = mins / 1440;
  return (
    <div className="dg">
      <div className="dg-row">
        <span className="dg-num">{now.getDate()}</span>
        <span className="dg-col">
          <span className="dg-day" style={{ color: RED }}>
            {now.toLocaleDateString(undefined, { weekday: "long" })}
          </span>
          <span className="dg-sub">
            Week {week} · Day {dayOfYear}
          </span>
        </span>
      </div>
      <div className="dg-bar">
        <motion.span className="dg-fill" initial={{ width: 0 }} animate={{ width: `${frac * 100}%` }} transition={{ type: "spring", stiffness: 90, damping: 20, delay: 0.1 }} />
      </div>
      <span className="dg-left">
        {Math.floor(left / 60)}h {left % 60}m left today
      </span>
    </div>
  );
}

function isoWeek(d: Date): number {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t.getTime() - y0.getTime()) / 86_400_000 + 1) / 7);
}

/** Reminders you can tick off right here (they glide away once done). */
function UpNext() {
  const all = useStore(todoStore);
  const open = all.filter((t) => !t.done);
  const goNotes = () => {
    notesStore.set((s) => ({ ...s, view: "todo" }));
    window.dispatchEvent(new CustomEvent("island:goto", { detail: "notes" }));
  };
  return (
    <div className="upnext">
      <button className="upnext-label" onClick={(e) => (stop(e), goNotes())}>
        Reminders{open.length > 2 ? ` · ${open.length}` : ""}
        <Chev />
      </button>
      <AnimatePresence initial={false} mode="popLayout">
        {open.length === 0 ? (
          <motion.span key="none" className="upnext-item dim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            All done for today
          </motion.span>
        ) : (
          open.slice(0, 2).map((t) => (
            <motion.button
              layout
              key={t.id}
              className="upnext-item"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, x: 16, transition: { duration: 0.2 } }}
              transition={{ type: "spring", stiffness: 500, damping: 36 }}
              onClick={(e) => {
                stop(e);
                todoStore.set((ts) => ts.map((x) => (x.id === t.id ? { ...x, done: true } : x)));
              }}
              title="Mark as done"
            >
              <span className="upnext-check" />
              <span className="upnext-text">{t.text}</span>
            </motion.button>
          ))
        )}
      </AnimatePresence>
    </div>
  );
}

function Chev({ left }: { left?: boolean }) {
  return (
    <svg width="7" height="11" viewBox="0 0 9 14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d={left ? "M7 1.5L1.8 7 7 12.5" : "M2 1.5L7.2 7 2 12.5"} />
    </svg>
  );
}

/** Multicolour weather glyphs in the spirit of SF Symbols' palette rendering. */
export function SkyIcon({ kind, size = 20 }: { kind: Sky; size?: number }) {
  const SUN = "#ffd60a";
  const CLOUD = "#fff";
  const DROP = "#64d2ff";
  const cloud = (dy = 0, op = 1) => (
    <path d={`M7.5 ${18.5 + dy}h9.2a3.8 3.8 0 0 0 .5-7.6 5.5 5.5 0 0 0-10.5 1.4 3.2 3.2 0 0 0 .8 6.2z`} fill={CLOUD} opacity={op} />
  );
  const sun = (cx = 12, cy = 12, r = 4.2) => (
    <g stroke={SUN} strokeWidth="1.9" strokeLinecap="round">
      <circle cx={cx} cy={cy} r={r} fill={SUN} stroke="none" />
      {Array.from({ length: 8 }, (_, i) => {
        const a = (i * Math.PI) / 4;
        return <line key={i} x1={cx + Math.cos(a) * (r + 2.2)} y1={cy + Math.sin(a) * (r + 2.2)} x2={cx + Math.cos(a) * (r + 4)} y2={cy + Math.sin(a) * (r + 4)} />;
      })}
    </g>
  );
  const moon = (cx = 12, cy = 12) => <path d={`M${cx + 3.8} ${cy + 3.2}a6.6 6.6 0 0 1-7.4-9.6 7 7 0 1 0 7.4 9.6z`} fill="#fff" />;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24">
      {kind === "sun" && sun()}
      {kind === "moon" && moon()}
      {kind === "partly" && (
        <>
          {sun(8.5, 8.5, 3.2)}
          {cloud(1)}
        </>
      )}
      {kind === "partlyNight" && (
        <>
          <g transform="translate(-3 -3) scale(0.8)">{moon()}</g>
          {cloud(1)}
        </>
      )}
      {kind === "cloud" && cloud()}
      {kind === "fog" && (
        <g stroke={CLOUD} strokeWidth="2" strokeLinecap="round">
          <line x1="4" y1="9" x2="20" y2="9" />
          <line x1="6" y1="13" x2="18" y2="13" />
          <line x1="4" y1="17" x2="20" y2="17" />
        </g>
      )}
      {kind === "rain" && (
        <>
          {cloud(-4)}
          <g stroke={DROP} strokeWidth="2" strokeLinecap="round">
            <line x1="8.5" y1="18" x2="7.5" y2="21" />
            <line x1="12.5" y1="18" x2="11.5" y2="21" />
            <line x1="16.5" y1="18" x2="15.5" y2="21" />
          </g>
        </>
      )}
      {kind === "snow" && (
        <>
          {cloud(-4)}
          <g fill="#fff">
            <circle cx="8" cy="19.5" r="1.2" />
            <circle cx="12" cy="20.5" r="1.2" />
            <circle cx="16" cy="19.5" r="1.2" />
          </g>
        </>
      )}
      {kind === "storm" && (
        <>
          {cloud(-4)}
          <path d="M12.5 15l-3 4.6h2.6L10.8 23l4-5.4h-2.6l1.4-2.6z" fill={SUN} />
        </>
      )}
    </svg>
  );
}
