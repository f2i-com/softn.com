use crate::pool::{self, ServerDb};
use crate::runtime::ServerRuntime;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use subtle::ConstantTimeEq;
use tokio::sync::broadcast;

/// Valid operations for sync ops.
const VALID_OPERATIONS: &[&str] = &["create", "update", "delete"];

/// Maximum allowed clock drift from clients into the future (in seconds).
/// Timestamps further ahead than this are clamped to server time to prevent
/// far-future timestamps from permanently winning in LWW conflict resolution.
/// Past timestamps are always trusted — they represent legitimate offline edits.
const MAX_FUTURE_DRIFT_SECS: i64 = 5 * 60; // 5 minutes

/// Validate a collection name: must be non-empty, alphanumeric + dash/underscore,
/// and at most 64 characters. Rejects names that could cause issues in queries.
fn is_valid_collection_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncOp {
    pub id: String,
    pub collection: String,
    pub operation: String,
    #[serde(rename = "recordId", default)]
    pub record_id: String,
    pub data: Option<serde_json::Value>,
    #[serde(default)]
    pub timestamp: String,
    #[serde(rename = "clientId", default)]
    pub client_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
pub enum ServerMessage {
    #[serde(rename = "auth_ok")]
    AuthOk {
        #[serde(rename = "clientId")]
        client_id: String,
        #[serde(rename = "serverTime")]
        server_time: String,
    },
    #[serde(rename = "auth_error")]
    AuthError { reason: String },
    #[serde(rename = "sync_state")]
    SyncState {
        collection: String,
        records: Vec<serde_json::Value>,
    },
    #[serde(rename = "sync_delta")]
    SyncDelta { ops: Vec<SyncOp> },
    #[serde(rename = "sync_ack")]
    SyncAck {
        #[serde(rename = "opIds")]
        op_ids: Vec<String>,
    },
    #[serde(rename = "sync_reject")]
    SyncReject {
        #[serde(rename = "opId")]
        op_id: String,
        reason: String,
    },
    /// Transient failure — client should retry (e.g. hook execution error,
    /// pool exhaustion). Distinct from SyncReject which is permanent.
    #[serde(rename = "sync_retry")]
    SyncRetry {
        #[serde(rename = "opIds")]
        op_ids: Vec<String>,
        reason: String,
    },
    #[serde(rename = "error")]
    Error { message: String },
}

pub struct SyncManager {
    db: ServerDb,
    broadcast_tx: broadcast::Sender<(String, ServerMessage)>,
    runtime: Option<Arc<ServerRuntime>>,
    /// Batch hook: validates all ops in a single RPC call (preferred).
    has_before_sync_batch: bool,
    /// Per-op hook: fallback if batch hook is not defined.
    has_before_sync: bool,
    has_after_sync_batch: bool,
    has_after_sync: bool,
    auth_token: Option<String>,
    /// Bounds concurrent blocking sync operations to prevent Tokio's
    /// spawn_blocking pool (512 threads) from exhaustion by slow/malicious
    /// clients. When full, callers should return backpressure immediately.
    pub sync_permits: Arc<tokio::sync::Semaphore>,
}

impl SyncManager {
    pub fn new(
        db: ServerDb,
        runtime: Option<Arc<ServerRuntime>>,
        auth_token: Option<String>,
    ) -> Arc<Self> {
        let (broadcast_tx, _) = broadcast::channel(256);

        let has_before_sync_batch = runtime
            .as_ref()
            .map(|r| r.has_function("onBeforeSyncBatch"))
            .unwrap_or(false);
        let has_before_sync = runtime
            .as_ref()
            .map(|r| r.has_function("onBeforeSync"))
            .unwrap_or(false);
        let has_after_sync_batch = runtime
            .as_ref()
            .map(|r| r.has_function("onAfterSyncBatch"))
            .unwrap_or(false);
        let has_after_sync = runtime
            .as_ref()
            .map(|r| r.has_function("onAfterSync"))
            .unwrap_or(false);

        if has_before_sync_batch {
            tracing::info!("onBeforeSyncBatch hook detected (batch mode)");
        } else if has_before_sync {
            tracing::info!("onBeforeSync hook detected (per-op mode)");
        }
        if has_after_sync_batch {
            tracing::info!("onAfterSyncBatch hook detected (batch mode)");
        } else if has_after_sync {
            tracing::info!("onAfterSync hook detected (per-op mode)");
        }

        if auth_token.is_some() {
            tracing::warn!(
                "Auth token is configured but the server does not enforce TLS. \
                 Tokens will be transmitted in plaintext unless a TLS-terminating \
                 reverse proxy (e.g. nginx, Caddy) is placed in front of this server."
            );
        }

        // Cap concurrent sync operations well below Tokio's 512-thread blocking pool.
        // Sized for I/O-bound DB queries: 4x CPUs is ample headroom, capped at 64.
        let max_concurrent = std::thread::available_parallelism()
            .map(|n| (n.get() * 4).min(64))
            .unwrap_or(32);
        let sync_permits = Arc::new(tokio::sync::Semaphore::new(max_concurrent));
        tracing::info!("Sync concurrency limit: {} permits", max_concurrent);

        Arc::new(Self {
            db,
            broadcast_tx,
            runtime,
            has_before_sync_batch,
            has_before_sync,
            has_after_sync_batch,
            has_after_sync,
            auth_token,
            sync_permits,
        })
    }

    pub fn subscribe(&self) -> broadcast::Receiver<(String, ServerMessage)> {
        self.broadcast_tx.subscribe()
    }

    pub fn handle_auth(
        &self,
        token: Option<&str>,
        _app_version: Option<&str>,
    ) -> Result<String, String> {
        // Check auth token if configured (constant-time comparison)
        if let Some(expected) = &self.auth_token {
            match token {
                Some(t) if t.as_bytes().ct_eq(expected.as_bytes()).into() => {}
                // Generic error prevents token enumeration (attacker can't
                // distinguish "no token" from "wrong token").
                Some(_) => return Err("Authentication failed".into()),
                None => return Err("Authentication failed".into()),
            }
        }

        let client_id = uuid::Uuid::new_v4().to_string();
        Ok(client_id)
    }

    pub fn handle_sync_pull(&self, collections: &[String]) -> Vec<ServerMessage> {
        let mut messages = Vec::new();

        for collection in collections {
            if !is_valid_collection_name(collection) {
                messages.push(ServerMessage::Error {
                    message: format!("Invalid collection name: {}", collection),
                });
                continue;
            }

            // Read from the pool — concurrent with other reads and writes.
            let conn = match self.db.read() {
                Ok(c) => c,
                Err(e) => {
                    messages.push(ServerMessage::Error {
                        message: format!("Read pool error: {}", e),
                    });
                    continue;
                }
            };
            let records = match pool::read_collection(&conn, collection) {
                Ok(r) => r,
                Err(e) => {
                    tracing::warn!("Failed to query collection '{}': {}", collection, e);
                    Vec::new()
                }
            };
            drop(conn);

            let json_records: Vec<serde_json::Value> = records
                .into_iter()
                .map(|r| {
                    serde_json::json!({
                        "id": r.id,
                        "collection": r.collection,
                        "data": r.data,
                        "createdAt": r.created_at,
                        "updatedAt": r.updated_at,
                    })
                })
                .collect();

            messages.push(ServerMessage::SyncState {
                collection: collection.clone(),
                records: json_records,
            });
        }

        messages
    }

    pub fn handle_sync_push(
        &self,
        ops: Vec<SyncOp>,
        client_id: &str,
    ) -> Vec<ServerMessage> {
        let mut responses = Vec::new();

        // Phase 1: Validate and run onBeforeSync hooks (no DB lock held).
        // This ensures hooks don't block the database and all validation
        // completes before we touch storage.

        // First pass: basic validation (no RPC needed)
        let server_now = chrono::Utc::now();
        let server_time = server_now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let mut basic_valid_ops = Vec::new();
        let mut seen_ids = std::collections::HashSet::new();
        for mut op in ops {
            // Reject duplicate op IDs within the same batch
            if !seen_ids.insert(op.id.clone()) {
                responses.push(ServerMessage::SyncReject {
                    op_id: op.id.clone(),
                    reason: "Duplicate op ID in batch".into(),
                });
                continue;
            }

            op.client_id = client_id.to_string();

            // Trust client timestamps for correct local-first / offline sync ordering.
            // Without this, a client that goes offline Monday, edits a record, then
            // reconnects Wednesday would have its stale edit "win" over newer online
            // edits because the server would stamp it with Wednesday's time.
            // Fall back to server time if missing or unparseable. Clamp far-future
            // timestamps to prevent clock-skew abuse in LWW conflict resolution.
            if op.timestamp.is_empty() {
                op.timestamp = server_time.clone();
            } else if let Ok(client_ts) = chrono::DateTime::parse_from_rfc3339(&op.timestamp) {
                let drift = client_ts.signed_duration_since(server_now).num_seconds();
                if drift > MAX_FUTURE_DRIFT_SECS {
                    tracing::warn!(
                        "Clamping future timestamp from client {} (drift: {}s)",
                        client_id, drift
                    );
                    op.timestamp = server_time.clone();
                }
                // Otherwise trust the client's timestamp — even past timestamps are
                // valid (e.g. edits made while offline).
            } else {
                // Unparseable timestamp — fall back to server time
                op.timestamp = server_time.clone();
            }

            if !VALID_OPERATIONS.contains(&op.operation.as_str()) {
                responses.push(ServerMessage::SyncReject {
                    op_id: op.id.clone(),
                    reason: format!("Unknown operation: {}", op.operation),
                });
                continue;
            }

            if !is_valid_collection_name(&op.collection) {
                responses.push(ServerMessage::SyncReject {
                    op_id: op.id.clone(),
                    reason: "Invalid collection name (must be 1-64 alphanumeric/dash/underscore chars)".into(),
                });
                continue;
            }

            if (op.operation == "update" || op.operation == "delete") && op.record_id.is_empty() {
                responses.push(ServerMessage::SyncReject {
                    op_id: op.id.clone(),
                    reason: format!("{} requires a recordId", op.operation),
                });
                continue;
            }

            basic_valid_ops.push(op);
        }

        // Second pass: run hooks — batch mode (1 RPC) preferred over per-op (N RPCs)
        let validated_ops = if self.has_before_sync_batch {
            self.call_before_sync_batch(basic_valid_ops, &mut responses)
        } else if self.has_before_sync {
            let mut accepted = Vec::new();
            for op in basic_valid_ops {
                match self.call_before_sync(&op) {
                    Ok(false) => {
                        tracing::info!("onBeforeSync rejected op {}", op.id);
                        responses.push(ServerMessage::SyncReject {
                            op_id: op.id.clone(),
                            reason: "Rejected by onBeforeSync hook".into(),
                        });
                    }
                    Err(e) => {
                        // Hook execution error — use SyncRetry so the client
                        // retains the op. A server redeploy may fix the script
                        // bug; SyncReject would permanently discard user data.
                        tracing::warn!("onBeforeSync hook error (retry): {}", e);
                        responses.push(ServerMessage::SyncRetry {
                            op_ids: vec![op.id.clone()],
                            reason: "Transient hook error — retry later".into(),
                        });
                    }
                    _ => accepted.push(op),
                }
            }
            accepted
        } else {
            basic_valid_ops
        };

        // Phase 2: Apply all validated ops atomically under a single DB lock.
        // This prevents interleaving from concurrent client batches.
        let mut accepted_ops = Vec::new();
        if !validated_ops.is_empty() {
            let mut db = self.db.write();

            for mut op in validated_ops {
                let result: Result<Option<String>, xdb::DbError> = match op.operation.as_str() {
                    "create" => {
                        let data = op.data.clone().unwrap_or(serde_json::json!({}));
                        db.create_record(&op.collection, data)
                            .map(|(record, _)| Some(record.id))
                    }
                    "update" => {
                        let data = op.data.clone().unwrap_or(serde_json::json!({}));
                        db.update_record(&op.record_id, data).map(|_| None)
                    }
                    "delete" => db.delete_record(&op.record_id).map(|_| None),
                    other => Err(xdb::DbError::NotFound(format!(
                        "Unknown operation: {}",
                        other
                    ))),
                };

                match result {
                    Ok(generated_id) => {
                        if let Some(id) = generated_id {
                            op.record_id = id;
                        }
                        accepted_ops.push(op);
                    }
                    Err(e) => {
                        tracing::warn!("sync_push DB error for op {}: {}", op.id, e);
                        responses.push(ServerMessage::SyncReject {
                            op_id: op.id.clone(),
                            reason: "Operation failed".into(),
                        });
                    }
                }
            }
            drop(db);
        }

        // Phase 3: Run onAfterSync hooks outside the DB lock.
        // Batch mode (1 RPC) preferred over per-op (N RPCs).
        if !accepted_ops.is_empty() {
            if self.has_after_sync_batch {
                if let Err(e) = self.call_after_sync_batch(&accepted_ops) {
                    tracing::warn!("onAfterSyncBatch error: {}", e);
                }
            } else if self.has_after_sync {
                for op in &accepted_ops {
                    if let Err(e) = self.call_after_sync(op) {
                        tracing::warn!("onAfterSync error: {}", e);
                    }
                }
            }
        }

        // Acknowledge accepted ops to the pushing client, then broadcast to others
        if !accepted_ops.is_empty() {
            let ack_ids: Vec<String> = accepted_ops.iter().map(|op| op.id.clone()).collect();
            responses.push(ServerMessage::SyncAck { op_ids: ack_ids });

            let delta = ServerMessage::SyncDelta {
                ops: accepted_ops,
            };
            let _ = self
                .broadcast_tx
                .send((client_id.to_string(), delta));
        }

        responses
    }

    /// Batch before-sync hook: passes all ops in a single RPC call.
    /// Returns an array of rejected op IDs, or an object `{ rejected: ["id1", ...] }`.
    /// Ops not in the rejected list are accepted.
    fn call_before_sync_batch(
        &self,
        ops: Vec<SyncOp>,
        responses: &mut Vec<ServerMessage>,
    ) -> Vec<SyncOp> {
        let rt = match self.runtime.as_ref() {
            Some(r) => r,
            None => return ops,
        };

        let ops_json: Vec<serde_json::Value> = ops.iter().map(Self::op_to_json).collect();
        let result = match rt.call("onBeforeSyncBatch", vec![serde_json::Value::Array(ops_json)]) {
            Ok(r) => r,
            Err(e) => {
                // Hook execution error — use SyncRetry so the client retains ops
                // in its queue. Script bugs (TypeError, etc.) may be fixed by a
                // server redeploy; permanent rejection (SyncReject) would
                // irreversibly discard user data changes.
                tracing::warn!("onBeforeSyncBatch hook error (retry): {}", e);
                responses.push(ServerMessage::SyncRetry {
                    op_ids: ops.iter().map(|op| op.id.clone()).collect(),
                    reason: "Transient hook error — retry later".into(),
                });
                return Vec::new();
            }
        };

        // Parse rejected IDs from the result.
        // Supported formats:
        //   - ["id1", "id2"]          (array of rejected IDs)
        //   - { rejected: ["id1"] }   (object with rejected field)
        //   - null / undefined        (accept all)
        let rejected_ids: std::collections::HashSet<String> = match &result {
            serde_json::Value::Array(arr) => {
                arr.iter().filter_map(|v| v.as_str().map(String::from)).collect()
            }
            serde_json::Value::Object(obj) => {
                obj.get("rejected")
                    .and_then(|v| v.as_array())
                    .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                    .unwrap_or_default()
            }
            _ => std::collections::HashSet::new(),
        };

        let mut accepted = Vec::new();
        for op in ops {
            if rejected_ids.contains(&op.id) {
                tracing::info!("onBeforeSyncBatch rejected op {}", op.id);
                responses.push(ServerMessage::SyncReject {
                    op_id: op.id.clone(),
                    reason: "Rejected by onBeforeSyncBatch hook".into(),
                });
            } else {
                accepted.push(op);
            }
        }
        accepted
    }

    fn call_before_sync(&self, op: &SyncOp) -> Result<bool, String> {
        let rt = self.runtime.as_ref().ok_or("No runtime")?;
        let op_json = Self::op_to_json(op);
        let result = rt.call("onBeforeSync", vec![op_json])?;
        // Only an explicit `false` rejects; null/undefined (forgotten return) allows
        match &result {
            serde_json::Value::Bool(false) => Ok(false),
            _ => Ok(true),
        }
    }

    /// Batch after-sync hook: passes all accepted ops in a single RPC call.
    fn call_after_sync_batch(&self, ops: &[SyncOp]) -> Result<(), String> {
        let rt = self.runtime.as_ref().ok_or("No runtime")?;
        let ops_json: Vec<serde_json::Value> = ops.iter().map(Self::op_to_json).collect();
        let _ = rt.call("onAfterSyncBatch", vec![serde_json::Value::Array(ops_json)]);
        Ok(())
    }

    fn call_after_sync(&self, op: &SyncOp) -> Result<(), String> {
        let rt = self.runtime.as_ref().ok_or("No runtime")?;
        let op_json = Self::op_to_json(op);
        let _ = rt.call("onAfterSync", vec![op_json]);
        Ok(())
    }

    fn op_to_json(op: &SyncOp) -> serde_json::Value {
        serde_json::json!({
            "id": op.id,
            "collection": op.collection,
            "operation": op.operation,
            "recordId": op.record_id,
            "data": op.data,
            "timestamp": op.timestamp,
            "clientId": op.client_id,
        })
    }
}
