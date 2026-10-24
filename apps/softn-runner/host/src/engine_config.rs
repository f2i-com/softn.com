// Shared between build.rs (which COMPILES the guest) and guest.rs (which only
// DESERIALISES it): wasmtime refuses a precompiled module whose
// configuration differs from the engine loading it, so every setting that
// affects the artifact is here, once, and both sides `include!` it. (The
// arrangement is FormLogic's sandbox launcher's.)

/// The engine configuration the guest is compiled for and loaded with.
fn base_engine_config() -> wasmtime::Config {
    let mut config = wasmtime::Config::new();
    // Epoch: a wall-clock stop for the guest, checked by the code Cranelift
    // emits, so an instance still running near the deadline traps and its
    // request is answered as failed, whatever the interpreter is doing.
    // ZIPP's own instruction budget is what ordinarily stops a script.
    config.epoch_interruption(true);
    // The guest's native call stack (its WebAssembly frames) is wasmtime's
    // default, 512 KiB; the engine's own 16 MiB stack lives in its linear
    // memory. The request thread it runs on has 64 MiB (main.rs), so SQLite's
    // own recursion has room below a guest at its deepest.
    // Pinned, because the default is read from the environment
    // (WASMTIME_BACKTRACE_DETAILS) and is part of the artifact's
    // compatibility check: a runner built in a shell with that variable set
    // would refuse its own guest everywhere else.
    config.wasm_backtrace_details(wasmtime::WasmBacktraceDetails::Disable);
    config
}
