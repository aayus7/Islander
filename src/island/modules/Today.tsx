// Today: iOS-widget-style month calendar, weather glance and what's up next.
import { motion } from "motion/react";
import { useNow } from "../../lib/hooks";
import { useStore } from "../../lib/persist";
import { useSettings } from "../../lib/settings";
import { condition, sky, useWeather, type Sky } from "../../lib/weather";
import { todoStore, notesStore } from "./Notes";

const RED = "#ff453a";

export function TodayPanel({ width, height }: { width: number; height: number }) {
  const now = new Date(useNow(true, 30_000));
  return (
    <div className="today2" style={{ width, height }}>
      <MonthGrid now={now} />
      <div className="today-side">
        <WeatherGlance />
        <UpNext now={now} />
      </div>
    </div>
  );
}

function MonthGrid({ now }: { now: Date }) {
  const y = now.getFullYear();
  const m = now.getMonth();
  const first = new Date(y, m, 1);
  const lead = (first.getDay() + 6) % 7; // Monday first
  const days = new Date(y, m + 1, 0).getDate();
  const cells: (number | null)[] = [...Array(lead).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];
  while (cells.length % 7) cells.push(null);
  const heads = Array.from({ length: 7 }, (_, i) => new Date(2024, 0, 1 + i).toLocaleDateString(undefined, { weekday: "narrow" }));
  return (
    <div className="cal">
      <div className="cal-month" style={{ color: RED }}>
        {now.toLocaleDateString(undefined, { month: "long" }).toUpperCase()}
      </div>
      <div className="cal-grid">
        {heads.map((h, i) => (
          <span key={`h${i}`} className="cal-head">
            {h}
          </span>
        ))}
        {cells.map((d, i) => (
          <span key={i} className={`cal-day ${d === now.getDate() ? "is-today" : ""} ${i % 7 >= 5 ? "weekend" : ""}`}>
            {d ?? ""}
          </span>
        ))}
      </div>
    </div>
  );
}

function WeatherGlance() {
  const { settings } = useSettings();
  const { data, error } = useWeather(settings.weatherCity ?? "", settings.weatherUnit === "F" ? "F" : "C");
  if (!data)
    return (
      <div className="wx">
        <span className="wx-city">{error ? "Weather" : "Locating…"}</span>
        <span className="dim" style={{ fontSize: 12.5 }}>
          {error || "Getting the forecast"}
        </span>
      </div>
    );
  return (
    <motion.div className="wx" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
      <div className="row" style={{ justifyContent: "space-between", width: "100%" }}>
        <span className="wx-city">
          {data.city}
          {!settings.weatherCity && (
            <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" style={{ marginLeft: 4 }}>
              <path d="M21 3L3 10.5l7.5 3 3 7.5z" />
            </svg>
          )}
        </span>
        <SkyIcon kind={sky(data.code, data.isDay)} size={22} />
      </div>
      <span className="wx-temp">{data.temp}°</span>
      <span className="wx-cond">{condition(data.code)}</span>
      <span className="wx-hl">
        H:{data.high}° L:{data.low}°
      </span>
    </motion.div>
  );
}

function UpNext({ now }: { now: Date }) {
  const todos = useStore(todoStore).filter((t) => !t.done);
  return (
    <div
      className="upnext"
      onClick={(e) => {
        e.stopPropagation();
        notesStore.set((s) => ({ ...s, view: "todo" }));
        window.dispatchEvent(new CustomEvent("island:goto", { detail: "notes" }));
      }}
    >
      <span className="upnext-label">{now.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })} · Up Next</span>
      {todos.length === 0 ? (
        <span className="upnext-item dim">No reminders</span>
      ) : (
        todos.slice(0, 2).map((t) => (
          <span key={t.id} className="upnext-item">
            <span className="upnext-bar" />
            {t.text}
          </span>
        ))
      )}
    </div>
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
