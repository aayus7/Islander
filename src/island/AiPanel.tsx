// "Search or Ask": the island's AI panel (Gemini), modelled on iOS Siri.
//
//  Search view  — a glass pill: big grey "Search or Ask", glowing white caret.
//  Answer view  — the field gives way to the answer itself: large, bold white text on
//                 black that melts into liquid glass at the bottom of the card.
//  Typing again — any key brings the search pill back for a follow-up (context is kept).
import { AnimatePresence, motion } from "motion/react";
import { DEFAULT_RELAY } from "../lib/relayUrl";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { bridge } from "../bridge";
import { on } from "../lib/native";
import type { AiMeta } from "../lib/ai";
import { aiSession, useAiSession, type AiView } from "../lib/aiSession";
import { useSettings } from "../lib/settings";

export const AI_BAR_H = 60;
export const AI_MAX_H = 420;

export type { AiView };

interface Props {
  width: number;
  /** true once the panel owns the keyboard (clicked / opened by hotkey) */
  active: boolean;
  onActivate(): void;
  onShape(h: number, view: AiView): void;
  onClose(): void;
}

export function AiPanel({ width, active, onActivate, onShape, onClose }: Props) {
  const { settings } = useSettings();
  const { q, chunks, status, error, view, meta, voice, voiceNote } = useAiSession();
  const setQ = aiSession.setQuery;
  const setView = aiSession.setView;
  const [focused, setFocused] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const measure = useRef<HTMLSpanElement>(null);
  const [caretX, setCaretX] = useState(0);

  // Take the keyboard as soon as the island lets us.
  useEffect(() => {
    if (!active) return;
    const t = setTimeout(() => input.current?.focus(), 60);
    return () => clearTimeout(t);
  }, [active, view]);

  // While dictating, keep the newest words in view.
  useEffect(() => {
    if (voice === "listening" && input.current) input.current.scrollLeft = input.current.scrollWidth;
  }, [q, voice]);

  // Closing the panel or switching tabs never leaves the mic on.
  // (While the words are being transcribed the island shows its thinking circle instead of
  // this panel, so only an open mic is stopped here.)
  useEffect(() => () => aiSession.dropMic(), []);

  // In the answer view, typing any character starts a follow-up, and Backspace clears the
  // answer for a fresh question. The panel keeps keyboard focus so this works straight away.
  useEffect(() => {
    if (view !== "answer" || !active) return;
    box.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") return onClose();
      if ((e.key === "Backspace" || e.key === "Delete") && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        if (status === "thinking" || status === "streaming") aiSession.cancel();
        aiSession.askAgain("");
        return;
      }
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        aiSession.askAgain(e.key);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, active, onClose, status]);

  // Report our natural size so the island can spring to it.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const report = () => onShape(Math.min(AI_MAX_H, Math.max(AI_BAR_H, Math.ceil(el.getBoundingClientRect().height))), view);
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [onShape, view]);

  // Glowing caret follows the text.
  useLayoutEffect(() => {
    setCaretX(measure.current?.getBoundingClientRect().width ?? 0);
  }, [q, view]); // the field is rebuilt when coming back from an answer

  useEffect(() => {
    const s = scroller.current;
    if (s && status === "streaming") s.scrollTop = s.scrollHeight;
  }, [chunks, status]);

  const cfg = () => ({
    apiKey: settings.aiApiKey,
    relayUrl: settings.aiRelayUrl.trim() || DEFAULT_RELAY,
    model: settings.aiModel,
    deviceId: settings.deviceId,
    log: bridge.log,
  });
  function submit() {
    aiSession.submit(cfg());
  }

  const busy = status === "thinking" || status === "streaming";
  const listening = voice === "listening";
  const toggleMic = () => {
    if (!active) onActivate();
    if (voice === "listening") aiSession.stopListening(cfg());
    else if (voice === "off") aiSession.listen(cfg());
  };

  return (
    <div ref={box} className={`ai ai-view-${view}`} style={{ width }} tabIndex={-1}>
      <AnimatePresence>
        {busy && (
          <motion.div
            className="siri-edge"
            style={{ borderRadius: view === "search" ? AI_BAR_H / 2 : 40 }}
            initial={{ opacity: 0 }}
            animate={{ opacity: status === "thinking" ? 1 : 0.4 }}
            exit={{ opacity: 0, transition: { duration: 0.7 } }}
            transition={{ duration: 0.4 }}
          />
        )}
      </AnimatePresence>

      <AnimatePresence mode="popLayout" initial={false}>
        {view === "search" ? (
          <motion.div
            key="search"
            className="ai-bar"
            initial={{ opacity: 0, filter: "blur(6px)" }}
            animate={{ opacity: 1, filter: "blur(0px)" }}
            exit={{ opacity: 0, filter: "blur(6px)", transition: { duration: 0.15 } }}
            transition={{ duration: 0.25 }}
            onClick={() => {
              // On release (not press), so pressing and holding can pick the island up.
              if (!active) onActivate();
            }}
          >
            <div className="ai-field">
              <input
                ref={input}
                className="ai-input"
                value={q}
                readOnly={voice !== "off"}
                spellCheck={false}
                autoComplete="off"
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (voice !== "off") {
                    if (e.key === "Escape") aiSession.cancelListening();
                    if (e.key === "Enter" && listening) aiSession.stopListening(cfg());
                    return;
                  }
                  if (e.key === "Enter") submit();
                  if (e.key === "Escape") {
                    if (busy) aiSession.cancel();
                    else if (chunks.length || error) setView("answer");
                    else onClose();
                  }
                }}
              />
              {!q && (
                <AnimatePresence mode="popLayout" initial={false}>
                  <motion.span
                    key={listening ? "l" : voice === "transcribing" ? "t" : voiceNote || "p"}
                    className={`ai-placeholder ${voice !== "off" ? "ai-placeholder-live" : ""}`}
                    initial={{ opacity: 0, y: 6, filter: "blur(4px)" }}
                    animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                    exit={{ opacity: 0, y: -6, filter: "blur(4px)", transition: { duration: 0.14 } }}
                    transition={{ duration: 0.22 }}
                  >
                    {listening ? "Listening…" : voice === "transcribing" ? "One moment…" : voiceNote || "Search or Ask"}
                  </motion.span>
                </AnimatePresence>
              )}
              <span ref={measure} className="ai-measure">
                {q}
              </span>
              {focused && voice === "off" && <span className="ai-caret" style={{ transform: `translateX(${caretX}px)` }} />}
            </div>
            {busy || voice === "transcribing" || (q && voice === "off") ? (
              <Sparkle busy={busy || voice === "transcribing"} />
            ) : (
              <MicButton listening={listening} onToggle={toggleMic} />
            )}
          </motion.div>
        ) : (
          <motion.div
            key="answer"
            className="ai-body"
            ref={scroller}
            style={{ maxHeight: AI_MAX_H }}
            initial={{ opacity: 0, filter: "blur(8px)" }}
            animate={{ opacity: 1, filter: "blur(0px)" }}
            exit={{ opacity: 0, filter: "blur(8px)", transition: { duration: 0.15 } }}
            transition={{ duration: 0.3 }}
            onClick={() => {
              // On release (not press), so pressing and holding can pick the island up.
              if (!active) onActivate();
            }}
          >
            {error ? (
              <div className="ai-error">
                <p className="ai-answer ai-answer-err">{error.message}</p>
                <div className="ai-actions">
                  {error.code !== "no_key" && (
                    <button className="ai-pill ai-pill-primary" onClick={() => aiSession.retry(cfg())}>
                      Try again
                    </button>
                  )}
                  <button className="ai-pill" onClick={() => aiSession.askAgain()}>
                    Ask something else
                  </button>
                  {(error.code === "no_key" || error.code === "upstream") && (
                    <button className="ai-pill" onClick={() => bridge.openSettings()}>
                      Settings
                    </button>
                  )}
                </div>
              </div>
            ) : status === "thinking" ? (
              <p className="ai-answer ai-thinking">Thinking…</p>
            ) : (
              <>
                <p className="ai-answer">
                  {chunks.map((c, i) => (
                    <span key={i} className="ai-chunk">
                      {c}
                    </span>
                  ))}
                </p>
                {status === "idle" && meta && <SourceLine meta={meta} />}
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** AI Overview-style footer: where the answer came from. */
function SourceLine({ meta }: { meta: AiMeta }) {
  const domains = [...new Set(meta.sources.map((s) => (s.title || s.uri).replace(/^www\./, "")))].slice(0, 3);
  return (
    <motion.div className="ai-sources" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35, delay: 0.1 }}>
      {meta.searched ? (
        <>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
            <circle cx="11" cy="11" r="6.5" />
            <path d="M16 16l4.5 4.5" />
          </svg>
          <span>{domains.length ? domains.join(" · ") : "Google Search"}</span>
        </>
      ) : (
        <span className="ai-stale">{meta.searchEnabled ? "Answered from memory, may be out of date" : "Answered without a web lookup, may be out of date"}</span>
      )}
    </motion.div>
  );
}

/**
 * Mic: a quiet glyph at rest; while listening it becomes a white disc with a live voice
 * waveform (tap it to finish early). Levels go straight to the DOM, not through React.
 */
function MicButton({ listening, onToggle }: { listening: boolean; onToggle(): void }) {
  const bars = useRef<(HTMLSpanElement | null)[]>([]);
  useEffect(() => {
    if (!listening) return;
    let level = 0;
    let target = 0;
    let raf = 0;
    const SHAPE = [0.55, 0.85, 1, 0.8, 0.5];
    const off = on<number>("mic://level", (v) => (target = v));
    const tick = (t: number) => {
      // Fast attack, slower release, like iOS dictation.
      level += (target - level) * (target > level ? 0.45 : 0.12);
      bars.current.forEach((b, i) => {
        if (!b) return;
        const wobble = 0.75 + 0.25 * Math.sin(t / 95 + i * 1.7);
        const h = 3 + 15 * Math.min(1, level * 1.25) * SHAPE[i] * wobble;
        b.style.height = `${h.toFixed(1)}px`;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      off();
      cancelAnimationFrame(raf);
    };
  }, [listening]);
  return (
    <motion.button
      className={`ai-mic ${listening ? "on" : ""}`}
      aria-label={listening ? "Stop listening" : "Ask by voice"}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      initial={{ opacity: 0, scale: 0.6 }}
      animate={{ opacity: 1, scale: 1 }}
      whileTap={{ scale: 0.88 }}
      transition={{ type: "spring", stiffness: 420, damping: 26 }}
    >
      <AnimatePresence mode="popLayout" initial={false}>
        {listening ? (
          <motion.span key="wave" className="ai-mic-wave" initial={{ opacity: 0, scale: 0.5 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.5 }}>
            {[0, 1, 2, 3, 4].map((i) => (
              <span key={i} ref={(el) => void (bars.current[i] = el)} />
            ))}
          </motion.span>
        ) : (
          <motion.svg key="mic" width="20" height="20" viewBox="0 0 24 24" fill="none" initial={{ opacity: 0, scale: 0.5 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.5 }}>
            <rect x="8.6" y="2.6" width="6.8" height="12.2" rx="3.4" fill="currentColor" />
            <path d="M5.6 11.2a6.4 6.4 0 0 0 12.8 0M12 17.6v3.6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </motion.svg>
        )}
      </AnimatePresence>
    </motion.button>
  );
}

function Sparkle({ busy }: { busy: boolean }) {
  return (
    <motion.svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      className="ai-sparkle"
      animate={busy ? { rotate: 360, opacity: 1 } : { rotate: 0, opacity: 0.55 }}
      transition={busy ? { rotate: { duration: 2.4, repeat: Infinity, ease: "linear" } } : { duration: 0.4 }}
    >
      <path d="M12 2.5c.6 4.6 3.4 7.9 8.5 9.5-5.1 1.6-7.9 4.9-8.5 9.5-.6-4.6-3.4-7.9-8.5-9.5 5.1-1.6 7.9-4.9 8.5-9.5z" fill="currentColor" />
    </motion.svg>
  );
}
