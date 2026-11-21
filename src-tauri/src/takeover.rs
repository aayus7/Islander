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
pub fn volume_changed() {}
#[cfg(not(windows))]
pub fn set_banners(_app: &tauri::AppHandle, _on: bool) {}
#[cfg(not(windows))]
pub fn hush_app(_aumid: &str) {}
#[cfg(not(windows))]
pub fn install_exit_guard() {}
#[cfg(not(windows))]
pub fn restore_on_exit() {}
#[cfg(not(windows))]
pub fn restore_from_backup_file() {}

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
    /// Marks keystrokes Islander sends itself (dwExtraInfo), so the hook lets them through.
    pub const ISLAND_INPUT: usize = 0x1514_A4D0;
    /// Volume/media keys the hook has seen (diagnostics: tells "hook dropped" apart from
    /// "keys arrive but Windows still shows its popup").
    static SEEN: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    static LAST_SEEN: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

    unsafe extern "system" fn hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code >= 0 && KEYS.load(Ordering::Relaxed) {
            let k = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
            // Volume and media keys are handled even when they're *injected*: laptop Fn
            // keys, keyboard/mouse software (Logitech, Razer, ASUS, HP…) and macro tools
            // send them that way, and letting those through is what made Windows' own
            // volume popup still appear. Only keys marked as Islander's own pass through.
            let _ = LLKHF_INJECTED;
            if k.dwExtraInfo != ISLAND_INPUT {
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
                    SEEN.fetch_add(1, Ordering::Relaxed);
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

    /* ---------------- Windows' own volume popup ----------------
     * On some PCs Windows still shows its volume popup even though the keys never reach
     * it (it also reads the keyboard's media buttons another way). So, like the
     * HideVolumeOSD tool does: find the popup's window — the one that appears right
     * after a volume key — and keep it minimised, which stops it from ever showing.
     * Put back when Islander quits or the option is turned off. */

    static OSD: std::sync::atomic::AtomicIsize = std::sync::atomic::AtomicIsize::new(0);

    /// Windows that can be the popup: Windows 11's XAML host with its content bridge
    /// child, or Windows 10's NativeHWNDHost with a DirectUIHWND child.
    fn osd_candidates() -> Vec<windows::Win32::Foundation::HWND> {
        use windows::core::w;
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::FindWindowExW;
        let mut out = Vec::new();
        for (outer, inner, inner_name) in [
            (w!("XamlExplorerHostIslandWindow"), w!("Windows.UI.Composition.DesktopWindowContentBridge"), w!("DesktopWindowXamlSource")),
            (w!("NativeHWNDHost"), w!("DirectUIHWND"), PCWSTR::null()),
        ] {
            let mut after: Option<HWND> = None;
            unsafe {
                while let Ok(h) = FindWindowExW(None, after, outer, PCWSTR::null()) {
                    if h.0.is_null() {
                        break;
                    }
                    if FindWindowExW(Some(h), None, inner, inner_name).map(|c| !c.0.is_null()).unwrap_or(false) {
                        out.push(h);
                    }
                    after = Some(h);
                }
            }
        }
        out
    }

    fn visible_now(h: windows::Win32::Foundation::HWND) -> bool {
        use windows::Win32::UI::WindowsAndMessaging::{IsIconic, IsWindowVisible};
        unsafe { IsWindowVisible(h).as_bool() && !IsIconic(h).as_bool() }
    }

    /// After a volume key: if Windows' popup came up anyway, minimise it for good.
    fn suppress_osd(before: Vec<windows::Win32::Foundation::HWND>) {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{IsWindow, ShowWindow, SW_MINIMIZE};
        let known = OSD.load(Ordering::Relaxed);
        if known != 0 {
            let h = HWND(known as _);
            unsafe {
                if IsWindow(Some(h)).as_bool() {
                    if visible_now(h) {
                        let _ = ShowWindow(h, SW_MINIMIZE);
                    }
                    return;
                }
            }
            OSD.store(0, Ordering::Relaxed); // Explorer restarted: find it again
        }
        // (Window handles as numbers: raw handles can't cross threads.)
        let before: Vec<isize> = before.iter().map(|h| h.0 as isize).collect();
        std::thread::spawn(move || {
            for wait in [40u64, 80, 160, 320, 600] {
                std::thread::sleep(Duration::from_millis(wait));
                // The popup is the window that just became visible.
                let fresh: Vec<HWND> = osd_candidates().into_iter().filter(|h| visible_now(*h) && !before.contains(&(h.0 as isize))).collect();
                if fresh.len() == 1 {
                    let h = fresh[0];
                    unsafe {
                        let _ = ShowWindow(h, SW_MINIMIZE);
                    }
                    OSD.store(h.0 as isize, Ordering::Relaxed);
                    #[cfg(debug_assertions)]
                    crate::log_line(format!("keys: Windows' volume popup found ({:?}) and kept hidden", h.0));
                    return;
                }
            }
        });
    }

    /* Third layer, for volume changes the keyboard hook never sees: an admin app in front
     * (Windows doesn't let a normal app's hook see keys then), the hook dropped by Windows
     * for a moment, or volume changed by a headset, a knob or vendor software. Windows
     * reports every window that appears; when its volume popup appears right after the
     * volume changed (from any source), it's minimised on the spot. */

    static VOL_AT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    fn now_ms() -> u64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
    }

    /// Called on every volume / mute change, whatever caused it (hud.rs).
    pub fn volume_changed() {
        VOL_AT.store(now_ms(), Ordering::Relaxed);
        // Popup already known: if it's up, put it away right now.
        let known = OSD.load(Ordering::Relaxed);
        if KEYS.load(Ordering::Relaxed) && known != 0 {
            let h = windows::Win32::Foundation::HWND(known as _);
            if visible_now(h) {
                unsafe {
                    let _ = windows::Win32::UI::WindowsAndMessaging::ShowWindow(h, windows::Win32::UI::WindowsAndMessaging::SW_MINIMIZE);
                }
            }
        }
    }

    /// Is this one of the windows Windows' volume popup lives in?
    fn is_osd_window(h: windows::Win32::Foundation::HWND) -> bool {
        use windows::core::w;
        use windows::Win32::UI::WindowsAndMessaging::{FindWindowExW, GetClassNameW};
        let mut buf = [0u16; 64];
        let n = unsafe { GetClassNameW(h, &mut buf) }.max(0) as usize;
        let class = String::from_utf16_lossy(&buf[..n]);
        let child = |inner: PCWSTR, name: PCWSTR| unsafe { FindWindowExW(Some(h), None, inner, name).map(|c| !c.0.is_null()).unwrap_or(false) };
        match class.as_str() {
            "XamlExplorerHostIslandWindow" => child(w!("Windows.UI.Composition.DesktopWindowContentBridge"), w!("DesktopWindowXamlSource")),
            "NativeHWNDHost" => child(w!("DirectUIHWND"), PCWSTR::null()),
            _ => false,
        }
    }

    unsafe extern "system" fn on_window_shown(
        _hook: windows::Win32::UI::Accessibility::HWINEVENTHOOK,
        _event: u32,
        hwnd: windows::Win32::Foundation::HWND,
        id_object: i32,
        _child: i32,
        _thread: u32,
        _time: u32,
    ) {
        if id_object != 0 || hwnd.0.is_null() || !KEYS.load(Ordering::Relaxed) {
            return; // OBJID_WINDOW only
        }
        let known = OSD.load(Ordering::Relaxed);
        let is_known = known != 0 && hwnd.0 as isize == known;
        // Only right after a volume change: the same kind of window also hosts other parts
        // of the shell, which must never be touched.
        let recent = now_ms().saturating_sub(VOL_AT.load(Ordering::Relaxed)) < 1500;
        if is_known || (recent && is_osd_window(hwnd)) {
            hide_osd(hwnd, is_known);
        } else if is_osd_window(hwnd) {
            // The popup can come up a moment before the volume watcher (50 ms) notices the
            // change: look again shortly, and hide it then if a volume change came with it.
            let raw = hwnd.0 as isize;
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(90));
                let h = windows::Win32::Foundation::HWND(raw as _);
                if now_ms().saturating_sub(VOL_AT.load(Ordering::Relaxed)) < 1500 && visible_now(h) {
                    hide_osd(h, false);
                }
            });
        }
    }

    fn hide_osd(hwnd: windows::Win32::Foundation::HWND, known: bool) {
        use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_MINIMIZE};
        unsafe {
            let _ = ShowWindow(hwnd, SW_MINIMIZE);
        }
        if !known {
            OSD.store(hwnd.0 as isize, Ordering::Relaxed);
            crate::log_line("keys: Windows' volume popup appeared after a volume change; hidden".into());
        }
    }

    fn spawn_osd_watch() {
        std::thread::spawn(|| unsafe {
            use windows::Win32::UI::Accessibility::SetWinEventHook;
            use windows::Win32::UI::WindowsAndMessaging::{EVENT_OBJECT_SHOW, EVENT_SYSTEM_MINIMIZEEND, WINEVENT_OUTOFCONTEXT, WINEVENT_SKIPOWNPROCESS};
            let flags = WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS;
            // A window appearing, or the (minimised) popup being brought back by Windows.
            let a = SetWinEventHook(EVENT_OBJECT_SHOW, EVENT_OBJECT_SHOW, None, Some(on_window_shown), 0, 0, flags);
            let b = SetWinEventHook(EVENT_SYSTEM_MINIMIZEEND, EVENT_SYSTEM_MINIMIZEEND, None, Some(on_window_shown), 0, 0, flags);
            if a.is_invalid() && b.is_invalid() {
                crate::log_line("keys: couldn't watch for Windows' volume popup".into());
                return;
            }
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {}
        });
    }

    /// Give Windows its volume popup back (quitting, or the option turned off).
    pub fn restore_osd() {
        use windows::Win32::UI::WindowsAndMessaging::{IsIconic, ShowWindow, SW_HIDE, SW_RESTORE};
        OSD.store(0, Ordering::Relaxed);
        for h in osd_candidates() {
            unsafe {
                if IsIconic(h).as_bool() {
                    // Restore, then hide at once: it's shown again the next time the
                    // volume changes, and doesn't sit invisibly blocking clicks.
                    let _ = ShowWindow(h, SW_RESTORE);
                    let _ = ShowWindow(h, SW_HIDE);
                }
            }
        }
    }

    fn handle(key: Key) {
        let before = if matches!(key, Key::VolUp | Key::VolDown | Key::Mute) {
            osd_candidates().into_iter().filter(|h| visible_now(*h)).collect::<Vec<_>>()
        } else {
            Vec::new()
        };
        #[cfg(debug_assertions)]
        crate::log_line(format!("keys: {} handled by the island", match key {
            Key::VolUp => "volume up",
            Key::VolDown => "volume down",
            Key::Mute => "mute",
            Key::PlayPause => "play/pause",
            Key::Next => "next",
            Key::Prev => "previous",
        }));
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
                suppress_osd(before);
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
        restore_osd();
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
    /// Used by the uninstaller (`Islander.exe --restore-windows`): put back every app's
    /// notification banner from the backup file, even if Islander was force-closed.
    pub fn restore_from_backup_file() {
        restore_osd();
        let Some(dir) = std::env::var_os("APPDATA").map(|d| std::path::PathBuf::from(d).join("dev.island.desktop")) else { return };
        let p = dir.join("banner-backup.json");
        let Some(prev) = std::fs::read_to_string(&p).ok().and_then(|s| serde_json::from_str::<HashMap<String, Option<u32>>>(&s).ok()) else { return };
        let _ = BACKUP.set(p);
        *SAVED.lock().unwrap() = Some(prev);
        restore_all();
    }

    pub fn restore_on_exit() {
        restore_osd();
        if ACTIVE.swap(false, Ordering::Relaxed) {
            restore_all();
        }
    }

    pub fn spawn_keys() {
        spawn_osd_watch();
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
            use windows::Win32::System::Threading::{GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_TIME_CRITICAL};
            use windows::Win32::UI::WindowsAndMessaging::{KillTimer, SetTimer, UnhookWindowsHookEx, WM_TIMER};
            // The hook must answer within Windows' LowLevelHooksTimeout or Windows quietly
            // drops it (and its own popup comes back). Run this thread at top priority…
            let _ = SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_TIME_CRITICAL);
            // Low-level hooks want the module that contains the callback (this exe).
            let module = windows::Win32::System::LibraryLoader::GetModuleHandleW(PCWSTR::null()).ok().map(windows::Win32::Foundation::HINSTANCE::from);
            let mut current = match SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook), module, 0) {
                Ok(h) => {
                    eprintln!("[island] volume & media keys: handled by the island");
                    h
                }
                Err(e) => {
                    eprintln!("[island] couldn't take over the volume keys: {e}");
                    return;
                }
            };
            // …and re-install it every 5 s, so even if Windows dropped it (PC under heavy
            // load, waking from sleep) it's back almost at once. (The popup watcher above
            // covers those few seconds.)
            let timer = SetTimer(None, 0, 5_000, None);
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                if msg.message == WM_TIMER {
                    let ok = match SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook), module, 0) {
                        Ok(h) => {
                            let _ = UnhookWindowsHookEx(current);
                            current = h;
                            true
                        }
                        Err(_) => false,
                    };
                    #[cfg(debug_assertions)]
                    {
                        let seen = SEEN.load(Ordering::Relaxed);
                        if seen != LAST_SEEN.swap(seen, Ordering::Relaxed) || !ok {
                            crate::log_line(format!("keys: hook refreshed (ok={ok}, on={}, keys seen so far={seen})", KEYS.load(Ordering::Relaxed)));
                        }
                    }
                    let _ = ok;
                }
            }
            let _ = KillTimer(None, timer);
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
