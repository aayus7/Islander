//! User settings: one JSON file in the app's config folder
//! (%APPDATA%\dev.island.desktop\settings.json). Rust owns the truth; every window
//! gets "settings://changed" whenever it changes.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Mutex;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// "default" | "bouncy" | "smooth" | "snappy"
    pub anim_style: String,
    /// 0.25 – 2.0, higher = faster
    pub anim_speed: f64,
    /// 0.7 – 1.6
    pub size_scale: f64,
    /// Logical px from the default top-centre position.
    pub offset_x: f64,
    pub offset_y: f64,
    /// "primary" | "follow" | "0", "1", … (index into the monitor list)
    pub monitor: String,
    pub expand_on_hover: bool,
    pub pinned: bool,
    /// "black" | "graphite" | "midnight"
    pub theme: String,
    /// 0 = solid, 0.6 = very see-through
    pub transparency: f64,
    /// e.g. "Ctrl+Alt+D". Empty = no hotkey.
    pub hide_hotkey: String,
    /// Look when nothing is playing: "notch" (attached waterdrop) | "dot" | "pill"
    pub idle_style: String,

    // ---- AI ----
    /// Hotkey that opens "Search or Ask".
    pub ai_hotkey: String,
    /// Your own Gemini API key (optional). Empty → use the relay.
    pub ai_api_key: String,
    /// Gemini model id.
    pub ai_model: String,
    /// Relay server URL for keyless use (set when you deploy relay/).
    pub ai_relay_url: String,
    /// Real liquid glass behind the AI panel (captures the screen behind it, locally).
    pub ai_glass: bool,
    /// Anonymous per-install id, used by the relay for fair daily limits.
    pub device_id: String,

    // ---- modules & workspace ----
    /// Enabled tabs, in order.
    pub modules: Vec<String>,
    /// Every tab this settings file has heard of, so tabs added in an update get
    /// switched on once (next to their usual neighbour) without re-enabling ones
    /// you turned off.
    #[serde(default = "legacy_known")]
    pub modules_known: Vec<String>,
    pub weather_city: String,
    /// "C" | "F"
    pub weather_unit: String,
    pub clipboard_history: bool,

    // ---- system ----
    pub hud: bool,
    pub privacy_dots: bool,
    pub notifications: bool,
    pub dnd: bool,
    pub hide_in_fullscreen: bool,
    /// Show the island in Islander's own screen recordings (off = left out of the video).
    pub show_in_recordings: bool,
    pub auto_hide: bool,
    pub frame_rate: u32,
    /// Replace Windows' own volume flyout and notification banners with the island's.
    pub takeover: bool,
    /// Start Islander when you sign in to Windows.
    pub launch_at_login: bool,
    /// Which screen edge the island lives on: "top" | "bottom" | "left" | "right".
    pub dock: String,
    /// Where along that edge: "start" (left/top) | "center" | "end" (right/bottom).
    pub dock_along: String,
    /// The one-time "you can move the island" tip was shown.
    pub move_tip_shown: bool,
    /// Browsers already shown the one-time "get the extension" prompt ("chrome", "edge", "firefox"…).
    pub ext_tips: Vec<String>,
    /// Nearby sharing (LocalSend) in the Shelf: send to / receive from phones on this network.
    pub nearby_sharing: bool,
    /// The name other devices see ("" = this PC's name).
    pub nearby_name: String,
    /// Typeface: "inter" (bundled, default) | "system" (SF Pro if installed, else Segoe UI).
    pub font: String,
    /// Version of the AI model choice (bumped to move everyone to a new default once).
    /// Missing in older files → 0.
    #[serde(default)]
    pub ai_model_v: u32,
}

/// Target refresh rate for live visuals (waveform events, glass capture), from settings.
pub static FPS: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(60);

pub const ALL_MODULES: [&str; 10] = ["ai", "media", "controls", "today", "weather", "clock", "notes", "shelf", "clipboard", "stats"];

/// Tabs that existed before `modules_known` was tracked (older settings files).
fn legacy_known() -> Vec<String> {
    ["ai", "media", "controls", "today", "clock", "notes", "shelf", "clipboard", "stats"].iter().map(|s| s.to_string()).collect()
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            anim_style: "default".into(),
            anim_speed: 1.0,
            size_scale: 1.0,
            offset_x: 0.0,
            offset_y: 0.0,
            monitor: "primary".into(),
            expand_on_hover: true,
            pinned: false,
            theme: "black".into(),
            transparency: 0.0,
            hide_hotkey: "Ctrl+Alt+D".into(),
            idle_style: "notch".into(),
            ai_hotkey: "Ctrl+Alt+Space".into(),
            ai_api_key: String::new(),
            ai_model: "gemini-3.5-flash-lite".into(),
            ai_relay_url: String::new(),
            ai_glass: true,
            device_id: String::new(),
            modules: ALL_MODULES.iter().map(|s| s.to_string()).collect(),
            modules_known: ALL_MODULES.iter().map(|s| s.to_string()).collect(),
            weather_city: String::new(),
            weather_unit: "C".into(),
            clipboard_history: true,
            hud: true,
            privacy_dots: true,
            notifications: true,
            dnd: false,
            hide_in_fullscreen: true,
            show_in_recordings: true,
            auto_hide: false,
            frame_rate: 60,
            takeover: true,
            launch_at_login: true,
            dock: "top".into(),
            dock_along: "center".into(),
            move_tip_shown: false,
            ext_tips: Vec::new(),
            font: "inter".into(),
            nearby_sharing: true,
            nearby_name: String::new(),
            ai_model_v: 2,
        }
    }
}

impl Settings {
    fn sanitized(mut self) -> Self {
        if self.device_id.len() < 16 {
            self.device_id = new_device_id();
        }
        // Pin the "-latest" aliases and retired 2.x names to the previous-generation
        // models: the newest one behind the alias is often out of free quota.
        match self.ai_model.trim() {
            "" | "gemini-flash-lite-latest" | "gemini-2.5-flash-lite" | "gemini-2.0-flash-lite" => self.ai_model = "gemini-3.5-flash-lite".into(),
            "gemini-flash-latest" | "gemini-2.5-flash" | "gemini-2.0-flash" => self.ai_model = "gemini-3.6-flash".into(),
            _ => {}
        }
        if !["top", "bottom", "left", "right"].contains(&self.dock.as_str()) {
            self.dock = "top".into();
        }
        if !["inter", "system"].contains(&self.font.as_str()) {
            self.font = "inter".into();
        }
        if !["start", "center", "end"].contains(&self.dock_along.as_str()) {
            self.dock_along = "center".into();
        }
        // v2: Gemini 3.5 Flash-Lite with Google Search is the setup that works on the free
        // tier (3.6 Flash's search quota is often 0), so move everyone to it once.
        if self.ai_model_v < 2 {
            self.ai_model = "gemini-3.5-flash-lite".into();
            self.ai_model_v = 2;
        }
        self.anim_speed = self.anim_speed.clamp(0.25, 2.0);
        self.size_scale = self.size_scale.clamp(0.7, 1.6);
        self.offset_x = self.offset_x.clamp(-2000.0, 2000.0);
        self.offset_y = self.offset_y.clamp(-40.0, 600.0);
        self.transparency = self.transparency.clamp(0.0, 0.8);
        if !["default", "bouncy", "smooth", "snappy"].contains(&self.anim_style.as_str()) {
            self.anim_style = "default".into();
        }
        if !["notch", "dot", "pill"].contains(&self.idle_style.as_str()) {
            self.idle_style = "notch".into();
        }
        let mut seen = std::collections::HashSet::new();
        self.modules.retain(|m| ALL_MODULES.contains(&m.as_str()) && seen.insert(m.clone()));
        // New tabs from an update: add each after its usual neighbour, once.
        for (i, id) in ALL_MODULES.iter().enumerate() {
            if self.modules_known.iter().any(|k| k == id) {
                continue;
            }
            if !self.modules.iter().any(|m| m == id) {
                let after = ALL_MODULES[..i].iter().rev().find_map(|p| self.modules.iter().position(|m| m == p));
                self.modules.insert(after.map(|p| p + 1).unwrap_or(0), id.to_string());
            }
        }
        self.modules_known = ALL_MODULES.iter().map(|s| s.to_string()).collect();
        if self.modules.is_empty() {
            self.modules = vec!["ai".into(), "media".into()];
        }
        if self.weather_unit != "F" {
            self.weather_unit = "C".into();
        }
        self.frame_rate = self.frame_rate.clamp(30, 240);
        if !["black", "graphite", "midnight"].contains(&self.theme.as_str()) {
            self.theme = "black".into();
        }
        self
    }
}

/// Random, anonymous id (no personal data): 128 bits from the OS-seeded hasher + clock.
fn new_device_id() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let mut parts = [0u64; 2];
    for (i, p) in parts.iter_mut().enumerate() {
        let mut h = RandomState::new().build_hasher();
        h.write_u128(t);
        h.write_u32(std::process::id());
        h.write_usize(i);
        *p = h.finish();
    }
    format!("{:016x}{:016x}", parts[0], parts[1])
}

pub struct Store {
    path: Option<PathBuf>,
    inner: Mutex<Settings>,
}

impl Store {
    pub fn load(path: Option<PathBuf>) -> Self {
        let settings = path
            .as_ref()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str::<Settings>(&s).ok())
            .unwrap_or_default()
            .sanitized();
        let store = Self { path, inner: Mutex::new(settings) };
        let s = store.get();
        store.save(&s); // persists a newly generated device id
        store
    }

    pub fn get(&self) -> Settings {
        self.inner.lock().unwrap().clone()
    }

    /// Merge a partial JSON object into the settings, save, and return (old, new).
    pub fn update(&self, patch: Value) -> (Settings, Settings) {
        let mut guard = self.inner.lock().unwrap();
        let old = guard.clone();
        let mut merged = serde_json::to_value(&old).unwrap_or(Value::Null);
        if let (Value::Object(base), Value::Object(p)) = (&mut merged, patch) {
            for (k, v) in p {
                base.insert(k, v);
            }
        }
        let new = serde_json::from_value::<Settings>(merged).unwrap_or_else(|_| old.clone()).sanitized();
        *guard = new.clone();
        drop(guard);
        self.save(&new);
        (old, new)
    }

    pub fn reset(&self) -> (Settings, Settings) {
        let mut guard = self.inner.lock().unwrap();
        let old = guard.clone();
        *guard = Settings::default();
        let new = guard.clone();
        drop(guard);
        self.save(&new);
        (old, new)
    }

    fn save(&self, s: &Settings) {
        let Some(path) = &self.path else { return };
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(json) = serde_json::to_string_pretty(s) {
            // Write to a temp file and rename, so a crash never leaves a half-written file.
            let tmp = path.with_extension("json.tmp");
            if std::fs::write(&tmp, json).is_ok() {
                let _ = std::fs::rename(&tmp, path);
            }
        }
    }
}
