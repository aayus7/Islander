//! Clipboard history: watches the Windows clipboard for text, links, images and
//! copied files. Pinned items and recent history are saved (images as PNGs in the
//! app's data folder). Content that password managers mark as private is skipped.
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ClipItem {
    pub id: String,
    /// "text" | "link" | "image" | "files"
    pub kind: String,
    pub text: String,
    pub thumb: Option<String>,
    pub path: Option<String>,
    pub files: Vec<String>,
    pub pinned: bool,
    pub at: u64,
    /// Content fingerprint, to avoid duplicates when the same thing is copied again.
    #[serde(default)]
    pub sig: u64,
}

static ITEMS: Mutex<Vec<ClipItem>> = Mutex::new(Vec::new());
/// Sequence number of a clipboard change we made ourselves (ignore it).
static OWN_SEQ: Mutex<u32> = Mutex::new(0);
const MAX_UNPINNED: usize = 40;

fn data_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok()
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn hash(bytes: &[u8]) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut h);
    h.finish()
}

fn save_and_emit(app: &AppHandle) {
    let items = ITEMS.lock().unwrap().clone();
    if let Some(dir) = data_dir(app) {
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(dir.join("clipboard.json"), serde_json::to_string(&items).unwrap_or_default());
    }
    let _ = app.emit("clip://changed", items);
}

fn load(app: &AppHandle) {
    if let Some(items) = data_dir(app)
        .and_then(|d| std::fs::read_to_string(d.join("clipboard.json")).ok())
        .and_then(|s| serde_json::from_str::<Vec<ClipItem>>(&s).ok())
    {
        *ITEMS.lock().unwrap() = items;
    }
}

/// Put a new capture on top (or bump an identical existing one).
fn push(app: &AppHandle, mut item: ClipItem) {
    {
        let mut items = ITEMS.lock().unwrap();
        if let Some(pos) = items.iter().position(|i| i.sig == item.sig && i.kind == item.kind) {
            let mut old = items.remove(pos);
            old.at = item.at;
            items.insert(0, old);
        } else {
            item.id = format!("{:x}{:x}", item.at, item.sig & 0xffff);
            items.insert(0, item);
        }
        // Trim unpinned history (and its image files).
        let mut unpinned = 0;
        let mut dropped = Vec::new();
        items.retain(|i| {
            if i.pinned {
                return true;
            }
            unpinned += 1;
            if unpinned > MAX_UNPINNED {
                dropped.extend(i.path.clone());
                false
            } else {
                true
            }
        });
        for p in dropped {
            let _ = std::fs::remove_file(p);
        }
    }
    save_and_emit(app);
}

fn is_link(t: &str) -> bool {
    let t = t.trim();
    !t.contains(char::is_whitespace) && (t.starts_with("http://") || t.starts_with("https://") || t.starts_with("www."))
}

#[cfg(windows)]
pub fn spawn(app: AppHandle) {
    load(&app);
    std::thread::spawn(move || imp::watch(app));
}
#[cfg(not(windows))]
pub fn spawn(app: AppHandle) {
    load(&app);
}

#[cfg(windows)]
mod imp {
    use super::*;
    use std::time::Duration;
    use windows::core::w;
    use windows::Win32::Foundation::{HANDLE, HGLOBAL};
    use windows::Win32::System::DataExchange::*;
    use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
    use windows::Win32::System::Ole::{CF_DIB, CF_HDROP, CF_UNICODETEXT};
    use windows::Win32::UI::Shell::{DragQueryFileW, HDROP};

    /// Holds the clipboard open; closes on drop. Retries briefly if another app has it.
    struct Open;
    impl Open {
        fn new() -> Option<Open> {
            for _ in 0..10 {
                if unsafe { OpenClipboard(None) }.is_ok() {
                    return Some(Open);
                }
                std::thread::sleep(Duration::from_millis(15));
            }
            None
        }
    }
    impl Drop for Open {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseClipboard();
            }
        }
    }

    fn has(fmt: u32) -> bool {
        unsafe { IsClipboardFormatAvailable(fmt).is_ok() }
    }

    fn read_bytes(fmt: u32) -> Option<Vec<u8>> {
        unsafe {
            let h = GetClipboardData(fmt).ok()?;
            let g = HGLOBAL(h.0);
            let size = GlobalSize(g);
            let p = GlobalLock(g) as *const u8;
            if p.is_null() || size == 0 {
                return None;
            }
            let v = std::slice::from_raw_parts(p, size).to_vec();
            let _ = GlobalUnlock(g);
            Some(v)
        }
    }

    fn read_text() -> Option<String> {
        let b = read_bytes(CF_UNICODETEXT.0 as u32)?;
        let u: Vec<u16> = b.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        let end = u.iter().position(|&c| c == 0).unwrap_or(u.len());
        Some(String::from_utf16_lossy(&u[..end]))
    }

    fn read_files() -> Vec<String> {
        unsafe {
            let Ok(h) = GetClipboardData(CF_HDROP.0 as u32) else { return vec![] };
            let drop = HDROP(h.0);
            let n = DragQueryFileW(drop, u32::MAX, None);
            (0..n)
                .filter_map(|i| {
                    let len = DragQueryFileW(drop, i, None) as usize;
                    let mut buf = vec![0u16; len + 1];
                    let got = DragQueryFileW(drop, i, Some(&mut buf)) as usize;
                    (got > 0).then(|| String::from_utf16_lossy(&buf[..got]))
                })
                .collect()
        }
    }

    /// The copied image as an RGBA image: the "PNG" format if offered (keeps transparency), else the DIB.
    fn read_image(png_fmt: u32) -> Option<image::DynamicImage> {
        if png_fmt != 0 && has(png_fmt) {
            if let Some(img) = read_bytes(png_fmt).and_then(|b| image::load_from_memory(&b).ok()) {
                return Some(img);
            }
        }
        let dib = read_bytes(CF_DIB.0 as u32)?;
        // A DIB is a .bmp file without its 14-byte file header: add one and decode as BMP.
        let header_size = u32::from_le_bytes(dib.get(0..4)?.try_into().ok()?) as usize;
        let bit_count = u16::from_le_bytes(dib.get(14..16)?.try_into().ok()?);
        let compression = u32::from_le_bytes(dib.get(16..20)?.try_into().ok()?);
        let colors_used = u32::from_le_bytes(dib.get(32..36)?.try_into().ok()?) as usize;
        let masks = if compression == 3 && header_size == 40 { 12 } else { 0 };
        let palette = if bit_count <= 8 { (if colors_used == 0 { 1 << bit_count } else { colors_used }) * 4 } else { colors_used * 4 };
        let offset = 14 + header_size + masks + palette;
        let mut bmp = Vec::with_capacity(dib.len() + 14);
        bmp.extend_from_slice(b"BM");
        bmp.extend_from_slice(&((dib.len() + 14) as u32).to_le_bytes());
        bmp.extend_from_slice(&[0, 0, 0, 0]);
        bmp.extend_from_slice(&(offset as u32).to_le_bytes());
        bmp.extend_from_slice(&dib);
        let img = image::load_from_memory_with_format(&bmp, image::ImageFormat::Bmp).ok()?;
        // 32-bit DIBs often carry a junk (all-zero) alpha channel: treat as opaque.
        let mut rgba = img.to_rgba8();
        if bit_count == 32 && rgba.pixels().all(|p| p[3] == 0) {
            for p in rgba.pixels_mut() {
                p[3] = 255;
            }
        }
        Some(image::DynamicImage::ImageRgba8(rgba))
    }

    fn data_url_png(img: &image::DynamicImage) -> Option<String> {
        use base64::Engine;
        let mut buf = std::io::Cursor::new(Vec::new());
        img.write_to(&mut buf, image::ImageFormat::Png).ok()?;
        Some(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(buf.into_inner())))
    }

    pub fn watch(app: AppHandle) {
        let png_fmt = unsafe { RegisterClipboardFormatW(w!("PNG")) };
        let exclude = unsafe { RegisterClipboardFormatW(w!("ExcludeClipboardContentFromMonitorProcessing")) };
        let no_history = unsafe { RegisterClipboardFormatW(w!("CanIncludeInClipboardHistory")) };
        let mut seq = unsafe { GetClipboardSequenceNumber() };
        loop {
            std::thread::sleep(Duration::from_millis(300));
            let now = unsafe { GetClipboardSequenceNumber() };
            if now == seq {
                continue;
            }
            seq = now;
            if *OWN_SEQ.lock().unwrap() == now {
                continue;
            }
            let enabled = app.state::<crate::St>().store.get().clipboard_history;
            if !enabled {
                continue;
            }
            std::thread::sleep(Duration::from_millis(60)); // let the source finish writing all formats
            let Some(guard) = Open::new() else { continue };
            // Respect password managers & apps that opt out of history.
            if has(exclude) {
                continue;
            }
            if has(no_history) {
                if let Some(b) = read_bytes(no_history) {
                    if b.get(0..4).map(|d| u32::from_le_bytes([d[0], d[1], d[2], d[3]])) == Some(0) {
                        continue;
                    }
                }
            }
            let at = now_ms();
            let item = if has(CF_HDROP.0 as u32) {
                let files = read_files();
                drop(guard);
                if files.is_empty() {
                    continue;
                }
                let text = if files.len() == 1 {
                    std::path::Path::new(&files[0]).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| files[0].clone())
                } else {
                    format!("{} files", files.len())
                };
                ClipItem { id: String::new(), kind: "files".into(), sig: hash(files.join("|").as_bytes()), text, thumb: None, path: None, files, pinned: false, at }
            } else if has(png_fmt) || has(CF_DIB.0 as u32) {
                let img = read_image(png_fmt);
                drop(guard);
                let Some(img) = img else { continue };
                let sig = hash(img.as_bytes());
                let thumb = data_url_png(&img.thumbnail(96, 96));
                let path = data_dir(&app).and_then(|d| {
                    let dir = d.join("clips");
                    std::fs::create_dir_all(&dir).ok()?;
                    let p = dir.join(format!("clip-{sig:x}.png"));
                    img.save_with_format(&p, image::ImageFormat::Png).ok()?;
                    Some(p.to_string_lossy().to_string())
                });
                let text = format!("Image · {}×{}", img.width(), img.height());
                ClipItem { id: String::new(), kind: "image".into(), sig, text, thumb, path, files: vec![], pinned: false, at }
            } else if has(CF_UNICODETEXT.0 as u32) {
                let t = read_text();
                drop(guard);
                let Some(t) = t else { continue };
                if t.trim().is_empty() {
                    continue;
                }
                let text: String = t.chars().take(4000).collect();
                let kind = if is_link(&text) { "link" } else { "text" };
                ClipItem { id: String::new(), kind: kind.into(), sig: hash(text.as_bytes()), text, thumb: None, path: None, files: vec![], pinned: false, at }
            } else {
                continue;
            };
            push(&app, item);
        }
    }

    /// Put a history item back on the clipboard.
    pub fn copy(item: &ClipItem) -> Result<(), String> {
        let _g = Open::new().ok_or("clipboard is busy")?;
        unsafe {
            EmptyClipboard().map_err(|e| e.to_string())?;
            let set = |fmt: u32, bytes: &[u8]| -> Result<(), String> {
                let h = crate::dragout::imp::global(bytes).map_err(|e| e.to_string())?;
                SetClipboardData(fmt, Some(HANDLE(h.0))).map(|_| ()).map_err(|e| e.to_string())
            };
            match item.kind.as_str() {
                "files" => set(CF_HDROP.0 as u32, &crate::dragout::hdrop_bytes(&item.files))?,
                "image" => {
                    let path = item.path.as_ref().ok_or("image is gone")?;
                    let img = image::open(path).map_err(|e| e.to_string())?;
                    // PNG for apps that understand it (keeps transparency) + a DIB for everyone else.
                    let png = std::fs::read(path).map_err(|e| e.to_string())?;
                    let png_fmt = RegisterClipboardFormatW(w!("PNG"));
                    let _ = set(png_fmt, &png);
                    let mut bmp = std::io::Cursor::new(Vec::new());
                    image::DynamicImage::ImageRgb8(img.to_rgb8()).write_to(&mut bmp, image::ImageFormat::Bmp).map_err(|e| e.to_string())?;
                    let bmp = bmp.into_inner();
                    if bmp.len() > 14 {
                        set(CF_DIB.0 as u32, &bmp[14..])?;
                    }
                }
                _ => {
                    let mut b: Vec<u8> = item.text.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
                    b.extend_from_slice(&[0, 0]);
                    set(CF_UNICODETEXT.0 as u32, &b)?;
                }
            }
        }
        *OWN_SEQ.lock().unwrap() = unsafe { GetClipboardSequenceNumber() };
        Ok(())
    }
}

/* ---------------- commands ---------------- */

#[tauri::command]
pub fn clip_list() -> Vec<ClipItem> {
    ITEMS.lock().unwrap().clone()
}

#[tauri::command]
pub async fn clip_copy(app: AppHandle, id: String) -> Result<(), String> {
    let item = ITEMS.lock().unwrap().iter().find(|i| i.id == id).cloned().ok_or("not found")?;
    #[cfg(windows)]
    tauri::async_runtime::spawn_blocking(move || imp::copy(&item)).await.map_err(|e| e.to_string())??;
    #[cfg(not(windows))]
    let _ = item;
    // Copying an old item moves it to the top, like Paste/Raycast.
    {
        let mut items = ITEMS.lock().unwrap();
        if let Some(pos) = items.iter().position(|i| i.id == id) {
            let mut it = items.remove(pos);
            it.at = now_ms();
            items.insert(0, it);
        }
    }
    save_and_emit(&app);
    Ok(())
}

#[tauri::command]
pub fn clip_pin(app: AppHandle, id: String, pinned: bool) {
    if let Some(i) = ITEMS.lock().unwrap().iter_mut().find(|i| i.id == id) {
        i.pinned = pinned;
    }
    save_and_emit(&app);
}

#[tauri::command]
pub fn clip_delete(app: AppHandle, id: String) {
    let mut gone = None;
    ITEMS.lock().unwrap().retain(|i| {
        if i.id == id {
            gone = i.path.clone();
            false
        } else {
            true
        }
    });
    if let Some(p) = gone {
        let _ = std::fs::remove_file(p);
    }
    save_and_emit(&app);
}

/// Clear history; pinned items stay.
#[tauri::command]
pub fn clip_clear(app: AppHandle) {
    let mut paths = Vec::new();
    ITEMS.lock().unwrap().retain(|i| {
        if !i.pinned {
            paths.extend(i.path.clone());
        }
        i.pinned
    });
    for p in paths {
        let _ = std::fs::remove_file(p);
    }
    save_and_emit(&app);
}
