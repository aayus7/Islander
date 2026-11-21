//! Movie and series posters for video players (mpv from Stremio, VLC, MPC…), which only
//! tell Windows a file name. The frontend turns that name into a title (+ year, or
//! "series" when it has S01E02), and this looks it up in Cinemeta — Stremio's own free
//! metadata service, no key needed — and downloads the poster from MetaHub, Stremio's
//! image service. Results are remembered for the session (misses too).
//!
//! Besides the poster it returns the real title, year and director (or, for an episode,
//! the episode's name), so the island can show "Interstellar / Christopher Nolan" instead
//! of a release file name and "mpv".

use std::collections::HashMap;
use std::sync::Mutex;

#[derive(serde::Serialize, Clone)]
pub struct MovieInfo {
    /// data: URL of the poster image.
    pub poster: String,
    pub title: String,
    pub year: Option<String>,
    /// Director(s) for a movie; for a series (which has none) its creator.
    pub director: Option<String>,
    /// Episode name, when this is an episode and Cinemeta knows it.
    pub episode: Option<String>,
}

static CACHE: Mutex<Option<HashMap<String, Option<MovieInfo>>>> = Mutex::new(None);

#[tauri::command]
pub async fn movie_poster(query: String, year: Option<u32>, series: bool, season: Option<u32>, episode: Option<u32>) -> Option<MovieInfo> {
    let key = format!("{}|{:?}|{series}|{:?}|{:?}", query.to_lowercase(), year, season, episode);
    let hit = { CACHE.lock().unwrap().get_or_insert_with(HashMap::new).get(&key).cloned() };
    if let Some(hit) = hit {
        return hit;
    }
    let found = tauri::async_runtime::spawn_blocking(move || lookup(&query, year, series, season, episode)).await.ok().flatten();
    // Remember (misses too, so a file with no match isn't looked up again and again).
    CACHE.lock().unwrap().get_or_insert_with(HashMap::new).insert(key, found.clone());
    found
}

#[derive(serde::Deserialize)]
struct Catalog {
    #[serde(default)]
    metas: Vec<Meta>,
}

#[derive(serde::Deserialize)]
struct Meta {
    #[serde(default)]
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default, rename = "releaseInfo")]
    release_info: String,
}

#[derive(serde::Deserialize)]
struct MetaResp {
    meta: Option<Full>,
}

#[derive(serde::Deserialize)]
struct Full {
    #[serde(default)]
    name: String,
    #[serde(default, rename = "releaseInfo")]
    release_info: Option<String>,
    #[serde(default)]
    director: Option<Vec<String>>,
    #[serde(default)]
    writer: Option<Vec<String>>,
    #[serde(default)]
    videos: Option<Vec<Video>>,
}

#[derive(serde::Deserialize)]
struct Video {
    #[serde(default)]
    season: Option<u32>,
    #[serde(default)]
    episode: Option<u32>,
    #[serde(default)]
    name: Option<String>,
}

/// "A, B" from up to two names, None if there are none.
fn names(v: Option<Vec<String>>) -> Option<String> {
    let v: Vec<String> = v?.into_iter().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).take(2).collect();
    (!v.is_empty()).then(|| v.join(", "))
}

fn norm(s: &str) -> String {
    s.chars().filter(|c| c.is_alphanumeric()).collect::<String>().to_lowercase()
}

fn lookup(query: &str, year: Option<u32>, series: bool, season: Option<u32>, episode: Option<u32>) -> Option<MovieInfo> {
    let q = query.trim();
    if q.len() < 2 {
        return None;
    }
    let kinds: &[&str] = if series { &["series", "movie"] } else { &["movie", "series"] };
    for kind in kinds {
        let url = format!("https://v3-cinemeta.strem.io/catalog/{kind}/top/search={}.json", encode(q));
        let Some(body) = http_get(&url) else { continue };
        let Ok(cat) = serde_json::from_slice::<Catalog>(&body) else { continue };
        let want = norm(q);
        let year_ok = |m: &Meta| year.map_or(false, |y| m.release_info.starts_with(&y.to_string()) || m.release_info.contains(&y.to_string()));
        // Best: same name and same year; then same year; then same name; then the top hit.
        let pick = cat
            .metas
            .iter()
            .find(|m| norm(&m.name) == want && year_ok(m))
            .or_else(|| cat.metas.iter().find(|m| year_ok(m)))
            .or_else(|| cat.metas.iter().find(|m| norm(&m.name) == want))
            .or_else(|| if year.is_none() { cat.metas.first() } else { None });
        let Some(m) = pick.filter(|m| m.id.starts_with("tt")) else { continue };
        let img = format!("https://images.metahub.space/poster/medium/{}/img", m.id);
        if let Some(bytes) = http_get(&img).filter(|b| b.len() > 512) {
            use base64::Engine;
            let mime = if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
                "image/png"
            } else if bytes.starts_with(b"RIFF") {
                "image/webp"
            } else {
                "image/jpeg"
            };
            let poster = format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes));
            // Full record: real title, year, director (series: creator), episode name.
            let full = http_get(&format!("https://v3-cinemeta.strem.io/meta/{kind}/{}.json", m.id))
                .and_then(|b| serde_json::from_slice::<MetaResp>(&b).ok())
                .and_then(|r| r.meta);
            let mut info = MovieInfo {
                poster,
                title: m.name.clone(),
                year: (!m.release_info.is_empty()).then(|| m.release_info.clone()),
                director: None,
                episode: None,
            };
            if let Some(f) = full {
                if !f.name.trim().is_empty() {
                    info.title = f.name.trim().to_string();
                }
                if let Some(y) = f.release_info.filter(|y| !y.trim().is_empty()) {
                    info.year = Some(y);
                }
                info.director = names(f.director).or_else(|| if *kind == "series" { names(f.writer) } else { None });
                if let (Some(s), Some(e)) = (season, episode) {
                    info.episode = f
                        .videos
                        .unwrap_or_default()
                        .into_iter()
                        .find(|v| v.season == Some(s) && v.episode == Some(e))
                        .and_then(|v| v.name)
                        .filter(|n| !n.trim().is_empty());
                }
            }
            return Some(info);
        }
    }
    None
}

fn encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

#[cfg(windows)]
fn http_get(url: &str) -> Option<Vec<u8>> {
    use windows::core::HSTRING;
    use windows::Foundation::Uri;
    use windows::Storage::Streams::DataReader;
    use windows::Web::Http::HttpClient;
    let run = || -> windows::core::Result<Vec<u8>> {
        let client = HttpClient::new()?;
        let _ = client.DefaultRequestHeaders()?.UserAgent()?.TryParseAdd(&HSTRING::from("Islander/0.6 (+https://github.com/aayus7)"));
        let uri = Uri::CreateUri(&HSTRING::from(url))?;
        let buf = client.GetBufferAsync(&uri)?.get()?;
        let mut out = vec![0u8; buf.Length()? as usize];
        DataReader::FromBuffer(&buf)?.ReadBytes(&mut out)?;
        Ok(out)
    };
    run().ok()
}

#[cfg(not(windows))]
fn http_get(_url: &str) -> Option<Vec<u8>> {
    None
}
