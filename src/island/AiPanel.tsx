// "Search or Ask": the island's AI panel (Gemini), modelled on iOS Siri.
//
//  Search view  — a glass pill: big grey "Search or Ask", glowing white caret.
//  Answer view  — the field gives way to the answer itself: large, bold white text on
//                 black that melts into liquid glass at the bottom of the card.
//  Typing again — any key brings the search pill back for a follow-up (context is kept).
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { bridge } from "../bridge";
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
  const { q, chunks, status, error, view, meta } = useAiSession();
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

  // In the answer view, typing any character starts a follow-up.
  useEffect(() => {
    if (view !== "answer" || !active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") return onClose();
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        aiSession.askAgain(e.key);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, active, onClose]);

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
  }, [q]);

  useEffect(() => {
    const s = scroller.current;
    if (s && status === "streaming") s.scrollTop = s.scrollHeight;
  }, [chunks, status]);

  const cfg = () => ({
    apiKey: settings.aiApiKey,
    relayUrl: settings.aiRelayUrl,
    model: settings.aiModel,
    deviceId: settings.deviceId,
    log: bridge.log,
  });
  function submit() {
    aiSession.submit(cfg());
  }

  const busy = status === "thinking" || status === "streaming";

  return (
    <div ref={box} className={`ai ai-view-${view}`} style={{ width }}>
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
            onPointerDown={() => {
              if (!active) onActivate();
            }}
          >
            <div className="ai-field">
              <input
                ref={input}
                className="ai-input"
                value={q}
                spellCheck={false}
                autoComplete="off"
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submit();
                  if (e.key === "Escape") {
                    if (busy) aiSession.cancel();
                    else if (chunks.length || error) setView("answer");
                    else onClose();
                  }
                }}
              />
              {!q && <span className="ai-placeholder">Search or Ask</span>}
              <span ref={measure} className="ai-measure">
                {q}
              </span>
              {focused && <span className="ai-caret" style={{ transform: `translateX(${caretX}px)` }} />}
            </div>
            <Sparkle busy={busy} />
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
            onPointerDown={() => {
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
        <span className="ai-stale">{meta.searchEnabled ? "Answered from memory, may be out of date" : "Web search unavailable on this key, may be out of date"}</span>
      )}
    </motion.div>
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
