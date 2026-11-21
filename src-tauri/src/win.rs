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

/// Show without taking focus and keep it above everything: used to flash the volume pill
/// over a fullscreen app. A normal show could activate the island and knock a game or video
/// out of fullscreen.
pub fn show_no_activate(win: &tauri::WebviewWindow) {
    use windows::Win32::UI::WindowsAndMessaging::{SetWindowPos, ShowWindow, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SW_SHOWNOACTIVATE};
    let Ok(h) = win.hwnd() else { return };
    let hwnd = HWND(h.0 as _);
    unsafe {
        let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
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

/// Why the island is hidden from screen captures (several features can ask at once).
pub const CAPTURE_GLASS: u8 = 1;
pub const CAPTURE_RECORDING: u8 = 2;
static CAPTURE_REASONS: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(0);

/// Hide the island from screen captures while any reason asks for it.
pub fn exclude_from_capture(win: &tauri::WebviewWindow, reason: u8, on: bool) {
    use std::sync::atomic::Ordering;
    use windows::Win32::UI::WindowsAndMessaging::{SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE, WDA_NONE};
    let before = if on { CAPTURE_REASONS.fetch_or(reason, Ordering::SeqCst) } else { CAPTURE_REASONS.fetch_and(!reason, Ordering::SeqCst) };
    let mask = if on { before | reason } else { before & !reason };
    // Changing the display affinity makes Windows redraw the window (a visible blink),
    // so only touch it when the island actually switches between shown and hidden.
    if (before != 0) == (mask != 0) {
        return;
    }
    let Ok(h) = win.hwnd() else { return };
    unsafe {
        let _ = SetWindowDisplayAffinity(HWND(h.0 as _), if mask != 0 { WDA_EXCLUDEFROMCAPTURE } else { WDA_NONE });
    }
}

/// The glass effect's reason (see glass.rs).
pub fn set_capture_excluded(win: &tauri::WebviewWindow, excluded: bool) {
    exclude_from_capture(win, CAPTURE_GLASS, excluded);
}

/// True when the app in front covers the whole monitor the island is on (a game,
/// a fullscreen video, a presentation) — the island gets out of the way then.
pub fn fullscreen_in_front(win: &tauri::WebviewWindow) -> bool {
    let (yes, why) = fs_check(win);
    *FS_WHY.lock().unwrap() = why;
    yes
}

/// Why the last fullscreen check decided what it did (for the log).
static FS_WHY: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());
pub fn fullscreen_why() -> String {
    FS_WHY.lock().unwrap().clone()
}

fn fs_check(win: &tauri::WebviewWindow) -> (bool, String) {
    use windows::Win32::Foundation::RECT;
    use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST};
    use windows::Win32::UI::WindowsAndMessaging::{GetClassNameW, GetForegroundWindow, GetWindowRect, IsZoomed};
    let Ok(h) = win.hwnd() else { return (false, "no island window".into()) };
    let island = HWND(h.0 as _);
    unsafe {
        let fg = GetForegroundWindow();
        if fg.0.is_null() || fg == island {
            return (false, if fg.0.is_null() { "no foreground window".into() } else { "the island itself is in front".into() });
        }
        // Our own windows (Settings, the drop-zone layer while moving) never count.
        let mut pid = 0u32;
        windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId(fg, Some(&mut pid as *mut u32));
        if pid == std::process::id() {
            return (false, "one of Islander's own windows is in front".into());
        }
        // The desktop and taskbar are "fullscreen" windows too — ignore them.
        let mut cls = [0u16; 64];
        let n = GetClassNameW(fg, &mut cls).max(0) as usize;
        let class = String::from_utf16_lossy(&cls[..n]);
        if matches!(class.as_str(), "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd" | "Windows.UI.Core.CoreWindow" | "XamlExplorerHostIslandWindow") {
            return (false, format!("shell window in front ({class})"));
        }
        let zoomed = IsZoomed(fg).as_bool();
        let mon = MonitorFromWindow(fg, MONITOR_DEFAULTTONEAREST);
        if mon != MonitorFromWindow(island, MONITOR_DEFAULTTONEAREST) {
            return (false, format!("{class} is on another monitor"));
        }
        let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        if !GetMonitorInfoW(mon, &mut info).as_bool() {
            return (false, "no monitor info".into());
        }
        let mut r = RECT::default();
        if GetWindowRect(fg, &mut r).is_err() {
            return (false, "no window rect".into());
        }
        // True fullscreen (games, F11, video players) sits exactly on the monitor.
        let m = info.rcMonitor;
        let covers = (r.left - m.left).abs() <= 1 && (r.top - m.top).abs() <= 1 && (r.right - m.right).abs() <= 1 && (r.bottom - m.bottom).abs() <= 1;
        let desc = format!(
            "{class} rect {},{},{},{} monitor {},{},{},{} work {},{},{},{} maximized {zoomed}",
            r.left, r.top, r.right, r.bottom, m.left, m.top, m.right, m.bottom, info.rcWork.left, info.rcWork.top, info.rcWork.right, info.rcWork.bottom
        );
        if !covers {
            return (false, desc);
        }
        // Browsers keep a maximized window flagged "maximized" when a video goes fullscreen
        // (Firefox does this), so "maximized" alone doesn't rule it out. What does: a normal
        // maximized window never covers the taskbar. Only when the taskbar auto-hides (work
        // area = whole monitor) is a maximized window ambiguous; then it isn't fullscreen.
        let w = info.rcWork;
        let taskbar_visible = w.left != m.left || w.top != m.top || w.right != m.right || w.bottom != m.bottom;
        (!zoomed || taskbar_visible, desc)
    }
}

/// The island is a single overlay: if an older copy is still running (e.g. a dev
/// restart that didn't shut it down), close it so there's one island and the
/// hotkeys are free.
#[allow(dead_code)] // development builds only
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

/// Debug: which of the island's windows accept OLE drops (have a registered
/// IDropTarget), plus their extended styles. Written to island-debug.log.
#[cfg(debug_assertions)]
pub fn probe_drop_targets(win: &tauri::WebviewWindow) -> String {
    use windows::core::w;
    use windows::core::BOOL;
    use windows::Win32::Foundation::LPARAM;
    use windows::Win32::UI::WindowsAndMessaging::{EnumChildWindows, GetClassNameW, GetPropW};
    let Ok(h) = win.hwnd() else { return "no hwnd".into() };
    let root = HWND(h.0 as _);
    let mut out = Vec::<String>::new();
    let describe = |hw: HWND| unsafe {
        let mut buf = [0u16; 128];
        let n = GetClassNameW(hw, &mut buf);
        let class = String::from_utf16_lossy(&buf[..n.max(0) as usize]);
        let target = !GetPropW(hw, w!("OleDropTargetInterface")).is_invalid();
        let ex = GetWindowLongPtrW(hw, GWL_EXSTYLE);
        format!("{class} droptarget={target} exstyle={ex:#x}")
    };
    out.push(format!("root: {}", describe(root)));
    unsafe extern "system" fn each(hw: HWND, l: LPARAM) -> BOOL {
        let v = &mut *(l.0 as *mut Vec<HWND>);
        v.push(hw);
        BOOL(1)
    }
    let mut kids: Vec<HWND> = Vec::new();
    unsafe {
        let _ = EnumChildWindows(Some(root), Some(each), LPARAM(&mut kids as *mut _ as isize));
    }
    for k in kids {
        out.push(format!("child: {}", describe(k)));
    }
    out.join(" | ")
}

/// Put `top` above every other always-on-top window, and `below` right under it
/// (the island over its own drop-zone layer). Never takes focus.
pub fn stack_above(top: &tauri::WebviewWindow, below: Option<&tauri::WebviewWindow>) {
    use windows::Win32::UI::WindowsAndMessaging::{SetWindowPos, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE};
    let Ok(t) = top.hwnd() else { return };
    let t = HWND(t.0 as _);
    unsafe {
        let _ = SetWindowPos(t, Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        if let Some(Ok(b)) = below.map(|b| b.hwnd()) {
            let _ = SetWindowPos(HWND(b.0 as _), Some(t), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        }
    }
}
