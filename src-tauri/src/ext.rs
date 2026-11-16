//! Bridge for the "Island Media Bridge" browser extension.
//!
//! The extension reads the real <video>/<audio> elements in your tabs (exact time,
//! length, play state, thumbnail) and streams them here over a local WebSocket:
//!   ws://127.0.0.1:47823
//! Only browser-extension origins may connect, so web pages can't talk to the island.
//! Nothing leaves your PC.
use serde::Deserialize;
use std::collections::HashMap;
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc::{channel, Sender};
use std::sync::Mutex;
use std::time::Duration;
use tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tungstenite::{Error as WsError, Message};

pub const PORT: u16 = 47823;

#[derive(Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ExtSession {
    pub key: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub artwork: Option<String>,
    /// Site icon (favicon) as a data: URL.
    pub icon: Option<String>,
    pub site_name: String,
    pub playing: bool,
    pub position: f64,
    pub duration: f64,
    pub rate: f64,
    pub sampled_at: f64,
    pub can_seek: bool,
    pub can_next: bool,
    pub can_prev: bool,
    pub audible: bool,
    pub live: bool,
}

impl Default for ExtSession {
    fn default() -> Self {
        Self {
            key: String::new(),
            title: String::new(),
            artist: String::new(),
            album: String::new(),
            artwork: None,
            icon: None,
            site_name: String::new(),
            playing: false,
            position: 0.0,
            duration: 0.0,
            rate: 1.0,
            sampled_at: 0.0,
            can_seek: false,
            can_next: false,
            can_prev: false,
            audible: false,
            live: false,
        }
    }
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum Incoming {
    Hello { browser: String },
    State { sessions: Vec<ExtSession> },
    Downloads { items: Vec<Download> },
    Ping,
}

/// A browser download in progress (or just finished), for the island's progress activity.
#[derive(Deserialize, serde::Serialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Download {
    pub id: String,
    pub name: String,
    pub path: String,
    pub received: f64,
    pub total: f64,
    /// "in_progress" | "complete" | "interrupted"
    pub state: String,
    #[serde(skip_deserializing)]
    pub browser: String,
}

static DOWNLOADS: Mutex<Option<HashMap<String, Vec<Download>>>> = Mutex::new(None);
static APP: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();

/// Lets the bridge push download progress straight to the island.
pub fn set_app(app: tauri::AppHandle) {
    let _ = APP.set(app);
}

fn emit_downloads(browser: &str, items: Option<Vec<Download>>) {
    use tauri::Emitter;
    let all: Vec<Download> = {
        let mut g = DOWNLOADS.lock().unwrap();
        let m = g.get_or_insert_with(HashMap::new);
        match items {
            Some(v) => {
                m.insert(browser.to_string(), v);
            }
            None => {
                m.remove(browser);
            }
        }
        m.values().flatten().cloned().collect()
    };
    if let Some(app) = APP.get() {
        let _ = app.emit("downloads://update", all);
    }
}

struct Conn {
    id: u64,
    sessions: Vec<ExtSession>,
    tx: Sender<String>,
}

/// browser name ("firefox" | "chrome" | "edge" | …) → its live connection.
static CONNS: Mutex<Option<HashMap<String, Conn>>> = Mutex::new(None);

fn with_conns<R>(f: impl FnOnce(&mut HashMap<String, Conn>) -> R) -> R {
    let mut g = CONNS.lock().unwrap();
    f(g.get_or_insert_with(HashMap::new))
}

/// Media currently reported by each connected browser.
pub fn snapshot() -> Vec<(String, ExtSession)> {
    with_conns(|c| {
        c.iter()
            .flat_map(|(b, conn)| conn.sessions.iter().map(move |s| (b.clone(), s.clone())))
            .collect()
    })
}

/// Browsers that currently have the extension connected.
pub fn connected_browsers() -> Vec<String> {
    with_conns(|c| c.keys().cloned().collect())
}

/// Send a command ("toggle" | "next" | "prev" | "seek:<secs>") to one tab's player.
pub fn command(browser: &str, key: &str, action: &str) -> Result<(), String> {
    let (act, value) = match action.split_once(':') {
        Some((a, v)) => (a, v.parse::<f64>().ok()),
        None => (action, None),
    };
    let msg = serde_json::json!({ "type": "cmd", "key": key, "action": act, "value": value }).to_string();
    with_conns(|c| match c.get(browser) {
        Some(conn) => conn.tx.send(msg).map_err(|e| e.to_string()),
        None => Err(format!("{browser} extension not connected")),
    })
}

pub fn spawn(on_change: fn()) {
    std::thread::spawn(move || {
        let listener = match TcpListener::bind(("127.0.0.1", PORT)) {
            Ok(l) => l,
            Err(e) => {
                eprintln!("extension bridge: can't listen on {PORT}: {e}");
                return;
            }
        };
        let mut next_id = 1u64;
        for stream in listener.incoming().flatten() {
            let id = next_id;
            next_id += 1;
            std::thread::spawn(move || {
                if let Err(e) = handle(stream, id, on_change) {
                    eprintln!("extension bridge: connection ended: {e}");
                }
            });
        }
    });
}

fn allowed_origin(req: &Request) -> bool {
    req.headers()
        .get("origin")
        .and_then(|o| o.to_str().ok())
        .map(|o| o.starts_with("moz-extension://") || o.starts_with("chrome-extension://") || o.starts_with("extension://"))
        .unwrap_or(false)
}

/// Look at the first bytes without consuming them, to explain odd connections.
fn describe_non_websocket(stream: &TcpStream) -> Option<String> {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let mut buf = [0u8; 24];
    let n = stream.peek(&mut buf).unwrap_or(0);
    let _ = stream.set_read_timeout(None);
    if n == 0 {
        return Some("closed without sending anything".into());
    }
    if buf[0] == 0x16 {
        return Some("a TLS/HTTPS handshake (something tried wss:// or https://)".into());
    }
    if buf.starts_with(b"GET ") {
        return None; // looks like a normal WebSocket request
    }
    let text: String = buf[..n].iter().map(|&b| if b.is_ascii_graphic() || b == b' ' { b as char } else { '.' }).collect();
    Some(format!("non-HTTP data: {text:?}"))
}

fn handle(stream: TcpStream, id: u64, on_change: fn()) -> Result<(), String> {
    let _ = stream.set_nodelay(true);
    let peer = stream.peer_addr().map(|a| a.to_string()).unwrap_or_default();
    if let Some(what) = describe_non_websocket(&stream) {
        return Err(format!("ignored a connection from {peer}: {what}"));
    }
    let mut ws = tungstenite::accept_hdr(stream, |req: &Request, resp: Response| -> Result<Response, ErrorResponse> {
        if allowed_origin(req) {
            Ok(resp)
        } else {
            let mut r = ErrorResponse::new(Some("extensions only".into()));
            *r.status_mut() = tungstenite::http::StatusCode::FORBIDDEN;
            Err(r)
        }
    })
    .map_err(|e| format!("handshake from {peer} failed: {e}"))?;
    eprintln!("extension bridge: browser connected ({peer})");
    // Short read timeout so the same thread can also push commands to the browser.
    ws.get_mut()
        .set_read_timeout(Some(Duration::from_millis(50)))
        .map_err(|e| e.to_string())?;

    let (tx, rx) = channel::<String>();
    let mut browser: Option<String> = None;

    let result = loop {
        let mut send_err = None;
        while let Ok(out) = rx.try_recv() {
            if let Err(e) = ws.send(Message::text(out)) {
                send_err = Some(e.to_string());
                break;
            }
        }
        if let Some(e) = send_err {
            break Err(e);
        }
        match ws.read() {
            Ok(Message::Text(t)) => match serde_json::from_str::<Incoming>(t.as_str()) {
                Ok(Incoming::Hello { browser: b }) => {
                    let b = b.to_lowercase();
                    with_conns(|c| {
                        c.insert(b.clone(), Conn { id, sessions: vec![], tx: tx.clone() });
                    });
                    eprintln!("extension bridge: hello from {b}");
                    browser = Some(b);
                    on_change();
                }
                Ok(Incoming::State { sessions }) => {
                    if let Some(b) = &browser {
                        with_conns(|c| {
                            if let Some(conn) = c.get_mut(b) {
                                if conn.id == id {
                                    conn.sessions = sessions;
                                }
                            }
                        });
                        on_change();
                    }
                }
                Ok(Incoming::Downloads { items }) => {
                    if let Some(b) = &browser {
                        let items = items.into_iter().map(|mut d| {
                            d.browser = b.clone();
                            d
                        });
                        emit_downloads(b, Some(items.collect()));
                    }
                }
                Ok(Incoming::Ping) => {
                    let _ = ws.send(Message::text(r#"{"type":"pong"}"#));
                }
                Err(_) => {}
            },
            Ok(Message::Close(_)) => break Ok(()),
            Ok(_) => {}
            Err(WsError::Io(e)) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {}
            Err(e) => break Err(e.to_string()),
        }
    };

    // Forget this browser's media (only if a newer connection hasn't replaced it).
    if let Some(b) = browser {
        with_conns(|c| {
            if c.get(&b).map(|conn| conn.id) == Some(id) {
                c.remove(&b);
            }
        });
        emit_downloads(&b, None);
        on_change();
    }
    result
}
