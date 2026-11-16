// Thin helpers for the newer modules (shelf, clipboard, stats, system…).
// In the browser preview there is no backend: calls resolve to the given mock value
// and events never fire, so every module still renders.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "../bridge";

export async function call<T = void>(cmd: string, args?: Record<string, unknown>, mock?: T): Promise<T> {
  if (!isTauri) return mock as T;
  return invoke<T>(cmd, args);
}

/** Fire-and-forget command (errors go to the console). */
export function send(cmd: string, args?: Record<string, unknown>) {
  if (!isTauri) return;
  invoke(cmd, args).catch((e) => console.error(cmd, e));
}

export function on<T>(event: string, cb: (payload: T) => void): () => void {
  if (!isTauri) return () => {};
  const p = listen<T>(event, (e) => cb(e.payload));
  return () => void p.then((un) => un());
}
