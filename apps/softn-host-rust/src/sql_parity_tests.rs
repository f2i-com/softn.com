//! The SQL contract shared with the PHP host: `apps/softn-host-php/tests/sql-parity.json`
//! (run there by `sql-parity.test.mjs`). Every migration case is applied as its own
//! `.sql` file through `apply_migrations`, every request-time case through
//! `NativeSql`, each on a fresh database built from the fixture's schema.
//!
//! A case whose `rust` note starts with `allowed` or `refused` is one this host
//! answers differently on purpose; the note says why, and this test holds the
//! host to the note instead of `allow`, so a note that stops being true fails
//! here and must be removed from the fixture.
use super::apply_migrations;
use crate::{
    bridges::sql::{open_connection, NativeSql},
    bundle::{ServerBlock, TransactionMode},
};
use serde_json::Value;
use std::{
    path::PathBuf,
    sync::{atomic::AtomicBool, Arc},
};

const PARITY: &str = include_str!("../../softn-host-php/tests/sql-parity.json");

fn fresh(schema: &str) -> (PathBuf, PathBuf) {
    let root = std::env::temp_dir().join(format!("softn-sql-parity-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(root.join("server")).unwrap();
    let path = root.join("application.sqlite");
    open_connection(&path).unwrap().execute_batch(schema).unwrap();
    (root, path)
}

/// What this host must answer: `allow`, unless a `rust` note says otherwise.
fn expected(case: &Value) -> bool {
    let allow = case["allow"].as_bool().expect("allow");
    match case["rust"].as_str() {
        Some(note) if note.starts_with("allowed") => true,
        Some(note) if note.starts_with("refused") => false,
        _ => allow,
    }
}

/// JSON equality with numbers compared by value (3 and 3.0 are the same).
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(x, y)| same(x, y))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w)))
        }
        _ => a == b,
    }
}

#[test]
fn shared_sql_parity_fixture() {
    let parity: Value = serde_json::from_str(PARITY).unwrap();
    let schema = parity["schema"].as_str().unwrap();
    let mut wrong = Vec::new();

    let migrations = parity["migration"].as_array().unwrap();
    for case in migrations {
        let sql = case["sql"].as_str().unwrap();
        let (root, path) = fresh(schema);
        std::fs::write(root.join("server/001.sql"), sql).unwrap();
        let server: ServerBlock = serde_json::from_value(serde_json::json!({
            "database": {"kind": "private-sqlite", "migrations": ["server/001.sql"]}
        }))
        .unwrap();
        let outcome = apply_migrations(&path, &root, &server);
        if outcome.is_ok() != expected(case) {
            wrong.push(format!(
                "migration {}: {sql} ({outcome:?})",
                if outcome.is_ok() { "allowed" } else { "refused" }
            ));
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    let runtime = parity["runtime"].as_array().unwrap();
    for case in runtime {
        let sql = case["sql"].as_str().unwrap();
        let kind = format!("sql.{}", case["kind"].as_str().unwrap());
        let mode = match case["mode"].as_str() {
            Some("read") => TransactionMode::Read,
            _ => TransactionMode::Write,
        };
        let params = case.get("params").cloned().unwrap_or(Value::Array(vec![]));
        let (root, path) = fresh(schema);
        let mut bridge = NativeSql::new(path);
        bridge.begin(mode, Arc::new(AtomicBool::new(false))).unwrap();
        let outcome = bridge.call(&kind, sql, &params.to_string());
        let _ = bridge.finish(false);
        drop(bridge);
        if outcome.is_ok() != expected(case) {
            wrong.push(format!(
                "runtime {}: {kind} {sql:?} ({outcome:?})",
                if outcome.is_ok() { "allowed" } else { "refused" }
            ));
        } else if let (Ok(actual), Some(result)) = (&outcome, case.get("result")) {
            if case.get("rust").is_none() && !same(actual, result) {
                wrong.push(format!("runtime result of {sql:?}: {actual}"));
            }
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    assert!(migrations.len() + runtime.len() > 0);
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}
