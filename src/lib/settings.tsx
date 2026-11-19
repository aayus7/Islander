import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { bridge } from "../bridge";
import { DEFAULT_SETTINGS, type AppSettings } from "../settings-types";
import { springsFor, type SpringSet } from "./springs";

interface Ctx {
  settings: AppSettings;
  springs: SpringSet;
  update(patch: Partial<AppSettings>): void;
  reset(): void;
}

const SettingsCtx = createContext<Ctx | null>(null);

/** Settings live in the Rust backend (or the mock); every window stays in sync via events. */
export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);

  useEffect(() => {
    let alive = true;
    bridge.getSettings().then((s) => alive && setSettings(s)).catch(console.error);
    const un = bridge.onSettings(setSettings);
    return () => {
      alive = false;
      un();
    };
  }, []);

  const update = useCallback((patch: Partial<AppSettings>) => {
    setSettings((s) => ({ ...s, ...patch })); // optimistic: sliders feel instant
    bridge.updateSettings(patch).then(setSettings).catch(console.error);
  }, []);

  const reset = useCallback(() => {
    bridge.resetSettings().then(setSettings).catch(console.error);
  }, []);

  // Typeface for every window (island, Settings, overlays).
  useEffect(() => {
    document.documentElement.style.setProperty(
      "--font",
      settings.font === "system"
        ? '-apple-system, "SF Pro Text", "SF Pro Display", "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif'
        : '"Islander Inter", "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif',
    );
  }, [settings.font]);

  const springs = useMemo(() => springsFor(settings.animStyle, settings.animSpeed), [settings.animStyle, settings.animSpeed]);

  return <SettingsCtx.Provider value={{ settings, springs, update, reset }}>{children}</SettingsCtx.Provider>;
}

export function useSettings() {
  const v = useContext(SettingsCtx);
  if (!v) throw new Error("useSettings outside provider");
  return v;
}
