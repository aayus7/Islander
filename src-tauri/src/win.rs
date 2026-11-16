//! Windows-only window tweaks.
use windows::Win32::Foundation::HWND;
use windows::Win32::UI::WindowsAndMessaging::{
    GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
};

/// WS_EX_NOACTIVATE: clicking the island never steals focus from the app you're in.
/// WS_EX_TOOLWINDOW: keeps it out of Alt+Tab and the taskbar.
pub fn apply_overlay_styles(win: &tauri::WebviewWindow) {
    let Ok(h) = win.hwnd() else { return };
    // Tauri may link a different `windows` crate version, so go through the raw pointer.
    let hwnd = HWND(h.0 as _);
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        SetWindowLongPtrW(
            hwnd,
            GWL_EXSTYLE,
            ex | WS_EX_NOACTIVATE.0 as isize | WS_EX_TOOLWINDOW.0 as isize,
        );
    }
}

/// A popup menu only closes on outside clicks if its owner window is in the foreground.
pub fn bring_to_foreground(win: &tauri::WebviewWindow) {
    let Ok(h) = win.hwnd() else { return };
    unsafe {
        let _ = windows::Win32::UI::WindowsAndMessaging::SetForegroundWindow(HWND(h.0 as _));
    }
}

/// Allow/deny keyboard focus. The island normally never takes focus (so clicking it
/// doesn't steal focus from your app); the AI panel needs it to type.
pub fn set_activatable(win: &tauri::WebviewWindow, activatable: bool) {
    let Ok(h) = win.hwnd() else { return };
    let hwnd = HWND(h.0 as _);
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let na = WS_EX_NOACTIVATE.0 as isize;
        let new = if activatable { ex & !na } else { ex | na };
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, new);
    }
}

/// Hide the island from screen captures (so the glass effect can see what's *behind* it).
pub fn set_capture_excluded(win: &tauri::WebviewWindow, excluded: bool) {
    use windows::Win32::UI::WindowsAndMessaging::{SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE, WDA_NONE};
    let Ok(h) = win.hwnd() else { return };
    unsafe {
        let _ = SetWindowDisplayAffinity(HWND(h.0 as _), if excluded { WDA_EXCLUDEFROMCAPTURE } else { WDA_NONE });
    }
}

/// True when the app in front covers the whole monitor the island is on (a game,
/// a fullscreen video, a presentation) — the island gets out of the way then.
pub fn fullscreen_in_front(win: &tauri::WebviewWindow) -> bool {
    use windows::Win32::Foundation::RECT;
    use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST};
    use windows::Win32::UI::WindowsAndMessaging::{GetClassNameW, GetForegroundWindow, GetWindowRect, IsZoomed};
    let Ok(h) = win.hwnd() else { return false };
    let island = HWND(h.0 as _);
    unsafe {
        let fg = GetForegroundWindow();
        if fg.0.is_null() || fg == island {
            return false;
        }
        // The desktop and taskbar are "fullscreen" windows too — ignore them.
        let mut cls = [0u16; 64];
        let n = GetClassNameW(fg, &mut cls).max(0) as usize;
        let class = String::from_utf16_lossy(&cls[..n]);
        if matches!(class.as_str(), "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd" | "Windows.UI.Core.CoreWindow" | "XamlExplorerHostIslandWindow") {
            return false;
        }
        // A maximized window (Explorer, a browser…) is not "fullscreen", even when an
        // auto-hiding taskbar lets it cover the whole screen.
        if IsZoomed(fg).as_bool() {
            return false;
        }
        let mon = MonitorFromWindow(fg, MONITOR_DEFAULTTONEAREST);
        if mon != MonitorFromWindow(island, MONITOR_DEFAULTTONEAREST) {
            return false;
        }
        let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        if !GetMonitorInfoW(mon, &mut info).as_bool() {
            return false;
        }
        let mut r = RECT::default();
        if GetWindowRect(fg, &mut r).is_err() {
            return false;
        }
        // True fullscreen (games, F11, video players) sits exactly on the monitor.
        let m = info.rcMonitor;
        (r.left - m.left).abs() <= 1 && (r.top - m.top).abs() <= 1 && (r.right - m.right).abs() <= 1 && (r.bottom - m.bottom).abs() <= 1
    }
}

/// The island is a single overlay: if an older copy is still running (e.g. a dev
/// restart that didn't shut it down), close it so there's one island and the
/// hotkeys are free.
pub fn close_other_instances() {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
    use windows::Win32::System::Threading::{GetCurrentProcessId, OpenProcess, TerminateProcess, PROCESS_TERMINATE};
    let Ok(me) = std::env::current_exe() else { return };
    let Some(name) = me.file_name().map(|n| n.to_string_lossy().to_lowercase()) else { return };
    unsafe {
        let my_pid = GetCurrentProcessId();
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return };
        let mut e = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        if Process32FirstW(snap, &mut e).is_ok() {
            loop {
                let len = e.szExeFile.iter().position(|&c| c == 0).unwrap_or(e.szExeFile.len());
                let exe = String::from_utf16_lossy(&e.szExeFile[..len]).to_lowercase();
                if exe == name && e.th32ProcessID != my_pid {
                    if let Ok(h) = OpenProcess(PROCESS_TERMINATE, false, e.th32ProcessID) {
                        eprintln!("closing an older island instance (pid {})", e.th32ProcessID);
                        let _ = TerminateProcess(h, 0);
                        let _ = CloseHandle(h);
                    }
                }
                if Process32NextW(snap, &mut e).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
    }
}

/// Bring a running app's main window to the front, by exe stem ("spotify",
/// "firefox"). Falls back to launching the exe again, which makes single-instance
/// apps (Spotify, Discord, browsers) show themselves — e.g. when minimised to tray.
pub fn focus_app(stem: &str) -> bool {
    use windows::core::BOOL;
    use windows::Win32::Foundation::LPARAM;
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindow, GetWindowTextLengthW, GetWindowThreadProcessId, IsIconic, IsWindowVisible, SetForegroundWindow, ShowWindow, GW_OWNER, SW_RESTORE,
    };
    struct Search {
        stem: String,
        found: Option<HWND>,
    }
    unsafe extern "system" fn visit(hwnd: HWND, lp: LPARAM) -> BOOL {
        let s = &mut *(lp.0 as *mut Search);
        // A real app window: visible, top-level (no owner) and titled.
        if !IsWindowVisible(hwnd).as_bool() || GetWindow(hwnd, GW_OWNER).map(|o| !o.0.is_null()).unwrap_or(false) || GetWindowTextLengthW(hwnd) == 0 {
            return BOOL(1);
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid as *mut u32));
        if crate::audio::meters::exe_stem(pid).0 == s.stem {
            s.found = Some(hwnd);
            return BOOL(0); // stop
        }
        BOOL(1)
    }
    let mut search = Search { stem: stem.to_lowercase(), found: None };
    unsafe {
        let _ = EnumWindows(Some(visit), LPARAM(&mut search as *mut Search as isize));
        if let Some(h) = search.found {
            if IsIconic(h).as_bool() {
                let _ = ShowWindow(h, SW_RESTORE);
            }
            if SetForegroundWindow(h).as_bool() {
                return true;
            }
        }
    }
    let path = crate::audio::meters::exe_path(stem).or_else(|| crate::media::process_exe(stem));
    match path {
        Some(p) => crate::system::open(&p, "open").is_ok(),
        None => false,
    }
}
