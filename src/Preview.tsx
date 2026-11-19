// Browser-only harness: a fake desktop + controls for tuning the island's look and motion.
// The Windows app never shows this (main.tsx only renders it outside Tauri).
import { useEffect, useState } from "react";
import { App } from "./App";
import { mock } from "./mock";
import { useSettings } from "./lib/settings";
import type { AnimStyle } from "./lib/springs";
import type { MediaState } from "./bridge";

export function Preview() {
  const { settings, update } = useSettings();
  const [state, setState] = useState<MediaState | null>(null);
  useEffect(() => mock.subscribe(setState), []);

  const primary = state?.sessions.find((s) => s.id === mock.primaryId());
  const second = !!state?.sessions.some((s) => s.id === "Chrome");

  return (
    <div className="preview">
      <App />
      <div className="panel">
        <div className="hint">Hover to expand · scroll inside to switch tabs · click the bar to seek · click the bubble to swap sources</div>
        <div className="buttons">
          <button onClick={() => primary && mock.command(primary.id, "toggle")}>{primary?.playing ? "Pause" : "Play"}</button>
          <button onClick={() => primary && mock.command(primary.id, "next")}>Next track</button>
          <button className={second ? "on" : ""} onClick={() => mock.toggleSecondSource()}>Second app playing</button>
          <button onClick={() => mock.toggleThirdSource()}>Third app</button>
          <button className={settings.pinned ? "on" : ""} onClick={() => update({ pinned: !settings.pinned })}>Pin open</button>
          <button onClick={() => window.dispatchEvent(new Event("island:ai-open"))}>Search or Ask ✦</button>
          <button onClick={() => window.open("#settings", "_blank")}>Settings page ↗</button>
        </div>
        <div className="buttons">
          {(["default", "bouncy", "smooth", "snappy"] as AnimStyle[]).map((s) => (
            <button key={s} className={settings.animStyle === s ? "on" : ""} onClick={() => update({ animStyle: s })}>
              {s[0].toUpperCase() + s.slice(1)}
            </button>
          ))}
          <label className="speed">
            Speed
            <input type="range" min={0.25} max={2} step={0.05} value={settings.animSpeed} onChange={(e) => update({ animSpeed: +e.target.value })} />
            <span>{settings.animSpeed.toFixed(2)}×</span>
          </label>
        </div>
      </div>
    </div>
  );
}
