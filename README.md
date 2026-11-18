# Islander — a Dynamic Island for Windows

An iPhone-style Dynamic Island for Windows 10/11 that lives at the top of your screen: live media, timers,
notifications, a file shelf, clipboard history, system stats, quick controls and an AI "Search or Ask"
bar. It tries to match the real iOS island's look and motion as closely as possible.

Built with **Tauri 2 (Rust)** + **React 19** + **Motion**.

---

## Features

### The island
- **iOS motion**: Apple-style springs (SwiftUI `response` / `dampingFraction`) that keep their velocity when
  interrupted. Default, Bouncy, Smooth and Snappy presets plus a speed slider.
- **Shape**: squircle (continuous-curvature) outline that becomes a true capsule when collapsed. Content
  sits in a fixed frame, so text never jitters while the shape morphs.
- **Hairline rim**: a thin grey outline that tints with what the island is doing: red when muted, orange
  for timers, yellow for the stopwatch, green for downloads and Focus breaks.
- **Idle styles**: a waterdrop notch attached to the top edge, a dot, or the classic pill.
- **Split bubble**: a second live activity pinches off into a bubble with a gooey bridge (a second song,
  a timer next to your music, or a download).
- **Smart overlay window**: transparent, always on top, never steals focus, not in Alt+Tab or the
  taskbar. Click-through everywhere except the island, so browser tabs under it stay clickable.
- **Gestures**: hover to expand (or click, if you prefer), scroll to switch tabs, drag upwards to dismiss.
- **Gets out of the way**: hides while a fullscreen game, F11 browser or fullscreen video is in front
  (maximized windows don't count), with optional auto-hide until you touch the top edge.
- **Multi-monitor & DPI**: pin to the primary display, a specific display, or follow the mouse; correct
  per-monitor DPI scaling.

### Tabs (scroll to switch; each can be turned off)
| Tab | What it does |
|---|---|
| **Search or Ask** | Siri-style AI bar using Google Gemini with live Google Search grounding, short AI-Overview-style answers, source domains, follow-ups and a remembered conversation. Optional real **liquid glass** (refraction of what's behind the panel). Maths and unit conversions (`12 km to mi`, `70f in c`) are answered instantly on your PC. |
| **Now Playing** | Live media from every app (Spotify, browsers, Media Player…), with artwork, a colour-matched 6-bar waveform driven by the real audio, iOS-style 3D cover flip on track change, a draggable scrubber, iOS rolling-digit timestamps, a **LIVE** bar for live streams, source switching, an output-device picker (speakers/headphones) and click-to-open the playing app or tab. |
| **Today** | Month calendar with today highlighted, a weather glance (Open-Meteo, no API key), and your next reminders. |
| **Timer & Focus** | iOS Clock-style timer, stopwatch (with laps) and Focus (Pomodoro) with rolling digits. Keeps running as a live pill while collapsed, or in the bubble next to your music, and chimes and shows a banner when done. |
| **Notes & To-Do** | A quick scratchpad and a Reminders-style checklist, saved automatically. |
| **Shelf** | Drop files, folders or images on the island to stash them, then drag them out into any app (Explorer, Discord, browsers). Open, show in Explorer, remove, clear, and convert images to JPG/PNG/WebP. |
| **Clipboard** | History of copied text, links, images and files. Click to copy again, drag out into any app, pin, delete or clear. Content that password managers mark as private is never recorded. |
| **System** | Activity-style rings for CPU, GPU, memory and disk (green → yellow → red with load) and live upload/download speed with a smooth scrolling graph. |
| **Controls** | Control-Center toggles: Do Not Disturb, Mute, Light/Dark mode, Screenshot (Win+PrintScreen), Lock and Sleep, plus a launcher for pinned apps, folders and URLs (drop them on the tab). |

### Live activities & system
- **Notifications**: Windows notifications appear as island banners with the app icon, and for messaging
  apps the sender's picture with the app as a badge (like iOS). Attached photos show as a thumbnail.
  Swipe sideways to dismiss, click to open the app. Do Not Disturb silences them.
- **Replaces Windows' popups** (optional): the volume/media keys and notification banners are handled by
  the island, so Windows' own popups stay hidden while it runs. Your original settings are restored
  when you quit.
- **Volume & mute pills**: a slim volume bar, plus an iOS Ring/Silent-style mute pill that turns red.
  Caps Lock and Num Lock pills too.
- **Privacy dots**: green while an app uses the camera, orange for the microphone.
- **Bluetooth batteries**: a banner when a wireless device connects or drops below 20 %.
- **Download progress**: browser downloads show as a progress ring live activity and a "Downloaded" banner.

### Settings
iOS-style settings window (right-click the island → Settings): behaviour, tabs, animation style & speed,
size, theme, transparency, position & display, weather city/units, AI key & model, hotkeys,
system pills, notifications, clipboard history, frame rate (60–240 Hz) and more. Every change applies live.

---

## Getting started

**One-click:** run `run-island.bat`. It installs Node, Rust and the Visual Studio Build Tools if they're
missing, then starts the island.

**Manually:**
```powershell
npm install
npm run tauri dev      # run with hot reload
npm run tauri build    # build an installer (src-tauri/target/release/bundle/nsis)
```

> Run it **without** administrator rights: Windows blocks drag-and-drop from Explorer into admin apps,
> so the Shelf couldn't receive files.

### Browser extension (recommended)
For perfectly synced browser media (YouTube, Spotify Web, SoundCloud…), live-stream detection,
jump-to-tab and download progress, load the extension in `extension/`:
- **Firefox**: `about:debugging` → This Firefox → Load Temporary Add-on → pick `extension/manifest.json`.
- **Chrome / Edge**: `chrome://extensions` → Developer mode → Load unpacked → pick the `extension` folder.

It only talks to the island on `127.0.0.1`; nothing leaves your PC.

### AI ("Search or Ask")
Either paste your own free Gemini API key in Settings (get one at https://aistudio.google.com/apikey),
or deploy the small Cloudflare Worker in `relay/` so users don't need a key (see `relay/README.md`;
it keeps the key on the server with per-device and global daily limits).
Default hotkey: `Ctrl+Alt+Space` (change it in Settings if another app uses it).

### Hotkeys
| Action | Default |
|---|---|
| Search or Ask | `Ctrl+Alt+Space` |
| Hide / show the island | `Ctrl+Alt+D` |

---

## Design in the browser
`npm run dev` and open http://localhost:1420: a fake desktop with mock media and a panel to try states,
animation styles and speed, no Windows needed.

## Project layout
```
src/
  island/Island.tsx          shape, springs, modes, tabs, live activities, bubble, rim
  island/content.tsx       Now Playing (compact & expanded), output picker
  island/AiPanel.tsx       Search or Ask
  island/Glass.tsx         WebGL liquid glass
  island/modules/          Today, Clock, Notes, Shelf, Clipboard, Stats, Controls,
                           Banners, Hud, Downloads, Privacy, shared iOS UI parts
  lib/                     springs, settings, AI client, timer engine, weather, quick answers
  SettingsPage.tsx         the settings window
src-tauri/src/
  main.rs                  window, click-through, hotkeys, menu, commands
  media.rs / audio.rs      media sessions, real-audio waveform, per-app meters
  ext.rs                   browser-extension bridge (WebSocket)
  notify.rs                notification listener (+ sender pictures)
  takeover.rs              replaces Windows' volume flyout & notification banners
  shelf.rs / dragout.rs    file shelf and native drag-out
  clipboard.rs             clipboard history
  sysmon.rs                CPU / GPU / memory / disk / network
  hud.rs, privacy.rs       volume & lock pills, camera/mic dots
  battery.rs               Bluetooth battery levels
  system.rs                lock, sleep, mute, theme, launcher, screenshot
  glass.rs, outputs.rs     glass capture, output-device switching
extension/                 browser extension (Firefox + Chromium)
relay/                     optional Cloudflare Worker for keyless AI
```

## Privacy
Everything runs locally. Clipboard history and shelf lists are stored on your PC only
(`%APPDATA%\dev.island.desktop`). Screen capture for liquid glass is used live and never saved.
The only network calls are weather (Open-Meteo), the AI request (Gemini, or your relay) and
website favicons for pinned URLs.

### Islander Media Bridge (browser extension)
The browser extension exists only to connect your browser to the Islander app on the same PC.

- **What it reads:** for the tab that's playing audio or video, the media title, artist,
  artwork and playback position (from the page's own player / Media Session), whether it's a
  live stream, and the progress of your current downloads.
- **Where it goes:** only to the Islander app on your own computer, over a local connection
  (`ws://127.0.0.1:47823`). Nothing is sent to any server, ours or anyone else's.
- **What it does with it:** shows it in the island and carries out the play / pause / skip /
  seek buttons you press there.
- **What it never does:** it doesn't store your browsing, read page content beyond the media
  player, collect personal information, use analytics or ads, or sell or share any data.

Removing the extension (or closing Islander) stops all of this immediately. Questions:
open an issue at https://github.com/aayus7/Islander/issues.

## Fonts
The UI uses SF Pro if it's installed, otherwise Inter, otherwise Segoe UI. SF Pro's licence only covers
Apple platforms, so don't bundle it in anything you distribute.
