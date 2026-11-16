//! Audio output devices: list them and switch the Windows default (speakers ⇄ headphones).
//!
//! Listing uses the public Core Audio API. Windows has no *public* API to change the
//! default device, so — like every audio switcher (EarTrumpet, SoundSwitch, …) — this
//! uses the long-standing system interface IPolicyConfig that the Sound settings use.
use serde::Serialize;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OutputDevice {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

#[cfg(windows)]
mod imp {
    use super::OutputDevice;
    use std::ffi::c_void;
    use windows::core::{GUID, HRESULT, PCWSTR};
    use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
    use windows::Win32::Media::Audio::{eConsole, eRender, IMMDevice, IMMDeviceEnumerator, MMDeviceEnumerator, DEVICE_STATE_ACTIVE};
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_MULTITHREADED, STGM_READ};

    #[windows::core::interface("f8679f50-850a-41cf-9c72-430f290290c8")]
    unsafe trait IPolicyConfig: windows::core::IUnknown {
        fn GetMixFormat(&self, device: PCWSTR, format: *mut *mut c_void) -> HRESULT;
        fn GetDeviceFormat(&self, device: PCWSTR, default: i32, format: *mut *mut c_void) -> HRESULT;
        fn ResetDeviceFormat(&self, device: PCWSTR) -> HRESULT;
        fn SetDeviceFormat(&self, device: PCWSTR, endpoint: *mut c_void, mix: *mut c_void) -> HRESULT;
        fn GetProcessingPeriod(&self, device: PCWSTR, default: i32, default_period: *mut i64, min_period: *mut i64) -> HRESULT;
        fn SetProcessingPeriod(&self, device: PCWSTR, period: *mut i64) -> HRESULT;
        fn GetShareMode(&self, device: PCWSTR, mode: *mut c_void) -> HRESULT;
        fn SetShareMode(&self, device: PCWSTR, mode: *mut c_void) -> HRESULT;
        fn GetPropertyValue(&self, device: PCWSTR, key: *const c_void, value: *mut c_void) -> HRESULT;
        fn SetPropertyValue(&self, device: PCWSTR, key: *const c_void, value: *mut c_void) -> HRESULT;
        fn SetDefaultEndpoint(&self, device: PCWSTR, role: i32) -> HRESULT;
        fn SetEndpointVisibility(&self, device: PCWSTR, visible: i32) -> HRESULT;
    }

    const CLSID_POLICY_CONFIG_CLIENT: GUID = GUID::from_u128(0x870af99c_171d_4f9e_af0d_e63df40c2bc9);

    fn com() {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
    }

    unsafe fn device_id(d: &IMMDevice) -> Option<String> {
        let p = d.GetId().ok()?;
        let s = p.to_string().ok();
        CoTaskMemFree(Some(p.0 as *const c_void));
        s
    }

    unsafe fn device_name(d: &IMMDevice) -> String {
        d.OpenPropertyStore(STGM_READ)
            .and_then(|store| store.GetValue(&PKEY_Device_FriendlyName))
            .map(|v| v.to_string())
            .unwrap_or_default()
    }

    pub fn list() -> Result<Vec<OutputDevice>, String> {
        com();
        unsafe {
            let en: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(|e| e.to_string())?;
            let default_id = en.GetDefaultAudioEndpoint(eRender, eConsole).ok().and_then(|d| device_id(&d));
            let col = en.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE).map_err(|e| e.to_string())?;
            let mut out = Vec::new();
            for i in 0..col.GetCount().map_err(|e| e.to_string())? {
                let Ok(d) = col.Item(i) else { continue };
                let Some(id) = device_id(&d) else { continue };
                let name = device_name(&d);
                out.push(OutputDevice { is_default: Some(&id) == default_id.as_ref(), name: if name.is_empty() { "Audio device".into() } else { name }, id });
            }
            Ok(out)
        }
    }

    pub fn set_default(id: &str) -> Result<(), String> {
        com();
        unsafe {
            let policy: IPolicyConfig = CoCreateInstance(&CLSID_POLICY_CONFIG_CLIENT, None, CLSCTX_ALL).map_err(|e| e.to_string())?;
            let wide: Vec<u16> = id.encode_utf16().chain(std::iter::once(0)).collect();
            // 0 = console, 1 = multimedia, 2 = communications: switch all three, like Sound settings.
            for role in 0..3 {
                policy.SetDefaultEndpoint(PCWSTR(wide.as_ptr()), role).ok().map_err(|e| e.to_string())?;
            }
            Ok(())
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use super::OutputDevice;
    pub fn list() -> Result<Vec<OutputDevice>, String> {
        Ok(vec![])
    }
    pub fn set_default(_id: &str) -> Result<(), String> {
        Err("only on Windows".into())
    }
}

pub use imp::{list, set_default};
