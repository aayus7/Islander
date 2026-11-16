//! Liquid glass for the AI panel.
//!
//! A web view can't see what's behind its own window, so CSS blur alone only blurs the
//! island itself. While the AI panel is open we capture the small strip of screen right
//! behind it (the island is excluded from capture, so we see what's *under* it), shrink
//! it, and stream it to the UI as JPEG frames. The UI then refracts and blurs it.
//! Frames never leave your PC, and capture stops the moment the panel closes.

/// Encode BGRA pixels as a JPEG data: URL. (Platform independent so it can be tested.)
#[allow(dead_code)]
pub fn bgra_to_jpeg_data_url(bgra: &[u8], w: u16, h: u16, quality: u8) -> Option<String> {
    use base64::Engine;
    let mut out = Vec::with_capacity(bgra.len() / 8);
    jpeg_encoder::Encoder::new(&mut out, quality)
        .encode(bgra, w, h, jpeg_encoder::ColorType::Bgra)
        .ok()?;
    Some(format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(&out)))
}

#[cfg(windows)]
mod imp {
    use super::bgra_to_jpeg_data_url;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Mutex;
    use std::time::{Duration, Instant};
    use tauri::{AppHandle, Emitter, Manager};
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits, ReleaseDC, SelectObject,
        SetStretchBltMode, StretchBlt, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HALFTONE, SRCCOPY,
    };

    /// Capture runs while GEN matches the generation it started with.
    static GEN: AtomicU64 = AtomicU64::new(0);
    /// Area to capture, in logical px relative to the island window.
    static RECT: Mutex<(f64, f64, f64, f64)> = Mutex::new((0.0, 0.0, 0.0, 0.0));

    const FPS: u64 = 24;
    /// Captured at half resolution: it's going to be blurred anyway.
    const SCALE: f64 = 0.5;

    pub fn start(app: AppHandle, x: f64, y: f64, w: f64, h: f64) {
        *RECT.lock().unwrap() = (x, y, w, h);
        let gen = GEN.fetch_add(1, Ordering::SeqCst) + 1;
        if let Some(win) = app.get_webview_window("island") {
            crate::win::set_capture_excluded(&win, true);
        }
        std::thread::spawn(move || {
            let mut last_sig = 0u64;
            let mut last_sent = Instant::now() - Duration::from_secs(1);
            while GEN.load(Ordering::SeqCst) == gen {
                let t0 = Instant::now();
                if let Some(frame) = capture(&app) {
                    // Skip identical frames (static desktop) except for a 1 s keep-alive.
                    let sig = frame.1;
                    if sig != last_sig || last_sent.elapsed() > Duration::from_secs(1) {
                        last_sig = sig;
                        last_sent = Instant::now();
                        let _ = app.emit("glass://frame", frame.0);
                    }
                }
                // Glass follows the frame-rate setting (screen capture is costly, so at most 60 fps).
                let fps = (crate::settings::FPS.load(Ordering::Relaxed) as u64 / 2).clamp(FPS, 60);
                let budget = Duration::from_millis(1000 / fps);
                if let Some(rest) = budget.checked_sub(t0.elapsed()) {
                    std::thread::sleep(rest);
                }
            }
        });
    }

    /// Update the area while the panel grows/shrinks.
    pub fn update(x: f64, y: f64, w: f64, h: f64) {
        *RECT.lock().unwrap() = (x, y, w, h);
    }

    pub fn stop(app: &AppHandle) {
        GEN.fetch_add(1, Ordering::SeqCst);
        if let Some(win) = app.get_webview_window("island") {
            crate::win::set_capture_excluded(&win, false);
        }
    }

    /// Returns (jpeg data URL, cheap content signature).
    fn capture(app: &AppHandle) -> Option<(String, u64)> {
        let win = app.get_webview_window("island")?;
        let origin = win.outer_position().ok()?;
        let scale = win.scale_factor().ok()?;
        let (x, y, w, h) = *RECT.lock().unwrap();
        let sx = origin.x + (x * scale).round() as i32;
        let sy = origin.y + (y * scale).round() as i32;
        let sw = (w * scale).round() as i32;
        let sh = (h * scale).round() as i32;
        if sw < 4 || sh < 4 {
            return None;
        }
        let dw = ((sw as f64) * SCALE).round().max(2.0) as i32;
        let dh = ((sh as f64) * SCALE).round().max(2.0) as i32;

        unsafe {
            let screen = GetDC(None);
            if screen.is_invalid() {
                return None;
            }
            let mem = CreateCompatibleDC(Some(screen));
            let bmp = CreateCompatibleBitmap(screen, dw, dh);
            let old = SelectObject(mem, bmp.into());
            SetStretchBltMode(mem, HALFTONE);
            let ok = StretchBlt(mem, 0, 0, dw, dh, Some(screen), sx, sy, sw, sh, SRCCOPY).as_bool();
            SelectObject(mem, old); // GetDIBits needs the bitmap deselected

            let mut bmi = BITMAPINFO::default();
            bmi.bmiHeader = BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: dw,
                biHeight: -dh, // top-down
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            };
            let mut px = vec![0u8; (dw * dh * 4) as usize];
            let rows = if ok {
                GetDIBits(mem, bmp, 0, dh as u32, Some(px.as_mut_ptr() as _), &mut bmi, DIB_RGB_COLORS)
            } else {
                0
            };
            let _ = DeleteObject(bmp.into());
            let _ = DeleteDC(mem);
            ReleaseDC(None, screen);
            if rows == 0 {
                return None;
            }
            for p in px.chunks_mut(4) {
                p[3] = 255;
            }
            // Signature: sample every 97th byte.
            let sig = px.iter().step_by(97).fold(1469598103934665603u64, |h, &b| (h ^ b as u64).wrapping_mul(1099511628211));
            let url = bgra_to_jpeg_data_url(&px, dw as u16, dh as u16, 72)?;
            Some((url, sig))
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use tauri::AppHandle;
    pub fn start(_app: AppHandle, _x: f64, _y: f64, _w: f64, _h: f64) {}
    pub fn update(_x: f64, _y: f64, _w: f64, _h: f64) {}
    pub fn stop(_app: &AppHandle) {}
}

pub use imp::{start, stop, update};
