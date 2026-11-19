//! Wi-Fi, Bluetooth and Airplane mode for the Controls tab.
//!
//! * Wi-Fi: scan, see signal & security, connect (saved networks or with a
//!   password), disconnect, turn the radio on/off.
//! * Bluetooth: paired devices with their type, connection state and battery;
//!   connect/disconnect audio devices (the same mechanism Windows' Sound panel uses);
//!   turn the radio on/off. A "Connected" live activity fires when one connects.
//! * Airplane mode: all radios off (and back on).
use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WifiNet {
    pub ssid: String,
    pub bars: u8,
    pub secure: bool,
    pub connected: bool,
    /// Windows has a saved profile (knows the password).
    pub saved: bool,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct WifiState {
    pub available: bool,
    pub on: bool,
    pub connected: Option<String>,
    pub networks: Vec<WifiNet>,
    pub error: Option<String>,
}

#[derive(Serialize, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BtDevice {
    pub id: String,
    pub name: String,
    pub connected: bool,
    /// "earbuds" | "headphones" | "speaker" | "mouse" | "keyboard" | "controller" | "phone" | "other"
    pub kind: String,
    pub battery: Option<u8>,
    /// Audio devices can be connected/disconnected from the island.
    pub audio: bool,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct BtState {
    pub available: bool,
    pub on: bool,
    pub devices: Vec<BtDevice>,
}

/// Guess the device type from its name and Bluetooth class.
pub fn kind_of(name: &str, audio_class: bool) -> &'static str {
    let n = name.to_lowercase();
    if n.contains("airpods max") || n.contains("headphone") || n.contains("qc") || n.contains("wh-") || n.contains("bose") || n == "jet" {
        "headphones"
    } else if n.contains("airpods") || n.contains("buds") || n.contains("earbud") || n.contains("wf-") || n.contains("beats") {
        "earbuds"
    } else if n.contains("speaker") || n.contains("soundlink") || n.contains("jbl") || n.contains("boom") {
        "speaker"
    } else if n.contains("mouse") || n.contains("mx master") || n.contains("mx anywhere") {
        "mouse"
    } else if n.contains("keyboard") || n.contains("keys") {
        "keyboard"
    } else if n.contains("controller") || n.contains("xbox") || n.contains("dualsense") || n.contains("dualshock") || n.contains("pro controller") {
        "controller"
    } else if n.contains("iphone") || n.contains("galaxy") || n.contains("pixel") || n.contains("phone") {
        "phone"
    } else if audio_class {
        "headphones"
    } else {
        "other"
    }
}

#[cfg(windows)]
mod imp {
    //! Event-driven: Windows tells us the moment a radio flips, a network
    //! connects/drops, the list of nearby networks changes or a Bluetooth device
    //! (dis)connects. We keep the latest state cached so the UI reads it instantly
    //! and push every change to the island ("wifi://state", "bt://state").
    use super::*;
    use std::sync::{Mutex, OnceLock};
    use std::time::Duration;
    use windows::core::{IInspectable, Interface, Ref, HSTRING, PCWSTR};
    use windows::Devices::Bluetooth::{BluetoothAdapter, BluetoothConnectionStatus, BluetoothDevice, BluetoothLEDevice, BluetoothMajorClass};
    use windows::Devices::Enumeration::DeviceInformation;
    use windows::Devices::Radios::{Radio, RadioAccessStatus, RadioKind, RadioState};
    use windows::Devices::WiFi::{WiFiAccessStatus, WiFiAdapter, WiFiConnectionStatus, WiFiReconnectionKind};
    use windows::Foundation::TypedEventHandler;
    use windows::Networking::Connectivity::{NetworkAuthenticationType, NetworkInformation, NetworkStatusChangedEventHandler};
    use windows::Security::Credentials::PasswordCredential;

    static APP: OnceLock<AppHandle> = OnceLock::new();
    static RADIOS: Mutex<Vec<Radio>> = Mutex::new(Vec::new());
    /// The Bluetooth radio, found through the default Bluetooth adapter. Looked up again until
    /// it exists: when Islander starts at sign-in, Windows often hasn't started Bluetooth yet.
    static BT_RADIO: Mutex<Option<Radio>> = Mutex::new(None);
    /// Whether this PC has a Bluetooth adapter at all (None = not known yet).
    static BT_ADAPTER: Mutex<Option<bool>> = Mutex::new(None);
    static ADAPTER: Mutex<Option<WiFiAdapter>> = Mutex::new(None);
    static WIFI: Mutex<Option<WifiState>> = Mutex::new(None);
    static BT: Mutex<Option<BtState>> = Mutex::new(None);
    static ENTRIES: Mutex<Vec<Entry>> = Mutex::new(Vec::new());
    /// Names connected at the last publish (None until the first one: no
    /// "Connected" activity for devices that were already connected at startup).
    static PREV_CONNECTED: Mutex<Option<Vec<String>>> = Mutex::new(None);
    static LAST_AIRPLANE: Mutex<Option<bool>> = Mutex::new(None);

    struct Entry {
        id: String,
        name: String,
        kind: String,
        audio: bool,
        classic: Option<BluetoothDevice>,
        le: Option<BluetoothLEDevice>,
    }

    fn com() {
        use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
    }

    fn emit<S: Serialize + Clone>(ev: &str, v: &S) {
        if let Some(app) = APP.get() {
            let _ = app.emit(ev, v.clone());
        }
    }

    /* ---------- radios ---------- */

    fn load_radios() {
        let _ = Radio::RequestAccessAsync().and_then(|op| op.get());
        let list: Vec<Radio> = Radio::GetRadiosAsync().and_then(|op| op.get()).map(|v| v.into_iter().collect()).unwrap_or_default();
        for r in &list {
            let _ = r.StateChanged(&TypedEventHandler::<Radio, IInspectable>::new(|sender: Ref<Radio>, _| {
                if let Some(r) = sender.as_ref() {
                    match r.Kind() {
                        Ok(RadioKind::WiFi) => spawn_publish_wifi(false),
                        Ok(RadioKind::Bluetooth) => {
                            std::thread::spawn(publish_bt);
                        }
                        _ => {}
                    }
                }
                publish_airplane();
                Ok(())
            }));
        }
        if let Ok(mut g) = RADIOS.lock() {
            *g = list;
        }
    }

    fn radio(kind: RadioKind) -> Option<Radio> {
        if RADIOS.lock().map(|g| g.is_empty()).unwrap_or(true) {
            load_radios();
        }
        RADIOS.lock().ok()?.iter().find(|r| r.Kind().ok() == Some(kind)).cloned()
    }

    /// Finds (and from then on watches) the Bluetooth radio. Cheap once found.
    fn bt_radio() -> Option<Radio> {
        if let Some(r) = BT_RADIO.lock().ok().and_then(|g| g.clone()) {
            return Some(r);
        }
        let adapter = BluetoothAdapter::GetDefaultAsync().and_then(|op| op.get()).ok();
        if let Ok(mut g) = BT_ADAPTER.lock() {
            *g = Some(adapter.is_some());
        }
        let r = adapter
            .and_then(|a| a.GetRadioAsync().and_then(|op| op.get()).ok())
            .or_else(|| {
                // Fall back to the system radio list, re-read in case it was read too early.
                if let Ok(mut g) = RADIOS.lock() {
                    if !g.iter().any(|r| r.Kind().ok() == Some(RadioKind::Bluetooth)) {
                        g.clear();
                    }
                }
                radio(RadioKind::Bluetooth)
            })?;
        let _ = r.StateChanged(&TypedEventHandler::<Radio, IInspectable>::new(|_, _| {
            std::thread::spawn(publish_bt);
            publish_airplane();
            Ok(())
        }));
        crate::log_line(format!("bluetooth: radio found (state {:?})", r.State().map(|s| s.0)));
        if let Ok(mut g) = BT_RADIO.lock() {
            *g = Some(r.clone());
        }
        Some(r)
    }

    fn radio_on(kind: RadioKind) -> Option<bool> {
        let r = if kind == RadioKind::Bluetooth { bt_radio() } else { radio(kind) };
        r.and_then(|r| r.State().ok()).map(|s| s == RadioState::On)
    }

    pub fn set_radio(kind: RadioKind, on: bool) -> Result<(), String> {
        com();
        let name = if kind == RadioKind::Bluetooth { "Bluetooth" } else { "Wi-Fi" };
        let _ = Radio::RequestAccessAsync().and_then(|op| op.get());
        let r = if kind == RadioKind::Bluetooth { bt_radio() } else { radio(kind) };
        let r = r.ok_or_else(|| format!("Windows isn't showing a {name} radio right now. Open {name} settings to turn it on."))?;
        let status = r
            .SetStateAsync(if on { RadioState::On } else { RadioState::Off })
            .and_then(|op| op.get())
            .map_err(|e| e.to_string())?;
        crate::log_line(format!("radio {name} -> {on}: access {:?}", status.0));
        if status == RadioAccessStatus::Allowed {
            Ok(())
        } else {
            // Most often: Settings → Privacy & security → Radios → "Let apps control device radios" is off.
            Err(format!("Windows didn't let Islander switch {name}. Turn it on in {name} settings, or allow \"Let apps control device radios\" under Privacy & security → Radios."))
        }
    }

    pub fn airplane() -> bool {
        // "Airplane mode" here = every radio this PC has is off.
        if RADIOS.lock().map(|g| g.is_empty()).unwrap_or(true) {
            load_radios();
        }
        let Ok(g) = RADIOS.lock() else { return false };
        let states: Vec<bool> = g.iter().filter_map(|r| r.State().ok()).map(|s| s == RadioState::On).collect();
        !states.is_empty() && states.iter().all(|on| !on)
    }

    fn publish_airplane() {
        let a = airplane();
        let mut last = LAST_AIRPLANE.lock().unwrap();
        if *last != Some(a) {
            *last = Some(a);
            emit("airplane://state", &a);
        }
    }

    pub fn set_airplane(on: bool) -> Result<(), String> {
        com();
        if RADIOS.lock().map(|g| g.is_empty()).unwrap_or(true) {
            load_radios();
        }
        let list: Vec<Radio> = RADIOS.lock().map(|g| g.clone()).unwrap_or_default();
        for r in list {
            let _ = r.SetStateAsync(if on { RadioState::Off } else { RadioState::On }).and_then(|op| op.get());
        }
        Ok(())
    }

    /* ---------- Wi-Fi ---------- */

    fn adapter() -> Result<WiFiAdapter, String> {
        if let Some(a) = ADAPTER.lock().ok().and_then(|g| g.clone()) {
            return Ok(a);
        }
        let access = WiFiAdapter::RequestAccessAsync().and_then(|op| op.get()).map_err(|e| e.to_string())?;
        if access != WiFiAccessStatus::Allowed {
            return Err("Windows only shows Wi-Fi networks to apps when location access is on. Turn on Settings → Privacy & security → Location → \"Let desktop apps access your location\".".into());
        }
        let a = WiFiAdapter::FindAllAdaptersAsync()
            .and_then(|op| op.get())
            .map_err(|e| e.to_string())?
            .into_iter()
            .next()
            .ok_or_else(|| "No Wi-Fi adapter".to_string())?;
        // Nearby networks changed (Windows rescans on its own every so often).
        let _ = a.AvailableNetworksChanged(&TypedEventHandler::<WiFiAdapter, IInspectable>::new(|_, _| {
            spawn_publish_wifi(false);
            Ok(())
        }));
        if let Ok(mut g) = ADAPTER.lock() {
            *g = Some(a.clone());
        }
        Ok(a)
    }

    fn connected_ssid(a: &WiFiAdapter) -> Option<String> {
        let p = a.NetworkAdapter().ok()?.GetConnectedProfileAsync().ok()?.get().ok()?;
        if !p.IsWlanConnectionProfile().unwrap_or(false) {
            return None;
        }
        p.WlanConnectionProfileDetails().ok()?.GetConnectedSsid().ok().map(|s| s.to_string()).filter(|s| !s.is_empty())
    }

    /// Networks this PC has a saved profile for (it knows their password).
    fn saved_profiles() -> Vec<String> {
        NetworkInformation::GetConnectionProfiles()
            .map(|v| {
                v.into_iter()
                    .filter(|p| p.IsWlanConnectionProfile().unwrap_or(false))
                    .filter_map(|p| p.ProfileName().ok().map(|n| n.to_string()))
                    .collect()
            })
            .unwrap_or_default()
    }

    fn is_secure(n: &windows::Devices::WiFi::WiFiAvailableNetwork) -> bool {
        let auth = n.SecuritySettings().and_then(|s| s.NetworkAuthenticationType()).unwrap_or(NetworkAuthenticationType::None);
        auth != NetworkAuthenticationType::Open80211 && auth != NetworkAuthenticationType::None
    }

    fn compute_wifi(scan: bool) -> WifiState {
        let on = radio_on(RadioKind::WiFi);
        let mut st = WifiState { available: on.is_some(), on: on.unwrap_or(false), ..Default::default() };
        if !st.on {
            return st;
        }
        let a = match adapter() {
            Ok(a) => a,
            Err(e) => {
                st.error = Some(e);
                return st;
            }
        };
        st.connected = connected_ssid(&a);
        if scan {
            let _ = a.ScanAsync().and_then(|op| op.get());
        }
        let saved = saved_profiles();
        let mut nets: Vec<WifiNet> = Vec::new();
        if let Ok(list) = a.NetworkReport().and_then(|r| r.AvailableNetworks()) {
            for n in list {
                let ssid = n.Ssid().map(|s| s.to_string()).unwrap_or_default();
                if ssid.is_empty() {
                    continue; // hidden networks
                }
                let bars = n.SignalBars().unwrap_or(0);
                match nets.iter_mut().find(|x| x.ssid == ssid) {
                    Some(x) => x.bars = x.bars.max(bars),
                    None => nets.push(WifiNet {
                        connected: st.connected.as_deref() == Some(ssid.as_str()),
                        saved: saved.iter().any(|p| p == &ssid),
                        secure: is_secure(&n),
                        ssid,
                        bars,
                    }),
                }
            }
        }
        // The connected network is always listed, even if the last report missed it.
        if let Some(c) = &st.connected {
            if !nets.iter().any(|n| &n.ssid == c) {
                nets.push(WifiNet { ssid: c.clone(), bars: 4, secure: true, connected: true, saved: true });
            }
        }
        nets.sort_by(|a, b| b.connected.cmp(&a.connected).then(b.saved.cmp(&a.saved)).then(b.bars.cmp(&a.bars)));
        st.networks = nets;
        st
    }

    pub fn publish_wifi(scan: bool) -> WifiState {
        com();
        let st = compute_wifi(scan);
        let changed = {
            let mut g = WIFI.lock().unwrap();
            let changed = g.as_ref().map(|o| serde_json::to_string(o).ok() != serde_json::to_string(&st).ok()).unwrap_or(true);
            *g = Some(st.clone());
            changed
        };
        if changed {
            emit("wifi://state", &st);
        }
        st
    }

    fn spawn_publish_wifi(scan: bool) {
        std::thread::spawn(move || {
            publish_wifi(scan);
        });
    }

    pub fn wifi(scan: bool) -> WifiState {
        if !scan {
            if let Some(st) = WIFI.lock().ok().and_then(|g| g.clone()) {
                return st;
            }
        }
        publish_wifi(scan)
    }

    /// "connected" | "needs_password" | "wrong_password" | "failed"
    pub fn wifi_connect(ssid: &str, password: Option<String>) -> Result<String, String> {
        com();
        let a = adapter()?;
        let find = |a: &WiFiAdapter| a.NetworkReport().and_then(|r| r.AvailableNetworks()).ok().and_then(|l| l.into_iter().find(|n| n.Ssid().map(|s| s.to_string()).ok().as_deref() == Some(ssid)));
        let net = match find(&a) {
            Some(n) => n,
            None => {
                let _ = a.ScanAsync().and_then(|op| op.get());
                find(&a).ok_or("That network is out of range")?
            }
        };
        let secure = is_secure(&net);
        let password = password.filter(|p| !p.is_empty());
        if secure && password.is_none() && !saved_profiles().iter().any(|p| p == ssid) {
            return Ok("needs_password".into());
        }
        let result = match &password {
            Some(pw) => {
                let cred = PasswordCredential::new().map_err(|e| e.to_string())?;
                cred.SetPassword(&HSTRING::from(pw.as_str())).map_err(|e| e.to_string())?;
                a.ConnectWithPasswordCredentialAsync(&net, WiFiReconnectionKind::Automatic, &cred).and_then(|op| op.get())
            }
            None => a.ConnectAsync(&net, WiFiReconnectionKind::Automatic).and_then(|op| op.get()),
        }
        .map_err(|e| e.to_string())?;
        let status = result.ConnectionStatus().map_err(|e| e.to_string())?;
        spawn_publish_wifi(false);
        Ok(match status {
            WiFiConnectionStatus::Success => "connected",
            WiFiConnectionStatus::NetworkNotAvailable | WiFiConnectionStatus::Timeout => "failed",
            // Without a password, a failure on a secured network means the saved
            // one no longer works: ask for it (never "wrong" before you typed one).
            _ if password.is_none() => {
                if secure {
                    "needs_password"
                } else {
                    "failed"
                }
            }
            _ => "wrong_password",
        }
        .into())
    }

    pub fn wifi_disconnect() -> Result<(), String> {
        com();
        adapter()?.Disconnect().map_err(|e| e.to_string())?;
        spawn_publish_wifi(false);
        Ok(())
    }

    /* ---------- Bluetooth ---------- */

    fn on_bt_change() {
        std::thread::spawn(publish_bt);
    }

    /// Picks up newly paired / removed devices and subscribes to their connection events.
    fn enumerate_bt() {
        let mut found: Vec<String> = Vec::new();
        let mut fresh: Vec<Entry> = Vec::new();
        let known: Vec<String> = ENTRIES.lock().map(|g| g.iter().map(|e| e.id.clone()).collect()).unwrap_or_default();
        if let Ok(sel) = BluetoothDevice::GetDeviceSelectorFromPairingState(true) {
            if let Ok(infos) = DeviceInformation::FindAllAsyncAqsFilter(&sel).and_then(|op| op.get()) {
                for info in infos {
                    let Ok(id) = info.Id() else { continue };
                    let id_s = id.to_string();
                    found.push(id_s.clone());
                    if known.contains(&id_s) {
                        continue;
                    }
                    let Ok(d) = BluetoothDevice::FromIdAsync(&id).and_then(|op| op.get()) else { continue };
                    let name = d.Name().map(|n| n.to_string()).unwrap_or_default();
                    if name.is_empty() {
                        continue;
                    }
                    let major = d.ClassOfDevice().and_then(|c| c.MajorClass()).ok();
                    let audio = major == Some(BluetoothMajorClass::AudioVideo);
                    let kind = match major {
                        Some(BluetoothMajorClass::Phone) => "phone",
                        Some(BluetoothMajorClass::Peripheral) => {
                            let k = kind_of(&name, false);
                            if k == "other" { "mouse" } else { k }
                        }
                        _ => kind_of(&name, audio),
                    };
                    let _ = d.ConnectionStatusChanged(&TypedEventHandler::<BluetoothDevice, IInspectable>::new(|_, _| {
                        on_bt_change();
                        Ok(())
                    }));
                    fresh.push(Entry { id: id_s, name, kind: kind.into(), audio, classic: Some(d), le: None });
                }
            }
        }
        if let Ok(sel) = BluetoothLEDevice::GetDeviceSelectorFromPairingState(true) {
            if let Ok(infos) = DeviceInformation::FindAllAsyncAqsFilter(&sel).and_then(|op| op.get()) {
                for info in infos {
                    let Ok(id) = info.Id() else { continue };
                    let id_s = id.to_string();
                    found.push(id_s.clone());
                    if known.contains(&id_s) {
                        continue;
                    }
                    let Ok(d) = BluetoothLEDevice::FromIdAsync(&id).and_then(|op| op.get()) else { continue };
                    let name = d.Name().map(|n| n.to_string()).unwrap_or_default();
                    if name.is_empty() {
                        continue;
                    }
                    let k = kind_of(&name, false);
                    let _ = d.ConnectionStatusChanged(&TypedEventHandler::<BluetoothLEDevice, IInspectable>::new(|_, _| {
                        on_bt_change();
                        Ok(())
                    }));
                    fresh.push(Entry { id: id_s, name, kind: if k == "other" { "mouse".into() } else { k.into() }, audio: false, classic: None, le: Some(d) });
                }
            }
        }
        if let Ok(mut g) = ENTRIES.lock() {
            g.retain(|e| found.contains(&e.id));
            g.extend(fresh);
        }
    }

    fn compute_bt() -> BtState {
        let on = radio_on(RadioKind::Bluetooth);
        let has_adapter = BT_ADAPTER.lock().ok().and_then(|g| *g).unwrap_or(false);
        let mut st = BtState { available: on.is_some() || has_adapter, on: on.unwrap_or(false), devices: vec![] };
        // No readable radio state but a device is clearly connected: Bluetooth is on.
        let radio_unknown = on.is_none();
        let levels = crate::battery::levels();
        let battery_for = |name: &str| {
            let n = name.to_lowercase();
            levels.iter().find(|(l, _)| l.to_lowercase() == n || l.to_lowercase().contains(&n)).map(|(_, v)| *v)
        };
        if let Ok(g) = ENTRIES.lock() {
            for e in g.iter() {
                let connected = (st.on || radio_unknown)
                    && match (&e.classic, &e.le) {
                        (Some(d), _) => d.ConnectionStatus().ok() == Some(BluetoothConnectionStatus::Connected),
                        (_, Some(d)) => d.ConnectionStatus().ok() == Some(BluetoothConnectionStatus::Connected),
                        _ => false,
                    };
                // Merge the classic + LE halves of the same device.
                if let Some(x) = st.devices.iter_mut().find(|x| x.name == e.name) {
                    x.connected |= connected;
                    continue;
                }
                st.devices.push(BtDevice { id: e.id.clone(), name: e.name.clone(), connected, kind: e.kind.clone(), battery: battery_for(&e.name), audio: e.audio });
            }
        }
        st.devices.sort_by(|a, b| b.connected.cmp(&a.connected).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
        if radio_unknown && st.devices.iter().any(|d| d.connected) {
            st.on = true;
        }
        if !st.devices.is_empty() {
            st.available = true;
        }
        st
    }

    static PUBLISH: Mutex<()> = Mutex::new(());

    pub fn publish_bt() {
        com();
        let _one_at_a_time = PUBLISH.lock();
        let st = compute_bt();
        let now: Vec<String> = st.devices.iter().filter(|d| d.connected).map(|d| d.name.clone()).collect();
        let newly: Vec<BtDevice> = {
            let mut prev = PREV_CONNECTED.lock().unwrap();
            let newly = match prev.as_ref() {
                Some(p) => st.devices.iter().filter(|d| d.connected && !p.contains(&d.name)).cloned().collect(),
                None => vec![],
            };
            *prev = Some(now);
            newly
        };
        let changed = {
            let mut g = BT.lock().unwrap();
            let changed = g.as_ref().map(|o| serde_json::to_string(o).ok() != serde_json::to_string(&st).ok()).unwrap_or(true);
            *g = Some(st.clone());
            changed
        };
        if changed {
            emit("bt://state", &st);
        }
        for d in newly {
            emit("bt://connected", &d);
            // Headsets report their battery a moment after connecting: fetch it then.
            let name = d.name.clone();
            std::thread::spawn(move || {
                for ms in [1200u64, 3000, 6000] {
                    std::thread::sleep(Duration::from_millis(ms));
                    crate::battery::scan_now();
                    let lvl = crate::battery::levels().into_iter().find(|(n, _)| n.to_lowercase().contains(&name.to_lowercase())).map(|(_, l)| l);
                    if let Some(l) = lvl {
                        emit("bt://battery", &(name.clone(), l));
                        publish_bt();
                        break;
                    }
                }
            });
        }
    }

    pub fn bluetooth() -> BtState {
        if let Some(st) = BT.lock().ok().and_then(|g| g.clone()) {
            return st;
        }
        com();
        enumerate_bt();
        publish_bt();
        BT.lock().ok().and_then(|g| g.clone()).unwrap_or_default()
    }

    /// Connect / disconnect a Bluetooth audio device: find its audio endpoints, walk
    /// to the Bluetooth audio driver behind them and ask it to (re)connect, exactly
    /// what "Connect" in Windows' Bluetooth & Sound panels does.
    pub fn bt_audio(name: &str, connect: bool) -> Result<(), String> {
        use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
        use windows::Win32::Media::Audio::*;
        use windows::Win32::Media::KernelStreaming::*;
        use windows::Win32::System::Com::{CoCreateInstance, CoTaskMemFree, CLSCTX_ALL, STGM_READ};
        com();
        let want = name.to_lowercase();
        let mut hits = 0;
        unsafe {
            let en: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(|e| e.to_string())?;
            let col = en
                .EnumAudioEndpoints(eAll, DEVICE_STATE(DEVICE_STATE_ACTIVE.0 | DEVICE_STATE_UNPLUGGED.0))
                .map_err(|e| e.to_string())?;
            for i in 0..col.GetCount().unwrap_or(0) {
                let Ok(d) = col.Item(i) else { continue };
                let friendly = d
                    .OpenPropertyStore(STGM_READ)
                    .and_then(|s| s.GetValue(&PKEY_Device_FriendlyName))
                    .map(|v| v.to_string())
                    .unwrap_or_default()
                    .to_lowercase();
                if !friendly.contains(&want) {
                    continue;
                }
                let step = || -> windows::core::Result<()> {
                    let topo: IDeviceTopology = d.Activate(CLSCTX_ALL, None)?;
                    let conn = topo.GetConnector(0)?;
                    let other = conn.GetConnectedTo()?;
                    let part: IPart = other.cast()?;
                    let filter = part.GetTopologyObject()?;
                    let id = filter.GetDeviceId()?;
                    let dev = en.GetDevice(PCWSTR(id.0));
                    CoTaskMemFree(Some(id.0 as *const _));
                    let ks: IKsControl = dev?.Activate(CLSCTX_ALL, None)?;
                    let prop = KSIDENTIFIER {
                        Anonymous: KSIDENTIFIER_0 {
                            Anonymous: KSIDENTIFIER_0_0 {
                                Set: KSPROPSETID_BtAudio,
                                Id: if connect { KSPROPERTY_ONESHOT_RECONNECT.0 as u32 } else { KSPROPERTY_ONESHOT_DISCONNECT.0 as u32 },
                                Flags: KSPROPERTY_TYPE_GET,
                            },
                        },
                    };
                    let mut returned = 0u32;
                    let _ = ks.KsProperty(&prop, std::mem::size_of::<KSIDENTIFIER>() as u32, std::ptr::null_mut(), 0, &mut returned);
                    Ok(())
                };
                if step().is_ok() {
                    hits += 1;
                }
            }
        }
        if hits == 0 {
            return Err(format!("Couldn't reach {name} — make sure it's on and nearby"));
        }
        Ok(())
    }

    pub fn watch(app: AppHandle) {
        let _ = APP.set(app);
        std::thread::spawn(move || {
            com();
            load_radios();
            let _ = NetworkInformation::NetworkStatusChanged(&NetworkStatusChangedEventHandler::new(|_| {
                spawn_publish_wifi(false);
                Ok(())
            }));
            publish_wifi(false);
            publish_airplane();
            enumerate_bt();
            publish_bt();
            loop {
                // Events do the real-time work; this only catches newly paired devices
                // and anything an event might have missed.
                std::thread::sleep(Duration::from_secs(6));
                enumerate_bt();
                publish_bt();
                publish_airplane();
            }
        });
    }
}

/* ---------------- commands ---------------- */

macro_rules! blocking {
    ($e:expr) => {
        tauri::async_runtime::spawn_blocking(move || $e).await.map_err(|e| e.to_string())
    };
}

#[tauri::command]
pub async fn wifi_state(scan: bool) -> Result<WifiState, String> {
    #[cfg(windows)]
    return blocking!(imp::wifi(scan));
    #[allow(unreachable_code)]
    {
        let _ = scan;
        Ok(WifiState::default())
    }
}

#[tauri::command]
pub async fn wifi_set(on: bool) -> Result<(), String> {
    #[cfg(windows)]
    return blocking!(imp::set_radio(windows::Devices::Radios::RadioKind::WiFi, on))?;
    #[allow(unreachable_code)]
    {
        let _ = on;
        Err("unsupported".into())
    }
}

#[tauri::command]
pub async fn wifi_connect(ssid: String, password: Option<String>) -> Result<String, String> {
    #[cfg(windows)]
    return blocking!(imp::wifi_connect(&ssid, password))?;
    #[allow(unreachable_code)]
    {
        let _ = (ssid, password);
        Err("unsupported".into())
    }
}

#[tauri::command]
pub async fn wifi_disconnect() -> Result<(), String> {
    #[cfg(windows)]
    return blocking!(imp::wifi_disconnect())?;
    #[allow(unreachable_code)]
    Err("unsupported".into())
}

#[tauri::command]
pub async fn bt_state() -> Result<BtState, String> {
    #[cfg(windows)]
    return blocking!(imp::bluetooth());
    #[allow(unreachable_code)]
    Ok(BtState::default())
}

#[tauri::command]
pub async fn bt_set(on: bool) -> Result<(), String> {
    #[cfg(windows)]
    return blocking!(imp::set_radio(windows::Devices::Radios::RadioKind::Bluetooth, on))?;
    #[allow(unreachable_code)]
    {
        let _ = on;
        Err("unsupported".into())
    }
}

#[tauri::command]
pub async fn bt_connect(name: String, connect: bool) -> Result<(), String> {
    #[cfg(windows)]
    return blocking!(imp::bt_audio(&name, connect))?;
    #[allow(unreachable_code)]
    {
        let _ = (name, connect);
        Err("unsupported".into())
    }
}

#[tauri::command]
pub async fn airplane_state() -> bool {
    #[cfg(windows)]
    return blocking!(imp::airplane()).unwrap_or(false);
    #[allow(unreachable_code)]
    false
}

#[tauri::command]
pub async fn airplane_set(on: bool) -> Result<(), String> {
    #[cfg(windows)]
    return blocking!(imp::set_airplane(on))?;
    #[allow(unreachable_code)]
    {
        let _ = on;
        Err("unsupported".into())
    }
}

pub fn spawn(app: AppHandle) {
    #[cfg(windows)]
    imp::watch(app);
    #[cfg(not(windows))]
    let _ = app;
}
