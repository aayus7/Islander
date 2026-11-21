// Bluetooth device artwork + the "Connected" and power live activities.
//
// * DeviceIcon — flat, SF-Symbols-like glyphs for each AirPods model, over-ear
//   headphones (AirPods Max, Bose QC Ultra…), speakers, mice, keyboards, controllers.
// * DeviceActivity — iOS' "Connected" activity: the device turns a full 360° next to
//   its name, with a battery ring on the right.
// * PowerActivity — "Charging 66 %" (green) / "Low Battery 12 %" (red).
import { motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { on } from "../../lib/native";

export type DeviceModel = "airpods" | "airpods3" | "airpodspro" | "airpodsmax" | "headphones" | "earbuds" | "speaker" | "mouse" | "keyboard" | "controller" | "phone" | "other";

export interface BtDevice {
  id: string;
  name: string;
  connected: boolean;
  kind: string;
  battery: number | null;
  audio: boolean;
}

/** Which artwork a device gets — by name first (AirPods models, "Jet" = Bose QC Ultra), then by type. */
export function modelOf(name: string, kind: string): DeviceModel {
  const n = name.toLowerCase();
  if (/airpods\s*max/.test(n)) return "airpodsmax";
  if (/airpods\s*pro/.test(n)) return "airpodspro";
  if (/airpods.*\b(3|4|3rd|4th|third|fourth)\b/.test(n) || /airpods\s*(3|4)/.test(n)) return "airpods3";
  if (/airpods/.test(n)) return "airpods";
  if (n.trim() === "jet" || /bose|qc\s*ultra|quietcomfort|headphones?\b|wh-1000|xm[3-6]|studio pro/.test(n)) return "headphones";
  if (/buds|earbud|wf-|beats|powerbeats|nothing ear/.test(n)) return "earbuds";
  switch (kind) {
    case "headphones":
      return "headphones";
    case "earbuds":
      return "earbuds";
    case "speaker":
    case "mouse":
    case "keyboard":
    case "controller":
    case "phone":
      return kind;
    default:
      return "other";
  }
}

/** A friendly display name: "Jet" is the user's Bose QC Ultra. */
export function subtitleOf(model: DeviceModel, name: string) {
  if (name.trim().toLowerCase() === "jet") return "Bose QC Ultra Headphones";
  return (
    {
      airpods: "AirPods",
      airpods3: "AirPods",
      airpodspro: "AirPods Pro",
      airpodsmax: "AirPods Max",
      headphones: "Headphones",
      earbuds: "Earbuds",
      speaker: "Speaker",
      mouse: "Mouse",
      keyboard: "Keyboard",
      controller: "Controller",
      phone: "Phone",
      other: "Bluetooth device",
    } as const
  )[model];
}

/* ---------------- flat glyphs ---------------- */

/** Monochrome glyph (uses currentColor), for lists and tiles. */
export function DeviceIcon({ model, size = 22 }: { model: DeviceModel; size?: number }) {
  const p = {
    width: size,
    height: size,
    viewBox: "0 0 32 32",
    fill: "currentColor",
  } as const;
  switch (model) {
    case "airpods":
      // Two buds with long stems.
      return (
        <svg {...p}>
          <Bud x={9.5} stem={15} pro={false} />
          <Bud x={22.5} stem={15} pro={false} mirror />
        </svg>
      );
    case "airpods3":
      // Shorter stems, wider heads.
      return (
        <svg {...p}>
          <Bud x={9.5} stem={10} pro={false} wide />
          <Bud x={22.5} stem={10} pro={false} wide mirror />
        </svg>
      );
    case "airpodspro":
    case "earbuds":
      return (
        <svg {...p}>
          <Bud x={8.8} stem={8} pro />
          <Bud x={23.2} stem={8} pro mirror />
        </svg>
      );
    case "airpodsmax":
      return (
        <svg {...p}>
          {/* mesh canopy + stainless band */}
          <path d="M6.6 15.5V12a9.4 9.4 0 0 1 18.8 0v3.5h-2.3V12a7.1 7.1 0 0 0-14.2 0v3.5z" />
          <rect x="3.6" y="14.4" width="7" height="12.6" rx="3.3" />
          <rect x="21.4" y="14.4" width="7" height="12.6" rx="3.3" />
          <rect x="8.2" y="15.6" width="1.4" height="10.2" rx="0.7" opacity="0.45" fill="#000" />
          <rect x="22.4" y="15.6" width="1.4" height="10.2" rx="0.7" opacity="0.45" fill="#000" />
          <rect x="4.7" y="11.6" width="1.6" height="3.6" rx="0.8" />
        </svg>
      );
    case "headphones":
      // Bose-style over-ears: thin band, oval cups on yokes.
      return (
        <svg {...p}>
          <path d="M5.4 17.5V14a10.6 10.6 0 0 1 21.2 0v3.5h-2.2V14a8.4 8.4 0 0 0-16.8 0v3.5z" />
          <path d="M6.3 16.2h1.2v2.2H6.3zM24.5 16.2h1.2v2.2h-1.2z" />
          <ellipse cx="7.3" cy="22.4" rx="3.9" ry="5.4" />
          <ellipse cx="24.7" cy="22.4" rx="3.9" ry="5.4" />
          <ellipse cx="9.4" cy="22.4" rx="1.2" ry="3.9" fill="#000" opacity="0.35" />
          <ellipse cx="22.6" cy="22.4" rx="1.2" ry="3.9" fill="#000" opacity="0.35" />
        </svg>
      );
    case "speaker":
      return (
        <svg {...p}>
          <rect x="8" y="3.5" width="16" height="25" rx="4" />
          <circle cx="16" cy="19" r="5.2" fill="#000" opacity="0.4" />
          <circle cx="16" cy="19" r="2.2" />
          <circle cx="16" cy="9.5" r="2.1" fill="#000" opacity="0.4" />
        </svg>
      );
    case "mouse":
      return (
        <svg {...p}>
          <path d="M16 3.5c-5 0-8 3.6-8 8.6v7.4c0 5 3.3 9 8 9s8-4 8-9v-7.4c0-5-3-8.6-8-8.6z" />
          <rect x="15" y="7" width="2" height="5" rx="1" fill="#000" opacity="0.45" />
        </svg>
      );
    case "keyboard":
      return (
        <svg {...p}>
          <rect x="2.5" y="8.5" width="27" height="15" rx="3" />
          <g fill="#000" opacity="0.45">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <rect key={`a${i}`} x={5.4 + i * 3.7} y="11.3" width="2.4" height="2.4" rx="0.6" />
            ))}
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <rect key={`b${i}`} x={5.4 + i * 3.7} y="15" width="2.4" height="2.4" rx="0.6" />
            ))}
            <rect x="9.1" y="18.8" width="13.8" height="2.2" rx="0.6" />
          </g>
        </svg>
      );
    case "controller":
      return (
        <svg {...p}>
          <path d="M9.5 9h13c3.4 0 5.4 2.4 6 6l1 6.4c.5 3-2.6 4.8-4.6 2.6L22 21H10l-2.9 3c-2 2.2-5.1.4-4.6-2.6l1-6.4c.6-3.6 2.6-6 6-6z" />
          <g fill="#000" opacity="0.45">
            <rect x="8.4" y="12" width="1.8" height="6" rx="0.5" />
            <rect x="6.3" y="14.1" width="6" height="1.8" rx="0.5" />
            <circle cx="22" cy="12.6" r="1.2" />
            <circle cx="24.4" cy="15" r="1.2" />
            <circle cx="19.6" cy="15" r="1.2" />
            <circle cx="22" cy="17.4" r="1.2" />
          </g>
        </svg>
      );
    case "phone":
      return (
        <svg {...p}>
          <rect x="9" y="2.5" width="14" height="27" rx="3.6" />
          <rect x="13.4" y="4.6" width="5.2" height="1.6" rx="0.8" fill="#000" opacity="0.5" />
        </svg>
      );
    default:
      return (
        <svg {...p} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10 10.5l12 11-6 5.5V5l6 5.5-12 11" />
        </svg>
      );
  }
}

/** One earbud: round head + stem (+ silicone tip for Pro). */
function Bud({ x, stem, pro, wide, mirror }: { x: number; stem: number; pro: boolean; wide?: boolean; mirror?: boolean }) {
  const headR = pro ? 4.6 : wide ? 4.8 : 4.3;
  const top = pro ? 8 : 6;
  const t = mirror ? `translate(${2 * x} 0) scale(-1 1)` : undefined;
  return (
    <g transform={t}>
      <circle cx={x} cy={top + headR} r={headR} />
      {pro && <ellipse cx={x + headR - 0.4} cy={top + 2.2} rx="2.6" ry="2.2" transform={`rotate(-30 ${x + headR - 0.4} ${top + 2.2})`} opacity="0.7" />}
      <rect x={x - 1.9} y={top + headR} width="3.8" height={stem + 2} rx="1.9" />
      <circle cx={x - 1.2} cy={top + headR - 0.5} r="1.1" fill="#000" opacity="0.4" />
    </g>
  );
}

/* ---------------- shaded artwork for the live activity ---------------- */

/**
 * The product "photo" for the activity: the glyph drawn in white with soft
 * shading, split into left/right halves sitting at different depths so the
 * 360° turn has real parallax (like the rotating AirPods on iOS).
 */
function DeviceArt({ model, size }: { model: DeviceModel; size: number }) {
  const shade = (
    <defs>
      <linearGradient id="dev-shade" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="#ffffff" />
        <stop offset="0.55" stopColor="#e9e9ee" />
        <stop offset="1" stopColor="#b9b9c2" />
      </linearGradient>
    </defs>
  );
  const half = (side: "l" | "r") => (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      style={{
        position: "absolute",
        inset: 0,
        clipPath: side === "l" ? "inset(0 50% 0 0)" : "inset(0 0 0 50%)",
      }}
    >
      {shade}
      <g fill="url(#dev-shade)" style={{ color: "#f2f2f5" }}>
        <DeviceIconInner model={model} />
      </g>
    </svg>
  );
  // Over-ear / speakers are one piece; earbuds are two.
  const split = model === "airpods" || model === "airpods3" || model === "airpodspro" || model === "earbuds";
  if (model === "other")
    return (
      <div style={{ color: "#f2f2f5" }}>
        <DeviceIcon model="other" size={size} />
      </div>
    );
  return (
    <div
      style={{
        position: "relative",
        width: size,
        height: size,
        transformStyle: "preserve-3d",
      }}
    >
      {split ? (
        <>
          <div
            style={{
              position: "absolute",
              inset: 0,
              transform: "translateZ(7px)",
            }}
          >
            {half("l")}
          </div>
          <div
            style={{
              position: "absolute",
              inset: 0,
              transform: "translateZ(-7px)",
            }}
          >
            {half("r")}
          </div>
        </>
      ) : (
        <div style={{ position: "absolute", inset: 0 }}>
          {half("l")}
          {half("r")}
        </div>
      )}
    </div>
  );
}

/** DeviceIcon's shapes without its own <svg>, for embedding. */
function DeviceIconInner({ model }: { model: DeviceModel }) {
  // Render the glyph and lift its children out (it's a static SVG tree).
  const el = DeviceIcon({ model, size: 32 }) as React.ReactElement<{
    children: React.ReactNode;
  }>;
  return <>{el.props.children}</>;
}

/* ---------------- activities ---------------- */

export type PowerKind = "charging" | "unplugged" | "low";
export type Activity = { kind: "device"; id: number; device: BtDevice } | { kind: PowerKind; id: number; percent: number };

export const DEVICE_SIZE = { w: 352, h: 76, r: 38 };
export const POWER_SIZE = { w: 300, h: 37, r: 18.5 };
export const GREEN = "#30d158";
export const RED = "#ff453a";

/** Device connections and power events, shown one at a time for a few seconds. */
export function useActivity(): Activity | null {
  const [act, setAct] = useState<Activity | null>(null);
  const timer = useRef(0);
  const seq = useRef(0);
  useEffect(() => {
    const show = (a: Activity, ms: number) => {
      setAct(a);
      clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setAct(null), ms);
    };
    const offs = [
      on<BtDevice>("bt://connected", (device) => show({ kind: "device", id: ++seq.current, device }, 4600)),
      on<{ kind: PowerKind; percent: number }>("power://alert", (p) => show({ kind: p.kind, id: ++seq.current, percent: p.percent }, p.kind === "low" ? 5000 : 3400)),
      // The headset's battery usually arrives a second after it connects: fill the ring in.
      on<[string, number]>("bt://battery", ([name, level]) =>
        setAct((a) => (a?.kind === "device" && a.device.name === name && a.device.battery == null ? { ...a, device: { ...a.device, battery: level } } : a)),
      ),
    ];
    // Preview / testing hook: window.dispatchEvent(new CustomEvent("island:activity", { detail }))
    const test = (e: Event) => {
      const a = (e as CustomEvent<Activity>).detail;
      show({ ...a, id: ++seq.current }, 600000);
    };
    window.addEventListener("island:activity", test);
    return () => {
      offs.forEach((off) => off());
      window.removeEventListener("island:activity", test);
    };
  }, []);
  return act;
}

/**
 * 360° turntable clips for AirPods and Beats (from AirPodsDesktop by SpriteOvO, GPL-3.0;
 * magenta background keyed out to transparent WebM). Matched by the device's name.
 */
export function deviceVideo(name: string): string | null {
  const n = name.toLowerCase();
  const file = /beats\s*fit\s*pro/.test(n)
    ? "beats-fit-pro"
    : /airpods\s*max/.test(n)
      ? "airpods-max"
      : /airpods\s*pro/.test(n)
        ? /\b(3|3rd|third)\b/.test(n)
          ? "airpods-pro-3"
          : /\b(1|1st|first)\b/.test(n)
            ? "airpods-pro"
            : "airpods-pro-2"
        : /airpods/.test(n)
          ? /\b4\b|4th|fourth/.test(n)
            ? /anc|noise/.test(n)
              ? "airpods-4-anc"
              : "airpods-4"
            : /\b3\b|3rd|third/.test(n)
              ? "airpods-3"
              : /\b1\b|1st|first/.test(n)
                ? "airpods-1"
                : "airpods-2"
          : null;
  return file ? `/devices/${file}.webm` : null;
}

/**
 * Some clips frame the product much smaller than the rest (AirPods Max fills about half the
 * frame the others do), so each gets a zoom and vertical nudge that evens out the visual size.
 * `w` narrows the slot for products that are roughly square (the Max), so they don't sit in
 * the middle of empty space meant for a pair of buds plus a case; the clip overflows the
 * slot evenly on both sides, which is invisible because those edges are transparent.
 */
type Fit = { s: number; y: number; w?: number };
const VIDEO_FIT: Record<string, Fit> = {
  "airpods-max": { s: 1.5, y: 3.4, w: 50 },
};
const fitOf = (src: string): Fit => VIDEO_FIT[src.replace(/^.*\/|\.webm$/g, "")] ?? { s: 1, y: 0 };

function DeviceVideo({ src }: { src: string }) {
  const fit = fitOf(src);
  return (
    <motion.video
      className="dev-video"
      src={src}
      autoPlay
      muted
      loop
      playsInline
      onLoadedMetadata={(e) => (e.currentTarget.playbackRate = 1.5)}
      initial={{ opacity: 0, scale: 0.85 * fit.s, y: fit.y }}
      animate={{ opacity: 1, scale: fit.s, y: fit.y }}
      transition={{ type: "spring", stiffness: 260, damping: 24, delay: 0.1 }}
    />
  );
}

export function DeviceActivity({ device }: { device: BtDevice }) {
  const model = modelOf(device.name, device.kind);
  const level = device.battery;
  const video = deviceVideo(device.name);
  return (
    <div className="dev-act" style={{ width: DEVICE_SIZE.w, height: DEVICE_SIZE.h }}>
      {video ? (
        <div
          className="dev-art wide"
          style={fitOf(video).w ? { width: fitOf(video).w, marginLeft: 0 } : undefined}
        >
          <DeviceVideo src={video} />
        </div>
      ) : (
      <div className="dev-art">
        <motion.div
          style={{ width: 46, height: 46, transformStyle: "preserve-3d" }}
          initial={{ rotateY: 0 }}
          animate={{ rotateY: 360 }}
          transition={{ duration: 1.9, delay: 0.25, ease: [0.45, 0, 0.2, 1] }}
        >
          <DeviceArt model={model} size={46} />
        </motion.div>
      </div>
      )}
      <div className="dev-text">
        <span className="dev-kicker">Connected</span>
        <span className="dev-name">{device.name}</span>
      </div>
      {level != null ? <BatteryRing level={level} /> : <span className="dev-sub">{subtitleOf(model, device.name)}</span>}
    </div>
  );
}

/** iOS battery ring: a coloured arc with the number inside. */
export function BatteryRing({ level, size = 34 }: { level: number; size?: number }) {
  const sw = 3.4;
  const rr = (size - sw) / 2;
  const c = 2 * Math.PI * rr;
  const color = level <= 20 ? RED : GREEN;
  return (
    <div className="bat-ring" style={{ width: size, height: size }}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
        <circle cx={size / 2} cy={size / 2} r={rr} fill="none" stroke={color} strokeOpacity="0.28" strokeWidth={sw} />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={rr}
          fill="none"
          stroke={color}
          strokeWidth={sw}
          strokeLinecap="round"
          strokeDasharray={c}
          initial={{ strokeDashoffset: c }}
          animate={{ strokeDashoffset: c * (1 - Math.max(0.02, level / 100)) }}
          transition={{ duration: 0.9, delay: 0.3, ease: [0.25, 0.1, 0.25, 1] }}
        />
      </svg>
      <span className="bat-ring-num" style={{ color }}>
        {level}
      </span>
    </div>
  );
}

export function PowerActivity({ kind, percent }: { kind: PowerKind; percent: number }) {
  const color = kind === "charging" ? GREEN : kind === "low" || percent <= 20 ? RED : "#ffffff";
  return (
    <div className="power-act" style={{ width: POWER_SIZE.w, height: POWER_SIZE.h }}>
      <span className="power-label">{kind === "charging" ? "Charging" : kind === "unplugged" ? "Charger Disconnected" : "Low Battery"}</span>
      <span className="power-right" style={{ color }}>
        <span className="power-pct">{percent}%</span>
        <BatteryGlyph level={percent} color={color} charging={kind === "charging"} />
      </span>
    </div>
  );
}

/** iOS status-bar style battery: rounded body, nub, fill, optional bolt. */
export function BatteryGlyph({ level, color, charging, width = 27 }: { level: number; color: string; charging?: boolean; width?: number }) {
  const h = width * 0.48;
  const bw = width - 2.6;
  const fillW = Math.max(1.5, (bw - 3.4) * Math.min(1, level / 100));
  return (
    <svg width={width} height={h} viewBox={`0 0 ${width} ${h}`}>
      <rect x="0.6" y="0.6" width={bw - 1.2} height={h - 1.2} rx={h * 0.3} fill="none" stroke={color} strokeOpacity="0.45" strokeWidth="1.2" />
      <motion.rect
        x="2.3"
        y="2.3"
        height={h - 4.6}
        rx={h * 0.17}
        fill={color}
        initial={{ width: 1.5 }}
        animate={{ width: fillW }}
        transition={{ duration: 0.7, delay: 0.2, ease: [0.25, 0.1, 0.25, 1] }}
      />
      <path d={`M${bw + 0.4} ${h * 0.34}a${h * 0.18} ${h * 0.18} 0 0 1 0 ${h * 0.32}z`} fill={color} fillOpacity="0.5" />
      {charging && (
        <path
          d={`M${bw * 0.56} ${h * 0.12}L${bw * 0.36} ${h * 0.56}h${bw * 0.13}l-${bw * 0.03} ${h * 0.34}${"l"}${bw * 0.2} -${h * 0.46}h-${bw * 0.13}z`}
          fill="#fff"
          stroke="#000"
          strokeWidth="0.6"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}
