// Live audio levels from the backend, held in motion values so 30 updates a second
// never re-render React — the bars read them directly.
import { motionValue } from "motion/react";
import { bridge } from "../bridge";

export const BANDS = 6;
export const levels = Array.from({ length: BANDS }, () => motionValue(0));

let started = false;
export function startAudio() {
  if (started) return;
  started = true;
  bridge.onAudio((arr) => {
    for (let i = 0; i < BANDS; i++) levels[i].set(arr[i] ?? 0);
  });
}
