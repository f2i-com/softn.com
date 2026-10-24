//! FormLogic's record events (the PHP host's runtime/record-events.mjs): TEMP
//! triggers the trusted host installs, which write a change to an outbox in
//! the same transaction as the write. An uploaded bundle cannot install a
//! trigger, and only these triggers may touch the outbox.

use std::collections::HashSet;

use rusqlite::{
    hooks::{AuthAction, AuthContext},
    Connection,
};
use serde_json::Value;

use crate::HostError;

pub const RECORD_OUTBOX: &str = "_formlogic_record_events";

fn identifier(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// `/password|token|secret|code_hash|challenge|encrypted|sealed/i`
fn hidden(name: &str) -> bool {
    let lower = name.to_lowercase();
    ["password", "token", "secret", "code_hash", "challenge", "encrypted", "sealed"].iter().any(|w| lower.contains(w))
}

pub struct RecordEvents {
    trusted: HashSet<String>,
}

impl RecordEvents {
    /// Install a trigger for each subscription whose table exists; `None`
    /// when there are none.
    pub fn configure(db: &Connection, subscriptions: &Value) -> Result<Option<Self>, HostError> {
        let Some(list) = subscriptions.as_array().filter(|l| l.len() <= 100) else {
            return Err(HostError::own("Invalid record subscriptions"));
        };
        if list.is_empty() {
            return Ok(None);
        }
        db.execute_batch(&format!(
            "CREATE TABLE IF NOT EXISTS {RECORD_OUTBOX}(id TEXT PRIMARY KEY,event_name TEXT NOT NULL,data_json TEXT NOT NULL,bindings_json TEXT NOT NULL,created_at INTEGER NOT NULL) STRICT"
        ))
        .map_err(HostError::sqlite)?;
        let tables: HashSet<String> = {
            let mut statement = db
                .prepare("SELECT name FROM sqlite_master WHERE type='table' AND substr(name,1,1)!='_' AND name NOT LIKE 'sqlite_%'")
                .map_err(HostError::sqlite)?;
            let rows = statement.query_map([], |row| row.get::<_, String>(0)).map_err(HostError::sqlite)?;
            rows.collect::<Result<_, _>>().map_err(HostError::sqlite)?
        };
        let mut trusted = HashSet::new();
        for (index, subscription) in list.iter().enumerate() {
            let event = subscription.get("event").and_then(Value::as_str).unwrap_or("");
            let bindings = subscription.get("bindings").and_then(Value::as_array);
            let parsed = event.strip_prefix("app.record.").and_then(|rest| rest.split_once('.')).filter(|(operation, table)| {
                matches!(*operation, "created" | "updated" | "deleted")
                    && (1..=63).contains(&table.len())
                    && table.starts_with(|c: char| c.is_ascii_alphabetic())
                    && table.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
            });
            let valid_bindings = bindings.is_some_and(|b| {
                !b.is_empty()
                    && b.len() <= 100
                    && b.iter().all(|id| id.as_str().is_some_and(|s| (1..=100).contains(&s.len()) && s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')))
            });
            let (Some((operation, table)), true) = (parsed, valid_bindings) else {
                return Err(HostError::own("Invalid record subscription"));
            };
            // A migration may remove a table while a paused or old binding still names it.
            if !tables.contains(table) {
                continue;
            }
            let mut columns: Vec<(String, i64)> = {
                let mut statement = db.prepare(&format!("PRAGMA table_info({})", identifier(table))).map_err(HostError::sqlite)?;
                let rows = statement
                    .query_map([], |row| Ok((row.get::<_, String>("name")?, row.get::<_, i64>("pk")?)))
                    .map_err(HostError::sqlite)?;
                rows.collect::<Result<_, _>>().map_err(HostError::sqlite)?
            };
            columns.retain(|(name, _)| !hidden(name));
            columns.sort_by(|a, b| b.1.cmp(&a.1));
            columns.truncate(40);
            let row = if operation == "deleted" { "OLD" } else { "NEW" };
            let pairs: Vec<String> = columns
                .iter()
                .flat_map(|(name, _)| {
                    let value = format!("{row}.{}", identifier(name));
                    [
                        literal(name),
                        format!("CASE WHEN typeof({value})='blob' THEN NULL WHEN typeof({value})='text' THEN substr({value},1,400) ELSE {value} END"),
                    ]
                })
                .collect();
            let trigger = format!("_formlogic_capture_{index}");
            let action = match operation {
                "created" => "INSERT",
                "updated" => "UPDATE",
                _ => "DELETE",
            };
            let bindings_json = serde_json::to_string(bindings.expect("checked above")).map_err(HostError::library)?;
            db.execute_batch(&format!(
                "CREATE TEMP TRIGGER {} AFTER {action} ON main.{} BEGIN
      SELECT CASE WHEN (SELECT count(*) FROM {RECORD_OUTBOX}) >= 10000 THEN RAISE(ABORT,'Record automation queue is full') END;
      INSERT INTO {RECORD_OUTBOX}(id,event_name,data_json,bindings_json,created_at)
      VALUES(lower(hex(randomblob(16))),{},json_object('table',{},'operation',{},'record',json_object({}),'recordPreview',json('true')),{},unixepoch());
    END",
                identifier(&trigger),
                identifier(table),
                literal(event),
                literal(table),
                literal(operation),
                pairs.join(","),
                literal(&bindings_json),
            ))
            .map_err(HostError::sqlite)?;
            trusted.insert(trigger);
        }
        Ok(Some(Self { trusted }))
    }

    /// SQLite names the trigger an operation comes from: only these triggers
    /// may read and write the outbox and call what they call.
    pub fn authorize(&self, ctx: &AuthContext<'_>) -> bool {
        let Some(source) = ctx.accessor else { return false };
        if !self.trusted.contains(source) || ctx.database_name.is_some_and(|d| d != "main") {
            return false;
        }
        match ctx.action {
            AuthAction::Read { table_name, .. } | AuthAction::Insert { table_name } => table_name == RECORD_OUTBOX,
            AuthAction::Function { function_name } => matches!(
                function_name.to_lowercase().as_str(),
                "count" | "raise" | "lower" | "hex" | "randomblob" | "json_object" | "json" | "typeof" | "substr" | "unixepoch"
            ),
            _ => false,
        }
    }
}
