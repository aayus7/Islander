// Banners: Windows notifications, timer alerts and device alerts drop into the island
// like an iOS alert. Swipe sideways to dismiss, click to jump to the source.
import { motion, useMotionValue, useTransform } from "motion/react";
import { RecordGlyph } from "./ScreenRec";
import { useEffect, useState, useSyncExternalStore } from "react";
import { on, send } from "../../lib/native";
import { useSettings } from "../../lib/settings";
import { clock, clockActions } from "../../lib/timer";
import { ClockGlyph } from "./Clock";
import { ArrowDown, FileTile } from "./Downloads";

export const BANNER_H = 84;

export interface BannerData {
  id: string;
  app: string;
  title: string;
  body: string;
  icon: string | null;
  /** The sender's picture (messaging apps): shown round, with the app icon as a badge. */
  avatar?: string | null;
  avatarRound?: boolean;
  /** A photo/preview attached to the notification (thumbnail on the right). */
  attachment?: string | null;
  /** Glyph + tint for built-in banners (no app icon). */
  glyph?: "timer" | "focus" | "battery" | "download" | "update" | "record" | "hidden";
  tint?: string;
  /** Source to activate on click (AppUserModelId) or an island tab to open. */
  aumid?: string;
  goto?: string;
  /** File to show in Explorer on click. */
  reveal?: string;
  /** Web page to open on click (e.g. the extension's store page). */
  url?: string;
  /** Click runs this instead (e.g. "update": install the downloaded update). */
  action?: "update";
  /** A finished download: its file name (shown as the file's tile with a check). */
  file?: string;
  at: number;
  ttl: number;
}

/* ---- queue ---- */
let queue: BannerData[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
export function pushBanner(b: Omit<BannerData, "at" | "ttl"> & { ttl?: number }) {
  if (queue.some((q) => q.id === b.id)) return;
  queue = [...queue, { ttl: 5200, ...b, at: Date.now() }].slice(-6);
  emit();
}
/** Show this one right now, ahead of anything waiting. */
export function pushBannerNow(b: Omit<BannerData, "at" | "ttl"> & { ttl?: number }) {
  queue = [{ ttl: 5200, ...b, at: Date.now() }, ...queue.filter((q) => q.id !== b.id).map((q) => ({ ...q, at: Date.now() }))].slice(0, 6);
  emit();
}
export function dismissBanner(id: string) {
  queue = queue.filter((b) => b.id !== id);
  emit();
}
let paused = false;
setInterval(() => {
  if (paused || !queue.length) return;
  const head = queue[0];
  if (Date.now() - head.at > head.ttl) {
    queue = queue.slice(1).map((b, i) => (i === 0 ? { ...b, at: Date.now() } : b));
    emit();
  }
}, 250);

export interface NotifyPayload {
  id: string;
  app: string;
  title: string;
  body: string;
  icon: string | null;
  avatar: string | null;
  avatarRound: boolean;
  attachment: string | null;
  aumid: string;
}

export function useBanners() {
  const { settings } = useSettings();
  const q = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => queue,
  );

  // Windows notifications
  useEffect(() => {
    if (!settings.notifications) return;
    return on<NotifyPayload>("notify://new", (n) => {
      pushBanner({ id: `n-${n.id}`, app: n.app, title: n.title, body: n.body, icon: n.icon, avatar: n.avatar, avatarRound: n.avatarRound, attachment: n.attachment, aumid: n.aumid });
    });
  }, [settings.notifications]);

  // Device battery alerts
  useEffect(
    () =>
      on<{ name: string; level: number; low: boolean }>("battery://alert", (b) =>
        pushBanner({
          id: `bat-${b.name}-${b.low ? "low" : "on"}`,
          app: b.low ? "Low Battery" : "Connected",
          title: b.name,
          body: `${b.level}% battery${b.low ? " — charge soon" : ""}`,
          icon: null,
          glyph: "battery",
          tint: b.low ? "#ff453a" : b.level <= 20 ? "#ff453a" : "#30d158",
          ttl: 4200,
        }),
      ),
    [],
  );

  // Timer / focus phase finished
  useEffect(() => {
    let last = clock.get().doneAt;
    return clock.subscribe(() => {
      const s = clock.get();
      if (s.doneAt && s.doneAt !== last) {
        pushBanner({
          id: `clock-${s.doneAt}`,
          app: s.kind === "focus" ? "Focus" : "Timer",
          title: s.doneLabel,
          body: s.kind === "focus" ? (s.phase === "break" ? "Nice work. Take a breather." : "Break's over — let's go.") : "Your timer has finished.",
          icon: null,
          glyph: s.kind === "focus" ? "focus" : "timer",
          tint: s.kind === "focus" && s.phase === "break" ? "#30d158" : "#ff9f0a",
          goto: "clock",
          ttl: 8000,
        });
        clockActions.dismissDone();
      }
      last = s.doneAt;
    });
  }, []);

  // Do Not Disturb hides everything except the user's own timer.
  // (and the island telling you how to bring it back before it hides).
  return settings.dnd ? q.filter((b) => b.glyph === "timer" || b.glyph === "focus" || b.glyph === "hidden") : q;
}

/* ---- view ---- */

export function Banner({ banner, width }: { banner: BannerData; width: number }) {
  const x = useMotionValue(0);
  const opacity = useTransform(x, [-140, 0, 140], [0, 1, 0]);
  const [hover, setHover] = useState(false);
  useEffect(() => {
    paused = hover;
    return () => {
      paused = false;
    };
  }, [hover]);
  return (
    <motion.div
      className="banner"
      style={{ width, height: BANNER_H, x, opacity }}
      drag="x"
      dragConstraints={{ left: 0, right: 0 }}
      dragElastic={0.6}
      onDragEnd={(_, info) => {
        if (Math.abs(info.offset.x) > 70 || Math.abs(info.velocity.x) > 500) dismissBanner(banner.id);
      }}
      onHoverStart={() => setHover(true)}
      onHoverEnd={() => setHover(false)}
      onClick={(e) => {
        e.stopPropagation();
        if (banner.aumid) send("notify_open", { aumid: banner.aumid });
        if (banner.reveal) send("reveal_path", { path: banner.reveal });
        if (banner.goto) window.dispatchEvent(new CustomEvent("island:goto", { detail: banner.goto }));
        if (banner.action === "update") send("update_install");
        if (banner.url) send("launch", { target: banner.url });
        dismissBanner(banner.id);
      }}
    >
      {banner.file ? (
        <FileTile name={banner.file} size={44} done />
      ) : banner.avatar ? (
        // iOS communication notification: the person, with the app as a small badge.
        <div className="banner-avatar">
          <img src={banner.avatar} alt="" draggable={false} style={{ borderRadius: banner.avatarRound ? "50%" : 11 }} />
          {banner.icon && (
            <span className="banner-badge">
              <img src={banner.icon} alt="" draggable={false} />
            </span>
          )}
        </div>
      ) : (
      <div className="banner-icon" style={banner.icon ? undefined : { background: banner.tint ?? "#3a3a3c" }}>
        {banner.icon ? (
          <img src={banner.icon} alt="" draggable={false} />
        ) : banner.glyph === "timer" || banner.glyph === "focus" ? (
          <span style={{ color: "#000", display: "flex" }}>
            <ClockGlyph kind={banner.glyph === "focus" ? "focus" : "timer"} size={22} />
          </span>
        ) : banner.glyph === "battery" ? (
          <BatteryGlyph />
        ) : banner.glyph === "update" ? (
          <span className="banner-update-icon">
            <span />
          </span>
        ) : banner.glyph === "record" ? (
          <span style={{ color: "#fff", display: "flex" }}>
            <RecordGlyph size={22} dot="#ff3b30" />
          </span>
        ) : banner.glyph === "hidden" ? (
          <span style={{ color: "#fff", display: "flex" }}>
            <HiddenGlyph />
          </span>
        ) : banner.glyph === "download" ? (
          <span style={{ color: "#fff", display: "flex" }}>
            <ArrowDown size={22} />
          </span>
        ) : (
          <span className="banner-letter">{banner.app.slice(0, 1).toUpperCase()}</span>
        )}
      </div>
      )}
      <div className="banner-text">
        <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
          <span className="banner-app">{banner.app}</span>
          <span className="banner-time">now</span>
        </div>
        <span className="banner-title">{banner.title}</span>
        {banner.body && <span className="banner-body">{banner.body}</span>}
      </div>
      {banner.attachment && <img className="banner-attach" src={banner.attachment} alt="" draggable={false} />}
      {banner.file && banner.reveal && (
        <span className="banner-folder" title="Show in folder">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
            <path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.2h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
          </svg>
        </span>
      )}
    </motion.div>
  );
}

/** An eye with a slash: the island is going away (and how to get it back). */
function HiddenGlyph() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12s-3.5 6.5-9.5 6.5S2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="2.8" />
      <path d="M4 20 20 4" />
    </svg>
  );
}

function BatteryGlyph() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#000" strokeWidth="2" strokeLinecap="round">
      <rect x="3" y="7.5" width="15" height="9" rx="2.4" />
      <path d="M21 10.5v3" />
    </svg>
  );
}
