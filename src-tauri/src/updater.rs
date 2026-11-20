//! Automatic updates (release builds).
//!
//! A few seconds after every start (retrying while the network comes up), and then every
//! few hours, Islander asks the release feed
//! (`latest.json` in the GitHub releases, see tauri.conf.json → plugins.updater) whether
//! there's a newer version. If there is, it downloads and verifies it in the background
//! (it's signed with the project's updater key), then tells the island
//! (`update://ready`), which shows an "Update ready" banner. Click it — or Settings →
//! About → Restart to Update — and the new version installs and relaunches.
//! Nothing installs without that click, so music or a timer is never cut off mid-way.

use std::sync::Mutex;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::{Update, UpdaterExt};

static PENDING: Mutex<Option<(Update, Vec<u8>)>> = Mutex::new(None);
static STATUS: Mutex<String> = Mutex::new(String::new());

fn set_status(app: &AppHandle, s: impl Into<String>) {
    let s = s.into();
    *STATUS.lock().unwrap() = s.clone();
    let _ = app.emit("update://status", s);
}

pub fn spawn(app: AppHandle) {
    if cfg!(debug_assertions) {
        return; // development builds don't update themselves
    }
    tauri::async_runtime::spawn(async move {
        // Every launch (Windows startup included): ask soon after the island is up.
        tokio_sleep(6).await;
        loop {
            // At sign-in the network is often not up yet: keep trying for a while
            // (every minute, up to 15 tries) before falling back to the 6-hour rhythm.
            for attempt in 0..15 {
                if check(&app).await.is_ok() {
                    break;
                }
                if attempt < 14 {
                    tokio_sleep(60).await;
                }
            }
            tokio_sleep(6 * 3600).await;
        }
    });
}

async fn tokio_sleep(secs: u64) {
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(std::time::Duration::from_secs(secs))).await;
}

/// Check, and download if there's something new. Returns the status text.
async fn check(app: &AppHandle) -> Result<String, String> {
    // Already downloaded and still not installed: ask again (a gentle reminder).
    let pending = PENDING.lock().unwrap().as_ref().map(|(u, _)| (u.version.clone(), u.body.clone().unwrap_or_default()));
    if let Some((version, notes)) = pending {
        let _ = app.emit("update://ready", serde_json::json!({ "version": version, "notes": notes }));
        return Ok(format!("ready:{version}"));
    }
    set_status(app, "checking");
    let updater = app.updater().map_err(|e| e.to_string())?;
    let found = match updater.check().await {
        Ok(f) => f,
        Err(e) => {
            set_status(app, "error");
            return Err(e.to_string());
        }
    };
    let Some(update) = found else {
        set_status(app, "latest");
        return Ok("latest".into());
    };
    set_status(app, format!("downloading:{}", update.version));
    let bytes = match update.download(|_, _| {}, || {}).await {
        Ok(b) => b,
        Err(e) => {
            set_status(app, "error");
            return Err(e.to_string());
        }
    };
    let version = update.version.clone();
    let notes = update.body.clone().unwrap_or_default();
    *PENDING.lock().unwrap() = Some((update, bytes));
    set_status(app, format!("ready:{version}"));
    let _ = app.emit("update://ready", serde_json::json!({ "version": version, "notes": notes }));
    Ok(format!("ready:{version}"))
}

/// Settings → About → "Check for Updates".
#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<String, String> {
    if cfg!(debug_assertions) {
        return Ok("dev".into());
    }
    check(&app).await
}

/// Current status: "", "checking", "latest", "downloading:<v>", "ready:<v>", "error", "dev".
#[tauri::command]
pub fn update_status() -> String {
    if cfg!(debug_assertions) {
        return "dev".into();
    }
    STATUS.lock().unwrap().clone()
}

/// Install the downloaded update now and relaunch.
#[tauri::command]
pub fn update_install(app: AppHandle) -> Result<(), String> {
    let Some((update, bytes)) = PENDING.lock().unwrap().take() else {
        return Err("no update downloaded".into());
    };
    set_status(&app, "installing");
    // Windows gets its own popups back first; the new version takes over again.
    crate::takeover::restore_on_exit();
    // On Windows this starts the installer (quietly, it relaunches Islander) and exits.
    update.install(bytes).map_err(|e| e.to_string())?;
    app.restart();
}
