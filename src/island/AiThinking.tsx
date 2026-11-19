// The AI "thinking" spinner: a ring of soft glowing dots where a swell travels
// round and round (the big dots chase each other), like iOS' Dynamic Island
// activity indicator. While Gemini thinks, the island shrinks down to just this.
import { motion, useAnimationFrame } from "motion/react";
import { useRef } from "react";

// A circle hugging the spinner: 26px of dots plus a slim ring of island around them.
export const THINKING_SIZE = { w: 38, h: 38, r: 19 };

const N = 8;

export function DotSpinner({ size = 26 }: { size?: number }) {
  const dots = useRef<(SVGCircleElement | null)[]>([]);
  const c = size / 2;
  const R = size * 0.36;
  useAnimationFrame((t) => {
    const phase = (t / 1000) * 1.55 * Math.PI * 2 * 0.5; // ~0.78 turns per second
    dots.current.forEach((el, i) => {
      if (!el) return;
      const a = (i / N) * Math.PI * 2;
      // Distance (around the ring) from the moving swell, 0 = right under it.
      let d = (((a - phase) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      d = Math.min(d, Math.PI * 2 - d);
      const swell = Math.exp(-(d * d) / 1.1); // soft bump spanning ~3 dots
      const r = size * (0.06 + 0.065 * swell);
      el.setAttribute("r", r.toFixed(2));
      el.setAttribute("opacity", (0.45 + 0.55 * swell).toFixed(2));
      // The ring itself rotates slowly too, so it never looks static.
      const rot = a + phase * 0.35;
      el.setAttribute("cx", (c + Math.cos(rot) * R).toFixed(2));
      el.setAttribute("cy", (c + Math.sin(rot) * R).toFixed(2));
    });
  });
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ overflow: "visible", filter: "drop-shadow(0 0 3px rgba(255,255,255,0.75)) drop-shadow(0 0 7px rgba(255,255,255,0.35))" }}>
      {Array.from({ length: N }, (_, i) => (
        <circle key={i} ref={(el) => void (dots.current[i] = el)} cx={c} cy={c} r={1} fill="#f2f2f7" />
      ))}
    </svg>
  );
}

/** What the island shows while Gemini is thinking: just the spinner, centred. */
export function AiThinking() {
  return (
    <motion.div
      className="ai-thinking-pill"
      style={{ width: THINKING_SIZE.w, height: THINKING_SIZE.h }}
      initial={{ opacity: 0, scale: 0.6, filter: "blur(4px)" }}
      animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
      exit={{ opacity: 0, scale: 0.6, filter: "blur(4px)" }}
      transition={{ type: "spring", stiffness: 420, damping: 30 }}
    >
      <DotSpinner />
    </motion.div>
  );
}
