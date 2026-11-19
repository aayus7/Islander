// Small persistent stores (localStorage, which WebView2 keeps between launches).
// A store is shared by every component that uses it and survives tab switches.
import { useSyncExternalStore } from "react";

export interface Store<T> {
  get(): T;
  set(v: T | ((prev: T) => T)): void;
  subscribe(l: () => void): () => void;
}

const stores = new Map<string, Store<any>>();

export function persistent<T>(key: string, initial: T): Store<T> {
  const existing = stores.get(key);
  if (existing) return existing;
  const k = `island:${key}`;
  let value: T = initial;
  try {
    const raw = localStorage.getItem(k);
    if (raw != null) {
      const parsed = JSON.parse(raw);
      const plain = (o: unknown) => !!o && typeof o === "object" && !Array.isArray(o);
      value = plain(initial) && plain(parsed) ? ({ ...initial, ...parsed } as T) : (parsed as T);
    }
  } catch {
    /* corrupt or unavailable storage → defaults */
  }
  const listeners = new Set<() => void>();
  const store: Store<T> = {
    get: () => value,
    set(v) {
      value = typeof v === "function" ? (v as (p: T) => T)(value) : v;
      try {
        localStorage.setItem(k, JSON.stringify(value));
      } catch {
        /* quota / private mode: keep in memory */
      }
      listeners.forEach((l) => l());
    },
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
  // Keep windows (island + settings) in sync.
  if (typeof window !== "undefined") {
    window.addEventListener("storage", (e) => {
      if (e.key !== k || e.newValue == null) return;
      try {
        value = JSON.parse(e.newValue);
        listeners.forEach((l) => l());
      } catch {
        /* ignore */
      }
    });
  }
  stores.set(key, store);
  return store;
}

export function useStore<T>(s: Store<T>): T {
  return useSyncExternalStore(s.subscribe, s.get, s.get);
}

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
