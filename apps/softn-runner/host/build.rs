//! Precompile the guest at build time.
//!
//! `softn-runner-guest.wasm` (copied here from ../guest by ../build.mjs, never
//! committed) is compiled with Cranelift into wasmtime's serialised form and
//! embedded by guest.rs. As in FormLogic's sandbox launcher:
//!
//! * the target triple is named explicitly, the one this runner is built for,
//!   so the code is baseline for that target and not tuned to this machine's
//!   CPU (a module compiled with AVX-512 would refuse to load on a server
//!   without it);
//! * the configuration is src/engine_config.rs, shared with guest.rs, because
//!   wasmtime checks it when the module is loaded;
//! * the compile runs on a thread with a large stack: ZIPP's interpreter is one
//!   very large function, and Cranelift recurses deeply over it, past the
//!   1 MiB a Windows main thread has.

include!("src/engine_config.rs");

fn main() {
    let guest = "softn-runner-guest.wasm";
    println!("cargo:rerun-if-changed={guest}");
    println!("cargo:rerun-if-changed=src/engine_config.rs");
    let wasm = std::fs::read(guest).unwrap_or_else(|e| {
        panic!("cannot read {guest}: {e}\nBuild the runner with `node apps/softn-runner/build.mjs`, which builds the guest first.")
    });
    let target = std::env::var("TARGET").expect("cargo sets TARGET");
    let mut config = base_engine_config();
    config.target(&target).unwrap_or_else(|e| panic!("wasmtime cannot target {target}: {e}"));
    let compiled = std::thread::Builder::new()
        .name("precompile-guest".into())
        .stack_size(512 * 1024 * 1024)
        .spawn(move || {
            let engine = wasmtime::Engine::new(&config).expect("wasmtime engine for precompilation");
            engine.precompile_module(&wasm).unwrap_or_else(|e| panic!("precompiling the guest failed: {e}"))
        })
        .expect("spawn precompile thread")
        .join()
        .expect("precompile thread panicked");
    let out = std::path::PathBuf::from(std::env::var("OUT_DIR").expect("cargo sets OUT_DIR")).join("guest.cwasm");
    std::fs::write(&out, compiled).expect("write guest.cwasm");
}
