//! Drag files and/or text OUT of the island into any app, with a real Windows
//! (OLE) drag-and-drop: Explorer copies the files, Discord/Slack/browsers upload
//! them, text fields receive the text.
use tauri::AppHandle;

/// Bytes of a CF_HDROP block: DROPFILES header + double-NUL-terminated UTF-16 paths.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn hdrop_bytes(files: &[String]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&20u32.to_le_bytes()); // pFiles: offset of the list
    out.extend_from_slice(&0i32.to_le_bytes()); // pt.x
    out.extend_from_slice(&0i32.to_le_bytes()); // pt.y
    out.extend_from_slice(&0i32.to_le_bytes()); // fNC
    out.extend_from_slice(&1i32.to_le_bytes()); // fWide: UTF-16
    for f in files {
        for u in f.encode_utf16() {
            out.extend_from_slice(&u.to_le_bytes());
        }
        out.extend_from_slice(&[0, 0]);
    }
    out.extend_from_slice(&[0, 0]);
    out
}

#[cfg(windows)]
pub mod imp {
    use super::*;
    use std::mem::ManuallyDrop;
    use windows::core::{implement, Ref, BOOL, HRESULT};
    use windows::Win32::Foundation::*;
    use windows::Win32::System::Com::*;
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    use windows::Win32::System::Ole::{DoDragDrop, IDropSource, IDropSource_Impl, CF_HDROP, CF_UNICODETEXT, DROPEFFECT, DROPEFFECT_COPY};
    use windows::Win32::System::SystemServices::{MK_LBUTTON, MODIFIERKEYS_FLAGS};
    use windows::Win32::UI::Shell::SHCreateStdEnumFmtEtc;

    /// A movable global memory block holding `bytes` (what clipboard/drag data lives in).
    pub fn global(bytes: &[u8]) -> windows::core::Result<HGLOBAL> {
        unsafe {
            let h = GlobalAlloc(GMEM_MOVEABLE, bytes.len().max(1))?;
            let p = GlobalLock(h) as *mut u8;
            if p.is_null() {
                return Err(windows::core::Error::from_win32());
            }
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), p, bytes.len());
            let _ = GlobalUnlock(h);
            Ok(h)
        }
    }

    fn fmt(cf: u16) -> FORMATETC {
        FORMATETC { cfFormat: cf, ptd: std::ptr::null_mut(), dwAspect: DVASPECT_CONTENT.0, lindex: -1, tymed: TYMED_HGLOBAL.0 as u32 }
    }

    #[implement(IDataObject)]
    struct DataObj {
        files: Vec<String>,
        text: Option<String>,
    }

    impl DataObj {
        fn formats(&self) -> Vec<FORMATETC> {
            let mut v = Vec::new();
            if !self.files.is_empty() {
                v.push(fmt(CF_HDROP.0));
            }
            if self.text.is_some() {
                v.push(fmt(CF_UNICODETEXT.0));
            }
            v
        }
        fn bytes_for(&self, cf: u16) -> Option<Vec<u8>> {
            if cf == CF_HDROP.0 && !self.files.is_empty() {
                return Some(hdrop_bytes(&self.files));
            }
            if cf == CF_UNICODETEXT.0 {
                let t = self.text.as_ref()?;
                let mut b: Vec<u8> = t.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
                b.extend_from_slice(&[0, 0]);
                return Some(b);
            }
            None
        }
    }

    impl IDataObject_Impl for DataObj_Impl {
        fn GetData(&self, pformatetcin: *const FORMATETC) -> windows::core::Result<STGMEDIUM> {
            let f = unsafe { &*pformatetcin };
            if f.tymed & TYMED_HGLOBAL.0 as u32 == 0 {
                return Err(DV_E_FORMATETC.into());
            }
            let bytes = self.bytes_for(f.cfFormat).ok_or(windows::core::Error::from(DV_E_FORMATETC))?;
            let h = global(&bytes)?;
            Ok(STGMEDIUM { tymed: TYMED_HGLOBAL.0 as u32, u: STGMEDIUM_0 { hGlobal: h }, pUnkForRelease: ManuallyDrop::new(None) })
        }
        fn GetDataHere(&self, _: *const FORMATETC, _: *mut STGMEDIUM) -> windows::core::Result<()> {
            Err(E_NOTIMPL.into())
        }
        fn QueryGetData(&self, pformatetc: *const FORMATETC) -> HRESULT {
            let f = unsafe { &*pformatetc };
            if f.tymed & TYMED_HGLOBAL.0 as u32 != 0 && self.bytes_for(f.cfFormat).is_some() {
                S_OK
            } else {
                DV_E_FORMATETC
            }
        }
        fn GetCanonicalFormatEtc(&self, _: *const FORMATETC, pformatetcout: *mut FORMATETC) -> HRESULT {
            unsafe {
                if !pformatetcout.is_null() {
                    (*pformatetcout).ptd = std::ptr::null_mut();
                }
            }
            E_NOTIMPL
        }
        fn SetData(&self, _: *const FORMATETC, _: *const STGMEDIUM, _: BOOL) -> windows::core::Result<()> {
            Err(E_NOTIMPL.into())
        }
        fn EnumFormatEtc(&self, dwdirection: u32) -> windows::core::Result<IEnumFORMATETC> {
            if dwdirection == DATADIR_GET.0 as u32 {
                unsafe { SHCreateStdEnumFmtEtc(&self.formats()) }
            } else {
                Err(E_NOTIMPL.into())
            }
        }
        fn DAdvise(&self, _: *const FORMATETC, _: u32, _: Ref<'_, IAdviseSink>) -> windows::core::Result<u32> {
            Err(OLE_E_ADVISENOTSUPPORTED.into())
        }
        fn DUnadvise(&self, _: u32) -> windows::core::Result<()> {
            Err(OLE_E_ADVISENOTSUPPORTED.into())
        }
        fn EnumDAdvise(&self) -> windows::core::Result<IEnumSTATDATA> {
            Err(OLE_E_ADVISENOTSUPPORTED.into())
        }
    }

    #[implement(IDropSource)]
    struct DropSrc;

    impl IDropSource_Impl for DropSrc_Impl {
        fn QueryContinueDrag(&self, fescapepressed: BOOL, grfkeystate: MODIFIERKEYS_FLAGS) -> HRESULT {
            if fescapepressed.as_bool() {
                DRAGDROP_S_CANCEL
            } else if grfkeystate.0 & MK_LBUTTON.0 == 0 {
                DRAGDROP_S_DROP
            } else {
                S_OK
            }
        }
        fn GiveFeedback(&self, _: DROPEFFECT) -> HRESULT {
            DRAGDROP_S_USEDEFAULTCURSORS
        }
    }

    /// Runs the modal drag loop; returns when the user drops or cancels.
    /// Must be called on the UI (STA, OLE-initialised) thread.
    pub fn run(files: Vec<String>, text: Option<String>) {
        let data: IDataObject = DataObj { files, text }.into();
        let src: IDropSource = DropSrc.into();
        let mut effect = DROPEFFECT(0);
        unsafe {
            let _ = DoDragDrop(&data, &src, DROPEFFECT_COPY, &mut effect);
        }
    }
}

#[tauri::command]
pub fn drag_out(app: AppHandle, files: Vec<String>, text: Option<String>) {
    let files: Vec<String> = files.into_iter().filter(|f| !f.is_empty()).collect();
    let text = text.filter(|t| !t.is_empty());
    if files.is_empty() && text.is_none() {
        return;
    }
    #[cfg(windows)]
    {
        let _ = app.run_on_main_thread(move || imp::run(files, text));
    }
    #[cfg(not(windows))]
    {
        let _ = (app, files, text);
    }
}
