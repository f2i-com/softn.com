//! WebGL 1 and 2 for `<canvas>`, on desktop OpenGL: through WGL on Windows,
//! and through EGL on Linux, where Mesa provides it -- on the GPU where it
//! has a driver for one, and on the CPU (llvmpipe) anywhere else.
//!
//! The page side is `webgl_shim.js`: a `WebGLRenderingContext` (or
//! `WebGL2RenderingContext`) that records its calls into a batch of
//! `[op, ...args]` and sends it here with the `gl` host call, bytes beside it
//! in `__zippHostBytes`. A GL thread replays batches: one OpenGL context per
//! canvas (made current on a hidden window with WGL, on no surface at all
//! with EGL), each drawing into an offscreen framebuffer that
//! stands in for the canvas's default one (`bindFramebuffer(null)` binds it;
//! multisampled when the context is antialiased, as WebGL's are by default).
//! A `present` at the end of a frame reads that framebuffer back; the frame
//! goes to `canvas::take_frames`, and the page's canvas element gets it as its
//! image (`apply_canvas_frames` in main.rs).
//!
//! The GL thread keeps OpenGL off the window's thread, which never has a GL
//! context of its own. Each batch is synchronous: the page waits for the
//! answer to its last command (a query, or nothing).
//!
//! Shaders are translated one by one, since a WebGL 2 context takes both
//! kinds: GLSL ES 3.00 (`#version 300 es`) compiles as GLSL 3.30, and GLSL ES
//! 1.00 as GLSL 1.20, which has no precision qualifiers, so there
//! `lowp`/`mediump`/`highp` become nothing. `precision` statements go in both.
//! The context is a compatibility one, which runs both.
//!
//! What OpenGL ES always does and desktop OpenGL leaves to a switch is
//! switched on: point sprites and shader-set point sizes, seamless cube maps,
//! sRGB encoding when drawing into sRGB textures, and (WebGL 2) primitive
//! restart at the largest index.
//!
//! Where desktop OpenGL is older than 3.3 (a Raspberry Pi 4's GPU has 3.1)
//! the contexts are OpenGL ES 3 ones instead, which is what WebGL is made
//! from: shaders go to them as the page wrote them, and none of the switches
//! above is needed. `ZIPP_WEBGL_API=es` (or `gl`) chooses either way.

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Arc;

use glow::HasContext;
use serde_json::Value as Json;
use zipp_vm::embed::HostCtx;

use egl::{Platform, RawContext};

use crate::bundle::{strip_virtual_origin, SoftnBundle};
use crate::canvas::Frame;
use crate::http_cache::BlobStore;

const MAX_WEBGL_CONTEXTS: usize = 16;
const MAX_GL_OBJECTS: usize = 16_384;
const MAX_WEBGL_DIM: i32 = 4096;
const MAX_DATA_URL_BYTES: usize = 32 * 1024 * 1024;

struct Batch {
    context: u32,
    cmds: String,
    payload: Vec<u8>,
    bundle: Option<Arc<SoftnBundle>>,
    blobs: Option<Arc<BlobStore>>,
    reply: Sender<Reply>,
}

thread_local! {
    static CURRENT_BUNDLE: RefCell<Option<Arc<SoftnBundle>>> = const { RefCell::new(None) };
    static CURRENT_BLOBS: RefCell<Option<Arc<BlobStore>>> = const { RefCell::new(None) };
}

#[derive(Default)]
struct Reply {
    /// The answer to the batch's last command, as JSON ("" for none).
    result: String,
    error: Option<String>,
    /// `readPixels`' bytes, for `__zippHostBytes`.
    bytes: Option<Vec<u8>>,
    frame: Option<Frame>,
}

thread_local! {
    static GL_THREAD: RefCell<Option<Sender<Batch>>> = const { RefCell::new(None) };
}

/// Tear down all active WebGL contexts on the current thread's GL worker (if started),
/// used when switching bundles or dropping the engine.
pub(crate) fn reset_all() {
    let sender = GL_THREAD.with(|t| t.borrow().clone());
    if let Some(sender) = sender {
        let (reply_tx, reply_rx) = mpsc::channel();
        if sender
            .send(Batch {
                context: 0,
                cmds: r#"[["reset"]]"#.to_string(),
                payload: Vec::new(),
                bundle: None,
                blobs: None,
                reply: reply_tx,
            })
            .is_ok()
        {
            let _ = reply_rx.recv_timeout(std::time::Duration::from_secs(5));
        }
    }
}

/// `__zippHostCall("gl", context, batch, payloadLength)`.
pub(crate) fn host_call(
    ctx: &mut dyn HostCtx,
    bundle: Arc<SoftnBundle>,
    blobs: Arc<BlobStore>,
    args: &[String],
) -> Result<String, String> {
    let context: u32 = args.first().and_then(|a| a.parse().ok()).ok_or("Error: gl: no context")?;
    let cmds = args.get(1).cloned().unwrap_or_default();
    let len: usize = args.get(2).and_then(|a| a.parse().ok()).unwrap_or(0);
    if len > MAX_READ_BYTES {
        return Err("Error: gl: payload exceeds 64 MiB limit".into());
    }
    let payload = if len > 0 {
        let (addr, count, kind) = ctx.typed_array_region("__zippHostBytes")?;
        if kind != 1 || count < len {
            return Err("Error: gl: __zippHostBytes is not the batch's bytes".into());
        }
        // SAFETY: the engine pinned `count` bytes at `addr` for this call.
        unsafe { std::slice::from_raw_parts(addr as *const u8, len) }.to_vec()
    } else {
        Vec::new()
    };
    let sender = GL_THREAD.with(|t| -> Result<Sender<Batch>, String> {
        let mut slot = t.borrow_mut();
        if let Some(existing) = slot.as_ref() {
            return Ok(existing.clone());
        }
        let (tx, rx) = mpsc::channel();
        std::thread::Builder::new()
            .name("zipp-webgl".into())
            .spawn(move || gl_thread(rx))
            .map_err(|e| format!("Error: failed to spawn WebGL thread: {e}"))?;
        *slot = Some(tx.clone());
        Ok(tx)
    })?;
    let (reply_tx, reply_rx) = mpsc::channel();
    sender
        .send(Batch {
            context,
            cmds,
            payload,
            bundle: Some(bundle),
            blobs: Some(blobs),
            reply: reply_tx,
        })
        .map_err(|_| "Error: WebGL is unavailable".to_string())?;
    // A draw the GL thread is still on after half a minute (a hung driver, or
    // a huge one on the CPU) gives the page an error rather than freezing it.
    let reply = reply_rx.recv_timeout(std::time::Duration::from_secs(30)).map_err(|e| match e {
        mpsc::RecvTimeoutError::Timeout => "Error: WebGL did not answer in 30 seconds".to_string(),
        mpsc::RecvTimeoutError::Disconnected => "Error: WebGL stopped".to_string(),
    })?;
    if let Some(error) = reply.error {
        log::warn!("WebGL: {error}");
    }
    if let Some(bytes) = reply.bytes {
        let (addr, count, kind) = ctx.typed_array_region("__zippHostBytes")?;
        if kind == 1 {
            // SAFETY: as above; never more than the array holds.
            unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), addr as *mut u8, bytes.len().min(count)) };
        }
    }
    if let Some(frame) = reply.frame {
        crate::canvas::push_frame(frame);
    }
    Ok(reply.result)
}

fn gl_thread(batches: Receiver<Batch>) {
    let mut host = match Platform::new() {
        Ok(platform) => Some(Host { platform, current: None, contexts: HashMap::new() }),
        Err(e) => {
            log::warn!("WebGL EGL init failed: {e}");
            None
        }
    };
    for batch in batches {
        CURRENT_BUNDLE.with(|b| *b.borrow_mut() = batch.bundle);
        CURRENT_BLOBS.with(|b| *b.borrow_mut() = batch.blobs);
        let reply = match host.as_mut() {
            Some(host) => host.run(batch.context, &batch.cmds, &batch.payload),
            None => Reply { error: Some("OpenGL is unavailable".into()), ..Default::default() },
        };
        CURRENT_BUNDLE.with(|b| *b.borrow_mut() = None);
        CURRENT_BLOBS.with(|b| *b.borrow_mut() = None);
        let _ = batch.reply.send(reply);
    }
}

/// The platform's way of making GL contexts, and the contexts.
struct Host {
    platform: Platform,
    current: Option<u32>,
    contexts: HashMap<u32, Context>,
}

impl Drop for Host {
    fn drop(&mut self) {
        let all: Vec<u32> = self.contexts.keys().copied().collect();
        for c in all {
            self.delete(c);
        }
    }
}

/// One canvas's GL context and the WebGL objects in it, by the page's numbers.
struct Context {
    raw: RawContext,
    gl: glow::Context,
    /// OpenGL ES rather than desktop OpenGL.
    es: bool,
    flid: u32,
    width: i32,
    height: i32,
    /// The canvas: multisampled (`samples` > 0) when antialiased, and then
    /// resolved into `resolve` to be read.
    fbo: glow::Framebuffer,
    color: glow::Renderbuffer,
    depth: glow::Renderbuffer,
    samples: i32,
    resolve: Option<(glow::Framebuffer, glow::Renderbuffer)>,
    /// `alpha: false`: the canvas is opaque whatever is drawn.
    opaque: bool,
    buffers: HashMap<u32, glow::Buffer>,
    textures: HashMap<u32, glow::Texture>,
    shaders: HashMap<u32, glow::Shader>,
    programs: HashMap<u32, glow::Program>,
    framebuffers: HashMap<u32, glow::Framebuffer>,
    renderbuffers: HashMap<u32, glow::Renderbuffer>,
    vaos: HashMap<u32, glow::VertexArray>,
    samplers: HashMap<u32, glow::Sampler>,
    queries: HashMap<u32, glow::Query>,
    feedbacks: HashMap<u32, glow::TransformFeedback>,
    uniforms: HashMap<u32, HashMap<String, Option<glow::UniformLocation>>>,
    flip_y: bool,
    premultiply: bool,
    /// State the page set that resizing and reading back the canvas have to
    /// put back as they found it.
    state: PageState,
}

struct PageState {
    draw_fb: Option<glow::Framebuffer>,
    read_fb: Option<glow::Framebuffer>,
    renderbuffer: Option<glow::Renderbuffer>,
    array_buffer: Option<glow::Buffer>,
    current_vao: u32,
    vao_element_buffers: HashMap<u32, Option<glow::Buffer>>,
    pack_buffer: Option<glow::Buffer>,
    unpack_buffer: Option<glow::Buffer>,
    /// `pixelStorei` values other than WebGL's own flags.
    pixel_store: HashMap<u32, i32>,
    scissor_test: bool,
    clear_color: [f32; 4],
    clear_depth: f64,
    clear_stencil: i32,
    color_mask: [bool; 4],
    depth_mask: bool,
    stencil_mask: [u32; 2],
}

impl PageState {
    fn new(canvas: glow::Framebuffer) -> Self {
        PageState {
            draw_fb: Some(canvas),
            read_fb: Some(canvas),
            renderbuffer: None,
            array_buffer: None,
            current_vao: 0,
            vao_element_buffers: HashMap::new(),
            pack_buffer: None,
            unpack_buffer: None,
            pixel_store: HashMap::new(),
            scissor_test: false,
            clear_color: [0.0; 4],
            clear_depth: 1.0,
            clear_stencil: 0,
            color_mask: [true; 4],
            depth_mask: true,
            stencil_mask: [u32::MAX; 2],
        }
    }

    fn current_element_buffer(&self) -> Option<glow::Buffer> {
        self.vao_element_buffers
            .get(&self.current_vao)
            .copied()
            .flatten()
    }

    fn pixel_store(&self, name: u32) -> i32 {
        let default = if matches!(name, glow::UNPACK_ALIGNMENT | glow::PACK_ALIGNMENT) { 4 } else { 0 };
        self.pixel_store.get(&name).copied().unwrap_or(default)
    }
}

impl Host {
    fn make_current(&mut self, context: u32) -> bool {
        if self.current == Some(context) {
            return true;
        }
        let Some(ctx) = self.contexts.get(&context) else {
            return false;
        };
        let ok = unsafe { self.platform.make_current(Some(ctx.raw)) };
        self.current = ok.then_some(context);
        ok
    }

    /// Delete a context and everything in it.
    fn delete(&mut self, context: u32) {
        if let Some(ctx) = self.contexts.remove(&context) {
            unsafe {
                if self.current == Some(context) {
                    self.platform.make_current(None);
                    self.current = None;
                }
                self.platform.destroy(ctx.raw);
            }
        }
    }

    fn create(&mut self, context: u32, cmd: &Json) -> Result<(), String> {
        let n = |i: usize| cmd.get(i).and_then(Json::as_f64).unwrap_or(0.0);
        let flag = |i: usize| cmd.get(i).and_then(Json::as_bool).unwrap_or(false);
        let (flid, width, height, version, antialias, alpha) =
            (n(1) as u32, n(2) as i32, n(3) as i32, n(4) as u32, flag(5), flag(6));
        // The page's numbers start again on every page: a context made under
        // a number still in use replaces it.
        self.delete(context);
        if self.contexts.len() >= MAX_WEBGL_CONTEXTS {
            return Err(format!("WebGL context limit ({MAX_WEBGL_CONTEXTS}) reached"));
        }
        unsafe {
            let raw = self.platform.create()?;
            // Do not mark `self.current = Some(context)` until the context is inserted,
            // and destroy `raw` on any setup error so no EGL context or stale current id leaks.
            self.current = None;
            let setup = (|| -> Result<Context, String> {
                let platform = &self.platform;
                let gl = glow::Context::from_loader_function(|name| platform.proc_address(name));
                static FIRST: std::sync::Once = std::sync::Once::new();
                FIRST.call_once(|| {
                    eprintln!(
                        "[WEBGL] {} / OpenGL {}",
                        gl.get_parameter_string(glow::RENDERER),
                        gl.get_parameter_string(glow::VERSION)
                    )
                });
                let fbo = gl.create_framebuffer()?;
                let color = gl.create_renderbuffer()?;
                let depth = gl.create_renderbuffer()?;
                let resolve = if antialias {
                    Some((gl.create_framebuffer()?, gl.create_renderbuffer()?))
                } else {
                    None
                };
                let es = platform.es();
                if !es {
                    for cap in [
                        0x8861, /* POINT_SPRITE */
                        glow::PROGRAM_POINT_SIZE,
                        glow::TEXTURE_CUBE_MAP_SEAMLESS,
                        glow::FRAMEBUFFER_SRGB,
                    ] {
                        gl.enable(cap);
                    }
                    if version >= 2 {
                        gl.enable(glow::PRIMITIVE_RESTART_FIXED_INDEX);
                    }
                }
                let mut ctx = Context {
                    raw,
                    gl,
                    es,
                    flid,
                    width: 0,
                    height: 0,
                    fbo,
                    color,
                    depth,
                    samples: if antialias { 4 } else { 0 },
                    resolve,
                    opaque: !alpha,
                    buffers: HashMap::new(),
                    textures: HashMap::new(),
                    shaders: HashMap::new(),
                    programs: HashMap::new(),
                    framebuffers: HashMap::new(),
                    renderbuffers: HashMap::new(),
                    vaos: HashMap::new(),
                    samplers: HashMap::new(),
                    queries: HashMap::new(),
                    feedbacks: HashMap::new(),
                    uniforms: HashMap::new(),
                    flip_y: false,
                    premultiply: false,
                    state: PageState::new(fbo),
                };
                ctx.resize(width, height);
                ctx.gl.bind_framebuffer(glow::FRAMEBUFFER, Some(fbo));
                ctx.gl.viewport(0, 0, ctx.width, ctx.height);
                // Nothing the setup did is the page's error.
                while ctx.gl.get_error() != glow::NO_ERROR {}
                Ok(ctx)
            })();
            match setup {
                Ok(ctx) => {
                    self.contexts.insert(context, ctx);
                    self.current = Some(context);
                }
                Err(e) => {
                    self.platform.make_current(None);
                    self.platform.destroy(raw);
                    return Err(e);
                }
            }
        }
        Ok(())
    }

    fn run(&mut self, context: u32, cmds: &str, payload: &[u8]) -> Reply {
        let mut reply = Reply::default();
        let cmds: Vec<Json> = match serde_json::from_str(cmds) {
            Ok(Json::Array(c)) => c,
            _ => {
                reply.error = Some("malformed batch".into());
                return reply;
            }
        };
        for cmd in &cmds {
            let Some(op) = cmd.get(0).and_then(Json::as_str) else {
                continue;
            };
            if op == "reset" {
                // A new page: the last one's contexts go.
                let all: Vec<u32> = self.contexts.keys().copied().collect();
                for c in all {
                    self.delete(c);
                }
                continue;
            }
            if op == "create" {
                if let Err(e) = self.create(context, cmd) {
                    reply.error = Some(format!("cannot create a context: {e}"));
                }
                continue;
            }
            if !self.make_current(context) {
                reply.error = Some("no such context".into());
                return reply;
            }
            let Some(ctx) = self.contexts.get_mut(&context) else {
                reply.error = Some("no such context".into());
                return reply;
            };
            match unsafe { ctx.exec(op, cmd, payload, &mut reply) } {
                Ok(result) => reply.result = result,
                Err(e) => reply.error = Some(format!("{op}: {e}")),
            }
        }
        reply
    }
}

/// A WebGL shader as desktop GLSL (see the module docs).
fn translate_shader(source: &str) -> String {
    let es3 = source.lines().any(|l| {
        let l = l.trim_start();
        l.starts_with("#version") && l.contains("300")
    });
    let mut body = String::with_capacity(source.len() + 256);
    for line in source.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("#version") {
            continue;
        }
        // Built into desktop GLSL, or provided by the prelude below.
        if trimmed.starts_with("#extension")
            && ["GL_OES_standard_derivatives", "GL_EXT_frag_depth", "GL_EXT_shader_texture_lod", "GL_EXT_draw_buffers"]
                .iter()
                .any(|e| trimmed.contains(e))
        {
            continue;
        }
        let mut line = line.to_string();
        // `precision mediump float;`, anywhere on the line.
        while let Some(at) = line.find("precision ") {
            match line[at..].find(';') {
                Some(end) => line.replace_range(at..at + end + 1, ""),
                None => break,
            }
        }
        body.push_str(&line);
        body.push('\n');
    }
    if es3 {
        return format!("#version 330\n{body}");
    }
    let mut prelude = String::from("#version 120\n");
    if source.contains("GL_EXT_shader_texture_lod") {
        prelude.push_str(
            "#extension GL_ARB_shader_texture_lod : enable\n\
             #define texture2DLodEXT texture2DLod\n#define texture2DProjLodEXT texture2DProjLod\n\
             #define textureCubeLodEXT textureCubeLod\n#define texture2DGradEXT texture2DGradARB\n\
             #define texture2DProjGradEXT texture2DProjGradARB\n#define textureCubeGradEXT textureCubeGradARB\n",
        );
    }
    prelude.push_str("#define lowp\n#define mediump\n#define highp\n#define gl_FragDepthEXT gl_FragDepth\n");
    format!("{prelude}{body}")
}

/// Turn rows `stride` bytes apart upside down (GL reads the bottom row first).
fn flip_rows(data: &mut [u8], stride: usize, height: usize) {
    if stride == 0 {
        return;
    }
    for y in 0..height / 2 {
        let (top, bottom) = data.split_at_mut((height - 1 - y) * stride);
        top[y * stride..y * stride + stride].swap_with_slice(&mut bottom[..stride]);
    }
}

fn pixel_bytes(format: u32, ty: u32) -> Option<usize> {
    let channels = match format {
        glow::RGBA | glow::RGBA_INTEGER => 4,
        glow::RGB | glow::RGB_INTEGER => 3,
        glow::RG | glow::RG_INTEGER | glow::LUMINANCE_ALPHA => 2,
        glow::RED | glow::RED_INTEGER | glow::ALPHA | glow::LUMINANCE | glow::DEPTH_COMPONENT | glow::DEPTH_STENCIL => 1,
        _ => return None,
    };
    Some(match ty {
        glow::UNSIGNED_BYTE | glow::BYTE => channels,
        glow::FLOAT | glow::INT | glow::UNSIGNED_INT => channels * 4,
        glow::HALF_FLOAT | glow::SHORT | glow::UNSIGNED_SHORT => channels * 2,
        glow::UNSIGNED_SHORT_5_6_5 | glow::UNSIGNED_SHORT_4_4_4_4 | glow::UNSIGNED_SHORT_5_5_5_1 => 2,
        glow::UNSIGNED_INT_2_10_10_10_REV
        | glow::UNSIGNED_INT_10F_11F_11F_REV
        | glow::UNSIGNED_INT_5_9_9_9_REV
        | glow::UNSIGNED_INT_24_8 => 4,
        glow::FLOAT_32_UNSIGNED_INT_24_8_REV => 8,
        _ => return None,
    })
}

/// The most one read back may take (64 MiB). A page asking for more is refused,
/// not answered by trying to allocate it.
const MAX_READ_BYTES: usize = 64 * 1024 * 1024;

/// The page's name for the canvas's color buffer, as the offscreen one's.
fn canvas_buffer(buffer: u32) -> u32 {
    if buffer == glow::BACK { glow::COLOR_ATTACHMENT0 } else { buffer }
}

impl Context {
    /// glClearDepth on desktop OpenGL; OpenGL ES has only glClearDepthf.
    unsafe fn set_clear_depth(&self, depth: f64) {
        unsafe {
            if self.es {
                self.gl.clear_depth_f32(depth as f32);
            } else {
                self.gl.clear_depth_f64(depth);
            }
        }
    }

    /// Bytes between rows of a `width`-pixel image under the page's
    /// alignment and row length (`pack`: for reading, else for uploading).
    fn row_stride(&self, width: i32, format: u32, ty: u32, pack: bool) -> usize {
        let (align, length) = if pack {
            (glow::PACK_ALIGNMENT, glow::PACK_ROW_LENGTH)
        } else {
            (glow::UNPACK_ALIGNMENT, glow::UNPACK_ROW_LENGTH)
        };
        let pixels = match self.state.pixel_store(length) {
            0 => width,
            n => n,
        };
        let align = self.state.pixel_store(align).max(1) as usize;
        // The largest pixel for what is not known: callers have refused it
        // already (`image_bytes`).
        (pixels.max(0) as usize).saturating_mul(pixel_bytes(format, ty).unwrap_or(16)).div_ceil(align).saturating_mul(align)
    }

    /// How many bytes the driver will touch reading or writing a `w`x`h`x`d`
    /// image under the page's pixel store: rows, padding, and what the skips
    /// step over. None for a format and type WebGL does not have, a negative
    /// size, or a total that does not fit.
    ///
    /// This is what stands between a page and the heap: OpenGL takes a pointer
    /// and no length. `readPixels` sized its buffer without the skips, and
    /// counted a format it did not know as one channel, so
    /// `pixelStorei(PACK_SKIP_ROWS, 100000)` had the driver write pixels the
    /// page chose past the end of it; an upload was never compared with its
    /// dimensions, so the driver read past the page's bytes, and the page could
    /// read what it found back.
    fn image_bytes(&self, w: i32, h: i32, d: i32, format: u32, ty: u32, pack: bool) -> Option<usize> {
        if w < 0 || h < 0 || d < 0 {
            return None;
        }
        let pixel = pixel_bytes(format, ty)?;
        if w == 0 || h == 0 || d == 0 {
            return Some(0);
        }
        let store = |name: u32| self.state.pixel_store(name).max(0) as usize;
        let (skip_rows, skip_pixels, skip_images, image_height) = if pack {
            (store(glow::PACK_SKIP_ROWS), store(glow::PACK_SKIP_PIXELS), 0, 0)
        } else {
            (
                store(glow::UNPACK_SKIP_ROWS),
                store(glow::UNPACK_SKIP_PIXELS),
                store(glow::UNPACK_SKIP_IMAGES),
                store(glow::UNPACK_IMAGE_HEIGHT),
            )
        };
        let (w, h, d) = (w as usize, h as usize, d as usize);
        let image_rows = if image_height == 0 { h } else { image_height };
        let rows = skip_images.checked_add(d - 1)?.checked_mul(image_rows)?.checked_add(skip_rows)?.checked_add(h - 1)?;
        let stride = self.row_stride(w.min(i32::MAX as usize) as i32, format, ty, pack);
        rows.checked_mul(stride)?.checked_add(skip_pixels.checked_add(w)?.checked_mul(pixel)?)
    }

    /// `len` bytes of the page's are enough for this upload, or it is refused.
    fn check_upload(&self, len: usize, w: i32, h: i32, d: i32, format: u32, ty: u32) -> Result<(), String> {
        let need = self
            .image_bytes(w, h, d, format, ty, false)
            .ok_or_else(|| format!("InvalidEnumError: no such pixels: format {format:#x}, type {ty:#x}, {w}x{h}x{d}"))?;
        if len < need {
            return Err(format!("InvalidOperationError: {len} bytes of pixels for an image of {need}"));
        }
        Ok(())
    }

    /// Page bytes for a `width`x`height` upload, flipped if UNPACK_FLIP_Y
    /// is set (padded out to whole rows first).
    fn unpack_bytes(&self, data: &[u8], width: i32, height: i32, format: u32, ty: u32) -> Vec<u8> {
        let mut data = data.to_vec();
        if self.flip_y && height > 1 {
            let stride = self.row_stride(width, format, ty, false);
            let rows = height as usize;
            if data.len() < stride * rows {
                data.resize(stride * rows, 0);
            }
            flip_rows(&mut data, stride, rows);
        }
        data
    }

    unsafe fn resize(&mut self, width: i32, height: i32) {
        let (width, height) = (width.clamp(1, MAX_WEBGL_DIM), height.clamp(1, MAX_WEBGL_DIM));
        if width == self.width && height == self.height {
            return;
        }
        self.width = width;
        self.height = height;
        unsafe {
            let gl = &self.gl;
            let storage = |rb, format| {
                gl.bind_renderbuffer(glow::RENDERBUFFER, Some(rb));
                if self.samples > 0 {
                    gl.renderbuffer_storage_multisample(glow::RENDERBUFFER, self.samples, format, width, height);
                } else {
                    gl.renderbuffer_storage(glow::RENDERBUFFER, format, width, height);
                }
            };
            storage(self.color, glow::RGBA8);
            storage(self.depth, glow::DEPTH24_STENCIL8);
            gl.bind_framebuffer(glow::FRAMEBUFFER, Some(self.fbo));
            gl.framebuffer_renderbuffer(glow::FRAMEBUFFER, glow::COLOR_ATTACHMENT0, glow::RENDERBUFFER, Some(self.color));
            gl.framebuffer_renderbuffer(glow::FRAMEBUFFER, glow::DEPTH_STENCIL_ATTACHMENT, glow::RENDERBUFFER, Some(self.depth));
            if let Some((fb, rb)) = self.resolve {
                gl.bind_renderbuffer(glow::RENDERBUFFER, Some(rb));
                gl.renderbuffer_storage(glow::RENDERBUFFER, glow::RGBA8, width, height);
                gl.bind_framebuffer(glow::FRAMEBUFFER, Some(fb));
                gl.framebuffer_renderbuffer(glow::FRAMEBUFFER, glow::COLOR_ATTACHMENT0, glow::RENDERBUFFER, Some(rb));
                gl.bind_framebuffer(glow::FRAMEBUFFER, Some(self.fbo));
            }
            // A new canvas is transparent black, whatever the page's clear
            // state, masks and scissor; those are put back after.
            gl.disable(glow::SCISSOR_TEST);
            gl.color_mask(true, true, true, true);
            gl.depth_mask(true);
            gl.stencil_mask(u32::MAX);
            gl.clear_color(0.0, 0.0, 0.0, 0.0);
            self.set_clear_depth(1.0);
            gl.clear_stencil(0);
            gl.clear(glow::COLOR_BUFFER_BIT | glow::DEPTH_BUFFER_BIT | glow::STENCIL_BUFFER_BIT);
            self.restore_state();
        }
    }

    /// Put back what the page had bound and set.
    unsafe fn restore_state(&self) {
        let (gl, s) = (&self.gl, &self.state);
        unsafe {
            gl.bind_framebuffer(glow::DRAW_FRAMEBUFFER, s.draw_fb);
            gl.bind_framebuffer(glow::READ_FRAMEBUFFER, s.read_fb);
            gl.bind_renderbuffer(glow::RENDERBUFFER, s.renderbuffer);
            gl.bind_buffer(glow::PIXEL_PACK_BUFFER, s.pack_buffer);
            gl.bind_buffer(glow::PIXEL_UNPACK_BUFFER, s.unpack_buffer);
            for name in [
                glow::PACK_ALIGNMENT,
                glow::UNPACK_ALIGNMENT,
                glow::PACK_ROW_LENGTH,
                glow::UNPACK_ROW_LENGTH,
                glow::PACK_SKIP_ROWS,
                glow::PACK_SKIP_PIXELS,
            ] {
                gl.pixel_store_i32(name, s.pixel_store(name));
            }
            if s.scissor_test {
                gl.enable(glow::SCISSOR_TEST);
            }
            let [r, g, b, a] = s.color_mask;
            gl.color_mask(r, g, b, a);
            gl.depth_mask(s.depth_mask);
            gl.stencil_mask_separate(glow::FRONT, s.stencil_mask[0]);
            gl.stencil_mask_separate(glow::BACK, s.stencil_mask[1]);
            let [r, g, b, a] = s.clear_color;
            gl.clear_color(r, g, b, a);
            self.set_clear_depth(s.clear_depth);
            gl.clear_stencil(s.clear_stencil);
        }
    }

    /// When the page reads from the canvas and it is multisampled, resolve it
    /// and read from that instead. True when it did (`end_resolved_read`
    /// puts the read binding back).
    unsafe fn begin_resolved_read(&self) -> bool {
        let Some((resolve, _)) = self.resolve else {
            return false;
        };
        if self.state.read_fb != Some(self.fbo) {
            return false;
        }
        unsafe {
            self.resolve_canvas(resolve);
            self.gl.bind_framebuffer(glow::READ_FRAMEBUFFER, Some(resolve));
        }
        true
    }

    unsafe fn end_resolved_read(&self, resolved: bool) {
        if resolved {
            unsafe { self.gl.bind_framebuffer(glow::READ_FRAMEBUFFER, self.state.read_fb) };
        }
    }

    /// Blit the multisampled canvas into `resolve`, leaving the page's draw
    /// binding and scissor as they were.
    unsafe fn resolve_canvas(&self, resolve: glow::Framebuffer) {
        let gl = &self.gl;
        unsafe {
            gl.disable(glow::SCISSOR_TEST);
            gl.bind_framebuffer(glow::READ_FRAMEBUFFER, Some(self.fbo));
            gl.bind_framebuffer(glow::DRAW_FRAMEBUFFER, Some(resolve));
            let (w, h) = (self.width, self.height);
            gl.blit_framebuffer(0, 0, w, h, 0, 0, w, h, glow::COLOR_BUFFER_BIT, glow::NEAREST);
            gl.bind_framebuffer(glow::DRAW_FRAMEBUFFER, self.state.draw_fb);
            gl.bind_framebuffer(glow::READ_FRAMEBUFFER, self.state.read_fb);
            if self.state.scissor_test {
                gl.enable(glow::SCISSOR_TEST);
            }
        }
    }

    fn uniform_location(&mut self, program: u32, name: &str) -> Option<glow::UniformLocation> {
        if let Some(found) = self.uniforms.get(&program).and_then(|m| m.get(name)) {
            return *found;
        }
        let p = *self.programs.get(&program)?;
        let found = unsafe { self.gl.get_uniform_location(p, name) };
        self.uniforms
            .entry(program)
            .or_default()
            .insert(name.to_string(), found);
        found
    }

    /// A program's attributes as WebGL lists them: without built-ins
    /// (`gl_VertexID`), which some drivers count.
    unsafe fn active_attributes(&self, p: glow::Program) -> Vec<glow::ActiveAttribute> {
        unsafe {
            (0..self.gl.get_active_attributes(p))
                .filter_map(|i| self.gl.get_active_attribute(p, i))
                .filter(|a| !a.name.starts_with("gl_"))
                .collect()
        }
    }

    /// An image's pixels from its URL, as RGBA8 with the unpack flags applied.
    fn decode_image(&self, url: &str) -> Result<(i32, i32, Vec<u8>), String> {
        let raw = if url.starts_with("blob:") {
            CURRENT_BLOBS
                .with(|b| b.borrow().as_ref().and_then(|blobs| blobs.lookup_bytes(url)))
                .ok_or_else(|| format!("WebGL blob texture not found: {url}"))?
        } else if url.starts_with("data:") {
            if url.len() > MAX_DATA_URL_BYTES {
                return Err("WebGL data URL exceeds size limit".into());
            }
            let parsed = data_url::DataUrl::process(url).map_err(|e| format!("data url: {e:?}"))?;
            let (body, _) = parsed.decode_to_vec().map_err(|e| format!("data decode: {e:?}"))?;
            if body.len() > MAX_DATA_URL_BYTES {
                return Err("WebGL data URL body exceeds size limit".into());
            }
            body
        } else {
            let rel = if let Some(rest) = strip_virtual_origin(url) {
                rest
            } else if url.starts_with("http://") || url.starts_with("https://") {
                return Err(format!("WebGL cross-origin texture blocked: {url}"));
            } else {
                url
            };
            CURRENT_BUNDLE
                .with(|b| {
                    b.borrow()
                        .as_ref()
                        .and_then(|bundle| bundle.read_public_asset(rel))
                        .map(|(_, _, bytes)| bytes)
                })
                .ok_or_else(|| format!("WebGL texture asset not found: {url}"))?
        };
        let (w, h, mut rgba) = if let Ok(img) = image::load_from_memory(&raw) {
            if img.width() > MAX_WEBGL_DIM as u32 || img.height() > MAX_WEBGL_DIM as u32 {
                return Err(format!("texture {url}: dimensions exceed {MAX_WEBGL_DIM} limit"));
            }
            let rgba_img = img.to_rgba8();
            let (w, h) = (rgba_img.width() as i32, rgba_img.height() as i32);
            (w, h, rgba_img.into_raw())
        } else if let Some(svg_pm) = zipp_renderer::rasterize_svg(&raw) {
            if svg_pm.width() > MAX_WEBGL_DIM as u32 || svg_pm.height() > MAX_WEBGL_DIM as u32 {
                return Err(format!("texture {url}: rasterized SVG exceeds {MAX_WEBGL_DIM} limit"));
            }
            let (w, h) = (svg_pm.width() as i32, svg_pm.height() as i32);
            let mut straight = vec![0u8; svg_pm.data().len()];
            for (d, s) in straight.chunks_exact_mut(4).zip(svg_pm.data().chunks_exact(4)) {
                match s[3] {
                    0 => {}
                    255 => d.copy_from_slice(s),
                    a => {
                        let a32 = a as u32;
                        let half = a32 / 2;
                        d[0] = ((s[0] as u32 * 255 + half) / a32).min(255) as u8;
                        d[1] = ((s[1] as u32 * 255 + half) / a32).min(255) as u8;
                        d[2] = ((s[2] as u32 * 255 + half) / a32).min(255) as u8;
                        d[3] = a;
                    }
                }
            }
            (w, h, straight)
        } else {
            return Err(format!("texture {url}: unsupported image format"));
        };
        if self.flip_y {
            flip_rows(&mut rgba, w as usize * 4, h as usize);
        }
        if self.premultiply {
            for px in rgba.chunks_exact_mut(4) {
                let a = px[3] as u32;
                for c in &mut px[..3] {
                    *c = ((*c as u32 * a + 127) / 255) as u8;
                }
            }
        }
        Ok((w, h, rgba))
    }

    /// Upload decoded RGBA8 rows, tightly packed, from client memory whatever
    /// the page set for its own uploads.
    unsafe fn with_tight_unpack(&self, upload: impl FnOnce(&glow::Context)) {
        let gl = &self.gl;
        unsafe {
            gl.bind_buffer(glow::PIXEL_UNPACK_BUFFER, None);
            for name in [glow::UNPACK_ROW_LENGTH, glow::UNPACK_SKIP_ROWS, glow::UNPACK_SKIP_PIXELS] {
                gl.pixel_store_i32(name, 0);
            }
            gl.pixel_store_i32(glow::UNPACK_ALIGNMENT, 1);
            upload(gl);
            gl.bind_buffer(glow::PIXEL_UNPACK_BUFFER, self.state.unpack_buffer);
            for name in [glow::UNPACK_ROW_LENGTH, glow::UNPACK_SKIP_ROWS, glow::UNPACK_SKIP_PIXELS, glow::UNPACK_ALIGNMENT] {
                gl.pixel_store_i32(name, self.state.pixel_store(name));
            }
        }
    }

    /// Run one command; its answer as JSON, or "".
    unsafe fn exec(&mut self, op: &str, cmd: &Json, payload: &[u8], reply: &mut Reply) -> Result<String, String> {
        let num = |i: usize| cmd.get(i).and_then(Json::as_f64).unwrap_or(0.0);
        let u = |i: usize| num(i) as u32;
        let int = |i: usize| num(i) as i32;
        let f = |i: usize| num(i) as f32;
        let flag = |i: usize| cmd.get(i).and_then(Json::as_bool).unwrap_or(false);
        let text_str = |i: usize| cmd.get(i).and_then(Json::as_str).unwrap_or("");
        let text = |i: usize| text_str(i).to_string();
        let list = |i: usize| cmd.get(i).and_then(Json::as_array).cloned().unwrap_or_default();
        let nums = |i: usize| -> Vec<f64> { list(i).iter().filter_map(Json::as_f64).collect() };
        let texts = |i: usize| -> Vec<String> { list(i).iter().filter_map(|v| v.as_str().map(String::from)).collect() };
        let bytes = |off: usize, len: usize| -> Result<&[u8], String> {
            let end = off.checked_add(len).ok_or_else(|| "bytes range overflow".to_string())?;
            payload.get(off..end).ok_or_else(|| "bytes out of range".to_string())
        };
        let mut out = String::new();
        unsafe {
            match op {
                "resize" => {
                    let (w, h) = (int(1), int(2));
                    self.resize(w, h);
                }
                "createBuffer" => {
                    let id = u(1);
                    if !self.buffers.contains_key(&id) && self.buffers.len() >= MAX_GL_OBJECTS {
                        return Err("buffer limit exceeded".into());
                    }
                    let b = self.gl.create_buffer()?;
                    if let Some(old) = self.buffers.insert(id, b) {
                        self.gl.delete_buffer(old);
                    }
                }
                "deleteBuffer" => {
                    if let Some(b) = self.buffers.remove(&u(1)) {
                        if self.state.array_buffer == Some(b) {
                            self.state.array_buffer = None;
                        }
                        if self.state.pack_buffer == Some(b) {
                            self.state.pack_buffer = None;
                        }
                        if self.state.unpack_buffer == Some(b) {
                            self.state.unpack_buffer = None;
                        }
                        for slot in self.state.vao_element_buffers.values_mut() {
                            if *slot == Some(b) {
                                *slot = None;
                            }
                        }
                        self.gl.delete_buffer(b);
                    }
                }
                "bindBuffer" => {
                    let b = self.buffers.get(&u(2)).copied();
                    match u(1) {
                        glow::ARRAY_BUFFER => self.state.array_buffer = b,
                        glow::ELEMENT_ARRAY_BUFFER => {
                            self.state
                                .vao_element_buffers
                                .insert(self.state.current_vao, b);
                        }
                        glow::PIXEL_PACK_BUFFER => self.state.pack_buffer = b,
                        glow::PIXEL_UNPACK_BUFFER => self.state.unpack_buffer = b,
                        _ => {}
                    }
                    self.gl.bind_buffer(u(1), b);
                }
                "bindBufferBase" => self.gl.bind_buffer_base(u(1), u(2), self.buffers.get(&u(3)).copied()),
                "bindBufferRange" => {
                    self.gl.bind_buffer_range(u(1), u(2), self.buffers.get(&u(3)).copied(), int(4), int(5));
                }
                "bufferData" => self.gl.buffer_data_u8_slice(u(1), bytes(u(2) as usize, u(3) as usize)?, u(4)),
                "bufferSize" => {
                    let sz = int(2);
                    if sz < 0 || (sz as usize) > MAX_READ_BYTES {
                        return Err("InvalidValueError: bufferSize out of bounds".into());
                    }
                    self.gl.buffer_data_size(u(1), sz, u(3));
                }
                "bufferSubData" => self.gl.buffer_sub_data_u8_slice(u(1), int(2), bytes(u(3) as usize, u(4) as usize)?),
                "copyBufferSubData" => self.gl.copy_buffer_sub_data(u(1), u(2), int(3), int(4), int(5)),
                "getBufferSubData" => {
                    let target = u(1);
                    let offset = int(2);
                    let len_f = num(3);
                    if offset < 0 || !len_f.is_finite() || len_f < 0.0 {
                        return Err("InvalidValueError: getBufferSubData negative offset or length".into());
                    }
                    let len = len_f as usize;
                    if len > MAX_READ_BYTES || len > i32::MAX as usize {
                        return Err(format!("InvalidOperationError: getBufferSubData length {len} exceeds 64 MiB limit"));
                    }
                    let mut buf = vec![0u8; len];
                    if !self.es {
                        self.gl.get_buffer_sub_data(target, offset, &mut buf);
                    } else if !buf.is_empty() {
                        // OpenGL ES reads a buffer back by mapping it. Only unmap when
                        // glMapBufferRange succeeded (returned non-null).
                        let mapped = self.gl.map_buffer_range(target, offset, buf.len() as i32, glow::MAP_READ_BIT);
                        if mapped.is_null() {
                            return Err("InvalidOperationError: getBufferSubData mapBufferRange failed".into());
                        }
                        std::ptr::copy_nonoverlapping(mapped, buf.as_mut_ptr(), buf.len());
                        self.gl.unmap_buffer(target);
                    }
                    reply.bytes = Some(buf);
                }
                "createShader" => {
                    let id = u(1);
                    if !self.shaders.contains_key(&id) && self.shaders.len() >= MAX_GL_OBJECTS {
                        return Err("shader limit exceeded".into());
                    }
                    let s = self.gl.create_shader(u(2))?;
                    if let Some(old) = self.shaders.insert(id, s) {
                        self.gl.delete_shader(old);
                    }
                }
                "deleteShader" => { if let Some(s) = self.shaders.remove(&u(1)) { self.gl.delete_shader(s); } }
                "shaderSource" => {
                    if let Some(&s) = self.shaders.get(&u(1)) {
                        let source = text_str(2);
                        if self.es {
                            self.gl.shader_source(s, source);
                        } else {
                            let translated = translate_shader(source);
                            self.gl.shader_source(s, &translated);
                        }
                    }
                }
                "compileShader" => { if let Some(&s) = self.shaders.get(&u(1)) { self.gl.compile_shader(s); } }
                "getShaderParameter" => {
                    let s = self.shaders.get(&u(1)).copied();
                    out = match (s, u(2)) {
                        (Some(s), glow::COMPILE_STATUS) => self.gl.get_shader_compile_status(s).to_string(),
                        (_, glow::DELETE_STATUS) => "false".into(),
                        _ => "null".into(),
                    };
                }
                // A driver's warnings about a shader that compiled are not
                // WebGL's to report (Chrome's translator has none), and pages
                // print a non-empty log: only failures keep theirs.
                "getShaderInfoLog" => {
                    let log = match self.shaders.get(&u(1)) {
                        Some(&s) if !self.gl.get_shader_compile_status(s) => self.gl.get_shader_info_log(s),
                        _ => String::new(),
                    };
                    out = Json::String(log).to_string();
                }
                "createProgram" => {
                    let id = u(1);
                    if !self.programs.contains_key(&id) && self.programs.len() >= MAX_GL_OBJECTS {
                        return Err("program limit exceeded".into());
                    }
                    let p = self.gl.create_program()?;
                    if let Some(old) = self.programs.insert(id, p) {
                        self.gl.delete_program(old);
                    }
                    self.uniforms.remove(&id);
                }
                "deleteProgram" => {
                    let id = u(1);
                    self.uniforms.remove(&id);
                    if let Some(p) = self.programs.remove(&id) {
                        self.gl.delete_program(p);
                    }
                }
                "attachShader" | "detachShader" => {
                    if let (Some(&p), Some(&s)) = (self.programs.get(&u(1)), self.shaders.get(&u(2))) {
                        if op == "attachShader" { self.gl.attach_shader(p, s) } else { self.gl.detach_shader(p, s) }
                    }
                }
                "linkProgram" => {
                    let program = u(1);
                    if let Some(&p) = self.programs.get(&program) {
                        self.gl.link_program(p);
                        self.uniforms.remove(&program);
                    }
                }
                "validateProgram" => {}
                "getProgramParameter" => {
                    let p = self.programs.get(&u(1)).copied();
                    out = match (p, u(2)) {
                        (Some(p), glow::LINK_STATUS) => self.gl.get_program_link_status(p).to_string(),
                        (Some(p), glow::ACTIVE_ATTRIBUTES) => self.active_attributes(p).len().to_string(),
                        (Some(p), glow::ACTIVE_UNIFORMS) => self.gl.get_active_uniforms(p).to_string(),
                        (Some(p), pname @ (glow::ACTIVE_UNIFORM_BLOCKS | glow::TRANSFORM_FEEDBACK_VARYINGS
                            | glow::TRANSFORM_FEEDBACK_BUFFER_MODE)) => {
                            self.gl.get_program_parameter_i32(p, pname).to_string()
                        }
                        (Some(_), glow::VALIDATE_STATUS) => "true".into(),
                        (_, glow::DELETE_STATUS) => "false".into(),
                        (Some(_), glow::ATTACHED_SHADERS) => "2".into(),
                        _ => "null".into(),
                    };
                }
                "getProgramInfoLog" => {
                    let log = match self.programs.get(&u(1)) {
                        Some(&p) if !self.gl.get_program_link_status(p) => self.gl.get_program_info_log(p),
                        _ => String::new(),
                    };
                    out = Json::String(log).to_string();
                }
                "useProgram" => self.gl.use_program(self.programs.get(&u(1)).copied()),
                "getAttribLocation" => {
                    let at = self.programs.get(&u(1)).and_then(|&p| self.gl.get_attrib_location(p, &text(2)));
                    out = at.map(|a| a as i64).unwrap_or(-1).to_string();
                }
                "bindAttribLocation" => {
                    if let Some(&p) = self.programs.get(&u(1)) {
                        self.gl.bind_attrib_location(p, u(2), &text(3));
                    }
                }
                "getUniformLocation" => {
                    let (program, name) = (u(1), text(2));
                    out = self.uniform_location(program, &name).is_some().to_string();
                }
                "getActiveAttrib" | "getActiveUniform" => {
                    let p = self.programs.get(&u(1)).copied();
                    let info = p.and_then(|p| {
                        if op == "getActiveAttrib" {
                            self.active_attributes(p).into_iter().nth(u(2) as usize).map(|a| (a.name, a.size, a.atype))
                        } else {
                            self.gl.get_active_uniform(p, u(2)).map(|a| (a.name, a.size, a.utype))
                        }
                    });
                    out = match info {
                        Some((name, size, ty)) => serde_json::json!([name, size, ty]).to_string(),
                        None => "null".into(),
                    };
                }
                "getFragDataLocation" => {
                    let at = self.programs.get(&u(1)).map(|&p| self.gl.get_frag_data_location(p, &text(2)));
                    out = at.unwrap_or(-1).to_string();
                }
                "getUniformBlockIndex" => {
                    let index = self.programs.get(&u(1)).and_then(|&p| self.gl.get_uniform_block_index(p, &text(2)));
                    out = index.unwrap_or(u32::MAX).to_string();
                }
                "uniformBlockBinding" => {
                    if let Some(&p) = self.programs.get(&u(1)) {
                        self.gl.uniform_block_binding(p, u(2), u(3));
                    }
                }
                "getActiveUniformBlockParameter" => {
                    let Some(&p) = self.programs.get(&u(1)) else { return Ok("null".into()) };
                    let (index, pname) = (u(2), u(3));
                    out = match pname {
                        glow::UNIFORM_BLOCK_ACTIVE_UNIFORM_INDICES => {
                            let n = self.gl.get_active_uniform_block_parameter_i32(p, index, glow::UNIFORM_BLOCK_ACTIVE_UNIFORMS);
                            let mut indices = vec![0i32; n.max(0) as usize];
                            self.gl.get_active_uniform_block_parameter_i32_slice(p, index, pname, &mut indices);
                            serde_json::json!(indices).to_string()
                        }
                        glow::UNIFORM_BLOCK_REFERENCED_BY_VERTEX_SHADER | glow::UNIFORM_BLOCK_REFERENCED_BY_FRAGMENT_SHADER => {
                            (self.gl.get_active_uniform_block_parameter_i32(p, index, pname) != 0).to_string()
                        }
                        _ => self.gl.get_active_uniform_block_parameter_i32(p, index, pname).to_string(),
                    };
                }
                "getActiveUniformBlockName" => {
                    let name = self.programs.get(&u(1)).map(|&p| self.gl.get_active_uniform_block_name(p, u(2)));
                    out = name.map(|n| Json::String(n).to_string()).unwrap_or_else(|| "null".into());
                }
                "getUniformIndices" => {
                    let names = texts(2);
                    let names: Vec<&str> = names.iter().map(String::as_str).collect();
                    let indices = self.programs.get(&u(1)).map(|&p| self.gl.get_uniform_indices(p, &names));
                    out = match indices {
                        Some(i) => serde_json::json!(i.iter().map(|i| i.unwrap_or(u32::MAX)).collect::<Vec<_>>()).to_string(),
                        None => "null".into(),
                    };
                }
                "getActiveUniforms" => {
                    let indices: Vec<u32> = nums(2).iter().map(|&i| i as u32).collect();
                    let pname = u(3);
                    let values = self.programs.get(&u(1)).map(|&p| self.gl.get_active_uniforms_parameter(p, &indices, pname));
                    out = match values {
                        Some(v) if pname == glow::UNIFORM_IS_ROW_MAJOR => {
                            serde_json::json!(v.iter().map(|&x| x != 0).collect::<Vec<_>>()).to_string()
                        }
                        Some(v) => serde_json::json!(v).to_string(),
                        None => "null".into(),
                    };
                }
                "enableVertexAttribArray" => self.gl.enable_vertex_attrib_array(u(1)),
                "disableVertexAttribArray" => self.gl.disable_vertex_attrib_array(u(1)),
                "vertexAttribPointer" => {
                    if self.state.array_buffer.is_none() {
                        return Err("InvalidOperationError: vertexAttribPointer requires a bound ARRAY_BUFFER".into());
                    }
                    let (stride, offset) = (int(5), int(6));
                    if stride < 0 || offset < 0 {
                        return Err("InvalidValueError: negative stride or offset".into());
                    }
                    self.gl.vertex_attrib_pointer_f32(u(1), int(2), u(3), flag(4), stride, offset);
                }
                "vertexAttribIPointer" => {
                    if self.state.array_buffer.is_none() {
                        return Err("InvalidOperationError: vertexAttribIPointer requires a bound ARRAY_BUFFER".into());
                    }
                    let (stride, offset) = (int(4), int(5));
                    if stride < 0 || offset < 0 {
                        return Err("InvalidValueError: negative stride or offset".into());
                    }
                    self.gl.vertex_attrib_pointer_i32(u(1), int(2), u(3), stride, offset);
                }
                "vertexAttrib" => self.gl.vertex_attrib_4_f32(u(1), f(2), f(3), f(4), f(5)),
                "vertexAttribI" => {
                    if flag(6) {
                        self.gl.vertex_attrib_4_u32(u(1), u(2), u(3), u(4), u(5));
                    } else {
                        self.gl.vertex_attrib_4_i32(u(1), int(2), int(3), int(4), int(5));
                    }
                }
                "vertexAttribDivisor" => self.gl.vertex_attrib_divisor(u(1), u(2)),
                "uniform" => {
                    // The values are bytes beside the batch, of the kind's type.
                    let (program, name, kind, transpose) = (u(1), text_str(2), text_str(3), flag(6));
                    let raw = bytes(u(4) as usize, u(5) as usize)?;
                    if let Some(loc) = self.uniform_location(program, name) {
                        let count = raw.len() / 4;
                        let (gl, loc) = (&self.gl, Some(&loc));
                        if kind.ends_with('i') {
                            let mut stack = [0i32; 16];
                            let heap: Vec<i32>;
                            let slice: &[i32] = if count <= stack.len() {
                                for (dst, w) in stack[..count].iter_mut().zip(raw.chunks_exact(4)) {
                                    *dst = i32::from_le_bytes([w[0], w[1], w[2], w[3]]);
                                }
                                &stack[..count]
                            } else {
                                heap = raw
                                    .chunks_exact(4)
                                    .map(|w| i32::from_le_bytes([w[0], w[1], w[2], w[3]]))
                                    .collect();
                                &heap
                            };
                            match kind {
                                "1i" => gl.uniform_1_i32_slice(loc, slice),
                                "2i" => gl.uniform_2_i32_slice(loc, slice),
                                "3i" => gl.uniform_3_i32_slice(loc, slice),
                                "4i" => gl.uniform_4_i32_slice(loc, slice),
                                _ => {}
                            }
                        } else if kind.ends_with('u') {
                            let mut stack = [0u32; 16];
                            let heap: Vec<u32>;
                            let slice: &[u32] = if count <= stack.len() {
                                for (dst, w) in stack[..count].iter_mut().zip(raw.chunks_exact(4)) {
                                    *dst = u32::from_le_bytes([w[0], w[1], w[2], w[3]]);
                                }
                                &stack[..count]
                            } else {
                                heap = raw
                                    .chunks_exact(4)
                                    .map(|w| u32::from_le_bytes([w[0], w[1], w[2], w[3]]))
                                    .collect();
                                &heap
                            };
                            match kind {
                                "1u" => gl.uniform_1_u32_slice(loc, slice),
                                "2u" => gl.uniform_2_u32_slice(loc, slice),
                                "3u" => gl.uniform_3_u32_slice(loc, slice),
                                "4u" => gl.uniform_4_u32_slice(loc, slice),
                                _ => {}
                            }
                        } else {
                            let mut stack = [0.0f32; 16];
                            let heap: Vec<f32>;
                            let slice: &[f32] = if count <= stack.len() {
                                for (dst, w) in stack[..count].iter_mut().zip(raw.chunks_exact(4)) {
                                    *dst = f32::from_le_bytes([w[0], w[1], w[2], w[3]]);
                                }
                                &stack[..count]
                            } else {
                                heap = raw
                                    .chunks_exact(4)
                                    .map(|w| f32::from_le_bytes([w[0], w[1], w[2], w[3]]))
                                    .collect();
                                &heap
                            };
                            match kind {
                                "1f" => gl.uniform_1_f32_slice(loc, slice),
                                "2f" => gl.uniform_2_f32_slice(loc, slice),
                                "3f" => gl.uniform_3_f32_slice(loc, slice),
                                "4f" => gl.uniform_4_f32_slice(loc, slice),
                                "m2" => gl.uniform_matrix_2_f32_slice(loc, transpose, slice),
                                "m3" => gl.uniform_matrix_3_f32_slice(loc, transpose, slice),
                                "m4" => gl.uniform_matrix_4_f32_slice(loc, transpose, slice),
                                "m23" => gl.uniform_matrix_2x3_f32_slice(loc, transpose, slice),
                                "m24" => gl.uniform_matrix_2x4_f32_slice(loc, transpose, slice),
                                "m32" => gl.uniform_matrix_3x2_f32_slice(loc, transpose, slice),
                                "m34" => gl.uniform_matrix_3x4_f32_slice(loc, transpose, slice),
                                "m42" => gl.uniform_matrix_4x2_f32_slice(loc, transpose, slice),
                                "m43" => gl.uniform_matrix_4x3_f32_slice(loc, transpose, slice),
                                _ => {}
                            }
                        }
                    }
                }
                "createTexture" => {
                    let id = u(1);
                    if !self.textures.contains_key(&id) && self.textures.len() >= MAX_GL_OBJECTS {
                        return Err("texture limit exceeded".into());
                    }
                    let t = self.gl.create_texture()?;
                    if let Some(old) = self.textures.insert(id, t) {
                        self.gl.delete_texture(old);
                    }
                }
                "deleteTexture" => { if let Some(t) = self.textures.remove(&u(1)) { self.gl.delete_texture(t); } }
                "bindTexture" => self.gl.bind_texture(u(1), self.textures.get(&u(2)).copied()),
                "activeTexture" => self.gl.active_texture(u(1)),
                "texParameteri" => self.gl.tex_parameter_i32(u(1), u(2), int(3)),
                "texParameterf" => self.gl.tex_parameter_f32(u(1), u(2), f(3)),
                "pixelStorei" => match u(1) {
                    0x9240 => self.flip_y = num(2) != 0.0,
                    0x9241 => self.premultiply = num(2) != 0.0,
                    0x9243 => {}
                    name @ (glow::PACK_ALIGNMENT | glow::UNPACK_ALIGNMENT) => {
                        let val = int(2);
                        if !matches!(val, 1 | 2 | 4 | 8) {
                            return Err(format!("InvalidValueError: pixelStorei alignment {val}"));
                        }
                        self.state.pixel_store.insert(name, val);
                        self.gl.pixel_store_i32(name, val);
                    }
                    name @ (glow::PACK_ROW_LENGTH
                    | glow::UNPACK_ROW_LENGTH
                    | glow::PACK_SKIP_ROWS
                    | glow::PACK_SKIP_PIXELS
                    | glow::UNPACK_SKIP_ROWS
                    | glow::UNPACK_SKIP_PIXELS
                    | glow::UNPACK_SKIP_IMAGES
                    | glow::UNPACK_IMAGE_HEIGHT) => {
                        let val = int(2);
                        if !(0..=65536).contains(&val) {
                            return Err(format!("InvalidValueError: pixelStorei {name:#x} out of range ({val})"));
                        }
                        self.state.pixel_store.insert(name, val);
                        self.gl.pixel_store_i32(name, val);
                    }
                    name => {
                        return Err(format!("InvalidEnumError: unsupported pixelStorei pname {name:#x}"));
                    }
                },
                "generateMipmap" => self.gl.generate_mipmap(u(1)),
                "texStorage2D" => self.gl.tex_storage_2d(u(1), int(2), u(3), int(4), int(5)),
                "texStorage3D" => self.gl.tex_storage_3d(u(1), int(2), u(3), int(4), int(5), int(6)),
                "texImage2D" => {
                    let (target, level, internal, w, h, format, ty) = (u(1), int(2), int(3), int(4), int(5), u(6), u(7));
                    let at = num(8);
                    if at < 0.0 {
                        self.gl.tex_image_2d(target, level, internal, w, h, 0, format, ty, glow::PixelUnpackData::Slice(None));
                    } else {
                        let page = bytes(at as usize, u(9) as usize)?;
                        self.check_upload(page.len(), w, h, 1, format, ty)?;
                        let data = self.unpack_bytes(page, w, h, format, ty);
                        self.gl.tex_image_2d(target, level, internal, w, h, 0, format, ty, glow::PixelUnpackData::Slice(Some(&data)));
                    }
                }
                "texImage2DPbo" => {
                    if self.state.unpack_buffer.is_none() {
                        return Err("InvalidOperationError: texImage2DPbo requires a bound PIXEL_UNPACK_BUFFER".into());
                    }
                    let pixels = glow::PixelUnpackData::BufferOffset(u(8));
                    self.gl.tex_image_2d(u(1), int(2), int(3), int(4), int(5), 0, u(6), u(7), pixels);
                }
                "texImage2DUrl" => {
                    let (target, level, internal, url) = (u(1), int(2), int(3), text(6));
                    let (w, h, rgba) = self.decode_image(&url)?;
                    self.with_tight_unpack(|gl| {
                        let pixels = glow::PixelUnpackData::Slice(Some(&rgba));
                        gl.tex_image_2d(target, level, internal, w, h, 0, glow::RGBA, glow::UNSIGNED_BYTE, pixels);
                    });
                }
                "texSubImage2D" => {
                    let (target, level, x, y, w, h, format, ty) = (u(1), int(2), int(3), int(4), int(5), int(6), u(7), u(8));
                    let page = bytes(u(9) as usize, u(10) as usize)?;
                    self.check_upload(page.len(), w, h, 1, format, ty)?;
                    let data = self.unpack_bytes(page, w, h, format, ty);
                    self.gl.tex_sub_image_2d(target, level, x, y, w, h, format, ty, glow::PixelUnpackData::Slice(Some(&data)));
                }
                "texSubImage2DPbo" => {
                    if self.state.unpack_buffer.is_none() {
                        return Err("InvalidOperationError: texSubImage2DPbo requires a bound PIXEL_UNPACK_BUFFER".into());
                    }
                    let pixels = glow::PixelUnpackData::BufferOffset(u(9));
                    self.gl.tex_sub_image_2d(u(1), int(2), int(3), int(4), int(5), int(6), u(7), u(8), pixels);
                }
                "texSubImage2DUrl" => {
                    let (target, level, x, y, url) = (u(1), int(2), int(3), int(4), text(7));
                    let (w, h, rgba) = self.decode_image(&url)?;
                    self.with_tight_unpack(|gl| {
                        let pixels = glow::PixelUnpackData::Slice(Some(&rgba));
                        gl.tex_sub_image_2d(target, level, x, y, w, h, glow::RGBA, glow::UNSIGNED_BYTE, pixels);
                    });
                }
                "texImage3D" => {
                    let (target, level, internal, w, h, d, format, ty) = (u(1), int(2), int(3), int(4), int(5), int(6), u(7), u(8));
                    let at = num(9);
                    let data = if at < 0.0 { None } else { Some(bytes(at as usize, u(10) as usize)?) };
                    if let Some(data) = data {
                        self.check_upload(data.len(), w, h, d, format, ty)?;
                    }
                    self.gl.tex_image_3d(target, level, internal, w, h, d, 0, format, ty, glow::PixelUnpackData::Slice(data));
                }
                "texImage3DPbo" => {
                    if self.state.unpack_buffer.is_none() {
                        return Err("InvalidOperationError: texImage3DPbo requires a bound PIXEL_UNPACK_BUFFER".into());
                    }
                    let pixels = glow::PixelUnpackData::BufferOffset(u(9));
                    self.gl.tex_image_3d(u(1), int(2), int(3), int(4), int(5), int(6), 0, u(7), u(8), pixels);
                }
                "texSubImage3D" => {
                    let data = bytes(u(11) as usize, u(12) as usize)?;
                    self.check_upload(data.len(), int(6), int(7), int(8), u(9), u(10))?;
                    let pixels = glow::PixelUnpackData::Slice(Some(data));
                    self.gl.tex_sub_image_3d(u(1), int(2), int(3), int(4), int(5), int(6), int(7), int(8), u(9), u(10), pixels);
                }
                "texSubImage3DPbo" => {
                    if self.state.unpack_buffer.is_none() {
                        return Err("InvalidOperationError: texSubImage3DPbo requires a bound PIXEL_UNPACK_BUFFER".into());
                    }
                    let pixels = glow::PixelUnpackData::BufferOffset(u(11));
                    self.gl.tex_sub_image_3d(u(1), int(2), int(3), int(4), int(5), int(6), int(7), int(8), u(9), u(10), pixels);
                }
                "copyTexImage2D" => {
                    let resolved = self.begin_resolved_read();
                    self.gl.copy_tex_image_2d(u(1), int(2), u(3), int(4), int(5), int(6), int(7), 0);
                    self.end_resolved_read(resolved);
                }
                "copyTexSubImage2D" => {
                    let resolved = self.begin_resolved_read();
                    self.gl.copy_tex_sub_image_2d(u(1), int(2), int(3), int(4), int(5), int(6), int(7), int(8));
                    self.end_resolved_read(resolved);
                }
                "copyTexSubImage3D" => {
                    let resolved = self.begin_resolved_read();
                    self.gl.copy_tex_sub_image_3d(u(1), int(2), int(3), int(4), int(5), int(6), int(7), int(8), int(9));
                    self.end_resolved_read(resolved);
                }
                "createSampler" => {
                    let id = u(1);
                    if !self.samplers.contains_key(&id) && self.samplers.len() >= MAX_GL_OBJECTS {
                        return Err("sampler limit exceeded".into());
                    }
                    let s = self.gl.create_sampler()?;
                    if let Some(old) = self.samplers.insert(id, s) {
                        self.gl.delete_sampler(old);
                    }
                }
                "deleteSampler" => { if let Some(s) = self.samplers.remove(&u(1)) { self.gl.delete_sampler(s); } }
                "bindSampler" => self.gl.bind_sampler(u(1), self.samplers.get(&u(2)).copied()),
                "samplerParameteri" => {
                    if let Some(&s) = self.samplers.get(&u(1)) { self.gl.sampler_parameter_i32(s, u(2), int(3)); }
                }
                "samplerParameterf" => {
                    if let Some(&s) = self.samplers.get(&u(1)) { self.gl.sampler_parameter_f32(s, u(2), f(3)); }
                }
                "createFramebuffer" => {
                    let id = u(1);
                    if !self.framebuffers.contains_key(&id) && self.framebuffers.len() >= MAX_GL_OBJECTS {
                        return Err("framebuffer limit exceeded".into());
                    }
                    let fb = self.gl.create_framebuffer()?;
                    if let Some(old) = self.framebuffers.insert(id, fb) {
                        self.gl.delete_framebuffer(old);
                    }
                }
                "deleteFramebuffer" => {
                    if let Some(fb) = self.framebuffers.remove(&u(1)) {
                        self.gl.delete_framebuffer(fb);
                        // Deleting a bound framebuffer binds the canvas's.
                        let canvas = Some(self.fbo);
                        for bound in [&mut self.state.draw_fb, &mut self.state.read_fb] {
                            if *bound == Some(fb) {
                                *bound = canvas;
                            }
                        }
                        self.gl.bind_framebuffer(glow::DRAW_FRAMEBUFFER, self.state.draw_fb);
                        self.gl.bind_framebuffer(glow::READ_FRAMEBUFFER, self.state.read_fb);
                    }
                }
                "bindFramebuffer" => {
                    // Null is the canvas: its offscreen framebuffer.
                    let fb = if u(2) == 0 { Some(self.fbo) } else { self.framebuffers.get(&u(2)).copied() };
                    let target = u(1);
                    if target != glow::READ_FRAMEBUFFER {
                        self.state.draw_fb = fb;
                    }
                    if target != glow::DRAW_FRAMEBUFFER {
                        self.state.read_fb = fb;
                    }
                    self.gl.bind_framebuffer(target, fb);
                }
                "framebufferTexture2D" => {
                    self.gl.framebuffer_texture_2d(u(1), u(2), u(3), self.textures.get(&u(4)).copied(), int(5));
                }
                "framebufferTextureLayer" => {
                    self.gl.framebuffer_texture_layer(u(1), u(2), self.textures.get(&u(3)).copied(), int(4), int(5));
                }
                "framebufferRenderbuffer" => {
                    self.gl.framebuffer_renderbuffer(u(1), u(2), u(3), self.renderbuffers.get(&u(4)).copied());
                }
                "checkFramebufferStatus" => out = self.gl.check_framebuffer_status(u(1)).to_string(),
                "drawBuffers" => {
                    let buffers: Vec<u32> = nums(1).iter().map(|&b| canvas_buffer(b as u32)).collect();
                    self.gl.draw_buffers(&buffers);
                }
                "readBuffer" => self.gl.read_buffer(canvas_buffer(u(1))),
                "blitFramebuffer" => {
                    let resolved = self.begin_resolved_read();
                    self.gl.blit_framebuffer(int(1), int(2), int(3), int(4), int(5), int(6), int(7), int(8), u(9), u(10));
                    self.end_resolved_read(resolved);
                }
                "createRenderbuffer" => {
                    let id = u(1);
                    if !self.renderbuffers.contains_key(&id) && self.renderbuffers.len() >= MAX_GL_OBJECTS {
                        return Err("renderbuffer limit exceeded".into());
                    }
                    let rb = self.gl.create_renderbuffer()?;
                    if let Some(old) = self.renderbuffers.insert(id, rb) {
                        self.gl.delete_renderbuffer(old);
                    }
                }
                "deleteRenderbuffer" => {
                    if let Some(rb) = self.renderbuffers.remove(&u(1)) {
                        self.gl.delete_renderbuffer(rb);
                        if self.state.renderbuffer == Some(rb) {
                            self.state.renderbuffer = None;
                        }
                    }
                }
                "bindRenderbuffer" => {
                    let rb = self.renderbuffers.get(&u(2)).copied();
                    self.state.renderbuffer = rb;
                    self.gl.bind_renderbuffer(u(1), rb);
                }
                "renderbufferStorage" => {
                    // WebGL's DEPTH_STENCIL is a sized format on the desktop.
                    let format = if u(2) == 0x84f9 { glow::DEPTH24_STENCIL8 } else { u(2) };
                    self.gl.renderbuffer_storage(u(1), format, int(3), int(4));
                }
                "renderbufferStorageMultisample" => {
                    let format = if u(3) == 0x84f9 { glow::DEPTH24_STENCIL8 } else { u(3) };
                    self.gl.renderbuffer_storage_multisample(u(1), int(2), format, int(4), int(5));
                }
                "createVertexArray" => {
                    let id = u(1);
                    if !self.vaos.contains_key(&id) && self.vaos.len() >= MAX_GL_OBJECTS {
                        return Err("vertex array limit exceeded".into());
                    }
                    let v = self.gl.create_vertex_array()?;
                    if let Some(old) = self.vaos.insert(id, v) {
                        self.gl.delete_vertex_array(old);
                    }
                }
                "deleteVertexArray" => {
                    let id = u(1);
                    self.state.vao_element_buffers.remove(&id);
                    if self.state.current_vao == id {
                        self.state.current_vao = 0;
                    }
                    if let Some(v) = self.vaos.remove(&id) {
                        self.gl.delete_vertex_array(v);
                    }
                }
                "bindVertexArray" => {
                    let id = u(1);
                    let vao = if id == 0 { None } else { self.vaos.get(&id).copied() };
                    self.state.current_vao = if vao.is_some() { id } else { 0 };
                    self.gl.bind_vertex_array(vao);
                }
                "createQuery" => {
                    let id = u(1);
                    if !self.queries.contains_key(&id) && self.queries.len() >= MAX_GL_OBJECTS {
                        return Err("query limit exceeded".into());
                    }
                    let q = self.gl.create_query()?;
                    if let Some(old) = self.queries.insert(id, q) {
                        self.gl.delete_query(old);
                    }
                }
                "deleteQuery" => { if let Some(q) = self.queries.remove(&u(1)) { self.gl.delete_query(q); } }
                "beginQuery" => {
                    if let Some(&q) = self.queries.get(&u(2)) { self.gl.begin_query(u(1), q); }
                }
                "endQuery" => self.gl.end_query(u(1)),
                "getQueryParameter" => {
                    let Some(&q) = self.queries.get(&u(1)) else { return Ok("null".into()) };
                    let value = self.gl.get_query_parameter_u32(q, u(2));
                    out = if u(2) == glow::QUERY_RESULT_AVAILABLE { (value != 0).to_string() } else { value.to_string() };
                }
                "createTransformFeedback" => {
                    let id = u(1);
                    if !self.feedbacks.contains_key(&id) && self.feedbacks.len() >= MAX_GL_OBJECTS {
                        return Err("transform feedback limit exceeded".into());
                    }
                    let t = self.gl.create_transform_feedback()?;
                    if let Some(old) = self.feedbacks.insert(id, t) {
                        self.gl.delete_transform_feedback(old);
                    }
                }
                "deleteTransformFeedback" => {
                    if let Some(t) = self.feedbacks.remove(&u(1)) { self.gl.delete_transform_feedback(t); }
                }
                "bindTransformFeedback" => self.gl.bind_transform_feedback(u(1), self.feedbacks.get(&u(2)).copied()),
                "beginTransformFeedback" => self.gl.begin_transform_feedback(u(1)),
                "endTransformFeedback" => self.gl.end_transform_feedback(),
                "pauseTransformFeedback" => self.gl.pause_transform_feedback(),
                "resumeTransformFeedback" => self.gl.resume_transform_feedback(),
                "transformFeedbackVaryings" => {
                    if let Some(&p) = self.programs.get(&u(1)) {
                        let names = texts(2);
                        let names: Vec<&str> = names.iter().map(String::as_str).collect();
                        self.gl.transform_feedback_varyings(p, &names, u(3));
                    }
                }
                "getTransformFeedbackVarying" => {
                    let info = self.programs.get(&u(1)).and_then(|&p| self.gl.get_transform_feedback_varying(p, u(2)));
                    out = match info {
                        Some(v) => serde_json::json!([v.name, v.size, v.tftype]).to_string(),
                        None => "null".into(),
                    };
                }
                "enable" | "disable" => {
                    let on = op == "enable";
                    if u(1) == glow::SCISSOR_TEST {
                        self.state.scissor_test = on;
                    }
                    if on { self.gl.enable(u(1)) } else { self.gl.disable(u(1)) }
                }
                "viewport" => self.gl.viewport(int(1), int(2), int(3), int(4)),
                "scissor" => self.gl.scissor(int(1), int(2), int(3), int(4)),
                "clearColor" => {
                    self.state.clear_color = [f(1), f(2), f(3), f(4)];
                    self.gl.clear_color(f(1), f(2), f(3), f(4));
                }
                "clearDepth" => {
                    self.state.clear_depth = num(1);
                    self.set_clear_depth(num(1));
                }
                "clearStencil" => {
                    self.state.clear_stencil = int(1);
                    self.gl.clear_stencil(int(1));
                }
                "clear" => self.gl.clear(u(1)),
                "clearBufferfv" => {
                    let buf = u(1);
                    let need = match buf {
                        glow::COLOR => 4,
                        glow::DEPTH => 1,
                        _ => return Err(format!("InvalidEnumError: clearBufferfv buffer {buf:#x}")),
                    };
                    let v: Vec<f32> = nums(3).iter().map(|&x| x as f32).collect();
                    if v.len() < need {
                        return Err("InvalidValueError: clearBufferfv requires enough values".into());
                    }
                    self.gl.clear_buffer_f32_slice(buf, u(2), &v);
                }
                "clearBufferiv" => {
                    let buf = u(1);
                    let need = match buf {
                        glow::COLOR => 4,
                        glow::STENCIL => 1,
                        _ => return Err(format!("InvalidEnumError: clearBufferiv buffer {buf:#x}")),
                    };
                    let v: Vec<i32> = nums(3).iter().map(|&x| x as i32).collect();
                    if v.len() < need {
                        return Err("InvalidValueError: clearBufferiv requires enough values".into());
                    }
                    self.gl.clear_buffer_i32_slice(buf, u(2), &v);
                }
                "clearBufferuiv" => {
                    let buf = u(1);
                    if buf != glow::COLOR {
                        return Err(format!("InvalidEnumError: clearBufferuiv buffer {buf:#x}"));
                    }
                    let v: Vec<u32> = nums(3).iter().map(|&x| x as u32).collect();
                    if v.len() < 4 {
                        return Err("InvalidValueError: clearBufferuiv requires 4 values".into());
                    }
                    self.gl.clear_buffer_u32_slice(buf, u(2), &v);
                }
                "clearBufferfi" => self.gl.clear_buffer_depth_stencil(u(1), u(2), f(3), int(4)),
                "colorMask" => {
                    self.state.color_mask = [flag(1), flag(2), flag(3), flag(4)];
                    self.gl.color_mask(flag(1), flag(2), flag(3), flag(4));
                }
                "depthMask" => {
                    self.state.depth_mask = flag(1);
                    self.gl.depth_mask(flag(1));
                }
                "depthFunc" => self.gl.depth_func(u(1)),
                "depthRange" => {
                    if self.es {
                        self.gl.depth_range_f32(f(1), f(2));
                    } else {
                        self.gl.depth_range_f64(num(1), num(2));
                    }
                }
                "blendFuncSeparate" => self.gl.blend_func_separate(u(1), u(2), u(3), u(4)),
                "blendEquationSeparate" => self.gl.blend_equation_separate(u(1), u(2)),
                "blendColor" => self.gl.blend_color(f(1), f(2), f(3), f(4)),
                "cullFace" => self.gl.cull_face(u(1)),
                "frontFace" => self.gl.front_face(u(1)),
                "lineWidth" => self.gl.line_width(f(1)),
                "polygonOffset" => self.gl.polygon_offset(f(1), f(2)),
                "stencilFuncSeparate" => self.gl.stencil_func_separate(u(1), u(2), int(3), u(4)),
                "stencilOpSeparate" => self.gl.stencil_op_separate(u(1), u(2), u(3), u(4)),
                "stencilMaskSeparate" => {
                    let (face, mask) = (u(1), u(2));
                    if face != glow::BACK {
                        self.state.stencil_mask[0] = mask;
                    }
                    if face != glow::FRONT {
                        self.state.stencil_mask[1] = mask;
                    }
                    self.gl.stencil_mask_separate(face, mask);
                }
                "drawArrays" => {
                    let (first, count) = (int(2), int(3));
                    if first < 0 || count < 0 {
                        return Err("InvalidValueError: drawArrays negative first or count".into());
                    }
                    self.gl.draw_arrays(u(1), first, count);
                }
                "drawElements" => {
                    if self.state.current_element_buffer().is_none() {
                        return Err("InvalidOperationError: drawElements requires a bound ELEMENT_ARRAY_BUFFER".into());
                    }
                    let (count, offset) = (int(2), int(4));
                    if count < 0 || offset < 0 {
                        return Err("InvalidValueError: drawElements negative count or offset".into());
                    }
                    self.gl.draw_elements(u(1), count, u(3), offset);
                }
                "drawArraysInstanced" => {
                    let (first, count, instances) = (int(2), int(3), int(4));
                    if first < 0 || count < 0 || instances < 0 {
                        return Err("InvalidValueError: drawArraysInstanced negative argument".into());
                    }
                    self.gl.draw_arrays_instanced(u(1), first, count, instances);
                }
                "drawElementsInstanced" => {
                    if self.state.current_element_buffer().is_none() {
                        return Err("InvalidOperationError: drawElementsInstanced requires a bound ELEMENT_ARRAY_BUFFER".into());
                    }
                    let (count, offset, instances) = (int(2), int(4), int(5));
                    if count < 0 || offset < 0 || instances < 0 {
                        return Err("InvalidValueError: drawElementsInstanced negative argument".into());
                    }
                    self.gl.draw_elements_instanced(u(1), count, u(3), offset, instances);
                }
                "readPixels" => {
                    let (x, y, w, h, format, ty) = (int(1), int(2), int(3), int(4), u(5), u(6));
                    let resolved = self.begin_resolved_read();
                    if num(7) >= 0.0 {
                        if self.state.pack_buffer.is_none() {
                            self.end_resolved_read(resolved);
                            return Err("InvalidOperationError: readPixels PBO requires a bound PIXEL_PACK_BUFFER".into());
                        }
                        let pixels = glow::PixelPackData::BufferOffset(u(7));
                        self.gl.read_pixels(x, y, w, h, format, ty, pixels);
                    } else {
                        let len = self
                            .image_bytes(w, h, 1, format, ty, true)
                            .filter(|&len| len <= MAX_READ_BYTES)
                            .ok_or_else(|| {
                                self.end_resolved_read(resolved);
                                format!("InvalidOperationError: readPixels: format {format:#x}, type {ty:#x}, {w}x{h}")
                            })?;
                        let mut buf = vec![0u8; len];
                        self.gl.bind_buffer(glow::PIXEL_PACK_BUFFER, None);
                        self.gl.read_pixels(x, y, w, h, format, ty, glow::PixelPackData::Slice(Some(&mut buf)));
                        self.gl.bind_buffer(glow::PIXEL_PACK_BUFFER, self.state.pack_buffer);
                        out = len.to_string();
                        reply.bytes = Some(buf);
                    }
                    self.end_resolved_read(resolved);
                }
                "finish" => self.gl.finish(),
                "getError" => out = self.gl.get_error().to_string(),
                "present" => {
                    let (w, h) = (int(1), int(2));
                    self.resize(w, h);
                    let source = match self.resolve {
                        Some((resolve, _)) => {
                            self.resolve_canvas(resolve);
                            resolve
                        }
                        None => self.fbo,
                    };
                    let rgba_len = (self.width as usize)
                        .checked_mul(self.height as usize)
                        .and_then(|n| n.checked_mul(4))
                        .ok_or_else(|| "present: canvas size overflow".to_string())?;
                    let mut rgba = vec![0u8; rgba_len];
                    let gl = &self.gl;
                    gl.bind_framebuffer(glow::READ_FRAMEBUFFER, Some(source));
                    gl.bind_buffer(glow::PIXEL_PACK_BUFFER, None);
                    gl.pixel_store_i32(glow::PACK_ALIGNMENT, 1);
                    gl.pixel_store_i32(glow::PACK_ROW_LENGTH, 0);
                    gl.pixel_store_i32(glow::PACK_SKIP_ROWS, 0);
                    gl.pixel_store_i32(glow::PACK_SKIP_PIXELS, 0);
                    gl.read_pixels(0, 0, self.width, self.height, glow::RGBA, glow::UNSIGNED_BYTE, glow::PixelPackData::Slice(Some(&mut rgba)));
                    self.restore_state();
                    flip_rows(&mut rgba, self.width as usize * 4, self.height as usize);
                    if self.opaque {
                        for px in rgba.chunks_exact_mut(4) {
                            px[3] = 255;
                        }
                    }
                    reply.frame = Some(Frame { flid: self.flid, width: self.width as u32, height: self.height as u32, rgba });
                }
                _ => return Err("unsupported".into()),
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::translate_shader;

    #[test]
    fn es3_shaders_compile_as_glsl_330() {
        let out = translate_shader("#version 300 es\nprecision highp float;\nout highp vec4 c;\nvoid main(){ c = vec4(1); }");
        assert!(out.starts_with("#version 330\n"), "{out}");
        assert!(!out.contains("precision highp float;"), "{out}");
        assert!(out.contains("out highp vec4 c;"), "qualifiers on declarations stay: {out}");
        assert!(!out.contains("#define highp"), "{out}");
    }

    #[test]
    fn es1_shaders_compile_as_glsl_120() {
        let out = translate_shader("#extension GL_OES_standard_derivatives : enable\nprecision mediump float;\nvoid main(){}");
        assert!(out.starts_with("#version 120\n"), "{out}");
        assert!(out.contains("#define mediump\n"), "{out}");
        assert!(!out.contains("GL_OES_standard_derivatives"), "{out}");
        assert!(!out.contains("precision mediump float;"), "{out}");
    }
}

/// Contexts through WGL, all drawing through one hidden window.
#[cfg(windows)]
mod wgl {
    use std::ffi::{CString, c_void};

    use windows::Win32::Foundation::{HMODULE, HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::Graphics::Gdi::{GetDC, HDC};
    use windows::Win32::Graphics::OpenGL::{
        ChoosePixelFormat, HGLRC, PFD_DOUBLEBUFFER, PFD_DRAW_TO_WINDOW, PFD_MAIN_PLANE, PFD_SUPPORT_OPENGL,
        PFD_TYPE_RGBA, PIXELFORMATDESCRIPTOR, SetPixelFormat, wglCreateContext, wglDeleteContext, wglGetProcAddress,
        wglMakeCurrent,
    };
    use windows::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress, LoadLibraryA};
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, RegisterClassW, WINDOW_EX_STYLE, WNDCLASSW, WS_OVERLAPPEDWINDOW,
    };
    use windows::core::{PCSTR, s, w};

    pub(super) type RawContext = HGLRC;

    /// The hidden window's procedure: it handles nothing itself.
    unsafe extern "system" fn window_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
    }

    /// The hidden window every context draws through.
    pub(super) struct Platform {
        dc: HDC,
        opengl32: HMODULE,
    }

    impl Platform {
        /// Always desktop OpenGL.
        pub(super) fn es(&self) -> bool {
            false
        }

        pub(super) fn new() -> Result<Self, String> {
            unsafe {
                let instance = GetModuleHandleW(None).map_err(|e| e.to_string())?;
                let class = WNDCLASSW {
                    lpfnWndProc: Some(window_proc),
                    hInstance: instance.into(),
                    lpszClassName: w!("ZippWebGL"),
                    ..Default::default()
                };
                RegisterClassW(&class);
                let hwnd: HWND = CreateWindowExW(
                    WINDOW_EX_STYLE(0),
                    w!("ZippWebGL"),
                    w!("Zipp WebGL"),
                    WS_OVERLAPPEDWINDOW,
                    0,
                    0,
                    16,
                    16,
                    None,
                    None,
                    Some(instance.into()),
                    None,
                )
                .map_err(|e| e.to_string())?;
                let dc = GetDC(Some(hwnd));
                let pfd = PIXELFORMATDESCRIPTOR {
                    nSize: std::mem::size_of::<PIXELFORMATDESCRIPTOR>() as u16,
                    nVersion: 1,
                    dwFlags: PFD_DRAW_TO_WINDOW | PFD_SUPPORT_OPENGL | PFD_DOUBLEBUFFER,
                    iPixelType: PFD_TYPE_RGBA,
                    cColorBits: 32,
                    cDepthBits: 24,
                    cStencilBits: 8,
                    iLayerType: PFD_MAIN_PLANE.0 as u8,
                    ..Default::default()
                };
                let format = ChoosePixelFormat(dc, &pfd);
                if format == 0 {
                    return Err("no pixel format".into());
                }
                SetPixelFormat(dc, format, &pfd).map_err(|e| e.to_string())?;
                let opengl32 = LoadLibraryA(s!("opengl32.dll")).map_err(|e| e.to_string())?;
                Ok(Platform { dc, opengl32 })
            }
        }

        pub(super) fn proc_address(&self, name: &str) -> *const c_void {
            let opengl32 = self.opengl32;
            let Ok(c) = CString::new(name) else {
                return std::ptr::null();
            };
            unsafe {
                let p = wglGetProcAddress(PCSTR(c.as_ptr() as *const u8)).map(|f| f as usize).unwrap_or(0);
                // wglGetProcAddress answers 1, 2, 3 or -1 for "not mine": the
                // OpenGL 1.1 entry points live in opengl32.dll itself.
                if p > 3 && p != usize::MAX {
                    return p as *const c_void;
                }
                GetProcAddress(opengl32, PCSTR(c.as_ptr() as *const u8)).map(|f| f as usize).unwrap_or(0) as *const c_void
            }
        }

        /// A new context, current.
        pub(super) unsafe fn create(&self) -> Result<RawContext, String> {
            unsafe {
                let hglrc = wglCreateContext(self.dc).map_err(|e| e.to_string())?;
                wglMakeCurrent(self.dc, hglrc).map_err(|e| e.to_string())?;
                Ok(hglrc)
            }
        }

        /// Make `raw` current, or none.
        pub(super) unsafe fn make_current(&self, raw: Option<RawContext>) -> bool {
            unsafe { wglMakeCurrent(self.dc, raw.unwrap_or_default()) }.is_ok()
        }

        pub(super) unsafe fn destroy(&self, raw: RawContext) {
            let _ = unsafe { wglDeleteContext(raw) };
        }
    }
}

/// Android EGL + OpenGL ES 3 offscreen pbuffer contexts (`libEGL.so` + `libGLESv2.so`).
/// Uses a 1×1 pbuffer surface so hardware GPU rendering works on 100% of Android
/// drivers and emulators (even those without `EGL_KHR_surfaceless_context`), while
/// every WebGL canvas renders into its own FBO.
mod egl {
    use std::ffi::{CStr, CString, c_char, c_void};

    pub(super) type RawContext = *mut c_void;
    type Display = *mut c_void;
    type Config = *mut c_void;
    type Surface = *mut c_void;

    const EGL_NONE: i32 = 0x3038;
    const EGL_OPENGL_ES_API: u32 = 0x30A0;
    const EGL_OPENGL_ES3_BIT: i32 = 0x0040;
    const EGL_OPENGL_ES2_BIT: i32 = 0x0004;
    const EGL_CONTEXT_MAJOR_VERSION: i32 = 0x3098;
    const EGL_SURFACE_TYPE: i32 = 0x3033;
    const EGL_PBUFFER_BIT: i32 = 0x0001;
    const EGL_RENDERABLE_TYPE: i32 = 0x3040;
    const EGL_RED_SIZE: i32 = 0x3024;
    const EGL_GREEN_SIZE: i32 = 0x3023;
    const EGL_BLUE_SIZE: i32 = 0x3022;
    const EGL_ALPHA_SIZE: i32 = 0x3021;
    const EGL_DEPTH_SIZE: i32 = 0x3025;
    const EGL_STENCIL_SIZE: i32 = 0x3026;
    const EGL_WIDTH: i32 = 0x3057;
    const EGL_HEIGHT: i32 = 0x3056;
    const EGL_VENDOR: i32 = 0x3053;

    pub(super) struct Platform {
        _egl_lib: libloading::Library,
        gles_lib: Option<libloading::Library>,
        display: Display,
        config: Config,
        surface: Surface,
        get_proc_address: unsafe extern "C" fn(*const c_char) -> *const c_void,
        create_context: unsafe extern "C" fn(Display, Config, RawContext, *const i32) -> RawContext,
        make_current: unsafe extern "C" fn(Display, Surface, Surface, RawContext) -> u32,
        destroy_context: unsafe extern "C" fn(Display, RawContext) -> u32,
        destroy_surface: unsafe extern "C" fn(Display, Surface) -> u32,
        terminate: unsafe extern "C" fn(Display) -> u32,
        get_error: unsafe extern "C" fn() -> i32,
        gles_major: i32,
    }

    impl Platform {
        pub(super) fn new() -> Result<Self, String> {
            unsafe {
                let lib = libloading::Library::new("libEGL.so").map_err(|e| e.to_string())?;
                let gles_lib = libloading::Library::new("libGLESv3.so")
                    .or_else(|_| libloading::Library::new("libGLESv2.so"))
                    .ok();
                macro_rules! sym {
                    ($name:literal) => {
                        *lib.get(concat!($name, "\0").as_bytes())
                            .map_err(|e| format!("{}: {e}", $name))?
                    };
                }
                let get_display: unsafe extern "C" fn(*mut c_void) -> Display = sym!("eglGetDisplay");
                let initialize: unsafe extern "C" fn(Display, *mut i32, *mut i32) -> u32 = sym!("eglInitialize");
                let bind_api: unsafe extern "C" fn(u32) -> u32 = sym!("eglBindAPI");
                let choose_config: unsafe extern "C" fn(Display, *const i32, *mut Config, i32, *mut i32) -> u32 =
                    sym!("eglChooseConfig");
                let create_pbuffer: unsafe extern "C" fn(Display, Config, *const i32) -> Surface =
                    sym!("eglCreatePbufferSurface");
                let query_string: unsafe extern "C" fn(Display, i32) -> *const c_char = sym!("eglQueryString");
                let get_error: unsafe extern "C" fn() -> i32 = sym!("eglGetError");

                let display = get_display(std::ptr::null_mut());
                if display.is_null() {
                    return Err(format!("eglGetDisplay failed (0x{:x})", get_error()));
                }
                let (mut major, mut minor) = (0, 0);
                if initialize(display, &mut major, &mut minor) == 0 {
                    return Err(format!("eglInitialize: 0x{:x}", get_error()));
                }
                if bind_api(EGL_OPENGL_ES_API) == 0 {
                    return Err(format!("eglBindAPI(GLES): 0x{:x}", get_error()));
                }

                let try_config = |renderable: i32, depth: i32| -> Option<Config> {
                    let attrs = [
                        EGL_RENDERABLE_TYPE, renderable,
                        EGL_SURFACE_TYPE, EGL_PBUFFER_BIT,
                        EGL_RED_SIZE, 8,
                        EGL_GREEN_SIZE, 8,
                        EGL_BLUE_SIZE, 8,
                        EGL_ALPHA_SIZE, 8,
                        EGL_DEPTH_SIZE, depth,
                        EGL_STENCIL_SIZE, 8,
                        EGL_NONE,
                    ];
                    let (mut cfg, mut count) = (std::ptr::null_mut(), 0);
                    if choose_config(display, attrs.as_ptr(), &mut cfg, 1, &mut count) != 0 && count >= 1 && !cfg.is_null() {
                        Some(cfg)
                    } else {
                        None
                    }
                };
                let (config, gles_major) = if let Some(c) = try_config(EGL_OPENGL_ES3_BIT, 24).or_else(|| try_config(EGL_OPENGL_ES3_BIT, 16)) {
                    (c, 3)
                } else if let Some(c) = try_config(EGL_OPENGL_ES2_BIT, 24).or_else(|| try_config(EGL_OPENGL_ES2_BIT, 16)) {
                    (c, 2)
                } else {
                    return Err(format!("eglChooseConfig failed (0x{:x})", get_error()));
                };

                let pbuf_attrs = [EGL_WIDTH, 1, EGL_HEIGHT, 1, EGL_NONE];
                let surface = create_pbuffer(display, config, pbuf_attrs.as_ptr());
                if surface.is_null() {
                    return Err(format!("eglCreatePbufferSurface failed (0x{:x})", get_error()));
                }

                let vendor = query_string(display, EGL_VENDOR);
                let vendor = if vendor.is_null() {
                    "?".into()
                } else {
                    CStr::from_ptr(vendor).to_string_lossy()
                };
                log::info!("WebGL initialized: Android EGL {major}.{minor} ({vendor}), OpenGL ES {gles_major}");

                Ok(Platform {
                    get_proc_address: sym!("eglGetProcAddress"),
                    create_context: sym!("eglCreateContext"),
                    make_current: sym!("eglMakeCurrent"),
                    destroy_context: sym!("eglDestroyContext"),
                    destroy_surface: sym!("eglDestroySurface"),
                    terminate: sym!("eglTerminate"),
                    get_error,
                    display,
                    config,
                    surface,
                    gles_major,
                    _egl_lib: lib,
                    gles_lib,
                })
            }
        }

        pub(super) fn es(&self) -> bool {
            true
        }

        pub(super) fn proc_address(&self, name: &str) -> *const c_void {
            let Ok(c) = CString::new(name) else {
                return std::ptr::null();
            };
            unsafe {
                let p = (self.get_proc_address)(c.as_ptr());
                if !p.is_null() {
                    return p;
                }
                if let Some(ref gles) = self.gles_lib {
                    if let Ok(sym) = gles.get::<*const c_void>(c.as_bytes_with_nul()) {
                        return *sym;
                    }
                }
                std::ptr::null()
            }
        }

        pub(super) unsafe fn create(&self) -> Result<RawContext, String> {
            unsafe {
                let attributes = [EGL_CONTEXT_MAJOR_VERSION, self.gles_major, EGL_NONE];
                let raw = (self.create_context)(self.display, self.config, std::ptr::null_mut(), attributes.as_ptr());
                if raw.is_null() {
                    return Err(format!("eglCreateContext: 0x{:x}", (self.get_error)()));
                }
                if !self.make_current(Some(raw)) {
                    let error = (self.get_error)();
                    self.destroy(raw);
                    return Err(format!("eglMakeCurrent: 0x{error:x}"));
                }
                Ok(raw)
            }
        }

        pub(super) unsafe fn make_current(&self, raw: Option<RawContext>) -> bool {
            let none = std::ptr::null_mut();
            let (surf, ctx) = match raw {
                Some(c) => (self.surface, c),
                None => (none, none),
            };
            unsafe { (self.make_current)(self.display, surf, surf, ctx) != 0 }
        }

        pub(super) unsafe fn destroy(&self, raw: RawContext) {
            unsafe {
                (self.destroy_context)(self.display, raw);
            }
        }
    }

    impl Drop for Platform {
        fn drop(&mut self) {
            unsafe {
                let none = std::ptr::null_mut();
                (self.make_current)(self.display, none, none, none);
                if !self.surface.is_null() {
                    (self.destroy_surface)(self.display, self.surface);
                    self.surface = none;
                }
                if !self.display.is_null() {
                    (self.terminate)(self.display);
                    self.display = none;
                }
            }
        }
    }
}
