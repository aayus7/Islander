//! Bluetooth / wireless device batteries (headphones, controllers, mice). Windows
//! exposes the level as a device property; we check every 30 s and raise a banner
//! when a device shows up or drops below 20 %.
use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Clone)]
pub struct BatteryAlert {
    pub name: String,
    pub level: u8,
    pub low: bool,
}

#[cfg(windows)]
pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || imp::run(app));
}
#[cfg(not(windows))]
pub fn spawn(_app: AppHandle) {}

#[cfg(windows)]
mod imp {
    use super::*;
    use std::collections::HashMap;
    use std::time::Duration;
    use windows::core::{Interface, HSTRING};
    use windows::Devices::Enumeration::{DeviceInformation, DeviceInformationKind};
    use windows_collections::IIterable;
    use windows::Foundation::IPropertyValue;

    /// DEVPKEY_Bluetooth_Battery
    const BATTERY: &str = "{104EA319-6EE2-4701-BD47-8DDBF425BBE5} 2";

    fn scan() -> HashMap<String, u8> {
        let mut out = HashMap::new();
        let props: IIterable<HSTRING> = vec![HSTRING::from(BATTERY)].into();
        let Ok(list) = DeviceInformation::FindAllAsyncWithKindAqsFilterAndAdditionalProperties(&HSTRING::new(), &props, DeviceInformationKind::Device).and_then(|op| op.get())
        else {
            return out;
        };
        let key = HSTRING::from(BATTERY);
        for d in list {
            let Ok(map) = d.Properties() else { continue };
            if !map.HasKey(&key).unwrap_or(false) {
                continue;
            }
            let Ok(v) = map.Lookup(&key) else { continue };
            let Ok(pv) = v.cast::<IPropertyValue>() else { continue };
            let level = pv.GetUInt8().ok().or_else(|| pv.GetUInt32().ok().map(|x| x.min(100) as u8));
            let (Some(level), Ok(name)) = (level, d.Name()) else { continue };
            if level <= 100 {
                out.insert(name.to_string(), level);
            }
        }
        out
    }

    pub fn run(app: AppHandle) {
        unsafe {
            use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        // First pass only records what's there (no banner storm at startup).
        let mut known = scan();
        loop {
            std::thread::sleep(Duration::from_secs(30));
            let now = scan();
            for (name, &level) in &now {
                let alert = match known.get(name) {
                    None => Some(BatteryAlert { name: name.clone(), level, low: level <= 20 }),
                    Some(&prev) if prev > 20 && level <= 20 => Some(BatteryAlert { name: name.clone(), level, low: true }),
                    _ => None,
                };
                if let Some(a) = alert {
                    let _ = app.emit("battery://alert", a);
                }
            }
            known = now;
        }
    }
}
