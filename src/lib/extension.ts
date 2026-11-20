// Islander Media Bridge: where to get it, and which browser a media session comes from.
import { call } from "./native";

/** Store pages. Chrome, Edge, Brave and Opera all install from the Chrome Web Store. */
export const STORE = {
  chrome: "https://chromewebstore.google.com/detail/godincneomgpbkdeaehkhiimpcmbffce",
  firefox: "https://addons.mozilla.org/firefox/addon/islander-media-bridge/",
};

/** Browser names as the extension reports them. */
export type Browser = "chrome" | "edge" | "brave" | "opera" | "firefox";

const PRETTY: Record<Browser, string> = { chrome: "Chrome", edge: "Edge", brave: "Brave", opera: "Opera", firefox: "Firefox" };
export const browserName = (b: Browser) => PRETTY[b];

export const storeFor = (b: Browser) => (b === "firefox" ? STORE.firefox : STORE.chrome);

/** The browser behind a Windows media session (its AppUserModelId), or null for other apps. */
export function browserOf(sessionId: string): Browser | null {
  const id = sessionId.toLowerCase();
  // Firefox registers under a hashed AppUserModelId.
  if (id.includes("firefox") || id.includes("308046b0af4a39cb") || id.includes("6f193ccc56814779")) return "firefox";
  if (id.includes("msedge")) return "edge";
  if (id.includes("brave")) return "brave";
  if (id.includes("opera")) return "opera";
  if (id.includes("chrome")) return "chrome";
  return null;
}

/** Browsers whose extension is talking to Islander right now. */
export const connectedBrowsers = () => call<string[]>("ext_connected", undefined, []).catch(() => [] as string[]);
