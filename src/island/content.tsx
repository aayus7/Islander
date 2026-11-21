import { AnimatePresence, motion, useMotionValue, useTransform } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { bridge, type MediaAction, type MediaSession, type OutputDevice } from "../bridge";
import { fmtTime, livePosition, useArtColor, useNow } from "../lib/hooks";
import { useSettings } from "../lib/settings";
import { NumericText } from "./modules/ui";
import { Artwork, useArtAspect, useArtSize, gradientStops, readableOn, visibleOnBlack, Marquee, NoteIcon, PauseIcon, PlayIcon, SkipIcon, Waveform } from "./parts";
import { useHiRes } from "../lib/hires";

/* ---------- Compact: art on the left, waveform on the right ---------- */

export function MediaCompact({ session, width, height }: { session: MediaSession; width: number; height: number }) {
  // No artwork? Take the colour from the app's own icon (purple for mpv, green for Spotify…).
  const color = useArtColor(session.artwork ?? session.icon ?? null, session.app);
  return (
    <div className="row" style={{ width, height, padding: "0 9px 0 8px", justifyContent: "space-between" }}>
      <CompactArt session={session} color={color} size={23} radius={6.5} />
      <div style={{ paddingRight: 3 }}>
        <Waveform playing={session.playing} color={color} bars={6} height={14} barWidth={2.6} gap={2} />
      </div>
    </div>
  );
}

/**
 * The collapsed island's cover: a soft halo in the album's colour, breathing while it plays,
 * and the cover turning on every track change (media keys, autoplay) like the open island.
 * Shared by the top/bottom pill and the side pill, so both look and move the same.
 */
export function CompactArt({ session, color, size, radius }: { session: MediaSession; color: string; size: number; radius: number }) {
  const flipDir = useRef(1);
  return (
    <span className="cmp-glow-wrap">
      <motion.span
        className="cmp-glow"
        style={{ background: color }}
        initial={false}
        animate={session.playing ? { opacity: [0.38, 0.62, 0.38], scale: [0.96, 1.08, 0.96] } : { opacity: 0, scale: 0.9 }}
        transition={session.playing ? { duration: 3.2, repeat: Infinity, ease: "easeInOut" } : { duration: 0.5 }}
      />
      <FlipArt src={session.artwork} trackKey={`${session.id}|${session.title}|${session.artist}`} dir={flipDir} size={size} radius={radius} />
    </span>
  );
}

/* ---------- Minimal bubble content (second activity) ---------- */

export function MediaMinimal({ session }: { session: MediaSession }) {
  return <Artwork src={session.artwork} size={23} radius={11.5} />;
}

/* ---------- Expanded media ---------- */

export function MediaExpanded({
  session, sessions, width, height, onCommand, onSelect, onExtraHeight,
}: {
  session: MediaSession | null;
  sessions: MediaSession[];
  width: number;
  height: number;
  onCommand(a: MediaAction): void;
  onSelect(id: string): void;
  /** Extra height the panel needs (e.g. while the output list is open). */
  onExtraHeight?(h: number): void;
}) {
  const [routesOpen, setRoutesOpen] = useState(false);
  const { devices, setDevices } = useOutputs(routesOpen);
  const current = devices.find((d) => d.isDefault);
  // margin + header + rows + card padding (must match .outputs CSS)
  const listH = routesOpen ? 12 + 26 + Math.max(1, devices.length) * OUT_ROW_H + 6 : 0;
  // Tall artwork (movie posters, 2:3) is shown whole at its own shape, and the island grows
  // to fit it, instead of being cropped to a square. Square art keeps the 64×64 cover.
  const ratio = useArtAspect(session?.artwork ?? null);
  const tall = ratio > 1.15;
  const artH = tall ? Math.min(Math.round(64 * ratio), 104) : 64;
  const artW = tall ? Math.round(artH / ratio) : 64;
  const artExtra = artH - 64;

  // ---- Cover card: click the cover and it grows to fill the player; click (or Esc) to go back.
  const [big, setBig] = useState(false);
  // Just came back from the card: the shrinking cover keeps the sharp art until it lands,
  // and the rest of the player fades in behind it.
  const [returning, setReturning] = useState(false);
  const back = () => {
    setBig(false);
    setReturning(true);
    // The island gets shorter under the cursor: stay open a moment instead of snapping shut.
    bridge.setHold(true);
    window.setTimeout(() => bridge.setHold(false), 700);
    window.setTimeout(() => setReturning(false), 650);
  };
  const hi = useHiRes(session);
  const hiSize = useArtSize(hi.url);
  const loSize = useArtSize(session?.artwork ?? null);
  const card = coverCard(hi.url ? hiSize : loSize, !!hi.url || hi.pending, loSize, height);
  useEffect(() => {
    if (!big) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && back();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [big]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!session) setBig(false);
  }, [session]);

  useEffect(() => {
    onExtraHeight?.(big ? card.extra : listH + artExtra);
  }, [big, card.extra, listH, artExtra, onExtraHeight]);
  useEffect(() => () => onExtraHeight?.(0), [onExtraHeight]);

  // Optimistic UI: show the result of a seek / play-pause instantly, then hand back to
  // real data once the player reports something newer than the click (seeks can take
  // a second to land, which used to make the bar jump back to the old spot).
  const [pending, setPending] = useState<{ id: string; at: number; pos?: number; playing?: boolean } | null>(null);
  const live = session && pending && pending.id === session.id && session.sampledAt < pending.at && Date.now() - pending.at < 4000
    ? {
        ...session,
        playing: pending.playing ?? session.playing,
        position: pending.pos ?? livePosition(session, pending.at),
        sampledAt: pending.at,
      }
    : session;
  useEffect(() => {
    if (!pending) return;
    const t = setTimeout(() => setPending(null), 4000);
    return () => clearTimeout(t);
  }, [pending]);

  useNow(!!live?.playing, 250); // re-render the time labels 4×/s
  const flipDir = useRef(1); // 1 = next (flip left), -1 = previous (flip right)
  const color = useArtColor(session?.artwork ?? session?.icon ?? null, session?.app ?? "");

  if (!session) {
    return (
      <div className="col center" style={{ width, height, gap: 8 }}>
        <NoteIcon size={28} />
        <div className="dim" style={{ fontSize: 14, fontWeight: 500 }}>Nothing playing</div>
      </div>
    );
  }

  const cur = live ?? session;
  const dur = session.duration;

  // Video players (mpv, VLC…) and live-less videos: iOS-style "back 10 / forward 10"
  // instead of previous/next track, like the TV and Podcasts apps.
  const skipMode = !session.live && dur > 0 && isVideoPlayer(session);
  const skipBy = (delta: number) => {
    const now = livePosition(cur, Date.now());
    const target = Math.max(0, Math.min(dur - 0.5, now + delta));
    setPending({ id: session.id, at: Date.now(), pos: target, playing: cur.playing });
    onCommand(`seek:${target}`);
  };

  if (big) {
    return (
      <div
        className="cover-card"
        style={{ width, height: height + card.extra }}
        title="Back to the player"
        onClick={(e) => {
          e.stopPropagation();
          back();
        }}
      >
        <motion.div
          layoutId="mx-cover"
          className="cover-big"
          style={{ width: card.w, height: card.h, borderRadius: 20 }}
          transition={COVER_SPRING}
        >
          <ArtGlow src={session.artwork} playing={cur.playing} />
          {session.artwork && <img className="cover-lo" src={session.artwork} alt="" draggable={false} style={{ filter: hi.url ? "none" : "blur(3px)" }} />}
          <AnimatePresence>
            {hi.url && (
              <motion.img
                key={hi.url}
                className="cover-hi"
                src={hi.url}
                alt=""
                draggable={false}
                initial={{ opacity: 0, filter: "blur(6px)" }}
                animate={{ opacity: 1, filter: "blur(0px)" }}
                transition={{ duration: 0.35, ease: "easeOut" }}
              />
            )}
          </AnimatePresence>
          {!session.artwork && !hi.url && <NoteIcon size={64} />}
        </motion.div>
        <motion.div
          className="cover-text"
          style={{ width: Math.max(card.w, 240) }}
          initial={{ opacity: 0, y: 8, filter: "blur(4px)" }}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          transition={{ delay: 0.1, duration: 0.3, ease: [0.2, 0.8, 0.2, 1] }}
        >
          <Marquee text={session.title || "Unknown title"} className="title" />
          <Marquee text={session.artist || session.app} className="subtitle" />
        </motion.div>
      </div>
    );
  }

  return (
    <div className={`media-x${returning ? " returning" : ""}`} style={{ width, minHeight: height }}>
      <div className="row" style={{ gap: 14, height: artH }}>
        {/* Like iOS Music: the cover eases back a touch when paused, springs forward on play. */}
        <motion.div layoutId="mx-cover" transition={COVER_SPRING} style={{ position: "relative", width: 64, height: artH, flexShrink: 0, borderRadius: tall ? 10 : 14 }}>
          {returning && (hi.url || session.artwork) && (
            <motion.img
              className="cover-hi cover-landing"
              src={hi.url ?? session.artwork!}
              alt=""
              draggable={false}
              initial={{ opacity: 1 }}
              animate={{ opacity: 0 }}
              transition={{ duration: 0.22, delay: 0.3 }}
            />
          )}
          <motion.div
            className="open-src"
            title="Show the cover"
            style={{ position: "relative", width: 64, height: artH, isolation: "isolate", display: "flex", justifyContent: "center" }}
            initial={false}
            animate={{ scale: cur.playing ? 1 : 0.93 }}
            whileTap={{ scale: cur.playing ? 0.94 : 0.88 }}
            transition={{ type: "spring", stiffness: 260, damping: 17, mass: 0.9 }}
            onClick={(e) => {
              e.stopPropagation();
              setBig(true);
            }}
          >
            <ArtGlow src={session.artwork} playing={cur.playing} />
            <FlipArt src={session.artwork} trackKey={`${session.id}|${session.title}|${session.artist}`} dir={flipDir} size={artW} height={artH} radius={tall ? 10 : 14} />
          </motion.div>
        </motion.div>
        <div
          className="col open-src"
          title={`Open ${session.app}`}
          style={{ flex: 1, minWidth: 0, gap: 1, overflow: "hidden" }}
          onClick={(e) => {
            e.stopPropagation();
            onCommand("open");
          }}
        >
          <Marquee text={session.title || "Unknown title"} className="title" />
          <Marquee text={session.artist || session.app} className="subtitle" />
        </div>
        <div style={{ width: 36, display: "flex", justifyContent: "flex-end", alignSelf: "center" }}>
          <Waveform playing={cur.playing} color={color} bars={6} height={20} barWidth={3} gap={2.2} />
        </div>
      </div>

      {session.live ? (
        <LiveBar />
      ) : dur > 0 && (
        <Scrubber
          s={cur}
          dur={dur}
          canSeek={session.canSeek}
          onSeek={(target) => {
            setPending({ id: session.id, at: Date.now(), pos: target, playing: cur.playing });
            onCommand(`seek:${target}`);
          }}
        />
      )}

      <AnimatePresence initial={false}>
        {routesOpen && (
          <motion.div
            key="routes"
            initial={{ height: 0 }}
            animate={{ height: listH }}
            exit={{ height: 0, opacity: 0, transition: { height: OUT_SPRING, opacity: { duration: 0.16 } } }}
            transition={OUT_SPRING}
            style={{ overflow: "hidden" }}
          >
            <OutputList
              devices={devices}
              accent={color}
              onPick={(d) => {
                setDevices((ds) => ds.map((x) => ({ ...x, isDefault: x.id === d.id }))); // instant feedback
                bridge.setOutput(d.id).catch(() => {});
                setTimeout(() => setRoutesOpen(false), 520);
              }}
            />
          </motion.div>
        )}
      </AnimatePresence>

      <div className="controls" style={{ marginTop: dur > 0 || session.live ? 10 : 20 }}>
        {/* (video players get ±10 s buttons instead of previous/next) */}
        <SourceIcons sessions={sessions} activeId={session.id} onSelect={onSelect} />
        <div className="row" style={{ gap: 16 }}>
          {skipMode ? (
            <CtrlButton disabled={!session.canSeek} onClick={() => skipBy(-10)}>
              <SymbolSwap k={`b10-${session.id}`}>
                <Skip10Icon dir={-1} size={30} />
              </SymbolSwap>
            </CtrlButton>
          ) : (
            <CtrlButton disabled={!session.canPrev} onClick={() => { flipDir.current = -1; onCommand("prev"); }}>
              <SymbolSwap k={`prev-${session.id}`}>
                <SkipIcon dir={-1} size={30} />
              </SymbolSwap>
            </CtrlButton>
          )}
          <CtrlButton
            big
            onClick={() => {
              setPending({ id: session.id, at: Date.now(), pos: livePosition(cur, Date.now()), playing: !cur.playing });
              onCommand("toggle");
            }}
          >
            <SymbolSwap k={`${cur.playing ? "pause" : "play"}-${session.id}`}>{cur.playing ? <PauseIcon size={32} /> : <PlayIcon size={32} />}</SymbolSwap>
          </CtrlButton>
          {skipMode ? (
            <CtrlButton disabled={!session.canSeek} onClick={() => skipBy(10)}>
              <SymbolSwap k={`f10-${session.id}`}>
                <Skip10Icon dir={1} size={30} />
              </SymbolSwap>
            </CtrlButton>
          ) : (
            <CtrlButton disabled={!session.canNext} onClick={() => { flipDir.current = 1; onCommand("next"); }}>
              <SymbolSwap k={`next-${session.id}`}>
                <SkipIcon dir={1} size={30} />
              </SymbolSwap>
            </CtrlButton>
          )}
        </div>
        <div style={{ width: 86, display: "flex", justifyContent: "flex-end" }}>
          <OutputButton kind={deviceKind(current?.name ?? "")} accent={color} active={routesOpen} onClick={() => setRoutesOpen((o) => !o)} />
        </div>
      </div>
    </div>
  );
}

/* ---------- iOS-style scrubber: press and drag (either mouse button) ---------- */

function Scrubber({ s, dur, canSeek, onSeek }: { s: MediaSession; dur: number; canSeek: boolean; onSeek(t: number): void }) {
  const { springs } = useSettings();
  const fill = useMotionValue(0); // 0..1, written every frame — no React re-renders
  const width = useTransform(fill, (f) => `${Math.max(0, Math.min(1, f)) * 100}%`);
  const [drag, setDrag] = useState<number | null>(null); // fraction while dragging
  const trackRef = useRef<HTMLDivElement>(null);
  const live = useRef(s);
  live.current = s;
  const dragging = drag !== null;

  // Smooth progress: follow the real clock every animation frame.
  useEffect(() => {
    if (dragging) return;
    let raf = 0;
    const tick = () => {
      fill.set(livePosition(live.current, Date.now()) / dur);
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [dur, dragging, fill]);

  const fracAt = (clientX: number) => {
    const r = trackRef.current!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width));
  };

  const shown = dragging ? drag * dur : livePosition(s, Date.now());

  return (
    <div className="row" style={{ gap: 10, marginTop: 16 }}>
      <motion.span className="time" animate={{ color: dragging ? "#fff" : "rgba(235,235,245,0.6)" }}>
        <NumericText value={fmtTime(shown)} />
      </motion.span>
      <div
        className={`scrub ${canSeek ? "seekable" : ""}`}
        data-no-lift="" onPointerDown={(e) => {
          if (!canSeek || (e.button !== 0 && e.button !== 2)) return;
          e.stopPropagation();
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          bridge.setHold(true); // keep the island open & clickable even if the cursor leaves it
          const f = fracAt(e.clientX);
          setDrag(f);
          fill.set(f);
        }}
        onPointerMove={(e) => {
          if (!dragging) return;
          const f = fracAt(e.clientX);
          setDrag(f);
          fill.set(f);
        }}
        onPointerUp={(e) => {
          if (!dragging) return;
          const f = fracAt(e.clientX);
          setDrag(null);
          bridge.setHold(false);
          fill.set(f);
          onSeek(Math.round(f * dur * 10) / 10);
        }}
        onPointerCancel={() => {
          setDrag(null);
          bridge.setHold(false);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation(); // right-drag scrubs instead of opening the island menu
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <motion.div
          ref={trackRef}
          className="track"
          animate={{ height: dragging ? 12 : 6, borderRadius: dragging ? 6 : 3 }}
          transition={springs.press}
        >
          <motion.div className="fill" style={{ width }} />
        </motion.div>
      </div>
      <motion.span className="time" style={{ display: "flex", justifyContent: "flex-end" }} animate={{ color: dragging ? "#fff" : "rgba(235,235,245,0.6)" }}>
        <NumericText value={`-${fmtTime(dur - shown)}`} dir={dragging ? undefined : -1} />
      </motion.span>
    </div>
  );
}

/** Live streams: iOS's full-width track with "LIVE" sitting in a soft gap in the middle. */
function LiveBar() {
  return (
    <motion.div
      className="live-bar"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.35 }}
    >
      <div className="live-track live-left" />
      <span className="live-label">LIVE</span>
      <div className="live-track live-right" />
    </motion.div>
  );
}

/* ---------- source logos (bottom-left), like iOS's "playing from" ---------- */

const BADGE_COLORS = ["#ff9f0a", "#30d158", "#0a84ff", "#bf5af2", "#ff375f", "#64d2ff", "#ffd60a"];

function SourceIcons({ sessions, activeId, onSelect }: { sessions: MediaSession[]; activeId: string; onSelect(id: string): void }) {
  const [fanned, setFanned] = useState(false);
  const MAX = 4;
  // Active source first (in front), others behind it, newest-playing next.
  const active = sessions.find((s) => s.id === activeId);
  const rest = sessions.filter((s) => s.id !== activeId).sort((a, b) => Number(b.playing) - Number(a.playing));
  const shown = (active ? [active, ...rest] : rest).slice(0, MAX);
  const extra = sessions.length - shown.length;
  const SIZE = 26;
  const STEP_STACKED = 13; // overlap when resting
  const STEP_FANNED = 29; // spread out on hover so each is easy to click (fits the 86px slot)
  const step = shown.length > 2 && !fanned ? STEP_STACKED : STEP_FANNED;
  const width = SIZE + step * (shown.length - 1) + (extra > 0 ? 22 : 0);
  const spring = { type: "spring" as const, stiffness: 520, damping: 34, mass: 0.7 };

  return (
    // Fixed-width slot: fanning out never pushes the playback controls around.
    <div className="sources-slot">
    <motion.div
      className="sources"
      onHoverStart={() => setFanned(true)}
      onHoverEnd={() => setFanned(false)}
      animate={{ width }}
      transition={spring}
    >
      {shown.map((s, i) => {
        const on = s.id === activeId;
        return (
          <motion.button
            key={s.id}
            className={`src ${on ? "on" : ""}`}
            style={{ position: "absolute", left: 0, zIndex: MAX - i }}
            title={`${s.app}${s.title ? ` — ${s.title}` : ""}`}
            whileTap={{ scale: 0.85 }}
            initial={false}
            animate={{ x: i * step, opacity: on ? 1 : fanned ? 0.85 : 0.6, scale: on ? 1 : 0.9 }}
            transition={spring}
            onClick={(e) => {
              e.stopPropagation();
              if (!on) onSelect(s.id);
            }}
          >
            {/* Selected source glows in its own colours: a soft, blurred copy of its icon behind it. */}
            <AnimatePresence>
              {on && (
                <motion.span
                  key="glow"
                  className="src-glow"
                  style={s.icon ? { backgroundImage: `url("${s.icon}")` } : { background: BADGE_COLORS[hash(s.app) % BADGE_COLORS.length] }}
                  initial={{ opacity: 0, scale: 0.8 }}
                  animate={{ opacity: [0.85, 0.5, 0.75], scale: 1.25 }}
                  exit={{ opacity: 0, scale: 0.8, transition: { duration: 0.25 } }}
                  transition={{
                    scale: { type: "spring", stiffness: 300, damping: 22 },
                    opacity: { duration: 2.4, repeat: Infinity, repeatType: "mirror", ease: "easeInOut" },
                  }}
                />
              )}
            </AnimatePresence>
            {/* A thin dark ring separates overlapping icons. */}
            <span className="src-face">
              {s.icon ? (
                <img src={s.icon} alt="" draggable={false} />
              ) : (
                <span className="letter" style={{ background: BADGE_COLORS[hash(s.app) % BADGE_COLORS.length] }}>
                  {(s.app || "?").trim()[0]?.toUpperCase()}
                </span>
              )}
            </span>
            <AnimatePresence>{s.playing && (i === 0 || step === STEP_FANNED) && <LiveDot key="live" />}</AnimatePresence>
          </motion.button>
        );
      })}
      {extra > 0 && (
        <motion.span className="more" style={{ position: "absolute" }} animate={{ x: SIZE + step * (shown.length - 1) + 4 }} transition={spring}>
          +{extra}
        </motion.span>
      )}
    </motion.div>
    </div>
  );
}

/* ---------- output device (speakers / headphones), bottom-right ---------- */

function deviceKind(name: string): "headphones" | "display" | "speaker" {
  const n = name.toLowerCase();
  if (/head(phone|set)|earbud|buds|airpods|wh-|wf-|bose|jabra|arctis|hyperx|corsair|hs\d|beats/.test(n)) return "headphones";
  if (/hdmi|displayport|nvidia|amd high definition|monitor|lg |samsung|dell|tv\b/.test(n)) return "display";
  return "speaker";
}

function DeviceIcon({ kind, size = 18 }: { kind: ReturnType<typeof deviceKind>; size?: number }) {
  const sw = 1.8;
  if (kind === "headphones")
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round">
        <path d="M4 15v-3a8 8 0 0 1 16 0v3" />
        <rect x="3" y="14" width="4.5" height="7" rx="2" fill="currentColor" />
        <rect x="16.5" y="14" width="4.5" height="7" rx="2" fill="currentColor" />
      </svg>
    );
  if (kind === "display")
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="4" width="18" height="12.5" rx="2" />
        <path d="M9 20.5h6M12 16.5v4" />
      </svg>
    );
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z" fill="currentColor" />
      <path d="M15.5 9a4 4 0 0 1 0 6M18.2 6.5a7.5 7.5 0 0 1 0 11" />
    </svg>
  );
}

function useOutputs(open: boolean) {
  const [devices, setDevices] = useState<OutputDevice[]>([]);
  const refresh = () => bridge.listOutputs().then(setDevices).catch(() => {});
  useEffect(() => {
    refresh();
  }, []);
  useEffect(() => {
    if (open) refresh();
  }, [open]);
  return { devices, refresh, setDevices };
}

/** Apple spring (response 0.42, dampingFraction 0.86) for the route picker. */
const OUT_SPRING = { type: "spring", stiffness: 224, damping: 25.7, mass: 1 } as const;
const OUT_ROW_H = 52;

/** The now-playing gradient, plus whichever of black/white reads best on it. */
function accentStyle(accent: string) {
  const [from, to] = gradientStops(accent, 2);
  const p = (c: string) => (c.match(/\d+/g) ?? ["0", "0", "0"]).map(Number);
  const [a, b] = [p(from), p(to)];
  // Judge legibility where the glyph sits: the middle of the gradient, mostly `from`.
  const mid = `rgb(${a.map((v, i) => Math.round(v * 0.65 + b[i] * 0.35)).join(",")})`;
  return { from, grad: `linear-gradient(145deg, ${to} -20%, ${from} 70%)`, glyph: readableOn(mid), mark: visibleOnBlack(from) };
}

function OutputButton({ kind, accent, active, onClick }: { kind: ReturnType<typeof deviceKind>; accent: string; active: boolean; onClick(): void }) {
  const { springs } = useSettings();
  const { from, grad, glyph } = accentStyle(accent);
  return (
    <motion.button
      className="out-btn"
      title="Audio output"
      whileTap={{ scale: 0.86 }}
      transition={springs.press}
      initial={false}
      animate={{ color: active ? glyph : "rgba(235,235,245,0.78)" }}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      {/* While the picker is open the button wears the song's gradient. */}
      <motion.span
        className="out-btn-fill"
        style={{ background: grad, boxShadow: `0 0 16px -3px ${from}` }}
        initial={false}
        animate={{ opacity: active ? 1 : 0, scale: active ? 1 : 0.5 }}
        transition={{ type: "spring", stiffness: 420, damping: 28 }}
      />
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={kind}
          style={{ display: "flex", position: "relative" }}
          initial={{ opacity: 0, scale: 0.6, filter: "blur(4px)" }}
          animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
          exit={{ opacity: 0, scale: 0.6, filter: "blur(4px)" }}
          transition={{ duration: 0.22 }}
        >
          <DeviceIcon kind={kind} size={23} />
        </motion.span>
      </AnimatePresence>
    </motion.button>
  );
}

/**
 * Windows names devices like "Speakers (Realtek(R) Audio)". iOS shows a short name
 * with the detail underneath, so split it that way and drop the ®/™ clutter.
 */
function deviceLabel(name: string, kind: ReturnType<typeof deviceKind>) {
  const clean = (t: string) => t.replace(/\((R|TM|C)\)|[®™]/gi, "").replace(/\s{2,}/g, " ").trim();
  const m = name.match(/^(.*?)\s*\((.*)\)\s*$/);
  let title = clean(m ? m[1] : name);
  let sub = m ? clean(m[2]) : "";
  sub = sub.replace(/\bHigh Definition Audio\b/i, "").replace(/\bAudio\b/i, "").replace(/\s{2,}/g, " ").trim();
  // "Headphones (Arctis Nova 7)": the product name is the better title.
  if (/^(head(phones|set)|earphones)$/i.test(title) && sub) [title, sub] = [sub, title];
  if (kind === "display") sub = sub ? `Display · ${sub}` : "Display";
  else if (kind === "headphones") sub = sub || "Headphones";
  else sub = sub || "Speaker";
  if (!title) title = sub;
  return { title, sub };
}

/**
 * iOS AirPlay-style route list: big round device glyphs, a bold short name with the
 * detail in grey underneath, and a single blue checkmark on the active device — no
 * boxes, no dividers. Opens from the output button's corner with Apple's spring.
 */
export function OutputList({ devices, accent, onPick }: { devices: OutputDevice[]; accent: string; onPick(d: OutputDevice): void }) {
  // The active device wears the now-playing colour, as a soft gradient (same family
  // as the waveform), instead of a stock system blue.
  const { from, grad, glyph: glyphOn, mark } = accentStyle(accent);
  return (
    <motion.div
      className="outputs"
      style={{ transformOrigin: "100% 100%" }}
      initial={{ opacity: 0, scale: 0.92, filter: "blur(8px)" }}
      animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
      transition={{ ...OUT_SPRING, opacity: { duration: 0.2 }, filter: { duration: 0.25 } }}
    >
      <div className="out-head">Audio Output</div>
      {devices.length === 0 && <div className="out-empty">No output devices found</div>}
      {devices.map((d, i) => {
        const kind = deviceKind(d.name);
        const { title, sub } = deviceLabel(d.name, kind);
        return (
          <motion.button
            key={d.id}
            className={`out-row ${d.isDefault ? "on" : ""}`}
            title={d.name}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0, transition: { delay: 0.05 + 0.04 * i, duration: 0.3, ease: [0.2, 0.8, 0.2, 1] } }}
            whileTap={{ scale: 0.97 }}
            onClick={(e) => {
              e.stopPropagation();
              onPick(d);
            }}
          >
            <span className="out-ic">
              <motion.span
                className="out-ic-fill"
                style={{ background: grad, boxShadow: `0 0 14px -2px ${from}` }}
                initial={false}
                animate={{ opacity: d.isDefault ? 1 : 0, scale: d.isDefault ? 1 : 0.6 }}
                transition={{ type: "spring", stiffness: 420, damping: 28 }}
              />
              <motion.span
                style={{ position: "relative", display: "flex" }}
                initial={false}
                animate={{ color: d.isDefault ? glyphOn : "#fff" }}
                transition={{ duration: 0.25 }}
              >
                <DeviceIcon kind={kind} size={19} />
              </motion.span>
            </span>
            <span className="out-text">
              <span className="out-name">{title}</span>
              <span className="out-sub">{sub}</span>
            </span>
            <Check on={d.isDefault} color={mark} />
          </motion.button>
        );
      })}
    </motion.div>
  );
}

/** iOS selection mark: a blue checkmark that pops and draws itself in. */
function Check({ on, color }: { on: boolean; color: string }) {
  return (
    <motion.svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      className="out-check"
      initial={false}
      animate={{ scale: on ? 1 : 0.5, opacity: on ? 1 : 0 }}
      transition={{ type: "spring", stiffness: 520, damping: 28 }}
    >
      <motion.path
        d="M4.2 10.6l3.6 3.6 8-8.6"
        fill="none"
        stroke={color}
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={false}
        animate={{ pathLength: on ? 1 : 0 }}
        transition={{ duration: 0.3, delay: on ? 0.06 : 0, ease: "easeOut" }}
      />
    </motion.svg>
  );
}

/**
 * Track change, like iOS: the old cover turns away around its vertical axis while
 * blurring until it's edge-on, then the new cover turns in blurred and sharpens.
 * "Previous" flips the other way.
 */
function FlipArt({ src, trackKey, dir, size = 64, height, radius = 14 }: { src: string | null; trackKey: string; dir: React.MutableRefObject<number>; size?: number; height?: number; radius?: number }) {
  const h = height ?? size;
  const [d, setD] = useState(1);
  const last = useRef(trackKey);
  if (last.current !== trackKey) {
    last.current = trackKey;
    if (d !== dir.current) setD(dir.current);
    dir.current = 1; // changes not started from our buttons count as "next"
  }
  // Blur and perspective scale with the cover, so the small pill turns the same way.
  const b = size / 64;
  const variants = {
    enter: (k: number) => ({ rotateY: -90 * k, filter: `blur(${9 * b}px)`, opacity: 1 }),
    center: {
      rotateY: 0,
      filter: "blur(0px)",
      transition: {
        rotateY: { duration: 0.2, ease: [0.15, 0.6, 0.35, 1] as const },
        filter: { duration: 0.45, delay: 0.08, ease: "easeOut" as const },
      },
    },
    exit: (k: number) => ({
      rotateY: 90 * k,
      filter: `blur(${7 * b}px)`,
      transition: { duration: 0.24, ease: [0.55, 0, 0.85, 0.4] as const },
    }),
  };
  return (
    <div style={{ position: "relative", width: size, height: h, perspective: 420 * b }}>
      <AnimatePresence initial={false} mode="wait" custom={d}>
        <motion.div
          key={trackKey}
          custom={d}
          variants={variants}
          initial="enter"
          animate="center"
          exit="exit"
          style={{ width: size, height: h, transformStyle: "preserve-3d", backfaceVisibility: "hidden" }}
        >
          <Artwork src={src} size={size} height={h} radius={radius} />
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

/**
 * Very soft ambient glow behind the artwork, in the artwork's own colours.
 * Breathes slowly while playing, fades almost away when paused, cross-fades on track change.
 */
function ArtGlow({ src, playing }: { src: string | null; playing: boolean }) {
  return (
    <AnimatePresence initial={false}>
      {src && (
        // Outer layer: smooth fade between "playing" and "paused" levels (both directions).
        <motion.span
          key={src}
          className="art-glow-wrap"
          initial={{ opacity: 0 }}
          animate={{ opacity: playing ? 1 : 0.25 }}
          exit={{ opacity: 0, transition: { duration: 0.6 } }}
          transition={{ duration: 0.9, ease: [0.4, 0, 0.2, 1] }}
        >
          {/* Inner layer: the slow breathing, always running underneath. */}
          <motion.span
            className="art-glow"
            style={{ backgroundImage: `url("${src}")` }}
            initial={{ opacity: 0.4 }}
            animate={{ opacity: [0.42, 0.26, 0.38] }}
            transition={{ duration: 3.2, repeat: Infinity, repeatType: "mirror", ease: "easeInOut" }}
          />
        </motion.span>
      )}
    </AnimatePresence>
  );
}

/** Green "playing" dot: pops in with a glow, breathes softly, shrinks away when it stops. */
function LiveDot() {
  return (
    <motion.span
      className="live"
      initial={{ scale: 0, opacity: 0 }}
      animate={{
        scale: 1,
        opacity: 1,
        boxShadow: [
          "0 0 0 1.75px #000, 0 0 6px 2px rgba(48,209,88,0.75)",
          "0 0 0 1.75px #000, 0 0 3px 0px rgba(48,209,88,0.25)",
          "0 0 0 1.75px #000, 0 0 5px 1px rgba(48,209,88,0.55)",
        ],
      }}
      exit={{ scale: 0, opacity: 0, transition: { duration: 0.22, ease: [0.4, 0, 1, 1] } }}
      transition={{
        scale: { type: "spring", stiffness: 520, damping: 18 },
        opacity: { duration: 0.15 },
        boxShadow: { duration: 2.4, repeat: Infinity, repeatType: "mirror", ease: "easeInOut" },
      }}
    />
  );
}

function hash(t: string) {
  let h = 0;
  for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/**
 * SF Symbols "replace" transition: when a control's symbol changes (play ⇄ pause,
 * or switching sources swaps ⏮/⏭ for ±10 s), the old one shrinks away with a blur
 * while the new one grows in — and every control re-plays it when the source
 * changes, in step with the artwork flip.
 */
function SymbolSwap({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.span
        key={k}
        className="sym-swap"
        initial={{ scale: 0.4, opacity: 0, filter: "blur(4px)" }}
        animate={{ scale: 1, opacity: 1, filter: "blur(0px)" }}
        exit={{ scale: 0.4, opacity: 0, filter: "blur(4px)", transition: { duration: 0.16, ease: [0.4, 0, 1, 1] } }}
        transition={{ type: "spring", stiffness: 420, damping: 24, opacity: { duration: 0.18 }, filter: { duration: 0.2 } }}
      >
        {children}
      </motion.span>
    </AnimatePresence>
  );
}

function CtrlButton({ children, onClick, disabled, big }: { children: React.ReactNode; onClick(): void; disabled?: boolean; big?: boolean }) {
  const { springs } = useSettings();
  const s = big ? 46 : 40;
  return (
    <motion.button
      className="ctrl"
      disabled={disabled}
      style={{ width: s, height: s, backgroundColor: "rgba(255,255,255,0)" }}
      // Hover: a soft round highlight fades in behind the symbol and it lifts a little
      // (like the media controls on macOS); pressing squeezes it.
      whileHover={disabled ? undefined : { scale: 1.07, backgroundColor: "rgba(255,255,255,0.11)" }}
      whileTap={disabled ? undefined : { scale: 0.84, backgroundColor: "rgba(255,255,255,0.18)" }}
      transition={springs.press}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      {children}
    </motion.button>
  );
}

/* ---------- Expanded "Today" tab ---------- */

const RED = "#ff453a";

export function TodayExpanded({ width, height }: { width: number; height: number }) {
  const now = new Date(useNow(true, 1000));
  const weekday = now.toLocaleDateString(undefined, { weekday: "long" });
  const month = now.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const time = now.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

  // Week strip, Monday first.
  const start = new Date(now);
  start.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });

  return (
    <div className="today" style={{ width, height }}>
      <div className="col" style={{ gap: 0 }}>
        <div style={{ color: RED, fontSize: 13, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.2 }}>{weekday}</div>
        <div style={{ fontSize: 46, fontWeight: 600, lineHeight: 1.02, letterSpacing: -1 }}>{now.getDate()}</div>
        <div className="dim" style={{ fontSize: 13, fontWeight: 500 }}>{month}</div>
      </div>
      <div className="col" style={{ alignItems: "flex-end", gap: 14 }}>
        <div className="week">
          {days.map((d) => {
            const today = d.toDateString() === now.toDateString();
            return (
              <div key={d.toISOString()} className="col center" style={{ gap: 5 }}>
                <span className="dim" style={{ fontSize: 10.5, fontWeight: 600 }}>
                  {d.toLocaleDateString(undefined, { weekday: "narrow" })}
                </span>
                <span className={`day ${today ? "today-dot" : ""}`}>{d.getDate()}</span>
              </div>
            );
          })}
        </div>
        <div style={{ fontSize: 26, fontWeight: 600, letterSpacing: -0.5, fontVariantNumeric: "tabular-nums" }}>{time}</div>
      </div>
    </div>
  );
}

const VIDEO_PLAYERS = /^(mpv|mpv\.net|vlc|vlc media player|mpc-hc|mpc-be|media player classic|potplayer|potplayermini|potplayermini64|kmplayer|gom player|iina|movies & tv|films & tv|plex|jellyfin media player|kodi|stremio)$/i;

/** Apps where skipping ±10 s makes more sense than previous/next track. */
function isVideoPlayer(s: MediaSession) {
  const name = (s.app || "").trim();
  return VIDEO_PLAYERS.test(name) || /(^|[\\/])(mpv|vlc|mpc-hc64|mpc-be64|potplayermini64)\.exe$/i.test(s.id || "");
}

/** "Back 10" / "forward 10": an open arc over the top, arrowhead at the end, bold 10 underneath. */
function Skip10Icon({ size = 30, dir }: { size?: number; dir: 1 | -1 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 30 30" fill="none">
      <g style={{ transform: dir < 0 ? "scaleX(-1)" : undefined, transformOrigin: "15px 15px" }}>
        <path d="M6.39 17.01 A9.5 9.5 0 1 1 24.41 14.32" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
        <path d="M20.6 13.2 L28.1 13.0 L24.5 19.6 Z" fill="currentColor" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" />
      </g>
      <text x="15" y="27.2" textAnchor="middle" fontSize="10" fontWeight="800" fill="currentColor" letterSpacing="-0.5" fontFamily="var(--font)">
        10
      </text>
    </svg>
  );
}

/** The grow/shrink between the small cover and the card: quick, with a soft landing. */
const COVER_SPRING = { type: "spring" as const, stiffness: 300, damping: 30, mass: 0.9 };

/**
 * Size of the cover card for an image of `size` (natural pixels). Square covers get 300 px,
 * wide ones (videos) up to the player's width, tall posters up to 340 px high. With no
 * large copy coming, the card never shows the art more than ~25 % past its real
 * resolution, so a small cover doesn't turn to mush (never smaller than 170 px).
 * `extra` is how much taller than the player the island has to grow.
 */
function coverCard(size: { w: number; h: number } | null, sharp: boolean, lo: { w: number; h: number } | null, base: number) {
  const r = size ? size.h / size.w : 1;
  let w = r < 0.9 ? 328 : r > 1.15 ? Math.round(340 / r) : 300;
  if (!sharp && lo) {
    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    w = Math.min(w, Math.round((lo.w / dpr) * 1.25));
  }
  w = Math.max(170, w);
  const h = Math.round(w * r);
  const total = 22 + h + 14 + 44 + 22; // top, cover, gap, title + artist, bottom
  return { w, h, extra: Math.max(0, total - base) };
}
