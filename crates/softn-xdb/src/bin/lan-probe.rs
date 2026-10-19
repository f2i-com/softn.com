//! `lan-probe`: one XDB network node as a process, for LAN qualification runs
//! across containers or machines (the two-host check the README asks for).
//!
//! It opens a database, starts a node with the trusted-LAN options (mDNS
//! discovery + listening), optionally writes one record and broadcasts it,
//! then waits until the `notes` collection holds the expected number of
//! records (its own plus what peers delivered) or the deadline passes. It
//! prints one JSON line with what it saw and exits 0 on success, 1 on a
//! timeout. Two of these on one Docker bridge network, each writing one
//! record and expecting two, prove discovery, delivery and convergence
//! between separate network stacks; see scripts/lan-two-containers.sh.
//!
//! ```sh
//! cargo run -p xdb --no-default-features --bin lan-probe -- \
//!     --data /tmp/a --label a --write hello-from-a --expect 2 --timeout 90
//! ```
//!
//! Trusted-LAN development feature only: this speaks the v1 protocol on the
//! default namespace with transport identity and no application authorization.
use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde_json::json;
use tokio::sync::broadcast;
use xdb::{create_shared_db, NetworkNode, NetworkOptions, SharedDb, SyncGate};

struct Args {
    data: PathBuf,
    label: String,
    write: Option<String>,
    expect: usize,
    timeout: Duration,
    settle: Duration,
}

fn parse_args() -> Result<Args, String> {
    let mut args = Args {
        data: PathBuf::from("./lan-probe-data"),
        label: "probe".into(),
        write: None,
        expect: 1,
        timeout: Duration::from_secs(90),
        settle: Duration::from_secs(3),
    };
    let mut it = std::env::args().skip(1);
    while let Some(flag) = it.next() {
        let mut value = |name: &str| it.next().ok_or_else(|| format!("{name} needs a value"));
        match flag.as_str() {
            "--data" => args.data = PathBuf::from(value("--data")?),
            "--label" => args.label = value("--label")?,
            "--write" => args.write = Some(value("--write")?),
            "--expect" => args.expect = value("--expect")?.parse().map_err(|e| format!("--expect: {e}"))?,
            "--timeout" => args.timeout = Duration::from_secs(value("--timeout")?.parse().map_err(|e| format!("--timeout: {e}"))?),
            "--settle" => args.settle = Duration::from_secs(value("--settle")?.parse().map_err(|e| format!("--settle: {e}"))?),
            "--help" | "-h" => {
                eprintln!("lan-probe --data DIR --label NAME [--write TITLE] --expect N [--timeout SECS] [--settle SECS]");
                std::process::exit(0);
            }
            other => return Err(format!("unknown flag {other}")),
        }
    }
    Ok(args)
}

fn titles(db: &SharedDb) -> Vec<String> {
    let db = db.lock().expect("database lock");
    let mut out: Vec<String> = db
        .get_collection("notes")
        .unwrap_or_default()
        .into_iter()
        .filter(|r| !r.deleted)
        .map(|r| r.data["title"].as_str().unwrap_or("").to_string())
        .collect();
    out.sort();
    out
}

#[tokio::main]
async fn main() {
    let args = match parse_args() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("lan-probe: {e}");
            std::process::exit(2);
        }
    };
    // RUST_LOG=libp2p_mdns=debug,xdb=debug shows discovery on stderr.
    let _ = tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .with_writer(std::io::stderr)
        .try_init();
    std::fs::create_dir_all(&args.data).expect("data directory");
    let db = create_shared_db(args.data.join("xdb.sqlite")).expect("open database");
    let (tx, _rx) = broadcast::channel(256);
    let node = NetworkNode::new(db.clone(), tx, NetworkOptions::trusted_lan(), SyncGate::new())
        .await
        .expect("network node starts");
    eprintln!("[{}] peer {} listening; discovery on", args.label, node.local_peer_id());

    if let Some(title) = &args.write {
        let (update, epoch) = {
            let mut db = db.lock().expect("database lock");
            let (_, update) = db.create_record("notes", json!({ "title": title, "from": args.label })).expect("create record");
            (update, db.get_epoch("notes").unwrap_or(0))
        };
        // Broadcast now (a subscribed peer receives it) and rely on the
        // connect-time reconciliation for peers that connect later.
        node.broadcast_update("notes", epoch, update).await.expect("broadcast");
        eprintln!("[{}] wrote and broadcast \"{}\"", args.label, title);
    }

    let started = Instant::now();
    let mut reached_at: Option<Instant> = None;
    let outcome = loop {
        let have = titles(&db);
        let peers = node.get_connected_peers().await;
        if have.len() >= args.expect {
            // Hold the result briefly so a late duplicate or a peer's own
            // catch-up request can complete before we exit.
            let at = *reached_at.get_or_insert_with(Instant::now);
            if at.elapsed() >= args.settle {
                break Ok((have, peers));
            }
        } else if started.elapsed() > args.timeout {
            break Err((have, peers));
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    };

    let (ok, (have, peers)) = match outcome {
        Ok(v) => (true, v),
        Err(v) => (false, v),
    };
    let stats = node.stats();
    println!(
        "{}",
        json!({
            "label": args.label,
            "ok": ok,
            "peer_id": node.local_peer_id(),
            "connected_peers": peers,
            "titles": have,
            "expected": args.expect,
            "elapsed_ms": started.elapsed().as_millis(),
            "stats": {
                "publishes_sent": stats.publishes_sent,
                "publishes_without_peers": stats.publishes_without_peers,
                "updates_applied": stats.updates_applied,
                "sync_requests_sent": stats.sync_requests_sent,
                "sync_responses_applied": stats.sync_responses_applied,
            }
        })
    );
    let _ = node.shutdown().await;
    std::process::exit(if ok { 0 } else { 1 });
}
