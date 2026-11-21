// Large artwork for the cover card. Media apps hand Windows small covers (Spotify ~300 px,
// the browser extension 384 px), which turn soft when the cover grows into the big card.
// The backend finds the same cover at full size (movies: the large poster; music: iTunes,
// then Deezer, only when artist and title agree). It's asked as soon as a track starts
// playing, so the big cover is usually ready before anyone opens the card.
import { useEffect, useState } from "react";
import type { MediaSession } from "../bridge";
import { call } from "./native";
import { isVideoPlayer } from "./posters";
import { toBlobUrl } from "./artref";

// key → blob: URL of the large cover (null = none). Oldest first; capped so a long listening
// session doesn't keep every cover in memory (the backend's disk cache still has them all).
const cache = new Map<string, string | null>();
const LIMIT = 30;

function store(key: string, url: string | null) {
  cache.set(key, url && url.startsWith("data:") ? toBlobUrl(url) ?? url : url);
  while (cache.size > LIMIT) {
    const [k, v] = cache.entries().next().value!;
    cache.delete(k);
    if (v?.startsWith("blob:")) URL.revokeObjectURL(v);
  }
}

function touch(key: string) {
  const v = cache.get(key);
  if (v === undefined) return;
  cache.delete(key);
  cache.set(key, v);
}
const waiting = new Set<string>();
const subs = new Set<() => void>();

export function hiresKey(s: MediaSession | null | undefined): string | null {
  if (!s) return null;
  if (s.imdb) return `imdb:${s.imdb}`;
  // A video player without a matched movie has nothing to look up; nor does a video in the
  // browser (its own wide thumbnail is the cover, not the song's album art).
  if (s.artworkWide || isVideoPlayer(s) || !s.title || !s.artist || s.title === "Advertisement") return null;
  return `m:${s.artist}\u0001${s.title}\u0001${s.album ?? ""}`;
}

export function requestHiRes(s: MediaSession | null | undefined) {
  const key = hiresKey(s);
  if (!s || !key || cache.has(key) || waiting.has(key)) return;
  waiting.add(key);
  call<string | null>("hires_art", { artist: s.artist ?? "", title: s.title ?? "", album: s.album ?? "", imdb: s.imdb ?? null }, null)
    .then((url) => store(key, url || null))
    .catch(() => store(key, null))
    .finally(() => {
      waiting.delete(key);
      subs.forEach((f) => f());
    });
}

/**
 * The large cover for this session: `url` once it has arrived, `pending` while it's still
 * being looked up (so the card can open at full size and sharpen when it lands).
 */
export function useHiRes(s: MediaSession | null | undefined): { url: string | null; pending: boolean } {
  const [, bump] = useState(0);
  const key = hiresKey(s);
  useEffect(() => {
    const f = () => bump((n) => n + 1);
    subs.add(f);
    return () => void subs.delete(f);
  }, []);
  useEffect(() => requestHiRes(s), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!key) return { url: null, pending: false };
  touch(key);
  return { url: cache.get(key) ?? null, pending: !cache.has(key) };
}

/** Start fetching large covers for whatever is playing, before the card is opened. */
export function usePrefetchHiRes(sessions: MediaSession[]) {
  const keys = sessions.filter((s) => s.playing).map(hiresKey).join("\u0002");
  useEffect(() => {
    sessions.filter((s) => s.playing).forEach(requestHiRes);
  }, [keys]); // eslint-disable-line react-hooks/exhaustive-deps
}
