# Islander logo

| File | Use |
|---|---|
| `islander-logo.svg` | Master logo (rounded tile with standard padding). Use this for most things. |
| `islander-logo-small.svg` | Tuned for 16–32 px: tile fills the square, bigger pill. Favicons, tray, small icons. |
| `islander-logo-fullbleed.svg` | Tile fills the whole square (for places that add their own padding or mask). |
| `islander-logo-<size>.png` | Ready-made PNGs, 16 to 1024 px, transparent. 16/24/32 use the small version. |

Colours: tile gradient `#3a3a3e` (top) → `#1b1b1d` (bottom) with a 0.5 px white top highlight at 25%; pill `#000000` with a 12% white ring; dot `#ff9f0a` with an 8 px glow. Same recipe as the app icon in Settings → About (`.sp-appicon` in `src/styles.css`).

The app icons (`src-tauri/icons`), the extension icons (`extension/icons`) and the website favicon are generated from these files.
