//! Nearby sharing for the Shelf: Islander speaks the LocalSend protocol, so phones and
//! PCs running the free LocalSend app (https://localsend.org) can trade files with it.
//! The protocol lives in `localsend_core.rs`; this file connects it to the island:
//!
//! - `localsend://peers`     nearby devices (Shelf shows them as AirDrop-style bubbles)
//! - `localsend://incoming`  someone wants to send files → Accept / Decline in the island
//! - `localsend://transfer`  progress of one transfer (either direction)
//! - transfers also appear in the Downloads live activity (ring while collapsed, banner when
//!   done), and received files are added to the Shelf.

use crate::localsend_core::{Hooks, Identity, Incoming, LocalSend, LsHttp, Peer, Transfer};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

static SERVICE: OnceLock<Arc<LocalSend>> = OnceLock::new();
/// Whether phones can reach this PC: 0 unknown, 1 yes, 2 blocked (usually Windows Firewall).
static BLOCKED: AtomicU8 = AtomicU8::new(0);
/// Incoming requests waiting for Accept / Decline: request id → answer.
static PENDING: Mutex<Option<HashMap<String, Sender<bool>>>> = Mutex::new(None);
/// Transfers shown in the Downloads activity: id → (item, when it finished).
static SHOWN: Mutex<Option<HashMap<String, (crate::ext::Download, Option<Instant>)>>> = Mutex::new(None);

struct AppHooks {
    app: AppHandle,
}

impl Hooks for AppHooks {
    fn peers_changed(&self, peers: Vec<Peer>) {
        let _ = self.app.emit("localsend://peers", peers);
    }

    fn ask(&self, req: &Incoming) -> bool {
        // Development builds: requests from this PC itself are accepted automatically, so the
        // receive path can be tested end to end without clicking.
        #[cfg(debug_assertions)]
        if req.alias == "Islander self-test" {
            crate::log_line("localsend: self-test request auto-accepted".into());
            return true;
        }
        let (tx, rx) = channel();
        PENDING.lock().unwrap().get_or_insert_with(HashMap::new).insert(req.id.clone(), tx);
        let _ = self.app.emit("localsend://incoming", req);
        // No answer within 2 minutes counts as "no" (like LocalSend itself).
        let answer = rx.recv_timeout(Duration::from_secs(120)).unwrap_or(false);
        PENDING.lock().unwrap().get_or_insert_with(HashMap::new).remove(&req.id);
        let _ = self.app.emit("localsend://incoming-closed", &req.id);
        answer
    }

    fn transfer(&self, t: &Transfer) {
        let _ = self.app.emit("localsend://transfer", t);
        show_in_downloads(t);
        if !t.outgoing && t.state == "done" && !t.paths.is_empty() {
            let app = self.app.clone();
            let paths = t.paths.clone();
            tauri::async_runtime::spawn(async move {
                let _ = crate::shelf::shelf_add(app, paths).await;
            });
        }
    }

    fn save_dir(&self) -> PathBuf {
        downloads_dir()
    }

    fn log(&self, msg: &str) {
        crate::log_line(format!("localsend: {msg}"));
    }

    fn inbound_blocked(&self, blocked: bool) {
        let v = if blocked { 2 } else { 1 };
        if BLOCKED.swap(v, Ordering::Relaxed) != v {
            crate::log_line(format!("localsend: phones {} reach this PC", if blocked { "can't" } else { "can" }));
            let _ = self.app.emit("localsend://blocked", blocked);
        }
    }
}

/// The user's Downloads folder (where browsers save too).
fn downloads_dir() -> PathBuf {
    #[cfg(windows)]
    unsafe {
        use windows::Win32::UI::Shell::{FOLDERID_Downloads, SHGetKnownFolderPath, KNOWN_FOLDER_FLAG};
        if let Ok(p) = SHGetKnownFolderPath(&FOLDERID_Downloads, KNOWN_FOLDER_FLAG(0), None) {
            let s = p.to_string().unwrap_or_default();
            windows::Win32::System::Com::CoTaskMemFree(Some(p.0 as *const _));
            if !s.is_empty() {
                return PathBuf::from(s);
            }
        }
    }
    std::env::var_os("USERPROFILE").map(|h| PathBuf::from(h).join("Downloads")).unwrap_or_else(|| PathBuf::from("."))
}

/// Feeds a transfer into the shared downloads list ("from:Pixel 8" / "to:Pixel 8").
fn show_in_downloads(t: &Transfer) {
    let state = match t.state.as_str() {
        "waiting" | "sending" => "in_progress",
        "done" => "complete",
        _ => "interrupted",
    };
    let item = crate::ext::Download {
        id: t.id.clone(),
        name: if t.files > 1 { format!("{} (+{} more)", t.name, t.files - 1) } else { t.name.clone() },
        path: if t.outgoing { String::new() } else { t.path.clone() },
        received: t.sent as f64,
        total: t.total as f64,
        state: state.into(),
        browser: format!("{}:{}", if t.outgoing { "to" } else { "from" }, t.peer),
        speed: 0.0,
    };
    let list: Vec<crate::ext::Download> = {
        let mut g = SHOWN.lock().unwrap();
        let m = g.get_or_insert_with(HashMap::new);
        let finished = if state == "in_progress" { None } else { Some(Instant::now()) };
        // Declined before anything moved: don't leave a failed row behind.
        if t.state == "declined" {
            m.remove(&t.id);
        } else {
            m.insert(t.id.clone(), (item, finished));
        }
        m.retain(|_, (_, f)| f.map(|at| at.elapsed() < Duration::from_secs(8)).unwrap_or(true));
        m.values().map(|(d, _)| d.clone()).collect()
    };
    crate::ext::emit_downloads("localsend", if list.is_empty() { None } else { Some(list) });
    // Clear finished rows a little later, so the list doesn't keep them.
    if state != "in_progress" {
        std::thread::spawn(|| {
            std::thread::sleep(Duration::from_secs(9));
            let list: Vec<crate::ext::Download> = {
                let mut g = SHOWN.lock().unwrap();
                let m = g.get_or_insert_with(HashMap::new);
                m.retain(|_, (_, f)| f.map(|at| at.elapsed() < Duration::from_secs(8)).unwrap_or(true));
                m.values().map(|(d, _)| d.clone()).collect()
            };
            crate::ext::emit_downloads("localsend", if list.is_empty() { None } else { Some(list) });
        });
    }
}

/* ---------------- start / commands ---------------- */

fn computer_name() -> String {
    let title = |w: &str| {
        let mut c = w.chars();
        c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
    };
    let pc = std::env::var("COMPUTERNAME").unwrap_or_default();
    let up = pc.to_uppercase();
    // Windows' made-up names (DESKTOP-B9Q87R9) mean nothing on a phone: use the user's name.
    let generated = up.starts_with("DESKTOP-") || up.starts_with("LAPTOP-") || up.starts_with("WIN-") || pc.is_empty();
    if generated {
        let user: String = std::env::var("USERNAME").unwrap_or_default().chars().take_while(|c| c.is_alphabetic()).collect();
        return if user.is_empty() { "Windows PC".into() } else { format!("{}'s PC", title(&user)) };
    }
    // GAMING-RIG → Gaming-Rig
    pc.split('-').map(|w| title(&w.to_lowercase())).collect::<Vec<_>>().join("-")
}

/// This PC's LocalSend identity: a self-signed certificate (LocalSend needs one for its
/// encrypted connections) whose SHA-256 is the fingerprint phones know us by. Kept, so
/// phones see the same device after restarts.
fn identity(app: &AppHandle) -> Result<Identity, String> {
    use tauri::Manager;
    let path = app.path().app_config_dir().map_err(|e| e.to_string())?.join("nearby-identity.json");
    if let Ok(raw) = std::fs::read_to_string(&path) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(id) = Identity::from_pem(v["cert"].as_str().unwrap_or(""), v["key"].as_str().unwrap_or("")) {
                return Ok(id);
            }
        }
    }
    let id = Identity::generate()?;
    let _ = std::fs::create_dir_all(path.parent().unwrap_or(&path));
    let _ = std::fs::write(&path, serde_json::json!({ "cert": id.cert_pem, "key": id.key_pem }).to_string());
    Ok(id)
}

pub fn spawn(app: AppHandle, enabled: bool, alias: String) {
    let name = if alias.trim().is_empty() { computer_name() } else { alias };
    let id = match identity(&app) {
        Ok(id) => id,
        Err(e) => return crate::log_line(format!("localsend: no identity: {e}")),
    };
    let http = match LsHttp::new(&id) {
        Ok(h) => h,
        Err(e) => return crate::log_line(format!("localsend: no TLS client: {e}")),
    };
    let svc = LocalSend::new(name, id.fingerprint.clone(), Arc::new(AppHooks { app: app.clone() }), Arc::new(http));
    svc.enabled.store(enabled, Ordering::Relaxed);
    let _ = SERVICE.set(svc.clone());
    std::thread::spawn(move || {
        if let Err(e) = svc.start_server() {
            crate::log_line(format!("localsend: can't receive: {e}"));
        }
        match svc.start_discovery() {
            Ok(()) => {
                std::thread::sleep(Duration::from_millis(500));
                svc.announce();
            }
            Err(e) => crate::log_line(format!("localsend: discovery off: {e}")),
        }
        // Multicast is often filtered (Windows Firewall, guest Wi-Fi, some routers): if
        // nobody answered, look on the local network directly.
        std::thread::sleep(Duration::from_secs(3));
        if svc.enabled.load(Ordering::Relaxed) && svc.peers().is_empty() {
            svc.scan_subnet();
        }
    });
}

/// Settings changed: on/off and the name others see.
pub fn configure(enabled: bool, alias: &str) {
    if let Some(s) = SERVICE.get() {
        s.enabled.store(enabled, Ordering::Relaxed);
        s.set_alias(if alias.trim().is_empty() { computer_name() } else { alias.to_string() }.as_str());
        if enabled {
            s.announce();
        }
    }
}

#[tauri::command]
pub fn localsend_peers() -> Vec<Peer> {
    SERVICE.get().map(|s| s.peers()).unwrap_or_default()
}

/// Look for devices now (the Shelf calls this when it opens, and every few seconds while open).
#[tauri::command]
pub fn localsend_scan() {
    if let Some(s) = SERVICE.get() {
        if !s.enabled.load(Ordering::Relaxed) {
            return;
        }
        s.announce();
        if s.peers().is_empty() {
            s.scan_subnet(); // at most every 30 s
        }
        s.check_inbound();
    }
}

/// "Allow" on the Shelf's warning: let phones on the local network reach Islander through
/// Windows Firewall. Windows asks the user (UAC) first; nothing changes without a yes.
/// Rules that block this program are removed (they win over any allow rule; Windows adds
/// them when its first firewall prompt is dismissed), then one allow rule is added that
/// only covers this program and only devices on the local subnet.
#[tauri::command]
pub async fn localsend_allow_firewall() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let exe = exe.to_string_lossy().to_string();
        if exe.contains('"') {
            return Err("unexpected program path".into());
        }
        let args = format!(
            "/c netsh advfirewall firewall delete rule name=all dir=in program=\"{exe}\" & netsh advfirewall firewall add rule name=\"Islander Nearby sharing\" dir=in action=allow program=\"{exe}\" enable=yes profile=any remoteip=localsubnet"
        );
        run_elevated("cmd.exe", &args)?;
        crate::log_line("localsend: firewall rule added".into());
        BLOCKED.store(0, Ordering::Relaxed);
        if let Some(s) = SERVICE.get() {
            s.recheck_inbound();
            s.announce();
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Runs a program as administrator (Windows shows its UAC prompt) and waits for it.
#[cfg(windows)]
fn run_elevated(file: &str, args: &str) -> Result<(), String> {
    use windows::core::HSTRING;
    use windows::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
    use windows::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject};
    use windows::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW};
    use windows::Win32::UI::WindowsAndMessaging::SW_HIDE;
    let (verb, file, args) = (HSTRING::from("runas"), HSTRING::from(file), HSTRING::from(args));
    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS,
        lpVerb: windows::core::PCWSTR(verb.as_ptr()),
        lpFile: windows::core::PCWSTR(file.as_ptr()),
        lpParameters: windows::core::PCWSTR(args.as_ptr()),
        nShow: SW_HIDE.0,
        ..Default::default()
    };
    unsafe {
        // Fails with ERROR_CANCELLED when the user says no to UAC.
        ShellExecuteExW(&mut info).map_err(|_| "cancelled".to_string())?;
        if info.hProcess.is_invalid() {
            return Err("couldn't start".into());
        }
        let ok = WaitForSingleObject(info.hProcess, 30_000) == WAIT_OBJECT_0;
        let mut code = 1u32;
        let _ = GetExitCodeProcess(info.hProcess, &mut code);
        let _ = CloseHandle(info.hProcess);
        if !ok {
            return Err("timed out".into());
        }
        if code != 0 {
            return Err(format!("netsh exit code {code}"));
        }
    }
    Ok(())
}

#[cfg(not(windows))]
fn run_elevated(_: &str, _: &str) -> Result<(), String> {
    Err("Windows only".into())
}

#[tauri::command]
pub fn localsend_send(fingerprint: String, paths: Vec<String>) -> Result<String, String> {
    let s = SERVICE.get().ok_or("Nearby sharing isn't running")?;
    if !s.enabled.load(Ordering::Relaxed) {
        return Err("Nearby sharing is off in Settings".into());
    }
    s.send(&fingerprint, paths.into_iter().map(PathBuf::from).collect())
}

#[tauri::command]
pub fn localsend_respond(id: String, accept: bool) {
    if let Some(tx) = PENDING.lock().unwrap().get_or_insert_with(HashMap::new).remove(&id) {
        let _ = tx.send(accept);
    }
}

#[tauri::command]
pub fn localsend_cancel(id: String) {
    if let Some(s) = SERVICE.get() {
        s.cancel(&id);
    }
}

/// For the Downloads activity's ✕ on a LocalSend row.
pub fn cancel(id: &str) {
    if let Some(s) = SERVICE.get() {
        s.cancel(id);
    }
}

#[tauri::command]
pub fn localsend_info() -> serde_json::Value {
    match SERVICE.get() {
        Some(s) => {
            let i = s.info.lock().unwrap().clone();
            serde_json::json!({ "alias": i.alias, "port": i.port, "enabled": s.enabled.load(Ordering::Relaxed), "saveDir": downloads_dir().to_string_lossy(), "blocked": BLOCKED.load(Ordering::Relaxed) == 2 })
        }
        None => serde_json::json!({ "alias": computer_name(), "enabled": false }),
    }
}
