//! How much memory one request may take: the app's engine (the guest's linear
//! memory), the script heap inside it, and SQLite. The host that starts the
//! runner says how much, in SOFTN_RUNNER_MEMORY_MB (the PHP host from
//! private/config.json `requestMemoryMb`, 256 unless the operator says
//! otherwise, which is what its Node runner's engine is held to); without it,
//! 1024, as FormLogic's Node runner's engine is.

use std::sync::OnceLock;

const MIB: u64 = 1024 * 1024;
/// With no word from the host.
pub const DEFAULT_MB: u64 = 1024;
/// The least the engine can run in: its 16 MiB stack lives in its memory, and
/// the script heap is what is left after 64 MiB.
pub const MIN_MB: u64 = 128;
/// The most: the guest's own declared maximum (guest/.cargo/config.toml).
pub const MAX_MB: u64 = 1024;
/// The script heap ZIPP counts is held below the memory it lives in by this
/// much, for its stack and for what the count does not see; and never past
/// 512 MiB, where it always was.
const HEAP_HEADROOM: u64 = 64 * MIB;
const MAX_HEAP: u64 = 512 * MIB;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    /// The guest's linear memory: past it a grow fails, and the engine stops.
    pub memory: usize,
    /// ZIPP's heap accounting: past it the engine stops the script ("script
    /// exceeded its memory budget", which no `catch` sees) and the request fails.
    pub heap: u64,
    /// SQLite's hard heap limit: past it a statement fails "out of memory".
    pub sqlite: i64,
}

impl Limits {
    /// From SOFTN_RUNNER_MEMORY_MB's text: a whole number of MiB, held to
    /// MIN_MB..=MAX_MB; anything else (or nothing) is DEFAULT_MB.
    pub fn from_setting(text: Option<&str>) -> Self {
        let mb = text.and_then(|t| t.trim().parse::<u64>().ok()).map_or(DEFAULT_MB, |mb| mb.clamp(MIN_MB, MAX_MB));
        let memory = mb * MIB;
        Limits { memory: memory as usize, heap: (memory - HEAP_HEADROOM).min(MAX_HEAP), sqlite: memory as i64 }
    }
}

/// This process's limits, read once.
pub fn limits() -> Limits {
    static LIMITS: OnceLock<Limits> = OnceLock::new();
    *LIMITS.get_or_init(|| Limits::from_setting(std::env::var("SOFTN_RUNNER_MEMORY_MB").ok().as_deref()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_host_sets_the_memory_and_the_heap_and_sqlite_follow() {
        // Nothing said: as before, FormLogic's 1 GiB, the 512 MiB heap.
        assert_eq!(Limits::from_setting(None), Limits { memory: 1 << 30, heap: 512 * MIB, sqlite: 1 << 30 });
        // The PHP host's 256: the heap 64 MiB below, SQLite the same.
        assert_eq!(Limits::from_setting(Some("256")), Limits { memory: 256 << 20, heap: 192 * MIB, sqlite: 256 << 20 });
        // Held to 128..=1024, and text that is not a whole number is the default.
        assert_eq!(Limits::from_setting(Some("64")).memory, 128 << 20);
        assert_eq!(Limits::from_setting(Some("64")).heap, 64 * MIB);
        assert_eq!(Limits::from_setting(Some("4096")).memory, 1 << 30);
        for text in ["", "abc", "256.5", "-1", "1e3"] {
            assert_eq!(Limits::from_setting(Some(text)), Limits::from_setting(None), "{text:?}");
        }
    }
}
