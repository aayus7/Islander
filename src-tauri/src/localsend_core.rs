//! LocalSend protocol v2 (https://github.com/localsend/protocol), implemented from the
//! public spec so Islander's Shelf can trade files with phones running the LocalSend app.
//! This file is plain std + serde (no Tauri, no Windows), so it can be tested anywhere;
//! `localsend.rs` wires it into the app.
//!
//! - Discovery: JSON announcements on UDP multicast 224.0.0.167:53317. We announce when
//!   asked (Shelf opened), and answer other devices' announcements over UDP.
//! - Receiving: a small HTTP server (protocol "http") for register / info /
//!   prepare-upload / upload / cancel. Every incoming transfer is asked about first.
//! - Sending: prepare-upload then upload to the phone (its HTTPS is handled by the
//!   caller-provided client, see `Http`).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, SocketAddrV4, TcpListener, TcpStream, UdpSocket};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const MULTICAST: Ipv4Addr = Ipv4Addr::new(224, 0, 0, 167);
pub const DEFAULT_PORT: u16 = 53317;
const API: &str = "/api/localsend/v2";

/* ------------------------------------------------------------------ data */

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    pub alias: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub device_model: Option<String>,
    #[serde(default)]
    pub device_type: Option<String>,
    #[serde(default)]
    pub fingerprint: String,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub protocol: Option<String>,
    #[serde(default)]
    pub download: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub announce: Option<bool>,
    /// v1 name for `announce`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub announcement: Option<bool>,
}

/// A nearby LocalSend device.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Peer {
    pub fingerprint: String,
    pub alias: String,
    pub device_model: Option<String>,
    /// "mobile" | "desktop" | "web" | "headless" | "server"
    pub device_type: String,
    pub ip: String,
    pub port: u16,
    pub https: bool,
    #[serde(skip)]
    pub seen: Instant,
}

impl Peer {
    pub fn base_url(&self) -> String {
        format!("{}://{}:{}{API}", if self.https { "https" } else { "http" }, self.ip, self.port)
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileDto {
    pub id: String,
    pub file_name: String,
    pub size: u64,
    #[serde(default)]
    pub file_type: String,
    #[serde(default)]
    pub sha256: Option<String>,
    #[serde(default)]
    pub preview: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PrepareRequest {
    pub info: Info,
    pub files: HashMap<String, FileDto>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PrepareResponse {
    pub session_id: String,
    pub files: HashMap<String, String>,
}

/// Something a nearby device wants to send us, shown in the island for Accept / Decline.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Incoming {
    pub id: String,
    pub alias: String,
    pub device_model: Option<String>,
    pub device_type: String,
    pub files: Vec<IncomingFile>,
    pub total: u64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct IncomingFile {
    pub name: String,
    pub size: u64,
    pub file_type: String,
    /// Small image the sender attached (data URL), if any.
    pub preview: Option<String>,
}

/// Progress of one transfer (either direction), for the island.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Transfer {
    pub id: String,
    pub outgoing: bool,
    pub peer: String,
    /// File currently moving (or the first one).
    pub name: String,
    /// Where it is on this PC (received file, or the file being sent).
    pub path: String,
    pub files: usize,
    pub done_files: usize,
    pub sent: u64,
    pub total: u64,
    /// "waiting" (for the other side to accept) | "sending" | "done" | "declined" | "failed" | "cancelled"
    pub state: String,
    pub error: Option<String>,
    /// Received files, once done.
    pub paths: Vec<String>,
}

/// What the app layer provides: where to put things and how to tell the UI.
pub trait Hooks: Send + Sync + 'static {
    fn peers_changed(&self, peers: Vec<Peer>);
    /// Blocks until the user accepts (true) or declines (false). Called on a server thread.
    fn ask(&self, req: &Incoming) -> bool;
    fn transfer(&self, t: &Transfer);
    fn save_dir(&self) -> PathBuf;
    fn log(&self, msg: &str);
    /// Nearby devices were found by reaching out, but nothing ever reaches this PC: almost
    /// always Windows Firewall blocking Islander. `true` = suspected, `false` = all good.
    fn inbound_blocked(&self, _blocked: bool) {}
}

/// HTTP(S) client used for sending (the phone usually speaks HTTPS with a self-signed cert).
pub trait Http: Send + Sync + 'static {
    /// POST a JSON body; returns (status, body). `timeout` covers waiting for the reply.
    fn post_json(&self, url: &str, body: &str, timeout: Duration) -> Result<(u16, String), String>;
    /// POST a file as the raw body, calling `progress(bytes_sent)` along the way.
    fn post_file(&self, url: &str, path: &Path, size: u64, progress: &(dyn Fn(u64) + Sync), cancel: &AtomicBool) -> Result<u16, String>;
}

/* ------------------------------------------------------------------ helpers */

pub fn rand_hex(n: usize) -> String {
    // Good enough for session ids / tokens on a LAN: time + counter + address entropy, hashed.
    static C: AtomicU64 = AtomicU64::new(0);
    let mut out = String::new();
    let mut x = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(0)
        ^ C.fetch_add(0x9E37_79B9_7F4A_7C15, Ordering::Relaxed)
        ^ (&out as *const String as usize as u64);
    while out.len() < n {
        // splitmix64
        x = x.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = x;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^= z >> 31;
        out.push_str(&format!("{z:016x}"));
    }
    out.truncate(n);
    out
}

pub fn mime_of(name: &str) -> &'static str {
    let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "heic" => "image/heic",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "mkv" => "video/x-matroska",
        "webm" => "video/webm",
        "avi" => "video/x-msvideo",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "wav" => "audio/wav",
        "flac" => "audio/flac",
        "ogg" | "opus" => "audio/ogg",
        "pdf" => "application/pdf",
        "zip" => "application/zip",
        "apk" => "application/vnd.android.package-archive",
        "txt" | "md" | "log" => "text/plain",
        "json" => "application/json",
        "doc" | "docx" => "application/msword",
        "xls" | "xlsx" => "application/vnd.ms-excel",
        "ppt" | "pptx" => "application/vnd.ms-powerpoint",
        _ => "application/octet-stream",
    }
}

/// A name that's safe on Windows and doesn't escape the save folder.
pub fn safe_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("file");
    let mut s: String = base.chars().map(|c| if c.is_control() || "<>:\"|?*".contains(c) { '_' } else { c }).collect();
    s = s.trim().trim_end_matches('.').to_string();
    if s.is_empty() || s == "." || s == ".." {
        s = "file".into();
    }
    let stem = s.split('.').next().unwrap_or("").to_ascii_uppercase();
    if ["CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "LPT1", "LPT2", "LPT3"].contains(&stem.as_str()) {
        s = format!("_{s}");
    }
    s
}

/// "photo.jpg" → "photo (1).jpg" … until nothing exists at that path (or reserved).
pub fn unique_path(dir: &Path, name: &str, taken: &[PathBuf]) -> PathBuf {
    let p = dir.join(name);
    if !p.exists() && !taken.contains(&p) {
        return p;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    for n in 1.. {
        let p = dir.join(format!("{stem} ({n}){ext}"));
        if !p.exists() && !taken.contains(&p) {
            return p;
        }
    }
    unreachable!()
}

/* ------------------------------------------------------------------ the service */

struct RecvFile {
    token: String,
    name: String,
    size: u64,
    dest: PathBuf,
    done: bool,
}

struct Session {
    id: String,
    ip: IpAddr,
    peer: String,
    files: HashMap<String, RecvFile>,
    received: u64,
    total: u64,
    cancelled: Arc<AtomicBool>,
    last: Instant,
}

pub struct LocalSend {
    pub info: Mutex<Info>,
    hooks: Arc<dyn Hooks>,
    http: Arc<dyn Http>,
    peers: Mutex<HashMap<String, Peer>>,
    session: Mutex<Option<Session>>,
    /// Outgoing transfers that can be cancelled: transfer id → (flag, peer url, session id).
    sending: Mutex<HashMap<String, (Arc<AtomicBool>, String, Option<String>)>>,
    udp: Mutex<Option<UdpSocket>>,
    pub enabled: AtomicBool,
    /// Something from another device reached us (UDP announcement or HTTP request).
    inbound_seen: AtomicBool,
    /// When we first found a device by reaching out (for the firewall check).
    first_outbound_find: Mutex<Option<Instant>>,
    last_scan: Mutex<Option<Instant>>,
}

impl LocalSend {
    pub fn new(alias: String, fingerprint: String, hooks: Arc<dyn Hooks>, http: Arc<dyn Http>) -> Arc<Self> {
        Arc::new(Self {
            info: Mutex::new(Info {
                alias,
                version: "2.2".into(),
                device_model: Some("Windows".into()),
                device_type: Some("desktop".into()),
                fingerprint,
                port: Some(DEFAULT_PORT),
                protocol: Some("http".into()),
                download: Some(false),
                announce: None,
                announcement: None,
            }),
            hooks,
            http,
            peers: Mutex::new(HashMap::new()),
            session: Mutex::new(None),
            sending: Mutex::new(HashMap::new()),
            udp: Mutex::new(None),
            enabled: AtomicBool::new(true),
            inbound_seen: AtomicBool::new(false),
            first_outbound_find: Mutex::new(None),
            last_scan: Mutex::new(None),
        })
    }

    fn note_inbound(&self, ip: IpAddr) {
        if !ip.is_loopback() && !self.inbound_seen.swap(true, Ordering::Relaxed) {
            self.hooks.log(&format!("inbound traffic from {ip} reaches us (firewall OK)"));
            self.hooks.inbound_blocked(false);
        }
    }

    /// Called a while after a device was found by reaching out: if nothing has come back
    /// to us by then, the PC is very likely blocking incoming connections.
    pub fn check_inbound(&self) {
        let found = *self.first_outbound_find.lock().unwrap();
        if let Some(at) = found {
            if at.elapsed() > Duration::from_secs(12) && !self.inbound_seen.load(Ordering::Relaxed) {
                self.hooks.inbound_blocked(true);
            }
        }
    }

    /// After the firewall changed: give phones another chance to reach us before warning again.
    pub fn recheck_inbound(&self) {
        self.inbound_seen.store(false, Ordering::Relaxed);
        if self.first_outbound_find.lock().unwrap().is_some() {
            *self.first_outbound_find.lock().unwrap() = Some(Instant::now());
        }
    }

    fn me(&self) -> Info {
        self.info.lock().unwrap().clone()
    }

    pub fn set_alias(&self, alias: &str) {
        if !alias.trim().is_empty() {
            self.info.lock().unwrap().alias = alias.trim().chars().take(40).collect();
        }
    }

    pub fn peers(&self) -> Vec<Peer> {
        let mut v: Vec<Peer> = self.peers.lock().unwrap().values().filter(|p| p.seen.elapsed() < Duration::from_secs(20 * 60)).cloned().collect();
        v.sort_by(|a, b| (a.device_type != "mobile").cmp(&(b.device_type != "mobile")).then(a.alias.to_lowercase().cmp(&b.alias.to_lowercase())));
        v
    }

    fn upsert_peer(&self, info: &Info, ip: IpAddr) {
        // Ourselves, or something on this PC talking over loopback: not a "nearby device".
        if info.fingerprint.is_empty() || info.fingerprint == self.me().fingerprint || info.alias.is_empty() || ip.is_loopback() {
            return;
        }
        let peer = Peer {
            fingerprint: info.fingerprint.clone(),
            alias: info.alias.clone(),
            device_model: info.device_model.clone(),
            device_type: info.device_type.clone().unwrap_or_else(|| "desktop".into()),
            ip: ip.to_string(),
            port: info.port.unwrap_or(DEFAULT_PORT),
            https: info.protocol.as_deref() != Some("http"),
            seen: Instant::now(),
        };
        let changed = {
            let mut g = self.peers.lock().unwrap();
            // Same device, new fingerprint (app restarted with HTTPS on): drop the old entry.
            g.retain(|k, p| k == &peer.fingerprint || !(p.ip == peer.ip && p.alias == peer.alias));
            let changed = g.get(&peer.fingerprint).map(|p| p.ip != peer.ip || p.port != peer.port || p.alias != peer.alias || p.https != peer.https).unwrap_or(true);
            g.insert(peer.fingerprint.clone(), peer);
            changed
        };
        if changed {
            self.hooks.log(&format!("found {} ({}) at {}:{}", info.alias, info.device_type.as_deref().unwrap_or("?"), ip, info.port.unwrap_or(DEFAULT_PORT)));
            self.hooks.peers_changed(self.peers());
        }
    }

    /* ---------------- discovery ---------------- */

    /// The IPv4 address of the interface used to reach the network (Wi-Fi/Ethernet).
    pub fn lan_ip() -> Option<Ipv4Addr> {
        let s = UdpSocket::bind("0.0.0.0:0").ok()?;
        s.connect("8.8.8.8:80").ok()?;
        match s.local_addr().ok()?.ip() {
            IpAddr::V4(ip) if !ip.is_loopback() && !ip.is_unspecified() => Some(ip),
            _ => None,
        }
    }

    pub fn start_discovery(self: &Arc<Self>) -> Result<(), String> {
        use socket2::{Domain, Protocol, Socket, Type};
        let sock = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP)).map_err(|e| e.to_string())?;
        // Share the port with the LocalSend app if it runs on this PC too.
        let _ = sock.set_reuse_address(true);
        sock.bind(&SocketAddr::from((Ipv4Addr::UNSPECIFIED, DEFAULT_PORT)).into()).map_err(|e| format!("udp bind: {e}"))?;
        let lan = Self::lan_ip();
        let mut joined = false;
        if let Some(ip) = lan {
            joined |= sock.join_multicast_v4(&MULTICAST, &ip).is_ok();
            let _ = sock.set_multicast_if_v4(&ip);
        }
        joined |= sock.join_multicast_v4(&MULTICAST, &Ipv4Addr::UNSPECIFIED).is_ok();
        if !joined {
            return Err("couldn't join the LocalSend multicast group".into());
        }
        let _ = sock.set_multicast_loop_v4(true);
        let _ = sock.set_multicast_ttl_v4(4);
        let udp: UdpSocket = sock.into();
        let reader = udp.try_clone().map_err(|e| e.to_string())?;
        *self.udp.lock().unwrap() = Some(udp);
        self.hooks.log(&format!("discovery on {MULTICAST}:{DEFAULT_PORT} via {:?}", lan));
        let me = self.clone();
        std::thread::Builder::new()
            .name("localsend-udp".into())
            .spawn(move || {
                let mut buf = vec![0u8; 64 * 1024];
                loop {
                    let Ok((n, from)) = reader.recv_from(&mut buf) else {
                        std::thread::sleep(Duration::from_millis(200));
                        continue;
                    };
                    if !me.enabled.load(Ordering::Relaxed) {
                        continue;
                    }
                    let Ok(info) = serde_json::from_slice::<Info>(&buf[..n]) else { continue };
                    if info.fingerprint == me.me().fingerprint {
                        continue;
                    }
                    me.note_inbound(from.ip());
                    me.upsert_peer(&info, from.ip());
                    // v2.2: every multicast message is an announcement (answered over HTTP);
                    // v2.1 marked answers with announce=false.
                    if info.announce.or(info.announcement).unwrap_or(true) {
                        // Answer so it lists us too: over HTTP (preferred by the spec) when it
                        // speaks plain HTTP, and over UDP as the spec's fallback in any case.
                        let me2 = me.clone();
                        let to = SocketAddr::new(from.ip(), info.port.unwrap_or(DEFAULT_PORT));
                        let https = info.protocol.as_deref() != Some("http");
                        std::thread::spawn(move || me2.answer(to, https));
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    fn answer(&self, to: SocketAddr, https: bool) {
        match self.register_with(to, https) {
            Ok(true) => {}
            r => {
                if let Err(e) = r {
                    self.hooks.log(&format!("register with {to} failed: {e}"));
                }
                // LocalSend 2.1 also accepted an answer over UDP.
                let mut info = self.me();
                info.announce = Some(false);
                info.announcement = Some(false);
                self.send_udp(&info);
            }
        }
    }

    /// POST /register to a device: it learns about us, and we about it.
    fn register_with(&self, to: SocketAddr, https: bool) -> Result<bool, String> {
        let mut me = self.me();
        me.announce = None;
        me.announcement = None;
        let body = serde_json::to_string(&me).unwrap_or_default();
        let url = format!("{}://{}{API}/register", if https { "https" } else { "http" }, to);
        let (code, b) = self.http.post_json(&url, &body, Duration::from_secs(3))?;
        if code != 200 {
            return Err(format!("HTTP {code}"));
        }
        let theirs: Info = serde_json::from_str(&b).map_err(|e| e.to_string())?;
        if theirs.fingerprint.is_empty() || theirs.fingerprint == me.fingerprint {
            return Ok(true);
        }
        self.upsert_peer(&Info { port: Some(to.port()), protocol: Some(if https { "https" } else { "http" }.into()), ..theirs }, to.ip());
        self.mark_outbound_find();
        Ok(true)
    }

    /// For networks where announcements don't get through (or Windows Firewall blocks them
    /// coming in): ask every address on this /24 directly. Only outgoing connections, so it
    /// works even when nothing can reach this PC. Runs at most every 30 s.
    pub fn scan_subnet(self: &Arc<Self>) {
        {
            let mut g = self.last_scan.lock().unwrap();
            if g.map(|t| t.elapsed() < Duration::from_secs(30)).unwrap_or(false) {
                return;
            }
            *g = Some(Instant::now());
        }
        let Some(lan) = Self::lan_ip() else { return };
        let o = lan.octets();
        let me = self.clone();
        std::thread::spawn(move || {
            let t0 = Instant::now();
            let before = me.peers.lock().unwrap().len();
            let hosts: Vec<Ipv4Addr> = (1..=254u8).map(|h| Ipv4Addr::new(o[0], o[1], o[2], h)).filter(|ip| *ip != lan || std::env::var_os("LS_SCAN_SELF").is_some()).collect();
            let next = Arc::new(Mutex::new(hosts.into_iter()));
            let workers: Vec<_> = (0..48)
                .map(|_| {
                    let next = next.clone();
                    let me = me.clone();
                    std::thread::spawn(move || loop {
                        let Some(ip) = next.lock().unwrap().next() else { break };
                        let addr = SocketAddr::from((ip, DEFAULT_PORT));
                        // Quick port check first, so silent hosts cost ~0.4 s.
                        if TcpStream::connect_timeout(&addr, Duration::from_millis(400)).is_err() {
                            continue;
                        }
                        if !matches!(me.register_with(addr, true), Ok(true)) {
                            let _ = me.register_with(addr, false);
                        }
                    })
                })
                .collect();
            for w in workers {
                let _ = w.join();
            }
            let found = me.peers.lock().unwrap().len();
            me.hooks.log(&format!("subnet scan of {}.{}.{}.0/24: {} device(s) in {} ms", o[0], o[1], o[2], found, t0.elapsed().as_millis()));
            if found > before || found > 0 {
                me.mark_outbound_find();
            }
        });
    }

    fn mark_outbound_find(&self) {
        let mut g = self.first_outbound_find.lock().unwrap();
        if g.is_none() {
            *g = Some(Instant::now());
        }
    }

    fn send_udp(&self, info: &Info) {
        if let Some(s) = self.udp.lock().unwrap().as_ref() {
            let msg = serde_json::to_vec(info).unwrap_or_default();
            let _ = s.send_to(&msg, SocketAddrV4::new(MULTICAST, DEFAULT_PORT));
        }
    }

    /// Tell everyone we're here (they answer, so we learn about them too).
    pub fn announce(&self) {
        if !self.enabled.load(Ordering::Relaxed) {
            return;
        }
        let mut info = self.me();
        info.announce = Some(true);
        info.announcement = None;
        self.send_udp(&info);
    }

    /* ---------------- receiving: HTTP server ---------------- */

    /// Listens on 53317 (or the next free port when the LocalSend app already has it).
    pub fn start_server(self: &Arc<Self>) -> Result<u16, String> {
        let mut last = String::new();
        for port in DEFAULT_PORT..DEFAULT_PORT + 10 {
            match TcpListener::bind((Ipv4Addr::UNSPECIFIED, port)) {
                Ok(l) => {
                    self.info.lock().unwrap().port = Some(port);
                    let me = self.clone();
                    std::thread::Builder::new()
                        .name("localsend-http".into())
                        .spawn(move || {
                            for conn in l.incoming().flatten() {
                                let me = me.clone();
                                std::thread::spawn(move || {
                                    let _ = conn.set_read_timeout(Some(Duration::from_secs(60)));
                                    if let Err(e) = me.handle(conn) {
                                        me.hooks.log(&format!("request failed: {e}"));
                                    }
                                });
                            }
                        })
                        .map_err(|e| e.to_string())?;
                    self.hooks.log(&format!("receiving on port {port}"));
                    return Ok(port);
                }
                Err(e) => last = e.to_string(),
            }
        }
        Err(format!("no free port: {last}"))
    }

    fn handle(&self, mut conn: TcpStream) -> Result<(), String> {
        let peer_ip = conn.peer_addr().map_err(|e| e.to_string())?.ip();
        let mut reader = BufReader::new(conn.try_clone().map_err(|e| e.to_string())?);
        let mut line = String::new();
        reader.read_line(&mut line).map_err(|e| e.to_string())?;
        let mut parts = line.split_whitespace();
        let method = parts.next().unwrap_or("").to_string();
        let target = parts.next().unwrap_or("").to_string();
        let mut len: Option<u64> = None;
        let mut chunked = false;
        loop {
            let mut h = String::new();
            if reader.read_line(&mut h).map_err(|e| e.to_string())? == 0 {
                break;
            }
            let h = h.trim_end();
            if h.is_empty() {
                break;
            }
            if let Some((k, v)) = h.split_once(':') {
                let k = k.trim().to_ascii_lowercase();
                let v = v.trim();
                if k == "content-length" {
                    len = v.parse().ok();
                } else if k == "transfer-encoding" && v.to_ascii_lowercase().contains("chunked") {
                    chunked = true;
                }
            }
        }
        let (path, query) = target.split_once('?').unwrap_or((target.as_str(), ""));
        let q: HashMap<String, String> = query.split('&').filter_map(|kv| kv.split_once('=')).map(|(k, v)| (k.to_string(), url_decode(v))).collect();
        let mut body = Body { r: reader, left: len, chunked, chunk_left: 0, done: false };

        if !self.enabled.load(Ordering::Relaxed) {
            return respond(&mut conn, 403, "");
        }
        self.note_inbound(peer_ip);
        let route = path.trim_end_matches('/');
        let route = route.strip_prefix("/api/localsend/v2").or_else(|| route.strip_prefix("/api/localsend/v1")).unwrap_or(route);
        match (method.as_str(), route) {
            ("POST", "/register") => {
                let raw = body.read_small(64 * 1024)?;
                if let Ok(info) = serde_json::from_slice::<Info>(&raw) {
                    self.upsert_peer(&info, peer_ip);
                }
                respond(&mut conn, 200, &serde_json::to_string(&self.me()).unwrap_or_default())
            }
            ("GET", "/info") => respond(&mut conn, 200, &serde_json::to_string(&self.me()).unwrap_or_default()),
            ("POST", "/prepare-upload") => {
                let raw = body.read_small(4 * 1024 * 1024)?;
                let (code, out) = self.prepare(&raw, peer_ip);
                respond(&mut conn, code, &out)
            }
            ("POST", "/upload") => {
                let code = self.receive(&q, peer_ip, &mut body);
                respond(&mut conn, code, "")
            }
            ("POST", "/cancel") => {
                let raw = body.read_small(64 * 1024);
                let _ = raw;
                self.cancel_incoming(q.get("sessionId").map(|s| s.as_str()), peer_ip);
                respond(&mut conn, 200, "")
            }
            _ => respond(&mut conn, 404, ""),
        }
    }

    fn prepare(&self, raw: &[u8], ip: IpAddr) -> (u16, String) {
        let Ok(req) = serde_json::from_slice::<PrepareRequest>(raw) else { return (400, String::new()) };
        if req.files.is_empty() {
            return (400, String::new());
        }
        {
            let mut g = self.session.lock().unwrap();
            if let Some(s) = g.as_ref() {
                // A stale session (sender vanished) shouldn't block forever.
                if s.last.elapsed() < Duration::from_secs(90) && !s.cancelled.load(Ordering::Relaxed) {
                    return (409, String::new());
                }
                *g = None;
            }
        }
        self.upsert_peer(&req.info, ip);
        let mut files: Vec<&FileDto> = req.files.values().collect();
        files.sort_by(|a, b| a.file_name.cmp(&b.file_name));
        let incoming = Incoming {
            id: rand_hex(12),
            alias: req.info.alias.clone(),
            device_model: req.info.device_model.clone(),
            device_type: req.info.device_type.clone().unwrap_or_else(|| "mobile".into()),
            files: files
                .iter()
                .map(|f| IncomingFile { name: safe_name(&f.file_name), size: f.size, file_type: f.file_type.clone(), preview: f.preview.clone().filter(|p| p.starts_with("data:image/") && p.len() < 400_000) })
                .collect(),
            total: files.iter().map(|f| f.size).sum(),
        };
        self.hooks.log(&format!("{} wants to send {} file(s), {} bytes", incoming.alias, incoming.files.len(), incoming.total));
        if !self.hooks.ask(&incoming) {
            self.hooks.transfer(&Transfer {
                id: incoming.id.clone(),
                outgoing: false,
                peer: incoming.alias.clone(),
                name: incoming.files[0].name.clone(),
                path: String::new(),
                files: incoming.files.len(),
                done_files: 0,
                sent: 0,
                total: incoming.total,
                state: "declined".into(),
                error: None,
                paths: vec![],
            });
            return (403, String::new());
        }
        let dir = self.hooks.save_dir();
        let _ = std::fs::create_dir_all(&dir);
        let mut taken = vec![];
        let mut map = HashMap::new();
        let mut tokens = HashMap::new();
        for f in files {
            let dest = unique_path(&dir, &safe_name(&f.file_name), &taken);
            taken.push(dest.clone());
            let token = rand_hex(24);
            tokens.insert(f.id.clone(), token.clone());
            map.insert(f.id.clone(), RecvFile { token, name: safe_name(&f.file_name), size: f.size, dest, done: false });
        }
        let s = Session {
            id: incoming.id.clone(),
            ip,
            peer: incoming.alias.clone(),
            total: incoming.total,
            received: 0,
            files: map,
            cancelled: Arc::new(AtomicBool::new(false)),
            last: Instant::now(),
        };
        self.emit_session(&s, "sending", None);
        *self.session.lock().unwrap() = Some(s);
        (200, serde_json::to_string(&PrepareResponse { session_id: incoming.id, files: tokens }).unwrap_or_default())
    }

    fn emit_session(&self, s: &Session, state: &str, error: Option<String>) {
        let current = s.files.values().find(|f| !f.done).or_else(|| s.files.values().next());
        let paths: Vec<String> = s.files.values().filter(|f| f.done).map(|f| f.dest.to_string_lossy().to_string()).collect();
        self.hooks.transfer(&Transfer {
            id: s.id.clone(),
            outgoing: false,
            peer: s.peer.clone(),
            name: current.map(|f| f.name.clone()).unwrap_or_default(),
            path: if state == "done" {
                paths.first().cloned().unwrap_or_default()
            } else {
                current.map(|f| f.dest.to_string_lossy().to_string()).unwrap_or_default()
            },
            files: s.files.len(),
            done_files: s.files.values().filter(|f| f.done).count(),
            sent: s.received,
            total: s.total,
            state: state.into(),
            error,
            paths,
        });
    }

    fn receive(&self, q: &HashMap<String, String>, ip: IpAddr, body: &mut Body) -> u16 {
        let (Some(sid), Some(fid), Some(token)) = (q.get("sessionId"), q.get("fileId"), q.get("token")) else { return 400 };
        let (dest, cancelled) = {
            let g = self.session.lock().unwrap();
            let Some(s) = g.as_ref() else { return 409 };
            if &s.id != sid || s.ip != ip {
                return 403;
            }
            let Some(f) = s.files.get(fid) else { return 403 };
            if &f.token != token || f.done {
                return 403;
            }
            (f.dest.clone(), s.cancelled.clone())
        };
        let part = dest.with_file_name(format!("{}.part", dest.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()));
        let mut out = match std::fs::File::create(&part) {
            Ok(f) => std::io::BufWriter::with_capacity(256 * 1024, f),
            Err(e) => {
                self.hooks.log(&format!("can't write {}: {e}", part.display()));
                return 500;
            }
        };
        let mut buf = vec![0u8; 128 * 1024];
        let mut got: u64 = 0;
        let mut last_emit = Instant::now();
        loop {
            if cancelled.load(Ordering::Relaxed) {
                drop(out);
                let _ = std::fs::remove_file(&part);
                return 500;
            }
            let n = match body.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => n,
                Err(e) => {
                    drop(out);
                    let _ = std::fs::remove_file(&part);
                    self.hooks.log(&format!("upload interrupted: {e}"));
                    self.fail_session(sid, "The transfer was interrupted.");
                    return 500;
                }
            };
            if out.write_all(&buf[..n]).is_err() {
                drop(out);
                let _ = std::fs::remove_file(&part);
                self.fail_session(sid, "Couldn't save the file (is the disk full?).");
                return 500;
            }
            got += n as u64;
            let mut g = self.session.lock().unwrap();
            if let Some(s) = g.as_mut() {
                s.received += n as u64;
                s.last = Instant::now();
                if last_emit.elapsed() > Duration::from_millis(150) {
                    last_emit = Instant::now();
                    self.emit_session(s, "sending", None);
                }
            }
        }
        if out.flush().is_err() {
            return 500;
        }
        drop(out);
        let _ = std::fs::remove_file(&dest);
        if std::fs::rename(&part, &dest).is_err() {
            return 500;
        }
        let finished = {
            let mut g = self.session.lock().unwrap();
            let Some(s) = g.as_mut() else { return 200 };
            if let Some(f) = s.files.get_mut(fid) {
                f.done = true;
                if f.size > got {
                    // Sender reported a bigger size than it sent; keep the totals honest.
                    s.total = s.total.saturating_sub(f.size - got);
                }
            }
            s.last = Instant::now();
            let all = s.files.values().all(|f| f.done);
            self.emit_session(s, if all { "done" } else { "sending" }, None);
            all
        };
        if finished {
            let s = self.session.lock().unwrap().take();
            if let Some(s) = s {
                self.hooks.log(&format!("received {} file(s) from {}", s.files.len(), s.peer));
            }
        }
        200
    }

    fn fail_session(&self, sid: &str, why: &str) {
        let mut g = self.session.lock().unwrap();
        if g.as_ref().map(|s| s.id == sid).unwrap_or(false) {
            if let Some(s) = g.take() {
                s.cancelled.store(true, Ordering::Relaxed);
                self.emit_session(&s, "failed", Some(why.into()));
            }
        }
    }

    fn cancel_incoming(&self, sid: Option<&str>, ip: IpAddr) {
        self.cancel_incoming_by(sid, ip, true)
    }

    /// `by_sender`: the other device cancelled (vs. the user here).
    fn cancel_incoming_by(&self, sid: Option<&str>, ip: IpAddr, by_sender: bool) {
        let mut g = self.session.lock().unwrap();
        let hit = g.as_ref().map(|s| s.ip == ip && sid.map(|x| x == s.id).unwrap_or(true)).unwrap_or(false);
        if hit {
            if let Some(s) = g.take() {
                s.cancelled.store(true, Ordering::Relaxed);
                for f in s.files.values().filter(|f| !f.done) {
                    let _ = std::fs::remove_file(f.dest.with_file_name(format!("{}.part", f.dest.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default())));
                }
                let why = if by_sender { format!("{} cancelled", s.peer) } else { "Cancelled".to_string() };
                self.emit_session(&s, "cancelled", Some(why));
            }
        }
    }

    /// Cancel a transfer from the island (either direction).
    pub fn cancel(&self, id: &str) {
        let incoming = {
            let g = self.session.lock().unwrap();
            g.as_ref().map(|s| (s.id == id, s.ip)).unwrap_or((false, IpAddr::V4(Ipv4Addr::UNSPECIFIED)))
        };
        if incoming.0 {
            self.cancel_incoming_by(Some(id), incoming.1, false);
            return;
        }
        if let Some((flag, base, sid)) = self.sending.lock().unwrap().get(id).cloned() {
            flag.store(true, Ordering::Relaxed);
            if let Some(sid) = sid {
                let http = self.http.clone();
                std::thread::spawn(move || {
                    let _ = http.post_json(&format!("{base}/cancel?sessionId={sid}"), "", Duration::from_secs(3));
                });
            }
        }
    }

    /* ---------------- sending ---------------- */

    /// Sends files to a nearby device on a background thread; progress goes to `hooks.transfer`.
    /// Returns the transfer id.
    pub fn send(self: &Arc<Self>, fingerprint: &str, paths: Vec<PathBuf>) -> Result<String, String> {
        let peer = self.peers.lock().unwrap().get(fingerprint).cloned().ok_or("That device isn't nearby any more.")?;
        let mut files: Vec<(String, PathBuf, FileDto)> = vec![];
        for p in paths {
            let meta = std::fs::metadata(&p).map_err(|e| format!("{}: {e}", p.display()))?;
            if meta.is_dir() {
                return Err("Folders can't be sent yet; zip it first.".into());
            }
            let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "file".into());
            let id = rand_hex(16);
            files.push((id.clone(), p.clone(), FileDto { id, file_name: name.clone(), size: meta.len(), file_type: mime_of(&name).into(), sha256: None, preview: None }));
        }
        if files.is_empty() {
            return Err("Nothing to send.".into());
        }
        let tid = rand_hex(12);
        let flag = Arc::new(AtomicBool::new(false));
        self.sending.lock().unwrap().insert(tid.clone(), (flag.clone(), peer.base_url(), None));
        let me = self.clone();
        let tid2 = tid.clone();
        std::thread::spawn(move || {
            let r = me.send_inner(&tid2, &peer, &files, &flag);
            let total: u64 = files.iter().map(|f| f.2.size).sum();
            let mk = |state: &str, error: Option<String>, sent: u64, done: usize| Transfer {
                id: tid2.clone(),
                outgoing: true,
                peer: peer.alias.clone(),
                name: files[0].2.file_name.clone(),
                path: files[0].1.to_string_lossy().to_string(),
                files: files.len(),
                done_files: done,
                sent,
                total,
                state: state.into(),
                error,
                paths: vec![],
            };
            match r {
                Ok(()) => me.hooks.transfer(&mk("done", None, total, files.len())),
                Err((state, e)) => {
                    me.hooks.log(&format!("send to {} ended: {state} {e}", peer.alias));
                    me.hooks.transfer(&mk(&state, Some(e), 0, 0));
                }
            }
            me.sending.lock().unwrap().remove(&tid2);
        });
        Ok(tid)
    }

    fn send_inner(&self, tid: &str, peer: &Peer, files: &[(String, PathBuf, FileDto)], cancel: &AtomicBool) -> Result<(), (String, String)> {
        let total: u64 = files.iter().map(|f| f.2.size).sum();
        let emit = |state: &str, sent: u64, done: usize, name: &str, path: &Path| {
            self.hooks.transfer(&Transfer {
                id: tid.into(),
                outgoing: true,
                peer: peer.alias.clone(),
                name: name.into(),
                path: path.to_string_lossy().to_string(),
                files: files.len(),
                done_files: done,
                sent,
                total,
                state: state.into(),
                error: None,
                paths: vec![],
            })
        };
        emit("waiting", 0, 0, &files[0].2.file_name, &files[0].1);
        let req = PrepareRequest { info: self.me(), files: files.iter().map(|f| (f.0.clone(), f.2.clone())).collect() };
        let body = serde_json::to_string(&req).unwrap_or_default();
        let base = peer.base_url();
        // The other side may take a while to tap Accept.
        let (code, resp) = self.http.post_json(&format!("{base}/prepare-upload"), &body, Duration::from_secs(120)).map_err(|e| ("failed".to_string(), format!("Couldn't reach {}: {e}", peer.alias)))?;
        if cancel.load(Ordering::Relaxed) {
            // Cancelled while they were deciding: if they said yes, tell them it's off.
            if code == 200 {
                if let Ok(pr) = serde_json::from_str::<PrepareResponse>(&resp) {
                    let _ = self.http.post_json(&format!("{base}/cancel?sessionId={}", url_encode(&pr.session_id)), "", Duration::from_secs(3));
                }
            }
            return Err(("cancelled".into(), "Cancelled".into()));
        }
        match code {
            200 => {}
            204 => return Ok(()),
            403 => return Err(("declined".into(), format!("{} declined", peer.alias))),
            401 => return Err(("failed".into(), format!("{} asks for a PIN; turn the PIN off in LocalSend to send from Islander", peer.alias))),
            409 => return Err(("failed".into(), format!("{} is busy with another transfer", peer.alias))),
            c => return Err(("failed".into(), format!("{} answered {c}", peer.alias))),
        }
        let pr: PrepareResponse = serde_json::from_str(&resp).map_err(|e| ("failed".to_string(), format!("Unexpected answer: {e}")))?;
        if let Some(e) = self.sending.lock().unwrap().get_mut(tid) {
            e.2 = Some(pr.session_id.clone());
        }
        let sent_before = AtomicU64::new(0);
        let mut done = 0usize;
        for (id, path, dto) in files {
            let Some(token) = pr.files.get(id) else {
                // The receiver skipped this one (already has it).
                sent_before.fetch_add(dto.size, Ordering::Relaxed);
                done += 1;
                continue;
            };
            emit("sending", sent_before.load(Ordering::Relaxed), done, &dto.file_name, path);
            let url = format!("{base}/upload?sessionId={}&fileId={}&token={}", url_encode(&pr.session_id), url_encode(id), url_encode(token));
            let last = Mutex::new(Instant::now());
            let base_sent = sent_before.load(Ordering::Relaxed);
            let progress = |n: u64| {
                let mut l = last.lock().unwrap();
                if l.elapsed() > Duration::from_millis(150) {
                    *l = Instant::now();
                    emit("sending", base_sent + n, done, &dto.file_name, path);
                }
            };
            let code = self.http.post_file(&url, path, dto.size, &progress, cancel).map_err(|e| {
                if cancel.load(Ordering::Relaxed) {
                    ("cancelled".to_string(), "Cancelled".to_string())
                } else if ["reset", "aborted", "closed", "broken pipe", "10053", "10054"].iter().any(|k| e.to_lowercase().contains(k)) {
                    ("failed".to_string(), format!("{} stopped the transfer", peer.alias))
                } else {
                    ("failed".to_string(), format!("Sending {} failed: {e}", dto.file_name))
                }
            })?;
            if code != 200 && code != 204 {
                return Err(("failed".into(), format!("{} refused {} ({code})", peer.alias, dto.file_name)));
            }
            sent_before.fetch_add(dto.size, Ordering::Relaxed);
            done += 1;
        }
        Ok(())
    }
}

/* ------------------------------------------------------------------ tiny HTTP bits */

struct Body {
    r: BufReader<TcpStream>,
    left: Option<u64>,
    chunked: bool,
    chunk_left: u64,
    done: bool,
}

impl Body {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.done {
            return Ok(0);
        }
        if self.chunked {
            if self.chunk_left == 0 {
                let mut line = String::new();
                self.r.read_line(&mut line)?;
                if line.trim().is_empty() {
                    line.clear();
                    self.r.read_line(&mut line)?;
                }
                let size = u64::from_str_radix(line.trim().split(';').next().unwrap_or("0"), 16).unwrap_or(0);
                if size == 0 {
                    self.done = true;
                    return Ok(0);
                }
                self.chunk_left = size;
            }
            let n = (buf.len() as u64).min(self.chunk_left) as usize;
            let got = self.r.read(&mut buf[..n])?;
            if got == 0 {
                return Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "connection closed"));
            }
            self.chunk_left -= got as u64;
            if self.chunk_left == 0 {
                let mut crlf = [0u8; 2];
                let _ = self.r.read_exact(&mut crlf);
            }
            return Ok(got);
        }
        match self.left {
            Some(0) => {
                self.done = true;
                Ok(0)
            }
            Some(left) => {
                let n = (buf.len() as u64).min(left) as usize;
                let got = self.r.read(&mut buf[..n])?;
                if got == 0 {
                    return Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "connection closed"));
                }
                self.left = Some(left - got as u64);
                Ok(got)
            }
            // No length and not chunked: read to the end.
            None => {
                let got = self.r.read(buf)?;
                if got == 0 {
                    self.done = true;
                }
                Ok(got)
            }
        }
    }

    fn read_small(&mut self, max: usize) -> Result<Vec<u8>, String> {
        if self.left.is_none() && !self.chunked {
            return Ok(vec![]); // no body
        }
        let mut out = vec![];
        let mut buf = [0u8; 16 * 1024];
        loop {
            let n = self.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            out.extend_from_slice(&buf[..n]);
            if out.len() > max {
                return Err("body too large".into());
            }
        }
        Ok(out)
    }
}

fn respond(conn: &mut TcpStream, code: u16, body: &str) -> Result<(), String> {
    let reason = match code {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        409 => "Conflict",
        422 => "Unprocessable Entity",
        _ => "Internal Server Error",
    };
    let head = format!(
        "HTTP/1.1 {code} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    conn.write_all(head.as_bytes()).and_then(|_| conn.write_all(body.as_bytes())).and_then(|_| conn.flush()).map_err(|e| e.to_string())
}

pub fn url_encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn url_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(std::str::from_utf8(&b[i + 1..i + 3]).unwrap_or(""), 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(if b[i] == b'+' { b' ' } else { b[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

/// Plain-HTTP client on std sockets (used for `http` peers, and for tests).
pub struct PlainHttp;

impl PlainHttp {
    fn connect(url: &str, timeout: Duration) -> Result<(TcpStream, String, String), String> {
        let rest = url.strip_prefix("http://").ok_or("only http:// here")?;
        let (hostport, path) = rest.split_once('/').map(|(h, p)| (h, format!("/{p}"))).unwrap_or((rest, "/".into()));
        let addr: SocketAddr = hostport.parse().map_err(|e| format!("{hostport}: {e}"))?;
        let s = TcpStream::connect_timeout(&addr, Duration::from_secs(4)).map_err(|e| e.to_string())?;
        let _ = s.set_read_timeout(Some(timeout));
        let _ = s.set_write_timeout(Some(Duration::from_secs(30)));
        Ok((s, hostport.to_string(), path))
    }
    fn read_response(s: TcpStream) -> Result<(u16, String), String> {
        let mut r = BufReader::new(s);
        let mut line = String::new();
        r.read_line(&mut line).map_err(|e| e.to_string())?;
        let code: u16 = line.split_whitespace().nth(1).and_then(|c| c.parse().ok()).ok_or("bad response")?;
        let mut len: Option<usize> = None;
        loop {
            let mut h = String::new();
            if r.read_line(&mut h).map_err(|e| e.to_string())? == 0 {
                break;
            }
            let h = h.trim_end();
            if h.is_empty() {
                break;
            }
            if let Some((k, v)) = h.split_once(':') {
                if k.trim().eq_ignore_ascii_case("content-length") {
                    len = v.trim().parse().ok();
                }
            }
        }
        let mut body = vec![];
        match len {
            Some(n) => {
                body.resize(n, 0);
                r.read_exact(&mut body).map_err(|e| e.to_string())?;
            }
            None => {
                let _ = r.read_to_end(&mut body);
            }
        }
        Ok((code, String::from_utf8_lossy(&body).to_string()))
    }
}

impl Http for PlainHttp {
    fn post_json(&self, url: &str, body: &str, timeout: Duration) -> Result<(u16, String), String> {
        let (mut s, host, path) = Self::connect(url, timeout)?;
        let req = format!("POST {path} HTTP/1.1\r\nHost: {host}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
        s.write_all(req.as_bytes()).map_err(|e| e.to_string())?;
        Self::read_response(s)
    }
    fn post_file(&self, url: &str, path: &Path, size: u64, progress: &(dyn Fn(u64) + Sync), cancel: &AtomicBool) -> Result<u16, String> {
        let (mut s, host, p) = Self::connect(url, Duration::from_secs(60))?;
        let head = format!("POST {p} HTTP/1.1\r\nHost: {host}\r\nContent-Type: application/octet-stream\r\nContent-Length: {size}\r\nConnection: close\r\n\r\n");
        s.write_all(head.as_bytes()).map_err(|e| e.to_string())?;
        let mut f = std::fs::File::open(path).map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; 256 * 1024];
        let mut sent = 0u64;
        loop {
            if cancel.load(Ordering::Relaxed) {
                return Err("cancelled".into());
            }
            let n = f.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            s.write_all(&buf[..n]).map_err(|e| e.to_string())?;
            sent += n as u64;
            progress(sent);
        }
        Self::read_response(s).map(|r| r.0)
    }
}


/* ------------------------------------------------------------------ identity & TLS */

/// This device's TLS identity. Current LocalSend versions require the connecting side to
/// present a certificate (mutual TLS) and only trust a fingerprint that matches it, so
/// the fingerprint is the uppercase-hex SHA-256 of the certificate.
#[derive(Clone)]
pub struct Identity {
    pub cert_pem: String,
    pub key_pem: String,
    pub fingerprint: String,
}

impl Identity {
    pub fn generate() -> Result<Self, String> {
        let mut params = rcgen::CertificateParams::new(vec!["LocalSend User".to_string()]).map_err(|e| e.to_string())?;
        params.distinguished_name.push(rcgen::DnType::CommonName, "LocalSend User");
        // rcgen's default validity (1975–4096) passes LocalSend's time check on any clock.
        let key = rcgen::KeyPair::generate().map_err(|e| e.to_string())?;
        let cert = params.self_signed(&key).map_err(|e| e.to_string())?;
        Ok(Self::from_parts(cert.pem(), key.serialize_pem(), cert.der().as_ref()))
    }

    fn from_parts(cert_pem: String, key_pem: String, der: &[u8]) -> Self {
        let d = ring::digest::digest(&ring::digest::SHA256, der);
        let fingerprint = d.as_ref().iter().map(|b| format!("{b:02X}")).collect();
        Self { cert_pem, key_pem, fingerprint }
    }

    /// Loads a saved identity (cert + key PEM), or None if it's unusable.
    pub fn from_pem(cert_pem: &str, key_pem: &str) -> Option<Self> {
        use rustls::pki_types::pem::PemObject;
        let der = rustls::pki_types::CertificateDer::from_pem_slice(cert_pem.as_bytes()).ok()?;
        rustls::pki_types::PrivateKeyDer::from_pem_slice(key_pem.as_bytes()).ok()?;
        Some(Self::from_parts(cert_pem.to_string(), key_pem.to_string(), der.as_ref()))
    }
}

/// LocalSend peers use self-signed certificates: any certificate is accepted here (the
/// fingerprint the peer announced identifies it), but the handshake signature is still
/// verified so the connection is genuinely encrypted to that certificate's key.
#[derive(Debug)]
struct AnyServerCert(Arc<rustls::crypto::CryptoProvider>);

impl rustls::client::danger::ServerCertVerifier for AnyServerCert {
    fn verify_server_cert(
        &self,
        _: &rustls::pki_types::CertificateDer<'_>,
        _: &[rustls::pki_types::CertificateDer<'_>],
        _: &rustls::pki_types::ServerName<'_>,
        _: &[u8],
        _: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(&self, m: &[u8], c: &rustls::pki_types::CertificateDer<'_>, d: &rustls::DigitallySignedStruct) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(m, c, d, &self.0.signature_verification_algorithms)
    }
    fn verify_tls13_signature(&self, m: &[u8], c: &rustls::pki_types::CertificateDer<'_>, d: &rustls::DigitallySignedStruct) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(m, c, d, &self.0.signature_verification_algorithms)
    }
    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

/// HTTP and HTTPS (with this device's client certificate) on plain std sockets.
pub struct LsHttp {
    tls: Arc<rustls::ClientConfig>,
}

impl LsHttp {
    pub fn new(id: &Identity) -> Result<Self, String> {
        use rustls::pki_types::pem::PemObject;
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let certs = vec![rustls::pki_types::CertificateDer::from_pem_slice(id.cert_pem.as_bytes()).map_err(|e| e.to_string())?];
        let key = rustls::pki_types::PrivateKeyDer::from_pem_slice(id.key_pem.as_bytes()).map_err(|e| e.to_string())?;
        let cfg = rustls::ClientConfig::builder_with_provider(provider.clone())
            .with_safe_default_protocol_versions()
            .map_err(|e| e.to_string())?
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(AnyServerCert(provider)))
            .with_client_auth_cert(certs, key)
            .map_err(|e| e.to_string())?;
        Ok(Self { tls: Arc::new(cfg) })
    }

    fn open(&self, url: &str, timeout: Duration) -> Result<(Box<dyn ReadWrite>, String, String), String> {
        let (tls, rest) = if let Some(r) = url.strip_prefix("https://") {
            (true, r)
        } else if let Some(r) = url.strip_prefix("http://") {
            (false, r)
        } else {
            return Err(format!("bad url {url}"));
        };
        let (hostport, path) = rest.split_once('/').map(|(h, p)| (h, format!("/{p}"))).unwrap_or((rest, "/".into()));
        let addr: SocketAddr = match hostport.parse() {
            Ok(a) => a,
            Err(_) => std::net::ToSocketAddrs::to_socket_addrs(hostport).map_err(|e| format!("{hostport}: {e}"))?.next().ok_or("no address")?,
        };
        let s = TcpStream::connect_timeout(&addr, Duration::from_millis(2500)).map_err(|e| e.to_string())?;
        let _ = s.set_read_timeout(Some(timeout));
        let _ = s.set_write_timeout(Some(Duration::from_secs(30)));
        let _ = s.set_nodelay(true);
        if !tls {
            return Ok((Box::new(s), hostport.to_string(), path));
        }
        let host = hostport.rsplit_once(':').map(|(h, _)| h).unwrap_or(hostport).trim_matches(['[', ']']);
        let name = rustls::pki_types::ServerName::try_from(host.to_string()).map_err(|e| e.to_string())?;
        let conn = rustls::ClientConnection::new(self.tls.clone(), name).map_err(|e| e.to_string())?;
        let mut tls = rustls::StreamOwned::new(conn, s);
        // Finish the handshake now, so certificate problems surface as a clear error.
        while tls.conn.is_handshaking() {
            tls.conn.complete_io(&mut tls.sock).map_err(|e| format!("TLS: {e}"))?;
        }
        Ok((Box::new(tls), hostport.to_string(), path))
    }
}

pub trait ReadWrite: Read + Write + Send {}
impl<T: Read + Write + Send> ReadWrite for T {}

fn read_response(s: &mut dyn ReadWrite) -> Result<(u16, String), String> {
    let mut r = BufReader::new(s);
    let mut line = String::new();
    r.read_line(&mut line).map_err(|e| e.to_string())?;
    let code: u16 = line.split_whitespace().nth(1).and_then(|c| c.parse().ok()).ok_or_else(|| format!("bad response: {}", line.trim()))?;
    let mut len: Option<usize> = None;
    let mut chunked = false;
    loop {
        let mut h = String::new();
        if r.read_line(&mut h).map_err(|e| e.to_string())? == 0 {
            break;
        }
        let h = h.trim_end();
        if h.is_empty() {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            if k.trim().eq_ignore_ascii_case("content-length") {
                len = v.trim().parse().ok();
            } else if k.trim().eq_ignore_ascii_case("transfer-encoding") && v.to_ascii_lowercase().contains("chunked") {
                chunked = true;
            }
        }
    }
    let mut body = vec![];
    if chunked {
        loop {
            let mut sz = String::new();
            if r.read_line(&mut sz).map_err(|e| e.to_string())? == 0 {
                break;
            }
            let n = usize::from_str_radix(sz.trim().split(';').next().unwrap_or("0"), 16).unwrap_or(0);
            if n == 0 {
                break;
            }
            let at = body.len();
            body.resize(at + n, 0);
            r.read_exact(&mut body[at..]).map_err(|e| e.to_string())?;
            let mut crlf = [0u8; 2];
            let _ = r.read_exact(&mut crlf);
        }
    } else if let Some(n) = len {
        body.resize(n, 0);
        r.read_exact(&mut body).map_err(|e| e.to_string())?;
    } else if code != 204 {
        let _ = r.read_to_end(&mut body);
    }
    Ok((code, String::from_utf8_lossy(&body).to_string()))
}

impl Http for LsHttp {
    fn post_json(&self, url: &str, body: &str, timeout: Duration) -> Result<(u16, String), String> {
        let (mut s, host, path) = self.open(url, timeout)?;
        let req = format!("POST {path} HTTP/1.1\r\nHost: {host}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
        s.write_all(req.as_bytes()).and_then(|_| s.flush()).map_err(|e| e.to_string())?;
        read_response(s.as_mut())
    }
    fn post_file(&self, url: &str, path: &Path, size: u64, progress: &(dyn Fn(u64) + Sync), cancel: &AtomicBool) -> Result<u16, String> {
        let (mut s, host, p) = self.open(url, Duration::from_secs(120))?;
        let head = format!("POST {p} HTTP/1.1\r\nHost: {host}\r\nContent-Type: application/octet-stream\r\nContent-Length: {size}\r\nConnection: close\r\n\r\n");
        s.write_all(head.as_bytes()).map_err(|e| e.to_string())?;
        let mut f = std::fs::File::open(path).map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; 256 * 1024];
        let mut sent = 0u64;
        loop {
            if cancel.load(Ordering::Relaxed) {
                return Err("cancelled".into());
            }
            let n = f.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            s.write_all(&buf[..n]).map_err(|e| e.to_string())?;
            sent += n as u64;
            progress(sent);
        }
        s.flush().map_err(|e| e.to_string())?;
        read_response(s.as_mut()).map(|r| r.0)
    }
}
