import { AnimatePresence, animate, motion, useMotionValue, useMotionValueEvent, useTransform, type MotionValue } from "motion/react";
import { getSvgPath } from "figma-squircle";
import { useCallback, useEffect, useRef, useState } from "react";
import { bridge, type MediaAction, type MediaSession } from "../bridge";
import { useSettings } from "../lib/settings";
import { ALL_MODULES, islandColor } from "../settings-types";
import { MediaCompact, MediaExpanded, MediaMinimal } from "./content";
import type { ModuleId } from "../settings-types";
import { isActive as clockActive, startClockTicker, useClock } from "../lib/timer";
import { ClockCompact, ClockMinimal, ClockPanel } from "./modules/Clock";
import { NotesPanel } from "./modules/Notes";
import { TodayPanel } from "./modules/Today";
import { WeatherPanel } from "./modules/Weather";
import { ShelfPanel, useShelf, useShelfDrop } from "./modules/Shelf";
import { ClipboardPanel, useClips } from "./modules/Clipboard";
import { StatsPanel } from "./modules/Stats";
import { ControlsPanel } from "./modules/Controls";
import { Banner, useBanners, BANNER_H, pushBanner, pushBannerNow, dismissBanner, isUrgent, setBannerShowing } from "./modules/Banners";
import { on, send } from "../lib/native";
import { Hud, useHud, quietHud, HUD_SIZE, MUTE_SIZE, Speaker } from "./modules/Hud";
import { DeviceActivity, PowerActivity, useActivity, DEVICE_SIZE, POWER_SIZE } from "./modules/Devices";
import { PrivacyDots } from "./modules/Privacy";
import { DownloadCompact, DownloadMinimal, DownloadsPanel, downloadsPanelHeight, useDownloads } from "./modules/Downloads";
import { INCOMING_SIZE, IncomingCard, NEARBY_H } from "./modules/Nearby";
import { useNearby } from "../lib/nearby";
import { markScrolled, tabStep } from "../lib/wheel";
import { browserName, browserOf, connectedBrowsers, storeFor } from "../lib/extension";
import { AiPanel, AI_BAR_H, type AiView } from "./AiPanel";
import { AiThinking, THINKING_SIZE } from "./AiThinking";
import { useAiSession } from "../lib/aiSession";
import { TabDock, DOCK_GAP, DOCK_H } from "./TabDock";
import { COMPACT_REC, REC_PANEL, RecCompact, RecMinimal, RecPanel } from "./modules/ScreenRec";
import { recActive, useScreenRec } from "../lib/screenrec";
import { SIDE, MediaCompactV, ClockCompactV, DownloadCompactV, HudV, RecCompactV } from "./SidePill";
import type { Dock, DockAlong } from "../settings-types";
import { pinsPageOpen } from "./modules/Controls";
import { clearGlassFrames, LiquidGlass, warmGlass } from "./Glass";

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
// The island's window (CSS px before the size scale; same as WIN_W/WIN_H in main.rs).
// The frame sits in its middle; for each dock the whole layer is shifted so the island
// hugs the matching window edge, and the window hugs that screen edge.
const WIN_W = 560;
const WIN_H = 480;
/** Extra room below the frame for the open island's shadow to fade out. */
const SHADOW_PAD = WIN_H - 440;
const FRAME_X = (WIN_W - FRAME_W) / 2;
const EDGE = 8; // gap to the screen edge it's docked on
const SIDE_M = 14; // inset at the start/end of an edge

// Collapsed live activities on the top/bottom edge: just wide enough for what they show
// (artwork + waveform is short; a download needs room for its name).
const COMPACT_MEDIA = { w: 184, h: 37, r: 18.5 };
const COMPACT_CLOCK = { w: 204, h: 37, r: 18.5 };

/** No-overshoot spring for shape changes while the island is being moved. */
const CALM = { type: "spring" as const, stiffness: 520, damping: 46, mass: 1 };
/** Picked up: a quick pop with a whisper of overshoot. */
const LIFT = { type: "spring" as const, stiffness: 430, damping: 22, mass: 0.8 };
/** Let go: one soft, critically-damped-ish glide into place (position and size together). */
const LAND = { type: "spring" as const, stiffness: 300, damping: 30, mass: 0.9, restDelta: 0.01 };

/** Top-left of the island inside the window for a dock (w/h = current size). */
function islandOrigin(dock: Dock, along: DockAlong, w: number, h: number, below: number, above: number) {
  const horiz = dock === "top" || dock === "bottom";
  const x = horiz
    ? along === "start"
      ? SIDE_M
      : along === "end"
        ? WIN_W - SIDE_M - w
        : (WIN_W - w) / 2
    : dock === "left"
      ? EDGE
      : WIN_W - EDGE - w;
  const total = h + below + above;
  const y = horiz
    ? dock === "top"
      ? TOP
      : WIN_H - TOP - h
    : (along === "start" ? SIDE_M : along === "end" ? WIN_H - SIDE_M - total : (WIN_H - total) / 2) + above;
  return { x, y };
}

type Mode = "idle" | "compact" | "expanded" | "ai" | "hud" | "banner" | "activity" | "incoming" | "rec";
const AI_W = 440;
type Tab = ModuleId | "downloads";
type WarmTab = Exclude<Tab, "ai">;

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
  media: { w: 372, h: 192, r: 46 },
  today: { w: 372, h: 198, r: 44 },
  weather: { w: 372, h: 330, r: 44 },
  clock: { w: 372, h: 190, r: 44 },
  notes: { w: 372, h: 230, r: 44 },
  shelf: { w: 372, h: 194, r: 44 },
  clipboard: { w: 372, h: 250, r: 44 },
  stats: { w: 372, h: 230, r: 44 },
  controls: { w: 372, h: 228, r: 44 },
  downloads: { w: 372, h: 200, r: 44 }, // height follows the number of downloads
};

/** Squircle outline, horizontally centred in the frame. A true capsule when r = h/2. */
function islandPath(w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, h / 2, w / 2));
  const d = getSvgPath({ width: w, height: h, cornerRadius: rr, cornerSmoothing: SMOOTHING, preserveSmoothing: true });
  const dx = (FRAME_W - w) / 2;
  // figma-squircle only uses absolute coords in M/L commands; shift those. It also writes
  // relative arcs as "-${n}", so a value that goes negative mid-spring would read "--n",
  // which Chromium rejects (that frame's outline is dropped): a double minus is a plus.
  return d
    .replace(/--/g, "")
    .replace(/([ML]) (-?[\d.]+) (-?[\d.]+)/g, (_, c, x, y) => `${c} ${(+x + dx).toFixed(3)} ${y}`);
}

/**
 * Lets the wheel scroll whatever scrollable list it's over. Vertical wheels also
 * scroll horizontal strips (the shelf), like a trackpad would. Returns true if
 * the event was used for scrolling (or the pointer is in a list that can scroll
 * that way).
 */
function scrollInside(e: React.WheelEvent): boolean {
  // Over a page's tab zone (Weather's hero) the wheel is for tabs.
  if ((e.nativeEvent as WheelEvent & { islandTabZone?: boolean }).islandTabZone) return false;
  // The smooth scroller already took this wheel for a list.
  if (e.nativeEvent.defaultPrevented) return true;
  const dy = e.deltaY;
  const dx = e.deltaX;
  let el = e.target as HTMLElement | null;
  while (el && el !== e.currentTarget) {
    const cs = getComputedStyle(el);
    const canY = /(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1;
    const canX = /(auto|scroll)/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 1;
    if (canY && Math.abs(dy) >= Math.abs(dx)) {
      const room = dy > 0 ? el.scrollHeight - el.clientHeight - el.scrollTop : el.scrollTop;
      if (room > 1) return true; // the browser scrolls it
    }
    if (canX) {
      const d = Math.abs(dx) > Math.abs(dy) ? dx : dy;
      const room = d > 0 ? el.scrollWidth - el.clientWidth - el.scrollLeft : el.scrollLeft;
      if (room > 1) return true; // smoothScroll glides it
    }
    el = el.parentElement;
  }
  return false;
}

/* ---------------- Component ---------------- */

interface Props {
  session: MediaSession | null;
  sessions: MediaSession[];
  onCommand(id: string, a: MediaAction): void;
  onSelect(id: string): void;
}

export function Island({ session, sessions, onCommand, onSelect }: Props) {
  const { springs, settings, update } = useSettings();
  const { pinned, expandOnHover, sizeScale } = settings;
  // Your order (rearranged by dragging icons in the tab dock).
  const SAVED: Tab[] = settings.modules?.length ? settings.modules.filter((id) => ALL_MODULES.some((m) => m.id === id)) : ["ai", "media"];
  // While something downloads (or just finished), a Downloads page comes first.
  const { active: downloads, items: dlItems } = useDownloads();
  const TABS: Tab[] = dlItems.length ? ["downloads", ...SAVED] : SAVED;
  useEffect(startClockTicker, []);
  const clockState = useClock();
  const timerLive = clockActive(clockState);
  const banners = useBanners();
  const banner = banners[0] ?? null;
  const shelfCount = useShelf().length;
  // Someone nearby wants to send files: the island opens to ask (oldest request first).
  const incomingReq = useNearby().incoming[0] ?? null;
  const clipCount = useClips().length;
  const downloading = downloads.length > 0;
  const hud = useHud();
  const activity = useActivity();
  const fill = islandColor(settings);
  const solid = settings.transparency === 0;

  /* ---- hover / click to expand ---- */
  const [hover, setHover] = useState(false);
  const [clickOpen, setClickOpen] = useState(false);
  // Press and hold the island to lift it, then slide it along the top: it snaps to the
  // top-left corner, the centre or the top-right corner (also in the right-click menu).
  const [lifted, setLifted] = useState(false);
  /** Let go: the island is gliding into its spot (it settles back to its normal size
   *  together with that glide, not after it). */
  const [dropping, setDropping] = useState(false);
  /** Finger down on the island (a click, or the start of a hold). */
  const [pressing, setPressing] = useState(false);
  const pinRef = useRef<() => void>(() => {});
  const dragOnRef = useRef(false);
  /** True from the moment a hold picks the island up until it's been dropped. */
  const pickupRef = useRef(false);
  const aiStickyRef = useRef(false);
  // While moving: the edge under the cursor (the island previews its shape for it).
  const [preview, setPreview] = useState<{ dock: Dock; along: DockAlong } | null>(null);
  useEffect(() => {
    const a = on("move://begin", () => {
      pickupRef.current = true;
      if (!dragOnRef.current) pinRef.current(); // started from the menu / Settings
      setLifted(true);
    });
    const b = on<{ dock: Dock; along: DockAlong }>("move://zone", setPreview);
    const c = on("move://end", () => {
      setPreview(null);
      justDropped.current = performance.now();
      clearTimeout(hoverTimer.current);
      setHover(false);
      swallowClick.current = true;
      setTimeout(() => {
        setLifted(false);
        setDropping(false);
        swallowClick.current = false;
        pickupRef.current = false;
        // Picked up from Search or Ask: give it the keyboard back so you can keep typing.
        if (aiStickyRef.current) bridge.aiFocus(true);
      }, 160);
    });
    return () => {
      a();
      b();
      c();
    };
  }, []);
  const dock: Dock = preview?.dock ?? settings.dock ?? "top";
  const along: DockAlong = preview?.along ?? settings.dockAlong ?? "center";
  const side = dock === "left" || dock === "right";
  const hoverTimer = useRef<number>(0);
  /** Just dropped with the cursor still on it: don't spring open under the cursor.
   *  It opens again normally once the pointer has left it once. */
  // Only for a moment, though: if the cursor was already off it when you let go, the next
  // time you reach it must open it (that first hover used to be swallowed).
  const justDropped = useRef(0);
  const setHoverDelayed = useCallback((v: boolean) => {
    if (justDropped.current) {
      const fresh = performance.now() - justDropped.current < 700;
      justDropped.current = 0;
      if (v && fresh) return;
    }
    clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => {
      setHover(v);
      if (!v) setClickOpen(false);
    }, v ? 45 : 200); // open almost at once; a short grace before closing so passing edges don't flicker
  }, []);
  useEffect(() => bridge.onHover(setHoverDelayed), [setHoverDelayed]);

  const [mediaExtra, setMediaExtra] = useState(0);
  const [mediaW, setMediaW] = useState<number | null>(null); // cover card around a narrow poster
  const [controlsExtra, setControlsExtra] = useState(0);

  /* ---- swipe up (drag the island upwards) to dismiss, like iOS ---- */
  const swipe = useRef<{ y: number; t: number } | null>(null);

  /* ---- AI panel ("Search or Ask") ----
   * Shown as the third tab, or "sticky" (stays open, owns the keyboard) once opened by
   * the hotkey / menu or clicked into. Sticky closes with Esc, a click away, or app switch. */
  const [aiSticky, setAiSticky] = useState(false);
  aiStickyRef.current = aiSticky;
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
    // Click into another app → close, like Spotlight/Siri. Not while the island is being
    // picked up and moved: showing the drop zones takes focus for a moment, and closing
    // then collapsed the island in your hand.
    const onBlur = () => {
      if (pickupRef.current) return;
      closeAi();
    };
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [aiSticky, closeAi]);

  /* Pointing at a notification banner is to click it, not to open the island: while the cursor
   * arrived on a banner, the island keeps showing the banner (and doesn't open on whatever tab was
   * last used, e.g. Search or Ask) until the cursor leaves. */
  // Decided in render (not an effect) so the island never flashes open for a frame first.
  const bannerHover = useRef({ hover: false, on: false });
  if (bannerHover.current.hover !== hover) bannerHover.current = { hover, on: hover && !!banner };
  const onBanner = bannerHover.current.on;
  const expanded = !lifted && !onBanner && (pinned || (expandOnHover ? hover : clickOpen && hover));

  /* ---- warm-up ----
   * WebView2 starts cold: the first time a panel mounts it parses/JITs its code, decodes images,
   * rasterises fonts and compiles the GPU shaders for blur/backdrop filters. Doing all that on the
   * first hover made the first open stutter. Right after launch we mount every panel once in an
   * invisible layer (one per frame or two), run the same blur/scale entrance on it, then drop it,
   * so the real first hover is as smooth as the hundredth. A real hover cancels it immediately. */
  const [warmTab, setWarmTab] = useState<WarmTab | "dock" | null>(null);
  const warmDone = useRef(false);
  const warmDockTop = useMotionValue(0);
  useEffect(() => {
    if (expanded && !warmDone.current) {
      warmDone.current = true;
      setWarmTab(null);
    }
  }, [expanded]);
  useEffect(() => {
    let dead = false;
    const frames = (n: number) =>
      new Promise<void>((res) => {
        const t = window.setTimeout(res, 60 * n); // rAF can be throttled while the window is untouched
        const step = (k: number) => (k <= 0 ? (clearTimeout(t), res()) : requestAnimationFrame(() => step(k - 1)));
        step(n);
      });
    (async () => {
      await Promise.race([document.fonts?.ready, frames(30)]);
      await frames(20); // let launch work settle first
      // JIT the squircle maths the expand animation runs every frame.
      for (let i = 0; i < 160; i++) islandPath(120 + i * 1.6, 37 + i, 18 + i * 0.16);
      // (AI is skipped: its panel grabs keyboard focus when it mounts.)
      const order: (WarmTab | "dock")[] = ["media", ...TABS.filter((t): t is WarmTab => t !== "media" && t !== "ai"), "dock"];
      for (const t of order) {
        if (dead || warmDone.current) return;
        setWarmTab(t);
        await frames(3);
      }
      warmDone.current = true;
      if (!dead) setWarmTab(null);
    })();
    return () => {
      dead = true;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---- tabs (scroll to switch) ---- */
  const [tab, setTab] = useState<Tab>("media");
  // Volume changes made while the island is open (the Controls slider, or keys
  // while you're looking at it) don't pop a HUD afterwards.
  const quietHere = expanded && tab === "controls";
  useEffect(() => {
    quietHud(quietHere ? Infinity : 0);
  }, [quietHere]);
  useEffect(() => {
    if (!expanded) quietHud(450); // and drop anything queued while it was open
  }, [expanded]);
  const [dir, setDir] = useState(1);
  const lastWheel = useRef(0);
  const listWheel = useRef(0);
  /* Picking a tab resizes the island, which can slide the dock out from under the cursor
   * (a shorter tab pulls it up). Without this the island closed the moment you picked a
   * shorter tab. Keep it open until the cursor clearly moves on (or 5 s pass). */
  const tabPickHold = useRef<{ x: number; y: number; timer: number } | null>(null);
  const lastPress = useRef({ x: 0, y: 0 });
  const releaseTabPickHold = useCallback(() => {
    const h = tabPickHold.current;
    if (!h) return;
    window.clearTimeout(h.timer);
    tabPickHold.current = null;
    // Search or Ask keeps its own hold while you type in it: leave that alone.
    if (!aiStickyRef.current) bridge.setHold(false);
  }, []);
  const holdAfterTabPick = () => {
    if (tabPickHold.current) window.clearTimeout(tabPickHold.current.timer);
    bridge.setHold(true);
    tabPickHold.current = { ...lastPress.current, timer: window.setTimeout(releaseTabPickHold, 5000) };
  };
  useEffect(() => {
    const down = (e: PointerEvent) => (lastPress.current = { x: e.screenX, y: e.screenY });
    const move = (e: PointerEvent) => {
      const h = tabPickHold.current;
      if (h && Math.hypot(e.screenX - h.x, e.screenY - h.y) > 48) releaseTabPickHold();
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointermove", move, true);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointermove", move, true);
    };
  }, [releaseTabPickHold]);
  /** One tab left/right per gesture: a wheel spin or a touchpad swipe (momentum included). */
  const flickTab = (e: React.WheelEvent | WheelEvent) => {
    const d = tabStep(e);
    if (!d) return;
    lastWheel.current = performance.now();
    if (aiSticky) {
      // Scrolling away from Search or Ask: let go of the keyboard and switch tabs.
      setAiSticky(false);
      bridge.aiFocus(false);
      bridge.glassStop();
      setHover(true);
    }
    const next = TABS[TABS.indexOf(tab) + d];
    if (next) {
      setDir(d);
      setTab(next);
    }
  };
  const onWheel = (e: React.WheelEvent) => {
    if (!expanded && !aiSticky) return;
    // Shift+wheel always changes tabs, even over a list (Weather, Clipboard…).
    if (e.shiftKey) {
      flickTab(e);
      return;
    }
    // Lists (clipboard, shelf, Wi-Fi…) scroll first; only at their ends — and only
    // with a fresh flick, not the tail of a scroll — does the wheel change tabs.
    if (scrollInside(e)) {
      markScrolled(e);
      listWheel.current = performance.now();
      return;
    }
    if (performance.now() - listWheel.current < 450) {
      listWheel.current = performance.now();
      return;
    }
    flickTab(e);
  };
  // Opening the island: Media if something is playing, otherwise straight to AI.
  const wasExpanded = useRef(false);
  const tabLock = useRef(0);
  const tabRef = useRef(tab);
  tabRef.current = tab;
  useEffect(() => {
    if (expanded && !wasExpanded.current && !aiSticky && Date.now() - tabLock.current > 600) {
      // Open on what the collapsed island was showing: music stays music even while a
      // download runs in the side bubble (the bubble opens Downloads).
      const pick: Tab = primary === "media" && TABS.includes("media")
        ? "media"
        : primary === "clock" && TABS.includes("clock")
          ? "clock"
        : TABS.includes("downloads")
        ? "downloads"
        : session?.playing && TABS.includes("media")
          ? "media"
          : timerLive && TABS.includes("clock")
            ? "clock"
            : TABS.includes("ai")
              ? "ai"
              : TABS[0];
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
  // Files dragged onto the island always open the Shelf (unless the Controls tab's
  // Pinned page is open — then the drop pins them to the launcher instead).
  const dragging = useShelfDrop(() => {
    bridge.log(`drag enter: tab=${tabRef.current} pinsOpen=${pinsPageOpen()} expanded=${expanded}`);
    if (TABS.includes("shelf") && !(tabRef.current === "controls" && pinsPageOpen())) {
      tabLock.current = Date.now();
      setDir(TABS.indexOf("shelf") > TABS.indexOf(tabRef.current) ? 1 : -1);
      setTab("shelf");
    }
    setHover(true);
  });

  // What the collapsed island shows: media first (like iOS), otherwise a running timer.
  // Picking a paused source in the open island is just for a look: once it closes,
  // the island goes back to whatever is actually playing (like iOS).
  const playingElsewhere = !session?.playing ? sessions.find((x) => x.playing) : undefined;
  useEffect(() => {
    if (!expanded && playingElsewhere) onSelect(playingElsewhere.id);
  }, [expanded, playingElsewhere?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // A screen recording (or its countdown) outranks everything else in the collapsed island.
  const rec = useScreenRec();
  const recOn = recActive(rec);
  // While recording, hovering shows Pause / Stop; picking a tab in the dock shows that tab
  // instead until the island closes again.
  const [recBrowse, setRecBrowse] = useState(false);
  useEffect(() => {
    if (!expanded) setRecBrowse(false);
  }, [expanded]);
  // Recording while music plays: the music keeps the island and the recording buds off into
  // the bubble (a breathing red dot). The countdown still takes the whole island.
  const recBubble = recOn && !!session?.playing && rec.phase !== "countdown" && rec.phase !== "starting";
  // Clicking that bubble opens the recording's Pause / Stop card.
  const [recCard, setRecCard] = useState(false);
  useEffect(() => {
    if (!expanded) setRecCard(false);
  }, [expanded]);
  const primary: "rec" | "media" | "clock" | "download" | null = recOn && !recBubble ? "rec" : session?.playing ? "media" : timerLive ? "clock" : downloading ? "download" : null;
  const mode: Mode =
    banner?.id === "island-hidden"
      ? "banner"
    : // A timer or focus alarm shows over everything, even Search or Ask while it answers
      // (the answer keeps coming in underneath and is there again after the alert).
      isUrgent(banner) && !dragging
      ? "banner"
    : aiSticky
      ? "ai"
      : incomingReq && !dragging
        ? "incoming"
      : recOn && expanded && !dragging && !recBrowse && (!recBubble || recCard)
        ? "rec"
      : expanded && tab === "ai"
        ? "ai"
      : expanded || dragging
        ? "expanded"
        : banner
          ? "banner"
          : hud
            ? "hud"
            : activity
              ? "activity"
              : primary
                ? "compact"
                : "idle";

  // Volume keys while the media page is open: the island grows a volume row underneath
  // instead of swapping to the HUD pill (useHud clears it again after a moment).
  const mediaVol = mode === "expanded" && tab === "media" && hud && (hud.kind === "volume" || hud.kind === "mute") ? hud : null;

  // Banners only count down while they're actually on screen.
  useEffect(() => setBannerShowing(mode === "banner"), [mode]);

  // While Gemini thinks, the island shrinks to just the glowing dot spinner, then
  // springs open again when the answer starts arriving.
  const { status: aiStatus, voice: aiVoice } = useAiSession();
  // Turning speech into text looks exactly like thinking: the island shrinks to its circle.
  const aiThinking = mode === "ai" && (aiStatus === "thinking" || aiVoice === "transcribing");

  // A new version is downloaded and waiting: ask (every launch, and again every few hours).
  useEffect(
    () =>
      on<{ version: string }>("update://ready", ({ version }) =>
        pushBannerNow({
          id: `update-${version}`,
          app: "Software Update",
          title: `Islander ${version} is ready`,
          body: "Click to restart and update",
          icon: null,
          glyph: "update",
          tint: "#1c1c1e",
          action: "update",
          ttl: 30000,
        }),
      ),
    [],
  );

  // Hidden from the shortcut or the menu: before it goes, say how to bring it back.
  useEffect(() => {
    const offs = [
      on<string>("island://hiding", (hotkey) =>
        pushBannerNow({
          id: "island-hidden",
          app: "Islander",
          title: "Island hidden",
          body: hotkey ? `Press ${hotkey.replace(/\+/g, " + ")} to bring it back` : "Open Islander from the Start menu to bring it back",
          icon: null,
          glyph: "hidden",
          tint: "#3a3a3c",
          ttl: 2400,
        }),
      ),
      on<boolean>("island://hidden", (hidden) => {
        if (!hidden) dismissBanner("island-hidden");
      }),
    ];
    return () => offs.forEach((f) => f());
  }, []);

  /* ---- second activity → split bubble ---- */
  const otherMedia = sessions.find((s) => s.playing && s.id !== session?.id) ?? null;
  // Second live activity → the split bubble: a timer next to music, or a second player.
  const bubbleKind: "media" | "clock" | "download" | "rec" | null =
    primary === "media" && recBubble
      ? "rec"
      : primary === "media" && timerLive
      ? "clock"
      : primary !== "download" && downloading
        ? "download"
        : otherMedia
          ? "media"
          : null;
  const other = bubbleKind === "media" ? otherMedia : null;
  // While the bubble melts back in, keep showing what it showed (fading), not nothing.
  const lastBubbleKind = useRef(bubbleKind);
  if (bubbleKind) lastBubbleKind.current = bubbleKind;
  const shownKind = bubbleKind ?? lastBubbleKind.current;
  // On a side edge the bubble sits under the slim pill instead of beside it.
  const split = mode === "compact" && !!bubbleKind && !lifted;
  const dockOn = (expanded || aiSticky) && TABS.length > 1;
  const lastOther = useRef(other);
  if (other) lastOther.current = other;

  /* ---- shape springs ---- */
  // The waterdrop notch only exists on the top edge; elsewhere the idle island is a pill.
  const idleStyle = IDLE[settings.idleStyle] ? (settings.idleStyle === "notch" && dock !== "top" ? "pill" : settings.idleStyle) : "notch";
  // Auto-hide: when idle, the island tucks fully into the top edge until the cursor touches it.
  const tucked = !!settings.autoHide && dock === "top" && mode === "idle" && !hover && !lifted;
  // On the left/right edge the collapsed forms stand upright.
  const vertical = side && (mode === "idle" || mode === "compact" || (mode === "hud" && (hud?.kind === "volume" || hud?.kind === "brightness")));
  const target: Size =
    mode === "ai"
      ? aiThinking
        ? THINKING_SIZE
        : { w: AI_W, h: aiH, r: aiView === "search" ? aiH / 2 : 40 }
      : mode === "expanded"
        ? tab === "media"
          ? { ...SIZES.media, w: mediaW ?? SIZES.media.w, h: SIZES.media.h + mediaExtra + (mediaVol ? MEDIA_VOL_H : 0) }
          : tab === "controls"
            ? { ...SIZES.controls, h: SIZES.controls.h + controlsExtra }
          : tab === "shelf"
            ? // Compact while empty; full height once there's something on it (or a drag is over it).
              // Nearby sharing adds the row of devices underneath.
              { ...SIZES.shelf, h: (shelfCount || dragging ? SIZES.shelf.h : 126) + (settings.nearbySharing !== false ? NEARBY_H : 0) }
            : tab === "clipboard"
              ? // Grows with the list: header + 44 px per row, up to four rows (then it scrolls).
                { ...SIZES.clipboard, h: Math.min(SIZES.clipboard.h, Math.max(126, 68 + 44 * (settings.clipboardHistory ? clipCount : 0))) }
              : tab === "downloads"
                ? { ...SIZES.downloads, h: downloadsPanelHeight(dlItems.length) }
                : SIZES[tab as Exclude<Tab, "ai">] ?? SIZES.today
        : mode === "incoming"
          ? INCOMING_SIZE
        : mode === "rec"
          ? REC_PANEL
        : mode === "banner"
          ? SIZES.banner
          : mode === "activity"
            ? activity?.kind === "device"
              ? DEVICE_SIZE
              : POWER_SIZE
          : mode === "hud"
            ? vertical
              ? SIDE.hud
              : hud?.kind === "mute"
                ? MUTE_SIZE
                : HUD_SIZE
            : mode === "idle"
              ? tucked
                ? { w: IDLE[idleStyle].w, h: 0, r: 0 }
                : vertical && idleStyle === "pill"
                  ? SIDE.pill
                  : IDLE[idleStyle]
              : vertical
                ? SIDE.compact
                : primary === "rec"
                  ? COMPACT_REC
                  : primary === "media"
                  ? COMPACT_MEDIA
                  : primary === "clock"
                    ? COMPACT_CLOCK
                    : SIZES.compact;
  const attached = mode === "idle" && idleStyle === "notch" && !tucked && dock === "top";
  const movingRef = useRef(false);
  movingRef.current = lifted;
  const w = useMotionValue(target.w);
  const h = useMotionValue(target.h);
  const r = useMotionValue(target.r);
  const prevArea = useRef(target.w * target.h);

  useEffect(() => {
    const area = target.w * target.h;
    // While it's held/moved, shape changes glide without any bounce (a bouncing shape
    // under your cursor reads as a glitch); otherwise the usual springs.
    const sp = movingRef.current ? CALM : area >= prevArea.current ? springs.expand : springs.collapse;
    prevArea.current = area;
    // animate() on a moving value keeps its velocity → smooth retargeting.
    animate(w, target.w, sp);
    animate(h, target.h, sp);
    animate(r, target.r, sp);
  }, [target.w, target.h, target.r, springs, w, h, r]);

  const clip = useTransform(() => `path('${islandPath(w.get(), h.get(), r.get())}')`);
  const rimPath = useTransform(() => islandPath(w.get(), h.get(), r.get()));
  // A little longer than the island so the shadow falls more below it.

  /* ---- the hairline rim: grey by default, tinted by what the island is doing ---- */
  const rimColor =
    (mode === "compact" || mode === "rec") && primary === "rec"
      ? "rgba(255, 59, 48, 0.95)"
      : (mode === "hud" && hud?.kind === "mute" && hud.on) || (mode === "activity" && activity?.kind === "low")
      ? "rgba(255, 69, 58, 0.62)"
      : mode === "activity" && activity?.kind === "charging"
        ? "rgba(48, 209, 88, 0.6)"
        : mode === "activity" && activity?.kind === "unplugged"
          ? "rgba(255, 255, 255, 0.34)"
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
  const dockTop = useTransform(h, (v) => (dock === "bottom" ? TOP - DOCK_GAP - DOCK_H : TOP + v + DOCK_GAP));
  const dockSpace = dockOn ? DOCK_GAP + DOCK_H : 0;
  // At the bottom end of a side edge, leave room for the bubble under the pill.
  const below = dock === "bottom" ? 0 : dockSpace || (side && split && along === "end" ? GAP + BUBBLE : 0);
  const above = dock === "bottom" ? dockSpace : 0;

  /* ---- where the island sits in its window (follows the shape as it morphs) ---- */
  // While it's being moved the island floats in the middle of its window (the window
  // follows the mouse); `float` blends between docked (0) and floating (1). On landing,
  // `landX/Y` start at where it was on screen and spring to 0, so it glides into place.
  // While held, the island keeps its centre exactly where it was picked up (dragOn = 1,
  // centre = dragX/Y) and only the window follows the mouse: one motion, no tug of war.
  const dragOn = useMotionValue(0);
  const dragX = useMotionValue(0);
  const dragY = useMotionValue(0);
  const landX = useMotionValue(0);
  const landY = useMotionValue(0);
  const shiftX = useTransform(() => {
    if (dragOn.get()) return dragX.get() - (FRAME_X + FRAME_W / 2);
    return islandOrigin(dock, along, w.get(), h.get(), below, above).x - (FRAME_X + (FRAME_W - w.get()) / 2) + landX.get();
  });
  const shiftY = useTransform(() => {
    if (dragOn.get()) return dragY.get() - h.get() / 2 - TOP;
    return islandOrigin(dock, along, w.get(), h.get(), below, above).y - TOP + landY.get();
  });
  const origin = islandOrigin(dock, along, target.w, target.h, below, above);
  const dockRef = useRef({ dock, along, below, above });
  dockRef.current = { dock, along, below, above };
  /** Pin the island's current centre for the move and tell the backend (it keeps that
   *  point under the cursor). Called the moment it's picked up. */
  const pinForMove = () => {
    const o = islandOrigin(dock, along, w.get(), h.get(), below, above);
    const cx = o.x + w.get() / 2;
    const cy = o.y + h.get() / 2;
    dragX.set(cx);
    dragY.set(cy);
    dragOn.set(1);
    dragOnRef.current = true;
    landX.set(0);
    landY.set(0);
    send("island_move_anchor", { x: cx * sizeScale, y: cy * sizeScale });
  };
  pinRef.current = pinForMove;
  useEffect(() => {
    if (!lifted) {
      dragOn.set(0);
      dragOnRef.current = false;
    }
  }, [lifted, dragOn]);
  useEffect(
    () =>
      on<{ x: number; y: number }>("move://landing", ({ x, y }) => {
        // The window has just jumped to its spot: start the island where it was on
        // screen (x, y = its centre in the new window), then spring it home.
        const d = dockRef.current;
        const o = islandOrigin(d.dock, d.along, w.get(), h.get(), d.below, d.above);
        dragOn.set(0);
        landX.set(x - (o.x + w.get() / 2));
        landY.set(y - (o.y + h.get() / 2));
        // Now (same task, before this frame is painted) ask the backend to jump the window,
        // so the new offset and the new window position reach the screen together: no
        // one-frame flash of the island at its final spot before it glides there.
        send("island_land_now");
        setDropping(true);
        animate(landX, 0, LAND);
        animate(landY, 0, LAND);
      }),
    [], // eslint-disable-line react-hooks/exhaustive-deps
  );

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

  // Bubble centre relative to the island's centre line (top/bottom: to the right of the
  // pill; side edges: below it). It grows out of the island as bp goes 0 → 1.
  // In the right-hand corner of the top/bottom edge it buds off to the left instead, toward
  // the screen rather than off its edge.
  const stackV = side;
  const bubbleSign = !side && along === "end" ? -1 : 1;
  const bubbleCx = useTransform(() => (stackV ? 0 : bubbleSign * (w.get() / 2 + GAP + BUBBLE / 2 - (GAP + BUBBLE) * (1 - bp.get()))));
  const bubbleCy = useTransform(() => (stackV ? TOP + h.get() + GAP + BUBBLE / 2 - (GAP + BUBBLE) * (1 - bp.get()) : TOP + BUBBLE / 2));
  const bubbleX = useTransform(bubbleCx, (cx) => cx - BUBBLE / 2);
  const bubbleY = useTransform(bubbleCy, (cy) => cy - BUBBLE / 2);
  const bubbleScale = useTransform(bp, [0, 0.6, 1], [0.55, 0.92, 1]);
  // What's inside arrives only once it has pulled free (and leaves first when it melts back):
  // a fade with a little scale and blur, so it resolves instead of popping. The coloured
  // ring likewise appears only once it's its own shape, never as a circle over the island.
  const bubbleContentOpacity = useTransform(bp, [0.55, 0.95], [0, 1]);
  const bubbleContentScale = useTransform(bp, [0.5, 1], [0.6, 1]);
  const bubbleContentBlur = useTransform(bp, [0.5, 0.95], [6, 0], { clamp: true });
  const bubbleContentFilter = useTransform(bubbleContentBlur, (b) => (b > 0.05 ? `blur(${b.toFixed(2)}px)` : "none"));
  const bubbleRimOpacity = useTransform(bp, [0.72, 1], [0, 1]);
  // While island and bubble are one joined shape, the island's hairline would draw a seam
  // across the join: it steps aside for that moment and comes back once they're apart.
  const rimJoinFade = useTransform(bp, [0, 0.06, 0.82, 1], [1, 0, 0, 1]);

  /* ---- tell the backend where we are (for click-through + hover) ---- */
  useEffect(() => {
    const s = sizeScale;
    const cx = origin.x + target.w / 2;
    const island = tucked
      ? { x: (cx - 110) * s, y: 0, w: 220 * s, h: 3 } // a thin strip at the very top edge
      : attached
      ? { x: (cx - DROP_W / 2) * s, y: 0, w: DROP_W * s, h: DROP_D * s }
      : { x: origin.x * s, y: (origin.y - above) * s, w: target.w * s, h: (target.h + below + above) * s };
    const bubble = !split
      ? null
      : side
        ? { x: (origin.x + (target.w - BUBBLE) / 2) * s, y: (origin.y + target.h + GAP) * s, w: BUBBLE * s, h: BUBBLE * s }
        : along === "end"
          ? { x: (origin.x - GAP - BUBBLE) * s, y: origin.y * s, w: BUBBLE * s, h: BUBBLE * s }
          : { x: (origin.x + target.w + GAP) * s, y: origin.y * s, w: BUBBLE * s, h: BUBBLE * s };
    bridge.setHitRects(island, bubble);
  }, [target.w, target.h, split, side, along, sizeScale, attached, tucked, origin.x, origin.y, below, above]);

  // One-time prompt per browser: media playing in a browser without the extension connected
  // → point to the store page (tab titles, live streams and downloads need it).
  const extAsked = useRef(new Set<string>());
  const extCandidate = sessions.find((x) => x.playing && x.source !== "extension" && browserOf(x.id));
  const extBrowser = extCandidate ? browserOf(extCandidate.id) : null;
  useEffect(() => {
    if (!extBrowser || settings.extTips.includes(extBrowser) || extAsked.current.has(extBrowser)) return;
    const b = extBrowser;
    const icon = extCandidate?.icon ?? null;
    // only after it has been playing a few seconds, so a quick blip never triggers it
    const t = setTimeout(async () => {
      if ((await connectedBrowsers()).includes(b)) return;
      extAsked.current.add(b);
      pushBanner({
        id: "tip-ext-" + b,
        app: "Islander",
        title: `See your ${browserName(b)} tabs in the island`,
        body: "Click to get the free browser extension",
        icon,
        glyph: "update",
        tint: "#1c1c1e",
        url: storeFor(b),
        ttl: 10000,
      });
      update({ extTips: [...settings.extTips, b] });
    }, 4000);
    return () => clearTimeout(t);
  }, [extBrowser, settings.extTips]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (settings.moveTipShown) return;
    const t = setTimeout(() => {
      pushBanner({
        id: "tip-move",
        app: "Tip",
        title: "Put the island anywhere",
        body: "Press and hold it, then drag it to any edge of the screen",
        icon: null,
        glyph: "update",
        tint: "#1c1c1e",
        ttl: 9000,
      });
      update({ moveTipShown: true });
    }, 6000);
    return () => clearTimeout(t);
  }, [settings.moveTipShown]); // eslint-disable-line react-hooks/exhaustive-deps

  // Ready Search or Ask's glass ahead of its first opening (see warmGlass).
  useEffect(() => {
    if (!settings.aiGlass) return;
    const t = window.setTimeout(() => warmGlass(), 2500);
    return () => clearTimeout(t);
  }, [settings.aiGlass]);

  // Paused while the island is being moved: capturing a moving area gives black frames.
  const glassOn = mode === "ai" && settings.aiGlass && !lifted;
  useEffect(() => {
    if (!glassOn) return;
    const s = sizeScale;
    const rect = () => {
      const o = islandOrigin(dock, along, AI_W, Math.max(h.get(), AI_BAR_H), 0, 0);
      return { x: o.x * s, y: o.y * s, w: AI_W * s, h: Math.max(h.get(), AI_BAR_H) * s };
    };
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
  }, [glassOn, sizeScale, h, dock, along]);

  // Press and hold the island to pick it up; the backend then moves it with the mouse
  // and docks it where you let go (see start_move in main.rs).
  const holdTimer = useRef(0);
  const holdAt = useRef<{ x: number; y: number } | null>(null);
  const swallowClick = useRef(false);
  const NO_LIFT = "[data-no-lift], button, input, textarea, select, a, [role=slider], [draggable=true], .dock-wrap, [contenteditable]";
  // Placing the island by click (Move Island…): a click anywhere on the island's window
  // places it (the drop-zone layer handles clicks everywhere else).
  useEffect(() => {
    if (!lifted) return;
    const place = () => send("island_move_place");
    window.addEventListener("pointerdown", place, true);
    return () => window.removeEventListener("pointerdown", place, true);
  }, [lifted]);
  const liftDown = (e: React.PointerEvent<HTMLElement>) => {
    // Works on every page. On the Search or Ask bar it works even while you're typing:
    // holding still picks the island up, while a quick drag still selects text (moving
    // before the hold completes cancels the pick-up).
    if (e.button !== 0 || lifted) return;
    const t = e.target as HTMLElement;
    const onBar = !!t.closest(".ai-bar") && !t.closest("button, a, [data-no-lift]");
    if (!onBar && (aiSticky || t.closest(NO_LIFT))) return;
    holdAt.current = { x: e.screenX, y: e.screenY };
    clearTimeout(holdTimer.current);
    holdTimer.current = window.setTimeout(() => {
      holdAt.current = null;
      swallowClick.current = true;
      pickupRef.current = true;
      // Safety net: a move always ends within 90 s (see run_move), so never stay stuck.
      window.setTimeout(() => (pickupRef.current = false), 95_000);
      pinForMove();
      setPressing(false);
      setLifted(true);
      send("island_move_start", { click: false });
    }, 360);
  };
  const liftMove = (e: React.PointerEvent<HTMLElement>) => {
    // Moving before the hold completes is a normal drag/swipe, not a pick-up.
    const at = holdAt.current;
    if (at && Math.hypot(e.screenX - at.x, e.screenY - at.y) > 8) {
      clearTimeout(holdTimer.current);
      holdAt.current = null;
    }
  };
  const liftUp = () => {
    clearTimeout(holdTimer.current);
    holdAt.current = null;
    setPressing(false);
  };
  // A press that ends anywhere (even off the island) lets it spring back.
  useEffect(() => {
    if (!pressing) return;
    const up = () => setPressing(false);
    window.addEventListener("pointerup", up);
    window.addEventListener("blur", up);
    return () => {
      window.removeEventListener("pointerup", up);
      window.removeEventListener("blur", up);
    };
  }, [pressing]);

  // (The showcase stage hit-tests like the native side, so it opts out of DOM hover too.)
  const domHover = bridge.isNative || (window as unknown as { __stageHover?: boolean }).__stageHover
    ? {}
    : { onPointerEnter: () => setHoverDelayed(true), onPointerLeave: () => setHoverDelayed(false) };

  const contentKey =
    mode === "ai"
      ? aiThinking
        ? "ai-thinking"
        : "ai"
      : mode === "expanded"
        ? `x-${tab}`
        : mode === "incoming"
          ? `in-${incomingReq?.id}`
        : mode === "rec"
          ? "rec-panel"
        : mode === "banner"
          ? `b-${banner?.id}`
          : mode === "activity"
            ? `act-${activity?.id}`
          : mode === "hud"
            ? `hud-${hud?.kind}${hud?.kind === "mute" ? `-${hud.seq}` : ""}`
            : mode === "compact"
              ? primary === "media"
                ? `c-${session?.id}`
                : `c-${primary}`
              : `idle-${idleStyle}`;

  const contentVariants = {
    // New content starts resolving right away (it used to wait ~70 ms), the old one leaves a
    // bit quicker: the island answers the moment you reach it instead of after a beat.
    initial: (d: number) => ({ opacity: 0, scale: 0.93, filter: "blur(8px)", x: mode === "expanded" ? d * 28 : 0 }),
    animate: {
      opacity: 1, scale: 1, filter: "blur(0px)", x: 0,
      transition: { ...springs.content, delay: 0.015, opacity: { duration: 0.2, delay: 0.03, ease: [0.2, 0, 0, 1] as const }, filter: { duration: 0.26, delay: 0.015, ease: [0.2, 0, 0, 1] as const } },
    },
    exit: (d: number) => ({
      opacity: 0, scale: 0.93, filter: "blur(8px)", x: mode === "expanded" ? -d * 28 : 0,
      transition: { duration: 0.15, ease: [0.4, 0, 1, 1] as const },
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
      {/* Everything moves together to the edge the island is docked on. */}
      <motion.div className="stage-shift" style={{ x: shiftX, y: shiftY }}>
      {/* Gooey bridge layer: blurred + alpha-thresholded copy that only shows where shapes meet. */}
      {bubbleVisible && mode !== "expanded" && solid && <GooLayer w={w} h={h} cx={bubbleCx} cy={bubbleCy} scale={bubbleScale} fill={fill} />}

      {attVisible && <Waterdrop att={att} fill={fill} />}


      {/* Backdrop: a soft, blurred shadow behind the open island (like iOS dimming the
          background when the island expands). Follows the shape as it morphs. */}
      <motion.svg
        className="island-backdrop"
        width={WIN_W}
        height={FRAME_H + SHADOW_PAD}
        style={{ top: 0, marginLeft: -WIN_W / 2 }}
        initial={false}
        animate={{ opacity: mode === "expanded" || mode === "ai" || mode === "incoming" || mode === "rec" || (lifted && !dropping) ? 1 : 0 }}
        transition={{ duration: mode === "expanded" || mode === "ai" || mode === "incoming" || mode === "rec" ? 0.35 : 0.25, ease: [0.25, 0.1, 0.25, 1] }}
      >
        {/* The blur is an SVG filter over the whole frame (not a CSS-blurred layer), so
            the renderer can never clip it into a hard-edged box while the island resizes. */}
        <defs>
          {/* The whole window wide, so a wide panel (AI is 440 of the 460 px frame) has room
              for the blur to fade out instead of being cut into a hard-edged box. */}
          <filter id="island-shadow" filterUnits="userSpaceOnUse" x={0} y={0} width={WIN_W} height={FRAME_H + SHADOW_PAD}>
            <feGaussianBlur stdDeviation={13} />
          </filter>
        </defs>
        {/* The filter sits on an unshifted group, and the layer starts at the window's top
            edge: a filter region in userSpaceOnUse is measured in the filtered element's own
            coordinates, so on the shifted path it began at the shape's left/top edge and cut
            the blur off there in a straight line. */}
        <g filter="url(#island-shadow)">
          <motion.path d={rimPath} fill="rgba(0,0,0,0.38)" style={{ x: (WIN_W - FRAME_W) / 2, y: TOP + 10 }} />
        </g>
      </motion.svg>

      <motion.div
        className="island"
        style={{ width: FRAME_W, height: FRAME_H, marginLeft: -FRAME_W / 2, top: TOP, clipPath: clip }}
        initial={false}
        animate={{
          backgroundColor: mode === "ai" && !aiThinking ? "rgba(0,0,0,0)" : fill,
          // Pressed: it gives a little; held long enough: it pops up off the screen
          // (a soft overshoot, like lifting an app icon); let go: it settles as it lands.
          scale: lifted && !dropping ? 1.06 : pressing && mode !== "expanded" && mode !== "ai" ? 0.95 : 1,
        }}
        transition={{
          ...springs.press,
          scale: lifted && !dropping ? LIFT : dropping ? LAND : springs.press,
          backgroundColor: { duration: mode === "ai" ? 0.35 : 0.2 },
        }}
        onWheel={onWheel}
        onPointerDown={(e) => {
          if (e.button === 0) swipe.current = { y: e.clientY, t: performance.now() };
          if (e.button === 0) setPressing(true);
          liftDown(e);
        }}
        onPointerMove={liftMove}
        onPointerCancel={liftUp}
        onClickCapture={(e) => {
          if (swallowClick.current) {
            swallowClick.current = false;
            e.stopPropagation();
            e.preventDefault();
          }
        }}
        onPointerUp={(e) => {
          liftUp();
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
          {mode === "ai" && !aiThinking && (
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
        <motion.svg className="island-rim" width={FRAME_W} height={FRAME_H} style={{ opacity: rimJoinFade }}>
          <motion.path
            d={rimPath}
            fill="none"
            strokeWidth={2.8}
            initial={false}
            animate={{ stroke: rimColor, opacity: rimHidden ? 0 : 1 }}
            transition={{ stroke: { duration: 0.45, ease: [0.4, 0, 0.2, 1] }, opacity: { duration: 0.25 } }}
          />
        </motion.svg>

        <AnimatePresence initial={false} custom={dir}>
          <motion.div
            key={vertical ? `${contentKey}:v` : contentKey}
            className="content"
            custom={dir}
            variants={contentVariants}
            initial="initial"
            animate="animate"
            exit="exit"
          >
            {mode === "compact" && vertical && primary === "media" && session && <MediaCompactV session={session} />}
            {mode === "compact" && vertical && primary === "clock" && <ClockCompactV />}
            {mode === "compact" && vertical && primary === "download" && <DownloadCompactV active={downloads} />}
            {mode === "compact" && !vertical && primary === "media" && session && <MediaCompact session={session} width={COMPACT_MEDIA.w} height={COMPACT_MEDIA.h} />}
            {mode === "compact" && !vertical && primary === "clock" && <ClockCompact width={COMPACT_CLOCK.w} height={COMPACT_CLOCK.h} />}
            {mode === "compact" && !vertical && primary === "download" && <DownloadCompact active={downloads} width={SIZES.compact.w} height={SIZES.compact.h} />}
            {mode === "banner" && banner && <Banner banner={banner} width={SIZES.banner.w} />}
            {mode === "incoming" && incomingReq && <IncomingCard req={incomingReq} />}
            {mode === "rec" && <RecPanel />}
            {mode === "compact" && primary === "rec" && (vertical ? <RecCompactV /> : <RecCompact width={COMPACT_REC.w} height={COMPACT_REC.h} />)}
            {mode === "hud" && hud && (vertical ? <HudV hud={hud} /> : <Hud hud={hud} />)}
            {mode === "activity" && activity?.kind === "device" && <DeviceActivity device={activity.device} />}
            {mode === "activity" && activity && activity.kind !== "device" && <PowerActivity kind={activity.kind} percent={activity.percent} />}
            {mode === "expanded" && tab === "media" && (
              <MediaExpanded
                session={session}
                sessions={sessions}
                width={SIZES.media.w}
                height={SIZES.media.h}
                onCommand={(a) => session && onCommand(session.id, a)}
                onSelect={onSelect}
                onExtraHeight={setMediaExtra}
                onWidth={setMediaW}
              />
            )}
            {mode === "expanded" && tab === "media" && (
              <AnimatePresence>
                {mediaVol && (
                  <motion.div
                    key="media-vol"
                    className="media-vol"
                    style={{ top: SIZES.media.h + mediaExtra + 2, width: SIZES.media.w }}
                    initial={{ opacity: 0, y: -8, filter: "blur(4px)" }}
                    animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                    exit={{ opacity: 0, y: -6, filter: "blur(3px)", transition: { duration: 0.16 } }}
                    transition={{ type: "spring", stiffness: 420, damping: 32 }}
                  >
                    <MediaVolume muted={mediaVol.on} value={mediaVol.value} />
                  </motion.div>
                )}
              </AnimatePresence>
            )}
            {mode === "expanded" && tab === "downloads" && <DownloadsPanel items={dlItems} width={SIZES.downloads.w} height={target.h} />}
            {mode === "expanded" && tab === "today" && <TodayPanel width={SIZES.today.w} height={SIZES.today.h} />}
            {mode === "expanded" && tab === "weather" && <WeatherPanel width={SIZES.weather.w} height={SIZES.weather.h} />}
            {mode === "expanded" && tab === "clock" && <ClockPanel width={SIZES.clock.w} height={SIZES.clock.h} />}
            {mode === "expanded" && tab === "notes" && <NotesPanel width={SIZES.notes.w} height={SIZES.notes.h} />}
            {mode === "expanded" && tab === "shelf" && <ShelfPanel width={SIZES.shelf.w} height={target.h} dragging={dragging} />}
            {mode === "expanded" && tab === "clipboard" && <ClipboardPanel width={SIZES.clipboard.w} height={target.h} />}
            {mode === "expanded" && tab === "stats" && <StatsPanel width={SIZES.stats.w} height={SIZES.stats.h} />}
            {mode === "expanded" && tab === "controls" && <ControlsPanel width={SIZES.controls.w} height={SIZES.controls.h} onExtraHeight={setControlsExtra} />}
            {mode === "ai" && aiThinking && <AiThinking />}
            {mode === "ai" && !aiThinking && <AiPanel width={AI_W} active={aiSticky} onActivate={activateAi} onShape={onAiShape} onClose={closeAi} />}
          </motion.div>
        </AnimatePresence>

      </motion.div>

      {warmTab && !expanded && !aiSticky && (
        <div className="warm-layer" aria-hidden>
          {warmTab === "dock" ? (
            <TabDock tabs={TABS} active={tab} top={warmDockTop} fill={fill} onSelect={() => {}} onReorder={() => {}} />
          ) : (
            <motion.div
              key={warmTab}
              className="warm-panel"
              style={{ width: SIZES[warmTab].w, height: SIZES[warmTab].h, background: fill, borderRadius: SIZES[warmTab].r }}
              initial={{ opacity: 0, scale: 0.92, filter: "blur(10px)" }}
              animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
              transition={{ duration: 0.12 }}
            >
              {warmTab === "media" && (
                <MediaExpanded session={session} sessions={sessions} width={SIZES.media.w} height={SIZES.media.h} onCommand={() => {}} onSelect={() => {}} onExtraHeight={() => {}} />
              )}
              {warmTab === "downloads" && <DownloadsPanel items={dlItems} width={SIZES.downloads.w} height={SIZES.downloads.h} />}
              {warmTab === "today" && <TodayPanel width={SIZES.today.w} height={SIZES.today.h} />}
              {warmTab === "weather" && <WeatherPanel width={SIZES.weather.w} height={SIZES.weather.h} />}
              {warmTab === "clock" && <ClockPanel width={SIZES.clock.w} height={SIZES.clock.h} />}
              {warmTab === "notes" && <NotesPanel width={SIZES.notes.w} height={SIZES.notes.h} />}
              {warmTab === "shelf" && <ShelfPanel width={SIZES.shelf.w} height={SIZES.shelf.h} dragging={false} scan={false} />}
              {warmTab === "clipboard" && <ClipboardPanel width={SIZES.clipboard.w} height={SIZES.clipboard.h} />}
              {warmTab === "stats" && <StatsPanel width={SIZES.stats.w} height={SIZES.stats.h} />}
              {warmTab === "controls" && <ControlsPanel width={SIZES.controls.w} height={SIZES.controls.h} onExtraHeight={() => {}} />}
            </motion.div>
          )}
        </div>
      )}

      {/* Tab dock: one icon per tab under the open island (click, hover, drag to rearrange). */}
      <AnimatePresence>
        {(expanded || aiSticky) && !aiThinking && mode !== "incoming" && mode !== "banner" && TABS.length > 1 && (
          <TabDock
            key="dock"
            tabs={TABS}
            active={tab}
            top={dockTop}
            fill={fill}
            onSelect={(t) => {
              if (recOn) setRecBrowse(true);
              if (aiSticky) {
                setAiSticky(false);
                bridge.aiFocus(false);
                bridge.glassStop();
                setHover(true);
              }
              holdAfterTabPick(); // after aiFocus(false), which also clears the hold
              if (t === tab) return;
              setDir(TABS.indexOf(t) > TABS.indexOf(tab) ? 1 : -1);
              setTab(t);
              tabLock.current = Date.now();
            }}
            onReorder={(order) => update({ modules: order.filter((t): t is ModuleId => t !== "downloads") })}
            onWheel={(e) => flickTab(e)}
          />
        )}
      </AnimatePresence>

      {bubbleVisible && (bubbleSession || shownKind === "clock" || shownKind === "download" || shownKind === "rec") && (
        <motion.div
          className="bubble"
          style={{ x: bubbleX, y: bubbleY, scale: bubbleScale, top: 0, width: BUBBLE, height: BUBBLE, background: fill }}
          whileTap={{ scale: 0.9 }}
          onClick={() => {
            if (other) onSelect(other.id);
            else if (bubbleKind === "clock") window.dispatchEvent(new CustomEvent("island:goto", { detail: "clock" }));
            else if (bubbleKind === "download") window.dispatchEvent(new CustomEvent("island:goto", { detail: "downloads" }));
            else if (bubbleKind === "rec") {
              setRecCard(true);
              setClickOpen(true);
              setHover(true);
            }
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            bridge.showContextMenu();
          }}
        >
          <motion.span
            className="bubble-rim"
            style={{ opacity: bubbleRimOpacity }}
            initial={false}
            animate={{
              boxShadow: `inset 0 0 0 1.4px ${
                shownKind === "clock"
                  ? clockState.kind === "stopwatch"
                    ? "rgba(255, 214, 10, 0.55)"
                    : "rgba(255, 159, 10, 0.55)"
                  : shownKind === "download"
                    ? "rgba(48, 209, 88, 0.55)"
                    : shownKind === "rec"
                    ? "rgba(255, 59, 48, 0.6)"
                    : "rgba(255, 255, 255, 0.17)"
              }`,
            }}
            transition={{ duration: 0.45 }}
          />
          <motion.div style={{ opacity: bubbleContentOpacity, scale: bubbleContentScale, filter: bubbleContentFilter }}>
            {shownKind === "clock" ? (
              <ClockMinimal />
            ) : shownKind === "rec" ? (
              <RecMinimal />
            ) : shownKind === "download" ? (
              <DownloadMinimal active={downloads} />
            ) : (
              bubbleSession && <MediaMinimal session={bubbleSession} />
            )}
          </motion.div>
        </motion.div>
      )}

      {/* Camera/mic dot: in the middle of the idle island, beside it otherwise. */}
      {settings.privacyDots && !side && <PrivacyDots islandW={w} islandH={h} split={split} flip={along === "end"} centered={mode === "idle" && !tucked} attached={attached} />}
      </motion.div>
    </div>
  );
}

/* ---------------- Goo ---------------- */

function GooLayer({ w, h, cx, cy, scale, fill }: { w: MotionValue<number>; h: MotionValue<number>; cx: MotionValue<number>; cy: MotionValue<number>; scale: MotionValue<number>; fill: string }) {
  const W = 700;
  const rectX = useTransform(w, (v) => W / 2 - v / 2);
  const rx = useTransform(h, (v) => v / 2);
  const ccx = useTransform(cx, (v) => W / 2 + v);
  const cr = useTransform(scale, (s) => (BUBBLE / 2) * s);
  return (
    <svg className="goo" width={W} height={240} style={{ marginLeft: -W / 2 }}>
      <defs>
        <filter id="goo" x="-20%" y="-50%" width="140%" height="200%" colorInterpolationFilters="sRGB">
          <feGaussianBlur in="SourceGraphic" stdDeviation="4" />
          <feColorMatrix values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 20 -9" />
        </filter>
      </defs>
      <g filter="url(#goo)">
        <motion.rect x={rectX} y={TOP} width={w} height={h} rx={rx} fill={fill} />
        <motion.circle cx={ccx} cy={cy} r={cr} fill={fill} />
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

/** Height the media page grows by while the volume row shows. */
const MEDIA_VOL_H = 40; // 16 above the row (like the gaps above), 22 row, room to match the top padding below

function MediaVolume({ muted, value }: { muted: boolean; value: number }) {
  const level = muted ? 0 : value;
  return (
    <div className="media-vol-row">
      <span className="media-vol-ico">
        <Speaker level={level} muted={muted} />
      </span>
      <div className="hud-bar">
        <motion.div className="hud-fill" initial={false} animate={{ width: `${Math.round(level * 100)}%` }} transition={{ type: "spring", stiffness: 600, damping: 40 }} />
      </div>
      <span className="media-vol-num">{Math.round(level * 100)}</span>
    </div>
  );
}
