//! The process's allocator: the system's, reporting the large blocks it hands
//! out to the script engine.
//!
//! ZIPP collects on what its allocator has outstanding as well as on the
//! objects it makes (since 0.0.23). An array pushed or index-stored to a
//! megabyte, an object gathering thousands of keys or a filling Map grows in
//! place, which makes no object, so a handler that built and dropped such
//! things in a loop ran no collection and held all of it until the call ended:
//! 1,200 megabyte arrays, each dead at the next iteration, were all resident at
//! once. The engine sees that growth only if the binary's global allocator
//! reports it, through `zipp_vm::note_large_block`, as ZIPP's own command-line
//! build does. A block under `LARGE_BLOCK_BYTES` costs one compare and a report
//! is one atomic add. The figure is the process's, not a worker's: with several
//! script workers one worker's garbage can bring another's collection a little
//! early, and nothing more, since the engine reads it only to decide when to
//! collect.

use std::alloc::{GlobalAlloc, Layout, System};

pub struct ReportingAlloc;

#[inline]
fn note(old_size: usize, new_size: usize) {
    if old_size >= zipp_vm::LARGE_BLOCK_BYTES || new_size >= zipp_vm::LARGE_BLOCK_BYTES {
        zipp_vm::note_large_block(old_size, new_size);
        #[cfg(test)]
        peak::note(old_size, new_size);
    }
}

// SAFETY: every method forwards its arguments unchanged to the system
// allocator and returns what it returned; the reports only add to and
// subtract from atomic counters, and allocate nothing.
unsafe impl GlobalAlloc for ReportingAlloc {
    #[inline]
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let p = unsafe { System.alloc(layout) };
        if !p.is_null() {
            note(0, layout.size());
        }
        p
    }

    #[inline]
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let p = unsafe { System.alloc_zeroed(layout) };
        if !p.is_null() {
            note(0, layout.size());
        }
        p
    }

    #[inline]
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        note(layout.size(), 0);
        unsafe { System.dealloc(ptr, layout) }
    }

    #[inline]
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let p = unsafe { System.realloc(ptr, layout, new_size) };
        if !p.is_null() {
            note(layout.size(), new_size);
        }
        p
    }
}

/// What the tests measure with: the large blocks outstanding and their peak,
/// kept beside the engine's own figure (which it does not export).
#[cfg(test)]
pub(crate) mod peak {
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NET: AtomicUsize = AtomicUsize::new(0);
    static PEAK: AtomicUsize = AtomicUsize::new(0);

    pub(super) fn note(old_size: usize, new_size: usize) {
        let old = if old_size >= zipp_vm::LARGE_BLOCK_BYTES { old_size } else { 0 };
        let new = if new_size >= zipp_vm::LARGE_BLOCK_BYTES { new_size } else { 0 };
        let now = if new >= old {
            NET.fetch_add(new - old, Ordering::Relaxed) + (new - old)
        } else {
            NET.fetch_sub(old - new, Ordering::Relaxed).saturating_sub(old - new)
        };
        PEAK.fetch_max(now, Ordering::Relaxed);
    }

    /// Run `f` and say how far the large blocks outstanding rose above where
    /// they stood when it started. The figure is the process's, so whatever
    /// the tests running beside it hold at the time is counted too: a bound
    /// asserted with it has to leave room for that.
    pub(crate) fn growth<T>(f: impl FnOnce() -> T) -> (T, usize) {
        let start = NET.load(Ordering::Relaxed);
        PEAK.store(start, Ordering::Relaxed);
        let value = f();
        (value, PEAK.load(Ordering::Relaxed).saturating_sub(start))
    }
}
