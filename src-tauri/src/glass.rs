//! Liquid glass for the AI panel.
//!
//! A web view can't see what's behind its own window, so CSS blur alone only blurs the
//! island itself. While the AI panel is open we capture the small strip of screen right
//! behind it, shrink it, and stream it to the UI as JPEG frames. The UI then refracts and
//! blurs it. Frames never leave your PC, and capture stops the moment the panel closes.
//!
//! To see what's *under* the island, the capture has to skip the island itself. Windows'
//! magnifier API can do exactly that (a filter list of windows to leave out), so the island
//! stays visible to screen recorders and screenshots. Only if the magnifier isn't available
//! do we fall back to marking the island "excluded from capture", which also hides it from
//! recordings while the panel is open.

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
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::Mutex;
    use std::time::{Duration, Instant};
    use tauri::{AppHandle, Emitter, Manager};
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits, ReleaseDC, SelectObject,
        SetStretchBltMode, StretchBlt, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HALFTONE, SRCCOPY,
    };

    /// Capture runs while GEN matches the generation it started with.
    static GEN: AtomicU64 = AtomicU64::new(0);
    /// True while the AI panel is open.
    static RUNNING: AtomicBool = AtomicBool::new(false);
    /// Area to capture, in logical px relative to the island window.
    static RECT: Mutex<(f64, f64, f64, f64)> = Mutex::new((0.0, 0.0, 0.0, 0.0));

    const FPS: u64 = 24;
    /// Captured at half resolution: it's going to be blurred anyway.
    const SCALE: f64 = 0.5;

    pub fn start(app: AppHandle, x: f64, y: f64, w: f64, h: f64) {
        *RECT.lock().unwrap() = (x, y, w, h);
        GEN.fetch_add(1, Ordering::SeqCst);
        RUNNING.store(true, Ordering::SeqCst);
        // One worker for the app's whole life. It owns the magnifier and pauses between opens.
        // (A new worker per open meant an old one could still be switching the magnifier off
        // while the new one used it — Windows then kills the app with 0xc000041d.)
        static WORKER: std::sync::Once = std::sync::Once::new();
        WORKER.call_once(move || {
            std::thread::spawn(move || worker(app));
        });
    }

    fn worker(app: AppHandle) {
        // The magnifier lives on this thread (its window must be used where it was made).
        let island = app.get_webview_window("island").and_then(|w| w.hwnd().ok()).map(|h| windows::Win32::Foundation::HWND(h.0 as _));
        let mut mag = island.and_then(mag::Mag::new);
        let mut shown = false;
        loop {
            if !RUNNING.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(15));
                continue;
            }
            let gen = GEN.load(Ordering::SeqCst);
            let mut said = false;
            let mut last_sig = 0u64;
            let mut last_sent = Instant::now() - Duration::from_secs(1);
            let started = Instant::now();
            // Brightness of the last frame we passed on, and how many dark ones we've held back.
            let mut last_avg: Option<u32> = None;
            let mut held = 0u32;
            let mut trace = String::new();
            while RUNNING.load(Ordering::SeqCst) && GEN.load(Ordering::SeqCst) == gen {
                let t0 = Instant::now();
                let got = mag.as_ref().map(|m| capture_mag(&app, m));
                let frame = match got {
                    Some(Some(f)) => {
                        if !said {
                            said = true;
                            crate::log_line(format!("glass: magnifier capture (island stays visible to recorders), avg brightness {}", f.2));
                        }
                        // While the panel grows the magnifier sometimes hands back an empty (black)
                        // picture for a frame or two. Showing it makes the glass blink black, so
                        // hold it back unless the screen really did go dark (it stays dark).
                        let dark = f.2 <= 3 && last_avg.map_or(true, |a| a > 10);
                        if started.elapsed() < Duration::from_secs(2) {
                            trace.push_str(&format!("{}{} ", f.2, if dark && held < 6 { "x" } else { "" }));
                        }
                        if dark && held < 6 {
                            held += 1;
                            None
                        } else {
                            held = 0;
                            last_avg = Some(f.2);
                            Some((f.0, f.1))
                        }
                    }
                    Some(None) if !shown => {
                        crate::log_line(format!("glass: magnifier gave no frame ({}); retrying with its window shown invisibly", mag::seen()));
                        shown = true;
                        if let Some(m) = &mag {
                            m.show_invisibly();
                        }
                        None
                    }
                    Some(None) => {
                        // Not working on this PC: fall back to hiding the island from capture.
                        crate::log_line(format!("glass: magnifier still gave no frame ({}), falling back to capture exclusion", mag::seen()));
                        mag = None;
                        said = true;
                        if let Some(win) = app.get_webview_window("island") {
                            crate::win::set_capture_excluded(&win, true);
                        }
                        None
                    }
                    None => {
                        if !said {
                            said = true;
                            crate::log_line("glass: magnifier unavailable, using capture exclusion".into());
                            if let Some(win) = app.get_webview_window("island") {
                                crate::win::set_capture_excluded(&win, true);
                            }
                        }
                        capture(&app)
                    }
                };
                if !trace.is_empty() && started.elapsed() >= Duration::from_secs(2) {
                    if trace.contains('x') {
                        crate::log_line(format!("glass: first frames' brightness (x = held back): {}", trace.trim()));
                    }
                    trace.clear();
                }
                if let Some(frame) = frame {
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
        }
    }

    /// Update the area while the panel grows/shrinks.
    pub fn update(x: f64, y: f64, w: f64, h: f64) {
        *RECT.lock().unwrap() = (x, y, w, h);
    }

    pub fn stop(app: &AppHandle) {
        RUNNING.store(false, Ordering::SeqCst);
        GEN.fetch_add(1, Ordering::SeqCst);
        if let Some(win) = app.get_webview_window("island") {
            crate::win::set_capture_excluded(&win, false);
        }
    }

    /// The capture area in physical screen pixels.
    fn area(app: &AppHandle) -> Option<(i32, i32, i32, i32)> {
        let win = app.get_webview_window("island")?;
        let origin = win.outer_position().ok()?;
        let scale = win.scale_factor().ok()?;
        let (x, y, w, h) = *RECT.lock().unwrap();
        let r = (origin.x + (x * scale).round() as i32, origin.y + (y * scale).round() as i32, (w * scale).round() as i32, (h * scale).round() as i32);
        if r.2 < 4 || r.3 < 4 {
            return None;
        }
        Some(r)
    }

    /// Via the magnifier (island left out). Returns (jpeg data URL, signature, avg brightness).
    fn capture_mag(app: &AppHandle, m: &mag::Mag) -> Option<(String, u64, u32)> {
        let (sx, sy, sw, sh) = area(app)?;
        // Always grab the same size: the tallest the panel can get (it's as tall as it is wide),
        // then use only the rows the panel covers right now. Resizing the magnifier while the
        // answer panel grows crashed the whole app (0xc000041d) inside Windows' magnifier.
        let (full, fw, gh) = m.grab(sx, sy, sw, sw.max(sh))?;
        let fh = sh.min(gh).max(1);
        // Half size (2×2 average): it's going to be blurred anyway.
        let dw = (fw / 2).max(2);
        let dh = (fh / 2).max(2);
        let mut px = vec![255u8; (dw * dh * 4) as usize];
        let stride = (fw * 4) as usize;
        for y in 0..dh as usize {
            for x in 0..dw as usize {
                let (x0, y0) = ((x * 2).min(fw as usize - 1), (y * 2).min(fh as usize - 1));
                let (x1, y1) = ((x0 + 1).min(fw as usize - 1), (y0 + 1).min(fh as usize - 1));
                for c in 0..3 {
                    let v = full[y0 * stride + x0 * 4 + c] as u32 + full[y0 * stride + x1 * 4 + c] as u32 + full[y1 * stride + x0 * 4 + c] as u32 + full[y1 * stride + x1 * 4 + c] as u32;
                    px[(y * dw as usize + x) * 4 + c] = (v / 4) as u8;
                }
            }
        }
        let sig = px.iter().step_by(97).fold(1469598103934665603u64, |h, &b| (h ^ b as u64).wrapping_mul(1099511628211));
        let n = (px.len() / 4).max(1) as u64;
        let avg = (px.chunks(4).map(|p| (p[0] as u64 + p[1] as u64 + p[2] as u64) / 3).sum::<u64>() / n) as u32;
        let url = bgra_to_jpeg_data_url(&px, dw as u16, dh as u16, 72)?;
        Some((url, sig, avg))
    }

    /// Screen capture that leaves one window out (Windows' Magnification API, the same
    /// technique Chrome's screen sharing used). Everything here stays on the thread that made it.
    mod mag {
        use std::cell::RefCell;
        use std::ffi::c_void;
        use windows::core::{w, BOOL};
        use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, RECT, WPARAM};
        use windows::Win32::Graphics::Gdi::HRGN;
        use windows::Win32::System::LibraryLoader::GetModuleHandleW;
        use windows::Win32::UI::Magnification::{
            MagInitialize, MagSetImageScalingCallback, MagSetWindowFilterList, MagSetWindowSource, MagUninitialize, MAGIMAGEHEADER, MW_FILTERMODE_EXCLUDE, WC_MAGNIFIER,
        };
        use windows::Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, DefWindowProcW, DestroyWindow, RegisterClassExW, SetLayeredWindowAttributes, SetWindowPos, ShowWindow, LWA_ALPHA, SET_WINDOW_POS_FLAGS, SW_HIDE, WINDOW_EX_STYLE,
            WNDCLASSEXW, WS_CHILD, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_POPUP, WS_VISIBLE,
        };

        thread_local! {
            /// The latest frame the callback handed us: (BGRA pixels, width, height).
            static LAST: RefCell<Option<(Vec<u8>, i32, i32)>> = const { RefCell::new(None) };
        }

        unsafe extern "system" fn host_proc(h: HWND, m: u32, w: WPARAM, l: LPARAM) -> LRESULT {
            DefWindowProcW(h, m, w, l)
        }

        thread_local! {
            /// What the last callback saw (for the log when no frame comes through).
            static SEEN: RefCell<String> = const { RefCell::new(String::new()) };
        }

        thread_local! {
            /// The size we asked for: a frame of any other shape is ignored.
            static WANT: std::cell::Cell<(usize, usize)> = const { std::cell::Cell::new((0, 0)) };
        }

        unsafe extern "system" fn on_frame(_: HWND, src: *mut c_void, hdr: MAGIMAGEHEADER, _: *mut c_void, _: MAGIMAGEHEADER, _: RECT, _: RECT, _: HRGN) -> BOOL {
            let (w, h, stride) = (hdr.width as usize, hdr.height as usize, hdr.stride as usize);
            SEEN.with(|x| *x.borrow_mut() = format!("callback {w}x{h} stride {stride} size {} offset {} null {}", hdr.cbSize, hdr.offset, src.is_null()));
            // Copy only a frame that is exactly what we asked for, 4 bytes a pixel, with a
            // buffer Windows says is big enough (as Chrome's capturer does). Anything else is
            // skipped: reading past the buffer here would crash the whole app.
            let (ww, wh) = WANT.with(|x| x.get());
            if src.is_null() || w == 0 || h == 0 || w != ww || h != wh || stride != w * 4 || hdr.cbSize < stride * h {
                return BOOL(1);
            }
            // Never let a Rust panic unwind into Windows here: that kills the app (0xc000041d).
            let _ = std::panic::catch_unwind(|| {
                #[allow(unused_unsafe)]
                let s = unsafe { std::slice::from_raw_parts(src as *const u8, stride * h) };
                LAST.with(|l| {
                    if let Ok(mut l) = l.try_borrow_mut() {
                        *l = Some((s.to_vec(), w as i32, h as i32));
                    }
                });
            });
            BOOL(1)
        }

        /// For the log: what happened on the last attempt.
        pub fn seen() -> String {
            SEEN.with(|x| x.borrow().clone())
        }

        pub struct Mag {
            host: HWND,
            mag: HWND,
            size: std::cell::Cell<(i32, i32)>,
        }

        impl Mag {
            pub fn new(exclude: HWND) -> Option<Self> {
                unsafe {
                    if !MagInitialize().as_bool() {
                        return None;
                    }
                    let inst = GetModuleHandleW(None).ok()?;
                    let class = w!("IslanderGlassHost");
                    let wc = WNDCLASSEXW { cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32, lpfnWndProc: Some(host_proc), hInstance: inst.into(), lpszClassName: class, ..Default::default() };
                    RegisterClassExW(&wc); // fails harmlessly when already registered
                    let Ok(host) = CreateWindowExW(WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE, class, w!(""), WS_POPUP, 0, 0, 1, 1, None, None, Some(inst.into()), None) else {
                        let _ = MagUninitialize();
                        return None;
                    };
                    let _ = SetLayeredWindowAttributes(host, COLORREF(0), 255, LWA_ALPHA);
                    // One value that owns both windows: if anything below fails, dropping it
                    // cleans up once. (Building it twice destroyed the windows on return.)
                    let mut me = Self { host, mag: HWND::default(), size: std::cell::Cell::new((-1, -1)) };
                    me.mag = CreateWindowExW(WINDOW_EX_STYLE(0), WC_MAGNIFIER, w!("IslanderGlass"), WS_CHILD | WS_VISIBLE, 0, 0, 1, 1, Some(host), None, Some(inst.into()), None).ok()?;
                    let mag = me.mag;
                    let _ = ShowWindow(host, SW_HIDE);
                    if !MagSetImageScalingCallback(mag, Some(on_frame)).as_bool() {
                        return None;
                    }
                    let mut list = [exclude];
                    if !MagSetWindowFilterList(mag, MW_FILTERMODE_EXCLUDE, 1, list.as_mut_ptr()).as_bool() {
                        return None;
                    }
                    Some(me)
                }
            }

            /// One frame of the screen area (physical px), without the excluded window.
            pub fn grab(&self, x: i32, y: i32, w: i32, h: i32) -> Option<(Vec<u8>, i32, i32)> {
                unsafe {
                    LAST.with(|l| *l.borrow_mut() = None);
                    WANT.with(|x| x.set((w.max(0) as usize, h.max(0) as usize)));
                    SEEN.with(|s| *s.borrow_mut() = "no callback".into());
                    // Resizing the magnifier clears its picture, so only do it when the size changes.
                    if self.size.get() != (w, h) {
                        self.size.set((w, h));
                        let _ = SetWindowPos(self.mag, None, 0, 0, w, h, SET_WINDOW_POS_FLAGS(0));
                    }
                    if !MagSetWindowSource(self.mag, RECT { left: x, top: y, right: x + w, bottom: y + h }).as_bool() {
                        SEEN.with(|s| *s.borrow_mut() = format!("MagSetWindowSource failed: {:?}", windows::core::Error::from_win32()));
                        return None;
                    }
                }
                LAST.with(|l| l.borrow_mut().take())
            }

            /// Some Windows versions only render the magnifier while its window is shown:
            /// show it invisibly (fully transparent, click-through, 1 px, never activated).
            pub fn show_invisibly(&self) {
                unsafe {
                    use windows::Win32::UI::WindowsAndMessaging::{GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, SWP_NOACTIVATE, SWP_SHOWWINDOW, WS_EX_TRANSPARENT, HWND_BOTTOM};
                    let ex = GetWindowLongPtrW(self.host, GWL_EXSTYLE);
                    SetWindowLongPtrW(self.host, GWL_EXSTYLE, ex | WS_EX_TRANSPARENT.0 as isize);
                    let _ = SetLayeredWindowAttributes(self.host, COLORREF(0), 1, LWA_ALPHA);
                    let _ = SetWindowPos(self.host, Some(HWND_BOTTOM), 0, 0, 1, 1, SWP_NOACTIVATE | SWP_SHOWWINDOW);
                }
            }
        }

        impl Drop for Mag {
            fn drop(&mut self) {
                unsafe {
                    let _ = DestroyWindow(self.host);
                    let _ = MagUninitialize();
                }
            }
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
