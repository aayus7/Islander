//! Windows notifications → island banners. Uses Windows' notification listener
//! (the API behind "notification mirroring"). Windows asks the user once for
//! permission; if it's refused or unavailable the island simply shows no banners.
use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Notify {
    pub id: String,
    pub app: String,
    pub title: String,
    pub body: String,
    pub icon: Option<String>,
    /// The sender's picture the app attached to the toast (e.g. a Discord avatar).
    pub avatar: Option<String>,
    /// The app asked for the avatar to be cropped round.
    pub avatar_round: bool,
    /// A photo/preview attached to the toast (hero or inline image).
    pub attachment: Option<String>,
    pub aumid: String,
}

#[cfg(windows)]
pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || imp::run(app));
}
#[cfg(not(windows))]
pub fn spawn(_app: AppHandle) {}

#[cfg(windows)]
mod imp {
    use super::*;
    use std::collections::{HashMap, HashSet};
    use std::time::Duration;
    use windows::core::Interface;
    use windows::Foundation::Size;
    use windows::Storage::Streams::IRandomAccessStreamReference;
    use windows::UI::Notifications::Management::{UserNotificationListener, UserNotificationListenerAccessStatus};
    use windows::UI::Notifications::{KnownNotificationBindings, NotificationKinds, UserNotification};

    /// Windows only exposes a toast's *text* to listeners, but it keeps the whole toast
    /// (its XML, including the image the app attached) in the user's notification
    /// database. Look the toast up there and load its picture.
    #[derive(Default)]
    struct Pictures {
        avatar: Option<String>,
        round: bool,
        attachment: Option<String>,
    }

    fn pictures_for(id: u32) -> Pictures {
        toast_xml(id).map(|x| pictures_from_toast(&x)).unwrap_or_default()
    }

    fn toast_xml(id: u32) -> Option<String> {
        let dir = std::env::var_os("LOCALAPPDATA").map(std::path::PathBuf::from)?.join(r"Microsoft\Windows\Notifications");
        let db = dir.join("wpndatabase.db");
        // The listener can see a toast a moment before Windows has written it: retry briefly.
        for attempt in 0..5 {
            match query_payload(&db, id) {
                Ok(Some(xml)) => return Some(xml),
                Ok(None) => {}
                Err(e) if attempt == 0 => {
                    eprintln!("[notify] can't read the notification database directly ({e}); trying a copy");
                    // Windows may hold it locked: read a private copy (with its WAL) instead.
                    let tmp = std::env::temp_dir().join("island-wpn");
                    let _ = std::fs::create_dir_all(&tmp);
                    for f in ["wpndatabase.db", "wpndatabase.db-wal", "wpndatabase.db-shm"] {
                        let _ = std::fs::copy(dir.join(f), tmp.join(f));
                    }
                    match query_payload(&tmp.join("wpndatabase.db"), id) {
                        Ok(Some(xml)) => return Some(xml),
                        Ok(None) => {}
                        Err(e) => {
                            eprintln!("[notify] copy unreadable too ({e})");
                            return None;
                        }
                    }
                }
                Err(_) => {}
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        eprintln!("[notify] toast {id} not found in the notification database");
        None
    }

    fn query_payload(db: &std::path::Path, id: u32) -> Result<Option<String>, String> {
        let flags = rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX;
        let conn = rusqlite::Connection::open_with_flags(db, flags).map_err(|e| e.to_string())?;
        let _ = conn.busy_timeout(Duration::from_millis(300));
        match conn.query_row("SELECT Payload FROM Notification WHERE Id = ?1", [id as i64], |r| r.get::<_, Vec<u8>>(0)) {
            Ok(p) => Ok(Some(String::from_utf8_lossy(&p).to_string())),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    /// The toast's pictures: the app-logo override is the sender (avatar); a hero or
    /// inline image is an attachment (shown as a thumbnail, like iOS).
    fn pictures_from_toast(xml: &str) -> Pictures {
        let tags: Vec<&str> = xml.split("<image").skip(1).map(|t| t.split('>').next().unwrap_or("")).collect();
        let attr = |tag: &str, name: &str| -> Option<String> {
            let key = format!("{name}=\"");
            let start = tag.find(&key)? + key.len();
            let end = tag[start..].find('"')? + start;
            Some(tag[start..end].replace("&amp;", "&").replace("&quot;", "\"").replace("&apos;", "'"))
        };
        // A toast about a file (WhatsApp "Downloaded video.mp4", a browser download…) uses
        // the logo slot for the file type's icon, not a person.
        let texts: String = xml
            .split("<text")
            .skip(1)
            .filter_map(|t| t.split_once('>').map(|(_, rest)| rest.split("</text>").next().unwrap_or("")))
            .collect::<Vec<_>>()
            .join(" ")
            .to_lowercase();
        let about_file = texts.contains("download")
            || texts.split(|c: char| c.is_whitespace() || c == '"' || c == '\'' ).any(|w| {
                let w = w.trim_end_matches(|c: char| matches!(c, '.' | ',' | ')' | '!' | '?'));
                w.rsplit_once('.').is_some_and(|(stem, ext)| {
                    !stem.is_empty()
                        && matches!(
                            ext,
                            "mp4" | "mkv" | "mov" | "avi" | "webm" | "mp3" | "wav" | "flac" | "m4a" | "ogg" | "opus" | "jpg" | "jpeg" | "png" | "gif" | "webp" | "heic" | "pdf" | "doc"
                                | "docx" | "xls" | "xlsx" | "ppt" | "pptx" | "txt" | "zip" | "rar" | "7z" | "exe" | "msi" | "apk" | "csv"
                        )
                })
            });
        let mut out = Pictures::default();
        if tags.is_empty() {
            eprintln!("[notify] toast has no images");
        }
        for t in &tags {
            let Some(src) = attr(t, "src") else { continue };
            eprintln!("[notify] toast image ({}): {}", attr(t, "placement").unwrap_or_else(|| "inline".into()), src.chars().take(160).collect::<String>());
            match attr(t, "placement").as_deref() {
                // The logo override is normally the sender (Discord, Teams, WhatsApp chats…).
                // On a toast about a file it's the file type's icon (e.g. WhatsApp
                // "Downloaded video.mp4" shows the video player's icon) — skip it then,
                // so the app's own logo is used.
                Some("appLogoOverride") if out.avatar.is_none() && !about_file => {
                    out.avatar = load_image(&src);
                    out.round = true; // a person: shown round, like iOS
                }
                Some("appLogoOverride") => {}
                _ if out.attachment.is_none() => out.attachment = load_image(&src),
                _ => {}
            }
        }
        out
    }

    fn load_image(src: &str) -> Option<String> {
        use base64::Engine;
        if src.starts_with("http://") || src.starts_with("https://") || src.starts_with("data:") {
            return Some(src.to_string());
        }
        let path = src.strip_prefix("file:///").or_else(|| src.strip_prefix("file://")).unwrap_or(src);
        let path = percent_decode(path).replace('/', "\\");
        let bytes = match std::fs::read(&path) {
            Ok(b) => b,
            Err(e) => {
                eprintln!("[notify] can't read image {path}: {e}");
                return None;
            }
        };
        if bytes.is_empty() || bytes.len() > 4_000_000 {
            return None;
        }
        let lower = path.to_lowercase();
        let mime = if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
            "image/jpeg"
        } else if lower.ends_with(".gif") {
            "image/gif"
        } else if lower.ends_with(".webp") {
            "image/webp"
        } else {
            "image/png"
        };
        Some(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
    }

    fn percent_decode(s: &str) -> String {
        let b = s.as_bytes();
        let mut out = Vec::with_capacity(b.len());
        let mut i = 0;
        while i < b.len() {
            if b[i] == b'%' && i + 2 < b.len() {
                if let Some(v) = std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) {
                    out.push(v);
                    i += 3;
                    continue;
                }
            }
            out.push(b[i]);
            i += 1;
        }
        String::from_utf8_lossy(&out).to_string()
    }

    /// The app's logo. Store apps hand it over with the notification; desktop apps
    /// (Discord, Slack, WhatsApp desktop…) usually don't, so fall back to the icon of
    /// the app's running .exe, matched by its AppUserModelId or name.
    fn app_icon(display: Option<&windows::ApplicationModel::AppDisplayInfo>, aumid: &str, name: &str) -> Option<String> {
        let from_logo = display.and_then(|d| {
            let logo = d.GetLogo(Size { Width: 64.0, Height: 64.0 }).ok()?;
            crate::media::read_thumbnail(&logo.cast::<IRandomAccessStreamReference>().ok()?).ok()
        });
        if from_logo.is_some() {
            return from_logo;
        }
        // "com.squirrel.Discord.Discord" → "discord"; "C:\…\Slack.exe" → "slack"; or the display name.
        let mut candidates: Vec<String> = Vec::new();
        let last = aumid.rsplit(['.', '\\', '/', '!']).find(|s| !s.is_empty() && !s.eq_ignore_ascii_case("exe")).unwrap_or("");
        candidates.push(last.to_lowercase());
        candidates.push(name.to_lowercase().replace(' ', ""));
        candidates.push(name.to_lowercase().split_whitespace().next().unwrap_or("").to_string());
        candidates.dedup();
        candidates.into_iter().filter(|c| !c.is_empty()).find_map(|c| crate::media::exe_icon(&c))
    }

    fn describe(n: &UserNotification, icons: &mut HashMap<String, Option<String>>) -> Option<Notify> {
        let info = n.AppInfo().ok()?;
        let aumid = info.AppUserModelId().map(|h| h.to_string()).unwrap_or_default();
        let display = info.DisplayInfo().ok();
        let app = display.as_ref().and_then(|d| d.DisplayName().ok()).map(|h| h.to_string()).unwrap_or_else(|| "Notification".into());
        let binding = n.Notification().ok()?.Visual().ok()?.GetBinding(&KnownNotificationBindings::ToastGeneric().ok()?).ok()?;
        let texts: Vec<String> = binding.GetTextElements().ok()?.into_iter().filter_map(|t| t.Text().ok().map(|h| h.to_string())).collect();
        let title = texts.first().cloned().unwrap_or_default();
        let body = texts.iter().skip(1).cloned().collect::<Vec<_>>().join(" — ");
        if title.is_empty() && body.is_empty() {
            return None;
        }
        let icon = match icons.get(&aumid) {
            Some(Some(i)) => Some(i.clone()),
            _ => {
                let found = app_icon(display.as_ref(), &aumid, &app);
                // Cache hits; keep retrying misses (the app may not have been running yet).
                icons.insert(aumid.clone(), found.clone());
                found
            }
        };
        let id = n.Id().ok()?;
        crate::takeover::hush_app(&aumid);
        let pics = pictures_for(id);
        Some(Notify { id: id.to_string(), app, title, body, icon, avatar: pics.avatar, avatar_round: pics.round, attachment: pics.attachment, aumid })
    }

    pub fn run(app: AppHandle) {
        let listener = match UserNotificationListener::Current() {
            Ok(l) => l,
            Err(e) => {
                eprintln!("notifications: listener unavailable ({e})");
                let _ = app.emit("notify://status", "unavailable");
                return;
            }
        };
        let mut status = listener.GetAccessStatus().unwrap_or(UserNotificationListenerAccessStatus::Unspecified);
        if status != UserNotificationListenerAccessStatus::Allowed {
            status = listener
                .RequestAccessAsync()
                .and_then(|op| op.get())
                .unwrap_or(UserNotificationListenerAccessStatus::Denied);
        }
        if status != UserNotificationListenerAccessStatus::Allowed {
            eprintln!("notifications: access not granted ({status:?})");
            let _ = app.emit("notify://status", "denied");
            return;
        }
        let _ = app.emit("notify://status", "allowed");

        let mut seen: HashSet<u32> = HashSet::new();
        let mut icons: HashMap<String, Option<String>> = HashMap::new();
        let mut first = true;
        loop {
            if let Ok(list) = listener.GetNotificationsAsync(NotificationKinds::Toast).and_then(|op| op.get()) {
                let mut now = HashSet::new();
                for n in list {
                    let Ok(id) = n.Id() else { continue };
                    now.insert(id);
                    if seen.contains(&id) || first {
                        continue;
                    }
                    if let Some(info) = describe(&n, &mut icons) {
                        let _ = app.emit("notify://new", info);
                    }
                }
                seen = now;
                first = false;
            }
            std::thread::sleep(Duration::from_millis(1200));
        }
    }
}
