use crate::sync::{ServerMessage, SyncManager, SyncOp};
use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use std::sync::Arc;
use tokio::sync::{broadcast, mpsc};

const HANDLER_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
const MAX_OPS_PER_PUSH: usize = 1000;
/// If no data is received from the client within this period, assume the
/// connection is dead (e.g. mobile lost signal, laptop asleep) and clean up.
const IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(90);
/// Max time to wait for the client to send an auth message after connecting.
/// Prevents resource leaks from clients that open connections but never authenticate.
const AUTH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
/// Outbound channel capacity — large enough to absorb burst from sync_pull
/// responses without blocking the reader task.
const OUT_CHANNEL_SIZE: usize = 512;
/// Timeout for sending direct responses (sync_pull/sync_push results).
/// If the writer can't drain within this, the client is irrecoverably slow.
const SEND_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// Send a direct response (sync_pull/sync_push result) to the writer task.
/// Uses an async send with a timeout — these are responses the client is
/// actively waiting for, so we must not silently drop them.
/// Returns false if the channel is closed or the send times out.
async fn send_response(out_tx: &mpsc::Sender<ServerMessage>, msg: ServerMessage) -> bool {
    match tokio::time::timeout(SEND_TIMEOUT, out_tx.send(msg)).await {
        Ok(Ok(())) => true,
        _ => false, // Channel closed or client too slow
    }
}

pub async fn handle_ws(socket: WebSocket, sync: Arc<SyncManager>) {
    let (mut ws_tx, mut ws_rx) = socket.split();

    // Auth phase: expect first message to be a text auth message.
    // Wrapped in AUTH_TIMEOUT to prevent connection leaks from clients
    // that complete the WebSocket handshake but never send a message.
    let auth_msg = match tokio::time::timeout(AUTH_TIMEOUT, async {
        loop {
            match ws_rx.next().await {
                Some(Ok(Message::Text(text))) => return Some(text),
                Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
                Some(Ok(_)) => return None,
                _ => return None,
            }
        }
    }).await {
        Ok(Some(text)) => text,
        Ok(None) => {
            let msg = ServerMessage::Error {
                message: "Expected text auth message".into(),
            };
            if let Ok(json) = serde_json::to_string(&msg) {
                let _ = ws_tx.send(Message::Text(json.into())).await;
            }
            return;
        }
        Err(_) => {
            tracing::debug!("WebSocket auth timeout — closing unauthenticated connection");
            return;
        }
    };

    let parsed: serde_json::Value = match serde_json::from_str(&auth_msg) {
        Ok(v) => v,
        Err(_) => {
            let msg = ServerMessage::Error {
                message: "Invalid JSON".into(),
            };
            if let Ok(json) = serde_json::to_string(&msg) {
                let _ = ws_tx.send(Message::Text(json.into())).await;
            }
            return;
        }
    };

    if parsed.get("type").and_then(|t| t.as_str()) != Some("auth") {
        let msg = ServerMessage::Error {
            message: "Expected auth message".into(),
        };
        if let Ok(json) = serde_json::to_string(&msg) {
            let _ = ws_tx.send(Message::Text(json.into())).await;
        }
        return;
    }

    let token = parsed.get("token").and_then(|t| t.as_str());
    let app_version = parsed.get("appVersion").and_then(|v| v.as_str());

    let cid = match sync.handle_auth(token, app_version) {
        Ok(cid) => {
            let msg = ServerMessage::AuthOk {
                client_id: cid.clone(),
                server_time: iso_now(),
            };
            if let Ok(json) = serde_json::to_string(&msg) {
                let _ = ws_tx.send(Message::Text(json.into())).await;
            }
            cid
        }
        Err(reason) => {
            let msg = ServerMessage::AuthError { reason };
            if let Ok(json) = serde_json::to_string(&msg) {
                let _ = ws_tx.send(Message::Text(json.into())).await;
            }
            return;
        }
    };
    tracing::info!("Client {} connected", cid);

    // Split into reader/writer actor tasks to prevent head-of-line blocking.
    // The writer task owns ws_tx and drains both broadcast messages and
    // outbound responses from the reader, so broadcast delivery is never
    // blocked by slow sync operations.
    let (out_tx, out_rx) = mpsc::channel::<ServerMessage>(OUT_CHANNEL_SIZE);
    let broadcast_rx = sync.subscribe();

    let cid_for_writer = cid.clone();
    let writer_handle = tokio::spawn(writer_task(ws_tx, out_rx, broadcast_rx, cid_for_writer));

    // Reader task: runs in the current task
    reader_task(&mut ws_rx, &sync, &cid, &out_tx).await;

    // Reader exited (client disconnected or error) — drop out_tx to signal writer
    drop(out_tx);
    let _ = writer_handle.await;
    tracing::info!("Client {} disconnected", cid);
}

/// Writer task: owns the WebSocket sink and merges outbound messages from
/// the reader (via out_rx) and broadcast notifications (via broadcast_rx).
async fn writer_task(
    mut ws_tx: futures_util::stream::SplitSink<WebSocket, Message>,
    mut out_rx: mpsc::Receiver<ServerMessage>,
    mut broadcast_rx: broadcast::Receiver<(String, ServerMessage)>,
    cid: String,
) {
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
                    // Reader dropped out_tx — time to exit
                    None => break,
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
) {
    loop {
        // Idle timeout: if no data arrives within IDLE_TIMEOUT, assume the
        // connection is dead and break to trigger cleanup.
        let next = tokio::time::timeout(IDLE_TIMEOUT, ws_rx.next()).await;
        let msg = match next {
            Ok(msg) => msg,
            Err(_) => {
                tracing::info!("Client {} idle timeout ({}s) — disconnecting", cid, IDLE_TIMEOUT.as_secs());
                let _ = send_response(out_tx, ServerMessage::Error {
                    message: "Idle timeout".into(),
                }).await;
                break;
            }
        };
        match msg {
            Some(Ok(Message::Text(text))) => {
                let parsed: serde_json::Value = match serde_json::from_str(&text) {
                    Ok(v) => v,
                    Err(_) => {
                        if !send_response(out_tx, ServerMessage::Error {
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
                        let sync_clone = sync.clone();
                        // Note: tokio::time::timeout drops the future but does NOT cancel
                        // the underlying blocking thread. However, all operations within
                        // handle_sync_pull are bounded: DB queries are fast indexed reads
                        // under WAL, and the VM has a 25s wall-time limit. The blocking
                        // thread will always terminate within the VM timeout.
                        let responses = match tokio::time::timeout(
                            HANDLER_TIMEOUT,
                            tokio::task::spawn_blocking(move || {
                                sync_clone.handle_sync_pull(&collections)
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
                            if !send_response(out_tx, resp).await {
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
                            continue;
                        }
                        if ops.len() > MAX_OPS_PER_PUSH {
                            if !send_response(out_tx, ServerMessage::Error {
                                message: format!("Too many ops ({}, max {})", ops.len(), MAX_OPS_PER_PUSH),
                            }).await {
                                return;
                            }
                            continue;
                        }
                        let sync_clone = sync.clone();
                        let cid_clone = cid.to_string();
                        let responses = match tokio::time::timeout(
                            HANDLER_TIMEOUT,
                            tokio::task::spawn_blocking(move || {
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
                            if !send_response(out_tx, resp).await {
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
