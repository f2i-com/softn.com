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
    fn query(&self, collection: &str) -> Vec<DbRecord> {
        let db = match self.db.lock() {
            Ok(db) => db,
            Err(e) => {
                tracing::error!("db.query lock error: {}", e);
                return Vec::new();
            }
        };
        db.get_collection(collection)
            .unwrap_or_default()
            .into_iter()
            .map(xdb_to_fl)
            .collect()
    }

    fn create(&mut self, collection: &str, data: &str) -> DbRecord {
        let mut db = match self.db.lock() {
            Ok(db) => db,
            Err(e) => {
                tracing::error!("db.create lock error: {}", e);
                return DbRecord {
                    id: String::new(),
                    collection: collection.to_string(),
                    data: data.to_string(),
                    created_at: String::new(),
                    updated_at: String::new(),
                    data_parsed: None,
                };
            }
        };
        let json: serde_json::Value = serde_json::from_str(data).unwrap_or_default();
        match db.create_record(collection, json) {
            Ok((record, _update)) => xdb_to_fl(record),
            Err(e) => {
                tracing::error!("db.create failed: {}", e);
                DbRecord {
                    id: String::new(),
                    collection: collection.to_string(),
                    data: data.to_string(),
                    created_at: String::new(),
                    updated_at: String::new(),
                    data_parsed: None,
                }
            }
        }
    }

    fn update(&mut self, id: &str, data: &str) -> Option<DbRecord> {
        let mut db = match self.db.lock() {
            Ok(db) => db,
            Err(e) => {
                tracing::error!("db.update lock error: {}", e);
                return None;
            }
        };
        let json: serde_json::Value = serde_json::from_str(data).unwrap_or_default();
        db.update_record(id, json).ok().map(|(r, _)| xdb_to_fl(r))
    }

    fn delete(&mut self, id: &str) {
        let mut db = match self.db.lock() {
            Ok(db) => db,
            Err(e) => {
                tracing::error!("db.delete lock error: {}", e);
                return;
            }
        };
        let _ = db.delete_record(id);
    }

    fn hard_delete(&mut self, _collection: &str, id: &str) {
        // XDB only supports soft delete (sets deleted=1 for CRDT sync)
        tracing::warn!("hard_delete called but XDB only supports soft delete (id={})", id);
        let mut db = match self.db.lock() {
            Ok(db) => db,
            Err(e) => {
                tracing::error!("db.hard_delete lock error: {}", e);
                return;
            }
        };
        let _ = db.delete_record(id);
    }

    fn get(&self, _collection: &str, id: &str) -> Option<DbRecord> {
        let db = match self.db.lock() {
            Ok(db) => db,
            Err(e) => {
                tracing::error!("db.get lock error: {}", e);
                return None;
            }
        };
        db.get_record(id).ok().map(xdb_to_fl)
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
