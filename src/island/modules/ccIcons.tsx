// Control Center glyphs that act out what they do when tapped:
// the plane takes off and lands, the padlock snaps shut, the moon swings,
// the appearance disc spins, the shutter fires, Wi-Fi radiates, and so on.
// Each takes `play` — bump it to replay the animation.
import { motion, useAnimate } from "motion/react";
import { useEffect, useRef } from "react";

type AnimateFn = ReturnType<typeof useAnimate>[1];

/** Runs `run` every time `play` changes (not on mount). */
function useReplay<T extends Element = SVGSVGElement>(play: number, run: (a: AnimateFn, root: T) => unknown) {
  const [scope, animate] = useAnimate<T>();
  const first = useRef(play);
  useEffect(() => {
    if (play === first.current || !scope.current) return;
    run(animate, scope.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [play]);
  return scope;
}

const box = { width: 20, height: 20, viewBox: "0 0 24 24", style: { overflow: "visible" } } as const;
/** Transform around a point of the element's own box (not the whole icon). */
const fb = (origin: string): React.CSSProperties => ({ transformBox: "fill-box", transformOrigin: origin });

/** Takes off up and to the right, comes back in from below and settles. */
export function PlaneIcon({ play }: { play: number }) {
  const scope = useReplay(play, async (a, root) => {
    const p = root.querySelector("g")!;
    await a(p, { x: [0, 3, 22], y: [0, -3, -26], rotate: [0, 8, 18], scale: [1, 1.05, 0.7], opacity: [1, 1, 0] }, { duration: 0.42, ease: [0.5, 0, 0.9, 0.4] });
    await a(p, { x: [-14, 0], y: [24, 0], rotate: [-14, 0], scale: [0.75, 1], opacity: [0, 1] }, { type: "spring", stiffness: 260, damping: 17 });
  });
  return (
    <svg ref={scope} {...box} fill="currentColor">
      <g style={fb("50% 50%")}>
        <path d="M21 15.5v-1.8l-7.6-4.9V4.3a1.4 1.4 0 0 0-2.8 0v4.5L3 13.7v1.8l7.6-2.4v4.6l-2 1.5v1.4l3.4-.9 3.4.9v-1.4l-2-1.5v-4.6z" />
      </g>
    </svg>
  );
}

/**
 * Apple-privacy-ad padlock: the shackle lifts open, then slams down into the
 * body with a little squash, and the keyhole blinks.
 */
export function LockIcon({ play }: { play: number }) {
  const scope = useReplay(play, async (a, root) => {
    const shackle = root.querySelector(".shackle")!;
    const body = root.querySelector(".body")!;
    const hole = root.querySelector(".hole")!;
    await a(shackle, { y: -4.2, rotate: -14 }, { duration: 0.16, ease: "easeOut" });
    a(shackle, { y: [-4.2, 0.9, 0], rotate: [-14, 0, 0] }, { duration: 0.24, times: [0, 0.55, 1], ease: ["easeIn", "easeOut"] });
    await new Promise((r) => setTimeout(r, 120));
    a(body, { scaleY: [1, 0.86, 1.04, 1], scaleX: [1, 1.08, 0.98, 1], y: [0, 0.8, 0, 0] }, { duration: 0.36, ease: "easeOut" });
    a(root, { scale: [1, 1.12, 1] }, { duration: 0.34, ease: "easeOut" });
    a(hole, { scale: [1, 0.2, 1.2, 1] }, { duration: 0.36 });
  });
  return (
    <svg ref={scope} {...box} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
      {/* Shackle hinges on its right leg, like a real padlock. */}
      <path className="shackle" d="M8 11V8a4 4 0 0 1 8 0v3" style={fb("100% 100%")} />
      <g className="body" style={fb("50% 100%")}>
        <rect x="5" y="10.5" width="14" height="10" rx="2.6" fill="currentColor" stroke="none" />
      </g>
      <circle className="hole" cx="12" cy="15.4" r="1.5" fill="#000" fillOpacity="0.55" stroke="none" style={fb("50% 50%")} />
    </svg>
  );
}

/** Do Not Disturb: the crescent swings like it's settling in for the night. */
export function MoonIcon({ play }: { play: number }) {
  const scope = useReplay(play, (a, root) => {
    a(root.querySelector("path")!, { rotate: [0, -40, 16, -6, 0], scale: [1, 0.85, 1.08, 1] }, { duration: 0.7, ease: "easeOut" });
    a(root.querySelectorAll(".star"), { opacity: [0, 1, 0], scale: [0.2, 1.2, 0.2] }, { duration: 0.6, delay: 0.12 });
  });
  return (
    <svg ref={scope} {...box} fill="currentColor">
      <path d="M20.5 14.6A8.6 8.6 0 0 1 9.4 3.5a8.6 8.6 0 1 0 11.1 11.1z" style={fb("50% 50%")} />
      <circle className="star" cx="19" cy="5" r="1.3" opacity="0" style={fb("50% 50%")} />
      <circle className="star" cx="15.5" cy="2.6" r="0.9" opacity="0" style={fb("50% 50%")} />
    </svg>
  );
}

/** Dark/Light: the filled half spins round to the other side (always clockwise). */
export function AppearanceIcon({ play, dark }: { play: number; dark: boolean }) {
  const scope = useReplay(play, (a, root) => {
    a(root, { scale: [1, 0.86, 1] }, { duration: 0.3 });
  });
  // Keep turning the same way: count half-turns instead of jumping between 0 and 180.
  const turns = useRef({ dark, n: dark ? 0 : 1 });
  if (turns.current.dark !== dark) turns.current = { dark, n: turns.current.n + 1 };
  return (
    <svg ref={scope} {...box} fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="8" />
      <motion.path
        d="M12 4a8 8 0 0 1 0 16z"
        fill="currentColor"
        stroke="none"
        initial={false}
        animate={{ rotate: turns.current.n * 180 }}
        transition={{ type: "spring", stiffness: 200, damping: 18 }}
        style={{ transformBox: "view-box", originX: "12px", originY: "12px" }}
      />
    </svg>
  );
}

/** Screenshot: the frame snaps in and the shutter fires. */
export function ScreenshotIcon({ play }: { play: number }) {
  const scope = useReplay(play, (a, root) => {
    a(root.querySelector(".frame")!, { scale: [1, 0.74, 1.06, 1] }, { duration: 0.42, ease: "easeOut" });
    a(root.querySelector(".shutter")!, { scale: [1, 0.2, 1.35, 1], opacity: [1, 0.4, 1, 1] }, { duration: 0.42 });
    a(root.querySelector(".flash")!, { opacity: [0, 0.9, 0], scale: [0.6, 1.4, 1.8] }, { duration: 0.4, delay: 0.1 });
  });
  return (
    <svg ref={scope} {...box} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path className="frame" d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" style={fb("50% 50%")} />
      <circle className="shutter" cx="12" cy="12" r="3" style={fb("50% 50%")} />
      <circle className="flash" cx="12" cy="12" r="4" fill="currentColor" stroke="none" opacity="0" style={fb("50% 50%")} />
    </svg>
  );
}

/** Sleep: the moon nods off and a "z" drifts up. */
export function SleepIcon({ play }: { play: number }) {
  const scope = useReplay(play, (a, root) => {
    a(root.querySelector(".moon")!, { rotate: [0, -24, 6, 0], y: [0, 1.5, 0] }, { duration: 0.7, ease: "easeInOut" });
    const z = root.querySelector(".z")!;
    a(z, { x: [0, 3, 0], y: [0, -7, 0], opacity: [1, 0, 1], scale: [1, 1.3, 1] }, { duration: 0.9, times: [0, 0.5, 1], ease: "easeInOut" });
  });
  return (
    <svg ref={scope} {...box} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path className="moon" d="M17.5 14.2A6.6 6.6 0 0 1 9.8 6.5a6.6 6.6 0 1 0 7.7 7.7z" fill="currentColor" stroke="none" style={fb("50% 50%")} />
      <path className="z" d="M15 3.5h4l-4 4.5h4" strokeWidth="1.8" style={fb("50% 50%")} />
    </svg>
  );
}

/** Pinned apps: the four tiles pop in turn. */
export function GridIcon({ play }: { play: number }) {
  const scope = useReplay(play, (a, root) => {
    root.querySelectorAll("rect").forEach((r, i) => a(r, { scale: [1, 0.35, 1.15, 1] }, { duration: 0.42, delay: [0, 0.06, 0.12, 0.18][i] }));
  });
  return (
    <svg ref={scope} {...box} fill="currentColor">
      {[
        [4, 4],
        [13, 4],
        [4, 13],
        [13, 13],
      ].map(([x, y]) => (
        <rect key={`${x}${y}`} x={x} y={y} width="7" height="7" rx="2" style={fb("50% 50%")} />
      ))}
    </svg>
  );
}

/** Wi-Fi: the signal radiates out from the dot, arc by arc. */
export function WifiIcon({ play, bars, size = 18 }: { play: number; bars: number; size?: number }) {
  const scope = useReplay(play, (a, root) => {
    a(root.querySelector(".dot")!, { scale: [1, 1.6, 1] }, { duration: 0.3 });
    root.querySelectorAll(".arc").forEach((p, i) => a(p, { opacity: [0.15, 1], scale: [0.7, 1.08, 1] }, { duration: 0.32, delay: 0.08 + (2 - i) * 0.08 }));
  });
  const lit = (n: number) => (bars === 0 || bars >= n ? 1 : 0.28);
  return (
    <svg ref={scope} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" style={{ overflow: "visible" }}>
      <path className="arc" d="M2.5 9.2a13.6 13.6 0 0 1 19 0" opacity={lit(4)} style={fb("50% 100%")} />
      <path className="arc" d="M5.9 12.7a8.8 8.8 0 0 1 12.2 0" opacity={lit(3)} style={fb("50% 100%")} />
      <path className="arc" d="M9.3 16.1a4 4 0 0 1 5.4 0" opacity={lit(2)} style={fb("50% 100%")} />
      <circle className="dot" cx="12" cy="19.6" r="1.6" fill="currentColor" stroke="none" style={fb("50% 50%")} />
    </svg>
  );
}

/** Bluetooth: the rune draws itself again and pulses. */
export function BtIcon({ play, size = 18 }: { play: number; size?: number }) {
  const scope = useReplay(play, (a, root) => {
    a(root.querySelector("path")!, { pathLength: [0, 1] }, { duration: 0.45, ease: "easeInOut" });
    a(root, { scale: [1, 0.85, 1.12, 1] }, { duration: 0.45 });
  });
  return (
    <svg ref={scope} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6.5 7.5l11 9.5-5.5 5V2l5.5 5-11 9.5" />
    </svg>
  );
}
