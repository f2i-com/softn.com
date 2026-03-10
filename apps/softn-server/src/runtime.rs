use formlogic_core::engine::{FormLogicEngine, ScriptState};
use formlogic_core::object::{self, HashKey, HashObject, Object};
use formlogic_core::value::{self, Heap, Value};
use std::collections::HashSet;
use std::sync::Arc;

/// Collection of bridge instances, created per worker thread.
pub struct BridgeSet {
    pub db: Option<Box<dyn formlogic_core::db_bridge::DbBridge>>,
    pub http: Option<Box<dyn formlogic_core::http_bridge::HttpBridge>>,
    pub fs: Option<Box<dyn formlogic_core::fs_bridge::FsBridge>>,
    pub env: Option<Box<dyn formlogic_core::env_bridge::EnvBridge>>,
}

enum ScriptRequest {
    Init {
        source: String,
        reply: std::sync::mpsc::Sender<Result<Vec<String>, String>>,
    },
    Call {
        name: String,
        args: Vec<serde_json::Value>,
        reply: std::sync::mpsc::Sender<Result<serde_json::Value, String>>,
    },
}

/// Wraps FormLogicEngine instances behind a pool of dedicated OS threads.
///
/// Architecture:
/// - Each worker has a **dedicated** init channel (guarantees 1:1 delivery).
/// - After init, workers pull Call requests from a **shared** MPMC channel
///   so idle workers pick up tasks automatically.
/// - Pool is sized for I/O-bound workloads (scripts may block on HTTP/DB).
///
/// **Important for script authors:** Worker threads may be re-initialized after
/// a panic, which resets all in-memory global state to its post-init value.
/// Additionally, requests are dispatched to any idle worker, so different calls
/// may execute on different threads with independent global state. Scripts must
/// not rely on in-memory globals persisting across operations — always flush
/// state to the database (via `db.*` APIs) for durability.
///
/// **Thread lifecycle:** Workers are tied to the channels owned by this struct.
/// When `ServerRuntime` is dropped (e.g. if `init()` fails), `work_tx` and
/// `init_txs` are dropped, causing all worker `recv()` calls to return `Err`,
/// which exits their loops cleanly. No explicit shutdown signal is needed.
pub struct ServerRuntime {
    work_tx: crossbeam_channel::Sender<ScriptRequest>,
    /// One per worker — used only during init() for guaranteed 1:1 delivery.
    init_txs: Vec<crossbeam_channel::Sender<ScriptRequest>>,
    worker_count: usize,
    /// Global names extracted during init for lock-free has_function lookups.
    known_globals: std::sync::OnceLock<HashSet<String>>,
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

        let factory = Arc::new(bridge_factory);
        // Bounded queue prevents memory exhaustion from request floods.
        // 2x worker_count gives enough headroom for burst absorption while
        // applying backpressure when all workers are saturated.
        let (work_tx, work_rx) = crossbeam_channel::bounded::<ScriptRequest>(worker_count * 2);
        let mut init_txs = Vec::with_capacity(worker_count);

        for i in 0..worker_count {
            let factory_clone = factory.clone();
            let work_rx_clone = work_rx.clone();
            // Each worker gets a dedicated bounded(1) init channel
            let (init_tx, init_rx) = crossbeam_channel::bounded::<ScriptRequest>(1);

            std::thread::Builder::new()
                .name(format!("softn-worker-{}", i))
                .spawn(move || {
                    Self::script_thread(init_rx, work_rx_clone, &*factory_clone);
                })
                .unwrap_or_else(|e| {
                    tracing::error!("Failed to spawn worker thread {}: {}", i, e);
                    panic!("Cannot start server: failed to spawn worker thread {}", i);
                });

            init_txs.push(init_tx);
        }

        tracing::info!("Script worker pool: {} threads", worker_count);

        Arc::new(Self {
            work_tx,
            init_txs,
            worker_count,
            known_globals: std::sync::OnceLock::new(),
        })
    }

    fn script_thread<F>(
        init_rx: crossbeam_channel::Receiver<ScriptRequest>,
        work_rx: crossbeam_channel::Receiver<ScriptRequest>,
        bridge_factory: &F,
    )
    where
        F: Fn() -> BridgeSet,
    {
        let engine = FormLogicEngine::default();
        let mut state: Option<ScriptState> = None;
        let mut init_source: Option<String> = None;

        // Phase 1: Wait for Init on dedicated channel (guaranteed 1:1 delivery).
        match init_rx.recv() {
            Ok(req) => {
                if let ScriptRequest::Init { ref source, .. } = req {
                    init_source = Some(source.clone());
                }
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    Self::handle_request(req, &engine, &mut state, bridge_factory);
                }));
                if let Err(panic_info) = result {
                    Self::log_panic(&panic_info);
                    state = None;
                }
            }
            Err(_) => return,
        }

        // Phase 2: Process Call requests from the shared MPMC queue.
        // Circuit breaker: if panics are too frequent, delay re-init to avoid
        // thrashing CPU with constant teardown/rebuild cycles from a deterministic
        // crash payload being repeatedly dispatched.
        const MAX_PANICS_IN_WINDOW: u32 = 3;
        const PANIC_WINDOW: std::time::Duration = std::time::Duration::from_secs(10);
        const COOLDOWN: std::time::Duration = std::time::Duration::from_secs(5);
        let mut panic_count: u32 = 0;
        let mut window_start = std::time::Instant::now();

        loop {
            let req = match work_rx.recv() {
                Ok(r) => r,
                Err(_) => break,
            };

            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                Self::handle_request(req, &engine, &mut state, bridge_factory);
            }));

            if let Err(panic_info) = result {
                Self::log_panic(&panic_info);

                // Circuit breaker: track panic frequency
                let now = std::time::Instant::now();
                if now.duration_since(window_start) > PANIC_WINDOW {
                    // Reset window
                    panic_count = 1;
                    window_start = now;
                } else {
                    panic_count += 1;
                }

                if panic_count >= MAX_PANICS_IN_WINDOW {
                    tracing::warn!(
                        "Worker panicked {} times in {}s — sleeping for {}s to prevent thrashing",
                        panic_count, PANIC_WINDOW.as_secs(), COOLDOWN.as_secs()
                    );
                    // Sleep rather than drain the shared MPMC channel. A sleeping
                    // worker simply doesn't participate — healthy workers pick up
                    // all requests from the bounded queue. Draining would actively
                    // steal requests from healthy workers and fail them ("black hole").
                    std::thread::sleep(COOLDOWN);
                    panic_count = 0;
                    window_start = std::time::Instant::now();
                }

                // State is potentially corrupted — attempt re-init from stored source
                state = None;
                if let Some(ref source) = init_source {
                    match Self::init_state(&engine, source, bridge_factory) {
                        Ok(s) => {
                            state = Some(s);
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

    /// Compile source, attach bridges, and configure execution limits.
    fn init_state<F>(
        engine: &FormLogicEngine,
        source: &str,
        bridge_factory: &F,
    ) -> Result<ScriptState, String>
    where
        F: Fn() -> BridgeSet,
    {
        let mut s = engine.init_script(source)?;
        let bridges = bridge_factory();
        if let Some(db) = bridges.db {
            s.set_db(db);
        }
        if let Some(http) = bridges.http {
            s.set_http(http);
        }
        if let Some(fs) = bridges.fs {
            s.set_fs(fs);
        }
        if let Some(env) = bridges.env {
            s.set_env(env);
        }
        // VM wall-time (25s) must be lower than the HTTP/WS
        // timeout (30s) so the engine terminates gracefully
        // and sends a clean error before the outer timeout fires.
        s.set_execution_limits(
            Some(100_000_000), // 100M instructions
            Some(25_000),      // 25s wall time (< 30s HTTP timeout)
        );
        Ok(s)
    }

    fn handle_request<F>(
        req: ScriptRequest,
        engine: &FormLogicEngine,
        state: &mut Option<ScriptState>,
        bridge_factory: &F,
    )
    where
        F: Fn() -> BridgeSet,
    {
        match req {
            ScriptRequest::Init { source, reply } => {
                match Self::init_state(engine, &source, bridge_factory) {
                    Ok(s) => {
                        let globals: Vec<String> =
                            s.globals_table().keys().cloned().collect();
                        *state = Some(s);
                        let _ = reply.send(Ok(globals));
                    }
                    Err(e) => {
                        let _ = reply.send(Err(e));
                    }
                }
            }
            ScriptRequest::Call { name, args, reply } => {
                let result = match state.as_mut() {
                    Some(s) => {
                        let obj_args: Result<Vec<Object>, String> = args
                            .into_iter()
                            .map(|v| json_to_object(v, s.heap_mut()))
                            .collect();
                        match obj_args {
                            Ok(obj_args) => {
                                match s.call_function(&name, &obj_args) {
                                    Ok(result) => object_to_json(&result, s.heap()),
                                    Err(e) => Err(e),
                                }
                            }
                            Err(e) => Err(e),
                        }
                    }
                    None => Err("Runtime not initialized".into()),
                };
                let _ = reply.send(result);
            }
        }
    }

    /// Initialize all workers with the same source code.
    /// Uses per-worker dedicated channels to guarantee 1:1 delivery.
    pub fn init(&self, source: String) -> Result<(), String> {
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
        let init_timeout = std::time::Duration::from_secs(30);
        for (i, reply_rx) in reply_rxs.iter().enumerate() {
            match reply_rx.recv_timeout(init_timeout) {
                Ok(Ok(globals)) => {
                    // Store global names from the first successful worker
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
        reply_rx
            .recv()
            .map_err(|_| "Script worker died".to_string())?
    }

    /// Instant lock-free check using global names extracted during init.
    pub fn has_function(&self, name: &str) -> bool {
        self.known_globals
            .get()
            .map(|set| set.contains(name))
            .unwrap_or(false)
    }
}

// ── JSON ↔ Object conversion ──

/// Maximum nesting depth for JSON → Object conversion to prevent stack overflow.
const MAX_JSON_DEPTH: usize = 64;

/// Maximum individual string length when converting JSON to VM objects (2MB).
/// Prevents OOM from payloads with multi-megabyte string values being copied
/// into the sandboxed VM heap. Scripts needing larger data should use the
/// FS bridge to read/write files instead.
const MAX_STRING_VALUE_LEN: usize = 2 * 1024 * 1024;

fn json_to_object(val: serde_json::Value, heap: &mut Heap) -> Result<Object, String> {
    json_to_object_inner(val, heap, 0)
}

fn json_to_object_inner(val: serde_json::Value, heap: &mut Heap, depth: usize) -> Result<Object, String> {
    if depth > MAX_JSON_DEPTH {
        return Err(format!("JSON nesting depth exceeds maximum of {}", MAX_JSON_DEPTH));
    }
    match val {
        serde_json::Value::Null => Ok(Object::Null),
        serde_json::Value::Bool(b) => Ok(Object::Boolean(b)),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Ok(Object::Integer(i))
            } else {
                Ok(Object::Float(n.as_f64().unwrap_or(0.0)))
            }
        }
        serde_json::Value::String(s) => {
            if s.len() > MAX_STRING_VALUE_LEN {
                return Err(format!(
                    "String value too large ({} bytes, max {})",
                    s.len(), MAX_STRING_VALUE_LEN
                ));
            }
            Ok(Object::String(s.into()))
        }
        serde_json::Value::Array(arr) => {
            let mut items: Vec<Value> = Vec::with_capacity(arr.len());
            for v in arr {
                let child = json_to_object_inner(v, heap, depth + 1)?;
                items.push(value::obj_into_val(child, heap));
            }
            Ok(object::make_array(items))
        }
        serde_json::Value::Object(map) => {
            let mut hash = HashObject::default();
            for (k, v) in map {
                let child = json_to_object_inner(v, heap, depth + 1)?;
                let val = value::obj_into_val(child, heap);
                hash.insert_pair(HashKey::from_owned_string(k), val);
            }
            Ok(object::make_hash(hash))
        }
    }
}

fn object_to_json(obj: &Object, heap: &Heap) -> Result<serde_json::Value, String> {
    object_to_json_inner(obj, heap, 0)
}

fn object_to_json_inner(obj: &Object, heap: &Heap, depth: usize) -> Result<serde_json::Value, String> {
    if depth > MAX_JSON_DEPTH {
        return Err(format!("Object nesting depth exceeds maximum of {}", MAX_JSON_DEPTH));
    }
    match obj {
        Object::Null | Object::Undefined => Ok(serde_json::Value::Null),
        Object::Boolean(b) => Ok(serde_json::Value::Bool(*b)),
        Object::Integer(n) => Ok(serde_json::json!(*n)),
        Object::Float(f) => Ok(serde_json::json!(*f)),
        Object::String(s) => {
            let s = s.to_string();
            if s.len() > MAX_STRING_VALUE_LEN {
                // Truncate at a UTF-8 boundary to prevent allocation of
                // massive JSON strings from script-generated values.
                let mut end = MAX_STRING_VALUE_LEN;
                while end > 0 && !s.is_char_boundary(end) {
                    end -= 1;
                }
                let mut truncated = s[..end].to_string();
                truncated.push_str("...(truncated)");
                Ok(serde_json::Value::String(truncated))
            } else {
                Ok(serde_json::Value::String(s))
            }
        }
        Object::Array(arr) => {
            let items = arr.borrow();
            let mut vals: Vec<serde_json::Value> = Vec::with_capacity(items.len());
            for v in items.iter() {
                let child = value::val_to_obj(*v, heap);
                vals.push(object_to_json_inner(&child, heap, depth + 1)?);
            }
            Ok(serde_json::Value::Array(vals))
        }
        Object::Hash(hash) => {
            let borrowed = hash.borrow_mut();
            borrowed.sync_pairs_if_dirty();
            let mut map = serde_json::Map::new();
            for (key, val) in borrowed.pairs.iter() {
                let k = key.display_key();
                let child = value::val_to_obj(*val, heap);
                map.insert(k, object_to_json_inner(&child, heap, depth + 1)?);
            }
            Ok(serde_json::Value::Object(map))
        }
        Object::Instance(inst) => {
            let mut map = serde_json::Map::new();
            for (k, v) in &inst.fields {
                map.insert(k.clone(), object_to_json_inner(v, heap, depth + 1)?);
            }
            Ok(serde_json::Value::Object(map))
        }
        Object::Error(err) => {
            // Truncate error messages to prevent unbounded memory usage from
            // scripts that generate massive strings in Error constructors.
            const MAX_ERR_LEN: usize = 2048;
            let name = err.name.to_string();
            let mut message = err.message.to_string();
            if message.len() > MAX_ERR_LEN {
                message.truncate(MAX_ERR_LEN);
                message.push_str("...(truncated)");
            }
            Ok(serde_json::json!({
                "name": name,
                "message": message,
            }))
        }
        _ => Ok(serde_json::Value::Null),
    }
}
