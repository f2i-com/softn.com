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

/// Ticket requests one client address may make at once, and how fast that
/// allowance comes back. A client asks for one ticket per connection; the
/// burst absorbs a reconnect storm (a server restart, a flapping network, an
/// office behind one address) that a fixed 10-a-minute window turned into a
/// run of 429s, and the refill still holds a single address to 30 a minute.
const TICKET_BURST: f64 = 20.0;
const TICKET_REFILL_PER_SEC: f64 = 0.5;
/// Addresses the limiter remembers. A full bucket is the same as no entry,
/// so those are dropped first; past this, a new address waits.
const MAX_LIMITER_KEYS: usize = 10_000;

/// Default ceiling on open sync sockets per app (`config.server.maxSyncConnections`).
pub const DEFAULT_MAX_SYNC_CONNECTIONS: usize = 1024;
/// Default ceiling on one visitor's open sync sockets per app
/// (`config.server.maxSyncConnectionsPerVisitor`). The client opens one
/// socket per app per tab, so this is sixteen tabs of one app from one
/// address (or IPv6 /64): room for a household or a small office behind one
/// NAT, while one visitor can hold no more than 1/64 of the default 1024.
pub const DEFAULT_MAX_SYNC_CONNECTIONS_PER_VISITOR: usize = 16;

/// Why `/sync/ticket` said no.
#[derive(Debug, PartialEq, Eq)]
pub enum TicketError {
    /// Wrong or missing token: permanent until the credential changes.
    Unauthorized,
    /// This address asked too often; retry after this long.
    RateLimited(std::time::Duration),
    /// The host is holding too many unredeemed tickets: transient.
    Busy,
}

/// The key a client address is limited under. An IPv6 client usually holds a
/// whole /64 and can rotate through it freely, so one /64 is one client.
fn limiter_key(ip: std::net::IpAddr) -> std::net::IpAddr {
    match ip {
        std::net::IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => std::net::IpAddr::V4(v4),
            None => std::net::IpAddr::V6(std::net::Ipv6Addr::from(u128::from(v6) & !((1u128 << 64) - 1))),
        },
        v4 => v4,
    }
}

struct Bucket {
    tokens: f64,
    updated: std::time::Instant,
}

/// A token bucket per client address (an IPv6 /64 counting as one), per app:
/// one tenant's visitors do not spend another's allowance.
pub struct AddressLimiter {
    burst: f64,
    refill_per_sec: f64,
    buckets: std::sync::Mutex<std::collections::HashMap<std::net::IpAddr, Bucket>>,
}

impl AddressLimiter {
    pub fn new(burst: f64, refill_per_sec: f64) -> Self {
        Self { burst, refill_per_sec, buckets: std::sync::Mutex::new(std::collections::HashMap::new()) }
    }

    /// `per_minute` requests a minute, all of which may come at once (the
    /// PHP host's per-minute count, without its cliff at the minute's edge).
    pub fn per_minute(per_minute: u32) -> Self {
        Self::new(f64::from(per_minute), f64::from(per_minute) / 60.0)
    }

    fn refill(&self, bucket: &mut Bucket, now: std::time::Instant) {
        let elapsed = now.duration_since(bucket.updated).as_secs_f64();
        bucket.tokens = (bucket.tokens + elapsed * self.refill_per_sec).min(self.burst);
        bucket.updated = now;
    }

    /// Spend one request of `ip`'s allowance, or say how long to wait.
    pub fn check(&self, ip: std::net::IpAddr) -> Result<(), std::time::Duration> {
        let now = std::time::Instant::now();
        let key = limiter_key(ip);
        let mut buckets = self.buckets.lock().unwrap_or_else(|p| p.into_inner());
        if !buckets.contains_key(&key) && buckets.len() >= MAX_LIMITER_KEYS {
            buckets.retain(|_, b| {
                self.refill(b, now);
                b.tokens < self.burst
            });
            if buckets.len() >= MAX_LIMITER_KEYS {
                return Err(std::time::Duration::from_secs(60));
            }
        }
        let bucket = buckets.entry(key).or_insert(Bucket { tokens: self.burst, updated: now });
        self.refill(bucket, now);
        if bucket.tokens >= 1.0 {
            bucket.tokens -= 1.0;
            Ok(())
        } else {
            let wait = ((1.0 - bucket.tokens) / self.refill_per_sec).ceil().max(1.0);
            Err(std::time::Duration::from_secs(wait as u64))
        }
    }
}

/// Open sync sockets: in all, and per visitor (keyed as [`limiter_key`] keys
/// an address, so an IPv6 /64 is one visitor). The map holds at most
/// `max_connections` keys, since a key is removed when its count reaches 0.
#[derive(Default)]
struct OpenConnections {
    total: usize,
    per_visitor: std::collections::HashMap<std::net::IpAddr, usize>,
}

/// Why a sync socket was refused a place.
#[derive(Debug, PartialEq, Eq)]
pub enum ConnectionRefused {
    /// The app is at `maxSyncConnections`.
    Full,
    /// This visitor is at `maxSyncConnectionsPerVisitor`.
    VisitorFull,
}

/// An open sync socket's claim on the app's connection budget and on its
/// visitor's, both returned when the socket is dropped.
pub struct ConnectionSlot {
    open: Arc<std::sync::Mutex<OpenConnections>>,
    visitor: std::net::IpAddr,
}

impl Drop for ConnectionSlot {
    fn drop(&mut self) {
        let mut open = self.open.lock().unwrap_or_else(|p| p.into_inner());
        open.total = open.total.saturating_sub(1);
        if let std::collections::hash_map::Entry::Occupied(mut entry) = open.per_visitor.entry(self.visitor) {
            *entry.get_mut() -= 1;
            if *entry.get() == 0 {
                entry.remove();
            }
        }
    }
}

/// The sync limits an app's manifest may set under `config.server`.
#[derive(Clone, Debug)]
pub struct SyncSettings {
    /// Refuse pushes once the database file reaches this size; 0 disables.
    pub max_storage_bytes: u64,
    /// Concurrent blocking sync operations.
    pub sync_permits: usize,
    pub force_server_timestamps: bool,
    /// Open sync sockets at once.
    pub max_connections: usize,
    /// Open sync sockets at once from one visitor.
    pub max_connections_per_visitor: usize,
}

impl SyncSettings {
    /// Read from `config.server`. `multi_tenant` selects the lower defaults
    /// and caps one process hosting many apps uses.
    pub fn from_manifest(manifest: &crate::bundle::ServerManifest, multi_tenant: bool) -> Self {
        let server = manifest.config.as_ref().and_then(|c| c.get("server"));
        let number = |key: &str| server.and_then(|s| s.get(key)).and_then(|v| v.as_u64());
        let max_storage_bytes = number("maxStorageMB")
            .map(|mb| mb.min(10 * 1024) * 1024 * 1024) // cap at 10 GiB
            .unwrap_or(512 * 1024 * 1024);
        let sync_permits = if multi_tenant {
            number("syncPermits").map(|n| (n as usize).clamp(4, 64)).unwrap_or(16)
        } else {
            number("syncPermits").map(|n| (n as usize).clamp(4, 256)).unwrap_or_else(|| {
                std::thread::available_parallelism().map(|n| (n.get() * 4).min(64)).unwrap_or(32)
            })
        };
        let max_connections = number("maxSyncConnections")
            .map(|n| (n as usize).clamp(1, 65_536))
            .unwrap_or(DEFAULT_MAX_SYNC_CONNECTIONS);
        let max_connections_per_visitor = number("maxSyncConnectionsPerVisitor")
            .map(|n| n.min(65_536) as usize)
            .unwrap_or(DEFAULT_MAX_SYNC_CONNECTIONS_PER_VISITOR)
            .clamp(1, max_connections);
        let force_server_timestamps = server
            .and_then(|s| s.get("forceServerTimestamps"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        Self { max_storage_bytes, sync_permits, force_server_timestamps, max_connections, max_connections_per_visitor }
    }
}

/// Valid operations for sync ops.
const VALID_OPERATIONS: &[&str] = &["create", "update", "delete"];

/// Maximum byte size of an individual SyncOp's `data` field (512KB).
/// Without this, a client could submit 1000 ops each with a 500KB JSON object,
/// forcing the server to parse ~500MB of payload data in memory. The 4MB
/// MAX_WS_MESSAGE_SIZE provides outer bounds, but this inner limit prevents
/// memory amplification from serde_json::Value's overhead (5-10x input size).
const MAX_OP_DATA_BYTES: usize = 512 * 1024;

/// Maximum total bytes of all op data payloads in a single sync_push batch.
/// Bounds the total memory consumed during the DB write transaction to prevent
/// excessive SQLite WAL writer lock hold times. Individual ops are capped by
/// MAX_OP_DATA_BYTES; this caps the aggregate. Defense-in-depth alongside the
/// 4MB MAX_WS_MESSAGE_SIZE WebSocket frame limit.
const MAX_BATCH_DATA_BYTES: usize = 4 * 1024 * 1024;

/// Maximum records per SyncState message to prevent oversized WebSocket frames
/// and server-side RAM spikes. With ~200-500 bytes per JSON record, 500 records
/// ≈ 100-250KB per message — well within the 4MB MAX_WS_MESSAGE_SIZE limit.
/// Multiple SyncState messages are sent for the same collection when there are
/// more records than this limit.
const SYNC_PULL_CHUNK_SIZE: usize = 500;

/// Serialized bytes per SyncState message. The client discards any message
/// over 2 MB (`xdb-server-sync.ts` MAX_MESSAGE_SIZE), so a chunk bounded by
/// count alone — 500 records of up to 512 KB each — could be a 256 MB frame
/// the client drops, leaving that collection never synced. One record larger
/// than this still travels alone.
const SYNC_PULL_CHUNK_BYTES: usize = 1024 * 1024;

/// Distinct collections one sync_pull may name. Each is a query of up to
/// 10,000 rows held in memory; the names are deduplicated first, since one
/// 4 MB message could otherwise repeat a collection a hundred thousand times.
const MAX_PULL_COLLECTIONS: usize = 100;

/// Maximum allowed clock drift from clients into the future (in seconds).
/// Timestamps further ahead than this are clamped to server time to prevent
/// far-future timestamps from permanently winning in LWW conflict resolution.
/// Past timestamps are always trusted — they represent legitimate offline edits.
const MAX_FUTURE_DRIFT_SECS: i64 = 5 * 60; // 5 minutes

/// Whether an edit stamped `op_time` was made before the record's last
/// change, stamped `record_time`: the edit was overtaken, and does not apply.
/// Compared as times, not as text: a client writes `…Z` to the millisecond,
/// and a record written by xdb's own update carries the server's clock as
/// `+00:00` to the nanosecond. A time that does not parse decides nothing,
/// and the op applies as it did before edits were weighed.
fn overtaken(op_time: &str, record_time: &str) -> bool {
    match (
        chrono::DateTime::parse_from_rfc3339(op_time),
        chrono::DateTime::parse_from_rfc3339(record_time),
    ) {
        (Ok(op), Ok(record)) => op < record,
        _ => false,
    }
}

/// A record as it stands, as an op any client applies from a `sync_delta`:
/// an update carrying its whole data, or a delete. `answering` is the id of
/// the overtaken op it is sent for.
fn as_it_stands(record: xdb::Record, answering: String) -> SyncOp {
    SyncOp {
        id: answering,
        collection: record.collection,
        operation: if record.deleted { "delete" } else { "update" }.into(),
        record_id: record.id,
        data: if record.deleted { None } else { Some(record.data) },
        timestamp: record.updated_at,
        client_id: "server".into(),
    }
}

/// An update's fields laid over the record's, as xdb's `update_record`
/// merges them: one name at a time, the update's winning; anything but an
/// object on either side, and the update's data replaces the record's.
fn merged(existing: serde_json::Value, incoming: serde_json::Value) -> serde_json::Value {
    match (existing, incoming) {
        (serde_json::Value::Object(mut fields), serde_json::Value::Object(incoming)) => {
            for (name, value) in incoming {
                fields.insert(name, value);
            }
            serde_json::Value::Object(fields)
        }
        (_, incoming) => incoming,
    }
}

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
        /// Present on the last piece of a page that was full: where the next
        /// page of this collection starts. A client that knows it asks again
        /// with it as `cursor`; one that does not ignores it, and has what it
        /// always had.
        #[serde(skip_serializing_if = "Option::is_none")]
        more: Option<PullCursor>,
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

/// Which connections a message in the sync stream is for. Every connection
/// reads the one stream, in the order the store wrote it, and lets through
/// what is for it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Audience {
    /// Every connection but the one that pushed: its own ops, stored.
    Others(String),
    /// That one connection alone: what the store says of its push.
    Only(String),
}

impl Audience {
    pub fn reaches(&self, client_id: &str) -> bool {
        match self {
            Audience::Others(sender) => sender != client_id,
            Audience::Only(target) => target == client_id,
        }
    }
}

/// A pull under way: the collections still to read and, in the one being
/// read, the last record read and the message being filled. See
/// [`SyncManager::pull_step`].
pub struct Pull {
    collections: Vec<String>,
    /// The collection being read.
    next: usize,
    last_sync: Option<String>,
    last_id: Option<String>,
    cursor: Option<(String, String)>,
    page: i64,
    /// The (server_received_at, id) of the last record read of this collection.
    position: Option<(String, String)>,
    /// Records read of this collection.
    read: i64,
    chunk: Vec<serde_json::Value>,
    chunk_bytes: usize,
    /// Whether a message of this collection has been sent.
    sent: bool,
}

impl Pull {
    fn next_collection(&mut self) {
        self.next += 1;
        self.position = None;
        self.read = 0;
        self.chunk = Vec::new();
        self.chunk_bytes = 0;
        self.sent = false;
    }
}

/// A record as a pull sends it.
fn pull_record(r: pool::SyncRecord) -> serde_json::Value {
    let mut record = serde_json::json!({
        "id": r.id,
        "collection": r.collection,
        "data": r.data,
        "createdAt": r.created_at,
        "updatedAt": r.updated_at,
        // Server-assigned receipt timestamp for sync cursor pagination.
        // Clients should use this (not updatedAt) as the lastSync cursor
        // to avoid missing offline edits with past timestamps.
        "serverReceivedAt": r.server_received_at,
    });
    // Include deleted flag for incremental sync so clients
    // can remove locally cached records deleted on other devices.
    if r.deleted {
        record["deleted"] = serde_json::json!(true);
    }
    record
}

/// Where a full pull of one collection left off: the receipt time and id of
/// the last record sent, which is the order pages are read in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PullCursor {
    pub at: String,
    pub id: String,
}

/// How long the per-op before-hook may go on taking ops of one push. Each
/// call may itself run for MAX_CALL_WAIT, so the two together stay inside
/// the time the connection waits for the push (ws.rs HANDLER_TIMEOUT): past
/// that the client was told "timed out" and sent everything again, while the
/// first attempt went on to commit.
const BEFORE_HOOK_BUDGET: std::time::Duration = std::time::Duration::from_secs(5);

/// How long the per-op after-sync hooks of one push may go on being started,
/// as BEFORE_HOOK_BUDGET is for the before-hooks. The call under way when it
/// is spent is held to a call's own time (runtime.rs WALL_TIME_MS), as the
/// one batch hook is.
const AFTER_HOOK_BUDGET: std::time::Duration = std::time::Duration::from_secs(5);

pub struct SyncManager {
    db: ServerDb,
    db_path: PathBuf,
    /// Records in one page of a pull (pool::MAX_COLLECTION_ROWS).
    pull_page: std::sync::atomic::AtomicI64,
    /// BEFORE_HOOK_BUDGET, in milliseconds.
    before_hook_budget_ms: std::sync::atomic::AtomicU64,
    /// AFTER_HOOK_BUDGET, in milliseconds.
    after_hook_budget_ms: std::sync::atomic::AtomicU64,
    max_storage_bytes: u64,
    /// The sync stream: each item once per connection, which lets through
    /// what is for it ([`Audience`]). Shared, so a message meant for one
    /// connection is not copied for every other.
    broadcast_tx: broadcast::Sender<(Audience, Arc<ServerMessage>)>,
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
    /// When true, all sync ops use server time regardless of client timestamps.
    /// Prevents LWW manipulation where a malicious client sets timestamps to
    /// `ServerTime + 4m59s` to guarantee their edits win over concurrent edits.
    /// Trade-off: offline edits lose their original timestamps, so the LWW
    /// ordering may not reflect the actual sequence of user actions. Enable
    /// this for apps where data integrity matters more than offline ordering.
    force_server_timestamps: bool,
    /// Per-address allowance for `/sync/ticket`.
    ticket_limiter: AddressLimiter,
    /// Open sync sockets, and how many may be open at once, in all and
    /// per visitor.
    connections: Arc<std::sync::Mutex<OpenConnections>>,
    max_connections: usize,
    max_connections_per_visitor: usize,
    /// Pull messages read, for the tests that count them.
    #[cfg(test)]
    pub pull_messages: std::sync::atomic::AtomicUsize,
}

impl SyncManager {
    pub fn new(
        db: ServerDb,
        runtime: Option<Arc<ServerRuntime>>,
        auth_token: Option<String>,
        db_path: PathBuf,
        settings: SyncSettings,
    ) -> Arc<Self> {
        let SyncSettings { max_storage_bytes, sync_permits: max_sync_permits, force_server_timestamps, max_connections, max_connections_per_visitor } = settings;
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
        if force_server_timestamps {
            tracing::info!("Server timestamps enforced — client timestamps will be ignored (LWW hardening)");
        }

        Arc::new(Self {
            db,
            db_path,
            pull_page: std::sync::atomic::AtomicI64::new(pool::MAX_COLLECTION_ROWS),
            before_hook_budget_ms: std::sync::atomic::AtomicU64::new(BEFORE_HOOK_BUDGET.as_millis() as u64),
            after_hook_budget_ms: std::sync::atomic::AtomicU64::new(AFTER_HOOK_BUDGET.as_millis() as u64),
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
            force_server_timestamps,
            ticket_limiter: AddressLimiter::new(TICKET_BURST, TICKET_REFILL_PER_SEC),
            connections: Arc::new(std::sync::Mutex::new(OpenConnections::default())),
            max_connections,
            max_connections_per_visitor,
            #[cfg(test)]
            pull_messages: std::sync::atomic::AtomicUsize::new(0),
        })
    }

    /// Claim a place for one more sync socket from `client_ip`, or say why
    /// not: the app is at `maxSyncConnections`, or this visitor (an address,
    /// an IPv6 /64 counting as one) is at `maxSyncConnectionsPerVisitor`, so
    /// that one visitor cannot take every place. Each socket holds a
    /// broadcast receiver, a 512-slot outbound queue and two tasks; without a
    /// ceiling a token-less host could be walked into file-descriptor and
    /// memory exhaustion.
    pub fn try_open_connection(&self, client_ip: std::net::IpAddr) -> Result<ConnectionSlot, ConnectionRefused> {
        let visitor = limiter_key(client_ip);
        let mut open = self.connections.lock().unwrap_or_else(|p| p.into_inner());
        if open.total >= self.max_connections {
            return Err(ConnectionRefused::Full);
        }
        let mine = open.per_visitor.entry(visitor).or_insert(0);
        if *mine >= self.max_connections_per_visitor {
            return Err(ConnectionRefused::VisitorFull);
        }
        *mine += 1;
        open.total += 1;
        Ok(ConnectionSlot { open: self.connections.clone(), visitor })
    }

    /// The per-visitor ceiling, for the startup line.
    pub fn max_connections_per_visitor(&self) -> usize {
        self.max_connections_per_visitor
    }

    pub fn subscribe(&self) -> broadcast::Receiver<(Audience, Arc<ServerMessage>)> {
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
    ///
    /// Every request spends from `client_ip`'s allowance, a failed one too,
    /// so the endpoint is no faster a way to guess the token than any other.
    /// A full ticket table is `Busy`, not `Unauthorized`: the client gives up
    /// for good on a 401, and anyone able to fill the table would otherwise
    /// switch every client's sync off.
    pub fn issue_ticket(&self, token: Option<&str>, client_ip: std::net::IpAddr) -> Result<String, TicketError> {
        self.ticket_limiter.check(client_ip).map_err(TicketError::RateLimited)?;
        let client_id = self.handle_auth(token, None).map_err(|_| TicketError::Unauthorized)?;

        let mut tickets = self.tickets.lock().unwrap_or_else(|p| p.into_inner());

        // Evict expired tickets opportunistically to bound memory usage.
        let now = std::time::Instant::now();
        tickets.retain(|_, t| t.expires_at > now);

        if tickets.len() >= MAX_PENDING_TICKETS {
            return Err(TicketError::Busy);
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
    /// `cursor` continues a full pull of one collection from where a page
    /// that was full left off (the `more` of its last `sync_state`).
    ///
    /// The whole answer at once, as [`Self::pull_step`] gives it a message at
    /// a time; the connection takes it a message at a time.
    #[cfg(test)]
    pub fn handle_sync_pull(
        &self,
        collections: &[String],
        last_sync: Option<&str>,
        last_id: Option<&str>,
        cursor: Option<(&str, &str)>,
    ) -> Vec<ServerMessage> {
        let mut pull = match self.start_pull(collections, last_sync, last_id, cursor) {
            Ok(pull) => pull,
            Err(refusal) => return vec![refusal],
        };
        let mut messages = Vec::new();
        while let Some(message) = self.pull_step(&mut pull) {
            messages.push(message);
        }
        messages
    }

    /// A pull as it is asked for, read nothing yet; or its refusal.
    pub fn start_pull(
        &self,
        collections: &[String],
        last_sync: Option<&str>,
        last_id: Option<&str>,
        cursor: Option<(&str, &str)>,
    ) -> Result<Pull, ServerMessage> {
        let mut seen = std::collections::HashSet::new();
        let collections: Vec<String> = collections.iter().filter(|c| seen.insert(c.as_str())).cloned().collect();
        if collections.len() > MAX_PULL_COLLECTIONS {
            return Err(ServerMessage::Error {
                message: format!("Too many collections in one sync_pull ({}, max {})", collections.len(), MAX_PULL_COLLECTIONS),
            });
        }
        Ok(Pull {
            collections,
            next: 0,
            last_sync: last_sync.map(String::from),
            last_id: last_id.map(String::from),
            cursor: cursor.map(|(at, id)| (at.to_string(), id.to_string())),
            page: self.pull_page.load(std::sync::atomic::Ordering::Relaxed).max(1),
            position: None,
            read: 0,
            chunk: Vec::new(),
            chunk_bytes: 0,
            sent: false,
        })
    }

    /// The next message of a pull, or None when it has said everything.
    ///
    /// A pull used to read every collection it named, up to a page of each,
    /// into memory, and make all of its messages, before the first was sent:
    /// a hundred collections of ten thousand records, held while a slow
    /// client took its time over them. Now each step reads as far as one
    /// message, and the next goes on from the last record it read, as a
    /// cursor. The messages are the ones the whole answer was made of: by
    /// collection, chunked by count and by bytes under the client's limit,
    /// a collection with nothing in it still answered, the last message of a
    /// full page carrying where the next page begins.
    pub fn pull_step(&self, pull: &mut Pull) -> Option<ServerMessage> {
        let message = self.read_pull_message(pull);
        #[cfg(test)]
        if message.is_some() {
            self.pull_messages.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
        message
    }

    fn read_pull_message(&self, pull: &mut Pull) -> Option<ServerMessage> {
        loop {
            let collection = pull.collections.get(pull.next)?.clone();
            if !is_valid_collection_name(&collection) {
                pull.next_collection();
                return Some(ServerMessage::Error {
                    message: format!("Invalid collection name: {}", collection),
                });
            }

            // Read from the pool — concurrent with other reads and writes.
            let conn = match self.db.read() {
                Ok(c) => c,
                Err(e) => {
                    pull.next_collection();
                    return Some(ServerMessage::Error {
                        message: format!("Read pool error: {}", e),
                    });
                }
            };

            // Incremental, what changed since the client's point; full, the
            // records a page at a time. Either goes on from the last record
            // a step read.
            let full = pull.last_sync.is_none();
            let cap = if full { pull.page } else { pool::MAX_COLLECTION_ROWS };
            let position = pull.position.clone();
            let since = pull.last_sync.clone();
            let last_id = pull.last_id.clone();
            let cursor = pull.cursor.clone();
            let from = match (&position, &since) {
                (Some((at, id)), Some(_)) => pool::SyncFrom::Since { since: at, last_id: Some(id) },
                (None, Some(since)) => pool::SyncFrom::Since { since, last_id: last_id.as_deref() },
                (Some((at, id)), None) => pool::SyncFrom::Page { after: Some((at, id)) },
                (None, None) => pool::SyncFrom::Page { after: cursor.as_ref().map(|(at, id)| (at.as_str(), id.as_str())) },
            };
            let mut message = None;
            let remaining = cap - pull.read;
            if remaining > 0 {
                let read = pool::visit_sync_records(&conn, &collection, from, remaining, &mut |record| {
                    pull.read += 1;
                    pull.position = Some((record.server_received_at.clone(), record.id.clone()));
                    let record = pull_record(record);
                    let size = serde_json::to_vec(&record).map(|b| b.len() + 1).unwrap_or(0);
                    // Send in chunks to prevent oversized WebSocket frames and RAM spikes.
                    let full_chunk = !pull.chunk.is_empty()
                        && (pull.chunk.len() >= SYNC_PULL_CHUNK_SIZE || pull.chunk_bytes + size > SYNC_PULL_CHUNK_BYTES);
                    if full_chunk {
                        message = Some(ServerMessage::SyncState {
                            collection: collection.clone(),
                            records: std::mem::take(&mut pull.chunk),
                            more: None,
                        });
                        pull.chunk_bytes = 0;
                        pull.sent = true;
                    }
                    pull.chunk_bytes += size;
                    pull.chunk.push(record);
                    !full_chunk
                });
                if let Err(e) = read {
                    tracing::warn!("Failed to read collection '{}' for a sync pull: {}", collection, e);
                }
            }
            drop(conn);
            if message.is_some() {
                return message;
            }

            // The collection is read out: its last message. A full page of a
            // full pull may not be all of it, and the client is told where
            // to ask from; it used to be told nothing, and a collection past
            // the page was never wholly received by anyone.
            let more = match &pull.position {
                Some((at, id)) if full && pull.read >= pull.page => {
                    pool::warn_capped("A sync pull", &collection, pull.page);
                    Some(PullCursor { at: at.clone(), id: id.clone() })
                }
                _ => None,
            };
            let last = if !pull.chunk.is_empty() {
                Some(ServerMessage::SyncState { collection, records: std::mem::take(&mut pull.chunk), more })
            } else if !pull.sent {
                // Sent empty, so the client knows the collection was queried.
                Some(ServerMessage::SyncState { collection, records: Vec::new(), more: None })
            } else {
                None
            };
            pull.next_collection();
            if last.is_some() {
                return last;
            }
        }
    }

    /// Check, store, acknowledge and broadcast a push, then run its
    /// after-hooks. The connection does the two halves itself
    /// ([`Self::apply_sync_push`], [`Self::run_after_sync`]) so the answer is
    /// not kept waiting on the hooks.
    ///
    /// Returns what the pusher is told: the answer, then what the sync
    /// stream carried for it alone.
    #[cfg(test)]
    pub fn handle_sync_push(
        &self,
        ops: Vec<SyncOp>,
        client_id: &str,
    ) -> Vec<ServerMessage> {
        let mut stream = self.subscribe();
        let (mut responses, accepted) = self.apply_sync_push(ops, client_id);
        let mine = Audience::Only(client_id.to_string());
        loop {
            match stream.try_recv() {
                Ok((audience, message)) if audience == mine => responses.push((*message).clone()),
                Ok(_) | Err(broadcast::error::TryRecvError::Lagged(_)) => {}
                Err(_) => break,
            }
        }
        self.run_after_sync(&accepted);
        responses
    }

    /// Everything a push's answer depends on: the checks, the before-hooks,
    /// the write, and the broadcast to the other clients. Returns the answer
    /// and the ops that were stored, for [`Self::run_after_sync`].
    ///
    /// The after-hooks used to run before the acknowledgement was handed
    /// back. They may take as long as a handler may, so with the before-hook
    /// a push could outlast the time its connection waits for it: the client
    /// was told "Operation timed out" and pushed the same ops again, while
    /// the first attempt went on to commit, hook and broadcast them.
    pub fn apply_sync_push(&self, ops: Vec<SyncOp>, client_id: &str) -> (Vec<ServerMessage>, Vec<SyncOp>) {
        let mut accepted = Vec::new();
        let responses = self.store_sync_push(ops, client_id, &mut accepted);
        (responses, accepted)
    }

    /// The after-sync hooks for ops that are stored, acknowledged and
    /// broadcast. Outside the DB lock; batch mode (one call) before per-op.
    /// A push as a connection makes it: stored and answered under its sync
    /// permit, which is let go before the after-hooks run. The permit bounds
    /// the blocking work of storing; the hooks run in the script workers,
    /// within their own budget, and held it all the while: a hook that took
    /// a while on a large push kept the next push waiting, and as many slow
    /// pushes as there are permits answered every client "server busy".
    pub fn push_and_hook(
        &self,
        ops: Vec<SyncOp>,
        client_id: &str,
        permit: tokio::sync::OwnedSemaphorePermit,
        answer: impl FnOnce(Vec<ServerMessage>),
    ) {
        let (responses, accepted) = self.apply_sync_push(ops, client_id);
        drop(permit);
        answer(responses);
        self.run_after_sync(&accepted);
    }

    pub fn run_after_sync(&self, accepted_ops: &[SyncOp]) {
        if accepted_ops.is_empty() {
            return;
        }
        if self.has_after_sync_batch {
            if let Err(e) = self.call_after_sync_batch(accepted_ops) {
                tracing::warn!("onAfterSyncBatch error: {}", e);
            }
        } else if self.has_after_sync {
            for error in self.call_after_sync_each(accepted_ops) {
                tracing::warn!("onAfterSync error: {}", error);
            }
        }
    }

    fn store_sync_push(
        &self,
        ops: Vec<SyncOp>,
        client_id: &str,
        stored: &mut Vec<SyncOp>,
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
        let mut batch_data_bytes: usize = 0;
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
            if self.force_server_timestamps || op.timestamp.is_empty() {
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
                batch_data_bytes += data_size;
                if batch_data_bytes > MAX_BATCH_DATA_BYTES {
                    // Reject remaining ops to bound DB write lock hold time.
                    // Already-accepted ops proceed normally; the client retries
                    // the rest in a subsequent batch.
                    responses.push(ServerMessage::SyncRetry {
                        op_ids: vec![op.id.clone()],
                        reason: format!(
                            "Batch data limit exceeded ({}MB max) — send fewer ops per batch",
                            MAX_BATCH_DATA_BYTES / (1024 * 1024)
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
            // One call an op: a few hundred ops against a slow hook could
            // outlast the connection's wait for the push. Past the budget the
            // rest are not checked; the client keeps them and sends them
            // again. The first op is always checked, so a push makes progress.
            let started = std::time::Instant::now();
            let budget = std::time::Duration::from_millis(self.before_hook_budget_ms.load(std::sync::atomic::Ordering::Relaxed));
            // One client's push is one request, however many ops it carries:
            // its hooks run in order on one worker (`ServerRuntime::call_each`).
            let mut answers = self.call_before_sync_each(&basic_valid_ops, started + budget).into_iter();
            let mut checked = 0usize;
            let mut unchecked = Vec::new();
            for mut op in basic_valid_ops {
                let Some(answer) = answers.next() else {
                    unchecked.push(op.id.clone());
                    continue;
                };
                checked += 1;
                match answer.and_then(|result| Self::read_before_sync(&op, result)) {
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
            if !unchecked.is_empty() {
                tracing::warn!("onBeforeSync checked {} op(s) of a push in {}ms; {} left for the client to send again", checked, started.elapsed().as_millis(), unchecked.len());
                responses.push(ServerMessage::SyncRetry {
                    op_ids: unchecked,
                    reason: "The server ran out of time checking this push — send the rest again".into(),
                });
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
        // The acknowledgement of overtaken ops and the records they were
        // overtaken on, for the pusher alone.
        let mut to_pusher: Option<(Vec<String>, Vec<SyncOp>)> = None;
        if !validated_ops.is_empty() {
            // Collect op IDs before moving ops into the transaction closure,
            // so we can reference them in error paths after the move.
            let all_op_ids: Vec<String> = validated_ops.iter().map(|op| op.id.clone()).collect();
            let mut db = self.db.write();

            // Wrap the entire batch in a single SQLite transaction.
            // Without this, each operation auto-commits individually, causing
            // 1000 ops × 1 fsync each = massive I/O overhead and prolonged
            // writer mutex hold time. A single transaction flushes to disk once.
            //
            // And as one xdb batch: each record write used to save its
            // collection's whole CRDT document, which is as large as the
            // collection, so a push of N ops into a collection of size C
            // encoded and wrote C bytes N times, all of it under this lock.
            // The document is now saved once per collection, in the same
            // transaction as the rows. An op that fails is still refused
            // alone: xdb keeps the others in the document it saves.
            let batch_result = db.with_batch(|db| {
                let mut batch_accepted = Vec::new();
                let mut batch_rejected = Vec::new();
                let mut batch_replayed = Vec::new();
                // The records overtaken edits were for, and the deleted ones
                // updates were refused for, each with the first such op (or
                // an overtaken delete of it): their pusher is sent them as
                // they stand.
                let mut batch_overtaken: Vec<(String, String)> = Vec::new();

                for mut op in validated_ops {
                    // xdb finds a record by id alone. An op names a collection,
                    // and that is what a before-sync hook authorized; an id that
                    // lives in another collection would otherwise let an op
                    // "in notes" update, delete or (by INSERT OR REPLACE)
                    // overwrite a record the hook never saw.
                    let existing = match db.get_record(&op.record_id) {
                        Ok(existing) if existing.collection != op.collection => {
                            batch_rejected.push((op.id.clone(), "recordId belongs to another collection".to_string()));
                            continue;
                        }
                        Ok(existing) => Some(existing),
                        Err(xdb::DbError::NotFound(_)) => None,
                        Err(e) => return Err(e),
                    };
                    let exists = existing.is_some();
                    // A create for an id that is already here is a create
                    // that already happened: the client sends every op again
                    // until it is acknowledged, and an acknowledgement can be
                    // lost after the commit. Applying it again is INSERT OR
                    // REPLACE with the record's first payload, which wrote
                    // over whatever another client had changed since and
                    // brought a deleted record back. It is acknowledged, so
                    // the client stops sending it, and nothing is written,
                    // broadcast or handed to the after-sync hooks.
                    if exists && op.operation == "create" {
                        batch_replayed.push(op.id.clone());
                        continue;
                    }
                    // Last writer wins, by the time each edit was made: the
                    // op's timestamp, as clamped above. An update or a delete
                    // made before the record last changed was overtaken by
                    // that change: an edit made offline and pushed after a
                    // newer one, or one sent again after its acknowledgement
                    // was lost and another client's edit landed. Applied, it
                    // undid the newer edit. It is acknowledged, so the client
                    // stops sending it, and nothing is written, broadcast or
                    // handed to the after-sync hooks. An update for a deleted
                    // record is refused below, as it always was, whenever it
                    // was made; its pusher is sent the record as well, or it
                    // would go on showing one that is deleted everywhere else
                    // (a full pull sends no deleted records).
                    if let Some(record) = &existing {
                        let weighed = op.operation == "delete" || (op.operation == "update" && !record.deleted);
                        let was_overtaken = weighed && overtaken(&op.timestamp, &record.updated_at);
                        let deleted_already = op.operation == "update" && record.deleted;
                        if was_overtaken || deleted_already {
                            match batch_overtaken.iter_mut().find(|(id, _)| *id == record.id) {
                                None => batch_overtaken.push((record.id.clone(), op.id.clone())),
                                // An overtaken delete is the op the record
                                // answers: its pusher hides the record until
                                // that delete is answered, and knows the
                                // answer by its id.
                                Some(entry) if op.operation == "delete" => entry.1 = op.id.clone(),
                                Some(_) => {}
                            }
                        }
                        if was_overtaken {
                            batch_replayed.push(op.id.clone());
                            continue;
                        }
                    }
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
                        // The record keeps the time its edit was made, as a
                        // create always has: that is what the next edit is
                        // weighed against. xdb's update_record and
                        // delete_record stamp the server's clock instead, so
                        // the row is written whole here, with update_record's
                        // merge, and its creation time kept.
                        "update" => match existing {
                            Some(record) if !record.deleted => {
                                // A record is held to what one op may carry, as
                                // the op was: merged updates of new keys grew
                                // one without end. One already past it, from
                                // before, may still be made smaller.
                                let before = record.data.to_string().len();
                                let data = merged(record.data, op.data.clone().unwrap_or(serde_json::json!({})));
                                let after = data.to_string().len();
                                if after > MAX_OP_DATA_BYTES && after > before {
                                    batch_rejected.push((op.id.clone(), format!(
                                        "Record too large after this update ({} bytes, max {})",
                                        after, MAX_OP_DATA_BYTES
                                    )));
                                    continue;
                                }
                                db.upsert_record(xdb::Record { data, updated_at: op.timestamp.clone(), ..record }).map(|_| None)
                            }
                            _ => Err(xdb::DbError::NotFound(op.record_id.clone())),
                        },
                        "delete" => match existing {
                            Some(record) => db.upsert_record(xdb::Record { updated_at: op.timestamp.clone(), deleted: true, ..record }).map(|_| None),
                            None => Err(xdb::DbError::NotFound(op.record_id.clone())),
                        },
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

                // Read once the whole push is in, so a later op of the same
                // push for the same record is part of what is sent.
                let mut batch_current = Vec::new();
                for (id, answering) in batch_overtaken {
                    if let Ok(record) = db.get_record(&id) {
                        batch_current.push(as_it_stands(record, answering));
                    }
                }

                Ok((batch_accepted, batch_rejected, batch_replayed, batch_current))
            });

            match batch_result {
                Ok((batch_accepted, batch_rejected, batch_replayed, batch_current)) => {
                    for (op_id, reason) in batch_rejected {
                        responses.push(ServerMessage::SyncReject {
                            op_id,
                            reason,
                        });
                    }
                    if !batch_replayed.is_empty() {
                        tracing::debug!("sync_push: {} op(s) already applied or overtaken by a newer edit, acknowledged without writing", batch_replayed.len());
                    }
                    if batch_current.is_empty() {
                        if !batch_replayed.is_empty() {
                            responses.push(ServerMessage::SyncAck { op_ids: batch_replayed });
                        }
                    } else {
                        // Sent below, with the stream of other clients' edits.
                        to_pusher = Some((batch_replayed, batch_current));
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
            // The pusher had applied its overtaken edits to its own copy,
            // and would go on showing them: it is sent each record as it
            // stands, a delta like any other, and only it. Sent here, in the
            // stream of other clients' edits and while the writer lock is
            // held, it reaches the pusher in the order the record was read
            // among those edits. It went with the push's answer, on the
            // connection's own queue, which the connection interleaves with
            // that stream as the two are ready: an edit stored after the
            // read could arrive first, and the older record then undid it on
            // the pusher's screen. The acknowledgement of the ops it answers
            // goes just before it, in the same stream, as it went before it
            // in the answer: a client keeps a record it deleted hidden only
            // while that delete is unanswered, so a skipped delete's record
            // comes back on the device that pushed it
            // (`XDBServerSync.unansweredDeletes` in @softn/core).
            if let Some((replayed, current)) = to_pusher {
                if !replayed.is_empty() {
                    let _ = self.broadcast_tx.send((Audience::Only(client_id.to_string()), Arc::new(ServerMessage::SyncAck { op_ids: replayed })));
                }
                let _ = self.broadcast_tx.send((Audience::Only(client_id.to_string()), Arc::new(ServerMessage::SyncDelta { ops: current })));
            }
            // Broadcast to the other clients while the writer lock is still
            // held, so that pushes are sent on in the order they were stored.
            // It was done once the lock had been let go, after the ops were
            // copied: a push stored second could be sent first, and a client,
            // which applies what it is sent as it comes, was left with the
            // older of two edits to one record. Sending waits for nobody.
            if !accepted_ops.is_empty() {
                let delta = ServerMessage::SyncDelta {
                    ops: accepted_ops.clone(),
                };
                let _ = self
                    .broadcast_tx
                    .send((Audience::Others(client_id.to_string()), Arc::new(delta)));
            }
            drop(db);
        }

        // Acknowledge accepted ops to the pushing client. Phase 3, the
        // after-hooks, is the caller's to run once this answer is on its way
        // (run_after_sync).
        if !accepted_ops.is_empty() {
            let ack_ids: Vec<String> = accepted_ops.iter().map(|op| op.id.clone()).collect();
            responses.push(ServerMessage::SyncAck { op_ids: ack_ids });
            *stored = accepted_ops;
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
                        // A hook that falls off the end of a branch returns
                        // `undefined`, which crosses as null. Applying that
                        // replaces the record's whole payload with JSON null and
                        // broadcasts the wipe to every peer — never what a
                        // sanitising hook meant. Keep the original data instead.
                        if data.is_null() {
                            tracing::warn!(
                                op = id,
                                "onBeforeSyncBatch returned no data for an op — keeping the \
                                 original payload rather than nulling the record"
                            );
                            return None;
                        }
                        Some((id, data))
                    })
                    .collect();

                if !mutations.is_empty() {
                    let mut refused = std::collections::HashSet::new();
                    for op in &mut accepted {
                        if let Some(&new_data) = mutations.get(op.id.as_str()) {
                            if op.data.as_ref() == Some(new_data) {
                                continue;
                            }
                            // Held to what a client may send (check_hook_data).
                            if let Err(why) = Self::check_hook_data(new_data) {
                                tracing::warn!(op = %op.id, "onBeforeSyncBatch: {why} — the op is not applied");
                                responses.push(ServerMessage::SyncRetry {
                                    op_ids: vec![op.id.clone()],
                                    reason: "Transient hook error — retry later".into(),
                                });
                                refused.insert(op.id.clone());
                                continue;
                            }
                            op.data = Some(new_data.clone());
                        }
                    }
                    accepted.retain(|op| !refused.contains(&op.id));
                    tracing::info!(
                        "onBeforeSyncBatch mutated data for {} op(s)",
                        mutations.len()
                    );
                }
            }
        }

        accepted
    }

    /// The per-op before-sync hook for each op of a push, in order on one
    /// worker. One answer for each op the hook was run for: fewer than the ops
    /// means it ran out of time and the rest were not checked. When the hook
    /// could not be run at all, every op has the reason for its answer.
    fn call_before_sync_each(&self, ops: &[SyncOp], deadline: std::time::Instant) -> Vec<Result<serde_json::Value, String>> {
        let asked = match self.runtime.as_ref() {
            Some(rt) => rt.call_each("onBeforeSync", ops.iter().map(Self::op_to_json).collect(), Some(deadline)),
            None => Err("No runtime".into()),
        };
        asked.unwrap_or_else(|error| ops.iter().map(|_| Err(error.clone())).collect())
    }

    /// What a per-op before-hook's answer says of its op: `(accepted, optional_mutated_data)`.
    /// If the hook returns an object with a `data` field, that data overrides
    /// the original op's data (enabling sanitization/enrichment).
    /// An explicit `false` rejects; null/undefined/true accepts without mutation.
    fn read_before_sync(op: &SyncOp, result: serde_json::Value) -> Result<(bool, Option<serde_json::Value>), String> {
        match &result {
            serde_json::Value::Bool(false) => Ok((false, None)),
            // `{ data: clean(op.data) }` where `clean` falls off the end of a
            // branch: undefined crosses as null, and applying that replaced
            // the record's whole payload with JSON null and broadcast the
            // wipe. The batch hook already keeps the original for this.
            serde_json::Value::Object(obj) if obj.get("data").is_some_and(|data| data.is_null()) => {
                tracing::warn!(
                    op = %op.id,
                    "onBeforeSync returned no data for an op — keeping the original payload \
                     rather than nulling the record"
                );
                Ok((true, None))
            }
            serde_json::Value::Object(obj) if obj.contains_key("data") => {
                let data = obj.get("data").cloned().unwrap_or_default();
                // Handed back as it came: nothing to check, nothing changed.
                if op.data.as_ref() == Some(&data) {
                    return Ok((true, None));
                }
                Self::check_hook_data(&data)?;
                Ok((true, Some(data)))
            }
            _ => Ok((true, None)),
        }
    }

    /// Whether data a before-hook handed back may replace an op's payload.
    ///
    /// The size of what a client sends is checked before the hooks run, so a
    /// hook could hand back more than any client may send. And anything but
    /// an object replaces the whole record with that value (xdb): a hook that
    /// returned a string or a number by mistake wiped the record, and the
    /// wipe was broadcast. Such an op is not applied; the client keeps it and
    /// is told to retry, as it is when the hook throws. Writing what the
    /// client sent instead would let through exactly what a sanitising hook
    /// was there to change.
    fn check_hook_data(data: &serde_json::Value) -> Result<(), String> {
        if !data.is_object() {
            return Err("a before-sync hook returned data that is not an object".into());
        }
        let size = data.to_string().len();
        if size > MAX_OP_DATA_BYTES {
            return Err(format!("a before-sync hook returned {size} bytes of data for one op (max {MAX_OP_DATA_BYTES})"));
        }
        Ok(())
    }

    /// Batch after-sync hook: passes all accepted ops in a single RPC call.
    fn call_after_sync_batch(&self, ops: &[SyncOp]) -> Result<(), String> {
        let rt = self.runtime.as_ref().ok_or("No runtime")?;
        let ops_json: Vec<serde_json::Value> = ops.iter().map(Self::op_to_json).collect();
        // The ops are committed either way; what the hook threw is for the
        // caller to log. Discarding it here left that log line unreachable,
        // and an after-sync hook that failed on every push did so in silence.
        rt.call("onAfterSyncBatch", vec![serde_json::Value::Array(ops_json)]).map(|_| ())
    }

    /// The per-op after-sync hook for each op, in order on one worker, and
    /// what each failure said.
    fn call_after_sync_each(&self, ops: &[SyncOp]) -> Vec<String> {
        let Some(rt) = self.runtime.as_ref() else {
            return vec!["No runtime".into()];
        };
        // Within the budget: a push of a thousand ops ran a thousand hooks,
        // however long each took. The ops are stored either way; the hooks
        // not started are said in the log.
        let budget = std::time::Duration::from_millis(self.after_hook_budget_ms.load(std::sync::atomic::Ordering::Relaxed));
        let started = std::time::Instant::now();
        match rt.call_each("onAfterSync", ops.iter().map(Self::op_to_json).collect(), Some(started + budget)) {
            Ok(answers) => {
                if answers.len() < ops.len() {
                    tracing::warn!(
                        "onAfterSync ran for {} of the {} op(s) of a push in {}ms; the rest were not run",
                        answers.len(), ops.len(), started.elapsed().as_millis()
                    );
                }
                answers.into_iter().filter_map(Result::err).collect()
            }
            Err(error) => vec![error],
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn manager(script: Option<&str>) -> (Arc<SyncManager>, ServerDb) {
        manager_with(script, 1)
    }

    fn manager_with(script: Option<&str>, workers: usize) -> (Arc<SyncManager>, ServerDb) {
        let dir = crate::test_dirs::temp_path("softn-sync", "");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("xdb.sqlite");
        let shared = xdb::create_shared_db(path.clone()).unwrap();
        let db = ServerDb::new(shared, &path, 2).unwrap();
        let runtime = script.map(|source| {
            let rt = ServerRuntime::new(|| crate::host::BridgeSet {
                db: None, http: None, fs: None, env: None, sql: None, crypto: None,
                allow_time: false, development: true, allow_photos: false, app_config: serde_json::Value::Null,
            }, Some(workers)).unwrap();
            rt.init(source.to_string()).unwrap();
            rt
        });
        let settings = SyncSettings { max_storage_bytes: 0, sync_permits: 4, force_server_timestamps: false, max_connections: 2, max_connections_per_visitor: 2 };
        (SyncManager::new(db.clone(), runtime, None, path, settings), db)
    }

    #[test]
    fn tickets_are_limited_per_address_with_a_burst_and_a_retry_hint() {
        let limiter = AddressLimiter::new(TICKET_BURST, TICKET_REFILL_PER_SEC);
        let a: std::net::IpAddr = "203.0.113.7".parse().unwrap();
        for _ in 0..TICKET_BURST as usize {
            assert!(limiter.check(a).is_ok());
        }
        let wait = limiter.check(a).unwrap_err();
        assert!(wait >= std::time::Duration::from_secs(1) && wait <= std::time::Duration::from_secs(2), "{wait:?}");
        assert!(limiter.check("203.0.113.8".parse().unwrap()).is_ok(), "another address has its own allowance");
        // One IPv6 /64 is one client; the next /64 is another.
        let v6 = AddressLimiter::new(TICKET_BURST, TICKET_REFILL_PER_SEC);
        for i in 0..TICKET_BURST as usize {
            assert!(v6.check(format!("2001:db8:0:1::{:x}", i + 1).parse().unwrap()).is_ok());
        }
        assert!(v6.check("2001:db8:0:1:ffff::1".parse().unwrap()).is_err());
        assert!(v6.check("2001:db8:0:2::1".parse().unwrap()).is_ok());
        assert_eq!(limiter_key("::ffff:10.0.0.1".parse().unwrap()), "10.0.0.1".parse::<std::net::IpAddr>().unwrap());
    }

    #[test]
    fn a_full_ticket_table_is_busy_and_a_wrong_token_unauthorized() {
        let (sync, _) = manager(None);
        let mut ip = 0u32;
        for _ in 0..MAX_PENDING_TICKETS {
            ip += 1;
            sync.issue_ticket(None, std::net::IpAddr::V4(ip.into())).unwrap();
        }
        assert_eq!(sync.issue_ticket(None, "198.51.100.1".parse().unwrap()), Err(TicketError::Busy));
        let dir = crate::test_dirs::temp_path("softn-sync", "");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("xdb.sqlite");
        let db = ServerDb::new(xdb::create_shared_db(path.clone()).unwrap(), &path, 2).unwrap();
        let settings = SyncSettings { max_storage_bytes: 0, sync_permits: 4, force_server_timestamps: false, max_connections: 2, max_connections_per_visitor: 2 };
        let guarded = SyncManager::new(db, None, Some("s3cret".into()), path, settings);
        let ip: std::net::IpAddr = "198.51.100.2".parse().unwrap();
        assert_eq!(guarded.issue_ticket(Some("wrong"), ip), Err(TicketError::Unauthorized));
        assert!(guarded.issue_ticket(Some("s3cret"), ip).is_ok());
    }

    #[test]
    fn connection_slots_are_bounded_and_returned() {
        let (sync, _) = manager(None);
        let a: std::net::IpAddr = "203.0.113.7".parse().unwrap();
        let b: std::net::IpAddr = "203.0.113.8".parse().unwrap();
        let first = sync.try_open_connection(a).unwrap();
        let _second = sync.try_open_connection(b).unwrap();
        assert_eq!(sync.try_open_connection("203.0.113.9".parse().unwrap()).err(), Some(ConnectionRefused::Full));
        drop(first);
        assert!(sync.try_open_connection(a).is_ok());
    }

    /// One visitor cannot take every place: an address, or an IPv6 /64, is
    /// held to `maxSyncConnectionsPerVisitor`, and its places come back.
    #[test]
    fn one_visitor_cannot_take_every_connection() {
        let dir = crate::test_dirs::temp_path("softn-sync", "");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("xdb.sqlite");
        let db = ServerDb::new(xdb::create_shared_db(path.clone()).unwrap(), &path, 2).unwrap();
        let settings = SyncSettings { max_storage_bytes: 0, sync_permits: 4, force_server_timestamps: false, max_connections: 10, max_connections_per_visitor: 2 };
        let sync = SyncManager::new(db, None, None, path, settings);
        let ip = |s: &str| s.parse::<std::net::IpAddr>().unwrap();
        let first = sync.try_open_connection(ip("2001:db8:0:1::1")).unwrap();
        let _second = sync.try_open_connection(ip("2001:db8:0:1::2")).unwrap();
        // Another address in the same /64 is the same visitor.
        assert_eq!(sync.try_open_connection(ip("2001:db8:0:1:ffff::9")).err(), Some(ConnectionRefused::VisitorFull));
        // The next /64, and an IPv4 visitor, are others.
        assert!(sync.try_open_connection(ip("2001:db8:0:2::1")).is_ok());
        assert!(sync.try_open_connection(ip("198.51.100.1")).is_ok());
        drop(first);
        assert!(sync.try_open_connection(ip("2001:db8:0:1::3")).is_ok());
    }

    #[test]
    fn the_per_visitor_cap_defaults_small_and_never_exceeds_the_total() {
        let settings = |server: serde_json::Value| {
            let manifest: crate::bundle::ServerManifest = serde_json::from_value(serde_json::json!({
                "name": "x", "version": "1", "config": {"server": server}})).unwrap();
            SyncSettings::from_manifest(&manifest, false)
        };
        assert_eq!(settings(serde_json::json!({})).max_connections_per_visitor, DEFAULT_MAX_SYNC_CONNECTIONS_PER_VISITOR);
        assert_eq!(settings(serde_json::json!({"maxSyncConnectionsPerVisitor": 3})).max_connections_per_visitor, 3);
        assert_eq!(settings(serde_json::json!({"maxSyncConnectionsPerVisitor": 0})).max_connections_per_visitor, 1);
        assert_eq!(settings(serde_json::json!({"maxSyncConnections": 4})).max_connections_per_visitor, 4);
    }

    fn op(id: &str, collection: &str, operation: &str, record: &str, data: serde_json::Value) -> SyncOp {
        SyncOp {
            id: id.into(), collection: collection.into(), operation: operation.into(),
            record_id: record.into(), data: Some(data), timestamp: String::new(), client_id: String::new(),
        }
    }

    fn rejected(responses: &[ServerMessage]) -> Vec<String> {
        responses.iter().filter_map(|m| match m {
            ServerMessage::SyncReject { op_id, .. } => Some(op_id.clone()),
            _ => None,
        }).collect()
    }

    /// A hook that guards a collection is the app's authorization for sync.
    /// An op naming an allowed collection must not reach a record that lives
    /// in a guarded one: xdb looks a record up by id alone.
    #[test]
    fn an_op_cannot_reach_a_record_in_another_collection() {
        let (sync, db) = manager(Some("function onBeforeSyncBatch(ops) { return ops.filter(function (o) { return o.collection === 'admin'; }).map(function (o) { return o.id; }); }"));
        db.write().upsert_record(xdb::Record {
            id: "root".into(), collection: "admin".into(), data: serde_json::json!({"role":"owner"}),
            created_at: "2026-01-01T00:00:00Z".into(), updated_at: "2026-01-01T00:00:00Z".into(), deleted: false,
        }).unwrap();
        let responses = sync.handle_sync_push(vec![
            op("u1", "notes", "update", "root", serde_json::json!({"role":"guest"})),
            op("d1", "notes", "delete", "root", serde_json::json!({})),
            op("c1", "notes", "create", "root", serde_json::json!({"title":"moved"})),
            op("ok", "notes", "create", "n1", serde_json::json!({"title":"fine"})),
        ], "client");
        let mut refused = rejected(&responses);
        refused.sort();
        assert_eq!(refused, vec!["c1", "d1", "u1"], "{responses:?}");
        let root = db.write().get_record("root").unwrap();
        assert_eq!(root.collection, "admin");
        assert_eq!(root.data, serde_json::json!({"role":"owner"}));
        assert!(!root.deleted);
        assert_eq!(db.write().get_record("n1").unwrap().collection, "notes");
    }

    fn acked(responses: &[ServerMessage]) -> Vec<String> {
        responses.iter().flat_map(|m| match m {
            ServerMessage::SyncAck { op_ids } => op_ids.clone(),
            _ => Vec::new(),
        }).collect()
    }

    /// The client sends an op again until it is acknowledged, and an
    /// acknowledgement can be lost after the commit. A create that comes back
    /// must not undo what happened to the record in between.
    #[test]
    fn a_create_sent_again_does_not_overwrite_what_changed_since() {
        let (sync, db) = manager(None);
        let first = sync.handle_sync_push(vec![
            op("c1", "notes", "create", "n1", serde_json::json!({"title":"draft"})),
        ], "a");
        assert_eq!(acked(&first), vec!["c1"]);
        // Another client edits the note.
        let edit = sync.handle_sync_push(vec![
            op("u1", "notes", "update", "n1", serde_json::json!({"title":"final"})),
        ], "b");
        assert_eq!(acked(&edit), vec!["u1"]);

        let mut deltas = sync.broadcast_tx.subscribe();
        let again = sync.handle_sync_push(vec![
            op("c1", "notes", "create", "n1", serde_json::json!({"title":"draft"})),
        ], "a");
        // Acknowledged, so the client stops sending it; not refused.
        assert_eq!(acked(&again), vec!["c1"], "{again:?}");
        assert!(rejected(&again).is_empty(), "{again:?}");
        assert_eq!(db.write().get_record("n1").unwrap().data, serde_json::json!({"title":"final"}));
        // And no peer is told to apply the stale payload.
        assert!(deltas.try_recv().is_err(), "a replayed create was broadcast");
    }

    /// An op as a client stamps it, `minutes` before now.
    fn stamped(mut op: SyncOp, minutes: i64) -> SyncOp {
        op.timestamp = (chrono::Utc::now() - chrono::Duration::minutes(minutes))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        op
    }

    /// Last writer wins, by the times the clients stamped their edits: an
    /// edit made offline before another client's, and pushed after it, is
    /// acknowledged, so the client stops sending it, and not applied.
    #[test]
    fn a_stale_offline_update_does_not_overwrite_a_newer_one() {
        let (sync, db) = manager(None);
        sync.handle_sync_push(vec![stamped(op("c1", "notes", "create", "n1", serde_json::json!({"title":"first"})), 60)], "a");
        let newer = sync.handle_sync_push(vec![stamped(op("u2", "notes", "update", "n1", serde_json::json!({"title":"final"})), 10)], "b");
        assert_eq!(acked(&newer), vec!["u2"]);

        let mut deltas = sync.broadcast_tx.subscribe();
        let offline = sync.handle_sync_push(vec![stamped(op("u1", "notes", "update", "n1", serde_json::json!({"title":"draft"})), 30)], "a");
        assert_eq!(acked(&offline), vec!["u1"], "{offline:?}");
        assert!(rejected(&offline).is_empty(), "{offline:?}");
        assert_eq!(db.write().get_record("n1").unwrap().data, serde_json::json!({"title":"final"}));
        assert!(!reaches_another(&drained(&mut deltas), "a"), "an overtaken update was broadcast");
    }

    /// The ops of the `sync_delta` messages in a push's answer: what the
    /// pushing client alone is sent.
    fn told(responses: &[ServerMessage]) -> Vec<SyncOp> {
        responses.iter().flat_map(|m| match m {
            ServerMessage::SyncDelta { ops } => ops.clone(),
            _ => Vec::new(),
        }).collect()
    }

    /// The client that pushed an overtaken edit had applied it to its own
    /// copy already. It is sent the record as it stands, in a `sync_delta`
    /// it applies as it applies any other, so it does not go on showing an
    /// edit the server dropped. Nobody else is sent anything.
    #[test]
    fn the_pusher_of_an_overtaken_edit_is_sent_the_record_as_it_stands() {
        let (sync, _db) = manager(None);
        sync.handle_sync_push(vec![stamped(op("c1", "notes", "create", "n1", serde_json::json!({"title":"first", "body":"b"})), 60)], "a");
        let newer = stamped(op("u2", "notes", "update", "n1", serde_json::json!({"title":"final"})), 10);
        sync.handle_sync_push(vec![newer.clone()], "b");
        // An edit in time is answered as ever: acknowledged, nothing sent back.
        assert!(told(&sync.handle_sync_push(vec![stamped(op("c2", "notes", "create", "n2", serde_json::json!({"title":"x"})), 5)], "a")).is_empty());

        let mut others = sync.broadcast_tx.subscribe();
        for stale in [
            stamped(op("u1", "notes", "update", "n1", serde_json::json!({"title":"draft"})), 30),
            stamped(op("d1", "notes", "delete", "n1", serde_json::json!({})), 20),
        ] {
            let answer = sync.handle_sync_push(vec![stale.clone()], "a");
            assert_eq!(acked(&answer), vec![stale.id.clone()], "{answer:?}");
            let current = told(&answer);
            assert_eq!(current.len(), 1, "{answer:?}");
            assert_eq!((current[0].operation.as_str(), current[0].collection.as_str(), current[0].record_id.as_str()), ("update", "notes", "n1"));
            assert_eq!(current[0].data, Some(serde_json::json!({"title":"final", "body":"b"})));
            assert_eq!(current[0].timestamp, newer.timestamp);
        }
        assert!(!reaches_another(&drained(&mut others), "a"), "another client was sent something");
        // A record deleted since is told as deleted.
        sync.handle_sync_push(vec![stamped(op("d2", "notes", "delete", "n1", serde_json::json!({})), 3)], "b");
        let mut others = sync.broadcast_tx.subscribe();
        let answer = sync.handle_sync_push(vec![stamped(op("d0", "notes", "delete", "n1", serde_json::json!({})), 40)], "a");
        let current = told(&answer);
        assert_eq!(current.len(), 1, "{answer:?}");
        assert_eq!((current[0].operation.as_str(), current[0].record_id.as_str()), ("delete", "n1"));
        assert!(!reaches_another(&drained(&mut others), "a"), "another client was sent something");
    }

    /// Everything the sync stream holds now.
    fn drained(stream: &mut broadcast::Receiver<(Audience, Arc<ServerMessage>)>) -> Vec<(Audience, Arc<ServerMessage>)> {
        let mut out = Vec::new();
        while let Ok(item) = stream.try_recv() {
            out.push(item);
        }
        out
    }

    /// Of what the stream held, what `client`'s connection lets through, in order.
    fn reaching(items: &[(Audience, Arc<ServerMessage>)], client: &str) -> Vec<ServerMessage> {
        items.iter().filter(|(audience, _)| audience.reaches(client)).map(|(_, message)| (**message).clone()).collect()
    }

    /// Whether anything the stream held reaches a connection other than `client`'s.
    fn reaches_another(items: &[(Audience, Arc<ServerMessage>)], client: &str) -> bool {
        items.iter().any(|(audience, _)| *audience != Audience::Only(client.to_string()))
    }

    /// The record as it stands, sent to the pusher of an overtaken edit,
    /// reaches it in the order the store saw it among the other clients'
    /// edits. It went with the push's answer, on the connection's own queue,
    /// which the connection's writer interleaves with the stream of other
    /// clients' edits in whatever order the two are ready: an edit stored
    /// after it could reach the pusher first and then be undone there by
    /// the older record, which the device went on showing.
    #[test]
    fn the_record_as_it_stands_reaches_its_pusher_in_the_order_it_was_read() {
        let (sync, _db) = manager(None);
        sync.handle_sync_push(vec![stamped(op("c1", "notes", "create", "n1", serde_json::json!({"title":"first"})), 60)], "a");
        sync.handle_sync_push(vec![stamped(op("u2", "notes", "update", "n1", serde_json::json!({"title":"second"})), 10)], "b");
        let mut stream = sync.subscribe();
        // a's edit was made offline before b's: overtaken. Then c edits.
        let answer = sync.apply_sync_push(vec![stamped(op("u1", "notes", "update", "n1", serde_json::json!({"title":"draft"})), 30)], "a").0;
        sync.handle_sync_push(vec![stamped(op("u3", "notes", "update", "n1", serde_json::json!({"title":"third"})), 1)], "c");

        let to_a = reaching(&drained(&mut stream), "a");
        let shape: Vec<(&str, Vec<String>)> = to_a.iter().map(|message| match message {
            ServerMessage::SyncAck { op_ids } => ("ack", op_ids.clone()),
            ServerMessage::SyncDelta { ops } => ("delta", ops.iter().map(|op| format!("{} {}", op.id, op.data.as_ref().unwrap()["title"])).collect()),
            other => panic!("{other:?}"),
        }).collect();
        assert_eq!(shape, vec![
            ("ack", vec!["u1".to_string()]),
            ("delta", vec!["u1 \"second\"".to_string()]),
            ("delta", vec!["u3 \"third\"".to_string()]),
        ], "{answer:?}");
        // Said once: the answer itself carries neither.
        assert!(acked(&answer).is_empty() && told(&answer).is_empty(), "{answer:?}");
        // And nobody else is sent a's.
        sync.apply_sync_push(vec![stamped(op("u0", "notes", "update", "n1", serde_json::json!({"title":"older"})), 40)], "a");
        let held = drained(&mut stream);
        assert!(reaching(&held, "b").is_empty() && reaching(&held, "c").is_empty(), "{held:?}");
    }

    /// One push that edits a record and then deletes it, both overtaken: the
    /// record as it stands answers the delete. The pusher keeps a record it
    /// deleted hidden until that delete is answered (@softn/core
    /// `XDBServerSync.unansweredDeletes`), and it knows the answer by the
    /// op's id; under the edit's id the record stayed hidden there until the
    /// delete's acknowledgement came, which it may do after the record.
    #[test]
    fn the_record_as_it_stands_answers_an_overtaken_delete_of_the_same_push() {
        let (sync, _db) = manager(None);
        sync.handle_sync_push(vec![stamped(op("c1", "notes", "create", "n1", serde_json::json!({"title":"first"})), 60)], "a");
        sync.handle_sync_push(vec![stamped(op("u2", "notes", "update", "n1", serde_json::json!({"title":"final"})), 10)], "b");
        let answer = sync.handle_sync_push(vec![
            stamped(op("u1", "notes", "update", "n1", serde_json::json!({"title":"draft"})), 40),
            stamped(op("d1", "notes", "delete", "n1", serde_json::json!({})), 30),
        ], "a");
        let current = told(&answer);
        assert_eq!(current.len(), 1, "{answer:?}");
        assert_eq!((current[0].id.as_str(), current[0].operation.as_str()), ("d1", "update"), "{answer:?}");
        let mut ids = acked(&answer);
        ids.sort();
        assert_eq!(ids, vec!["d1", "u1"]);
    }

    /// An edit is weighed by the time on the device that made it, and a
    /// write the server makes itself (a hook's `db.update`) by the server's
    /// clock. An edit from a device whose clock is behind the server's,
    /// made after such a write, is acknowledged and not applied, and the
    /// device is sent the record back. Stamped in the server's time, as the
    /// runtime's client now stamps its edits (from `auth_ok.serverTime`,
    /// @softn/core xdb-server-sync.ts), the same edit applies.
    #[test]
    fn an_edit_stamped_by_a_clock_behind_the_servers_loses_to_a_server_write() {
        let (sync, db) = manager(None);
        sync.handle_sync_push(vec![stamped(op("c1", "notes", "create", "n1", serde_json::json!({"title":"first"})), 60)], "a");
        db.write().update_record("n1", serde_json::json!({"seen": true})).unwrap();
        // Made just now on a device ten minutes behind.
        let behind = sync.handle_sync_push(vec![stamped(op("u1", "notes", "update", "n1", serde_json::json!({"title":"edited"})), 10)], "a");
        assert_eq!(acked(&behind), vec!["u1"], "{behind:?}");
        assert_eq!(told(&behind).len(), 1, "{behind:?}");
        assert_eq!(db.write().get_record("n1").unwrap().data["title"], "first", "the edit was applied");
        let in_server_time = sync.handle_sync_push(vec![stamped(op("u2", "notes", "update", "n1", serde_json::json!({"title":"edited"})), 0)], "a");
        assert_eq!(acked(&in_server_time), vec!["u2"]);
        assert!(told(&in_server_time).is_empty(), "{in_server_time:?}");
        assert_eq!(db.write().get_record("n1").unwrap().data, serde_json::json!({"title":"edited", "seen": true}));
    }

    /// The client sends an op again until it is acknowledged. An update whose
    /// acknowledgement was lost, sent again after another client's newer
    /// edit, does not undo that edit; sent again with nothing in between, it
    /// leaves the record as it was.
    #[test]
    fn an_update_sent_again_after_a_lost_ack_is_harmless() {
        let (sync, db) = manager(None);
        sync.handle_sync_push(vec![stamped(op("c1", "notes", "create", "n1", serde_json::json!({"title":"first"})), 60)], "a");
        let u1 = stamped(op("u1", "notes", "update", "n1", serde_json::json!({"title":"draft"})), 30);
        assert_eq!(acked(&sync.handle_sync_push(vec![u1.clone()], "a")), vec!["u1"]);
        assert_eq!(acked(&sync.handle_sync_push(vec![u1.clone()], "a")), vec!["u1"]);
        assert_eq!(db.write().get_record("n1").unwrap().data, serde_json::json!({"title":"draft"}));

        sync.handle_sync_push(vec![stamped(op("u2", "notes", "update", "n1", serde_json::json!({"title":"final"})), 10)], "b");
        let again = sync.handle_sync_push(vec![u1], "a");
        assert_eq!(acked(&again), vec!["u1"], "{again:?}");
        assert_eq!(db.write().get_record("n1").unwrap().data, serde_json::json!({"title":"final"}));
    }

    /// Edits in the order they were made apply as they always did, in one
    /// push or several, and the record keeps the time of the edit that made
    /// it what it is: the time later edits are weighed against.
    #[test]
    fn updates_in_order_still_apply_and_keep_their_time() {
        let (sync, db) = manager(None);
        sync.handle_sync_push(vec![stamped(op("c1", "notes", "create", "n1", serde_json::json!({"title":"first", "body":"b"})), 60)], "a");
        let second = stamped(op("u2", "notes", "update", "n1", serde_json::json!({"title":"third"})), 20);
        let pushed = sync.handle_sync_push(vec![
            stamped(op("u1", "notes", "update", "n1", serde_json::json!({"title":"second"})), 30),
            second.clone(),
        ], "a");
        let mut ids = acked(&pushed);
        ids.sort();
        assert_eq!(ids, vec!["u1", "u2"]);
        let record = db.write().get_record("n1").unwrap();
        assert_eq!(record.data, serde_json::json!({"title":"third", "body":"b"}), "an update still merges into the record");
        assert_eq!(record.updated_at, second.timestamp);
        // An op the client did not stamp is stamped by the server, now, and applies.
        let unstamped = sync.handle_sync_push(vec![op("u3", "notes", "update", "n1", serde_json::json!({"title":"fourth"}))], "b");
        assert_eq!(acked(&unstamped), vec!["u3"]);
        assert_eq!(db.write().get_record("n1").unwrap().data["title"], "fourth");
    }

    /// An update is merged into the record it names, and a record may be no
    /// larger than one op may carry: each op was held to that, and a record
    /// was not, so a few updates of new keys grew one record without end,
    /// until every op on it, and every pull of it, was a copy of all of it.
    /// The op that would take a record past the limit is refused with the
    /// reason; one that keeps it within the limit, or makes a record that is
    /// already past it (from before this) smaller, applies.
    #[test]
    fn an_update_cannot_grow_a_record_past_what_one_op_may_carry() {
        let (sync, db) = manager(None);
        let big = "x".repeat(400 * 1024);
        sync.handle_sync_push(vec![stamped(op("c1", "notes", "create", "n1", serde_json::json!({"k0": big})), 60)], "a");
        let grown = sync.handle_sync_push(vec![stamped(op("u1", "notes", "update", "n1", serde_json::json!({"k1": big})), 50)], "a");
        assert_eq!(rejected(&grown), vec!["u1"], "{grown:?}");
        let reason = grown.iter().find_map(|m| match m { ServerMessage::SyncReject { reason, .. } => Some(reason.clone()), _ => None }).unwrap();
        assert!(reason.contains("too large") && reason.contains(&MAX_OP_DATA_BYTES.to_string()), "{reason}");
        assert_eq!(db.write().get_record("n1").unwrap().data, serde_json::json!({"k0": big}));
        let within = sync.handle_sync_push(vec![stamped(op("u2", "notes", "update", "n1", serde_json::json!({"k1": "small"})), 40)], "a");
        assert_eq!(acked(&within), vec!["u2"], "{within:?}");

        // A record already past the limit: written before records were held to it.
        let huge = "y".repeat(MAX_OP_DATA_BYTES + 1024);
        db.write().upsert_record(xdb::Record {
            id: "n2".into(), collection: "notes".into(), data: serde_json::json!({"k0": huge, "k1": "z"}),
            created_at: "2026-01-01T00:00:00Z".into(), updated_at: "2026-01-01T00:00:00Z".into(), deleted: false,
        }).unwrap();
        let more = sync.handle_sync_push(vec![stamped(op("u3", "notes", "update", "n2", serde_json::json!({"k2": "more"})), 30)], "a");
        assert_eq!(rejected(&more), vec!["u3"], "{more:?}");
        let smaller = sync.handle_sync_push(vec![stamped(op("u4", "notes", "update", "n2", serde_json::json!({"k0": "short"})), 20)], "a");
        assert_eq!(acked(&smaller), vec!["u4"], "{smaller:?}");
        assert_eq!(db.write().get_record("n2").unwrap().data, serde_json::json!({"k0": "short", "k1": "z"}));
    }

    /// The per-op after-sync hooks of a push stop being started once their
    /// budget is spent, as the before-hooks do: a push of a thousand ops to a
    /// hook that takes a little while each ran them all, however long that
    /// was. And they hold no sync permit: the push is stored and answered
    /// under one, and it is let go before the hooks run, so a slow hook
    /// cannot keep it from the next push.
    #[test]
    fn the_after_sync_hooks_have_a_deadline_and_hold_no_permit() {
        const SLOW: &str = "function onAfterSync(op) { var a = []; for (var i = 0; i < 100000; i++) a.push(i); var n = 0; for (var k = 0; k < 20; k++) n = n + JSON.stringify(a).length; return n; }";
        let ops = |prefix: &str, count: usize| -> Vec<SyncOp> {
            (0..count).map(|i| op(&format!("{prefix}{i}"), "notes", "create", &format!("{prefix}r{i}"), serde_json::json!({"n": i}))).collect()
        };
        // With one worker and with several: the hooks of a push are one run
        // that idle workers take a stretch at a time.
        for workers in [1, 4] {
            let (sync, _db) = manager_with(Some(SLOW), workers);
            // What one hook takes on this machine.
            let started = std::time::Instant::now();
            sync.run_after_sync(&sync.apply_sync_push(ops("one", 1), "a").1);
            let one = started.elapsed();

            sync.after_hook_budget_ms.store(200, std::sync::atomic::Ordering::Relaxed);
            let accepted = sync.apply_sync_push(ops("many", 60), "a").1;
            assert_eq!(accepted.len(), 60);
            let started = std::time::Instant::now();
            sync.run_after_sync(&accepted);
            let many = started.elapsed();
            assert!(many < std::time::Duration::from_millis(200) + one * 4 + std::time::Duration::from_millis(500),
                "{workers} worker(s): 60 hooks took {many:?}, one {one:?}: the budget did not stop them");
        }

        let (sync, _db) = manager(Some(SLOW));
        sync.after_hook_budget_ms.store(200, std::sync::atomic::Ordering::Relaxed);

        // The permit is back as soon as the push is answered.
        let total = sync.sync_permits.available_permits();
        let permit = sync.sync_permits.clone().try_acquire_owned().unwrap();
        let (answered_tx, answered_rx) = std::sync::mpsc::channel();
        let pusher = Arc::clone(&sync);
        let pushing = std::thread::spawn(move || {
            pusher.push_and_hook(ops("later", 20), "a", permit, |responses| { let _ = answered_tx.send(responses); });
        });
        let responses = answered_rx.recv().unwrap();
        assert_eq!(acked(&responses).len(), 20);
        assert_eq!(sync.sync_permits.available_permits(), total, "the hooks are holding the permit");
        pushing.join().unwrap();
    }

    /// A delete is weighed the same way: one made before a newer edit does
    /// not remove it; one made after does, and keeps its time. An update for
    /// a deleted record is refused, as it was.
    #[test]
    fn deletes_are_weighed_by_their_time_too() {
        let (sync, db) = manager(None);
        sync.handle_sync_push(vec![stamped(op("c1", "notes", "create", "n1", serde_json::json!({"title":"first"})), 60)], "a");
        sync.handle_sync_push(vec![stamped(op("u2", "notes", "update", "n1", serde_json::json!({"title":"final"})), 10)], "b");
        let stale = sync.handle_sync_push(vec![stamped(op("d1", "notes", "delete", "n1", serde_json::json!({})), 30)], "a");
        assert_eq!(acked(&stale), vec!["d1"], "{stale:?}");
        let record = db.write().get_record("n1").unwrap();
        assert!(!record.deleted, "a delete made before the newer edit removed it");
        assert_eq!(record.data, serde_json::json!({"title":"final"}));

        let delete = stamped(op("d2", "notes", "delete", "n1", serde_json::json!({})), 5);
        assert_eq!(acked(&sync.handle_sync_push(vec![delete.clone()], "a")), vec!["d2"]);
        let record = db.write().get_record("n1").unwrap();
        assert!(record.deleted);
        assert_eq!(record.updated_at, delete.timestamp);
        let late = sync.handle_sync_push(vec![stamped(op("u3", "notes", "update", "n1", serde_json::json!({"title":"late"})), 1)], "b");
        assert_eq!(rejected(&late), vec!["u3"], "{late:?}");
    }

    /// Several clients edit one record at once, each edit weighed against
    /// the record and written under the one writer lock: whatever order the
    /// pushes arrive in, with one script worker checking them or four, the
    /// record ends as the newest edit made it and every op is acknowledged.
    #[test]
    fn of_edits_pushed_at_once_the_newest_is_the_record() {
        for workers in [1, 4] {
            let (sync, db) = manager_with(Some("function onBeforeSync(op) { return true; }"), workers);
            let began = chrono::Utc::now() - chrono::Duration::seconds(120);
            let at = move |n: i64| (began + chrono::Duration::milliseconds(n)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
            let mut create = op("c1", "notes", "create", "n1", serde_json::json!({"v": -1}));
            create.timestamp = at(0);
            sync.handle_sync_push(vec![create], "seed");
            const CLIENTS: i64 = 6;
            const EDITS: i64 = 150;
            let pushing: Vec<_> = (0..CLIENTS).map(|client| {
                let sync = Arc::clone(&sync);
                std::thread::spawn(move || {
                    let mut answered = 0;
                    for i in 0..EDITS {
                        // Half the clients push their edits newest first, as
                        // a device that was offline may.
                        let turn = if client % 2 == 0 { i } else { EDITS - 1 - i };
                        let n = 1 + turn * CLIENTS + client;
                        let mut edit = op(&format!("u{n}"), "notes", "update", "n1", serde_json::json!({"v": n}));
                        edit.timestamp = at(n);
                        // An op the host could not check this time (every
                        // worker taken) is sent again, as a client does.
                        for attempt in 0.. {
                            let answer = sync.handle_sync_push(vec![edit.clone()], &format!("client-{client}"));
                            assert!(rejected(&answer).is_empty(), "{answer:?}");
                            if acked(&answer).len() == 1 {
                                answered += 1;
                                break;
                            }
                            assert!(attempt < 2000 && matches!(answer.as_slice(), [ServerMessage::SyncRetry { .. }]), "{answer:?}");
                            std::thread::sleep(std::time::Duration::from_millis(2));
                        }
                    }
                    answered
                })
            }).collect();
            let answered: usize = pushing.into_iter().map(|thread| thread.join().unwrap()).sum();
            assert_eq!(answered as i64, CLIENTS * EDITS, "{workers} worker(s)");
            let newest = CLIENTS * EDITS;
            let record = db.write().get_record("n1").unwrap();
            assert_eq!(record.data, serde_json::json!({"v": newest}), "{workers} worker(s)");
            assert_eq!(record.updated_at, at(newest), "{workers} worker(s)");
        }
    }

    /// An update for a record that has been deleted is refused, whenever it
    /// was made. The device that pushed it had the record, edited, on its
    /// screen: a full pull sends no deleted records and a refusal changes
    /// nothing there, so it went on showing a record every other device had
    /// seen deleted. Its pusher is sent the record as it stands, deleted,
    /// as the pusher of an overtaken edit is, and nobody else is sent anything.
    #[test]
    fn the_pusher_of_an_update_to_a_deleted_record_is_told_it_is_deleted() {
        let (sync, db) = manager(None);
        sync.handle_sync_push(vec![stamped(op("c1", "notes", "create", "n1", serde_json::json!({"title":"first"})), 60)], "a");
        sync.handle_sync_push(vec![stamped(op("d1", "notes", "delete", "n1", serde_json::json!({})), 20)], "b");
        let mut others = sync.broadcast_tx.subscribe();
        // Made before the delete (offline) and made after it: refused alike.
        for (id, minutes) in [("u-before", 30), ("u-after", 5)] {
            let answer = sync.handle_sync_push(vec![stamped(op(id, "notes", "update", "n1", serde_json::json!({"title":"edited"})), minutes)], "a");
            assert_eq!(rejected(&answer), vec![id], "{answer:?}");
            assert!(acked(&answer).is_empty(), "{answer:?}");
            let current = told(&answer);
            assert_eq!(current.len(), 1, "{answer:?}");
            assert_eq!((current[0].operation.as_str(), current[0].collection.as_str(), current[0].record_id.as_str()), ("delete", "notes", "n1"));
            assert_eq!(current[0].data, None);
        }
        assert!(db.write().get_record("n1").unwrap().deleted);
        assert!(!reaches_another(&drained(&mut others), "a"), "another client was sent something");
        // An update for a record that was never there has nothing to be told.
        let missing = sync.handle_sync_push(vec![op("u-missing", "notes", "update", "nobody", serde_json::json!({"title":"x"}))], "a");
        assert_eq!(rejected(&missing), vec!["u-missing"]);
        assert!(told(&missing).is_empty(), "{missing:?}");
    }

    #[test]
    fn a_create_sent_again_does_not_bring_back_a_deleted_record() {
        let (sync, db) = manager(None);
        sync.handle_sync_push(vec![op("c1", "notes", "create", "n1", serde_json::json!({"title":"draft"}))], "a");
        sync.handle_sync_push(vec![op("d1", "notes", "delete", "n1", serde_json::json!({}))], "b");
        assert!(db.write().get_record("n1").unwrap().deleted);

        let again = sync.handle_sync_push(vec![
            op("c1", "notes", "create", "n1", serde_json::json!({"title":"draft"})),
            op("c2", "notes", "create", "n2", serde_json::json!({"title":"new"})),
        ], "a");
        let mut ids = acked(&again);
        ids.sort();
        assert_eq!(ids, vec!["c1", "c2"], "{again:?}");
        assert!(db.write().get_record("n1").unwrap().deleted, "the delete was undone");
        // A create for an id that is not there is still a create.
        assert_eq!(db.write().get_record("n2").unwrap().data, serde_json::json!({"title":"new"}));
    }

    /// `{ data: clean(op.data) }` where `clean` returns nothing: the record
    /// keeps its payload instead of becoming JSON null.
    #[test]
    fn a_per_op_hook_that_returns_no_data_does_not_null_the_record() {
        let (sync, db) = manager(Some(
            "function onBeforeSync(op) { return { data: op.operation === 'update' ? undefined : op.data }; }",
        ));
        sync.handle_sync_push(vec![op("c1", "notes", "create", "n1", serde_json::json!({"title":"draft"}))], "a");
        let responses = sync.handle_sync_push(vec![
            op("u1", "notes", "update", "n1", serde_json::json!({"title":"final"})),
        ], "a");
        assert_eq!(acked(&responses), vec!["u1"], "{responses:?}");
        let data = db.write().get_record("n1").unwrap().data;
        assert!(data.is_object(), "the record's payload became {data}");
        assert_eq!(data["title"], "final");
    }

    /// The per-op hooks of one push run in order in one VM, whatever the size
    /// of the worker pool, and the next push's start from the script as it
    /// was loaded. Sent as a call each they were taken by whichever worker
    /// was idle, so on four workers a hook that counted the ops of a push
    /// numbered them 1, 1, 1, 1, 2, 2 and so on.
    #[test]
    fn the_per_op_hooks_of_one_push_run_in_order_in_one_world() {
        let (sync, db) = manager_with(Some(
            "var seen = 0; function onBeforeSync(op) { seen = seen + 1; return { data: { seq: seen } }; }",
        ), 4);
        // One stretch, however slowly this machine is running the test.
        sync.runtime.as_ref().unwrap().each_slice_ms.store(600_000, std::sync::atomic::Ordering::Relaxed);
        for prefix in ["a", "b"] {
            let ops: Vec<SyncOp> = (0..12)
                .map(|n| op(&format!("{prefix}{n}"), "notes", "create", &format!("{prefix}-r{n}"), serde_json::json!({"n": n})))
                .collect();
            let responses = sync.handle_sync_push(ops, "a");
            assert_eq!(acked(&responses).len(), 12, "{responses:?}");
            let numbered: Vec<i64> = (0..12)
                .map(|n| db.write().get_record(&format!("{prefix}-r{n}")).unwrap().data["seq"].as_i64().unwrap())
                .collect();
            assert_eq!(numbered, (1..=12).collect::<Vec<i64>>(), "push {prefix}");
        }
    }

    /// A hook may change an op's data to another object of a size a client
    /// may send, and to nothing else: a string would replace the record with
    /// that string, and more than a client may send was never checked.
    #[test]
    fn what_a_before_hook_hands_back_is_held_to_what_a_client_may_send() {
        for hook in [
            "function onBeforeSync(op) { return { data: change(op) }; }",
            "function onBeforeSyncBatch(ops) { return { rejected: [], ops: ops.map(function (op) { return { id: op.id, data: change(op) }; }) }; }",
        ] {
            let source = format!(
                "function change(op) {{
                    if (op.data.as === 'text') return 'wiped';
                    if (op.data.as === 'list') return [1, 2];
                    if (op.data.as === 'huge') return {{ blob: new Array({}).join('x') }};
                    if (op.data.as === 'clean') return {{ title: op.data.title.trim() }};
                    return op.data;
                }}
                {hook}",
                MAX_OP_DATA_BYTES + 2
            );
            let (sync, db) = manager(Some(&source));
            sync.handle_sync_push(vec![op("c1", "notes", "create", "n1", serde_json::json!({"title":"kept"}))], "a");
            for bad in ["text", "list", "huge"] {
                let responses = sync.handle_sync_push(vec![
                    op(&format!("u-{bad}"), "notes", "update", "n1", serde_json::json!({"as": bad})),
                ], "a");
                assert!(acked(&responses).is_empty(), "{bad}: {responses:?}");
                assert!(rejected(&responses).is_empty(), "{bad}: the client keeps the op: {responses:?}");
                assert!(responses.iter().any(|r| matches!(r, ServerMessage::SyncRetry { op_ids, .. } if op_ids == &vec![format!("u-{bad}")])), "{bad}: {responses:?}");
                assert_eq!(db.write().get_record("n1").unwrap().data, serde_json::json!({"title":"kept"}), "{bad} ({hook})");
            }
            // An object of an ordinary size is what a sanitising hook is for.
            let responses = sync.handle_sync_push(vec![
                op("u-clean", "notes", "update", "n1", serde_json::json!({"as":"clean","title":"  tidy  "})),
            ], "a");
            assert_eq!(acked(&responses), vec!["u-clean"], "{responses:?}");
            assert_eq!(db.write().get_record("n1").unwrap().data["title"], "tidy");
        }
    }

    /// A collection past one page is pulled in pages: each full page says
    /// where the next begins, and nothing is sent twice or left out.
    #[test]
    fn a_pull_past_one_page_says_where_the_next_begins() {
        let (sync, _db) = manager(None);
        sync.pull_page.store(2, std::sync::atomic::Ordering::Relaxed);
        for n in 1..=5 {
            sync.handle_sync_push(vec![op(&format!("c{n}"), "notes", "create", &format!("n{n}"), serde_json::json!({"n": n}))], "a");
        }
        // One that is deleted is in no page.
        sync.handle_sync_push(vec![op("d3", "notes", "delete", "n3", serde_json::json!({}))], "a");

        let page = |cursor: Option<&PullCursor>| {
            let messages = sync.handle_sync_pull(&["notes".to_string()], None, None, cursor.map(|c| (c.at.as_str(), c.id.as_str())));
            let mut ids = Vec::new();
            let mut next = None;
            for (i, message) in messages.iter().enumerate() {
                let ServerMessage::SyncState { records, more, .. } = message else { panic!("{message:?}") };
                ids.extend(records.iter().map(|r| r["id"].as_str().unwrap().to_string()));
                assert!(more.is_none() || i == messages.len() - 1, "only the last piece of a page says there is more");
                next = more.clone();
            }
            (ids, next)
        };
        let (first, more) = page(None);
        assert_eq!(first.len(), 2);
        let more = more.expect("a full page says where the next begins");
        // What a client of today is sent, and what one from before reads past.
        let wire = serde_json::to_value(ServerMessage::SyncState { collection: "notes".into(), records: Vec::new(), more: Some(more.clone()) }).unwrap();
        assert_eq!(wire["more"], serde_json::json!({"at": more.at, "id": more.id}));
        assert!(serde_json::to_value(ServerMessage::SyncState { collection: "notes".into(), records: Vec::new(), more: None }).unwrap().get("more").is_none());

        let (second, more) = page(Some(&more));
        assert_eq!(second.len(), 2);
        let (third, end) = page(Some(&more.expect("the second page was full too")));
        assert!(end.is_none(), "a page that is not full is the last");
        let mut all = [first, second, third].concat();
        all.sort();
        assert_eq!(all, vec!["n1", "n2", "n4", "n5"]);
    }

    /// The acknowledgement and the broadcast do not wait for the after-hooks.
    #[test]
    fn a_push_is_answered_and_broadcast_before_its_after_hooks_run() {
        let dir = crate::test_dirs::temp_path("softn-sync-after", "");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("xdb.sqlite");
        let db = ServerDb::new(xdb::create_shared_db(path.clone()).unwrap(), &path, 2).unwrap();
        let hook_db = db.clone();
        let runtime = ServerRuntime::new(move || crate::host::BridgeSet {
            db: Some(Box::new(crate::bridges::db::NativeDbBridge::new(hook_db.clone()))),
            http: None, fs: None, env: None, sql: None, crypto: None,
            allow_time: false, development: true, allow_photos: false, app_config: serde_json::Value::Null,
        }, Some(1)).unwrap();
        runtime.init("function onAfterSyncBatch(ops) { db.create('audit', { seen: ops.length }); }".to_string()).unwrap();
        let settings = SyncSettings { max_storage_bytes: 0, sync_permits: 4, force_server_timestamps: false, max_connections: 2, max_connections_per_visitor: 2 };
        let sync = SyncManager::new(db.clone(), Some(runtime), None, path, settings);
        let mut deltas = sync.subscribe();
        let audited = || {
            let conn = db.read().unwrap();
            pool::read_collection(&conn, "audit").unwrap().len()
        };

        let (responses, stored) = sync.apply_sync_push(vec![op("c1", "notes", "create", "n1", serde_json::json!({"title": "x"}))], "a");
        assert_eq!(acked(&responses), vec!["c1"], "{responses:?}");
        assert!(deltas.try_recv().is_ok(), "the other clients are told with the answer");
        assert_eq!(audited(), 0, "the after-hook ran before the push was answered");
        assert_eq!(stored.len(), 1);
        sync.run_after_sync(&stored);
        assert_eq!(audited(), 1, "and it does run");
        // Nothing stored, nothing to hook.
        sync.run_after_sync(&[]);
        assert_eq!(audited(), 1);
    }

    /// Past its budget the per-op before-hook checks no more ops of a push;
    /// the client keeps the rest. The first is always checked.
    #[test]
    fn a_before_hook_that_runs_out_of_time_leaves_the_rest_for_the_client() {
        let (sync, db) = manager(Some("function onBeforeSync(op) { return true; }"));
        sync.before_hook_budget_ms.store(0, std::sync::atomic::Ordering::Relaxed);
        let responses = sync.handle_sync_push(vec![
            op("c1", "notes", "create", "n1", serde_json::json!({"n": 1})),
            op("c2", "notes", "create", "n2", serde_json::json!({"n": 2})),
            op("c3", "notes", "create", "n3", serde_json::json!({"n": 3})),
        ], "a");
        assert_eq!(acked(&responses), vec!["c1"], "{responses:?}");
        assert!(rejected(&responses).is_empty(), "nothing is refused for good: {responses:?}");
        let retried: Vec<String> = responses.iter().flat_map(|r| match r {
            ServerMessage::SyncRetry { op_ids, .. } => op_ids.clone(),
            _ => Vec::new(),
        }).collect();
        assert_eq!(retried, vec!["c2", "c3"]);
        assert!(db.write().get_record("n1").is_ok() && db.write().get_record("n2").is_err());
        // With time to spare every op is checked.
        sync.before_hook_budget_ms.store(60_000, std::sync::atomic::Ordering::Relaxed);
        let responses = sync.handle_sync_push(vec![
            op("c2", "notes", "create", "n2", serde_json::json!({"n": 2})),
            op("c3", "notes", "create", "n3", serde_json::json!({"n": 3})),
        ], "a");
        let mut ids = acked(&responses);
        ids.sort();
        assert_eq!(ids, vec!["c2", "c3"]);
    }

    /// A push writes each collection's CRDT document once, not once an op,
    /// and what it writes is still every op of the push but the one refused.
    #[test]
    fn a_push_saves_each_collections_document_once() {
        let ops = |prefix: &str| -> Vec<SyncOp> {
            (0..20).map(|n| op(&format!("{prefix}{n}"), "notes", "create", &format!("n{n}"), serde_json::json!({"n": n}))).collect()
        };
        // Twenty ops in one push, and the same twenty a push each: the rows
        // are the same, and the one push saves the document nineteen fewer times.
        let (together, db_together) = manager(None);
        let before = db_together.write().total_changes();
        let responses = together.handle_sync_push(ops("c"), "a");
        assert_eq!(acked(&responses).len(), 20, "{responses:?}");
        let one_push = db_together.write().total_changes() - before;

        let (apart, db_apart) = manager(None);
        let before = db_apart.write().total_changes();
        for single in ops("c") {
            apart.handle_sync_push(vec![single], "a");
        }
        let twenty_pushes = db_apart.write().total_changes() - before;
        assert_eq!(twenty_pushes - one_push, 19, "{one_push} changes for one push, {twenty_pushes} for twenty");

        // One op of a push refused by the store (an update of a record that
        // is not there); the rest, on both sides of it, are in the document a
        // peer would be sent.
        let mixed = together.handle_sync_push(vec![
            op("u1", "notes", "update", "n1", serde_json::json!({"edited": true})),
            op("u-missing", "notes", "update", "nobody", serde_json::json!({"edited": true})),
            op("u2", "notes", "update", "n2", serde_json::json!({"edited": true})),
        ], "a");
        let mut done = acked(&mixed);
        done.sort();
        assert_eq!(done, vec!["u1", "u2"], "{mixed:?}");
        assert_eq!(rejected(&mixed), vec!["u-missing"]);
        let state = db_together.write().get_full_state("notes").unwrap();
        let dir = crate::test_dirs::temp_path("softn-sync-peer", "");
        std::fs::create_dir_all(&dir).unwrap();
        let peer = xdb::create_shared_db(dir.join("peer.sqlite")).unwrap();
        let peer_db = ServerDb::new(peer, &dir.join("peer.sqlite"), 2).unwrap();
        peer_db.write().apply_remote_update("notes", &state).unwrap();
        let replicated = peer_db.write().get_collection("notes").unwrap();
        assert_eq!(replicated.len(), 20);
        let edited: Vec<&str> = replicated.iter().filter(|r| r.data["edited"] == true).map(|r| r.id.as_str()).collect();
        assert_eq!(edited.len(), 2, "{edited:?}");
        assert!(edited.contains(&"n1") && edited.contains(&"n2"));
    }

    /// What an after-sync hook throws reaches the caller, which logs it.
    #[test]
    fn an_after_sync_hook_that_throws_is_reported() {
        let (sync, _) = manager(Some("function onAfterSyncBatch(ops) { throw new Error('mail is down'); } function onAfterSync(op) { throw new Error('mail is down'); }"));
        let ops = vec![op("c1", "notes", "create", "n1", serde_json::json!({}))];
        let batch = sync.call_after_sync_batch(&ops).unwrap_err();
        assert!(batch.contains("mail is down"), "{batch}");
        let single = sync.call_after_sync_each(&ops[..1]).remove(0);
        assert!(single.contains("mail is down"), "{single}");
    }

    /// A pull is chunked by bytes as well as by count: the client drops any
    /// message over 2 MB, so a count-only chunk of large records never lands.
    #[test]
    fn a_pull_is_chunked_under_the_clients_message_limit() {
        let (sync, db) = manager(None);
        let big = "x".repeat(300 * 1024);
        for i in 0..20 {
            db.write().upsert_record(xdb::Record {
                id: format!("r{i}"), collection: "docs".into(), data: serde_json::json!({"body": big}),
                created_at: "2026-01-01T00:00:00Z".into(), updated_at: "2026-01-01T00:00:00Z".into(), deleted: false,
            }).unwrap();
        }
        let messages = sync.handle_sync_pull(&["docs".to_string()], None, None, None);
        let mut total = 0;
        for message in &messages {
            let bytes = serde_json::to_vec(message).unwrap().len();
            assert!(bytes <= 2 * 1024 * 1024, "a {bytes}-byte sync_state would be discarded by the client");
            if let ServerMessage::SyncState { records, .. } = message { total += records.len(); }
        }
        assert_eq!(total, 20);
        assert!(messages.len() > 1);
    }

    /// A pull is read a message at a time, each when the one before has
    /// gone: it holds one message's records, where it used to read every
    /// collection it named, up to ten thousand records each, into memory
    /// before the first was sent. What is sent is what was sent before, in
    /// the same messages: by collection, chunked by count and by bytes, a
    /// collection with nothing in it still answered, and an incremental pull
    /// with the deleted records as well.
    #[test]
    fn a_pull_is_read_one_message_at_a_time() {
        let (sync, db) = manager(None);
        let put = |id: String, collection: &str, received: usize, deleted: bool| {
            db.write().upsert_record(xdb::Record {
                id, collection: collection.into(), data: serde_json::json!({"n": received}),
                created_at: "2026-01-01T00:00:00Z".into(), updated_at: "2026-01-01T00:00:00Z".into(), deleted,
            }).unwrap();
        };
        for i in 0..1200 { put(format!("a{i:04}"), "alpha", i, false); }
        for i in 0..3 { put(format!("b{i}"), "beta", i, i == 1); }
        let names: Vec<String> = ["alpha", "beta", "gamma"].iter().map(|s| s.to_string()).collect();
        let records = |message: &ServerMessage| match message {
            ServerMessage::SyncState { collection, records, .. } => (collection.clone(), records.len()),
            other => panic!("{other:?}"),
        };

        let mut pull = sync.start_pull(&names, None, None, None).unwrap();
        let mut steps = Vec::new();
        while let Some(message) = sync.pull_step(&mut pull) {
            assert!(pull.chunk.len() <= SYNC_PULL_CHUNK_SIZE, "a step kept {} records", pull.chunk.len());
            steps.push(message);
        }
        assert_eq!(steps.iter().map(records).collect::<Vec<_>>(), vec![
            ("alpha".to_string(), 500), ("alpha".to_string(), 500), ("alpha".to_string(), 200),
            ("beta".to_string(), 2), ("gamma".to_string(), 0),
        ]);
        let all = serde_json::to_string(&sync.handle_sync_pull(&names, None, None, None)).unwrap();
        assert_eq!(serde_json::to_string(&steps).unwrap(), all, "the pull a step at a time is the pull");

        // Incremental: what changed since a point, the deleted included, in order.
        let since = "0000";
        let mut pull = sync.start_pull(&names[1..2], Some(since), None, None).unwrap();
        let first = sync.pull_step(&mut pull).unwrap();
        assert!(sync.pull_step(&mut pull).is_none());
        let ServerMessage::SyncState { records, more, .. } = first else { panic!() };
        assert!(more.is_none());
        let ids: Vec<(String, bool)> = records.iter().map(|r| (r["id"].as_str().unwrap().to_string(), r.get("deleted").is_some())).collect();
        assert_eq!(ids, vec![("b0".to_string(), false), ("b1".to_string(), true), ("b2".to_string(), false)]);
    }

    /// Other clients are sent a push's ops in the order the pushes were
    /// stored. They were sent once the writer lock had been let go, after
    /// the acknowledgement was made and the ops copied, so a push stored
    /// second could be sent first, and the larger the first push the longer
    /// its copying took. A client applies what it is sent as it comes: of
    /// two edits to one record it was left showing the older, while the
    /// server, and the client that made the newer, had the newer.
    ///
    /// Several clients push at once here, one of them in large pushes. Every
    /// op creates a record, so the table's row numbers are the order the
    /// pushes were stored in, and the records must be sent on in that order.
    #[test]
    fn pushes_reach_other_clients_in_the_order_they_were_stored() {
        let (sync, _db) = manager(None);
        let mut deltas = sync.subscribe();
        let listener = std::thread::spawn(move || {
            let mut sent = Vec::new();
            loop {
                match deltas.blocking_recv() {
                    Ok((_, message)) if matches!(*message, ServerMessage::SyncDelta { .. }) => {
                        let ServerMessage::SyncDelta { ops } = &*message else { unreachable!() };
                        for op in ops {
                            if op.record_id == "end" {
                                return sent;
                            }
                            sent.push(op.record_id.clone());
                        }
                    }
                    // What a slow listener missed is left out; what it has is still in order.
                    Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(broadcast::error::RecvError::Closed) => return sent,
                }
            }
        });

        let mut pushing = Vec::new();
        {
            // One client pushes six hundred records at a time.
            let sync = Arc::clone(&sync);
            pushing.push(std::thread::spawn(move || {
                let tags: Vec<String> = (0..60).map(|n| format!("tag {n}")).collect();
                for round in 0..12 {
                    let ops: Vec<SyncOp> = (0..600)
                        .map(|i| op(&format!("b{round}-{i}"), "bulk", "create", &format!("bulk-{round}-{i}"), serde_json::json!({"tags": tags})))
                        .collect();
                    assert_eq!(acked(&sync.handle_sync_push(ops, "bulk")).len(), 600);
                }
            }));
        }
        for client in 0..3 {
            // The others push one record after another.
            let sync = Arc::clone(&sync);
            pushing.push(std::thread::spawn(move || {
                for i in 0..300 {
                    let create = op(&format!("c{client}-{i}"), "notes", "create", &format!("note-{client}-{i}"), serde_json::json!({"n": i}));
                    assert_eq!(acked(&sync.handle_sync_push(vec![create], &format!("client-{client}"))).len(), 1);
                }
            }));
        }
        for thread in pushing {
            thread.join().unwrap();
        }
        sync.handle_sync_push(vec![op("end", "notes", "create", "end", serde_json::json!({}))], "seed");
        let sent = listener.join().unwrap();

        let direct = rusqlite::Connection::open(&sync.db_path).unwrap();
        let stored: std::collections::HashMap<String, i64> = direct
            .prepare("SELECT id, rowid FROM records").unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?))).unwrap()
            .collect::<Result<_, _>>().unwrap();
        assert!(sent.len() > 1000, "only {} of the records were sent on", sent.len());
        let rows: Vec<i64> = sent.iter().map(|id| stored[id]).collect();
        let late = rows.windows(2).filter(|pair| pair[1] < pair[0]).count();
        assert_eq!(late, 0, "{late} time(s) a push was sent on after one stored later");
    }

    /// The ids a full pull of `notes` sends, page after page as a client
    /// asks for them, in the order they are sent.
    fn pulled_in_pages(sync: &SyncManager) -> Vec<String> {
        let mut ids = Vec::new();
        let mut cursor: Option<PullCursor> = None;
        for _ in 0..1000 {
            let messages = sync.handle_sync_pull(&["notes".to_string()], None, None, cursor.as_ref().map(|c| (c.at.as_str(), c.id.as_str())));
            cursor = None;
            for message in messages {
                let ServerMessage::SyncState { records, more, .. } = message else { panic!("{message:?}") };
                ids.extend(records.iter().map(|r| r["id"].as_str().unwrap().to_string()));
                cursor = more;
            }
            if cursor.is_none() {
                return ids;
            }
        }
        panic!("the pull went on asking for more after {} records", ids.len());
    }

    /// Each step of a pull goes on from the last record the step before
    /// read, and each page from the last record of the page before. Through
    /// records received in the same millisecond (a bulk statement stamps
    /// every row it touches alike), through records with no receipt time
    /// (null, or empty, from a host before there were receipt times), and
    /// with the ends of messages and of pages falling among both, every
    /// record is sent once, in the order `COALESCE(server_received_at, '')`,
    /// id: the order the pull was read in when it was one query.
    #[test]
    fn a_pull_in_steps_and_pages_sends_every_record_once_in_the_one_order() {
        let (sync, db) = manager(None);
        for i in 0..1300 {
            db.write().upsert_record(xdb::Record {
                id: format!("n{i:04}"), collection: "notes".into(), data: serde_json::json!({"n": i}),
                created_at: "2026-01-01T00:00:00Z".into(), updated_at: "2026-01-01T00:00:00Z".into(), deleted: false,
            }).unwrap();
        }
        let direct = rusqlite::Connection::open(&sync.db_path).unwrap();
        // 650 records in one millisecond and 450 in the next, 50 as they were
        // received, and 150 with no receipt time: null and empty by turns.
        direct.execute_batch(
            "UPDATE records SET server_received_at = '2026-01-01T00:00:00.000Z' WHERE id < 'n0650';
             UPDATE records SET server_received_at = '2026-01-01T00:00:00.001Z' WHERE id >= 'n0650' AND id < 'n1100';
             UPDATE records SET server_received_at = NULL WHERE id >= 'n1150';
             UPDATE records SET server_received_at = '' WHERE id >= 'n1150' AND substr(id, 5, 1) IN ('1', '3', '5', '7', '9');",
        ).unwrap();
        let wanted: Vec<String> = direct
            .prepare("SELECT id FROM records WHERE collection = 'notes' AND deleted = 0 ORDER BY COALESCE(server_received_at, '') ASC, id ASC").unwrap()
            .query_map([], |row| row.get(0)).unwrap().collect::<Result<_, _>>().unwrap();
        assert_eq!(wanted.len(), 1300);
        assert!(wanted[0] == "n1150" && wanted[149] == "n1299" && wanted[150] == "n0000", "{:?}", &wanted[..3]);

        // A page the size of the collection, pages that end among the
        // records with no receipt time, among the ties, and on a message's end.
        for page in [10_000, 700, 500, 100, 7] {
            sync.pull_page.store(page, std::sync::atomic::Ordering::Relaxed);
            let sent = pulled_in_pages(&sync);
            assert_eq!(sent.len(), wanted.len(), "pages of {page}");
            assert!(sent == wanted, "pages of {page}: sent in another order, or one twice");
        }

        // An incremental pull, from a record among the ties: the rest, the
        // records with no receipt time left out as they always were.
        let since = sync.handle_sync_pull(&["notes".to_string()], Some("2026-01-01T00:00:00.000Z"), Some("n0100"), None);
        let ids: Vec<String> = since.iter().flat_map(|m| match m {
            ServerMessage::SyncState { records, .. } => records.iter().map(|r| r["id"].as_str().unwrap().to_string()).collect::<Vec<_>>(),
            other => panic!("{other:?}"),
        }).collect();
        assert_eq!(ids, wanted[251..].to_vec());
    }

    /// Records are written while a pull is between two of its steps. One not
    /// yet read that is changed is sent once, as changed (it has moved to
    /// the end, where it is read); one already sent that is changed is sent
    /// again, as changed; one not yet read that is deleted is not sent; and
    /// the pull ends.
    #[test]
    fn records_written_between_the_steps_of_a_pull_are_neither_lost_nor_sent_for_ever() {
        let (sync, _db) = manager(None);
        let creates: Vec<SyncOp> = (0..1200)
            .map(|i| op(&format!("c{i}"), "notes", "create", &format!("n{i:04}"), serde_json::json!({"n": i})))
            .collect();
        for batch in creates.chunks(400) {
            assert_eq!(acked(&sync.handle_sync_push(batch.to_vec(), "a")).len(), 400);
        }
        let mut pull = sync.start_pull(&["notes".to_string()], None, None, None).unwrap();
        let mut sent: Vec<(String, serde_json::Value)> = Vec::new();
        let take = |message: ServerMessage, sent: &mut Vec<(String, serde_json::Value)>| {
            let ServerMessage::SyncState { records, .. } = message else { panic!("{message:?}") };
            sent.extend(records.iter().map(|r| (r["id"].as_str().unwrap().to_string(), r["data"].clone())));
        };
        take(sync.pull_step(&mut pull).unwrap(), &mut sent);
        assert_eq!(sent.len(), 500);
        let pushed = sync.handle_sync_push(vec![
            op("u-unread", "notes", "update", "n0800", serde_json::json!({"edited": true})),
            op("u-sent", "notes", "update", "n0010", serde_json::json!({"edited": true})),
            op("d-unread", "notes", "delete", "n0900", serde_json::json!({})),
        ], "b");
        assert_eq!(acked(&pushed).len(), 3, "{pushed:?}");
        let mut steps = 1;
        while let Some(message) = sync.pull_step(&mut pull) {
            take(message, &mut sent);
            steps += 1;
            assert!(steps < 50, "the pull did not end");
        }
        let of = |id: &str| -> Vec<&serde_json::Value> { sent.iter().filter(|(sent_id, _)| sent_id == id).map(|(_, data)| data).collect() };
        assert_eq!(of("n0800"), vec![&serde_json::json!({"n": 800, "edited": true})]);
        assert_eq!(of("n0010"), vec![&serde_json::json!({"n": 10}), &serde_json::json!({"n": 10, "edited": true})]);
        assert!(of("n0900").is_empty());
        for i in (0..1200).filter(|i| ![800, 10, 900].contains(i)) {
            assert_eq!(of(&format!("n{i:04}")).len(), 1, "n{i:04}");
        }
    }

    /// Naming one collection many times in one pull used to read it that many
    /// times into memory: a 4 MB message could hold a hundred thousand names.
    #[test]
    fn a_pull_reads_each_collection_once_and_bounds_how_many() {
        let (sync, db) = manager(None);
        db.write().upsert_record(xdb::Record {
            id: "a".into(), collection: "notes".into(), data: serde_json::json!({}),
            created_at: "2026-01-01T00:00:00Z".into(), updated_at: "2026-01-01T00:00:00Z".into(), deleted: false,
        }).unwrap();
        let repeated: Vec<String> = std::iter::repeat_n("notes".to_string(), 5_000).collect();
        let messages = sync.handle_sync_pull(&repeated, None, None, None);
        assert_eq!(messages.len(), 1, "one sync_state for one distinct collection");
        let many: Vec<String> = (0..MAX_PULL_COLLECTIONS + 1).map(|i| format!("c{i}")).collect();
        let messages = sync.handle_sync_pull(&many, None, None, None);
        assert!(matches!(messages.as_slice(), [ServerMessage::Error { .. }]), "{} messages", messages.len());
    }
}
