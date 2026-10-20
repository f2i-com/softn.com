use crate::limiter::{limiter_key, AddressLimiter};
use crate::pool::{self, ServerDb};
use crate::runtime::ServerRuntime;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
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

/// Maximum byte size of an individual SyncOp's `data` field (512KB), and of
/// the record an update merges into (see the "update" arm of
/// `store_sync_push`). The 4 MiB message limit (http.rs MAX_WS_MESSAGE_SIZE)
/// already bounds what one push carries; this bounds one record. Without it
/// one op could be the whole 4 MiB, a record could grow past any message the
/// client takes by merged updates of new keys, and the hooks, the CRDT
/// document and every pull would carry it.
pub(crate) const MAX_OP_DATA_BYTES: usize = 512 * 1024;

/// Maximum total bytes of all op data payloads in a single sync_push batch.
/// Bounds the total memory consumed during the DB write transaction to prevent
/// excessive SQLite WAL writer lock hold times. Individual ops are capped by
/// MAX_OP_DATA_BYTES; this caps the aggregate. Defense-in-depth alongside the
/// 4MB MAX_WS_MESSAGE_SIZE WebSocket frame limit.
pub(crate) const MAX_BATCH_DATA_BYTES: usize = 4 * 1024 * 1024;

/// Maximum records per SyncState message to prevent oversized WebSocket frames
/// and server-side RAM spikes. With ~200-500 bytes per JSON record, 500 records
/// ≈ 100-250KB per message — well within the 4MB MAX_WS_MESSAGE_SIZE limit.
/// Multiple SyncState messages are sent for the same collection when there are
/// more records than this limit.
const SYNC_PULL_CHUNK_SIZE: usize = 500;

/// Serialized bytes per `sync_state` and per `sync_delta` message. The client
/// discards any message over the 4 MiB both sides hold messages to
/// (`sync-protocol.json`, `xdb-server-sync.ts` MAX_MESSAGE_BYTES), so a chunk
/// bounded by count alone — 500 records of up to 512 KB each — could be a
/// 256 MB frame the client drops, leaving that collection never synced. One
/// record larger than this still travels alone; only a record written by the
/// server itself (a route's `db.update`, which is not held to
/// MAX_OP_DATA_BYTES) can be larger than a client takes.
pub(crate) const SYNC_PULL_CHUNK_BYTES: usize = 1024 * 1024;

/// Distinct collections one sync_pull may name. Each is a query of up to
/// 10,000 rows held in memory; the names are deduplicated first, since one
/// 4 MB message could otherwise repeat a collection a hundred thousand times.
pub(crate) const MAX_PULL_COLLECTIONS: usize = 100;

/// How long a client is asked to wait before it asks again for something
/// the host refused for now (a busy host, a step that timed out), in
/// seconds: `retryAfter` on a typed refusal.
const RETRY_AFTER_SECS: u64 = 2;

/// Ops a push stored that the host remembers, so that one sent again (its
/// acknowledgement lost, or a refusal of something else taken for its own)
/// is acknowledged and not applied, broadcast and hooked a second time.
/// Remembered for RECENT_OPS_TTL, at most RECENT_OPS of them.
const RECENT_OPS: usize = 10_000;
const RECENT_OPS_TTL: std::time::Duration = std::time::Duration::from_secs(15 * 60);

/// Maximum allowed clock drift from clients into the future (in seconds).
/// Timestamps further ahead than this are clamped to server time to prevent
/// far-future timestamps from permanently winning in LWW conflict resolution.
/// Past timestamps are always trusted — they represent legitimate offline edits.
const MAX_FUTURE_DRIFT_SECS: i64 = 5 * 60; // 5 minutes

/// Whether an edit stamped `op_time` was made before the record's last
/// change, stamped `record_time`: the edit was overtaken, and does not apply.
/// Compared as times, not as text: a client writes `…Z` to the millisecond,
/// and a record written by xdb's own update carries the server's clock as
/// `+00:00` to the nanosecond. So they are compared to the millisecond, the
/// finest a client can stamp: an edit made in the same millisecond as a
/// server write, after it, is not overtaken by digits it could not have
/// written. A time that does not parse decides nothing, and the op applies
/// as it did before edits were weighed.
fn overtaken(op_time: &str, record_time: &str) -> bool {
    match (
        chrono::DateTime::parse_from_rfc3339(op_time),
        chrono::DateTime::parse_from_rfc3339(record_time),
    ) {
        (Ok(op), Ok(record)) => op.timestamp_millis() < record.timestamp_millis(),
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

/// An update or a delete refused for good, by the record it names. Its pusher
/// has applied it to its own copy already, and is sent the record as it
/// stands, which puts that copy right: a refused edit used to stay on the
/// device that made it, since no later pull brings a record that has not
/// changed. A refused create is left alone: the server has no record to send,
/// and a delete would take away what the person made, which the app is told
/// was refused (`sync_reject`).
struct Refused {
    op_id: String,
    collection: String,
    record_id: String,
}

impl Refused {
    fn of(op: &SyncOp) -> Option<Self> {
        let names_a_record = matches!(op.operation.as_str(), "update" | "delete")
            && is_valid_collection_name(&op.collection)
            && !op.record_id.is_empty();
        names_a_record.then(|| Refused { op_id: op.id.clone(), collection: op.collection.clone(), record_id: op.record_id.clone() })
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
/// The client holds the names it asks for to the same rule
/// (`sync-protocol.json` `collectionName`).
pub(crate) fn is_valid_collection_name(name: &str) -> bool {
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
    /// Something the host could not do. A refused pull says so (`for:
    /// "pull"`), names the collections it did not finish and, when asking
    /// again later may work, how many seconds to wait (`retryAfter`): a
    /// client that knows them asks again for those collections and leaves
    /// its pushes alone. A client from before reads the message alone, as
    /// it always has. A push that could not be taken is answered
    /// `sync_retry` with its op ids instead (see ws.rs), which every client
    /// already reads.
    #[serde(rename = "error")]
    Error {
        message: String,
        #[serde(rename = "for", skip_serializing_if = "Option::is_none")]
        refused: Option<&'static str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        collections: Option<Vec<String>>,
        #[serde(rename = "retryAfter", skip_serializing_if = "Option::is_none")]
        retry_after: Option<u64>,
    },
}

impl ServerMessage {
    /// An error that answers nothing in particular.
    pub fn error(message: impl Into<String>) -> Self {
        ServerMessage::Error { message: message.into(), refused: None, collections: None, retry_after: None }
    }

    /// A pull, or the rest of one, refused: `collections` were not (all)
    /// sent. `retry` says whether asking again later may work.
    pub fn pull_refused(message: impl Into<String>, collections: Vec<String>, retry: bool) -> Self {
        ServerMessage::Error {
            message: message.into(),
            refused: Some("pull"),
            collections: Some(collections),
            retry_after: retry.then_some(RETRY_AFTER_SECS),
        }
    }

    /// A push of these ops not taken this time, for the client to send again.
    pub fn push_retry(op_ids: Vec<String>, reason: impl Into<String>) -> Self {
        ServerMessage::SyncRetry { op_ids, reason: reason.into() }
    }
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
    /// Every connection: a write the server made itself (a route's or a
    /// hook's `db.*`, bridges/db.rs).
    All,
}

impl Audience {
    pub fn reaches(&self, client_id: &str) -> bool {
        match self {
            Audience::Others(sender) => sender != client_id,
            Audience::Only(target) => target == client_id,
            Audience::All => true,
        }
    }
}

/// The sync stream: what every connection reads, in the order the store
/// wrote it. Made before the script runtime, whose `db` bridge writes into
/// it, and handed to the [`SyncManager`].
pub type SyncStream = broadcast::Sender<(Audience, Arc<ServerMessage>)>;

/// A new, empty sync stream.
pub fn sync_stream() -> SyncStream {
    broadcast::channel(256).0
}

/// `ops` as `sync_delta` messages in order, each at most
/// SYNC_PULL_CHUNK_BYTES serialized, as a pull's messages are: one op larger
/// than that goes alone. A push of up to 4 MiB of data, or the records as
/// they stand for every op of one, used to be one message, which a client
/// that takes messages of a few megabytes at most dropped whole.
pub fn delta_pieces(ops: Vec<SyncOp>) -> Vec<ServerMessage> {
    let mut pieces = Vec::new();
    let mut piece: Vec<SyncOp> = Vec::new();
    let mut bytes = 0usize;
    for op in ops {
        let size = serde_json::to_vec(&op).map(|b| b.len() + 1).unwrap_or(0);
        if !piece.is_empty() && bytes + size > SYNC_PULL_CHUNK_BYTES {
            pieces.push(ServerMessage::SyncDelta { ops: std::mem::take(&mut piece) });
            bytes = 0;
        }
        bytes += size;
        piece.push(op);
    }
    if !piece.is_empty() {
        pieces.push(ServerMessage::SyncDelta { ops: piece });
    }
    pieces
}

/// Send each of `messages` to `audience` on the stream, in order.
pub fn send_all(stream: &SyncStream, audience: &Audience, messages: Vec<ServerMessage>) {
    for message in messages {
        let _ = stream.send((audience.clone(), Arc::new(message)));
    }
}

/// The ops a push stored, by (op id, collection, record id), for a while
/// (RECENT_OPS, RECENT_OPS_TTL). Client op ids are only unique per device,
/// hence the record in the key.
#[derive(Default)]
struct RecentOps {
    seen: std::collections::HashMap<(String, String, String), std::time::Instant>,
    order: std::collections::VecDeque<((String, String, String), std::time::Instant)>,
}

impl RecentOps {
    fn key(op: &SyncOp) -> (String, String, String) {
        (op.id.clone(), op.collection.clone(), op.record_id.clone())
    }

    fn contains(&mut self, op: &SyncOp, now: std::time::Instant) -> bool {
        self.expire(now);
        self.seen.contains_key(&Self::key(op))
    }

    fn remember(&mut self, op: &SyncOp, now: std::time::Instant) {
        let key = Self::key(op);
        self.seen.insert(key.clone(), now);
        self.order.push_back((key, now));
        while self.order.len() > RECENT_OPS {
            self.forget_oldest();
        }
    }

    fn expire(&mut self, now: std::time::Instant) {
        while self.order.front().is_some_and(|(_, at)| now.duration_since(*at) > RECENT_OPS_TTL) {
            self.forget_oldest();
        }
    }

    fn forget_oldest(&mut self) {
        if let Some((key, at)) = self.order.pop_front() {
            // Remembered again since: that later entry keeps it.
            if self.seen.get(&key) == Some(&at) {
                self.seen.remove(&key);
            }
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
    /// The collections this pull has not finished sending: what a refusal
    /// part-way names, for the client to ask for again.
    pub fn remaining(&self) -> Vec<String> {
        self.collections.get(self.next..).map(<[String]>::to_vec).unwrap_or_default()
    }

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
    broadcast_tx: SyncStream,
    /// Ops recently stored, so that one sent again is not applied again.
    recent_ops: std::sync::Mutex<RecentOps>,
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
    /// A manager with a stream of its own: for a host whose script cannot
    /// write records (none, or tests).
    #[cfg(test)]
    pub fn new(
        db: ServerDb,
        runtime: Option<Arc<ServerRuntime>>,
        auth_token: Option<String>,
        db_path: PathBuf,
        settings: SyncSettings,
    ) -> Arc<Self> {
        Self::with_stream(db, runtime, auth_token, db_path, settings, sync_stream())
    }

    /// A manager whose connections read `stream`, which the script's `db`
    /// bridge also writes the server's own writes into.
    pub fn with_stream(
        db: ServerDb,
        runtime: Option<Arc<ServerRuntime>>,
        auth_token: Option<String>,
        db_path: PathBuf,
        settings: SyncSettings,
        broadcast_tx: SyncStream,
    ) -> Arc<Self> {
        let SyncSettings { max_storage_bytes, sync_permits: max_sync_permits, force_server_timestamps, max_connections, max_connections_per_visitor } = settings;

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
            recent_ops: std::sync::Mutex::new(RecentOps::default()),
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

    /// Check `token` against the host's own, if it has one, and name the new client.
    pub fn handle_auth(&self, token: Option<&str>) -> Result<String, String> {
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
        let client_id = self.handle_auth(token).map_err(|_| TicketError::Unauthorized)?;

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
    /// the host received after that point (incremental sync, including
    /// soft-deleted records so the client can remove them locally), at most
    /// a page of each collection. Otherwise returns all non-deleted records
    /// (full sync for first-time connections), a page at a time.
    /// The point is the host's own receipt time, `server_received_at`, which
    /// every record a pull sends carries as `serverReceivedAt` (pool.rs
    /// [`pool::SyncFrom`]), never `updated_at`, which is the edit's time and
    /// may be long before the host saw it. `last_id` forms a compound cursor
    /// with `last_sync` to handle ties: records received in one millisecond
    /// are read in id order, and one a page ended among is not passed over.
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
            return Err(ServerMessage::pull_refused(
                format!("Too many collections in one sync_pull ({}, max {})", collections.len(), MAX_PULL_COLLECTIONS),
                collections,
                false,
            ));
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
                return Some(ServerMessage::pull_refused(format!("Invalid collection name: {}", collection), vec![collection], false));
            }

            // Read from the pool — concurrent with other reads and writes.
            let conn = match self.db.read() {
                Ok(c) => c,
                Err(e) => {
                    pull.next_collection();
                    return Some(ServerMessage::pull_refused(format!("Read pool error: {}", e), vec![collection], true));
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
        // Ops refused for good that name a record the pusher has applied
        // them to: it is sent the record as it stands (see below).
        let mut refused: Vec<Refused> = Vec::new();
        // Ops whose data a before-hook changed: their pusher is sent the
        // record as stored.
        let mut hook_changed: HashSet<String> = HashSet::new();

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

            // Reject oversized data payloads before any further processing
            // (MAX_OP_DATA_BYTES says why).
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
                    refused.extend(Refused::of(&op));
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
            self.call_before_sync_batch(basic_valid_ops, &mut responses, &mut refused, &mut hook_changed)
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
                        refused.extend(Refused::of(&op));
                    }
                    Ok((true, Some(new_data))) => {
                        op.data = Some(new_data);
                        hook_changed.insert(op.id.clone());
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
        // The acknowledgement of ops answered with their records, and those
        // records as they stand, for the pusher alone.
        let mut to_pusher: Option<(Vec<String>, Vec<SyncOp>)> = None;
        let mut acked_in_stream: HashSet<String> = HashSet::new();
        if !validated_ops.is_empty() || !refused.is_empty() {
            // Collect op IDs before moving ops into the transaction closure,
            // so we can reference them in error paths after the move.
            let all_op_ids: Vec<String> = validated_ops.iter().map(|op| op.id.clone()).collect();
            let mut db = self.db.write();
            // Taken under the writer lock, so a push stored and remembered
            // here is remembered before the next push is weighed.
            let mut recent = self.recent_ops.lock().unwrap_or_else(|p| p.into_inner());
            let now = std::time::Instant::now();

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
                // Ops stored as a before-hook changed them, by record: their
                // pusher is sent the record as stored.
                let mut batch_hooked: Vec<(String, String)> = Vec::new();

                for op in validated_ops {
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
                    // Stored already, and nothing newer since: sent again
                    // after its acknowledgement was lost, or after a refusal
                    // of something else (an older client takes any `error`
                    // for its pushes). An update or a delete applied again
                    // was broadcast and hooked again. Asked only here, once
                    // the op would otherwise be applied: one overtaken since
                    // is answered above with the record as it stands, which
                    // its pusher, holding its own edit, needs.
                    if recent.contains(&op, now) {
                        batch_replayed.push(op.id.clone());
                        continue;
                    }
                    let result: Result<(), xdb::DbError> = match op.operation.as_str() {
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
                            db.upsert_record(record).map(|_| ())
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
                                    refused.extend(Refused::of(&op));
                                    continue;
                                }
                                db.upsert_record(xdb::Record { data, updated_at: op.timestamp.clone(), ..record }).map(|_| ())
                            }
                            _ => Err(xdb::DbError::NotFound(op.record_id.clone())),
                        },
                        "delete" => match existing {
                            Some(record) => db.upsert_record(xdb::Record { updated_at: op.timestamp.clone(), deleted: true, ..record }).map(|_| ()),
                            None => Err(xdb::DbError::NotFound(op.record_id.clone())),
                        },
                        // Checked against VALID_OPERATIONS before the hooks,
                        // which change an op's data and nothing else.
                        _ => unreachable!("an op's operation is checked before it is stored"),
                    };

                    match result {
                        Ok(()) => {
                            if hook_changed.contains(&op.id) {
                                batch_hooked.push((op.record_id.clone(), op.id.clone()));
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
                // push for the same record is part of what is sent. A record
                // is sent once, under the first op that asks for it.
                let mut batch_current: Vec<SyncOp> = Vec::new();
                let mut sent = HashSet::new();
                let mut send = |db: &xdb::XdbDatabase, id: &str, collection: Option<&str>, answering: String, current: &mut Vec<SyncOp>| {
                    if !sent.insert(id.to_string()) {
                        return;
                    }
                    if let Ok(record) = db.get_record(id) {
                        // A refused op names its collection; a record of
                        // another is not this client's to be sent.
                        if collection.is_none_or(|c| c == record.collection) {
                            current.push(as_it_stands(record, answering));
                        }
                    }
                };
                for (id, answering) in batch_overtaken {
                    send(db, &id, None, answering, &mut batch_current);
                }
                for (id, answering) in batch_hooked {
                    send(db, &id, None, answering, &mut batch_current);
                }
                for Refused { op_id, collection, record_id } in refused {
                    send(db, &record_id, Some(&collection), op_id, &mut batch_current);
                }

                Ok((batch_accepted, batch_rejected, batch_replayed, batch_current))
            });

            match batch_result {
                Ok((batch_accepted, batch_rejected, batch_replayed, batch_current)) => {
                    for op in &batch_accepted {
                        recent.remember(op, now);
                    }
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
                        // Sent below, with the stream of other clients' edits,
                        // and so is the acknowledgement of the ops a hook
                        // changed: the record answers them.
                        acked_in_stream.extend(batch_accepted.iter().filter(|op| hook_changed.contains(&op.id)).map(|op| op.id.clone()));
                        let mut acked = batch_replayed;
                        acked.extend(acked_in_stream.iter().cloned());
                        to_pusher = Some((acked, batch_current));
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
            drop(recent);
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
            // in the answer: a client keeps a record it deleted hidden, and
            // one it edited as it edited it, only while that op is
            // unanswered, so a skipped op's record comes back on the device
            // that pushed it (`XDBServerSync.unansweredChanges` in
            // @softn/core).
            //
            // The same goes for an op a before-hook changed (the pusher
            // holds what it sent, not what was stored) and for an update or
            // a delete refused for good (see `Refused`). The records go in
            // pieces a client takes (`delta_pieces`): all of them in one
            // message could be several megabytes, which the client dropped,
            // keeping the edits the host had overruled.
            if let Some((acked, current)) = to_pusher {
                let pusher = Audience::Only(client_id.to_string());
                if !acked.is_empty() {
                    let _ = self.broadcast_tx.send((pusher.clone(), Arc::new(ServerMessage::SyncAck { op_ids: acked })));
                }
                send_all(&self.broadcast_tx, &pusher, delta_pieces(current));
            }
            // Broadcast to the other clients while the writer lock is still
            // held, so that pushes are sent on in the order they were stored.
            // It was done once the lock had been let go, after the ops were
            // copied: a push stored second could be sent first, and a client,
            // which applies what it is sent as it comes, was left with the
            // older of two edits to one record. Sending waits for nobody.
            // In pieces, as above: a push may carry 4 MiB of data.
            if !accepted_ops.is_empty() {
                send_all(&self.broadcast_tx, &Audience::Others(client_id.to_string()), delta_pieces(accepted_ops.clone()));
            }
            drop(db);
        }

        // Acknowledge accepted ops to the pushing client. Phase 3, the
        // after-hooks, is the caller's to run once this answer is on its way
        // (run_after_sync). An op a hook changed was acknowledged above,
        // just before its record, when the record could be read.
        if !accepted_ops.is_empty() {
            let ack_ids: Vec<String> = accepted_ops.iter().filter(|op| !acked_in_stream.contains(&op.id)).map(|op| op.id.clone()).collect();
            if !ack_ids.is_empty() {
                responses.push(ServerMessage::SyncAck { op_ids: ack_ids });
            }
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
    ///
    /// The ops it refuses are added to `refused`, and those whose data it
    /// changed to `changed`.
    fn call_before_sync_batch(
        &self,
        ops: Vec<SyncOp>,
        responses: &mut Vec<ServerMessage>,
        refused: &mut Vec<Refused>,
        changed: &mut HashSet<String>,
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
                        refused.extend(Refused::of(op));
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
                refused.extend(Refused::of(&op));
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
                    let mut retried = HashSet::new();
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
                                retried.insert(op.id.clone());
                                continue;
                            }
                            op.data = Some(new_data.clone());
                            changed.insert(op.id.clone());
                        }
                    }
                    accepted.retain(|op| !retried.contains(&op.id));
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
#[path = "sync_tests.rs"]
mod tests;
