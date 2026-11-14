# WebAssembly

Three programs compiled from Rust, run by one SoftN app, each in a sandboxed
worker of its own:

- `src/game.rs`: a brick-breaking game for `<WasmApp>`. It draws a 240×180
  frame of pixels each frame, hears the arrow keys and the pointer, beeps, and
  posts its score to the app, which shows it; the app's buttons call its
  `reset` and `set_speed` functions with `softn.wasm.call`. Written without
  the standard library, so it is a few kilobytes.
- `src/stats.rs`: a library for `softn.wasm.load` and `softn.wasm.call`: a
  text of numbers in, a JSON summary out (`returns: "json"`), and primes
  counted by a sieve.
- `src/wordfreq.rs`: a command-line program built for WASI, run with
  `softn.wasm.run`: it reads the text on stdin, prints the most used words,
  says how many there were on stderr, and writes `report.csv`, which comes
  back with the result.

`ui/main.ui` and `logic/main.logic` are the app. It asks for no permission:
a module from the app's own files reaches nothing but what SoftN gives it.

Build the bundle with `node examples/webassembly/build.mjs`, which packs the
`.wasm` files in `assets/`. With `--rust` it compiles them from `src/` first
(rustc alone; `rustup target add wasm32-unknown-unknown wasm32-wasip1`). Then
open `examples/webassembly/WebAssembly.softn` in the runtime (`/web/`, the +
button, or drop the file on the page). The guide's page "WebAssembly in SoftN
apps" describes the calls and the component.
