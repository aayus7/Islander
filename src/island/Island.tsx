import { AnimatePresence, animate, motion, useMotionValue, useMotionValueEvent, useTransform, type MotionValue } from "motion/react";
import { getSvgPath } from "figma-squircle";
import { useCallback, useEffect, useRef, useState } from "react";
import { bridge, type MediaAction, type MediaSession } from "../bridge";
import { useSettings } from "../lib/settings";
import { islandColor } from "../settings-types";
import { MediaCompact, MediaExpanded, MediaMinimal } from "./content";
import type { ModuleId } from "../settings-types";
import { isActive as clockActive, startClockTicker, useClock } from "../lib/timer";
import { ClockCompact, ClockMinimal, ClockPanel } from "./modules/Clock";
import { NotesPanel } from "./modules/Notes";
import { TodayPanel } from "./modules/Today";
import { ShelfPanel, useShelf, useShelfDrop } from "./modules/Shelf";
import { ClipboardPanel, useClips } from "./modules/Clipboard";
import { StatsPanel } from "./modules/Stats";
import { ControlsPanel } from "./modules/Controls";
import { Banner, useBanners, BANNER_H } from "./modules/Banners";
import { Hud, useHud, HUD_SIZE, MUTE_SIZE } from "./modules/Hud";
import { PrivacyDots } from "./modules/Privacy";
import { DownloadCompact, DownloadMinimal, useDownloads } from "./modules/Downloads";
import { AiPanel, AI_BAR_H, type AiView } from "./AiPanel";
import { clearGlassFrames, LiquidGlass } from "./Glass";

/* ---------------- Geometry ---------------- */

export const TOP = 8; // gap from top of the screen
const BUBBLE = 37; // second-activity bubble diameter
const GAP = 10; // gap between island and bubble once separated
const SMOOTHING = 0.6; // iOS "continuous corner" smoothing

// The island is drawn inside a FIXED, integer-positioned frame. Only the clip-path
// outline animates; the content never moves while the shape morphs. (Centring
// content inside an animating width makes text snap between pixels as the spring
// settles — that was the "twitch" at the end of transitions.)
const FRAME_W = 460;
const FRAME_H = 440; // tall enough for the AI panel

type Mode = "idle" | "compact" | "expanded" | "ai" | "hud" | "banner";
const AI_W = 440;
type Tab = ModuleId;

interface Size { w: number; h: number; r: number }

// Idle look: a waterdrop notch attached to the top edge (default), a floating dot, or the pill.
const IDLE: Record<"notch" | "dot" | "pill", Size> = {
  notch: { w: 4, h: 4, r: 2 }, // the pill grows from a tiny seed inside the drop
  dot: { w: 22, h: 22, r: 11 },
  pill: { w: 126, h: 37, r: 18.5 },
};
// Waterdrop notch, traced from a reference: half-width 33 px at the screen edge,
// 15 px deep. Points are (x, y) on the right half; the left half is mirrored.
const DROP_W = 66;
const DROP_D = 16;

const SIZES: Record<"idle" | "compact" | "banner", Size> & Record<Exclude<Tab, "ai">, Size> = {
  idle: IDLE.pill,
  compact: { w: 250, h: 37, r: 18.5 },
  banner: { w: 372, h: BANNER_H, r: 38 },
  media: { w: 372, h: 198, r: 46 },
  today: { w: 372, h: 204, r: 44 },
  clock: { w: 372, h: 196, r: 44 },
  notes: { w: 372, h: 236, r: 44 },
  shelf: { w: 372, h: 200, r: 44 },
  clipboard: { w: 372, h: 256, r: 44 },
  stats: { w: 372, h: 236, r: 44 },
  controls: { w: 372, h: 206, r: 44 },
};

/** Squircle outline, horizontally centred in the frame. A true capsule when r = h/2. */
function islandPath(w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, h / 2, w / 2));
  const d = getSvgPath({ width: w, height: h, cornerRadius: rr, cornerSmoothing: SMOOTHING, preserveSmoothing: true });
  const dx = (FRAME_W - w) / 2;
  // figma-squircle only uses absolute coords in M/L commands; shift those.
  return d.replace(/([ML]) (-?[\d.]+) (-?[\d.]+)/g, (_, c, x, y) => `${c} ${(+x + dx).toFixed(3)} ${y}`);
}

/* ---------------- Component ---------------- */

interface Props {
  session: MediaSession | null;
  sessions: MediaSession[];
  onCommand(id: string, a: MediaAction): void;
  onSelect(id: string): void;
}

export function Island({ session, sessions, onCommand, onSelect }: Props) {
  const { springs, settings } = useSettings();
  const { pinned, expandOnHover, sizeScale } = settings;
  const TABS: Tab[] = settings.modules?.length ? settings.modules : ["ai", "media"];
  useEffect(startClockTicker, []);
  const clockState = useClock();
  const timerLive = clockActive(clockState);
  const banners = useBanners();
  const { active: downloads } = useDownloads();
  const shelfCount = useShelf().length;
  const clipCount = useClips().length;
  const downloading = downloads.length > 0;
  const hud = useHud();
  const fill = islandColor(settings);
  const solid = settings.transparency === 0;

  /* ---- hover / click to expand ---- */
  const [hover, setHover] = useState(false);
  const [clickOpen, setClickOpen] = useState(false);
  const hoverTimer = useRef<number>(0);
  const setHoverDelayed = useCallback((v: boolean) => {
    clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => {
      setHover(v);
      if (!v) setClickOpen(false);
    }, v ? 70 : 240);
  }, []);
  useEffect(() => bridge.onHover(setHoverDelayed), [setHoverDelayed]);

  const [mediaExtra, setMediaExtra] = useState(0);

  /* ---- swipe up (drag the island upwards) to dismiss, like iOS ---- */
  const swipe = useRef<{ y: number; t: number } | null>(null);

  /* ---- AI panel ("Search or Ask") ----
   * Shown as the third tab, or "sticky" (stays open, owns the keyboard) once opened by
   * the hotkey / menu or clicked into. Sticky closes with Esc, a click away, or app switch. */
  const [aiSticky, setAiSticky] = useState(false);
  const [aiH, setAiH] = useState(AI_BAR_H);
  const [aiView, setAiView] = useState<AiView>("search");
  const onAiShape = useCallback((hh: number, v: AiView) => {
    setAiH(hh);
    setAiView(v);
  }, []);
  const activateAi = useCallback(() => {
    setAiSticky(true);
    bridge.aiFocus(true);
  }, []);
  useEffect(() => bridge.onAiOpen(() => {
    setAiSticky(true);
    setTab("ai");
  }), []);
  const closeAi = useCallback(() => {
    setAiSticky(false);
    bridge.aiFocus(false);
    bridge.glassStop();
    clearGlassFrames();
    setHover(false);
  }, []);
  useEffect(() => {
    if (!aiSticky || !bridge.isNative) return;
    // Click into another app → close, like Spotlight/Siri.
    const onBlur = () => closeAi();
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [aiSticky, closeAi]);

  const expanded = pinned || (expandOnHover ? hover : clickOpen && hover);

  /* ---- tabs (scroll to switch) ---- */
  const [tab, setTab] = useState<Tab>("media");
  const [dir, setDir] = useState(1);
  const lastWheel = useRef(0);
  const onWheel = (e: React.WheelEvent) => {
    if (!expanded || aiSticky) return;
    const t = performance.now();
    if (t - lastWheel.current < 380 || Math.abs(e.deltaY) + Math.abs(e.deltaX) < 4) return;
    lastWheel.current = t;
    const d = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) > 0 ? 1 : -1;
    const next = TABS[TABS.indexOf(tab) + d];
    if (next) {
      setDir(d);
      setTab(next);
    }
  };
  // Opening the island: Media if something is playing, otherwise straight to AI.
  const wasExpanded = useRef(false);
  const tabLock = useRef(0);
  const tabRef = useRef(tab);
  tabRef.current = tab;
  useEffect(() => {
    if (expanded && !wasExpanded.current && !aiSticky && Date.now() - tabLock.current > 600) {
      const pick: Tab =
        session?.playing && TABS.includes("media") ? "media" : timerLive && TABS.includes("clock") ? "clock" : TABS.includes("ai") ? "ai" : TABS[0];
      setTab(pick);
    }
    wasExpanded.current = expanded;
  }, [expanded, aiSticky, session?.playing]); // eslint-disable-line react-hooks/exhaustive-deps
  // A disabled tab can't stay selected.
  useEffect(() => {
    if (!TABS.includes(tab)) setTab(TABS[0]);
  }, [TABS.join(), tab]); // eslint-disable-line react-hooks/exhaustive-deps
  // Other parts of the UI can jump to a tab ("Up Next" → To-Do, etc.).
  useEffect(() => {
    const go = (e: Event) => {
      const t = (e as CustomEvent<Tab>).detail;
      if (TABS.includes(t)) {
        setDir(TABS.indexOf(t) > TABS.indexOf(tab) ? 1 : -1);
        setTab(t);
        setClickOpen(true);
        setHover(true);
        tabLock.current = Date.now(); // don't let the "default tab on open" logic override this
      }
    };
    window.addEventListener("island:goto", go);
    return () => window.removeEventListener("island:goto", go);
  });

  // Files dragged onto the island open the shelf.
  const dragging = useShelfDrop(() => {
    if (TABS.includes("shelf") && tabRef.current !== "controls") {
      tabLock.current = Date.now();
      setTab("shelf");
    }
    setHover(true);
  });

  // What the collapsed island shows: media first (like iOS), otherwise a running timer.
  const primary: "media" | "clock" | "download" | null = session?.playing ? "media" : timerLive ? "clock" : downloading ? "download" : null;
  const banner = banners[0] ?? null;
  const mode: Mode =
    aiSticky || (expanded && tab === "ai")
      ? "ai"
      : expanded || dragging
        ? "expanded"
        : banner
          ? "banner"
          : hud
            ? "hud"
            : primary
              ? "compact"
              : "idle";

  /* ---- second activity → split bubble ---- */
  const otherMedia = sessions.find((s) => s.playing && s.id !== session?.id) ?? null;
  // Second live activity → the split bubble: a timer next to music, or a second player.
  const bubbleKind: "media" | "clock" | "download" | null =
    primary === "media" && timerLive
      ? "clock"
      : primary !== "download" && downloading
        ? "download"
        : otherMedia
          ? "media"
          : null;
  const other = bubbleKind === "media" ? otherMedia : null;
  const split = mode === "compact" && !!bubbleKind;
  const lastOther = useRef(other);
  if (other) lastOther.current = other;

  /* ---- shape springs ---- */
  const idleStyle = IDLE[settings.idleStyle] ? settings.idleStyle : "notch";
  // Auto-hide: when idle, the island tucks fully into the top edge until the cursor touches it.
  const tucked = !!settings.autoHide && mode === "idle" && !hover;
  const target: Size =
    mode === "ai"
      ? { w: AI_W, h: aiH, r: aiView === "search" ? aiH / 2 : 40 }
      : mode === "expanded"
        ? tab === "media"
          ? { ...SIZES.media, h: SIZES.media.h + mediaExtra }
          : tab === "shelf"
            ? // Compact while empty; full height once there's something on it (or a drag is over it).
              { ...SIZES.shelf, h: shelfCount || dragging ? SIZES.shelf.h : 132 }
            : tab === "clipboard"
              ? // Grows with the list: header + 44 px per row, up to four rows (then it scrolls).
                { ...SIZES.clipboard, h: Math.min(SIZES.clipboard.h, Math.max(132, 74 + 44 * (settings.clipboardHistory ? clipCount : 0))) }
              : SIZES[tab as Exclude<Tab, "ai">] ?? SIZES.today
        : mode === "banner"
          ? SIZES.banner
          : mode === "hud"
            ? hud?.kind === "mute"
              ? MUTE_SIZE
              : HUD_SIZE
            : mode === "idle"
              ? tucked
                ? { w: IDLE[idleStyle].w, h: 0, r: 0 }
                : IDLE[idleStyle]
              : SIZES.compact;
  const attached = mode === "idle" && idleStyle === "notch" && !tucked;
  const w = useMotionValue(target.w);
  const h = useMotionValue(target.h);
  const r = useMotionValue(target.r);
  const prevArea = useRef(target.w * target.h);

  useEffect(() => {
    const area = target.w * target.h;
    const sp = area >= prevArea.current ? springs.expand : springs.collapse;
    prevArea.current = area;
    // animate() on a moving value keeps its velocity → smooth retargeting.
    animate(w, target.w, sp);
    animate(h, target.h, sp);
    animate(r, target.r, sp);
  }, [target.w, target.h, target.r, springs, w, h, r]);

  const clip = useTransform(() => `path('${islandPath(w.get(), h.get(), r.get())}')`);
  const rimPath = useTransform(() => islandPath(w.get(), h.get(), r.get()));

  /* ---- the hairline rim: grey by default, tinted by what the island is doing ---- */
  const rimColor =
    mode === "hud" && hud?.kind === "mute" && hud.on
      ? "rgba(255, 69, 58, 0.62)"
      : mode === "compact" && primary === "clock"
        ? clockState.kind === "stopwatch"
          ? "rgba(255, 214, 10, 0.55)"
          : clockState.kind === "focus" && clockState.phase === "break"
            ? "rgba(48, 209, 88, 0.55)"
            : "rgba(255, 159, 10, 0.55)"
        : mode === "compact" && primary === "download"
          ? "rgba(48, 209, 88, 0.55)"
          : "rgba(255, 255, 255, 0.17)";
  const rimHidden = mode === "ai" || attached || tucked;

  /* ---- notch attachment (1 = joined to the top edge, 0 = floating) ---- */
  const att = useMotionValue(attached ? 1 : 0);
  useEffect(() => {
    // Detaching uses the bouncier expand spring so it "drips" off the edge.
    animate(att, attached ? 1 : 0, attached ? springs.collapse : { ...springs.press, restDelta: 0.001 });
  }, [attached, springs, att]);
  const [attVisible, setAttVisible] = useState(attached);
  useMotionValueEvent(att, "change", (v) => setAttVisible(v > 0.01));
  useEffect(() => {
    if (attached) setAttVisible(true);
  }, [attached]);
  const dotsY = useTransform(h, (v) => v - 13);

  /* ---- bubble progress (0 = merged into island, 1 = fully separated) ---- */
  const bp = useMotionValue(split ? 1 : 0);
  useEffect(() => {
    animate(bp, split ? 1 : 0, split ? springs.bubble : { ...springs.collapse, restDelta: 0.001 });
  }, [split, springs, bp]);
  const [bubbleVisible, setBubbleVisible] = useState(split);
  useMotionValueEvent(bp, "change", (v) => setBubbleVisible(v > 0.004));
  useEffect(() => {
    if (split) setBubbleVisible(true);
  }, [split]);

  // Bubble centre relative to the island's centre line.
  const bubbleCx = useTransform(() => w.get() / 2 + GAP + BUBBLE / 2 - (GAP + BUBBLE) * (1 - bp.get()));
  const bubbleX = useTransform(bubbleCx, (cx) => cx - BUBBLE / 2);
  const bubbleScale = useTransform(bp, [0, 0.6, 1], [0.55, 0.92, 1]);
  const bubbleContentOpacity = useTransform(bp, [0.45, 0.9], [0, 1]);

  /* ---- tell the backend where we are (for click-through + hover) ---- */
  useEffect(() => {
    const vw = window.innerWidth;
    const s = sizeScale;
    const island = tucked
      ? { x: vw / 2 - 110 * s, y: 0, w: 220 * s, h: 3 } // a thin strip at the very top edge
      : attached
      ? { x: vw / 2 - (DROP_W * s) / 2, y: 0, w: DROP_W * s, h: DROP_D * s }
      : { x: vw / 2 - (target.w * s) / 2, y: TOP * s, w: target.w * s, h: target.h * s };
    const bubble = split ? { x: vw / 2 + (target.w / 2 + GAP) * s, y: TOP * s, w: BUBBLE * s, h: BUBBLE * s } : null;
    bridge.setHitRects(island, bubble);
  }, [target.w, target.h, split, sizeScale, attached, tucked]);

  const glassOn = mode === "ai" && settings.aiGlass;
  useEffect(() => {
    if (!glassOn) return;
    const s = sizeScale;
    const rect = () => ({ x: window.innerWidth / 2 - (AI_W * s) / 2, y: TOP * s, w: AI_W * s, h: Math.max(h.get(), AI_BAR_H) * s });
    bridge.glassStart(rect());
    // Follow the panel as it grows (throttled to the capture rate).
    let last = 0;
    const un = h.on("change", () => {
      const now = performance.now();
      if (now - last > 40) {
        last = now;
        bridge.glassUpdate(rect());
      }
    });
    const settle = setInterval(() => bridge.glassUpdate(rect()), 250);
    return () => {
      un();
      clearInterval(settle);
      bridge.glassStop();
    };
  }, [glassOn, sizeScale, h]);

  const domHover = bridge.isNative
    ? {}
    : { onPointerEnter: () => setHoverDelayed(true), onPointerLeave: () => setHoverDelayed(false) };

  const contentKey =
    mode === "ai"
      ? "ai"
      : mode === "expanded"
        ? `x-${tab}`
        : mode === "banner"
          ? `b-${banner?.id}`
          : mode === "hud"
            ? `hud-${hud?.kind}${hud?.kind === "mute" ? `-${hud.seq}` : ""}`
            : mode === "compact"
              ? primary === "media"
                ? `c-${session?.id}`
                : `c-${primary}`
              : `idle-${idleStyle}`;

  const contentVariants = {
    initial: (d: number) => ({ opacity: 0, scale: 0.92, filter: "blur(10px)", x: mode === "expanded" ? d * 30 : 0 }),
    animate: {
      opacity: 1, scale: 1, filter: "blur(0px)", x: 0,
      transition: { ...springs.content, delay: 0.04, opacity: { duration: 0.24, delay: 0.07 }, filter: { duration: 0.3, delay: 0.04 } },
    },
    exit: (d: number) => ({
      opacity: 0, scale: 0.92, filter: "blur(10px)", x: mode === "expanded" ? -d * 30 : 0,
      transition: { duration: 0.18, ease: [0.4, 0, 1, 1] as const },
    }),
  };

  const bubbleSession = other ?? lastOther.current;

  return (
    <div
      className={`stage ${mode === "ai" ? "ai-open" : ""}`}
      style={{ zoom: sizeScale }}
      onPointerDown={(e) => {
        if (mode === "ai" && e.target === e.currentTarget) closeAi();
      }}
    >
      {/* Gooey bridge layer: blurred + alpha-thresholded copy that only shows where shapes meet. */}
      {bubbleVisible && mode !== "expanded" && solid && <GooLayer w={w} h={h} cx={bubbleCx} scale={bubbleScale} fill={fill} />}

      {attVisible && <Waterdrop att={att} fill={fill} />}

      {settings.privacyDots && <PrivacyDots islandW={w} split={split} />}

      <motion.div
        className="island"
        style={{ width: FRAME_W, height: FRAME_H, marginLeft: -FRAME_W / 2, top: TOP, clipPath: clip }}
        initial={false}
        animate={{ backgroundColor: mode === "ai" ? "rgba(0,0,0,0)" : fill }}
        transition={{ ...springs.press, backgroundColor: { duration: mode === "ai" ? 0.35 : 0.2 } }}
        whileTap={mode !== "expanded" && mode !== "ai" ? { scale: 0.95 } : undefined}
        onWheel={onWheel}
        onPointerDown={(e) => {
          if (e.button === 0) swipe.current = { y: e.clientY, t: performance.now() };
        }}
        onPointerUp={(e) => {
          const st = swipe.current;
          swipe.current = null;
          if (!st || pinned || aiSticky || mode !== "expanded") return;
          if (st.y - e.clientY > 36 && performance.now() - st.t < 600) {
            setClickOpen(false);
            setHover(false); // stays closed until the cursor leaves and comes back
          }
        }}
        onClick={() => {
          if (mode !== "expanded" && mode !== "ai") {
            setClickOpen(true);
            setHover(true);
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          bridge.showContextMenu();
        }}
        {...domHover}
      >
        <AnimatePresence>
          {mode === "ai" && (
            <motion.div
              key="glass"
              className="glass-layer"
              style={{ left: (FRAME_W - AI_W) / 2 }}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, transition: { duration: 0.3 } }}
              exit={{ opacity: 0, transition: { duration: 0.2 } }}
            >
              <LiquidGlass
                width={AI_W}
                height={h}
                radius={r}
                clearFrom={aiView === "search" ? AI_BAR_H : Math.max(72, aiH * 0.3)}
                tintTop={aiView === "search" ? 0.62 : 0.97}
                tintBottom={aiView === "search" ? 0.5 : 0.28}
                maxHeight={FRAME_H}
              />
            </motion.div>
          )}
        </AnimatePresence>

        {/* Rim: a stroke along the same outline as the clip (only its inner half shows). */}
        <svg className="island-rim" width={FRAME_W} height={FRAME_H}>
          <motion.path
            d={rimPath}
            fill="none"
            strokeWidth={2.8}
            initial={false}
            animate={{ stroke: rimColor, opacity: rimHidden ? 0 : 1 }}
            transition={{ stroke: { duration: 0.45, ease: [0.4, 0, 0.2, 1] }, opacity: { duration: 0.25 } }}
          />
        </svg>

        <AnimatePresence initial={false} custom={dir}>
          <motion.div
            key={contentKey}
            className="content"
            custom={dir}
            variants={contentVariants}
            initial="initial"
            animate="animate"
            exit="exit"
          >
            {mode === "compact" && primary === "media" && session && <MediaCompact session={session} width={SIZES.compact.w} height={SIZES.compact.h} />}
            {mode === "compact" && primary === "clock" && <ClockCompact width={SIZES.compact.w} height={SIZES.compact.h} />}
            {mode === "compact" && primary === "download" && <DownloadCompact active={downloads} width={SIZES.compact.w} height={SIZES.compact.h} />}
            {mode === "banner" && banner && <Banner banner={banner} width={SIZES.banner.w} />}
            {mode === "hud" && hud && <Hud hud={hud} />}
            {mode === "expanded" && tab === "media" && (
              <MediaExpanded
                session={session}
                sessions={sessions}
                width={SIZES.media.w}
                height={SIZES.media.h}
                onCommand={(a) => session && onCommand(session.id, a)}
                onSelect={onSelect}
                onExtraHeight={setMediaExtra}
              />
            )}
            {mode === "expanded" && tab === "today" && <TodayPanel width={SIZES.today.w} height={SIZES.today.h} />}
            {mode === "expanded" && tab === "clock" && <ClockPanel width={SIZES.clock.w} height={SIZES.clock.h} />}
            {mode === "expanded" && tab === "notes" && <NotesPanel width={SIZES.notes.w} height={SIZES.notes.h} />}
            {mode === "expanded" && tab === "shelf" && <ShelfPanel width={SIZES.shelf.w} height={target.h} dragging={dragging} />}
            {mode === "expanded" && tab === "clipboard" && <ClipboardPanel width={SIZES.clipboard.w} height={target.h} />}
            {mode === "expanded" && tab === "stats" && <StatsPanel width={SIZES.stats.w} height={SIZES.stats.h} />}
            {mode === "expanded" && tab === "controls" && <ControlsPanel width={SIZES.controls.w} height={SIZES.controls.h} />}
            {mode === "ai" && <AiPanel width={AI_W} active={aiSticky} onActivate={activateAi} onShape={onAiShape} onClose={closeAi} />}
          </motion.div>
        </AnimatePresence>

        <AnimatePresence>
          {expanded && !aiSticky && (
            <motion.div
              className="dots"
              style={{ y: dotsY }}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, transition: { delay: 0.15 } }}
              exit={{ opacity: 0, transition: { duration: 0.1 } }}
            >
              {TABS.map((t) => (
                <motion.span key={t} animate={{ opacity: t === tab ? 0.9 : 0.25, width: t === tab ? 12 : 5 }} transition={springs.content} />
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>

      {bubbleVisible && (bubbleSession || bubbleKind === "clock" || bubbleKind === "download") && (
        <motion.div
          className="bubble"
          style={{ x: bubbleX, scale: bubbleScale, top: TOP, width: BUBBLE, height: BUBBLE, background: fill }}
          initial={false}
          animate={{
            boxShadow: `inset 0 0 0 1.4px ${
              bubbleKind === "clock"
                ? clockState.kind === "stopwatch"
                  ? "rgba(255, 214, 10, 0.55)"
                  : "rgba(255, 159, 10, 0.55)"
                : bubbleKind === "download"
                  ? "rgba(48, 209, 88, 0.55)"
                  : "rgba(255, 255, 255, 0.17)"
            }`,
          }}
          transition={{ duration: 0.45 }}
          whileTap={{ scale: 0.9 }}
          onClick={() => {
            if (other) onSelect(other.id);
            else if (bubbleKind === "clock") window.dispatchEvent(new CustomEvent("island:goto", { detail: "clock" }));
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            bridge.showContextMenu();
          }}
        >
          <motion.div style={{ opacity: bubbleContentOpacity }}>
            {bubbleKind === "clock" ? (
              <ClockMinimal />
            ) : bubbleKind === "download" ? (
              <DownloadMinimal active={downloads} />
            ) : (
              bubbleSession && <MediaMinimal session={bubbleSession} />
            )}
          </motion.div>
        </motion.div>
      )}
    </div>
  );
}

/* ---------------- Goo ---------------- */

function GooLayer({ w, h, cx, scale, fill }: { w: MotionValue<number>; h: MotionValue<number>; cx: MotionValue<number>; scale: MotionValue<number>; fill: string }) {
  const W = 700;
  const rectX = useTransform(w, (v) => W / 2 - v / 2);
  const rx = useTransform(h, (v) => v / 2);
  const ccx = useTransform(cx, (v) => W / 2 + v);
  const cr = useTransform(scale, (s) => (BUBBLE / 2) * s);
  return (
    <svg className="goo" width={W} height={120} style={{ marginLeft: -W / 2 }}>
      <defs>
        <filter id="goo" x="-20%" y="-50%" width="140%" height="200%" colorInterpolationFilters="sRGB">
          <feGaussianBlur in="SourceGraphic" stdDeviation="4" />
          <feColorMatrix values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 20 -9" />
        </filter>
      </defs>
      <g filter="url(#goo)">
        <motion.rect x={rectX} y={TOP} width={w} height={h} rx={rx} fill={fill} />
        <motion.circle cx={ccx} cy={TOP + BUBBLE / 2} r={cr} fill={fill} />
      </g>
    </svg>
  );
}

/* ---------------- Notch ---------------- */

/**
 * The idle waterdrop notch, joined to the top edge of the screen: it leaves the edge
 * tangentially (so there's no visible seam), curves in quickly at the shoulders,
 * tapers, and ends in a small rounded bottom. `att` 1 → full drop, 0 → gone
 * (it shrinks back up into the edge while the pill grows out underneath).
 */
function Waterdrop({ att, fill }: { att: MotionValue<number>; fill: string }) {
  const W = 200;
  const d = useTransform(att, (raw) => {
    const a = Math.max(0, Math.min(1, raw));
    const c = W / 2;
    const Y = (y: number) => (y * a).toFixed(3);
    const R = (x: number, y: number) => `${(c + x * a).toFixed(3)} ${Y(y)}`;
    const L = (x: number, y: number) => `${(c - x * a).toFixed(3)} ${Y(y)}`;
    return [
      `M ${L(33, 0)}`,
      `L ${R(33, 0)}`,
      // right shoulder → taper → rounded bottom
      `C ${R(25, 0)} ${R(20, 1.6)} ${R(18, 4.6)}`,
      `C ${R(16.2, 7.4)} ${R(10.5, 11.2)} ${R(7.6, 13.4)}`,
      `C ${R(5.4, 15.1)} ${R(2.6, 16)} ${R(0, 16)}`,
      // mirror back up the left side
      `C ${L(2.6, 16)} ${L(5.4, 15.1)} ${L(7.6, 13.4)}`,
      `C ${L(10.5, 11.2)} ${L(16.2, 7.4)} ${L(18, 4.6)}`,
      `C ${L(20, 1.6)} ${L(25, 0)} ${L(33, 0)}`,
      "Z",
    ].join(" ");
  });
  return (
    <svg className="notch" width={W} height={40} style={{ marginLeft: -W / 2 }}>
      <motion.path d={d} fill={fill} />
    </svg>
  );
}
