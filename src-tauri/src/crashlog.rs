//! Crash notes. Anything that takes the app down leaves a record of why:
//! - a Rust panic: its message and a full backtrace;
//! - a Windows-level crash (an access violation, a stack overflow, an error inside a
//!   Windows callback — exit code 0xc000041d — which prints nothing to the console): the
//!   error code, the DLL and offset where it happened, a backtrace when the stack allows it,
//!   and a crash dump (.dmp, up to three per run) that a debugger opens at the exact line.
//! Written to crash.log (and the dumps) next to settings.json; development builds also copy
//! the text into island-debug.log in the project folder.
use std::io::Write;
use std::path::PathBuf;
use std::sync::OnceLock;

static DIR: OnceLock<PathBuf> = OnceLock::new();

fn dir() -> Option<&'static PathBuf> {
    DIR.get()
}

/// Appends to crash.log (and, in development builds, the project's island-debug.log).
pub fn note(msg: &str) {
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let text = format!("{stamp} {msg}\n");
    eprint!("{text}");
    if let Some(d) = dir() {
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(d.join("crash.log")) {
            let _ = f.write_all(text.as_bytes());
        }
    }
    #[cfg(debug_assertions)]
    {
        let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("island-debug.log");
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(p) {
            let _ = f.write_all(text.as_bytes());
        }
    }
}

pub fn init() {
    if let Some(d) = std::env::var_os("APPDATA").map(|d| PathBuf::from(d).join("dev.island.desktop")) {
        let _ = std::fs::create_dir_all(&d);
        let _ = DIR.set(d);
    }
    std::panic::set_hook(Box::new(|info| {
        let thread = std::thread::current().name().unwrap_or("unnamed").to_string();
        note(&format!("CRASH (panic) on thread '{thread}': {info}\n{}", std::backtrace::Backtrace::force_capture()));
    }));
    #[cfg(windows)]
    imp::install();
}

#[cfg(windows)]
mod imp {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{HANDLE, HMODULE};
    use windows::Win32::System::Diagnostics::Debug::{
        AddVectoredExceptionHandler, MiniDumpWithIndirectlyReferencedMemory, MiniDumpWriteDump, SetUnhandledExceptionFilter, EXCEPTION_POINTERS, MINIDUMP_EXCEPTION_INFORMATION,
    };
    use windows::Win32::System::LibraryLoader::{GetModuleFileNameW, GetModuleHandleExW, GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS, GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT};
    use windows::Win32::System::Threading::{GetCurrentProcess, GetCurrentProcessId, GetCurrentThreadId};

    static DUMPS: AtomicU32 = AtomicU32::new(0);
    static NOTED: AtomicU32 = AtomicU32::new(0);

    pub fn install() {
        unsafe {
            // First look at every exception (Windows swallows some inside its callbacks and
            // only reports 0xc000041d afterwards), plus the last-chance filter.
            AddVectoredExceptionHandler(1, Some(first_look));
            SetUnhandledExceptionFilter(Some(last_chance));
        }
    }

    fn name(code: u32) -> &'static str {
        match code {
            0xC0000005 => "access violation",
            0xC00000FD => "stack overflow",
            0xC000001D => "illegal instruction",
            0xC0000094 => "integer divide by zero",
            0xC0000409 => "fail-fast / stack buffer overrun",
            0xC0000374 => "heap corruption",
            0xC000041D => "exception inside a Windows callback",
            _ => "",
        }
    }

    /// "dynamic-island.exe+0x1a2b3c" for an address.
    fn where_(addr: usize) -> String {
        unsafe {
            let mut m = HMODULE::default();
            let flags = GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT;
            if GetModuleHandleExW(flags, PCWSTR(addr as *const u16), &mut m).is_err() {
                return format!("{addr:#x} (no module)");
            }
            let mut buf = [0u16; 260];
            let n = GetModuleFileNameW(Some(m), &mut buf) as usize;
            let path = String::from_utf16_lossy(&buf[..n]);
            let file = path.rsplit('\\').next().unwrap_or(&path).to_string();
            format!("{file}+{:#x}", addr.wrapping_sub(m.0 as usize))
        }
    }

    fn report(info: *mut EXCEPTION_POINTERS, stage: &str) {
        let Some(rec) = (unsafe { info.as_ref().and_then(|i| i.ExceptionRecord.as_ref()) }) else { return };
        let code = rec.ExceptionCode.0 as u32;
        let what = name(code);
        if what.is_empty() {
            return; // ordinary exceptions that code handles on purpose
        }
        // A handled access violation can repeat (some libraries probe memory): note a few.
        if NOTED.fetch_add(1, Ordering::Relaxed) >= 8 {
            return;
        }
        let addr = rec.ExceptionAddress as usize;
        let detail = if code == 0xC0000005 && rec.NumberParameters >= 2 {
            let op = match rec.ExceptionInformation[0] { 0 => "reading", 1 => "writing", 8 => "executing", _ => "touching" };
            format!(" ({op} {:#x})", rec.ExceptionInformation[1])
        } else {
            String::new()
        };
        let thread = std::thread::current().name().map(str::to_string).unwrap_or_else(|| format!("id {}", unsafe { GetCurrentThreadId() }));
        // No backtrace on a stack overflow: there's no stack left to build it with.
        let bt = if code == 0xC00000FD { String::from("(no backtrace: stack overflow)") } else { std::backtrace::Backtrace::force_capture().to_string() };
        note(&format!("CRASH? ({stage}) {code:#010x} {what}{detail} at {} on thread '{thread}'\n{bt}", where_(addr)));
        dump(info);
    }

    /// Up to three crash dumps per run (an exception that turns out to be handled shouldn't
    /// use up the only one), written from a fresh thread (the crashing one may have no stack
    /// left).
    fn dump(info: *mut EXCEPTION_POINTERS) {
        if DUMPS.fetch_add(1, Ordering::Relaxed) >= 3 {
            return;
        }
        let Some(d) = dir() else { return };
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let path = d.join(format!("crash-{stamp}.dmp"));
        let tid = unsafe { GetCurrentThreadId() };
        let ptrs = info as usize;
        let p2 = path.clone();
        let ok = std::thread::spawn(move || -> bool {
            use std::os::windows::io::AsRawHandle;
            let Ok(file) = std::fs::File::create(&p2) else { return false };
            let ex = MINIDUMP_EXCEPTION_INFORMATION { ThreadId: tid, ExceptionPointers: ptrs as *mut EXCEPTION_POINTERS, ClientPointers: false.into() };
            unsafe {
                MiniDumpWriteDump(GetCurrentProcess(), GetCurrentProcessId(), HANDLE(file.as_raw_handle()), MiniDumpWithIndirectlyReferencedMemory, Some(&ex as *const _), None, None).is_ok()
            }
        })
        .join()
        .unwrap_or(false);
        note(&format!("crash dump: {} ({})", path.display(), if ok { "written" } else { "failed" }));
    }

    unsafe extern "system" fn first_look(info: *mut EXCEPTION_POINTERS) -> i32 {
        let _ = std::panic::catch_unwind(|| report(info, "first look"));
        0 // EXCEPTION_CONTINUE_SEARCH: whoever handles it still does
    }

    unsafe extern "system" fn last_chance(info: *const EXCEPTION_POINTERS) -> i32 {
        let _ = std::panic::catch_unwind(|| report(info as *mut _, "unhandled"));
        0 // EXCEPTION_CONTINUE_SEARCH
    }
}
