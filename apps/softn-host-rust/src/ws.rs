use crate::sync::{Audience, ServerMessage, SyncManager, SyncOp};
use crate::util;
use axum::extract::ws::{CloseFrame, Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
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
const MAX_OPS_PER_PUSH: usize = 1000;
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
    close_reason_tx: &watch::Sender<Option<String>>,
    msg: ServerMessage,
) -> bool {
    send_response_with_timeout(out_tx, close_reason_tx, msg.into(), SEND_TIMEOUT).await
}

/// Like `send_response` but with a caller-specified timeout.
/// Used for bulk transfers (sync_pull/sync_push) where slow mobile clients
/// need more time to drain large payloads without being disconnected.
async fn send_response_with_timeout(
    out_tx: &mpsc::Sender<Outbound>,
    close_reason_tx: &watch::Sender<Option<String>>,
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
            let _ = close_reason_tx.send(Some(
                "Connection too slow — disconnecting to force re-sync".into(),
            ));
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
    let (close_reason_tx, close_reason_rx) = watch::channel::<Option<String>>(None);

    let cid_for_writer = cid.clone();
    let writer_handle = tokio::spawn(writer_task(ws_tx, out_rx, broadcast_rx, cid_for_writer, shutdown_rx, close_reason_rx, WRITER_SEND_TIMEOUT));

    // Reader task: runs in the current task
    reader_task(&mut ws_rx, &sync, &cid, &out_tx, &close_reason_tx).await;

    // Reader exited (client disconnected or error) — drop out_tx to signal writer
    drop(out_tx);
    finish_writer(writer_handle, WRITER_DRAIN).await;
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
    close_reason_rx: watch::Receiver<Option<String>>,
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
                        // (set by send_response on timeout). Falls back to a
                        // generic reason for normal disconnects.
                        let reason = close_reason_rx.borrow().clone()
                            .unwrap_or_else(|| "Connection closing".into());
                        let _ = ws_tx.send(Message::Close(Some(CloseFrame {
                            code: 1000,
                            reason: reason.into(),
                        }))).await;
                        break;
                    }
                }
            }
            // The sync stream: other clients' pushes, and what the store
            // said of this client's own (sync.rs Audience).
            result = broadcast_rx.recv() => {
                match result {
                    Ok((audience, msg)) => {
                        // A push is not echoed back to its sender.
                        if audience.reaches(&cid) {
                            if let Ok(json) = serde_json::to_string(&*msg) {
                                if ws_tx.send(Message::Text(json.into())).await.is_err() {
                                    break;
                                }
                            }
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        tracing::warn!("Client {} lagged, missed {} messages — disconnecting to force re-sync", cid, n);
                        let msg = ServerMessage::Error {
                            message: format!("Missed {} messages, reconnect to re-sync", n),
                        };
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
                    let msg = ServerMessage::Error {
                        message: "Server shutting down".into(),
                    };
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
    close_reason_tx: &watch::Sender<Option<String>>,
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
                let _ = send_response(out_tx, close_reason_tx, ServerMessage::Error {
                    message: "Idle timeout".into(),
                }).await;
                break;
            }
        };
        match msg {
            Some(Ok(Message::Text(text))) => {
                // Depth-bounded parse to prevent stack overflow from deeply nested payloads
                let parsed: serde_json::Value = match util::parse_json_bounded(&text, util::MAX_JSON_DEPTH) {
                    Ok(v) => v,
                    Err(_) => {
                        if !send_response(out_tx, close_reason_tx, ServerMessage::Error {
                            message: "Invalid JSON".into(),
                        }).await {
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
                        // Optional timestamp cursor for incremental sync.
                        // If provided, only records updated after this timestamp are returned.
                        let last_sync: Option<String> = parsed
                            .get("lastSync")
                            .and_then(|v| v.as_str())
                            .map(String::from);
                        // Optional compound cursor: (lastSync, lastId) resolves
                        // timestamp ties when >10k records share the same updated_at.
                        let last_id: Option<String> = parsed
                            .get("lastId")
                            .and_then(|v| v.as_str())
                            .map(String::from);
                        // Where a full pull continues from: the `more` of the
                        // last sync_state of a page that was full.
                        let cursor: Option<(String, String)> = parsed.get("cursor").and_then(|c| {
                            Some((c.get("at")?.as_str()?.to_string(), c.get("id")?.as_str()?.to_string()))
                        });

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
                                    let _ = close_reason_tx.send(Some("Connection too slow — disconnecting to force re-sync".into()));
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
                            let permit = match tokio::time::timeout(
                                wait,
                                sync.sync_permits.clone().acquire_owned(),
                            ).await {
                                Ok(Ok(p)) => p,
                                _ => {
                                    if !send_response(out_tx, close_reason_tx, ServerMessage::Error {
                                        message: "Server busy — too many concurrent sync operations, retry later".into(),
                                    }).await {
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
                                    let _ = send_response(out_tx, close_reason_tx, ServerMessage::Error {
                                        message: "Internal server error".into(),
                                    }).await;
                                    break;
                                }
                                Err(_) => {
                                    tracing::error!("sync_pull timed out");
                                    let _ = send_response(out_tx, close_reason_tx, ServerMessage::Error {
                                        message: "Operation timed out".into(),
                                    }).await;
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
                            if !send_response(out_tx, close_reason_tx, ServerMessage::Error {
                                message: "Invalid or empty ops in sync_push".into(),
                            }).await {
                                return;
                            }
                            continue;
                        }
                        if ops.len() > MAX_OPS_PER_PUSH {
                            if !send_response(out_tx, close_reason_tx, ServerMessage::Error {
                                message: format!("Too many ops ({}, max {})", ops.len(), MAX_OPS_PER_PUSH),
                            }).await {
                                return;
                            }
                            continue;
                        }

                        // Acquire sync permit (same rationale as sync_pull above)
                        let permit = match tokio::time::timeout(
                            PERMIT_WAIT,
                            sync.sync_permits.clone().acquire_owned(),
                        ).await {
                            Ok(Ok(p)) => p,
                            _ => {
                                if !send_response(out_tx, close_reason_tx, ServerMessage::Error {
                                    message: "Server busy — too many concurrent sync operations, retry later".into(),
                                }).await {
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
                        let responses = match tokio::time::timeout(HANDLER_TIMEOUT, answer_rx).await {
                            Ok(Ok(r)) => r,
                            Ok(Err(_)) => {
                                tracing::error!("sync_push task ended before it answered");
                                vec![ServerMessage::Error {
                                    message: "Internal server error".into(),
                                }]
                            }
                            Err(_) => {
                                tracing::error!("sync_push timed out");
                                vec![ServerMessage::Error {
                                    message: "Operation timed out".into(),
                                }]
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
                        // Subscriptions handled via broadcast channel
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
            Some(Ok(Message::Close(_))) | None => break,
            _ => {}
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
        let (_reason_tx, reason_rx) = watch::channel::<Option<String>>(None);
        let writer = tokio::spawn(writer_task(
            Stalled(closes.clone()), out_rx, broadcast_rx, "peer".into(), shutdown_rx, reason_rx,
            std::time::Duration::from_millis(100),
        ));
        out_tx.send(ServerMessage::Error { message: "one".into() }.into()).await.unwrap();
        out_tx.send(ServerMessage::Error { message: "two".into() }.into()).await.unwrap();
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
            let (_reason_tx, reason_rx) = watch::channel::<Option<String>>(None);
            let writer = tokio::spawn(writer_task(
                Recording(sent.clone()), out_rx, broadcast_rx, cid.into(), shutdown_rx, reason_rx,
                std::time::Duration::from_secs(5),
            ));
            for (audience, text) in [
                (Audience::Others("a".into()), "from a"),
                (Audience::Only("a".into()), "for a"),
                (Audience::Others("b".into()), "from b"),
            ] {
                stream.send((audience, Arc::new(ServerMessage::Error { message: text.into() }))).unwrap();
            }
            // The last item is for both: once it is through, the rest are too.
            stream.send((Audience::Others("c".into()), Arc::new(ServerMessage::Error { message: "end".into() }))).unwrap();
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
}
