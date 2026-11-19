//! "Open at login": a per-user Run entry pointing at the installed Islander.exe.
//! Development builds never register themselves (they'd point at target\debug).

const RUN_KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const NAME: &str = "Islander";

#[cfg(all(windows, not(debug_assertions)))]
pub fn set(enabled: bool) {
    use windows::core::HSTRING;
    use windows::Win32::System::Registry::{RegDeleteKeyValueW, RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ};
    let key = HSTRING::from(RUN_KEY);
    let name = HSTRING::from(NAME);
    unsafe {
        if enabled {
            let Ok(exe) = std::env::current_exe() else { return };
            let cmd: Vec<u16> = format!("\"{}\"", exe.display()).encode_utf16().chain(Some(0)).collect();
            let _ = RegSetKeyValueW(HKEY_CURRENT_USER, &key, &name, REG_SZ.0, Some(cmd.as_ptr() as *const _), (cmd.len() * 2) as u32);
        } else {
            let _ = RegDeleteKeyValueW(HKEY_CURRENT_USER, &key, &name);
        }
    }
}

#[cfg(not(all(windows, not(debug_assertions))))]
pub fn set(enabled: bool) {
    let _ = (enabled, RUN_KEY, NAME);
}

/// Where the bundled browser extension lives (installed copy, or the repo in dev).
pub fn extension_dir(app: &tauri::AppHandle) -> std::path::PathBuf {
    use tauri::Manager;
    if let Ok(res) = app.path().resource_dir() {
        let p = res.join("extension");
        if p.join("manifest.json").exists() {
            return p;
        }
    }
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("extension")
}

#[tauri::command]
pub fn open_extension_folder(app: tauri::AppHandle) -> Result<String, String> {
    let dir = extension_dir(&app);
    let dir = dir.canonicalize().unwrap_or(dir);
    let s = dir.to_string_lossy().trim_start_matches(r"\\?\").to_string();
    std::process::Command::new("explorer.exe").arg(&s).spawn().map_err(|e| e.to_string())?;
    Ok(s)
}
