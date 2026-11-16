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
  if (!force && cur.data && cur.key === key && Date.now() - cur.data.at < TTL) return Promise.resolve();
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const loc = await locate(city);
      const u = unit === "F" ? "&temperature_unit=fahrenheit" : "";
      const r = await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&current=temperature_2m,weather_code,is_day&daily=temperature_2m_max,temperature_2m_min&hourly=temperature_2m,weather_code,is_day&forecast_hours=6&timezone=auto${u}`,
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
