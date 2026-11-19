//! Camera / microphone in-use detection for the privacy dots. Windows records
//! every app's capability use under CapabilityAccessManager\ConsentStore; an app
//! is using the device right now when its LastUsedTimeStop is 0 (and it has started).
use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct PrivacyState {
    pub camera: bool,
    pub mic: bool,
    pub apps: Vec<String>,
}

#[cfg(windows)]
pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || {
        // Live camera use comes from Windows' sensor activity monitor (the registry only
        // records camera sessions once they end); keep it alive for the thread's life.
        let _monitor = sensors::start();
        let mut last = PrivacyState::default();
        eprintln!("[privacy] recent camera use: {:?}", reg::recent("webcam"));
        loop {
            let mut cam = sensors::streaming_apps();
            cam.extend(reg::in_use("webcam"));
            let mic = reg::in_use("microphone");
            let mut apps: Vec<String> = cam.iter().chain(mic.iter()).cloned().collect();
            apps.sort();
            apps.dedup();
            let now = PrivacyState { camera: !cam.is_empty(), mic: !mic.is_empty(), apps };
            if now != last {
                eprintln!("[privacy] camera: {} · mic: {} {:?}", now.camera, now.mic, now.apps);
                let _ = app.emit("privacy://update", &now);
                last = now;
            }
            std::thread::sleep(std::time::Duration::from_millis(700));
        }
    });
}
#[cfg(not(windows))]
pub fn spawn(_app: AppHandle) {}

#[cfg(windows)]
pub mod reg {
    use windows::core::{HSTRING, PCWSTR, PWSTR};
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::*;

    const BASE: &str = r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore";

    pub struct Key(pub HKEY);
    impl Drop for Key {
        fn drop(&mut self) {
            unsafe {
                let _ = RegCloseKey(self.0);
            }
        }
    }

    pub fn open(root: HKEY, path: &str, access: REG_SAM_FLAGS) -> Option<Key> {
        let mut k = HKEY::default();
        let p = HSTRING::from(path);
        unsafe { (RegOpenKeyExW(root, PCWSTR(p.as_ptr()), None, access, &mut k) == ERROR_SUCCESS).then_some(Key(k)) }
    }

    pub fn subkeys(k: &Key) -> Vec<String> {
        let mut out = Vec::new();
        for i in 0.. {
            let mut buf = [0u16; 512];
            let mut len = buf.len() as u32;
            let r = unsafe { RegEnumKeyExW(k.0, i, Some(PWSTR(buf.as_mut_ptr())), &mut len, None, None, None, None) };
            if r != ERROR_SUCCESS {
                break;
            }
            out.push(String::from_utf16_lossy(&buf[..len as usize]));
        }
        out
    }

    pub fn qword(k: &Key, name: &str) -> Option<u64> {
        let n = HSTRING::from(name);
        let mut v = 0u64;
        let mut size = 8u32;
        let r = unsafe { RegGetValueW(k.0, PCWSTR::null(), PCWSTR(n.as_ptr()), RRF_RT_REG_QWORD, None, Some(&mut v as *mut u64 as *mut _), Some(&mut size)) };
        (r == ERROR_SUCCESS).then_some(v)
    }

    pub fn string(k: &Key, name: &str) -> Option<String> {
        let n = HSTRING::from(name);
        let mut buf = vec![0u16; 1024];
        let mut size = (buf.len() * 2) as u32;
        let r = unsafe { RegGetValueW(k.0, PCWSTR::null(), PCWSTR(n.as_ptr()), RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ, None, Some(buf.as_mut_ptr() as *mut _), Some(&mut size)) };
        if r != ERROR_SUCCESS {
            return None;
        }
        let len = (size as usize / 2).min(buf.len());
        let end = buf[..len].iter().position(|&c| c == 0).unwrap_or(len);
        Some(String::from_utf16_lossy(&buf[..end]))
    }

    pub fn dword(k: &Key, name: &str) -> Option<u32> {
        let n = HSTRING::from(name);
        let mut v = 0u32;
        let mut size = 4u32;
        let r = unsafe { RegGetValueW(k.0, PCWSTR::null(), PCWSTR(n.as_ptr()), RRF_RT_REG_DWORD, None, Some(&mut v as *mut u32 as *mut _), Some(&mut size)) };
        (r == ERROR_SUCCESS).then_some(v)
    }

    pub fn set_dword(k: &Key, name: &str, v: u32) -> bool {
        let n = HSTRING::from(name);
        unsafe { RegSetValueExW(k.0, PCWSTR(n.as_ptr()), None, REG_DWORD, Some(&v.to_le_bytes())) == ERROR_SUCCESS }
    }

    /// In use right now: it has started, and hasn't stopped since (Windows writes a 0
    /// stop time while in use, but some apps leave an older stop time behind).
    fn active(k: &Key) -> bool {
        match (qword(k, "LastUsedTimeStart"), qword(k, "LastUsedTimeStop")) {
            (Some(start), Some(stop)) => start > 0 && (stop == 0 || stop < start),
            (Some(start), None) => start > 0,
            _ => false,
        }
    }

    /// Friendly-ish app name from a ConsentStore key name.
    fn pretty(key: &str) -> String {
        // Desktop apps: "C:#Program Files#App#app.exe"; Store apps: "Microsoft.WindowsCamera_8wekyb3d8bbwe".
        let last = key.rsplit('#').next().unwrap_or(key);
        let last = last.split('_').next().unwrap_or(last);
        let last = last.trim_end_matches(".exe").trim_end_matches(".EXE");
        last.rsplit('.').next().unwrap_or(last).to_string()
    }

    /// Apps currently using `capability` ("webcam" | "microphone"). Windows records
    /// use per user (HKCU) and, for some apps and services, machine-wide (HKLM).
    pub fn in_use(capability: &str) -> Vec<String> {
        let mut apps = Vec::new();
        for root in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
            scan(root, capability, &mut apps);
        }
        apps.sort();
        apps.dedup();
        apps
    }

    /// Debug: the most recently used apps for a capability, with their raw times.
    pub fn recent(capability: &str) -> Vec<String> {
        let mut rows: Vec<(u64, String)> = Vec::new();
        for root in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
            let Some(r) = open(root, &format!(r"{BASE}\{capability}"), KEY_READ) else { continue };
            let mut visit = |k: &Key, name: &str| {
                if let Some(s) = qword(k, "LastUsedTimeStart") {
                    rows.push((s, format!("{} start={} stop={:?}", pretty(name), s, qword(k, "LastUsedTimeStop"))));
                }
            };
            for name in subkeys(&r) {
                let Some(k) = open(r.0, &name, KEY_READ) else { continue };
                if name == "NonPackaged" {
                    for sub in subkeys(&k) {
                        if let Some(s) = open(k.0, &sub, KEY_READ) {
                            visit(&s, &sub);
                        }
                    }
                } else {
                    visit(&k, &name);
                }
            }
        }
        rows.sort_by(|a, b| b.0.cmp(&a.0));
        rows.into_iter().take(3).map(|r| r.1).collect()
    }

    fn scan(base: HKEY, capability: &str, apps: &mut Vec<String>) {
        let Some(root) = open(base, &format!(r"{BASE}\{capability}"), KEY_READ) else { return };
        for name in subkeys(&root) {
            let Some(k) = open(root.0, &name, KEY_READ) else { continue };
            if name == "NonPackaged" {
                for sub in subkeys(&k) {
                    if let Some(s) = open(k.0, &sub, KEY_READ) {
                        if active(&s) {
                            apps.push(pretty(&sub));
                        }
                    }
                }
            } else if active(&k) {
                apps.push(pretty(&name));
            }
        }
    }
}

/// Live camera activity via Media Foundation's sensor activity monitor: Windows
/// reports which processes are streaming from each camera, as it happens.
#[cfg(windows)]
mod sensors {
    use std::collections::HashSet;
    use std::sync::Mutex;
    use windows::core::{implement, Ref};
    use windows::Win32::Media::MediaFoundation::*;

    static STREAMING: Mutex<Option<HashSet<u32>>> = Mutex::new(None);

    #[implement(IMFSensorActivitiesReportCallback)]
    struct Watcher;

    impl IMFSensorActivitiesReportCallback_Impl for Watcher_Impl {
        fn OnActivitiesReport(&self, report: Ref<'_, IMFSensorActivitiesReport>) -> windows::core::Result<()> {
            let mut pids = HashSet::new();
            if let Some(report) = report.as_ref() {
                unsafe {
                    for i in 0..report.GetCount().unwrap_or(0) {
                        let Ok(device) = report.GetActivityReport(i) else { continue };
                        for j in 0..device.GetProcessCount().unwrap_or(0) {
                            let Ok(p) = device.GetProcessActivity(j) else { continue };
                            if p.GetStreamingState().map(|b| b.as_bool()).unwrap_or(false) {
                                if let Ok(pid) = p.GetProcessId() {
                                    pids.insert(pid);
                                }
                            }
                        }
                    }
                }
            }
            *STREAMING.lock().unwrap() = Some(pids);
            Ok(())
        }
    }

    /// Starts watching; returns the monitor (dropping it stops the reports).
    pub fn start() -> Option<IMFSensorActivityMonitor> {
        unsafe {
            if let Err(e) = MFStartup(MF_VERSION, MFSTARTUP_FULL) {
                eprintln!("[privacy] camera monitor unavailable ({e})");
                return None;
            }
            let cb: IMFSensorActivitiesReportCallback = Watcher.into();
            match MFCreateSensorActivityMonitor(&cb).and_then(|m| m.Start().map(|_| m)) {
                Ok(m) => Some(m),
                Err(e) => {
                    eprintln!("[privacy] camera monitor unavailable ({e})");
                    None
                }
            }
        }
    }

    /// Names of the apps streaming from a camera right now.
    pub fn streaming_apps() -> Vec<String> {
        let pids: Vec<u32> = STREAMING.lock().unwrap().as_ref().map(|s| s.iter().copied().collect()).unwrap_or_default();
        pids.into_iter()
            .map(|pid| {
                let stem = crate::audio::meters::exe_stem(pid).0;
                if stem.is_empty() { format!("pid {pid}") } else { stem }
            })
            .collect()
    }
}
