// Privacy indicators, like iOS: a green dot while an app uses the camera, an orange
// dot while one uses the microphone. While the island is idle the dot sits in its
// middle; when the island opens it glides out to just beside its right edge.
import { AnimatePresence, motion, useSpring, useTransform, type MotionValue } from "motion/react";
import { useEffect, useState } from "react";
import { on } from "../../lib/native";
import { TOP } from "../Island";

export interface PrivacyState {
  camera: boolean;
  mic: boolean;
  apps: string[];
}

export function PrivacyDots({
  islandW,
  islandH,
  split,
  centered,
  attached,
}: {
  islandW: MotionValue<number>;
  islandH: MotionValue<number>;
  split: boolean;
  centered: boolean;
  /** The waterdrop notch: its black area starts at the very top of the screen. */
  attached: boolean;
}) {
  const [p, setP] = useState<PrivacyState>({ camera: false, mic: false, apps: [] });
  useEffect(() => on<PrivacyState>("privacy://update", setP), []);
  // 0 = centred in the island, 1 = beside it. Sprung, so it glides between the two.
  const side = useSpring(centered ? 0 : 1, { stiffness: 380, damping: 32 });
  useEffect(() => side.set(centered ? 0 : 1), [centered, side]);
  const x = useTransform(() => side.get() * (islandW.get() / 2 + (split ? 37 + 10 + 11.5 : 11.5)));
  const y = useTransform(() => {
    // Centre of the visible black shape (the notch also covers the gap above the island).
    const mid = attached ? (TOP + islandH.get()) / 2 : TOP + islandH.get() / 2;
    const beside = TOP + 14; // level with the top of the open island
    return mid + (beside - mid) * side.get();
  });
  const color = p.camera ? "#30d158" : "#ff9f0a";
  return (
    <AnimatePresence>
      {(p.camera || p.mic) && (
        <motion.span
          className={`privacy-dot ${centered ? "breathe" : ""}`}
          title={`${p.camera ? "Camera" : "Microphone"} in use${p.apps.length ? ` — ${p.apps.join(", ")}` : ""}`}
          style={{ x, y, background: color, color }}
          initial={{ scale: 0, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0, opacity: 0 }}
          transition={{ type: "spring", stiffness: 520, damping: 22 }}
        />
      )}
    </AnimatePresence>
  );
}
