// Nearby sharing UI (LocalSend): AirDrop-style device bubbles under the Shelf, and the
// card that asks before accepting files from a phone.
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { allowIncoming, respond, type Incoming, type Peer, type Transfer } from "../../lib/nearby";
import { FileTile, fmtBytes } from "./Downloads";
import type { ShelfItem } from "./Shelf";

const BLUE = "#0a84ff";
const GREEN = "#30d158";
const RED = "#ff453a";

/** Shown after a device was found when nothing ever came back: Windows Firewall is
 *  dropping phones' connections, so they can't see or send to this PC. One tap fixes it. */
function AllowChip({ onDone }: { onDone(msg: string): void }) {
  const [busy, setBusy] = useState(false);
  return (
    <motion.button
      layout
      className="nb-dev nb-allow"
      title="Windows Firewall is blocking phones from reaching this PC"
      initial={{ opacity: 0, scale: 0.7, filter: "blur(6px)" }}
      animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
      exit={{ opacity: 0, scale: 0.7, filter: "blur(6px)", transition: { duration: 0.16 } }}
      whileTap={busy ? undefined : { scale: 0.92 }}
      transition={{ type: "spring", stiffness: 420, damping: 30 }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={async (e) => {
        e.stopPropagation();
        if (busy) return;
        setBusy(true);
        const err = await allowIncoming();
        setBusy(false);
        onDone(err ?? "Phones can now send to this PC");
      }}
    >
      <span className="nb-avatar warn">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3l7.5 3v5.6c0 4.4-3.1 8.1-7.5 9.4-4.4-1.3-7.5-5-7.5-9.4V6z" />
          <path d="M12 8.5v4" />
          <path d="M12 15.6v.1" />
        </svg>
        {busy && (
          <svg className="nb-ring" width="50" height="50" viewBox="0 0 50 50">
            <circle className="nb-spin" cx="25" cy="25" r="22" fill="none" stroke="#ff9f0a" strokeWidth="2.6" strokeLinecap="round" strokeDasharray="30 140" />
          </svg>
        )}
      </span>
      <span className="nb-name">Can't receive</span>
      <span className="nb-sub">{busy ? "Waiting for Windows…" : "Allow phones"}</span>
    </motion.button>
  );
}

/** Phone / laptop / globe, drawn like SF Symbols. */
export function DeviceGlyph({ type, size = 20 }: { type: string; size?: number }) {
  const p = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" } as const;
  if (type === "mobile")
    return (
      <svg {...p}>
        <rect x="6.5" y="2.5" width="11" height="19" rx="2.8" />
        <path d="M10.5 5.2h3" />
      </svg>
    );
  if (type === "web")
    return (
      <svg {...p}>
        <circle cx="12" cy="12" r="8.5" />
        <path d="M3.5 12h17M12 3.5c2.4 2.4 3.4 5.3 3.4 8.5s-1 6.1-3.4 8.5c-2.4-2.4-3.4-5.3-3.4-8.5s1-6.1 3.4-8.5z" />
      </svg>
    );
  return (
    <svg {...p}>
      <rect x="4" y="5" width="16" height="11" rx="1.8" />
      <path d="M2.5 19h19" />
    </svg>
  );
}

function statusOf(t: Transfer | undefined): { text: string; color: string } | null {
  if (!t) return null;
  switch (t.state) {
    case "waiting":
      return { text: "Waiting…", color: "rgba(235,235,245,0.6)" };
    case "sending":
      return { text: "Sending…", color: BLUE };
    case "done":
      return { text: t.files > 1 ? `Sent ${t.files} files` : t.files === 1 ? "Sent 1 file" : "Sent", color: GREEN };
    case "declined":
      return { text: "Declined", color: RED };
    case "cancelled":
      return { text: "Cancelled", color: "rgba(235,235,245,0.6)" };
    default:
      return { text: "Failed", color: RED };
  }
}

/** One nearby device: avatar with a progress ring, name, and what's happening. */
function DeviceBubble({ peer, t, disabled, onTap }: { peer: Peer; t?: Transfer; disabled: boolean; onTap(): void }) {
  const st = statusOf(t);
  const busy = t?.state === "waiting" || t?.state === "sending";
  const frac = t && t.total > 0 ? Math.min(1, t.sent / t.total) : 0;
  const R = 22;
  const C = 2 * Math.PI * R;
  return (
    <motion.button
      layout
      className={`nb-dev ${disabled ? "off" : ""}`}
      title={disabled ? "Add files to the Shelf first" : busy ? `Sending to ${peer.alias}` : `Send everything on the Shelf to ${peer.alias}`}
      initial={{ opacity: 0, scale: 0.7, filter: "blur(6px)" }}
      animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
      exit={{ opacity: 0, scale: 0.7, filter: "blur(6px)", transition: { duration: 0.16 } }}
      whileTap={disabled || busy ? undefined : { scale: 0.92 }}
      transition={{ type: "spring", stiffness: 420, damping: 30 }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        if (!disabled && !busy) onTap();
      }}
    >
      <span className={`nb-avatar ${t?.state === "done" ? "done" : ""}`}>
        <AnimatePresence mode="popLayout" initial={false}>
          {t?.state === "done" ? (
            <motion.svg key="ok" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.4, opacity: 0 }}>
              <path d="M5 12.5l4.5 4.5L19 7.5" />
            </motion.svg>
          ) : (
            <motion.span key="dev" style={{ display: "flex" }} initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.4, opacity: 0 }}>
              <DeviceGlyph type={peer.deviceType} />
            </motion.span>
          )}
        </AnimatePresence>
        {busy && (
          <svg className="nb-ring" width="50" height="50" viewBox="0 0 50 50">
            <circle cx="25" cy="25" r={R} fill="none" stroke="rgba(10,132,255,0.25)" strokeWidth="2.6" />
            {t?.state === "waiting" ? (
              <circle className="nb-spin" cx="25" cy="25" r={R} fill="none" stroke={BLUE} strokeWidth="2.6" strokeLinecap="round" strokeDasharray={`${C * 0.22} ${C}`} />
            ) : (
              <motion.circle
                cx="25"
                cy="25"
                r={R}
                fill="none"
                stroke={BLUE}
                strokeWidth="2.6"
                strokeLinecap="round"
                strokeDasharray={C}
                initial={false}
                animate={{ strokeDashoffset: C * (1 - Math.max(0.02, frac)) }}
                transition={{ type: "spring", stiffness: 120, damping: 24 }}
                transform="rotate(-90 25 25)"
              />
            )}
          </svg>
        )}
      </span>
      <span className="nb-name">{peer.alias}</span>
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={st?.text ?? "model"}
          className="nb-sub"
          style={{ color: st?.color }}
          initial={{ opacity: 0, y: 3 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -3 }}
          transition={{ duration: 0.16 }}
          title={t?.error ?? undefined}
        >
          {st?.text ?? (peer.deviceModel || (peer.deviceType === "mobile" ? "Phone" : "Computer"))}
        </motion.span>
      </AnimatePresence>
    </motion.button>
  );
}

/** Radar pulse while looking for devices. */
function Radar() {
  return (
    <span className="nb-radar">
      {[0, 1, 2].map((i) => (
        <span key={i} style={{ animationDelay: `${i * 0.6}s` }} />
      ))}
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={BLUE} strokeWidth="2" strokeLinecap="round">
        <path d="M8.5 15.5a5 5 0 0 1 0-7M15.5 8.5a5 5 0 0 1 0 7M5.6 18.4a9 9 0 0 1 0-12.8M18.4 5.6a9 9 0 0 1 0 12.8" />
        <circle cx="12" cy="12" r="1.6" fill={BLUE} stroke="none" />
      </svg>
    </span>
  );
}

/** Height the Nearby row adds to the Shelf. */
export const NEARBY_H = 62;

/** Devices under the Shelf. Tapping one opens the Send sheet (what goes, then confirm) via onPick. */
export function NearbyRow({ peers, byPeer, items, blocked, onPick }: { peers: Peer[]; byPeer: Record<string, Transfer>; items: ShelfItem[]; blocked: boolean; onPick(p: Peer): void }) {
  const files = items.filter((i) => i.kind !== "folder");
  const [note, setNote] = useState<string | null>(null);
  const flash = (m: string) => {
    setNote(m);
    window.setTimeout(() => setNote((n) => (n === m ? null : n)), 3200);
  };
  return (
    <div className="nb-row">
      <AnimatePresence mode="popLayout" initial={false}>
        {peers.length === 0 && !blocked ? (
          <motion.div key="look" className="nb-looking" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <Radar />
            <div className="col" style={{ gap: 1, minWidth: 0 }}>
              <span className="nb-look-title">Looking for nearby devices</span>
              <span className="nb-look-sub">Open LocalSend on your phone, on the same Wi-Fi</span>
            </div>
          </motion.div>
        ) : (
          <motion.div key="list" className="nb-list" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <AnimatePresence initial={false}>
              {blocked && <AllowChip key="allow" onDone={flash} />}
              {peers.map((p) => (
                <DeviceBubble
                  key={p.fingerprint}
                  peer={p}
                  t={byPeer[p.alias]}
                  disabled={files.length === 0}
                  onTap={() => onPick(p)}
                />
              ))}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {note && (
          <motion.div className="nb-note" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 6 }} transition={{ type: "spring", stiffness: 420, damping: 32 }}>
            {note}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** "Pixel 8 wants to share 3 files" — the island opens to this card until you choose. */
export const INCOMING_SIZE = { w: 372, h: 178, r: 44 };

export function IncomingCard({ req }: { req: Incoming }) {
  const n = req.files.length;
  const allImages = req.files.every((f) => f.fileType.startsWith("image/"));
  const what = n === 1 ? req.files[0].name : `${n} ${allImages ? "photos" : "files"}`;
  const shown = req.files.slice(0, 5);
  return (
    <div className="nb-in" style={{ width: INCOMING_SIZE.w, height: INCOMING_SIZE.h }}>
      <div className="nb-in-head">
        <span className="nb-in-avatar">
          <DeviceGlyph type={req.deviceType} size={22} />
        </span>
        <div className="col" style={{ gap: 2, minWidth: 0, flex: 1 }}>
          <span className="nb-in-title">{req.alias}</span>
          <span className="nb-in-sub">
            wants to share {what} · {fmtBytes(req.total)}
          </span>
        </div>
      </div>
      <div className="nb-in-files">
        {shown.map((f, i) => (
          <motion.span
            key={`${f.name}-${i}`}
            className="nb-in-file"
            title={`${f.name} · ${fmtBytes(f.size)}`}
            initial={{ opacity: 0, y: 8, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ type: "spring", stiffness: 380, damping: 28, delay: 0.05 + i * 0.04 }}
          >
            {f.preview ? <img src={f.preview} alt="" draggable={false} /> : <FileTile name={f.name} size={34} />}
          </motion.span>
        ))}
        {n > shown.length && <span className="nb-in-more">+{n - shown.length}</span>}
      </div>
      <div className="nb-in-actions">
        <motion.button className="nb-btn" whileTap={{ scale: 0.95 }} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => (e.stopPropagation(), respond(req.id, false))}>
          Decline
        </motion.button>
        <motion.button className="nb-btn accept" whileTap={{ scale: 0.95 }} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => (e.stopPropagation(), respond(req.id, true))}>
          Accept
        </motion.button>
      </div>
    </div>
  );
}
