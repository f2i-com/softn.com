use formlogic_core::engine::{FormLogicEngine, ScriptState};
use formlogic_core::object::{self, HashKey, HashObject, Object};
use formlogic_core::value::{self, Heap, Value};
use std::sync::Arc;

/// Collection of bridge factories, created on the script thread.
pub struct BridgeSet {
    pub db: Option<Box<dyn formlogic_core::db_bridge::DbBridge>>,
    pub http: Option<Box<dyn formlogic_core::http_bridge::HttpBridge>>,
    pub fs: Option<Box<dyn formlogic_core::fs_bridge::FsBridge>>,
    pub env: Option<Box<dyn formlogic_core::env_bridge::EnvBridge>>,
}

enum ScriptRequest {
    Init {
        source: String,
        reply: std::sync::mpsc::Sender<Result<(), String>>,
    },
    Call {
        name: String,
        args: Vec<serde_json::Value>,
        reply: std::sync::mpsc::Sender<Result<serde_json::Value, String>>,
    },
    HasFunction {
        name: String,
        reply: std::sync::mpsc::Sender<bool>,
    },
}

/// Wraps a FormLogicEngine + ScriptState behind a dedicated OS thread.
pub struct ServerRuntime {
    tx: std::sync::mpsc::Sender<ScriptRequest>,
}

impl ServerRuntime {
    /// Create a new runtime. `bridge_factory` is called on the script thread.
    pub fn new<F>(bridge_factory: F) -> Arc<Self>
    where
        F: FnOnce() -> BridgeSet + Send + 'static,
    {
        let (tx, rx) = std::sync::mpsc::channel::<ScriptRequest>();

        std::thread::spawn(move || {
            Self::script_thread(rx, bridge_factory);
        });

        Arc::new(Self { tx })
    }

    fn script_thread<F>(rx: std::sync::mpsc::Receiver<ScriptRequest>, bridge_factory: F)
    where
        F: FnOnce() -> BridgeSet,
    {
        let engine = FormLogicEngine::default();
        let mut state: Option<ScriptState> = None;
        let mut bridges = Some(bridge_factory());

        while let Ok(req) = rx.recv() {
            match req {
                ScriptRequest::Init { source, reply } => {
                    match engine.init_script(&source) {
                        Ok(mut s) => {
                            // Set all bridges (consumed once during init)
                            if let Some(b) = bridges.take() {
                                if let Some(db) = b.db {
                                    s.set_db(db);
                                }
                                if let Some(http) = b.http {
                                    s.set_http(http);
                                }
                                if let Some(fs) = b.fs {
                                    s.set_fs(fs);
                                }
                                if let Some(env) = b.env {
                                    s.set_env(env);
                                }
                            }
                            // VM wall-time (25s) must be lower than the HTTP/WS
                            // timeout (30s) so the engine terminates gracefully
                            // and sends a clean error before the outer timeout fires.
                            s.set_execution_limits(
                                Some(100_000_000), // 100M instructions
                                Some(25_000),      // 25s wall time (< 30s HTTP timeout)
                            );
                            state = Some(s);
                            let _ = reply.send(Ok(()));
                        }
                        Err(e) => {
                            let _ = reply.send(Err(e));
                        }
                    }
                }
                ScriptRequest::Call { name, args, reply } => {
                    let result = match state.as_mut() {
                        Some(s) => {
                            // Convert JSON args to Objects
                            let obj_args: Vec<Object> = args
                                .into_iter()
                                .map(|v| json_to_object(v, s.heap_mut()))
                                .collect();

                            match s.call_function(&name, &obj_args) {
                                Ok(result) => {
                                    Self::flush_server_log(s);
                                    let json = object_to_json(&result, s.heap());
                                    Ok(json)
                                }
                                Err(e) => {
                                    Self::flush_server_log(s);
                                    Err(e)
                                }
                            }
                        }
                        None => Err("Runtime not initialized".into()),
                    };
                    let _ = reply.send(result);
                }
                ScriptRequest::HasFunction { name, reply } => {
                    let has = state
                        .as_ref()
                        .map(|s| s.globals_table().contains_key(&name))
                        .unwrap_or(false);
                    let _ = reply.send(has);
                }
            }
        }
    }

    fn flush_server_log(state: &mut ScriptState) {
        if let Ok(log_obj) = state.get_global("__server_log") {
            if let Object::Array(arr) = &log_obj {
                // Collect messages first, then clear — avoids overlapping borrow/borrow_mut
                let messages: Vec<String> = {
                    let borrowed = arr.borrow();
                    borrowed
                        .iter()
                        .map(|item| {
                            let obj = value::val_to_obj(*item, state.heap());
                            match &obj {
                                Object::String(s) => s.to_string(),
                                other => format!("{:?}", other),
                            }
                        })
                        .collect()
                };
                arr.borrow_mut().clear();

                for msg in &messages {
                    if msg.starts_with("WARN ") {
                        tracing::warn!(target: "softn_script", "{}", &msg[5..]);
                    } else if msg.starts_with("ERROR ") {
                        tracing::error!(target: "softn_script", "{}", &msg[6..]);
                    } else if msg.starts_with("INFO ") {
                        tracing::info!(target: "softn_script", "{}", &msg[5..]);
                    } else {
                        tracing::info!(target: "softn_script", "{}", msg);
                    }
                }
            }
        }
    }

    pub fn init(&self, source: String) -> Result<(), String> {
        let (reply_tx, reply_rx) = std::sync::mpsc::channel();
        self.tx
            .send(ScriptRequest::Init {
                source,
                reply: reply_tx,
            })
            .map_err(|_| "Script thread died".to_string())?;
        reply_rx
            .recv()
            .map_err(|_| "Script thread died".to_string())?
    }

    pub fn call(
        &self,
        name: &str,
        args: Vec<serde_json::Value>,
    ) -> Result<serde_json::Value, String> {
        let (reply_tx, reply_rx) = std::sync::mpsc::channel();
        self.tx
            .send(ScriptRequest::Call {
                name: name.to_string(),
                args,
                reply: reply_tx,
            })
            .map_err(|_| "Script thread died".to_string())?;
        reply_rx
            .recv()
            .map_err(|_| "Script thread died".to_string())?
    }

    pub fn has_function(&self, name: &str) -> bool {
        let (reply_tx, reply_rx) = std::sync::mpsc::channel();
        let _ = self.tx.send(ScriptRequest::HasFunction {
            name: name.to_string(),
            reply: reply_tx,
        });
        reply_rx.recv().unwrap_or(false)
    }
}

// ── JSON ↔ Object conversion ──

fn json_to_object(val: serde_json::Value, heap: &mut Heap) -> Object {
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
                    let child = json_to_object(v, heap);
                    value::obj_into_val(child, heap)
                })
                .collect();
            object::make_array(items)
        }
        serde_json::Value::Object(map) => {
            let mut hash = HashObject::default();
            for (k, v) in map {
                let child = json_to_object(v, heap);
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
