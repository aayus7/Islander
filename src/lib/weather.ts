// Weather glance: Open-Meteo (free, no API key). Location comes from the city set in
// Settings, or an approximate IP lookup when none is set. Cached for 20 minutes.
import { useEffect } from "react";
import { persistent, useStore } from "./persist";

export interface Weather {
  city: string;
  temp: number;
  high: number;
  low: number;
  code: number;
  isDay: boolean;
  unit: "C" | "F";
  at: number;
  /** Next hours: [hour label, temp, code, isDay] */
  hourly: [string, number, number, boolean][];

  // ---- details for the Weather tab ----
  feels: number;
  humidity: number;
  dewPoint: number;
  wind: number;
  windDir: number;
  gust: number;
  /** "km/h" | "mph" */
  windUnit: string;
  uv: number;
  /** hPa */
  pressure: number;
  /** metres */
  visibility: number;
  /** mm (or inch) in the last hour */
  precip: number;
  /** Seconds the location's clock is ahead of UTC. */
  utcOffset: number;
  /** ISO local times (the location's own clock) */
  sunrise: string;
  sunset: string;
  tomorrowSunrise: string;
  /** Next 24 hours. */
  hours: { t: string; temp: number; code: number; isDay: boolean; pop: number }[];
  /** Next 7 days. */
  days: { date: string; max: number; min: number; code: number; pop: number; uv: number; precipSum: number }[];
}

export const weatherStore = persistent<{ data: Weather | null; error: string; key: string }>("weather", { data: null, error: "", key: "" });

const TTL = 20 * 60_000;
let inflight: Promise<void> | null = null;

async function locate(city: string): Promise<{ lat: number; lon: number; name: string }> {
  if (city.trim()) {
    const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?count=1&name=${encodeURIComponent(city.trim())}`);
    const j = await r.json();
    const g = j?.results?.[0];
    if (!g) throw new Error(`Couldn't find “${city}”`);
    return { lat: g.latitude, lon: g.longitude, name: g.name };
  }
  const r = await fetch("https://get.geojs.io/v1/ip/geo.json");
  const j = await r.json();
  return { lat: parseFloat(j.latitude), lon: parseFloat(j.longitude), name: j.city || j.region || "Your location" };
}

export function refreshWeather(city: string, unit: "C" | "F", force = false) {
  const key = `${city}|${unit}`;
  const cur = weatherStore.get();
  if (!force && cur.data?.days && cur.key === key && Date.now() - cur.data.at < TTL) return Promise.resolve();
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const loc = await locate(city);
      const u = unit === "F" ? "&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch" : "";
      const r = await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}` +
          `&current=temperature_2m,apparent_temperature,relative_humidity_2m,dew_point_2m,weather_code,is_day,wind_speed_10m,wind_direction_10m,wind_gusts_10m,precipitation,pressure_msl,visibility,uv_index` +
          `&hourly=temperature_2m,weather_code,is_day,precipitation_probability&forecast_hours=25` +
          `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,sunrise,sunset,uv_index_max&forecast_days=7` +
          `&timezone=auto${u}`,
      );
      const j = await r.json();
      if (!j?.current) throw new Error("Weather unavailable");
      const hourly: Weather["hourly"] = (j.hourly?.time ?? []).slice(1, 6).map((t: string, i: number) => [
        new Date(t).toLocaleTimeString(undefined, { hour: "numeric" }),
        Math.round(j.hourly.temperature_2m[i + 1]),
        j.hourly.weather_code[i + 1],
        !!j.hourly.is_day[i + 1],
      ]);
      weatherStore.set({
        key,
        error: "",
        data: {
          city: loc.name,
          temp: Math.round(j.current.temperature_2m),
          high: Math.round(j.daily.temperature_2m_max[0]),
          low: Math.round(j.daily.temperature_2m_min[0]),
          code: j.current.weather_code,
          isDay: !!j.current.is_day,
          unit,
          at: Date.now(),
          hourly,
          feels: Math.round(j.current.apparent_temperature),
          humidity: Math.round(j.current.relative_humidity_2m),
          dewPoint: Math.round(j.current.dew_point_2m),
          wind: Math.round(j.current.wind_speed_10m),
          windDir: j.current.wind_direction_10m ?? 0,
          gust: Math.round(j.current.wind_gusts_10m ?? 0),
          windUnit: unit === "F" ? "mph" : "km/h",
          uv: Math.round(j.current.uv_index ?? 0),
          pressure: Math.round(j.current.pressure_msl ?? 1013),
          visibility: j.current.visibility ?? 10000,
          precip: j.current.precipitation ?? 0,
          utcOffset: j.utc_offset_seconds ?? -new Date().getTimezoneOffset() * 60,
          sunrise: j.daily.sunrise[0],
          sunset: j.daily.sunset[0],
          tomorrowSunrise: j.daily.sunrise[1] ?? j.daily.sunrise[0],
          hours: (j.hourly?.time ?? []).slice(0, 25).map((t: string, i: number) => ({
            t,
            temp: Math.round(j.hourly.temperature_2m[i]),
            code: j.hourly.weather_code[i],
            isDay: !!j.hourly.is_day[i],
            pop: j.hourly.precipitation_probability?.[i] ?? 0,
          })),
          days: (j.daily.time ?? []).map((d: string, i: number) => ({
            date: d,
            max: Math.round(j.daily.temperature_2m_max[i]),
            min: Math.round(j.daily.temperature_2m_min[i]),
            code: j.daily.weather_code[i],
            pop: j.daily.precipitation_probability_max?.[i] ?? 0,
            uv: Math.round(j.daily.uv_index_max?.[i] ?? 0),
            precipSum: j.daily.precipitation_sum?.[i] ?? 0,
          })),
        },
      });
    } catch (e) {
      weatherStore.set((s) => ({ ...s, error: (e as Error).message || "Weather unavailable" }));
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function useWeather(city: string, unit: "C" | "F") {
  const s = useStore(weatherStore);
  useEffect(() => {
    refreshWeather(city, unit);
    const t = setInterval(() => refreshWeather(city, unit), 5 * 60_000);
    return () => clearInterval(t);
  }, [city, unit]);
  return s;
}

/** WMO weather code → short condition text. */
export function condition(code: number): string {
  if (code === 0) return "Clear";
  if (code <= 2) return "Partly Cloudy";
  if (code === 3) return "Cloudy";
  if (code <= 48) return "Foggy";
  if (code <= 57) return "Drizzle";
  if (code <= 67) return "Rain";
  if (code <= 77) return "Snow";
  if (code <= 82) return "Showers";
  if (code <= 86) return "Snow Showers";
  return "Thunderstorms";
}

export type Sky = "sun" | "moon" | "partly" | "partlyNight" | "cloud" | "fog" | "rain" | "snow" | "storm";
export function sky(code: number, isDay: boolean): Sky {
  if (code === 0) return isDay ? "sun" : "moon";
  if (code <= 2) return isDay ? "partly" : "partlyNight";
  if (code === 3) return "cloud";
  if (code <= 48) return "fog";
  if (code <= 67 || (code >= 80 && code <= 82)) return "rain";
  if (code <= 77 || code === 85 || code === 86) return "snow";
  return "storm";
}

/** Minutes since midnight at the weather location, right now. */
export function localMinutes(w: Weather): number {
  const d = new Date(Date.now() + (w.utcOffset ?? 0) * 1000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** "2026-11-17T07:12" → minutes since midnight. */
export function isoMinutes(iso: string): number {
  const m = /T(\d\d):(\d\d)/.exec(iso);
  return m ? +m[1] * 60 + +m[2] : 0;
}

/** "2026-11-17T16:52" → "4:52 PM" (location's own clock, shown as-is). */
export function isoClock(iso: string, withMinutes = true): string {
  const mins = isoMinutes(iso);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const h12 = h % 12 || 12;
  const ap = h < 12 ? "AM" : "PM";
  return withMinutes ? `${h12}:${String(m).padStart(2, "0")} ${ap}` : `${h12}${ap}`;
}
