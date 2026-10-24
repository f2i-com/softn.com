use super::*;
use serde_json::json;

fn database(dir: &tempfile::TempDir, name: &str) -> XdbDatabase {
    XdbDatabase::open(dir.path().join(name)).unwrap()
}

fn replicated_records(db: &mut XdbDatabase, collection: &str) -> Vec<Record> {
    let dir = tempfile::tempdir().unwrap();
    let mut peer = database(&dir, "peer.sqlite");
    peer.apply_remote_update(collection, &db.get_full_state(collection).unwrap())
        .unwrap();
    peer.get_collection(collection).unwrap()
}

#[test]
fn export_includes_uncheckpointed_writes_and_crdt_state() {
    let dir = tempfile::tempdir().unwrap();
    let mut db = database(&dir, "source.sqlite");
    db.conn
        .pragma_update(None, "wal_autocheckpoint", 0)
        .unwrap();
    let (record, _) = db
        .create_record("notes", json!({"title": "Latest note"}))
        .unwrap();
    let exported = dir.path().join("export.sqlite");
    db.export_to_file(&exported).unwrap();
    let mut backup = XdbDatabase::open(exported).unwrap();
    assert_eq!(backup.get_record(&record.id).unwrap().data, record.data);
    assert_eq!(
        replicated_records(&mut backup, "notes")[0].data,
        record.data
    );
    // Export must not close or otherwise disrupt the live database.
    db.update_record(&record.id, json!({"title": "Still open"}))
        .unwrap();
    assert_eq!(backup.get_record(&record.id).unwrap().data, record.data);
}

#[test]
fn import_reads_live_wal_and_clears_cached_documents() {
    let dir = tempfile::tempdir().unwrap();
    let mut source = database(&dir, "source.sqlite");
    source
        .conn
        .pragma_update(None, "wal_autocheckpoint", 0)
        .unwrap();
    let (imported, _) = source
        .create_record("notes", json!({"title": "Imported"}))
        .unwrap();
    let mut target = database(&dir, "target.sqlite");
    let (old, _) = target
        .create_record("notes", json!({"title": "Old"}))
        .unwrap();
    target.replace_from_file(source.path()).unwrap();
    assert!(matches!(
        target.get_record(&old.id),
        Err(DbError::NotFound(_))
    ));
    assert_eq!(target.get_record(&imported.id).unwrap().data, imported.data);
    target
        .update_record(&imported.id, json!({"edited": true}))
        .unwrap();
    let synced = replicated_records(&mut target, "notes");
    assert_eq!(synced.len(), 1);
    assert_eq!(synced[0].data, json!({"title": "Imported", "edited": true}));
    assert_eq!(
        target
            .conn
            .pragma_query_value(None, "journal_mode", |row| row.get::<_, String>(0))
            .unwrap(),
        "wal"
    );
}

#[test]
fn failed_import_preserves_existing_data_and_connection() {
    let dir = tempfile::tempdir().unwrap();
    let mut db = database(&dir, "target.sqlite");
    let (record, _) = db
        .create_record("notes", json!({"title": "Keep me"}))
        .unwrap();
    let missing = dir.path().join("missing.sqlite");
    let invalid = dir.path().join("invalid.sqlite");
    std::fs::write(&invalid, b"not a sqlite file").unwrap();
    let unrelated = dir.path().join("unrelated.sqlite");
    Connection::open(&unrelated)
        .unwrap()
        .execute_batch("CREATE TABLE unrelated (id INTEGER)")
        .unwrap();
    for path in [&missing, &invalid, &unrelated] {
        assert!(db.replace_from_file(path).is_err());
        assert_eq!(db.get_record(&record.id).unwrap().data, record.data);
    }
    assert!(!missing.exists());
    db.update_record(&record.id, json!({"still_working": true}))
        .unwrap();
    assert_eq!(replicated_records(&mut db, "notes").len(), 1);
}

#[test]
fn backup_rejects_same_path_and_uncommitted_transactions() {
    let dir = tempfile::tempdir().unwrap();
    let mut db = database(&dir, "target.sqlite");
    let path = db.path().clone();
    assert!(db.export_to_file(&path).is_err());
    assert!(db.replace_from_file(&path).is_err());
    db.with_transaction(|db| {
        assert!(db
            .export_to_file(&dir.path().join("export.sqlite"))
            .is_err());
        assert!(db
            .replace_from_file(&dir.path().join("missing.sqlite"))
            .is_err());
        assert!(db.reload().is_err());
        Ok(())
    })
    .unwrap();
    db.create_record("notes", json!({"title": "Still usable"}))
        .unwrap();
}

#[test]
fn outer_rollback_restores_database_and_sync_state() {
    let dir = tempfile::tempdir().unwrap();
    let mut db = database(&dir, "target.sqlite");
    let (original, _) = db
        .create_record("notes", json!({"title": "Original"}))
        .unwrap();
    let result: DbResult<()> = db.with_transaction(|db| {
        db.update_record(&original.id, json!({"title": "Must roll back"}))?;
        db.create_record("notes", json!({"title": "Never committed"}))?;
        Err(DbError::InvalidOperation("Cancel batch".into()))
    });
    assert!(result.is_err());
    assert_eq!(db.get_collection("notes").unwrap().len(), 1);
    let replicated = replicated_records(&mut db, "notes");
    assert_eq!(replicated.len(), 1);
    assert_eq!(replicated[0].data, original.data);
    db.create_record("notes", json!({"title": "Next write"}))
        .unwrap();
    assert_eq!(replicated_records(&mut db, "notes").len(), 2);
}

#[test]
fn caught_nested_failure_rolls_back_only_inner_changes() {
    let dir = tempfile::tempdir().unwrap();
    let mut db = database(&dir, "target.sqlite");
    db.with_transaction(|db| {
        db.create_record("notes", json!({"title": "Before"}))?;
        let inner: DbResult<()> = db.with_transaction(|db| {
            db.create_record("notes", json!({"title": "Rejected"}))?;
            Err(DbError::InvalidOperation("Reject inner batch".into()))
        });
        assert!(inner.is_err());
        db.create_record("notes", json!({"title": "After"}))?;
        Ok(())
    })
    .unwrap();
    let records = replicated_records(&mut db, "notes");
    assert_eq!(records.len(), 2);
    assert!(records
        .iter()
        .all(|record| record.data["title"] != "Rejected"));
    assert_eq!(db.get_collection("notes").unwrap().len(), 2);
}

#[test]
fn panic_rolls_back_and_leaves_database_usable() {
    let dir = tempfile::tempdir().unwrap();
    let mut db = database(&dir, "target.sqlite");
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _: DbResult<()> = db.with_transaction(|db| {
            db.create_record("notes", json!({"title": "Not committed"}))?;
            panic!("cancel callback");
        });
    }));
    assert!(result.is_err());
    assert!(db.conn.is_autocommit());
    assert!(db.get_collection("notes").unwrap().is_empty());
    assert!(replicated_records(&mut db, "notes").is_empty());
    db.create_record("notes", json!({"title": "Next write"}))
        .unwrap();
}

#[test]
fn failed_commit_rolls_back_cached_state() {
    let dir = tempfile::tempdir().unwrap();
    let mut db = database(&dir, "target.sqlite");
    db.conn.execute_batch("PRAGMA foreign_keys = ON;
        CREATE TABLE parent (id INTEGER PRIMARY KEY);
        CREATE TABLE child (parent_id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED);").unwrap();
    let result = db.with_transaction(|db| {
        db.create_record("notes", json!({"title": "Not committed"}))?;
        db.conn
            .execute("INSERT INTO child (parent_id) VALUES (42)", [])?;
        Ok(())
    });
    assert!(result.is_err());
    assert!(db.conn.is_autocommit());
    assert!(db.get_collection("notes").unwrap().is_empty());
    assert!(replicated_records(&mut db, "notes").is_empty());
}

#[test]
fn deletion_metadata_matches_between_local_and_synced_records() {
    let dir = tempfile::tempdir().unwrap();
    let mut db = database(&dir, "source.sqlite");
    let (record, _) = db
        .create_record("notes", json!({"title": "Archived"}))
        .unwrap();
    db.delete_record(&record.id).unwrap();
    let mut peer = database(&dir, "peer.sqlite");
    peer.apply_remote_update("notes", &db.get_full_state("notes").unwrap())
        .unwrap();
    let local = serde_json::to_value(db.get_record(&record.id).unwrap()).unwrap();
    let remote = serde_json::to_value(peer.get_record(&record.id).unwrap()).unwrap();
    assert_eq!(local, remote);
    assert!(peer.get_collection("notes").unwrap().is_empty());
}

#[test]
fn corrupt_saved_crdt_is_reported_without_overwriting_data() {
    let dir = tempfile::tempdir().unwrap();
    let mut db = database(&dir, "target.sqlite");
    let (original, _) = db
        .create_record("notes", json!({"title": "Original"}))
        .unwrap();
    db.conn
        .execute(
            "UPDATE crdt_state SET doc_state = ?1 WHERE collection = 'notes'",
            params![vec![255_u8]],
        )
        .unwrap();
    db.reload().unwrap();
    assert!(matches!(
        db.create_record("notes", json!({"title": "Not committed"})),
        Err(DbError::Crdt(_))
    ));
    assert_eq!(db.get_collection("notes").unwrap().len(), 1);
    assert_eq!(db.get_record(&original.id).unwrap().data, original.data);
}

#[test]
fn statistics_include_database_pages_still_in_wal() {
    let dir = tempfile::tempdir().unwrap();
    let mut db = database(&dir, "target.sqlite");
    db.conn
        .pragma_update(None, "wal_autocheckpoint", 0)
        .unwrap();
    let before = db.get_stats().unwrap().db_size_bytes;
    db.create_record("notes", json!({"content": "a".repeat(100_000)}))
        .unwrap();
    assert!(db.get_stats().unwrap().db_size_bytes > before);
    assert!(db.get_stats().unwrap().db_size_bytes > std::fs::metadata(db.path()).unwrap().len());
}

#[test]
fn corrupt_record_data_is_reported_instead_of_null_or_not_found() {
    let dir = tempfile::tempdir().unwrap();
    let mut db = database(&dir, "target.sqlite");
    let (record, _) = db
        .create_record("notes", json!({"title": "Original"}))
        .unwrap();
    db.conn
        .execute(
            "UPDATE records SET data = 'invalid json' WHERE id = ?1",
            params![record.id],
        )
        .unwrap();
    assert!(matches!(db.get_record(&record.id), Err(DbError::Sqlite(_))));
    assert!(matches!(
        db.get_collection("notes"),
        Err(DbError::Sqlite(_))
    ));
    assert!(matches!(
        db.get_record("missing"),
        Err(DbError::NotFound(_))
    ));
    assert!(db
        .update_record(&record.id, json!({"title": "Must not overwrite"}))
        .is_err());
}

#[test]
fn import_rejects_damaged_records_or_sync_state_before_replacing_target() {
    let dir = tempfile::tempdir().unwrap();
    let mut target = database(&dir, "target.sqlite");
    let (original, _) = target
        .create_record("notes", json!({"title": "Keep me"}))
        .unwrap();
    for (index, damage) in [
        "UPDATE records SET data = 'invalid json'",
        "UPDATE crdt_state SET doc_state = X'FF'",
        "UPDATE crdt_state SET state_vector = X'FF'",
    ]
    .iter()
    .enumerate()
    {
        let mut source = database(&dir, &format!("damaged-{index}.sqlite"));
        source
            .create_record("notes", json!({"title": "Damaged source"}))
            .unwrap();
        source.conn.execute_batch(damage).unwrap();
        assert!(target.replace_from_file(source.path()).is_err());
        assert_eq!(target.get_record(&original.id).unwrap().data, original.data);
        assert_eq!(
            replicated_records(&mut target, "notes")[0].data,
            original.data
        );
    }
}

// ── Audit SN-01: bulk import is one transaction with a durable completion signal ──

fn imported(id: &str, collection: &str, title: &str) -> Record {
    let now = chrono::Utc::now().to_rfc3339();
    Record {
        id: id.to_string(),
        collection: collection.to_string(),
        data: json!({ "title": title }),
        created_at: now.clone(),
        updated_at: now,
        deleted: false,
    }
}

fn live_ids(db: &XdbDatabase, collection: &str) -> Vec<String> {
    let mut ids: Vec<String> = db
        .get_collection(collection)
        .unwrap()
        .into_iter()
        .map(|r| r.id)
        .collect();
    ids.sort();
    ids
}

#[test]
fn bulk_import_commits_every_batch_or_none() {
    let dir = tempfile::tempdir().unwrap();
    let mut db = database(&dir, "bulk.sqlite");
    let good = CollectionImport {
        collection: "notes".into(),
        replace: false,
        records: vec![imported("n1", "notes", "one"), imported("n2", "notes", "two")],
    };
    let malformed = CollectionImport {
        collection: "tasks".into(),
        replace: false,
        records: vec![imported("", "tasks", "no id")],
    };
    let mismatched = CollectionImport {
        collection: "tasks".into(),
        replace: false,
        records: vec![imported("t1", "notes", "wrong collection")],
    };

    for bad in [malformed, mismatched] {
        let result = db.import_records(vec![good.clone(), bad]);
        assert!(matches!(result, Err(DbError::InvalidOperation(_))), "{result:?}");
        assert!(live_ids(&db, "notes").is_empty(), "a failed batch commits nothing");
        assert!(db.get_collections().unwrap().is_empty());
    }

    let (summary, deltas) = db.import_records(vec![good]).unwrap();
    assert_eq!(summary.imported, 2);
    assert_eq!(summary.tombstoned, 0);
    assert_eq!(summary.collections.len(), 1);
    assert_eq!(deltas.len(), 2, "one delta per written record, all after the commit");
    assert!(deltas.iter().all(|(c, epoch, _)| c == "notes" && *epoch == 0));

    // Immediately "exit" and reopen: the durable signal was truthful.
    drop(db);
    let reopened = database(&dir, "bulk.sqlite");
    assert_eq!(live_ids(&reopened, "notes"), vec!["n1", "n2"]);
}

#[test]
fn replace_import_tombstones_absent_records_so_peers_drop_them_too() {
    let dir = tempfile::tempdir().unwrap();
    let mut db = database(&dir, "replace.sqlite");
    db.import_records(vec![CollectionImport {
        collection: "notes".into(),
        replace: false,
        records: vec![
            imported("n1", "notes", "one"),
            imported("n2", "notes", "two"),
            imported("n3", "notes", "three"),
        ],
    }])
    .unwrap();
    let mut peer = database(&dir, "peer.sqlite");
    peer.apply_remote_update("notes", &db.get_full_state("notes").unwrap())
        .unwrap();
    assert_eq!(live_ids(&peer, "notes"), vec!["n1", "n2", "n3"]);

    let (summary, deltas) = db
        .import_records(vec![CollectionImport {
            collection: "notes".into(),
            replace: true,
            records: vec![imported("n2", "notes", "two v2"), imported("n4", "notes", "four")],
        }])
        .unwrap();
    assert_eq!((summary.imported, summary.tombstoned), (2, 2));
    assert_eq!(live_ids(&db, "notes"), vec!["n2", "n4"]);
    assert!(
        db.get_record("n1").unwrap().deleted,
        "absent rows become tombstones, not hard deletes"
    );
    assert_eq!(db.get_record("n2").unwrap().data["title"], "two v2");

    // The tombstones travel with the deltas: the peer converges to the replacement.
    for (collection, _epoch, update) in &deltas {
        peer.apply_remote_update(collection, update).unwrap();
    }
    assert_eq!(live_ids(&peer, "notes"), vec!["n2", "n4"]);

    // A duplicate import is deterministic and cache/disk agree.
    let (again, again_deltas) = db
        .import_records(vec![CollectionImport {
            collection: "notes".into(),
            replace: true,
            records: vec![imported("n2", "notes", "two v2"), imported("n4", "notes", "four")],
        }])
        .unwrap();
    assert_eq!((again.imported, again.tombstoned), (2, 0));
    assert_eq!(again_deltas.len(), 2);
    assert_eq!(live_ids(&db, "notes"), vec!["n2", "n4"]);
    for (collection, _epoch, update) in &again_deltas {
        peer.apply_remote_update(collection, update).unwrap();
    }
    assert_eq!(live_ids(&peer, "notes"), vec!["n2", "n4"]);
}

// ── Audit XD-03: local reset vs replicated deletion vs administrative reset ──

#[test]
fn reset_epochs_reject_stale_peers_and_replicate_the_reset() {
    let dir = tempfile::tempdir().unwrap();
    let mut a = database(&dir, "a.sqlite");
    let mut b = database(&dir, "b.sqlite");
    let mut c = database(&dir, "c.sqlite");
    let (_, seed) = a
        .create_record("notes", json!({"title": "shared"}))
        .unwrap();
    for peer in [&mut b, &mut c] {
        peer.apply_remote_update("notes", &seed).unwrap();
    }
    assert_eq!(a.get_epoch("notes").unwrap(), 0);

    // clear_collection is LOCAL: the next peer update simply repopulates it.
    b.clear_collection("notes").unwrap();
    assert!(live_ids(&b, "notes").is_empty());
    b.apply_remote_update("notes", &a.get_full_state("notes").unwrap())
        .unwrap();
    assert_eq!(live_ids(&b, "notes").len(), 1, "a local reset is not authoritative");

    // A replicated (administrative) reset advances the epoch and clears A.
    let epoch = a.reset_collection("notes", "admin").unwrap();
    assert_eq!(epoch, 1);
    assert!(live_ids(&a, "notes").is_empty());
    assert_eq!(a.get_epoch("notes").unwrap(), 1);

    // A stale peer (still at epoch 0) cannot reintroduce pre-reset state.
    let (_, stale_update) = b
        .create_record("notes", json!({"title": "from stale B"}))
        .unwrap();
    match a
        .apply_remote_update_at_epoch("notes", 0, &stale_update)
        .unwrap()
    {
        RemoteApplyOutcome::StaleEpoch { local, remote } => assert_eq!((local, remote), (1, 0)),
        other => panic!("stale update was not rejected: {other:?}"),
    }
    assert!(live_ids(&a, "notes").is_empty());

    // B adopts the reset (clearing its copy); an equal/older reset does nothing.
    assert!(b.apply_remote_reset("notes", 1, "a").unwrap());
    assert!(live_ids(&b, "notes").is_empty());
    assert_eq!(b.get_epoch("notes").unwrap(), 1);
    assert!(!b.apply_remote_reset("notes", 1, "a").unwrap());
    assert!(!b.apply_remote_reset("notes", 0, "c").unwrap());
    assert_eq!(b.get_epoch("notes").unwrap(), 1);

    // Post-reset writes at the new epoch flow normally.
    let (_, fresh) = b
        .create_record("notes", json!({"title": "post-reset"}))
        .unwrap();
    assert!(matches!(
        a.apply_remote_update_at_epoch("notes", 1, &fresh).unwrap(),
        RemoteApplyOutcome::Applied(_)
    ));
    assert_eq!(live_ids(&a, "notes").len(), 1);

    // C was offline for the whole reset. Its old update is rejected by A, and
    // when it hears a newer-epoch update it must adopt the reset first.
    let offline_id = live_ids(&c, "notes")[0].clone();
    let (_, from_c) = c
        .update_record(&offline_id, json!({"title": "edited offline"}))
        .unwrap();
    assert!(matches!(
        a.apply_remote_update_at_epoch("notes", 0, &from_c).unwrap(),
        RemoteApplyOutcome::StaleEpoch { .. }
    ));
    match c.apply_remote_update_at_epoch("notes", 1, &fresh).unwrap() {
        RemoteApplyOutcome::MissingReset { local, remote } => assert_eq!((local, remote), (0, 1)),
        other => panic!("C applied a newer-epoch update without the reset: {other:?}"),
    }
    assert!(c.apply_remote_reset("notes", 1, "a").unwrap());
    assert!(matches!(
        c.apply_remote_update_at_epoch("notes", 1, &fresh).unwrap(),
        RemoteApplyOutcome::Applied(_)
    ));
    assert_eq!(live_ids(&c, "notes"), live_ids(&a, "notes"));

    // bump_epoch: the CURRENT contents become authoritative (replace-scope restore).
    let bumped = a.bump_epoch("notes", "restore").unwrap();
    assert_eq!(bumped, 2);
    assert_eq!(live_ids(&a, "notes").len(), 1, "bump keeps the local records");
    assert!(b.apply_remote_reset("notes", 2, "a").unwrap());
    assert!(live_ids(&b, "notes").is_empty());
    b.apply_remote_update("notes", &a.get_full_state("notes").unwrap())
        .unwrap();
    assert_eq!(live_ids(&b, "notes"), live_ids(&a, "notes"));

    // Epochs survive a restart.
    drop(a);
    assert_eq!(database(&dir, "a.sqlite").get_epoch("notes").unwrap(), 2);
}

// ── Audit XD-02: disconnected peers converge through state-vector reconciliation ──

/// One direction of a reconciliation pass: `to` asks `from` for what it lacks.
fn reconcile(from: &mut XdbDatabase, to: &mut XdbDatabase) {
    // Collections `to` has never seen are requested with an empty state vector.
    let announced = from.get_collections().unwrap();
    for collection in to.unknown_collections(&announced).unwrap() {
        let empty = yrs::StateVector::default().encode_v1();
        let update = from.get_updates_since(&collection, &empty).unwrap();
        let epoch = from.get_epoch(&collection).unwrap();
        assert!(matches!(
            to.apply_remote_update_at_epoch(&collection, epoch, &update)
                .unwrap(),
            RemoteApplyOutcome::Applied(_)
        ));
    }
    for (collection, epoch, sv) in to.reconcile_plan().unwrap() {
        if !announced.contains(&collection) {
            continue;
        }
        let update = from.get_updates_since(&collection, &sv).unwrap();
        assert!(matches!(
            to.apply_remote_update_at_epoch(&collection, epoch, &update)
                .unwrap(),
            RemoteApplyOutcome::Applied(_)
        ));
    }
}

fn snapshot(db: &XdbDatabase) -> Vec<(String, String, bool, serde_json::Value)> {
    let mut all = Vec::new();
    for collection in db.get_collections().unwrap() {
        let mut stmt = db
            .conn
            .prepare("SELECT id, collection, data, created_at, updated_at, deleted FROM records WHERE collection = ?1")
            .unwrap();
        for record in stmt.query_map([&collection], record_from_row).unwrap() {
            let r = record.unwrap();
            all.push((r.collection, r.id, r.deleted, r.data));
        }
    }
    all.sort_by(|x, y| (&x.0, &x.1).cmp(&(&y.0, &y.1)));
    all
}

#[test]
fn disconnected_peers_converge_after_reconnecting_without_manual_intervention() {
    let dir = tempfile::tempdir().unwrap();
    let mut a = database(&dir, "a.sqlite");
    let mut b = database(&dir, "b.sqlite");
    let (shared, seed) = a
        .create_record("notes", json!({"title": "shared"}))
        .unwrap();
    b.apply_remote_update("notes", &seed).unwrap();

    // Partition: disjoint edits, plus a collection that exists on one side only.
    a.create_record("notes", json!({"title": "from A"})).unwrap();
    a.create_record("tasks", json!({"title": "only A knows tasks"}))
        .unwrap();
    b.create_record("notes", json!({"title": "from B"})).unwrap();
    b.delete_record(&shared.id).unwrap();

    // Restart independently before reconnecting.
    drop(a);
    drop(b);
    let mut a = database(&dir, "a.sqlite");
    let mut b = database(&dir, "b.sqlite");
    assert_ne!(snapshot(&a), snapshot(&b));

    // Reconnect: each side announces and requests; no manual step.
    reconcile(&mut a, &mut b);
    reconcile(&mut b, &mut a);
    assert_eq!(snapshot(&a), snapshot(&b));
    assert_eq!(live_ids(&a, "notes").len(), 2, "both new notes; the shared one is deleted");
    assert!(a.get_record(&shared.id).unwrap().deleted);
    assert_eq!(live_ids(&b, "tasks").len(), 1, "B discovered the collection it never had");

    // Repeated delivery and an interrupted pass are idempotent.
    let before = snapshot(&a);
    reconcile(&mut b, &mut a);
    reconcile(&mut b, &mut a);
    assert_eq!(snapshot(&a), before);

    // Convergence persists across another restart.
    drop(a);
    drop(b);
    assert_eq!(
        snapshot(&database(&dir, "a.sqlite")),
        snapshot(&database(&dir, "b.sqlite"))
    );
}

// ── R2-XD-03: a legacy snapshot is migrated in staging before it replaces the live schema ──

fn legacy_snapshot(dir: &tempfile::TempDir, name: &str) -> PathBuf {
    // A backup taken by the revision before reset epochs existed: identical
    // core tables, no collection_epochs.
    let path = dir.path().join(name);
    {
        let mut db = database(dir, name);
        db.create_record("notes", json!({"title": "legacy"})).unwrap();
        db.create_record("archive", json!({"title": "tombstoned later"})).unwrap();
        let archived = db.get_collection("archive").unwrap()[0].id.clone();
        db.delete_record(&archived).unwrap();
        db.conn.execute_batch("DROP TABLE collection_epochs").unwrap();
    }
    let conn = Connection::open(&path).unwrap();
    let tables: Vec<String> = conn
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert!(!tables.iter().any(|t| t == "collection_epochs"), "fixture must be legacy");
    path
}

#[test]
fn restoring_a_legacy_snapshot_keeps_the_epoch_table_usable_without_a_restart() {
    let dir = tempfile::tempdir().unwrap();
    let source = legacy_snapshot(&dir, "legacy.sqlite");
    let mut live = database(&dir, "live.sqlite");
    live.create_record("notes", json!({"title": "current"})).unwrap();
    assert_eq!(live.reset_collection("notes", "admin").unwrap(), 1);

    live.replace_from_file(&source).unwrap();

    // Immediately, on the same connection: epochs and bulk import work.
    assert_eq!(live.get_epoch("notes").unwrap(), 0, "the snapshot carried no epoch history");
    assert_eq!(live_ids(&live, "notes").len(), 1);
    assert_eq!(live.get_collection("notes").unwrap()[0].data["title"], "legacy");
    assert!(live.get_collection("archive").unwrap().is_empty(), "tombstoned collection restored as tombstoned");
    let (summary, _) = live
        .import_records(vec![CollectionImport {
            collection: "notes".into(),
            replace: false,
            records: vec![imported("n2", "notes", "after restore")],
        }])
        .unwrap();
    assert_eq!(summary.imported, 1);
    assert_eq!(live.bump_epoch("notes", "x").unwrap(), 1);
    // The source file was not modified (still legacy) and no staging file remains.
    let src = Connection::open(&source).unwrap();
    assert!(src
        .query_row("SELECT count(*) FROM sqlite_master WHERE name='collection_epochs'", [], |r| r.get::<_, i64>(0))
        .unwrap() == 0);
    let leftovers: Vec<_> = std::fs::read_dir(dir.path())
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().contains("restore-staging"))
        .collect();
    assert!(leftovers.is_empty(), "staging copies are removed");

    // Reopen after success: still consistent.
    drop(live);
    let reopened = database(&dir, "live.sqlite");
    assert_eq!(live_ids(&reopened, "notes").len(), 2);
    assert_eq!(reopened.get_epoch("notes").unwrap(), 1);

    // An empty legacy database restores to an empty, usable database too.
    let empty = dir.path().join("empty-legacy.sqlite");
    {
        let db = database(&dir, "empty-legacy.sqlite");
        db.conn.execute_batch("DROP TABLE collection_epochs").unwrap();
    }
    let mut target = database(&dir, "target.sqlite");
    target.create_record("notes", json!({})).unwrap();
    target.replace_from_file(&empty).unwrap();
    assert!(target.get_collections().unwrap().is_empty());
    assert_eq!(target.get_epoch("notes").unwrap(), 0);
}

#[test]
fn a_snapshot_that_fails_staging_validation_leaves_the_live_database_untouched() {
    let dir = tempfile::tempdir().unwrap();
    let mut live = database(&dir, "live.sqlite");
    live.create_record("notes", json!({"title": "keep"})).unwrap();
    // Missing a core table entirely: unsupported, rejected before any mutation.
    let bogus = dir.path().join("bogus.sqlite");
    let conn = Connection::open(&bogus).unwrap();
    conn.execute_batch("CREATE TABLE records (id TEXT PRIMARY KEY, collection TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted INTEGER DEFAULT 0)").unwrap();
    drop(conn);
    let err = live.replace_from_file(&bogus).unwrap_err();
    assert!(err.to_string().contains("missing table 'crdt_state'"), "{err}");
    assert_eq!(live_ids(&live, "notes").len(), 1);
    live.create_record("notes", json!({"title": "still usable"})).unwrap();
    assert_eq!(live_ids(&live, "notes").len(), 2);
}

// ── R2-XD-02: authoritative replacement keeps reset authority monotonic and covers omitted collections ──

#[test]
fn authoritative_restore_exceeds_both_live_and_snapshot_epochs_over_the_union_of_collections() {
    let dir = tempfile::tempdir().unwrap();
    // Backup taken when notes was at epoch 1 and tasks did not exist.
    let backup = dir.path().join("earlier.sqlite");
    {
        let mut db = database(&dir, "earlier.sqlite");
        db.create_record("notes", json!({"title": "from backup"})).unwrap();
        assert_eq!(db.reset_collection("notes", "a").unwrap(), 1);
        db.create_record("notes", json!({"title": "post-reset in backup"})).unwrap();
    }
    // Live state moved on: notes at epoch 5, and a tasks collection peers know about.
    let mut live = database(&dir, "live.sqlite");
    live.create_record("notes", json!({"title": "live"})).unwrap();
    for _ in 0..5 {
        live.bump_epoch("notes", "live").unwrap();
    }
    live.create_record("tasks", json!({"title": "only live has tasks"})).unwrap();
    let mut peer = database(&dir, "peer.sqlite");
    peer.apply_remote_update("notes", &live.get_full_state("notes").unwrap()).unwrap();
    peer.apply_remote_reset("notes", 5, "live").unwrap();
    peer.apply_remote_update("tasks", &live.get_full_state("tasks").unwrap()).unwrap();

    let plan = live.replace_from_file_authoritative(&backup, "restore").unwrap();
    let plan: HashMap<String, u64> = plan.into_iter().collect();
    assert_eq!(plan.get("notes"), Some(&6), "exceeds live 5 and snapshot 1, never announces 2");
    assert_eq!(plan.get("tasks"), Some(&1), "a collection the snapshot omits is reset too");
    assert_eq!(live.get_epoch("notes").unwrap(), 6);
    assert_eq!(live.get_epoch("tasks").unwrap(), 1);
    assert!(live.get_collection("tasks").unwrap().is_empty());
    assert_eq!(live_ids(&live, "notes").len(), 1);

    // The peer at epoch 5 adopts the replacement; a stale peer update is refused.
    let (_, stale) = peer.create_record("notes", json!({"title": "peer edit at 5"})).unwrap();
    assert!(matches!(
        live.apply_remote_update_at_epoch("notes", 5, &stale).unwrap(),
        RemoteApplyOutcome::StaleEpoch { local: 6, remote: 5 }
    ));
    assert!(peer.apply_remote_reset("notes", 6, "restore").unwrap());
    assert!(peer.apply_remote_reset("tasks", 1, "restore").unwrap());
    assert!(peer.get_collection("tasks").unwrap().is_empty(), "B did not silently survive on the peer");
    peer.apply_remote_update("notes", &live.get_full_state("notes").unwrap()).unwrap();
    assert_eq!(live_ids(&peer, "notes"), live_ids(&live, "notes"));

    // Re-applying the persisted plan after an interruption is idempotent and never lowers an epoch.
    live.bump_epoch("notes", "later").unwrap();
    live.apply_reset_plan(&[("notes".into(), 6), ("tasks".into(), 1), ("new".into(), 3)], "replay").unwrap();
    assert_eq!(live.get_epoch("notes").unwrap(), 7);
    assert_eq!(live.get_epoch("new").unwrap(), 3);
}


// ── XD-04 follow-up: a batch of updates persists the CRDT document once per collection ──

#[test]
fn update_records_commits_all_or_nothing_with_one_snapshot_per_collection() {
    let dir = tempfile::tempdir().unwrap();
    let mut db = database(&dir, "batch.sqlite");
    let ids: Vec<String> = (0..20)
        .map(|i| db.create_record("notes", json!({"n": i})).unwrap().0.id)
        .collect();
    let other = db.create_record("tasks", json!({"t": 0})).unwrap().0.id;

    let before = db.total_changes();
    let updates: Vec<(String, serde_json::Value)> = ids
        .iter()
        .map(|id| (id.clone(), json!({"edited": true})))
        .chain(std::iter::once((other.clone(), json!({"edited": true}))))
        .collect();
    let out = db.update_records(updates).unwrap();
    assert_eq!(out.len(), 21);
    // 21 record rows + 2 crdt_state rows (one per collection), not 21 + 21.
    assert_eq!(db.total_changes() - before, 23);
    assert!(out.iter().all(|(r, _)| r.data["edited"] == true));

    // The persisted document agrees with the rows: a peer applying the full
    // state sees every edit.
    let peer_notes = replicated_records(&mut db, "notes");
    assert!(peer_notes.iter().all(|r| r.data["edited"] == true));

    // One bad id rolls back the whole batch, including records already updated.
    let failed = db.update_records(vec![
        (ids[0].clone(), json!({"edited": "second"})),
        ("missing".into(), json!({})),
    ]);
    assert!(matches!(failed, Err(DbError::NotFound(_))));
    assert_eq!(db.get_record(&ids[0]).unwrap().data["edited"], true);
    assert!(replicated_records(&mut db, "notes")
        .iter()
        .all(|r| r.data["edited"] == true));
}


// ── R3-XD-02: restored data and reset epochs activate in one step, or not at all ──

#[test]
fn authoritative_restore_activates_data_and_epochs_together_or_leaves_the_live_database_untouched() {
    let dir = tempfile::tempdir().unwrap();
    let backup = dir.path().join("earlier.sqlite");
    {
        let mut db = database(&dir, "earlier.sqlite");
        db.create_record("notes", json!({"title": "from backup"})).unwrap();
        assert_eq!(db.reset_collection("notes", "a").unwrap(), 1);
        db.create_record("notes", json!({"title": "post-reset in backup"})).unwrap();
    }
    let mut live = database(&dir, "live.sqlite");
    live.create_record("notes", json!({"title": "live"})).unwrap();
    for _ in 0..5 {
        live.bump_epoch("notes", "live").unwrap();
    }
    live.create_record("tasks", json!({"title": "only live has tasks"})).unwrap();
    let live_before = (live.catalog().unwrap(), live_ids(&live, "notes"), live_ids(&live, "tasks"));

    // The plan is computed without touching anything.
    let planned = live.plan_authoritative_restore(&backup).unwrap();
    let plan: HashMap<String, u64> = planned.plan.iter().cloned().collect();
    assert_eq!(plan.get("notes"), Some(&6));
    assert_eq!(plan.get("tasks"), Some(&1));
    assert_eq!(planned.prior.iter().cloned().collect::<HashMap<_, _>>(), live_before.0);
    assert_eq!((live.catalog().unwrap(), live_ids(&live, "notes"), live_ids(&live, "tasks")), live_before);

    // Interruption between staging validation and activation: nothing live changes,
    // neither records nor the catalog, and the staging temporary is gone.
    let failed = live.apply_authoritative_restore_with(&backup, &planned.plan, "restore", |staging| {
        // The staging copy already carries data AND the plan at this point.
        let epoch: i64 = staging
            .query_row("SELECT epoch FROM collection_epochs WHERE collection = 'notes'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(epoch, 6);
        Err(DbError::InvalidOperation("power loss before activation".into()))
    });
    assert!(matches!(failed, Err(DbError::InvalidOperation(m)) if m.contains("power loss")));
    assert_eq!((live.catalog().unwrap(), live_ids(&live, "notes"), live_ids(&live, "tasks")), live_before);
    assert!(
        std::fs::read_dir(dir.path()).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().contains("restore-staging")),
        "no staging temporary survives a failed activation"
    );

    // A journaled plan that no longer exceeds the live generation is refused untouched.
    live.bump_epoch("notes", "moved on").unwrap();
    let stale = live.apply_authoritative_restore(&backup, &planned.plan, "restore");
    assert!(matches!(stale, Err(DbError::InvalidOperation(m)) if m.contains("Stale reset plan")));
    assert_eq!(live.get_epoch("notes").unwrap(), 6);
    assert_eq!(live_ids(&live, "notes"), live_before.1);
    let missing = live.apply_authoritative_restore(&backup, &[("notes".into(), 9)], "restore");
    assert!(matches!(missing, Err(DbError::InvalidOperation(m)) if m.contains("Incomplete reset plan")));

    // Re-planned against the moved-on live state: data and epochs land together.
    let replanned = live.plan_authoritative_restore(&backup).unwrap();
    assert_eq!(replanned.plan.iter().find(|(c, _)| c == "notes").map(|(_, e)| *e), Some(7));
    live.apply_authoritative_restore(&backup, &replanned.plan, "restore").unwrap();
    assert_eq!(live.get_epoch("notes").unwrap(), 7);
    assert_eq!(live.get_epoch("tasks").unwrap(), 1);
    assert_eq!(live_ids(&live, "notes").len(), 1);
    assert!(live.get_collection("tasks").unwrap().is_empty());
    // Applying the same journaled plan again (a retry after a crash between
    // activation and the journal update) is idempotent: the live state now
    // equals the snapshot plus that plan, so the plan still qualifies.
    live.apply_authoritative_restore(&backup, &replanned.plan, "restore").unwrap();
    assert_eq!(live.get_epoch("notes").unwrap(), 7);
    // A reopened database sees the same consistent pair.
    drop(live);
    let reopened = database(&dir, "live.sqlite");
    assert_eq!(reopened.get_epoch("notes").unwrap(), 7);
    assert_eq!(live_ids(&reopened, "notes").len(), 1);
}


// ── A batch of writes saves each collection's document once, and the saved document agrees with the rows ──

fn note(id: &str, title: &str) -> Record {
    Record {
        id: id.into(),
        collection: "notes".into(),
        data: json!({ "title": title }),
        created_at: "2026-01-01T00:00:00Z".into(),
        updated_at: "2026-01-01T00:00:00Z".into(),
        deleted: false,
    }
}

/// What the file holds, read by a database opened on it afresh: the rows of
/// a collection, and the records a peer gets from its saved document.
fn rows_and_replica(dir: &tempfile::TempDir, name: &str, collection: &str) -> (Vec<(String, serde_json::Value)>, Vec<(String, serde_json::Value)>) {
    let mut reopened = database(dir, name);
    let mut rows: Vec<_> = reopened.get_collection(collection).unwrap().into_iter().map(|r| (r.id, r.data)).collect();
    let mut replica: Vec<_> = replicated_records(&mut reopened, collection).into_iter().map(|r| (r.id, r.data)).collect();
    rows.sort_by(|a, b| a.0.cmp(&b.0));
    replica.sort_by(|a, b| a.0.cmp(&b.0));
    (rows, replica)
}

#[test]
fn a_batch_saves_each_collections_document_once() {
    let dir = tempfile::tempdir().unwrap();
    let mut db = database(&dir, "batch.sqlite");
    let edited = db.create_record("notes", json!({"title": "edited later"})).unwrap().0.id;
    let removed = db.create_record("notes", json!({"title": "removed later"})).unwrap().0.id;

    let before = db.total_changes();
    db.with_batch(|db| {
        for i in 0..10 {
            db.upsert_record(note(&format!("n{i}"), "pushed"))?;
        }
        db.update_record(&edited, json!({"title": "edited"}))?;
        db.delete_record(&removed)?;
        db.create_record("tasks", json!({"done": false}))?;
        Ok(())
    })
    .unwrap();
    // Thirteen rows written, and one document for each of the two
    // collections: 15. Written one at a time they are 13 + 13.
    assert_eq!(db.total_changes() - before, 15);

    // Outside a batch nothing changed: a write saves its document with it.
    let before = db.total_changes();
    db.upsert_record(note("alone", "by itself")).unwrap();
    assert_eq!(db.total_changes() - before, 2);
    drop(db);

    let (rows, replica) = rows_and_replica(&dir, "batch.sqlite", "notes");
    assert_eq!(rows.len(), 12);
    assert_eq!(replica, rows, "the saved document is not the rows");
    assert!(rows.iter().any(|(id, data)| *id == edited && data["title"] == "edited"));
    assert!(!rows.iter().any(|(id, _)| *id == removed));
    let (tasks, replica) = rows_and_replica(&dir, "batch.sqlite", "tasks");
    assert_eq!((tasks.len(), replica.len()), (1, 1));
}

#[test]
fn a_write_that_fails_inside_a_batch_takes_nothing_else_with_it() {
    let dir = tempfile::tempdir().unwrap();
    let mut db = database(&dir, "caught.sqlite");
    db.with_batch(|db| {
        db.upsert_record(note("before", "kept"))?;
        // Caught, as a host rejecting one op of a push catches it: this one
        // write rolls back, and with it every cached document is dropped.
        assert!(matches!(db.update_record("missing", json!({})), Err(DbError::NotFound(_))));
        // One that got as far as writing, and was then rolled back.
        let undone: DbResult<()> = db.with_transaction(|db| {
            db.upsert_record(note("undone", "never happened"))?;
            db.upsert_record(Record { collection: "drafts".into(), ..note("d1", "nor this") })?;
            Err(DbError::InvalidOperation("refused".into()))
        });
        assert!(undone.is_err());
        db.upsert_record(note("after", "kept"))?;
        Ok(())
    })
    .unwrap();
    drop(db);

    let (rows, replica) = rows_and_replica(&dir, "caught.sqlite", "notes");
    let ids: Vec<&str> = rows.iter().map(|(id, _)| id.as_str()).collect();
    assert_eq!(ids, vec!["after", "before"]);
    assert_eq!(replica, rows, "a write on one side of the failure is missing from the saved document, or the undone one is in it");
    let (drafts, replica) = rows_and_replica(&dir, "caught.sqlite", "drafts");
    assert!(drafts.is_empty() && replica.is_empty());
}

#[test]
fn a_batch_that_fails_or_panics_leaves_nothing_and_the_database_as_it_was() {
    let dir = tempfile::tempdir().unwrap();
    let mut db = database(&dir, "failed.sqlite");
    db.upsert_record(note("first", "here before")).unwrap();

    let failed: DbResult<()> = db.with_batch(|db| {
        db.upsert_record(note("second", "rolled back"))?;
        Err(DbError::InvalidOperation("the whole batch is refused".into()))
    });
    assert!(failed.is_err());
    let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _: DbResult<()> = db.with_batch(|db| {
            db.upsert_record(note("third", "rolled back"))?;
            panic!("inside a batch");
        });
    }));
    assert!(panicked.is_err());

    // Not left in a batch: the next write saves its document with it.
    let before = db.total_changes();
    db.upsert_record(note("fourth", "after both")).unwrap();
    assert_eq!(db.total_changes() - before, 2);
    // A batch inside a batch is one batch.
    let before = db.total_changes();
    db.with_batch(|db| {
        db.with_batch(|db| db.upsert_record(note("fifth", "inner")).map(|_| ()))?;
        db.upsert_record(note("sixth", "outer")).map(|_| ())
    })
    .unwrap();
    assert_eq!(db.total_changes() - before, 3);
    drop(db);

    let (rows, replica) = rows_and_replica(&dir, "failed.sqlite", "notes");
    let ids: Vec<&str> = rows.iter().map(|(id, _)| id.as_str()).collect();
    assert_eq!(ids, vec!["fifth", "first", "fourth", "sixth"]);
    assert_eq!(replica, rows);
}

/// Records are kept by id alone. A record a peer or a sync server sends for one collection,
/// under the id of a record of another collection here, replaced that record and moved it
/// into the collection it came in: a room or a server reached a collection never shared
/// with it.
#[test]
fn a_record_sent_for_one_collection_does_not_replace_another_collections() {
    let dir = tempfile::tempdir().unwrap();
    let mut db = database(&dir, "mine.sqlite");
    db.upsert_record(Record { collection: "private".into(), ..note("shared-id", "my secret") }).unwrap();

    // Sync's write: refused, and the record is as it was.
    let refused = db.upsert_record(Record { collection: "public".into(), ..note("shared-id", "planted") });
    assert!(matches!(refused, Err(DbError::InvalidOperation(_))), "{refused:?}");
    let kept = db.get_record("shared-id").unwrap();
    assert_eq!((kept.collection.as_str(), &kept.data), ("private", &json!({ "title": "my secret" })));

    // A peer's update for `public`: that record is skipped, and the rest of it is written.
    let mut peer = database(&dir, "peer.sqlite");
    peer.upsert_record(Record { collection: "public".into(), ..note("shared-id", "planted") }).unwrap();
    peer.upsert_record(Record { collection: "public".into(), ..note("their-own", "fine") }).unwrap();
    let written = db.apply_remote_update("public", &peer.get_full_state("public").unwrap()).unwrap();
    assert_eq!(written.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), vec!["their-own"]);
    let kept = db.get_record("shared-id").unwrap();
    assert_eq!((kept.collection.as_str(), &kept.data), ("private", &json!({ "title": "my secret" })));
    assert_eq!(live_ids(&db, "public"), vec!["their-own"]);

    // A record of the same collection is written over as before.
    db.upsert_record(Record { collection: "private".into(), ..note("shared-id", "edited") }).unwrap();
    assert_eq!(db.get_record("shared-id").unwrap().data, json!({ "title": "edited" }));
}