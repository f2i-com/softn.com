use crate::pool::{self, ServerDb};
use crate::sync::{Audience, SyncOp, SyncStream};
use super::{DbBridge, DbRecord, DbSyncStatus, DbUpdateIf};

pub struct NativeDbBridge {
    db: ServerDb,
    /// Where the server's own writes are announced to the connected sync
    /// clients, when the host syncs.
    stream: Option<SyncStream>,
}

impl NativeDbBridge {
    /// A bridge whose writes reach no sync client.
    #[cfg(test)]
    pub fn new(db: ServerDb) -> Self {
        Self { db, stream: None }
    }

    /// A bridge whose writes every connected sync client is sent, as it is
    /// sent another client's push. A route's `db.update` used to reach a
    /// device only when it next connected and pulled.
    pub fn with_stream(db: ServerDb, stream: SyncStream) -> Self {
        Self { db, stream: Some(stream) }
    }

    /// Tell every sync client of a record as it now stands: called with the
    /// writer lock still held (`_held`), so the stream carries the writes in
    /// the order the store made them, as a push's are. The whole record goes,
    /// not the fields the call named: `db.update` merges, and a client
    /// replaces a record with what it is sent.
    fn announce(&self, _held: &xdb::XdbDatabase, record: &xdb::Record, created: bool) {
        let Some(stream) = &self.stream else { return };
        let op = SyncOp {
            id: format!("server-{}", uuid::Uuid::new_v4()),
            collection: record.collection.clone(),
            operation: if record.deleted { "delete" } else if created { "create" } else { "update" }.into(),
            record_id: record.id.clone(),
            data: (!record.deleted).then(|| record.data.clone()),
            timestamp: record.updated_at.clone(),
            client_id: "server".into(),
        };
        crate::sync::send_all(stream, &Audience::All, crate::sync::delta_pieces(vec![op]));
    }
}

fn xdb_to_record(r: xdb::Record) -> DbRecord {
    DbRecord {
        id: r.id,
        collection: r.collection,
        data: r.data,
        created_at: r.created_at,
        updated_at: r.updated_at,
    }
}

const MAX_BRIDGE_RECORD_BYTES: usize = 1024 * 1024;
const MAX_COLLECTION_NAME_BYTES: usize = 128;
const MAX_BRIDGE_QUERY_BYTES: usize = 16 * 1024 * 1024;

fn validate_collection_name(collection: &str) -> Result<(), String> {
    if collection.is_empty() || collection.len() > MAX_COLLECTION_NAME_BYTES {
        return Err(format!(
            "Collection name must be 1..={} bytes",
            MAX_COLLECTION_NAME_BYTES
        ));
    }
    Ok(())
}

fn json_byte_size(val: &serde_json::Value) -> usize {
    struct Counter(usize);
    impl std::io::Write for Counter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0 = self.0.saturating_add(buf.len());
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
    }
    let mut c = Counter(0);
    let _ = serde_json::to_writer(&mut c, val);
    c.0
}

/// What a `db.query` has read so far. The read hands it one record at a time and stops at the
/// first that takes the result past [`MAX_BRIDGE_QUERY_BYTES`], so the host holds no more
/// than the cap and that record. The whole page used to be read and parsed before its size
/// was added up: ten thousand records of a megabyte each, in a call the VM's own limits do
/// not see.
#[derive(Default)]
struct BoundedRecords {
    records: Vec<DbRecord>,
    total_bytes: usize,
    over: bool,
}

impl BoundedRecords {
    /// Keeps `r` and answers whether the read should go on.
    fn take(&mut self, r: pool::SyncRecord) -> bool {
        let approx = r.id.len() + r.collection.len() + r.created_at.len() + r.updated_at.len() + json_byte_size(&r.data) + 64;
        self.total_bytes = self.total_bytes.saturating_add(approx);
        if self.total_bytes > MAX_BRIDGE_QUERY_BYTES {
            self.over = true;
            return false;
        }
        self.records.push(DbRecord {
            id: r.id,
            collection: r.collection,
            data: r.data,
            created_at: r.created_at,
            updated_at: r.updated_at,
        });
        true
    }

    fn finish(self) -> Result<Vec<DbRecord>, String> {
        if self.over {
            return Err(format!(
                "db.query exceeded maximum result size ({} bytes)",
                MAX_BRIDGE_QUERY_BYTES
            ));
        }
        Ok(self.records)
    }
}

impl DbBridge for NativeDbBridge {
    fn query_where(&self, collection: &str, filter: &serde_json::Map<String, serde_json::Value>) -> Result<Vec<DbRecord>, String> {
        if filter.is_empty() || filter.len() > pool::MAX_FILTER_FIELDS {
            return self.query(collection);
        }
        let conn = self.db.read()?;
        let mut found = BoundedRecords::default();
        pool::visit_collection_where(&conn, collection, filter, pool::MAX_COLLECTION_ROWS, &mut |record| found.take(record))
            .map_err(|e| format!("db.query failed: {}", e))?;
        if found.records.len() as i64 >= pool::MAX_COLLECTION_ROWS {
            pool::warn_capped("db.query with a filter", collection, pool::MAX_COLLECTION_ROWS);
        }
        found.finish()
    }

    fn query(&self, collection: &str) -> Result<Vec<DbRecord>, String> {
        // Use read pool — concurrent with other reads and writes
        let conn = self.db.read()?;
        let mut found = BoundedRecords::default();
        pool::visit_sync_records(&conn, collection, pool::SyncFrom::Page { after: None }, pool::MAX_COLLECTION_ROWS, &mut |record| {
            found.take(record)
        })
        .map_err(|e| format!("db.query failed: {}", e))?;
        if found.records.len() as i64 >= pool::MAX_COLLECTION_ROWS {
            pool::warn_capped("db.query", collection, pool::MAX_COLLECTION_ROWS);
        }
        found.finish()
    }

    fn create(&mut self, collection: &str, data: &str) -> Result<DbRecord, String> {
        validate_collection_name(collection)?;
        if data.len() > MAX_BRIDGE_RECORD_BYTES {
            return Err(format!(
                "db.create: record exceeds {} byte limit",
                MAX_BRIDGE_RECORD_BYTES
            ));
        }
        // Parse JSON BEFORE acquiring the single writer mutex so CPU-bound
        // parsing never stalls concurrent writers.
        let json: serde_json::Value = serde_json::from_str(data)
            .map_err(|e| format!("db.create: invalid JSON: {}", e))?;
        let mut db = self.db.write();
        let (record, _update) = db.create_record(collection, json)
            .map_err(|e| format!("db.create failed: {}", e))?;
        self.announce(&db, &record, true);
        Ok(xdb_to_record(record))
    }

    fn update(&mut self, id: &str, data: &str) -> Result<Option<DbRecord>, String> {
        if data.len() > MAX_BRIDGE_RECORD_BYTES {
            return Err(format!(
                "db.update: record exceeds {} byte limit",
                MAX_BRIDGE_RECORD_BYTES
            ));
        }
        let json: serde_json::Value = serde_json::from_str(data)
            .map_err(|e| format!("db.update: invalid JSON: {}", e))?;
        let mut db = self.db.write();
        match db.update_record(id, json) {
            Ok((r, _)) => {
                self.announce(&db, &r, false);
                Ok(Some(xdb_to_record(r)))
            }
            Err(xdb::DbError::NotFound(_)) => Ok(None),
            Err(e) => Err(format!("db.update failed: {}", e)),
        }
    }

    fn update_if(&mut self, id: &str, data: &str, field: &str, expected: &str) -> Result<DbUpdateIf, String> {
        if data.len() > MAX_BRIDGE_RECORD_BYTES || expected.len() > MAX_BRIDGE_RECORD_BYTES {
            return Err(format!(
                "db.updateIf: payload exceeds {} byte limit",
                MAX_BRIDGE_RECORD_BYTES
            ));
        }
        let json: serde_json::Value = serde_json::from_str(data)
            .map_err(|e| format!("db.updateIf: invalid JSON: {}", e))?;
        let expected: serde_json::Value = serde_json::from_str(expected)
            .map_err(|e| format!("db.updateIf: invalid expected value: {}", e))?;
        // The guard is the store's writer mutex: between reading the field and
        // writing the record, no other worker can write.
        let mut db = self.db.write();
        let existing = match db.get_record(id) {
            Ok(r) if !r.deleted => r,
            Ok(_) => return Ok(DbUpdateIf::Missing),
            Err(xdb::DbError::NotFound(_)) => return Ok(DbUpdateIf::Missing),
            Err(e) => return Err(format!("db.updateIf failed: {}", e)),
        };
        let current = existing.data.get(field).cloned().unwrap_or(serde_json::Value::Null);
        if current != expected {
            return Ok(DbUpdateIf::Conflict);
        }
        match db.update_record(id, json) {
            Ok((r, _)) => {
                self.announce(&db, &r, false);
                Ok(DbUpdateIf::Updated(xdb_to_record(r)))
            }
            Err(xdb::DbError::NotFound(_)) => Ok(DbUpdateIf::Missing),
            Err(e) => Err(format!("db.updateIf failed: {}", e)),
        }
    }

    fn delete(&mut self, id: &str) -> Result<(), String> {
        let mut db = self.db.write();
        db.delete_record(id)
            .map_err(|e| format!("db.delete failed: {}", e))?;
        if let Ok(record) = db.get_record(id) {
            self.announce(&db, &record, false);
        }
        Ok(())
    }

    fn hard_delete(&mut self, collection: &str, id: &str) -> Result<(), String> {
        // XDB only supports soft delete (sets deleted=1 for CRDT sync)
        let mut db = self.db.write();
        // xdb deletes by id alone; the collection the script named is the
        // one it meant, as for `db.get`.
        match db.get_record(id) {
            Ok(record) if record.collection == collection => {}
            Ok(_) | Err(xdb::DbError::NotFound(_)) => {
                return Err(format!("db.hard_delete failed: no record {id} in {collection}"))
            }
            Err(e) => return Err(format!("db.hard_delete failed: {}", e)),
        }
        db.delete_record(id)
            .map_err(|e| format!("db.hard_delete failed: {}", e))?;
        if let Ok(record) = db.get_record(id) {
            self.announce(&db, &record, false);
        }
        Ok(())
    }

    fn get(&self, collection: &str, id: &str) -> Result<Option<DbRecord>, String> {
        // Use read pool — concurrent with other reads and writes
        let conn = self.db.read()?;
        match pool::read_record(&conn, id) {
            // `read_record` looks an id up across the whole table and returns
            // tombstones, because sync needs both. A script asking a collection
            // for an id must not get another collection's record, and must not
            // see one it deleted — `db.query` already hides those.
            Ok(r) if r.deleted || r.collection != collection => Ok(None),
            Ok(r) => Ok(Some(xdb_to_record(r))),
            Err(xdb::DbError::NotFound(_)) => Ok(None),
            Err(e) => Err(format!("db.get failed: {}", e)),
        }
    }

    // Server IS the authority — sync methods are no-ops
    fn start_sync(&mut self, _room: &str) {}
    fn stop_sync(&mut self, _room: Option<&str>) {}
    fn get_sync_status(&self, _room: Option<&str>) -> DbSyncStatus {
        DbSyncStatus {
            connected: true,
            peers: 0,
            room: String::new(),
        }
    }
    fn get_saved_sync_room(&self) -> Option<String> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `db.hardDelete("notes", id)` with an id from a request must not delete
    /// a record in another collection: `db.get` is held to its collection, and
    /// so is this.
    #[test]
    fn hard_delete_is_held_to_its_collection() {
        let dir = crate::test_dirs::temp_path("softn-db-bridge", "");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("xdb.sqlite");
        let db = ServerDb::new(xdb::create_shared_db(path.clone()).unwrap(), &path, 2).unwrap();
        let mut bridge = NativeDbBridge::new(db);
        let admin = bridge.create("admin", r#"{"role":"owner"}"#).unwrap();
        assert!(bridge.hard_delete("notes", &admin.id).is_err());
        assert!(bridge.get("admin", &admin.id).unwrap().is_some());
        bridge.hard_delete("admin", &admin.id).unwrap();
        assert!(bridge.get("admin", &admin.id).unwrap().is_none());
    }

    /// `db.query` stops reading at the record that takes it past its size
    /// cap: it read and parsed the whole page, up to ten thousand records,
    /// before it added anything up.
    #[test]
    fn query_stops_reading_at_its_size_cap() {
        let dir = crate::test_dirs::temp_path("softn-db-bridge", "");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("xdb.sqlite");
        let db = ServerDb::new(xdb::create_shared_db(path.clone()).unwrap(), &path, 2).unwrap();
        let mut bridge = NativeDbBridge::new(db);
        // Twenty records of a megabyte: sixteen fit under the cap.
        let body = "x".repeat(1_000_000);
        for _ in 0..20 {
            bridge.create("big", &format!(r#"{{"kind":"blob","body":"{body}"}}"#)).unwrap();
        }
        bridge.create("small", r#"{"kind":"blob"}"#).unwrap();
        let filter = serde_json::json!({"kind": "blob"});
        let filter = filter.as_object().unwrap();

        let over = format!("db.query exceeded maximum result size ({MAX_BRIDGE_QUERY_BYTES} bytes)");
        assert_eq!(bridge.query("big").unwrap_err(), over);
        assert_eq!(bridge.query_where("big", filter).unwrap_err(), over);
        assert_eq!(bridge.query("small").unwrap().len(), 1);
        assert_eq!(bridge.query_where("small", filter).unwrap().len(), 1);

        // Both reads hand over the seventeenth record and no more.
        let conn = bridge.db.read().unwrap();
        let mut handed = 0;
        let mut found = BoundedRecords::default();
        pool::visit_sync_records(&conn, "big", pool::SyncFrom::Page { after: None }, pool::MAX_COLLECTION_ROWS, &mut |record| {
            handed += 1;
            found.take(record)
        })
        .unwrap();
        assert_eq!((handed, found.records.len(), found.over), (17, 16, true));
        let mut handed = 0;
        let mut found = BoundedRecords::default();
        pool::visit_collection_where(&conn, "big", filter, pool::MAX_COLLECTION_ROWS, &mut |record| {
            handed += 1;
            found.take(record)
        })
        .unwrap();
        assert_eq!((handed, found.records.len(), found.over), (17, 16, true));
        assert!(found.finish().is_err());
    }

    /// What a route's (or a hook's) `db.*` writes reaches every connected
    /// sync client, as another client's push does: it reached a device only
    /// when it next connected and pulled. The whole record goes, since
    /// `db.update` merges and a client replaces a record with what it is sent.
    #[test]
    fn the_servers_own_writes_reach_every_sync_client() {
        let dir = crate::test_dirs::temp_path("softn-db-bridge", "");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("xdb.sqlite");
        let db = ServerDb::new(xdb::create_shared_db(path.clone()).unwrap(), &path, 2).unwrap();
        let stream = crate::sync::sync_stream();
        let mut listening = stream.subscribe();
        let mut bridge = NativeDbBridge::with_stream(db, stream);
        let note = bridge.create("notes", r#"{"title":"one","body":"b"}"#).unwrap();
        bridge.update(&note.id, r#"{"title":"two"}"#).unwrap();
        assert!(matches!(bridge.update_if(&note.id, r#"{"title":"three"}"#, "title", r#""two""#).unwrap(), DbUpdateIf::Updated(_)));
        bridge.delete(&note.id).unwrap();
        let mut told = Vec::new();
        while let Ok((audience, message, _)) = listening.try_recv() {
            assert_eq!(audience, Audience::All);
            let crate::sync::ServerMessage::SyncDelta { ops } = &*message else { panic!("{message:?}") };
            told.extend(ops.iter().map(|op| (op.operation.clone(), op.record_id.clone(), op.data.clone(), op.client_id.clone())));
        }
        let data = |v: serde_json::Value| Some(v);
        assert_eq!(told, vec![
            ("create".to_string(), note.id.clone(), data(serde_json::json!({"title":"one","body":"b"})), "server".to_string()),
            ("update".to_string(), note.id.clone(), data(serde_json::json!({"title":"two","body":"b"})), "server".to_string()),
            ("update".to_string(), note.id.clone(), data(serde_json::json!({"title":"three","body":"b"})), "server".to_string()),
            ("delete".to_string(), note.id.clone(), None, "server".to_string()),
        ]);
        // A write that changed nothing says nothing.
        assert!(bridge.update("no-such-id", "{}").unwrap().is_none());
        assert!(listening.try_recv().is_err());
    }
}
