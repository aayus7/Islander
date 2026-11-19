//! Power & display: battery status (with "Charging" / "Low Battery" live activities)
//! and screen brightness — WMI for built-in laptop screens, DDC/CI for monitors.
use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct PowerStatus {
    pub has_battery: bool,
    pub charging: bool,
    pub percent: u8,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PowerAlert {
    /// "charging" | "unplugged" | "low"
    pub kind: &'static str,
    pub percent: u8,
}

#[cfg(windows)]
pub fn status() -> PowerStatus {
    use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
    let mut s = SYSTEM_POWER_STATUS::default();
    unsafe {
        if GetSystemPowerStatus(&mut s).is_err() {
            return PowerStatus::default();
        }
    }
    let has_battery = s.BatteryFlag != 128 && s.BatteryFlag != 255 && s.BatteryLifePercent != 255;
    PowerStatus { has_battery, charging: has_battery && s.ACLineStatus == 1, percent: if has_battery { s.BatteryLifePercent.min(100) } else { 100 } }
}
#[cfg(not(windows))]
pub fn status() -> PowerStatus {
    PowerStatus::default()
}

/// Watches the battery: plugging in shows "Charging", dropping to 20 % / 10 % on
/// battery shows "Low Battery".
pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last = status();
        let mut warned_at: u8 = 101;
        loop {
            std::thread::sleep(std::time::Duration::from_millis(400));
            let now = status();
            if now == last {
                continue;
            }
            let _ = app.emit("power://status", &now);
            if now.has_battery {
                if now.charging && !last.charging {
                    let _ = app.emit("power://alert", PowerAlert { kind: "charging", percent: now.percent });
                    warned_at = 101;
                } else if !now.charging && last.charging {
                    let _ = app.emit("power://alert", PowerAlert { kind: "unplugged", percent: now.percent });
                }
                if !now.charging && now.percent <= 20 && (warned_at > 20 || (now.percent <= 10 && warned_at > 10)) {
                    warned_at = now.percent;
                    let _ = app.emit("power://alert", PowerAlert { kind: "low", percent: now.percent });
                }
            }
            last = now;
        }
    });
}

#[tauri::command]
pub fn power_status() -> PowerStatus {
    status()
}

/* ---------------- brightness ---------------- */

#[cfg(windows)]
mod bright {
    use windows::core::{BSTR, PCWSTR};
    use windows::Win32::System::Com::*;
    use windows::Win32::System::Variant::{VARIANT, VT_I4, VT_UI1};
    use windows::Win32::System::Wmi::*;

    fn com() {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            // NB: no CoInitializeSecurity here — it's process-wide and broke Explorer
            // → island drag-and-drop. The WMI proxy gets its own security instead.
        }
    }

    fn services() -> Option<IWbemServices> {
        unsafe {
            let loc: IWbemLocator = CoCreateInstance(&WbemLocator, None, CLSCTX_INPROC_SERVER).ok()?;
            let svc = loc.ConnectServer(&BSTR::from("ROOT\\WMI"), &BSTR::new(), &BSTR::new(), &BSTR::new(), 0, &BSTR::new(), None::<&IWbemContext>).ok()?;
            // RPC_C_AUTHN_WINNT = 10, RPC_C_AUTHZ_NONE = 0
            let _ = CoSetProxyBlanket(&svc, 10, 0, PCWSTR::null(), RPC_C_AUTHN_LEVEL_CALL, RPC_C_IMP_LEVEL_IMPERSONATE, None, EOAC_NONE);
            Some(svc)
        }
    }

    fn first(svc: &IWbemServices, query: &str) -> Option<IWbemClassObject> {
        unsafe {
            let e = svc
                .ExecQuery(&BSTR::from("WQL"), &BSTR::from(query), WBEM_GENERIC_FLAG_TYPE(WBEM_FLAG_FORWARD_ONLY.0 | WBEM_FLAG_RETURN_IMMEDIATELY.0), None::<&IWbemContext>)
                .ok()?;
            let mut objs = [None];
            let mut n = 0u32;
            let _ = e.Next(WBEM_INFINITE, &mut objs, &mut n);
            if n == 0 {
                return None;
            }
            objs[0].take()
        }
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }

    /// Built-in screen (laptops) via WMI.
    pub fn wmi_get() -> Option<u8> {
        com();
        let svc = services()?;
        let obj = first(&svc, "SELECT CurrentBrightness FROM WmiMonitorBrightness WHERE Active=TRUE")?;
        let mut v = VARIANT::default();
        let name = wide("CurrentBrightness");
        unsafe {
            obj.Get(PCWSTR(name.as_ptr()), 0, &mut v, None, None).ok()?;
            Some(v.Anonymous.Anonymous.Anonymous.bVal)
        }
    }

    pub fn wmi_set(level: u8) -> bool {
        com();
        let Some(svc) = services() else { return false };
        let Some(inst) = first(&svc, "SELECT * FROM WmiMonitorBrightnessMethods WHERE Active=TRUE") else { return false };
        unsafe {
            let mut path = VARIANT::default();
            let p = wide("__PATH");
            if inst.Get(PCWSTR(p.as_ptr()), 0, &mut path, None, None).is_err() {
                return false;
            }
            let path: BSTR = (*path.Anonymous.Anonymous.Anonymous.bstrVal).clone();
            let mut class = None;
            if svc.GetObject(&BSTR::from("WmiMonitorBrightnessMethods"), WBEM_GENERIC_FLAG_TYPE(0), None::<&IWbemContext>, Some(&mut class), None).is_err() {
                return false;
            }
            let Some(class) = class else { return false };
            let m = wide("WmiSetBrightness");
            let mut in_def = None;
            let mut out_def = None;
            if class.GetMethod(PCWSTR(m.as_ptr()), 0, &mut in_def, &mut out_def).is_err() {
                return false;
            }
            let Some(in_def) = in_def else { return false };
            let Ok(args) = in_def.SpawnInstance(0) else { return false };
            let mut timeout = VARIANT::default();
            (*timeout.Anonymous.Anonymous).vt = VT_I4;
            (*timeout.Anonymous.Anonymous).Anonymous.lVal = 1;
            let mut val = VARIANT::default();
            (*val.Anonymous.Anonymous).vt = VT_UI1;
            (*val.Anonymous.Anonymous).Anonymous.bVal = level.min(100);
            let t = wide("Timeout");
            let b = wide("Brightness");
            let _ = args.Put(PCWSTR(t.as_ptr()), 0, &timeout, 0);
            let _ = args.Put(PCWSTR(b.as_ptr()), 0, &val, 0);
            svc.ExecMethod(&path, &BSTR::from("WmiSetBrightness"), WBEM_GENERIC_FLAG_TYPE(0), None::<&IWbemContext>, &args, None, None).is_ok()
        }
    }

    /// External monitors via DDC/CI (the monitor's own brightness setting).
    pub fn ddc(set: Option<u8>) -> Option<u8> {
        use windows::Win32::Devices::Display::*;
        use windows::Win32::Foundation::POINT;
        use windows::Win32::Graphics::Gdi::{MonitorFromPoint, HMONITOR, MONITOR_DEFAULTTOPRIMARY};
        unsafe {
            let mon: HMONITOR = MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY);
            let mut n = 0u32;
            GetNumberOfPhysicalMonitorsFromHMONITOR(mon, &mut n).ok()?;
            if n == 0 {
                return None;
            }
            let mut mons = vec![PHYSICAL_MONITOR::default(); n as usize];
            GetPhysicalMonitorsFromHMONITOR(mon, &mut mons).ok()?;
            let mut result = None;
            for m in &mons {
                let (mut lo, mut cur, mut hi) = (0u32, 0u32, 0u32);
                if GetMonitorBrightness(m.hPhysicalMonitor, &mut lo, &mut cur, &mut hi) == 0 || hi <= lo {
                    continue;
                }
                match set {
                    Some(level) => {
                        let v = lo + (hi - lo) * level.min(100) as u32 / 100;
                        SetMonitorBrightness(m.hPhysicalMonitor, v);
                        result = Some(level);
                    }
                    None => {
                        result = Some((((cur - lo) * 100) / (hi - lo)).min(100) as u8);
                    }
                }
                break;
            }
            let _ = DestroyPhysicalMonitors(&mons);
            result
        }
    }
}

#[tauri::command]
pub async fn brightness_get() -> Option<u8> {
    #[cfg(windows)]
    return tauri::async_runtime::spawn_blocking(|| bright::wmi_get().or_else(|| bright::ddc(None))).await.ok().flatten();
    #[allow(unreachable_code)]
    None
}

#[tauri::command]
pub async fn brightness_set(level: u8) -> bool {
    #[cfg(windows)]
    return tauri::async_runtime::spawn_blocking(move || bright::wmi_set(level) || bright::ddc(Some(level)).is_some()).await.unwrap_or(false);
    #[allow(unreachable_code)]
    {
        let _ = level;
        false
    }
}

/* ---------------- volume (Controls slider) ---------------- */

#[derive(Serialize, Clone, Default)]
pub struct Volume {
    pub level: f32,
    pub muted: bool,
}

#[tauri::command]
pub async fn volume_get() -> Volume {
    #[cfg(windows)]
    return tauri::async_runtime::spawn_blocking(|| unsafe {
        let _ = windows::Win32::System::Com::CoInitializeEx(None, windows::Win32::System::Com::COINIT_MULTITHREADED);
        crate::hud::imp::endpoint()
            .map(|(v, _)| Volume { level: v.GetMasterVolumeLevelScalar().unwrap_or(0.0), muted: v.GetMute().map(|m| m.as_bool()).unwrap_or(false) })
            .unwrap_or_default()
    })
    .await
    .unwrap_or_default();
    #[allow(unreachable_code)]
    Volume::default()
}

#[tauri::command]
pub async fn volume_set(level: f32) {
    #[cfg(windows)]
    let _ = tauri::async_runtime::spawn_blocking(move || unsafe {
        let _ = windows::Win32::System::Com::CoInitializeEx(None, windows::Win32::System::Com::COINIT_MULTITHREADED);
        if let Some((v, _)) = crate::hud::imp::endpoint() {
            let _ = v.SetMasterVolumeLevelScalar(level.clamp(0.0, 1.0), std::ptr::null());
            if level > 0.0 {
                let _ = v.SetMute(false, std::ptr::null());
            }
        }
    })
    .await;
    #[cfg(not(windows))]
    let _ = level;
}
