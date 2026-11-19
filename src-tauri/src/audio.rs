//! Real waveform: captures whatever the PC is playing (WASAPI loopback on the default
//! output device), splits it into frequency bands, and emits "audio://levels" (~30 fps)
//! as an array of 0..1 values. Silence → nothing is emitted after a few zero frames.

#[cfg(windows)]
mod imp {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use realfft::RealFftPlanner;
    use std::f32::consts::PI;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};
    use tauri::{AppHandle, Emitter};

    pub const BANDS: usize = 6;
    const FFT: usize = 1024;
    /// Band edges in Hz: sub-bass, bass, low-mid, mid, presence, air.
    const EDGES: [f32; BANDS + 1] = [35.0, 110.0, 280.0, 700.0, 1800.0, 4500.0, 13000.0];
    const FRAME: Duration = Duration::from_millis(16); // ~60 updates/s

    #[derive(Default)]
    struct Buf {
        samples: Vec<f32>,
        fresh: usize,
    }

    pub fn spawn(app: AppHandle) {
        std::thread::spawn(move || loop {
            if let Err(e) = run(&app) {
                eprintln!("audio capture: {e}");
            }
            let _ = app.emit("audio://levels", vec![0.0f32; BANDS]);
            // Device switched, unplugged, or failed: rebuild shortly.
            std::thread::sleep(Duration::from_millis(800));
        });
    }

    /// Mix any sample format down to mono f32 and append.
    fn push_mono(data: &cpal::Data, ch: usize, out: &mut Vec<f32>) -> usize {
        macro_rules! take {
            ($t:ty, $conv:expr) => {
                if let Some(s) = data.as_slice::<$t>() {
                    let mut n = 0;
                    for frame in s.chunks(ch.max(1)) {
                        let sum: f32 = frame.iter().map(|x| $conv(*x)).sum();
                        out.push(sum / frame.len() as f32);
                        n += 1;
                    }
                    return n;
                }
            };
        }
        take!(f32, |x: f32| x);
        take!(i16, |x: i16| x as f32 / 32_768.0);
        take!(i32, |x: i32| x as f32 / 2_147_483_648.0);
        take!(u16, |x: u16| (x as f32 - 32_768.0) / 32_768.0);
        0
    }

    fn run(app: &AppHandle) -> Result<(), String> {
        let host = cpal::default_host();
        let device = host.default_output_device().ok_or("no output device")?;
        let device_id = device.id().ok();
        let supported = device.default_output_config().map_err(|e| e.to_string())?;
        let channels = supported.channels() as usize;
        let rate = supported.sample_rate() as f32;
        let format = supported.sample_format();

        let buf = Arc::new(Mutex::new(Buf::default()));
        let failed = Arc::new(AtomicBool::new(false));
        let (b, f) = (buf.clone(), failed.clone());

        // An *input* stream on an *output* device = WASAPI loopback (what you hear).
        let stream = device
            .build_input_stream_raw(
                supported.config(),
                format,
                move |data: &cpal::Data, _| {
                    let mut g = b.lock().unwrap();
                    let n = push_mono(data, channels, &mut g.samples);
                    g.fresh += n;
                    let len = g.samples.len();
                    if len > FFT * 4 {
                        g.samples.drain(..len - FFT * 2);
                    }
                },
                move |e: cpal::Error| {
                    // Buffer under/overruns ("Xrun") are harmless glitches that happen when
                    // the PC is busy — keep going. Only rebuild when the device itself is gone.
                    use cpal::ErrorKind as K;
                    if matches!(e.kind(), K::DeviceNotAvailable | K::DeviceChanged | K::StreamInvalidated | K::HostUnavailable) {
                        eprintln!("audio stream lost: {e}");
                        f.store(true, Ordering::Relaxed);
                    }
                },
                None,
            )
            .map_err(|e| e.to_string())?;
        stream.play().map_err(|e| e.to_string())?;

        let fft = RealFftPlanner::<f32>::new().plan_fft_forward(FFT);
        let mut input = fft.make_input_vec();
        let mut spectrum = fft.make_output_vec();
        let window: Vec<f32> = (0..FFT).map(|i| 0.5 - 0.5 * (2.0 * PI * i as f32 / (FFT as f32 - 1.0)).cos()).collect();
        // Which FFT bins belong to which band.
        let bin_hz = rate / FFT as f32;
        let ranges: Vec<(usize, usize)> = (0..BANDS)
            .map(|i| {
                let lo = ((EDGES[i] / bin_hz).floor() as usize).max(1);
                let hi = ((EDGES[i + 1] / bin_hz).ceil() as usize).clamp(lo + 1, FFT / 2);
                (lo, hi)
            })
            .collect();

        let mut smooth = [0.0f32; BANDS];
        let mut zero_frames = 0u32;
        let mut last_device_check = Instant::now();
        // Loudest recent level of each band (dB): bars are drawn against it, like iOS, so a
        // quiet song still moves while a loud one doesn't pin every bar at the top.
        let mut peak = [-40.0f32; BANDS];
        // Noise gate: below it the bars rest flat (fade tails, hiss, near-silence).
        let mut gate_open = false;
        let mut last_frame = Instant::now();

        loop {
            let fps = crate::settings::FPS.load(Ordering::Relaxed).clamp(30, 240) as u64;
            std::thread::sleep(Duration::from_micros(1_000_000 / fps).min(FRAME));
            if failed.load(Ordering::Relaxed) {
                return Err("stream stopped".into());
            }
            // Rebuild if the default output changes (e.g. you switch to headphones).
            if last_device_check.elapsed() > Duration::from_secs(2) {
                last_device_check = Instant::now();
                let now_id = host.default_output_device().and_then(|d| d.id().ok());
                if now_id != device_id {
                    return Ok(());
                }
            }

            // Loopback delivers no packets while nothing plays → treat as silence.
            let dt = last_frame.elapsed().as_secs_f32().clamp(0.001, 0.1);
            last_frame = Instant::now();
            let mut energy = 0.0f32;
            let has_audio = {
                let mut g = buf.lock().unwrap();
                let fresh = g.fresh;
                g.fresh = 0;
                if fresh > 0 && g.samples.len() >= FFT {
                    let start = g.samples.len() - FFT;
                    for (i, s) in g.samples[start..].iter().enumerate() {
                        input[i] = s * window[i];
                        energy += s * s;
                    }
                    true
                } else {
                    false
                }
            };
            // Overall loudness of this frame; the gate opens at -50 dBFS and closes at
            // -56 (hysteresis, so it doesn't chatter on the edge).
            let rms_db = 10.0 * (energy / FFT as f32 + 1e-12).log10();
            gate_open = has_audio && if gate_open { rms_db > -56.0 } else { rms_db > -50.0 };

            let mut target = [0.0f32; BANDS];
            if gate_open && fft.process(&mut input, &mut spectrum).is_ok() {
                let norm = 2.0 / (FFT as f32 * 0.5); // amplitude, Hann-corrected
                for (i, &(lo, hi)) in ranges.iter().enumerate() {
                    let power: f32 = spectrum[lo..hi].iter().map(|c| c.norm_sqr()).sum::<f32>() / (hi - lo) as f32;
                    let amp = power.sqrt() * norm;
                    let db = 20.0 * (amp + 1e-9).log10();
                    // Music has less energy up high: a slightly lower floor there, so the
                    // treble bars still move, but not so low that hiss shows.
                    let floor = -60.0 - i as f32 * 2.0;
                    // Peak follows a louder level at once and falls back ~9 dB/s; it never
                    // drops below floor+30, so soft passages stay low instead of filling up.
                    peak[i] = db.max(peak[i] - 9.0 * dt).max(floor + 30.0);
                    let v = ((db - floor) / (peak[i] - floor)).clamp(0.0, 1.0);
                    // Soft knee: the bottom 10% is noise, not music.
                    target[i] = ((v - 0.1) / 0.9).max(0.0).powf(1.2);
                }
            }

            // Fast attack (~10 ms) so bars land on the beat, smooth release (~85 ms) like
            // iOS; frame-rate independent.
            let up = 1.0 - (-dt / 0.010).exp();
            let down = 1.0 - (-dt / 0.085).exp();
            let mut any = false;
            for i in 0..BANDS {
                let k = if target[i] > smooth[i] { up } else { down };
                smooth[i] += (target[i] - smooth[i]) * k;
                if smooth[i] < 0.01 {
                    smooth[i] = 0.0;
                }
                any |= smooth[i] > 0.0;
            }

            if any {
                zero_frames = 0;
            } else {
                zero_frames += 1;
            }
            if zero_frames <= 3 {
                let _ = app.emit("audio://levels", smooth.to_vec());
            }
        }
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn spawn(_app: tauri::AppHandle) {}
}

pub use imp::spawn;

/// Per-app audio meters: which programs are *actually making sound* right now.
/// Windows' own "current media session" guess is often wrong when several apps are
/// open; the island uses this to show the one you can hear.
#[cfg(windows)]
pub mod meters {
    use std::collections::{HashMap, HashSet};
    use std::sync::Mutex;
    use std::time::{Duration, Instant};
    use windows::core::{Interface, PWSTR};
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::Media::Audio::Endpoints::IAudioMeterInformation;
    use windows::Win32::Media::Audio::{eMultimedia, eRender, IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator, MMDeviceEnumerator};
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED};
    use windows::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};

    /// exe stem (lowercase, e.g. "spotify", "firefox") → last time it made sound.
    static HEARD: Mutex<Option<HashMap<String, Instant>>> = Mutex::new(None);
    /// exe stem → full exe path, for every app with an audio session (used for app icons).
    static PATHS: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

    pub fn exe_path(stem: &str) -> Option<String> {
        PATHS.lock().unwrap().as_ref().and_then(|m| m.get(stem).cloned())
    }
    /// Keep "audible" for a moment through quiet passages.
    const HOLD: Duration = Duration::from_millis(1500);

    pub fn audible(exe: &str) -> bool {
        let g = HEARD.lock().unwrap();
        g.as_ref().and_then(|m| m.get(exe)).map_or(false, |t| t.elapsed() < HOLD)
    }

    /// How long (ms) since the app last made sound. None = we've never heard it (no
    /// audio on the default device, or it isn't an audio app).
    pub fn silent_ms(exe: &str) -> Option<f64> {
        let g = HEARD.lock().unwrap();
        g.as_ref().and_then(|m| m.get(exe)).map(|t| t.elapsed().as_secs_f64() * 1000.0)
    }

    /// A coarse picture of who is sounding: changes the moment any app starts or stops
    /// making sound (and when silence crosses the thresholds the media clock cares about),
    /// so the media watcher re-reads right away instead of waiting for the app to report.
    fn audible_set() -> HashSet<(String, u8)> {
        let g = HEARD.lock().unwrap();
        g.as_ref()
            .map(|m| {
                m.iter()
                    .map(|(k, t)| {
                        let ms = t.elapsed().as_millis();
                        let bucket = if ms < 180 { 0 } else if ms < HOLD.as_millis() { 1 } else if ms < 2600 { 2 } else { 3 };
                        (k.clone(), bucket)
                    })
                    .filter(|(_, b)| *b < 3)
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn spawn(on_change: fn()) {
        std::thread::spawn(move || {
            unsafe {
                let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            }
            let mut names: HashMap<u32, String> = HashMap::new();
            let mut enumerator: Option<IMMDeviceEnumerator> = None;
            // The session manager is cached and refreshed every couple of seconds (it follows
            // the default output device); the meters themselves are read every 50 ms.
            let mut mgr: Option<(IAudioSessionManager2, Instant)> = None;
            let mut last = HashSet::new();
            loop {
                std::thread::sleep(Duration::from_millis(50));
                if enumerator.is_none() {
                    enumerator = unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).ok() };
                }
                let Some(en) = &enumerator else { continue };
                if mgr.as_ref().map_or(true, |(_, at)| at.elapsed() > Duration::from_secs(2)) {
                    mgr = unsafe { manager(en) }.ok().map(|m| (m, Instant::now()));
                }
                let ok = match &mgr {
                    Some((m, _)) => unsafe { tick(m, &mut names) }.is_ok(),
                    None => false,
                };
                if !ok {
                    enumerator = None;
                    mgr = None;
                }
                let now = audible_set();
                if now != last {
                    last = now;
                    on_change();
                }
                if names.len() > 256 {
                    names.clear();
                }
            }
        });
    }

    unsafe fn manager(en: &IMMDeviceEnumerator) -> windows::core::Result<IAudioSessionManager2> {
        let device = en.GetDefaultAudioEndpoint(eRender, eMultimedia)?;
        device.Activate(CLSCTX_ALL, None)
    }

    unsafe fn tick(mgr: &IAudioSessionManager2, names: &mut HashMap<u32, String>) -> windows::core::Result<()> {
        let list = mgr.GetSessionEnumerator()?;
        let now = Instant::now();
        let mut heard = Vec::new();
        for i in 0..list.GetCount()? {
            let Ok(ctl) = list.GetSession(i) else { continue };
            let Ok(c2) = ctl.cast::<IAudioSessionControl2>() else { continue };
            let pid = c2.GetProcessId().unwrap_or(0);
            if pid == 0 {
                continue;
            }
            let name = names
                .entry(pid)
                .or_insert_with(|| {
                    let (stem, path) = exe_stem(pid);
                    if !stem.is_empty() {
                        PATHS.lock().unwrap().get_or_insert_with(HashMap::new).insert(stem.clone(), path);
                    }
                    stem
                })
                .clone();
            let Ok(meter) = ctl.cast::<IAudioMeterInformation>() else { continue };
            if meter.GetPeakValue().unwrap_or(0.0) >= 0.0008 && !name.is_empty() {
                heard.push(name);
            }
        }
        let mut g = HEARD.lock().unwrap();
        let map = g.get_or_insert_with(HashMap::new);
        for n in heard {
            map.insert(n, now);
        }
        map.retain(|_, t| t.elapsed() < Duration::from_secs(30));
        Ok(())
    }

    /// (lowercase exe stem, full exe path) for a process.
    pub fn exe_stem(pid: u32) -> (String, String) {
        unsafe {
            let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else { return Default::default() };
            let mut buf = [0u16; 1024];
            let mut len = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
            let _ = CloseHandle(h);
            if !ok {
                return Default::default();
            }
            let path = String::from_utf16_lossy(&buf[..len as usize]);
            let stem = std::path::Path::new(&path)
                .file_stem()
                .map(|s| s.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            (stem, path)
        }
    }
}

#[cfg(not(windows))]
pub mod meters {
    pub fn audible(_exe: &str) -> bool {
        false
    }
    #[allow(dead_code)]
    pub fn exe_path(_stem: &str) -> Option<String> {
        None
    }
    pub fn spawn(_on_change: fn()) {}
    pub fn silent_ms(_exe: &str) -> Option<f64> {
        None
    }
}
