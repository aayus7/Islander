//! The PC's own location for the weather, from Windows' location service (Wi-Fi based,
//! usually right to the town). An IP lookup is only a fallback: it finds the internet
//! provider's hub instead, e.g. Kathmandu for someone in Hetauda.

use serde::Serialize;

#[derive(Serialize)]
pub struct Position {
    lat: f64,
    lon: f64,
    /// Metres.
    accuracy: f64,
}

/// `None` when Windows can't or won't say (location turned off, or desktop apps not
/// allowed under Settings › Privacy & security › Location); the app then uses its IP lookup.
#[tauri::command]
pub async fn geo_position() -> Option<Position> {
    tauri::async_runtime::spawn_blocking(locate).await.ok().flatten()
}

fn locate() -> Option<Position> {
    use std::time::Duration;
    use windows::Devices::Geolocation::{GeolocationAccessStatus, Geolocator, PositionAccuracy};
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
    let run = || -> windows::core::Result<Option<Position>> {
        if Geolocator::RequestAccessAsync()?.get()? != GeolocationAccessStatus::Allowed {
            return Ok(None);
        }
        let g = Geolocator::new()?;
        g.SetDesiredAccuracy(PositionAccuracy::Default)?;
        // Accept a fix up to 30 minutes old; give up after 8 s.
        let pos = g
            .GetGeopositionAsyncWithAgeAndTimeout(Duration::from_secs(30 * 60).into(), Duration::from_secs(8).into())?
            .get()?;
        let c = pos.Coordinate()?;
        let p = c.Point()?.Position()?;
        Ok(Some(Position { lat: p.Latitude, lon: p.Longitude, accuracy: c.Accuracy().unwrap_or(0.0) }))
    };
    match run() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("geo: {e}");
            None
        }
    }
}
