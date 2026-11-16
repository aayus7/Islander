import { useEffect, useRef, useState } from "react";
import { bridge, type MediaSession, type MediaState } from "./bridge";
import { Island } from "./island/Island";

export function App() {
  const [media, setMedia] = useState<MediaState>({ sessions: [], currentId: null });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const wasPlaying = useRef(new Set<string>());

  useEffect(() => bridge.onMedia(setMedia), []);

  // When something *starts* playing, follow it (drop any manual pick), like iOS.
  useEffect(() => {
    const now = new Set(media.sessions.filter((s) => s.playing).map((s) => s.id));
    for (const id of now) {
      if (!wasPlaying.current.has(id) && id !== selectedId) {
        setSelectedId(null);
        break;
      }
    }
    wasPlaying.current = now;
  }, [media, selectedId]);

  const session = pickSession(media, selectedId);

  return (
    <Island
      session={session}
      sessions={media.sessions}
      onSelect={setSelectedId}
      onCommand={(id, a) => bridge.mediaCommand(id, a)}
    />
  );
}

/**
 * Which source the island shows, best first:
 *  1. the one you picked (clicked the bubble / switched source)
 *  2. playing AND actually audible (per-app audio meter / tab audio) — what you hear
 *  3. playing and Windows' "current" session
 *  4. anything playing
 *  5. Windows' current session, then whatever is left
 */
function pickSession({ sessions, currentId }: MediaState, selectedId: string | null): MediaSession | null {
  return (
    sessions.find((s) => s.id === selectedId) ??
    sessions.find((s) => s.playing && s.audible && s.source === "extension") ??
    sessions.find((s) => s.playing && s.audible) ??
    sessions.find((s) => s.playing && s.id === currentId) ??
    sessions.find((s) => s.playing) ??
    sessions.find((s) => s.id === currentId) ??
    sessions[0] ??
    null
  );
}
