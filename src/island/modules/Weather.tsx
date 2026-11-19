// Weather: an iOS Weather–style page inside the island.
//
// The background is a live sky for the real conditions: sun glow or moon and
// twinkling stars, drifting clouds, falling rain or snow, fog banks, lightning,
// and golden light around sunrise/sunset. On top, a scrolling page: big hero
// temperature (collapses into a compact header as you scroll), hourly forecast
// with sunrise/sunset markers, 7-day range bars, and detail tiles — feels like,
// wind compass, UV, sunrise/sunset arc, humidity, visibility, pressure, rain.
import { motion, useScroll, useTransform } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSettings } from "../../lib/settings";
import { condition, isoClock, isoMinutes, localMinutes, refreshWeather, sky, useWeather, type Sky, type Weather } from "../../lib/weather";
import { startSky } from "./sky";
import { SkyIcon } from "./Today";
import { NumericText } from "./ui";

const stop = (e: React.SyntheticEvent) => e.stopPropagation();

export function WeatherPanel({ width, height }: { width: number; height: number }) {
  const { settings } = useSettings();
  const unit = settings.weatherUnit === "F" ? "F" : "C";
  const { data, error } = useWeather(settings.weatherCity ?? "", unit);
  const scroller = useRef<HTMLDivElement>(null);
  const { scrollY } = useScroll({ container: scroller });
  const heroOpacity = useTransform(scrollY, [0, 70], [1, 0]);
  const heroScale = useTransform(scrollY, [0, 90], [1, 0.86]);
  const heroY = useTransform(scrollY, [0, 90], [0, 18]);
  const barOpacity = useTransform(scrollY, [55, 95], [0, 1]);
  // The wheel over the big temperature changes tabs; below it, it scrolls the page.
  // Once the hero has scrolled away, the compact header strip takes that role.
  const hero = useRef<HTMLDivElement>(null);
  const [zone, setZone] = useState(150);
  const updateZone = () => {
    const sc = scroller.current;
    const h = hero.current;
    if (!sc || !h) return;
    const bottom = h.offsetTop + h.offsetHeight - sc.scrollTop;
    setZone(Math.round(Math.max(44, bottom)));
  };
  useEffect(updateZone);

  if (!data || !data.days) {
    return (
      <div className="wxp" style={{ width, height }}>
        <SkyScene kind="cloud" isDay width={width} height={height} golden={false} />
        <div className="wxp-empty">
          <SkyIcon kind="partly" size={40} />
          <span>{error ? "Weather is unavailable" : "Getting the forecast…"}</span>
          {error && (
            <button className="wxp-retry" onClick={(e) => (stop(e), refreshWeather(settings.weatherCity ?? "", unit, true))}>
              Try Again
            </button>
          )}
        </div>
      </div>
    );
  }

  const kind = sky(data.code, data.isDay);
  const now = localMinutes(data);
  const rise = isoMinutes(data.sunrise);
  const set = isoMinutes(data.sunset);
  const golden = data.isDay && (kind === "sun" || kind === "partly") && (Math.abs(now - set) < 50 || Math.abs(now - rise) < 40);

  return (
    <div className="wxp" style={{ width, height }}>
      <SkyScene kind={kind} isDay={data.isDay} width={width} height={height} golden={golden} wind={data.wind} />

      {/* Compact header that takes over once the hero scrolls away. */}
      <motion.div className="wxp-bar" style={{ opacity: barOpacity }}>
        <span className="wxp-bar-city">{data.city}</span>
        <span className="wxp-bar-temp">
          {data.temp}° · {condition(data.code)}
        </span>
      </motion.div>

      <div ref={scroller} className="wxp-scroll" data-tab-zone={zone} onScroll={updateZone}>
        <motion.div ref={hero} className="wxp-hero" style={{ opacity: heroOpacity, scale: heroScale, y: heroY }}>
          <span className="wxp-city">
            {data.city}
            {!settings.weatherCity && (
              <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" style={{ marginLeft: 5 }}>
                <path d="M21 3L3 10.5l7.5 3 3 7.5z" />
              </svg>
            )}
          </span>
          <span className="wxp-temp">
            <NumericText value={`${data.temp}`} />
            <span className="wxp-deg">°</span>
          </span>
          <span className="wxp-cond">{condition(data.code)}</span>
          <span className="wxp-hl">
            H:{data.high}°&nbsp;&nbsp;L:{data.low}°&nbsp;&nbsp;·&nbsp;&nbsp;Feels {data.feels}°
          </span>
        </motion.div>

        <Card i={0} icon={<ClockGlyph />} title="Hourly forecast">
          <p className="wxp-summary">{summary(data)}</p>
          <Hourly w={data} />
        </Card>

        <Card i={1} icon={<CalendarGlyph />} title="7-day forecast">
          <Daily w={data} unit={unit} />
        </Card>

        <div className="wxp-grid">
          <Tile i={2} title="Feels like" icon={<ThermoGlyph />}>
            <span className="wxp-big">{data.feels}°</span>
            <span className="wxp-note">{feelsNote(data)}</span>
          </Tile>
          <Tile i={2} title="Wind" icon={<WindGlyph />}>
            <Compass dir={data.windDir} speed={data.wind} unit={data.windUnit} />
            <span className="wxp-note center">Gusts {data.gust} {data.windUnit}</span>
          </Tile>
          <Tile i={3} title="UV index" icon={<SunGlyph />}>
            <span className="wxp-big">{data.uv}</span>
            <span className="wxp-mid">{uvLevel(data.uv)}</span>
            <UvBar uv={data.uv} />
            <span className="wxp-note">{data.days[0].uv >= 3 ? `Peaks at ${data.days[0].uv} today.` : "Low for the rest of the day."}</span>
          </Tile>
          <Tile i={3} title={now > rise && now < set ? "Sunset" : "Sunrise"} icon={<HorizonGlyph />}>
            <BigTime iso={now > rise && now < set ? data.sunset : now >= set ? data.tomorrowSunrise : data.sunrise} />
            <SunArc now={now} rise={rise} set={set} />
            <span className="wxp-note">
              {now > rise && now < set ? "Sunrise: " : "Sunset: "}
              <SmallTime iso={now > rise && now < set ? data.sunrise : data.sunset} />
            </span>
          </Tile>
          <Tile i={4} title="Humidity" icon={<DropGlyph />}>
            <span className="wxp-big">{data.humidity}%</span>
            <span className="wxp-note">The dew point is {data.dewPoint}° right now.</span>
          </Tile>
          <Tile i={4} title="Precipitation" icon={<RainGlyph />}>
            <span className="wxp-big sm">
              {fmtPrecip(data.days[0].precipSum, unit)}
            </span>
            <span className="wxp-mid">Today</span>
            <span className="wxp-note">{rainNote(data)}</span>
          </Tile>
          <Tile i={5} title="Visibility" icon={<EyeGlyph />}>
            <span className="wxp-big">{fmtVis(data.visibility, unit)}</span>
            <span className="wxp-note">{visNote(data.visibility)}</span>
          </Tile>
          <Tile i={5} title="Pressure" icon={<GaugeGlyph />}>
            <Pressure hpa={data.pressure} unit={unit} />
          </Tile>
        </div>

        <div className="wxp-foot">
          Weather by Open-Meteo · Updated {ago(data.at)}
          <button className="wxp-refresh" title="Refresh" onClick={(e) => (stop(e), refreshWeather(settings.weatherCity ?? "", unit, true))}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------------- sky ---------------- */

function SkyScene({ kind, isDay, width, height, golden, wind = 8 }: { kind: Sky; isDay: boolean; width: number; height: number; golden: boolean; wind?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => startSky(ref.current!, width, height, { kind, isDay, golden, wind }), [kind, isDay, golden, wind, width, height]);
  return (
    <motion.div className="wxs" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.6 }}>
      <canvas ref={ref} className="wxs-canvas" style={{ width, height }} />
    </motion.div>
  );
}

/* ---------------- cards ---------------- */

const enter = (i: number) => ({
  initial: { opacity: 0, y: 16, filter: "blur(6px)" },
  animate: { opacity: 1, y: 0, filter: "blur(0px)" },
  transition: { type: "spring" as const, stiffness: 260, damping: 26, delay: 0.08 + i * 0.07, filter: { duration: 0.35, delay: 0.08 + i * 0.07 } },
});

function Card({ i, icon, title, children }: { i: number; icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <motion.div className="wxp-card" {...enter(i)}>
      <div className="wxp-card-title">
        {icon}
        {title}
      </div>
      {children}
    </motion.div>
  );
}

function Tile({ i, icon, title, children }: { i: number; icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <motion.div className="wxp-card wxp-tile" {...enter(i)}>
      <div className="wxp-card-title">
        {icon}
        {title}
      </div>
      <div className="wxp-tile-body">{children}</div>
    </motion.div>
  );
}

function Hourly({ w }: { w: Weather }) {
  // Hours, with sunrise/sunset slipped in where they happen (like iOS).
  const items = useMemo(() => {
    const out: { key: string; label: string; icon: Sky | "sunrise" | "sunset"; text: string; pop?: number; now?: boolean }[] = [];
    const events = [
      { t: w.sunrise, kind: "sunrise" as const },
      { t: w.sunset, kind: "sunset" as const },
      { t: w.tomorrowSunrise, kind: "sunrise" as const },
    ];
    w.hours.forEach((h, i) => {
      out.push({ key: h.t, label: i === 0 ? "Now" : isoClock(h.t, false), icon: sky(h.code, h.isDay), text: `${i === 0 ? w.temp : h.temp}°`, pop: h.pop, now: i === 0 });
      const next = w.hours[i + 1];
      if (!next) return;
      for (const ev of events) if (ev.t > h.t && ev.t <= next.t) out.push({ key: ev.t + ev.kind, label: isoClock(ev.t), icon: ev.kind, text: ev.kind === "sunrise" ? "Sunrise" : "Sunset" });
    });
    return out;
  }, [w]);
  return (
    <div className="wxp-hours">
      {items.map((it, i) => (
        <motion.div key={it.key} className={`wxp-hour ${it.now ? "now" : ""}`} initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.15 + Math.min(i, 8) * 0.03 }}>
          <span className="wxp-hour-t">{it.label}</span>
          <span className="wxp-hour-ic">
            {it.icon === "sunrise" || it.icon === "sunset" ? <HorizonGlyph big up={it.icon === "sunrise"} /> : <SkyIcon kind={it.icon} size={22} />}
            {it.pop != null && it.pop >= 20 && <span className="wxp-pop">{Math.round(it.pop / 10) * 10}%</span>}
          </span>
          <span className="wxp-hour-v">{it.text}</span>
        </motion.div>
      ))}
    </div>
  );
}

function Daily({ w, unit }: { w: Weather; unit: "C" | "F" }) {
  const lo = Math.min(...w.days.map((d) => d.min));
  const hi = Math.max(...w.days.map((d) => d.max));
  const span = Math.max(1, hi - lo);
  return (
    <div className="wxp-days">
      {w.days.map((d, i) => {
        const left = ((d.min - lo) / span) * 100;
        const right = ((d.max - lo) / span) * 100;
        const label = i === 0 ? "Today" : new Date(`${d.date}T12:00:00`).toLocaleDateString(undefined, { weekday: "short" });
        return (
          <div key={d.date} className="wxp-day">
            <span className="wxp-day-name">{label}</span>
            <span className="wxp-day-ic">
              <SkyIcon kind={sky(d.code, true)} size={20} />
              {d.pop >= 30 && <span className="wxp-pop">{Math.round(d.pop / 10) * 10}%</span>}
            </span>
            <span className="wxp-day-lo">{d.min}°</span>
            <span className="wxp-range">
              <motion.span
                className="wxp-range-fill"
                style={{ left: `${left}%`, width: `${Math.max(6, right - left)}%`, background: `linear-gradient(90deg, ${tempColor(d.min, unit)}, ${tempColor(d.max, unit)})` }}
                initial={{ scaleX: 0, opacity: 0 }}
                animate={{ scaleX: 1, opacity: 1 }}
                transition={{ type: "spring", stiffness: 180, damping: 22, delay: 0.25 + i * 0.05 }}
              />
              {i === 0 && (
                <motion.span
                  className="wxp-range-now"
                  style={{ left: `${((Math.min(d.max, Math.max(d.min, w.temp)) - lo) / span) * 100}%` }}
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  transition={{ type: "spring", stiffness: 500, damping: 18, delay: 0.7 }}
                />
              )}
            </span>
            <span className="wxp-day-hi">{d.max}°</span>
          </div>
        );
      })}
    </div>
  );
}

function Compass({ dir, speed, unit }: { dir: number; speed: number; unit: string }) {
  const S = 92;
  const c = S / 2;
  return (
    <div className="wxp-compass" style={{ width: S, height: S }}>
      <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`}>
        {Array.from({ length: 72 }, (_, i) => {
          const a = (i * 5 * Math.PI) / 180;
          const major = i % 18 === 0;
          const r1 = c - 3;
          const r2 = c - (major ? 9 : i % 2 ? 5 : 6.5);
          return <line key={i} x1={c + Math.sin(a) * r1} y1={c - Math.cos(a) * r1} x2={c + Math.sin(a) * r2} y2={c - Math.cos(a) * r2} stroke="#fff" strokeOpacity={major ? 0.9 : 0.35} strokeWidth={major ? 1.6 : 1} />;
        })}
        {[
          ["N", 0],
          ["E", 90],
          ["S", 180],
          ["W", 270],
        ].map(([t, deg]) => {
          const a = ((deg as number) * Math.PI) / 180;
          return (
            <text key={t} x={c + Math.sin(a) * (c - 17)} y={c - Math.cos(a) * (c - 17) + 3.5} fill="#fff" fillOpacity="0.7" fontSize="10" fontWeight="700" textAnchor="middle">
              {t}
            </text>
          );
        })}
      </svg>
      {/* Arrow points where the wind is blowing to; springs round on open. */}
      <motion.div className="wxp-compass-arrow" initial={{ rotate: dir + 180 - 140 }} animate={{ rotate: dir + 180 }} transition={{ type: "spring", stiffness: 60, damping: 7, delay: 0.5 }}>
        <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`}>
          <line x1={c} y1={c + 30} x2={c} y2={c - 26} stroke="#fff" strokeWidth="2.6" strokeLinecap="round" />
          <path d={`M${c} ${c - 34}l-6 10h12z`} fill="#fff" />
          <circle cx={c} cy={c + 30} r="3.4" fill="none" stroke="#fff" strokeWidth="2" />
        </svg>
      </motion.div>
      <div className="wxp-compass-mid">
        <span className="wxp-compass-v">{speed}</span>
        <span className="wxp-compass-u">{unit}</span>
      </div>
    </div>
  );
}

function UvBar({ uv }: { uv: number }) {
  return (
    <span className="wxp-uv">
      <motion.span className="wxp-uv-dot" initial={{ left: "0%" }} animate={{ left: `${Math.min(100, (uv / 11) * 100)}%` }} transition={{ type: "spring", stiffness: 120, damping: 16, delay: 0.5 }} />
    </span>
  );
}

/**
 * iOS Sunrise/Sunset graph: one full day as a wave (midnight → midnight), crossing
 * the horizon at sunrise and sunset. Above the horizon the line is bright, below it
 * dim; the sun sits on the wave at the current time — glowing by day, an outlined
 * dark dot at night.
 */
function SunArc({ now, rise, set }: { now: number; rise: number; set: number }) {
  const W = 132;
  const H = 52;
  const mid = 24; // wave centre line
  const A = 20; // wave height
  const noon = (rise + set) / 2;
  const yAt = (m: number) => mid - A * Math.cos((2 * Math.PI * (m - noon)) / 1440);
  const horizon = yAt(rise);
  const xAt = (m: number) => (m / 1440) * W;
  const path = Array.from({ length: 97 }, (_, i) => {
    const m = (i / 96) * 1440;
    return `${i ? "L" : "M"}${xAt(m).toFixed(1)} ${yAt(m).toFixed(1)}`;
  }).join(" ");
  const sx = xAt(now);
  const sy = yAt(now);
  const up = sy <= horizon;
  const id = useMemo(() => `arc${Math.random().toString(36).slice(2, 7)}`, []);
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="wxp-arc">
      <defs>
        <clipPath id={`${id}a`}>
          <rect x="0" y="-10" width={W} height={horizon + 10} />
        </clipPath>
        <clipPath id={`${id}b`}>
          <rect x="0" y={horizon} width={W} height={H} />
        </clipPath>
      </defs>
      {/* Day part (above the horizon) bright, night part dim. */}
      <path d={path} fill="none" stroke="rgba(255,255,255,0.55)" strokeWidth="3" strokeLinecap="round" clipPath={`url(#${id}a)`} />
      <path d={path} fill="none" stroke="rgba(0,0,0,0.28)" strokeWidth="3" strokeLinecap="round" clipPath={`url(#${id}b)`} />
      <line x1="0" y1={horizon} x2={W} y2={horizon} stroke="rgba(255,255,255,0.55)" strokeWidth="1" />
      <motion.g initial={{ x: xAt(rise), y: yAt(rise), opacity: 0 }} animate={{ x: sx, y: sy, opacity: 1 }} transition={{ type: "spring", stiffness: 70, damping: 16, delay: 0.5 }}>
        {up ? (
          <>
            <circle r="9" fill="rgba(255,255,255,0.25)" />
            <circle r="5" fill="#fff" />
          </>
        ) : (
          <circle r="5" fill="rgba(30,34,46,0.95)" stroke="rgba(255,255,255,0.85)" strokeWidth="1.3" />
        )}
      </motion.g>
    </svg>
  );
}

/** "7:15 AM" with a small AM/PM, like iOS. */
function BigTime({ iso }: { iso: string }) {
  const [t, ap] = isoClock(iso).split(" ");
  return (
    <span className="wxp-big sm">
      {t}
      <span className="wxp-ampm">{ap}</span>
    </span>
  );
}

function SmallTime({ iso }: { iso: string }) {
  const [t, ap] = isoClock(iso).split(" ");
  return (
    <>
      {t}
      <span className="wxp-ampm-s">{ap}</span>
    </>
  );
}

function Pressure({ hpa, unit }: { hpa: number; unit: "C" | "F" }) {
  const S = 92;
  const c = S / 2;
  const f = Math.min(1, Math.max(0, (hpa - 970) / 70)); // 970–1040 hPa
  const start = -135;
  const sweep = 270;
  const ticks = Array.from({ length: 37 }, (_, i) => {
    const a = ((start + (i / 36) * sweep) * Math.PI) / 180;
    return <line key={i} x1={c + Math.sin(a) * (c - 4)} y1={c - Math.cos(a) * (c - 4)} x2={c + Math.sin(a) * (c - 10)} y2={c - Math.cos(a) * (c - 10)} stroke="#fff" strokeOpacity={0.35} strokeWidth="1.2" />;
  });
  const value = unit === "F" ? (hpa * 0.02953).toFixed(2) : String(hpa);
  return (
    <div className="wxp-compass" style={{ width: S, height: S }}>
      <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`}>
        {ticks}
      </svg>
      <motion.div className="wxp-compass-arrow" initial={{ rotate: start }} animate={{ rotate: start + f * sweep }} transition={{ type: "spring", stiffness: 70, damping: 11, delay: 0.5 }}>
        <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`}>
          <rect x={c - 2} y={1} width="4" height="15" rx="2" fill="#fff" />
        </svg>
      </motion.div>
      <div className="wxp-compass-mid">
        <span className="wxp-compass-v sm">{value}</span>
        <span className="wxp-compass-u">{unit === "F" ? "inHg" : "hPa"}</span>
      </div>
    </div>
  );
}

/* ---------------- words ---------------- */

function summary(w: Weather): string {
  const next = w.hours.slice(1, 13);
  const rainAt = next.find((h) => h.pop >= 50);
  if (rainAt && w.code < 51) return `${sky(rainAt.code, rainAt.isDay) === "snow" ? "Snow" : "Rain"} likely around ${isoClock(rainAt.t, false)}.`;
  const cur = condition(w.code);
  const change = next.find((h) => condition(h.code) !== cur);
  const gusty = w.gust >= (w.windUnit === "mph" ? 25 : 40) ? ` Wind gusts up to ${w.gust} ${w.windUnit}.` : "";
  if (change) return `${cur} now, ${condition(change.code).toLowerCase()} expected around ${isoClock(change.t, false)}.${gusty}`;
  return `${cur} conditions for the next few hours.${gusty}`;
}

function feelsNote(w: Weather): string {
  if (w.feels <= w.temp - 2) return w.wind >= (w.windUnit === "mph" ? 8 : 12) ? "Wind is making it feel colder." : "It feels colder than it is.";
  if (w.feels >= w.temp + 2) return "Humidity is making it feel warmer.";
  return "Similar to the actual temperature.";
}

function uvLevel(uv: number): string {
  return uv <= 2 ? "Low" : uv <= 5 ? "Moderate" : uv <= 7 ? "High" : uv <= 10 ? "Very High" : "Extreme";
}

function rainNote(w: Weather): string {
  const d = w.days.findIndex((x, i) => i > 0 && x.pop >= 50);
  if (w.days[0].pop >= 50) return `${w.days[0].pop}% chance today.`;
  if (d > 0) return `Next expected ${d === 1 ? "tomorrow" : new Date(`${w.days[d].date}T12:00:00`).toLocaleDateString(undefined, { weekday: "long" })}.`;
  return "None expected this week.";
}

function fmtPrecip(v: number, unit: "C" | "F"): string {
  return unit === "F" ? `${v.toFixed(v < 1 ? 2 : 1)}″` : `${v < 10 ? v.toFixed(1).replace(/\.0$/, "") : Math.round(v)} mm`;
}

function fmtVis(m: number, unit: "C" | "F"): string {
  if (unit === "F") return `${Math.round(m / 1609)} mi`;
  return m >= 10000 ? `${Math.round(m / 1000)} km` : `${(m / 1000).toFixed(1)} km`;
}

function visNote(m: number): string {
  if (m >= 20000) return "It's perfectly clear right now.";
  if (m >= 8000) return "Good visibility.";
  if (m >= 2000) return "Haze is reducing visibility.";
  return "Fog is reducing visibility.";
}

function ago(at: number): string {
  const m = Math.round((Date.now() - at) / 60000);
  return m < 1 ? "just now" : m === 1 ? "1 min ago" : `${m} min ago`;
}

/** iOS-style temperature colours for the range bars. */
function tempColor(t: number, unit: "C" | "F"): string {
  const c = unit === "F" ? ((t - 32) * 5) / 9 : t;
  const stops: [number, [number, number, number]][] = [
    [-15, [94, 92, 230]],
    [-2, [100, 210, 255]],
    [10, [48, 209, 88]],
    [20, [255, 214, 10]],
    [28, [255, 159, 10]],
    [36, [255, 69, 58]],
  ];
  if (c <= stops[0][0]) return `rgb(${stops[0][1].join(",")})`;
  for (let i = 1; i < stops.length; i++) {
    if (c <= stops[i][0]) {
      const [t0, a] = stops[i - 1];
      const [t1, b] = stops[i];
      const f = (c - t0) / (t1 - t0);
      return `rgb(${a.map((v, k) => Math.round(v + (b[k] - v) * f)).join(",")})`;
    }
  }
  return `rgb(${stops[stops.length - 1][1].join(",")})`;
}

/* ---------------- small glyphs (card titles) ---------------- */

const g = { width: 12, height: 12, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2.4, strokeLinecap: "round", strokeLinejoin: "round" } as const;
const ClockGlyph = () => (
  <svg {...g}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </svg>
);
const CalendarGlyph = () => (
  <svg {...g}>
    <rect x="3.5" y="5" width="17" height="15.5" rx="3" />
    <path d="M3.5 10h17M8 3v4M16 3v4" />
  </svg>
);
const ThermoGlyph = () => (
  <svg {...g}>
    <path d="M14 14.8V5a2 2 0 0 0-4 0v9.8a4 4 0 1 0 4 0z" />
  </svg>
);
const WindGlyph = () => (
  <svg {...g}>
    <path d="M3 8h11a3 3 0 1 0-3-3M3 12h16a3 3 0 1 1-3 3M3 16h7" />
  </svg>
);
const SunGlyph = () => (
  <svg {...g}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" />
  </svg>
);
const DropGlyph = () => (
  <svg {...g}>
    <path d="M12 3s6 6.6 6 11a6 6 0 0 1-12 0c0-4.4 6-11 6-11z" />
  </svg>
);
const RainGlyph = () => (
  <svg {...g}>
    <path d="M7 15a4 4 0 0 1-.6-8A6 6 0 0 1 18 8.5 3.5 3.5 0 0 1 17.5 15H7zM8 19l-1 2M12 19l-1 2M16 19l-1 2" />
  </svg>
);
const EyeGlyph = () => (
  <svg {...g}>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
    <circle cx="12" cy="12" r="2.8" />
  </svg>
);
const GaugeGlyph = () => (
  <svg {...g}>
    <path d="M4.5 17.5a9 9 0 1 1 15 0M12 13l3.5-4" />
  </svg>
);
function HorizonGlyph({ big, up }: { big?: boolean; up?: boolean }) {
  if (!big)
    return (
      <svg {...g}>
        <path d="M2.5 18h19M6.5 18a5.5 5.5 0 0 1 11 0M12 4v4M5 9.5l1.5 1.5M19 9.5L17.5 11" />
      </svg>
    );
  return (
    <svg width="22" height="22" viewBox="0 0 24 24">
      <path d="M6.5 17.5a5.5 5.5 0 0 1 11 0z" fill="#ffd60a" />
      <path d="M2.5 18h19" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />
      <path d={up ? "M12 3v6M9.5 5.5L12 3l2.5 2.5" : "M12 3v6M9.5 6.5L12 9l2.5-2.5"} stroke="#fff" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
