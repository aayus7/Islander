//! System HUD: watches master volume / mute and Caps / Num Lock, and tells the
//! island to show its pill when one changes.
use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Clone)]
struct HudEvent {
    kind: &'static str,
    value: f64,
    on: bool,
}

#[cfg(windows)]
pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || imp::run(app));
}
#[cfg(not(windows))]
pub fn spawn(_app: AppHandle) {}

#[cfg(windows)]
pub mod imp {
    use super::*;
    use std::time::{Duration, Instant};
    use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
    use windows::Win32::Media::Audio::{eConsole, eRender, IMMDeviceEnumerator, MMDeviceEnumerator};
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED};
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetKeyState, VK_CAPITAL, VK_NUMLOCK};

    /// The default output device's master volume control.
    pub fn endpoint() -> Option<(IAudioEndpointVolume, String)> {
        unsafe {
            let en: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).ok()?;
            let dev = en.GetDefaultAudioEndpoint(eRender, eConsole).ok()?;
            let id = dev
                .GetId()
                .ok()
                .map(|p| {
                    let s = p.to_string().unwrap_or_default();
                    windows::Win32::System::Com::CoTaskMemFree(Some(p.0 as *const _));
                    s
                })
                .unwrap_or_default();
            let vol: IAudioEndpointVolume = dev.Activate(CLSCTX_ALL, None).ok()?;
            Some((vol, id))
        }
    }

    pub fn run(app: AppHandle) {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        let lock = |vk: i32| unsafe { GetKeyState(vk) & 1 == 1 };
        let mut caps = lock(VK_CAPITAL.0 as i32);
        let mut num = lock(VK_NUMLOCK.0 as i32);
        let mut ep: Option<(IAudioEndpointVolume, String)> = None;
        let mut last_vol: Option<(f32, bool)> = None;
        let mut refreshed = Instant::now() - Duration::from_secs(10);
        loop {
            std::thread::sleep(Duration::from_millis(50));

            let c = lock(VK_CAPITAL.0 as i32);
            if c != caps {
                caps = c;
                let _ = app.emit("hud://show", HudEvent { kind: "caps", value: 0.0, on: c });
            }
            let n = lock(VK_NUMLOCK.0 as i32);
            if n != num {
                num = n;
                let _ = app.emit("hud://show", HudEvent { kind: "num", value: 0.0, on: n });
            }

            // Re-resolve the default device now and then (it changes when you switch outputs).
            if refreshed.elapsed() > Duration::from_secs(2) {
                refreshed = Instant::now();
                let fresh = endpoint();
                let changed = match (&ep, &fresh) {
                    (Some((_, a)), Some((_, b))) => a != b,
                    _ => true,
                };
                if changed {
                    ep = fresh;
                    last_vol = None; // a device switch isn't a volume change
                }
            }
            let Some((vol, _)) = &ep else { continue };
            let now = unsafe { (vol.GetMasterVolumeLevelScalar(), vol.GetMute()) };
            let (Ok(level), Ok(muted)) = now else {
                ep = None;
                continue;
            };
            let cur = (level, muted.as_bool());
            match last_vol {
                None => last_vol = Some(cur),
                Some(prev) if prev.1 != cur.1 => {
                    // Mute toggled: the Ring/Silent-style pill.
                    last_vol = Some(cur);
                    let _ = app.emit("hud://show", HudEvent { kind: "mute", value: cur.0 as f64, on: cur.1 });
                }
                Some(prev) if (prev.0 - cur.0).abs() > 0.004 => {
                    last_vol = Some(cur);
                    let _ = app.emit("hud://show", HudEvent { kind: "volume", value: cur.0 as f64, on: cur.1 });
                }
                _ => {}
            }
        }
    }
}
