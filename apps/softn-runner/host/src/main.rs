//! softn-runner: a SoftN app's private server logic, answered without Node.
//!
//! PHP starts one per request, as it starts the Node runner (the PHP host's
//! runtime/runner.mjs, FormLogic's NativeAppService): the request as JSON on
//! stdin, the backend root in SOFTN_BACKEND_ROOT, and one line on stdout,
//! `{"status":N,"body":...}`. What happens in between is the Node runner's,
//! port for port (worker.rs, host_calls.rs, sql.rs, migrations.rs,
//! record_events.rs): the trusted half here, natively; the app's logic in a
//! WebAssembly guest (guest.rs), ZIPP's safe-sandbox engine with nothing but
//! this process to ask.

mod guest;
mod host_calls;
mod js;
mod migrations;
mod record_events;
mod sql;
mod worker;

use std::{
    io::{Read, Write},
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};

/// When work this runner can stop by itself stops: a little before the
/// process deadline, so a request-time SQL statement or the app's logic that
/// runs that long ends as a failed request, rolled back and answered, rather
/// than by the kill. (The Node runner had only the kill.) A migration is not
/// stopped here: the deadline and its note decide what happens to it.
static SOFT_DEADLINE: OnceLock<Instant> = OnceLock::new();

pub fn soft_deadline() -> Instant {
    // main sets it first thing; unset (a unit test), it is an hour away.
    *SOFT_DEADLINE.get_or_init(|| Instant::now() + Duration::from_secs(3600))
}

/// Why something failed: a reason this runner wrote (told to a script as it
/// is, as a plain `Error` is in the Node runner), or a library's (told only
/// as which kind of call failed; the operator's log has the rest).
#[derive(Debug)]
pub enum HostError {
    Own(String),
    Library(String),
}

impl HostError {
    pub fn own(message: impl Into<String>) -> Self {
        HostError::Own(message.into())
    }

    pub fn library(error: impl std::fmt::Display) -> Self {
        HostError::Library(error.to_string())
    }

    /// A SQLite error in SQLite's own words, as node:sqlite gives it: rusqlite
    /// adds a statement's text to a syntax error ("… in SELECT … at offset
    /// 7"), which would put an app's SQL in the operator's log.
    pub fn sqlite(error: rusqlite::Error) -> Self {
        match error {
            rusqlite::Error::SqlInputError { msg, .. } => HostError::Library(msg),
            other => HostError::Library(other.to_string()),
        }
    }

    pub fn reason(&self) -> &str {
        match self {
            HostError::Own(m) | HostError::Library(m) => m,
        }
    }

    /// SQLite's "database is busy/locked" (request-worker.mjs `busy`).
    pub fn busy(&self) -> bool {
        let text = self.reason().to_ascii_lowercase();
        text.contains("database is locked") || text.contains("database is busy") || text.contains("database table is locked")
    }
}

/// The migration running, so the deadline can say which one it stopped.
pub struct Migration {
    pub name: String,
    pub file: String,
    pub sha256: String,
    pub marker: PathBuf,
    pub attempts: u32,
}

/// The deadline (runner.mjs): twenty seconds; a test may shorten it, and
/// setup.php's own run may lengthen it for a migration.
fn deadline_ms() -> u64 {
    if let Some(ms) = migrations::setup_deadline_ms() {
        return ms;
    }
    // `Number(process.env.SOFTN_RUNNER_DEADLINE_MS)`, a whole number from 1 to 20,000.
    let shortened = std::env::var("SOFTN_RUNNER_DEADLINE_MS").ok().map(|t| js::number_of(Some(&serde_json::Value::String(t)))).unwrap_or(f64::NAN);
    if shortened.fract() == 0.0 && (1.0..=20_000.0).contains(&shortened) { shortened as u64 } else { 20_000 }
}

/// A migration the deadline stopped: written down where the next request
/// reads it before starting the same migration again (runner.mjs `stopped`).
fn stopped(m: &Migration, ms: u64) {
    let mut stops = 1;
    if let Ok(text) = std::fs::read_to_string(&m.marker) {
        if let Ok(was) = serde_json::from_str::<serde_json::Value>(&text) {
            if was.get("name").and_then(|v| v.as_str()) == Some(&m.name) && was.get("sha256").and_then(|v| v.as_str()) == Some(&m.sha256) {
                stops = was.get("stops").and_then(|v| v.as_f64()).map_or(0, |n| n as u64) + 1;
            }
        }
    }
    let note = serde_json::json!({ "name": m.name, "sha256": m.sha256, "stops": stops });
    if std::fs::write(&m.marker, note.to_string()).is_ok() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&m.marker, std::fs::Permissions::from_mode(0o600));
        }
        let _ = writeln!(
            std::io::stderr(),
            "softn: startup stage database_migrations: migration {} was stopped at the {} s deadline ({stops} of {})",
            m.file,
            js::number_text(ms as f64 / 1000.0),
            m.attempts
        );
    }
}

/// End the process now, whatever the other thread is doing: inside SQLite,
/// a statement that never finishes is native code nothing interrupts, and the
/// process must not outlive its deadline holding the write lock.
fn kill() -> ! {
    let _ = std::io::stderr().flush();
    #[cfg(unix)]
    unsafe {
        libc::kill(libc::getpid(), libc::SIGKILL);
    }
    #[cfg(windows)]
    unsafe {
        windows_sys::Win32::System::Threading::TerminateProcess(windows_sys::Win32::System::Threading::GetCurrentProcess(), 1);
    }
    std::process::abort()
}

fn main() {
    let started = Instant::now();
    let ms = deadline_ms();
    // A quarter of a second before the kill (less for a deadline shorter than
    // 2.5 s): what still finishes in time under the Node runner finishes here.
    let _ = SOFT_DEADLINE.set(started + Duration::from_millis(ms - (ms / 10).min(250)));
    // A fault in the runner itself is told to the operator's log in the
    // log's own form, without the source paths a panic message carries; the
    // request it happened in is answered as failed (below, and host_calls.rs).
    std::panic::set_hook(Box::new(|info| js::log_failure("host fault", &info.to_string())));
    let migration: Arc<Mutex<Option<Migration>>> = Arc::new(Mutex::new(None));
    let watched = Arc::clone(&migration);
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(ms));
        if let Ok(running) = watched.try_lock() {
            if let Some(m) = running.as_ref() {
                stopped(m, ms);
            }
        }
        kill();
    });

    let mut input = Vec::new();
    let read = std::io::stdin().take(6_000_001).read_to_end(&mut input);
    if read.is_err() || input.len() > 6_000_000 {
        std::process::exit(1);
    }
    let input = String::from_utf8_lossy(&input).into_owned();

    // The Node runner's worker resolves the backend root as it loads, before
    // the request: one that cannot be resolved ends the runner with no answer
    // and its error's code in the log (runner.mjs's 'error' handler).
    let root = match worker::backend_root() {
        Ok(root) => root,
        Err(code) => {
            let _ = writeln!(std::io::stderr(), "softn: runner worker died: {code}");
            std::process::exit(1);
        }
    };

    // On a thread of its own with a large stack: SQLite's expression code,
    // wasmtime's frames for the guest and the runner's own all share it, and a
    // Windows main thread has 1 MiB.
    let request = std::thread::Builder::new()
        .name("request".into())
        .stack_size(64 * 1024 * 1024)
        .spawn(move || {
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| match guest::Guest::load() {
                Ok(guest) => worker::run(&root, &input, &guest, &migration),
                Err(error) => {
                    js::log_failure("startup stage wasm_initialization", error.reason());
                    worker::Answer {
                        status: 503,
                        body: js::stringify(&serde_json::json!({ "error": "The backend is unavailable. Check its private configuration.", "code": "backend_unavailable", "diagnostic": "wasm_initialization" })),
                    }
                }
            }))
        });
    let answer = match request.map(|thread| thread.join()) {
        Ok(Ok(Ok(answer))) => answer,
        // A fault the request did not catch: the database rolls back with the
        // connection, and the answer is the host error a handler's failure is.
        _ => worker::Answer {
            status: 500,
            body: js::stringify(&serde_json::json!({ "error": "The request could not be completed.", "code": "host_error" })),
        },
    };
    let mut out = std::io::stdout().lock();
    let _ = write!(out, "{{\"status\":{},\"body\":{}}}", answer.status, answer.body);
    let _ = out.flush();
}
