use crate::pool::{self, ServerDb};
use super::{DbBridge, DbRecord, DbSyncStatus};

pub struct NativeDbBridge {
    db: ServerDb,
}

impl NativeDbBridge {
    pub fn new(db: ServerDb) -> Self {
        Self { db }
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

impl DbBridge for NativeDbBridge {
    fn query(&self, collection: &str) -> Result<Vec<DbRecord>, String> {
        // Use read pool — concurrent with other reads and writes
        let conn = self.db.read()?;
        let records = pool::read_collection(&conn, collection)
            .map_err(|e| format!("db.query failed: {}", e))?;
        // Note: the read pool yields `SyncRecord`, not `xdb::Record` — same
        // field set, different type, so this cannot reuse `xdb_to_record`.
        Ok(records.into_iter().map(|r| DbRecord {
            id: r.id,
            collection: r.collection,
            data: r.data,
            created_at: r.created_at,
            updated_at: r.updated_at,
        }).collect())
    }

    fn create(&mut self, collection: &str, data: &str) -> Result<DbRecord, String> {
        let mut db = self.db.write();
        let json: serde_json::Value = serde_json::from_str(data)
            .map_err(|e| format!("db.create: invalid JSON: {}", e))?;
        let (record, _update) = db.create_record(collection, json)
            .map_err(|e| format!("db.create failed: {}", e))?;
        Ok(xdb_to_record(record))
    }

    fn update(&mut self, id: &str, data: &str) -> Result<Option<DbRecord>, String> {
        let mut db = self.db.write();
        let json: serde_json::Value = serde_json::from_str(data)
            .map_err(|e| format!("db.update: invalid JSON: {}", e))?;
        match db.update_record(id, json) {
            Ok((r, _)) => Ok(Some(xdb_to_record(r))),
            Err(xdb::DbError::NotFound(_)) => Ok(None),
            Err(e) => Err(format!("db.update failed: {}", e)),
        }
    }

    fn delete(&mut self, id: &str) -> Result<(), String> {
        let mut db = self.db.write();
        db.delete_record(id)
            .map_err(|e| format!("db.delete failed: {}", e))?;
        Ok(())
    }

    fn hard_delete(&mut self, _collection: &str, id: &str) -> Result<(), String> {
        // XDB only supports soft delete (sets deleted=1 for CRDT sync)
        let mut db = self.db.write();
        db.delete_record(id)
            .map_err(|e| format!("db.hard_delete failed: {}", e))?;
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
