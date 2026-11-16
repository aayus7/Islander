// Privacy indicators, like iOS: a green dot while an app uses the camera, an orange
// dot while one uses the microphone. They sit just right of the island.
import { AnimatePresence, motion, useTransform, type MotionValue } from "motion/react";
import { useEffect, useState } from "react";
import { on } from "../../lib/native";

export interface PrivacyState {
  camera: boolean;
  mic: boolean;
  apps: string[];
}

export function PrivacyDots({ islandW, split }: { islandW: MotionValue<number>; split: boolean }) {
  const [p, setP] = useState<PrivacyState>({ camera: false, mic: false, apps: [] });
  useEffect(() => on<PrivacyState>("privacy://update", setP), []);
  // Just outside the island's right edge (past the split bubble when there is one).
  const x = useTransform(islandW, (w) => w / 2 + (split ? 37 + 10 + 8 : 8));
  const color = p.camera ? "#30d158" : "#ff9f0a";
  return (
    <AnimatePresence>
      {(p.camera || p.mic) && (
        <motion.span
          className="privacy-dot"
          title={`${p.camera ? "Camera" : "Microphone"} in use${p.apps.length ? ` — ${p.apps.join(", ")}` : ""}`}
          style={{ x, background: color, boxShadow: `0 0 6px ${color}` }}
          initial={{ scale: 0, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0, opacity: 0 }}
          transition={{ type: "spring", stiffness: 520, damping: 22 }}
        />
      )}
    </AnimatePresence>
  );
}
