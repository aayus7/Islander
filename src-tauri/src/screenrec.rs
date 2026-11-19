//! Screen recording from the Controls tab (like iPhone's Screen Recording).
//!
//! - Video: Windows' own capture API (Windows.Graphics.Capture, what the Snipping Tool
//!   and Game Bar use) for the monitor the island is on, encoded by the graphics card's
//!   hardware H.264 encoder through Media Foundation. That gives the best quality for the
//!   size and barely touches the CPU. Output: an .mp4 that plays everywhere.
//! - Audio: what you hear (WASAPI loopback of the default output), AAC.
//! - Pause/resume: the video timeline is shifted back by the paused time, so the file
//!   continues seamlessly (no frozen gap), and no audio is written while paused.
//! - The island shows up in the recording, like any other window.
//!
//! Capture and encoding come from the `windows-capture` crate (MIT), vendored in
//! `vendor/windows-capture` with two small additions (timeline shift, monitor handle).

use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct RecState {
    /// "idle" | "recording" | "paused" | "saving" | "saved" | "error"
    pub state: String,
    pub elapsed_ms: u64,
    pub path: Option<String>,
    pub bytes: Option<u64>,
    pub error: Option<String>,
}

fn emit(app: &AppHandle, s: RecState) {
    let _ = app.emit("rec://state", s);
}

/// "Screen Recording 2026-11-18 at 11.59.01 PM.mp4" in Videos\Screen Recordings
/// (where Windows' own Snipping Tool saves recordings).
fn output_path() -> PathBuf {
    #[cfg(windows)]
    let base = unsafe {
        use windows::Win32::UI::Shell::{FOLDERID_Videos, SHGetKnownFolderPath, KNOWN_FOLDER_FLAG};
        SHGetKnownFolderPath(&FOLDERID_Videos, KNOWN_FOLDER_FLAG(0), None).ok().and_then(|p| {
            let s = p.to_string().ok();
            windows::Win32::System::Com::CoTaskMemFree(Some(p.0 as *const _));
            s.map(PathBuf::from)
        })
    };
    #[cfg(not(windows))]
    let base: Option<PathBuf> = None;
    let dir = base.unwrap_or_else(std::env::temp_dir).join("Screen Recordings");
    let _ = std::fs::create_dir_all(&dir);
    #[cfg(windows)]
    let name = unsafe {
        let t = windows::Win32::System::SystemInformation::GetLocalTime();
        let (h12, ampm) = match t.wHour {
            0 => (12, "AM"),
            1..=11 => (t.wHour, "AM"),
            12 => (12, "PM"),
            h => (h - 12, "PM"),
        };
        format!("Screen Recording {:04}-{:02}-{:02} at {}.{:02}.{:02} {}", t.wYear, t.wMonth, t.wDay, h12, t.wMinute, t.wSecond, ampm)
    };
    #[cfg(not(windows))]
    let name = "Screen Recording".to_string();
    let mut p = dir.join(format!("{name}.mp4"));
    let mut n = 2;
    while p.exists() {
        p = dir.join(format!("{name} ({n}).mp4"));
        n += 1;
    }
    p
}

#[cfg(windows)]
mod imp {
    use super::*;
    use std::collections::VecDeque;
    use std::time::Duration;
    use windows_capture::capture::{CaptureControl, Context, GraphicsCaptureApiHandler};
    use windows_capture::encoder::{AudioSettingsBuilder, ContainerSettingsBuilder, VideoEncoder, VideoSettingsBuilder, VideoSettingsSubType};
    use windows_capture::frame::Frame;
    use windows_capture::graphics_capture_api::InternalCaptureControl;
    use windows_capture::monitor::Monitor;
    use windows_capture::settings::{ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings, MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings};

    const AUDIO_RATE: u32 = 48_000;
    type Enc = Arc<Mutex<Option<VideoEncoder>>>;

    /// The recording clock, in 100 ns ticks on the same clock as capture timestamps (QPC).
    pub(super) fn now_ticks() -> i64 {
        use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};
        let (mut c, mut f) = (0i64, 0i64);
        unsafe {
            let _ = QueryPerformanceCounter(&mut c);
            let _ = QueryPerformanceFrequency(&mut f);
        }
        if f == 0 {
            return 0;
        }
        ((c as i128) * 10_000_000 / (f as i128)) as i64
    }

    #[derive(Default)]
    pub(super) struct Shared {
        /// Capture timestamp of the first frame (0 = not started yet).
        pub t0: AtomicI64,
        /// Total paused time removed from the timeline.
        pub shift: AtomicI64,
        pub paused: AtomicBool,
        pub pause_at: AtomicI64,
        pub stop: AtomicBool,
        /// Frames handed to the encoder (for the log).
        pub frames: std::sync::atomic::AtomicU64,
    }

    impl Shared {
        /// Position in the recording right now (what the video's clock says).
        pub fn elapsed_ticks(&self) -> i64 {
            let t0 = self.t0.load(Ordering::SeqCst);
            if t0 == 0 {
                return 0;
            }
            let now = if self.paused.load(Ordering::SeqCst) { self.pause_at.load(Ordering::SeqCst) } else { now_ticks() };
            (now - t0 - self.shift.load(Ordering::SeqCst)).max(0)
        }
    }

    pub(super) struct Rec {
        enc: Enc,
        sh: Arc<Shared>,
        /// Capture timestamp of the last frame sent (to keep to 60 fps on fast monitors).
        last: i64,
    }

    impl GraphicsCaptureApiHandler for Rec {
        type Flags = (Enc, Arc<Shared>);
        type Error = Box<dyn std::error::Error + Send + Sync>;

        fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
            Ok(Self { enc: ctx.flags.0, sh: ctx.flags.1, last: 0 })
        }

        fn on_frame_arrived(&mut self, frame: &mut Frame, _c: InternalCaptureControl) -> Result<(), Self::Error> {
            if self.sh.paused.load(Ordering::SeqCst) || self.sh.stop.load(Ordering::SeqCst) {
                return Ok(());
            }
            let ts = frame.timestamp()?.Duration;
            // 60 fps is plenty for a screen recording: skip extra frames from 120+ Hz screens.
            if self.last != 0 && ts - self.last < 160_000 {
                return Ok(());
            }
            self.last = ts;
            let mut g = self.enc.lock().unwrap();
            let Some(e) = g.as_mut() else { return Ok(()) };
            let _ = self.sh.t0.compare_exchange(0, ts, Ordering::SeqCst, Ordering::SeqCst);
            e.send_frame(frame)?;
            self.sh.frames.fetch_add(1, Ordering::Relaxed);
            Ok(())
        }
    }

    /// Converts the output device's audio to 48 kHz stereo 16-bit (what the encoder takes).
    struct Resampler {
        step: f64,
        t: f64,
        prev: [f32; 2],
    }

    impl Resampler {
        fn push(&mut self, frames: &[[f32; 2]], out: &mut VecDeque<i16>) {
            if frames.is_empty() {
                return;
            }
            let n = frames.len();
            let at = |i: usize| if i == 0 { self.prev } else { frames[i - 1] };
            while self.t < n as f64 {
                let i = self.t.floor() as usize;
                let f = (self.t - i as f64) as f32;
                let (a, b) = (at(i), at(i + 1));
                for c in 0..2 {
                    let v = a[c] + (b[c] - a[c]) * f;
                    out.push_back((v.clamp(-1.0, 1.0) * 32767.0) as i16);
                }
                self.t += self.step;
            }
            self.t -= n as f64;
            self.prev = frames[n - 1];
        }
    }

    /// Records what you hear and feeds it to the encoder, keeping audio in step with the
    /// video clock: silence fills the gaps (Windows sends nothing while nothing plays).
    fn audio_pump(enc: Enc, sh: Arc<Shared>) {
        use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
        let ring: Arc<Mutex<VecDeque<i16>>> = Arc::new(Mutex::new(VecDeque::new()));
        let host = cpal::default_host();
        // Loopback: an input stream on the output device records what's playing.
        let stream = host.default_output_device().and_then(|dev| {
            let cfg = dev.default_output_config().ok()?;
            let ch = cfg.channels() as usize;
            let mut rs = Resampler { step: cfg.sample_rate() as f64 / AUDIO_RATE as f64, t: 0.0, prev: [0.0; 2] };
            let r = ring.clone();
            let sh2 = sh.clone();
            let s = dev
                .build_input_stream_raw(
                    cfg.config(),
                    cfg.sample_format(),
                    move |data: &cpal::Data, _| {
                        if sh2.t0.load(Ordering::Relaxed) == 0 || sh2.paused.load(Ordering::Relaxed) {
                            return;
                        }
                        let mut frames: Vec<[f32; 2]> = Vec::new();
                        macro_rules! take {
                            ($t:ty, $conv:expr) => {
                                if let Some(s) = data.as_slice::<$t>() {
                                    for f in s.chunks(ch.max(1)) {
                                        let l = $conv(f[0]);
                                        let rr = if f.len() > 1 { $conv(f[1]) } else { l };
                                        frames.push([l, rr]);
                                    }
                                }
                            };
                        }
                        take!(f32, |x: f32| x);
                        take!(i16, |x: i16| x as f32 / 32_768.0);
                        take!(i32, |x: i32| x as f32 / 2_147_483_648.0);
                        let mut g = r.lock().unwrap();
                        rs.push(&frames, &mut g);
                    },
                    |e: cpal::Error| eprintln!("[rec] audio: {e}"),
                    None,
                )
                .ok()?;
            s.play().ok()?;
            Some(s)
        });
        if stream.is_none() {
            crate::log_line("rec: no system audio (recording video only, with silence)".into());
        }
        while !sh.stop.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(15));
            let mut data: Vec<i16> = ring.lock().unwrap().drain(..).collect();
            if sh.t0.load(Ordering::SeqCst) == 0 || sh.paused.load(Ordering::SeqCst) {
                continue;
            }
            let target = (sh.elapsed_ticks() as i128 * AUDIO_RATE as i128 / 10_000_000) as i64;
            let mut g = enc.lock().unwrap();
            let Some(e) = g.as_mut() else { break };
            let sent = e.audio_samples_sent() as i64;
            let avail = (data.len() / 2) as i64;
            // Behind the video clock (nothing was playing): fill with silence first.
            let gap = target - (sent + avail);
            if gap > (AUDIO_RATE / 20) as i64 {
                let mut silence = vec![0i16; (gap as usize) * 2];
                silence.append(&mut data);
                data = silence;
            }
            // Far ahead (clock drift): drop rather than let audio run early.
            if sent > target + (AUDIO_RATE / 2) as i64 {
                continue;
            }
            if !data.is_empty() {
                let bytes: Vec<u8> = data.iter().flat_map(|s| s.to_le_bytes()).collect();
                if let Err(err) = e.send_audio_buffer(&bytes, 0) {
                    crate::log_line(format!("rec: audio not sent: {err}"));
                }
            }
        }
        drop(stream);
    }

    /// Desktop Duplication capture loop (the fallback path). Sends frames at up to 60 fps,
    /// with the mouse pointer drawn in.
    fn duplicate(monitor: Monitor, enc: Enc, sh: Arc<Shared>, ready: std::sync::mpsc::Sender<Result<(), String>>) {
        use windows_capture::dxgi_duplication_api::{DxgiDuplicationApi, DxgiDuplicationFormat, Error as DupError};
        let origin = unsafe {
            use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, HMONITOR, MONITORINFO};
            let mut mi = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
            let _ = GetMonitorInfoW(HMONITOR(monitor.as_raw_hmonitor()), &mut mi);
            (mi.rcMonitor.left, mi.rcMonitor.top)
        };
        // HDR desktops come as 16-bit float; DesktopFrames maps them back to SDR (like OBS's
        // "force SDR") using the display's own SDR brightness, so colours aren't washed out.
        let formats = [DxgiDuplicationFormat::Rgba16F, DxgiDuplicationFormat::Bgra8];
        let white = windows_capture::islander::sdr_white_nits(monitor.as_raw_hmonitor());
        let mut desk = windows_capture::islander::DesktopFrames::new(white);
        let mut said_hdr = false;
        let mut dup = match DxgiDuplicationApi::new_options(monitor, &formats) {
            Ok(d) => {
                let _ = ready.send(Ok(()));
                d
            }
            Err(e) => {
                let _ = ready.send(Err(format!("{e}")));
                return;
            }
        };
        let mut last = 0i64;
        while !sh.stop.load(Ordering::SeqCst) {
            let lost: Option<String> = match dup.acquire_next_frame(100) {
                Ok(frame) => {
                    // Keep the last real desktop image (pointer-only updates carry none: encoding
                    // those gave black flashes), converted to SDR on HDR screens.
                    let have = match desk.update(&frame) {
                        Ok(h) => h,
                        Err(err) => {
                            crate::log_line(format!("rec: frame skipped: {err}"));
                            false
                        }
                    };
                    if desk.hdr_seen && !said_hdr {
                        said_hdr = true;
                        crate::log_line(format!("rec: HDR screen, converting to SDR (SDR white {white:.0} nits)"));
                    }
                    let now = now_ticks();
                    if have && !sh.paused.load(Ordering::SeqCst) && (last == 0 || now - last >= 160_000) {
                        last = now;
                        let mut g = enc.lock().unwrap();
                        if let (Some(e), Some(tex)) = (g.as_mut(), desk.texture()) {
                            let _ = sh.t0.compare_exchange(0, now, Ordering::SeqCst, Ordering::SeqCst);
                            match e.send_texture(frame.device(), frame.device_context(), tex, now, Some(origin)) {
                                Ok(()) => {
                                    sh.frames.fetch_add(1, Ordering::Relaxed);
                                }
                                Err(err) => crate::log_line(format!("rec: frame not sent: {err}")),
                            }
                        }
                    }
                    None
                }
                Err(DupError::Timeout) => None,
                Err(e) => Some(format!("{e}")),
            };
            if let Some(err) = lost {
                // Lost (a UAC prompt, a display change, a fullscreen switch): start again.
                eprintln!("[rec] duplication: {err}; reconnecting");
                std::thread::sleep(Duration::from_millis(150));
                match dup.recreate_options(&formats) {
                    Ok(d) => {
                        dup = d;
                        // New duplication, possibly a new GPU device: start the cache afresh.
                        desk = windows_capture::islander::DesktopFrames::new(white);
                    }
                    Err(e) => {
                        crate::log_line(format!("rec: screen capture lost: {e}"));
                        return;
                    }
                }
            }
        }
    }

    pub(super) struct Session {
        pub enc: Enc,
        pub sh: Arc<Shared>,
        pub control: Option<CaptureControl<Rec, Box<dyn std::error::Error + Send + Sync>>>,
        /// The Desktop Duplication thread, when Windows' capture service is unavailable.
        pub dup: Option<std::thread::JoinHandle<()>>,
        pub audio: Option<std::thread::JoinHandle<()>>,
        pub path: PathBuf,
    }

    /// `island`: the island window's handle as a number (raw handles can't cross threads).
    pub(super) fn start(island: Option<isize>) -> Result<Session, String> {
        use windows::Win32::Graphics::Gdi::{MonitorFromWindow, MONITOR_DEFAULTTOPRIMARY};
        // The island's monitor first, then the primary one, then whatever Windows lists first.
        let mut candidates: Vec<(&str, Monitor)> = Vec::new();
        if let Some(h) = island {
            candidates.push(("island's monitor", Monitor::from_raw_hmonitor(unsafe { MonitorFromWindow(windows::Win32::Foundation::HWND(h as _), MONITOR_DEFAULTTOPRIMARY) }.0)));
        }
        if let Ok(m) = Monitor::primary() {
            candidates.push(("primary monitor", m));
        }
        if let Ok(m) = Monitor::from_index(1) {
            candidates.push(("monitor 1", m));
        }
        // Ask Windows for a capture item for each, on a WinRT thread, and log the real reason
        // if it says no (the capture library only reports "couldn't convert").
        let probe = std::thread::spawn(move || {
            unsafe {
                let _ = windows::Win32::System::Com::CoInitializeEx(None, windows::Win32::System::Com::COINIT_MULTITHREADED);
            }
            let mut ok = None;
            let mut why = Vec::new();
            let fallback = candidates.first().map(|c| c.1);
            for (name, m) in candidates {
                let r: Result<windows_capture::settings::GraphicsCaptureItemType, _> = m.try_into();
                match r {
                    Ok(_) => {
                        ok = Some((name, m));
                        break;
                    }
                    Err(e) => why.push(format!("{name} (handle {:?}): {e:?}", m.as_raw_hmonitor())),
                }
            }
            (ok, why, fallback)
        })
        .join()
        .map_err(|_| "capture probe crashed".to_string())?;
        for w in &probe.1 {
            crate::log_line(format!("rec: Windows refused a capture item for {w}"));
        }
        // No capture item: Windows' capture service is off on this PC (debloat tools disable
        // it). Desktop Duplication (what OBS also uses) doesn't need it.
        let (monitor, dxgi) = match probe.0 {
            Some((which, m)) => {
                crate::log_line(format!("rec: capturing the {which}"));
                (m, false)
            }
            None => {
                let m = probe.2.ok_or("No monitor to record")?;
                crate::log_line("rec: Windows' capture service is unavailable; using Desktop Duplication".into());
                (m, true)
            }
        };
        let (w, h) = (monitor.width().map_err(|e| e.to_string())?, monitor.height().map_err(|e| e.to_string())?);
        let (w, h) = (w & !1, h & !1); // the encoder wants even sizes
        // Screen content compresses well: ~0.07 bits per pixel per frame at 60 fps is sharp
        // text and smooth motion (1440p ≈ 15 Mbit/s, 1080p ≈ 9 Mbit/s, 4K ≈ 35 Mbit/s).
        let bitrate = ((w as f64 * h as f64 * 60.0 * 0.07) as u32).clamp(6_000_000, 40_000_000);
        let path = super::output_path();
        let enc = VideoEncoder::new(
            VideoSettingsBuilder::new(w, h).sub_type(VideoSettingsSubType::H264).frame_rate(60).bitrate(bitrate),
            AudioSettingsBuilder::new().sample_rate(AUDIO_RATE).channel_count(2).bit_per_sample(16).bitrate(160_000),
            ContainerSettingsBuilder::default(),
            &path,
        )
        .map_err(|e| format!("Couldn't start the video encoder ({e})"))?;
        let enc: Enc = Arc::new(Mutex::new(Some(enc)));
        let sh = Arc::new(Shared::default());
        if dxgi {
            let (e2, s2) = (enc.clone(), sh.clone());
            let (ready_tx, ready_rx) = std::sync::mpsc::channel();
            let dup = std::thread::spawn(move || duplicate(monitor, e2, s2, ready_tx));
            match ready_rx.recv_timeout(Duration::from_secs(5)) {
                Ok(Ok(())) => {}
                Ok(Err(e)) => return Err(format!("Couldn't capture the screen ({e})")),
                Err(_) => return Err("Screen capture didn't start".into()),
            }
            let (e3, s3) = (enc.clone(), sh.clone());
            let audio = std::thread::spawn(move || audio_pump(e3, s3));
            crate::log_line(format!("rec: recording {w}x{h} (Desktop Duplication), {} Mbit/s, to {}", bitrate / 1_000_000, path.display()));
            return Ok(Session { enc, sh, control: None, dup: Some(dup), audio: Some(audio), path });
        }
        let settings = |border, interval| {
            Settings::new(
                monitor,
                CursorCaptureSettings::WithCursor,
                border,
                SecondaryWindowSettings::Default,
                interval,
                DirtyRegionSettings::Default,
                ColorFormat::Bgra8,
                (enc.clone(), sh.clone()),
            )
        };
        // Newer options first (no yellow capture border, a 60 fps cap from Windows); older
        // Windows versions don't have them, so step down until Windows accepts.
        let tries = [
            ("no border, 60 fps cap", DrawBorderSettings::WithoutBorder, MinimumUpdateIntervalSettings::Custom(Duration::from_millis(16))),
            ("no border", DrawBorderSettings::WithoutBorder, MinimumUpdateIntervalSettings::Default),
            ("defaults", DrawBorderSettings::Default, MinimumUpdateIntervalSettings::Default),
        ];
        let mut control = None;
        let mut why = Vec::new();
        for (name, border, interval) in tries {
            match Rec::start_free_threaded(settings(border, interval)) {
                Ok(c) => {
                    crate::log_line(format!("rec: capture started ({name})"));
                    control = Some(c);
                    break;
                }
                Err(e) => {
                    crate::log_line(format!("rec: capture with {name} refused: {e} ({e:?})"));
                    why.push(format!("{e}"));
                }
            }
        }
        let Some(control) = control else {
            return Err(format!("Windows refused screen capture: {}", why.last().cloned().unwrap_or_default()));
        };
        let (e2, s2) = (enc.clone(), sh.clone());
        let audio = std::thread::spawn(move || audio_pump(e2, s2));
        crate::log_line(format!("rec: recording {w}x{h} at 60 fps, {} Mbit/s, to {}", bitrate / 1_000_000, path.display()));
        Ok(Session { enc, sh, control: Some(control), dup: None, audio: Some(audio), path })
    }

    /// One log line about how the recording is going.
    pub(super) fn report(s: &Session) -> String {
        let audio = s.enc.lock().unwrap().as_ref().map(|e| e.audio_samples_sent()).unwrap_or(0);
        let bytes = std::fs::metadata(&s.path).map(|m| m.len()).unwrap_or(0);
        format!(
            "rec: {:.1} s recorded, {} frames, {:.1} s of audio, file {} KB",
            s.sh.elapsed_ticks() as f64 / 1e7,
            s.sh.frames.load(Ordering::Relaxed),
            audio as f64 / AUDIO_RATE as f64,
            bytes / 1024
        )
    }

    pub(super) fn pause(s: &Session) {
        if !s.sh.paused.swap(true, Ordering::SeqCst) {
            s.sh.pause_at.store(now_ticks(), Ordering::SeqCst);
        }
    }

    pub(super) fn resume(s: &Session) {
        if s.sh.paused.load(Ordering::SeqCst) {
            let extra = now_ticks() - s.sh.pause_at.load(Ordering::SeqCst);
            if s.sh.t0.load(Ordering::SeqCst) != 0 && extra > 0 {
                if let Some(e) = s.enc.lock().unwrap().as_mut() {
                    e.shift_timeline(extra);
                }
                s.sh.shift.fetch_add(extra, Ordering::SeqCst);
            }
            s.sh.paused.store(false, Ordering::SeqCst);
        }
    }

    /// Stops capture and audio, then writes the file's index. Blocks until the file is done.
    pub(super) fn finish(mut s: Session) -> Result<PathBuf, String> {
        crate::log_line(report(&s));
        s.sh.stop.store(true, Ordering::SeqCst);
        if let Some(c) = s.control.take() {
            let _ = c.stop();
        }
        if let Some(d) = s.dup.take() {
            let _ = d.join();
        }
        if let Some(a) = s.audio.take() {
            let _ = a.join();
        }
        let enc = s.enc.lock().unwrap().take();
        if let Some(e) = enc {
            e.finish().map_err(|e| format!("Couldn't finish the video file ({e})"))?;
        }
        if std::fs::metadata(&s.path).map(|m| m.len()).unwrap_or(0) == 0 {
            let _ = std::fs::remove_file(&s.path);
            return Err("Nothing was recorded".into());
        }
        Ok(s.path)
    }
}

/* ---------------- commands ---------------- */

#[cfg(windows)]
static SESSION: Mutex<Option<imp::Session>> = Mutex::new(None);

#[cfg(windows)]
fn ticker(app: AppHandle, sh: Arc<imp::Shared>) {
    std::thread::spawn(move || {
        let mut n = 0u32;
        while !sh.stop.load(Ordering::SeqCst) {
            n += 1;
            if n % 20 == 0 {
                if let Some(s) = SESSION.lock().unwrap().as_ref() {
                    crate::log_line(imp::report(s));
                }
            }
            let state = if sh.paused.load(Ordering::SeqCst) { "paused" } else { "recording" };
            emit(&app, RecState { state: state.into(), elapsed_ms: (sh.elapsed_ticks() / 10_000) as u64, ..Default::default() });
            std::thread::sleep(std::time::Duration::from_millis(250));
        }
    });
}

#[tauri::command]
pub async fn rec_start(app: AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    {
        use tauri::Manager;
        if SESSION.lock().unwrap().is_some() {
            return Ok(());
        }
        let win = app.get_webview_window("island");
        let hwnd = win.as_ref().and_then(|w| w.hwnd().ok()).map(|h| h.0 as isize);
        let started = tauri::async_runtime::spawn_blocking(move || imp::start(hwnd)).await.map_err(|e| e.to_string())?;
        let s = match started {
            Ok(s) => s,
            Err(e) => {
                crate::log_line(format!("rec: couldn't start: {e}"));
                // The encoder makes the file before capture starts: don't leave empty files.
                std::thread::spawn(remove_empty_recordings);
                return Err(e);
            }
        };
        // Settings → "Show in screen recordings": when off, leave the island out of the video.
        let show = app.state::<crate::St>().store.get().show_in_recordings;
        if let (false, Some(w)) = (show, &win) {
            crate::win::exclude_from_capture(w, crate::win::CAPTURE_RECORDING, true);
        }
        crate::log_line(format!("rec: island {} the recording", if show { "shown in" } else { "left out of" }));
        ticker(app.clone(), s.sh.clone());
        *SESSION.lock().unwrap() = Some(s);
        emit(&app, RecState { state: "recording".into(), ..Default::default() });
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Err("Screen recording needs Windows".into())
    }
}

/// The setting changed: apply it right away if a recording is running.
pub fn island_in_recording(app: &AppHandle, show: bool) {
    #[cfg(windows)]
    {
        use tauri::Manager;
        if SESSION.lock().unwrap().is_none() {
            return;
        }
        if let Some(w) = app.get_webview_window("island") {
            crate::win::exclude_from_capture(&w, crate::win::CAPTURE_RECORDING, !show);
        }
    }
    let _ = (app, show);
}

/// Deletes 0-byte recordings (left by attempts that couldn't start).
fn remove_empty_recordings() {
    std::thread::sleep(std::time::Duration::from_millis(800));
    if let Some(dir) = output_path().parent() {
        for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            let p = e.path();
            if p.extension().is_some_and(|x| x == "mp4") && e.metadata().map(|m| m.len() == 0).unwrap_or(false) {
                let _ = std::fs::remove_file(p);
            }
        }
    }
}

/// What the recorder is doing right now (the island asks when it loads).
#[tauri::command]
pub fn rec_status() -> RecState {
    #[cfg(windows)]
    if let Some(s) = SESSION.lock().unwrap().as_ref() {
        let state = if s.sh.paused.load(Ordering::SeqCst) { "paused" } else { "recording" };
        return RecState { state: state.into(), elapsed_ms: (s.sh.elapsed_ticks() / 10_000) as u64, ..Default::default() };
    }
    RecState { state: "idle".into(), ..Default::default() }
}

#[tauri::command]
pub fn rec_pause(app: AppHandle) {
    #[cfg(windows)]
    if let Some(s) = SESSION.lock().unwrap().as_ref() {
        imp::pause(s);
        emit(&app, RecState { state: "paused".into(), elapsed_ms: (s.sh.elapsed_ticks() / 10_000) as u64, ..Default::default() });
    }
    let _ = app;
}

#[tauri::command]
pub fn rec_resume(app: AppHandle) {
    #[cfg(windows)]
    if let Some(s) = SESSION.lock().unwrap().as_ref() {
        imp::resume(s);
        emit(&app, RecState { state: "recording".into(), elapsed_ms: (s.sh.elapsed_ticks() / 10_000) as u64, ..Default::default() });
    }
    let _ = app;
}

#[tauri::command]
pub async fn rec_stop(app: AppHandle) -> Result<String, String> {
    #[cfg(windows)]
    {
        use tauri::Manager;
        let Some(s) = SESSION.lock().unwrap().take() else { return Err("Not recording".into()) };
        let elapsed = (s.sh.elapsed_ticks() / 10_000) as u64;
        emit(&app, RecState { state: "saving".into(), elapsed_ms: elapsed, ..Default::default() });
        let res = tauri::async_runtime::spawn_blocking(move || imp::finish(s)).await.map_err(|e| e.to_string())?;
        if let Some(w) = app.get_webview_window("island") {
            crate::win::exclude_from_capture(&w, crate::win::CAPTURE_RECORDING, false);
        }
        match res {
            Ok(path) => {
                let p = path.to_string_lossy().to_string();
                let bytes = std::fs::metadata(&path).map(|m| m.len()).ok();
                crate::log_line(format!("rec: saved {p} ({} MB)", bytes.unwrap_or(0) / 1_000_000));
                emit(&app, RecState { state: "saved".into(), elapsed_ms: elapsed, path: Some(p.clone()), bytes, ..Default::default() });
                Ok(p)
            }
            Err(e) => {
                crate::log_line(format!("rec: failed: {e}"));
                emit(&app, RecState { state: "error".into(), error: Some(e.clone()), ..Default::default() });
                Err(e)
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Err("Screen recording needs Windows".into())
    }
}
