//! Media sessions via Windows' Global System Media Transport Controls (GSMTC) —
//! the same API behind the volume flyout's media controls. Works with Spotify,
//! browsers, Media Player, and anything else that reports to Windows.
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Serialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MediaSession {
    pub id: String,
    pub app: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub artwork: Option<String>,
    /// App or site logo as a data: URL (None → the UI draws a letter badge).
    pub icon: Option<String>,
    pub playing: bool,
    pub position: f64,
    pub duration: f64,
    pub sampled_at: f64,
    pub can_next: bool,
    pub can_prev: bool,
    pub can_seek: bool,
    /// The app is actually producing sound right now (per-app audio meter / tab audio).
    pub audible: bool,
    /// Playback speed (1.0 normal) so the UI clock runs at the right pace.
    pub rate: f64,
    /// "windows" | "extension"
    pub source: String,
    /// A live stream: no timeline, the UI shows the LIVE bar.
    pub live: bool,
}

#[derive(Serialize, Clone, PartialEq, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct MediaState {
    pub sessions: Vec<MediaSession>,
    pub current_id: Option<String>,
}

static FORCE_EMIT: AtomicBool = AtomicBool::new(true);

/// Ask the watcher to re-send the current state (e.g. when the UI reloads).
pub fn request_refresh() {
    FORCE_EMIT.store(true, Ordering::Relaxed);
}

/// "Spotify.exe" → "Spotify", "Microsoft.ZuneMusic_…!App" → "Media Player", etc.
#[allow(dead_code)]
fn friendly_app_name(id: &str) -> String {
    let lower = id.to_lowercase();
    let known = [
        ("308046b0af4a39cb", "Firefox"), // Firefox's AppUserModelId
        ("6f193ccc56814779", "Firefox"),
        ("spotify", "Spotify"),
        ("zunemusic", "Media Player"),
        ("msedge", "Edge"),
        ("chrome", "Chrome"),
        ("firefox", "Firefox"),
        ("brave", "Brave"),
        ("opera", "Opera"),
        ("vlc", "VLC"),
        ("applemusic", "Apple Music"),
        ("itunes", "iTunes"),
        ("tidal", "TIDAL"),
        ("deezer", "Deezer"),
        ("foobar", "foobar2000"),
        ("musicbee", "MusicBee"),
        ("aimp", "AIMP"),
    ];
    for (needle, name) in known {
        if lower.contains(needle) {
            return name.to_string();
        }
    }
    // Some apps report an opaque hex ID instead of a name.
    if id.len() >= 12 && id.chars().all(|c| c.is_ascii_hexdigit()) {
        return "Browser".into();
    }
    let base = id.rsplit(['\\', '/', '!']).next().unwrap_or(id);
    let base = base.trim_end_matches(".exe").trim_end_matches(".EXE");
    let base = base.split('_').next().unwrap_or(base);
    let base = base.rsplit('.').next().unwrap_or(base);
    let mut c = base.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => "Media".into(),
    }
}

/// GSMTC id → the exe stem the audio meters report ("Spotify.exe" → "spotify").
pub fn exe_for_id(id: &str) -> String {
    let lower = id.to_lowercase();
    for (needle, exe) in [
        ("308046b0af4a39cb", "firefox"),
        ("6f193ccc56814779", "firefox"),
        ("firefox", "firefox"),
        ("msedge", "msedge"),
        ("chrome", "chrome"),
        ("brave", "brave"),
        ("opera", "opera"),
        ("spotify", "spotify"),
        ("zunemusic", "microsoft.media.player"),
    ] {
        if lower.contains(needle) {
            return exe.into();
        }
    }
    let base = lower.rsplit(['\\', '/', '!']).next().unwrap_or(&lower);
    base.trim_end_matches(".exe").to_string()
}

/// Browser name the extension reports → that browser's exe stem.
fn browser_exe(browser: &str) -> &str {
    match browser {
        "edge" => "msedge",
        b => b,
    }
}

fn browser_pretty(browser: &str) -> String {
    match browser {
        "edge" => "Edge".into(),
        b => {
            let mut c = b.chars();
            c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
        }
    }
}

/// BGRA pixels (as GDI returns them) → "data:image/png;base64,…".
/// Old-style icons have no alpha channel (all 0): treat those as opaque.
#[allow(dead_code)]
fn bgra_to_png_data_url(px: &mut [u8], size: u32) -> Option<String> {
    use base64::Engine;
    let has_alpha = px.chunks(4).any(|p| p[3] != 0);
    for p in px.chunks_mut(4) {
        p.swap(0, 2);
        if !has_alpha {
            p[3] = 255;
        }
    }
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, size, size);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        let mut w = enc.write_header().ok()?;
        w.write_image_data(px).ok()?;
    }
    Some(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(&out)))
}

/// Add the browser extension's sessions and hide the (less accurate) Windows-reported
/// sessions of any browser the extension covers.
#[allow(dead_code)]
fn merge_extension(mut sessions: Vec<MediaSession>) -> Vec<MediaSession> {
    let ext = crate::ext::snapshot();
    if ext.is_empty() {
        return sessions;
    }
    let covered: std::collections::HashSet<String> = ext.iter().map(|(b, _)| browser_exe(b).to_string()).collect();
    sessions.retain(|s| s.source != "windows" || !covered.contains(&exe_for_id(&s.id)));
    for (b, e) in ext {
        sessions.push(MediaSession {
            id: format!("ext:{b}:{}", e.key),
            app: if e.site_name.is_empty() { browser_pretty(&b) } else { e.site_name.clone() },
            title: e.title,
            artist: e.artist,
            album: e.album,
            artwork: e.artwork,
            // Site icon from the extension; if the site has none, the browser's own logo.
            icon: e.icon.or_else(|| imp::exe_icon(browser_exe(&b))),
            playing: e.playing,
            position: e.position,
            duration: e.duration,
            sampled_at: e.sampled_at,
            can_next: e.can_next,
            can_prev: e.can_prev,
            can_seek: e.can_seek,
            audible: e.audible,
            rate: if e.rate > 0.0 { e.rate } else { 1.0 },
            source: "extension".into(),
            live: e.live,
        });
    }
    sessions
}

/// Route a command for an extension session ("ext:<browser>:<key>").
fn ext_command(id: &str, action: &str) -> Option<Result<(), String>> {
    let rest = id.strip_prefix("ext:")?;
    let (browser, key) = rest.split_once(':')?;
    Some(crate::ext::command(browser, key, action))
}

#[cfg(windows)]
mod imp {
    use super::*;
    use base64::Engine;
    use std::collections::{HashMap, HashSet};
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
    use super::bgra_to_png_data_url;
    use tauri::{AppHandle, Emitter};
    use windows::core::Result as WinResult;
    use windows::Foundation::TypedEventHandler;
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSession as Session,
        GlobalSystemMediaTransportControlsSessionManager as Manager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status, CurrentSessionChangedEventArgs,
        MediaPropertiesChangedEventArgs, PlaybackInfoChangedEventArgs, SessionsChangedEventArgs,
        TimelinePropertiesChangedEventArgs,
    };
    use windows::core::{Interface, HSTRING};
    use windows::ApplicationModel::AppInfo;
    use windows::Foundation::Size;
    use windows::Storage::FileProperties::{ThumbnailMode, ThumbnailOptions};
    use windows::Storage::StorageFile;
    use windows::Storage::Streams::{DataReader, IRandomAccessStreamReference, IRandomAccessStreamWithContentType};

    /// 100ns ticks between 1601-01-01 and 1970-01-01.
    const EPOCH_DIFF: i64 = 116_444_736_000_000_000;
    /// Set by Windows' change events → the loop refreshes within ~30 ms.
    static DIRTY: AtomicBool = AtomicBool::new(true);
    /// Even with events, re-read once a second as a safety net (some apps never fire them).
    const SAFETY_POLL: Duration = Duration::from_millis(1000);

    fn secs(ticks: i64) -> f64 {
        ticks as f64 / 10_000_000.0
    }
    fn now_ms() -> f64 {
        SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
    }
    pub fn mark_dirty() {
        DIRTY.store(true, Ordering::Relaxed);
    }

    /// Our own steady clock per session. Apps report position irregularly (some only
    /// on seek, some reset the timeline on play/pause), so we keep the last good
    /// values and extrapolate ourselves instead of trusting every report.
    struct Clock {
        track: String,
        duration: f64,
        position: f64, // at sampled_at
        sampled_at: f64,
        playing: bool,
        tl_stamp: i64, // LastUpdatedTime of the report we last accepted
        tl_pos: f64,
        /// What the app itself last said (playing?), and when that changed.
        rep_playing: bool,
        rep_changed_at: f64,
        /// We've heard the app's audio since it last said "playing".
        heard_in_play: bool,
        /// When the current song started (as we saw it), and the previous song's last
        /// timeline: apps like Spotify keep reporting the *old* song's position/length for a
        /// moment after a skip, which must not bleed into the new song.
        track_at: f64,
        prev_dur: f64,
        prev_pos: f64,
    }

    impl Clock {
        fn now_pos(&self, now: f64) -> f64 {
            let p = if self.playing { self.position + (now - self.sampled_at) / 1000.0 } else { self.position };
            if self.duration > 0.0 { p.clamp(0.0, self.duration) } else { p.max(0.0) }
        }
    }

    #[derive(Default)]
    struct Watcher {
        art: HashMap<String, String>,
        misses: HashMap<String, u8>,
        clocks: HashMap<String, Clock>,
        /// Sessions we've attached change-handlers to (kept alive here).
        hooked: HashMap<String, Session>,
        /// id → (display name, icon, last attempt) — looked up once per app (retried while missing).
        idents: HashMap<String, (String, Option<String>, Instant)>,
    }

    pub fn spawn(app: AppHandle) {
        std::thread::spawn(move || {
            let mut w = Watcher::default();
            let mut last: Option<MediaState> = None;
            let mut mgr: Option<Manager> = None;
            let mut last_read = Instant::now() - SAFETY_POLL;
            loop {
                std::thread::sleep(Duration::from_millis(30));
                if mgr.is_none() {
                    mgr = Manager::RequestAsync().and_then(|op| op.get()).ok();
                    if let Some(m) = &mgr {
                        let _ = m.SessionsChanged(&TypedEventHandler::<Manager, SessionsChangedEventArgs>::new(|_, _| {
                            mark_dirty();
                            Ok(())
                        }));
                        let _ = m.CurrentSessionChanged(&TypedEventHandler::<Manager, CurrentSessionChangedEventArgs>::new(|_, _| {
                            mark_dirty();
                            Ok(())
                        }));
                        w.hooked.clear();
                        mark_dirty();
                    } else {
                        std::thread::sleep(Duration::from_secs(1));
                        continue;
                    }
                }
                let dirty = DIRTY.swap(false, Ordering::Relaxed);
                if !dirty && last_read.elapsed() < SAFETY_POLL {
                    continue;
                }
                last_read = Instant::now();
                let Some(m) = &mgr else { continue };
                match snapshot(m, &mut w) {
                    Ok(state) => {
                        let force = FORCE_EMIT.swap(false, Ordering::Relaxed);
                        if force || last.as_ref() != Some(&state) {
                            // Debug log (set ISLAND_DEBUG=1): one line per session per update.
                            let debug = std::env::var_os("ISLAND_DEBUG").is_some();
                            for x in state.sessions.iter().filter(|_| debug) {
                                eprintln!(
                                    "media: [{}] {} | playing={} pos={:.1} dur={:.1} at={} audible={}",
                                    x.source, x.title.chars().take(30).collect::<String>(), x.playing, x.position, x.duration,
                                    (x.sampled_at as u64) % 100_000, x.audible
                                );
                            }
                            let _ = app.emit("media://update", &state);
                            last = Some(state);
                        }
                    }
                    Err(_) => mgr = None, // re-acquire next tick
                }
            }
        });
    }

    fn hook(s: &Session) {
        let _ = s.MediaPropertiesChanged(&TypedEventHandler::<Session, MediaPropertiesChangedEventArgs>::new(|_, _| {
            mark_dirty();
            Ok(())
        }));
        let _ = s.PlaybackInfoChanged(&TypedEventHandler::<Session, PlaybackInfoChangedEventArgs>::new(|_, _| {
            mark_dirty();
            Ok(())
        }));
        let _ = s.TimelinePropertiesChanged(&TypedEventHandler::<Session, TimelinePropertiesChangedEventArgs>::new(|_, _| {
            mark_dirty();
            Ok(())
        }));
    }

    fn snapshot(m: &Manager, w: &mut Watcher) -> WinResult<MediaState> {
        let current_id = m
            .GetCurrentSession()
            .ok()
            .and_then(|s| s.SourceAppUserModelId().ok())
            .map(|h| h.to_string());
        let list = m.GetSessions()?;
        let mut sessions = Vec::new();
        let mut seen = HashSet::new();
        for i in 0..list.Size()? {
            let Ok(s) = list.GetAt(i) else { continue };
            let Ok(id) = s.SourceAppUserModelId().map(|h| h.to_string()) else { continue };
            seen.insert(id.clone());
            if !w.hooked.contains_key(&id) {
                hook(&s);
                w.hooked.insert(id.clone(), s.clone());
            }
            if let Ok(ms) = read_session(&s, id, w) {
                if !ms.title.is_empty() || ms.playing {
                    sessions.push(ms);
                }
            }
        }
        w.hooked.retain(|id, _| seen.contains(id));
        w.clocks.retain(|id, _| seen.contains(id));
        if w.art.len() > 64 {
            w.art.clear();
            w.misses.clear();
        }
        let sessions = merge_extension(sessions);
        Ok(MediaState { sessions, current_id })
    }

    fn read_session(s: &Session, id: String, w: &mut Watcher) -> WinResult<MediaSession> {
        let props = s.TryGetMediaPropertiesAsync()?.get()?;
        let title = props.Title().map(|h| h.to_string()).unwrap_or_default();
        let artist = props.Artist().map(|h| h.to_string()).unwrap_or_default();
        let album = props.AlbumTitle().map(|h| h.to_string()).unwrap_or_default();

        let info = s.GetPlaybackInfo()?;
        let rep_playing = info.PlaybackStatus()? == Status::Playing;
        let (can_next, can_prev, can_seek) = info
            .Controls()
            .map(|c| {
                (
                    c.IsNextEnabled().unwrap_or(false),
                    c.IsPreviousEnabled().unwrap_or(false),
                    c.IsPlaybackPositionEnabled().unwrap_or(false),
                )
            })
            .unwrap_or((false, false, false));

        // ---- timeline, through our steady clock ----
        let track = format!("{title}|{artist}|{album}");
        let now = now_ms();
        let (rep_pos, rep_dur, rep_stamp) = match s.GetTimelineProperties() {
            Ok(tl) => {
                let start = tl.StartTime().map(|t| secs(t.Duration)).unwrap_or(0.0);
                let end = tl.EndTime().map(|t| secs(t.Duration)).unwrap_or(0.0);
                let pos = tl.Position().map(|t| secs(t.Duration)).unwrap_or(0.0) - start;
                let stamp = tl.LastUpdatedTime().map(|t| t.UniversalTime).unwrap_or(0);
                (pos.max(0.0), (end - start).max(0.0), stamp)
            }
            Err(_) => (0.0, 0.0, 0),
        };

        let clock = w.clocks.entry(id.clone()).or_insert_with(|| Clock {
            track: String::new(),
            duration: 0.0,
            position: 0.0,
            sampled_at: now,
            playing: rep_playing,
            tl_stamp: 0,
            tl_pos: -1.0,
            rep_playing,
            rep_changed_at: now,
            heard_in_play: false,
            track_at: now,
            prev_dur: -1.0,
            prev_pos: -1.0,
        });

        if clock.track != track {
            // New song: start fresh, but only trust a duration reported for this song.
            let first = clock.track.is_empty();
            clock.prev_dur = if first { -1.0 } else { clock.duration };
            clock.prev_pos = if first { -1.0 } else { clock.tl_pos };
            clock.track = track.clone();
            clock.track_at = now;
            clock.position = 0.0;
            clock.sampled_at = now;
            clock.tl_stamp = 0;
            clock.tl_pos = -1.0;
        }
        // Right after a skip (first 5 s), a timeline that still looks like the previous
        // song's — same length, or a position far beyond how long the new song has been
        // playing — is a leftover. Ignore it; the new song's real timeline follows shortly.
        let since_change = (now - clock.track_at) / 1000.0;
        let leftover = !clock.track.is_empty()
            && since_change < 5.0
            && clock.prev_dur > 0.0
            && ((rep_dur - clock.prev_dur).abs() < 0.5 || rep_pos > since_change + 2.5 || (rep_pos - clock.prev_pos).abs() < 0.05);
        // Keep the last known duration if the app briefly reports 0 (this is what
        // made the scrubber vanish on play/pause).
        if rep_dur > 0.0 && (!leftover || (rep_dur - clock.prev_dur).abs() >= 0.5) {
            clock.duration = rep_dur;
        }

        // ---- play/pause from the app's real audio ----
        // Apps like Spotify tell Windows about play/pause late (sometimes seconds late).
        // The per-app audio meter knows instantly, so it wins when the two disagree:
        //  · the app says paused, but fresh sound started after it said so → playing
        //  · the app says playing, but has gone silent after we'd heard it → paused
        //    (clock frozen at the moment the sound stopped)
        if rep_playing != clock.rep_playing {
            clock.rep_playing = rep_playing;
            clock.rep_changed_at = now;
            clock.heard_in_play = false;
        }
        let silent = crate::audio::meters::silent_ms(&exe_for_id(&id));
        let heard_at = silent.map(|s| now - s);
        if rep_playing && silent.map_or(false, |s| s < 300.0) {
            clock.heard_in_play = true;
        }
        let playing = match heard_at {
            Some(h) if !rep_playing && h > clock.rep_changed_at + 500.0 && now - h < 400.0 => true,
            Some(h) if rep_playing && clock.heard_in_play && now - h > 2500.0 => false,
            _ => rep_playing,
        };

        let fresh_report = rep_stamp != clock.tl_stamp || (rep_pos - clock.tl_pos).abs() > 0.01;
        if fresh_report && leftover {
            // Remember it so it isn't treated as fresh again, but don't move the clock.
            clock.tl_stamp = rep_stamp;
            clock.tl_pos = rep_pos;
        } else if fresh_report && (rep_stamp > 0 || rep_pos > 0.0) {
            clock.tl_stamp = rep_stamp;
            clock.tl_pos = rep_pos;
            // Where is it *now*? The report was taken at LastUpdatedTime.
            let report_ms = if rep_stamp > EPOCH_DIFF { ((rep_stamp - EPOCH_DIFF) / 10_000) as f64 } else { now };
            let age = ((now - report_ms) / 1000.0).clamp(0.0, 6.0 * 3600.0);
            let mut p = if playing { rep_pos + age } else { rep_pos };
            if clock.duration > 0.0 {
                p = p.min(clock.duration);
            }
            // Ignore stale reports that would jump us backwards a lot while playing
            // (some apps re-send an old timeline when you press play).
            let ours = clock.now_pos(now);
            let stale = playing && clock.playing && p + 3.0 < ours && age > 5.0;
            // Smooth clock: while it keeps playing, small disagreements are just the app's
            // sloppy reporting (Spotify is ±1 s) — keep our steady clock. Snap only on real
            // jumps: seeks, or the first report after a play/pause.
            let jitter = playing && clock.playing && (p - ours).abs() < 1.5;
            if !stale && !jitter {
                clock.position = p;
                clock.sampled_at = now;
            }
        } else if playing != clock.playing {
            // Play/pause without a timeline update: freeze/resume from our own clock.
            // A pause we detected from silence freezes at the moment the sound stopped.
            let at = match heard_at {
                Some(h) if !playing && rep_playing => h.clamp(clock.sampled_at, now),
                _ => now,
            };
            clock.position = clock.now_pos(at);
            clock.sampled_at = now;
        }
        clock.playing = playing;
        // Copy out of the clock before borrowing the watcher again.
        let (c_pos, c_dur, c_at) = (clock.position, clock.duration, clock.sampled_at);

        // ---- artwork (expensive: cache per track) ----
        let key = format!("{id}|{track}");
        let artwork = match w.art.get(&key) {
            Some(a) => Some(a.clone()),
            None if w.misses.get(&key).copied().unwrap_or(0) < 6 => {
                match props.Thumbnail().ok().and_then(|t| read_thumbnail(&t).ok()) {
                    Some(a) => {
                        w.art.insert(key, a.clone());
                        Some(a)
                    }
                    None => {
                        // Apps often publish the title a moment before the art: retry a few times.
                        *w.misses.entry(key).or_insert(0) += 1;
                        mark_dirty();
                        None
                    }
                }
            }
            None => None,
        };

        let id_for_meter = id.clone();
        let (app_name, icon) = identity(&id, w);
        Ok(MediaSession {
            app: app_name,
            icon,
            position: c_pos,
            duration: c_dur,
            sampled_at: c_at,
            id,
            title,
            artist,
            album,
            artwork,
            playing,
            can_next,
            can_prev,
            can_seek: can_seek && c_dur > 0.0,
            audible: crate::audio::meters::audible(&exe_for_id(&id_for_meter)),
            rate: 1.0,
            source: "windows".into(),
            live: false,
        })
    }

    /// The app's real name and logo. Store/Start-menu apps: from Windows' app registry.
    /// Plain .exe apps (e.g. Spotify): the exe's own icon, found via its audio session.
    fn identity(id: &str, w: &mut Watcher) -> (String, Option<String>) {
        if let Some((name, icon, at)) = w.idents.get(id) {
            if icon.is_some() || at.elapsed() < Duration::from_secs(10) {
                return (name.clone(), icon.clone());
            }
        }
        let mut name = None;
        let mut icon = None;
        if let Ok(info) = AppInfo::GetFromAppUserModelId(&HSTRING::from(id)) {
            if let Ok(di) = info.DisplayInfo() {
                name = di.DisplayName().ok().map(|h| h.to_string()).filter(|s| !s.trim().is_empty());
                icon = di
                    .GetLogo(Size { Width: 64.0, Height: 64.0 })
                    .ok()
                    .and_then(|r| r.cast::<IRandomAccessStreamReference>().ok())
                    .and_then(|r| read_thumbnail(&r).ok());
            }
        }
        if icon.is_none() {
            icon = exe_icon(&exe_for_id(id));
        }
        let name = name.unwrap_or_else(|| friendly_app_name(id));
        if icon.is_none() {
            eprintln!("island: no icon found for {id:?} (will retry)");
        }
        w.idents.insert(id.to_string(), (name.clone(), icon.clone(), Instant::now()));
        (name, icon)
    }

    /// Icon of a running app by exe stem ("spotify", "firefox"), cached once found.
    pub fn exe_icon(stem: &str) -> Option<String> {
        static CACHE: std::sync::Mutex<Option<HashMap<String, String>>> = std::sync::Mutex::new(None);
        if let Some(hit) = CACHE.lock().unwrap().as_ref().and_then(|m| m.get(stem).cloned()) {
            return Some(hit);
        }
        let path = crate::audio::meters::exe_path(stem).or_else(|| find_process_exe(stem))?;
        // Shell thumbnail first (nicest, high-res); raw icon extraction if the shell says no.
        let icon = file_icon(&path).ok().or_else(|| extract_exe_icon(&path, 64))?;
        CACHE.lock().unwrap().get_or_insert_with(HashMap::new).insert(stem.to_string(), icon.clone());
        Some(icon)
    }

    /// Full exe path of a running process by exe stem (e.g. "spotify" → C:\…\Spotify.exe).
    fn find_process_exe(stem: &str) -> Option<String> {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).ok()?;
            let mut e = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
            let mut found = None;
            if Process32FirstW(snap, &mut e).is_ok() {
                loop {
                    let len = e.szExeFile.iter().position(|&c| c == 0).unwrap_or(e.szExeFile.len());
                    let name = String::from_utf16_lossy(&e.szExeFile[..len]).to_lowercase();
                    if name.trim_end_matches(".exe") == stem {
                        let (_, path) = crate::audio::meters::exe_stem(e.th32ProcessID);
                        if !path.is_empty() {
                            found = Some(path);
                            break;
                        }
                    }
                    if Process32NextW(snap, &mut e).is_err() {
                        break;
                    }
                }
            }
            let _ = CloseHandle(snap);
            found
        }
    }

    /// Pull the icon resource straight out of an .exe and encode it as PNG.
    fn extract_exe_icon(path: &str, size: i32) -> Option<String> {
        use windows::Win32::Graphics::Gdi::{
            CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
        };
        use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, PrivateExtractIconsW, HICON, ICONINFO};
        unsafe {
            let mut name = [0u16; 260];
            for (i, c) in path.encode_utf16().take(259).enumerate() {
                name[i] = c;
            }
            let mut icons = [HICON::default(); 1];
            if PrivateExtractIconsW(&name, 0, size, size, Some(&mut icons), None, 0) == 0 || icons[0].is_invalid() {
                return None;
            }
            let icon = icons[0];
            let mut info = ICONINFO::default();
            if GetIconInfo(icon, &mut info).is_err() {
                let _ = DestroyIcon(icon);
                return None;
            }
            let dc = CreateCompatibleDC(None);
            let mut bmi = BITMAPINFO::default();
            bmi.bmiHeader = BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: size,
                biHeight: -size, // top-down rows
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            };
            let mut px = vec![0u8; (size * size * 4) as usize];
            let rows = GetDIBits(dc, info.hbmColor, 0, size as u32, Some(px.as_mut_ptr() as _), &mut bmi, DIB_RGB_COLORS);
            let _ = DeleteDC(dc);
            let _ = DeleteObject(info.hbmColor.into());
            let _ = DeleteObject(info.hbmMask.into());
            let _ = DestroyIcon(icon);
            if rows == 0 {
                return None;
            }
            Some(bgra_to_png_data_url(&mut px, size as u32)?)
        }
    }

    /// The shell's icon for a file (for an .exe: its app icon), via Windows' thumbnail service.
    fn file_icon(path: &str) -> WinResult<String> {
        let file = StorageFile::GetFileFromPathAsync(&HSTRING::from(path))?.get()?;
        let thumb = file.GetThumbnailAsync(ThumbnailMode::SingleItem, 64, ThumbnailOptions::ResizeThumbnail)?.get()?;
        read_stream(&thumb.cast::<IRandomAccessStreamWithContentType>()?)
    }

    /// Shell thumbnail for any path: real picture previews for images, the app icon for
    /// .exe files, the folder icon for folders, the type icon for everything else.
    pub fn shell_thumb(path: &str, size: u32, picture: bool) -> Option<String> {
        let mode = if picture { ThumbnailMode::PicturesView } else { ThumbnailMode::SingleItem };
        let p = HSTRING::from(path);
        let via_file = || -> WinResult<String> {
            let file = StorageFile::GetFileFromPathAsync(&p)?.get()?;
            let t = file.GetThumbnailAsync(mode, size, ThumbnailOptions::ResizeThumbnail)?.get()?;
            read_stream(&t.cast::<IRandomAccessStreamWithContentType>()?)
        };
        let via_folder = || -> WinResult<String> {
            let folder = windows::Storage::StorageFolder::GetFolderFromPathAsync(&p)?.get()?;
            let t = folder.GetThumbnailAsync(ThumbnailMode::SingleItem, size, ThumbnailOptions::ResizeThumbnail)?.get()?;
            read_stream(&t.cast::<IRandomAccessStreamWithContentType>()?)
        };
        via_file()
            .or_else(|_| via_folder())
            .ok()
            .or_else(|| path.to_lowercase().ends_with(".exe").then(|| extract_exe_icon(path, 64)).flatten())
    }

    pub fn read_thumbnail(r: &IRandomAccessStreamReference) -> WinResult<String> {
        read_stream(&r.OpenReadAsync()?.get()?)
    }

    fn read_stream(stream: &IRandomAccessStreamWithContentType) -> WinResult<String> {
        let size = stream.Size()? as u32;
        if size == 0 {
            return Err(windows::core::Error::empty());
        }
        let mime = stream.ContentType().map(|h| h.to_string()).unwrap_or_default();
        let reader = DataReader::CreateDataReader(stream)?;
        reader.LoadAsync(size)?.get()?;
        let mut buf = vec![0u8; size as usize];
        reader.ReadBytes(&mut buf)?;
        let mime = if mime.is_empty() { "image/png".to_string() } else { mime };
        Ok(format!(
            "data:{};base64,{}",
            mime,
            base64::engine::general_purpose::STANDARD.encode(&buf)
        ))
    }

    /// action: "toggle" | "next" | "prev" | "seek:<seconds>"
    /// Full exe path of a running app by stem (for re-launch / focus).
    pub fn process_exe(stem: &str) -> Option<String> {
        find_process_exe(stem)
    }

    pub fn command(id: &str, action: &str) -> Result<(), String> {
        if action == "open" {
            // Browser tab → the extension focuses the tab; also raise the browser window.
            if let Some(rest) = id.strip_prefix("ext:") {
                let browser = rest.split(':').next().unwrap_or("");
                let _ = ext_command(id, "focus");
                crate::win::focus_app(browser_exe(browser));
                return Ok(());
            }
            let stem = exe_for_id(id);
            if !crate::win::focus_app(&stem) {
                // Store apps: activate by their AppUserModelId.
                crate::system::activate_app(id)?;
            }
            return Ok(());
        }
        if let Some(r) = ext_command(id, action) {
            mark_dirty();
            return r;
        }
        let run = || -> WinResult<()> {
            let m = Manager::RequestAsync()?.get()?;
            let list = m.GetSessions()?;
            for i in 0..list.Size()? {
                let s = list.GetAt(i)?;
                if s.SourceAppUserModelId()?.to_string() != id {
                    continue;
                }
                match action {
                    "toggle" => {
                        s.TryTogglePlayPauseAsync()?.get()?;
                    }
                    "next" => {
                        s.TrySkipNextAsync()?.get()?;
                    }
                    "prev" => {
                        s.TrySkipPreviousAsync()?.get()?;
                    }
                    a if a.starts_with("seek:") => {
                        let secs: f64 = a[5..].parse().unwrap_or(0.0);
                        let start = s.GetTimelineProperties().and_then(|t| t.StartTime()).map(|t| t.Duration).unwrap_or(0);
                        s.TryChangePlaybackPositionAsync(start + (secs.max(0.0) * 10_000_000.0) as i64)?.get()?;
                    }
                    _ => {}
                }
                break;
            }
            Ok(())
        };
        let r = run().map_err(|e| e.to_string());
        mark_dirty();
        request_refresh();
        r
    }
}

#[cfg(not(windows))]
mod imp {
    use tauri::AppHandle;
    pub fn spawn(_app: AppHandle) {}
    pub fn mark_dirty() {}
    pub fn exe_icon(_stem: &str) -> Option<String> {
        None
    }
    pub fn command(id: &str, action: &str) -> Result<(), String> {
        super::ext_command(id, action).unwrap_or_else(|| Err("media control is only supported on Windows".into()))
    }
}

pub use imp::{command, mark_dirty, spawn};
#[cfg(windows)]
pub use imp::{exe_icon, process_exe, read_thumbnail, shell_thumb};
