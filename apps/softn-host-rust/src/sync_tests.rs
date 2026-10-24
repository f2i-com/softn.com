//! The sync manager's tests: tickets and connection slots, pushes and how
//! they are weighed, answered and broadcast, the hooks, and pulls.
use super::*;

fn manager(script: Option<&str>) -> (Arc<SyncManager>, ServerDb) {
    manager_with(script, 1)
}

fn manager_with(script: Option<&str>, workers: usize) -> (Arc<SyncManager>, ServerDb) {
    let dir = crate::test_dirs::temp_path("softn-sync", "");
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("xdb.sqlite");
    let shared = xdb::create_shared_db(path.clone()).unwrap();
    let db = ServerDb::new(shared, &path, 2).unwrap();
    let runtime = script.map(|source| {
        let rt = ServerRuntime::new(|| crate::host::BridgeSet {
            db: None, http: None, fs: None, env: None, sql: None, crypto: None,
            allow_time: false, development: true, allow_photos: false, app_config: serde_json::Value::Null,
        }, Some(workers)).unwrap();
        rt.init(source.to_string()).unwrap();
        rt
    });
    let settings = SyncSettings { max_storage_bytes: 0, sync_permits: 4, force_server_timestamps: false, max_connections: 2, max_connections_per_visitor: 2 };
    (SyncManager::new(db.clone(), runtime, None, path, settings), db)
}

#[test]
fn tickets_are_limited_per_address_with_a_burst_and_a_retry_hint() {
    let limiter = AddressLimiter::new(TICKET_BURST, TICKET_REFILL_PER_SEC);
    let a: std::net::IpAddr = "203.0.113.7".parse().unwrap();
    for _ in 0..TICKET_BURST as usize {
        assert!(limiter.check(a).is_ok());
    }
    let wait = limiter.check(a).unwrap_err();
    assert!(wait >= std::time::Duration::from_secs(1) && wait <= std::time::Duration::from_secs(2), "{wait:?}");
    assert!(limiter.check("203.0.113.8".parse().unwrap()).is_ok(), "another address has its own allowance");
    // One IPv6 /64 is one client; the next /64 is another.
    let v6 = AddressLimiter::new(TICKET_BURST, TICKET_REFILL_PER_SEC);
    for i in 0..TICKET_BURST as usize {
        assert!(v6.check(format!("2001:db8:0:1::{:x}", i + 1).parse().unwrap()).is_ok());
    }
    assert!(v6.check("2001:db8:0:1:ffff::1".parse().unwrap()).is_err());
    assert!(v6.check("2001:db8:0:2::1".parse().unwrap()).is_ok());
    assert_eq!(limiter_key("::ffff:10.0.0.1".parse().unwrap()), "10.0.0.1".parse::<std::net::IpAddr>().unwrap());
}

#[test]
fn a_full_ticket_table_is_busy_and_a_wrong_token_unauthorized() {
    let (sync, _) = manager(None);
    let mut ip = 0u32;
    for _ in 0..MAX_PENDING_TICKETS {
        ip += 1;
        sync.issue_ticket(None, std::net::IpAddr::V4(ip.into())).unwrap();
    }
    assert_eq!(sync.issue_ticket(None, "198.51.100.1".parse().unwrap()), Err(TicketError::Busy));
    let dir = crate::test_dirs::temp_path("softn-sync", "");
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("xdb.sqlite");
    let db = ServerDb::new(xdb::create_shared_db(path.clone()).unwrap(), &path, 2).unwrap();
    let settings = SyncSettings { max_storage_bytes: 0, sync_permits: 4, force_server_timestamps: false, max_connections: 2, max_connections_per_visitor: 2 };
    let guarded = SyncManager::new(db, None, Some("s3cret".into()), path, settings);
    let ip: std::net::IpAddr = "198.51.100.2".parse().unwrap();
    assert_eq!(guarded.issue_ticket(Some("wrong"), ip), Err(TicketError::Unauthorized));
    assert!(guarded.issue_ticket(Some("s3cret"), ip).is_ok());
}

#[test]
fn connection_slots_are_bounded_and_returned() {
    let (sync, _) = manager(None);
    let a: std::net::IpAddr = "203.0.113.7".parse().unwrap();
    let b: std::net::IpAddr = "203.0.113.8".parse().unwrap();
    let first = sync.try_open_connection(a).unwrap();
    let _second = sync.try_open_connection(b).unwrap();
    assert_eq!(sync.try_open_connection("203.0.113.9".parse().unwrap()).err(), Some(ConnectionRefused::Full));
    drop(first);
    assert!(sync.try_open_connection(a).is_ok());
}

/// One visitor cannot take every place: an address, or an IPv6 /64, is
/// held to `maxSyncConnectionsPerVisitor`, and its places come back.
#[test]
fn one_visitor_cannot_take_every_connection() {
    let dir = crate::test_dirs::temp_path("softn-sync", "");
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("xdb.sqlite");
    let db = ServerDb::new(xdb::create_shared_db(path.clone()).unwrap(), &path, 2).unwrap();
    let settings = SyncSettings { max_storage_bytes: 0, sync_permits: 4, force_server_timestamps: false, max_connections: 10, max_connections_per_visitor: 2 };
    let sync = SyncManager::new(db, None, None, path, settings);
    let ip = |s: &str| s.parse::<std::net::IpAddr>().unwrap();
    let first = sync.try_open_connection(ip("2001:db8:0:1::1")).unwrap();
    let _second = sync.try_open_connection(ip("2001:db8:0:1::2")).unwrap();
    // Another address in the same /64 is the same visitor.
    assert_eq!(sync.try_open_connection(ip("2001:db8:0:1:ffff::9")).err(), Some(ConnectionRefused::VisitorFull));
    // The next /64, and an IPv4 visitor, are others.
    assert!(sync.try_open_connection(ip("2001:db8:0:2::1")).is_ok());
    assert!(sync.try_open_connection(ip("198.51.100.1")).is_ok());
    drop(first);
    assert!(sync.try_open_connection(ip("2001:db8:0:1::3")).is_ok());
}

#[test]
fn the_per_visitor_cap_defaults_small_and_never_exceeds_the_total() {
    let settings = |server: serde_json::Value| {
        let manifest: crate::bundle::ServerManifest = serde_json::from_value(serde_json::json!({
            "name": "x", "version": "1", "config": {"server": server}})).unwrap();
        SyncSettings::from_manifest(&manifest, false)
    };
    assert_eq!(settings(serde_json::json!({})).max_connections_per_visitor, DEFAULT_MAX_SYNC_CONNECTIONS_PER_VISITOR);
    assert_eq!(settings(serde_json::json!({"maxSyncConnectionsPerVisitor": 3})).max_connections_per_visitor, 3);
    assert_eq!(settings(serde_json::json!({"maxSyncConnectionsPerVisitor": 0})).max_connections_per_visitor, 1);
    assert_eq!(settings(serde_json::json!({"maxSyncConnections": 4})).max_connections_per_visitor, 4);
}

fn op(id: &str, collection: &str, operation: &str, record: &str, data: serde_json::Value) -> SyncOp {
    SyncOp {
        id: id.into(), collection: collection.into(), operation: operation.into(),
        record_id: record.into(), data: Some(data), timestamp: String::new(), client_id: String::new(),
    }
}

fn rejected(responses: &[ServerMessage]) -> Vec<String> {
    responses.iter().filter_map(|m| match m {
        ServerMessage::SyncReject { op_id, .. } => Some(op_id.clone()),
        _ => None,
    }).collect()
}

/// A hook that guards a collection is the app's authorization for sync.
/// An op naming an allowed collection must not reach a record that lives
/// in a guarded one: xdb looks a record up by id alone.
#[test]
fn an_op_cannot_reach_a_record_in_another_collection() {
    let (sync, db) = manager(Some("function onBeforeSyncBatch(ops) { return ops.filter(function (o) { return o.collection === 'admin'; }).map(function (o) { return o.id; }); }"));
    db.write().upsert_record(xdb::Record {
        id: "root".into(), collection: "admin".into(), data: serde_json::json!({"role":"owner"}),
        created_at: "2026-01-01T00:00:00Z".into(), updated_at: "2026-01-01T00:00:00Z".into(), deleted: false,
    }).unwrap();
    let responses = sync.handle_sync_push(vec![
        op("u1", "notes", "update", "root", serde_json::json!({"role":"guest"})),
        op("d1", "notes", "delete", "root", serde_json::json!({})),
        op("c1", "notes", "create", "root", serde_json::json!({"title":"moved"})),
        op("ok", "notes", "create", "n1", serde_json::json!({"title":"fine"})),
    ], "client");
    let mut refused = rejected(&responses);
    refused.sort();
    assert_eq!(refused, vec!["c1", "d1", "u1"], "{responses:?}");
    let root = db.write().get_record("root").unwrap();
    assert_eq!(root.collection, "admin");
    assert_eq!(root.data, serde_json::json!({"role":"owner"}));
    assert!(!root.deleted);
    assert_eq!(db.write().get_record("n1").unwrap().collection, "notes");
}

fn acked(responses: &[ServerMessage]) -> Vec<String> {
    responses.iter().flat_map(|m| match m {
        ServerMessage::SyncAck { op_ids } => op_ids.clone(),
        _ => Vec::new(),
    }).collect()
}

/// The client sends an op again until it is acknowledged, and an
/// acknowledgement can be lost after the commit. A create that comes back
/// must not undo what happened to the record in between.
#[test]
fn a_create_sent_again_does_not_overwrite_what_changed_since() {
    let (sync, db) = manager(None);
    let first = sync.handle_sync_push(vec![
        op("c1", "notes", "create", "n1", serde_json::json!({"title":"draft"})),
    ], "a");
    assert_eq!(acked(&first), vec!["c1"]);
    // Another client edits the note.
    let edit = sync.handle_sync_push(vec![
        op("u1", "notes", "update", "n1", serde_json::json!({"title":"final"})),
    ], "b");
    assert_eq!(acked(&edit), vec!["u1"]);

    let mut deltas = sync.broadcast_tx.subscribe();
    let again = sync.handle_sync_push(vec![
        op("c1", "notes", "create", "n1", serde_json::json!({"title":"draft"})),
    ], "a");
    // Acknowledged, so the client stops sending it; not refused.
    assert_eq!(acked(&again), vec!["c1"], "{again:?}");
    assert!(rejected(&again).is_empty(), "{again:?}");
    assert_eq!(db.write().get_record("n1").unwrap().data, serde_json::json!({"title":"final"}));
    // And no peer is told to apply the stale payload; its pusher is sent the record as it stands.
    assert!(!reaches_another(&drained(&mut deltas), "a"), "a replayed create was broadcast");
    assert_eq!(told(&again).iter().map(|op| op.data.clone()).collect::<Vec<_>>(), vec![Some(serde_json::json!({"title":"final"}))], "{again:?}");
}

/// An op as a client stamps it, `minutes` before now.
fn stamped(mut op: SyncOp, minutes: i64) -> SyncOp {
    op.timestamp = (chrono::Utc::now() - chrono::Duration::minutes(minutes))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    op
}

/// Last writer wins, by the times the clients stamped their edits: an
/// edit made offline before another client's, and pushed after it, is
/// acknowledged, so the client stops sending it, and not applied.
#[test]
fn a_stale_offline_update_does_not_overwrite_a_newer_one() {
    let (sync, db) = manager(None);
    sync.handle_sync_push(vec![stamped(op("c1", "notes", "create", "n1", serde_json::json!({"title":"first"})), 60)], "a");
    let newer = sync.handle_sync_push(vec![stamped(op("u2", "notes", "update", "n1", serde_json::json!({"title":"final"})), 10)], "b");
    assert_eq!(acked(&newer), vec!["u2"]);

    let mut deltas = sync.broadcast_tx.subscribe();
    let offline = sync.handle_sync_push(vec![stamped(op("u1", "notes", "update", "n1", serde_json::json!({"title":"draft"})), 30)], "a");
    assert_eq!(acked(&offline), vec!["u1"], "{offline:?}");
    assert!(rejected(&offline).is_empty(), "{offline:?}");
    assert_eq!(db.write().get_record("n1").unwrap().data, serde_json::json!({"title":"final"}));
    assert!(!reaches_another(&drained(&mut deltas), "a"), "an overtaken update was broadcast");
}

/// A device that never synced sends every record it has as a create. One
/// the host holds already is acknowledged and not written, as a create sent
/// again is; and its pusher is sent the record as it stands, or one deleted
/// here meanwhile stayed on that device as if it were not.
#[test]
fn a_create_for_a_record_deleted_here_is_answered_with_the_record_deleted() {
    let (sync, db) = manager(None);
    sync.handle_sync_push(vec![stamped(op("c1", "notes", "create", "n1", serde_json::json!({"title":"kept"})), 60)], "b");
    sync.handle_sync_push(vec![stamped(op("d1", "notes", "delete", "n1", serde_json::json!({})), 30)], "b");
    let answer = sync.handle_sync_push(vec![stamped(op("c9", "notes", "create", "n1", serde_json::json!({"title":"kept"})), 50)], "a");
    assert_eq!(acked(&answer), vec!["c9"], "{answer:?}");
    let current = told(&answer);
    assert_eq!(current.len(), 1, "{answer:?}");
    assert_eq!((current[0].operation.as_str(), current[0].record_id.as_str(), current[0].id.as_str()), ("delete", "n1", "c9"));
    assert!(db.write().get_record("n1").unwrap().deleted, "nothing was written");
}

/// A client leaves another's edit to a record it edited until its own edit
/// is answered. The plain acknowledgement went on the connection's own
/// queue, which its writer interleaves with the stream of the other
/// clients' edits as the two are ready: an edit stored after this one could
/// reach the pusher first, be left, and then be written over by the
/// pusher's next edit, which sends its whole record. It goes in the stream
/// now, in the order the store wrote it.
#[test]
fn a_push_is_acknowledged_in_the_stream_before_the_edits_stored_after_it() {
    let (sync, _db) = manager(None);
    sync.handle_sync_push(vec![stamped(op("c1", "notes", "create", "n1", serde_json::json!({"title":"first"})), 60)], "a");
    let mut stream = sync.subscribe();
    let (mine, _) = sync.apply_sync_push(vec![stamped(op("u1", "notes", "update", "n1", serde_json::json!({"title":"a's"})), 30)], "a");
    assert!(acked(&mine).is_empty(), "the acknowledgement is not on the connection's own queue: {mine:?}");
    sync.handle_sync_push(vec![stamped(op("u2", "notes", "update", "n1", serde_json::json!({"title":"b's"})), 10)], "b");
    let to_a = reaching(&drained(&mut stream), "a");
    assert!(matches!(to_a.first(), Some(ServerMessage::SyncAck { op_ids }) if op_ids == &vec!["u1".to_string()]), "{to_a:?}");
    assert!(matches!(to_a.get(1), Some(ServerMessage::SyncDelta { ops }) if ops[0].id == "u2"), "{to_a:?}");
}

/// The ops of the `sync_delta` messages in a push's answer: what the
/// pushing client alone is sent.
fn told(responses: &[ServerMessage]) -> Vec<SyncOp> {
    responses.iter().flat_map(|m| match m {
        ServerMessage::SyncDelta { ops } => ops.clone(),
        _ => Vec::new(),
    }).collect()
}

/// The client that pushed an overtaken edit had applied it to its own
/// copy already. It is sent the record as it stands, in a `sync_delta`
/// it applies as it applies any other, so it does not go on showing an
/// edit the server dropped. Nobody else is sent anything.
#[test]
fn the_pusher_of_an_overtaken_edit_is_sent_the_record_as_it_stands() {
    let (sync, _db) = manager(None);
    sync.handle_sync_push(vec![stamped(op("c1", "notes", "create", "n1", serde_json::json!({"title":"first", "body":"b"})), 60)], "a");
    let newer = stamped(op("u2", "notes", "update", "n1", serde_json::json!({"title":"final", "body":"b"})), 10);
    sync.handle_sync_push(vec![newer.clone()], "b");
    // An edit in time is answered as ever: acknowledged, nothing sent back.
    assert!(told(&sync.handle_sync_push(vec![stamped(op("c2", "notes", "create", "n2", serde_json::json!({"title":"x"})), 5)], "a")).is_empty());

    let mut others = sync.broadcast_tx.subscribe();
    for stale in [
        stamped(op("u1", "notes", "update", "n1", serde_json::json!({"title":"draft", "body":"b"})), 30),
        stamped(op("d1", "notes", "delete", "n1", serde_json::json!({})), 20),
    ] {
        let answer = sync.handle_sync_push(vec![stale.clone()], "a");
        assert_eq!(acked(&answer), vec![stale.id.clone()], "{answer:?}");
        let current = told(&answer);
        assert_eq!(current.len(), 1, "{answer:?}");
        assert_eq!((current[0].operation.as_str(), current[0].collection.as_str(), current[0].record_id.as_str()), ("update", "notes", "n1"));
        assert_eq!(current[0].data, Some(serde_json::json!({"title":"final", "body":"b"})));
        assert_eq!(current[0].timestamp, newer.timestamp);
    }
    assert!(!reaches_another(&drained(&mut others), "a"), "another client was sent something");
    // A record deleted since is told as deleted.
    sync.handle_sync_push(vec![stamped(op("d2", "notes", "delete", "n1", serde_json::json!({})), 3)], "b");
    let mut others = sync.broadcast_tx.subscribe();
    let answer = sync.handle_sync_push(vec![stamped(op("d0", "notes", "delete", "n1", serde_json::json!({})), 40)], "a");
    let current = told(&answer);
    assert_eq!(current.len(), 1, "{answer:?}");
    assert_eq!((current[0].operation.as_str(), current[0].record_id.as_str()), ("delete", "n1"));
    assert!(!reaches_another(&drained(&mut others), "a"), "another client was sent something");
}

/// Everything the sync stream holds now.
fn drained(stream: &mut broadcast::Receiver<(Audience, Arc<ServerMessage>)>) -> Vec<(Audience, Arc<ServerMessage>)> {
    let mut out = Vec::new();
    while let Ok(item) = stream.try_recv() {
        out.push(item);
    }
    out
}

/// Of what the stream held, what `client`'s connection lets through, in order.
fn reaching(items: &[(Audience, Arc<ServerMessage>)], client: &str) -> Vec<ServerMessage> {
    items.iter().filter(|(audience, _)| audience.reaches(client)).map(|(_, message)| (**message).clone()).collect()
}

/// Whether anything the stream held reaches a connection other than `client`'s.
fn reaches_another(items: &[(Audience, Arc<ServerMessage>)], client: &str) -> bool {
    items.iter().any(|(audience, _)| *audience != Audience::Only(client.to_string()))
}

/// The record as it stands, sent to the pusher of an overtaken edit,
/// reaches it in the order the store saw it among the other clients'
/// edits. It went with the push's answer, on the connection's own queue,
/// which the connection's writer interleaves with the stream of other
/// clients' edits in whatever order the two are ready: an edit stored
/// after it could reach the pusher first and then be undone there by
/// the older record, which the device went on showing.
#[test]
fn the_record_as_it_stands_reaches_its_pusher_in_the_order_it_was_read() {
    let (sync, _db) = manager(None);
    sync.handle_sync_push(vec![stamped(op("c1", "notes", "create", "n1", serde_json::json!({"title":"first"})), 60)], "a");
    sync.handle_sync_push(vec![stamped(op("u2", "notes", "update", "n1", serde_json::json!({"title":"second"})), 10)], "b");
    let mut stream = sync.subscribe();
    // a's edit was made offline before b's: overtaken. Then c edits.
    let answer = sync.apply_sync_push(vec![stamped(op("u1", "notes", "update", "n1", serde_json::json!({"title":"draft"})), 30)], "a").0;
    sync.handle_sync_push(vec![stamped(op("u3", "notes", "update", "n1", serde_json::json!({"title":"third"})), 1)], "c");

    let to_a = reaching(&drained(&mut stream), "a");
    let shape: Vec<(&str, Vec<String>)> = to_a.iter().map(|message| match message {
        ServerMessage::SyncAck { op_ids } => ("ack", op_ids.clone()),
        ServerMessage::SyncDelta { ops } => ("delta", ops.iter().map(|op| format!("{} {}", op.id, op.data.as_ref().unwrap()["title"])).collect()),
        other => panic!("{other:?}"),
    }).collect();
    assert_eq!(shape, vec![
        ("ack", vec!["u1".to_string()]),
        ("delta", vec!["u1 \"second\"".to_string()]),
        ("delta", vec!["u3 \"third\"".to_string()]),
    ], "{answer:?}");
    // Said once: the answer itself carries neither.
    assert!(acked(&answer).is_empty() && told(&answer).is_empty(), "{answer:?}");
    // And nobody else is sent a's.
    sync.apply_sync_push(vec![stamped(op("u0", "notes", "update", "n1", serde_json::json!({"title":"older"})), 40)], "a");
    let held = drained(&mut stream);
    assert!(reaching(&held, "b").is_empty() && reaching(&held, "c").is_empty(), "{held:?}");
}

/// One push that edits a record and then deletes it, both overtaken: the
/// record as it stands answers the delete. The pusher keeps a record it
/// deleted hidden until that delete is answered (@softn/core
/// `XDBServerSync.unansweredChanges`), and it knows the answer by the
/// op's id; under the edit's id the record stayed hidden there until the
/// delete's acknowledgement came, which it may do after the record.
#[test]
fn the_record_as_it_stands_answers_an_overtaken_delete_of_the_same_push() {
    let (sync, _db) = manager(None);
    sync.handle_sync_push(vec![stamped(op("c1", "notes", "create", "n1", serde_json::json!({"title":"first"})), 60)], "a");
    sync.handle_sync_push(vec![stamped(op("u2", "notes", "update", "n1", serde_json::json!({"title":"final"})), 10)], "b");
    let answer = sync.handle_sync_push(vec![
        stamped(op("u1", "notes", "update", "n1", serde_json::json!({"title":"draft"})), 40),
        stamped(op("d1", "notes", "delete", "n1", serde_json::json!({})), 30),
    ], "a");
    let current = told(&answer);
    assert_eq!(current.len(), 1, "{answer:?}");
    assert_eq!((current[0].id.as_str(), current[0].operation.as_str()), ("d1", "update"), "{answer:?}");
    let mut ids = acked(&answer);
    ids.sort();
    assert_eq!(ids, vec!["d1", "u1"]);
}

/// An edit is weighed by the time on the device that made it, and a
/// write the server makes itself (a hook's `db.update`) by the server's
/// clock. An edit from a device whose clock is behind the server's,
/// made after such a write, is acknowledged and not applied, and the
/// device is sent the record back. Stamped in the server's time, as the
/// runtime's client now stamps its edits (from `auth_ok.serverTime`,
/// @softn/core xdb-server-sync.ts), the same edit applies.
#[test]
fn an_edit_stamped_by_a_clock_behind_the_servers_loses_to_a_server_write() {
    let (sync, db) = manager(None);
    sync.handle_sync_push(vec![stamped(op("c1", "notes", "create", "n1", serde_json::json!({"title":"first"})), 60)], "a");
    db.write().update_record("n1", serde_json::json!({"seen": true})).unwrap();
    // Made just now on a device ten minutes behind.
    let behind = sync.handle_sync_push(vec![stamped(op("u1", "notes", "update", "n1", serde_json::json!({"title":"edited"})), 10)], "a");
    assert_eq!(acked(&behind), vec!["u1"], "{behind:?}");
    assert_eq!(told(&behind).len(), 1, "{behind:?}");
    assert_eq!(db.write().get_record("n1").unwrap().data["title"], "first", "the edit was applied");
    // The device was sent the record as it stands, the server's write in it,
    // and its next edit carries the whole of it, as every update does.
    let in_server_time = sync.handle_sync_push(vec![stamped(op("u2", "notes", "update", "n1", serde_json::json!({"title":"edited", "seen": true})), 0)], "a");
    assert_eq!(acked(&in_server_time), vec!["u2"]);
    assert!(told(&in_server_time).is_empty(), "{in_server_time:?}");
    assert_eq!(db.write().get_record("n1").unwrap().data, serde_json::json!({"title":"edited", "seen": true}));
}

/// A client stamps to the millisecond and a server write to the
/// nanosecond: an edit stamped in the millisecond of the write is not
/// overtaken by it, one stamped a millisecond before is, and text that is
/// not a time decides nothing. (The test above met the first case on a
/// fast runner, when its edit landed in the same millisecond as the
/// write.)
#[test]
fn edits_and_server_writes_are_weighed_to_the_millisecond() {
    let write = "2026-10-18T12:47:55.322109412+00:00";
    assert!(!overtaken("2026-10-18T12:47:55.322Z", write), "the same millisecond, after the write");
    assert!(overtaken("2026-10-18T12:47:55.321Z", write), "the millisecond before");
    assert!(!overtaken("2026-10-18T12:47:55.323Z", write));
    assert!(overtaken("2026-10-18T12:37:55.322Z", write), "ten minutes behind");
    assert!(!overtaken("not a time", write) && !overtaken("2026-10-18T12:47:55.322Z", "not a time"));
}

/// The client sends an op again until it is acknowledged. An update whose
/// acknowledgement was lost, sent again after another client's newer
/// edit, does not undo that edit; sent again with nothing in between, it
/// leaves the record as it was.
#[test]
fn an_update_sent_again_after_a_lost_ack_is_harmless() {
    let (sync, db) = manager(None);
    sync.handle_sync_push(vec![stamped(op("c1", "notes", "create", "n1", serde_json::json!({"title":"first"})), 60)], "a");
    let u1 = stamped(op("u1", "notes", "update", "n1", serde_json::json!({"title":"draft"})), 30);
    assert_eq!(acked(&sync.handle_sync_push(vec![u1.clone()], "a")), vec!["u1"]);
    assert_eq!(acked(&sync.handle_sync_push(vec![u1.clone()], "a")), vec!["u1"]);
    assert_eq!(db.write().get_record("n1").unwrap().data, serde_json::json!({"title":"draft"}));

    sync.handle_sync_push(vec![stamped(op("u2", "notes", "update", "n1", serde_json::json!({"title":"final"})), 10)], "b");
    let again = sync.handle_sync_push(vec![u1], "a");
    assert_eq!(acked(&again), vec!["u1"], "{again:?}");
    assert_eq!(db.write().get_record("n1").unwrap().data, serde_json::json!({"title":"final"}));
}

/// Edits in the order they were made apply as they always did, in one
/// push or several, and the record keeps the time of the edit that made
/// it what it is: the time later edits are weighed against.
#[test]
fn updates_in_order_still_apply_and_keep_their_time() {
    let (sync, db) = manager(None);
    sync.handle_sync_push(vec![stamped(op("c1", "notes", "create", "n1", serde_json::json!({"title":"first", "body":"b"})), 60)], "a");
    // A client sends the record's whole data with each update.
    let second = stamped(op("u2", "notes", "update", "n1", serde_json::json!({"title":"third", "body":"b"})), 20);
    let pushed = sync.handle_sync_push(vec![
        stamped(op("u1", "notes", "update", "n1", serde_json::json!({"title":"second", "body":"b"})), 30),
        second.clone(),
    ], "a");
    let mut ids = acked(&pushed);
    ids.sort();
    assert_eq!(ids, vec!["u1", "u2"]);
    let record = db.write().get_record("n1").unwrap();
    assert_eq!(record.data, serde_json::json!({"title":"third", "body":"b"}));
    assert_eq!(record.updated_at, second.timestamp);
    // An op the client did not stamp is stamped by the server, now, and applies.
    let unstamped = sync.handle_sync_push(vec![op("u3", "notes", "update", "n1", serde_json::json!({"title":"fourth"}))], "b");
    assert_eq!(acked(&unstamped), vec!["u3"]);
    assert_eq!(db.write().get_record("n1").unwrap().data["title"], "fourth");
}

/// A record may be no larger than one op may carry: each op was held to
/// that, and a record was not, so a few updates of new keys grew one record
/// without end, until every op on it, and every pull of it, was a copy of
/// all of it. An update is the record's whole data now, but the keys a
/// before-hook takes out keep the record's values, and can take it past the
/// limit. The op that would is refused with the reason; one that keeps it
/// within the limit, or makes a record already past it (from before) smaller,
/// applies.
#[test]
fn an_update_cannot_grow_a_record_past_what_one_op_may_carry() {
    // A hook that keeps `k0` as stored, whatever an update sends for it.
    let (sync, db) = manager(Some("function onBeforeSync(op) { if (op.operation !== 'update' || !op.data) return true; var d = {}; for (var k in op.data) { if (k !== 'k0') d[k] = op.data[k]; } return { data: d }; }"));
    let big = "x".repeat(400 * 1024);
    sync.handle_sync_push(vec![stamped(op("c1", "notes", "create", "n1", serde_json::json!({"k0": big})), 60)], "a");
    let grown = sync.handle_sync_push(vec![stamped(op("u1", "notes", "update", "n1", serde_json::json!({"k0": "", "k1": big})), 50)], "a");
    assert_eq!(rejected(&grown), vec!["u1"], "{grown:?}");
    let reason = grown.iter().find_map(|m| match m { ServerMessage::SyncReject { reason, .. } => Some(reason.clone()), _ => None }).unwrap();
    assert!(reason.contains("too large") && reason.contains(&MAX_OP_DATA_BYTES.to_string()), "{reason}");
    assert_eq!(db.write().get_record("n1").unwrap().data, serde_json::json!({"k0": big}));
    let within = sync.handle_sync_push(vec![stamped(op("u2", "notes", "update", "n1", serde_json::json!({"k0": "", "k1": "small"})), 40)], "a");
    assert_eq!(acked(&within), vec!["u2"], "{within:?}");
    assert_eq!(db.write().get_record("n1").unwrap().data, serde_json::json!({"k0": big, "k1": "small"}));

    // A record already past the limit: written before records were held to it.
    let huge = "y".repeat(MAX_OP_DATA_BYTES + 1024);
    db.write().upsert_record(xdb::Record {
        id: "n2".into(), collection: "notes".into(), data: serde_json::json!({"k0": huge, "k1": "z"}),
        created_at: "2026-01-01T00:00:00Z".into(), updated_at: "2026-01-01T00:00:00Z".into(), deleted: false,
    }).unwrap();
    let more = sync.handle_sync_push(vec![stamped(op("u3", "notes", "update", "n2", serde_json::json!({"k0": "", "k1": "z", "k2": "more"})), 30)], "a");
    assert_eq!(rejected(&more), vec!["u3"], "{more:?}");
    let smaller = sync.handle_sync_push(vec![stamped(op("u4", "notes", "update", "n2", serde_json::json!({"k0": ""})), 20)], "a");
    assert_eq!(acked(&smaller), vec!["u4"], "{smaller:?}");
    assert_eq!(db.write().get_record("n2").unwrap().data, serde_json::json!({"k0": huge}));
}

/// A client sends the record's whole data with every update, so a key it
/// leaves out is one it removed. Updates were merged into the record, and a
/// removed key stayed on the server and came back to every device at its
/// next pull. The other clients are sent what was stored; an update that
/// carries no data changes the record's stamp alone.
#[test]
fn an_update_is_the_records_whole_data() {
    let (sync, db) = manager(None);
    sync.handle_sync_push(vec![stamped(op("c1", "notes", "create", "n1", serde_json::json!({"title": "a", "body": "b", "tag": "old"})), 60)], "a");
    let mut stream = sync.subscribe();
    let pushed = sync.handle_sync_push(vec![stamped(op("u1", "notes", "update", "n1", serde_json::json!({"title": "a2", "body": "b"})), 50)], "a");
    assert_eq!(acked(&pushed), vec!["u1"], "{pushed:?}");
    assert_eq!(db.write().get_record("n1").unwrap().data, serde_json::json!({"title": "a2", "body": "b"}));
    let to_b: Vec<SyncOp> = reaching(&drained(&mut stream), "b").into_iter().flat_map(|m| match m { ServerMessage::SyncDelta { ops } => ops, _ => Vec::new() }).collect();
    assert_eq!(to_b.iter().map(|o| o.data.clone()).collect::<Vec<_>>(), vec![Some(serde_json::json!({"title": "a2", "body": "b"}))]);

    let mut bare = stamped(op("u2", "notes", "update", "n1", serde_json::json!({})), 40);
    bare.data = None;
    assert_eq!(acked(&sync.handle_sync_push(vec![bare.clone()], "a")), vec!["u2"]);
    let record = db.write().get_record("n1").unwrap();
    assert_eq!(record.data, serde_json::json!({"title": "a2", "body": "b"}));
    assert_eq!(record.updated_at, bare.timestamp);
}

/// A before-sync hook never sees the stored record: it keeps a client from
/// changing a field by taking the field out of what the client sent, and
/// the record keeps its value, as it did when updates were merged. Laid
/// over the client's data instead, a field a hook deleted would come back
/// from the client. A hook that hands back only some fields (a whitelist)
/// keeps the rest as stored. Every client, the pusher included, is sent the
/// record as stored.
#[test]
fn a_key_a_before_hook_takes_out_keeps_the_records_value() {
    let seed = |db: &ServerDb, data: serde_json::Value| {
        db.write().upsert_record(xdb::Record {
            id: "n1".into(), collection: "notes".into(), data,
            created_at: "2026-01-01T00:00:00Z".into(), updated_at: "2026-01-01T00:00:00Z".into(), deleted: false,
        }).unwrap();
    };
    for script in [
        "function onBeforeSync(op) { if (op.data) delete op.data.role; return { data: op.data }; }",
        "function onBeforeSyncBatch(ops) { return { ops: ops.map(function (op) { if (op.data) delete op.data.role; return { id: op.id, data: op.data }; }) }; }",
    ] {
        let (sync, db) = manager(Some(script));
        seed(&db, serde_json::json!({"title": "x", "role": "user"}));
        let mut stream = sync.subscribe();
        let pushed = sync.handle_sync_push(vec![stamped(op("u1", "notes", "update", "n1", serde_json::json!({"title": "y", "role": "admin"})), 10)], "a");
        assert!(rejected(&pushed).is_empty(), "{script}: {pushed:?}");
        let stored = serde_json::json!({"title": "y", "role": "user"});
        assert_eq!(db.write().get_record("n1").unwrap().data, stored, "{script}");
        let items = drained(&mut stream);
        for client in ["a", "b"] {
            let data: Vec<Option<serde_json::Value>> = reaching(&items, client).into_iter().flat_map(|m| match m { ServerMessage::SyncDelta { ops } => ops, _ => Vec::new() }).map(|o| o.data).collect();
            assert_eq!(data, vec![Some(stored.clone())], "{script}: what reaches {client}");
        }
    }

    let (sync, db) = manager(Some("function onBeforeSync(op) { if (op.data && op.data.title) return { data: { title: op.data.title.trim(), stampedBy: 'server' } }; return true; }"));
    seed(&db, serde_json::json!({"title": "a", "body": "kept"}));
    sync.handle_sync_push(vec![stamped(op("u1", "notes", "update", "n1", serde_json::json!({"title": "  b  ", "body": "changed"})), 10)], "a");
    assert_eq!(db.write().get_record("n1").unwrap().data, serde_json::json!({"title": "b", "stampedBy": "server", "body": "kept"}));
}

/// The per-op after-sync hooks of a push stop being started once their
/// budget is spent, as the before-hooks do: a push of a thousand ops to a
/// hook that takes a little while each ran them all, however long that
/// was. And they hold no sync permit: the push is stored and answered
/// under one, and it is let go before the hooks run, so a slow hook
/// cannot keep it from the next push.
#[test]
fn the_after_sync_hooks_have_a_deadline_and_hold_no_permit() {
    const SLOW: &str = "function onAfterSync(op) { var a = []; for (var i = 0; i < 100000; i++) a.push(i); var n = 0; for (var k = 0; k < 20; k++) n = n + JSON.stringify(a).length; return n; }";
    let ops = |prefix: &str, count: usize| -> Vec<SyncOp> {
        (0..count).map(|i| op(&format!("{prefix}{i}"), "notes", "create", &format!("{prefix}r{i}"), serde_json::json!({"n": i}))).collect()
    };
    // With one worker and with several: the hooks of a push are one run
    // that idle workers take a stretch at a time.
    for workers in [1, 4] {
        let (sync, _db) = manager_with(Some(SLOW), workers);
        // What one hook takes on this machine.
        let started = std::time::Instant::now();
        sync.run_after_sync(&sync.apply_sync_push(ops("one", 1), "a").1);
        let one = started.elapsed();

        sync.after_hook_budget_ms.store(200, std::sync::atomic::Ordering::Relaxed);
        let accepted = sync.apply_sync_push(ops("many", 60), "a").1;
        assert_eq!(accepted.len(), 60);
        let started = std::time::Instant::now();
        sync.run_after_sync(&accepted);
        let many = started.elapsed();
        assert!(many < std::time::Duration::from_millis(200) + one * 4 + std::time::Duration::from_millis(500),
            "{workers} worker(s): 60 hooks took {many:?}, one {one:?}: the budget did not stop them");
    }

    let (sync, _db) = manager(Some(SLOW));
    sync.after_hook_budget_ms.store(200, std::sync::atomic::Ordering::Relaxed);

    // The permit is back as soon as the push is answered.
    let total = sync.sync_permits.available_permits();
    let permit = sync.sync_permits.clone().try_acquire_owned().unwrap();
    let (answered_tx, answered_rx) = std::sync::mpsc::channel();
    let pusher = Arc::clone(&sync);
    let mut stream = sync.subscribe();
    let pushing = std::thread::spawn(move || {
        pusher.push_and_hook(ops("later", 20), "a", permit, |responses| { let _ = answered_tx.send(responses); });
    });
    let responses = answered_rx.recv().unwrap();
    assert!(rejected(&responses).is_empty(), "{responses:?}");
    // Acknowledged in the stream, before the answer was handed back.
    assert_eq!(acked(&reaching(&drained(&mut stream), "a")).len(), 20);
    assert_eq!(sync.sync_permits.available_permits(), total, "the hooks are holding the permit");
    pushing.join().unwrap();
}

/// A delete is weighed the same way: one made before a newer edit does
/// not remove it; one made after does, and keeps its time. An update for
/// a deleted record is refused, as it was.
#[test]
fn deletes_are_weighed_by_their_time_too() {
    let (sync, db) = manager(None);
    sync.handle_sync_push(vec![stamped(op("c1", "notes", "create", "n1", serde_json::json!({"title":"first"})), 60)], "a");
    sync.handle_sync_push(vec![stamped(op("u2", "notes", "update", "n1", serde_json::json!({"title":"final"})), 10)], "b");
    let stale = sync.handle_sync_push(vec![stamped(op("d1", "notes", "delete", "n1", serde_json::json!({})), 30)], "a");
    assert_eq!(acked(&stale), vec!["d1"], "{stale:?}");
    let record = db.write().get_record("n1").unwrap();
    assert!(!record.deleted, "a delete made before the newer edit removed it");
    assert_eq!(record.data, serde_json::json!({"title":"final"}));

    let delete = stamped(op("d2", "notes", "delete", "n1", serde_json::json!({})), 5);
    assert_eq!(acked(&sync.handle_sync_push(vec![delete.clone()], "a")), vec!["d2"]);
    let record = db.write().get_record("n1").unwrap();
    assert!(record.deleted);
    assert_eq!(record.updated_at, delete.timestamp);
    let late = sync.handle_sync_push(vec![stamped(op("u3", "notes", "update", "n1", serde_json::json!({"title":"late"})), 1)], "b");
    assert_eq!(rejected(&late), vec!["u3"], "{late:?}");
}

/// Several clients edit one record at once, each edit weighed against
/// the record and written under the one writer lock: whatever order the
/// pushes arrive in, with one script worker checking them or four, the
/// record ends as the newest edit made it and every op is acknowledged.
#[test]
fn of_edits_pushed_at_once_the_newest_is_the_record() {
    for workers in [1, 4] {
        let (sync, db) = manager_with(Some("function onBeforeSync(op) { return true; }"), workers);
        let began = chrono::Utc::now() - chrono::Duration::seconds(120);
        let at = move |n: i64| (began + chrono::Duration::milliseconds(n)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let mut create = op("c1", "notes", "create", "n1", serde_json::json!({"v": -1}));
        create.timestamp = at(0);
        sync.handle_sync_push(vec![create], "seed");
        const CLIENTS: i64 = 6;
        const EDITS: i64 = 150;
        let pushing: Vec<_> = (0..CLIENTS).map(|client| {
            let sync = Arc::clone(&sync);
            std::thread::spawn(move || {
                let mut answered = 0;
                for i in 0..EDITS {
                    // Half the clients push their edits newest first, as
                    // a device that was offline may.
                    let turn = if client % 2 == 0 { i } else { EDITS - 1 - i };
                    let n = 1 + turn * CLIENTS + client;
                    let mut edit = op(&format!("u{n}"), "notes", "update", "n1", serde_json::json!({"v": n}));
                    edit.timestamp = at(n);
                    // An op the host could not check this time (every
                    // worker taken) is sent again, as a client does.
                    for attempt in 0.. {
                        let answer = sync.handle_sync_push(vec![edit.clone()], &format!("client-{client}"));
                        assert!(rejected(&answer).is_empty(), "{answer:?}");
                        if acked(&answer).len() == 1 {
                            answered += 1;
                            break;
                        }
                        assert!(attempt < 2000 && matches!(answer.as_slice(), [ServerMessage::SyncRetry { .. }]), "{answer:?}");
                        std::thread::sleep(std::time::Duration::from_millis(2));
                    }
                }
                answered
            })
        }).collect();
        let answered: usize = pushing.into_iter().map(|thread| thread.join().unwrap()).sum();
        assert_eq!(answered as i64, CLIENTS * EDITS, "{workers} worker(s)");
        let newest = CLIENTS * EDITS;
        let record = db.write().get_record("n1").unwrap();
        assert_eq!(record.data, serde_json::json!({"v": newest}), "{workers} worker(s)");
        assert_eq!(record.updated_at, at(newest), "{workers} worker(s)");
    }
}

/// An update for a record that has been deleted is refused, whenever it
/// was made. The device that pushed it had the record, edited, on its
/// screen: a full pull sends no deleted records and a refusal changes
/// nothing there, so it went on showing a record every other device had
/// seen deleted. Its pusher is sent the record as it stands, deleted,
/// as the pusher of an overtaken edit is, and nobody else is sent anything.
#[test]
fn the_pusher_of_an_update_to_a_deleted_record_is_told_it_is_deleted() {
    let (sync, db) = manager(None);
    sync.handle_sync_push(vec![stamped(op("c1", "notes", "create", "n1", serde_json::json!({"title":"first"})), 60)], "a");
    sync.handle_sync_push(vec![stamped(op("d1", "notes", "delete", "n1", serde_json::json!({})), 20)], "b");
    let mut others = sync.broadcast_tx.subscribe();
    // Made before the delete (offline) and made after it: refused alike.
    for (id, minutes) in [("u-before", 30), ("u-after", 5)] {
        let answer = sync.handle_sync_push(vec![stamped(op(id, "notes", "update", "n1", serde_json::json!({"title":"edited"})), minutes)], "a");
        assert_eq!(rejected(&answer), vec![id], "{answer:?}");
        assert!(acked(&answer).is_empty(), "{answer:?}");
        let current = told(&answer);
        assert_eq!(current.len(), 1, "{answer:?}");
        assert_eq!((current[0].operation.as_str(), current[0].collection.as_str(), current[0].record_id.as_str()), ("delete", "notes", "n1"));
        assert_eq!(current[0].data, None);
    }
    assert!(db.write().get_record("n1").unwrap().deleted);
    assert!(!reaches_another(&drained(&mut others), "a"), "another client was sent something");
    // An update for a record that was never there has nothing to be told.
    let missing = sync.handle_sync_push(vec![op("u-missing", "notes", "update", "nobody", serde_json::json!({"title":"x"}))], "a");
    assert_eq!(rejected(&missing), vec!["u-missing"]);
    assert!(told(&missing).is_empty(), "{missing:?}");
}

#[test]
fn a_create_sent_again_does_not_bring_back_a_deleted_record() {
    let (sync, db) = manager(None);
    sync.handle_sync_push(vec![op("c1", "notes", "create", "n1", serde_json::json!({"title":"draft"}))], "a");
    sync.handle_sync_push(vec![op("d1", "notes", "delete", "n1", serde_json::json!({}))], "b");
    assert!(db.write().get_record("n1").unwrap().deleted);

    let again = sync.handle_sync_push(vec![
        op("c1", "notes", "create", "n1", serde_json::json!({"title":"draft"})),
        op("c2", "notes", "create", "n2", serde_json::json!({"title":"new"})),
    ], "a");
    let mut ids = acked(&again);
    ids.sort();
    assert_eq!(ids, vec!["c1", "c2"], "{again:?}");
    assert!(db.write().get_record("n1").unwrap().deleted, "the delete was undone");
    // A create for an id that is not there is still a create.
    assert_eq!(db.write().get_record("n2").unwrap().data, serde_json::json!({"title":"new"}));
}

/// `{ data: clean(op.data) }` where `clean` returns nothing: the record
/// keeps its payload instead of becoming JSON null.
#[test]
fn a_per_op_hook_that_returns_no_data_does_not_null_the_record() {
    let (sync, db) = manager(Some(
        "function onBeforeSync(op) { return { data: op.operation === 'update' ? undefined : op.data }; }",
    ));
    sync.handle_sync_push(vec![op("c1", "notes", "create", "n1", serde_json::json!({"title":"draft"}))], "a");
    let responses = sync.handle_sync_push(vec![
        op("u1", "notes", "update", "n1", serde_json::json!({"title":"final"})),
    ], "a");
    assert_eq!(acked(&responses), vec!["u1"], "{responses:?}");
    let data = db.write().get_record("n1").unwrap().data;
    assert!(data.is_object(), "the record's payload became {data}");
    assert_eq!(data["title"], "final");
}

/// The per-op hooks of one push run in order in one VM, whatever the size
/// of the worker pool, and the next push's start from the script as it
/// was loaded. Sent as a call each they were taken by whichever worker
/// was idle, so on four workers a hook that counted the ops of a push
/// numbered them 1, 1, 1, 1, 2, 2 and so on.
#[test]
fn the_per_op_hooks_of_one_push_run_in_order_in_one_world() {
    let (sync, db) = manager_with(Some(
        "var seen = 0; function onBeforeSync(op) { seen = seen + 1; return { data: { seq: seen } }; }",
    ), 4);
    // One stretch, however slowly this machine is running the test.
    sync.runtime.as_ref().unwrap().each_slice_ms.store(600_000, std::sync::atomic::Ordering::Relaxed);
    for prefix in ["a", "b"] {
        let ops: Vec<SyncOp> = (0..12)
            .map(|n| op(&format!("{prefix}{n}"), "notes", "create", &format!("{prefix}-r{n}"), serde_json::json!({"n": n})))
            .collect();
        let responses = sync.handle_sync_push(ops, "a");
        assert_eq!(acked(&responses).len(), 12, "{responses:?}");
        let numbered: Vec<i64> = (0..12)
            .map(|n| db.write().get_record(&format!("{prefix}-r{n}")).unwrap().data["seq"].as_i64().unwrap())
            .collect();
        assert_eq!(numbered, (1..=12).collect::<Vec<i64>>(), "push {prefix}");
    }
}

/// A hook may change an op's data to another object of a size a client
/// may send, and to nothing else: a string would replace the record with
/// that string, and more than a client may send was never checked.
#[test]
fn what_a_before_hook_hands_back_is_held_to_what_a_client_may_send() {
    for hook in [
        "function onBeforeSync(op) { return { data: change(op) }; }",
        "function onBeforeSyncBatch(ops) { return { rejected: [], ops: ops.map(function (op) { return { id: op.id, data: change(op) }; }) }; }",
    ] {
        let source = format!(
            "function change(op) {{
                if (op.data.as === 'text') return 'wiped';
                if (op.data.as === 'list') return [1, 2];
                if (op.data.as === 'huge') return {{ blob: new Array({}).join('x') }};
                if (op.data.as === 'clean') return {{ title: op.data.title.trim() }};
                return op.data;
            }}
            {hook}",
            MAX_OP_DATA_BYTES + 2
        );
        let (sync, db) = manager(Some(&source));
        sync.handle_sync_push(vec![op("c1", "notes", "create", "n1", serde_json::json!({"title":"kept"}))], "a");
        for bad in ["text", "list", "huge"] {
            let responses = sync.handle_sync_push(vec![
                op(&format!("u-{bad}"), "notes", "update", "n1", serde_json::json!({"as": bad})),
            ], "a");
            assert!(acked(&responses).is_empty(), "{bad}: {responses:?}");
            assert!(rejected(&responses).is_empty(), "{bad}: the client keeps the op: {responses:?}");
            assert!(responses.iter().any(|r| matches!(r, ServerMessage::SyncRetry { op_ids, .. } if op_ids == &vec![format!("u-{bad}")])), "{bad}: {responses:?}");
            assert_eq!(db.write().get_record("n1").unwrap().data, serde_json::json!({"title":"kept"}), "{bad} ({hook})");
        }
        // An object of an ordinary size is what a sanitising hook is for.
        let responses = sync.handle_sync_push(vec![
            op("u-clean", "notes", "update", "n1", serde_json::json!({"as":"clean","title":"  tidy  "})),
        ], "a");
        assert_eq!(acked(&responses), vec!["u-clean"], "{responses:?}");
        assert_eq!(db.write().get_record("n1").unwrap().data["title"], "tidy");
    }
}

/// A collection past one page is pulled in pages: each full page says
/// where the next begins, and nothing is sent twice or left out.
#[test]
fn a_pull_past_one_page_says_where_the_next_begins() {
    let (sync, _db) = manager(None);
    sync.pull_page.store(2, std::sync::atomic::Ordering::Relaxed);
    for n in 1..=5 {
        sync.handle_sync_push(vec![op(&format!("c{n}"), "notes", "create", &format!("n{n}"), serde_json::json!({"n": n}))], "a");
    }
    // One that is deleted is in no page.
    sync.handle_sync_push(vec![op("d3", "notes", "delete", "n3", serde_json::json!({}))], "a");

    let page = |cursor: Option<&PullCursor>| {
        let messages = sync.handle_sync_pull(&["notes".to_string()], None, None, cursor.map(|c| (c.at.as_str(), c.id.as_str())));
        let mut ids = Vec::new();
        let mut next = None;
        for (i, message) in messages.iter().enumerate() {
            let ServerMessage::SyncState { records, more, .. } = message else { panic!("{message:?}") };
            ids.extend(records.iter().map(|r| r["id"].as_str().unwrap().to_string()));
            assert!(more.is_none() || i == messages.len() - 1, "only the last piece of a page says there is more");
            next = more.clone();
        }
        (ids, next)
    };
    let (first, more) = page(None);
    assert_eq!(first.len(), 2);
    let more = more.expect("a full page says where the next begins");
    // What a client of today is sent, and what one from before reads past.
    let wire = serde_json::to_value(ServerMessage::SyncState { collection: "notes".into(), records: Vec::new(), more: Some(more.clone()) }).unwrap();
    assert_eq!(wire["more"], serde_json::json!({"at": more.at, "id": more.id}));
    assert!(serde_json::to_value(ServerMessage::SyncState { collection: "notes".into(), records: Vec::new(), more: None }).unwrap().get("more").is_none());

    let (second, more) = page(Some(&more));
    assert_eq!(second.len(), 2);
    let (third, end) = page(Some(&more.expect("the second page was full too")));
    assert!(end.is_none(), "a page that is not full is the last");
    let mut all = [first, second, third].concat();
    all.sort();
    assert_eq!(all, vec!["n1", "n2", "n4", "n5"]);
}

/// The acknowledgement and the broadcast do not wait for the after-hooks.
#[test]
fn a_push_is_answered_and_broadcast_before_its_after_hooks_run() {
    let dir = crate::test_dirs::temp_path("softn-sync-after", "");
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("xdb.sqlite");
    let db = ServerDb::new(xdb::create_shared_db(path.clone()).unwrap(), &path, 2).unwrap();
    let hook_db = db.clone();
    let runtime = ServerRuntime::new(move || crate::host::BridgeSet {
        db: Some(Box::new(crate::bridges::db::NativeDbBridge::new(hook_db.clone()))),
        http: None, fs: None, env: None, sql: None, crypto: None,
        allow_time: false, development: true, allow_photos: false, app_config: serde_json::Value::Null,
    }, Some(1)).unwrap();
    runtime.init("function onAfterSyncBatch(ops) { db.create('audit', { seen: ops.length }); }".to_string()).unwrap();
    let settings = SyncSettings { max_storage_bytes: 0, sync_permits: 4, force_server_timestamps: false, max_connections: 2, max_connections_per_visitor: 2 };
    let sync = SyncManager::new(db.clone(), Some(runtime), None, path, settings);
    let mut deltas = sync.subscribe();
    let audited = || {
        let conn = db.read().unwrap();
        pool::read_collection(&conn, "audit").unwrap().len()
    };

    let (responses, stored) = sync.apply_sync_push(vec![op("c1", "notes", "create", "n1", serde_json::json!({"title": "x"}))], "a");
    assert!(rejected(&responses).is_empty(), "{responses:?}");
    // The pusher's acknowledgement, and the other clients' edit, are in the stream already.
    let told = drained(&mut deltas);
    assert_eq!(acked(&reaching(&told, "a")), vec!["c1"], "{told:?}");
    assert!(reaches_another(&told, "a"), "the other clients are told with the answer");
    assert_eq!(audited(), 0, "the after-hook ran before the push was answered");
    assert_eq!(stored.len(), 1);
    sync.run_after_sync(&stored);
    assert_eq!(audited(), 1, "and it does run");
    // Nothing stored, nothing to hook.
    sync.run_after_sync(&[]);
    assert_eq!(audited(), 1);
}

/// Past its budget the per-op before-hook checks no more ops of a push;
/// the client keeps the rest. The first is always checked.
#[test]
fn a_before_hook_that_runs_out_of_time_leaves_the_rest_for_the_client() {
    let (sync, db) = manager(Some("function onBeforeSync(op) { return true; }"));
    sync.before_hook_budget_ms.store(0, std::sync::atomic::Ordering::Relaxed);
    let responses = sync.handle_sync_push(vec![
        op("c1", "notes", "create", "n1", serde_json::json!({"n": 1})),
        op("c2", "notes", "create", "n2", serde_json::json!({"n": 2})),
        op("c3", "notes", "create", "n3", serde_json::json!({"n": 3})),
    ], "a");
    assert_eq!(acked(&responses), vec!["c1"], "{responses:?}");
    assert!(rejected(&responses).is_empty(), "nothing is refused for good: {responses:?}");
    let retried: Vec<String> = responses.iter().flat_map(|r| match r {
        ServerMessage::SyncRetry { op_ids, .. } => op_ids.clone(),
        _ => Vec::new(),
    }).collect();
    assert_eq!(retried, vec!["c2", "c3"]);
    assert!(db.write().get_record("n1").is_ok() && db.write().get_record("n2").is_err());
    // With time to spare every op is checked.
    sync.before_hook_budget_ms.store(60_000, std::sync::atomic::Ordering::Relaxed);
    let responses = sync.handle_sync_push(vec![
        op("c2", "notes", "create", "n2", serde_json::json!({"n": 2})),
        op("c3", "notes", "create", "n3", serde_json::json!({"n": 3})),
    ], "a");
    let mut ids = acked(&responses);
    ids.sort();
    assert_eq!(ids, vec!["c2", "c3"]);
}

/// A push writes each collection's CRDT document once, not once an op,
/// and what it writes is still every op of the push but the one refused.
#[test]
fn a_push_saves_each_collections_document_once() {
    let ops = |prefix: &str| -> Vec<SyncOp> {
        (0..20).map(|n| op(&format!("{prefix}{n}"), "notes", "create", &format!("n{n}"), serde_json::json!({"n": n}))).collect()
    };
    // Twenty ops in one push, and the same twenty a push each: the rows
    // are the same, and the one push saves the document nineteen fewer times.
    let (together, db_together) = manager(None);
    let before = db_together.write().total_changes();
    let responses = together.handle_sync_push(ops("c"), "a");
    assert_eq!(acked(&responses).len(), 20, "{responses:?}");
    let one_push = db_together.write().total_changes() - before;

    let (apart, db_apart) = manager(None);
    let before = db_apart.write().total_changes();
    for single in ops("c") {
        apart.handle_sync_push(vec![single], "a");
    }
    let twenty_pushes = db_apart.write().total_changes() - before;
    assert_eq!(twenty_pushes - one_push, 19, "{one_push} changes for one push, {twenty_pushes} for twenty");

    // One op of a push refused by the store (an update of a record that
    // is not there); the rest, on both sides of it, are in the document a
    // peer would be sent.
    let mixed = together.handle_sync_push(vec![
        op("u1", "notes", "update", "n1", serde_json::json!({"edited": true})),
        op("u-missing", "notes", "update", "nobody", serde_json::json!({"edited": true})),
        op("u2", "notes", "update", "n2", serde_json::json!({"edited": true})),
    ], "a");
    let mut done = acked(&mixed);
    done.sort();
    assert_eq!(done, vec!["u1", "u2"], "{mixed:?}");
    assert_eq!(rejected(&mixed), vec!["u-missing"]);
    let state = db_together.write().get_full_state("notes").unwrap();
    let dir = crate::test_dirs::temp_path("softn-sync-peer", "");
    std::fs::create_dir_all(&dir).unwrap();
    let peer = xdb::create_shared_db(dir.join("peer.sqlite")).unwrap();
    let peer_db = ServerDb::new(peer, &dir.join("peer.sqlite"), 2).unwrap();
    peer_db.write().apply_remote_update("notes", &state).unwrap();
    let replicated = peer_db.write().get_collection("notes").unwrap();
    assert_eq!(replicated.len(), 20);
    let edited: Vec<&str> = replicated.iter().filter(|r| r.data["edited"] == true).map(|r| r.id.as_str()).collect();
    assert_eq!(edited.len(), 2, "{edited:?}");
    assert!(edited.contains(&"n1") && edited.contains(&"n2"));
}

/// What an after-sync hook throws reaches the caller, which logs it.
#[test]
fn an_after_sync_hook_that_throws_is_reported() {
    let (sync, _) = manager(Some("function onAfterSyncBatch(ops) { throw new Error('mail is down'); } function onAfterSync(op) { throw new Error('mail is down'); }"));
    let ops = vec![op("c1", "notes", "create", "n1", serde_json::json!({}))];
    let batch = sync.call_after_sync_batch(&ops).unwrap_err();
    assert!(batch.contains("mail is down"), "{batch}");
    let single = sync.call_after_sync_each(&ops[..1]).remove(0);
    assert!(single.contains("mail is down"), "{single}");
}

/// A pull is chunked by bytes as well as by count: the client drops any
/// message over 2 MB, so a count-only chunk of large records never lands.
#[test]
fn a_pull_is_chunked_under_the_clients_message_limit() {
    let (sync, db) = manager(None);
    let big = "x".repeat(300 * 1024);
    for i in 0..20 {
        db.write().upsert_record(xdb::Record {
            id: format!("r{i}"), collection: "docs".into(), data: serde_json::json!({"body": big}),
            created_at: "2026-01-01T00:00:00Z".into(), updated_at: "2026-01-01T00:00:00Z".into(), deleted: false,
        }).unwrap();
    }
    let messages = sync.handle_sync_pull(&["docs".to_string()], None, None, None);
    let mut total = 0;
    for message in &messages {
        let bytes = serde_json::to_vec(message).unwrap().len();
        assert!(bytes <= 2 * 1024 * 1024, "a {bytes}-byte sync_state would be discarded by the client");
        if let ServerMessage::SyncState { records, .. } = message { total += records.len(); }
    }
    assert_eq!(total, 20);
    assert!(messages.len() > 1);
}

/// A pull is read a message at a time, each when the one before has
/// gone: it holds one message's records, where it used to read every
/// collection it named, up to ten thousand records each, into memory
/// before the first was sent. What is sent is what was sent before, in
/// the same messages: by collection, chunked by count and by bytes, a
/// collection with nothing in it still answered, and an incremental pull
/// with the deleted records as well.
#[test]
fn a_pull_is_read_one_message_at_a_time() {
    let (sync, db) = manager(None);
    let put = |id: String, collection: &str, received: usize, deleted: bool| {
        db.write().upsert_record(xdb::Record {
            id, collection: collection.into(), data: serde_json::json!({"n": received}),
            created_at: "2026-01-01T00:00:00Z".into(), updated_at: "2026-01-01T00:00:00Z".into(), deleted,
        }).unwrap();
    };
    for i in 0..1200 { put(format!("a{i:04}"), "alpha", i, false); }
    for i in 0..3 { put(format!("b{i}"), "beta", i, i == 1); }
    let names: Vec<String> = ["alpha", "beta", "gamma"].iter().map(|s| s.to_string()).collect();
    let records = |message: &ServerMessage| match message {
        ServerMessage::SyncState { collection, records, .. } => (collection.clone(), records.len()),
        other => panic!("{other:?}"),
    };

    let mut pull = sync.start_pull(&names, None, None, None).unwrap();
    let mut steps = Vec::new();
    while let Some(message) = sync.pull_step(&mut pull) {
        assert!(pull.chunk.len() <= SYNC_PULL_CHUNK_SIZE, "a step kept {} records", pull.chunk.len());
        steps.push(message);
    }
    assert_eq!(steps.iter().map(records).collect::<Vec<_>>(), vec![
        ("alpha".to_string(), 500), ("alpha".to_string(), 500), ("alpha".to_string(), 200),
        ("beta".to_string(), 2), ("gamma".to_string(), 0),
    ]);
    let all = serde_json::to_string(&sync.handle_sync_pull(&names, None, None, None)).unwrap();
    assert_eq!(serde_json::to_string(&steps).unwrap(), all, "the pull a step at a time is the pull");

    // Incremental: what changed since a point, the deleted included, in order.
    let since = "0000";
    let mut pull = sync.start_pull(&names[1..2], Some(since), None, None).unwrap();
    let first = sync.pull_step(&mut pull).unwrap();
    assert!(sync.pull_step(&mut pull).is_none());
    let ServerMessage::SyncState { records, more, .. } = first else { panic!() };
    assert!(more.is_none());
    let ids: Vec<(String, bool)> = records.iter().map(|r| (r["id"].as_str().unwrap().to_string(), r.get("deleted").is_some())).collect();
    assert_eq!(ids, vec![("b0".to_string(), false), ("b1".to_string(), true), ("b2".to_string(), false)]);
}

/// Other clients are sent a push's ops in the order the pushes were
/// stored. They were sent once the writer lock had been let go, after
/// the acknowledgement was made and the ops copied, so a push stored
/// second could be sent first, and the larger the first push the longer
/// its copying took. A client applies what it is sent as it comes: of
/// two edits to one record it was left showing the older, while the
/// server, and the client that made the newer, had the newer.
///
/// Several clients push at once here, one of them in large pushes. Every
/// op creates a record, so the table's row numbers are the order the
/// pushes were stored in, and the records must be sent on in that order.
#[test]
fn pushes_reach_other_clients_in_the_order_they_were_stored() {
    let (sync, _db) = manager(None);
    let mut deltas = sync.subscribe();
    let listener = std::thread::spawn(move || {
        let mut sent = Vec::new();
        loop {
            match deltas.blocking_recv() {
                Ok((_, message)) if matches!(*message, ServerMessage::SyncDelta { .. }) => {
                    let ServerMessage::SyncDelta { ops } = &*message else { unreachable!() };
                    for op in ops {
                        if op.record_id == "end" {
                            return sent;
                        }
                        sent.push(op.record_id.clone());
                    }
                }
                // What a slow listener missed is left out; what it has is still in order.
                Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {}
                Err(broadcast::error::RecvError::Closed) => return sent,
            }
        }
    });

    let mut pushing = Vec::new();
    {
        // One client pushes six hundred records at a time.
        let sync = Arc::clone(&sync);
        pushing.push(std::thread::spawn(move || {
            let tags: Vec<String> = (0..60).map(|n| format!("tag {n}")).collect();
            for round in 0..12 {
                let ops: Vec<SyncOp> = (0..600)
                    .map(|i| op(&format!("b{round}-{i}"), "bulk", "create", &format!("bulk-{round}-{i}"), serde_json::json!({"tags": tags})))
                    .collect();
                assert_eq!(acked(&sync.handle_sync_push(ops, "bulk")).len(), 600);
            }
        }));
    }
    for client in 0..3 {
        // The others push one record after another.
        let sync = Arc::clone(&sync);
        pushing.push(std::thread::spawn(move || {
            for i in 0..300 {
                let create = op(&format!("c{client}-{i}"), "notes", "create", &format!("note-{client}-{i}"), serde_json::json!({"n": i}));
                assert_eq!(acked(&sync.handle_sync_push(vec![create], &format!("client-{client}"))).len(), 1);
            }
        }));
    }
    for thread in pushing {
        thread.join().unwrap();
    }
    sync.handle_sync_push(vec![op("end", "notes", "create", "end", serde_json::json!({}))], "seed");
    let sent = listener.join().unwrap();

    let direct = rusqlite::Connection::open(&sync.db_path).unwrap();
    let stored: std::collections::HashMap<String, i64> = direct
        .prepare("SELECT id, rowid FROM records").unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?))).unwrap()
        .collect::<Result<_, _>>().unwrap();
    assert!(sent.len() > 1000, "only {} of the records were sent on", sent.len());
    let rows: Vec<i64> = sent.iter().map(|id| stored[id]).collect();
    let late = rows.windows(2).filter(|pair| pair[1] < pair[0]).count();
    assert_eq!(late, 0, "{late} time(s) a push was sent on after one stored later");
}

/// The ids a full pull of `notes` sends, page after page as a client
/// asks for them, in the order they are sent.
fn pulled_in_pages(sync: &SyncManager) -> Vec<String> {
    let mut ids = Vec::new();
    let mut cursor: Option<PullCursor> = None;
    for _ in 0..1000 {
        let messages = sync.handle_sync_pull(&["notes".to_string()], None, None, cursor.as_ref().map(|c| (c.at.as_str(), c.id.as_str())));
        cursor = None;
        for message in messages {
            let ServerMessage::SyncState { records, more, .. } = message else { panic!("{message:?}") };
            ids.extend(records.iter().map(|r| r["id"].as_str().unwrap().to_string()));
            cursor = more;
        }
        if cursor.is_none() {
            return ids;
        }
    }
    panic!("the pull went on asking for more after {} records", ids.len());
}

/// Each step of a pull goes on from the last record the step before
/// read, and each page from the last record of the page before. Through
/// records received in the same millisecond (a bulk statement stamps
/// every row it touches alike), through records with no receipt time
/// (null, or empty, from a host before there were receipt times), and
/// with the ends of messages and of pages falling among both, every
/// record is sent once, in the order `COALESCE(server_received_at, '')`,
/// id: the order the pull was read in when it was one query.
#[test]
fn a_pull_in_steps_and_pages_sends_every_record_once_in_the_one_order() {
    let (sync, db) = manager(None);
    for i in 0..1300 {
        db.write().upsert_record(xdb::Record {
            id: format!("n{i:04}"), collection: "notes".into(), data: serde_json::json!({"n": i}),
            created_at: "2026-01-01T00:00:00Z".into(), updated_at: "2026-01-01T00:00:00Z".into(), deleted: false,
        }).unwrap();
    }
    let direct = rusqlite::Connection::open(&sync.db_path).unwrap();
    // 650 records in one millisecond and 450 in the next, 50 as they were
    // received, and 150 with no receipt time: null and empty by turns.
    direct.execute_batch(
        "UPDATE records SET server_received_at = '2026-01-01T00:00:00.000Z' WHERE id < 'n0650';
         UPDATE records SET server_received_at = '2026-01-01T00:00:00.001Z' WHERE id >= 'n0650' AND id < 'n1100';
         UPDATE records SET server_received_at = NULL WHERE id >= 'n1150';
         UPDATE records SET server_received_at = '' WHERE id >= 'n1150' AND substr(id, 5, 1) IN ('1', '3', '5', '7', '9');",
    ).unwrap();
    let wanted: Vec<String> = direct
        .prepare("SELECT id FROM records WHERE collection = 'notes' AND deleted = 0 ORDER BY COALESCE(server_received_at, '') ASC, id ASC").unwrap()
        .query_map([], |row| row.get(0)).unwrap().collect::<Result<_, _>>().unwrap();
    assert_eq!(wanted.len(), 1300);
    assert!(wanted[0] == "n1150" && wanted[149] == "n1299" && wanted[150] == "n0000", "{:?}", &wanted[..3]);

    // A page the size of the collection, pages that end among the
    // records with no receipt time, among the ties, and on a message's end.
    for page in [10_000, 700, 500, 100, 7] {
        sync.pull_page.store(page, std::sync::atomic::Ordering::Relaxed);
        let sent = pulled_in_pages(&sync);
        assert_eq!(sent.len(), wanted.len(), "pages of {page}");
        assert!(sent == wanted, "pages of {page}: sent in another order, or one twice");
    }

    // An incremental pull, from a record among the ties: the rest, the
    // records with no receipt time left out as they always were.
    let since = sync.handle_sync_pull(&["notes".to_string()], Some("2026-01-01T00:00:00.000Z"), Some("n0100"), None);
    let ids: Vec<String> = since.iter().flat_map(|m| match m {
        ServerMessage::SyncState { records, .. } => records.iter().map(|r| r["id"].as_str().unwrap().to_string()).collect::<Vec<_>>(),
        other => panic!("{other:?}"),
    }).collect();
    assert_eq!(ids, wanted[251..].to_vec());
}

/// Records are written while a pull is between two of its steps. One not
/// yet read that is changed is sent once, as changed (it has moved to
/// the end, where it is read); one already sent that is changed is sent
/// again, as changed; one not yet read that is deleted is not sent; and
/// the pull ends.
#[test]
fn records_written_between_the_steps_of_a_pull_are_neither_lost_nor_sent_for_ever() {
    let (sync, _db) = manager(None);
    let creates: Vec<SyncOp> = (0..1200)
        .map(|i| op(&format!("c{i}"), "notes", "create", &format!("n{i:04}"), serde_json::json!({"n": i})))
        .collect();
    for batch in creates.chunks(400) {
        assert_eq!(acked(&sync.handle_sync_push(batch.to_vec(), "a")).len(), 400);
    }
    let mut pull = sync.start_pull(&["notes".to_string()], None, None, None).unwrap();
    let mut sent: Vec<(String, serde_json::Value)> = Vec::new();
    let take = |message: ServerMessage, sent: &mut Vec<(String, serde_json::Value)>| {
        let ServerMessage::SyncState { records, .. } = message else { panic!("{message:?}") };
        sent.extend(records.iter().map(|r| (r["id"].as_str().unwrap().to_string(), r["data"].clone())));
    };
    take(sync.pull_step(&mut pull).unwrap(), &mut sent);
    assert_eq!(sent.len(), 500);
    let pushed = sync.handle_sync_push(vec![
        op("u-unread", "notes", "update", "n0800", serde_json::json!({"n": 800, "edited": true})),
        op("u-sent", "notes", "update", "n0010", serde_json::json!({"n": 10, "edited": true})),
        op("d-unread", "notes", "delete", "n0900", serde_json::json!({})),
    ], "b");
    assert_eq!(acked(&pushed).len(), 3, "{pushed:?}");
    let mut steps = 1;
    while let Some(message) = sync.pull_step(&mut pull) {
        take(message, &mut sent);
        steps += 1;
        assert!(steps < 50, "the pull did not end");
    }
    let of = |id: &str| -> Vec<&serde_json::Value> { sent.iter().filter(|(sent_id, _)| sent_id == id).map(|(_, data)| data).collect() };
    assert_eq!(of("n0800"), vec![&serde_json::json!({"n": 800, "edited": true})]);
    assert_eq!(of("n0010"), vec![&serde_json::json!({"n": 10}), &serde_json::json!({"n": 10, "edited": true})]);
    assert!(of("n0900").is_empty());
    for i in (0..1200).filter(|i| ![800, 10, 900].contains(i)) {
        assert_eq!(of(&format!("n{i:04}")).len(), 1, "n{i:04}");
    }
}

/// Naming one collection many times in one pull used to read it that many
/// times into memory: a 4 MB message could hold a hundred thousand names.
#[test]
fn a_pull_reads_each_collection_once_and_bounds_how_many() {
    let (sync, db) = manager(None);
    db.write().upsert_record(xdb::Record {
        id: "a".into(), collection: "notes".into(), data: serde_json::json!({}),
        created_at: "2026-01-01T00:00:00Z".into(), updated_at: "2026-01-01T00:00:00Z".into(), deleted: false,
    }).unwrap();
    let repeated: Vec<String> = std::iter::repeat_n("notes".to_string(), 5_000).collect();
    let messages = sync.handle_sync_pull(&repeated, None, None, None);
    assert_eq!(messages.len(), 1, "one sync_state for one distinct collection");
    let many: Vec<String> = (0..MAX_PULL_COLLECTIONS + 1).map(|i| format!("c{i}")).collect();
    let messages = sync.handle_sync_pull(&many, None, None, None);
    assert!(matches!(messages.as_slice(), [ServerMessage::Error { .. }]), "{} messages", messages.len());
}

// ── The audit of 2026-10-21 ──

/// Every `sync_delta` the stream holds for `client`, as the JSON it is sent as.
fn deltas_for(items: &[(Audience, Arc<ServerMessage>)], client: &str) -> Vec<String> {
    reaching(items, client).iter()
        .filter(|m| matches!(m, ServerMessage::SyncDelta { .. }))
        .map(|m| serde_json::to_string(m).unwrap())
        .collect()
}

fn ops_of(json: &[String]) -> Vec<serde_json::Value> {
    json.iter().flat_map(|text| serde_json::from_str::<serde_json::Value>(text).unwrap()["ops"].as_array().unwrap().clone()).collect()
}

/// A record of about `kb` kilobytes.
fn sized(kb: usize, tag: &str) -> serde_json::Value {
    serde_json::json!({"v": tag, "pad": "p".repeat(kb * 1024)})
}

/// A device edited six records offline; another made each about 400 KB. The
/// host answered the first device's stale edits with all six records as they
/// stand in one 2.4 MB message, which the client dropped (it took 2 MB), so
/// it kept the edits that lost. They go in pieces the client takes.
#[test]
fn overruled_records_reach_their_pusher_in_pieces_a_client_takes() {
    let (sync, _db) = manager(None);
    let ids: Vec<String> = (0..6).map(|i| format!("n{i}")).collect();
    sync.handle_sync_push(ids.iter().map(|id| stamped(op(&format!("c-{id}"), "notes", "create", id, serde_json::json!({"v": "a"})), 60)).collect(), "a");
    for pair in ids.chunks(2) {
        let answer = sync.handle_sync_push(pair.iter().map(|id| stamped(op(&format!("b-{id}"), "notes", "update", id, sized(400, "b")), 10)).collect(), "b");
        assert_eq!(acked(&answer).len(), 2, "{answer:?}");
    }
    let mut stream = sync.subscribe();
    let answer = sync.apply_sync_push(ids.iter().map(|id| stamped(op(&format!("a2-{id}"), "notes", "update", id, serde_json::json!({"v": "a2"})), 30)).collect(), "a").0;
    assert!(rejected(&answer).is_empty(), "{answer:?}");
    let held = drained(&mut stream);
    let pieces = deltas_for(&held, "a");
    assert!(pieces.len() >= 3, "{} message(s)", pieces.len());
    for piece in &pieces {
        assert!(piece.len() <= SYNC_PULL_CHUNK_BYTES + 64, "a piece of {} bytes", piece.len());
        assert!(piece.len() < crate::http::MAX_WS_MESSAGE_SIZE);
    }
    let records = ops_of(&pieces);
    assert_eq!(records.len(), 6);
    assert!(records.iter().all(|op| op["data"]["v"] == "b" && op["clientId"] == "server"), "the records as they stand");
    // Acknowledged first, in the same stream.
    assert!(matches!(reaching(&held, "a").first(), Some(ServerMessage::SyncAck { op_ids }) if op_ids.len() == 6));
    assert!(!reaches_another(&held, "a"));
}

/// The other clients are sent a push in pieces too: a push may carry 4 MiB of data.
#[test]
fn a_large_push_reaches_the_other_clients_in_pieces() {
    let (sync, _db) = manager(None);
    let mut stream = sync.subscribe();
    let answer = sync.handle_sync_push((0..8).map(|i| op(&format!("c{i}"), "notes", "create", &format!("n{i}"), sized(400, "x"))).collect(), "a");
    assert_eq!(acked(&answer).len(), 8, "{answer:?}");
    let pieces = deltas_for(&drained(&mut stream), "b");
    assert!(pieces.len() >= 4, "{} message(s)", pieces.len());
    assert!(pieces.iter().all(|piece| piece.len() <= SYNC_PULL_CHUNK_BYTES + 64));
    let ids: Vec<String> = ops_of(&pieces).iter().map(|op| op["recordId"].as_str().unwrap().to_string()).collect();
    assert_eq!(ids, (0..8).map(|i| format!("n{i}")).collect::<Vec<_>>(), "in the order stored");
}

/// One op larger than a piece still goes, alone.
#[test]
fn pieces_hold_one_large_op_alone_and_keep_the_order() {
    let big = |id: &str, kb: usize| SyncOp { data: Some(sized(kb, id)), ..op(id, "notes", "update", id, serde_json::json!({})) };
    let pieces = delta_pieces(vec![big("a", 10), big("b", 1500), big("c", 10), big("d", 600), big("e", 600)]);
    let shape: Vec<Vec<String>> = pieces.iter().map(|m| match m {
        ServerMessage::SyncDelta { ops } => ops.iter().map(|op| op.id.clone()).collect(),
        other => panic!("{other:?}"),
    }).collect();
    assert_eq!(shape, vec![vec!["a"], vec!["b"], vec!["c", "d"], vec!["e"]]);
    assert!(delta_pieces(Vec::new()).is_empty());
}

/// A before-sync hook that changes what is stored: the other clients were
/// sent the stored data, and the pusher only an acknowledgement, so it kept
/// what it had sent. It is sent the record as stored, under its op's id,
/// just after the acknowledgement.
#[test]
fn the_pusher_is_sent_what_a_before_hook_stored() {
    for script in [
        "function onBeforeSyncBatch(ops) { return { ops: ops.filter(function (o) { return o.data && o.data.title; }).map(function (o) { return { id: o.id, data: { title: o.data.title.trim(), stampedBy: 'server' } }; }) }; }",
        "function onBeforeSync(op) { if (op.data && op.data.title) return { data: { title: op.data.title.trim(), stampedBy: 'server' } }; return true; }",
    ] {
        let (sync, _db) = manager(Some(script));
        let mut stream = sync.subscribe();
        let answer = sync.apply_sync_push(vec![
            op("c1", "notes", "create", "n1", serde_json::json!({"title": "  hello  "})),
            op("c2", "notes", "create", "n2", serde_json::json!({"body": "untouched"})),
        ], "a").0;
        // Both are acknowledged in the stream, the record the hook changed just after.
        assert!(acked(&answer).is_empty(), "{script}: {answer:?}");
        let to_a = reaching(&drained(&mut stream), "a");
        assert!(matches!(to_a.first(), Some(ServerMessage::SyncAck { op_ids }) if { let mut ids = op_ids.clone(); ids.sort(); ids == vec!["c1".to_string(), "c2".to_string()] }), "{to_a:?}");
        let told: Vec<&SyncOp> = to_a.iter().flat_map(|m| match m { ServerMessage::SyncDelta { ops } => ops.iter().collect(), _ => Vec::new() }).collect();
        assert_eq!(told.len(), 1, "{to_a:?}");
        assert_eq!((told[0].id.as_str(), told[0].record_id.as_str(), told[0].client_id.as_str()), ("c1", "n1", "server"));
        assert_eq!(told[0].data, Some(serde_json::json!({"title": "hello", "stampedBy": "server"})));
    }
}

/// An update refused for good used to stay on the device that made it: no
/// later pull brings a record that has not changed. Its pusher is sent the
/// record as it stands. A refused create is not answered so (the server has
/// nothing to send, and a delete would take away what the person made), and
/// a record of another collection is never sent.
#[test]
fn a_refused_update_is_answered_with_the_record_as_it_stands() {
    let (sync, db) = manager(Some("function onBeforeSyncBatch(ops) { return ops.filter(function (o) { return o.data && o.data.locked; }).map(function (o) { return o.id; }); }"));
    sync.handle_sync_push(vec![stamped(op("c1", "notes", "create", "n1", serde_json::json!({"title": "kept"})), 60)], "b");
    db.write().upsert_record(xdb::Record {
        id: "root".into(), collection: "admin".into(), data: serde_json::json!({"role":"owner"}),
        created_at: "2026-01-01T00:00:00Z".into(), updated_at: "2026-01-01T00:00:00Z".into(), deleted: false,
    }).unwrap();
    let mut stream = sync.subscribe();
    let answer = sync.apply_sync_push(vec![
        stamped(op("u1", "notes", "update", "n1", serde_json::json!({"title": "mine", "locked": true})), 1),
        op("c9", "notes", "create", "n9", serde_json::json!({"locked": true})),
        op("x1", "notes", "update", "root", serde_json::json!({"role": "guest"})),
    ], "a").0;
    let mut refused = rejected(&answer);
    refused.sort();
    assert_eq!(refused, vec!["c9", "u1", "x1"], "{answer:?}");
    let told: Vec<SyncOp> = reaching(&drained(&mut stream), "a").into_iter().flat_map(|m| match m { ServerMessage::SyncDelta { ops } => ops, _ => Vec::new() }).collect();
    assert_eq!(told.len(), 1, "{told:?}");
    assert_eq!((told[0].id.as_str(), told[0].record_id.as_str()), ("u1", "n1"));
    assert_eq!(told[0].data, Some(serde_json::json!({"title": "kept"})));
}

/// An op sent again (its acknowledgement lost, or put back by a refusal of
/// something else) used to be applied, broadcast and hooked again when it
/// was an update or a delete.
#[test]
fn an_op_sent_again_is_not_applied_again() {
    let (sync, db) = manager(None);
    sync.handle_sync_push(vec![stamped(op("c1", "notes", "create", "n1", serde_json::json!({"title": "first"})), 60)], "a");
    let u1 = stamped(op("u1", "notes", "update", "n1", serde_json::json!({"title": "draft"})), 30);
    let d1 = stamped(op("d1", "notes", "delete", "n1", serde_json::json!({})), 20);
    for again in [u1, d1] {
        assert_eq!(acked(&sync.handle_sync_push(vec![again.clone()], "a")), vec![again.id.clone()]);
        let mut stream = sync.subscribe();
        let answer = sync.handle_sync_push(vec![again.clone()], "a");
        assert_eq!(acked(&answer), vec![again.id.clone()], "{answer:?}");
        let held = drained(&mut stream);
        assert!(!reaches_another(&held, "a"), "{} was broadcast again: {held:?}", again.id);
    }
    assert!(db.write().get_record("n1").unwrap().deleted);
    // Another device's op of the same id, for another record, is its own.
    sync.handle_sync_push(vec![op("c2", "notes", "create", "n2", serde_json::json!({}))], "b");
    let theirs = sync.handle_sync_push(vec![stamped(op("u1", "notes", "update", "n2", serde_json::json!({"title": "theirs"})), 0)], "b");
    assert_eq!(acked(&theirs), vec!["u1"]);
    assert_eq!(db.write().get_record("n2").unwrap().data["title"], "theirs");
}

/// An op stored, its acknowledgement lost, then overtaken by another
/// client's newer edit before it is sent again: its pusher, which still holds
/// its own edit (it passed over the newer one while the op was unanswered),
/// is sent the record as it stands, as for any overtaken op, not just an
/// acknowledgement.
#[test]
fn an_op_sent_again_after_a_newer_edit_is_answered_with_the_record() {
    let (sync, _db) = manager(None);
    sync.handle_sync_push(vec![stamped(op("c1", "notes", "create", "n1", serde_json::json!({"title": "first"})), 60)], "a");
    let u1 = stamped(op("u1", "notes", "update", "n1", serde_json::json!({"title": "draft"})), 30);
    assert_eq!(acked(&sync.handle_sync_push(vec![u1.clone()], "a")), vec!["u1"]);
    sync.handle_sync_push(vec![stamped(op("u2", "notes", "update", "n1", serde_json::json!({"title": "final"})), 10)], "b");
    let again = sync.handle_sync_push(vec![u1], "a");
    assert_eq!(acked(&again), vec!["u1"], "{again:?}");
    let current = told(&again);
    assert_eq!(current.len(), 1, "{again:?}");
    assert_eq!((current[0].id.as_str(), current[0].operation.as_str()), ("u1", "update"));
    assert_eq!(current[0].data, Some(serde_json::json!({"title": "final"})));

    // The same for a delete.
    sync.handle_sync_push(vec![stamped(op("c2", "notes", "create", "n2", serde_json::json!({})), 60)], "a");
    let d1 = stamped(op("d1", "notes", "delete", "n2", serde_json::json!({})), 30);
    assert_eq!(acked(&sync.handle_sync_push(vec![d1.clone()], "a")), vec!["d1"]);
    sync.handle_sync_push(vec![stamped(op("d2", "notes", "delete", "n2", serde_json::json!({})), 10)], "b");
    let again = sync.handle_sync_push(vec![d1], "a");
    let current = told(&again);
    assert_eq!(current.len(), 1, "{again:?}");
    assert_eq!((current[0].id.as_str(), current[0].operation.as_str()), ("d1", "delete"));
}

#[test]
fn recent_ops_are_forgotten_oldest_first_and_in_time() {
    let mut recent = RecentOps::default();
    let now = std::time::Instant::now();
    let a = op("a", "notes", "update", "n1", serde_json::json!({}));
    recent.remember(&a, now);
    assert!(recent.contains(&a, now));
    assert!(!recent.contains(&SyncOp { record_id: "n2".into(), ..a.clone() }, now), "the record is part of the key");
    assert!(!recent.contains(&a, now + RECENT_OPS_TTL + std::time::Duration::from_secs(1)), "forgotten in time");
    for i in 0..RECENT_OPS + 1 {
        recent.remember(&op(&format!("o{i}"), "notes", "update", "n", serde_json::json!({})), now);
    }
    assert!(!recent.contains(&op("o0", "notes", "update", "n", serde_json::json!({})), now));
    assert!(recent.contains(&op(&format!("o{RECENT_OPS}"), "notes", "update", "n", serde_json::json!({})), now));
    assert!(recent.seen.len() <= RECENT_OPS);
}

/// A refused pull says so, names what it did not send, and whether to ask
/// again; an error that answers nothing in particular is the shape it was.
#[test]
fn a_refused_pull_says_what_it_refused() {
    let (sync, _db) = manager(None);
    let many: Vec<String> = (0..MAX_PULL_COLLECTIONS + 1).map(|i| format!("c{i}")).collect();
    let refused = serde_json::to_value(sync.handle_sync_pull(&many, None, None, None).remove(0)).unwrap();
    assert_eq!(refused["type"], "error");
    assert_eq!(refused["for"], "pull");
    assert_eq!(refused["collections"].as_array().unwrap().len(), MAX_PULL_COLLECTIONS + 1);
    assert!(refused.get("retryAfter").is_none(), "asked again, it is refused again");
    let bad = serde_json::to_value(&sync.handle_sync_pull(&["notes".into(), "bad name".into()], None, None, None)[1]).unwrap();
    assert_eq!((bad["for"].as_str(), bad["collections"].clone()), (Some("pull"), serde_json::json!(["bad name"])));
    let busy = serde_json::to_value(ServerMessage::pull_refused("Server busy", vec!["notes".into()], true)).unwrap();
    assert_eq!(busy["retryAfter"], RETRY_AFTER_SECS);
    assert_eq!(serde_json::to_value(ServerMessage::error("Invalid JSON")).unwrap(), serde_json::json!({"type": "error", "message": "Invalid JSON"}));
    let retry = serde_json::to_value(ServerMessage::push_retry(vec!["o1".into()], "Server busy")).unwrap();
    assert_eq!(retry, serde_json::json!({"type": "sync_retry", "opIds": ["o1"], "reason": "Server busy"}));
}

/// The limits the client holds to are the host's (sync-protocol.json, which
/// the client's test reads as well).
#[test]
fn the_sync_limits_are_the_shared_ones() {
    let protocol: serde_json::Value = serde_json::from_str(include_str!("../sync-protocol.json")).unwrap();
    let number = |key: &str| protocol[key].as_u64().unwrap_or_else(|| panic!("{key}")) as usize;
    assert_eq!(number("maxMessageBytes"), crate::http::MAX_WS_MESSAGE_SIZE);
    // How deep a message's objects and arrays may go (ws.rs reads every message with it).
    assert_eq!(number("maxMessageDepth"), crate::util::MAX_JSON_DEPTH);
    assert_eq!(number("pieceBytes"), SYNC_PULL_CHUNK_BYTES);
    assert_eq!(number("maxOpsPerPush"), crate::ws::MAX_OPS_PER_PUSH);
    assert_eq!(number("maxOpDataBytes"), MAX_OP_DATA_BYTES);
    assert_eq!(number("maxPushDataBytes"), MAX_BATCH_DATA_BYTES);
    assert_eq!(number("maxPullCollections"), MAX_PULL_COLLECTIONS);
    assert_eq!(number("pageRows") as i64, pool::MAX_COLLECTION_ROWS);
    // The rule is_valid_collection_name implements, and the names it is held to.
    assert_eq!(protocol["collectionName"], "^[A-Za-z0-9_-]{1,64}$");
    for name in protocol["collectionNames"]["valid"].as_array().unwrap() {
        assert!(is_valid_collection_name(name.as_str().unwrap()), "{name}");
    }
    for name in protocol["collectionNames"]["invalid"].as_array().unwrap() {
        assert!(!is_valid_collection_name(name.as_str().unwrap()), "{name}");
    }
}

/// A batch hook's answer that is not a list of op ids (the ops themselves, ids
/// in objects), or `false`, rejected nothing and let every op through: a hook
/// there to keep some out failed open. It is refused, as an object the host
/// does not read is; `false` rejects every op, as onBeforeSync's does its op.
#[test]
fn a_batch_hook_answer_that_names_no_op_ids_lets_nothing_through() {
    for answer in [
        "ops",
        "ops.map(function (o) { return { id: o.id }; })",
        // The records' ids, not the ops'.
        "ops.map(function (o) { return o.recordId; })",
        "{ rejected: ops.map(function (o) { return o.recordId; }) }",
        // Data changes naming the records, or with no data: the change was lost, the raw data kept.
        "{ ops: ops.map(function (o) { return { id: o.recordId, data: { title: 'clean' } }; }) }",
        "{ ops: ops.map(function (o) { return { id: o.id }; }) }",
        "{ ops: 'all' }",
        // Values that cannot cross, which crossed as the null of `undefined`: none rejected.
        "{ rejected: new Set(ops.map(function (o) { return o.id; })) }",
        "new Set(ops.map(function (o) { return o.id; }))",
        "{ ops: ops.map(function (o) { return { id: o.id, data: new Map() }; }) }",
        "{ rejected: ops }",
        "{ rejected: 'c1' }",
        "false",
        "1",
    ] {
        let script = format!("function onBeforeSyncBatch(ops) {{ return {answer}; }}");
        let (sync, db) = manager(Some(script.as_str()));
        let responses = sync.handle_sync_push(vec![op("c1", "notes", "create", "n1", serde_json::json!({"title": "in"}))], "a");
        assert_eq!(rejected(&responses), vec!["c1"], "{answer}: {responses:?}");
        assert!(db.write().get_record("n1").is_err(), "{answer}");
    }
    for answer in [
        "null",
        "undefined",
        "true",
        "[]",
        "[null, false]",
        "{}",
        "{ rejected: [] }",
        "{ rejected: undefined }",
        "{ rejected: undefined, ops: ops.map(function (o) { return { id: o.id, data: o.data }; }) }",
    ] {
        let script = format!("function onBeforeSyncBatch(ops) {{ return {answer}; }}");
        let (sync, db) = manager(Some(script.as_str()));
        let responses = sync.handle_sync_push(vec![op("c1", "notes", "create", "n1", serde_json::json!({"title": "in"}))], "a");
        assert_eq!(acked(&responses), vec!["c1"], "{answer}: {responses:?}");
        assert!(db.write().get_record("n1").is_ok(), "{answer}");
    }
    // A list that names some ops and not others, with null or false for the rest.
    for answer in ["ops.map(function (o) { return o.data.bad ? o.id : null; })", "ops.map(function (o) { return !o.data.bad || o.id; })"] {
        let script = format!("function onBeforeSyncBatch(ops) {{ return {answer}; }}");
        let (sync, db) = manager(Some(script.as_str()));
        let responses = sync.handle_sync_push(vec![
            op("c1", "notes", "create", "n1", serde_json::json!({"title": "in"})),
            op("c2", "notes", "create", "n2", serde_json::json!({"title": "out", "bad": true})),
        ], "a");
        assert_eq!((acked(&responses), rejected(&responses)), (vec!["c1".to_string()], vec!["c2".to_string()]), "{answer}: {responses:?}");
        assert!(db.write().get_record("n1").is_ok() && db.write().get_record("n2").is_err(), "{answer}");
    }
    // An op given the id of another op's record: a hook answering with record ids named the
    // wrong op, and the one it meant went through. Such a name rejects every op it may name.
    let (sync, db) = manager(Some("function onBeforeSyncBatch(ops) { return ops.filter(function (o) { return o.data.bad; }).map(function (o) { return o.recordId; }); }"));
    let responses = sync.handle_sync_push(vec![
        op("rB", "notes", "create", "n1", serde_json::json!({"title": "decoy"})),
        op("c2", "notes", "create", "rB", serde_json::json!({"title": "out", "bad": true})),
        op("c3", "notes", "create", "n3", serde_json::json!({"title": "fine"})),
    ], "a");
    let mut refused = rejected(&responses);
    refused.sort();
    assert_eq!(refused, vec!["c2", "rB"], "{responses:?}");
    assert!(db.write().get_record("rB").is_err());
    // The op no name could mean goes through: the push is not refused whole.
    assert_eq!(acked(&responses), vec!["c3"], "{responses:?}");
    // A correct hook naming the op whose id is also its own record's, beside another op of
    // that record: what it named is rejected, and the rest of the push goes on.
    let (sync, _db) = manager(Some("function onBeforeSyncBatch(ops) { return ops.filter(function (o) { return o.data.bad; }).map(function (o) { return o.id; }); }"));
    let responses = sync.handle_sync_push(vec![
        op("r9", "notes", "create", "r9", serde_json::json!({"title": "made", "bad": true})),
        op("u9", "notes", "update", "r9", serde_json::json!({"title": "edited"})),
        op("c4", "notes", "create", "n4", serde_json::json!({"title": "fine"})),
    ], "a");
    assert!(rejected(&responses).contains(&"r9".to_string()), "{responses:?}");
    assert!(acked(&responses).contains(&"c4".to_string()), "{responses:?}");
}

/// The per-op hook took any answer but `false` as accepting: the `0` or `''`
/// of `return a && b` let through an op the hook was there to keep out.
#[test]
fn a_per_op_hook_answer_it_does_not_read_rejects_the_op() {
    for answer in ["0", "''", "'yes'", "[]", "1", "{ allowed: false }", "{ reject: true }", "onBeforeSync", "new Date()", "{ data: new Map() }"] {
        let script = format!("function onBeforeSync(op) {{ return {answer}; }}");
        let (sync, db) = manager(Some(script.as_str()));
        let responses = sync.handle_sync_push(vec![op("c1", "notes", "create", "n1", serde_json::json!({"title": "in"}))], "a");
        assert_eq!(rejected(&responses), vec!["c1"], "{answer}: {responses:?}");
        assert!(db.write().get_record("n1").is_err(), "{answer}");
        // Told apart from a `false`: the hook's answer is not one the host reads.
        assert!(responses.iter().any(|m| matches!(m, ServerMessage::SyncReject { reason, .. } if reason.contains("does not read"))), "{answer}: {responses:?}");
    }
    for answer in ["true", "null", "undefined", "{}", "op", "{ data: op.data }"] {
        let script = format!("function onBeforeSync(op) {{ return {answer}; }}");
        let (sync, db) = manager(Some(script.as_str()));
        let responses = sync.handle_sync_push(vec![op("c1", "notes", "create", "n1", serde_json::json!({"title": "in"}))], "a");
        assert_eq!(acked(&responses), vec!["c1"], "{answer}: {responses:?}");
        assert_eq!(db.write().get_record("n1").unwrap().data, serde_json::json!({"title": "in"}), "{answer}");
    }
}

/// A record's data is an object. A string, a number or a list sent as a
/// create's or an update's data became the record's whole data, and every
/// other client was sent it.
#[test]
fn an_op_whose_data_is_not_an_object_is_refused() {
    let (sync, db) = manager(None);
    sync.handle_sync_push(vec![stamped(op("c1", "notes", "create", "n1", serde_json::json!({"title": "kept"})), 60)], "a");
    let responses = sync.handle_sync_push(vec![
        stamped(op("u1", "notes", "update", "n1", serde_json::json!("wiped")), 30),
        op("c2", "notes", "create", "n2", serde_json::json!([1, 2])),
        op("c3", "notes", "create", "n3", serde_json::json!(7)),
    ], "b");
    let mut refused = rejected(&responses);
    refused.sort();
    assert_eq!(refused, vec!["c2", "c3", "u1"], "{responses:?}");
    assert_eq!(db.write().get_record("n1").unwrap().data, serde_json::json!({"title": "kept"}));
    assert!(db.write().get_record("n2").is_err());
    // A delete's data is not read.
    let deleted = sync.handle_sync_push(vec![stamped(op("d1", "notes", "delete", "n1", serde_json::json!("anything")), 10)], "b");
    assert_eq!(acked(&deleted), vec!["d1"], "{deleted:?}");
}
