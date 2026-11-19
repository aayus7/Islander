//! Islander's additions for Desktop Duplication recording:
//!
//! - **A desktop cache.** When only the mouse pointer moves, Desktop Duplication reports a
//!   frame with no new desktop image (`LastPresentTime == 0`); encoding that gave black
//!   flashes. We keep the last real desktop image and reuse it for pointer-only updates.
//! - **HDR to SDR ("force SDR", like OBS).** On an HDR desktop the image comes as 16-bit
//!   float scRGB. Squashing that into 8 bits as-is looks washed out and too bright, so a small
//!   GPU shader maps it back to SDR: scale by the display's own "SDR content brightness"
//!   (so SDR white lands exactly on white), clip, and apply the sRGB curve.

use windows::Win32::Graphics::Direct3D::Fxc::D3DCompile;
use windows::Win32::Graphics::Direct3D::{D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST, ID3DBlob};
use windows::Win32::Graphics::Direct3D11::{
    D3D11_BIND_CONSTANT_BUFFER, D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE, D3D11_BUFFER_DESC,
    D3D11_COMPARISON_NEVER, D3D11_FILTER_MIN_MAG_MIP_POINT, D3D11_SAMPLER_DESC, D3D11_TEXTURE_ADDRESS_CLAMP,
    D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT, D3D11_VIEWPORT, ID3D11Buffer, ID3D11Device, ID3D11DeviceContext,
    ID3D11PixelShader, ID3D11RenderTargetView, ID3D11SamplerState, ID3D11ShaderResourceView, ID3D11Texture2D,
    ID3D11VertexShader,
};
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_FORMAT, DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_R16G16B16A16_FLOAT, DXGI_SAMPLE_DESC,
};
use windows::core::{PCSTR, s};

use crate::dxgi_duplication_api::DxgiDuplicationFrame;

const SHADER: &str = r#"
cbuffer C : register(b0) { float scale; float3 pad; };
Texture2D<float4> t : register(t0);
SamplerState sm : register(s0);
struct V { float4 pos : SV_POSITION; float2 uv : TEXCOORD0; };
V vs(uint id : SV_VertexID) {
    V o;
    o.uv = float2((id << 1) & 2, id & 2);
    o.pos = float4(o.uv * float2(2, -2) + float2(-1, 1), 0, 1);
    return o;
}
float3 srgb(float3 l) {
    return l <= 0.0031308 ? l * 12.92 : 1.055 * pow(l, 1.0 / 2.4) - 0.055;
}
float4 ps(V i) : SV_TARGET {
    float3 lin = saturate(t.Sample(sm, i.uv).rgb * scale);
    return float4(srgb(lin), 1);
}
"#;

fn compile(entry: PCSTR, target: PCSTR) -> windows::core::Result<ID3DBlob> {
    let mut code = None;
    let mut errors = None;
    unsafe {
        D3DCompile(SHADER.as_ptr() as _, SHADER.len(), PCSTR::null(), None, None, entry, target, 0, 0, &mut code, Some(&mut errors))?;
    }
    code.ok_or_else(|| windows::core::Error::from_hresult(windows::Win32::Foundation::E_FAIL))
}

fn blob_bytes(b: &ID3DBlob) -> &[u8] {
    unsafe { std::slice::from_raw_parts(b.GetBufferPointer() as *const u8, b.GetBufferSize()) }
}

struct ToneMapper {
    vs: ID3D11VertexShader,
    ps: ID3D11PixelShader,
    sampler: ID3D11SamplerState,
    cb: ID3D11Buffer,
    /// A shader-readable copy of the FP16 desktop (duplication textures can't be sampled).
    src: Option<(ID3D11Texture2D, ID3D11ShaderResourceView, u32, u32)>,
}

impl ToneMapper {
    fn new(device: &ID3D11Device) -> windows::core::Result<Self> {
        let vsb = compile(s!("vs"), s!("vs_4_0"))?;
        let psb = compile(s!("ps"), s!("ps_4_0"))?;
        let mut vs = None;
        let mut ps = None;
        let mut sampler = None;
        let mut cb = None;
        unsafe {
            device.CreateVertexShader(blob_bytes(&vsb), None, Some(&mut vs))?;
            device.CreatePixelShader(blob_bytes(&psb), None, Some(&mut ps))?;
            let sd = D3D11_SAMPLER_DESC {
                Filter: D3D11_FILTER_MIN_MAG_MIP_POINT,
                AddressU: D3D11_TEXTURE_ADDRESS_CLAMP,
                AddressV: D3D11_TEXTURE_ADDRESS_CLAMP,
                AddressW: D3D11_TEXTURE_ADDRESS_CLAMP,
                ComparisonFunc: D3D11_COMPARISON_NEVER,
                MaxLOD: f32::MAX,
                ..Default::default()
            };
            device.CreateSamplerState(&sd, Some(&mut sampler))?;
            let bd = D3D11_BUFFER_DESC {
                ByteWidth: 16,
                Usage: D3D11_USAGE_DEFAULT,
                BindFlags: D3D11_BIND_CONSTANT_BUFFER.0 as u32,
                ..Default::default()
            };
            device.CreateBuffer(&bd, None, Some(&mut cb))?;
        }
        Ok(Self { vs: vs.unwrap(), ps: ps.unwrap(), sampler: sampler.unwrap(), cb: cb.unwrap(), src: None })
    }

    /// Renders the FP16 `frame` into the BGRA8 `target` as SDR.
    fn run(
        &mut self,
        device: &ID3D11Device,
        ctx: &ID3D11DeviceContext,
        frame: &ID3D11Texture2D,
        target: &ID3D11Texture2D,
        w: u32,
        h: u32,
        scale: f32,
    ) -> windows::core::Result<()> {
        if !matches!(&self.src, Some((_, _, sw, sh)) if *sw == w && *sh == h) {
            let desc = D3D11_TEXTURE2D_DESC {
                Width: w,
                Height: h,
                MipLevels: 1,
                ArraySize: 1,
                Format: DXGI_FORMAT_R16G16B16A16_FLOAT,
                SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                Usage: D3D11_USAGE_DEFAULT,
                BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
                CPUAccessFlags: 0,
                MiscFlags: 0,
            };
            let mut tex = None;
            let mut srv = None;
            unsafe {
                device.CreateTexture2D(&desc, None, Some(&mut tex))?;
                let tex = tex.as_ref().unwrap();
                device.CreateShaderResourceView(tex, None, Some(&mut srv))?;
            }
            self.src = Some((tex.unwrap(), srv.unwrap(), w, h));
        }
        let (tex, srv, _, _) = self.src.as_ref().unwrap();
        let mut rtv: Option<ID3D11RenderTargetView> = None;
        unsafe {
            ctx.CopyResource(tex, frame);
            device.CreateRenderTargetView(target, None, Some(&mut rtv))?;
            let data = [scale, 0.0, 0.0, 0.0];
            ctx.UpdateSubresource(&self.cb, 0, None, data.as_ptr() as _, 0, 0);
            ctx.IASetInputLayout(None);
            ctx.IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
            ctx.VSSetShader(&self.vs, None);
            ctx.PSSetShader(&self.ps, None);
            ctx.PSSetConstantBuffers(0, Some(&[Some(self.cb.clone())]));
            ctx.PSSetShaderResources(0, Some(&[Some(srv.clone())]));
            ctx.PSSetSamplers(0, Some(&[Some(self.sampler.clone())]));
            ctx.RSSetViewports(Some(&[D3D11_VIEWPORT { TopLeftX: 0.0, TopLeftY: 0.0, Width: w as f32, Height: h as f32, MinDepth: 0.0, MaxDepth: 1.0 }]));
            ctx.OMSetRenderTargets(Some(&[rtv.clone()]), None);
            ctx.Draw(3, 0);
            // Unbind so the next copy into the source texture is allowed.
            ctx.PSSetShaderResources(0, Some(&[None]));
            ctx.OMSetRenderTargets(None, None);
        }
        Ok(())
    }
}

/// The last real desktop image (8-bit SDR), kept up to date from Desktop Duplication frames.
pub struct DesktopFrames {
    cache: Option<(ID3D11Texture2D, u32, u32)>,
    tone: Option<ToneMapper>,
    /// 80 / (the display's SDR white level in nits): scRGB → SDR.
    hdr_scale: f32,
    pub hdr_seen: bool,
}

impl DesktopFrames {
    /// `sdr_white_nits`: the display's "SDR content brightness" (Windows HDR settings).
    pub fn new(sdr_white_nits: f32) -> Self {
        Self { cache: None, tone: None, hdr_scale: 80.0 / sdr_white_nits.max(80.0), hdr_seen: false }
    }

    /// Takes in a duplication frame. Returns false when there's still no desktop image.
    pub fn update(&mut self, frame: &DxgiDuplicationFrame<'_>) -> windows::core::Result<bool> {
        let info = frame.frame_info();
        let fresh = info.LastPresentTime != 0;
        if !fresh && self.cache.is_some() {
            return Ok(true); // only the pointer moved: the cached desktop is still right
        }
        if !fresh {
            return Ok(false); // no desktop image yet (the very first calls)
        }
        let (w, h) = (frame.width(), frame.height());
        let device = frame.device();
        let ctx = frame.device_context();
        if !matches!(&self.cache, Some((_, cw, ch)) if *cw == w && *ch == h) {
            let desc = D3D11_TEXTURE2D_DESC {
                Width: w,
                Height: h,
                MipLevels: 1,
                ArraySize: 1,
                Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                Usage: D3D11_USAGE_DEFAULT,
                BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
                CPUAccessFlags: 0,
                MiscFlags: 0,
            };
            let mut tex = None;
            unsafe { device.CreateTexture2D(&desc, None, Some(&mut tex))? };
            self.cache = Some((tex.unwrap(), w, h));
        }
        let (cache, _, _) = self.cache.as_ref().unwrap();
        let fmt: DXGI_FORMAT = frame.texture_desc().Format;
        if fmt == DXGI_FORMAT_R16G16B16A16_FLOAT {
            self.hdr_seen = true;
            if self.tone.is_none() {
                self.tone = Some(ToneMapper::new(device)?);
            }
            let scale = self.hdr_scale;
            self.tone.as_mut().unwrap().run(device, ctx, frame.texture(), cache, w, h, scale)?;
        } else {
            unsafe { ctx.CopyResource(cache, frame.texture()) };
        }
        Ok(true)
    }

    /// The cached desktop image (BGRA8, SDR).
    pub fn texture(&self) -> Option<&ID3D11Texture2D> {
        self.cache.as_ref().map(|c| &c.0)
    }
}

/// The display's "SDR content brightness" in nits for the monitor (80 when it isn't HDR or
/// can't be read).
pub fn sdr_white_nits(monitor: *mut std::ffi::c_void) -> f32 {
    use windows::Win32::Devices::Display::{
        DISPLAYCONFIG_DEVICE_INFO_GET_SDR_WHITE_LEVEL, DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME,
        DISPLAYCONFIG_MODE_INFO, DISPLAYCONFIG_PATH_INFO, DISPLAYCONFIG_SDR_WHITE_LEVEL, DISPLAYCONFIG_SOURCE_DEVICE_NAME,
        DisplayConfigGetDeviceInfo, GetDisplayConfigBufferSizes, QDC_ONLY_ACTIVE_PATHS, QueryDisplayConfig,
    };
    use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, HMONITOR, MONITORINFOEXW};
    unsafe {
        let mut mi = MONITORINFOEXW::default();
        mi.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
        if !GetMonitorInfoW(HMONITOR(monitor), &mut mi as *mut _ as *mut _).as_bool() {
            return 80.0;
        }
        let name = String::from_utf16_lossy(&mi.szDevice).trim_end_matches('\0').to_string();
        let (mut np, mut nm) = (0u32, 0u32);
        if GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &mut np, &mut nm).0 != 0 {
            return 80.0;
        }
        let mut paths = vec![DISPLAYCONFIG_PATH_INFO::default(); np as usize];
        let mut modes = vec![DISPLAYCONFIG_MODE_INFO::default(); nm as usize];
        if QueryDisplayConfig(QDC_ONLY_ACTIVE_PATHS, &mut np, paths.as_mut_ptr(), &mut nm, modes.as_mut_ptr(), None).0 != 0 {
            return 80.0;
        }
        for p in paths.iter().take(np as usize) {
            let mut src = DISPLAYCONFIG_SOURCE_DEVICE_NAME::default();
            src.header.r#type = DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME;
            src.header.size = std::mem::size_of::<DISPLAYCONFIG_SOURCE_DEVICE_NAME>() as u32;
            src.header.adapterId = p.sourceInfo.adapterId;
            src.header.id = p.sourceInfo.id;
            if DisplayConfigGetDeviceInfo(&mut src.header) != 0 {
                continue;
            }
            let src_name = String::from_utf16_lossy(&src.viewGdiDeviceName).trim_end_matches('\0').to_string();
            if !src_name.eq_ignore_ascii_case(&name) {
                continue;
            }
            let mut wl = DISPLAYCONFIG_SDR_WHITE_LEVEL::default();
            wl.header.r#type = DISPLAYCONFIG_DEVICE_INFO_GET_SDR_WHITE_LEVEL;
            wl.header.size = std::mem::size_of::<DISPLAYCONFIG_SDR_WHITE_LEVEL>() as u32;
            wl.header.adapterId = p.targetInfo.adapterId;
            wl.header.id = p.targetInfo.id;
            if DisplayConfigGetDeviceInfo(&mut wl.header) == 0 && wl.SDRWhiteLevel > 0 {
                // SDRWhiteLevel is in thousandths of 80 nits.
                return wl.SDRWhiteLevel as f32 / 1000.0 * 80.0;
            }
        }
        80.0
    }
}
