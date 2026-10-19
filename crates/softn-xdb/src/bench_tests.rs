//! Audit XD-04: repeatable persistence / write-amplification measurements.
//!
//! Not a pass/fail test: it PRINTS a table. Run it explicitly:
//!
//! ```sh
//! cargo test -p xdb --release -- --ignored --nocapture bench_persistence
//! XDB_BENCH_LARGE=1 cargo test -p xdb --release -- --ignored --nocapture bench_persistence
//! ```
//!
//! Fixed record size and seed, three collection sizes (1k / 10k / 50k with
//! `XDB_BENCH_LARGE=1`). Single-operation lanes take SAMPLES independent
//! measurements (bulk import and the batch edit remain one-shot by nature and
//! print the same value for p50 and p95). For every lane it reports p50/p95 latency, SQLite rows
//! touched (`sqlite3_total_changes`), WAL bytes written, the encoded CRDT
//! delta size, the stored `doc_state` size and live database memory is left
//! to the operator's process monitor. Cold startup, warm mutation and the
//! remote-apply path are reported separately, and "duplicate remote apply"
//! (an already-converged peer) is measured on purpose, not only new inserts.
//!
//! The numbers are a BASELINE for the product to set a budget against, not a
//! target invented here. See docs/benchmarks.md for the recorded run.

use super::*;
use serde_json::json;
use std::time::{Duration, Instant};

const EDITS: usize = 50;
const BATCH: usize = 100;
/// Independent samples for the lanes that measure one operation, so p50/p95
/// are distributions rather than a single reading (recheck, September 2026).
const SAMPLES: usize = 7;

fn sizes() -> Vec<usize> {
    if std::env::var("XDB_BENCH_LARGE").is_ok() {
        vec![1_000, 10_000, 50_000]
    } else {
        vec![1_000, 10_000]
    }
}

/// Deterministic ~180-byte record payload.
fn payload(seed: usize) -> serde_json::Value {
    json!({
        "title": format!("record {seed:08}"),
        "body": "The quick brown fox jumps over the lazy dog. ".repeat(3),
        "tags": ["bench", "fixed", "size"],
        "counter": seed,
    })
}

fn percentile(samples: &mut [Duration], pct: f64) -> Duration {
    samples.sort();
    let idx = ((samples.len() as f64 - 1.0) * pct).round() as usize;
    samples[idx.min(samples.len() - 1)]
}

fn wal_bytes(db: &XdbDatabase) -> u64 {
    let mut wal = db.path().clone().into_os_string();
    wal.push("-wal");
    std::fs::metadata(wal).map(|m| m.len()).unwrap_or(0)
}

fn checkpoint(db: &XdbDatabase) {
    let _ = db
        .conn
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)");
}

fn doc_state_bytes(db: &XdbDatabase, collection: &str) -> u64 {
    db.conn
        .query_row(
            "SELECT length(doc_state) FROM crdt_state WHERE collection = ?1",
            [collection],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0) as u64
}

struct Lane {
    name: &'static str,
    p50: Duration,
    p95: Duration,
    rows_per_op: f64,
    wal_per_op: f64,
    delta_bytes: f64,
}

fn lane(name: &'static str, samples: &mut [Duration], rows: u64, wal: u64, delta: u64) -> Lane {
    let n = samples.len().max(1) as f64;
    Lane {
        name,
        p50: percentile(samples, 0.50),
        p95: percentile(samples, 0.95),
        rows_per_op: rows as f64 / n,
        wal_per_op: wal as f64 / n,
        delta_bytes: delta as f64 / n,
    }
}

fn run(n: usize) -> Vec<Lane> {
    let dir = tempfile::tempdir().unwrap();
    let mut db = XdbDatabase::open(dir.path().join("bench.sqlite")).unwrap();
    let mut lanes = Vec::new();

    // ── seed: one bulk import of N records ───────────────────────────────────
    let records: Vec<Record> = (0..n)
        .map(|i| {
            let now = chrono::Utc::now().to_rfc3339();
            Record {
                id: format!("r{i:08}"),
                collection: "bench".into(),
                data: payload(i),
                created_at: now.clone(),
                updated_at: now,
                deleted: false,
            }
        })
        .collect();
    checkpoint(&db);
    let rows0 = db.total_changes();
    let t = Instant::now();
    db.import_records(vec![CollectionImport {
        collection: "bench".into(),
        replace: false,
        records: records.clone(),
    }])
    .unwrap();
    let mut seed = vec![t.elapsed()];
    lanes.push(lane("bulk import (N records, 1 txn)", &mut seed, db.total_changes() - rows0, wal_bytes(&db), doc_state_bytes(&db, "bench")));

    // ── warm single edits ───────────────────────────────────────────────────
    checkpoint(&db);
    let rows0 = db.total_changes();
    let mut samples = Vec::new();
    let mut delta_total = 0u64;
    let mut last_delta = Vec::new();
    for i in 0..EDITS {
        let id = format!("r{:08}", (i * 7919) % n);
        let t = Instant::now();
        let (_, delta) = db.update_record(&id, json!({"counter": i, "edited": true})).unwrap();
        samples.push(t.elapsed());
        delta_total += delta.len() as u64;
        last_delta = delta;
    }
    lanes.push(lane("single edit (warm)", &mut samples, db.total_changes() - rows0, wal_bytes(&db), delta_total));

    // ── one batch of 100 edits in one transaction ───────────────────────────
    checkpoint(&db);
    let rows0 = db.total_changes();
    let updates: Vec<(String, serde_json::Value)> = (0..BATCH)
        .map(|i| (format!("r{:08}", (i * 104729) % n), json!({"batch": i})))
        .collect();
    let t = Instant::now();
    let batch_deltas = db.update_records(updates).unwrap();
    let mut batch = vec![t.elapsed()];
    let batch_delta_bytes: u64 = batch_deltas.iter().map(|(_, d)| d.len() as u64).sum();
    lanes.push(lane("batch edit (100 updates, 1 txn)", &mut batch, db.total_changes() - rows0, wal_bytes(&db), batch_delta_bytes));

    // ── initial sync into an empty peer (SAMPLES independent fresh peers) ──
    let full = db.get_full_state("bench").unwrap();
    let mut initial = Vec::new();
    let mut initial_rows = 0u64;
    let mut initial_wal = 0u64;
    for i in 0..SAMPLES {
        let mut fresh_peer = XdbDatabase::open(dir.path().join(format!("peer-initial-{i}.sqlite"))).unwrap();
        let rows0 = fresh_peer.total_changes();
        let t = Instant::now();
        fresh_peer.apply_remote_update("bench", &full).unwrap();
        initial.push(t.elapsed());
        initial_rows += fresh_peer.total_changes() - rows0;
        initial_wal += wal_bytes(&fresh_peer);
    }
    lanes.push(lane("initial sync (peer applies full state)", &mut initial, initial_rows, initial_wal, full.len() as u64 * SAMPLES as u64));

    // ── remote apply of ONE single-record delta on a converged peer (SAMPLES edits) ──
    let mut peer = XdbDatabase::open(dir.path().join("peer.sqlite")).unwrap();
    peer.apply_remote_update("bench", &full).unwrap();
    let mut remote = Vec::new();
    let mut remote_rows = 0u64;
    let mut remote_wal = 0u64;
    let mut remote_delta = 0u64;
    let mut deltas = Vec::new();
    for i in 0..SAMPLES {
        let (_, fresh) = db.update_record(&format!("r{:08}", (i * 31) % n), json!({"remote": format!("edit {i}")})).unwrap();
        checkpoint(&peer);
        let rows0 = peer.total_changes();
        let t = Instant::now();
        peer.apply_remote_update("bench", &fresh).unwrap();
        remote.push(t.elapsed());
        remote_rows += peer.total_changes() - rows0;
        remote_wal += wal_bytes(&peer);
        remote_delta += fresh.len() as u64;
        deltas.push(fresh);
    }
    lanes.push(lane("remote apply (1-record delta)", &mut remote, remote_rows, remote_wal, remote_delta));

    // ── duplicate delivery of those same deltas (already converged) ─────────
    let mut dup = Vec::new();
    let mut dup_rows = 0u64;
    let mut dup_wal = 0u64;
    for fresh in &deltas {
        checkpoint(&peer);
        let rows0 = peer.total_changes();
        let t = Instant::now();
        peer.apply_remote_update("bench", fresh).unwrap();
        dup.push(t.elapsed());
        dup_rows += peer.total_changes() - rows0;
        dup_wal += wal_bytes(&peer);
    }
    lanes.push(lane("duplicate remote apply (no-op delta)", &mut dup, dup_rows, dup_wal, remote_delta));
    let _ = last_delta;

    // ── restart: cold open + first collection read (SAMPLES reopens) ────────
    let path = db.path().clone();
    drop(db);
    let mut restart = Vec::new();
    let mut cold = XdbDatabase::open(path.clone()).unwrap();
    for _ in 0..SAMPLES {
        drop(cold);
        let t = Instant::now();
        cold = XdbDatabase::open(path.clone()).unwrap();
        let _ = cold.get_collection("bench").unwrap();
        restart.push(t.elapsed());
    }
    lanes.push(lane("restart (open + read collection)", &mut restart, 0, 0, 0));

    // ── compaction proxy: checkpoint + VACUUM ────────────────────────────────
    let t = Instant::now();
    checkpoint(&cold);
    cold.conn.execute_batch("VACUUM").unwrap();
    let mut compact = vec![t.elapsed()];
    lanes.push(lane("compaction (checkpoint + VACUUM)", &mut compact, 0, 0, 0));

    lanes
}

#[test]
#[ignore = "benchmark: cargo test -p xdb --release -- --ignored --nocapture bench_persistence"]
fn bench_persistence_write_amplification() {
    println!();
    println!("XDB persistence benchmark (record ~180 B JSON, {EDITS} single edits, {BATCH}-edit batch)");
    for n in sizes() {
        println!();
        println!("### N = {n} records");
        println!();
        println!("| lane | p50 ms | p95 ms | rows touched / op | WAL bytes / op | delta bytes / op |");
        println!("|---|---:|---:|---:|---:|---:|");
        for lane in run(n) {
            println!(
                "| {} | {:.2} | {:.2} | {:.0} | {:.0} | {:.0} |",
                lane.name,
                lane.p50.as_secs_f64() * 1000.0,
                lane.p95.as_secs_f64() * 1000.0,
                lane.rows_per_op,
                lane.wal_per_op,
                lane.delta_bytes
            );
        }
    }
    println!();
}
