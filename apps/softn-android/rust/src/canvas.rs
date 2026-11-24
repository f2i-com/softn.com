//! Frames that canvases drew with WebGL (webgl.rs) or WebGPU (webgpu.rs),
//! waiting to become their elements' images (`apply_canvas_frames`).

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Arc;

/// A frame read back from a canvas: its element's `data-flid`, size and RGBA.
pub(crate) struct Frame {
    pub flid: u32,
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

/// A frame a canvas is showing: its size and pixels.
pub(crate) type Shown = (u32, u32, Arc<Vec<u8>>);

thread_local! {
    static FRAMES: RefCell<Vec<Frame>> = const { RefCell::new(Vec::new()) };
    /// What each canvas of the page is showing, by `data-flid`. A re-render
    /// rebuilds the body, canvases included, and their new nodes get these
    /// back; otherwise a page that changes its DOM every frame (an FPS
    /// readout) would never show its canvas.
    static SHOWN: RefCell<HashMap<u32, Shown>> = RefCell::new(HashMap::new());
}

/// A canvas's newest frame (replacing one it presented earlier).
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn push_frame(frame: Frame) {
    FRAMES.with(|f| {
        let mut frames = f.borrow_mut();
        frames.retain(|old| old.flid != frame.flid);
        frames.push(frame);
    });
}

/// The frames presented since the last call, now what their canvases show.
pub(crate) fn take_frames() -> Vec<(u32, Shown)> {
    let frames = FRAMES.with(|f| std::mem::take(&mut *f.borrow_mut()));
    SHOWN.with(|s| {
        let mut shown = s.borrow_mut();
        frames
            .into_iter()
            .map(|f| {
                let frame = (f.width, f.height, Arc::new(f.rgba));
                shown.insert(f.flid, frame.clone());
                (f.flid, frame)
            })
            .collect()
    })
}

/// Every frame the page's canvases are showing.
pub(crate) fn shown_frames() -> Vec<(u32, Shown)> {
    SHOWN.with(|s| s.borrow().iter().map(|(&flid, frame)| (flid, frame.clone())).collect())
}

/// A new page or bundle: drop both pending and displayed frames so nothing bleeds across apps.
pub(crate) fn forget_shown() {
    FRAMES.with(|f| f.borrow_mut().clear());
    SHOWN.with(|s| s.borrow_mut().clear());
}
