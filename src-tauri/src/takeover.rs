//! While the island runs it replaces two Windows popups:
//!
//! * **Volume / media flyout** — the volume, mute and media keys are caught with a
//!   low-level keyboard hook and handled here (Windows never sees them, so its flyout
//!   never appears); the island's own pill shows the change.
//! * **Notification banners** — every app's "show banner" switch is turned off, so
//!   notifications go quietly to the Notification Center, where the island picks them
//!   up and shows them itself. The original per-app settings are saved first and put
//!   back when the island quits or the option is turned off.
use std::sync::atomic::{AtomicBool, Ordering};

/// Volume/media keys are handled by the island (mirrors the `hud` setting).
pub static KEYS: AtomicBool = AtomicBool::new(false);

#[cfg(windows)]
pub use imp::*;

#[cfg(not(windows))]
pub fn spawn_keys() {}
#[cfg(not(windows))]
pub fn set_banners(_app: &tauri::AppHandle, _on: bool) {}
#[cfg(not(windows))]
pub fn hush_app(_aumid: &str) {}
#[cfg(not(windows))]
pub fn install_exit_guard() {}
#[cfg(not(windows))]
pub fn restore_on_exit() {}

#[cfg(windows)]
mod imp {
    use super::*;
    use crate::privacy::reg;
    use std::collections::HashMap;
    use std::sync::mpsc::{channel, Sender};
    use std::sync::{Mutex, OnceLock};
    use std::time::Duration;
    use tauri::{AppHandle, Manager};
    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::Foundation::{ERROR_SUCCESS, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::Registry::*;
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, GetMessageW, SetWindowsHookExW, KBDLLHOOKSTRUCT, LLKHF_INJECTED, MSG, WH_KEYBOARD_LL, WM_KEYDOWN, WM_SYSKEYDOWN,
    };

    /* ---------------- keys ---------------- */

    #[derive(Clone, Copy)]
    enum Key {
        VolUp,
        VolDown,
        Mute,
        PlayPause,
        Next,
        Prev,
    }

    static TX: OnceLock<Mutex<Sender<Key>>> = OnceLock::new();

    unsafe extern "system" fn hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code >= 0 && KEYS.load(Ordering::Relaxed) {
            let k = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
            // Leave keys other programs simulate alone (e.g. our own Win+PrintScreen).
            if k.flags.0 & LLKHF_INJECTED.0 == 0 {
                let key = match k.vkCode {
                    0xAF => Some(Key::VolUp),
                    0xAE => Some(Key::VolDown),
                    0xAD => Some(Key::Mute),
                    0xB3 => Some(Key::PlayPause),
                    0xB0 => Some(Key::Next),
                    0xB1 => Some(Key::Prev),
                    _ => None,
                };
                if let Some(key) = key {
                    let down = wparam.0 as u32 == WM_KEYDOWN || wparam.0 as u32 == WM_SYSKEYDOWN;
                    if down {
                        if let Some(tx) = TX.get() {
                            let _ = tx.lock().unwrap().send(key);
                        }
                    }
                    return LRESULT(1); // swallowed: Windows won't show its flyout
                }
            }
        }
        CallNextHookEx(None, code, wparam, lparam)
    }

    fn handle(key: Key) {
        match key {
            Key::VolUp | Key::VolDown | Key::Mute => {
                let Some((vol, _)) = crate::hud::imp::endpoint() else { return };
                unsafe {
                    let muted = vol.GetMute().map(|b| b.as_bool()).unwrap_or(false);
                    let level = vol.GetMasterVolumeLevelScalar().unwrap_or(0.0);
                    match key {
                        Key::Mute => {
                            let _ = vol.SetMute(!muted, std::ptr::null());
                        }
                        _ => {
                            // Same 2 % steps as Windows; turning it up also unmutes.
                            let step = if matches!(key, Key::VolUp) { 0.02 } else { -0.02 };
                            let next = (((level + step) * 50.0).round() / 50.0).clamp(0.0, 1.0);
                            let _ = vol.SetMasterVolumeLevelScalar(next, std::ptr::null());
                            if muted && matches!(key, Key::VolUp) {
                                let _ = vol.SetMute(false, std::ptr::null());
                            }
                        }
                    }
                }
            }
            Key::PlayPause | Key::Next | Key::Prev => {
                use windows::Media::Control::GlobalSystemMediaTransportControlsSessionManager as Manager;
                let run = || -> windows::core::Result<()> {
                    let s = Manager::RequestAsync()?.get()?.GetCurrentSession()?;
                    match key {
                        Key::PlayPause => s.TryTogglePlayPauseAsync()?.get()?,
                        Key::Next => s.TrySkipNextAsync()?.get()?,
                        _ => s.TrySkipPreviousAsync()?.get()?,
                    };
                    Ok(())
                };
                let _ = run();
                crate::media::mark_dirty();
            }
        }
    }

    /// Closing the console window (or Ctrl+C) ends the island abruptly: put the
    /// banners back first. Windows gives us a few seconds for this.
    unsafe extern "system" fn on_console_close(_ctrl: u32) -> windows::core::BOOL {
        if ACTIVE.swap(false, Ordering::Relaxed) {
            restore_all();
        }
        windows::core::BOOL(0) // let the default handler end the process
    }

    pub fn install_exit_guard() {
        unsafe {
            let _ = windows::Win32::System::Console::SetConsoleCtrlHandler(Some(on_console_close), true);
        }
    }

    /// Put everything back (island quitting).
    pub fn restore_on_exit() {
        if ACTIVE.swap(false, Ordering::Relaxed) {
            restore_all();
        }
    }

    pub fn spawn_keys() {
        let (tx, rx) = channel::<Key>();
        let _ = TX.set(Mutex::new(tx));
        // Worker: does the (COM) work so the hook itself returns instantly.
        std::thread::spawn(move || {
            unsafe {
                use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
                let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            }
            for key in rx {
                handle(key);
            }
        });
        // Hook thread: a low-level hook needs a message loop on its own thread.
        std::thread::spawn(|| unsafe {
            if let Err(e) = SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook), None, 0) {
                eprintln!("[island] couldn't take over the volume keys: {e}");
                return;
            }
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {}
        });
    }

    /* ---------------- notification banners ---------------- */

    const SETTINGS: &str = r"Software\Microsoft\Windows\CurrentVersion\Notifications\Settings";
    /// app key → original ShowBanner (None = value wasn't set, i.e. Windows' default "on").
    static SAVED: Mutex<Option<HashMap<String, Option<u32>>>> = Mutex::new(None);
    static ACTIVE: AtomicBool = AtomicBool::new(false);
    static BACKUP: OnceLock<std::path::PathBuf> = OnceLock::new();

    fn backup_path(app: &AppHandle) -> Option<std::path::PathBuf> {
        BACKUP.get().cloned().or_else(|| {
            let p = app.path().app_data_dir().ok()?.join("banner-backup.json");
            let _ = BACKUP.set(p.clone());
            Some(p)
        })
    }

    fn write_backup() {
        if let (Some(p), Some(map)) = (BACKUP.get(), SAVED.lock().unwrap().as_ref()) {
            if let Some(d) = p.parent() {
                let _ = std::fs::create_dir_all(d);
            }
            let _ = std::fs::write(p, serde_json::to_string(map).unwrap_or_default());
        }
    }

    fn create_key(path: &str) -> Option<reg::Key> {
        let mut k = HKEY::default();
        let p = HSTRING::from(path);
        let r = unsafe { RegCreateKeyExW(HKEY_CURRENT_USER, PCWSTR(p.as_ptr()), None, PCWSTR::null(), REG_OPTION_NON_VOLATILE, KEY_READ | KEY_SET_VALUE, None, &mut k, None) };
        (r == ERROR_SUCCESS).then_some(reg::Key(k))
    }

    /// Turn off the banner for one app (remembering how it was).
    fn hush(app_key: &str) {
        let mut g = SAVED.lock().unwrap();
        let map = g.get_or_insert_with(HashMap::new);
        if map.contains_key(app_key) {
            return;
        }
        let Some(k) = create_key(&format!(r"{SETTINGS}\{app_key}")) else { return };
        let original = reg::dword(&k, "ShowBanner");
        if original == Some(0) {
            return; // already off by the user's choice: leave it alone (and don't "restore" it)
        }
        map.insert(app_key.to_string(), original);
        reg::set_dword(&k, "ShowBanner", 0);
        drop(g);
        write_backup();
    }

    /// Called for each app the island shows a notification for (catches apps that
    /// had never notified before, so they have no settings key yet).
    pub fn hush_app(aumid: &str) {
        if ACTIVE.load(Ordering::Relaxed) && !aumid.is_empty() {
            hush(aumid);
        }
    }

    fn restore_all() {
        let map = SAVED.lock().unwrap().take().unwrap_or_default();
        for (app_key, original) in map {
            if let Some(k) = reg::open(HKEY_CURRENT_USER, &format!(r"{SETTINGS}\{app_key}"), KEY_READ | KEY_SET_VALUE) {
                match original {
                    Some(v) => {
                        reg::set_dword(&k, "ShowBanner", v);
                    }
                    None => unsafe {
                        let n = HSTRING::from("ShowBanner");
                        let _ = RegDeleteValueW(k.0, PCWSTR(n.as_ptr()));
                    },
                }
            }
        }
        if let Some(p) = BACKUP.get() {
            let _ = std::fs::remove_file(p);
        }
    }

    /// Turn the takeover on/off. Also repairs things after a crash: a backup left by a
    /// previous run is loaded first, so the user's real settings are never lost.
    pub fn set_banners(app: &AppHandle, on: bool) {
        if let Some(p) = backup_path(app) {
            if let Some(prev) = std::fs::read_to_string(&p).ok().and_then(|s| serde_json::from_str::<HashMap<String, Option<u32>>>(&s).ok()) {
                let mut g = SAVED.lock().unwrap();
                let map = g.get_or_insert_with(HashMap::new);
                for (k, v) in prev {
                    map.entry(k).or_insert(v);
                }
            }
        }
        ACTIVE.store(on, Ordering::Relaxed);
        if on {
            std::thread::spawn(|| {
                let Some(root) = reg::open(HKEY_CURRENT_USER, SETTINGS, KEY_READ) else { return };
                for app_key in reg::subkeys(&root) {
                    hush(&app_key);
                    std::thread::sleep(Duration::from_millis(2));
                }
            });
        } else {
            restore_all();
        }
    }
}
