//! Host capabilities exposed to server-side `.logic`.
//!
//! These traits used to come from `formlogic_core`, whose VM called them as
//! builtin opcodes. zipp is a plain JavaScript engine with a single host
//! channel — strings in, one string out — so the contracts live here and
//! [`crate::host`] maps that channel's `kind` strings onto them.
//!
//! Keeping them as traits rather than folding them into the dispatcher is
//! deliberate: `AppContext` decides per bundle which capabilities exist, and
//! `None` has to mean "the script cannot reach this at all".

pub mod db;
pub mod env;
pub mod fs;
pub mod http;

/// One database row as scripts see it.
///
/// `data` is the parsed document rather than JSON text — scripts write
/// `record.data.title`, so re-encoding it here would only force them to parse
/// it again.
#[derive(Debug, Clone)]
pub struct DbRecord {
    pub id: String,
    pub collection: String,
    pub data: serde_json::Value,
    pub created_at: String,
    pub updated_at: String,
}

impl DbRecord {
    /// The shape `db.*` hands back to the script.
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "id": self.id,
            "collection": self.collection,
            "data": self.data,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        })
    }
}

/// Peer-sync state. The server is the authority, so its answers are static.
#[derive(Debug, Clone)]
pub struct DbSyncStatus {
    pub connected: bool,
    pub peers: u32,
    pub room: String,
}

/// A response from the outbound HTTP bridge.
#[derive(Debug, Clone)]
pub struct HttpResponse {
    pub status: u16,
    pub body: String,
    pub ok: bool,
}

/// Persistence, backed by the bundle's XDB database.
pub trait DbBridge: Send {
    fn query(&self, collection: &str) -> Result<Vec<DbRecord>, String>;
    fn create(&mut self, collection: &str, data: &str) -> Result<DbRecord, String>;
    fn update(&mut self, id: &str, data: &str) -> Result<Option<DbRecord>, String>;
    fn delete(&mut self, id: &str) -> Result<(), String>;
    fn hard_delete(&mut self, collection: &str, id: &str) -> Result<(), String>;
    fn get(&self, collection: &str, id: &str) -> Result<Option<DbRecord>, String>;
    fn start_sync(&mut self, room: &str);
    fn stop_sync(&mut self, room: Option<&str>);
    fn get_sync_status(&self, room: Option<&str>) -> DbSyncStatus;
    fn get_saved_sync_room(&self) -> Option<String>;
}

/// Outbound HTTP. Implementations are responsible for SSRF protection.
pub trait HttpBridge: Send {
    fn get(&self, url: &str) -> Result<HttpResponse, String>;
    fn post(&self, url: &str, body: &str, content_type: &str) -> Result<HttpResponse, String>;
    fn put(&self, url: &str, body: &str, content_type: &str) -> Result<HttpResponse, String>;
    fn delete(&self, url: &str) -> Result<HttpResponse, String>;
}

/// Filesystem access, confined to the bundle's data directory.
pub trait FsBridge: Send {
    fn read_file(&self, path: &str) -> Result<String, String>;
    fn write_file(&mut self, path: &str, content: &str) -> Result<(), String>;
    fn append_file(&mut self, path: &str, content: &str) -> Result<(), String>;
    fn exists(&self, path: &str) -> bool;
    fn list_dir(&self, path: &str) -> Result<Vec<String>, String>;
    fn delete_file(&mut self, path: &str) -> Result<(), String>;
    fn mkdir(&mut self, path: &str) -> Result<(), String>;
}

/// Environment variables and structured logging.
pub trait EnvBridge: Send {
    fn get(&self, name: &str) -> Option<String>;
    fn keys(&self) -> Vec<String>;
    fn log(&self, level: &str, message: &str);
}
