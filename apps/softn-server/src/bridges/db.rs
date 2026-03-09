use formlogic_core::db_bridge::{DbBridge, DbRecord, DbSyncStatus};
use xdb::SharedDb;

pub struct NativeDbBridge {
    db: SharedDb,
}

impl NativeDbBridge {
    pub fn new(db: SharedDb) -> Self {
        Self { db }
    }
}

fn xdb_to_fl(r: xdb::Record) -> DbRecord {
    DbRecord {
        id: r.id,
        collection: r.collection,
        data: r.data.to_string(),
        created_at: r.created_at,
        updated_at: r.updated_at,
        data_parsed: Some(r.data),
    }
}

impl DbBridge for NativeDbBridge {
    fn query(&self, collection: &str) -> Result<Vec<DbRecord>, String> {
        let db = self.db.lock()
            .map_err(|e| format!("db.query lock error: {}", e))?;
        let records = db.get_collection(collection)
            .map_err(|e| format!("db.query failed: {}", e))?;
        Ok(records.into_iter().map(xdb_to_fl).collect())
    }

    fn create(&mut self, collection: &str, data: &str) -> Result<DbRecord, String> {
        let mut db = self.db.lock()
            .map_err(|e| format!("db.create lock error: {}", e))?;
        let json: serde_json::Value = serde_json::from_str(data).unwrap_or_default();
        let (record, _update) = db.create_record(collection, json)
            .map_err(|e| format!("db.create failed: {}", e))?;
        Ok(xdb_to_fl(record))
    }

    fn update(&mut self, id: &str, data: &str) -> Result<Option<DbRecord>, String> {
        let mut db = self.db.lock()
            .map_err(|e| format!("db.update lock error: {}", e))?;
        let json: serde_json::Value = serde_json::from_str(data).unwrap_or_default();
        match db.update_record(id, json) {
            Ok((r, _)) => Ok(Some(xdb_to_fl(r))),
            Err(xdb::DbError::NotFound(_)) => Ok(None),
            Err(e) => Err(format!("db.update failed: {}", e)),
        }
    }

    fn delete(&mut self, id: &str) -> Result<(), String> {
        let mut db = self.db.lock()
            .map_err(|e| format!("db.delete lock error: {}", e))?;
        db.delete_record(id)
            .map_err(|e| format!("db.delete failed: {}", e))?;
        Ok(())
    }

    fn hard_delete(&mut self, _collection: &str, id: &str) -> Result<(), String> {
        // XDB only supports soft delete (sets deleted=1 for CRDT sync)
        let mut db = self.db.lock()
            .map_err(|e| format!("db.hard_delete lock error: {}", e))?;
        db.delete_record(id)
            .map_err(|e| format!("db.hard_delete failed: {}", e))?;
        Ok(())
    }

    fn get(&self, _collection: &str, id: &str) -> Result<Option<DbRecord>, String> {
        let db = self.db.lock()
            .map_err(|e| format!("db.get lock error: {}", e))?;
        match db.get_record(id) {
            Ok(r) => Ok(Some(xdb_to_fl(r))),
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
