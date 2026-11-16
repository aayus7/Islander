//! Hardware telemetry for the System tab: CPU, GPU, memory, disk and network,
//! read from Windows performance counters (the same ones Task Manager uses).
//! Only runs while the tab is open.
use serde::Serialize;
use std::sync::atomic::{AtomicU32, Ordering};
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub cpu: f64,
    pub gpu: Option<f64>,
    pub ram_used: u64,
    pub ram_total: u64,
    pub disk_used: u64,
    pub disk_total: u64,
    pub disk_name: String,
    pub down: f64,
    pub up: f64,
}

/// How many open System tabs want updates (the thread idles at 0).
static WATCHERS: AtomicU32 = AtomicU32::new(0);

pub fn watch(on: bool) {
    if on {
        WATCHERS.fetch_add(1, Ordering::Relaxed);
    } else {
        if WATCHERS.load(Ordering::Relaxed) > 0 {
            WATCHERS.fetch_sub(1, Ordering::Relaxed);
        }
    }
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
    use std::time::Duration;
    use windows::core::{w, PCWSTR};
    use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    use windows::Win32::System::Performance::*;
    use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};

    struct Pdh {
        query: PDH_HQUERY,
        cpu: PDH_HCOUNTER,
        gpu: Option<PDH_HCOUNTER>,
        down: PDH_HCOUNTER,
        up: PDH_HCOUNTER,
    }

    unsafe fn counter(q: PDH_HQUERY, path: PCWSTR) -> Option<PDH_HCOUNTER> {
        let mut c = PDH_HCOUNTER::default();
        (PdhAddEnglishCounterW(q, path, 0, &mut c) == 0).then_some(c)
    }

    unsafe fn open() -> Option<Pdh> {
        let mut query = PDH_HQUERY::default();
        if PdhOpenQueryW(PCWSTR::null(), 0, &mut query) != 0 {
            return None;
        }
        // "% Processor Utility" matches Task Manager on modern Windows; fall back to the classic one.
        let cpu = counter(query, w!("\\Processor Information(_Total)\\% Processor Utility"))
            .or_else(|| counter(query, w!("\\Processor(_Total)\\% Processor Time")))?;
        let gpu = counter(query, w!("\\GPU Engine(*engtype_3D)\\Utilization Percentage"));
        let down = counter(query, w!("\\Network Interface(*)\\Bytes Received/sec"))?;
        let up = counter(query, w!("\\Network Interface(*)\\Bytes Sent/sec"))?;
        PdhCollectQueryData(query);
        Some(Pdh { query, cpu, gpu, down, up })
    }

    unsafe fn single(c: PDH_HCOUNTER) -> Option<f64> {
        let mut v = PDH_FMT_COUNTERVALUE::default();
        if PdhGetFormattedCounterValue(c, PDH_FMT_DOUBLE, None, &mut v) != 0 {
            return None;
        }
        Some(v.Anonymous.doubleValue)
    }

    /// Sum over all instances of a wildcard counter.
    unsafe fn sum(c: PDH_HCOUNTER) -> Option<f64> {
        let mut size = 0u32;
        let mut count = 0u32;
        let r = PdhGetFormattedCounterArrayW(c, PDH_FMT(PDH_FMT_DOUBLE.0 | 0x8000), &mut size, &mut count, None);
        if r != PDH_MORE_DATA || size == 0 {
            return if r == 0 { Some(0.0) } else { None };
        }
        // Buffer of `size` bytes, aligned for the item struct.
        let n = (size as usize).div_ceil(std::mem::size_of::<PDH_FMT_COUNTERVALUE_ITEM_W>());
        let mut buf: Vec<PDH_FMT_COUNTERVALUE_ITEM_W> = Vec::with_capacity(n);
        let r = PdhGetFormattedCounterArrayW(c, PDH_FMT(PDH_FMT_DOUBLE.0 | 0x8000), &mut size, &mut count, Some(buf.as_mut_ptr()));
        if r != 0 {
            return None;
        }
        buf.set_len(count as usize);
        Some(buf.iter().filter(|i| i.FmtValue.CStatus == 0).map(|i| i.FmtValue.Anonymous.doubleValue).sum())
    }

    fn memory() -> (u64, u64) {
        let mut m = MEMORYSTATUSEX { dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32, ..Default::default() };
        unsafe {
            if GlobalMemoryStatusEx(&mut m).is_ok() {
                return (m.ullTotalPhys - m.ullAvailPhys, m.ullTotalPhys);
            }
        }
        (0, 0)
    }

    fn disk() -> (u64, u64, String) {
        let drive = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".into());
        let path: Vec<u16> = format!("{drive}\\").encode_utf16().chain(Some(0)).collect();
        let (mut free, mut total) = (0u64, 0u64);
        unsafe {
            let _ = GetDiskFreeSpaceExW(PCWSTR(path.as_ptr()), None, Some(&mut total), Some(&mut free));
        }
        (total.saturating_sub(free), total, drive)
    }

    pub fn run(app: AppHandle) {
        let mut pdh: Option<Pdh> = None;
        loop {
            if WATCHERS.load(Ordering::Relaxed) == 0 {
                std::thread::sleep(Duration::from_millis(400));
                continue;
            }
            if pdh.is_none() {
                pdh = unsafe { open() };
                std::thread::sleep(Duration::from_millis(400)); // rates need two samples
            }
            let Some(p) = &pdh else {
                std::thread::sleep(Duration::from_secs(2));
                continue;
            };
            unsafe {
                PdhCollectQueryData(p.query);
                let (ram_used, ram_total) = memory();
                let (disk_used, disk_total, disk_name) = disk();
                let stats = Stats {
                    cpu: single(p.cpu).unwrap_or(0.0).clamp(0.0, 100.0),
                    gpu: p.gpu.and_then(|g| sum(g)).map(|v| v.clamp(0.0, 100.0)),
                    ram_used,
                    ram_total,
                    disk_used,
                    disk_total,
                    disk_name,
                    down: sum(p.down).unwrap_or(0.0).max(0.0),
                    up: sum(p.up).unwrap_or(0.0).max(0.0),
                };
                let _ = app.emit("stats://update", stats);
            }
            std::thread::sleep(Duration::from_millis(500));
        }
    }
}
