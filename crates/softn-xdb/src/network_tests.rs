//! Two real network nodes in one process over real loopback sockets: mDNS
//! discovery, gossipsub delivery, a partition (one node shut down while both
//! sides keep writing), a restart with a fresh peer identity on the same
//! database, and reconciliation to convergence with no manual step.
//!
//! This needs multicast on the host and takes tens of seconds, so it is
//! `#[ignore]`d in the default run. Run it on purpose:
//!
//! ```sh
//! cargo test -p xdb -- --ignored two_nodes --nocapture
//! ```
//!
//! It is the single-machine stand-in for the two-machine LAN qualification;
//! a run on two hosts still has to be recorded separately.
use super::*;
use crate::db::{create_shared_db, SharedDb};
use serde_json::json;
use std::time::{Duration, Instant};

const DISCOVERY: Duration = Duration::from_secs(40);
const DELIVERY: Duration = Duration::from_secs(30);

struct Peer {
    node: NetworkNode,
    // Keeps the event channel open; the loop's sends would otherwise fail.
    _events: broadcast::Receiver<NetworkEvent>,
}

async fn start(db: &SharedDb) -> Peer {
    let (tx, rx) = broadcast::channel(256);
    let node = NetworkNode::new(db.clone(), tx, NetworkOptions::trusted_lan(), SyncGate::new())
        .await
        .expect("node starts");
    Peer { node, _events: rx }
}

fn titles(db: &SharedDb, collection: &str) -> Vec<String> {
    let db = db.lock().unwrap();
    let mut out: Vec<String> = db
        .get_collection(collection)
        .unwrap_or_default()
        .into_iter()
        .filter(|r| !r.deleted)
        .map(|r| r.data["title"].as_str().unwrap_or("").to_string())
        .collect();
    out.sort();
    out
}

fn write(db: &SharedDb, title: &str) -> (Vec<u8>, u64) {
    let mut db = db.lock().unwrap();
    let (_, update) = db.create_record("notes", json!({ "title": title })).unwrap();
    let epoch = db.get_epoch("notes").unwrap();
    (update, epoch)
}

async fn wait_connected(a: &NetworkNode, b: &NetworkNode) {
    let started = Instant::now();
    loop {
        let a_sees_b = a.get_connected_peers().await.contains(&b.local_peer_id());
        let b_sees_a = b.get_connected_peers().await.contains(&a.local_peer_id());
        if a_sees_b && b_sees_a {
            break;
        }
        assert!(
            started.elapsed() < DISCOVERY,
            "peers never connected over loopback (a sees b: {a_sees_b}, b sees a: {b_sees_a}); is multicast available on this host?"
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    // Gossipsub exchanges subscriptions after the connection and forms the
    // mesh on its next heartbeat (1 s in this crate's config).
    tokio::time::sleep(Duration::from_millis(2500)).await;
}

async fn wait_disconnected(a: &NetworkNode, gone: &str) {
    let started = Instant::now();
    while a.get_connected_peers().await.iter().any(|p| p == gone) {
        assert!(started.elapsed() < DISCOVERY, "peer {gone} never disappeared after shutdown");
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

async fn wait_titles(what: &str, db: &SharedDb, expected: &[&str]) {
    let started = Instant::now();
    loop {
        let now = titles(db, "notes");
        if now == expected {
            break;
        }
        assert!(started.elapsed() < DELIVERY, "timed out waiting for {what}: have {now:?}, want {expected:?}");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore]
async fn two_nodes_discover_deliver_partition_and_reconcile_over_loopback() {
    let dir = tempfile::tempdir().unwrap();
    let db_a = create_shared_db(dir.path().join("a.sqlite")).unwrap();
    let db_b = create_shared_db(dir.path().join("b.sqlite")).unwrap();

    // 1. Discovery and connection over real sockets; nothing is configured by hand.
    //    B starts a moment after A so A is listening when B's first query goes
    //    out; the 30 s re-query covers the case where both start at once.
    let a = start(&db_a).await;
    tokio::time::sleep(Duration::from_millis(750)).await;
    let b = start(&db_b).await;
    wait_connected(&a.node, &b.node).await;

    // 2. A write on A is delivered to B through gossipsub.
    let (update, epoch) = write(&db_a, "first");
    a.node.broadcast_update("notes", epoch, update).await.unwrap();
    wait_titles("first record on B", &db_b, &["first"]).await;

    // 3. Partition: B shuts down. Both sides keep writing. A's broadcast has no
    //    subscriber; B's write is local only.
    let old_b = b.node.local_peer_id();
    b.node.shutdown().await.unwrap();
    drop(b);
    wait_disconnected(&a.node, &old_b).await;
    let (update, epoch) = write(&db_a, "second");
    a.node.broadcast_update("notes", epoch, update).await.unwrap();
    let _ = write(&db_b, "offline");
    assert_eq!(titles(&db_a, "notes"), vec!["first", "second"]);
    assert_eq!(titles(&db_b, "notes"), vec!["first", "offline"]);

    // 4. B restarts on the same database with a NEW peer identity (as a real
    //    restart does). The connect-time announce and reconciliation must
    //    converge both databases without any manual sync request.
    tokio::time::sleep(Duration::from_millis(750)).await;
    let b2 = start(&db_b).await;
    assert_ne!(b2.node.local_peer_id(), old_b);
    wait_connected(&a.node, &b2.node).await;
    wait_titles("B catching up after restart", &db_b, &["first", "offline", "second"]).await;
    wait_titles("A receiving B's offline write", &db_a, &["first", "offline", "second"]).await;

    // 5. Live delivery works again in both directions after the reconnect.
    let (update, epoch) = write(&db_b, "after");
    b2.node.broadcast_update("notes", epoch, update).await.unwrap();
    wait_titles("post-reconnect write from B on A", &db_a, &["after", "first", "offline", "second"]).await;
    let (update, epoch) = write(&db_a, "final");
    a.node.broadcast_update("notes", epoch, update).await.unwrap();
    wait_titles("post-reconnect write from A on B", &db_b, &["after", "final", "first", "offline", "second"]).await;

    let stats_a = a.node.stats();
    println!(
        "loopback run: A peer {} / B peers {} -> {}; A stats {:?}",
        a.node.local_peer_id(),
        old_b,
        b2.node.local_peer_id(),
        stats_a
    );
    a.node.shutdown().await.unwrap();
    b2.node.shutdown().await.unwrap();
}
