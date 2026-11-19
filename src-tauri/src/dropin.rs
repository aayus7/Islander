//! Our own native drop target for files dragged onto the island (from Explorer,
//! browsers, anything). Replaces the WebView's handler on every window of the
//! island, so a drop can never be swallowed by the WebView layer, and logs each
//! step. Emits "drop://enter" / "drop://leave" / "drop://drop" with the paths.
use tauri::{AppHandle, Emitter};

#[cfg(windows)]
mod imp {
    use super::*;
    use std::cell::Cell;
    use windows::core::{implement, Ref, BOOL};
    use windows::Win32::Foundation::{HWND, LPARAM, POINTL};
    use windows::Win32::System::Com::{IDataObject, DVASPECT_CONTENT, FORMATETC, TYMED_HGLOBAL};
    use windows::Win32::System::Ole::{IDropTarget, IDropTarget_Impl, RegisterDragDrop, ReleaseStgMedium, RevokeDragDrop, CF_HDROP, DROPEFFECT, DROPEFFECT_COPY, DROPEFFECT_NONE};
    use windows::Win32::System::SystemServices::MODIFIERKEYS_FLAGS;
    use windows::Win32::UI::Shell::{DragQueryFileW, IShellItemArray, SHCreateShellItemArrayFromDataObject, HDROP, SIGDN_FILESYSPATH};
    use windows::Win32::UI::WindowsAndMessaging::EnumChildWindows;

    fn log(msg: String) {
        crate::ui_log(msg);
    }

    /// File paths in a drag: CF_HDROP first, then the shell's own view (virtual
    /// folders, some apps only offer that).
    fn paths(data: &IDataObject) -> Vec<String> {
        let mut out = Vec::new();
        let fmt = FORMATETC { cfFormat: CF_HDROP.0, ptd: std::ptr::null_mut(), dwAspect: DVASPECT_CONTENT.0, lindex: -1, tymed: TYMED_HGLOBAL.0 as u32 };
        unsafe {
            match data.GetData(&fmt) {
                Ok(mut med) => {
                    let h = HDROP(med.u.hGlobal.0);
                    let n = DragQueryFileW(h, u32::MAX, None);
                    for i in 0..n {
                        let len = DragQueryFileW(h, i, None) as usize;
                        let mut buf = vec![0u16; len + 1];
                        DragQueryFileW(h, i, Some(&mut buf));
                        out.push(String::from_utf16_lossy(&buf[..len]));
                    }
                    ReleaseStgMedium(&mut med);
                }
                Err(e) => log(format!("drop: CF_HDROP unavailable ({e})")),
            }
            if out.is_empty() {
                match SHCreateShellItemArrayFromDataObject::<_, IShellItemArray>(data) {
                    Ok(arr) => {
                        for i in 0..arr.GetCount().unwrap_or(0) {
                            if let Ok(item) = arr.GetItemAt(i) {
                                if let Ok(p) = item.GetDisplayName(SIGDN_FILESYSPATH) {
                                    out.push(p.to_string().unwrap_or_default());
                                    windows::Win32::System::Com::CoTaskMemFree(Some(p.0 as *const _));
                                }
                            }
                        }
                    }
                    Err(e) => log(format!("drop: no shell items either ({e})")),
                }
            }
        }
        out.retain(|p| !p.is_empty());
        out
    }

    #[implement(IDropTarget)]
    struct Target {
        app: AppHandle,
        ok: Cell<bool>,
    }

    impl IDropTarget_Impl for Target_Impl {
        fn DragEnter(&self, data: Ref<'_, IDataObject>, _k: MODIFIERKEYS_FLAGS, _pt: &POINTL, effect: *mut DROPEFFECT) -> windows::core::Result<()> {
            let files = data.ok().map(paths).unwrap_or_default();
            log(format!("drop: enter with {} file(s)", files.len()));
            self.ok.set(!files.is_empty());
            unsafe { *effect = if files.is_empty() { DROPEFFECT_NONE } else { DROPEFFECT_COPY } };
            if !files.is_empty() {
                let _ = self.app.emit("drop://enter", &files);
            }
            Ok(())
        }
        fn DragOver(&self, _k: MODIFIERKEYS_FLAGS, _pt: &POINTL, effect: *mut DROPEFFECT) -> windows::core::Result<()> {
            unsafe { *effect = if self.ok.get() { DROPEFFECT_COPY } else { DROPEFFECT_NONE } };
            Ok(())
        }
        fn DragLeave(&self) -> windows::core::Result<()> {
            if self.ok.get() {
                let _ = self.app.emit("drop://leave", ());
            }
            self.ok.set(false);
            Ok(())
        }
        fn Drop(&self, data: Ref<'_, IDataObject>, _k: MODIFIERKEYS_FLAGS, _pt: &POINTL, effect: *mut DROPEFFECT) -> windows::core::Result<()> {
            // Browsers hand over temporary files and delete them as soon as the drag ends:
            // copy those now, before this call returns.
            let files = crate::shelf::rescue(&self.app, data.ok().map(paths).unwrap_or_default());
            log(format!("drop: dropped {} file(s)", files.len()));
            unsafe { *effect = if files.is_empty() { DROPEFFECT_NONE } else { DROPEFFECT_COPY } };
            self.ok.set(false);
            let _ = self.app.emit("drop://drop", &files);
            Ok(())
        }
    }

    /// (Re)attach our drop target to the island window and every child window the
    /// WebView created. Must run on the UI thread that owns those windows.
    pub fn install(app: &AppHandle, root: HWND) {
        let target: IDropTarget = Target { app: app.clone(), ok: Cell::new(false) }.into();
        let mut wins = vec![root];
        unsafe extern "system" fn each(hw: HWND, l: LPARAM) -> BOOL {
            (*(l.0 as *mut Vec<HWND>)).push(hw);
            BOOL(1)
        }
        unsafe {
            let _ = EnumChildWindows(Some(root), Some(each), LPARAM(&mut wins as *mut _ as isize));
        }
        let mut n = 0;
        for hw in wins {
            unsafe {
                let _ = RevokeDragDrop(hw);
                if RegisterDragDrop(hw, &target).is_ok() {
                    n += 1;
                }
            }
        }
        log(format!("drop: handler attached to {n} window(s)"));
        // Keep the COM object alive for the life of the app.
        std::mem::forget(target);
    }
}

/// Attach (on the main thread) a moment after start-up, once WebView2 has made its
/// child windows, and again whenever the page reloads.
pub fn attach(app: &AppHandle) {
    #[cfg(windows)]
    {
        use tauri::Manager;
        let Some(win) = app.get_webview_window("island") else { return };
        let Ok(h) = win.hwnd() else { return };
        let raw = h.0 as isize;
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || imp::install(&app2, windows::Win32::Foundation::HWND(raw as _)));
    }
    #[cfg(not(windows))]
    let _ = app;
}

#[tauri::command]
pub fn drop_attach(app: AppHandle) {
    attach(&app);
}
