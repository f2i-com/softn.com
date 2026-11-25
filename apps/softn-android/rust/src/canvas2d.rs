//! Canvas 2D (`getContext("2d")`), drawn on the CPU with tiny-skia.
//!
//! The page side is `canvas2d_shim.js`: a `CanvasRenderingContext2D` that
//! records its calls into a batch, sent with the `c2d` host call at the end of
//! each frame and whenever a call needs an answer (`getImageData`,
//! `measureText`, `toDataURL`). Here each canvas is a pixmap with the drawing
//! state the spec gives it -- transform, styles, clip, the current path, the
//! save/restore stack -- and `present` hands its picture to the canvas element
//! (`canvas::push_frame`), as WebGL's frames are.
//!
//! Paths are kept in device space, each point transformed as it is added, as
//! the spec has it; strokes are made in the user space of the moment, so line
//! widths scale with the transform. Text comes from the embedded Liberation
//! faces (zipp-dom's), its glyph outlines filled as paths, without shaping or
//! kerning. Shadows and filters are not drawn.

use std::cell::RefCell;
use std::collections::HashMap;
use std::f32::consts::{FRAC_PI_2, TAU};
use std::sync::Arc;

use serde_json::Value as Json;
use skrifa::instance::{LocationRef, Size};
use skrifa::outline::{DrawSettings, OutlinePen};
use skrifa::{FontRef, MetadataProvider};
use tiny_skia::{
    BlendMode, Color, FillRule, FilterQuality, GradientStop, IntRect, IntSize, LineCap, LineJoin, LinearGradient, Mask,
    Paint, Path, PathBuilder, Pattern, Pixmap, Point, RadialGradient, Shader, SpreadMode, Stroke, StrokeDash,
    Transform,
};
use zipp_vm::embed::HostCtx;

use crate::bundle::{strip_virtual_origin, SoftnBundle};
use crate::canvas::Frame;
use crate::http_cache::BlobStore;

const MAX_CANVAS_DIM: u32 = 4096;
const MAX_CANVAS_READ_BYTES: usize = 64 * 1024 * 1024;
const MAX_CANVAS_TOTAL_BYTES: usize = 128 * 1024 * 1024;
const MAX_PATH_SEGS: usize = 131_072;
const MAX_DATA_URL_BYTES: usize = 32 * 1024 * 1024;
const MAX_CANVASES: usize = 64;
const MAX_GRADIENTS: usize = 4096;
const MAX_PATTERNS: usize = 1024;
const MAX_PATTERN_CACHE_BYTES: usize = 64 * 1024 * 1024;
const MAX_SVG_INPUT_BYTES: usize = 8 * 1024 * 1024;
const MAX_SVG_EMBEDDED_IMAGES: usize = 8;
const MAX_SVG_DECODED_IMAGE_BYTES: usize = 32 * 1024 * 1024;
const MAX_SVG_IMAGE_DIM: u32 = 4096;
const MAX_IMAGES: usize = 128;
const MAX_IMAGE_CACHE_BYTES: usize = 64 * 1024 * 1024;
const MAX_SAVE_STACK: usize = 256;

fn safe_fill_path(
    pixmap: &mut Pixmap,
    path: &Path,
    paint: &Paint,
    rule: FillRule,
    transform: Transform,
    mask: Option<&Mask>,
) {
    let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        pixmap.fill_path(path, paint, rule, transform, mask);
    }));
    if res.is_err() {
        let mut fallback = paint.clone();
        fallback.anti_alias = false;
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            pixmap.fill_path(path, &fallback, rule, transform, mask);
        }));
    }
}

fn safe_stroke_path(
    pixmap: &mut Pixmap,
    path: &Path,
    paint: &Paint,
    stroke: &Stroke,
    transform: Transform,
    mask: Option<&Mask>,
) {
    let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        pixmap.stroke_path(path, paint, stroke, transform, mask);
    }));
    if res.is_err() {
        let mut fallback = paint.clone();
        fallback.anti_alias = false;
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            pixmap.stroke_path(path, &fallback, stroke, transform, mask);
        }));
    }
}

/// A path, in device space: tiny-skia's builder cannot be read back or
/// reused, and a canvas fills and strokes the same path.
#[derive(Clone, Default)]
struct SegPath {
    segs: Vec<Seg>,
    /// The current point, and where the current subpath began.
    current: Option<Point>,
    start: Option<Point>,
}

#[derive(Clone, Copy)]
enum Seg {
    Move(Point),
    Line(Point),
    Quad(Point, Point),
    Cubic(Point, Point, Point),
    Close,
}

fn map(t: &Transform, x: f32, y: f32) -> Point {
    Point::from_xy(t.sx * x + t.kx * y + t.tx, t.ky * x + t.sy * y + t.ty)
}

impl SegPath {
    fn move_to(&mut self, p: Point) {
        if self.segs.len() >= MAX_PATH_SEGS {
            return;
        }
        self.segs.push(Seg::Move(p));
        self.current = Some(p);
        self.start = Some(p);
    }
    /// A line, or (with no current point) the start of a subpath.
    fn line_to(&mut self, p: Point) {
        if self.current.is_none() {
            return self.move_to(p);
        }
        if self.segs.len() >= MAX_PATH_SEGS {
            return;
        }
        self.segs.push(Seg::Line(p));
        self.current = Some(p);
    }
    fn quad_to(&mut self, c: Point, p: Point) {
        if self.current.is_none() {
            self.move_to(c);
        }
        if self.segs.len() >= MAX_PATH_SEGS {
            return;
        }
        self.segs.push(Seg::Quad(c, p));
        self.current = Some(p);
    }
    fn cubic_to(&mut self, c1: Point, c2: Point, p: Point) {
        if self.current.is_none() {
            self.move_to(c1);
        }
        if self.segs.len() >= MAX_PATH_SEGS {
            return;
        }
        self.segs.push(Seg::Cubic(c1, c2, p));
        self.current = Some(p);
    }
    fn close(&mut self) {
        if self.current.is_some() {
            if self.segs.len() < MAX_PATH_SEGS {
                self.segs.push(Seg::Close);
            }
            self.current = self.start;
        }
    }

    fn to_path(&self) -> Option<Path> {
        let mut b = PathBuilder::new();
        for seg in &self.segs {
            match *seg {
                Seg::Move(p) => b.move_to(p.x, p.y),
                Seg::Line(p) => b.line_to(p.x, p.y),
                Seg::Quad(c, p) => b.quad_to(c.x, c.y, p.x, p.y),
                Seg::Cubic(c1, c2, p) => b.cubic_to(c1.x, c1.y, c2.x, c2.y, p.x, p.y),
                Seg::Close => b.close(),
            }
        }
        b.finish()
    }

    /// An arc of the ellipse at (cx, cy), in user space under `t`, from
    /// angle `a0` round to `a1`, joined to the path by a line.
    #[allow(clippy::too_many_arguments)]
    fn ellipse(&mut self, t: &Transform, cx: f32, cy: f32, rx: f32, ry: f32, rotation: f32, a0: f32, a1: f32, ccw: bool) {
        let mut sweep = a1 - a0;
        if !ccw {
            sweep = if sweep >= TAU { TAU } else { sweep.rem_euclid(TAU) };
        } else {
            sweep = if -sweep >= TAU { -TAU } else { -(-sweep).rem_euclid(TAU) };
        }
        let (rs, rc) = rotation.sin_cos();
        let point = |a: f32| {
            let (s, c) = a.sin_cos();
            let (x, y) = (rx * c, ry * s);
            map(t, cx + x * rc - y * rs, cy + x * rs + y * rc)
        };
        let tangent = |a: f32, k: f32| {
            let (s, c) = a.sin_cos();
            let (x, y) = (-rx * s * k, ry * c * k);
            (x * rc - y * rs, x * rs + y * rc)
        };
        let first = point(a0);
        if self.current.is_some() {
            self.line_to(first);
        } else {
            self.move_to(first);
        }
        if sweep == 0.0 {
            return;
        }
        let n = (sweep.abs() / FRAC_PI_2).ceil().max(1.0) as usize;
        let step = sweep / n as f32;
        let k = 4.0 / 3.0 * (step / 4.0).tan();
        let mut a = a0;
        for _ in 0..n {
            let b = a + step;
            let (s0, c0) = a.sin_cos();
            let (s1, c1) = b.sin_cos();
            let (x0, y0) = (rx * c0, ry * s0);
            let (x1, y1) = (rx * c1, ry * s1);
            let (d0x, d0y) = tangent(a, k);
            let (d1x, d1y) = tangent(b, k);
            let p0 = (cx + x0 * rc - y0 * rs, cy + x0 * rs + y0 * rc);
            let p1 = (cx + x1 * rc - y1 * rs, cy + x1 * rs + y1 * rc);
            self.cubic_to(map(t, p0.0 + d0x, p0.1 + d0y), map(t, p1.0 - d1x, p1.1 - d1y), map(t, p1.0, p1.1));
            a = b;
        }
    }
}

#[derive(Clone)]
enum Style {
    Color(Color),
    Gradient(u32),
    Pattern(u32),
}

#[derive(Clone, Copy, PartialEq)]
enum Align {
    Left,
    Right,
    Center,
}

#[derive(Clone)]
struct Font {
    size: f32,
    bold: bool,
    italic: bool,
    family: String,
}

impl Font {
    /// A CSS `font` shorthand: `italic bold 16px/1.2 "Fira Code", monospace`.
    fn parse(css: &str) -> Option<Font> {
        let mut font = Font { size: 10.0, bold: false, italic: false, family: "sans-serif".into() };
        let mut rest = css.trim();
        loop {
            let (word, after) = rest.split_once(char::is_whitespace).unwrap_or((rest, ""));
            let lower = word.to_ascii_lowercase();
            let size = lower.split('/').next().unwrap_or("");
            if let Some(px) = size.strip_suffix("px") {
                font.size = px.parse().ok()?;
            } else if let Some(pt) = size.strip_suffix("pt") {
                font.size = pt.parse::<f32>().ok()? * 4.0 / 3.0;
            } else if let Some(em) = size.strip_suffix("em").or_else(|| size.strip_suffix("rem")) {
                font.size = em.parse::<f32>().ok()? * 16.0;
            } else if let Some(pc) = size.strip_suffix('%') {
                font.size = pc.parse::<f32>().ok()? * 0.16;
            } else {
                match lower.as_str() {
                    "italic" | "oblique" => font.italic = true,
                    "bold" | "bolder" | "600" | "700" | "800" | "900" => font.bold = true,
                    "normal" | "lighter" | "100" | "200" | "300" | "400" | "500" | "small-caps" => {}
                    _ => return None,
                }
                rest = after.trim_start();
                continue;
            }
            if !font.size.is_finite() || font.size <= 0.0 {
                return None;
            }
            font.size = font.size.clamp(0.5, 2048.0);
            font.family = after.trim().to_string();
            return Some(font);
        }
    }
}

#[derive(Clone)]
struct State {
    transform: Transform,
    fill: Style,
    stroke: Style,
    line_width: f32,
    line_cap: LineCap,
    line_join: LineJoin,
    miter_limit: f32,
    dash: Vec<f32>,
    dash_offset: f32,
    alpha: f32,
    blend: BlendMode,
    font: Font,
    align: Align,
    /// Where the baseline is, as a fraction of (ascent, descent) to move by.
    baseline: String,
    smoothing: bool,
    clip: Option<Arc<Mask>>,
}

impl Default for State {
    fn default() -> Self {
        State {
            transform: Transform::identity(),
            fill: Style::Color(Color::BLACK),
            stroke: Style::Color(Color::BLACK),
            line_width: 1.0,
            line_cap: LineCap::Butt,
            line_join: LineJoin::Miter,
            miter_limit: 10.0,
            dash: Vec::new(),
            dash_offset: 0.0,
            alpha: 1.0,
            blend: BlendMode::SourceOver,
            font: Font { size: 10.0, bold: false, italic: false, family: "sans-serif".into() },
            align: Align::Left,
            baseline: "alphabetic".into(),
            smoothing: true,
            clip: None,
        }
    }
}

struct Canvas2D {
    flid: u32,
    pixmap: Pixmap,
    opaque: bool,
    state: State,
    stack: Vec<State>,
    path: SegPath,
}

enum GradientKind {
    Linear(f32, f32, f32, f32),
    Radial(f32, f32, f32, f32, f32, f32),
    Conic,
}

struct Gradient {
    kind: GradientKind,
    stops: Vec<(f32, Color)>,
}

struct PatternSource {
    pixmap: Arc<Pixmap>,
    repeat: bool,
}

thread_local! {
    static CANVASES: RefCell<HashMap<u32, Canvas2D>> = RefCell::new(HashMap::new());
    static GRADIENTS: RefCell<HashMap<u32, Gradient>> = RefCell::new(HashMap::new());
    static PATTERNS: RefCell<HashMap<u32, PatternSource>> = RefCell::new(HashMap::new());
    static PATTERN_CACHE_BYTES: RefCell<usize> = const { RefCell::new(0) };
    /// Decoded images, by URL, for `drawImage` and patterns.
    static IMAGES: RefCell<HashMap<String, Arc<Pixmap>>> = RefCell::new(HashMap::new());
    static IMAGE_CACHE_BYTES: RefCell<usize> = const { RefCell::new(0) };
}

/// Clear cached decoded images on the current thread (used on Clear Cache).
pub(crate) fn clear_image_cache() {
    IMAGES.with(|i| i.borrow_mut().clear());
    IMAGE_CACHE_BYTES.with(|b| *b.borrow_mut() = 0);
}

/// Drop all Canvas 2D state on the current thread (used on bundle switch / engine drop).
pub(crate) fn reset_all() {
    CANVASES.with(|c| c.borrow_mut().clear());
    GRADIENTS.with(|g| g.borrow_mut().clear());
    PATTERNS.with(|p| p.borrow_mut().clear());
    PATTERN_CACHE_BYTES.with(|b| *b.borrow_mut() = 0);
    COLOR_CACHE.with(|c| c.borrow_mut().clear());
    clear_image_cache();
}

/// Sanitize untrusted SVG bytes before handing them to `zipp_renderer::rasterize_svg` / `svg_size`.
///
/// `usvg::Options::default()` resolves local filesystem paths in `<image href="...">` and
/// decodes unbounded embedded `data:` images. This sanitizer strips DTD/ENTITY declarations,
/// strips all non-`#` `href`/`xlink:href` references except bounded raster `data:image/*;base64`
/// images (capped at 8 images / 32 MiB total decoded pixels), and strips non-`#` CSS `url(...)`.
pub(crate) fn sanitize_svg_for_raster(raw: &[u8]) -> Option<Vec<u8>> {
    if raw.is_empty() || raw.len() > MAX_SVG_INPUT_BYTES {
        return None;
    }
    let text = std::str::from_utf8(raw).ok()?;
    let lower_full = text.to_ascii_lowercase();
    if lower_full.contains("<!entity") || lower_full.contains("<!doctype") {
        return None;
    }

    let bytes = text.as_bytes();
    let len = bytes.len();
    let mut out = String::with_capacity(len);
    let mut i = 0usize;
    let mut img_count = 0usize;
    let mut img_decoded_bytes = 0usize;

    let validate_data_image = |val: &str, count: &mut usize, total_bytes: &mut usize| -> bool {
        let trimmed = val.trim();
        if trimmed.contains('&') {
            return false;
        }
        let lower = trimmed.to_ascii_lowercase();
        let rest = if let Some(r) = lower.strip_prefix("data:image/png;base64,") {
            &trimmed[trimmed.len() - r.len()..]
        } else if let Some(r) = lower.strip_prefix("data:image/jpeg;base64,") {
            &trimmed[trimmed.len() - r.len()..]
        } else if let Some(r) = lower.strip_prefix("data:image/jpg;base64,") {
            &trimmed[trimmed.len() - r.len()..]
        } else if let Some(r) = lower.strip_prefix("data:image/gif;base64,") {
            &trimmed[trimmed.len() - r.len()..]
        } else if let Some(r) = lower.strip_prefix("data:image/webp;base64,") {
            &trimmed[trimmed.len() - r.len()..]
        } else {
            return false;
        };
        if *count >= MAX_SVG_EMBEDDED_IMAGES || rest.len() > 11_000_000 {
            return false;
        }
        let cleaned_b64: String = rest.chars().filter(|c| !c.is_ascii_whitespace()).collect();
        use base64::Engine as _;
        let Ok(decoded) = base64::engine::general_purpose::STANDARD.decode(&cleaned_b64) else {
            return false;
        };
        if decoded.len() > 8 * 1024 * 1024 {
            return false;
        }
        let Ok(reader) = image::ImageReader::new(std::io::Cursor::new(&decoded)).with_guessed_format() else {
            return false;
        };
        let Ok((w, h)) = reader.into_dimensions() else {
            return false;
        };
        if w == 0 || h == 0 || w > MAX_SVG_IMAGE_DIM || h > MAX_SVG_IMAGE_DIM {
            return false;
        }
        let Some(px_bytes) = (w as usize).checked_mul(h as usize).and_then(|n| n.checked_mul(4)) else {
            return false;
        };
        let next_total = total_bytes.saturating_add(px_bytes);
        if next_total > MAX_SVG_DECODED_IMAGE_BYTES {
            return false;
        }
        *count += 1;
        *total_bytes = next_total;
        true
    };

    while i < len {
        // Match `href` / `xlink:href` / `<prefix>:href` attributes (case-insensitive)
        if (bytes[i] == b'h' || bytes[i] == b'H')
            && i + 4 <= len
            && bytes[i..i + 4].eq_ignore_ascii_case(b"href")
            && (i == 0 || !(bytes[i - 1].is_ascii_alphanumeric() || bytes[i - 1] == b'_' || bytes[i - 1] == b'-'))
        {
            let mut j = i + 4;
            while j < len && bytes[j].is_ascii_whitespace() {
                j += 1;
            }
            if j < len && bytes[j] == b'=' {
                j += 1;
                while j < len && bytes[j].is_ascii_whitespace() {
                    j += 1;
                }
                if j < len && (bytes[j] == b'"' || bytes[j] == b'\'') {
                    let quote = bytes[j];
                    let val_start = j + 1;
                    let mut val_end = val_start;
                    while val_end < len && bytes[val_end] != quote {
                        val_end += 1;
                    }
                    let val = &text[val_start..val_end];
                    let trimmed = val.trim();
                    let keep = (trimmed.starts_with('#') && !trimmed.contains('&'))
                        || validate_data_image(trimmed, &mut img_count, &mut img_decoded_bytes);
                    out.push_str(&text[i..val_start]);
                    if keep {
                        out.push_str(val);
                    }
                    if val_end < len {
                        out.push(quote as char);
                        i = val_end + 1;
                    } else {
                        i = val_end;
                    }
                    continue;
                }
            }
        }
        // Strip non-fragment CSS `url(...)` references
        if (bytes[i] == b'u' || bytes[i] == b'U')
            && i + 4 <= len
            && bytes[i..i + 4].eq_ignore_ascii_case(b"url(")
            && (i == 0 || !(bytes[i - 1].is_ascii_alphanumeric() || bytes[i - 1] == b'_' || bytes[i - 1] == b'-'))
        {
            let inner_start = i + 4;
            if let Some(rel_close) = text[inner_start..].find(')') {
                let inner = text[inner_start..inner_start + rel_close]
                    .trim()
                    .trim_matches(|c| c == '"' || c == '\'')
                    .trim();
                if inner.starts_with('#') && !inner.contains('&') {
                    out.push_str(&text[i..inner_start + rel_close + 1]);
                } else {
                    out.push_str("none");
                }
                i = inner_start + rel_close + 1;
                continue;
            }
        }
        let ch = text[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    Some(out.into_bytes())
}

#[derive(Default)]
struct Reply {
    result: String,
    bytes: Option<Vec<u8>>,
    error: Option<String>,
}

/// `__zippHostCall("c2d", context, batch, payloadLength)`.
pub(crate) fn host_call(
    ctx: &mut dyn HostCtx,
    bundle: &SoftnBundle,
    blobs: &BlobStore,
    args: &[String],
) -> Result<String, String> {
    let context: u32 = args.first().and_then(|a| a.parse().ok()).ok_or("Error: c2d: no context")?;
    let cmds: Vec<Json> = match serde_json::from_str(args.get(1).map(String::as_str).unwrap_or("[]")) {
        Ok(Json::Array(c)) => c,
        _ => return Err("Error: c2d: malformed batch".into()),
    };
    let len: usize = args.get(2).and_then(|a| a.parse().ok()).unwrap_or(0);
    if len > MAX_CANVAS_READ_BYTES {
        return Err("Error: c2d: payload exceeds 64 MiB limit".into());
    }
    let payload = if len > 0 {
        let (addr, count, kind) = ctx.typed_array_region("__zippHostBytes")?;
        if kind != 1 || count < len || addr == 0 {
            return Err("Error: c2d: __zippHostBytes is not the batch's bytes".into());
        }
        // SAFETY: the engine pinned `count` bytes at non-null `addr` for this call.
        unsafe { std::slice::from_raw_parts(addr as *const u8, len) }.to_vec()
    } else {
        Vec::new()
    };
    let mut reply = Reply::default();
    for cmd in &cmds {
        if let Err(e) = run(context, cmd, &payload, Some(bundle), Some(blobs), &mut reply) {
            let op = cmd.get(0).and_then(Json::as_str).unwrap_or("?");
            reply.error = Some(format!("{op}: {e}"));
        }
    }
    if let Some(error) = reply.error {
        #[cfg(target_os = "android")]
        log::warn!("Canvas 2D: {error}");
        #[cfg(not(target_os = "android"))]
        eprintln!("[CANVAS] {error}");
    }
    if let Some(bytes) = reply.bytes {
        if !bytes.is_empty() {
            let (addr, count, kind) = ctx.typed_array_region("__zippHostBytes")?;
            if kind == 1 && addr != 0 {
                // SAFETY: non-null pinned buffer; never more than the array holds.
                unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), addr as *mut u8, bytes.len().min(count)) };
            }
        }
    }
    Ok(reply.result)
}

fn clamp_canvas_dims(w: f64, h: f64) -> (u32, u32) {
    let cw = if !w.is_finite() || w < 1.0 {
        1
    } else {
        (w as u32).min(MAX_CANVAS_DIM)
    };
    let ch = if !h.is_finite() || h < 1.0 {
        1
    } else {
        (h as u32).min(MAX_CANVAS_DIM)
    };
    (cw, ch)
}

fn new_pixmap(w: f64, h: f64) -> Pixmap {
    let (cw, ch) = clamp_canvas_dims(w, h);
    Pixmap::new(cw, ch).unwrap_or_else(|| Pixmap::new(1, 1).unwrap())
}

fn canvas_mem_bytes(c: &Canvas2D) -> usize {
    let mut total = c.pixmap.data().len();
    let mut seen: Vec<*const Mask> = Vec::new();
    let mut add_mask = |m: &Option<Arc<Mask>>| {
        if let Some(arc) = m {
            let ptr = Arc::as_ptr(arc);
            if !seen.contains(&ptr) {
                seen.push(ptr);
                total = total.saturating_add(arc.data().len());
            }
        }
    };
    add_mask(&c.state.clip);
    for s in &c.stack {
        add_mask(&s.clip);
    }
    total
}

fn total_canvases_mem_bytes(map: &HashMap<u32, Canvas2D>, exclude_ctx: Option<u32>) -> usize {
    map.iter()
        .filter(|(&id, _)| Some(id) != exclude_ctx)
        .map(|(_, c)| canvas_mem_bytes(c))
        .fold(0usize, usize::saturating_add)
}

thread_local! {
    static COLOR_CACHE: RefCell<HashMap<String, Option<Color>>> = RefCell::new(HashMap::new());
}

fn parse_color(css: &str) -> Option<Color> {
    let trimmed = css.trim();
    if trimmed.len() > 128 {
        return color::parse_color(trimmed).ok().map(|parsed| {
            let c = parsed.to_alpha_color::<color::Srgb>().to_rgba8();
            Color::from_rgba8(c.r, c.g, c.b, c.a)
        });
    }
    COLOR_CACHE.with(|cache| {
        let mut map = cache.borrow_mut();
        if let Some(&hit) = map.get(trimmed) {
            return hit;
        }
        let res = color::parse_color(trimmed).ok().map(|parsed| {
            let c = parsed.to_alpha_color::<color::Srgb>().to_rgba8();
            Color::from_rgba8(c.r, c.g, c.b, c.a)
        });
        if map.len() >= 1024 {
            map.clear();
        }
        map.insert(trimmed.to_string(), res);
        res
    })
}

fn blend_mode(name: &str) -> Option<BlendMode> {
    Some(match name {
        "source-over" => BlendMode::SourceOver,
        "source-in" => BlendMode::SourceIn,
        "source-out" => BlendMode::SourceOut,
        "source-atop" => BlendMode::SourceAtop,
        "destination-over" => BlendMode::DestinationOver,
        "destination-in" => BlendMode::DestinationIn,
        "destination-out" => BlendMode::DestinationOut,
        "destination-atop" => BlendMode::DestinationAtop,
        "lighter" => BlendMode::Plus,
        "copy" => BlendMode::Source,
        "xor" => BlendMode::Xor,
        "multiply" => BlendMode::Multiply,
        "screen" => BlendMode::Screen,
        "overlay" => BlendMode::Overlay,
        "darken" => BlendMode::Darken,
        "lighten" => BlendMode::Lighten,
        "color-dodge" => BlendMode::ColorDodge,
        "color-burn" => BlendMode::ColorBurn,
        "hard-light" => BlendMode::HardLight,
        "soft-light" => BlendMode::SoftLight,
        "difference" => BlendMode::Difference,
        "exclusion" => BlendMode::Exclusion,
        "hue" => BlendMode::Hue,
        "saturation" => BlendMode::Saturation,
        "color" => BlendMode::Color,
        "luminosity" => BlendMode::Luminosity,
        _ => return None,
    })
}

/// An image's pixels from its URL, decoded once and kept.
fn image(
    url: &str,
    bundle: Option<&SoftnBundle>,
    blobs: Option<&BlobStore>,
) -> Result<Arc<Pixmap>, String> {
    if let Some(found) = IMAGES.with(|i| i.borrow().get(url).cloned()) {
        return Ok(found);
    }
    let raw = fetch_canvas_image_bytes(url, bundle, blobs)?;
    let decoded_raster = (|| -> Result<Option<image::DynamicImage>, String> {
        let Ok(mut reader) = image::ImageReader::new(std::io::Cursor::new(&raw)).with_guessed_format() else {
            return Ok(None);
        };
        if reader.format().is_none() {
            return Ok(None);
        }
        let mut limits = image::Limits::default();
        limits.max_image_width = Some(MAX_CANVAS_DIM);
        limits.max_image_height = Some(MAX_CANVAS_DIM);
        limits.max_alloc = Some(64 * 1024 * 1024);
        reader.limits(limits);
        match reader.decode() {
            Ok(img) => Ok(Some(img)),
            Err(image::ImageError::Limits(e)) => {
                Err(format!("image {url}: exceeds decode limits ({e})"))
            }
            Err(_) => Ok(None),
        }
    })()?;
    let pixmap = if let Some(img) = decoded_raster {
        let (w, h) = (img.width(), img.height());
        if w > MAX_CANVAS_DIM || h > MAX_CANVAS_DIM {
            return Err(format!("image {url}: dimensions {w}x{h} exceed {MAX_CANVAS_DIM} limit"));
        }
        let rgba = img.to_rgba8();
        let mut data = rgba.into_raw();
        for px in data.chunks_exact_mut(4) {
            let a = px[3] as u32;
            for c in &mut px[..3] {
                *c = ((*c as u32 * a + 127) / 255) as u8;
            }
        }
        Arc::new(
            Pixmap::from_vec(data, IntSize::from_wh(w.max(1), h.max(1)).ok_or("empty image")?).ok_or("bad image")?,
        )
    } else if let Some(svg_pixmap) = sanitize_svg_for_raster(&raw).and_then(|s| zipp_renderer::rasterize_svg(&s)) {
        if svg_pixmap.width() > MAX_CANVAS_DIM || svg_pixmap.height() > MAX_CANVAS_DIM {
            return Err(format!("image {url}: rasterized SVG exceeds {MAX_CANVAS_DIM} limit"));
        }
        Arc::new(svg_pixmap)
    } else {
        return Err(format!("image {url}: unsupported image format"));
    };
    let px_bytes = pixmap.data().len();
    IMAGES.with(|i| {
        IMAGE_CACHE_BYTES.with(|b| {
            let mut map = i.borrow_mut();
            let mut total = b.borrow_mut();
            if map.len() >= MAX_IMAGES || total.saturating_add(px_bytes) > MAX_IMAGE_CACHE_BYTES {
                map.clear();
                *total = 0;
            }
            if px_bytes <= MAX_IMAGE_CACHE_BYTES {
                map.insert(url.to_string(), pixmap.clone());
                *total = total.saturating_add(px_bytes);
            }
        });
    });
    Ok(pixmap)
}

fn fetch_canvas_image_bytes(
    url: &str,
    bundle: Option<&SoftnBundle>,
    blobs: Option<&BlobStore>,
) -> Result<Vec<u8>, String> {
    if url.starts_with("blob:") {
        if let Some(bytes) = blobs.and_then(|s| s.lookup_bytes(url)) {
            return Ok(bytes);
        }
        return Err(format!("canvas blob not found: {url}"));
    }
    if url.starts_with("data:") {
        if url.len() > MAX_DATA_URL_BYTES {
            return Err("canvas data URL exceeds size limit".into());
        }
        let parsed = data_url::DataUrl::process(url).map_err(|e| format!("data url: {e:?}"))?;
        let (body, _) = parsed.decode_to_vec().map_err(|e| format!("data decode: {e:?}"))?;
        if body.len() > MAX_DATA_URL_BYTES {
            return Err("canvas data URL body exceeds size limit".into());
        }
        return Ok(body);
    }
    if let Some(b) = bundle {
        let rel = if let Some(rest) = strip_virtual_origin(url) {
            rest
        } else if url.starts_with("http://") || url.starts_with("https://") {
            return Err(format!("canvas cross-origin image blocked: {url}"));
        } else {
            url
        };
        if let Some((_, _, bytes)) = b.read_public_asset(rel) {
            return Ok(bytes);
        }
    }
    Err(format!("canvas image not found: {url}"))
}

/// What a `drawImage` or `createPattern` source names: an image's URL, or
/// another canvas.
fn source(
    src: &Json,
    bundle: Option<&SoftnBundle>,
    blobs: Option<&BlobStore>,
) -> Result<Arc<Pixmap>, String> {
    if let Some(url) = src.get("url").and_then(Json::as_str) {
        return image(url, bundle, blobs);
    }
    if let Some(id) = src.get("canvas").and_then(Json::as_f64) {
        return CANVASES.with(|c| c.borrow().get(&(id as u32)).map(|c| Arc::new(c.pixmap.clone())))
            .ok_or_else(|| "no such canvas".to_string());
    }
    Err("unsupported image source".into())
}

fn premultiply_into(out: &mut [u8], straight: &[u8]) {
    for (o, s) in out.chunks_exact_mut(4).zip(straight.chunks_exact(4)) {
        let a = s[3] as u32;
        o[0] = ((s[0] as u32 * a + 127) / 255) as u8;
        o[1] = ((s[1] as u32 * a + 127) / 255) as u8;
        o[2] = ((s[2] as u32 * a + 127) / 255) as u8;
        o[3] = s[3];
    }
}

fn demultiply(px: &[u8]) -> [u8; 4] {
    match px[3] {
        0 => [0, 0, 0, 0],
        255 => [px[0], px[1], px[2], 255],
        a => {
            let un = |c: u8| ((c as u32 * 255 + a as u32 / 2) / a as u32).min(255) as u8;
            [un(px[0]), un(px[1]), un(px[2]), a]
        }
    }
}

/// The pixmap's pixels, straight alpha, `x, y, w, h` of them (outside is
/// transparent).
fn read_pixels(pixmap: &Pixmap, x: i32, y: i32, w: i32, h: i32) -> Result<Vec<u8>, String> {
    let (pw, ph) = (pixmap.width() as i32, pixmap.height() as i32);
    let data = pixmap.data();
    let (w, h) = (w.max(0), h.max(0));
    if w == 0 || h == 0 {
        return Ok(Vec::new());
    }
    let total = (w as usize)
        .checked_mul(h as usize)
        .and_then(|n| n.checked_mul(4))
        .ok_or_else(|| "getImageData size overflow".to_string())?;
    if total > MAX_CANVAS_READ_BYTES {
        return Err(format!(
            "getImageData request ({total} bytes) exceeds 64 MiB limit"
        ));
    }
    let mut out = vec![0u8; total];
    let fast_ok = x >= 0
        && y >= 0
        && x.checked_add(w).is_some_and(|xe| xe <= pw)
        && y.checked_add(h).is_some_and(|ye| ye <= ph);
    if fast_ok {
        let src_stride = (pw as usize) * 4;
        let dst_stride = (w as usize) * 4;
        let x_off = (x as usize) * 4;
        for row in 0..h as usize {
            let src_row = &data[(y as usize + row) * src_stride + x_off..][..dst_stride];
            let dst_row = &mut out[row * dst_stride..][..dst_stride];
            for (d, s) in dst_row.chunks_exact_mut(4).zip(src_row.chunks_exact(4)) {
                match s[3] {
                    255 => d.copy_from_slice(s),
                    0 => {}
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
        }
        return Ok(out);
    }
    for row in 0..h {
        let Some(sy) = y.checked_add(row) else {
            continue;
        };
        if sy < 0 || sy >= ph {
            continue;
        }
        for col in 0..w {
            let Some(sx) = x.checked_add(col) else {
                continue;
            };
            if sx < 0 || sx >= pw {
                continue;
            }
            let at = ((sy as usize) * (pw as usize) + (sx as usize)) * 4;
            let to = ((row as usize) * (w as usize) + (col as usize)) * 4;
            out[to..to + 4].copy_from_slice(&demultiply(&data[at..at + 4]));
        }
    }
    Ok(out)
}

struct GlyphPen<'a> {
    path: &'a mut SegPath,
    t: Transform,
}

impl OutlinePen for GlyphPen<'_> {
    fn move_to(&mut self, x: f32, y: f32) {
        self.path.move_to(map(&self.t, x, y));
    }
    fn line_to(&mut self, x: f32, y: f32) {
        self.path.line_to(map(&self.t, x, y));
    }
    fn quad_to(&mut self, cx0: f32, cy0: f32, x: f32, y: f32) {
        self.path.quad_to(map(&self.t, cx0, cy0), map(&self.t, x, y));
    }
    fn curve_to(&mut self, cx0: f32, cy0: f32, cx1: f32, cy1: f32, x: f32, y: f32) {
        self.path.cubic_to(map(&self.t, cx0, cy0), map(&self.t, cx1, cy1), map(&self.t, x, y));
    }
    fn close(&mut self) {
        self.path.close();
    }
}

/// Text laid out in a line: its advance, ascent and descent (both positive),
/// and its outline in user space with its origin at (`x`, `y`) per the
/// state's alignment and baseline, squeezed to `max_width` if given.
fn text(state: &State, s: &str, x: f32, y: f32, max_width: Option<f32>) -> (f32, f32, f32, SegPath) {
    let bytes = zipp_dom::fonts::embedded_face(&state.font.family, state.font.bold, state.font.italic);
    let mut path = SegPath::default();
    let Ok(font) = FontRef::new(bytes) else {
        return (0.0, 0.0, 0.0, path);
    };
    let size = Size::new(state.font.size);
    let location = LocationRef::default();
    let metrics = font.metrics(size, location);
    let (ascent, descent) = (metrics.ascent, -metrics.descent);
    let charmap = font.charmap();
    let glyph_metrics = font.glyph_metrics(size, location);
    let glyphs: Vec<_> = s
        .chars()
        .map(|c| {
            let gid = charmap.map(c).unwrap_or_default();
            (gid, glyph_metrics.advance_width(gid).unwrap_or(0.0))
        })
        .collect();
    let width: f32 = glyphs.iter().map(|(_, a)| a).sum();
    let squeeze = match max_width {
        Some(max) if max > 0.0 && width > max => max / width,
        _ => 1.0,
    };
    let shown = width * squeeze;
    let x0 = x - match state.align {
        Align::Left => 0.0,
        Align::Right => shown,
        Align::Center => shown / 2.0,
    };
    let y0 = y + match state.baseline.as_str() {
        "top" => ascent,
        "hanging" => ascent * 0.8,
        "middle" => (ascent - descent) / 2.0,
        "ideographic" | "bottom" => -descent,
        _ => 0.0,
    };
    let outlines = font.outline_glyphs();
    let mut pen_x = 0.0;
    for (gid, advance) in glyphs {
        if let Some(glyph) = outlines.get(gid) {
            // Font units are y-up; the canvas is y-down.
            let t = Transform::from_row(squeeze, 0.0, 0.0, -1.0, x0 + pen_x * squeeze, y0);
            let mut pen = GlyphPen { path: &mut path, t };
            let _ = glyph.draw(DrawSettings::unhinted(size, location), &mut pen);
            path.current = None;
        }
        pen_x += advance;
    }
    (shown, ascent, descent, path)
}

impl Canvas2D {
    fn new(flid: u32, w: f64, h: f64, opaque: bool) -> Self {
        let mut pixmap = new_pixmap(w, h);
        if opaque {
            pixmap.fill(Color::BLACK);
        }
        Canvas2D { flid, pixmap, opaque, state: State::default(), stack: Vec::new(), path: SegPath::default() }
    }

    /// Run `draw` with a paint for `style` under the current state.
    fn with_paint(&mut self, style: &Style, draw: impl FnOnce(&mut Pixmap, &Paint, Option<&Mask>)) {
        let state = &self.state;
        let alpha = state.alpha;
        let pattern = match style {
            Style::Pattern(id) => PATTERNS.with(|p| p.borrow().get(id).map(|p| (p.pixmap.clone(), p.repeat))),
            _ => None,
        };
        let quality = if state.smoothing { FilterQuality::Bilinear } else { FilterQuality::Nearest };
        let shader = match style {
            Style::Color(c) => {
                let mut c = *c;
                c.apply_opacity(alpha);
                Some(Shader::SolidColor(c))
            }
            Style::Gradient(id) => GRADIENTS.with(|g| {
                let g = g.borrow();
                let gradient = g.get(id)?;
                let stops: Vec<GradientStop> = gradient
                    .stops
                    .iter()
                    .map(|&(at, mut c)| {
                        c.apply_opacity(alpha);
                        GradientStop::new(at, c)
                    })
                    .collect();
                if stops.is_empty() {
                    return None;
                }
                if stops.len() == 1 {
                    let mut c = gradient.stops[0].1;
                    c.apply_opacity(alpha);
                    return Some(Shader::SolidColor(c));
                }
                match gradient.kind {
                    GradientKind::Linear(x0, y0, x1, y1) => LinearGradient::new(
                        Point::from_xy(x0, y0),
                        Point::from_xy(x1, y1),
                        stops,
                        SpreadMode::Pad,
                        state.transform,
                    ),
                    GradientKind::Radial(x0, y0, r0, x1, y1, r1) => {
                        // tiny-skia's radial gradient starts at a point: fold a
                        // start radius into the stops.
                        let inner = if r1 > 0.0 { (r0 / r1).clamp(0.0, 1.0) } else { 0.0 };
                        let stops = stops
                            .into_iter()
                            .zip(gradient.stops.iter())
                            .map(|(_, &(at, mut c))| {
                                c.apply_opacity(alpha);
                                GradientStop::new(inner + at * (1.0 - inner), c)
                            })
                            .collect();
                        RadialGradient::new(Point::from_xy(x0, y0), Point::from_xy(x1, y1), r1, stops, SpreadMode::Pad, state.transform)
                    }
                    // No sweep shader: the first stop's colour, as for a page's
                    // conic gradients.
                    GradientKind::Conic => {
                        let mut c = gradient.stops[0].1;
                        c.apply_opacity(alpha);
                        Some(Shader::SolidColor(c))
                    }
                }
            }),
            Style::Pattern(_) => pattern.as_ref().map(|(pixmap, repeat)| {
                let spread = if *repeat { SpreadMode::Repeat } else { SpreadMode::Pad };
                Pattern::new(pixmap.as_ref().as_ref(), spread, quality, alpha, state.transform)
            }),
        };
        let Some(shader) = shader else {
            return;
        };
        let paint = Paint { shader, blend_mode: state.blend, anti_alias: true, force_hq_pipeline: false };
        let clip = state.clip.clone();
        draw(&mut self.pixmap, &paint, clip.as_deref());
    }

    fn fill_path(&mut self, path: &SegPath, rule: FillRule) {
        let Some(path) = path.to_path() else {
            return;
        };
        let style = self.state.fill.clone();
        self.with_paint(&style, |pixmap, paint, clip| {
            safe_fill_path(pixmap, &path, paint, rule, Transform::identity(), clip);
        });
    }

    fn stroke(&self) -> Stroke {
        let s = &self.state;
        Stroke {
            width: s.line_width,
            miter_limit: s.miter_limit,
            line_cap: s.line_cap,
            line_join: s.line_join,
            dash: if s.dash.is_empty() { None } else { StrokeDash::new(s.dash.clone(), s.dash_offset) },
        }
    }

    /// Stroke a device-space path in the user space of the moment.
    fn stroke_path(&mut self, path: &SegPath) {
        let t = self.state.transform;
        let (Some(path), Some(inverse)) = (path.to_path(), t.invert()) else {
            return;
        };
        let Some(user) = path.transform(inverse) else {
            return;
        };
        let stroke = self.stroke();
        let style = self.state.stroke.clone();
        self.with_paint(&style, |pixmap, paint, clip| {
            safe_stroke_path(pixmap, &user, paint, &stroke, t, clip);
        });
    }

    fn rect_path(&self, x: f32, y: f32, w: f32, h: f32) -> SegPath {
        let t = &self.state.transform;
        let mut p = SegPath::default();
        p.move_to(map(t, x, y));
        p.line_to(map(t, x + w, y));
        p.line_to(map(t, x + w, y + h));
        p.line_to(map(t, x, y + h));
        p.close();
        p
    }

    /// A `Path2D`'s commands, or the current path when there are none.
    fn path_arg(&self, cmd: Option<&Json>) -> SegPath {
        match cmd.and_then(Json::as_array) {
            Some(cmds) => {
                let mut path = SegPath::default();
                for c in cmds {
                    path_command(&mut path, &self.state.transform, c);
                }
                path
            }
            None => self.path.clone(),
        }
    }

    fn clip(&mut self, path: &SegPath, rule: FillRule) {
        let Some(path) = path.to_path() else {
            // Clipping to nothing leaves nothing drawable.
            self.state.clip = Mask::new(self.pixmap.width(), self.pixmap.height()).map(Arc::new);
            return;
        };
        let mask = match self.state.clip.as_deref() {
            Some(existing) => {
                let mut mask = existing.clone();
                let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    mask.intersect_path(&path, rule, true, Transform::identity());
                }));
                if res.is_err() {
                    let mut fallback = existing.clone();
                    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        fallback.intersect_path(&path, rule, false, Transform::identity());
                    }));
                    fallback
                } else {
                    mask
                }
            }
            None => {
                let Some(mut mask) = Mask::new(self.pixmap.width(), self.pixmap.height()) else { return };
                let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    mask.fill_path(&path, rule, true, Transform::identity());
                }));
                if res.is_err() {
                    let Some(mut fallback) = Mask::new(self.pixmap.width(), self.pixmap.height()) else { return };
                    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        fallback.fill_path(&path, rule, false, Transform::identity());
                    }));
                    fallback
                } else {
                    mask
                }
            }
        };
        self.state.clip = Some(Arc::new(mask));
    }

    fn draw_image(&mut self, src: Arc<Pixmap>, n: &[f32]) {
        let (iw, ih) = (src.width() as f32, src.height() as f32);
        let (sx, sy, sw, sh, dx, dy, dw, dh) = match n.len() {
            2 => (0.0, 0.0, iw, ih, n[0], n[1], iw, ih),
            4 => (0.0, 0.0, iw, ih, n[0], n[1], n[2], n[3]),
            8 => (n[0], n[1], n[2], n[3], n[4], n[5], n[6], n[7]),
            _ => return,
        };
        if sw == 0.0 || sh == 0.0 || dw == 0.0 || dh == 0.0 {
            return;
        }
        // A part of the image is taken out first, so its edges do not bleed.
        let (src, sx, sy) = if sx != 0.0 || sy != 0.0 || sw != iw || sh != ih {
            match IntRect::from_xywh(sx.floor() as i32, sy.floor() as i32, sw.ceil().max(1.0) as u32, sh.ceil().max(1.0) as u32)
                .and_then(|r| src.clone_rect(r))
            {
                Some(part) => (Arc::new(part), sx - sx.floor(), sy - sy.floor()),
                None => (src, sx, sy),
            }
        } else {
            (src, sx, sy)
        };
        let t = self.state.transform;
        let shader_t = t
            .pre_concat(Transform::from_translate(dx, dy))
            .pre_concat(Transform::from_scale(dw / sw, dh / sh))
            .pre_concat(Transform::from_translate(-sx, -sy));
        let Some(path) = self.rect_path(dx, dy, dw, dh).to_path() else { return };
        let quality = if self.state.smoothing { FilterQuality::Bilinear } else { FilterQuality::Nearest };
        let paint = Paint {
            shader: Pattern::new(src.as_ref().as_ref(), SpreadMode::Pad, quality, self.state.alpha, shader_t),
            blend_mode: self.state.blend,
            anti_alias: true,
            force_hq_pipeline: false,
        };
        let clip = self.state.clip.clone();
        safe_fill_path(&mut self.pixmap, &path, &paint, FillRule::Winding, Transform::identity(), clip.as_deref());
    }

    /// Whether (x, y), in canvas pixels, is in `path`.
    fn contains(&self, path: &Path, rule: FillRule, x: f32, y: f32) -> bool {
        if !x.is_finite() || !y.is_finite() {
            return false;
        }
        let Some(mut mask) = Mask::new(1, 1) else { return false };
        let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            mask.fill_path(path, rule, false, Transform::from_translate(-x.floor(), -y.floor()));
        }));
        res.is_ok() && mask.data()[0] > 0
    }

    fn frame(&self) -> Frame {
        let src = self.pixmap.data();
        let mut rgba = vec![0u8; src.len()];
        if self.opaque {
            for (dst, px) in rgba.chunks_exact_mut(4).zip(src.chunks_exact(4)) {
                if px[3] == 255 {
                    dst.copy_from_slice(px);
                } else {
                    let u = demultiply(px);
                    dst[0] = u[0];
                    dst[1] = u[1];
                    dst[2] = u[2];
                    dst[3] = 255;
                }
            }
        } else {
            for (dst, px) in rgba.chunks_exact_mut(4).zip(src.chunks_exact(4)) {
                match px[3] {
                    0 => {}
                    255 => dst.copy_from_slice(px),
                    _ => dst.copy_from_slice(&demultiply(px)),
                }
            }
        }
        Frame { flid: self.flid, width: self.pixmap.width(), height: self.pixmap.height(), rgba }
    }
}

/// Add one path command (a canvas's or a `Path2D`'s) in user space under `t`.
fn path_command(path: &mut SegPath, t: &Transform, cmd: &Json) {
    let n = |i: usize| cmd.get(i).and_then(Json::as_f64).unwrap_or(0.0) as f32;
    let flag = |i: usize| cmd.get(i).and_then(Json::as_bool).unwrap_or(false);
    match cmd.get(0).and_then(Json::as_str).unwrap_or("") {
        "moveTo" => path.move_to(map(t, n(1), n(2))),
        "lineTo" => path.line_to(map(t, n(1), n(2))),
        "quadraticCurveTo" => path.quad_to(map(t, n(1), n(2)), map(t, n(3), n(4))),
        "bezierCurveTo" => path.cubic_to(map(t, n(1), n(2)), map(t, n(3), n(4)), map(t, n(5), n(6))),
        "closePath" => path.close(),
        "arc" => {
            let r = n(3).max(0.0);
            path.ellipse(t, n(1), n(2), r, r, 0.0, n(4), n(5), flag(6));
        }
        "ellipse" => path.ellipse(t, n(1), n(2), n(3).max(0.0), n(4).max(0.0), n(5), n(6), n(7), flag(8)),
        "rect" => {
            let (x, y, w, h) = (n(1), n(2), n(3), n(4));
            path.move_to(map(t, x, y));
            path.line_to(map(t, x + w, y));
            path.line_to(map(t, x + w, y + h));
            path.line_to(map(t, x, y + h));
            path.close();
            path.move_to(map(t, x, y));
        }
        "roundRect" => {
            let (mut x, mut y, mut w, mut h) = (n(1), n(2), n(3), n(4));
            if w < 0.0 {
                x += w;
                w = -w;
            }
            if h < 0.0 {
                y += h;
                h = -h;
            }
            let radii: Vec<f32> = cmd.get(5).and_then(Json::as_array).map_or_else(Vec::new, |a| {
                a.iter().filter_map(Json::as_f64).map(|r| r as f32).collect()
            });
            // 1 to 4 radii, as CSS border-radius: tl, tr, br, bl.
            let [tl, tr, br, bl] = match radii.as_slice() {
                [] => [0.0; 4],
                [a] => [*a; 4],
                [a, b] => [*a, *b, *a, *b],
                [a, b, c] => [*a, *b, *c, *b],
                [a, b, c, d, ..] => [*a, *b, *c, *d],
            };
            let scale = [(tl + tr) / w, (bl + br) / w, (tl + bl) / h, (tr + br) / h]
                .into_iter()
                .fold(1.0f32, |s, f| if f > 1.0 { s.min(1.0 / f) } else { s });
            let [tl, tr, br, bl] = [tl * scale, tr * scale, br * scale, bl * scale];
            path.move_to(map(t, x + tl, y));
            path.line_to(map(t, x + w - tr, y));
            path.ellipse(t, x + w - tr, y + tr, tr, tr, 0.0, -FRAC_PI_2, 0.0, false);
            path.line_to(map(t, x + w, y + h - br));
            path.ellipse(t, x + w - br, y + h - br, br, br, 0.0, 0.0, FRAC_PI_2, false);
            path.line_to(map(t, x + bl, y + h));
            path.ellipse(t, x + bl, y + h - bl, bl, bl, 0.0, FRAC_PI_2, std::f32::consts::PI, false);
            path.line_to(map(t, x, y + tl));
            path.ellipse(t, x + tl, y + tl, tl, tl, 0.0, std::f32::consts::PI, 1.5 * std::f32::consts::PI, false);
            path.close();
            path.move_to(map(t, x, y));
        }
        "arcTo" => {
            let (x1, y1, x2, y2, r) = (n(1), n(2), n(3), n(4), n(5).max(0.0));
            let Some(inverse) = t.invert() else { return };
            let Some(current) = path.current else {
                return path.move_to(map(t, x1, y1));
            };
            let p0 = map(&inverse, current.x, current.y);
            let (v0x, v0y) = (p0.x - x1, p0.y - y1);
            let (v2x, v2y) = (x2 - x1, y2 - y1);
            let (l0, l2) = ((v0x * v0x + v0y * v0y).sqrt(), (v2x * v2x + v2y * v2y).sqrt());
            let cross = v0x * v2y - v0y * v2x;
            if r == 0.0 || l0 == 0.0 || l2 == 0.0 || cross.abs() < 1e-6 {
                return path.line_to(map(t, x1, y1));
            }
            let (u0x, u0y, u2x, u2y) = (v0x / l0, v0y / l0, v2x / l2, v2y / l2);
            let angle = (u0x * u2x + u0y * u2y).clamp(-1.0, 1.0).acos();
            let d = r / (angle / 2.0).tan();
            let (t1x, t1y) = (x1 + u0x * d, y1 + u0y * d);
            let (t2x, t2y) = (x1 + u2x * d, y1 + u2y * d);
            let (bx, by) = (u0x + u2x, u0y + u2y);
            let bl = (bx * bx + by * by).sqrt();
            let h = r / (angle / 2.0).sin();
            let (cx, cy) = (x1 + bx / bl * h, y1 + by / bl * h);
            let a0 = (t1y - cy).atan2(t1x - cx);
            let a1 = (t2y - cy).atan2(t2x - cx);
            path.line_to(map(t, t1x, t1y));
            path.ellipse(t, cx, cy, r, r, 0.0, a0, a1, cross > 0.0);
        }
        "svg" => {
            let data = cmd.get(1).and_then(Json::as_str).unwrap_or("");
            for seg in svgtypes::SimplifyingPathParser::from(data).flatten() {
                use svgtypes::SimplePathSegment as S;
                match seg {
                    S::MoveTo { x, y } => path.move_to(map(t, x as f32, y as f32)),
                    S::LineTo { x, y } => path.line_to(map(t, x as f32, y as f32)),
                    S::Quadratic { x1, y1, x, y } => path.quad_to(map(t, x1 as f32, y1 as f32), map(t, x as f32, y as f32)),
                    S::CurveTo { x1, y1, x2, y2, x, y } => path.cubic_to(
                        map(t, x1 as f32, y1 as f32),
                        map(t, x2 as f32, y2 as f32),
                        map(t, x as f32, y as f32),
                    ),
                    S::ClosePath => path.close(),
                }
            }
        }
        "addPath" => {
            // Another Path2D's commands, under its own matrix as well.
            let m = cmd.get(2).and_then(Json::as_array);
            let m: Vec<f32> = m.map_or_else(Vec::new, |a| a.iter().filter_map(Json::as_f64).map(|v| v as f32).collect());
            let inner = if m.len() == 6 { t.pre_concat(Transform::from_row(m[0], m[1], m[2], m[3], m[4], m[5])) } else { *t };
            for c in cmd.get(1).and_then(Json::as_array).into_iter().flatten() {
                path_command(path, &inner, c);
            }
        }
        _ => {}
    }
}

fn fill_rule(v: Option<&Json>) -> FillRule {
    if v.and_then(Json::as_str) == Some("evenodd") { FillRule::EvenOdd } else { FillRule::Winding }
}

/// Run one command for canvas `context`.
fn run(
    context: u32,
    cmd: &Json,
    payload: &[u8],
    bundle: Option<&SoftnBundle>,
    blobs: Option<&BlobStore>,
    reply: &mut Reply,
) -> Result<(), String> {
    let op = cmd.get(0).and_then(Json::as_str).unwrap_or("");
    let num = |i: usize| cmd.get(i).and_then(Json::as_f64).unwrap_or(0.0);
    let n = |i: usize| num(i) as f32;
    let str_arg = |i: usize| cmd.get(i).and_then(Json::as_str).unwrap_or("");
    match op {
        "reset" => {
            reset_all();
            return Ok(());
        }
        "create" => {
            let opaque = cmd.get(4).and_then(Json::as_bool).unwrap_or(false);
            let (cw, ch) = clamp_canvas_dims(num(2), num(3));
            let needed_bytes = (cw as usize)
                .saturating_mul(ch as usize)
                .saturating_mul(4);
            CANVASES.with(|c| {
                let mut map = c.borrow_mut();
                if !map.contains_key(&context) && map.len() >= MAX_CANVASES {
                    return Err("canvas context limit exceeded".to_string());
                }
                let existing_other = total_canvases_mem_bytes(&map, Some(context));
                if existing_other.saturating_add(needed_bytes) > MAX_CANVAS_TOTAL_BYTES {
                    return Err("canvas total pixel memory limit exceeded".to_string());
                }
                let canvas = Canvas2D::new(num(1) as u32, f64::from(cw), f64::from(ch), opaque);
                map.insert(context, canvas);
                Ok(())
            })?;
            return Ok(());
        }
        "gradient" => {
            let kind = match str_arg(2) {
                "linear" => GradientKind::Linear(n(3), n(4), n(5), n(6)),
                "radial" => GradientKind::Radial(n(3), n(4), n(5), n(6), n(7), n(8)),
                _ => GradientKind::Conic,
            };
            let id = num(1) as u32;
            GRADIENTS.with(|g| {
                let mut map = g.borrow_mut();
                if !map.contains_key(&id) && map.len() >= MAX_GRADIENTS {
                    return Err("canvas gradient limit exceeded".to_string());
                }
                map.insert(id, Gradient { kind, stops: Vec::new() });
                Ok(())
            })?;
            return Ok(());
        }
        "stop" => {
            let color = parse_color(str_arg(3)).ok_or("not a colour")?;
            GRADIENTS.with(|g| {
                if let Some(g) = g.borrow_mut().get_mut(&(num(1) as u32)) {
                    if g.stops.len() < 256 {
                        let at = n(2).clamp(0.0, 1.0);
                        let i = g.stops.partition_point(|&(o, _)| o <= at);
                        g.stops.insert(i, (at, color));
                    }
                }
            });
            return Ok(());
        }
        "pattern" => {
            let pixmap = source(cmd.get(2).unwrap_or(&Json::Null), bundle, blobs)?;
            let repeat = str_arg(3) != "no-repeat";
            let id = num(1) as u32;
            let new_bytes = pixmap.data().len();
            PATTERNS.with(|p| {
                PATTERN_CACHE_BYTES.with(|b| {
                    let mut map = p.borrow_mut();
                    let mut total = b.borrow_mut();
                    let old_bytes = map.get(&id).map(|old| old.pixmap.data().len()).unwrap_or(0);
                    if !map.contains_key(&id) && map.len() >= MAX_PATTERNS {
                        return Err("canvas pattern limit exceeded".to_string());
                    }
                    let next_total = total.saturating_sub(old_bytes).saturating_add(new_bytes);
                    if next_total > MAX_PATTERN_CACHE_BYTES {
                        return Err("canvas pattern memory limit exceeded".to_string());
                    }
                    *total = next_total;
                    map.insert(id, PatternSource { pixmap, repeat });
                    Ok(())
                })
            })?;
            return Ok(());
        }
        _ => {}
    }
    // An image to draw is found before the canvas is borrowed: it may be one.
    let image = match op {
        "drawImage" => Some(source(cmd.get(1).unwrap_or(&Json::Null), bundle, blobs)?),
        _ => None,
    };
    CANVASES.with(|c| {
        let mut canvases = c.borrow_mut();
        match op {
            "resize" => {
                let (cw, ch) = clamp_canvas_dims(num(1), num(2));
                let needed_bytes = (cw as usize)
                    .saturating_mul(ch as usize)
                    .saturating_mul(4);
                let other_bytes = total_canvases_mem_bytes(&canvases, Some(context));
                if other_bytes.saturating_add(needed_bytes) > MAX_CANVAS_TOTAL_BYTES {
                    return Err("canvas total pixel memory limit exceeded".to_string());
                }
                let canvas = canvases.get_mut(&context).ok_or("no such canvas")?;
                let opaque = canvas.opaque;
                *canvas = Canvas2D::new(canvas.flid, f64::from(cw), f64::from(ch), opaque);
                return Ok(());
            }
            "clip" => {
                let canvas_ro = canvases.get(&context).ok_or("no such canvas")?;
                let mask_bytes = (canvas_ro.pixmap.width() as usize)
                    .saturating_mul(canvas_ro.pixmap.height() as usize);
                let total_bytes = total_canvases_mem_bytes(&canvases, None);
                if total_bytes.saturating_add(mask_bytes) > MAX_CANVAS_TOTAL_BYTES {
                    return Err("canvas clip mask memory limit exceeded".to_string());
                }
                let canvas = canvases.get_mut(&context).ok_or("no such canvas")?;
                let path = canvas.path_arg(cmd.get(2));
                canvas.clip(&path, fill_rule(cmd.get(1)));
                return Ok(());
            }
            _ => {}
        }
        let canvas = canvases.get_mut(&context).ok_or("no such canvas")?;
        let state = &mut canvas.state;
        match op {
            "save" => {
                if canvas.stack.len() >= MAX_SAVE_STACK {
                    return Err("canvas save() stack depth limit exceeded".to_string());
                }
                canvas.stack.push(state.clone());
            }
            "restore" => {
                if let Some(saved) = canvas.stack.pop() {
                    *state = saved;
                }
            }
            "resetContext" => {
                let (w, h, opaque) = (canvas.pixmap.width(), canvas.pixmap.height(), canvas.opaque);
                *canvas = Canvas2D::new(canvas.flid, w as f64, h as f64, opaque);
            }
            "setTransform" => {
                let vals = [n(1), n(2), n(3), n(4), n(5), n(6)];
                if vals.iter().all(|v| v.is_finite()) {
                    state.transform = Transform::from_row(vals[0], vals[1], vals[2], vals[3], vals[4], vals[5]);
                }
            }
            "transform" => {
                let vals = [n(1), n(2), n(3), n(4), n(5), n(6)];
                if vals.iter().all(|v| v.is_finite()) {
                    state.transform = state.transform.pre_concat(Transform::from_row(vals[0], vals[1], vals[2], vals[3], vals[4], vals[5]));
                }
            }
            "set" => {
                let value = cmd.get(2).unwrap_or(&Json::Null);
                let s = value.as_str().unwrap_or("");
                let v = value.as_f64().unwrap_or(0.0) as f32;
                let style = || -> Option<Style> {
                    if let Some(id) = value.get("g").and_then(Json::as_f64) {
                        return Some(Style::Gradient(id as u32));
                    }
                    if let Some(id) = value.get("p").and_then(Json::as_f64) {
                        return Some(Style::Pattern(id as u32));
                    }
                    parse_color(s).map(Style::Color)
                };
                match str_arg(1) {
                    "fillStyle" => {
                        if let Some(style) = style() {
                            state.fill = style;
                        }
                    }
                    "strokeStyle" => {
                        if let Some(style) = style() {
                            state.stroke = style;
                        }
                    }
                    "lineWidth" if v > 0.0 && v.is_finite() => state.line_width = v.min(2048.0),
                    "miterLimit" if v > 0.0 && v.is_finite() => state.miter_limit = v.min(1024.0),
                    "lineDashOffset" if v.is_finite() => state.dash_offset = v,
                    "globalAlpha" if (0.0..=1.0).contains(&v) => state.alpha = v,
                    "lineCap" => {
                        state.line_cap = match s {
                            "round" => LineCap::Round,
                            "square" => LineCap::Square,
                            _ => LineCap::Butt,
                        }
                    }
                    "lineJoin" => {
                        state.line_join = match s {
                            "round" => LineJoin::Round,
                            "bevel" => LineJoin::Bevel,
                            _ => LineJoin::Miter,
                        }
                    }
                    "globalCompositeOperation" => {
                        if let Some(mode) = blend_mode(s) {
                            state.blend = mode;
                        }
                    }
                    "font" => {
                        if let Some(font) = Font::parse(s) {
                            state.font = font;
                        }
                    }
                    "textAlign" => {
                        state.align = match s {
                            "right" | "end" => Align::Right,
                            "center" => Align::Center,
                            _ => Align::Left,
                        }
                    }
                    "textBaseline" => state.baseline = s.to_string(),
                    "imageSmoothingEnabled" => state.smoothing = value.as_bool().unwrap_or(true),
                    _ => {}
                }
            }
            "dash" => {
                let mut dash: Vec<f32> = cmd.get(1).and_then(Json::as_array).map_or_else(Vec::new, |a| {
                    a.iter().take(256).filter_map(Json::as_f64).map(|v| v as f32).collect()
                });
                if dash.len() % 2 == 1 {
                    dash.extend(dash.clone());
                }
                state.dash = if dash.iter().all(|d| d.is_finite() && *d >= 0.0) && dash.iter().any(|d| *d > 0.0) {
                    dash
                } else {
                    Vec::new()
                };
            }
            "beginPath" => canvas.path = SegPath::default(),
            "moveTo" | "lineTo" | "quadraticCurveTo" | "bezierCurveTo" | "closePath" | "arc" | "ellipse" | "rect"
            | "roundRect" | "arcTo" => {
                let t = state.transform;
                path_command(&mut canvas.path, &t, cmd);
            }
            "fill" => {
                let path = canvas.path_arg(cmd.get(2));
                canvas.fill_path(&path, fill_rule(cmd.get(1)));
            }
            "stroke" => {
                let path = canvas.path_arg(cmd.get(1));
                canvas.stroke_path(&path);
            }
            "fillRect" => {
                let path = canvas.rect_path(n(1), n(2), n(3), n(4));
                canvas.fill_path(&path, FillRule::Winding);
            }
            "strokeRect" => {
                let path = canvas.rect_path(n(1), n(2), n(3), n(4));
                canvas.stroke_path(&path);
            }
            "clearRect" => {
                if let Some(path) = canvas.rect_path(n(1), n(2), n(3), n(4)).to_path() {
                    let paint = Paint { blend_mode: BlendMode::Clear, ..Paint::default() };
                    let clip = canvas.state.clip.clone();
                    safe_fill_path(&mut canvas.pixmap, &path, &paint, FillRule::Winding, Transform::identity(), clip.as_deref());
                    if canvas.opaque {
                        let paint = Paint { shader: Shader::SolidColor(Color::BLACK), ..Paint::default() };
                        safe_fill_path(&mut canvas.pixmap, &path, &paint, FillRule::Winding, Transform::identity(), clip.as_deref());
                    }
                }
            }
            "fillText" | "strokeText" => {
                let max = cmd.get(4).and_then(Json::as_f64).map(|m| m as f32);
                let (_, _, _, user) = text(state, str_arg(1), n(2), n(3), max);
                if op == "fillText" {
                    let t = state.transform;
                    if let Some(p) = user.to_path().and_then(|p| p.transform(t)) {
                        let style = canvas.state.fill.clone();
                        canvas.with_paint(&style, |pixmap, paint, clip| {
                            safe_fill_path(pixmap, &p, paint, FillRule::Winding, Transform::identity(), clip);
                        });
                    }
                } else if let Some(p) = user.to_path() {
                    let (t, stroke) = (state.transform, canvas.stroke());
                    let style = canvas.state.stroke.clone();
                    canvas.with_paint(&style, |pixmap, paint, clip| {
                        safe_stroke_path(pixmap, &p, paint, &stroke, t, clip);
                    });
                }
            }
            "measureText" => {
                let (width, ascent, descent, path) = text(state, str_arg(1), 0.0, 0.0, None);
                let ink = path.to_path().map(|p| p.bounds());
                reply.result = serde_json::json!({
                    "width": width,
                    "actualBoundingBoxLeft": ink.map_or(0.0, |b| -b.left()),
                    "actualBoundingBoxRight": ink.map_or(width, |b| b.right()),
                    "actualBoundingBoxAscent": ink.map_or(ascent, |b| -b.top()),
                    "actualBoundingBoxDescent": ink.map_or(0.0, |b| b.bottom()),
                    "fontBoundingBoxAscent": ascent,
                    "fontBoundingBoxDescent": descent,
                    "emHeightAscent": ascent,
                    "emHeightDescent": descent,
                    "alphabeticBaseline": 0.0,
                })
                .to_string();
            }
            "drawImage" => {
                let nums: Vec<f32> = (2..cmd.as_array().map_or(2, Vec::len)).map(n).collect();
                if let Some(image) = image {
                    canvas.draw_image(image, &nums);
                }
            }
            "getImageData" | "pixels" => {
                let (x, y, w, h) = if op == "pixels" {
                    (0, 0, canvas.pixmap.width() as i32, canvas.pixmap.height() as i32)
                } else {
                    (num(1) as i32, num(2) as i32, num(3) as i32, num(4) as i32)
                };
                let bytes = read_pixels(&canvas.pixmap, x, y, w, h)?;
                reply.result = serde_json::json!([w.max(0), h.max(0), bytes.len()]).to_string();
                reply.bytes = Some(bytes);
            }
            "putImageData" => {
                let at_f = num(1);
                let len_f = num(2);
                if !at_f.is_finite() || !len_f.is_finite() || at_f < 0.0 || len_f < 0.0 {
                    return Err("putImageData: invalid byte range".to_string());
                }
                let (at, len) = (at_f as usize, len_f as usize);
                let end = at.checked_add(len).ok_or("putImageData: byte range overflow")?;
                let src = payload.get(at..end).ok_or("bytes out of range")?;
                let (w, h) = (num(3) as i32, num(4) as i32);
                if w <= 0 || h <= 0 || w > MAX_CANVAS_DIM as i32 || h > MAX_CANVAS_DIM as i32 {
                    return Err("putImageData: invalid image dimensions".to_string());
                }
                let expected = (w as usize)
                    .checked_mul(h as usize)
                    .and_then(|n| n.checked_mul(4))
                    .ok_or("putImageData: dimension overflow")?;
                if expected > MAX_CANVAS_READ_BYTES || src.len() < expected {
                    return Err("putImageData: source buffer shorter than w*h*4".to_string());
                }
                let (dx, dy) = (num(5) as i32, num(6) as i32);
                let (rx, ry, rw, rh) = (num(7) as i32, num(8) as i32, num(9) as i32, num(10) as i32);
                if rw <= 0 || rh <= 0 {
                    return Ok(());
                }
                let (pw, ph) = (canvas.pixmap.width() as i32, canvas.pixmap.height() as i32);
                let data = canvas.pixmap.data_mut();
                let row_start = ry.max(0);
                let row_end = ry.saturating_add(rh).min(h);
                let col_start = rx.max(0);
                let col_end = rx.saturating_add(rw).min(w);
                for row in row_start..row_end {
                    let Some(y) = dy.checked_add(row) else {
                        continue;
                    };
                    if y < 0 || y >= ph {
                        continue;
                    }
                    for col in col_start..col_end {
                        let Some(x) = dx.checked_add(col) else {
                            continue;
                        };
                        if x < 0 || x >= pw {
                            continue;
                        }
                        let from = ((row as usize) * (w as usize) + (col as usize)) * 4;
                        let to = ((y as usize) * (pw as usize) + (x as usize)) * 4;
                        if let (Some(dst_px), Some(src_px)) = (data.get_mut(to..to + 4), src.get(from..from + 4)) {
                            premultiply_into(dst_px, src_px);
                        }
                    }
                }
            }
            "toDataURL" => {
                use base64::Engine;
                let png = canvas.pixmap.encode_png().map_err(|e| e.to_string())?;
                let url = format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png));
                reply.result = Json::String(url).to_string();
            }
            "isPointInPath" | "isPointInStroke" => {
                let path = canvas.path_arg(cmd.get(4));
                let inside = path.to_path().is_some_and(|p| {
                    if op == "isPointInPath" {
                        canvas.contains(&p, fill_rule(cmd.get(3)), n(1), n(2))
                    } else {
                        let t = canvas.state.transform;
                        let stroked = t.invert().and_then(|i| p.transform(i)).and_then(|u| u.stroke(&canvas.stroke(), 1.0)).and_then(|s| s.transform(t));
                        stroked.is_some_and(|s| canvas.contains(&s, FillRule::Winding, n(1), n(2)))
                    }
                });
                reply.result = inside.to_string();
            }
            "present" => crate::canvas::push_frame(canvas.frame()),
            _ => return Err("unsupported".to_string()),
        }
        Ok(())
    })
}

/// A 2D canvas's whole picture, straight alpha: `[width, height, bytes]`.
#[cfg(test)]
fn canvas_pixels(context: u32) -> Option<(u32, u32, Vec<u8>)> {
    CANVASES.with(|c| {
        c.borrow().get(&context).map(|c| {
            let (w, h) = (c.pixmap.width(), c.pixmap.height());
            (w, h, read_pixels(&c.pixmap, 0, 0, w as i32, h as i32).unwrap_or_default())
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fonts_parse_as_css_says() {
        let f = Font::parse("italic bold 16px/1.2 \"Fira Code\", monospace").unwrap();
        assert_eq!((f.size, f.bold, f.italic), (16.0, true, true));
        assert_eq!(f.family, "\"Fira Code\", monospace");
        assert_eq!(Font::parse("12pt serif").unwrap().size, 16.0);
        assert!(Font::parse("nonsense").is_none());
    }

    #[test]
    fn draws_paths_text_and_reads_back() {
        run(1, &serde_json::json!(["create", 7, 40, 20, false]), &[], None, None, &mut Reply::default()).unwrap();
        let cmds = serde_json::json!([
            ["set", "fillStyle", "rgb(255, 0, 0)"],
            ["fillRect", 0, 0, 10, 10],
            ["beginPath"], ["arc", 30, 10, 5, 0, 6.3, false], ["set", "fillStyle", "#00ff00"], ["fill", "nonzero", null],
            ["set", "font", "bold 12px sans-serif"], ["fillText", "Hi", 0, 19],
        ]);
        for c in cmds.as_array().unwrap() {
            run(1, c, &[], None, None, &mut Reply::default()).unwrap();
        }
        let (w, h, px) = canvas_pixels(1).unwrap();
        assert_eq!((w, h), (40, 20));
        let at = |x: usize, y: usize| &px[(y * 40 + x) * 4..(y * 40 + x) * 4 + 4];
        assert_eq!(at(5, 5), [255, 0, 0, 255]);
        assert_eq!(at(30, 10), [0, 255, 0, 255]);
        assert_eq!(at(20, 2)[3], 0, "untouched stays transparent");
        let mut reply = Reply::default();
        run(1, &serde_json::json!(["measureText", "Hi"]), &[], None, None, &mut reply).unwrap();
        let m: Json = serde_json::from_str(&reply.result).unwrap();
        assert!(m["width"].as_f64().unwrap() > 8.0, "{m}");
    }

    #[test]
    fn put_and_get_image_data_reject_oob_and_oversized_requests() {
        run(99, &serde_json::json!(["create", 8, 16, 16, false]), &[], None, None, &mut Reply::default()).unwrap();
        // Mismatched short payload for 16x16 must error, not panic with OOB slice.
        let err = run(
            99,
            &serde_json::json!(["putImageData", 0, 4, 16, 16, 0, 0, 0, 0, 16, 16]),
            &[1, 2, 3, 4],
            None,
            None,
            &mut Reply::default(),
        );
        assert!(err.is_err());
        // Huge getImageData request must error, not OOM.
        let err2 = run(
            99,
            &serde_json::json!(["getImageData", 0, 0, 100000, 100000]),
            &[],
            None,
            None,
            &mut Reply::default(),
        );
        assert!(err2.is_err());
        reset_all();
    }

    #[test]
    fn sanitize_svg_for_raster_blocks_entities_external_refs_and_excess_images() {
        // Reject DTD / ENTITY declarations outright.
        let xxe = b"<!DOCTYPE svg [<!ENTITY x SYSTEM \"file:///etc/passwd\">]><svg/>";
        assert!(sanitize_svg_for_raster(xxe).is_none());

        // Strip filesystem / remote hrefs and non-fragment CSS url(...), keep #fragment refs.
        let dirty = br#"<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g"/></defs><rect fill="url(#g)" filter="url(https://evil.test/f)"/><image href="/etc/passwd"/><image xlink:href="file:///C:/secret.png"/></svg>"#;
        let clean = String::from_utf8(sanitize_svg_for_raster(dirty).unwrap()).unwrap();
        assert!(clean.contains("url(#g)"));
        assert!(!clean.contains("/etc/passwd"));
        assert!(!clean.contains("secret.png"));
        assert!(!clean.contains("evil.test"));
    }
}
