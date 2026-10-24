//! The text the guest compiles ahead of an app's logic, taken from where it
//! is kept rather than copied by hand:
//!
//! * ZIPP's own browser preamble (`crates/zipp-wasm/src/preamble.js` at the
//!   tag Cargo.toml names), which `../build.mjs` copies to `generated/` from
//!   the checkout Cargo resolved for zipp-vm, with its digest;
//! * SoftN's server shim, the `SHIM` template in the PHP host's
//!   `runtime/wasm-host.mjs`.
//!
//! Together they are what the Node runner's engine compiles ahead of the same
//! logic, so a script sees the same globals under either runner.

use std::path::PathBuf;

fn main() {
    let dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR"));
    let out = PathBuf::from(std::env::var("OUT_DIR").expect("cargo sets OUT_DIR"));

    let preamble_path = dir.join("generated/zipp-preamble.js");
    println!("cargo:rerun-if-changed={}", preamble_path.display());
    let preamble = std::fs::read_to_string(&preamble_path).unwrap_or_else(|e| {
        panic!(
            "cannot read {}: {e}\nBuild the runner with `node apps/softn-runner/build.mjs`, which copies \
             ZIPP's preamble from the checkout Cargo resolved.",
            preamble_path.display()
        )
    });

    let host_path = dir.join("../../softn-host-php/runtime/wasm-host.mjs");
    println!("cargo:rerun-if-changed={}", host_path.display());
    let host = std::fs::read_to_string(&host_path)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", host_path.display()));
    let open = "const SHIM=`";
    let start = host.find(open).expect("wasm-host.mjs no longer declares `const SHIM=`...`") + open.len();
    let end = start + host[start..].find("`;").expect("wasm-host.mjs's SHIM template is not closed");
    let shim = &host[start..end];
    // Plain text: a template with a substitution or an escape would be
    // something else once evaluated, and this copies it as written.
    assert!(
        !shim.contains("${") && !shim.contains('\\'),
        "wasm-host.mjs's SHIM now has a substitution or an escape; read it as JavaScript would"
    );

    std::fs::write(out.join("zipp-preamble.js"), preamble).expect("write zipp-preamble.js");
    std::fs::write(out.join("softn-shim.js"), shim).expect("write softn-shim.js");
}
