//! Download managers in the island: Mister Download Manager and Internet Download Manager.
//!
//! - **MDM** has a local automation API: `%APPDATA%\misterdownloadmanager\ipc.json` gives a
//!   127.0.0.1 port and a token; one JSON line `{"token", "query": "list"}` returns every
//!   download with its status, size, bytes done, speed and full path. The API is off by
//!   default, so Islander turns it on (`{"api": true}`) the first time it finds MDM.
//! - **IDM** has no API. While it downloads, each download has a progress window titled
//!   "37% file.zip" (also when the window is hidden), and finished downloads are listed in
//!   `HKCU\Software\DownloadManager\<n>` with their `LocalFileName`. Islander follows the
//!   titles and, when one closes, checks that the file arrived where IDM saves it.
//!
//! Both feed the same downloads list as the browser extension (`downloads://update`), so the
//! island shows them the same way, and a finished one opens its folder on click.

use crate::ext::Download;
use std::collections::HashMap;
use std::time::{Duration, Instant};

/// How long a finished download stays in the list (long enough for the island to announce it).
const DONE_FOR: Duration = Duration::from_secs(8);

pub fn spawn() {
    std::thread::spawn(|| {
        let mut mdm = Mdm::default();
        let mut idm = Idm::default();
        let mut last = String::new();
        loop {
            let mut items = Vec::new();
            mdm.poll(&mut items);
            #[cfg(windows)]
            idm.poll(&mut items);
            #[cfg(not(windows))]
            let _ = &mut idm;
            // Only tell the island when something changed.
            let sig = items.iter().map(|d| format!("{}|{}|{}|{}|{}", d.id, d.received as u64, d.total as u64, d.state, d.speed as u64)).collect::<Vec<_>>().join(";");
            if sig != last {
                last = sig;
                crate::ext::emit_downloads("download-managers", Some(items));
            }
            std::thread::sleep(Duration::from_millis(600));
        }
    });
}

/* ------------------------------------------------------------------ MDM */

#[derive(Default)]
struct Mdm {
    /// When we last asked MDM to turn its API on.
    api_asked: Option<Instant>,
    /// The running downloads from MDM's last answer, and when it answered. If MDM is slow to
    /// answer for a moment (minimized, busy), the island keeps showing these instead of
    /// dropping the download and losing track of it.
    last_running: Vec<Download>,
    last_ok: Option<Instant>,
    failing: bool,
    /// Downloads seen running: id → (name, path, size).
    watching: HashMap<u64, (String, String, f64)>,
    /// Finished while we watched: id → (item, when).
    done: HashMap<u64, (Download, Instant)>,
}

#[derive(serde::Deserialize)]
struct Endpoint {
    port: u16,
    token: String,
}

#[derive(serde::Deserialize)]
struct MdmList {
    downloads: Vec<MdmItem>,
}

#[derive(serde::Deserialize)]
struct MdmItem {
    id: u64,
    #[serde(default)]
    file: String,
    #[serde(default)]
    path: String,
    #[serde(default)]
    status: String,
    size: Option<u64>,
    #[serde(default)]
    downloaded: u64,
    #[serde(default)]
    speed: u64,
}

impl Mdm {
    fn ask(ep: &Endpoint, body: serde_json::Value) -> Option<String> {
        use std::io::{BufRead, BufReader, Write};
        let addr = std::net::SocketAddr::from(([127, 0, 0, 1], ep.port));
        let mut s = std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(250)).ok()?;
        s.set_read_timeout(Some(Duration::from_millis(3000))).ok();
        s.set_write_timeout(Some(Duration::from_millis(500))).ok();
        let mut msg = body;
        msg["token"] = serde_json::Value::String(ep.token.clone());
        s.write_all(format!("{msg}\n").as_bytes()).ok()?;
        let mut line = String::new();
        BufReader::new(s).read_line(&mut line).ok()?;
        Some(line.trim_end().to_string())
    }

    fn poll(&mut self, out: &mut Vec<Download>) {
        self.done.retain(|_, (_, t)| t.elapsed() < DONE_FOR);
        out.extend(self.done.values().map(|(d, _)| d.clone()));

        let Some(path) = std::env::var_os("APPDATA").map(|d| std::path::PathBuf::from(d).join("misterdownloadmanager").join("ipc.json")) else { return };
        let Ok(bytes) = std::fs::read(&path) else { return };
        let Ok(ep) = serde_json::from_slice::<Endpoint>(&bytes) else { return };
        // A moment without an answer: keep showing what MDM last reported (for a while), so a
        // slow reply doesn't drop the download from the island.
        let hold = |me: &mut Self, out: &mut Vec<Download>, why: &str| {
            if !me.failing {
                me.failing = true;
                crate::log_line(format!("dlmgr: Mister Download Manager didn't answer ({why}); holding its last state"));
            }
            if me.last_ok.is_some_and(|t| t.elapsed() < Duration::from_secs(20)) {
                out.extend(me.last_running.iter().cloned());
            }
        };
        let Some(answer) = Self::ask(&ep, serde_json::json!({ "query": "list" })) else {
            hold(self, out, "no reply");
            return;
        };
        if answer.contains("api-off") {
            // MDM's automation API is off by default, and MDM can switch it off again (it did
            // when its window was minimized): turn it back on whenever that happens, not just
            // once per run, or the island would lose MDM for good.
            if self.api_asked.is_none_or(|t| t.elapsed() > Duration::from_secs(3)) {
                self.api_asked = Some(Instant::now());
                let _ = Self::ask(&ep, serde_json::json!({ "api": true }));
                crate::log_line("dlmgr: turned on Mister Download Manager's automation API".into());
            }
            hold(self, out, "API off");
            return;
        }
        let Ok(list) = serde_json::from_str::<MdmList>(&answer) else {
            hold(self, out, "unreadable reply");
            return;
        };
        if self.failing {
            self.failing = false;
            crate::log_line("dlmgr: Mister Download Manager answering again".into());
        }
        let first = out.len();

        let mut seen = std::collections::HashSet::new();
        for d in &list.downloads {
            let total = d.size.unwrap_or(0) as f64;
            match d.status.as_str() {
                "Downloading" => {
                    seen.insert(d.id);
                    self.watching.insert(d.id, (d.file.clone(), d.path.clone(), total));
                    out.push(Download {
                        id: format!("mdm-{}", d.id),
                        name: d.file.clone(),
                        path: d.path.clone(),
                        received: d.downloaded as f64,
                        total,
                        state: "in_progress".into(),
                        browser: "MDM".into(),
                        speed: d.speed as f64,
                    });
                }
                "Complete" if self.watching.contains_key(&d.id) => {
                    self.watching.remove(&d.id);
                    let size = if total > 0.0 { total } else { d.downloaded as f64 };
                    let item = Download {
                        id: format!("mdm-{}", d.id),
                        name: d.file.clone(),
                        path: d.path.clone(),
                        received: size,
                        total: size,
                        state: "complete".into(),
                        browser: "MDM".into(),
                        speed: 0.0,
                    };
                    out.push(item.clone());
                    self.done.insert(d.id, (item, Instant::now()));
                }
                _ => {}
            }
        }
        // Paused, failed or removed: stop following.
        self.watching.retain(|id, _| seen.contains(id) || list.downloads.iter().any(|d| d.id == *id && d.status == "Complete"));
        self.last_running = out[first..].iter().filter(|d| d.state == "in_progress").cloned().collect();
        self.last_ok = Some(Instant::now());
    }
}

/// Cancel a download from the island (the ✕ in the Downloads page).
#[tauri::command]
pub fn download_cancel(id: String, browser: String, name: String) -> Result<(), String> {
    std::thread::spawn(move || {
        let r = match browser.as_str() {
            "MDM" => match id.strip_prefix("mdm-").and_then(|n| n.parse::<u64>().ok()) {
                Some(n) => mdm_cancel(n),
                None => Err("bad id".into()),
            },
            #[cfg(windows)]
            "IDM" => idm_cancel(&name),
            b if b.starts_with("from:") || b.starts_with("to:") => {
                crate::localsend::cancel(&id);
                Ok(())
            }
            b => crate::ext::send_raw(b, serde_json::json!({ "type": "dl_cancel", "id": id }).to_string()),
        };
        if let Err(e) = r {
            eprintln!("[dlmgr] cancel {name}: {e}");
        }
    });
    Ok(())
}

/// MDM: pause it, then delete it with its partial file (a running one can't be deleted).
fn mdm_cancel(n: u64) -> Result<(), String> {
    let path = std::env::var_os("APPDATA").map(|d| std::path::PathBuf::from(d).join("misterdownloadmanager").join("ipc.json")).ok_or("no APPDATA")?;
    let ep: Endpoint = serde_json::from_slice(&std::fs::read(&path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    Mdm::ask(&ep, serde_json::json!({ "action": "pause", "ids": [n] })).ok_or("MDM didn't answer")?;
    for _ in 0..10 {
        std::thread::sleep(Duration::from_millis(250));
        let answer = Mdm::ask(&ep, serde_json::json!({ "action": "delete", "ids": [n] })).unwrap_or_default();
        if answer.contains(&format!("[{n}]")) || answer.contains("no such download") {
            return Ok(());
        }
    }
    Err("MDM kept it".into())
}

/// IDM: press the Cancel button of its progress window.
#[cfg(windows)]
fn idm_cancel(name: &str) -> Result<(), String> {
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{EnumChildWindows, EnumWindows, GetWindowTextW, GetWindowThreadProcessId, PostMessageW, SendMessageTimeoutW, BM_CLICK, SMTO_ABORTIFHUNG, WM_GETTEXT};
    struct Find {
        name: String,
        win: Option<HWND>,
    }
    unsafe extern "system" fn top(hwnd: HWND, lp: LPARAM) -> BOOL {
        let f = &mut *(lp.0 as *mut Find);
        let mut buf = [0u16; 512];
        let n = GetWindowTextW(hwnd, &mut buf);
        let title = String::from_utf16_lossy(&buf[..n.max(0) as usize]);
        if title.split_once("% ").is_some_and(|(_, rest)| rest.trim() == f.name) {
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid as *mut u32));
            if crate::audio::meters::exe_stem(pid).0 == "idman" {
                f.win = Some(hwnd);
                return BOOL(0);
            }
        }
        BOOL(1)
    }
    unsafe extern "system" fn child(hwnd: HWND, lp: LPARAM) -> BOOL {
        let out = &mut *(lp.0 as *mut Option<HWND>);
        let mut buf = [0u16; 64];
        let mut got = 0usize;
        let _ = SendMessageTimeoutW(hwnd, WM_GETTEXT, WPARAM(buf.len()), LPARAM(buf.as_mut_ptr() as isize), SMTO_ABORTIFHUNG, 50, Some(&mut got as *mut usize));
        let text = String::from_utf16_lossy(&buf[..got.min(buf.len())]).replace('&', "").to_lowercase();
        if text.trim() == "cancel" {
            *out = Some(hwnd);
            return BOOL(0);
        }
        BOOL(1)
    }
    let mut f = Find { name: name.to_string(), win: None };
    unsafe {
        let _ = EnumWindows(Some(top), LPARAM(&mut f as *mut Find as isize));
        let win = f.win.ok_or("IDM's progress window isn't open")?;
        let mut btn: Option<HWND> = None;
        let _ = EnumChildWindows(Some(win), Some(child), LPARAM(&mut btn as *mut Option<HWND> as isize));
        let btn = btn.ok_or("no Cancel button")?;
        PostMessageW(Some(btn), BM_CLICK, WPARAM(0), LPARAM(0)).map_err(|e| e.to_string())
    }
}

/* ------------------------------------------------------------------ IDM */

#[derive(Default)]
struct Idm {
    /// IDM's process ids (checked by exe name, cached).
    pids: HashMap<u32, bool>,
    /// Downloads seen in progress: name → (last percent, first seen).
    watching: HashMap<String, (f64, std::time::SystemTime)>,
    done: HashMap<String, (Download, Instant)>,
}

#[cfg(windows)]
impl Idm {
    fn poll(&mut self, out: &mut Vec<Download>) {
        self.done.retain(|_, (_, t)| t.elapsed() < DONE_FOR);
        out.extend(self.done.values().map(|(d, _)| d.clone()));

        let windows = idm_progress_windows(&mut self.pids);
        let now = Instant::now();
        for (name, pct, speed) in &windows {
            let first = self.watching.get(name).map_or_else(std::time::SystemTime::now, |w| w.1);
            self.watching.insert(name.clone(), (*pct, first));
            out.push(Download {
                id: format!("idm-{name}"),
                name: name.clone(),
                path: String::new(),
                received: *pct,
                total: 100.0,
                state: "in_progress".into(),
                browser: "IDM".into(),
                speed: *speed,
            });
        }
        // A progress window that closed: finished if the file is now where IDM saves it.
        let gone: Vec<String> = self.watching.keys().filter(|n| !windows.iter().any(|(w, _, _)| w == *n)).cloned().collect();
        for name in gone {
            let Some((pct, since)) = self.watching.remove(&name) else { continue };
            if let Some(path) = idm_saved_file(&name, pct, since) {
                let size = std::fs::metadata(&path).map(|m| m.len() as f64).unwrap_or(0.0);
                let item = Download {
                    id: format!("idm-{name}"),
                    name: name.clone(),
                    path,
                    received: size,
                    total: size,
                    state: "complete".into(),
                    browser: "IDM".into(),
                    speed: 0.0,
                };
                out.push(item.clone());
                self.done.insert(name, (item, now));
            }
        }
    }
}

/// IDM's progress windows: (file name, percent, bytes/s).
#[cfg(windows)]
fn idm_progress_windows(pids: &mut HashMap<u32, bool>) -> Vec<(String, f64, f64)> {
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{EnumWindows, GetWindowTextW, GetWindowThreadProcessId};

    struct Scan<'a> {
        pids: &'a mut HashMap<u32, bool>,
        found: Vec<(HWND, String)>,
    }
    unsafe extern "system" fn visit(hwnd: HWND, lp: LPARAM) -> BOOL {
        let s = &mut *(lp.0 as *mut Scan);
        let mut buf = [0u16; 512];
        let n = GetWindowTextW(hwnd, &mut buf);
        if n <= 2 || !buf[..n as usize].contains(&('%' as u16)) {
            return BOOL(1);
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid as *mut u32));
        let is_idm = *s.pids.entry(pid).or_insert_with(|| crate::audio::meters::exe_stem(pid).0 == "idman");
        if is_idm {
            s.found.push((hwnd, String::from_utf16_lossy(&buf[..n as usize])));
        }
        BOOL(1)
    }
    let mut scan = Scan { pids, found: Vec::new() };
    unsafe {
        let _ = EnumWindows(Some(visit), LPARAM(&mut scan as *mut Scan as isize));
    }
    if scan.pids.len() > 256 {
        scan.pids.clear();
    }
    scan.found
        .into_iter()
        .filter_map(|(hwnd, title)| {
            // "37% file.zip" or "37.52% file.zip"
            let (pct, name) = title.split_once("% ")?;
            let pct: f64 = pct.trim().replace(',', ".").parse().ok()?;
            let name = name.trim().to_string();
            if name.is_empty() || !(0.0..=100.0).contains(&pct) {
                return None;
            }
            Some((name, pct, idm_speed(hwnd)))
        })
        .collect()
}

/// The "Transfer rate" line of an IDM progress window ("1.234 MB/sec"), in bytes/s.
#[cfg(windows)]
fn idm_speed(win: windows::Win32::Foundation::HWND) -> f64 {
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{EnumChildWindows, SendMessageTimeoutW, SMTO_ABORTIFHUNG, WM_GETTEXT};
    unsafe extern "system" fn visit(hwnd: HWND, lp: LPARAM) -> BOOL {
        let out = &mut *(lp.0 as *mut f64);
        let mut buf = [0u16; 128];
        let mut got = 0usize;
        // Text of a control in another process: ask it (GetWindowText only reads captions).
        let _ = SendMessageTimeoutW(hwnd, WM_GETTEXT, WPARAM(buf.len()), LPARAM(buf.as_mut_ptr() as isize), SMTO_ABORTIFHUNG, 50, Some(&mut got as *mut usize));
        let text = String::from_utf16_lossy(&buf[..got.min(buf.len())]);
        if let Some(v) = parse_rate(&text) {
            *out = v;
            return BOOL(0);
        }
        BOOL(1)
    }
    let mut speed = 0.0f64;
    unsafe {
        let _ = EnumChildWindows(Some(win), Some(visit), LPARAM(&mut speed as *mut f64 as isize));
    }
    speed
}

/// "1.234 MB/sec", "512 KB/sec", "3,2 MB/s" → bytes per second.
fn parse_rate(text: &str) -> Option<f64> {
    let t = text.trim();
    let lower = t.to_lowercase();
    if !(lower.contains("/sec") || lower.ends_with("/s")) {
        return None;
    }
    let num: String = t.chars().take_while(|c| c.is_ascii_digit() || *c == '.' || *c == ',').collect();
    let v: f64 = num.replace(',', ".").parse().ok()?;
    let mult = if lower.contains("gb") {
        1e9
    } else if lower.contains("mb") {
        1e6
    } else if lower.contains("kb") {
        1e3
    } else {
        1.0
    };
    Some(v * mult)
}

/// Where IDM saved `name`: the newest `LocalFileName` in its download list with that file
/// name, if the file is there now (IDM moves it into place only once it's complete).
/// `last_pct` and `since` (when we first saw it downloading) tell this download's file
/// from an older one of the same name.
#[cfg(windows)]
fn idm_saved_file(name: &str, last_pct: f64, since: std::time::SystemTime) -> Option<String> {
    use crate::privacy::reg;
    use windows::Win32::System::Registry::{HKEY_CURRENT_USER, KEY_READ};
    let root = reg::open(HKEY_CURRENT_USER, r"Software\DownloadManager", KEY_READ)?;
    let want = name.to_lowercase();
    let mut best: Option<(std::time::SystemTime, String)> = None;
    for sub in reg::subkeys(&root) {
        if !sub.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        let Some(k) = reg::open(HKEY_CURRENT_USER, &format!(r"Software\DownloadManager\{sub}"), KEY_READ) else { continue };
        let Some(path) = reg::string(&k, "LocalFileName") else { continue };
        let file = std::path::Path::new(&path).file_name().map(|f| f.to_string_lossy().to_lowercase()).unwrap_or_default();
        if file != want {
            continue;
        }
        let Ok(meta) = std::fs::metadata(&path) else { continue };
        let modified = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
        let created = meta.created().unwrap_or(std::time::UNIX_EPOCH);
        // Only the file from this download counts, not an older one of the same name: it was
        // written while we watched, or the download had just about finished.
        let cutoff = since - Duration::from_secs(60);
        if modified.max(created) < cutoff && last_pct < 99.0 {
            continue;
        }
        if best.as_ref().map_or(true, |(t, _)| modified > *t) {
            best = Some((modified, path));
        }
    }
    best.map(|(_, p)| p)
}

#[cfg(test)]
mod tests {
    #[test]
    fn rates() {
        assert_eq!(super::parse_rate("1.5 MB/sec"), Some(1.5e6));
        assert_eq!(super::parse_rate("512 KB/sec"), Some(512e3));
        assert_eq!(super::parse_rate("Downloaded 3 MB"), None);
    }
}
