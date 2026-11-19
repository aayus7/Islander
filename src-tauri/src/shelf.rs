//! File Shelf: files/folders dropped on the island, kept until removed
//! (saved in shelf.json so they survive restarts). Holds references to the
//! originals — nothing is copied or moved.
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ShelfItem {
    pub id: String,
    pub path: String,
    pub name: String,
    /// "file" | "folder" | "image"
    pub kind: String,
    pub size: u64,
    pub thumb: Option<String>,
    pub ext: String,
}

static ITEMS: Mutex<Vec<ShelfItem>> = Mutex::new(Vec::new());
static LOADED: Mutex<bool> = Mutex::new(false);

const IMAGE_EXT: [&str; 9] = ["png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff", "heic"];

fn file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("shelf.json"))
}

/// Where the Shelf keeps its own copies of files that would otherwise vanish: a photo
/// dragged from a browser arrives as a temporary file, which the browser deletes as soon
/// as the drag ends.
fn keep_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("shelf-files"))
}

fn is_temp(p: &str) -> bool {
    let l = p.to_lowercase().replace('/', "\\");
    let t = std::env::temp_dir().to_string_lossy().to_lowercase().replace('/', "\\");
    let t = t.trim_end_matches('\\');
    (!t.is_empty() && l.starts_with(&format!("{t}\\"))) || l.contains("\\appdata\\local\\temp\\") || l.contains("\\inetcache\\") || l.contains("\\temporary internet files\\")
}

/// Swap temporary files for copies the Shelf owns (anything else is left as it is).
/// Called the moment something is dropped, while the browser's temp file still exists.
pub fn rescue(app: &AppHandle, paths: Vec<String>) -> Vec<String> {
    let Some(dir) = keep_dir(app) else { return paths };
    paths
        .into_iter()
        .map(|p| {
            let src = Path::new(&p);
            if !is_temp(&p) || !src.is_file() {
                return p;
            }
            let Some(name) = src.file_name() else { return p };
            let dest_dir = dir.join(new_id());
            let dest = dest_dir.join(name);
            match std::fs::create_dir_all(&dest_dir).and_then(|_| std::fs::copy(src, &dest)) {
                Ok(_) => {
                    eprintln!("[shelf] kept a copy of temporary file {p}");
                    dest.to_string_lossy().to_string()
                }
                Err(e) => {
                    eprintln!("[shelf] couldn't copy temporary file {p}: {e}");
                    p
                }
            }
        })
        .collect()
}

/// Deletes the Shelf's own copy behind a removed item (never a file of yours).
fn forget_copy(app: &AppHandle, path: &str) {
    let Some(dir) = keep_dir(app) else { return };
    let p = Path::new(path);
    if let Some(parent) = p.parent() {
        if parent.parent() == Some(dir.as_path()) {
            let _ = std::fs::remove_dir_all(parent);
        }
    }
}

fn load(app: &AppHandle) {
    let mut loaded = LOADED.lock().unwrap();
    if *loaded {
        return;
    }
    *loaded = true;
    if let Some(items) = file(app).and_then(|p| std::fs::read_to_string(p).ok()).and_then(|s| serde_json::from_str::<Vec<ShelfItem>>(&s).ok()) {
        // Forget things that were deleted or moved while we were away.
        *ITEMS.lock().unwrap() = items.into_iter().filter(|i| Path::new(&i.path).exists()).collect();
    }
    // Copies no item uses any more (removed while we weren't running, or past 40 items).
    if let Some(dir) = keep_dir(app) {
        let used: Vec<String> = ITEMS.lock().unwrap().iter().map(|i| i.path.to_lowercase()).collect();
        for e in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let sub = e.path().to_string_lossy().to_lowercase();
            if !used.iter().any(|u| u.starts_with(&format!("{sub}\\")) || u.starts_with(&format!("{sub}/"))) {
                let _ = std::fs::remove_dir_all(e.path());
            }
        }
    }
    // And while running: a file deleted (or moved) in Explorer leaves the Shelf within ~2 s.
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(2));
        prune(&app);
    });
}

/// Drops items whose file or folder no longer exists. A handful of stat calls (≤ 40 items).
fn prune(app: &AppHandle) {
    let paths: Vec<(String, String)> = ITEMS.lock().unwrap().iter().map(|i| (i.id.clone(), i.path.clone())).collect();
    let gone: Vec<String> = paths.into_iter().filter(|(_, p)| !Path::new(p).exists()).map(|(id, _)| id).collect();
    if gone.is_empty() {
        return;
    }
    ITEMS.lock().unwrap().retain(|i| !gone.contains(&i.id));
    save_and_emit(app);
}

fn save_and_emit(app: &AppHandle) {
    let items = ITEMS.lock().unwrap().clone();
    if let Some(p) = file(app) {
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(p, serde_json::to_string(&items).unwrap_or_default());
    }
    let _ = app.emit("shelf://changed", items);
}

fn new_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let t = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    format!("{t:x}{:x}", N.fetch_add(1, std::sync::atomic::Ordering::Relaxed))
}

fn describe(path: &str) -> Option<ShelfItem> {
    let p = Path::new(path);
    let meta = std::fs::metadata(p).ok()?;
    let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| path.to_string());
    let ext = p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    let kind = if meta.is_dir() {
        "folder"
    } else if IMAGE_EXT.contains(&ext.as_str()) {
        "image"
    } else {
        "file"
    };
    #[cfg(windows)]
    let thumb = crate::media::shell_thumb(path, if kind == "image" { 160 } else { 96 }, kind == "image");
    #[cfg(not(windows))]
    let thumb = None;
    Some(ShelfItem { id: new_id(), path: path.to_string(), name, kind: kind.into(), size: if meta.is_dir() { 0 } else { meta.len() }, thumb, ext })
}

fn find(id: &str) -> Option<ShelfItem> {
    ITEMS.lock().unwrap().iter().find(|i| i.id == id).cloned()
}

/* ---------------- commands ---------------- */

/// Windows blocks drag-and-drop from Explorer into apps running as administrator.
#[tauri::command]
pub fn shelf_elevated() -> bool {
    #[cfg(windows)]
    unsafe {
        return windows::Win32::UI::Shell::IsUserAnAdmin().as_bool();
    }
    #[allow(unreachable_code)]
    false
}

#[tauri::command]
pub fn shelf_list(app: AppHandle) -> Vec<ShelfItem> {
    load(&app);
    ITEMS.lock().unwrap().clone()
}

#[tauri::command]
pub async fn shelf_add(app: AppHandle, paths: Vec<String>) -> Result<(), String> {
    load(&app);
    eprintln!("[shelf] adding {} item(s)", paths.len());
    let paths = rescue(&app, paths);
    let fresh: Vec<ShelfItem> = tauri::async_runtime::spawn_blocking(move || {
        let have: Vec<String> = ITEMS.lock().unwrap().iter().map(|i| i.path.to_lowercase()).collect();
        paths.iter().filter(|p| !have.contains(&p.to_lowercase())).filter_map(|p| describe(p)).collect()
    })
    .await
    .map_err(|e| e.to_string())?;
    eprintln!("[shelf] {} new item(s) after de-duplication", fresh.len());
    if !fresh.is_empty() {
        let mut items = ITEMS.lock().unwrap();
        items.extend(fresh);
        let n = items.len();
        if n > 40 {
            items.drain(0..n - 40);
        }
    }
    save_and_emit(&app);
    Ok(())
}

#[tauri::command]
pub fn shelf_remove(app: AppHandle, id: String) {
    let gone: Vec<String> = ITEMS.lock().unwrap().iter().filter(|i| i.id == id).map(|i| i.path.clone()).collect();
    gone.iter().for_each(|p| forget_copy(&app, p));
    ITEMS.lock().unwrap().retain(|i| i.id != id);
    save_and_emit(&app);
}

#[tauri::command]
pub fn shelf_clear(app: AppHandle) {
    let gone: Vec<String> = ITEMS.lock().unwrap().iter().map(|i| i.path.clone()).collect();
    gone.iter().for_each(|p| forget_copy(&app, p));
    ITEMS.lock().unwrap().clear();
    save_and_emit(&app);
}

#[tauri::command]
pub async fn shelf_open(id: String) -> Result<(), String> {
    let it = find(&id).ok_or("not on the shelf")?;
    tauri::async_runtime::spawn_blocking(move || crate::system::open(&it.path, "open")).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn shelf_reveal(id: String) -> Result<(), String> {
    let it = find(&id).ok_or("not on the shelf")?;
    crate::system::reveal(&it.path)
}

/// Convert an image to jpg / png / webp next to the original, and add the result to the shelf.
#[tauri::command]
pub async fn shelf_convert(app: AppHandle, id: String, format: String) -> Result<(), String> {
    let it = find(&id).ok_or("not on the shelf")?;
    let out = tauri::async_runtime::spawn_blocking(move || convert(&it.path, &format)).await.map_err(|e| e.to_string())??;
    shelf_add(app, vec![out]).await
}

pub fn convert(src: &str, format: &str) -> Result<String, String> {
    use image::{DynamicImage, ImageFormat};
    let img = image::open(src).map_err(|e| format!("can't read image: {e}"))?;
    let (fmt, ext) = match format {
        "jpg" | "jpeg" => (ImageFormat::Jpeg, "jpg"),
        "webp" => (ImageFormat::WebP, "webp"),
        _ => (ImageFormat::Png, "png"),
    };
    let img = match fmt {
        // JPEG has no transparency: flatten onto white like Preview/Photos do.
        ImageFormat::Jpeg => {
            let rgba = img.to_rgba8();
            let mut rgb = image::RgbImage::new(rgba.width(), rgba.height());
            for (x, y, p) in rgba.enumerate_pixels() {
                let a = p[3] as f32 / 255.0;
                let blend = |c: u8| (c as f32 * a + 255.0 * (1.0 - a)).round() as u8;
                rgb.put_pixel(x, y, image::Rgb([blend(p[0]), blend(p[1]), blend(p[2])]));
            }
            DynamicImage::ImageRgb8(rgb)
        }
        ImageFormat::WebP => DynamicImage::ImageRgba8(img.to_rgba8()),
        _ => img,
    };
    let srcp = Path::new(src);
    let stem = srcp.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "image".into());
    let dirs = [srcp.parent().map(Path::to_path_buf), dirs_downloads(), Some(std::env::temp_dir())];
    for dir in dirs.into_iter().flatten() {
        let mut out = dir.join(format!("{stem}.{ext}"));
        let mut n = 1;
        while out.exists() {
            out = dir.join(format!("{stem} ({n}).{ext}"));
            n += 1;
        }
        if img.save_with_format(&out, fmt).is_ok() {
            return Ok(out.to_string_lossy().to_string());
        }
    }
    Err("couldn't save the converted image".into())
}

fn dirs_downloads() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE").map(|h| PathBuf::from(h).join("Downloads"))
}
