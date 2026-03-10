use crate::sync::{ServerMessage, SyncManager, SyncOp};
use crate::util;
use axum::extract::ws::{CloseFrame, Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use std::sync::Arc;
use tokio::sync::{broadcast, mpsc, watch};

/// Timeout for sync_pull / sync_push blocking tasks. Must exceed the VM
/// wall-time limit (25s) by enough margin for the DB operations that follow
/// a long-running hook to complete cleanly.
const HANDLER_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(35);
const MAX_OPS_PER_PUSH: usize = 1000;
/// If no data is received from the client within this period, assume the
/// connection is dead (e.g. mobile lost signal, laptop asleep) and clean up.
const IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(90);
/// Outbound channel capacity — large enough to absorb burst from sync_pull
/// responses without blocking the reader task.
const OUT_CHANNEL_SIZE: usize = 512;
/// Timeout for sending direct responses (sync_pull/sync_push results).
/// If the writer can't drain within this, the client is irrecoverably slow.
const SEND_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
/// How long to wait for a sync permit before returning "server busy".
/// A short wait smooths out micro-bursts (e.g. dozens of clients reconnecting
/// after a network partition resolves) without hanging the connection.
const PERMIT_WAIT: std::time::Duration = std::time::Duration::from_secs(2);
/// Server-to-client Ping interval. Browser WebSocket APIs cannot send Ping
/// frames, so without server-initiated pings an idle (but healthy) browser
/// client would hit IDLE_TIMEOUT and be disconnected. The browser's built-in
/// Pong reply resets the reader's idle timer automatically.
const PING_INTERVAL: std::time::Duration = std::time::Duration::from_secs(30);

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
    out_tx: &mpsc::Sender<ServerMessage>,
    close_reason_tx: &watch::Sender<Option<String>>,
    msg: ServerMessage,
) -> bool {
    match tokio::time::timeout(SEND_TIMEOUT, out_tx.send(msg)).await {
        Ok(Ok(())) => true,
        Ok(Err(_)) => {
            tracing::warn!("WebSocket outbound channel closed — dropping connection");
            false
        }
        Err(_) => {
            tracing::warn!("WebSocket send timed out ({}s) — dropping connection to force re-sync", SEND_TIMEOUT.as_secs());
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
/// it signals the shutdown drain that this connection has closed.
pub async fn handle_ws(
    socket: WebSocket,
    sync: Arc<SyncManager>,
    shutdown_rx: watch::Receiver<bool>,
    cid: String,
    _conn_guard: tokio::sync::mpsc::Sender<()>,
) {
    let (mut ws_tx, mut ws_rx) = socket.split();

    // Connection is pre-authenticated — send auth_ok immediately so the
    // client receives its client_id and server time.
    let msg = ServerMessage::AuthOk {
        client_id: cid.clone(),
        server_time: iso_now(),
    };
    if let Ok(json) = serde_json::to_string(&msg) {
        if ws_tx.send(Message::Text(json.into())).await.is_err() {
            return;
        }
    }
    tracing::info!("Client {} connected", cid);

    // Split into reader/writer actor tasks to prevent head-of-line blocking.
    // The writer task owns ws_tx and drains both broadcast messages and
    // outbound responses from the reader, so broadcast delivery is never
    // blocked by slow sync operations.
    let (out_tx, out_rx) = mpsc::channel::<ServerMessage>(OUT_CHANNEL_SIZE);
    let broadcast_rx = sync.subscribe();

    // Dedicated watch channel for terminal close reasons. When send_response
    // times out, the mpsc channel is likely full — so we use a separate watch
    // channel to deliver the close reason to the writer task, which reads it
    // when out_rx returns None (after out_tx is dropped).
    let (close_reason_tx, close_reason_rx) = watch::channel::<Option<String>>(None);

    let cid_for_writer = cid.clone();
    let writer_handle = tokio::spawn(writer_task(ws_tx, out_rx, broadcast_rx, cid_for_writer, shutdown_rx, close_reason_rx));

    // Reader task: runs in the current task
    reader_task(&mut ws_rx, &sync, &cid, &out_tx, &close_reason_tx).await;

    // Reader exited (client disconnected or error) — drop out_tx to signal writer
    drop(out_tx);
    let _ = writer_handle.await;
    tracing::info!("Client {} disconnected", cid);
}

/// Writer task: owns the WebSocket sink and merges outbound messages from
/// the reader (via out_rx) and broadcast notifications (via broadcast_rx).
/// Also listens for the server shutdown signal to send a clean Close frame
/// before the process exits.
async fn writer_task(
    mut ws_tx: futures_util::stream::SplitSink<WebSocket, Message>,
    mut out_rx: mpsc::Receiver<ServerMessage>,
    mut broadcast_rx: broadcast::Receiver<(String, ServerMessage)>,
    cid: String,
    mut shutdown_rx: watch::Receiver<bool>,
    close_reason_rx: watch::Receiver<Option<String>>,
) {
    let mut ping_interval = tokio::time::interval(PING_INTERVAL);
    // First tick fires immediately — skip it so we don't ping right after connect.
    ping_interval.tick().await;

    loop {
        tokio::select! {
            // Messages from the reader (sync responses, errors, etc.)
            msg = out_rx.recv() => {
                match msg {
                    Some(server_msg) => {
                        if let Ok(json) = serde_json::to_string(&server_msg) {
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
            // Broadcast from other clients' sync_push
            result = broadcast_rx.recv() => {
                match result {
                    Ok((sender_id, msg)) => {
                        // Don't echo back to sender
                        if sender_id != cid {
                            if let Ok(json) = serde_json::to_string(&msg) {
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
    out_tx: &mpsc::Sender<ServerMessage>,
    close_reason_tx: &watch::Sender<Option<String>>,
) {
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

                        // Acquire a sync permit to bound concurrent blocking tasks.
                        // Without this, a flood of slow sync_pull requests could exhaust
                        // Tokio's 512-thread spawn_blocking pool, starving all other I/O.
                        // Uses a short timeout to smooth out micro-bursts (e.g. dozens of
                        // clients reconnecting after a network partition) instead of
                        // immediately failing and forcing client-side retry logic.
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
                        let responses = match tokio::time::timeout(
                            HANDLER_TIMEOUT,
                            tokio::task::spawn_blocking(move || {
                                let _permit = permit; // held until task completes
                                sync_clone.handle_sync_pull(&collections, last_sync.as_deref(), last_id.as_deref())
                            }),
                        ).await {
                            Ok(Ok(r)) => r,
                            Ok(Err(e)) => {
                                tracing::error!("sync_pull task failed: {}", e);
                                vec![ServerMessage::Error {
                                    message: "Internal server error".into(),
                                }]
                            }
                            Err(_) => {
                                tracing::error!("sync_pull timed out");
                                vec![ServerMessage::Error {
                                    message: "Operation timed out".into(),
                                }]
                            }
                        };
                        for resp in responses {
                            if !send_response(out_tx, close_reason_tx, resp).await {
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
                        let responses = match tokio::time::timeout(
                            HANDLER_TIMEOUT,
                            tokio::task::spawn_blocking(move || {
                                let _permit = permit; // held until task completes
                                sync_clone.handle_sync_push(ops, &cid_clone)
                            }),
                        ).await {
                            Ok(Ok(r)) => r,
                            Ok(Err(e)) => {
                                tracing::error!("sync_push task failed: {}", e);
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
                            if !send_response(out_tx, close_reason_tx, resp).await {
                                return;
                            }
                        }
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

fn iso_now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}
