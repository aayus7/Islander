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
        let mut last = PrivacyState::default();
        loop {
            let cam = reg::in_use("webcam");
            let mic = reg::in_use("microphone");
            let mut apps: Vec<String> = cam.iter().chain(mic.iter()).cloned().collect();
            apps.sort();
            apps.dedup();
            let now = PrivacyState { camera: !cam.is_empty(), mic: !mic.is_empty(), apps };
            if now != last {
                let _ = app.emit("privacy://update", &now);
                last = now;
            }
            std::thread::sleep(std::time::Duration::from_millis(1200));
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

    fn active(k: &Key) -> bool {
        matches!((qword(k, "LastUsedTimeStart"), qword(k, "LastUsedTimeStop")), (Some(s), Some(0)) if s > 0)
    }

    /// Friendly-ish app name from a ConsentStore key name.
    fn pretty(key: &str) -> String {
        // Desktop apps: "C:#Program Files#App#app.exe"; Store apps: "Microsoft.WindowsCamera_8wekyb3d8bbwe".
        let last = key.rsplit('#').next().unwrap_or(key);
        let last = last.split('_').next().unwrap_or(last);
        let last = last.trim_end_matches(".exe").trim_end_matches(".EXE");
        last.rsplit('.').next().unwrap_or(last).to_string()
    }

    /// Apps currently using `capability` ("webcam" | "microphone").
    pub fn in_use(capability: &str) -> Vec<String> {
        let mut apps = Vec::new();
        let Some(root) = open(HKEY_CURRENT_USER, &format!(r"{BASE}\{capability}"), KEY_READ) else { return apps };
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
        apps
    }
}
