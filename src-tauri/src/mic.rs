//! Voice input for "Search or Ask": records the default microphone while the user speaks,
//! streams a 0..1 loudness level ("mic://level", ~30/s) for the listening waveform, and on
//! stop hands back the recording as a 16 kHz mono WAV (base64) for transcription.
//! Nothing is recorded unless the user taps the mic, and nothing is kept afterwards.

use base64::Engine;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::AppHandle;

/// Longest recording we accept (the relay and Gemini don't need more for a question).
const MAX_SECS: f32 = 30.0;
const OUT_RATE: u32 = 16_000;

struct Rec {
    stop: Arc<AtomicBool>,
    samples: Arc<Mutex<Vec<f32>>>,
    rate: Arc<Mutex<u32>>,
    thread: Option<std::thread::JoinHandle<()>>,
}

static REC: Mutex<Option<Rec>> = Mutex::new(None);

/// Async so waiting for the device never blocks the app's main thread.
#[tauri::command]
pub async fn mic_start(app: AppHandle) -> Result<(), String> {
    let mut slot = REC.lock().unwrap();
    if slot.is_some() {
        return Ok(());
    }
    let stop = Arc::new(AtomicBool::new(false));
    let samples = Arc::new(Mutex::new(Vec::<f32>::with_capacity(48_000 * 10)));
    let rate = Arc::new(Mutex::new(48_000u32));
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    let (s2, r2, st2) = (samples.clone(), rate.clone(), stop.clone());
    let thread = std::thread::spawn(move || imp::record(app, s2, r2, st2, tx));
    // Wait until the microphone is actually open (or failed) before saying "listening".
    match rx.recv_timeout(std::time::Duration::from_secs(4)) {
        Ok(Ok(())) => {}
        Ok(Err(e)) => {
            stop.store(true, Ordering::Relaxed);
            let _ = thread.join();
            crate::log_line(format!("mic: {e}"));
            return Err(e);
        }
        Err(_) => {
            stop.store(true, Ordering::Relaxed);
            return Err("The microphone didn't respond.".into());
        }
    }
    *slot = Some(Rec { stop, samples, rate, thread: Some(thread) });
    Ok(())
}

fn finish() -> Option<(Vec<f32>, u32)> {
    let mut rec = REC.lock().unwrap().take()?;
    rec.stop.store(true, Ordering::Relaxed);
    if let Some(t) = rec.thread.take() {
        let _ = t.join();
    }
    let samples = std::mem::take(&mut *rec.samples.lock().unwrap());
    let rate = *rec.rate.lock().unwrap();
    Some((samples, rate))
}

/// Stop recording; returns the WAV as base64 ("" if nothing was recorded).
#[tauri::command]
pub async fn mic_stop() -> String {
    let Some((samples, rate)) = finish() else { return String::new() };
    if samples.len() < (rate as usize) / 4 {
        return String::new();
    }
    let peak = samples.iter().fold(0.0f32, |m, x| m.max(x.abs()));
    crate::log_line(format!("mic: {:.1}s at {rate} Hz, peak {:.3}", samples.len() as f32 / rate as f32, peak));
    let pcm = resample(&samples, rate, OUT_RATE);
    let bytes = wav(&pcm, OUT_RATE);
    // Development builds keep the last recording next to the log, to check what was heard.
    #[cfg(debug_assertions)]
    let _ = std::fs::write(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("voice-debug.wav"), &bytes);
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

#[tauri::command]
pub fn mic_cancel() {
    let _ = finish();
}

/// Linear-interpolation resample to mono 16 kHz, with a gentle gain so quiet mics are
/// still clear (peak normalised to about -3 dBFS, never boosted more than 8x).
fn resample(input: &[f32], from: u32, to: u32) -> Vec<i16> {
    let ratio = from as f64 / to as f64;
    let n = (input.len() as f64 / ratio) as usize;
    let peak = input.iter().fold(0.0f32, |m, x| m.max(x.abs())).max(1e-4);
    let gain = (0.7 / peak).clamp(1.0, 8.0);
    (0..n)
        .map(|i| {
            let p = i as f64 * ratio;
            let k = p as usize;
            let f = (p - k as f64) as f32;
            let a = input[k.min(input.len() - 1)];
            let b = input[(k + 1).min(input.len() - 1)];
            (((a + (b - a) * f) * gain).clamp(-1.0, 1.0) * 32_767.0) as i16
        })
        .collect()
}

fn wav(pcm: &[i16], rate: u32) -> Vec<u8> {
    let data_len = (pcm.len() * 2) as u32;
    let mut v = Vec::with_capacity(44 + data_len as usize);
    v.extend_from_slice(b"RIFF");
    v.extend_from_slice(&(36 + data_len).to_le_bytes());
    v.extend_from_slice(b"WAVEfmt ");
    v.extend_from_slice(&16u32.to_le_bytes());
    v.extend_from_slice(&1u16.to_le_bytes()); // PCM
    v.extend_from_slice(&1u16.to_le_bytes()); // mono
    v.extend_from_slice(&rate.to_le_bytes());
    v.extend_from_slice(&(rate * 2).to_le_bytes());
    v.extend_from_slice(&2u16.to_le_bytes());
    v.extend_from_slice(&16u16.to_le_bytes());
    v.extend_from_slice(b"data");
    v.extend_from_slice(&data_len.to_le_bytes());
    for s in pcm {
        v.extend_from_slice(&s.to_le_bytes());
    }
    v
}

#[cfg(windows)]
mod imp {
    use super::MAX_SECS;
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc::Sender;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    use tauri::{AppHandle, Emitter};

    fn push_mono(data: &cpal::Data, ch: usize, out: &mut Vec<f32>) {
        macro_rules! take {
            ($t:ty, $conv:expr) => {
                if let Some(s) = data.as_slice::<$t>() {
                    for frame in s.chunks(ch.max(1)) {
                        let sum: f32 = frame.iter().map(|x| $conv(*x)).sum();
                        out.push(sum / frame.len() as f32);
                    }
                    return;
                }
            };
        }
        take!(f32, |x: f32| x);
        take!(i16, |x: i16| x as f32 / 32_768.0);
        take!(i32, |x: i32| x as f32 / 2_147_483_648.0);
        take!(u16, |x: u16| (x as f32 - 32_768.0) / 32_768.0);
    }

    pub fn record(app: AppHandle, samples: Arc<Mutex<Vec<f32>>>, rate: Arc<Mutex<u32>>, stop: Arc<AtomicBool>, ready: Sender<Result<(), String>>) {
        let host = cpal::default_host();
        let Some(device) = host.default_input_device() else {
            let _ = ready.send(Err("No microphone found. Plug one in or pick one in Windows sound settings.".into()));
            return;
        };
        let supported = match device.default_input_config() {
            Ok(c) => c,
            Err(e) => {
                let _ = ready.send(Err(format!("Can't use the microphone ({e}). Check Settings → Privacy & security → Microphone.")));
                return;
            }
        };
        let channels = supported.channels() as usize;
        let sr = supported.sample_rate();
        *rate.lock().unwrap() = sr;
        let max = (sr as f32 * MAX_SECS) as usize;
        let s = samples.clone();
        let full = stop.clone();
        let stream = device.build_input_stream_raw(
            supported.config(),
            supported.sample_format(),
            move |data: &cpal::Data, _| {
                let mut g = s.lock().unwrap();
                if g.len() < max {
                    push_mono(data, channels, &mut g);
                } else {
                    full.store(true, Ordering::Relaxed);
                }
            },
            move |e: cpal::Error| eprintln!("mic stream: {e}"),
            None,
        );
        let stream = match stream {
            Ok(s) => s,
            Err(e) => {
                let _ = ready.send(Err(format!(
                    "Windows didn't allow the microphone ({e}). Turn on Settings → Privacy & security → Microphone → Let desktop apps access your microphone."
                )));
                return;
            }
        };
        if let Err(e) = stream.play() {
            let _ = ready.send(Err(format!("Couldn't start the microphone ({e}).")));
            return;
        }
        let _ = ready.send(Ok(()));

        // Loudness for the waveform: RMS of the newest ~40 ms, mapped from -60..-12 dBFS to 0..1.
        let win = (sr as usize / 25).max(256);
        let mut seen = 0usize;
        while !stop.load(Ordering::Relaxed) {
            std::thread::sleep(Duration::from_millis(33));
            let (level, len) = {
                let g = samples.lock().unwrap();
                let tail = &g[g.len().saturating_sub(win)..];
                let rms = if tail.is_empty() { 0.0 } else { (tail.iter().map(|x| x * x).sum::<f32>() / tail.len() as f32).sqrt() };
                (rms, g.len())
            };
            if len == seen {
                continue;
            }
            seen = len;
            let db = 20.0 * level.max(1e-6).log10();
            let v = ((db + 60.0) / 48.0).clamp(0.0, 1.0);
            let _ = app.emit("mic://level", v);
        }
        drop(stream);
        let _ = app.emit("mic://level", 0.0f32);
    }
}

#[cfg(not(windows))]
mod imp {
    use std::sync::atomic::AtomicBool;
    use std::sync::mpsc::Sender;
    use std::sync::{Arc, Mutex};
    use tauri::AppHandle;
    pub fn record(_: AppHandle, _: Arc<Mutex<Vec<f32>>>, _: Arc<Mutex<u32>>, _: Arc<AtomicBool>, ready: Sender<Result<(), String>>) {
        let _ = ready.send(Err("Voice input needs Windows.".into()));
    }
}
