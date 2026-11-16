// System HUD pills: volume, brightness, Caps Lock and Num Lock morph out of the island
// instead of Windows' own flyouts.
import { motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { on } from "../../lib/native";
import { useSettings } from "../../lib/settings";

export interface HudData {
  kind: "volume" | "mute" | "brightness" | "caps" | "num";
  value: number; // 0..1 for volume/brightness
  on: boolean; // muted (volume) or lock state
  seq: number;
}

export const HUD_SIZE = { w: 250, h: 37, r: 18.5 };
/** The Ring/Silent-style mute pill is a little larger, like iOS. */
export const MUTE_SIZE = { w: 268, h: 40, r: 20 };
export const RED = "#ff453a";

export function useHud(): HudData | null {
  const { settings } = useSettings();
  const [hud, setHud] = useState<HudData | null>(null);
  const t = useRef(0);
  const seq = useRef(0);
  useEffect(() => {
    if (!settings.hud) {
      setHud(null);
      return;
    }
    return on<Omit<HudData, "seq">>("hud://show", (h) => {
      setHud({ ...h, seq: ++seq.current });
      clearTimeout(t.current);
      t.current = window.setTimeout(() => setHud(null), h.kind === "caps" || h.kind === "num" ? 1300 : 1600);
    });
  }, [settings.hud]);
  return hud;
}

export function Hud({ hud }: { hud: HudData }) {
  if (hud.kind === "mute") return <MutePill muted={hud.on} />;
  const lock = hud.kind === "caps" || hud.kind === "num";
  return (
    <div className="hud" style={{ width: HUD_SIZE.w, height: HUD_SIZE.h }}>
      <span className="hud-icon">
        {hud.kind === "volume" ? <Speaker level={hud.on ? 0 : hud.value} muted={hud.on} /> : hud.kind === "brightness" ? <Sun /> : <LockGlyph kind={hud.kind} />}
      </span>
      {lock ? (
        <span className="hud-text">
          {hud.kind === "caps" ? "Caps Lock" : "Num Lock"}
          <motion.span className="hud-state" animate={{ color: hud.on ? "#30d158" : "rgba(235,235,245,0.6)" }}>
            {hud.on ? "On" : "Off"}
          </motion.span>
        </span>
      ) : (
        <div className="hud-bar">
          <motion.div
            className="hud-fill"
            initial={false}
            animate={{ width: `${Math.round((hud.kind === "volume" && hud.on ? 0 : hud.value) * 100)}%` }}
            transition={{ type: "spring", stiffness: 600, damping: 40 }}
          />
        </div>
      )}
    </div>
  );
}

function Speaker({ level, muted }: { level: number; muted: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z" fill="currentColor" />
      {muted ? (
        <path d="M16 9.5l5 5M21 9.5l-5 5" />
      ) : (
        <>
          {level > 0.02 && <path d="M15.5 9a4 4 0 0 1 0 6" />}
          {level > 0.5 && <path d="M18.2 6.5a7.5 7.5 0 0 1 0 11" />}
        </>
      )}
    </svg>
  );
}

function Sun() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" />
      {Array.from({ length: 8 }, (_, i) => {
        const a = (i * Math.PI) / 4;
        return <line key={i} x1={12 + Math.cos(a) * 7} y1={12 + Math.sin(a) * 7} x2={12 + Math.cos(a) * 9.2} y2={12 + Math.sin(a) * 9.2} />;
      })}
    </svg>
  );
}

function LockGlyph({ kind }: { kind: "caps" | "num" }) {
  return kind === "caps" ? (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
      <path d="M12 3.5l8 8.5h-4.5v5h-7v-5H4z" />
      <path d="M8.5 20.5h7" strokeLinecap="round" />
    </svg>
  ) : (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <rect x="4" y="4" width="16" height="16" rx="4" />
      <path d="M10 9v6M14 9v6M8.5 11h7M8.5 13h7" strokeWidth="1.7" />
    </svg>
  );
}

/**
 * iOS Ring/Silent switch, for the speaker: the glyph swings in with a little wiggle,
 * the slash draws across when muting, and the label reads Sound / Silent.
 * Muted turns the glyph, label (and the island's outline) red.
 */
function MutePill({ muted }: { muted: boolean }) {
  const color = muted ? RED : "#fff";
  return (
    <div className="mute-pill" style={{ width: MUTE_SIZE.w, height: MUTE_SIZE.h }}>
      <motion.span
        className="mute-icon"
        style={{ color, transformOrigin: "40% 50%" }}
        initial={{ rotate: 0, scale: 0.7 }}
        animate={{ rotate: [0, -24, 18, -11, 6, -2, 0], scale: [0.7, 1.12, 1] }}
        transition={{ rotate: { duration: 0.75, ease: "easeOut" }, scale: { duration: 0.45, ease: [0.2, 0.9, 0.3, 1.2] } }}
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3.5 9.5v5h3.6L12 18.6V5.4L7.1 9.5z" fill="currentColor" stroke="none" />
          {muted ? (
            <motion.path d="M15.5 9.5l5 5M20.5 9.5l-5 5" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.3, delay: 0.12 }} />
          ) : (
            <>
              <motion.path d="M15.5 9a4 4 0 0 1 0 6" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.1 }} />
              <motion.path d="M18.2 6.5a7.5 7.5 0 0 1 0 11" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.2 }} />
            </>
          )}
        </svg>
      </motion.span>
      <motion.span
        className="mute-label"
        style={{ color }}
        initial={{ opacity: 0, filter: "blur(6px)", x: 6 }}
        animate={{ opacity: 1, filter: "blur(0px)", x: 0 }}
        transition={{ duration: 0.35, delay: 0.08 }}
      >
        {muted ? "Silent" : "Sound"}
      </motion.span>
    </div>
  );
}
