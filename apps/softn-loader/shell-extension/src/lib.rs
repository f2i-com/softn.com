//! SoftN Shell Extension
//!
//! Windows Shell Extension that displays embedded icons from .softn files.
//! Implements IThumbnailProvider to extract icons from the ZIP bundle.
//! Reads manifest.json to find the icon path, supports PNG and SVG formats.

mod archive;
#[cfg(test)]
mod test_zip;
#[cfg(test)]
mod thumbnail_tests;

use std::cell::RefCell;
use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

use serde::Deserialize;

use image::GenericImageView;
use windows::core::*;
use windows::Win32::Foundation::*;
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::System::Com::*;
use windows::Win32::UI::Shell::*;
use windows::Win32::UI::Shell::PropertiesSystem::{IInitializeWithFile, IInitializeWithFile_Impl, IInitializeWithStream, IInitializeWithStream_Impl};

// Store the DLL module handle as a raw pointer (thread-safe via atomic)
static DLL_MODULE: AtomicUsize = AtomicUsize::new(0);

// GUID for our thumbnail provider
// {7A8E4D21-5B3F-4C2E-9D1A-8F6E7C3B2A90}
const CLSID_SOFTN_THUMBNAIL: GUID = GUID::from_u128(0x7A8E4D21_5B3F_4C2E_9D1A_8F6E7C3B2A90);

/// The most of a bundle read for its thumbnail: the runtime's own reader
/// takes no more (archive.rs refuses a larger one). Windows hands the stream
/// of whatever file is shown.
const MAX_BUNDLE_BYTES: u64 = 200 * 1024 * 1024;
/// The most a manifest or an icon may inflate to.
const MAX_ENTRY_BYTES: u64 = 8 * 1024 * 1024;
/// The widest and tallest raster icon decoded.
const MAX_ICON_SIDE: u32 = 4096;
/// The stack an SVG icon is parsed and drawn on.
const SVG_STACK_BYTES: usize = 64 * 1024 * 1024;

/// Minimal manifest structure — only the icon field is needed
#[derive(Deserialize)]
struct Manifest {
    icon: Option<String>,
}

/// Thumbnail provider for .softn files
#[implement(IThumbnailProvider, IInitializeWithFile, IInitializeWithStream)]
struct SoftNThumbnailProvider {
    file_path: RefCell<Option<PathBuf>>,
    stream_data: RefCell<Option<Vec<u8>>>,
}

impl SoftNThumbnailProvider {
    fn new() -> Self {
        Self {
            file_path: RefCell::new(None),
            stream_data: RefCell::new(None),
        }
    }

    /// A file of the bundle, as the runtime reads it (archive.rs), inflated
    /// no further than an icon or a manifest could need: a 1.56 MB entry
    /// inflated to 1.61 GB in the thumbnail process.
    fn extract_entry(&self, data: &[u8], entries: &HashMap<String, archive::Entry>, target: &str) -> Option<Vec<u8>> {
        archive::read(data, entries.get(target)?, MAX_ENTRY_BYTES)
    }

    /// Convert image bytes (PNG, JPEG, etc.) to HBITMAP
    fn raster_to_hbitmap(&self, img_data: &[u8], cx: u32) -> Option<HBITMAP> {
        // Held to an icon's size: a 500 KB, 16000×8000 PNG took 556 MB to
        // decode under the image crate's default limits.
        let mut reader = image::ImageReader::new(std::io::Cursor::new(img_data)).with_guessed_format().ok()?;
        let mut limits = image::Limits::default();
        limits.max_image_width = Some(MAX_ICON_SIDE);
        limits.max_image_height = Some(MAX_ICON_SIDE);
        limits.max_alloc = Some(MAX_ENTRY_BYTES * 8);
        reader.limits(limits);
        let img = reader.decode().ok()?;
        let img = img.resize_exact(cx, cx, image::imageops::FilterType::Lanczos3);
        let rgba = img.to_rgba8();
        let (width, height) = img.dimensions();
        self.rgba_to_hbitmap(&rgba, width, height)
    }

    /// Render SVG bytes to HBITMAP using resvg
    fn svg_to_hbitmap(&self, svg_data: &[u8], cx: u32) -> Option<HBITMAP> {
        // Parsed and drawn on a thread of its own with a large stack: an SVG
        // of some 700 nested groups (16 KB) overflowed the shell's 1 MB
        // thread stack and ended the process showing the folder.
        let svg = svg_data.to_vec();
        let pixels = std::thread::Builder::new()
            .stack_size(SVG_STACK_BYTES)
            .spawn(move || render_svg(&svg, cx))
            .ok()?
            .join()
            .ok()??;
        self.raw_bgra_to_hbitmap(&pixels, cx, cx)
    }
}

/// An SVG icon names images only inside itself (`data:` URLs). usvg's
/// default resolver reads any path an `<image>` names: the thumbnail of a
/// crafted `.softn` drew local files, and with `\\host\share\a.png` made
/// Windows connect to that share, the user's NTLM credentials with it, for no
/// more than showing the file in a folder.
fn svg_options() -> resvg::usvg::Options<'static> {
    let mut options = resvg::usvg::Options::default();
    options.image_href_resolver = resvg::usvg::ImageHrefResolver {
        resolve_data: resvg::usvg::ImageHrefResolver::default_data_resolver(),
        resolve_string: Box::new(|_, _| None),
    };
    options
}

/// The icon drawn into a cx×cx square of premultiplied BGRA, for Windows.
fn render_svg(svg_data: &[u8], cx: u32) -> Option<Vec<u8>> {
    {
        let tree = resvg::usvg::Tree::from_data(svg_data, &svg_options()).ok()?;
        let size = tree.size();
        // Compute scale to fit the requested thumbnail size
        let scale = cx as f32 / size.width().max(size.height());
        let scaled_w = (size.width() * scale).ceil() as u32;
        let scaled_h = (size.height() * scale).ceil() as u32;

        let mut pixmap = resvg::tiny_skia::Pixmap::new(scaled_w, scaled_h)?;
        resvg::render(
            &tree,
            resvg::tiny_skia::Transform::from_scale(scale, scale),
            &mut pixmap.as_mut(),
        );

        // Center the rendered image in a cx×cx square
        let mut final_pixmap = resvg::tiny_skia::Pixmap::new(cx, cx)?;
        let offset_x = ((cx - scaled_w) / 2) as i32;
        let offset_y = ((cx - scaled_h) / 2) as i32;
        final_pixmap.draw_pixmap(
            offset_x,
            offset_y,
            pixmap.as_ref(),
            &resvg::tiny_skia::PixmapPaint::default(),
            resvg::tiny_skia::Transform::identity(),
            None,
        );

        let pixels = final_pixmap.data();
        // resvg outputs premultiplied RGBA; we need premultiplied BGRA for Windows
        let mut bgra = vec![0u8; (cx * cx * 4) as usize];
        for i in 0..(cx * cx) as usize {
            let off = i * 4;
            bgra[off] = pixels[off + 2];     // B
            bgra[off + 1] = pixels[off + 1]; // G
            bgra[off + 2] = pixels[off];     // R
            bgra[off + 3] = pixels[off + 3]; // A
        }

        Some(bgra)
    }
}

impl SoftNThumbnailProvider {

    /// Convert RGBA image buffer to HBITMAP
    fn rgba_to_hbitmap(&self, rgba: &image::RgbaImage, width: u32, height: u32) -> Option<HBITMAP> {
        // Convert to premultiplied BGRA
        let mut bgra = vec![0u8; (width * height * 4) as usize];
        for (i, pixel) in rgba.pixels().enumerate() {
            let off = i * 4;
            let a = pixel[3] as u32;
            bgra[off] = ((pixel[2] as u32 * a) / 255) as u8;     // B
            bgra[off + 1] = ((pixel[1] as u32 * a) / 255) as u8; // G
            bgra[off + 2] = ((pixel[0] as u32 * a) / 255) as u8; // R
            bgra[off + 3] = pixel[3];                             // A
        }
        self.raw_bgra_to_hbitmap(&bgra, width, height)
    }

    /// Create an HBITMAP from raw premultiplied BGRA pixel data
    fn raw_bgra_to_hbitmap(&self, bgra: &[u8], width: u32, height: u32) -> Option<HBITMAP> {
        unsafe {
            let bmi = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: width as i32,
                    biHeight: -(height as i32), // Top-down
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    biSizeImage: 0,
                    biXPelsPerMeter: 0,
                    biYPelsPerMeter: 0,
                    biClrUsed: 0,
                    biClrImportant: 0,
                },
                bmiColors: [RGBQUAD::default()],
            };

            let mut bits: *mut std::ffi::c_void = std::ptr::null_mut();
            let hdc = GetDC(HWND::default());
            let hbitmap = CreateDIBSection(hdc, &bmi, DIB_RGB_COLORS, &mut bits, None, 0).ok()?;
            ReleaseDC(HWND::default(), hdc);

            if bits.is_null() {
                let _ = DeleteObject(hbitmap);
                return None;
            }

            let dst = std::slice::from_raw_parts_mut(bits as *mut u8, (width * height * 4) as usize);
            dst.copy_from_slice(bgra);

            Some(hbitmap)
        }
    }

    /// Detect format by extension or magic bytes and convert to HBITMAP
    fn icon_to_hbitmap(&self, icon_data: &[u8], icon_name: &str, cx: u32) -> Option<HBITMAP> {
        let lower = icon_name.to_lowercase();
        if lower.ends_with(".svg") {
            self.svg_to_hbitmap(icon_data, cx)
        } else {
            self.raster_to_hbitmap(icon_data, cx)
        }
    }

    /// Extract icon and return both data and the file name (for format detection)
    fn extract_icon_with_name(&self) -> Option<(Vec<u8>, String)> {
        // First try stream data (preferred by Windows)
        if let Some(data) = self.stream_data.borrow().as_ref() {
            return self.find_icon_with_name_in_zip(data);
        }

        // Fall back to file path
        let path = self.file_path.borrow();
        let path = path.as_ref()?;

        let file = File::open(path).ok()?;
        let mut data = Vec::new();
        file.take(MAX_BUNDLE_BYTES + 1).read_to_end(&mut data).ok()?;
        if data.len() as u64 > MAX_BUNDLE_BYTES {
            return None;
        }

        self.find_icon_with_name_in_zip(&data)
    }

    /// Find icon in ZIP, returning both data and the file name
    fn find_icon_with_name_in_zip(&self, data: &[u8]) -> Option<(Vec<u8>, String)> {
        if data.len() < 22 {
            return None;
        }

        // An archive the runtime would refuse has no thumbnail.
        let entries = archive::entries(data)?;

        // 1. Try manifest.json. The icon is the entry of the name the manifest
        // writes, as the runtime finds it (a backslash is not a folder there).
        if let Some(manifest_data) = self.extract_entry(data, &entries, "manifest.json") {
            if let Ok(text) = std::str::from_utf8(&manifest_data) {
                if let Ok(manifest) = serde_json::from_str::<Manifest>(text.strip_prefix('\u{feff}').unwrap_or(text)) {
                    if let Some(icon_path) = &manifest.icon {
                        if let Some(icon_data) = self.extract_entry(data, &entries, icon_path) {
                            return Some((icon_data, icon_path.clone()));
                        }
                    }
                }
            }
        }

        // 2. Fall back to common names
        let fallback_names = [
            "icon.png",
            "assets/icon.png",
            "icon.svg",
            "assets/icon.svg",
            "icon.jpg",
            "assets/icon.jpg",
        ];

        for name in &fallback_names {
            if let Some(icon_data) = self.extract_entry(data, &entries, name) {
                return Some((icon_data, name.to_string()));
            }
        }

        None
    }
}

impl IInitializeWithFile_Impl for SoftNThumbnailProvider_Impl {
    fn Initialize(&self, pszfilepath: &PCWSTR, _grfmode: u32) -> Result<()> {
        let path = unsafe { pszfilepath.to_string()? };
        *self.file_path.borrow_mut() = Some(PathBuf::from(path));
        Ok(())
    }
}

impl IInitializeWithStream_Impl for SoftNThumbnailProvider_Impl {
    fn Initialize(&self, pstream: Option<&IStream>, _grfmode: u32) -> Result<()> {
        let stream = pstream.ok_or(E_INVALIDARG)?;

        // Read all data from the stream
        let mut data = Vec::new();
        let mut buffer = [0u8; 8192];
        loop {
            let mut bytes_read = 0u32;
            unsafe {
                let hr = stream.Read(
                    buffer.as_mut_ptr() as *mut _,
                    buffer.len() as u32,
                    Some(&mut bytes_read),
                );
                if hr.is_err() && bytes_read == 0 {
                    break;
                }
            }
            if bytes_read == 0 {
                break;
            }
            data.extend_from_slice(&buffer[..bytes_read as usize]);
            // Past what a bundle may be there is no thumbnail to draw.
            if data.len() as u64 > MAX_BUNDLE_BYTES {
                return Err(E_FAIL.into());
            }
        }

        *self.stream_data.borrow_mut() = Some(data);
        Ok(())
    }
}

impl IThumbnailProvider_Impl for SoftNThumbnailProvider_Impl {
    fn GetThumbnail(&self, cx: u32, phbmp: *mut HBITMAP, pdwalpha: *mut WTS_ALPHATYPE) -> Result<()> {
        // Extract icon with name for format detection
        let (icon_data, icon_name) = self.extract_icon_with_name().ok_or(E_FAIL)?;

        // Convert to HBITMAP based on format
        let hbitmap = self.icon_to_hbitmap(&icon_data, &icon_name, cx).ok_or(E_FAIL)?;

        unsafe {
            *phbmp = hbitmap;
            *pdwalpha = WTSAT_ARGB;
        }

        Ok(())
    }
}

/// Class factory for creating thumbnail provider instances
#[implement(IClassFactory)]
struct SoftNClassFactory;

impl IClassFactory_Impl for SoftNClassFactory_Impl {
    fn CreateInstance(&self, punkouter: Option<&IUnknown>, riid: *const GUID, ppvobject: *mut *mut std::ffi::c_void) -> Result<()> {
        if punkouter.is_some() {
            return Err(CLASS_E_NOAGGREGATION.into());
        }

        let provider: IThumbnailProvider = SoftNThumbnailProvider::new().into();
        unsafe { provider.query(riid, ppvobject).ok() }
    }

    fn LockServer(&self, _flock: BOOL) -> Result<()> {
        Ok(())
    }
}

/// DLL entry point
#[no_mangle]
extern "system" fn DllMain(hinst: *mut std::ffi::c_void, reason: u32, _reserved: *mut std::ffi::c_void) -> BOOL {
    if reason == 1 {
        // DLL_PROCESS_ATTACH - store our module handle
        DLL_MODULE.store(hinst as usize, Ordering::SeqCst);
    }
    TRUE
}

/// Get class object for COM
#[no_mangle]
extern "system" fn DllGetClassObject(rclsid: *const GUID, riid: *const GUID, ppv: *mut *mut std::ffi::c_void) -> HRESULT {
    unsafe {
        if rclsid.is_null() || riid.is_null() || ppv.is_null() {
            return E_INVALIDARG;
        }

        *ppv = std::ptr::null_mut();

        if *rclsid != CLSID_SOFTN_THUMBNAIL {
            return CLASS_E_CLASSNOTAVAILABLE;
        }

        let factory: IClassFactory = SoftNClassFactory.into();
        factory.query(riid, ppv)
    }
}

/// Check if DLL can be unloaded
#[no_mangle]
extern "system" fn DllCanUnloadNow() -> HRESULT {
    S_FALSE
}

/// Register the shell extension
#[no_mangle]
extern "system" fn DllRegisterServer() -> HRESULT {
    match register_server() {
        Ok(()) => S_OK,
        Err(_) => E_FAIL,
    }
}

/// Unregister the shell extension
#[no_mangle]
extern "system" fn DllUnregisterServer() -> HRESULT {
    match unregister_server() {
        Ok(()) => S_OK,
        Err(_) => E_FAIL,
    }
}

fn register_server() -> std::io::Result<()> {
    use std::io::{Error, ErrorKind};
    use windows::Win32::System::Registry::*;

    let clsid_str = format!("{{{:08X}-{:04X}-{:04X}-{:02X}{:02X}-{:02X}{:02X}{:02X}{:02X}{:02X}{:02X}}}",
        CLSID_SOFTN_THUMBNAIL.data1,
        CLSID_SOFTN_THUMBNAIL.data2,
        CLSID_SOFTN_THUMBNAIL.data3,
        CLSID_SOFTN_THUMBNAIL.data4[0], CLSID_SOFTN_THUMBNAIL.data4[1],
        CLSID_SOFTN_THUMBNAIL.data4[2], CLSID_SOFTN_THUMBNAIL.data4[3],
        CLSID_SOFTN_THUMBNAIL.data4[4], CLSID_SOFTN_THUMBNAIL.data4[5],
        CLSID_SOFTN_THUMBNAIL.data4[6], CLSID_SOFTN_THUMBNAIL.data4[7]);

    unsafe {
        // Get DLL path using our stored module handle
        let module_ptr = DLL_MODULE.load(Ordering::SeqCst);
        let module = HMODULE(module_ptr as *mut std::ffi::c_void);
        let mut path = [0u16; 260];
        let len = windows::Win32::System::LibraryLoader::GetModuleFileNameW(module, &mut path);
        if len == 0 {
            return Err(Error::last_os_error());
        }
        let dll_path = String::from_utf16_lossy(&path[..len as usize]);

        // Use HKEY_CURRENT_USER for per-user registration (no admin needed)
        let mut hkey = HKEY::default();

        // Register CLSID under HKCU\Software\Classes
        let clsid_key = format!("Software\\Classes\\CLSID\\{}", clsid_str);
        let result = RegCreateKeyW(HKEY_CURRENT_USER, &HSTRING::from(&clsid_key), &mut hkey);
        if result != ERROR_SUCCESS {
            return Err(Error::new(ErrorKind::Other, format!("RegCreateKeyW failed: {:?}", result)));
        }

        let value = HSTRING::from("SoftN Thumbnail Provider");
        RegSetValueExW(hkey, None, 0, REG_SZ, Some(value.as_wide().align_to::<u8>().1)).ok()
            .map_err(|e| Error::new(ErrorKind::Other, e.to_string()))?;
        let _ = RegCloseKey(hkey);

        // Register InprocServer32
        let inproc_key = format!("Software\\Classes\\CLSID\\{}\\InprocServer32", clsid_str);
        let result = RegCreateKeyW(HKEY_CURRENT_USER, &HSTRING::from(&inproc_key), &mut hkey);
        if result != ERROR_SUCCESS {
            return Err(Error::new(ErrorKind::Other, format!("RegCreateKeyW failed: {:?}", result)));
        }

        let dll_path_h = HSTRING::from(&dll_path);
        RegSetValueExW(hkey, None, 0, REG_SZ, Some(dll_path_h.as_wide().align_to::<u8>().1)).ok()
            .map_err(|e| Error::new(ErrorKind::Other, e.to_string()))?;

        let threading = HSTRING::from("Apartment");
        RegSetValueExW(hkey, &HSTRING::from("ThreadingModel"), 0, REG_SZ, Some(threading.as_wide().align_to::<u8>().1)).ok()
            .map_err(|e| Error::new(ErrorKind::Other, e.to_string()))?;
        let _ = RegCloseKey(hkey);

        // Register for .softn extension under HKCU\Software\Classes
        let ext_key = "Software\\Classes\\.softn\\ShellEx\\{e357fccd-a995-4576-b01f-234630154e96}";
        let result = RegCreateKeyW(HKEY_CURRENT_USER, &HSTRING::from(ext_key), &mut hkey);
        if result != ERROR_SUCCESS {
            return Err(Error::new(ErrorKind::Other, format!("RegCreateKeyW failed: {:?}", result)));
        }

        let clsid_h = HSTRING::from(&clsid_str);
        RegSetValueExW(hkey, None, 0, REG_SZ, Some(clsid_h.as_wide().align_to::<u8>().1)).ok()
            .map_err(|e| Error::new(ErrorKind::Other, e.to_string()))?;
        let _ = RegCloseKey(hkey);
    }

    Ok(())
}

fn unregister_server() -> std::io::Result<()> {
    use windows::Win32::System::Registry::*;

    let clsid_str = format!("{{{:08X}-{:04X}-{:04X}-{:02X}{:02X}-{:02X}{:02X}{:02X}{:02X}{:02X}{:02X}}}",
        CLSID_SOFTN_THUMBNAIL.data1,
        CLSID_SOFTN_THUMBNAIL.data2,
        CLSID_SOFTN_THUMBNAIL.data3,
        CLSID_SOFTN_THUMBNAIL.data4[0], CLSID_SOFTN_THUMBNAIL.data4[1],
        CLSID_SOFTN_THUMBNAIL.data4[2], CLSID_SOFTN_THUMBNAIL.data4[3],
        CLSID_SOFTN_THUMBNAIL.data4[4], CLSID_SOFTN_THUMBNAIL.data4[5],
        CLSID_SOFTN_THUMBNAIL.data4[6], CLSID_SOFTN_THUMBNAIL.data4[7]);

    unsafe {
        // Delete extension registration from HKCU
        let ext_key = "Software\\Classes\\.softn\\ShellEx\\{e357fccd-a995-4576-b01f-234630154e96}";
        let _ = RegDeleteTreeW(HKEY_CURRENT_USER, &HSTRING::from(ext_key));

        // Delete CLSID from HKCU
        let clsid_key = format!("Software\\Classes\\CLSID\\{}", clsid_str);
        let _ = RegDeleteTreeW(HKEY_CURRENT_USER, &HSTRING::from(&clsid_key));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn red_png() -> Vec<u8> {
        let img = image::RgbaImage::from_pixel(8, 8, image::Rgba([255, 0, 0, 255]));
        let mut out = Vec::new();
        image::DynamicImage::ImageRgba8(img).write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png).unwrap();
        out
    }

    fn base64(bytes: &[u8]) -> String {
        const ABC: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::new();
        for chunk in bytes.chunks(3) {
            let n = (chunk[0] as u32) << 16 | (*chunk.get(1).unwrap_or(&0) as u32) << 8 | *chunk.get(2).unwrap_or(&0) as u32;
            for i in 0..4 {
                out.push(if i <= chunk.len() { ABC[(n >> (18 - 6 * i) & 63) as usize] as char } else { '=' });
            }
        }
        out
    }

    fn svg_with_image(href: &str) -> Vec<u8> {
        format!(r#"<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="8" height="8"><image width="8" height="8" xlink:href="{href}"/></svg>"#).into_bytes()
    }

    fn drawn(pixels: &[u8]) -> bool {
        pixels.chunks(4).any(|pixel| pixel[3] != 0)
    }

    /// An `<image>` naming a file or a share draws nothing, and reaches for
    /// neither: the thumbnail read local files, and a `\\host\share` path made
    /// Windows connect to that host with the user's credentials.
    #[test]
    fn an_svg_icon_draws_no_file_it_names() {
        let file = std::env::temp_dir().join(format!("softn-thumb-{}.png", std::process::id()));
        std::fs::write(&file, red_png()).unwrap();
        let local = render_svg(&svg_with_image(&file.to_string_lossy()), 32).unwrap();
        std::fs::remove_file(&file).ok();
        assert!(!drawn(&local), "a local file was drawn into the thumbnail");
        let started = std::time::Instant::now();
        let share = render_svg(&svg_with_image(r"\\192.0.2.1\share\a.png"), 32).unwrap();
        assert!(!drawn(&share));
        assert!(started.elapsed() < std::time::Duration::from_secs(2), "the share was reached for");
        // An image inside the icon itself is drawn.
        let inside = render_svg(&svg_with_image(&format!("data:image/png;base64,{}", base64(&red_png()))), 32).unwrap();
        assert!(drawn(&inside));
    }

    /// Thousands of nested groups are drawn on the icon's own stack; they
    /// overflowed the thread the shell called on, and ended its process.
    #[test]
    fn a_deeply_nested_svg_icon_does_not_end_the_process() {
        // Under the XML parser's own nesting limit, so it is the drawing that recurses.
        let depth = 1000;
        let svg = format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8">{}<rect width="8" height="8" fill="red"/>{}</svg>"#,
            "<g>".repeat(depth),
            "</g>".repeat(depth)
        );
        let provider = SoftNThumbnailProvider::new();
        let bitmap = provider.svg_to_hbitmap(svg.as_bytes(), 32).expect("the icon was drawn");
        unsafe {
            let _ = DeleteObject(bitmap);
        }
    }
}