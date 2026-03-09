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
    pub fn new<F>(bridge_factory: F) -> Arc<Self>
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
        let worker_count = std::thread::available_parallelism()
            .map(|n| n.get().max(16).min(50))
            .unwrap_or(16);

        let factory = Arc::new(bridge_factory);
        let (work_tx, work_rx) = crossbeam_channel::unbounded::<ScriptRequest>();
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
                .expect("Failed to spawn worker thread");

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

                // State is potentially corrupted — attempt re-init from stored source
                state = None;
                if let Some(ref source) = init_source {
                    match Self::init_state(&engine, source, bridge_factory) {
                        Ok(s) => {
                            state = Some(s);
                            tracing::info!("Worker re-initialized after panic");
                        }
                        Err(e) => {
                            tracing::error!("Worker failed to re-init after panic: {}", e);
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
                        let obj_args: Vec<Object> = args
                            .into_iter()
                            .map(|v| json_to_object(v, s.heap_mut()))
                            .collect();

                        match s.call_function(&name, &obj_args) {
                            Ok(result) => {
                                let json = object_to_json(&result, s.heap());
                                Ok(json)
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
        for (i, reply_rx) in reply_rxs.iter().enumerate() {
            match reply_rx.recv() {
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
    pub fn call(
        &self,
        name: &str,
        args: Vec<serde_json::Value>,
    ) -> Result<serde_json::Value, String> {
        let (reply_tx, reply_rx) = std::sync::mpsc::channel();
        self.work_tx
            .send(ScriptRequest::Call {
                name: name.to_string(),
                args,
                reply: reply_tx,
            })
            .map_err(|_| "All script workers died".to_string())?;
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

fn json_to_object(val: serde_json::Value, heap: &mut Heap) -> Object {
    json_to_object_inner(val, heap, 0)
}

fn json_to_object_inner(val: serde_json::Value, heap: &mut Heap, depth: usize) -> Object {
    if depth > MAX_JSON_DEPTH {
        return Object::Null;
    }
    match val {
        serde_json::Value::Null => Object::Null,
        serde_json::Value::Bool(b) => Object::Boolean(b),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Object::Integer(i)
            } else {
                Object::Float(n.as_f64().unwrap_or(0.0))
            }
        }
        serde_json::Value::String(s) => Object::String(s.into()),
        serde_json::Value::Array(arr) => {
            let items: Vec<Value> = arr
                .into_iter()
                .map(|v| {
                    let child = json_to_object_inner(v, heap, depth + 1);
                    value::obj_into_val(child, heap)
                })
                .collect();
            object::make_array(items)
        }
        serde_json::Value::Object(map) => {
            let mut hash = HashObject::default();
            for (k, v) in map {
                let child = json_to_object_inner(v, heap, depth + 1);
                let val = value::obj_into_val(child, heap);
                hash.insert_pair(HashKey::from_owned_string(k), val);
            }
            object::make_hash(hash)
        }
    }
}

fn object_to_json(obj: &Object, heap: &Heap) -> serde_json::Value {
    match obj {
        Object::Null | Object::Undefined => serde_json::Value::Null,
        Object::Boolean(b) => serde_json::Value::Bool(*b),
        Object::Integer(n) => serde_json::json!(*n),
        Object::Float(f) => serde_json::json!(*f),
        Object::String(s) => serde_json::Value::String(s.to_string()),
        Object::Array(arr) => {
            let items = arr.borrow();
            let vals: Vec<serde_json::Value> = items
                .iter()
                .map(|v| {
                    let child = value::val_to_obj(*v, heap);
                    object_to_json(&child, heap)
                })
                .collect();
            serde_json::Value::Array(vals)
        }
        Object::Hash(hash) => {
            let borrowed = hash.borrow_mut();
            borrowed.sync_pairs_if_dirty();
            let mut map = serde_json::Map::new();
            for (key, val) in borrowed.pairs.iter() {
                let k = key.display_key();
                let child = value::val_to_obj(*val, heap);
                map.insert(k, object_to_json(&child, heap));
            }
            serde_json::Value::Object(map)
        }
        Object::Instance(inst) => {
            let mut map = serde_json::Map::new();
            for (k, v) in &inst.fields {
                map.insert(k.clone(), object_to_json(v, heap));
            }
            serde_json::Value::Object(map)
        }
        Object::Error(err) => {
            serde_json::json!({
                "name": err.name.to_string(),
                "message": err.message.to_string(),
            })
        }
        _ => serde_json::Value::Null,
    }
}
