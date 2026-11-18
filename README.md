# Islander — a Dynamic Island for Windows

An iPhone-style Dynamic Island for Windows 10/11: live media, timers, notifications, downloads, a file
shelf, clipboard history, system stats, Control Center and a "Search or Ask" bar you can type or talk
to. It tries to match the real iOS island's look and motion as closely as possible.

Built with **Tauri 2 (Rust)** + **React 19** + **Motion**. Current version: **0.8.1**.

---

## Features

### The island
- **iOS motion**: Apple-style springs (SwiftUI `response` / `dampingFraction`) that keep their velocity when
  interrupted. Default, Bouncy, Smooth and Snappy presets plus a speed slider.
- **Shape**: squircle (continuous-curvature) outline that becomes a true capsule when collapsed. Content
  sits in a fixed frame, so text never jitters while the shape morphs.
- **Put it anywhere**: drag the island to the top, bottom, left or right edge of the screen; drop zones
  show where it will land. On the sides it becomes a slim vertical pill (with a horizontal waveform).
  Also from the island's menu (Move Island…) or Settings → Position.
- **Hairline rim**: a thin outline that tints with what the island is doing: red when muted, orange for
  timers, yellow for the stopwatch, green for downloads and Focus breaks.
- **Idle styles**: a waterdrop notch attached to the screen edge, a dot, or the classic pill.
- **Split bubble**: a second live activity pinches off into a bubble with a gooey bridge.
- **Smart overlay window**: transparent, always on top, never steals focus, not in Alt+Tab or the
  taskbar. Click-through everywhere except the island.
- **Smooth from the first hover**: right after launch every panel is prepared once, invisibly, so the
  very first open is as smooth as the hundredth.
- **Gestures**: hover to expand (or click), scroll to switch tabs, drag to move. Pointing at a
  notification keeps it up so you can click it, instead of opening the island.
- **Gets out of the way**: hides while a fullscreen game, F11 browser or fullscreen video is in front,
  with optional auto-hide until you touch the screen edge.
- **Multi-monitor & DPI**: primary display, a specific display, or follow the mouse.

### Tabs (scroll to switch; each can be turned off and reordered)
| Tab | What it does |
|---|---|
| **Search or Ask** | Siri-style AI bar. Works out of the box with **no API key** through Islander's free service, with live web, news and sports-score lookups. **Ask by voice**: tap the mic, speak, and it asks when you pause. Short answers, sources, follow-ups and a remembered conversation; shrinks to a glowing circle while thinking. Maths and unit conversions (`12 km to mi`) are answered instantly on your PC. Optional real **liquid glass**. |
| **Now Playing** | Media from every app (Spotify, browsers, mpv, Stremio…) with artwork (movie and series posters for mpv/Stremio), a 5-bar waveform driven by the real audio (iOS-style, quiet when the music is quiet), 3D cover flip, a draggable scrubber, rolling-digit timestamps, a **LIVE** bar for streams, source switching, an output-device picker and click-to-open the app. |
| **Downloads** | Appears while something downloads: browser downloads (via the extension), **Mister Download Manager** and **Internet Download Manager**. Hover for every download with progress and speed, cancel one, or click a finished one to open its folder. |
| **Today** | Month calendar, a weather glance (Open-Meteo, no key) with a sun or moon that playfully follows your cursor, and your next reminders. |
| **Timer & Focus** | iOS Clock-style timer, stopwatch (with laps) and Focus (Pomodoro). Keeps running as a live pill while collapsed and chimes when done. |
| **Notes & To-Do** | A quick scratchpad and a Reminders-style checklist, saved automatically. |
| **Shelf** | Drop files, folders or images on the island, then drag them out into any app. Open, show in Explorer, remove, and convert images to JPG/PNG/WebP. |
| **Clipboard** | History of copied text, links, images and files. Click to copy again, drag out, pin, delete. Content password managers mark as private is never recorded. |
| **System** | Activity-style rings for CPU, GPU, memory and disk, plus live upload/download speed. |
| **Controls** | Control Center: Wi-Fi and Bluetooth (with pages to join networks and connect headphones), brightness and volume sliders, Airplane mode, Do Not Disturb, Light/Dark, Screenshot, Lock, Sleep, and pinned apps, folders and URLs. |

### Live activities & system
- **Notifications**: Windows notifications appear as island banners with the app icon; for messaging
  apps (Discord, WhatsApp…) the sender's picture with the app as a badge, like iOS. Swipe to dismiss,
  click to open. Do Not Disturb silences them.
- **Replaces Windows' popups** (optional): the volume/media keys and notification banners are handled by
  the island, and Windows' own volume popup stays hidden. Your settings are restored when you quit.
- **Volume & mute pills**, plus Caps Lock and Num Lock pills.
- **Privacy dots**: green while an app uses the camera, orange for the microphone.
- **AirPods & Beats**: connecting plays a 360° animation of your model (AirPods 1–4, Pro 1–3, Max,
  Beats Fit Pro) with its battery level. Other headphones get a drawn icon. Try any model from
  Settings → Notifications & System → Bluetooth devices → Preview connection.
- **Low battery** banners for Bluetooth devices.

### Settings
macOS-style settings window (right-click the island → Settings) with search: behaviour, tabs, theme,
transparency, size, font, animation style and speed, position, weather, AI, hotkeys, system pills,
notifications, software updates and more. Every change applies live.

### Automatic updates
Installed copies check for new versions, download them in the background and offer to restart. Updates
are signed, so only builds made with your signing key are accepted.

---

## Getting started

**One click:** run `run-island.bat`. It installs Node, Rust and the Visual Studio Build Tools if they're
missing, then starts the island in development mode (output also goes to `dev-output.log`).

**Manually:**
```powershell
npm install
npm run tauri dev      # run with hot reload
```

> Run it **without** administrator rights: Windows blocks drag-and-drop from Explorer into admin apps,
> so the Shelf couldn't receive files.

### Building a release
Run `build-release.bat`. It builds an optimized, signed installer into the `release` folder:
`Islander_<version>_x64-setup.exe`, its `.sig` signature and `latest.json` (the update feed, with the
text from `release-notes.txt`).

To publish, create a GitHub release on `aayus7/Islander` tagged `v<version>` and upload all three files.
Installed copies look for `latest.json` in the **latest** release, so the repository must be public for
updates and downloads to work.

The signing key lives in `.keys/` (ignored by Git). **Never share or commit it**: anyone with it could
push updates to your users, and if you lose it, existing installs can't be updated any more.

### Browser extension (optional)
For perfectly synced browser media, live-stream detection, jump-to-tab and browser download progress,
load the extension in `extension/`:
- **Firefox**: `about:debugging` → This Firefox → Load Temporary Add-on → `extension/manifest.json`.
- **Chrome / Edge**: `chrome://extensions` → Developer mode → Load unpacked → the `extension` folder.

It only talks to the island on `127.0.0.1`; nothing leaves your PC. Release builds work without it.

### AI ("Search or Ask")
Nothing to set up for users: questions go to Islander's free service (the Cloudflare Worker in
`relay/`, see `relay/README.md`), with a fair daily limit per PC. Optionally, paste your own Gemini key
in Settings → Search or Ask (from https://aistudio.google.com/apikey) to use your own quota.

**Voice**: the mic button records only while you speak and nothing is kept. Speech is turned into text
by Whisper on Islander's free service (or, where Windows' "Online speech recognition" is on, typed out
live by Windows itself), then asked like a typed question.

### Hotkeys
| Action | Default |
|---|---|
| Search or Ask | `Ctrl+Alt+Space` (change it in Settings if another app uses it) |
| Hide / show the island | `Ctrl+Alt+D` |

---

## Design in the browser
`npm run dev` and open http://localhost:1420: a fake desktop with mock media and a panel to try states,
animation styles and speed, no Windows needed.

## Project layout
```
src/
  island/Island.tsx        shape, springs, modes, tabs, live activities, docking, warm-up
  island/SidePill.tsx      vertical forms for the left/right edges
  island/content.tsx       Now Playing (compact & expanded), output picker
  island/AiPanel.tsx       Search or Ask (typing, voice, answers)
  island/Glass.tsx         WebGL liquid glass
  island/modules/          Today, Clock, Notes, Shelf, Clipboard, Stats, Controls, Downloads,
                           Devices (AirPods videos), Banners, Hud, Privacy, shared iOS UI parts
  lib/                     springs, settings, AI client & session, posters, timer, weather, sky
  Zones.tsx                drop zones shown while moving the island
  SettingsPage.tsx         the settings window
  fonts.css, assets/fonts  bundled Inter
public/devices/            AirPods & Beats connection animations (WebM)
src-tauri/src/
  main.rs                  windows, click-through, docking & moving, hotkeys, menu, commands
  media.rs / audio.rs      media sessions, artwork, real-audio waveform
  posters.rs               movie & series posters (Cinemeta / MetaHub)
  mic.rs / speech.rs       voice recording, Windows dictation
  radios.rs                Wi-Fi, Bluetooth, Airplane mode
  dlmgr.rs                 Mister Download Manager & IDM progress
  ext.rs                   browser-extension bridge
  notify.rs                notification listener (+ sender pictures)
  takeover.rs              replaces Windows' volume flyout & notification banners
  shelf.rs / dragout.rs    file shelf and native drag-out
  clipboard.rs             clipboard history
  sysmon.rs                CPU / GPU / memory / disk / network
  hud.rs, privacy.rs       volume & lock pills, camera/mic dots
  battery.rs               Bluetooth battery levels
  updater.rs               automatic updates
  system.rs, win.rs        lock, sleep, theme, launcher, screenshot, window helpers
  glass.rs, outputs.rs     glass capture, output-device switching
extension/                 browser extension (Firefox + Chromium)
relay/                     Islander's free AI service (Cloudflare Worker)
```

## Privacy
Everything runs locally except:
- **AI questions and voice clips**, sent to Islander's free service. It passes them to Google Gemini or
  Cloudflare's own AI models, and looks things up on Wikipedia, Google News, DuckDuckGo and ESPN. Gemini's
  free tier may use questions to improve Google's products, so avoid private information.
- **Weather** (Open-Meteo), **posters** (Cinemeta/MetaHub), **update checks** (GitHub) and website icons
  for pinned URLs.

Clipboard history, notes and shelf lists stay on your PC (`%APPDATA%\dev.island.desktop`). The screen
capture for liquid glass is used live and never saved. The microphone is only on while you're asking.

## Fonts
Islander ships with **Inter** and uses it by default. SF Pro can't be bundled (Apple's licence limits it
to Apple platforms); people who installed it themselves can pick **System** in Settings → Appearance.

## Credits & licences
- **AirPods & Beats animations**: [AirPodsDesktop](https://github.com/SpriteOvO/AirPodsDesktop) by
  SpriteOvO, GPL-3.0 (licence in `public/devices/`).
- **Inter** typeface: The Inter Project Authors, SIL Open Font License 1.1 (licence in `src/assets/fonts/`).
- **Weather**: Open-Meteo, CC BY 4.0. **Posters**: Cinemeta and MetaHub.
- **Speech-to-text**: OpenAI Whisper on Cloudflare Workers AI.
