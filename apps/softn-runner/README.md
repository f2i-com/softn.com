# softn-runner

An app's private server logic, answered without Node.

The PHP host (`apps/softn-host-php`) and FormLogic start a runner for every
request to a native app's backend: the request as JSON on stdin, the backend
root in `SOFTN_BACKEND_ROOT`, one line on stdout, `{"status":N,"body":...}`.
That runner has been `runtime/runner.mjs`, which needs Node on the server.
`softn-runner` takes the same request and answers it the same way, as one
program of its own.

## How it is built

Two halves, each its own Cargo workspace:

- **`guest/`**: the ZIPP engine (zipp-vm, from the tag
  `packages/@softn/core/wasm-zipp` installs, with the browser engine's
  features) compiled to WebAssembly for WASI. It runs the app's logic behind
  the same preamble the Node runner's engine compiles ahead of it: ZIPP's own
  browser preamble and SoftN's shim (taken from `wasm-host.mjs` at build
  time), and calls the route's handler. It reaches the runner only through two
  imports, `softn.ask` and `softn.take`.
- **`host/`**: the trusted half, native: the operator's configuration and the
  bundle checked, migrations, the rate limit, the database (SQLite, as
  `node:sqlite` opens it), `softn.sql`, `softn.crypto` and `softn.time`, and the
  guest run under wasmtime. Each part is a port of the Node runner's file of
  the same job (`request-worker.mjs`, `wasm-host.mjs`, `sql.mjs`,
  `migrations.mjs`, `record-events.mjs`, `crypto.mjs`); `softn.time` is the
  Rust host's own `bridges/time.rs`, compiled in from there (`shared/`).

The guest is compiled once, at build time, into the runner (`host/build.rs`),
so a request deserialises it rather than compiling it.

## How an app is kept in

- The app's logic runs inside a WebAssembly instance: nothing it does can
  reach the runner's memory, the file system, the network or the operator's
  key. Its only door is `db.query`, and the runner decides every answer: the
  SQL authorizer keeps it to the app's own tables, as on every SoftN host.
- The instance has the clock and randomness, and nothing else: no directory,
  no environment, no stdio. Its memory is capped at 1 GiB; ZIPP's own
  accounting stops a script at 512 MiB, and its instruction budget at
  5,000,000 steps a request, as in the Node runner.
- The whole process has the Node runner's 20-second deadline, which ends it
  whatever it is doing, SQLite included. A quarter of a second before it, the
  app's logic and any SQL statement of the request still running are stopped,
  so the request fails, rolls back and is answered rather than killed.
- SQLite keeps its temporary tables and sorts in memory, and the process's
  SQLite memory is capped at 1 GiB, so a statement cannot fill the disk or
  the machine's memory before the deadline comes.

## Building

```sh
node apps/softn-runner/build.mjs                                   # this machine
node apps/softn-runner/build.mjs --target x86_64-unknown-linux-musl  # static Linux, as released
```

The runner is written to `dist/softn-runner-<platform>`. Each crate pins its
Rust (`rust-toolchain.toml`): the guest 1.92.0, ZIPP's release toolchain, with
the `wasm32-wasip1` target; the runner 1.99.0 (wasmtime 45 needs 1.93 or
newer). A static Linux build needs `x86_64-unknown-linux-musl` for the
runner's toolchain and musl's C compiler (`musl-tools`).

## Testing

```sh
cargo test --release --manifest-path apps/softn-runner/host/Cargo.toml
SOFTN_TEST_RUNNER=apps/softn-runner/dist/softn-runner-<platform> \
  node --test apps/softn-host-php/tests/route-declarations.test.mjs
```

The second runs the Node runner's own suite against the runner. CI does both
on the static Linux build (`.github/workflows/verify.yml`, job `runner`).

## Where it differs from the Node runner

- An operator's JavaScript hooks (`enableRequestHook`, `enableAfterRequestHook`)
  are modules the Node runner imports; this runner runs no JavaScript outside
  the guest and refuses a configuration that enables them.
- A stack frame inside SoftN's shim is named `zipp:preamble`, where the Node
  runner names it `logic`; frames of the app's own logic are named and
  numbered the same.
- The soft deadline and SQLite's memory above: under the Node runner a
  request that ran to the deadline was killed with no answer, and SQLite
  could spill to temporary files.
- `softn.time` is the Rust host's, on chrono, whose range ends before
  JavaScript's: `softn.time.format` of a time within two days of chrono's
  ends (the years 262,142 and -262,143) or past them is a failed host call,
  where Node formats times out to the years 275,760 and -271,821.
- SQLite is the one rusqlite bundles (3.53.2 for this release; Node 24.19
  carries 3.53.3).

## Where it ships

A release builds it for static Linux x86-64 and Windows x86-64
(`.github/workflows/release.yml`, job `runner`) and carries both in the
FormLogic archive as `native-runtime/bin/softn-runner-<platform>`, recorded in
`native-runtime/provenance.json`. Beside them goes
`SOFTN-RUNNER-THIRD-PARTY-LICENSES.txt`, which `build.mjs` writes from Cargo's
own record of what the two halves compile in: every crate, its licence, and
the licence files it ships (`build.mjs --notices` writes it alone).
