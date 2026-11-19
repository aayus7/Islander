// Thin helpers for the newer modules (shelf, clipboard, stats, system…).
// In the browser preview there is no backend: calls resolve to the given mock value and
// events only come from the preview's own demo bus (window.__islandDemo, used by the
// showcase recorder to stage notifications, downloads, AirDrop and so on). The Windows
// app never touches the demo bus.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "../bridge";

type Handler = (args?: Record<string, unknown>) => unknown;
interface DemoBus {
  listeners: Map<string, Set<(p: unknown) => void>>;
  handlers: Map<string, Handler>;
  emit(event: string, payload?: unknown): void;
  handle(cmd: string, fn: Handler): void;
}
function demoBus(): DemoBus {
  const w = window as unknown as { __islandDemo?: DemoBus };
  if (!w.__islandDemo) {
    const listeners = new Map<string, Set<(p: unknown) => void>>();
    const handlers = new Map<string, Handler>();
    w.__islandDemo = {
      listeners,
      handlers,
      emit: (event, payload) => listeners.get(event)?.forEach((l) => l(payload)),
      handle: (cmd, fn) => void handlers.set(cmd, fn),
    };
  }
  return w.__islandDemo;
}

export async function call<T = void>(cmd: string, args?: Record<string, unknown>, mock?: T): Promise<T> {
  if (!isTauri) {
    const h = demoBus().handlers.get(cmd);
    return (h ? h(args) : mock) as T;
  }
  return invoke<T>(cmd, args);
}

/** Fire-and-forget command (errors go to the console). */
export function send(cmd: string, args?: Record<string, unknown>) {
  if (!isTauri) {
    demoBus().handlers.get(cmd)?.(args);
    return;
  }
  invoke(cmd, args).catch((e) => console.error(cmd, e));
}

export function on<T>(event: string, cb: (payload: T) => void): () => void {
  if (!isTauri) {
    const bus = demoBus();
    const set = bus.listeners.get(event) ?? new Set();
    bus.listeners.set(event, set);
    const l = cb as (p: unknown) => void;
    set.add(l);
    return () => void set.delete(l);
  }
  const p = listen<T>(event, (e) => cb(e.payload));
  return () => void p.then((un) => un());
}
