//! Server-side `.logic` execution, on the zipp JavaScript engine.
//!
//! A `ScriptState` pins raw pointers into its own heap and is deliberately not
//! `Send`, so each VM is built on — and stays on — one worker thread. That
//! matches the pool design here, which was already one engine per thread.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use zipp_vm::embed::{compile_script, HostValue, ScriptState, SymbolScope};

use crate::host;
pub use crate::host::BridgeSet;

/// Host bridge definitions prepended to every script. See `preamble.js`.
const PREAMBLE: &str = include_str!("preamble.js");

/// How a worker returns to pristine globals between handler calls, so one
/// request's side-effects cannot bleed into the next on the same worker.
///
/// The engine hands globals over as `HostValue`, a *projection*: it carries data
/// faithfully but loses everything else. Writing such a projection back rebuilds
/// a plain object, which silently drops a class instance's prototype, breaks
/// aliasing and cycles, and cannot touch a `Map`/`Set`/`Date`/`RegExp` at all
/// (the engine refuses to overwrite an opaque slot, so its contents survive into
/// the next request). Restoring is therefore only sound for globals that are
/// pure primitives.
enum Isolation {
    /// Every top-level variable is a primitive. Restoring is exact and cheap.
    Restore(PrimitiveSnapshot),
    /// At least one global holds an object, array or opaque value. Nothing that
    /// reads back through `HostValue` can restore those faithfully, so the VM is
    /// rebuilt after any call that ran. Scripts are told not to keep state in
    /// globals; this makes that guidance enforceable rather than advisory.
    Rebuild,
}

/// Slot indices and their post-init primitive values, kept apart so a handler
/// that touched nothing compares equal and writes nothing back.
struct PrimitiveSnapshot {
    indices: Vec<u32>,
    values: Vec<HostValue>,
}

/// Whether `source` declares a class at the start of a line.
///
/// Deliberately textual and deliberately loose. The engine reports a class in
/// the same symbol scope as a function, so there is nothing to inspect after
/// compilation, and erring towards the sound-but-slower path is the right way
/// to be wrong. A `class` inside a string or comment costs that script a
/// rebuild per request; missing a real one would leak its statics.
fn declares_class(source: &str) -> bool {
    source
        .lines()
        .any(|l| l.trim_start().starts_with("class ") || l.trim_start().starts_with("class	"))
}

/// Whether a value survives the `HostValue` round trip unchanged.
fn is_primitive(v: &HostValue) -> bool {
    matches!(
        v,
        HostValue::Undefined | HostValue::Null | HostValue::Bool(_)
            | HostValue::Number(_) | HostValue::String(_)
    )
}

/// Whether a global-mutation warning has already been logged for this worker.
/// Set once per worker thread to avoid log spam — developers used to Node.js
/// will often try global caching, and we want to warn them exactly once.
struct MutationWarned(bool);

/// Warn if the globals snapshot exceeds this many slots after init.
/// The snapshot is re-read and compared before every handler call, so an
/// excessive number of globals usually indicates a script anti-pattern (loading
/// large data structures into module-level variables instead of using db.* APIs).
const MAX_GLOBALS_SNAPSHOT_SLOTS: usize = 5_000;

/// Bytecode instructions one handler call may execute before the engine stops
/// it with an uncaught `RangeError` the script cannot catch.
///
/// Re-applied before every call, because the budget is per-VM and would
/// otherwise span the worker's whole life. That has a cost: re-applying it
/// discards the engine's compiled code, so a handler never keeps a JIT tier
/// across requests. Handler bodies are short and dominated by bridge work
/// (SQLite, HTTP), so this buys a hard per-request bound for little — but it is
/// the knob to revisit if a CPU-heavy handler ever needs the tier.
const MAX_STEPS_PER_CALL: u64 = 100_000_000;

/// VM wall-time. Must stay under the HTTP/WS timeout (30s) so the engine
/// terminates and sends a clean error before the outer timeout fires.
///
/// The step budget alone cannot bound this: one native builtin — a huge
/// `JSON.parse`, a catastrophic regex — is a single instruction. The watchdog
/// thread is what makes wall-time real.
const WALL_TIME_MS: u64 = 25_000;

/// Grace beyond the wall-time limit after which a call that has ignored its
/// abort flag is treated as wedged rather than slow.
///
/// The flag is polled between instructions, so a script sitting inside ONE long
/// native builtin — a catastrophic regex, a huge `JSON.parse` — never sees it. That thread cannot be killed from safe Rust, so the pool
/// abandons it and starts a replacement instead of losing a worker for good.
const WEDGE_GRACE_MS: u64 = 25_000;

/// How many abandoned threads the pool will tolerate before it stops replacing
/// them. Each one keeps burning a core, so replacing without limit turns a
/// wedged-worker problem into a CPU-exhaustion one. Past this the server keeps
/// serving on a reduced pool and says so.
const MAX_ABANDONED_WORKERS: usize = 8;

/// The longest [`ServerRuntime::call`] will wait for a worker's reply.
///
/// A call the watchdog aborts returns just after the wall-time limit, so this
/// only has to clear that. It deliberately does NOT cover the wedge grace: once
/// a worker is wedged its reply is never coming, and waiting the extra time
/// only pins the caller's blocking thread for longer.
///
/// Every timeout layered above a handler must EXCEED this, or the outer one
/// fires first on a call that was going to answer — and dropping a
/// `spawn_blocking` handle does not cancel the work, so it goes on to commit
/// after the client has been told it failed.
pub const MAX_CALL_WAIT: Duration = Duration::from_millis(WALL_TIME_MS + 5_000);

/// How often the watchdog looks for overrunning calls. The engine polls the
/// abort flag every few thousand instructions, so the true overshoot is this
/// plus a poll interval — well inside the 5s margin to the HTTP timeout.
const WATCHDOG_TICK: Duration = Duration::from_millis(250);

/// Global cap on total worker threads across all ServerRuntime instances.
/// Prevents accidental thread exhaustion if multiple runtimes are created
/// (e.g. during testing or future multi-tenancy). Each OS thread consumes
/// ~8MB of stack, so 200 threads ≈ 1.6GB of stack alone.
const MAX_GLOBAL_WORKER_THREADS: usize = 200;
static GLOBAL_WORKER_COUNT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// Process start, so deadlines can live in an `AtomicU64` as milliseconds.
/// A monotonic base — unlike the wall clock, it cannot jump backwards and
/// leave a runaway script running.
fn elapsed_ms() -> u64 {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_millis() as u64
}

/// Names the preamble declares. Engine plumbing, not script state: excluded
/// from the symbol list the server reports and from the globals snapshot.
///
/// Derived by compiling the preamble alone rather than hard-coded, so editing
/// `preamble.js` cannot silently leak a new helper into script state.
fn preamble_names() -> &'static HashSet<String> {
    static NAMES: OnceLock<HashSet<String>> = OnceLock::new();
    NAMES.get_or_init(|| {
        match compile_script(PREAMBLE) {
            Ok(mut probe) => {
                // The preamble only declares; running it cannot reach the host.
                let _ = probe.run_init();
                probe.symbols().into_iter().map(|s| s.name).collect()
            }
            Err(e) => {
                tracing::error!("Preamble failed to compile: {}", e);
                HashSet::new()
            }
        }
    })
}

/// Per-worker deadline the watchdog thread watches.
struct CallGuard {
    /// Polled by the engine mid-execution; set by the watchdog on overrun.
    abort: Arc<AtomicBool>,
    /// `elapsed_ms()` by which the in-flight call must finish. 0 when idle.
    deadline_ms: AtomicU64,
    /// Set once the watchdog has given up on this worker and replaced it, so it
    /// is neither warned about nor replaced twice.
    abandoned: AtomicBool,
}

impl CallGuard {
    fn new() -> Self {
        Self {
            abort: Arc::new(AtomicBool::new(false)),
            deadline_ms: AtomicU64::new(0),
            abandoned: AtomicBool::new(false),
        }
    }

    /// Arm for a call that may run for `WALL_TIME_MS`.
    fn arm(&self) {
        self.abort.store(false, Ordering::Relaxed);
        self.deadline_ms.store(elapsed_ms() + WALL_TIME_MS, Ordering::Relaxed);
    }

    /// Disarm — the worker is idle and must not be aborted.
    fn disarm(&self) {
        self.deadline_ms.store(0, Ordering::Relaxed);
    }
}

enum ScriptRequest {
    Init {
        source: String,
        reply: std::sync::mpsc::Sender<Result<(Vec<String>, usize), String>>,
    },
    Call {
        name: String,
        args: Vec<serde_json::Value>,
        reply: std::sync::mpsc::Sender<Result<serde_json::Value, String>>,
    },
}

/// Everything one worker keeps between requests.
struct Worker {
    state: ScriptState,
    /// Top-level name → global slot, for calls by name.
    slots: HashMap<String, u32>,
    isolation: Isolation,
    /// Shared with the VM's host closure so rebuilding the VM does not rebuild
    /// the bridges — a fresh `ureq` agent and DB handle per request would cost
    /// far more than the recompile.
    bridges: Rc<RefCell<BridgeSet>>,
    /// The script this worker runs, so it can rebuild itself.
    source: Rc<str>,
    /// Whether a handler has run since the globals were last known clean. A
    /// rebuild re-executes the script's top level — including any `db.create`
    /// or `http.get` written there — so it must not happen on a worker that has
    /// not run anything since the last one.
    dirty: bool,
}

/// Wraps zipp VMs behind a pool of dedicated OS threads.
///
/// Architecture:
/// - Each worker has a **dedicated** init channel (guarantees 1:1 delivery).
/// - After init, workers pull Call requests from a **shared** MPMC channel
///   so idle workers pick up tasks automatically.
/// - Pool is sized for I/O-bound workloads (scripts may block on HTTP/DB).
///
/// **Single-tenant design:** This runtime creates one thread pool per
/// `ServerRuntime` instance. The softn-server currently hosts a single
/// `.softn` bundle per process. If multi-tenancy is added in the future
/// (hosting multiple bundles on one server), a shared global worker pool
/// should replace per-runtime pools to prevent thread exhaustion (e.g.
/// 10 apps × 50 threads = 500 OS threads).
///
/// **Important for script authors:** Worker threads maintain independent global
/// state. Consecutive requests from the same user may hit different workers, so
/// global variables will appear to "reset" unpredictably between calls. Workers
/// also re-initialize after panics, discarding all in-memory state. **Never use
/// global variables as an in-memory cache or session store.** Always persist
/// state to the database (via `db.*` APIs) and treat each handler call as
/// stateless.
///
/// **Thread lifecycle:** Workers are tied to the channels owned by this struct.
/// When `ServerRuntime` is dropped (e.g. if `init()` fails), `work_tx` and
/// `init_txs` are dropped, causing all worker `recv()` calls to return `Err`,
/// which exits their loops cleanly. The watchdog exits on its own flag.
pub struct ServerRuntime {
    work_tx: crossbeam_channel::Sender<ScriptRequest>,
    /// One per worker — used only during init() for guaranteed 1:1 delivery.
    init_txs: Vec<crossbeam_channel::Sender<ScriptRequest>>,
    worker_count: usize,
    /// Global names extracted during init for lock-free has_function lookups.
    known_globals: OnceLock<HashSet<String>>,
    /// Tells the watchdog thread to exit when this runtime is dropped.
    watchdog_stop: Arc<AtomicBool>,
    /// The script every worker runs, kept so the watchdog can initialise a
    /// replacement for a wedged one.
    init_source: Arc<std::sync::Mutex<Option<String>>>,
    /// Replacement workers the watchdog started. Counted against the global
    /// thread cap like any other worker, and returned to it on drop.
    replacements: Arc<std::sync::atomic::AtomicUsize>,
}

impl ServerRuntime {
    /// Create a new runtime with a worker pool.
    /// `bridge_factory` is called once per worker thread to create isolated bridges.
    /// `configured_workers` overrides the auto-detected pool size if provided.
    pub fn new<F>(bridge_factory: F, configured_workers: Option<usize>) -> Arc<Self>
    where
        F: Fn() -> BridgeSet + Send + Sync + 'static,
    {
        // Size the pool for I/O-bound workloads: scripts may block on ureq HTTP
        // calls (up to 20s) or SQLite disk I/O, so we need more threads than CPUs.
        // All native bridges have bounded execution time:
        // - HTTP bridge: ureq with 20s timeout (< 25s VM wall-time limit)
        // - FS bridge: OS filesystem calls return or error, cannot hang indefinitely
        // - DB bridge: SharedDb uses Mutex (no deadlock; contention bounded by pool size)
        // This ensures spawn_blocking tasks always terminate.
        let worker_count = configured_workers
            .map(|n| n.clamp(1, 200))
            .unwrap_or_else(|| {
                std::thread::available_parallelism()
                    .map(|n| n.get().clamp(16, 50))
                    .unwrap_or(16)
            });

        // Enforce a global cap on worker threads to prevent thread exhaustion
        // from multiple runtimes (e.g. during testing or future multi-tenancy).
        let current_global = GLOBAL_WORKER_COUNT.load(Ordering::Relaxed);
        let available = MAX_GLOBAL_WORKER_THREADS.saturating_sub(current_global);
        if available == 0 {
            tracing::error!(
                "Global worker thread limit reached ({}) — cannot create new runtime",
                MAX_GLOBAL_WORKER_THREADS
            );
            panic!("Cannot start runtime: global worker thread limit ({}) exhausted", MAX_GLOBAL_WORKER_THREADS);
        }
        let worker_count = worker_count.min(available);
        GLOBAL_WORKER_COUNT.fetch_add(worker_count, Ordering::Relaxed);

        let factory = Arc::new(bridge_factory);
        // Bounded queue prevents memory exhaustion from request floods.
        // 2x worker_count gives enough headroom for burst absorption while
        // applying backpressure when all workers are saturated.
        let (work_tx, work_rx) = crossbeam_channel::bounded::<ScriptRequest>(worker_count * 2);
        let mut init_txs = Vec::with_capacity(worker_count);
        let mut guards = Vec::with_capacity(worker_count);

        for i in 0..worker_count {
            match Self::spawn_worker(format!("softn-worker-{}", i), factory.clone(), work_rx.clone()) {
                Ok((init_tx, guard)) => {
                    init_txs.push(init_tx);
                    guards.push(guard);
                }
                Err(e) => {
                    tracing::error!("Failed to spawn worker thread {}: {}", i, e);
                    panic!("Cannot start server: failed to spawn worker thread {}", i);
                }
            }
        }

        // One watchdog for the pool. Per-call timer threads would cost a thread
        // per request; this costs one and is what makes WALL_TIME_MS real.
        let watchdog_stop = Arc::new(AtomicBool::new(false));
        let init_source: Arc<std::sync::Mutex<Option<String>>> = Arc::new(std::sync::Mutex::new(None));
        let stop = watchdog_stop.clone();
        let wd_factory = factory.clone();
        let wd_work_rx = work_rx.clone();
        let wd_source = init_source.clone();
        let replacements_count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let wd_replacements = replacements_count.clone();
        if let Err(e) = std::thread::Builder::new()
            .name("softn-vm-watchdog".to_string())
            .spawn(move || {
                let mut guards = guards;
                let mut abandoned = 0usize;
                let mut next_id = guards.len();
                while !stop.load(Ordering::Relaxed) {
                    std::thread::sleep(WATCHDOG_TICK);
                    let now = elapsed_ms();
                    let mut replacements = Vec::new();
                    for g in &guards {
                        let deadline = g.deadline_ms.load(Ordering::Relaxed);
                        if deadline == 0 || g.abandoned.load(Ordering::Relaxed) {
                            continue;
                        }
                        // First overrun: ask the script to stop. The engine polls
                        // this every few thousand instructions.
                        if now >= deadline && !g.abort.swap(true, Ordering::Relaxed) {
                            tracing::warn!(
                                wall_ms = WALL_TIME_MS,
                                "Handler exceeded the {}s wall-time limit — aborting it",
                                WALL_TIME_MS / 1000
                            );
                        }
                        // Still running long after being asked to stop: it is
                        // inside a native builtin that never returns to the loop
                        // where the flag is read. The thread cannot be killed, so
                        // give up on it and start a replacement — otherwise a
                        // handful of such requests would retire the whole pool.
                        if now < deadline.saturating_add(WEDGE_GRACE_MS) {
                            continue;
                        }
                        g.abandoned.store(true, Ordering::Relaxed);
                        if abandoned >= MAX_ABANDONED_WORKERS {
                            tracing::error!(
                                abandoned = abandoned,
                                limit = MAX_ABANDONED_WORKERS,
                                "Worker wedged in a native call, but the abandoned-thread limit is \
                                 reached — NOT replacing it, so the pool is now smaller. This is \
                                 almost always a catastrophic regex or a huge JSON.parse."
                            );
                            continue;
                        }
                        // A replacement is an additional thread — the wedged one
                        // cannot be reclaimed — so it has to come out of the same
                        // global budget as any other worker.
                        if GLOBAL_WORKER_COUNT.fetch_add(1, Ordering::Relaxed) >= MAX_GLOBAL_WORKER_THREADS {
                            GLOBAL_WORKER_COUNT.fetch_sub(1, Ordering::Relaxed);
                            tracing::error!(
                                "Worker wedged, but the global thread limit ({}) leaves no room for                                  a replacement — the pool is now smaller.",
                                MAX_GLOBAL_WORKER_THREADS
                            );
                            continue;
                        }
                        abandoned += 1;
                        let source = wd_source.lock().ok().and_then(|s| s.clone());
                        let Some(source) = source else {
                            GLOBAL_WORKER_COUNT.fetch_sub(1, Ordering::Relaxed);
                            abandoned -= 1;
                            tracing::error!("Worker wedged before init completed — not replacing it");
                            continue;
                        };
                        match Self::spawn_worker(
                            format!("softn-worker-r{}", next_id),
                            wd_factory.clone(),
                            wd_work_rx.clone(),
                        ) {
                            Ok((init_tx, guard)) => {
                                // The replacement initialises itself off the same
                                // source; nothing is waiting on the reply.
                                let (reply_tx, _reply_rx) = std::sync::mpsc::channel();
                                if init_tx.send(ScriptRequest::Init { source, reply: reply_tx }).is_ok() {
                                    tracing::error!(
                                        abandoned = abandoned,
                                        "Worker wedged in a native call — abandoned it and started \
                                         a replacement. The stuck thread keeps consuming a core \
                                         until the process exits."
                                    );
                                    replacements.push(guard);
                                    wd_replacements.fetch_add(1, Ordering::Relaxed);
                                    next_id += 1;
                                } else {
                                    GLOBAL_WORKER_COUNT.fetch_sub(1, Ordering::Relaxed);
                                    abandoned -= 1;
                                }
                            }
                            Err(e) => {
                                GLOBAL_WORKER_COUNT.fetch_sub(1, Ordering::Relaxed);
                                abandoned -= 1;
                                tracing::error!("Failed to spawn replacement worker: {}", e);
                            }
                        }
                    }
                    guards.extend(replacements);
                }
            })
        {
            // Without the watchdog the step budget still bounds ordinary code;
            // only a script stuck inside one long native builtin escapes.
            tracing::error!("Failed to spawn VM watchdog ({}) — wall-time limits are not enforced", e);
        }

        tracing::info!("Script worker pool: {} threads (zipp engine)", worker_count);

        Arc::new(Self {
            work_tx,
            init_txs,
            worker_count,
            known_globals: OnceLock::new(),
            watchdog_stop,
            init_source,
            replacements: replacements_count,
        })
    }

    /// Spawn one worker: a thread, its dedicated init channel, and the guard the
    /// watchdog watches. Returns the init sender and the guard.
    fn spawn_worker<F>(
        name: String,
        factory: Arc<F>,
        work_rx: crossbeam_channel::Receiver<ScriptRequest>,
    ) -> Result<(crossbeam_channel::Sender<ScriptRequest>, Arc<CallGuard>), std::io::Error>
    where
        F: Fn() -> BridgeSet + Send + Sync + 'static,
    {
        let (init_tx, init_rx) = crossbeam_channel::bounded::<ScriptRequest>(1);
        let guard = Arc::new(CallGuard::new());
        let guard_clone = guard.clone();
        std::thread::Builder::new().name(name).spawn(move || {
            Self::script_thread(init_rx, work_rx, &*factory, &guard_clone);
        })?;
        Ok((init_tx, guard))
    }

    fn script_thread<F>(
        init_rx: crossbeam_channel::Receiver<ScriptRequest>,
        work_rx: crossbeam_channel::Receiver<ScriptRequest>,
        bridge_factory: &F,
        guard: &CallGuard,
    )
    where
        F: Fn() -> BridgeSet,
    {
        let mut worker: Option<Worker> = None;
        let mut init_source: Option<String> = None;
        let mut mutation_warned = MutationWarned(false);

        // Phase 1: Wait for Init on dedicated channel (guaranteed 1:1 delivery).
        match init_rx.recv() {
            Ok(req) => {
                if let ScriptRequest::Init { ref source, .. } = req {
                    init_source = Some(source.clone());
                }
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    Self::handle_request(req, &mut worker, &mut mutation_warned, bridge_factory, guard);
                }));
                if let Err(panic_info) = result {
                    Self::log_panic(&panic_info);
                    // The panic unwound past `init_worker`'s disarm, so the guard
                    // is still armed against a worker that is now idle. Left set,
                    // the watchdog would warn about it and then abandon it.
                    guard.disarm();
                    worker = None;
                }
            }
            Err(_) => return,
        }

        // Never joined the pool. On the startup path `init()` collects the error
        // and the server refuses to start; a watchdog-spawned replacement has
        // nobody waiting on its reply, so without this it would sit in the queue
        // answering "Runtime not initialized" to its share of every request,
        // silently and forever.
        if worker.is_none() {
            tracing::error!("Worker failed to initialise — exiting instead of joining the pool");
            return;
        }

        // Phase 2: Process Call requests from the shared MPMC queue.
        // Circuit breaker: if panics are too frequent, delay re-init to avoid
        // thrashing CPU with constant teardown/rebuild cycles from a deterministic
        // crash payload being repeatedly dispatched.
        const MAX_PANICS_IN_WINDOW: u32 = 3;
        const PANIC_WINDOW: Duration = Duration::from_secs(10);
        const COOLDOWN: Duration = Duration::from_secs(5);
        let mut panic_count: u32 = 0;
        let mut window_start = Instant::now();

        loop {
            let req = match work_rx.recv() {
                Ok(r) => r,
                Err(_) => break,
            };

            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                Self::handle_request(req, &mut worker, &mut mutation_warned, bridge_factory, guard);
            }));

            // The watchdog gave up on this thread mid-call and started a
            // replacement. The native call it was stuck in has now returned, but
            // the watchdog will never arm against this guard again — so rejoining
            // the pool would mean serving requests with no wall-time limit at all.
            if guard.abandoned.load(Ordering::Relaxed) {
                tracing::warn!(
                    "Abandoned worker finished its call — exiting rather than rejoining                      the pool, where it would run unbounded."
                );
                return;
            }

            if let Err(panic_info) = result {
                Self::log_panic(&panic_info);
                // A panic can unwind out of a call that armed the guard; leaving
                // it armed would have the watchdog abort the next request.
                guard.disarm();

                // Circuit breaker: track panic frequency
                let now = Instant::now();
                if now.duration_since(window_start) > PANIC_WINDOW {
                    // Reset window
                    panic_count = 1;
                    window_start = now;
                } else {
                    panic_count += 1;
                }

                if panic_count >= MAX_PANICS_IN_WINDOW {
                    tracing::error!(
                        panic_count = panic_count,
                        window_secs = PANIC_WINDOW.as_secs(),
                        cooldown_secs = COOLDOWN.as_secs(),
                        "ALERT: Worker panicked {} times in {}s — likely a deterministic crash payload. \
                         Sleeping {}s to prevent CPU thrashing. Investigate the panic messages above.",
                        panic_count, PANIC_WINDOW.as_secs(), COOLDOWN.as_secs()
                    );
                    // Sleep rather than drain the shared MPMC channel. A sleeping
                    // worker simply doesn't participate — healthy workers pick up
                    // all requests from the bounded queue. Draining would actively
                    // steal requests from healthy workers and fail them ("black hole").
                    std::thread::sleep(COOLDOWN);
                    panic_count = 0;
                    window_start = Instant::now();
                }

                // State is potentially corrupted — attempt re-init from stored source
                worker = None;
                if let Some(ref source) = init_source {
                    match Self::init_worker(source, bridge_factory, guard) {
                        Ok(w) => {
                            worker = Some(w);
                            tracing::info!("Worker re-initialized after panic");
                        }
                        Err(e) => {
                            tracing::error!("Worker failed to re-init after panic, exiting: {}", e);
                            // Exit the loop — a permanently broken worker draining
                            // requests and failing them all is worse than a reduced pool.
                            break;
                        }
                    }
                }
            }
        }
    }

    fn log_panic(panic_info: &Box<dyn std::any::Any + Send>) {
        let msg = if let Some(s) = panic_info.downcast_ref::<&str>() {
            (*s).to_string()
        } else if let Some(s) = panic_info.downcast_ref::<String>() {
            s.clone()
        } else {
            "unknown panic".to_string()
        };
        tracing::error!("Worker caught panic: {}", msg);
    }

    /// Compile source behind the preamble, attach bridges, run the top level.
    fn init_worker<F>(
        source: &str,
        bridge_factory: &F,
        guard: &CallGuard,
    ) -> Result<Worker, String>
    where
        F: Fn() -> BridgeSet,
    {
        let bridges = Rc::new(RefCell::new(bridge_factory()));
        let source: Rc<str> = Rc::from(source);
        guard.arm();
        let built = Self::build_state(&source, &bridges, guard);
        guard.disarm();
        let (state, slots, isolation) = built?;
        Ok(Worker { state, slots, isolation, bridges, source, dirty: false })
    }

    /// Compile and run the script, returning the live VM, its symbol table and
    /// the isolation strategy its globals permit. Used for the first init and
    /// for every rebuild.
    fn build_state(
        source: &str,
        bridges: &Rc<RefCell<BridgeSet>>,
        guard: &CallGuard,
    ) -> Result<(ScriptState, HashMap<String, u32>, Isolation), String> {
        let full = format!("{PREAMBLE}\n{source}");
        let mut state = compile_script(&full)?;

        // The bridges outlive any one VM, so the closure holds a handle rather
        // than the set itself. Nothing a bridge does re-enters the VM, so the
        // borrow cannot overlap with another.
        let shared = Rc::clone(bridges);
        state.set_host_call(Box::new(move |kind, args| {
            host::dispatch(&mut shared.borrow_mut(), kind, args)
        }));

        // Bound the top level too — a script can loop forever before defining a
        // single handler.
        // The caller owns the deadline. Arming here as well would hand the top
        // level a fresh 25s on top of the one covering the request, so a rebuild
        // could outlive the HTTP timeout the wall-time limit exists to stay under.
        state.set_limits(MAX_STEPS_PER_CALL, Some(guard.abort.clone()));
        let init_result = state.run_init();
        drain_output(&mut state);
        init_result?;

        let preamble = preamble_names();
        let mut slots = HashMap::new();
        let mut var_indices = Vec::new();
        for s in state.symbols() {
            if preamble.contains(&s.name) {
                continue;
            }
            if s.scope == SymbolScope::Variable {
                var_indices.push(s.index);
            }
            slots.insert(s.name, s.index);
        }

        let values: Vec<HostValue> = var_indices.iter().map(|&i| state.get_slot(i)).collect();
        // A class lives in a *function* slot, and the host cannot write those at
        // all — so `class Cache { static items = {} }` would keep whatever a
        // handler hung on it into the next request, invisibly. Restoring cannot
        // reach that, so a script declaring a class rebuilds instead.
        let isolation = if values.iter().all(is_primitive) && !declares_class(source) {
            Isolation::Restore(PrimitiveSnapshot { indices: var_indices, values })
        } else {
            Isolation::Rebuild
        };
        Ok((state, slots, isolation))
    }

    fn handle_request<F>(
        req: ScriptRequest,
        worker: &mut Option<Worker>,
        mutation_warned: &mut MutationWarned,
        bridge_factory: &F,
        guard: &CallGuard,
    )
    where
        F: Fn() -> BridgeSet,
    {
        match req {
            ScriptRequest::Init { source, reply } => {
                match Self::init_worker(&source, bridge_factory, guard) {
                    Ok(w) => {
                        let globals: Vec<String> = w.slots.keys().cloned().collect();
                        let snapshot_slots = match &w.isolation {
                            Isolation::Restore(snap) => snap.indices.len(),
                            Isolation::Rebuild => 0,
                        };
                        *worker = Some(w);
                        let _ = reply.send(Ok((globals, snapshot_slots)));
                    }
                    Err(e) => {
                        let _ = reply.send(Err(e));
                    }
                }
            }
            ScriptRequest::Call { name, args, reply } => {
                let result = match worker.as_mut() {
                    Some(w) => Self::call_handler(w, &name, args, mutation_warned, guard),
                    None => Err("Runtime not initialized".into()),
                };
                let _ = reply.send(result);
            }
        }
    }

    fn call_handler(
        w: &mut Worker,
        name: &str,
        args: Vec<serde_json::Value>,
        mutation_warned: &mut MutationWarned,
        guard: &CallGuard,
    ) -> Result<serde_json::Value, String> {
        // One deadline for the whole request, covering the reset as well as the
        // handler: the reset walks VM state and, on a rebuild, recompiles and
        // re-runs the top level. Arming per step would give each its own 25s.
        guard.arm();
        let result = Self::run_request(w, name, args, mutation_warned, guard);
        guard.disarm();
        result
    }

    fn run_request(
        w: &mut Worker,
        name: &str,
        args: Vec<serde_json::Value>,
        mutation_warned: &mut MutationWarned,
        guard: &CallGuard,
    ) -> Result<serde_json::Value, String> {
        // Start this handler from pristine globals, whatever a prior request on
        // this worker did to them.
        Self::isolate(w, name, mutation_warned, guard)?;

        let slot = *w.slots.get(name).ok_or_else(|| format!("No such function '{name}'"))?;
        let host_args: Result<Vec<HostValue>, String> =
            args.into_iter().map(|v| json_to_host(v, 0)).collect();
        let host_args = host_args?;

        // Reset the step budget for this request. Without this the 100M budget
        // would span the worker's whole life and every worker would eventually
        // refuse to run anything.
        w.state.set_limits(MAX_STEPS_PER_CALL, Some(guard.abort.clone()));
        // Anything the handler touches has to be assumed dirty from here, even
        // if it throws part-way through.
        w.dirty = true;
        let call_result = w.state.call_slot(slot, &host_args);
        drain_output(&mut w.state);
        let value = call_result?;

        // A handler whose result cannot cross as data — most often an `async`
        // one, which returns a Promise — would otherwise marshal to `null` and
        // be served as `200 OK` with an empty body, losing both the response and
        // any error it threw. Say so instead.
        if matches!(value, HostValue::Opaque) {
            return Err(format!(
                "Handler '{name}' returned a value that cannot cross to the host                  (a Promise, function, Map, Set or Date). Server handlers must be                  synchronous and return plain data, e.g. {{ status, body }}."
            ));
        }

        host_to_json(&value, 0)
    }

    /// Return the worker's globals to their post-init state.
    ///
    /// Primitives are restored in place. Anything else cannot be restored
    /// faithfully through `HostValue` — see [`Isolation`] — so the VM is rebuilt
    /// instead, which is the only way to guarantee the next request cannot see
    /// the previous one's data.
    fn isolate(
        w: &mut Worker,
        name: &str,
        mutation_warned: &mut MutationWarned,
        guard: &CallGuard,
    ) -> Result<(), String> {
        // Nothing has run since the globals were last clean, so there is nothing
        // to undo. This is what keeps a rebuild off the first request after init
        // and off a worker that has been idle.
        if !w.dirty {
            return Ok(());
        }

        let mut mutated = false;
        let mut unrestorable = false;
        if let Isolation::Restore(snap) = &w.isolation {
            for (i, &index) in snap.indices.iter().enumerate() {
                if w.state.get_slot(index) == snap.values[i] {
                    continue;
                }
                mutated = true;
                // A refused write means the slot now holds something the host
                // cannot overwrite — a Map, Set, Date, or a closure the handler
                // assigned. The value stays live into the next request, so this
                // worker can no longer isolate by restoring.
                if !w.state.set_slot(index, &snap.values[i]) {
                    unrestorable = true;
                    break;
                }
            }
        }

        if unrestorable || matches!(w.isolation, Isolation::Rebuild) {
            if unrestorable {
                tracing::warn!(
                    handler = %name,
                    "A global now holds a value that cannot be restored (Map, Set, Date                      or a function). Rebuilding this worker's VM between requests from                      here on — note that re-runs the script's top level each time."
                );
            }
            let source = Rc::clone(&w.source);
            let bridges = Rc::clone(&w.bridges);
            let (state, slots, isolation) = Self::build_state(&source, &bridges, guard)?;
            w.state = state;
            w.slots = slots;
            w.isolation = isolation;
            w.dirty = false;
            return Ok(());
        }

        w.dirty = false;
        if mutated && !mutation_warned.0 {
            mutation_warned.0 = true;
            tracing::warn!(
                handler = %name,
                "A handler modified global variables before '{}'. These changes are                  discarded between requests (each call starts with clean state).                  Use db.* APIs for persistence instead of global variables.",
                name
            );
        }
        Ok(())
    }

    /// Initialize all workers with the same source code.
    /// Uses per-worker dedicated channels to guarantee 1:1 delivery.
    pub fn init(&self, source: String) -> Result<(), String> {
        // Kept so the watchdog can bring a replacement worker up to the same
        // state if one wedges.
        if let Ok(mut slot) = self.init_source.lock() {
            *slot = Some(source.clone());
        }
        let mut reply_rxs = Vec::with_capacity(self.worker_count);

        for (i, init_tx) in self.init_txs.iter().enumerate() {
            let (reply_tx, reply_rx) = std::sync::mpsc::channel();
            init_tx
                .send(ScriptRequest::Init {
                    source: source.clone(),
                    reply: reply_tx,
                })
                .map_err(|_| format!("Worker {} died during init", i))?;
            reply_rxs.push(reply_rx);
        }

        let mut errors = Vec::new();
        let init_timeout = Duration::from_secs(30);
        for (i, reply_rx) in reply_rxs.iter().enumerate() {
            match reply_rx.recv_timeout(init_timeout) {
                Ok(Ok((globals, snapshot_slots))) => {
                    // Log snapshot size once (first worker that sets known_globals)
                    if self.known_globals.set(globals.into_iter().collect()).is_ok()
                        && snapshot_slots > MAX_GLOBALS_SNAPSHOT_SLOTS
                    {
                        tracing::warn!(
                            slots = snapshot_slots,
                            "Large globals snapshot ({} slots). This is compared before \
                             each handler call. Keep global variables light — use db.* APIs \
                             for large data instead of global variables.",
                            snapshot_slots
                        );
                    }
                }
                Ok(Err(e)) => errors.push(format!("Worker {}: {}", i, e)),
                Err(_) => errors.push(format!("Worker {} died during init", i)),
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }

    /// Call a function on the next available (idle) worker.
    /// Uses `try_send` to avoid blocking the calling thread when the queue is
    /// full. This is critical because callers run inside `spawn_blocking` —
    /// a blocking `send` would pin a Tokio blocking thread until the queue
    /// drains, and under sustained load all 512 blocking threads would stall,
    /// starving DB reads, health checks, and all other blocking I/O.
    pub fn call(
        &self,
        name: &str,
        args: Vec<serde_json::Value>,
    ) -> Result<serde_json::Value, String> {
        let (reply_tx, reply_rx) = std::sync::mpsc::channel();
        self.work_tx
            .try_send(ScriptRequest::Call {
                name: name.to_string(),
                args,
                reply: reply_tx,
            })
            .map_err(|e| match e {
                crossbeam_channel::TrySendError::Full(_) => {
                    "Worker queue full — server overloaded".to_string()
                }
                crossbeam_channel::TrySendError::Disconnected(_) => {
                    "All script workers died".to_string()
                }
            })?;
        // Bounded, not `recv()`: a worker wedged inside a native call still owns
        // this request's reply Sender and will never drop it, and callers run on
        // Tokio blocking threads. Waiting forever would retire one of those per
        // wedged request until the blocking pool is gone and every other
        // blocking path — DB reads, health checks — stalls with it.
        match reply_rx.recv_timeout(MAX_CALL_WAIT) {
            Ok(result) => result,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                Err("Handler did not return — the worker is wedged".to_string())
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                Err("Script worker died".to_string())
            }
        }
    }

    /// Instant lock-free check using global names extracted during init.
    pub fn has_function(&self, name: &str) -> bool {
        self.known_globals
            .get()
            .map(|set| set.contains(name))
            .unwrap_or(false)
    }
}

impl Drop for ServerRuntime {
    fn drop(&mut self) {
        self.watchdog_stop.store(true, Ordering::Relaxed);
        let extra = self.replacements.load(Ordering::Relaxed);
        GLOBAL_WORKER_COUNT.fetch_sub(self.worker_count + extra, Ordering::Relaxed);
    }
}

/// Forward whatever the script printed to the server's log.
///
/// The engine buffers `console.*` inside the VM rather than writing it out, so
/// this must run after every re-entry — otherwise script output is invisible
/// and the buffer grows for the life of the worker.
fn drain_output(state: &mut ScriptState) {
    for line in state.take_output() {
        tracing::info!(target: "softn_script", "{}", line);
    }
    for line in state.take_errput() {
        tracing::error!(target: "softn_script", "{}", line);
    }
}

// ── JSON ↔ HostValue conversion ──

/// Maximum nesting depth for conversion in either direction, to bound stack use.
const MAX_JSON_DEPTH: usize = 64;

/// Maximum individual string length crossing into or out of the VM (2MB).
/// Prevents OOM from payloads with multi-megabyte string values being copied
/// into the sandboxed VM heap. Scripts needing larger data should use the
/// FS bridge to read/write files instead.
const MAX_STRING_VALUE_LEN: usize = 2 * 1024 * 1024;

fn json_to_host(val: serde_json::Value, depth: usize) -> Result<HostValue, String> {
    // `>=`, not `>`: the engine replaces anything at or past its own depth cap
    // with null, so a value accepted here at exactly the cap would reach the
    // handler as null with no error anywhere. Rejecting it is the honest answer.
    if depth >= MAX_JSON_DEPTH {
        return Err(format!("JSON nesting depth exceeds maximum of {}", MAX_JSON_DEPTH));
    }
    Ok(match val {
        serde_json::Value::Null => HostValue::Null,
        serde_json::Value::Bool(b) => HostValue::Bool(b),
        serde_json::Value::Number(n) => HostValue::Number(n.as_f64().unwrap_or(0.0)),
        serde_json::Value::String(s) => {
            if s.len() > MAX_STRING_VALUE_LEN {
                return Err(format!(
                    "String value too large ({} bytes, max {})",
                    s.len(), MAX_STRING_VALUE_LEN
                ));
            }
            HostValue::String(s)
        }
        serde_json::Value::Array(arr) => {
            let mut items = Vec::with_capacity(arr.len());
            for v in arr {
                items.push(json_to_host(v, depth + 1)?);
            }
            HostValue::Array(items)
        }
        serde_json::Value::Object(map) => {
            let mut pairs = Vec::with_capacity(map.len());
            for (k, v) in map {
                pairs.push((k, json_to_host(v, depth + 1)?));
            }
            HostValue::Object(pairs)
        }
    })
}

fn host_to_json(val: &HostValue, depth: usize) -> Result<serde_json::Value, String> {
    if depth >= MAX_JSON_DEPTH {
        return Err(format!("Value nesting depth exceeds maximum of {}", MAX_JSON_DEPTH));
    }
    Ok(match val {
        // A function, class, Map or Date cannot cross as data. Null is what the
        // previous engine produced for the same values.
        HostValue::Undefined | HostValue::Null | HostValue::Opaque => serde_json::Value::Null,
        HostValue::Bool(b) => serde_json::Value::Bool(*b),
        HostValue::Number(n) => number_to_json(*n),
        HostValue::String(s) => serde_json::Value::String(clamp_string(s)),
        HostValue::Array(items) => {
            let mut vals = Vec::with_capacity(items.len());
            for v in items {
                vals.push(host_to_json(v, depth + 1)?);
            }
            serde_json::Value::Array(vals)
        }
        HostValue::Object(pairs) => {
            let mut map = serde_json::Map::with_capacity(pairs.len());
            for (k, v) in pairs {
                map.insert(k.clone(), host_to_json(v, depth + 1)?);
            }
            serde_json::Value::Object(map)
        }
    })
}

/// JavaScript has one number type; JSON consumers do not.
///
/// An integral value is emitted as a JSON integer, because callers read it that
/// way — `http.rs` resolves a handler's status with `as_u64()`, which answers
/// `None` for `200.0` and would turn every response into a 500. Non-finite
/// values have no JSON spelling and become null, as `JSON.stringify` does.
fn number_to_json(n: f64) -> serde_json::Value {
    if n.is_finite() && n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_992.0 {
        serde_json::Value::from(n as i64)
    } else {
        serde_json::Number::from_f64(n).map_or(serde_json::Value::Null, serde_json::Value::Number)
    }
}

/// Truncate at a UTF-8 boundary to prevent allocation of massive JSON strings
/// from script-generated values.
fn clamp_string(s: &str) -> String {
    if s.len() <= MAX_STRING_VALUE_LEN {
        return s.to_string();
    }
    let mut end = MAX_STRING_VALUE_LEN;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    let mut truncated = s[..end].to_string();
    truncated.push_str("...(truncated)");
    truncated
}
