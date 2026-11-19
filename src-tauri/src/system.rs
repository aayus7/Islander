//! Quick system actions for the Controls tab and launcher: lock, sleep, mute,
//! light/dark mode, screen capture, opening apps/folders/URLs, file icons.
use serde::Serialize;

#[derive(Serialize)]
pub struct SysState {
    pub muted: bool,
    pub dark: bool,
}

#[cfg(windows)]
mod imp {
    use super::*;
    use crate::privacy::reg;
    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::Foundation::{LPARAM, WPARAM};
    use windows::Win32::System::Registry::{HKEY_CURRENT_USER, KEY_READ, KEY_SET_VALUE};
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::{SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, SW_SHOWNORMAL, WM_SETTINGCHANGE};

    const PERSONALIZE: &str = r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize";

    fn com() {
        use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
    }

    pub fn state() -> SysState {
        com();
        let muted = crate::hud::imp::endpoint().and_then(|(v, _)| unsafe { v.GetMute() }.ok()).map(|b| b.as_bool()).unwrap_or(false);
        let dark = reg::open(HKEY_CURRENT_USER, PERSONALIZE, KEY_READ).and_then(|k| reg::dword(&k, "AppsUseLightTheme")).map(|v| v == 0).unwrap_or(true);
        SysState { muted, dark }
    }

    pub fn toggle_mute() -> Result<bool, String> {
        com();
        let (v, _) = crate::hud::imp::endpoint().ok_or("no output device")?;
        unsafe {
            let now = v.GetMute().map_err(|e| e.to_string())?.as_bool();
            v.SetMute(!now, std::ptr::null()).map_err(|e| e.to_string())?;
            Ok(!now)
        }
    }

    /// Flip apps + system between light and dark, and tell every window to repaint.
    pub fn toggle_theme() -> Result<bool, String> {
        let k = reg::open(HKEY_CURRENT_USER, PERSONALIZE, KEY_READ | KEY_SET_VALUE).ok_or("can't open theme settings")?;
        let dark_now = reg::dword(&k, "AppsUseLightTheme").map(|v| v == 0).unwrap_or(false);
        let light = if dark_now { 1 } else { 0 };
        reg::set_dword(&k, "AppsUseLightTheme", light);
        reg::set_dword(&k, "SystemUsesLightTheme", light);
        let area = HSTRING::from("ImmersiveColorSet");
        unsafe {
            let _ = SendMessageTimeoutW(HWND_BROADCAST, WM_SETTINGCHANGE, WPARAM(0), LPARAM(area.as_ptr() as isize), SMTO_ABORTIFHUNG, 200, None);
        }
        Ok(!dark_now)
    }

    pub fn open(target: &str, verb: &str) -> Result<(), String> {
        let t = HSTRING::from(target);
        let v = HSTRING::from(verb);
        let r = unsafe { ShellExecuteW(None, PCWSTR(v.as_ptr()), PCWSTR(t.as_ptr()), PCWSTR::null(), PCWSTR::null(), SW_SHOWNORMAL) };
        if (r.0 as isize) <= 32 {
            return Err(format!("couldn't open {target}"));
        }
        Ok(())
    }

    /// Explorer window with the file selected.
    pub fn reveal(path: &str) -> Result<(), String> {
        use std::os::windows::process::CommandExt;
        let p = std::path::Path::new(path);
        let mut cmd = std::process::Command::new("explorer.exe");
        if p.is_file() {
            // Explorer only understands  /select,"C:\a b\c.mp4"  (quotes around the path alone).
            // Passing it as a normal argument quotes the whole thing, which Explorer can't read,
            // so it opened Documents for any file with a space in its name.
            cmd.raw_arg(format!("/select,\"{path}\""));
        } else if let Some(dir) = if p.is_dir() { Some(p) } else { p.parent().filter(|d| d.is_dir()) } {
            // The file is gone (moved or deleted): open the folder it was in.
            cmd.raw_arg(format!("\"{}\"", dir.display()));
        } else {
            return Err(format!("{path} no longer exists"));
        }
        cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
    }

    pub fn lock() {
        unsafe {
            let _ = windows::Win32::System::Shutdown::LockWorkStation();
        }
    }

    pub fn sleep() {
        // Give the click a moment to finish before the machine goes down.
        std::thread::spawn(|| {
            std::thread::sleep(std::time::Duration::from_millis(400));
            unsafe {
                let _ = windows::Win32::System::Power::SetSuspendState(false, false, false);
            }
        });
    }

    /// Presses Win+PrintScreen: Windows takes a full-screen shot (the screen dims
    /// briefly) and saves it to Pictures\Screenshots — no Snipping Tool needed.
    pub fn screenshot() {
        use windows::Win32::UI::Input::KeyboardAndMouse::{
            SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, VIRTUAL_KEY, VK_LWIN, VK_SNAPSHOT,
        };
        // Let the click finish (and the island settle) so it isn't in the shot mid-press.
        std::thread::spawn(|| {
            std::thread::sleep(std::time::Duration::from_millis(250));
            let key = |vk: VIRTUAL_KEY, flags: KEYBD_EVENT_FLAGS| INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: vk, wScan: 0, dwFlags: flags, time: 0, dwExtraInfo: crate::takeover::ISLAND_INPUT } },
            };
            let ext = KEYEVENTF_EXTENDEDKEY;
            let up = KEYBD_EVENT_FLAGS(KEYEVENTF_EXTENDEDKEY.0 | KEYEVENTF_KEYUP.0);
            let inputs = [key(VK_LWIN, ext), key(VK_SNAPSHOT, ext), key(VK_SNAPSHOT, up), key(VK_LWIN, up)];
            unsafe {
                SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
            }
        });
    }

    pub fn icon(path: &str) -> Option<String> {
        crate::media::shell_thumb(path, 64, false)
    }

    /// Bring an app to the front by its AppUserModelId (notification click).
    pub fn activate_app(aumid: &str) -> Result<(), String> {
        open(&format!("shell:AppsFolder\\{aumid}"), "open")
    }
}

#[cfg(not(windows))]
mod imp {
    use super::*;
    pub fn state() -> SysState {
        SysState { muted: false, dark: true }
    }
    pub fn toggle_mute() -> Result<bool, String> {
        Err("unsupported".into())
    }
    pub fn toggle_theme() -> Result<bool, String> {
        Err("unsupported".into())
    }
    pub fn open(_t: &str, _v: &str) -> Result<(), String> {
        Err("unsupported".into())
    }
    pub fn reveal(_p: &str) -> Result<(), String> {
        Err("unsupported".into())
    }
    pub fn lock() {}
    pub fn sleep() {}
    pub fn screenshot() {}
    pub fn icon(_p: &str) -> Option<String> {
        None
    }
    pub fn activate_app(_a: &str) -> Result<(), String> {
        Err("unsupported".into())
    }
}

pub use imp::*;

/* ---------------- commands ---------------- */

#[tauri::command]
pub async fn sys_state() -> SysState {
    tauri::async_runtime::spawn_blocking(state).await.unwrap_or(SysState { muted: false, dark: true })
}
#[tauri::command]
pub async fn sys_mute_toggle() -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(toggle_mute).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn sys_theme_toggle() -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(toggle_theme).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn sys_lock() {
    lock();
}
#[tauri::command]
pub fn sys_sleep() {
    sleep();
}
#[tauri::command]
pub fn sys_screenshot() {
    screenshot();
}
#[tauri::command]
pub async fn launch(target: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || open(&target, "open")).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn file_icon(path: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || icon(&path)).await.ok().flatten()
}
#[tauri::command]
pub fn reveal_path(path: String) -> Result<(), String> {
    reveal(&path)
}
#[tauri::command]
pub async fn notify_open(aumid: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || activate_app(&aumid)).await.map_err(|e| e.to_string())?
}
