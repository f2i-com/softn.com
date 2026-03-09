use crate::sync::{ServerMessage, SyncManager, SyncOp};
use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use std::sync::Arc;
use tokio::sync::broadcast;

const HANDLER_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
const MAX_OPS_PER_PUSH: usize = 1000;

/// Send a ServerMessage as JSON over the WebSocket. Logs and drops on failure.
async fn send_msg(
    ws_tx: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    msg: &ServerMessage,
) {
    match serde_json::to_string(msg) {
        Ok(json) => {
            let _ = ws_tx.send(Message::Text(json.into())).await;
        }
        Err(e) => {
            tracing::error!("Failed to serialize ServerMessage: {}", e);
        }
    }
}

pub async fn handle_ws(socket: WebSocket, sync: Arc<SyncManager>) {
    let (mut ws_tx, mut ws_rx) = socket.split();
    let mut broadcast_rx = sync.subscribe();

    // Auth phase: expect first message to be auth
    let auth_msg = match ws_rx.next().await {
        Some(Ok(Message::Text(text))) => text,
        _ => return,
    };

    let parsed: serde_json::Value = match serde_json::from_str(&auth_msg) {
        Ok(v) => v,
        Err(_) => {
            send_msg(&mut ws_tx, &ServerMessage::Error {
                message: "Invalid JSON".into(),
            })
            .await;
            return;
        }
    };

    if parsed.get("type").and_then(|t| t.as_str()) != Some("auth") {
        send_msg(&mut ws_tx, &ServerMessage::Error {
            message: "Expected auth message".into(),
        })
        .await;
        return;
    }

    let token = parsed.get("token").and_then(|t| t.as_str());
    let app_version = parsed.get("appVersion").and_then(|v| v.as_str());

    let cid = match sync.handle_auth(token, app_version) {
        Ok(cid) => {
            send_msg(&mut ws_tx, &ServerMessage::AuthOk {
                client_id: cid.clone(),
                server_time: iso_now(),
            })
            .await;
            cid
        }
        Err(reason) => {
            send_msg(&mut ws_tx, &ServerMessage::AuthError { reason }).await;
            return;
        }
    };
    let cid_for_broadcast = cid.clone();
    tracing::info!("Client {} connected", cid);

    // Message loop: incoming messages + broadcast forwarding
    loop {
        tokio::select! {
            msg = ws_rx.next() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        let parsed: serde_json::Value = match serde_json::from_str(&text) {
                            Ok(v) => v,
                            Err(_) => {
                                send_msg(&mut ws_tx, &ServerMessage::Error {
                                    message: "Invalid JSON".into(),
                                }).await;
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
                                    send_msg(&mut ws_tx, &resp).await;
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
                                    // No valid ops — don't bother spawning
                                    continue;
                                }
                                if ops.len() > MAX_OPS_PER_PUSH {
                                    send_msg(&mut ws_tx, &ServerMessage::Error {
                                        message: format!("Too many ops ({}, max {})", ops.len(), MAX_OPS_PER_PUSH),
                                    }).await;
                                    continue;
                                }
                                // Run blocking hook calls off the tokio reactor
                                let sync_clone = sync.clone();
                                let cid_clone = cid.clone();
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
                                    send_msg(&mut ws_tx, &resp).await;
                                }
                            }
                            "subscribe" => {
                                // Subscriptions handled via broadcast channel
                            }
                            _ => {}
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => {
                        tracing::info!("Client {} disconnected", cid);
                        break;
                    }
                    _ => {}
                }
            }
            result = broadcast_rx.recv() => {
                match result {
                    Ok((sender_id, msg)) => {
                        // Don't echo back to sender
                        if sender_id != cid_for_broadcast {
                            send_msg(&mut ws_tx, &msg).await;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        tracing::warn!("Client {} lagged, missed {} messages", cid_for_broadcast, n);
                        send_msg(&mut ws_tx, &ServerMessage::Error {
                            message: format!("Missed {} messages, consider re-syncing", n),
                        }).await;
                    }
                    Err(broadcast::error::RecvError::Closed) => {
                        tracing::info!("Broadcast channel closed, disconnecting client {}", cid_for_broadcast);
                        break;
                    }
                }
            }
        }
    }
}

/// ISO 8601 timestamp from system clock.
fn iso_now() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs();
    // Convert to date-time components
    let days = secs / 86400;
    let time_secs = secs % 86400;
    let hours = time_secs / 3600;
    let mins = (time_secs % 3600) / 60;
    let s = time_secs % 60;

    // Days since 1970-01-01
    let mut y = 1970i64;
    let mut remaining = days as i64;
    loop {
        let days_in_year = if y % 4 == 0 && (y % 100 != 0 || y % 400 == 0) {
            366
        } else {
            365
        };
        if remaining < days_in_year {
            break;
        }
        remaining -= days_in_year;
        y += 1;
    }
    let leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
    let month_days = [
        31,
        if leap { 29 } else { 28 },
        31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
    ];
    let mut m = 0;
    for md in &month_days {
        if remaining < *md {
            break;
        }
        remaining -= *md;
        m += 1;
    }
    let d = remaining + 1;

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        y,
        m + 1,
        d,
        hours,
        mins,
        s
    )
}
