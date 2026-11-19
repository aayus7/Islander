//! Movie and series posters for video players (mpv from Stremio, VLC, MPC…), which only
//! tell Windows a file name. The frontend turns that name into a title (+ year, or
//! "series" when it has S01E02), and this looks it up in Cinemeta — Stremio's own free
//! metadata service, no key needed — and downloads the poster from MetaHub, Stremio's
//! image service. Results are remembered for the session (misses too).

use std::collections::HashMap;
use std::sync::Mutex;

static CACHE: Mutex<Option<HashMap<String, Option<String>>>> = Mutex::new(None);

#[tauri::command]
pub async fn movie_poster(query: String, year: Option<u32>, series: bool) -> Option<String> {
    let key = format!("{}|{:?}|{series}", query.to_lowercase(), year);
    let hit = { CACHE.lock().unwrap().get_or_insert_with(HashMap::new).get(&key).cloned() };
    if let Some(hit) = hit {
        return hit;
    }
    let found = tauri::async_runtime::spawn_blocking(move || lookup(&query, year, series)).await.ok().flatten();
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

fn norm(s: &str) -> String {
    s.chars().filter(|c| c.is_alphanumeric()).collect::<String>().to_lowercase()
}

fn lookup(query: &str, year: Option<u32>, series: bool) -> Option<String> {
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
            return Some(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes)));
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
