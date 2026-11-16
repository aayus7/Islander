import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Preview } from "./Preview";
import { SettingsPage } from "./SettingsPage";
import { bridge, isTauri } from "./bridge";
import { SettingsProvider } from "./lib/settings";
import "./styles.css";

const isSettings = bridge.windowLabel === "settings";
document.documentElement.classList.toggle("native", isTauri);
document.documentElement.classList.toggle("settings-window", isSettings);

// No browser right-click menu anywhere in the app.
if (isTauri) document.addEventListener("contextmenu", (e) => e.preventDefault());

createRoot(document.getElementById("root")!).render(
  <SettingsProvider>{isSettings ? <SettingsPage /> : isTauri ? <App /> : <Preview />}</SettingsProvider>,
);
