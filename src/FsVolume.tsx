// The volume pill shown over fullscreen apps (games, videos, presentations). It lives in its
// own tiny always-on-top window that only ever draws this pill, so the island itself stays
// hidden in fullscreen: nothing else of it can flash up when you change the volume.
import { AnimatePresence, motion } from "motion/react";
import { Hud, HUD_SIZE, MUTE_SIZE, useHud } from "./island/modules/Hud";

export function FsVolume() {
  const hud = useHud();
  const show = hud && (hud.kind === "volume" || hud.kind === "mute") ? hud : null;
  const size = show?.kind === "mute" ? MUTE_SIZE : HUD_SIZE;
  return (
    <div className="fsvol">
      <AnimatePresence>
        {show && (
          <motion.div
            key="pill"
            className="fsvol-pill"
            style={{ width: size.w, height: size.h, borderRadius: size.r }}
            initial={{ opacity: 0, scale: 0.82, y: -8, filter: "blur(6px)" }}
            animate={{ opacity: 1, scale: 1, y: 0, filter: "blur(0px)", width: size.w, height: size.h, borderRadius: size.r }}
            exit={{ opacity: 0, scale: 0.9, y: -6, filter: "blur(4px)", transition: { duration: 0.22 } }}
            transition={{ type: "spring", stiffness: 420, damping: 30 }}
          >
            <Hud hud={show} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
