use crate::runtime::ServerRuntime;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::broadcast;
use xdb::SharedDb;

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
    #[serde(rename = "error")]
    Error { message: String },
}

pub struct SyncManager {
    db: SharedDb,
    broadcast_tx: broadcast::Sender<(String, ServerMessage)>,
    runtime: Option<Arc<ServerRuntime>>,
    has_before_sync: bool,
    has_after_sync: bool,
    auth_token: Option<String>,
}

impl SyncManager {
    pub fn new(
        db: SharedDb,
        runtime: Option<Arc<ServerRuntime>>,
        auth_token: Option<String>,
    ) -> Arc<Self> {
        let (broadcast_tx, _) = broadcast::channel(256);

        let has_before_sync = runtime
            .as_ref()
            .map(|r| r.has_function("onBeforeSync"))
            .unwrap_or(false);
        let has_after_sync = runtime
            .as_ref()
            .map(|r| r.has_function("onAfterSync"))
            .unwrap_or(false);

        if has_before_sync {
            tracing::info!("onBeforeSync hook detected");
        }
        if has_after_sync {
            tracing::info!("onAfterSync hook detected");
        }

        Arc::new(Self {
            db,
            broadcast_tx,
            runtime,
            has_before_sync,
            has_after_sync,
            auth_token,
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
                Some(t) if constant_time_eq(t.as_bytes(), expected.as_bytes()) => {}
                Some(_) => return Err("Invalid auth token".into()),
                None => return Err("Auth token required".into()),
            }
        }

        let client_id = uuid::Uuid::new_v4().to_string();
        Ok(client_id)
    }

    pub fn handle_sync_pull(&self, collections: &[String]) -> Vec<ServerMessage> {
        let mut messages = Vec::new();

        for collection in collections {
            // Lock per-collection so we don't block other operations across all collections
            let db = match self.db.lock() {
                Ok(db) => db,
                Err(e) => {
                    messages.push(ServerMessage::Error {
                        message: format!("Database lock error: {}", e),
                    });
                    continue;
                }
            };
            let records = match db.get_collection(collection) {
                Ok(r) => r,
                Err(e) => {
                    tracing::warn!("Failed to query collection '{}': {}", collection, e);
                    Vec::new()
                }
            };
            drop(db);

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
        let mut accepted_ops = Vec::new();

        for mut op in ops {
            // Stamp the authenticated client ID on each op
            op.client_id = client_id.to_string();

            // Validate recordId for update/delete (before hook to avoid unnecessary script calls)
            if (op.operation == "update" || op.operation == "delete") && op.record_id.is_empty() {
                responses.push(ServerMessage::SyncReject {
                    op_id: op.id.clone(),
                    reason: format!("{} requires a recordId", op.operation),
                });
                continue;
            }

            // Call onBeforeSync hook
            if self.has_before_sync {
                match self.call_before_sync(&op) {
                    Ok(false) => {
                        tracing::info!("onBeforeSync rejected op {}", op.id);
                        responses.push(ServerMessage::SyncReject {
                            op_id: op.id.clone(),
                            reason: "Rejected by onBeforeSync hook".into(),
                        });
                        continue;
                    }
                    Err(e) => {
                        tracing::warn!("onBeforeSync error (fail-closed): {}", e);
                        responses.push(ServerMessage::SyncReject {
                            op_id: op.id.clone(),
                            reason: format!("onBeforeSync hook error: {}", e),
                        });
                        continue;
                    }
                    _ => {}
                }
            }

            // Apply to XDB
            let mut db = match self.db.lock() {
                Ok(db) => db,
                Err(e) => {
                    responses.push(ServerMessage::SyncReject {
                        op_id: op.id.clone(),
                        reason: format!("Database lock error: {}", e),
                    });
                    continue;
                }
            };
            // Apply and capture the server-generated record ID for creates
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
            drop(db);

            match result {
                Ok(generated_id) => {
                    // For creates, set the server-generated record ID on the op
                    if let Some(id) = generated_id {
                        op.record_id = id;
                    }
                    // Call onAfterSync hook
                    if self.has_after_sync {
                        if let Err(e) = self.call_after_sync(&op) {
                            tracing::warn!("onAfterSync error: {}", e);
                        }
                    }
                    accepted_ops.push(op);
                }
                Err(e) => {
                    responses.push(ServerMessage::SyncReject {
                        op_id: op.id.clone(),
                        reason: format!("DB error: {}", e),
                    });
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

/// Constant-time byte comparison to prevent timing attacks on auth tokens.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}
