//! Code softn-runner shares with the Rust host, compiled from the Rust host's
//! own file so the two cannot drift: `softn.time` (bridges/time.rs), which
//! both hosts are held to with apps/softn-host-php/tests/time-parity.json.

#[path = "../../../softn-host-rust/src/bridges/time.rs"]
pub mod time;
