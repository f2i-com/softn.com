use crate::pool::{self, ServerDb};
use crate::runtime::ServerRuntime;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::sync::Arc;
use subtle::ConstantTimeEq;
use tokio::sync::broadcast;

/// Short-lived, single-use WebSocket authentication ticket.
/// Clients exchange their long-lived auth token for a ticket via POST /sync/ticket,
/// then use the ticket in the WebSocket URL (?ticket=...) instead of the raw token.
/// This prevents the long-lived token from appearing in proxy/load balancer access logs.
struct AuthTicket {
    /// Pre-authenticated client ID
    client_id: String,
    expires_at: std::time::Instant,
}

/// How long a ticket remains valid after issuance.
const TICKET_LIFETIME: std::time::Duration = std::time::Duration::from_secs(30);
/// Maximum outstanding tickets before we start rejecting (prevents memory exhaustion).
const MAX_PENDING_TICKETS: usize = 1000;

/// Valid operations for sync ops.
const VALID_OPERATIONS: &[&str] = &["create", "update", "delete"];

/// Maximum byte size of an individual SyncOp's `data` field (512KB).
/// Without this, a client could submit 1000 ops each with a 500KB JSON object,
/// forcing the server to parse ~500MB of payload data in memory. The 4MB
/// MAX_WS_MESSAGE_SIZE provides outer bounds, but this inner limit prevents
/// memory amplification from serde_json::Value's overhead (5-10x input size).
const MAX_OP_DATA_BYTES: usize = 512 * 1024;

/// Maximum records per SyncState message to prevent oversized WebSocket frames
/// and server-side RAM spikes. With ~200-500 bytes per JSON record, 500 records
/// ≈ 100-250KB per message — well within the 4MB MAX_WS_MESSAGE_SIZE limit.
/// Multiple SyncState messages are sent for the same collection when there are
/// more records than this limit.
const SYNC_PULL_CHUNK_SIZE: usize = 500;

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
    db_path: PathBuf,
    max_storage_bytes: u64,
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
    /// Short-lived single-use tickets for WebSocket auth. Keyed by ticket ID.
    tickets: std::sync::Mutex<std::collections::HashMap<String, AuthTicket>>,
}

impl SyncManager {
    pub fn new(
        db: ServerDb,
        runtime: Option<Arc<ServerRuntime>>,
        auth_token: Option<String>,
        db_path: PathBuf,
        max_storage_bytes: u64,
        max_sync_permits: usize,
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

        let sync_permits = Arc::new(tokio::sync::Semaphore::new(max_sync_permits));
        tracing::info!("Sync concurrency limit: {} permits", max_sync_permits);
        if max_storage_bytes > 0 {
            tracing::info!("Storage quota: {}MB", max_storage_bytes / (1024 * 1024));
        }

        Arc::new(Self {
            db,
            db_path,
            max_storage_bytes,
            broadcast_tx,
            runtime,
            has_before_sync_batch,
            has_before_sync,
            has_after_sync_batch,
            has_after_sync,
            auth_token,
            sync_permits,
            tickets: std::sync::Mutex::new(std::collections::HashMap::new()),
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
        // Check auth token if configured.
        // Hash both tokens to SHA-256 before comparing so ct_eq always operates
        // on 32-byte inputs. Raw ct_eq on variable-length slices leaks the
        // expected token's length via timing (instant fail if lengths differ).
        if let Some(expected) = &self.auth_token {
            match token {
                Some(t) => {
                    let hash_t = Sha256::digest(t.as_bytes());
                    let hash_e = Sha256::digest(expected.as_bytes());
                    if !bool::from(hash_t.ct_eq(&hash_e)) {
                        // Generic error prevents token enumeration (attacker can't
                        // distinguish "no token" from "wrong token").
                        return Err("Authentication failed".into());
                    }
                }
                None => return Err("Authentication failed".into()),
            }
        }

        let client_id = uuid::Uuid::new_v4().to_string();
        Ok(client_id)
    }

    /// Issue a short-lived, single-use ticket for WebSocket authentication.
    /// The client calls POST /sync/ticket with their auth token in the
    /// Authorization header; the returned ticket replaces the raw token in the
    /// WebSocket URL, preventing long-lived tokens from appearing in proxy logs.
    pub fn issue_ticket(&self, token: Option<&str>, app_version: Option<&str>) -> Result<String, String> {
        // Validate the auth token first (reuse existing logic).
        let client_id = self.handle_auth(token, app_version)?;

        let mut tickets = self.tickets.lock().unwrap_or_else(|p| p.into_inner());

        // Evict expired tickets opportunistically to bound memory usage.
        let now = std::time::Instant::now();
        tickets.retain(|_, t| t.expires_at > now);

        if tickets.len() >= MAX_PENDING_TICKETS {
            return Err("Too many pending tickets — try again later".into());
        }

        let ticket_id = uuid::Uuid::new_v4().to_string();
        tickets.insert(ticket_id.clone(), AuthTicket {
            client_id,
            expires_at: now + TICKET_LIFETIME,
        });
        Ok(ticket_id)
    }

    /// Redeem a single-use ticket for WebSocket upgrade.
    /// Returns the pre-authenticated client_id if the ticket is valid and
    /// not expired. The ticket is consumed (removed) on success.
    pub fn redeem_ticket(&self, ticket_id: &str) -> Result<String, String> {
        let mut tickets = self.tickets.lock().unwrap_or_else(|p| p.into_inner());
        match tickets.remove(ticket_id) {
            Some(ticket) if ticket.expires_at > std::time::Instant::now() => {
                Ok(ticket.client_id)
            }
            Some(_) => Err("Ticket expired".into()),
            None => Err("Invalid ticket".into()),
        }
    }

    /// Returns true if auth token is configured (clients should use ticket flow).
    #[allow(dead_code)]
    pub fn has_auth(&self) -> bool {
        self.auth_token.is_some()
    }

    /// Spawn a background task that periodically prunes expired tickets.
    /// Without this, expired tickets are only evicted opportunistically when
    /// issue_ticket/redeem_ticket is called. If an attacker fills the ticket
    /// table to MAX_PENDING_TICKETS and no legitimate requests arrive, the
    /// server would be locked out until a request triggers eviction.
    pub fn spawn_ticket_cleanup(self: &Arc<Self>) {
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(15));
            loop {
                interval.tick().await;
                let Some(sync) = weak.upgrade() else { break };
                let mut tickets = sync.tickets.lock().unwrap_or_else(|p| p.into_inner());
                let before = tickets.len();
                let now = std::time::Instant::now();
                tickets.retain(|_, t| t.expires_at > now);
                let evicted = before - tickets.len();
                if evicted > 0 {
                    tracing::debug!("Evicted {} expired auth tickets", evicted);
                }
            }
        });
    }

    /// Pull collection state. If `last_sync` is provided, returns only records
    /// updated after that timestamp (incremental sync, including soft-deleted
    /// records so the client can remove them locally). Otherwise returns all
    /// non-deleted records (full sync for first-time connections).
    /// `last_id` forms a compound cursor with `last_sync` to handle timestamp
    /// ties — without it, bulk updates sharing a timestamp could be permanently
    /// missed by the `updated_at > ?` cursor.
    pub fn handle_sync_pull(
        &self,
        collections: &[String],
        last_sync: Option<&str>,
        last_id: Option<&str>,
    ) -> Vec<ServerMessage> {
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

            let records = if let Some(since) = last_sync {
                // Incremental: only records changed since last sync.
                // Includes deleted records so the client can remove them locally.
                match pool::read_collection_since(&conn, collection, since, last_id) {
                    Ok(r) => r,
                    Err(e) => {
                        tracing::warn!("Failed to query collection '{}' since '{}': {}", collection, since, e);
                        Vec::new()
                    }
                }
            } else {
                // Full sync: all non-deleted records
                match pool::read_collection(&conn, collection) {
                    Ok(r) => r,
                    Err(e) => {
                        tracing::warn!("Failed to query collection '{}': {}", collection, e);
                        Vec::new()
                    }
                }
            };
            drop(conn);

            let mut json_records: Vec<serde_json::Value> = records
                .into_iter()
                .map(|r| {
                    let mut record = serde_json::json!({
                        "id": r.id,
                        "collection": r.collection,
                        "data": r.data,
                        "createdAt": r.created_at,
                        "updatedAt": r.updated_at,
                    });
                    // Include deleted flag for incremental sync so clients
                    // can remove locally cached records deleted on other devices.
                    if r.deleted {
                        record["deleted"] = serde_json::json!(true);
                    }
                    record
                })
                .collect();

            // Send in chunks to prevent oversized WebSocket frames and RAM spikes.
            // Each chunk is its own SyncState message so neither the server nor the
            // client needs to buffer all records in a single JSON array.
            if json_records.is_empty() {
                // Send empty SyncState so the client knows the collection was queried
                messages.push(ServerMessage::SyncState {
                    collection: collection.clone(),
                    records: Vec::new(),
                });
            } else {
                while !json_records.is_empty() {
                    let at = json_records.len().min(SYNC_PULL_CHUNK_SIZE);
                    let rest = json_records.split_off(at);
                    messages.push(ServerMessage::SyncState {
                        collection: collection.clone(),
                        records: json_records,
                    });
                    json_records = rest;
                }
            }
        }

        messages
    }

    pub fn handle_sync_push(
        &self,
        ops: Vec<SyncOp>,
        client_id: &str,
    ) -> Vec<ServerMessage> {
        // Storage quota: reject all ops if the database file exceeds the
        // configured limit. Prevents clients from filling the disk via
        // infinite sync_push loops. Uses SyncRetry (not SyncReject) because
        // the condition is transient — an admin can increase the limit or
        // clean up data, and SyncReject would permanently discard user data.
        if self.max_storage_bytes > 0 {
            let db_size = std::fs::metadata(&self.db_path)
                .map(|m| m.len())
                .unwrap_or(0);
            if db_size >= self.max_storage_bytes {
                tracing::warn!(
                    "Storage quota exceeded ({:.1}MB >= {}MB limit) — rejecting sync_push",
                    db_size as f64 / (1024.0 * 1024.0),
                    self.max_storage_bytes / (1024 * 1024)
                );
                let op_ids: Vec<String> = ops.iter().map(|op| op.id.clone()).collect();
                return vec![ServerMessage::SyncRetry {
                    op_ids,
                    reason: format!(
                        "Storage quota exceeded ({}MB limit)",
                        self.max_storage_bytes / (1024 * 1024)
                    ),
                }];
            }
        }

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
            //
            // NOTE: This uses wall-clock LWW — two clients editing the same record
            // within ~1s can produce non-deterministic winners depending on clock
            // skew. A Hybrid Logical Clock (HLC) would provide causal ordering, but
            // requires client-side HLC support and a protocol change. For the current
            // use case (single-user multi-device sync) this is acceptable.
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

            // Reject oversized data payloads before any further processing.
            // Without this, 1000 ops × 500KB each = 500MB parsed into serde Values
            // (which use 5-10x RAM vs input), causing memory spikes.
            if let Some(ref data) = op.data {
                let data_size = data.to_string().len();
                if data_size > MAX_OP_DATA_BYTES {
                    responses.push(ServerMessage::SyncReject {
                        op_id: op.id.clone(),
                        reason: format!(
                            "Op data too large ({} bytes, max {})",
                            data_size, MAX_OP_DATA_BYTES
                        ),
                    });
                    continue;
                }
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

            // All operations require a client-supplied recordId. In a local-first
            // architecture the client must generate UUIDs — if the server generates
            // one on create, the sender never learns it (SyncDelta is not echoed back)
            // so subsequent updates/deletes would fail or desync.
            if op.record_id.is_empty() {
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
            for mut op in basic_valid_ops {
                match self.call_before_sync(&op) {
                    Ok((false, _)) => {
                        tracing::info!("onBeforeSync rejected op {}", op.id);
                        responses.push(ServerMessage::SyncReject {
                            op_id: op.id.clone(),
                            reason: "Rejected by onBeforeSync hook".into(),
                        });
                    }
                    Ok((true, Some(new_data))) => {
                        op.data = Some(new_data);
                        accepted.push(op);
                    }
                    Ok((true, None)) => accepted.push(op),
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
                }
            }
            accepted
        } else {
            basic_valid_ops
        };

        // Phase 2: Apply all validated ops atomically under a single DB lock.
        // This prevents interleaving from concurrent client batches.
        //
        // WRITE CONTENTION NOTE: SQLite in WAL mode permits only one active writer.
        // Heavy concurrent pushes bottleneck behind this Mutex. This is acceptable
        // for local-first sync (clients push rarely, in batches) but requires that
        // hooks (Phase 1) and post-processing (Phase 3) run OUTSIDE the lock so
        // the time spent holding db.write() is exclusively I/O. Never add RPC
        // calls, network requests, or expensive computation inside this block.
        let mut accepted_ops = Vec::new();
        if !validated_ops.is_empty() {
            // Collect op IDs before moving ops into the transaction closure,
            // so we can reference them in error paths after the move.
            let all_op_ids: Vec<String> = validated_ops.iter().map(|op| op.id.clone()).collect();
            let mut db = self.db.write();

            // Wrap the entire batch in a single SQLite transaction.
            // Without this, each operation auto-commits individually, causing
            // 1000 ops × 1 fsync each = massive I/O overhead and prolonged
            // writer mutex hold time. A single transaction flushes to disk once.
            let batch_result = db.with_transaction(|db| {
                let mut batch_accepted = Vec::new();
                let mut batch_rejected = Vec::new();

                for mut op in validated_ops {
                    let result: Result<Option<String>, xdb::DbError> = match op.operation.as_str() {
                        "create" => {
                            let data = op.data.clone().unwrap_or(serde_json::json!({}));
                            let now = &op.timestamp;
                            let record = xdb::Record {
                                id: op.record_id.clone(),
                                collection: op.collection.clone(),
                                data,
                                created_at: now.clone(),
                                updated_at: now.clone(),
                                deleted: false,
                            };
                            db.upsert_record(record).map(|_| None)
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
                            batch_accepted.push(op);
                        }
                        Err(e) => {
                            tracing::warn!("sync_push DB error for op {}: {}", op.id, e);
                            batch_rejected.push((op.id.clone(), format!("Operation failed: {}", e)));
                        }
                    }
                }

                Ok((batch_accepted, batch_rejected))
            });

            match batch_result {
                Ok((batch_accepted, batch_rejected)) => {
                    for (op_id, reason) in batch_rejected {
                        responses.push(ServerMessage::SyncReject {
                            op_id,
                            reason,
                        });
                    }
                    accepted_ops = batch_accepted;
                }
                Err(e) => {
                    tracing::error!("Batch transaction failed: {}", e);
                    // Transaction rolled back — retry all ops
                    responses.push(ServerMessage::SyncRetry {
                        op_ids: all_op_ids,
                        reason: "Database transaction failed — retry later".into(),
                    });
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
    /// Supported return formats:
    ///   - `["id1", "id2"]`                    — rejected IDs
    ///   - `{ rejected: ["id1"] }`             — rejected IDs
    ///   - `{ rejected: ["id1"], ops: [...] }` — rejected IDs + data mutations
    ///   - `{ ops: [...] }`                    — accept all, with data mutations
    ///   - `null` / `undefined`                — accept all
    ///
    /// When `ops` is present, each entry's `data` field overrides the original
    /// op's data before DB insertion, enabling hooks to sanitize, transform,
    /// or enrich data (e.g. trimming strings, adding server-computed fields).
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
                if let Some(arr) = obj.get("rejected").and_then(|v| v.as_array()) {
                    arr.iter().filter_map(|v| v.as_str().map(String::from)).collect()
                } else if obj.is_empty() || obj.contains_key("ops") {
                    // Empty object {} or { ops: [...] } — no rejections.
                    // If `ops` is present, data mutations are applied below.
                    std::collections::HashSet::new()
                } else {
                    // Object doesn't match expected schema (e.g. { reject: [...] }
                    // typo). This is a deterministic developer bug — retrying won't
                    // resolve it and would jam the client's sync queue indefinitely.
                    // Use SyncReject so the client can surface the error and move on.
                    tracing::warn!(
                        "onBeforeSyncBatch returned unrecognized object schema \
                         (expected {{ rejected: [...] }}) — permanently rejecting batch"
                    );
                    for op in &ops {
                        responses.push(ServerMessage::SyncReject {
                            op_id: op.id.clone(),
                            reason: "Hook returned unrecognized schema (expected { rejected: [...] })".into(),
                        });
                    }
                    return Vec::new();
                }
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

        // Apply data mutations from `ops` field if present (hook data sanitization).
        // Each returned op with an `id` + `data` overrides the original op's data
        // before DB insertion. Ops not in the returned array keep their original data.
        if let serde_json::Value::Object(obj) = &result {
            if let Some(returned_ops) = obj.get("ops").and_then(|v| v.as_array()) {
                let mutations: std::collections::HashMap<&str, &serde_json::Value> = returned_ops
                    .iter()
                    .filter_map(|v| {
                        let id = v.get("id")?.as_str()?;
                        let data = v.get("data")?;
                        Some((id, data))
                    })
                    .collect();

                if !mutations.is_empty() {
                    for op in &mut accepted {
                        if let Some(&new_data) = mutations.get(op.id.as_str()) {
                            op.data = Some(new_data.clone());
                        }
                    }
                    tracing::info!(
                        "onBeforeSyncBatch mutated data for {} op(s)",
                        mutations.len()
                    );
                }
            }
        }

        accepted
    }

    /// Per-op before-sync hook. Returns `(accepted, optional_mutated_data)`.
    /// If the hook returns an object with a `data` field, that data overrides
    /// the original op's data (enabling sanitization/enrichment).
    /// An explicit `false` rejects; null/undefined/true accepts without mutation.
    fn call_before_sync(&self, op: &SyncOp) -> Result<(bool, Option<serde_json::Value>), String> {
        let rt = self.runtime.as_ref().ok_or("No runtime")?;
        let op_json = Self::op_to_json(op);
        let result = rt.call("onBeforeSync", vec![op_json])?;
        match &result {
            serde_json::Value::Bool(false) => Ok((false, None)),
            serde_json::Value::Object(obj) if obj.contains_key("data") => {
                Ok((true, obj.get("data").cloned()))
            }
            _ => Ok((true, None)),
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
