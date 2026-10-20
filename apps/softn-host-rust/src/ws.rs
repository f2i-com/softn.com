use crate::sync::{is_valid_collection_name, Audience, ServerMessage, SyncManager, SyncOp};
use crate::util;
use axum::extract::ws::{CloseFrame, Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use std::collections::HashSet;
use std::sync::Arc;
use tokio::sync::{broadcast, mpsc, watch};

/// Timeout for sync_pull / sync_push blocking tasks.
///
/// Must exceed the runtime's own wait so this never fires on a push that was
/// going to answer: the timeout does not cancel the blocking task, so it would
/// go on to commit and broadcast after the client had been told it timed out —
/// and the client, still holding those op ids, would push them again.
const HANDLER_TIMEOUT: std::time::Duration =
    crate::runtime::MAX_CALL_WAIT.saturating_add(std::time::Duration::from_secs(10));
/// Ops one `sync_push` may carry (`sync-protocol.json` `maxOpsPerPush`).
pub(crate) const MAX_OPS_PER_PUSH: usize = 1000;
/// Collections a connection's subscription may name; past this it is sent
/// every collection's deltas, as before subscriptions were read.
const MAX_SUBSCRIBED: usize = 1024;
/// How long a socket closed for a frame it refused is kept open, unread,
/// once its Close frame is sent (see handle_ws).
const REFUSED_FRAME_LINGER: std::time::Duration = std::time::Duration::from_secs(1);
/// If no data is received from the client within this period, assume the
/// connection is dead (e.g. mobile lost signal, laptop asleep) and clean up.
const IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(90);
/// Outbound channel capacity: room for a push's answers (one a refused op)
/// without holding up the reader. A pull's messages are held to
/// PULL_MESSAGES_HELD of it.
const OUT_CHANNEL_SIZE: usize = 512;
/// How many messages of a pull a connection holds at once: the one leaving
/// and the next, read while it leaves. A pull was read as fast as the store
/// gave it, into the outbound channel, so a client that asked for a large
/// pull and stopped reading had up to OUT_CHANNEL_SIZE messages of up to a
/// megabyte each held for it until its socket was given up on.
const PULL_MESSAGES_HELD: usize = 2;
/// Timeout for sending single-message responses (errors, acks, etc.).
/// If the writer can't drain within this, the client is irrecoverably slow.
const SEND_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
/// Timeout for sending bulk transfer responses (sync_pull, sync_push).
/// Mobile clients on slow networks (3G) may legitimately need longer to
/// drain large SyncState payloads. Using the tight SEND_TIMEOUT for these
/// would trap them in a disconnect → reconnect → heavy payload → timeout loop.
const SEND_TIMEOUT_BULK: std::time::Duration = std::time::Duration::from_secs(15);
/// How long to wait for a sync permit before returning "server busy".
/// A short wait smooths out micro-bursts (e.g. dozens of clients reconnecting
/// after a network partition resolves) without hanging the connection.
const PERMIT_WAIT: std::time::Duration = std::time::Duration::from_secs(2);
/// Server-to-client Ping interval. Browser WebSocket APIs cannot send Ping
/// frames, so without server-initiated pings an idle (but healthy) browser
/// client would hit IDLE_TIMEOUT and be disconnected. The browser's built-in
/// Pong reply resets the reader's idle timer automatically.
const PING_INTERVAL: std::time::Duration = std::time::Duration::from_secs(30);
/// The longest one message may take to leave. The stream under the socket
/// already fails a write that makes no progress for 30 seconds
/// (`http::StallGuard`), so this is the outer bound, generous enough for a
/// megabyte over a poor mobile link.
const WRITER_SEND_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);
/// How long the writer is given to finish once the reader has gone.
const WRITER_DRAIN: std::time::Duration = SEND_TIMEOUT_BULK;
/// How long a pull waits for one of its messages to leave before it reads
/// the next: as long as the writer gives one message, and a little more.
/// A writer that gives up drops what it holds, and the wait ends then.
const PULL_PLACE_WAIT: std::time::Duration = WRITER_SEND_TIMEOUT.saturating_add(SEND_TIMEOUT);

/// A message for the writer. A pull's message carries its place among the
/// pull's PULL_MESSAGES_HELD, given back once the message has left (or the
/// writer has given up and dropped it).
struct Outbound {
    message: ServerMessage,
    place: Option<tokio::sync::OwnedSemaphorePermit>,
}

impl From<ServerMessage> for Outbound {
    fn from(message: ServerMessage) -> Self {
        Outbound { message, place: None }
    }
}

/// Why a connection is being closed, for its Close frame: a code and a
/// reason (at most 123 bytes).
type CloseReason = (u16, String);

/// The collections whose deltas a connection is sent: every collection
/// (None) until the client names the ones it wants with `subscribe`, then
/// those and every collection it pulls or pushes to after that. The host
/// used to ignore `subscribe` and send each client every delta, which it
/// applied, collections it had not asked for included. A client from before
/// subscribes with the collections it knows when it connects and starts
/// using others later: one it pulls or pushes to is one it is sent.
#[derive(Clone, Default)]
struct Subscription(Arc<std::sync::Mutex<Option<HashSet<String>>>>);

impl Subscription {
    fn lock(&self) -> std::sync::MutexGuard<'_, Option<HashSet<String>>> {
        self.0.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// The client said which collections it wants.
    fn set(&self, collections: &[String]) {
        let names: HashSet<String> = collections.iter().filter(|c| is_valid_collection_name(c)).cloned().collect();
        *self.lock() = (names.len() <= MAX_SUBSCRIBED).then_some(names);
    }

    /// The client pulled or pushed to these.
    fn add<'a>(&self, collections: impl IntoIterator<Item = &'a str>) {
        let mut subscribed = self.lock();
        if let Some(names) = subscribed.as_mut() {
            for collection in collections {
                if is_valid_collection_name(collection) && !names.contains(collection) {
                    names.insert(collection.to_string());
                }
            }
            if names.len() > MAX_SUBSCRIBED {
                *subscribed = None;
            }
        }
    }

    /// What of `message` is for this connection, or None if nothing is. What
    /// the store says to this connection alone is never held back.
    fn admit(&self, audience: &Audience, message: &Arc<ServerMessage>) -> Option<Arc<ServerMessage>> {
        let ServerMessage::SyncDelta { ops } = &**message else { return Some(message.clone()) };
        if matches!(audience, Audience::Only(_)) {
            return Some(message.clone());
        }
        let subscribed = self.lock();
        let Some(names) = subscribed.as_ref() else { return Some(message.clone()) };
        if ops.iter().all(|op| names.contains(&op.collection)) {
            return Some(message.clone());
        }
        let kept: Vec<SyncOp> = ops.iter().filter(|op| names.contains(&op.collection)).cloned().collect();
        (!kept.is_empty()).then(|| Arc::new(ServerMessage::SyncDelta { ops: kept }))
    }
}

/// The Close frame for a frame the WebSocket layer refused: 1009 for a
/// message over MAX_WS_MESSAGE_SIZE, 1007 for text that is not UTF-8, 1002
/// for anything else the protocol does not allow. None when the connection
/// itself failed, and there is nobody to tell. The reader used to pass over
/// every such error and read on, and the socket closed as a normal closure
/// (1000), or, for a message over the limit, with no Close frame at all.
fn refused_frame(error: axum::Error) -> Option<CloseReason> {
    let error = error.into_inner();
    match error.downcast_ref::<tungstenite::Error>()? {
        tungstenite::Error::Capacity(_) => Some((1009, format!("Message too big (over {} bytes)", crate::http::MAX_WS_MESSAGE_SIZE))),
        tungstenite::Error::Utf8(_) => Some((1007, "A text message was not valid UTF-8".into())),
        tungstenite::Error::Protocol(_) => Some((1002, "WebSocket protocol error".into())),
        _ => None,
    }
}

/// The sink, with a deadline on everything sent through it.
///
/// No send had one. A peer that asked for a pull and stopped reading (a phone
/// in a tunnel that never sent FIN, or one doing it on purpose) left the
/// writer inside `send` until TCP gave up, which for a zero window is never:
/// the connection's slot under `maxSyncConnections`, its socket and up to
/// 512 queued messages stayed held, and a few such behind one address were
/// 429 for everyone there. After the first send that fails or runs out of
/// time, every later one fails at once: there is nobody to say goodbye to.
struct Deadlined<S> {
    sink: S,
    limit: std::time::Duration,
    dead: bool,
}

impl<S: futures_util::Sink<Message> + Unpin> Deadlined<S> {
    async fn within<F: std::future::Future<Output = Result<(), S::Error>>>(limit: std::time::Duration, dead: &mut bool, work: F) -> Result<(), ()> {
        if *dead {
            return Err(());
        }
        match tokio::time::timeout(limit, work).await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(_)) => {
                *dead = true;
                Err(())
            }
            Err(_) => {
                tracing::warn!("A sync peer took nothing for {}s — dropping the connection", limit.as_secs());
                *dead = true;
                Err(())
            }
        }
    }

    async fn send(&mut self, message: Message) -> Result<(), ()> {
        Self::within(self.limit, &mut self.dead, self.sink.send(message)).await
    }

    async fn close(&mut self) -> Result<(), ()> {
        Self::within(self.limit, &mut self.dead, self.sink.close()).await
    }
}

/// Wait for the writer to finish, for `wait` and no longer, then end it.
/// The reader has gone, so nothing more is coming for it to send.
async fn finish_writer(mut writer: tokio::task::JoinHandle<()>, wait: std::time::Duration) {
    if tokio::time::timeout(wait, &mut writer).await.is_err() {
        writer.abort();
        let _ = writer.await;
    }
}

/// Send a direct response (sync_pull/sync_push result) to the writer task.
/// Uses an async send with a timeout — these are responses the client is
/// actively waiting for, so we must not silently drop them.
///
/// Returns false if the channel is closed or the send times out, signaling
/// the caller to **drop the connection immediately**. A failed send means the
/// client is irrecoverably slow; dropping forces a reconnect and fresh sync.
///
/// On timeout, sets the close reason on `close_reason_tx` so the writer task
/// can include it in the Close frame. This bypasses the full outbound channel
/// via a dedicated watch channel, guaranteeing the reason is delivered even
/// when the mpsc channel is completely full.
async fn send_response(
    out_tx: &mpsc::Sender<Outbound>,
    close_reason_tx: &watch::Sender<Option<CloseReason>>,
    msg: ServerMessage,
) -> bool {
    send_response_with_timeout(out_tx, close_reason_tx, msg.into(), SEND_TIMEOUT).await
}

/// Like `send_response` but with a caller-specified timeout.
/// Used for bulk transfers (sync_pull/sync_push) where slow mobile clients
/// need more time to drain large payloads without being disconnected.
async fn send_response_with_timeout(
    out_tx: &mpsc::Sender<Outbound>,
    close_reason_tx: &watch::Sender<Option<CloseReason>>,
    msg: Outbound,
    timeout: std::time::Duration,
) -> bool {
    match tokio::time::timeout(timeout, out_tx.send(msg)).await {
        Ok(Ok(())) => true,
        Ok(Err(_)) => {
            tracing::warn!("WebSocket outbound channel closed — dropping connection");
            false
        }
        Err(_) => {
            tracing::warn!("WebSocket send timed out ({}s) — dropping connection to force re-sync", timeout.as_secs());
            // Signal the close reason via a dedicated watch channel that bypasses
            // the full mpsc queue. The writer reads this when out_rx returns None.
            let _ = close_reason_tx.send(Some((1000, "Connection too slow — disconnecting to force re-sync".into())));
            false
        }
    }
}

/// Handle an authenticated WebSocket connection.
/// Auth is performed during the HTTP upgrade phase (see http::ws_upgrade),
/// so `cid` is already validated before this function is called.
/// `_conn_guard` is held for the lifetime of the connection — when dropped,
/// it signals the shutdown drain that this connection has closed. `_slot` is
/// the connection's place under `maxSyncConnections`, returned on drop.
pub async fn handle_ws(
    socket: WebSocket,
    sync: Arc<SyncManager>,
    shutdown_rx: watch::Receiver<bool>,
    cid: String,
    _conn_guard: tokio::sync::mpsc::Sender<()>,
    _slot: crate::sync::ConnectionSlot,
) {
    let (mut ws_tx, mut ws_rx) = socket.split();

    // Connection is pre-authenticated — send auth_ok immediately so the
    // client receives its client_id and server time.
    let msg = ServerMessage::AuthOk {
        client_id: cid.clone(),
        server_time: iso_now(),
    };
    if let Ok(json) = serde_json::to_string(&msg) {
        if !matches!(tokio::time::timeout(SEND_TIMEOUT, ws_tx.send(Message::Text(json.into()))).await, Ok(Ok(()))) {
            return;
        }
    }
    tracing::info!("Client {} connected", cid);

    // Split into reader/writer actor tasks to prevent head-of-line blocking.
    // The writer task owns ws_tx and drains both broadcast messages and
    // outbound responses from the reader, so broadcast delivery is never
    // blocked by slow sync operations.
    let (out_tx, out_rx) = mpsc::channel::<Outbound>(OUT_CHANNEL_SIZE);
    let broadcast_rx = sync.subscribe();

    // Dedicated watch channel for terminal close reasons. When send_response
    // times out, the mpsc channel is likely full — so we use a separate watch
    // channel to deliver the close reason to the writer task, which reads it
    // when out_rx returns None (after out_tx is dropped).
    let (close_reason_tx, close_reason_rx) = watch::channel::<Option<CloseReason>>(None);
    // What the client has asked for, which the reader learns and the writer holds deltas to.
    let subscription = Subscription::default();

    let cid_for_writer = cid.clone();
    let writer_handle = tokio::spawn(writer_task(ws_tx, out_rx, broadcast_rx, cid_for_writer, shutdown_rx, close_reason_rx, subscription.clone(), WRITER_SEND_TIMEOUT));

    // Reader task: runs in the current task
    reader_task(&mut ws_rx, &sync, &cid, &out_tx, &close_reason_tx, &subscription).await;

    // Reader exited (client disconnected or error) — drop out_tx to signal writer
    drop(out_tx);
    finish_writer(writer_handle, WRITER_DRAIN).await;
    // A frame refused part-way through (a message over the limit) leaves the
    // rest of it unread. Closed at once, the socket resets the connection
    // while the client is still sending, and the reset can reach it before
    // the Close frame that says why (it saw 1006, no reason). It is held a
    // moment, unread, so the Close frame arrives first.
    let refused = close_reason_tx.borrow().as_ref().is_some_and(|(code, _)| *code != 1000);
    if refused {
        tokio::time::sleep(REFUSED_FRAME_LINGER).await;
    }
    drop(ws_rx);
    tracing::info!("Client {} disconnected", cid);
}

/// Writer task: owns the WebSocket sink and merges outbound messages from
/// the reader (via out_rx) and broadcast notifications (via broadcast_rx).
/// Also listens for the server shutdown signal to send a clean Close frame
/// before the process exits.
async fn writer_task<S: futures_util::Sink<Message> + Unpin>(
    sink: S,
    mut out_rx: mpsc::Receiver<Outbound>,
    mut broadcast_rx: broadcast::Receiver<(Audience, Arc<ServerMessage>)>,
    cid: String,
    mut shutdown_rx: watch::Receiver<bool>,
    close_reason_rx: watch::Receiver<Option<CloseReason>>,
    subscription: Subscription,
    send_limit: std::time::Duration,
) {
    let mut ws_tx = Deadlined { sink, limit: send_limit, dead: false };
    let mut ping_interval = tokio::time::interval(PING_INTERVAL);
    // First tick fires immediately — skip it so we don't ping right after connect.
    ping_interval.tick().await;

    loop {
        tokio::select! {
            // Messages from the reader (sync responses, errors, etc.)
            msg = out_rx.recv() => {
                match msg {
                    // A pull's place is given back as the message leaves.
                    Some(Outbound { message, place: _place }) => {
                        if let Ok(json) = serde_json::to_string(&message) {
                            if ws_tx.send(Message::Text(json.into())).await.is_err() {
                                break;
                            }
                        }
                    }
                    // Reader dropped out_tx — send a Close frame so the client
                    // sees a clean disconnect instead of an abrupt TCP close
                    // (covers both normal exit and send_response timeout).
                    None => {
                        // Check the watch channel for a terminal close reason
                        // (set by send_response on timeout, or by the reader
                        // for a frame it refused). Falls back to a generic
                        // reason for normal disconnects.
                        let (code, reason) = close_reason_rx.borrow().clone()
                            .unwrap_or_else(|| (1000, "Connection closing".into()));
                        let _ = ws_tx.send(Message::Close(Some(CloseFrame {
                            code,
                            reason: reason.into(),
                        }))).await;
                        break;
                    }
                }
            }
            // The sync stream: other clients' pushes, and what the store
            // said of this client's own (sync.rs Audience), held to the
            // collections the client asked for (Subscription).
            result = broadcast_rx.recv() => {
                match result {
                    Ok((audience, msg)) => {
                        // A push is not echoed back to its sender.
                        if let Some(msg) = audience.reaches(&cid).then(|| subscription.admit(&audience, &msg)).flatten() {
                            if let Ok(json) = serde_json::to_string(&*msg) {
                                if ws_tx.send(Message::Text(json.into())).await.is_err() {
                                    break;
                                }
                            }
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        tracing::warn!("Client {} lagged, missed {} messages — disconnecting to force re-sync", cid, n);
                        let msg = ServerMessage::error(format!("Missed {} messages, reconnect to re-sync", n));
                        if let Ok(json) = serde_json::to_string(&msg) {
                            let _ = ws_tx.send(Message::Text(json.into())).await;
                        }
                        break;
                    }
                    Err(broadcast::error::RecvError::Closed) => {
                        tracing::info!("Broadcast channel closed, disconnecting client {}", cid);
                        break;
                    }
                }
            }
            // Server-initiated keepalive ping. Browser WebSocket APIs cannot
            // send Ping frames, so without this an idle browser client would
            // hit the reader's IDLE_TIMEOUT and be disconnected. The browser
            // automatically replies with a Pong, which resets the idle timer.
            _ = ping_interval.tick() => {
                if ws_tx.send(Message::Ping(vec![].into())).await.is_err() {
                    break;
                }
            }
            // Server shutdown — send a clean Close frame before the process exits
            _ = shutdown_rx.changed() => {
                if *shutdown_rx.borrow() {
                    tracing::info!("Server shutting down, closing client {}", cid);
                    let msg = ServerMessage::error("Server shutting down");
                    if let Ok(json) = serde_json::to_string(&msg) {
                        let _ = ws_tx.send(Message::Text(json.into())).await;
                    }
                    // 1001 Going Away: the endpoint is leaving, which a
                    // client can tell from a normal close and reconnect to.
                    let _ = ws_tx.send(Message::Close(Some(CloseFrame {
                        code: 1001,
                        reason: "Server shutting down".into(),
                    }))).await;
                    break;
                }
            }
        }
    }
    // Attempt graceful close
    let _ = ws_tx.close().await;
}

/// Reader task: reads from the WebSocket and dispatches sync operations.
/// Sends responses through out_tx to the writer task.
/// Enforces an idle timeout to detect zombie connections (e.g. mobile losing
/// signal without sending a Close frame).
async fn reader_task(
    ws_rx: &mut futures_util::stream::SplitStream<WebSocket>,
    sync: &Arc<SyncManager>,
    cid: &str,
    out_tx: &mpsc::Sender<Outbound>,
    close_reason_tx: &watch::Sender<Option<CloseReason>>,
    subscription: &Subscription,
) {
    // The places a pull's messages take in this connection (PULL_MESSAGES_HELD).
    let pull_places = Arc::new(tokio::sync::Semaphore::new(PULL_MESSAGES_HELD));
    loop {
        // Idle timeout: if no data arrives within IDLE_TIMEOUT, assume the
        // connection is dead and break to trigger cleanup.
        let next = tokio::time::timeout(IDLE_TIMEOUT, ws_rx.next()).await;
        let msg = match next {
            Ok(msg) => msg,
            Err(_) => {
                tracing::info!("Client {} idle timeout ({}s) — disconnecting", cid, IDLE_TIMEOUT.as_secs());
                let _ = send_response(out_tx, close_reason_tx, ServerMessage::error("Idle timeout")).await;
                break;
            }
        };
        match msg {
            Some(Ok(Message::Text(text))) => {
                // Depth-bounded parse to prevent stack overflow from deeply nested payloads
                let parsed: serde_json::Value = match util::parse_json_bounded(&text, util::MAX_JSON_DEPTH) {
                    Ok(v) => v,
                    Err(_) => {
                        if !send_response(out_tx, close_reason_tx, ServerMessage::error("Invalid JSON")).await {
                            break;
                        }
                        continue;
                    }
                };

                let msg_type = parsed.get("type").and_then(|t| t.as_str()).unwrap_or("");

                match msg_type {
                    "sync_pull" => {
                        let collections: Vec<String> = parsed
                            .get("collections")
                            .and_then(|c| serde_json::from_value(c.clone()).ok())
                            .unwrap_or_default();
                        // Optional point for incremental sync: only records the
                        // host received after it are returned, deleted ones
                        // included. It is the host's own receipt time
                        // (`serverReceivedAt` on each record a pull sends,
                        // pool.rs SyncFrom), not the time of the edit.
                        let last_sync: Option<String> = parsed
                            .get("lastSync")
                            .and_then(|v| v.as_str())
                            .map(String::from);
                        // With `lastSync`, a compound cursor: of the records
                        // received in that millisecond, those after this id.
                        let last_id: Option<String> = parsed
                            .get("lastId")
                            .and_then(|v| v.as_str())
                            .map(String::from);
                        // Where a full pull continues from: the `more` of the
                        // last sync_state of a page that was full.
                        let cursor: Option<(String, String)> = parsed.get("cursor").and_then(|c| {
                            Some((c.get("at")?.as_str()?.to_string(), c.get("id")?.as_str()?.to_string()))
                        });

                        // A collection the client pulls is one it is sent the deltas of.
                        if collections.len() <= crate::sync::MAX_PULL_COLLECTIONS {
                            subscription.add(collections.iter().map(String::as_str));
                        }
                        let mut pull = match sync.start_pull(
                            &collections, last_sync.as_deref(), last_id.as_deref(),
                            cursor.as_ref().map(|(at, id)| (at.as_str(), id.as_str())),
                        ) {
                            Ok(pull) => pull,
                            Err(refusal) => {
                                if !send_response(out_tx, close_reason_tx, refusal).await {
                                    return;
                                }
                                continue;
                            }
                        };
                        // A message at a time (SyncManager::pull_step), each
                        // read once the one before has gone to the writer:
                        // what a pull holds is one message, not every
                        // collection it names.
                        let mut first = true;
                        loop {
                            // The next message is read once it has a place,
                            // which is once the message two before it has
                            // left: a pull goes as fast as its client takes
                            // it, and holds no sync permit while it waits.
                            let place = match tokio::time::timeout(PULL_PLACE_WAIT, pull_places.clone().acquire_owned()).await {
                                Ok(Ok(place)) => place,
                                _ => {
                                    tracing::warn!("A sync pull's messages were not taken for {}s — dropping the connection", PULL_PLACE_WAIT.as_secs());
                                    let _ = close_reason_tx.send(Some((1000, "Connection too slow — disconnecting to force re-sync".into())));
                                    return;
                                }
                            };
                            // A sync permit bounds concurrent blocking tasks.
                            // Without this, a flood of slow sync_pull requests could exhaust
                            // Tokio's 512-thread spawn_blocking pool, starving all other I/O.
                            // The first step waits briefly, to smooth out micro-bursts (e.g.
                            // dozens of clients reconnecting after a network partition)
                            // instead of immediately failing and forcing client-side retry
                            // logic; a pull under way waits for its turn, as long as a step
                            // may take, rather than stop part-way.
                            let wait = if first { PERMIT_WAIT } else { HANDLER_TIMEOUT };
                            first = false;
                            // What a refusal from here on names: the
                            // collections not yet sent whole. A client used to
                            // be told only "server busy", which it took for its
                            // pushes, and never asked for the pull again.
                            let remaining = pull.remaining();
                            let permit = match tokio::time::timeout(
                                wait,
                                sync.sync_permits.clone().acquire_owned(),
                            ).await {
                                Ok(Ok(p)) => p,
                                _ => {
                                    if !send_response(out_tx, close_reason_tx, ServerMessage::pull_refused(
                                        "Server busy — too many concurrent sync operations, retry later", remaining, true,
                                    )).await {
                                        return;
                                    }
                                    break;
                                }
                            };
                            let sync_clone = sync.clone();
                            let step = tokio::time::timeout(
                                HANDLER_TIMEOUT,
                                tokio::task::spawn_blocking(move || {
                                    let _permit = permit; // held for this step only
                                    let message = sync_clone.pull_step(&mut pull);
                                    (pull, message)
                                }),
                            ).await;
                            let message = match step {
                                Ok(Ok((back, message))) => {
                                    pull = back;
                                    message
                                }
                                Ok(Err(e)) => {
                                    tracing::error!("sync_pull task failed: {}", e);
                                    let _ = send_response(out_tx, close_reason_tx, ServerMessage::pull_refused("Internal server error", remaining, true)).await;
                                    break;
                                }
                                Err(_) => {
                                    tracing::error!("sync_pull timed out");
                                    let _ = send_response(out_tx, close_reason_tx, ServerMessage::pull_refused("Operation timed out", remaining, true)).await;
                                    break;
                                }
                            };
                            let Some(message) = message else { break };
                            if !send_response_with_timeout(out_tx, close_reason_tx, Outbound { message, place: Some(place) }, SEND_TIMEOUT_BULK).await {
                                return;
                            }
                        }
                    }
                    "sync_push" => {
                        let ops: Vec<SyncOp> = match parsed.get("ops") {
                            Some(o) => serde_json::from_value(o.clone()).unwrap_or_else(|e| {
                                tracing::warn!("Failed to parse sync_push ops: {}", e);
                                Vec::new()
                            }),
                            None => Vec::new(),
                        };
                        if ops.is_empty() {
                            if !send_response(out_tx, close_reason_tx, ServerMessage::error("Invalid or empty ops in sync_push")).await {
                                return;
                            }
                            continue;
                        }
                        if ops.len() > MAX_OPS_PER_PUSH {
                            if !send_response(out_tx, close_reason_tx, ServerMessage::error(format!("Too many ops ({}, max {})", ops.len(), MAX_OPS_PER_PUSH))).await {
                                return;
                            }
                            continue;
                        }
                        // A collection the client pushes to is one it is sent the deltas of.
                        subscription.add(ops.iter().map(|op| op.collection.as_str()));
                        // A push not taken this time is answered `sync_retry`
                        // with its op ids, which every client reads as "send
                        // these again". It was an `error` naming nothing, which
                        // a client took for everything it had sent.
                        let op_ids: Vec<String> = ops.iter().map(|op| op.id.clone()).collect();

                        // Acquire sync permit (same rationale as sync_pull above)
                        let permit = match tokio::time::timeout(
                            PERMIT_WAIT,
                            sync.sync_permits.clone().acquire_owned(),
                        ).await {
                            Ok(Ok(p)) => p,
                            _ => {
                                if !send_response(out_tx, close_reason_tx, ServerMessage::push_retry(
                                    op_ids, "Server busy — too many concurrent sync operations, retry later",
                                )).await {
                                    return;
                                }
                                continue;
                            }
                        };

                        let sync_clone = sync.clone();
                        let cid_clone = cid.to_string();
                        // The answer leaves the task as soon as the ops are
                        // stored and broadcast, before their after-hooks run.
                        let (answer_tx, answer_rx) = tokio::sync::oneshot::channel();
                        // The permit goes once the push is stored, before its
                        // after-hooks run (SyncManager::push_and_hook).
                        let mut task = tokio::task::spawn_blocking(move || {
                            sync_clone.push_and_hook(ops, &cid_clone, permit, |responses| {
                                let _ = answer_tx.send(responses);
                            });
                        });
                        // Sent again, an op the first attempt did store is
                        // acknowledged and not applied twice (sync.rs RecentOps).
                        let responses = match tokio::time::timeout(HANDLER_TIMEOUT, answer_rx).await {
                            Ok(Ok(r)) => r,
                            Ok(Err(_)) => {
                                tracing::error!("sync_push task ended before it answered");
                                vec![ServerMessage::push_retry(op_ids, "Internal server error")]
                            }
                            Err(_) => {
                                tracing::error!("sync_push timed out");
                                vec![ServerMessage::push_retry(op_ids, "Operation timed out")]
                            }
                        };
                        for resp in responses {
                            if !send_response_with_timeout(out_tx, close_reason_tx, resp.into(), SEND_TIMEOUT_BULK).await {
                                return;
                            }
                        }
                        // This connection's next message waits for the
                        // after-hooks, as it always did: one client's pushes
                        // are hooked in the order they came.
                        let _ = tokio::time::timeout(HANDLER_TIMEOUT, &mut task).await;
                    }
                    "subscribe" => {
                        // The collections this client wants the deltas of
                        // (Subscription); not a list of names, and it is
                        // sent everything, as before.
                        if let Some(collections) = parsed.get("collections").and_then(|c| serde_json::from_value::<Vec<String>>(c.clone()).ok()) {
                            subscription.set(&collections);
                        }
                    }
                    _ => {}
                }
            }
            Some(Ok(Message::Ping(_))) => {
                // Axum/tungstenite auto-responds to Pings with Pongs.
                // This match arm counts as activity and resets the IDLE_TIMEOUT,
                // so protocol-level keepalive pings keep the connection alive.
            }
            Some(Ok(Message::Pong(_))) => {
                // Pong responses also reset the idle timer.
            }
            // The protocol is JSON text. A binary message used to be passed
            // over without a word, and the client waited for an answer.
            Some(Ok(Message::Binary(_))) => {
                let _ = close_reason_tx.send(Some((1003, "Binary messages are not accepted".into())));
                break;
            }
            // A frame the WebSocket layer refused: the connection cannot go
            // on, and the Close frame says why (refused_frame).
            Some(Err(error)) => {
                if let Some(reason) = refused_frame(error) {
                    tracing::debug!("Client {} sent a frame that was refused: {} {}", cid, reason.0, reason.1);
                    let _ = close_reason_tx.send(Some(reason));
                }
                break;
            }
            Some(Ok(Message::Close(_))) | None => break,
        }
    }
}

/// The server's time, as `auth_ok` gives it: to the millisecond, since a
/// client stamps its edits in it (@softn/core xdb-server-sync.ts). Whole
/// seconds left a client up to a second behind the server.
fn iso_now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg(test)]
mod writer_tests {
    use super::*;
    use std::pin::Pin;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::task::{Context, Poll};

    /// A peer that takes nothing: never ready for a message, never closed.
    /// Counts how often it is asked to close.
    struct Stalled(Arc<AtomicUsize>);

    impl futures_util::Sink<Message> for Stalled {
        type Error = std::io::Error;
        fn poll_ready(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
            Poll::Pending
        }
        fn start_send(self: Pin<&mut Self>, _: Message) -> Result<(), Self::Error> {
            Ok(())
        }
        fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
            Poll::Pending
        }
        fn poll_close(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
            self.0.fetch_add(1, Ordering::Relaxed);
            Poll::Pending
        }
    }

    /// The writer of a connection whose peer stopped reading ends, and with
    /// it the connection's slot is returned.
    #[tokio::test]
    async fn the_writer_gives_up_on_a_peer_that_takes_nothing() {
        let closes = Arc::new(AtomicUsize::new(0));
        let (out_tx, out_rx) = mpsc::channel::<Outbound>(4);
        let (_broadcast_tx, broadcast_rx) = broadcast::channel::<(Audience, Arc<ServerMessage>)>(4);
        let (_shutdown_tx, shutdown_rx) = watch::channel(false);
        let (_reason_tx, reason_rx) = watch::channel::<Option<CloseReason>>(None);
        let writer = tokio::spawn(writer_task(
            Stalled(closes.clone()), out_rx, broadcast_rx, "peer".into(), shutdown_rx, reason_rx,
            Subscription::default(), std::time::Duration::from_millis(100),
        ));
        out_tx.send(ServerMessage::error("one").into()).await.unwrap();
        out_tx.send(ServerMessage::error("two").into()).await.unwrap();
        let ended = tokio::time::timeout(std::time::Duration::from_secs(3), writer).await;
        assert!(ended.is_ok(), "the writer was still inside a send its peer will never take");
        // One send ran out of time. The goodbye after it was not waited for as well.
        assert_eq!(closes.load(Ordering::Relaxed), 0);
    }

    /// A peer that takes everything, and keeps the text of each message.
    struct Recording(Arc<std::sync::Mutex<Vec<String>>>);

    impl futures_util::Sink<Message> for Recording {
        type Error = std::io::Error;
        fn poll_ready(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }
        fn start_send(self: Pin<&mut Self>, message: Message) -> Result<(), Self::Error> {
            if let Message::Text(text) = message {
                self.0.lock().unwrap().push(text.to_string());
            }
            Ok(())
        }
        fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }
        fn poll_close(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }
    }

    /// Each connection is sent what the sync stream holds for it: other
    /// clients' pushes, never its own, and what the store said of its own
    /// pushes, which no other connection is sent.
    #[tokio::test]
    async fn a_connection_is_sent_what_the_stream_holds_for_it() {
        for (cid, expected) in [("a", vec!["for a", "from b"]), ("b", vec!["from a"])] {
            let sent = Arc::new(std::sync::Mutex::new(Vec::new()));
            let (out_tx, out_rx) = mpsc::channel::<Outbound>(4);
            let (stream, broadcast_rx) = broadcast::channel::<(Audience, Arc<ServerMessage>)>(8);
            let (_shutdown_tx, shutdown_rx) = watch::channel(false);
            let (_reason_tx, reason_rx) = watch::channel::<Option<CloseReason>>(None);
            let writer = tokio::spawn(writer_task(
                Recording(sent.clone()), out_rx, broadcast_rx, cid.into(), shutdown_rx, reason_rx,
                Subscription::default(), std::time::Duration::from_secs(5),
            ));
            for (audience, text) in [
                (Audience::Others("a".into()), "from a"),
                (Audience::Only("a".into()), "for a"),
                (Audience::Others("b".into()), "from b"),
            ] {
                stream.send((audience, Arc::new(ServerMessage::error(text)))).unwrap();
            }
            // The last item is for both: once it is through, the rest are too.
            stream.send((Audience::Others("c".into()), Arc::new(ServerMessage::error("end")))).unwrap();
            let waited = tokio::time::timeout(std::time::Duration::from_secs(3), async {
                while !sent.lock().unwrap().iter().any(|text| text.contains("\"end\"")) {
                    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
                }
            }).await;
            assert!(waited.is_ok(), "{cid} was never sent the last item");
            drop(out_tx);
            let _ = tokio::time::timeout(std::time::Duration::from_secs(3), writer).await;
            let got: Vec<String> = sent.lock().unwrap().iter()
                .map(|text| serde_json::from_str::<serde_json::Value>(text).unwrap()["message"].as_str().unwrap().to_string())
                .filter(|text| text != "end")
                .collect();
            assert_eq!(got, expected, "{cid}");
        }
    }

    #[test]
    fn the_server_time_is_given_to_the_millisecond() {
        let now = iso_now();
        assert!(chrono::DateTime::parse_from_rfc3339(&now).is_ok(), "{now}");
        assert!(to_the_millisecond(&now), "{now}");
    }

    /// `2026-10-12T08:35:38.523Z`: three digits of fraction, then `Z`.
    fn to_the_millisecond(time: &str) -> bool {
        let Some((_, fraction)) = time.split_once('.') else { return false };
        fraction.len() == 4 && fraction.ends_with('Z') && fraction[..3].bytes().all(|b| b.is_ascii_digit())
    }

    /// Once the reader has gone the writer is waited for, not waited on.
    #[tokio::test]
    async fn a_writer_that_does_not_finish_is_ended() {
        struct Dropped(Arc<AtomicBool>);
        impl Drop for Dropped {
            fn drop(&mut self) {
                self.0.store(true, Ordering::Relaxed);
            }
        }
        let ended = Arc::new(AtomicBool::new(false));
        let held = Dropped(ended.clone());
        let writer = tokio::spawn(async move {
            let _held = held;
            std::future::pending::<()>().await;
        });
        let waited = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            finish_writer(writer, std::time::Duration::from_millis(100)),
        ).await;
        assert!(waited.is_ok(), "the connection waited on its writer without end");
        assert!(ended.load(Ordering::Relaxed), "and the writer's task is gone, with what it held");

        // One that finishes in time is simply waited for.
        let quick = tokio::spawn(async {});
        finish_writer(quick, std::time::Duration::from_secs(5)).await;
    }

    fn delta(ops: &[(&str, &str)]) -> Arc<ServerMessage> {
        Arc::new(ServerMessage::SyncDelta {
            ops: ops.iter().map(|(id, collection)| SyncOp {
                id: id.to_string(), collection: collection.to_string(), operation: "update".into(),
                record_id: id.to_string(), data: None, timestamp: String::new(), client_id: "c".into(),
            }).collect(),
        })
    }

    fn ids(message: Option<Arc<ServerMessage>>) -> Vec<String> {
        match message.as_deref() {
            Some(ServerMessage::SyncDelta { ops }) => ops.iter().map(|op| op.id.clone()).collect(),
            Some(other) => panic!("{other:?}"),
            None => Vec::new(),
        }
    }

    /// A connection is sent the deltas of the collections its client asked
    /// for, and of those it pulls or pushes to after: the host ignored
    /// `subscribe`, and every client applied every collection's changes.
    /// Until it says, it is sent everything, as a client from before expects;
    /// and what the store says to it alone is never held back.
    #[test]
    fn a_connection_is_sent_the_collections_its_client_wants() {
        let everyone = Audience::Others("x".into());
        let mixed = delta(&[("n1", "notes"), ("s1", "secrets"), ("t1", "tags")]);
        let subscription = Subscription::default();
        assert_eq!(ids(subscription.admit(&everyone, &mixed)), vec!["n1", "s1", "t1"], "before it says");
        subscription.set(&["notes".into(), "bad name".into()]);
        assert_eq!(ids(subscription.admit(&everyone, &mixed)), vec!["n1"]);
        assert_eq!(ids(subscription.admit(&Audience::All, &mixed)), vec!["n1"], "the server's own writes too");
        assert_eq!(ids(subscription.admit(&Audience::Only("me".into()), &mixed)), vec!["n1", "s1", "t1"], "its own answers");
        assert!(subscription.admit(&everyone, &delta(&[("s2", "secrets")])).is_none());
        // A message of its collections alone goes as it is, not copied.
        let notes = delta(&[("n2", "notes")]);
        assert!(Arc::ptr_eq(&subscription.admit(&everyone, &notes).unwrap(), &notes));
        // A collection it pulls or pushes to is one it is sent.
        subscription.add(["tags", "../x"]);
        assert_eq!(ids(subscription.admit(&everyone, &mixed)), vec!["n1", "t1"]);
        // Errors and acknowledgements are not deltas, and go.
        assert!(subscription.admit(&everyone, &Arc::new(ServerMessage::error("x"))).is_some());
        // Past MAX_SUBSCRIBED it is sent everything again.
        subscription.add((0..MAX_SUBSCRIBED).map(|i| format!("c{i}")).collect::<Vec<_>>().iter().map(String::as_str));
        assert_eq!(ids(subscription.admit(&everyone, &mixed)), vec!["n1", "s1", "t1"]);
        // An empty list: nothing until it uses a collection.
        subscription.set(&[]);
        assert!(subscription.admit(&everyone, &mixed).is_none());
    }
}
