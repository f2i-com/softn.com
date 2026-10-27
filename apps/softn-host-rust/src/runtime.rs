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

use zipp_vm::embed::{
    compile_script, compile_script_with_preamble_and_origin, CompileOptions, HostValue, ScriptOrigin, ScriptState,
};

use crate::host;
use crate::bundle::TransactionMode;
pub use crate::host::BridgeSet;

/// Host bridge definitions prepended to every script. See `preamble.js`.
const PREAMBLE: &str = include_str!("preamble.js");

/// The script's name in the positions its errors report (`at f (logic:3:9)`).
const LOGIC_SCRIPT_NAME: &str = "logic";

// How a worker keeps one request's world from the next: it does not keep the
// world. A VM that has run a handler is thrown away and built again from the
// script before the next call (`isolate`), as the PHP host builds one for
// every request.
//
// A VM used to be kept when every top-level variable was a primitive, and
// those variables alone were put back. That was only ever true of the
// variables. A handler can hang what it likes on a function (`h.cache = …`),
// on a builtin (`JSON.seen`), on `Object.prototype`, on the host's own
// `console` and `db` objects, or on a global it never declared, and none of
// those is a top-level variable: the next request that worker took read it.
// Nothing the engine offers can show a kept VM to be clean, so none is kept.

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

/// The script heap one VM may reach, re-applied with the step budget: a
/// handler past it is stopped with an error, as on softn-runner (512 MiB at
/// most there too) and on Node's engine. It had none, so one tenant's
/// handler could grow until the process, and every tenant in it, was out of
/// memory. `set_limits` installs a fresh recorder and with it no heap limit,
/// so this follows each call of it.
const SCRIPT_HEAP_LIMIT: usize = if cfg!(test) { 64 << 20 } else { 512 << 20 };

/// VM wall-time. Must stay under the HTTP/WS timeout (30s) so the engine
/// terminates and sends a clean error before the outer timeout fires.
///
/// The step budget alone cannot bound this: one native builtin — a huge
/// `JSON.parse` — is a single instruction. (A regex search is not: under
/// `safe-sandbox` its steps are charged to the budget and capped per search.)
/// The watchdog thread is what makes wall-time real.
const WALL_TIME_MS: u64 = 25_000;

/// Grace beyond the wall-time limit after which a call that has ignored its
/// abort flag is treated as wedged rather than slow.
///
/// The flag is polled between instructions, so a script sitting inside ONE long
/// native builtin — a huge `JSON.parse` — never sees it. That thread cannot be killed from safe Rust, so the pool
/// abandons it and starts a replacement instead of losing a worker for good.
const WEDGE_GRACE_MS: u64 = 25_000;

/// How many abandoned threads the pool will have running at once before it
/// stops replacing wedged workers. Each one keeps burning a core, so replacing
/// without limit turns a wedged-worker problem into a CPU-exhaustion one. At
/// the limit a wedged worker is left where it is, and serves again when its
/// call returns.
const MAX_ABANDONED_WORKERS: usize = 8;

/// What the watchdog and the workers both keep of the threads the pool has
/// given up on.
///
/// It used to be a count the watchdog kept to itself and never lowered: the
/// eighth stall in a process's life was the last one a replacement was
/// started for, however long ago the other seven threads had finished and
/// gone. From then on a wedged worker was marked abandoned with nothing to
/// replace it, and left the pool when its call came back healthy. The pool
/// shrank by one each time, to nothing, while /health said ok. The threads a
/// replacement added to the process-wide budget were not given back when the
/// thread they replaced exited, either.
#[derive(Default)]
struct Abandonment(std::sync::Mutex<AbandonmentState>);

#[derive(Default)]
struct AbandonmentState {
    /// Abandoned threads still inside the call they were left in.
    live: usize,
    /// Threads this pool has beyond the ones it started with: one for each
    /// replacement whose original has not exited yet.
    extra_threads: usize,
    /// The runtime is gone and has given its whole thread budget back.
    closed: bool,
}

impl Abandonment {
    fn state(&self) -> std::sync::MutexGuard<'_, AbandonmentState> {
        self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Take a place for one more abandoned thread. False at the limit.
    fn reserve(&self) -> bool {
        let mut state = self.state();
        if state.live >= MAX_ABANDONED_WORKERS {
            return false;
        }
        state.live += 1;
        true
    }

    /// Give the place back unused: no replacement could be started.
    fn release(&self) {
        let mut state = self.state();
        state.live = state.live.saturating_sub(1);
    }

    /// A replacement now runs beside the thread it replaces.
    fn replaced(&self) {
        self.state().extra_threads += 1;
    }

    /// An abandoned thread's call returned and the thread is going. Its place
    /// is free again; true when its share of the process-wide thread budget
    /// is the caller's to give back (false once the runtime has closed and
    /// given everything back itself).
    fn exited(&self) -> bool {
        let mut state = self.state();
        state.live = state.live.saturating_sub(1);
        if state.closed {
            return false;
        }
        state.extra_threads = state.extra_threads.saturating_sub(1);
        true
    }

    /// The runtime is dropped: how many threads beyond its own it still holds.
    fn close(&self) -> usize {
        let mut state = self.state();
        state.closed = true;
        state.extra_threads
    }

    fn live(&self) -> usize {
        self.state().live
    }
}

/// Give up on a worker wedged in a native call, if it can be replaced.
///
/// Three things are needed, in this order: a place among the abandoned, a
/// thread from the process-wide budget, and the replacement itself, which
/// `start` makes. Only with all three is the worker marked abandoned. Marked
/// first, as it was, a worker that could not be replaced still left the pool
/// when its call returned.
fn replace_wedged(
    guard: &CallGuard,
    abandonment: &Abandonment,
    start: impl FnOnce() -> Result<Arc<CallGuard>, String>,
) -> Option<Arc<CallGuard>> {
    let refuse = |why: String| -> Option<Arc<CallGuard>> {
        // Once for each stall, not once a tick for as long as it lasts.
        if !guard.wedge_reported.swap(true, Ordering::Relaxed) {
            tracing::error!(
                "Worker wedged in a native call and not replaced ({why}). It stays in the pool \
                 and serves again when the call returns. This is almost always a huge \
                 JSON.parse."
            );
        }
        None
    };
    if !abandonment.reserve() {
        return refuse(format!("{MAX_ABANDONED_WORKERS} abandoned threads are still running, the most allowed"));
    }
    if GLOBAL_WORKER_COUNT.fetch_add(1, Ordering::AcqRel) >= MAX_GLOBAL_WORKER_THREADS {
        GLOBAL_WORKER_COUNT.fetch_sub(1, Ordering::AcqRel);
        abandonment.release();
        return refuse(format!("the process-wide limit of {MAX_GLOBAL_WORKER_THREADS} worker threads is in use"));
    }
    match start() {
        Ok(replacement) => {
            guard.abandoned.store(true, Ordering::Relaxed);
            abandonment.replaced();
            tracing::error!(
                abandoned = abandonment.live(),
                "Worker wedged in a native call — abandoned it and started a replacement. \
                 The stuck thread holds a core until its call returns."
            );
            Some(replacement)
        }
        Err(why) => {
            GLOBAL_WORKER_COUNT.fetch_sub(1, Ordering::AcqRel);
            abandonment.release();
            refuse(why)
        }
    }
}

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

/// How long a run of calls made for one request (`call_each`) keeps its worker
/// before whatever else is waiting has a turn. Long enough that the rebuild a
/// further stretch begins with (about a millisecond) is a small part of it,
/// and short enough that a request arriving behind a long push does not wait
/// for the push.
const EACH_SLICE: Duration = Duration::from_millis(100);

/// How often the watchdog looks for overrunning calls. The engine polls the
/// abort flag every few thousand instructions, so the true overshoot is this
/// plus a poll interval — well inside the 5s margin to the HTTP timeout.
const WATCHDOG_TICK: Duration = Duration::from_millis(250);

/// Global cap on total worker threads across all ServerRuntime instances.
/// Prevents accidental thread exhaustion if multiple runtimes are created
/// (e.g. during testing or future multi-tenancy). Each OS thread consumes
/// ~8MB of stack, so 200 threads ≈ 1.6GB of stack alone.
pub(crate) const MAX_GLOBAL_WORKER_THREADS: usize = 200;
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
                // A metadata-only probe has no host; symbols remain inspectable
                // even when the preamble's configuration call cannot complete.
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
    /// The current stall has been reported as one that cannot be replaced.
    wedge_reported: AtomicBool,
    /// Shared with the watchdog and the runtime.
    abandonment: Arc<Abandonment>,
}

impl CallGuard {
    fn new(abandonment: Arc<Abandonment>) -> Self {
        Self {
            abort: Arc::new(AtomicBool::new(false)),
            deadline_ms: AtomicU64::new(0),
            abandoned: AtomicBool::new(false),
            wedge_reported: AtomicBool::new(false),
            abandonment,
        }
    }

    /// Arm for a call that may run for `WALL_TIME_MS`.
    fn arm(&self) {
        self.abort.store(false, Ordering::Relaxed);
        self.wedge_reported.store(false, Ordering::Relaxed);
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
        /// The script's top-level names, when it loaded.
        reply: std::sync::mpsc::Sender<Result<Vec<String>, String>>,
    },
    Call {
        name: String,
        args: Vec<serde_json::Value>,
        transaction: TransactionMode,
        cancellation: Arc<AtomicBool>,
        /// Set by the worker that takes the call off the queue.
        started: Arc<AtomicBool>,
        reply: std::sync::mpsc::Sender<Result<serde_json::Value, String>>,
    },
    /// One handler run for `args[from..]`, in order, by the worker that takes
    /// this off the queue, for `slice` from when it does: see `call_each`.
    CallEach {
        name: String,
        /// Shared with the caller, which sends what a stretch did not reach
        /// as a further one: the ops of a push are not copied for each.
        args: Arc<Vec<serde_json::Value>>,
        from: usize,
        /// How long the worker goes on beginning calls. Counted from when it
        /// takes this, not from when it was sent: a stretch that had waited
        /// its length in the queue would otherwise be one call long, and a
        /// busy host would compile the script for every op again.
        slice: Duration,
        /// Past this no further call is begun either. The first always is.
        deadline: Option<Instant>,
        cancellation: Arc<AtomicBool>,
        started: Arc<AtomicBool>,
        reply: std::sync::mpsc::Sender<EachReply>,
    },
}

/// When a stretch a worker took at `taken` stops beginning calls: its slice
/// later, or at the caller's deadline if that comes first.
fn stretch_end(taken: Instant, slice: Duration, deadline: Option<Instant>) -> Instant {
    let end = taken + slice;
    deadline.map_or(end, |at| at.min(end))
}

/// What a worker says of a `CallEach` it took.
enum EachReply {
    /// The answer of the next call, in order.
    Answer(Result<serde_json::Value, String>),
    /// Its time was up. The calls not answered were not begun.
    OutOfTime,
}

/// Everything one worker keeps between requests.
struct Worker {
    state: ScriptState,
    /// Top-level name → global slot, for calls by name.
    slots: HashMap<String, u32>,
    /// Shared with the VM's host closure so rebuilding the VM does not rebuild
    /// the bridges — a fresh `ureq` agent and DB handle per request would cost
    /// far more than the recompile.
    bridges: Rc<RefCell<BridgeSet>>,
    /// The script this worker runs, so it can rebuild itself.
    source: Rc<str>,
    /// Whether a handler has run in this VM. One that has is rebuilt before
    /// the next call. A rebuild re-executes the script's top level — including
    /// any `db.create` or `http.get` written there — so it must not happen on
    /// a worker that has not run anything since the last one.
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
/// **Important for script authors:** every handler call starts from the script
/// as it was loaded. Nothing a handler leaves in memory, in a global or
/// anywhere else, is there for the next call, on this worker or another, and
/// the script's top level runs again for each one. **Never use global
/// variables as an in-memory cache or session store.** Always persist state to
/// the database (via `db.*` APIs) and treat each handler call as stateless.
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
    abandonment: Arc<Abandonment>,
    /// `EACH_SLICE` in milliseconds. A test sets it to make a run of calls
    /// one stretch, or a stretch a call.
    pub(crate) each_slice_ms: AtomicU64,
}

impl ServerRuntime {
    /// Create a new runtime with a worker pool.
    /// `bridge_factory` is called once per worker thread to create isolated bridges.
    /// `configured_workers` overrides the auto-detected pool size if provided.
    ///
    /// Fails, rather than panicking, when the process-wide worker budget is
    /// spent: in multi-tenant mode one bundle's `workers` setting could
    /// otherwise take the whole budget and crash the host while the next
    /// tenant loads.
    pub fn new<F>(bridge_factory: F, configured_workers: Option<usize>) -> Result<Arc<Self>, String>
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
        // Reserve atomically: two runtimes built at once must not both see the
        // same headroom.
        let mut reserved = 0;
        let _ = GLOBAL_WORKER_COUNT.fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
            reserved = worker_count.min(MAX_GLOBAL_WORKER_THREADS.saturating_sub(current));
            (reserved > 0).then_some(current + reserved)
        });
        if reserved == 0 {
            return Err(format!(
                "Cannot start a script runtime: the process-wide limit of {} worker threads is in use. \
                 Lower `workers` (or --workers-per-tenant) for the apps on this host.",
                MAX_GLOBAL_WORKER_THREADS
            ));
        }
        let worker_count = reserved;

        let factory = Arc::new(bridge_factory);
        // Bounded queue prevents memory exhaustion from request floods.
        // 2x worker_count gives enough headroom for burst absorption while
        // applying backpressure when all workers are saturated.
        let (work_tx, work_rx) = crossbeam_channel::bounded::<ScriptRequest>(worker_count * 2);
        let mut init_txs = Vec::with_capacity(worker_count);
        let mut guards = Vec::with_capacity(worker_count);
        let abandonment = Arc::new(Abandonment::default());

        for i in 0..worker_count {
            match Self::spawn_worker(format!("softn-worker-{}", i), factory.clone(), work_rx.clone(), abandonment.clone()) {
                Ok((init_tx, guard)) => {
                    init_txs.push(init_tx);
                    guards.push(guard);
                }
                Err(e) => {
                    // Dropping the senders ends the workers already started.
                    drop(init_txs);
                    GLOBAL_WORKER_COUNT.fetch_sub(worker_count, Ordering::AcqRel);
                    return Err(format!("Cannot start a script runtime: failed to spawn worker thread {i}: {e}"));
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
        let wd_abandonment = abandonment.clone();
        if let Err(e) = std::thread::Builder::new()
            .name("softn-vm-watchdog".to_string())
            .spawn(move || {
                let mut guards = guards;
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
                        let id = next_id;
                        let replacement = replace_wedged(g, &wd_abandonment, || {
                            let source = wd_source.lock().ok().and_then(|s| s.clone())
                                .ok_or_else(|| "its script had not finished loading".to_string())?;
                            let (init_tx, guard) = Self::spawn_worker(
                                format!("softn-worker-r{}", id),
                                wd_factory.clone(),
                                wd_work_rx.clone(),
                                wd_abandonment.clone(),
                            )
                            .map_err(|e| format!("a thread could not be started: {e}"))?;
                            // The replacement initialises itself off the same
                            // source; nothing is waiting on the reply.
                            let (reply_tx, _reply_rx) = std::sync::mpsc::channel();
                            init_tx.send(ScriptRequest::Init { source, reply: reply_tx })
                                .map_err(|_| "the new thread ended before it was given the script".to_string())?;
                            Ok(guard)
                        });
                        if let Some(replacement) = replacement {
                            replacements.push(replacement);
                            next_id += 1;
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

        Ok(Arc::new(Self {
            work_tx,
            init_txs,
            worker_count,
            known_globals: OnceLock::new(),
            watchdog_stop,
            init_source,
            abandonment,
            each_slice_ms: AtomicU64::new(EACH_SLICE.as_millis() as u64),
        }))
    }

    /// Spawn one worker: a thread, its dedicated init channel, and the guard the
    /// watchdog watches. Returns the init sender and the guard.
    fn spawn_worker<F>(
        name: String,
        factory: Arc<F>,
        work_rx: crossbeam_channel::Receiver<ScriptRequest>,
        abandonment: Arc<Abandonment>,
    ) -> Result<(crossbeam_channel::Sender<ScriptRequest>, Arc<CallGuard>), std::io::Error>
    where
        F: Fn() -> BridgeSet + Send + Sync + 'static,
    {
        let (init_tx, init_rx) = crossbeam_channel::bounded::<ScriptRequest>(1);
        let guard = Arc::new(CallGuard::new(abandonment));
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

        // Phase 1: Wait for Init on dedicated channel (guaranteed 1:1 delivery).
        match init_rx.recv() {
            Ok(req) => {
                if let ScriptRequest::Init { ref source, .. } = req {
                    init_source = Some(source.clone());
                }
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    Self::handle_request(req, &mut worker, bridge_factory, guard);
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
                Self::handle_request(req, &mut worker, bridge_factory, guard);
            }));

            // The watchdog gave up on this thread mid-call and started a
            // replacement. The native call it was stuck in has now returned, but
            // the watchdog will never arm against this guard again — so rejoining
            // the pool would mean serving requests with no wall-time limit at all.
            if guard.abandoned.load(Ordering::Relaxed) {
                tracing::warn!(
                    "Abandoned worker finished its call — exiting rather than rejoining                      the pool, where it would run unbounded."
                );
                // Its place among the abandoned and its thread come back.
                if guard.abandonment.exited() {
                    GLOBAL_WORKER_COUNT.fetch_sub(1, Ordering::AcqRel);
                }
                return;
            }

            if let Err(panic_info) = result {
                Self::log_panic(&panic_info);
                // A panic can unwind out of a call that armed the guard; leaving
                // it armed would have the watchdog abort the next request.
                guard.disarm();

                // Circuit breaker: track panic frequency
                if let Some(w) = worker.as_mut() {
                    if let Some(sql) = w.bridges.borrow_mut().sql.as_mut() { let _ = sql.finish(false); }
                }
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
        let (state, slots) = built?;
        Ok(Worker { state, slots, bridges, source, dirty: false })
    }

    /// Compile and run the script, returning the live VM and its symbol table.
    /// Used for the first init and for every rebuild.
    fn build_state(
        source: &str,
        bridges: &Rc<RefCell<BridgeSet>>,
        guard: &CallGuard,
    ) -> Result<(ScriptState, HashMap<String, u32>), String> {
        // One program, so the preamble's bindings are globals the script
        // reaches by name, with the script's own directive prologue in force.
        // Joined as text, the script's `"use strict"` came after the
        // preamble's statements, was no directive, and strict server logic
        // ran sloppy. The positions an error reports count from the script's
        // first line (ZIPP 0.0.29; they were the joined text's), under the
        // name `logic`, as in the browser and on the PHP host.
        let origin = ScriptOrigin { name: Some(LOGIC_SCRIPT_NAME.into()), ..ScriptOrigin::default() };
        let mut state = compile_script_with_preamble_and_origin(PREAMBLE, source, &CompileOptions::default(), &origin)?;

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
        state.set_heap_limit(SCRIPT_HEAP_LIMIT);
        let init_result = state.run_init();
        drain_output(&mut state);
        init_result?;

        let preamble = preamble_names();
        let mut slots = HashMap::new();
        for s in state.symbols() {
            if preamble.contains(&s.name) {
                continue;
            }
            slots.insert(s.name, s.index);
        }
        Ok((state, slots))
    }

    fn handle_request<F>(
        req: ScriptRequest,
        worker: &mut Option<Worker>,
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
                        *worker = Some(w);
                        let _ = reply.send(Ok(globals));
                    }
                    Err(e) => {
                        let _ = reply.send(Err(e));
                    }
                }
            }
            ScriptRequest::Call { name, args, transaction, cancellation, started, reply } => {
                started.store(true, Ordering::Relaxed);
                let result = match worker.as_mut() {
                    Some(w) => Self::call_handler(w, &name, args, transaction, cancellation, true, guard),
                    None => Err("Runtime not initialized".into()),
                };
                let _ = reply.send(result);
            }
            ScriptRequest::CallEach { name, args, from, slice, deadline, cancellation, started, reply } => {
                started.store(true, Ordering::Relaxed);
                let until = stretch_end(Instant::now(), slice, deadline);
                // The first call starts from the script as loaded, like any
                // request. Each of the rest takes the VM as the one before left
                // it, unless that one failed: it may have stopped anywhere.
                let mut fresh = true;
                for index in from..args.len() {
                    if index > from {
                        // Nobody is waiting for the rest.
                        if cancellation.load(Ordering::Relaxed) {
                            break;
                        }
                        if Instant::now() >= until {
                            let _ = reply.send(EachReply::OutOfTime);
                            break;
                        }
                    }
                    let result = match worker.as_mut() {
                        Some(w) => Self::call_handler(w, &name, vec![args[index].clone()], TransactionMode::None, cancellation.clone(), fresh, guard),
                        None => Err("Runtime not initialized".into()),
                    };
                    fresh = result.is_err();
                    // Nobody is waiting any more, or the watchdog gave up on
                    // this thread during that call and will not arm against
                    // it again: nothing more may run here.
                    if reply.send(EachReply::Answer(result)).is_err() || guard.abandoned.load(Ordering::Relaxed) {
                        break;
                    }
                }
            }
        }
    }

    fn call_handler(
        w: &mut Worker,
        name: &str,
        args: Vec<serde_json::Value>,
        transaction: TransactionMode,
        cancellation: Arc<AtomicBool>,
        fresh: bool,
        guard: &CallGuard,
    ) -> Result<serde_json::Value, String> {
        guard.arm();
        let result = (|| {
            if cancellation.load(Ordering::Relaxed) { return Err("Request cancelled".into()); }
            // Rebuilding executes script initialization. Keep SQL unavailable
            // until initialization is complete, just as it is at first startup.
            //
            // Only a later call of one `call_each` job is not `fresh`: it
            // takes the VM as the call before it, of the same request, left it.
            if fresh {
                Self::isolate(w, guard)?;
            }
            if let Some(sql) = w.bridges.borrow_mut().sql.as_mut() {
                sql.begin(transaction, cancellation.clone())?;
            } else if transaction != TransactionMode::None {
                return Err("Route transaction requires the private SQL capability".into());
            }
            let mut result = Self::run_request(w, name, args, guard);
            // Validate the exact response before committing any application writes.
            if transaction != TransactionMode::None {
                if let Ok(value) = &result {
                    if let Err(error) = validate_private_response(value) { result = Err(error); }
                }
            }
            if guard.abort.load(Ordering::Relaxed) || cancellation.load(Ordering::Relaxed) {
                result = Err("Request cancelled or timed out".into());
            }
            let commit = result.as_ref().is_ok_and(|value| value.get("rollback") != Some(&serde_json::Value::Bool(true)));
            if let Some(sql) = w.bridges.borrow_mut().sql.as_mut() {
                if let Err(e) = sql.finish(commit) { result = Err(e); }
            }
            if let Ok(serde_json::Value::Object(value)) = &mut result { value.remove("rollback"); }
            result
        })();
        guard.disarm();
        result
    }

    fn run_request(
        w: &mut Worker,
        name: &str,
        args: Vec<serde_json::Value>,
        guard: &CallGuard,
    ) -> Result<serde_json::Value, String> {
        let slot = *w.slots.get(name).ok_or_else(|| format!("No such function '{name}'"))?;
        let host_args: Result<Vec<HostValue>, String> =
            args.into_iter().map(|v| json_to_host(v, 0)).collect();
        let host_args = host_args?;

        // Reset the step budget for this request. Without this the 100M budget
        // would span the worker's whole life and every worker would eventually
        // refuse to run anything.
        w.state.set_limits(MAX_STEPS_PER_CALL, Some(guard.abort.clone()));
        w.state.set_heap_limit(SCRIPT_HEAP_LIMIT);
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
        if matches!(value, HostValue::Opaque) && !DECISIONS.contains(&name) {
            return Err(format!(
                "Handler '{name}' returned a value that cannot cross to the host                  (a Promise, function, Map, Set or Date). Server handlers must be                  synchronous and return plain data, e.g. {{ status, body }}."
            ));
        }

        let json = host_to_json(&value, 0)?;
        // A decision's answer holding such a value, anywhere, is not read as the
        // null it would cross as: `{ rejected: new Set(ids) }` read as rejecting
        // none, and every op went through the hook there to keep some out.
        if DECISIONS.contains(&name) && holds_opaque(&value) {
            return Err(format!("{UNREAD_ANSWER} '{name}' answered with a value that cannot cross to the host (a Promise, function, Map, Set or Date)"));
        }
        Ok(json)
    }

    /// Give the call a VM no handler has run in.
    ///
    /// The VM that served the last call is dropped and the script compiled and
    /// run again, which is the only way to be sure the next request cannot
    /// see the previous one's data (see the note under `PREAMBLE`).
    /// It re-runs the script's top level, so that is run once for each
    /// request, as on the PHP host.
    fn isolate(w: &mut Worker, guard: &CallGuard) -> Result<(), String> {
        // Nothing has run in this VM, so there is nothing to undo. This is
        // what keeps a rebuild off the first request after init and off a
        // worker that has been idle.
        if !w.dirty {
            return Ok(());
        }
        let source = Rc::clone(&w.source);
        let bridges = Rc::clone(&w.bridges);
        let (state, slots) = Self::build_state(&source, &bridges, guard)?;
        w.state = state;
        w.slots = slots;
        w.dirty = false;
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
                Ok(Ok(globals)) => {
                    // Every worker runs the same script; the first to answer names it.
                    let _ = self.known_globals.set(globals.into_iter().collect());
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
        self.call_transaction(name, args, TransactionMode::None, Arc::new(AtomicBool::new(false)))
    }

    /// Run `name` once for each of `args`, in order: the calls one request makes.
    ///
    /// What a request leaves in the script's memory must not be there for the
    /// next, so a worker rebuilds its VM before every call, and that made the
    /// per-op sync hooks, which are one call an op, pay a rebuild an op: about
    /// a millisecond each. A push is one request from one client, so its
    /// hooks are sent as a run that one worker makes one after another. The
    /// first call starts from the script as loaded, like any request; each of
    /// the rest takes the VM as the one before left it, unless that one
    /// failed. Whatever the worker runs next starts clean.
    ///
    /// A run on one worker, and not calls that each name their request: idle
    /// workers take calls in turn, so with four of them the calls of one push
    /// ran in four VMs and a hook that counted saw 1, 1, 1, 1, 2, 2…
    ///
    /// And not the whole run at once. A worker that is making these calls is
    /// taking nothing else, so a push whose hooks are slow (one that calls out
    /// for each op, say) held a worker for as long as it lasted, where a call
    /// an op had let other requests in between: on a pool of one, everything
    /// else waited for the push and was refused after `MAX_CALL_WAIT`. A
    /// stretch is `EACH_SLICE` long. What it did not reach is sent as a
    /// further stretch, behind whatever is waiting by then, and that one
    /// starts clean like the first. So the calls are made in order, and what
    /// one of them finds in memory from the one before is a saving and not a
    /// promise.
    ///
    /// Past `deadline` nothing further is begun; the first call always is.
    /// The answers are those of the calls that were made, in order, so fewer
    /// than `args` means the rest were not run. `Err` when no worker could be
    /// asked at all.
    pub fn call_each(
        &self,
        name: &str,
        args: Vec<serde_json::Value>,
        deadline: Option<Instant>,
    ) -> Result<Vec<Result<serde_json::Value, String>>, String> {
        let args = Arc::new(args);
        let mut answers = Vec::with_capacity(args.len());
        'stretches: while answers.len() < args.len() {
            if !answers.is_empty() && deadline.is_some_and(|at| Instant::now() >= at) {
                break;
            }
            let (reply_tx, reply_rx) = std::sync::mpsc::channel();
            let started = Arc::new(AtomicBool::new(false));
            let cancellation = Arc::new(AtomicBool::new(false));
            let queued = self.work_tx.try_send(ScriptRequest::CallEach {
                name: name.to_string(),
                args: Arc::clone(&args),
                from: answers.len(),
                slice: Duration::from_millis(self.each_slice_ms.load(Ordering::Relaxed)),
                deadline,
                cancellation: cancellation.clone(),
                started: started.clone(),
                reply: reply_tx,
            });
            if let Err(error) = queued.map_err(Self::not_queued) {
                // Nothing was asked: the caller is told so. Later, it is the
                // failure of the call that could not be sent.
                if answers.is_empty() {
                    return Err(error);
                }
                answers.push(Err(error));
                break;
            }
            loop {
                // Each call is waited for as a call of its own is: see `call_transaction`.
                match reply_rx.recv_timeout(MAX_CALL_WAIT) {
                    Ok(EachReply::Answer(answer)) => {
                        answers.push(answer);
                        if answers.len() == args.len() {
                            break 'stretches;
                        }
                    }
                    Ok(EachReply::OutOfTime) => break,
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                        cancellation.store(true, Ordering::Relaxed);
                        answers.push(Err(Self::unanswered(name, &started)));
                        break 'stretches;
                    }
                    // The worker stopped without saying its time was up: that
                    // is the failure of the call it was on.
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                        answers.push(Err("Script worker died".to_string()));
                        break 'stretches;
                    }
                }
            }
        }
        Ok(answers)
    }

    pub fn call_transaction(
        &self,
        name: &str,
        args: Vec<serde_json::Value>,
        transaction: TransactionMode,
        cancellation: Arc<AtomicBool>,
    ) -> Result<serde_json::Value, String> {
        let (reply_tx, reply_rx) = std::sync::mpsc::channel();
        let started = Arc::new(AtomicBool::new(false));
        self.work_tx
            .try_send(ScriptRequest::Call {
                name: name.to_string(),
                args,
                transaction,
                cancellation: cancellation.clone(),
                started: started.clone(),
                reply: reply_tx,
            })
            .map_err(Self::not_queued)?;
        // Bounded, not `recv()`: a worker wedged inside a native call still owns
        // this request's reply Sender and will never drop it, and callers run on
        // Tokio blocking threads. Waiting forever would retire one of those per
        // wedged request until the blocking pool is gone and every other
        // blocking path — DB reads, health checks — stalls with it.
        match reply_rx.recv_timeout(MAX_CALL_WAIT) {
            Ok(result) => result,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                cancellation.store(true, Ordering::Relaxed);
                Err(Self::unanswered(name, &started))
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                Err("Script worker died".to_string())
            }
        }
    }

    fn not_queued(error: crossbeam_channel::TrySendError<ScriptRequest>) -> String {
        match error {
            crossbeam_channel::TrySendError::Full(_) => "Worker queue full — server overloaded".to_string(),
            crossbeam_channel::TrySendError::Disconnected(_) => "All script workers died".to_string(),
        }
    }

    /// What to say of a call that was not answered in time. Two different
    /// things, and the log should say which: a call no worker ever took is a
    /// pool too small for the load (or one held up by long calls), not a
    /// wedged worker.
    fn unanswered(name: &str, started: &AtomicBool) -> String {
        if started.load(Ordering::Relaxed) {
            tracing::warn!(handler = name, "Handler did not return within {}s — its worker is wedged", MAX_CALL_WAIT.as_secs());
            "Handler did not return — the worker is wedged".to_string()
        } else {
            tracing::warn!(handler = name, "No worker took the call within {}s — every worker was busy", MAX_CALL_WAIT.as_secs());
            "Handler did not start — every worker was busy".to_string()
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
        let extra = self.abandonment.close();
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
const MAX_INPUT_STRING_VALUE_LEN: usize = 16 * 1024 * 1024;

/// The most a handler's whole answer may be, as JSON: the PHP host's 3 MiB
/// (wasm-host.mjs). It was the 2 MiB a single string is held to, so an answer
/// between the two worked on that host and was a 500 on this one. One string
/// in it is still held to MAX_STRING_VALUE_LEN.
const MAX_PRIVATE_RESPONSE_BYTES: usize = 3 * 1024 * 1024;

pub(crate) fn validate_private_response(value: &serde_json::Value) -> Result<(), String> {
    let valid = value.get("status").and_then(|s| s.as_u64())
        .is_some_and(|status| (200..=599).contains(&status))
        && value.get("body").is_some();
    let bounded = serde_json::to_vec(value)
        .is_ok_and(|bytes| bytes.len() <= MAX_PRIVATE_RESPONSE_BYTES);
    if !valid || !bounded {
        return Err("Handler returned an invalid or oversized response".into());
    }
    Ok(())
}

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
            if s.len() > MAX_INPUT_STRING_VALUE_LEN {
                return Err(format!(
                    "String value too large ({} bytes, max {})",
                    s.len(), MAX_INPUT_STRING_VALUE_LEN
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

/// Functions whose answers the host reads as decisions (the before-sync hooks):
/// a value in them that cannot cross as data is an answer the host does not
/// read, refused with `UNREAD_ANSWER` at the head of the error, where a
/// handler's crosses as null (a `Date` in a body) or is an error to retry.
pub const DECISIONS: [&str; 2] = ["onBeforeSync", "onBeforeSyncBatch"];

/// How the error for a decision the host does not read begins.
pub const UNREAD_ANSWER: &str = "An answer the host does not read:";

/// Whether a value holds, anywhere, one that cannot cross as data. Called on a
/// value `host_to_json` has taken, which bounds how deep it goes.
fn holds_opaque(value: &HostValue) -> bool {
    match value {
        HostValue::Opaque => true,
        HostValue::Array(items) => items.iter().any(holds_opaque),
        HostValue::Object(pairs) => pairs.iter().any(|(_, item)| holds_opaque(item)),
        _ => false,
    }
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
        HostValue::String(s) => {
            if s.len() > MAX_STRING_VALUE_LEN { return Err("Handler string result exceeds host limit".into()); }
            serde_json::Value::String(s.clone())
        },
        HostValue::Utf16(units) => {
            // ZIPP preserves lone surrogates exactly in this variant. JSON's
            // Rust string representation cannot, so reject malformed text
            // rather than silently substituting U+FFFD or double-escaping it.
            // Bound decoded UTF-8 bytes as well as input units before copying.
            if units.len() > MAX_STRING_VALUE_LEN {
                return Err("Handler string result exceeds host limit".into());
            }
            let mut text = String::with_capacity(units.len());
            for decoded in char::decode_utf16(units.iter().copied()) {
                let character = decoded.map_err(|_| "Handler string result contains an unpaired UTF-16 surrogate")?;
                if text.len() + character.len_utf8() > MAX_STRING_VALUE_LEN {
                    return Err("Handler string result exceeds host limit".into());
                }
                text.push(character);
            }
            serde_json::Value::String(text)
        },
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
        // ZIPP 0.0.19 marshals a Float32Array as its elements, where 0.0.18
        // read one as Opaque. JSON has no typed arrays: it crosses as an array
        // of numbers, each the f64 the element reads as in JavaScript and a
        // non-finite one null as JSON.stringify spells it.
        //
        // What is bounded is the JSON the array becomes, held to the same
        // 2 MiB a string is — not the elements' own bytes, which say little
        // about the JSON: 600k zeros are 2.4 MiB of f32 and 1.2 MB of text,
        // while 300k small-exponent values are 1.2 MiB of f32 and some 5 MB of
        // text. The whole response is bounded again on its serialised bytes by
        // `validate_private_response`; this is the early refusal that names
        // the tensor rather than reporting an oversized response after every
        // other field was built. The element-count check ahead of the
        // serialisation is a floor — `[0,0,…,0]` is 2n+1 bytes, and no element
        // spells shorter than one digit and a separator — so an array that
        // cannot fit however it is spelled is refused before its text is
        // allocated, and the serialisation below is bounded by that floor.
        HostValue::Float32Array(values) => {
            if values.len().saturating_mul(2).saturating_add(1) > MAX_STRING_VALUE_LEN {
                return Err("Handler Float32Array result exceeds host limit".into());
            }
            let array = serde_json::Value::Array(values.iter().map(|v| number_to_json(f64::from(*v))).collect());
            let bounded = serde_json::to_vec(&array).is_ok_and(|bytes| bytes.len() <= MAX_STRING_VALUE_LEN);
            if !bounded {
                return Err("Handler Float32Array result exceeds host limit".into());
            }
            array
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

#[cfg(test)]
mod host_json_tests {
    use super::*;

    /// A whole answer may be 3 MiB, as on the PHP host, of strings of at most 2 MiB.
    #[test]
    fn an_answer_may_be_the_php_hosts_size() {
        let piece = "x".repeat(1024 * 1024);
        let answer = |pieces: usize| serde_json::json!({"status": 200, "body": vec![piece.clone(); pieces]});
        // Two and a half megabytes: refused when the bound was one string's.
        let mut fits = answer(2);
        fits["body"].as_array_mut().unwrap().push(serde_json::Value::String("x".repeat(512 * 1024)));
        assert!(validate_private_response(&fits).is_ok());
        assert!(validate_private_response(&answer(3)).is_err(), "3 MiB of text and its punctuation is over");
        assert!(validate_private_response(&serde_json::json!({"status": 99, "body": {}})).is_err());
        assert!(validate_private_response(&serde_json::json!({"status": 200})).is_err());
    }

    /// What a handler returns is written out with its keys in the order the
    /// handler gave them, and what it is handed keeps the order it arrived
    /// in: JSON read here used to come back out sorted by key.
    #[test]
    fn an_objects_keys_cross_in_the_order_they_were_written() {
        let returned = HostValue::Object(vec![
            ("zebra".into(), HostValue::Number(1.0)),
            ("apple".into(), HostValue::Object(vec![("y".into(), HostValue::Null), ("x".into(), HostValue::Bool(true))])),
        ]);
        assert_eq!(host_to_json(&returned, 0).unwrap().to_string(), r#"{"zebra":1,"apple":{"y":null,"x":true}}"#);
        let received: serde_json::Value = serde_json::from_str(r#"{"zebra":1,"apple":{"y":1,"x":2}}"#).unwrap();
        let HostValue::Object(pairs) = json_to_host(received, 0).unwrap() else { panic!("an object") };
        assert_eq!(pairs.iter().map(|(key, _)| key.as_str()).collect::<Vec<_>>(), ["zebra", "apple"]);
        assert!(matches!(&pairs[1].1, HostValue::Object(inner) if inner[0].0 == "y" && inner[1].0 == "x"));
    }

    #[test]
    fn utf16_json_preserves_pairs_nul_and_nested_text() {
        let value = HostValue::Object(vec![("body".into(), HostValue::Array(vec![
            HostValue::Utf16(vec![0x61, 0, 0xD83D, 0xDE00, 0x6F22]),
        ]))]);
        assert_eq!(host_to_json(&value, 0).unwrap(), serde_json::json!({
            "body": ["a\0\u{1F600}\u{6F22}"]
        }));
    }

    #[test]
    fn utf16_json_reports_a_guest_lone_surrogate_without_replacing_it() {
        let mut state = compile_script(r"var result = ['\ud800'];").unwrap();
        state.run_init().unwrap();
        let slot = state.symbols().into_iter().find(|symbol| symbol.name == "result").unwrap().index;
        let result = state.get_slot(slot);
        assert_eq!(result, HostValue::Array(vec![HostValue::Utf16(vec![0xD800])]));
        assert!(host_to_json(&result, 0).unwrap_err().contains("unpaired UTF-16 surrogate"));
        assert!(host_to_json(&HostValue::Utf16(vec![0xDC00]), 0).is_err());
    }

    #[test]
    fn utf16_json_enforces_the_decoded_byte_limit() {
        let at_limit = HostValue::Utf16(vec![0x61; MAX_STRING_VALUE_LEN]);
        assert_eq!(host_to_json(&at_limit, 0).unwrap().as_str().unwrap().len(), MAX_STRING_VALUE_LEN);
        let too_many_units = HostValue::Utf16(vec![0x61; MAX_STRING_VALUE_LEN + 1]);
        assert!(host_to_json(&too_many_units, 0).unwrap_err().contains("exceeds host limit"));
        // One code unit becomes three UTF-8 bytes; checking only unit count
        // would admit this string despite the existing 2 MiB response bound.
        let too_many_bytes = HostValue::Utf16(vec![0x20AC; MAX_STRING_VALUE_LEN / 3 + 1]);
        assert!(host_to_json(&too_many_bytes, 0).unwrap_err().contains("exceeds host limit"));
    }

    #[test]
    fn float32_array_json_is_its_elements_as_javascript_reads_them() {
        // A guest Float32Array crosses as HostValue::Float32Array (ZIPP 0.0.19),
        // and the server serves it as a JSON array of numbers: a whole number
        // as an integer, an f32 fraction as the f64 it reads as in JavaScript,
        // NaN and Infinity as null like JSON.stringify.
        let mut state = compile_script("var result = { body: new Float32Array([1.5, 2, 0.1, NaN, Infinity, -0]) };").unwrap();
        state.run_init().unwrap();
        let slot = state.symbols().into_iter().find(|symbol| symbol.name == "result").unwrap().index;
        let result = state.get_slot(slot);
        assert!(matches!(&result, HostValue::Object(pairs) if matches!(pairs[0].1, HostValue::Float32Array(_))), "{result:?}");
        assert_eq!(host_to_json(&result, 0).unwrap(), serde_json::json!({
            "body": [1.5, 2, f64::from(0.1f32), null, null, 0]
        }));
    }

    #[test]
    fn float32_array_json_enforces_the_serialised_byte_limit() {
        // The bound is the JSON's length, like a string's. `[1,1,…,1]` is
        // 2n+1 bytes: MAX/2 - 1 ones fit (MAX - 1 bytes) and one more does not.
        // The old elements-times-four rule refused a tensor of ones at MAX/4,
        // half this size, while a small exponent's fifteen-plus characters an
        // element sailed through it.
        let at_limit = HostValue::Float32Array(vec![1.0; MAX_STRING_VALUE_LEN / 2 - 1]);
        let json = host_to_json(&at_limit, 0).unwrap();
        assert_eq!(json.as_array().unwrap().len(), MAX_STRING_VALUE_LEN / 2 - 1);
        assert_eq!(serde_json::to_vec(&json).unwrap().len(), MAX_STRING_VALUE_LEN - 1);
        let one_more = HostValue::Float32Array(vec![1.0; MAX_STRING_VALUE_LEN / 2]);
        assert!(host_to_json(&one_more, 0).unwrap_err().contains("exceeds host limit"));
        // A quarter of the elements the old rule admitted, past the floor, and
        // still refused: by what they serialise to, not by their own bytes.
        let wide = HostValue::Float32Array(vec![1.2345678e-38; MAX_STRING_VALUE_LEN / 8]);
        assert!(serde_json::to_vec(&serde_json::json!(f64::from(1.2345678e-38f32))).unwrap().len() > 16);
        assert!(host_to_json(&wide, 0).unwrap_err().contains("exceeds host limit"));
    }
}

#[cfg(test)]
mod abandonment_tests {
    use super::*;

    fn guard(abandonment: &Arc<Abandonment>) -> Arc<CallGuard> {
        Arc::new(CallGuard::new(abandonment.clone()))
    }

    /// The limit is on abandoned threads that are still running, not on how
    /// many stalls a process has ever had.
    #[test]
    fn a_place_among_the_abandoned_comes_back_when_the_thread_exits() {
        let abandonment = Abandonment::default();
        for _ in 0..MAX_ABANDONED_WORKERS {
            assert!(abandonment.reserve());
            abandonment.replaced();
        }
        assert!(!abandonment.reserve(), "the ninth has no place while eight still run");
        assert!(abandonment.exited(), "the thread's share of the budget is the caller's to give back");
        assert_eq!(abandonment.live(), MAX_ABANDONED_WORKERS - 1);
        assert!(abandonment.reserve(), "and one more may be abandoned in its place");
        // A place taken and not used is given back whole.
        abandonment.release();
        assert_eq!(abandonment.live(), MAX_ABANDONED_WORKERS - 1);
    }

    /// The runtime gives its whole budget back when it is dropped; a thread
    /// that outlives it must not give its share back a second time.
    #[test]
    fn a_thread_that_outlives_its_runtime_gives_nothing_back_twice() {
        let abandonment = Abandonment::default();
        assert!(abandonment.reserve());
        abandonment.replaced();
        assert!(abandonment.reserve());
        abandonment.replaced();
        assert!(abandonment.exited());
        assert_eq!(abandonment.close(), 1, "one replacement's original is still running");
        assert!(!abandonment.exited(), "the runtime already gave that thread's share back");
        assert_eq!(abandonment.live(), 0);
    }

    /// A wedged worker is only given up on when its replacement has started.
    #[test]
    fn a_worker_that_cannot_be_replaced_stays_in_the_pool() {
        let abandonment = Arc::new(Abandonment::default());

        // No thread could be started: nothing is taken, nothing is marked.
        let wedged = guard(&abandonment);
        assert!(replace_wedged(&wedged, &abandonment, || Err("no thread".to_string())).is_none());
        assert!(!wedged.abandoned.load(Ordering::Relaxed), "it would have left the pool when its call returned");
        assert_eq!(abandonment.live(), 0);
        assert!(wedged.wedge_reported.load(Ordering::Relaxed));
        // The next call it takes is a new one to report on.
        wedged.arm();
        assert!(!wedged.wedge_reported.load(Ordering::Relaxed));
        wedged.disarm();

        // Replaced: marked, counted, and the replacement is handed back.
        let replacement = guard(&abandonment);
        let handed = replacement.clone();
        let got = replace_wedged(&wedged, &abandonment, move || Ok(handed));
        assert!(got.is_some_and(|g| Arc::ptr_eq(&g, &replacement)));
        assert!(wedged.abandoned.load(Ordering::Relaxed));
        assert_eq!(abandonment.live(), 1);
        // This test took one thread from the process-wide budget as a
        // replacement does; give it back as the exiting thread would.
        assert!(abandonment.exited());
        GLOBAL_WORKER_COUNT.fetch_sub(1, Ordering::AcqRel);

        // At the limit: the start is not even tried.
        for _ in 0..MAX_ABANDONED_WORKERS {
            assert!(abandonment.reserve());
        }
        let late = guard(&abandonment);
        let mut tried = false;
        assert!(replace_wedged(&late, &abandonment, || { tried = true; Err("unreached".to_string()) }).is_none());
        assert!(!tried);
        assert!(!late.abandoned.load(Ordering::Relaxed));
        assert_eq!(abandonment.live(), MAX_ABANDONED_WORKERS);
    }
}

#[cfg(test)]
mod isolation_tests {
    use super::*;

    fn one_worker(source: &str) -> Arc<ServerRuntime> {
        let runtime = ServerRuntime::new(|| BridgeSet {
            db: None, http: None, fs: None, env: None, sql: None, crypto: None,
            allow_time: false, development: false, allow_photos: false, app_config: serde_json::Value::Null,
        }, Some(1)).unwrap();
        runtime.init(source.to_string()).unwrap();
        runtime
    }

    /// Nothing one request leaves in the script's world is there for the next
    /// request the same worker takes. A script whose top-level variables were
    /// all primitives (or that had none) kept its VM, and only those variables
    /// were put back: what a handler hung on a function, on a builtin, on
    /// `Object.prototype`, on the host's own `console`, or on a global it never
    /// declared was read by whoever that worker served next.
    #[test]
    fn what_a_request_leaves_behind_is_not_there_for_the_next() {
        let runtime = one_worker(r#"
            var LIMIT = 5;
            function onFunction(req) { onFunction.seen = (onFunction.seen || []); onFunction.seen.push(req.user); return {status: 200, body: onFunction.seen}; }
            function onBuiltin(req) { JSON.seen = (JSON.seen || []); JSON.seen.push(req.user); return {status: 200, body: JSON.seen}; }
            function onPrototype(req) { var had = ({}).marker; Object.prototype.marker = req.user; return {status: 200, body: [had === undefined ? null : had]}; }
            function onPlumbing(req) { var had = console.last; console.last = req.user; return {status: 200, body: [had === undefined ? null : had]}; }
            function onUndeclared(req) { var had = (typeof leaked === 'undefined') ? null : leaked; leaked = req.user; return {status: 200, body: [had]}; }
            // A declared variable too, whatever a handler puts in it: a typed
            // array is one of the values the old restore could not always undo.
            function onVariable(req) { var had = LIMIT; LIMIT = req.user === 'alice' ? new Float32Array([2, 3]) : req.user; return {status: 200, body: [typeof had === 'number' ? had : 'alice left: ' + typeof had]}; }
        "#);
        for handler in ["onFunction", "onBuiltin", "onPrototype", "onPlumbing", "onUndeclared", "onVariable"] {
            let call = |user: &str| runtime.call(handler, vec![serde_json::json!({"user": user})]).unwrap();
            call("alice");
            let second = serde_json::to_string(&call("bob")["body"]).unwrap();
            assert!(!second.contains("alice"), "{handler}: the second request saw the first's: {second}");
        }
    }

    /// A handler that grows its heap without end is stopped at the VM's
    /// limit, and the worker serves the next request; it had no limit, so one
    /// tenant's handler could take the process every tenant runs in.
    #[test]
    fn a_handler_that_fills_its_heap_is_stopped() {
        let runtime = one_worker(r#"
            function fill(req) { var kept = []; for (;;) { kept.push(new Array(4096).fill(kept.length)); } }
            function small(req) { return {status: 200, body: {ok: true}}; }
        "#);
        let failed = runtime.call("fill", vec![serde_json::json!({})]).unwrap_err();
        assert!(failed.to_lowercase().contains("memory") || failed.to_lowercase().contains("heap"), "{failed}");
        assert_eq!(runtime.call("small", vec![serde_json::json!({})]).unwrap()["body"]["ok"], true);
    }

    /// A handler, a hook and the script's top level run once and are done:
    /// nothing a timer would run later ever runs. Each of the four timer
    /// functions is an Error that says so, as on the PHP host
    /// (apps/softn-host-php/tests/route-declarations.test.mjs), where the
    /// engine's own setTimeout kept its callback for ever, or stopped the
    /// engine at the top level.
    #[test]
    fn a_timer_in_server_logic_is_an_error_that_says_so() {
        let runtime = one_worker(r#"
            function timers(req) {
                var said = {};
                ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'].forEach(function (name) {
                    try {
                        var timer = ({setTimeout: setTimeout, setInterval: setInterval, clearTimeout: clearTimeout, clearInterval: clearInterval})[name];
                        timer(function () {}, 10);
                        said[name] = 'nothing';
                    } catch (e) { said[name] = e.message; }
                });
                return {status: 200, body: said};
            }
            function timerLeftAlone(req) { setTimeout(function () {}, 10); return {status: 200, body: {ok: true}}; }
        "#);
        let said = runtime.call("timers", vec![serde_json::json!({})]).unwrap();
        for name in ["setTimeout", "setInterval", "clearTimeout", "clearInterval"] {
            assert_eq!(said["body"][name], format!("{name} is not available in server logic: nothing runs after the handler returns."), "{said}");
        }
        let left = runtime.call("timerLeftAlone", vec![serde_json::json!({})]).unwrap_err();
        assert!(left.contains("setTimeout is not available in server logic"), "{left}");
        // At the top level the script does not load, and says why.
        let top = ServerRuntime::new(|| BridgeSet {
            db: None, http: None, fs: None, env: None, sql: None, crypto: None,
            allow_time: false, development: false, allow_photos: false, app_config: serde_json::Value::Null,
        }, Some(1)).unwrap();
        let refused = top.init("setTimeout(function () {}, 1000);\nfunction ping(req) { return {status: 200, body: {}}; }".to_string()).unwrap_err();
        assert!(refused.contains("setTimeout is not available in server logic"), "{refused}");
    }

    /// Server logic that opens with `"use strict"` is strict, the host's own
    /// bridges included, and logic that does not stays sloppy. The two used to
    /// be one text with the preamble first, so the directive was an ordinary
    /// string and strict logic ran sloppy: `this` in a plain call was the
    /// global object and assigning an undeclared name made a global.
    #[test]
    fn a_scripts_use_strict_is_in_force_and_its_absence_too() {
        const PROBE: &str = "function probe(req) {\n  var plainThis = (function () { return this === undefined; })();\n  var assigned;\n  try { undeclaredName = 1; assigned = 'made a global'; } catch (e) { assigned = e.name; }\n  var settings;\n  try { softn.config.development = true; settings = 'ignored'; } catch (e) { settings = e.name; }\n  var timer;\n  try { setTimeout(function () {}, 1); } catch (e) { timer = e.message; }\n  return {status: 200, body: {plainThis: plainThis, assigned: assigned, settings: settings, timer: timer, development: softn.config.development}};\n}\n";
        for (prefix, strict) in [("\"use strict\";\n", true), ("// a comment first\n'use strict'\n", true), ("", false), ("var first = 1;\n\"use strict\";\n", false)] {
            let runtime = one_worker(&format!("{prefix}{PROBE}"));
            let body = runtime.call("probe", vec![serde_json::json!({})]).unwrap()["body"].clone();
            assert_eq!(body["plainThis"], strict, "{prefix:?}: {body}");
            assert_eq!(body["assigned"], if strict { "ReferenceError" } else { "made a global" }, "{prefix:?}: {body}");
            assert_eq!(body["settings"], if strict { "TypeError" } else { "ignored" }, "{prefix:?}: {body}");
            assert_eq!(body["development"], false, "{prefix:?}: {body}");
            assert_eq!(body["timer"], "setTimeout is not available in server logic: nothing runs after the handler returns.", "{prefix:?}: {body}");
        }
    }

    /// The positions an error reports are the script's own lines, under the
    /// name `logic`, strict or not: a syntax error says where it is, and a
    /// stack's frames are where the script's code is. Up to ZIPP 0.0.28 both
    /// counted the preamble's lines too, so line 2 was reported as one past
    /// the preamble's length.
    #[test]
    fn an_errors_positions_are_the_scripts_own_lines() {
        for (prefix, first) in [("", 1), ("\"use strict\";\n", 2)] {
            let top = ServerRuntime::new(|| BridgeSet {
                db: None, http: None, fs: None, env: None, sql: None, crypto: None,
                allow_time: false, development: false, allow_photos: false, app_config: serde_json::Value::Null,
            }, Some(1)).unwrap();
            let refused = top.init(format!("{prefix}function ok(req) {{ return {{status: 200, body: {{}}}}; }}\nlet c = ;\n")).unwrap_err();
            assert!(refused.ends_with(&format!("SyntaxError: unexpected token ';'\n    at logic:{}:9", first + 1)), "{prefix:?}: {refused}");
            let runtime = one_worker(&format!("{prefix}function where(req) {{\n  var e = new Error('x');\n  return {{status: 200, body: {{stack: e.stack}}}};\n}}\n"));
            let stack = runtime.call("where", vec![serde_json::json!({})]).unwrap()["body"]["stack"].as_str().unwrap_or_default().to_string();
            assert!(stack.contains(&format!("at where (logic:{}:", first + 1)), "{prefix:?}: {stack}");
        }
    }

    /// A regular expression that backtracks without end stops at the engine's
    /// ceiling for one search, as a RangeError the handler can catch, long
    /// before the call's step budget or its wall time.
    #[test]
    fn a_regex_that_backtracks_without_end_is_an_error_the_handler_can_catch() {
        let runtime = one_worker(r#"
            function search(req) {
                try { return {status: 200, body: {matched: /^(a+)+$/.test("a".repeat(40) + "!")}}; }
                catch (e) { return {status: 200, body: {caught: e.name + ": " + e.message}}; }
            }
        "#);
        let started = Instant::now();
        let answer = runtime.call("search", vec![serde_json::json!({})]);
        let elapsed = started.elapsed();
        let answer = answer.unwrap();
        assert_eq!(answer["body"]["caught"], "RangeError: regular expression exceeded its execution budget", "{answer}");
        assert!(elapsed < Duration::from_secs(5), "the search took {elapsed:?}");
    }

    /// What a handler builds and drops while it runs is collected while it
    /// runs. An array index-stored to a megabyte grows in place, which makes
    /// no object the engine counts, so until this binary's allocator reported
    /// its large blocks (src/alloc.rs) no collection ran in this loop and all
    /// 1,200 megabytes were held at once, until the call ended. With the
    /// reports the engine collects on that growth and the peak stays in the
    /// tens of megabytes.
    ///
    /// The figure is the process's, so whatever a test running beside this
    /// one holds at the time would be counted: it is measured in a process of
    /// its own, this test binary started again to run this test alone.
    #[test]
    fn arrays_a_handler_drops_are_collected_while_it_runs() {
        const ALONE: &str = "SOFTN_TEST_ALLOCATION_ALONE";
        if std::env::var_os(ALONE).is_none() {
            let name = format!("{}::arrays_a_handler_drops_are_collected_while_it_runs", module_path!().split_once("::").map_or(module_path!(), |(_, rest)| rest));
            let run = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", &name, "--test-threads=1", "--nocapture"])
                .env(ALONE, "1")
                .output()
                .unwrap();
            let said = format!("{}{}", String::from_utf8_lossy(&run.stdout), String::from_utf8_lossy(&run.stderr));
            assert!(run.status.success() && said.contains("1 passed"), "the measurement, run alone:\n{said}");
            return;
        }
        let runtime = one_worker(r#"
            function grow(req) {
                var s = 0;
                for (var i = 0; i < 1200; i++) { var a = []; a[131071] = 1; s += a.length; }
                return {status: 200, body: {s: s}};
            }
        "#);
        let (answer, grew) = crate::alloc::peak::growth(|| runtime.call("grow", vec![serde_json::json!({})]).unwrap());
        assert_eq!(answer["body"]["s"], 157_286_400);
        assert!(grew < 400 << 20, "1,200 dropped megabyte arrays left {} MiB outstanding at the peak", grew >> 20);
    }

    /// `-0` in a body is `-0` in the handler. The PHP host hands the body to
    /// its runner as the client's own text, so it keeps the sign too (it
    /// used to decode the body and write `0`); this holds the two together.
    #[test]
    fn a_negative_zero_in_a_body_keeps_its_sign() {
        let runtime = one_worker("function sign(req) { return {status: 200, body: {negative: 1 / req.body.a < 0, zero: req.body.a === 0, plain: 1 / req.body.b > 0}}; }");
        let body: serde_json::Value = serde_json::from_str(r#"{"a":-0,"b":0}"#).unwrap();
        let answer = runtime.call("sign", vec![serde_json::json!({ "body": body })]).unwrap();
        assert_eq!(answer["body"], serde_json::json!({"negative": true, "zero": true, "plain": true}));
    }

    /// A key of a body that begins with a NUL character is a key like any
    /// other here. The PHP host answers such a body 400: its JSON decoder
    /// refuses the property name. PRIVATE_BACKEND.md says so; this is the
    /// half of that sentence that is about this host.
    #[test]
    fn a_body_key_that_begins_with_nul_reaches_the_handler() {
        let runtime = one_worker("function keys(req) { var k = Object.keys(req.body)[0]; return {status: 200, body: {first: k.charCodeAt(0), rest: k.slice(1), value: req.body[k]}}; }");
        let body: serde_json::Value = serde_json::from_str(r#"{"\u0000k":7}"#).unwrap();
        let answer = runtime.call("keys", vec![serde_json::json!({ "body": body })]).unwrap();
        assert_eq!(answer["body"], serde_json::json!({"first": 0, "rest": "k", "value": 7}));
    }

    /// The calls of one `call_each` are one request's: each may find what the
    /// one before left, in order, however many workers there are (idle
    /// workers take calls in turn, so calls sent one by one ran in as many
    /// VMs as there were workers). Whatever any worker runs next, and the
    /// first call of the next job, starts from the script as it was loaded.
    #[test]
    fn the_calls_of_one_job_share_a_world_in_order_and_nothing_else_does() {
        let runtime = ServerRuntime::new(|| BridgeSet {
            db: None, http: None, fs: None, env: None, sql: None, crypto: None,
            allow_time: false, development: false, allow_photos: false, app_config: serde_json::Value::Null,
        }, Some(4)).unwrap();
        runtime.init(r#"
            function count(req) {
                count.n = (count.n || 0) + 1;
                if (req.fail) throw new Error('no');
                return {status: 200, body: count.n};
            }
        "#.to_string()).unwrap();
        // One stretch, however slowly this machine is running the test.
        runtime.each_slice_ms.store(600_000, Ordering::Relaxed);
        let each = |args: Vec<serde_json::Value>, deadline: Option<Instant>| -> Vec<Option<i64>> {
            runtime.call_each("count", args, deadline).unwrap().into_iter()
                .map(|answer| answer.ok().and_then(|value| value["body"].as_i64()))
                .collect()
        };
        let plain = |n: usize| vec![serde_json::json!({}); n];

        let twelve: Vec<Option<i64>> = (1..=12).map(Some).collect();
        assert_eq!(each(plain(12), None), twelve);
        // The next job does not find the last one's, and neither does an
        // ordinary request on any of the four workers.
        assert_eq!(each(plain(3), None), vec![Some(1), Some(2), Some(3)]);
        for _ in 0..8 {
            assert_eq!(runtime.call("count", vec![serde_json::json!({})]).unwrap()["body"], 1);
        }
        // A call that fails may have stopped anywhere: the next starts clean.
        let mut args = plain(4);
        args[1] = serde_json::json!({"fail": true});
        assert_eq!(each(args, None), vec![Some(1), None, Some(1), Some(2)]);
        // Out of time: the first is still made, and the rest are not.
        assert_eq!(each(plain(5), Some(Instant::now())), vec![Some(1)]);
        assert!(runtime.call_each("count", Vec::new(), None).unwrap().is_empty());

        // On one worker there is no other VM for the next job to land in.
        let single = one_worker("function count(req) { count.n = (count.n || 0) + 1; return {status: 200, body: count.n}; }");
        single.each_slice_ms.store(600_000, Ordering::Relaxed);
        let bodies = |n: usize| -> Vec<i64> {
            single.call_each("count", vec![serde_json::json!({}); n], None).unwrap().into_iter()
                .map(|answer| answer.unwrap()["body"].as_i64().unwrap())
                .collect()
        };
        assert_eq!(bodies(3), vec![1, 2, 3]);
        assert_eq!(bodies(2), vec![1, 2]);
        assert_eq!(single.call("count", vec![serde_json::json!({})]).unwrap()["body"], 1);
    }
}

#[cfg(test)]
mod each_slice_tests {
    use super::*;
    use crate::host::BridgeSet;

    fn one_worker(source: &str) -> Arc<ServerRuntime> {
        let runtime = ServerRuntime::new(|| BridgeSet {
            db: None, http: None, fs: None, env: None, sql: None, crypto: None,
            allow_time: false, development: false, allow_photos: false, app_config: serde_json::Value::Null,
        }, Some(1)).unwrap();
        runtime.init(source.to_string()).unwrap();
        runtime
    }

    /// A run of calls keeps its worker for a stretch and no longer: what it
    /// did not reach waits its turn behind whatever else has arrived, and
    /// starts clean. Made all at once, a push with slow per-op hooks held a
    /// worker until its last op, and on a pool of one every other request
    /// waited for it (a request sent 5 ms into a run of 300 calls was
    /// answered when the run was, where a call an op had let it in after one).
    #[test]
    fn a_long_run_of_calls_lets_other_requests_in() {
        let runtime = one_worker(r#"
            function count(req) { count.n = (count.n || 0) + 1; return {status: 200, body: count.n}; }
            function other(req) { return {status: 200, body: 'in'}; }
            function echo(req) { return {status: 200, body: req.n}; }
        "#);
        // A stretch of no time at all is one call: the first is always made.
        runtime.each_slice_ms.store(0, Ordering::Relaxed);
        let bodies = |n: usize| -> Vec<i64> {
            runtime.call_each("count", vec![serde_json::json!({}); n], None).unwrap().into_iter()
                .map(|answer| answer.unwrap()["body"].as_i64().unwrap())
                .collect()
        };
        // Every call is made, in order, and each stretch starts clean.
        assert_eq!(bodies(4), vec![1, 1, 1, 1]);
        let echoed: Vec<i64> = runtime
            .call_each("echo", (0..6).map(|n| serde_json::json!({"n": n})).collect(), None).unwrap().into_iter()
            .map(|answer| answer.unwrap()["body"].as_i64().unwrap())
            .collect();
        assert_eq!(echoed, vec![0, 1, 2, 3, 4, 5]);

        // The run is 300 stretches, each a rebuild long. A request sent as
        // it begins is answered long before it ends.
        let gate = Arc::new(std::sync::Barrier::new(2));
        let run_is_over = Arc::new(AtomicBool::new(false));
        let run = {
            let (runtime, gate, run_is_over) = (runtime.clone(), gate.clone(), run_is_over.clone());
            std::thread::spawn(move || {
                gate.wait();
                let answers = runtime.call_each("count", vec![serde_json::json!({}); 300], None).unwrap();
                run_is_over.store(true, Ordering::SeqCst);
                answers.len()
            })
        };
        gate.wait();
        let answer = runtime.call("other", vec![serde_json::json!({})]).unwrap();
        let waited_for_the_run = run_is_over.load(Ordering::SeqCst);
        assert_eq!(answer["body"], "in");
        assert_eq!(run.join().unwrap(), 300);
        assert!(!waited_for_the_run, "the request was answered only when the run of 300 calls was over");
    }

    /// The deadline is the caller's and a stretch never outlasts it: with a
    /// stretch far longer than the time the run is given, the run still ends
    /// at its deadline, having made the calls it had time for.
    #[test]
    fn a_run_ends_at_its_deadline_whatever_the_stretch() {
        let runtime = one_worker("function count(req) { count.n = (count.n || 0) + 1; return {status: 200, body: count.n}; }");
        runtime.each_slice_ms.store(600_000, Ordering::Relaxed);
        let answers = runtime.call_each("count", vec![serde_json::json!({}); 5], Some(Instant::now())).unwrap();
        assert_eq!(answers.len(), 1);
        // And with no time for a stretch either, it is the same one call.
        runtime.each_slice_ms.store(0, Ordering::Relaxed);
        let answers = runtime.call_each("count", vec![serde_json::json!({}); 5], Some(Instant::now())).unwrap();
        assert_eq!(answers.len(), 1);
        assert!(runtime.call_each("count", Vec::new(), None).unwrap().is_empty());
    }

    /// A stretch is timed from when a worker takes it. Timed from when it was
    /// sent, one that had waited its length behind other requests was a
    /// single call long, and a busy host compiled the script for every op.
    #[test]
    fn a_stretch_is_timed_from_when_it_is_taken() {
        let slice = Duration::from_millis(100);
        let taken = Instant::now() + Duration::from_secs(3);
        assert_eq!(stretch_end(taken, slice, None), taken + slice);
        // The caller's deadline ends it sooner, and a later one does not extend it.
        let soon = taken + Duration::from_millis(10);
        assert_eq!(stretch_end(taken, slice, Some(soon)), soon);
        assert_eq!(stretch_end(taken, slice, Some(taken + Duration::from_secs(60))), taken + slice);
        // Past the deadline already: only the call that is always made.
        assert!(stretch_end(taken, slice, Some(taken - Duration::from_secs(1))) < taken);
    }
}

#[cfg(test)]
mod private_sql_tests {
    use super::*;
    use crate::bridges::sql::{NativeSql, open_connection};

    #[test]
    fn real_vm_commits_rejections_and_rolls_back_faults_and_invalid_responses() {
        let path = crate::test_dirs::temp_path("softn-vm-sql", ".sqlite");
        open_connection(&path).unwrap().execute_batch("CREATE TABLE attempts(id INTEGER PRIMARY KEY, count INTEGER);").unwrap();
        let worker_path = path.clone();
        let runtime = ServerRuntime::new(move || BridgeSet {
            db: None, http: None, fs: None, env: None,
            sql: Some(NativeSql::new(worker_path.clone())), crypto: None,
            allow_time: false, development: true, allow_photos: false, app_config: serde_json::Value::Null,
        }, Some(2)).unwrap();
        runtime.init(r#"
            var forceRebuild = {};
            try { softn.sql.execute('INSERT INTO attempts(count) VALUES(99)',[]); } catch(e) {}
            function change(req) {
                softn.sql.execute('INSERT INTO attempts(count) VALUES(?)',[1]);
                if(req.mode==='throw') throw new Error('fault');
                if(req.mode==='rollback') return {status:400,body:{error:'rejected'},rollback:true};
                if(req.mode==='invalid') return {status:999,body:{}};
                if(req.mode==='caught') { try {softn.sql.query('SELECT * FROM _migrations',[]);} catch(e) {} }
                return {status:401,body:{error:'wrong OTP'}};
            }
            function read() {return {status:200,body:softn.sql.first('SELECT COUNT(*) AS count FROM attempts',[])};}
        "#.to_string()).unwrap();
        let invoke = |mode: &str| runtime.call_transaction("change", vec![serde_json::json!({"mode":mode})], TransactionMode::Write, Arc::new(AtomicBool::new(false)));
        assert_eq!(invoke("commit").unwrap()["status"], 401);
        assert_eq!(invoke("rollback").unwrap()["status"], 400);
        assert!(invoke("throw").is_err());
        assert!(invoke("invalid").is_err());
        assert!(invoke("caught").is_err());
        let result = runtime.call_transaction("read", vec![], TransactionMode::Read, Arc::new(AtomicBool::new(false))).unwrap();
        assert_eq!(result["body"]["count"], 1);
    }
}
