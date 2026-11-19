// Posters for movies and episodes playing in a video player (mpv from Stremio, VLC,
// MPC, PotPlayer…). Those apps only report a file name like
// "Interstellar.2014.2160p.UHD.BluRay.x265-GRP.mkv", so we clean it into a title (+ year,
// or a series when it has S01E02) and ask the backend to look the poster up (Cinemeta,
// Stremio's own metadata service). The poster then stands in for the album art.
import { useEffect, useState } from "react";
import type { MediaSession } from "../bridge";
import { call } from "./native";

const PLAYERS = /\b(mpv|vlc|mpc|mpc-hc|mpc-be|potplayer|stremio|kmplayer|smplayer|celluloid|iina|media player classic|movies & tv|films & tv)\b/i;

export function isVideoPlayer(s: MediaSession) {
  return PLAYERS.test(s.app) || PLAYERS.test(s.id);
}

// Release-name noise that ends the title part.
const NOISE =
  /\b(2160p|1080p|720p|576p|480p|4k|8k|uhd|fhd|hd|bluray|blu ray|bdrip|brrip|web ?dl|web ?rip|webrip|hdrip|dvdrip|dvd|hdtv|x26[45]|h ?26[45]|hevc|avc|av1|hdr10\+?|hdr|dv|dolby vision|remux|proper|repack|extended|unrated|imax|directors cut|10bit|8bit|aac|ac3|eac3|ddp?5 1|dts|atmos|truehd|yts|yify|rarbg|multi|dual audio|hindi|english|esub|subs?)\b/i;

export interface PosterQuery {
  query: string;
  year?: number;
  series: boolean;
}

export function parseTitle(raw: string): PosterQuery | null {
  let t = (raw ?? "").trim();
  if (!t) return null;
  // A URL (streams): its last path part is the file name.
  if (/^[a-z]+:\/\//i.test(t)) {
    try {
      t = decodeURIComponent(t.split(/[?#]/)[0].split("/").filter(Boolean).pop() ?? "");
    } catch {
      t = t.split("/").pop() ?? "";
    }
  }
  t = t
    .replace(/\.(mkv|mp4|avi|mov|webm|m4v|ts|m2ts|wmv|flv|mpg|mpeg)$/i, "")
    .replace(/^(www\.)?[\w-]+\.(com|org|net|to|me|ws|in|cc)\s*[-–]\s*/i, "") // "www.site.com - " prefixes
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/[._]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const clean = (s: string) =>
    s
      .replace(/\([^)]*\)/g, " ")
      .replace(/[\s([{\-–:|]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();

  // Series: "Show Name S02E05" / "Show Name 2x05"
  const se = t.match(/^(.*?)\s*\b[Ss](\d{1,2})\s?[Ee](\d{1,3})\b/) ?? t.match(/^(.*?)\s*\b(\d{1,2})x(\d{2})\b/);
  if (se && clean(se[1]).length >= 2) return { query: clean(se[1]), series: true };

  // Movie with a year: "Title 2014 …" / "Title (2014)". The *last* year wins, so a
  // year inside the title ("Blade Runner 2049 2017") stays part of it.
  const y = t.match(/^(.+)\s*[([]?\b((?:19|20)\d{2})\b[)\]]?(?:\s|$)/);
  if (y && clean(y[1]).length >= 2) return { query: clean(y[1]), year: +y[2], series: false };

  // No year: cut at the first quality/release tag.
  const q = clean(t.split(NOISE)[0] ?? t);
  return q.length >= 2 ? { query: q, series: false } : null;
}

const known = new Map<string, string | null>(); // title → poster (null = none found)
const waiting = new Set<string>();

/** The sessions, with posters standing in for the artwork of movies/episodes in video players. */
export function usePosterArt(sessions: MediaSession[]): MediaSession[] {
  const [, bump] = useState(0);
  const wanted = sessions.filter((s) => isVideoPlayer(s) && s.title).map((s) => s.title);
  useEffect(() => {
    for (const title of wanted) {
      if (known.has(title) || waiting.has(title)) continue;
      const q = parseTitle(title);
      if (!q) {
        known.set(title, null);
        continue;
      }
      waiting.add(title);
      call<string | null>("movie_poster", { query: q.query, year: q.year ?? null, series: q.series }, null)
        .then((p) => known.set(title, p ?? null))
        .catch(() => known.set(title, null))
        .finally(() => {
          waiting.delete(title);
          bump((n) => n + 1);
        });
    }
  }, [wanted.join("\u0001")]); // eslint-disable-line react-hooks/exhaustive-deps
  return sessions.map((s) => {
    const p = isVideoPlayer(s) ? known.get(s.title) : null;
    return p ? { ...s, artwork: p } : s;
  });
}
