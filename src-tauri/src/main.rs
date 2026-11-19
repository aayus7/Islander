// Hide the console window in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod audio;
mod battery;
mod clipboard;
mod dlmgr;
mod posters;
mod updater;
mod dragout;
mod dropin;
mod ext;
mod glass;
mod hud;
mod media;
mod mic;
mod screenrec;
mod localsend;
mod localsend_core;
mod speech;
mod notify;
mod outputs;
mod power;
mod privacy;
mod radios;
mod settings;
mod shelf;
mod startup;
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
use std::time::{Duration, Instant};
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
/// Extra slack while the island is open (see the hit tester).
const HIT_MARGIN_OPEN: f64 = 12.0;

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

/// Is the cursor over the island right now? (The island asks when it loads: the hover
/// may have started before it was listening, e.g. right after startup.)
static HOVERING: AtomicBool = AtomicBool::new(false);
#[tauri::command]
fn hover_state() -> bool {
    HOVERING.load(Ordering::Relaxed)
}

/// While held, the island stays open and clickable even if the cursor leaves it.
#[tauri::command]
fn set_hold(state: tauri::State<'_, St>, hold: bool) {
    state.hold.store(hold, Ordering::Relaxed);
}

/// Open the AI panel: show the island, let it take keyboard focus, tell the UI.
fn open_ai(app: &AppHandle, state: &St) {
    if state.hidden.load(Ordering::Relaxed) {
        set_island_hidden(app, state, false, "Search or Ask shortcut");
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
    log_line(msg);
}

/// Log a line (stderr; development builds also append it to island-debug.log).
pub(crate) fn log_line(msg: String) {
    eprintln!("[ui] {msg}");
    // Development builds also keep a log file in the project folder, so problems
    // can be looked into after the fact.
    #[cfg(debug_assertions)]
    {
        use std::io::Write;
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("island-debug.log");
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
            let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
            let _ = writeln!(f, "{t} {msg}");
        }
    }
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
    set_island_hidden(&app, &state, hidden, "settings");
}

/* ------------------------------------------------------------------- main */

fn main() {
    // Uninstaller / repair: give Windows back its own notification banners, then quit.
    if std::env::args().any(|a| a == "--restore-windows") {
        takeover::restore_from_backup_file();
        return;
    }
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
    let builder = tauri::Builder::default();
    // Release: one Islander at a time. Opening it again (Start menu, desktop shortcut)
    // brings up Settings in the copy that's already running, like any desktop app, and
    // brings the island back if it was hidden (there's no tray icon to do that from).
    #[cfg(not(debug_assertions))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        let state = app.state::<St>();
        if state.hidden.load(Ordering::Relaxed) {
            set_island_hidden(app, &state, false, "Islander opened again");
        }
        let _ = open_settings_window(app);
    }));
    builder
        .plugin(tauri_plugin_updater::Builder::new().build())
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
                        set_island_hidden(app, &state, !hidden, "hide shortcut");
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            localsend::localsend_peers,
            localsend::localsend_scan,
            localsend::localsend_send,
            localsend::localsend_respond,
            localsend::localsend_cancel,
            localsend::localsend_info,
            localsend::localsend_allow_firewall,
            screenrec::rec_start,
            screenrec::rec_status,
            screenrec::rec_pause,
            screenrec::rec_resume,
            screenrec::rec_stop,
            mic::mic_start,
            mic::mic_stop,
            mic::mic_cancel,
            speech::speech_start,
            speech::speech_stop,
            speech::speech_cancel,
            dropin::drop_attach,
            startup::open_extension_folder,
            power::power_status,
            power::brightness_get,
            power::brightness_set,
            power::volume_get,
            power::volume_set,
            radios::wifi_state,
            radios::wifi_set,
            radios::wifi_connect,
            radios::wifi_disconnect,
            radios::bt_state,
            radios::bt_set,
            radios::bt_connect,
            radios::airplane_state,
            radios::airplane_set,
            set_hit_rects,
            media_command,
            media_refresh,
            set_hold,
            hover_state,
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
            dlmgr::download_cancel,
            posters::movie_poster,
            island_move_start,
            island_move_place,
            island_move_anchor,
            updater::update_check,
            updater::update_status,
            updater::update_install,
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
            // Development: a restart that didn't shut the old copy down gets replaced.
            #[cfg(all(windows, debug_assertions))]
            win::close_other_instances();
            ui_log(format!("startup: elevated={} exe={:?}", shelf::shelf_elevated(), std::env::current_exe().ok()));
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
            // Keep the login entry pointing at this copy (it moves on reinstall/update).
            startup::set(s.launch_at_login);
            place_island(&win, &state, &s, None)?;
            #[cfg(windows)]
            win::apply_overlay_styles(&win);
            #[cfg(all(windows, debug_assertions))]
            {
                let w2 = win.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(6));
                    ui_log(format!("drop probe: {}", win::probe_drop_targets(&w2)));
                });
            }
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
            dlmgr::spawn();
            updater::spawn(app.handle().clone());
            ext::spawn(media::mark_dirty);
            sysmon::spawn(app.handle().clone());
            privacy::spawn(app.handle().clone());
            hud::spawn(app.handle().clone());
            clipboard::spawn(app.handle().clone());
            notify::spawn(app.handle().clone());
            battery::spawn(app.handle().clone());
            power::spawn(app.handle().clone());
            radios::spawn(app.handle().clone());
            localsend::spawn(app.handle().clone(), s.nearby_sharing, s.nearby_name.clone());
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
    #[cfg(windows)]
    if (old.hud && old.takeover) && !(new.hud && new.takeover) {
        takeover::restore_osd();
    }
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
    if old.show_in_recordings != new.show_in_recordings {
        screenrec::island_in_recording(app, new.show_in_recordings);
    }
    if old.launch_at_login != new.launch_at_login {
        startup::set(new.launch_at_login);
    }
    if old.nearby_sharing != new.nearby_sharing || old.nearby_name != new.nearby_name {
        localsend::configure(new.nearby_sharing, &new.nearby_name);
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

fn set_island_hidden(app: &AppHandle, state: &St, hidden: bool, why: &str) {
    let was = state.hidden.swap(hidden, Ordering::Relaxed);
    if was != hidden {
        log_line(format!("island {} ({why})", if hidden { "hidden" } else { "shown" }));
    }
    if let Some(win) = app.get_webview_window("island") {
        if hidden {
            HOVERING.store(false, Ordering::Relaxed);
            let _ = app.emit("island://hover", false);
            let _ = win.set_ignore_cursor_events(true);
            if was {
                let _ = win.hide();
            } else {
                // Say it before going: a hidden island leaves nothing on screen, so without this
                // a stray shortcut press looks like the app vanished. The island shows how to
                // bring it back, then parks itself (unless it was brought back meanwhile).
                let hotkey = state.store.get().hide_hotkey;
                let _ = app.emit("island://hiding", hotkey);
                let app = app.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(HIDE_NOTICE_MS));
                    let state = app.state::<St>();
                    if state.hidden.load(Ordering::Relaxed) {
                        if let Some(win) = app.get_webview_window("island") {
                            let _ = win.hide();
                        }
                    }
                });
            }
        } else {
            let _ = win.set_ignore_cursor_events(true);
            let _ = win.show();
        }
    }
    let _ = app.emit("island://hidden", hidden);
}

/// How long the island shows "hidden — press … to bring it back" before it goes.
const HIDE_NOTICE_MS: u64 = 2600;

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
    let _ = scale;
    let pos = dock_position(&mon, s);
    win.set_position(pos)?;
    log_line(format!(
        "place: dock {} {} on {:?} ({}x{} at {},{}; setting {:?}, offset {},{}) -> window at {},{}",
        s.dock, s.dock_along, mon.name(), mon.size().width, mon.size().height, mon.position().x, mon.position().y, s.monitor, s.offset_x, s.offset_y, pos.x, pos.y
    ));
    *state.monitor_key.lock().unwrap() = monitor_key(&mon);
    Ok(())
}

/// Where the island window goes for its dock: flush against that screen edge (the island
/// sits against the matching edge of its window), at the start, centre or end of it.
/// The top edge uses the whole display; the others stay clear of the taskbar.
fn dock_position(mon: &Monitor, s: &Settings) -> PhysicalPosition<i32> {
    let scale = mon.scale_factor();
    let w = (WIN_W * s.size_scale * scale).round() as i32;
    let h = (WIN_H * s.size_scale * scale).round() as i32;
    let (mx, my) = (mon.position().x, mon.position().y);
    let mw = mon.size().width as i32;
    let wa = mon.work_area();
    let (wx, wy, ww, wh) = (wa.position.x, wa.position.y, wa.size.width as i32, wa.size.height as i32);
    let along = |lo: i32, len: i32, size: i32| match s.dock_along.as_str() {
        "start" => lo,
        "end" => lo + len - size,
        _ => lo + (len - size) / 2,
    };
    match s.dock.as_str() {
        "bottom" => PhysicalPosition::new(along(wx, ww, w), wy + wh - h),
        "left" => PhysicalPosition::new(wx, along(wy, wh, h)),
        "right" => PhysicalPosition::new(wx + ww - w, along(wy, wh, h)),
        _ => {
            let nudge = if s.dock_along == "center" { (s.offset_x * scale).round() as i32 } else { 0 };
            PhysicalPosition::new(along(mx, mw, w) + nudge, my + (s.offset_y * scale).round() as i32)
        }
    }
}

/* ------------------------------------------------------------ moving the island */
//
// Press and hold the island (or right-click → Move Island…): it lifts and follows the
// mouse, glowing drop zones appear along every screen edge, and letting go docks it to
// the nearest one — top, bottom, left or right, at the start, middle or end.

static MOVING: AtomicBool = AtomicBool::new(false);
/// Where the island's centre is inside its window (logical px), so it stays under the cursor.
static ANCHOR: std::sync::Mutex<(f64, f64)> = std::sync::Mutex::new((280.0, 26.0));

#[tauri::command]
fn island_move_anchor(x: f64, y: f64) {
    *ANCHOR.lock().unwrap() = (x, y);
}

/// `click`: from the menu — follow the mouse until the next click. Otherwise (press and
/// hold) until the button is released.
/// Set when the drop-zone layer (or the island) is clicked while placing by click. A quick
/// tap — a touchpad tap-to-click especially — can come and go between two polls of the
/// mouse button, so the click itself tells us.
static PLACE_NOW: AtomicBool = AtomicBool::new(false);
#[tauri::command]
fn island_move_place() {
    PLACE_NOW.store(true, Ordering::SeqCst);
}

#[tauri::command]
fn island_move_start(app: AppHandle, click: bool) {
    start_move(&app, click);
}

fn start_move(app: &AppHandle, click: bool) {
    if MOVING.swap(true, Ordering::SeqCst) {
        return;
    }
    let _ = app.emit("move://begin", ());
    let app = app.clone();
    std::thread::spawn(move || {
        #[cfg(windows)]
        run_move(&app, click);
        #[cfg(not(windows))]
        let _ = click;
        MOVING.store(false, Ordering::SeqCst);
        let _ = app.emit("move://end", ());
    });
}

/// The nearest screen edge to the cursor, and which third of it.
fn zone_at(mon: &Monitor, x: i32, y: i32) -> (&'static str, &'static str) {
    let (mx, my) = (mon.position().x, mon.position().y);
    let (mw, mh) = (mon.size().width as i32, mon.size().height as i32);
    let edges = [("top", y - my), ("bottom", my + mh - y), ("left", x - mx), ("right", mx + mw - x)];
    let dock = edges.iter().min_by_key(|e| e.1).map(|e| e.0).unwrap_or("top");
    let t = if dock == "top" || dock == "bottom" { (x - mx) as f64 / mw as f64 } else { (y - my) as f64 / mh as f64 };
    let along = if t < 1.0 / 3.0 {
        "start"
    } else if t > 2.0 / 3.0 {
        "end"
    } else {
        "center"
    };
    (dock, along)
}

/// The full-screen layer that shows the drop zones while moving (made on first use).
fn zones_window(app: &AppHandle) -> Option<WebviewWindow> {
    if let Some(w) = app.get_webview_window("zones") {
        return Some(w);
    }
    let w = WebviewWindowBuilder::new(app, "zones", WebviewUrl::default())
        .title("Islander zones")
        .decorations(false)
        .transparent(true)
        .background_color(tauri::window::Color(0, 0, 0, 0))
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .focusable(false)
        .resizable(false)
        .shadow(false)
        .visible(false)
        .additional_browser_args(BROWSER_ARGS)
        .build()
        .ok()?;
    let _ = w.set_ignore_cursor_events(true);
    Some(w)
}

#[cfg(windows)]
fn run_move(app: &AppHandle, click: bool) {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_ESCAPE, VK_LBUTTON};
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
    let Some(win) = app.get_webview_window("island") else { return };
    let state = app.state::<St>();
    let ss = state.store.get().size_scale;
    let pressed = |vk: windows::Win32::UI::Input::KeyboardAndMouse::VIRTUAL_KEY| unsafe { (GetAsyncKeyState(vk.0 as i32) as u16) & 0x8000 != 0 };
    // The drop-zone layer is made in the background the first time, so the island
    // starts following the mouse at once.
    if app.get_webview_window("zones").is_none() {
        let a = app.clone();
        std::thread::spawn(move || {
            let _ = zones_window(&a);
        });
    }
    let mut zones: Option<WebviewWindow> = None;
    let mut zones_on: Option<String> = None; // display the zones layer is showing on
    let mut last: Option<(&'static str, &'static str, Monitor)> = None;
    let mut seen_down = !click;
    let mut cancelled = false;
    // The island keeps the spot inside its window where it was picked up (ANCHOR, set by
    // the frontend); the window trails the cursor with a little weight.
    let anchor = || *ANCHOR.lock().unwrap();
    let mut pos = win.outer_position().map(|p| (p.x as f64, p.y as f64)).unwrap_or((0.0, 0.0));
    let mut scale = win.scale_factor().unwrap_or(1.0);
    let mut prev = Instant::now();
    let t0 = prev;
    // Forget the click that started this (choosing Move Island…), so only a new one places it.
    unsafe {
        let _ = GetAsyncKeyState(VK_LBUTTON.0 as i32);
    }
    PLACE_NOW.store(false, Ordering::SeqCst);
    loop {
        std::thread::sleep(Duration::from_millis(6));
        let dt = prev.elapsed().as_secs_f64().clamp(0.001, 0.05);
        prev = Instant::now();
        if pressed(VK_ESCAPE) || t0.elapsed() > Duration::from_secs(90) {
            cancelled = true;
            break;
        }
        let down = pressed(VK_LBUTTON);
        // Bit 0: pressed since the last check, so a click quicker than our 6 ms poll still counts.
        let tapped = unsafe { GetAsyncKeyState(VK_LBUTTON.0 as i32) as u16 & 1 != 0 };
        if click {
            if PLACE_NOW.swap(false, Ordering::SeqCst) {
                break;
            }
            if down || tapped {
                seen_down = true;
            }
            if !down && seen_down {
                break;
            }
        } else if !down {
            break;
        }
        let mut p = POINT::default();
        unsafe {
            let _ = GetCursorPos(&mut p);
        }
        let Some(mon) = win.monitor_from_point(p.x as f64, p.y as f64).ok().flatten() else { continue };
        scale = mon.scale_factor();
        let (cx, cy) = anchor();
        let target = (p.x as f64 - cx * scale, p.y as f64 - cy * scale);
        let k = 1.0 - (-dt / 0.04).exp();
        pos.0 += (target.0 - pos.0) * k;
        pos.1 += (target.1 - pos.1) * k;
        let _ = win.set_position(PhysicalPosition::new(pos.0.round() as i32, pos.1.round() as i32));
        // Drop zones on the display under the cursor.
        if zones.is_none() {
            zones = app.get_webview_window("zones");
        }
        let key = monitor_key(&mon);
        if let Some(z) = &zones {
            if zones_on.as_deref() != Some(key.as_str()) {
                let _ = z.set_position(*mon.position());
                let _ = z.set_size(*mon.size());
                // Placing by click (Move Island… in the menu or Settings): the layer catches that
                // click, so it doesn't also click whatever app is under the cursor.
                let _ = z.set_ignore_cursor_events(!click);
                let _ = z.show();
                // Keep the island above its own drop zones.
                win::stack_above(&win, Some(z));
                zones_on = Some(key);
                let _ = app.emit("move://begin", ());
            }
        }
        let (dock, along) = zone_at(&mon, p.x, p.y);
        if last.as_ref().map(|l| (l.0, l.1)) != Some((dock, along)) {
            let _ = app.emit("move://zone", json!({ "dock": dock, "along": along }));
        }
        last = Some((dock, along, mon));
    }
    if let Some(z) = &zones {
        let _ = z.hide();
        let _ = z.set_ignore_cursor_events(true);
    }
    // Where the window goes: the chosen spot, or back where it was (Esc).
    let (old, new, to) = match last.filter(|_| !cancelled) {
        Some((dock, along, mon)) => {
            let old_s = state.store.get();
            let mut patch = json!({ "dock": dock, "dockAlong": along, "offsetX": 0.0, "offsetY": 0.0, "moveTipShown": true });
            if old_s.monitor != "follow" {
                let key = monitor_key(&mon);
                let primary = win.primary_monitor().ok().flatten().map(|m| monitor_key(&m));
                patch["monitor"] = json!(if primary.as_deref() == Some(key.as_str()) {
                    "primary".to_string()
                } else {
                    win.available_monitors().unwrap_or_default().iter().position(|m| monitor_key(m) == key).map(|i| i.to_string()).unwrap_or_else(|| "primary".into())
                });
            }
            let (old, new) = state.store.update(patch);
            let to = dock_position(&mon, &new);
            (Some(old), new, to)
        }
        None => {
            let s = state.store.get();
            let Some(mon) = pick_monitor(&win, &s, None) else { return };
            let to = dock_position(&mon, &s);
            (None, s, to)
        }
    };
    // The window jumps to its new place; the island inside starts where it is on screen
    // right now and springs into its spot (the frontend animates that from this offset).
    let (cx, cy) = anchor();
    let rel_x = (pos.0 + cx * scale - to.x as f64) / scale / ss;
    let rel_y = (pos.1 + cy * scale - to.y as f64) / scale / ss;
    let _ = app.emit("move://landing", json!({ "x": rel_x, "y": rel_y }));
    std::thread::sleep(Duration::from_millis(12));
    let _ = win.set_position(to);
    match old {
        Some(old) => apply_settings(app, &state, &old, &new),
        None => {
            let _ = place_island(&win, &state, &new, None);
        }
    }
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
        let mut last_where: Option<(i32, i32, bool)> = None;
        // Hidden because a fullscreen app is in front (not the user's own "hide").
        let mut fs_hidden = false;
        // A change must be seen twice in a row (~1 s) before acting, so brief focus
        // changes (a toast, a menu, the "Press Esc" bubble) don't make the island blink.
        let mut fs_pending = 0u8;
        loop {
            std::thread::sleep(Duration::from_millis(16));
            tick = tick.wrapping_add(1);

            #[cfg(windows)]
            if tick % 30 == 0 && !state.hidden.load(Ordering::Relaxed) && !MOVING.load(Ordering::Relaxed) {
                if let Some(win) = app.get_webview_window("island") {
                    let want = state.store.get().hide_in_fullscreen && win::fullscreen_in_front(&win);
                    fs_pending = if want != fs_hidden { fs_pending + 1 } else { 0 };
                    if fs_pending >= 2 {
                        fs_pending = 0;
                        fs_hidden = want;
                        eprintln!("[island] {} [{}]", if want { "hiding: a fullscreen app is in front" } else { "back: fullscreen app closed" }, win::fullscreen_why());
                        if want {
                            HOVERING.store(false, Ordering::Relaxed);
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
                HOVERING.store(false, Ordering::Relaxed);
                continue;
            }
            if state.hidden.load(Ordering::Relaxed) {
                interactive = false;
                hovering = false;
                HOVERING.store(false, Ordering::Relaxed);
                std::thread::sleep(Duration::from_millis(100));
                continue;
            }
            let Some(win) = app.get_webview_window("island") else { continue };
            let (Ok(cursor), Ok(origin), Ok(scale)) = (win.cursor_position(), win.outer_position(), win.scale_factor()) else {
                continue;
            };

            // Follow mouse: hop to the monitor under the cursor (twice a second, never mid-hover).
            if tick % 30 == 0 && !interactive && !MOVING.load(Ordering::Relaxed) {
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

            // Where the island window actually is (logged when it changes): lets a "the island
            // disappeared" report be traced to a position, a display or visibility.
            if tick % 120 == 0 {
                let vis = win.is_visible().unwrap_or(false);
                let key = (origin.x, origin.y, vis);
                if last_where != Some(key) {
                    last_where = Some(key);
                    log_line(format!("island window at {},{} visible={vis}", origin.x, origin.y));
                }
            }
            let lx = (cursor.x - origin.x as f64) / scale;
            let ly = (cursor.y - origin.y as f64) / scale;
            let held = state.hold.load(Ordering::Relaxed);
            let (on_island, on_bubble) = {
                let h = state.hit.lock().unwrap();
                let i = h.island;
                // Hysteresis: once the island is open, the cursor has to move clearly away
                // before it closes, so resting right on its edge can't make it flicker
                // open/closed. The strip between the island and the top of the screen
                // counts as the island too (push the mouse to the top edge to open it).
                let m = if hovering { HIT_MARGIN_OPEN } else { HIT_MARGIN };
                let above = i.w > 0.0 && ly >= -1.0 && ly < i.y && lx >= i.x - m && lx <= i.x + i.w + m;
                (
                    held || above || i.contains(lx, ly, m),
                    h.bubble.map_or(false, |b| b.contains(lx, ly, 2.0)),
                )
            };

            // While moving, the island is under the cursor the whole time: keep it clickable so
            // the click that places it (Move Island…) reaches it instead of the app below.
            let now_interactive = on_island || on_bubble || MOVING.load(Ordering::Relaxed);
            if now_interactive != interactive {
                interactive = now_interactive;
                #[cfg(debug_assertions)]
                if unsafe { windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState(0x01) } < 0 {
                    // Mouse button held while crossing the island = probably a drag.
                    ui_log(format!("hit: interactive={interactive} (button held) at {lx:.0},{ly:.0}"));
                }
                let _ = win.set_ignore_cursor_events(!interactive);
            }
            // Only the island itself expands on hover; the bubble is a click target.
            if on_island != hovering {
                hovering = on_island;
                #[cfg(debug_assertions)]
                ui_log(format!("hover: {hovering} at {lx:.0},{ly:.0}"));
                HOVERING.store(hovering, Ordering::Relaxed);
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
        .text("move", "Move Island…")
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
                set_island_hidden(app, &state, true, "right-click menu");
                return;
            }
            "move" => {
                start_move(app, true);
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
    // On Windows 11 the window gets the system Mica material behind a dark theme, like
    // the built-in Settings app; older Windows gets a solid dark background.
    let mica = windows_build() >= 22000;
    let mut b = WebviewWindowBuilder::new(app, "settings", WebviewUrl::default())
        .title("Islander Settings")
        .inner_size(880.0, 620.0)
        .min_inner_size(720.0, 500.0)
        .theme(Some(tauri::Theme::Dark))
        .additional_browser_args(BROWSER_ARGS)
        .center();
    if mica {
        b = b
            .transparent(true)
            .background_color(tauri::window::Color(0, 0, 0, 0))
            .effects(tauri::utils::config::WindowEffectsConfig {
                effects: vec![tauri::utils::WindowEffect::Mica],
                ..Default::default()
            })
            .initialization_script("document.documentElement.setAttribute('data-mica','')");
    } else {
        b = b.background_color(tauri::window::Color(30, 30, 30, 255));
    }
    b.build()?;
    Ok(())
}

/// WebView2 switches shared by every window (they must match, or WebView2 refuses to
/// create the second window). The first part is Tauri's default; then GPU rasterisation
/// and zero-copy uploads for smooth animation, and no throttling when Windows thinks
/// the always-on-top island is covered.
pub const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion --enable-gpu-rasterization --enable-zero-copy --disable-background-timer-throttling --disable-renderer-backgrounding";

/// Windows build number (22000+ is Windows 11).
fn windows_build() -> u32 {
    use windows::core::w;
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ};
    let mut buf = [0u16; 32];
    let mut len = (buf.len() * 2) as u32;
    let ok = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            w!("SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion"),
            w!("CurrentBuildNumber"),
            RRF_RT_REG_SZ,
            None,
            Some(buf.as_mut_ptr().cast()),
            Some(&mut len),
        )
    };
    if ok.is_err() {
        return 0;
    }
    let n = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..n]).trim().parse().unwrap_or(0)
}
