// Hide the console window in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod audio;
mod battery;
mod clipboard;
mod dragout;
mod ext;
mod glass;
mod hud;
mod media;
mod notify;
mod outputs;
mod privacy;
mod settings;
mod shelf;
mod sysmon;
mod system;
mod takeover;
#[cfg(windows)]
mod win;

use serde::Deserialize;
use serde_json::{json, Value};
use settings::{Settings, Store};
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::menu::{CheckMenuItemBuilder, MenuBuilder, MenuEvent, SubmenuBuilder};
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, Monitor, PhysicalPosition, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

/// Island window size in logical px at size scale 1.0. Big enough for the largest
/// expanded state plus the split bubble.
const WIN_W: f64 = 560.0;
const WIN_H: f64 = 480.0; // tall enough for the AI panel; everything outside the island is click-through
/// Extra px around the island that still counts as "on the island".
const HIT_MARGIN: f64 = 4.0;

/* ------------------------------------------------------------------ state */

#[derive(Clone, Copy, Debug, Default, Deserialize)]
struct Rect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

impl Rect {
    fn contains(&self, px: f64, py: f64, m: f64) -> bool {
        self.w > 0.0 && px >= self.x - m && px <= self.x + self.w + m && py >= self.y - m && py <= self.y + self.h + m
    }
}

#[derive(Default)]
struct HitRects {
    island: Rect,
    bubble: Option<Rect>,
}

struct AppState {
    hit: Mutex<HitRects>,
    store: Store,
    hidden: AtomicBool,
    /// Set while the user drags something on the island (e.g. the scrubber).
    hold: AtomicBool,
    /// Name+position of the monitor the island is on (for "follow mouse").
    monitor_key: Mutex<String>,
}

type St = Arc<AppState>;

/* --------------------------------------------------------------- commands */

/// The frontend reports where the island (and the split bubble) are, in CSS px
/// (already multiplied by the size scale).
#[tauri::command]
fn set_hit_rects(state: tauri::State<'_, St>, island: Rect, bubble: Option<Rect>) {
    let mut h = state.hit.lock().unwrap();
    h.island = island;
    h.bubble = bubble;
}

#[tauri::command]
async fn media_command(id: String, action: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || media::command(&id, &action))
        .await
        .map_err(|e| e.to_string())?
}

/// While held, the island stays open and clickable even if the cursor leaves it.
#[tauri::command]
fn set_hold(state: tauri::State<'_, St>, hold: bool) {
    state.hold.store(hold, Ordering::Relaxed);
}

/// Open the AI panel: show the island, let it take keyboard focus, tell the UI.
fn open_ai(app: &AppHandle, state: &St) {
    if state.hidden.load(Ordering::Relaxed) {
        set_island_hidden(app, state, false);
    }
    set_ai_focus(app, state, true);
    let _ = app.emit("ai://open", ());
}

fn set_ai_focus(app: &AppHandle, state: &St, focused: bool) {
    state.hold.store(focused, Ordering::Relaxed);
    if let Some(win) = app.get_webview_window("island") {
        #[cfg(windows)]
        win::set_activatable(&win, focused);
        if focused {
            let _ = win.set_ignore_cursor_events(false);
            #[cfg(windows)]
            win::bring_to_foreground(&win);
            let _ = win.set_focus();
        }
    }
}

/// The UI opened/closed the AI panel (e.g. Esc, click away, or the menu).
#[tauri::command]
fn ai_focus(app: AppHandle, state: tauri::State<'_, St>, focused: bool) {
    set_ai_focus(&app, &state, focused);
}

#[tauri::command]
fn open_ai_panel(app: AppHandle, state: tauri::State<'_, St>) {
    open_ai(&app, &state);
}

#[tauri::command]
fn glass_start(app: AppHandle, x: f64, y: f64, w: f64, h: f64) {
    glass::start(app, x, y, w, h);
}

#[tauri::command]
fn glass_update(x: f64, y: f64, w: f64, h: f64) {
    glass::update(x, y, w, h);
}

#[tauri::command]
fn glass_stop(app: AppHandle) {
    glass::stop(&app);
}

#[tauri::command]
async fn list_outputs() -> Result<Vec<outputs::OutputDevice>, String> {
    tauri::async_runtime::spawn_blocking(outputs::list).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn set_output(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || outputs::set_default(&id)).await.map_err(|e| e.to_string())?
}

/// Lets the UI write to this console window (AI request tracing etc.).
#[tauri::command]
fn ui_log(msg: String) {
    eprintln!("[ui] {msg}");
}

#[tauri::command]
fn media_refresh() {
    media::request_refresh();
}

#[tauri::command]
fn get_settings(state: tauri::State<'_, St>) -> Settings {
    state.store.get()
}

#[tauri::command]
fn update_settings(app: AppHandle, state: tauri::State<'_, St>, patch: Value) -> Settings {
    let (old, new) = state.store.update(patch);
    apply_settings(&app, &state, &old, &new);
    new
}

#[tauri::command]
fn reset_settings(app: AppHandle, state: tauri::State<'_, St>) -> Settings {
    let (old, new) = state.store.reset();
    apply_settings(&app, &state, &old, &new);
    new
}

#[tauri::command]
fn show_context_menu(app: AppHandle, state: tauri::State<'_, St>) -> Result<(), String> {
    let win = app.get_webview_window("island").ok_or("no island window")?;
    let menu = build_context_menu(&app, &win, &state.store.get()).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    win::bring_to_foreground(&win); // lets the menu close when you click elsewhere
    // Lock the island open while the menu is up (the menu blocks until it closes),
    // so moving the cursor onto the menu doesn't make the island collapse behind it.
    state.hold.store(true, Ordering::Relaxed);
    let r = win.popup_menu(&menu).map_err(|e| e.to_string());
    state.hold.store(false, Ordering::Relaxed);
    r
}

/// Must be `async`: on Windows, creating a window from a synchronous command blocks the
/// main thread (the new window stays black and the island can freeze).
#[tauri::command]
async fn open_settings(app: AppHandle) -> Result<(), String> {
    open_settings_window(&app).map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
struct MonitorInfo {
    index: usize,
    label: String,
    primary: bool,
}

#[tauri::command]
fn list_monitors(app: AppHandle) -> Vec<MonitorInfo> {
    let Some(win) = app.get_webview_window("island") else { return vec![] };
    let primary = win.primary_monitor().ok().flatten().map(|m| monitor_key(&m));
    win.available_monitors()
        .unwrap_or_default()
        .iter()
        .enumerate()
        .map(|(i, m)| MonitorInfo {
            index: i,
            label: format!("Display {} — {}×{}", i + 1, m.size().width, m.size().height),
            primary: Some(monitor_key(m)) == primary,
        })
        .collect()
}

#[tauri::command]
fn stats_watch(on: bool) {
    sysmon::watch(on);
}

#[tauri::command]
fn set_hidden(app: AppHandle, state: tauri::State<'_, St>, hidden: bool) {
    set_island_hidden(&app, &state, hidden);
}

/* ------------------------------------------------------------------- main */

fn main() {
    // If anything ever crashes, leave a note explaining why (next to settings.json).
    std::panic::set_hook(Box::new(|info| {
        let msg = format!("[{:?}] island crashed: {info}\n", std::time::SystemTime::now());
        eprintln!("{msg}");
        if let Some(dir) = std::env::var_os("APPDATA").map(|d| std::path::PathBuf::from(d).join("dev.island.desktop")) {
            let _ = std::fs::create_dir_all(&dir);
            use std::io::Write;
            if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("crash.log")) {
                let _ = f.write_all(msg.as_bytes());
            }
        }
    }));
    tauri::Builder::default()
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    let state = app.state::<St>();
                    let s = state.store.get();
                    let is = |hk: &str| Shortcut::from_str(hk).map(|k| k.id() == shortcut.id()).unwrap_or(false);
                    if is(&s.ai_hotkey) {
                        open_ai(app, &state);
                    } else if is(&s.hide_hotkey) {
                        let hidden = state.hidden.load(Ordering::Relaxed);
                        set_island_hidden(app, &state, !hidden);
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            set_hit_rects,
            media_command,
            media_refresh,
            set_hold,
            ui_log,
            list_outputs,
            set_output,
            ai_focus,
            open_ai_panel,
            glass_start,
            glass_update,
            glass_stop,
            get_settings,
            update_settings,
            reset_settings,
            show_context_menu,
            open_settings,
            set_hidden,
            list_monitors,
            stats_watch,
            system::sys_state,
            system::sys_mute_toggle,
            system::sys_theme_toggle,
            system::sys_lock,
            system::sys_sleep,
            system::sys_screenshot,
            system::launch,
            system::file_icon,
            system::notify_open,
            system::reveal_path,
            dragout::drag_out,
            shelf::shelf_list,
            shelf::shelf_elevated,
            shelf::shelf_add,
            shelf::shelf_remove,
            shelf::shelf_clear,
            shelf::shelf_open,
            shelf::shelf_reveal,
            shelf::shelf_convert,
            clipboard::clip_list,
            clipboard::clip_copy,
            clipboard::clip_pin,
            clipboard::clip_delete,
            clipboard::clip_clear,
        ])
        .on_menu_event(handle_menu_event)
        .setup(|app| {
            #[cfg(windows)]
            win::close_other_instances();
            if shelf::shelf_elevated() {
                eprintln!("NOTE: Islander is running as administrator. Windows blocks dragging files from Explorer onto admin apps, so the Shelf can't receive drops. Start it without admin rights.");
            }
            let path = app.path().app_config_dir().ok().map(|d| d.join("settings.json"));
            let state: St = Arc::new(AppState {
                hit: Mutex::new(HitRects {
                    island: Rect { x: (WIN_W - 126.0) / 2.0, y: 8.0, w: 126.0, h: 37.0 },
                    bubble: None,
                }),
                store: Store::load(path),
                hidden: AtomicBool::new(false),
                hold: AtomicBool::new(false),
                monitor_key: Mutex::new(String::new()),
            });
            app.manage(state.clone());

            let win = app.get_webview_window("island").expect("island window missing");
            let s = state.store.get();
            settings::FPS.store(s.frame_rate, Ordering::Relaxed);
            place_island(&win, &state, &s, None)?;
            #[cfg(windows)]
            win::apply_overlay_styles(&win);
            // Everything except the island itself is click-through.
            win.set_ignore_cursor_events(true)?;
            win.show()?;

            register_hotkey(app.handle(), "", &s.hide_hotkey);
            register_hotkey(app.handle(), "", &s.ai_hotkey);
            spawn_hit_tester(app.handle().clone(), state.clone());
            media::spawn(app.handle().clone());
            audio::spawn(app.handle().clone());
            audio::meters::spawn(media::mark_dirty);
            takeover::KEYS.store(s.hud && s.takeover, Ordering::Relaxed);
            takeover::install_exit_guard();
            takeover::spawn_keys();
            takeover::set_banners(app.handle(), s.notifications && s.takeover);
            ext::set_app(app.handle().clone());
            ext::spawn(media::mark_dirty);
            sysmon::spawn(app.handle().clone());
            privacy::spawn(app.handle().clone());
            hud::spawn(app.handle().clone());
            clipboard::spawn(app.handle().clone());
            notify::spawn(app.handle().clone());
            battery::spawn(app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the island")
        .run(|_app, event| {
            // Quitting: give Windows its own popups back.
            if let tauri::RunEvent::Exit = event {
                takeover::restore_on_exit();
            }
        });
}

/* -------------------------------------------------------------- settings */

fn apply_settings(app: &AppHandle, state: &St, old: &Settings, new: &Settings) {
    settings::FPS.store(new.frame_rate, Ordering::Relaxed);
    takeover::KEYS.store(new.hud && new.takeover, Ordering::Relaxed);
    let banners = |s: &Settings| s.notifications && s.takeover;
    if banners(old) != banners(new) {
        takeover::set_banners(app, banners(new));
    }
    if let Some(win) = app.get_webview_window("island") {
        let moved = old.size_scale != new.size_scale
            || old.offset_x != new.offset_x
            || old.offset_y != new.offset_y
            || old.monitor != new.monitor;
        if moved {
            let _ = place_island(&win, state, new, None);
        }
    }
    if old.hide_hotkey != new.hide_hotkey {
        register_hotkey(app, &old.hide_hotkey, &new.hide_hotkey);
    }
    if old.ai_hotkey != new.ai_hotkey {
        register_hotkey(app, &old.ai_hotkey, &new.ai_hotkey);
    }
    let _ = app.emit("settings://changed", new);
}

fn register_hotkey(app: &AppHandle, old: &str, new: &str) {
    let gs = app.global_shortcut();
    if let Ok(sc) = Shortcut::from_str(old) {
        let _ = gs.unregister(sc);
    }
    if new.trim().is_empty() {
        return;
    }
    match Shortcut::from_str(new) {
        Ok(sc) => {
            if gs.register(sc).is_err() {
                // Usually the previous instance hasn't released it yet (dev restarts): retry.
                let app = app.clone();
                let new = new.to_string();
                std::thread::spawn(move || {
                    for _ in 0..20 {
                        std::thread::sleep(Duration::from_millis(500));
                        if app.global_shortcut().register(sc).is_ok() {
                            return;
                        }
                    }
                    eprintln!("could not register hotkey {new} (another app is using it)");
                });
            }
        }
        Err(e) => eprintln!("invalid hotkey {new}: {e}"),
    }
}

fn set_island_hidden(app: &AppHandle, state: &St, hidden: bool) {
    state.hidden.store(hidden, Ordering::Relaxed);
    if let Some(win) = app.get_webview_window("island") {
        if hidden {
            let _ = app.emit("island://hover", false);
            let _ = win.hide();
        } else {
            let _ = win.set_ignore_cursor_events(true);
            let _ = win.show();
        }
    }
    let _ = app.emit("island://hidden", hidden);
}

/* ------------------------------------------------------------- placement */

fn monitor_key(m: &Monitor) -> String {
    format!("{}@{},{}", m.name().cloned().unwrap_or_default(), m.position().x, m.position().y)
}

/// Which monitor the settings ask for. `follow` = the one under the cursor (passed in).
fn pick_monitor(win: &WebviewWindow, s: &Settings, follow: Option<Monitor>) -> Option<Monitor> {
    match s.monitor.as_str() {
        "follow" => follow.or_else(|| {
            let c = win.cursor_position().ok()?;
            win.monitor_from_point(c.x, c.y).ok().flatten()
        }),
        "primary" => None,
        idx => idx
            .parse::<usize>()
            .ok()
            .and_then(|i| win.available_monitors().ok()?.into_iter().nth(i)),
    }
    .or_else(|| win.primary_monitor().ok().flatten())
}

/// Size the window for the current scale and put it at the top-centre of the chosen monitor.
fn place_island(win: &WebviewWindow, state: &St, s: &Settings, follow: Option<Monitor>) -> tauri::Result<()> {
    let Some(mon) = pick_monitor(win, s, follow) else { return Ok(()) };
    let scale = mon.scale_factor();
    let (w, h) = (WIN_W * s.size_scale, WIN_H * s.size_scale);
    win.set_size(LogicalSize::new(w, h))?;
    let pos = mon.position();
    let size = mon.size();
    let w_phys = (w * scale).round() as i32;
    let x = pos.x + (size.width as i32 - w_phys) / 2 + (s.offset_x * scale).round() as i32;
    let y = pos.y + (s.offset_y * scale).round() as i32;
    win.set_position(PhysicalPosition::new(x, y))?;
    *state.monitor_key.lock().unwrap() = monitor_key(&mon);
    Ok(())
}

/* ------------------------------------------------------------ hit testing */

/// A transparent window would normally swallow every click in its rectangle.
/// This loop watches the cursor and only makes the window clickable while the
/// cursor is over the island or the bubble. It also drives hover-to-expand
/// (the webview can't see the mouse while click-through) and "follow mouse".
fn spawn_hit_tester(app: AppHandle, state: St) {
    std::thread::spawn(move || {
        let mut interactive = false;
        let mut hovering = false;
        let mut tick: u32 = 0;
        // Hidden because a fullscreen app is in front (not the user's own "hide").
        let mut fs_hidden = false;
        loop {
            std::thread::sleep(Duration::from_millis(16));
            tick = tick.wrapping_add(1);

            #[cfg(windows)]
            if tick % 30 == 0 && !state.hidden.load(Ordering::Relaxed) {
                if let Some(win) = app.get_webview_window("island") {
                    let want = state.store.get().hide_in_fullscreen && win::fullscreen_in_front(&win);
                    if want != fs_hidden {
                        fs_hidden = want;
                        eprintln!("[island] {}", if want { "hiding: a fullscreen app is in front" } else { "back: fullscreen app closed" });
                        if want {
                            let _ = app.emit("island://hover", false);
                            let _ = win.hide();
                        } else {
                            let _ = win.show();
                        }
                    }
                }
            }
            if fs_hidden {
                interactive = false;
                hovering = false;
                continue;
            }
            if state.hidden.load(Ordering::Relaxed) {
                interactive = false;
                hovering = false;
                std::thread::sleep(Duration::from_millis(100));
                continue;
            }
            let Some(win) = app.get_webview_window("island") else { continue };
            let (Ok(cursor), Ok(origin), Ok(scale)) = (win.cursor_position(), win.outer_position(), win.scale_factor()) else {
                continue;
            };

            // Follow mouse: hop to the monitor under the cursor (twice a second, never mid-hover).
            if tick % 30 == 0 && !interactive {
                let s = state.store.get();
                if s.monitor == "follow" {
                    if let Ok(Some(m)) = win.monitor_from_point(cursor.x, cursor.y) {
                        if *state.monitor_key.lock().unwrap() != monitor_key(&m) {
                            let _ = place_island(&win, &state, &s, Some(m));
                            continue;
                        }
                    }
                }
            }

            let lx = (cursor.x - origin.x as f64) / scale;
            let ly = (cursor.y - origin.y as f64) / scale;
            let held = state.hold.load(Ordering::Relaxed);
            let (on_island, on_bubble) = {
                let h = state.hit.lock().unwrap();
                (
                    held || h.island.contains(lx, ly, HIT_MARGIN),
                    h.bubble.map_or(false, |b| b.contains(lx, ly, 2.0)),
                )
            };

            let now_interactive = on_island || on_bubble;
            if now_interactive != interactive {
                interactive = now_interactive;
                let _ = win.set_ignore_cursor_events(!interactive);
            }
            // Only the island itself expands on hover; the bubble is a click target.
            if on_island != hovering {
                hovering = on_island;
                let _ = app.emit("island://hover", hovering);
            }
        }
    });
}

/* ----------------------------------------------------------- context menu */

fn build_context_menu(app: &AppHandle, win: &WebviewWindow, s: &Settings) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    let check = |id: &str, text: &str, on: bool| CheckMenuItemBuilder::with_id(id, text).checked(on).build(app);

    let mut anim = SubmenuBuilder::new(app, "Animation");
    for (id, label) in [("default", "Default"), ("bouncy", "Bouncy"), ("smooth", "Smooth"), ("snappy", "Snappy")] {
        anim = anim.item(&check(&format!("anim:{id}"), label, s.anim_style == id)?);
    }

    let mut size = SubmenuBuilder::new(app, "Size");
    for (v, label) in [(0.85, "Small"), (1.0, "Default"), (1.15, "Large"), (1.3, "Extra large")] {
        size = size.item(&check(&format!("size:{v}"), label, (s.size_scale - v).abs() < 0.01)?);
    }

    let idle = SubmenuBuilder::new(app, "When idle")
        .item(&check("idle:notch", "Notch", s.idle_style == "notch")?)
        .item(&check("idle:dot", "Dot", s.idle_style == "dot")?)
        .item(&check("idle:pill", "Pill", s.idle_style == "pill")?);

    let mut theme = SubmenuBuilder::new(app, "Theme");
    for (id, label) in [("black", "Black"), ("graphite", "Graphite"), ("midnight", "Midnight")] {
        theme = theme.item(&check(&format!("theme:{id}"), label, s.theme == id)?);
    }

    let mut alpha = SubmenuBuilder::new(app, "Transparency");
    for (v, label) in [(0.0, "Off"), (0.15, "Low"), (0.3, "Medium"), (0.5, "High")] {
        alpha = alpha.item(&check(&format!("alpha:{v}"), label, (s.transparency - v).abs() < 0.01)?);
    }

    let mut display = SubmenuBuilder::new(app, "Display");
    display = display
        .item(&check("mon:primary", "Primary display", s.monitor == "primary")?)
        .item(&check("mon:follow", "Follow mouse", s.monitor == "follow")?)
        .separator();
    for (i, m) in win.available_monitors().unwrap_or_default().iter().enumerate() {
        let label = format!("Display {} ({}×{})", i + 1, m.size().width, m.size().height);
        display = display.item(&check(&format!("mon:{i}"), &label, s.monitor == i.to_string())?);
    }

    let hide_label = if s.hide_hotkey.is_empty() {
        "Hide island".to_string()
    } else {
        format!("Hide island\t{}", s.hide_hotkey)
    };

    MenuBuilder::new(app)
        .item(&check("pin", "Pin open", s.pinned)?)
        .item(&check("hover", "Expand on hover", s.expand_on_hover)?)
        .separator()
        .item(&anim.build()?)
        .item(&size.build()?)
        .item(&idle.build()?)
        .item(&theme.build()?)
        .item(&alpha.build()?)
        .item(&display.build()?)
        .separator()
        .text("ai", if s.ai_hotkey.is_empty() { "Search or Ask".to_string() } else { format!("Search or Ask\t{}", s.ai_hotkey) })
        .text("hide", hide_label)
        .text("settings", "Settings…")
        .separator()
        .text("quit", "Quit Islander")
        .build()
}

fn handle_menu_event(app: &AppHandle, event: MenuEvent) {
    let state = app.state::<St>();
    let id = event.id().as_ref().to_string();
    let s = state.store.get();
    let patch = match id.split_once(':') {
        Some(("anim", v)) => json!({ "animStyle": v }),
        Some(("size", v)) => json!({ "sizeScale": v.parse::<f64>().unwrap_or(1.0) }),
        Some(("theme", v)) => json!({ "theme": v }),
        Some(("idle", v)) => json!({ "idleStyle": v }),
        Some(("alpha", v)) => json!({ "transparency": v.parse::<f64>().unwrap_or(0.0) }),
        Some(("mon", v)) => json!({ "monitor": v }),
        _ => match id.as_str() {
            "pin" => json!({ "pinned": !s.pinned }),
            "hover" => json!({ "expandOnHover": !s.expand_on_hover }),
            "hide" => {
                set_island_hidden(app, &state, true);
                return;
            }
            "ai" => {
                open_ai(app, &state);
                return;
            }
            "settings" => {
                let _ = open_settings_window(app);
                return;
            }
            "quit" => {
                app.exit(0);
                return;
            }
            _ => return,
        },
    };
    let (old, new) = state.store.update(patch);
    apply_settings(app, &state, &old, &new);
}

/* -------------------------------------------------------- settings window */

fn open_settings_window(app: &AppHandle) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window("settings") {
        w.unminimize()?;
        w.show()?;
        w.set_focus()?;
        return Ok(());
    }
    // Same frontend; it renders the settings page because the window label is "settings".
    WebviewWindowBuilder::new(app, "settings", WebviewUrl::default())
        .title("Islander Settings")
        .inner_size(480.0, 700.0)
        .min_inner_size(420.0, 520.0)
        .background_color(tauri::window::Color(0, 0, 0, 255))
        .center()
        .build()?;
    Ok(())
}
