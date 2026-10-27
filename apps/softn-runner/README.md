# softn-runner

An app's private server logic, answered without Node.

The PHP host (`apps/softn-host-php`) and FormLogic start a runner for every
request to a native app's backend: the request as JSON on stdin, the backend
root in `SOFTN_BACKEND_ROOT`, one line on stdout, `{"status":N,"body":...}`.
That runner has been `runtime/runner.mjs`, which needs Node on the server.
`softn-runner` takes the same request and answers it the same way, as one
program of its own. Both hosts start it where it is there: the PHP host from
its backend's `bin/` (`runtime/request.php` `softn_runner_choice`, which keeps
Node where the operator asks for it or enables a request hook), FormLogic
from its runtime's `native-runtime/bin/`.

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
  no environment, no stdio. Its memory is capped at what the host gives a
  request (below); ZIPP's own accounting stops a script 64 MiB short of it
  (the request fails, and the log says "script exceeded its memory budget"),
  and its instruction budget at 5,000,000 steps a request, as in the Node
  runner.
- The whole process has the Node runner's 20-second deadline, which ends it
  whatever it is doing, SQLite included. A quarter of a second before it, the
  app's logic and any SQL statement of the request still running are stopped
  and no further host call runs, so the request fails, rolls back and is
  answered rather than killed (a request still waiting for the database lock
  then is not: that wait is SQLite's).
- Once SQLite has ended a request's transaction under it (a statement's
  `ON CONFLICT ROLLBACK`, an error it rolls back for, a write the deadline
  interrupted), no further host call runs: each would commit by itself. The
  request answers host_error, or its own answer if it asked for the rollback.
  The Node runner and the Rust host do the same.
- SQLite keeps its temporary tables and sorts in memory, and its memory is
  capped at what the host gives a request, so a statement cannot fill the
  disk; a query result past its 2 MiB is refused before the runner copies the
  values that put it there.

## The process's own lockdown (Linux)

Behind the engine's sandbox and wasmtime's, the runner locks its own process
down before it reads the request or starts a thread (`host/src/lockdown.rs`),
with the kernel's own means: an unprivileged process may always restrict
itself, so it needs no root, no container and nothing installed, and every
thread it starts afterwards inherits it.

- **Its own session, and nothing gained**: no controlling terminal (setup.php
  starts it from the operator's), no_new_privs, no core file, and a umask of
  077 for what it makes.
- **Landlock** (Linux 5.13 and later): it may read the backend folder; in its
  database folder (`private/data`) and rate-limit notes (`private/limited`)
  make, write, truncate and remove regular files (and, in the notes,
  folders); and read `/dev/urandom` (SQLite seeds from it) and the system's
  time zone (`/etc/localtime`, `/usr/share/zoneinfo`: SQLite's `localtime`
  reads it where the host sets no TZ). Any other open is refused, and no
  device, link, socket or pipe can be made anywhere. Where the kernel has
  them, TCP binds and connects (6.7), signals and abstract sockets outside
  the lockdown (6.12) and pathname sockets (7.1) are refused too. Landlock
  does not govern a file's mode, owner, times or attributes, nor, before
  6.2, truncate by path: seccomp refuses those.
- **seccomp**, failing with EPERM: any system call of another ABI (i386, and
  x32's numbers, which a filter keyed on x86-64's would let through); running
  a program; making a process (a thread is allowed); sockets of any kind;
  signals, limits, scheduling and memory calls aimed at any other process
  (`kill`, `tkill`, `tgkill`, `rt_sigqueueinfo`, `prlimit64`, `ptrace`,
  `process_vm_*`, `fcntl` `F_SETOWN`); io_uring; a file's mode, owner, times
  or attributes changed by path (the runner sets its own through handles);
  links and device nodes; typing into a terminal (`TIOCSTI`); and the calls
  that only widen the kernel's surface (mounts, namespaces, BPF, perf,
  userfaultfd, keys, modules, kexec).

A kernel without Landlock still gets the seccomp filters, and the other way
round; one with neither runs the runner as before. Without Landlock, other
processes of the runner's account stay reachable through `/proc` (a
dumpable one's memory, say), which only Landlock closes. `softn-runner
--check-lockdown` (with `SOFTN_BACKEND_ROOT`) prints what this system
enforced and then tries a folder outside the backend (one it could list
before), a socket, a new process, a program, a signal to its parent (`kill`
and `tkill`), a mode changed by path, a symbolic link and an x32 call, each
reported denied, allowed or untried; the PHP host's `setup.php` says so in
words, and names anything that was not refused. The tests in
`apps/softn-host-php/tests/http-runner.test.mjs` hold the probes to it, and
every request in that suite and in `route-declarations.test.mjs` runs locked
down. Windows has no counterpart yet.

## Memory

The host says how much memory one request may take, in
`SOFTN_RUNNER_MEMORY_MB` (`host/src/limits.rs`): a whole number of MiB from
128 to 1024, and 1024 when it says nothing, which is FormLogic's case, as its
Node runner's engine has 1 GiB. The PHP host says 256, what its Node runner's
engine is held to, or the operator's `requestMemoryMb`. The app's engine may
grow to that, a script's heap to 64 MiB less (512 MiB at most), and SQLite to
that again.

What a request does take is far less. The engine's compiled code, 20 MB, is
part of the program. On Linux it runs where it lies in the program's pages
(`InPlace` in `host/src/guest.rs`), which every runner on the server shares,
and only the parts a request runs are read from disk; where the system will
not let those pages be made executable, and on Windows, it is copied into
memory of the process's own, as it always was. Peak memory of one request on
Linux (musl build, WSL; Node's runner beside it):

| request | softn-runner | copied, as before | Node's runner |
| --- | ---: | ---: | ---: |
| a handler that only answers | 14.6 MB | 47 MB | 100 MB |
| an insert and a count | 15.4 MB | 47 MB | 100 MB |
| 150,000 small objects made | 64 MB | 96 MB | 139 MB |
| a 20 MB string made | 69 MB | 100 MB | 122 MB |

The copy also cost 9 ms of a request's 40.

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
(cd apps/softn-runner/host && cargo test --release --locked)   # both ways of loading the engine, the memory limits
SOFTN_TEST_RUNNER=apps/softn-runner/dist/softn-runner-<platform> \
  node --test apps/softn-host-php/tests/route-declarations.test.mjs
```

The first runs in the crate's folder, so that its `rust-toolchain.toml` picks
Rust 1.99.0; from elsewhere, cargo takes the default toolchain, and one older
than 1.93 cannot build wasmtime. The second runs the Node runner's own suite against the runner. CI does both
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
- Memory is the host's to set (`SOFTN_RUNNER_MEMORY_MB`, Memory, above); the
  Node runner's engine has what its archive gives it (256 MiB in the PHP
  host's, 1 GiB in FormLogic's) and Node's own heap 128 MiB.
- On Linux the process locks itself down (above); the Node runner's process
  can do whatever its account can.
- A request nested more than 1,000 levels deep is refused as invalid, where
  JSON.parse takes any depth. No host sends one: PHP's json_decode passes on
  none past 512 levels (FormLogic), and the PHP host none past 63. The logic
  sees nothing past 64 levels on either runner.
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
`native-runtime/provenance.json`, and the Linux one in the PHP host's two
archives with a backend as `backend/bin/softn-runner-linux-x86_64`, recorded
in their `BUILD-INFO.json` (`softnRunner`; `npm run package:single --
--with-backend --runner-dir <dir>` and `npm run package:private-single-php --
--runner-dir <dir>` take it from where `build.mjs` wrote it). Beside them goes
`SOFTN-RUNNER-THIRD-PARTY-LICENSES.txt`, which `build.mjs` writes from Cargo's
own record of what the two halves compile in: every crate, its licence, and
the licence files it ships (`build.mjs --notices` writes it alone).
