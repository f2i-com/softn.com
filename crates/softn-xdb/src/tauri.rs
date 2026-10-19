//! Tauri Integration Module
//!
//! Provides Tauri command handlers and setup utilities for easy integration
//! with Tauri applications.
//!
//! ## Usage
//!
//! ```rust,ignore
//! use xdb::tauri::{setup_xdb, XdbState};
//!
//! tauri::Builder::default()
//!     .setup(|app| {
//!         xdb::tauri::setup_xdb(app)?;
//!         Ok(())
//!     })
//!     .invoke_handler(tauri::generate_handler![
//!         xdb::tauri::create_record,
//!         xdb::tauri::update_record,
//!         xdb::tauri::delete_record,
//!         xdb::tauri::get_record,
//!         xdb::tauri::get_collection,
//!         xdb::tauri::get_collections,
//!         xdb::tauri::get_db_stats,
//!         xdb::tauri::get_network_status,
//!         xdb::tauri::request_sync,
//!         xdb::tauri::export_database,
//!         xdb::tauri::import_database,
//!         xdb::tauri::get_db_path,
//!     ])
//!     .run(tauri::generate_context!())
//!     .expect("error running app");
//! ```

use crate::db::{
    create_shared_db, CollectionImport, DbStats, ImportSummary, Record, SharedDb,
};
use crate::network::{
    create_shared_network, NetworkEvent, NetworkMessage, NetworkNode, NetworkOptions,
    SharedNetwork, SyncGate, SyncStats,
};

/// The network state a host's `setup_xdb` manages, named here so a host can
/// wrap the commands that take it (for example to gate `import_database`
/// behind its own checks) without reaching into the private module.
pub use crate::network::SharedNetwork as SharedNetworkState;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::broadcast;
use tracing::{error, info, warn};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateRecordPayload {
    pub collection: String,
    pub data: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateRecordPayload {
    pub id: String,
    pub data: serde_json::Value,
}

/// Honest network status (audit XD-01/XD-02): what is ENABLED, what is
/// RUNNING, whether synchronization is paused, and counters of what the node
/// actually did. There is deliberately no single "synced" flag.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetworkStatus {
    pub peer_id: String,
    pub connected_peers: Vec<String>,
    pub is_running: bool,
    /// "local-only" (default) or "trusted-lan" (explicit opt-in).
    pub mode: String,
    pub enabled: bool,
    pub discovery: bool,
    pub listening: bool,
    /// Held after a local-scope restore until `resume_sync` (audit XD-03).
    pub sync_paused: bool,
    /// The unresolved restore holding the pause, when there is one (R2-XD-01).
    #[serde(default)]
    pub pending_restore: Option<PendingRestore>,
    pub stats: SyncStats,
}

/// Persisted networking choice (audit XD-01). Defaults to LOCAL ONLY: opening
/// a database never starts discovery or listening; the user/admin opts in.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct NetworkSettings {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_true")]
    pub discovery: bool,
    #[serde(default = "default_true")]
    pub listen: bool,
}

fn default_true() -> bool {
    true
}

impl Default for NetworkSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            discovery: true,
            listen: true,
        }
    }
}

impl NetworkSettings {
    pub const FILE_NAME: &'static str = "network-settings.json";

    pub fn path(base_dir: &std::path::Path) -> PathBuf {
        base_dir.join(Self::FILE_NAME)
    }

    /// Missing or unreadable settings mean local-only, never "enabled".
    pub fn load(base_dir: &std::path::Path) -> Self {
        match std::fs::read(Self::path(base_dir)) {
            Ok(bytes) => match serde_json::from_slice::<NetworkSettings>(&bytes) {
                Ok(settings) => settings,
                Err(e) => {
                    warn!("Ignoring unreadable network settings (local-only): {}", e);
                    Self::default()
                }
            },
            Err(_) => Self::default(),
        }
    }

    pub fn save(&self, base_dir: &std::path::Path) -> Result<(), String> {
        std::fs::create_dir_all(base_dir).map_err(|e| e.to_string())?;
        let path = Self::path(base_dir);
        let pending = path.with_extension("json.pending");
        std::fs::write(
            &pending,
            serde_json::to_vec_pretty(self).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        std::fs::rename(&pending, &path).map_err(|e| e.to_string())
    }

    pub fn options(&self) -> NetworkOptions {
        NetworkOptions {
            discovery: self.discovery,
            listen: self.listen,
        }
    }
}

/// A restore of the synchronized default database whose consequence for
/// peers is not settled yet (R2-XD-01). Written OUTSIDE the database bytes
/// being replaced, BEFORE the replacement begins, and loaded before any
/// network start, so a restart or a later "enable networking" cannot bypass
/// the decision. `local` stays pending until `resume_sync`; `replace` stays
/// pending until its reset plan has been published to peers.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PendingRestore {
    pub app_id: String,
    /// "local" | "replace"
    pub scope: String,
    pub started_at: String,
    /// True once the database bytes were replaced (for `replace`, the epoch
    /// plan below is committed too); false means the restore was interrupted
    /// before completion and the pre-restore backup is the recovery source.
    #[serde(default)]
    pub applied: bool,
    /// The authoritative reset plan (replace scope) still to be published.
    #[serde(default)]
    pub reset_plan: Vec<(String, u64)>,
    #[serde(default)]
    pub backup_path: Option<String>,
    /// Recovery journal (R3-XD-02), written BEFORE the live database is touched:
    /// `"planned"` (backup taken and plan computed, nothing replaced yet),
    /// `"applied"` (data and reset epochs activated in one step). Empty in
    /// records written before this field existed; see `phase()`.
    #[serde(default)]
    pub phase: String,
    /// The live catalog the plan was computed against.
    #[serde(default)]
    pub prior_catalog: Vec<(String, u64)>,
    /// The snapshot being restored, so an interrupted restore can be completed.
    #[serde(default)]
    pub source_path: Option<String>,
    /// Set when the record on disk could not be read or parsed (R3-XD-01): the
    /// reason, for the operator. Such a record holds synchronization and can
    /// only be discarded explicitly.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unreadable: Option<String>,
}

impl PendingRestore {
    pub const FILE_NAME: &'static str = "pending-restore.json";

    pub fn path(base_dir: &std::path::Path) -> PathBuf {
        base_dir.join(Self::FILE_NAME)
    }

    /// The recovery phase, also for records written before `phase` existed.
    pub fn phase(&self) -> &str {
        if !self.phase.is_empty() {
            &self.phase
        } else if self.applied {
            "applied"
        } else {
            "planned"
        }
    }

    /// Whether `resume_sync` may lift the pause: the restore completed
    /// (data and metadata are consistent) and the record itself is readable.
    pub fn is_resumable(&self) -> bool {
        self.unreadable.is_none() && self.phase() == "applied"
    }

    fn unreadable(reason: String) -> Self {
        PendingRestore {
            app_id: "_default".into(),
            scope: "unknown".into(),
            started_at: String::new(),
            applied: false,
            reset_plan: Vec::new(),
            backup_path: None,
            phase: "unknown".into(),
            prior_catalog: Vec::new(),
            source_path: None,
            unreadable: Some(reason),
        }
    }

    /// Only a confirmed ABSENT file means "no pending restore" (R3-XD-01). A
    /// file that exists but cannot be read (permissions, a directory in its
    /// place, an I/O error) or parsed is returned as pending and `unreadable`,
    /// because the safe reading of an unknown restore decision is "not decided".
    pub fn load(base_dir: &std::path::Path) -> Option<Self> {
        let path = Self::path(base_dir);
        let bytes = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
            Err(e) => {
                let reason = format!("cannot read {}: {}", path.display(), e);
                warn!("Pending-restore record unreadable; holding synchronization: {}", reason);
                return Some(Self::unreadable(reason));
            }
        };
        match serde_json::from_slice::<PendingRestore>(&bytes) {
            Ok(pending) => Some(pending),
            Err(e) => {
                let reason = format!("cannot parse {}: {}", path.display(), e);
                warn!("Pending-restore record unreadable; holding synchronization: {}", reason);
                Some(Self::unreadable(reason))
            }
        }
    }

    pub fn save(&self, base_dir: &std::path::Path) -> Result<(), String> {
        std::fs::create_dir_all(base_dir).map_err(|e| e.to_string())?;
        let path = Self::path(base_dir);
        let pending = path.with_extension("json.pending");
        std::fs::write(&pending, serde_json::to_vec_pretty(self).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        std::fs::rename(&pending, &path).map_err(|e| e.to_string())
    }

    pub fn clear(base_dir: &std::path::Path) -> Result<(), String> {
        match std::fs::remove_file(Self::path(base_dir)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

/// Host-side control of networking: the persisted choice, the pause gate and
/// the default database the legacy protocol serves.
pub struct NetworkControl {
    base_dir: PathBuf,
    settings: StdMutex<NetworkSettings>,
    gate: Arc<SyncGate>,
    default_db: SharedDb,
    pending_restore: StdMutex<Option<PendingRestore>>,
}

impl NetworkControl {
    /// Loads any persisted pending restore and pauses the gate BEFORE any
    /// network node can exist (R2-XD-01).
    pub fn new(base_dir: PathBuf, settings: NetworkSettings, default_db: SharedDb) -> Self {
        let pending = PendingRestore::load(&base_dir);
        let gate = SyncGate::new();
        if let Some(p) = &pending {
            warn!(
                "Unresolved {} restore of '{}' from {}: synchronization stays paused until it is resolved",
                p.scope, p.app_id, p.started_at
            );
            gate.pause();
        }
        Self {
            base_dir,
            settings: StdMutex::new(settings),
            gate,
            default_db,
            pending_restore: StdMutex::new(pending),
        }
    }

    pub fn settings(&self) -> NetworkSettings {
        self.settings.lock().map(|s| *s).unwrap_or_default()
    }

    pub fn gate(&self) -> Arc<SyncGate> {
        self.gate.clone()
    }

    pub fn pending_restore(&self) -> Option<PendingRestore> {
        self.pending_restore.lock().ok().and_then(|p| p.clone())
    }

    /// Persist the pending record first, then pause: nothing may apply once
    /// the record exists, and a crash between the two leaves the pause to be
    /// re-established at startup from the record.
    pub fn begin_restore(&self, pending: PendingRestore) -> Result<(), String> {
        pending.save(&self.base_dir)?;
        self.gate.pause();
        if let Ok(mut slot) = self.pending_restore.lock() {
            *slot = Some(pending);
        }
        Ok(())
    }

    pub fn update_restore(&self, pending: PendingRestore) -> Result<(), String> {
        pending.save(&self.base_dir)?;
        if let Ok(mut slot) = self.pending_restore.lock() {
            *slot = Some(pending);
        }
        Ok(())
    }

    /// The explicit, durable resolution: remove the record, then lift the pause.
    pub fn resolve_restore(&self) -> Result<(), String> {
        PendingRestore::clear(&self.base_dir)?;
        if let Ok(mut slot) = self.pending_restore.lock() {
            *slot = None;
        }
        self.gate.resume();
        Ok(())
    }

    /// Whether `resume_sync` may lift the pause now (R3-XD-02, R4-XD-01).
    /// `Ok(None)`: nothing is pending. `Ok(Some)`: the restore completed and
    /// may be published/resolved. `Err`: the record is unreadable, the restore
    /// was interrupted before it was applied, or it is an applied `replace`
    /// whose reset plan cannot be published because no network node is
    /// running (`node_available`); the pause stays and the error names the
    /// recovery source and the actions that resolve it.
    pub fn resume_decision(&self, node_available: bool) -> Result<Option<PendingRestore>, String> {
        let Some(pending) = self.pending_restore() else {
            return Ok(None);
        };
        if let Some(reason) = &pending.unreadable {
            return Err(format!(
                "Synchronization stays paused: the pending-restore record cannot be read ({reason}). Inspect the file; if the restore it recorded is known to be settled, call recover_restore with action \"discard\" to acknowledge it, otherwise restore the pre-restore backup by hand first"
            ));
        }
        if pending.is_resumable() {
            Self::publication_precondition(&pending, node_available)?;
            return Ok(Some(pending));
        }
        let backup = pending.backup_path.clone().unwrap_or_else(|| "(no backup was taken yet)".into());
        Err(format!(
            "Synchronization stays paused: the {} restore of '{}' started {} was interrupted before it was applied (phase {}). Its pre-restore backup is {}. Call recover_restore with action \"rollback\" (restore that backup) or \"complete\" (re-apply the journaled restore) before resuming",
            pending.scope, pending.app_id, pending.started_at, pending.phase(), backup
        ))
    }

    /// An applied `replace` restore is resolved only by PUBLISHING its reset
    /// plan (R4-XD-01): without a running network node the plan would be
    /// dropped and peers would never adopt the reset. The same rule decides
    /// initial import, `recover_restore complete`/`publish` and `resume_sync`,
    /// so the record stays pending (and the pause held) offline, survives a
    /// restart, and is found again when networking is enabled. `local` scope
    /// restores carry no plan and are resolved by the explicit resume alone.
    pub fn publication_precondition(pending: &PendingRestore, node_available: bool) -> Result<(), String> {
        if pending.scope == "replace" && pending.phase() == "applied" && !node_available {
            return Err(format!(
                "Synchronization stays paused: the authoritative (replace) restore of '{}' is applied, but its reset plan for {} collection(s) has not been published to peers and cannot be while networking is off. Enable networking (set_network_enabled), then call resume_sync or recover_restore with action \"complete\"; the plan is kept until then",
                pending.app_id,
                pending.reset_plan.len()
            ));
        }
        Ok(())
    }

    /// What `recover_restore` must do for `action` (R3-XD-02), decided from
    /// the journal alone so the rule is testable without a database:
    /// - `discard` acknowledges a record that changed nothing (unreadable, or
    ///   planned before a backup was taken); a restore that touched data
    ///   cannot be discarded.
    /// - `rollback` restores the pre-restore backup, in every phase that has one.
    /// - `complete` re-applies the journaled restore when it was interrupted
    ///   before activation, or publishes/resolves an applied one.
    pub fn recovery_plan(&self, action: &str) -> Result<RecoveryStep, String> {
        let Some(pending) = self.pending_restore() else {
            return Err("No restore is pending; nothing to recover".to_string());
        };
        // A readable record still in the `planned` phase with no backup taken
        // means no byte of the live database has moved yet.
        let nothing_changed =
            pending.unreadable.is_none() && pending.phase() == "planned" && pending.backup_path.is_none();
        match action {
            "discard" => {
                if pending.unreadable.is_some() || nothing_changed {
                    Ok(RecoveryStep::Discard)
                } else {
                    Err(format!(
                        "Refusing to discard: this {} restore (phase {}) changed or may have changed data; use \"rollback\" (backup {}) or \"complete\"",
                        pending.scope,
                        pending.phase(),
                        pending.backup_path.clone().unwrap_or_default()
                    ))
                }
            }
            "rollback" => {
                if let Some(reason) = &pending.unreadable {
                    return Err(format!("The pending-restore record cannot be read ({reason}); no backup path is known. Restore by hand, then \"discard\""));
                }
                match &pending.backup_path {
                    Some(backup) => Ok(RecoveryStep::Rollback { app_id: pending.app_id.clone(), backup: PathBuf::from(backup) }),
                    None => Ok(RecoveryStep::Discard),
                }
            }
            "complete" => {
                if let Some(reason) = &pending.unreadable {
                    return Err(format!("The pending-restore record cannot be read ({reason}); it cannot be completed"));
                }
                if pending.phase() == "applied" {
                    return Ok(RecoveryStep::Publish { pending });
                }
                let Some(source) = &pending.source_path else {
                    return Err("The journal has no source snapshot to complete from; use \"rollback\"".to_string());
                };
                if pending.scope == "replace" && pending.reset_plan.is_empty() {
                    return Err("The journal has no reset plan to complete with; use \"rollback\"".to_string());
                }
                Ok(RecoveryStep::Complete { source: PathBuf::from(source), pending })
            }
            other => Err(format!("Unknown recovery action '{other}' (discard | rollback | complete)")),
        }
    }
}

/// One step `recover_restore` executes (R3-XD-02).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RecoveryStep {
    /// Remove the record and lift the pause; nothing on disk changed.
    Discard,
    /// Restore the pre-restore backup, then resolve.
    Rollback { app_id: String, backup: PathBuf },
    /// Re-apply the journaled restore (data + plan in one step), then publish/resolve.
    Complete { source: PathBuf, pending: PendingRestore },
    /// The restore is applied: publish its plan (replace scope) and resolve.
    Publish { pending: PendingRestore },
}

/// What `recover_restore` did.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RecoveryOutcome {
    pub action: String,
    /// "discarded" | "rolled-back" | "completed" | "published"
    pub result: String,
    pub sync_paused: bool,
}

pub type SharedNetworkControl = Arc<NetworkControl>;

/// What a database import did, including the identity it landed in.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ImportOutcome {
    pub app_id: String,
    /// "local" | "fork" | "replace" (audit XD-03).
    pub scope: String,
    /// True when synchronization is now held until `resume_sync`.
    pub sync_paused: bool,
    /// Collections whose epoch was advanced (replace scope only).
    pub reset_collections: Vec<String>,
}

// ============================================================================
// Per-App Database Manager
// ============================================================================

/// Manages per-app SQLite databases.
///
/// Each app gets its own SQLite file at `{base_dir}/apps/{app_id}/data.sqlite`.
/// Databases are created lazily on first access.
pub struct DbManager {
    base_dir: PathBuf,
    default_db_path: PathBuf,
    databases: StdMutex<HashMap<String, SharedDb>>,
    app_handle: Option<AppHandle>,
}

impl DbManager {
    pub fn new(base_dir: PathBuf) -> Self {
        Self {
            default_db_path: base_dir.join("apps").join("_default").join("data.sqlite"),
            base_dir,
            databases: StdMutex::new(HashMap::new()),
            app_handle: None,
        }
    }

    /// Use an already opened database for the default app. Named apps continue
    /// to use independent files under `base_dir/apps`.
    pub fn with_default_database(base_dir: PathBuf, db: SharedDb) -> Result<Self, String> {
        let default_db_path = db.lock().map_err(|e| e.to_string())?.path().clone();
        Ok(Self {
            base_dir,
            default_db_path,
            databases: StdMutex::new(HashMap::from([("_default".to_string(), db)])),
            app_handle: None,
        })
    }

    fn with_app_handle(mut self, app_handle: AppHandle) -> Self {
        self.app_handle = Some(app_handle);
        self
    }

    fn emit_change(&self, app_id: &str, change_type: &str, collection: Option<&str>) {
        if let Some(app) = &self.app_handle {
            let mut payload = serde_json::json!({
                "type": change_type,
                "app_id": sanitize_app_id(app_id),
            });
            if let Some(collection) = collection {
                payload["collection"] = collection.into();
            }
            let _ = app.emit("xdb-data-event", payload);
        }
    }

    /// Get or create a database for the given app ID.
    /// Empty or missing app_id defaults to "_default".
    pub fn get_db(&self, app_id: &str) -> Result<SharedDb, String> {
        let app_id = sanitize_app_id(app_id);
        let mut dbs = self.databases.lock().map_err(|e| e.to_string())?;
        if let Some(db) = dbs.get(&app_id) {
            return Ok(db.clone());
        }
        let db_path = self.get_app_path(&app_id);
        if let Some(db_dir) = db_path.parent() {
            std::fs::create_dir_all(db_dir).map_err(|e| e.to_string())?;
        }
        info!("Opening per-app database: {:?}", db_path);
        let db = create_shared_db(db_path).map_err(|e| e.to_string())?;
        dbs.insert(app_id, db.clone());
        Ok(db)
    }

    /// Whether an app database is already open in this manager.
    pub fn is_open(&self, app_id: &str) -> Option<()> {
        let app_id = sanitize_app_id(app_id);
        self.databases
            .lock()
            .ok()
            .and_then(|dbs| dbs.contains_key(&app_id).then_some(()))
    }

    /// Get the database file path for a given app ID.
    pub fn get_app_path(&self, app_id: &str) -> PathBuf {
        let app_id = sanitize_app_id(app_id);
        if app_id == "_default" {
            self.default_db_path.clone()
        } else {
            self.base_dir.join("apps").join(&app_id).join("data.sqlite")
        }
    }

    /// Get the base directory where all app databases are stored.
    pub fn base_dir(&self) -> &PathBuf {
        &self.base_dir
    }
}

/// Thread-safe shared database manager
pub type SharedDbManager = Arc<DbManager>;

/// Sanitize an app ID to a safe directory name.
fn sanitize_app_id(app_id: &str) -> String {
    let trimmed = app_id.trim();
    if trimmed.is_empty() {
        return "_default".to_string();
    }
    trimmed
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

fn supports_legacy_sync(app_id: &str) -> bool {
    sanitize_app_id(app_id) == "_default"
}

async fn broadcast_scoped_update(
    network: &SharedNetwork,
    app_id: &str,
    collection: &str,
    epoch: u64,
    update: Vec<u8>,
) {
    // The v1 wire format has no app identity. Sending named-app data through
    // this node would mix it with the default database on other peers.
    if !supports_legacy_sync(app_id) {
        return;
    }
    let net = { network.lock().await.clone() };
    if let Some(net) = net {
        if net.gate().is_paused() {
            // Local commit succeeded; publication is held until the operator
            // resolves the pending restore (audit XD-03).
            return;
        }
        if let Err(e) = net.broadcast_update(collection, epoch, update).await {
            error!("Failed to broadcast update: {}", e);
        }
    }
}


/// Collision-resistant, create-only fork identity (R2-XD-04): a random id
/// under the source app's sanitized label, retried while the destination
/// already exists so an existing namespace is never reused as a fork target.
fn allocate_fork_id(db_manager: &DbManager, requested_app: &str) -> Result<String, String> {
    allocate_fork_id_with(db_manager, requested_app, || uuid::Uuid::new_v4().simple().to_string())
}

/// The allocator with an injectable id source. The destination directory is
/// RESERVED with create-new semantics before the identity is returned, so two
/// concurrent allocations (or a collision of the id source) can never both
/// receive the same namespace: the loser sees `AlreadyExists` and retries.
fn allocate_fork_id_with(
    db_manager: &DbManager,
    requested_app: &str,
    mut next_id: impl FnMut() -> String,
) -> Result<String, String> {
    let label = sanitize_app_id(requested_app);
    for _ in 0..16 {
        let candidate = format!("{}-fork-{}", label, next_id());
        if db_manager.is_open(&candidate).is_some() {
            continue;
        }
        let path = db_manager.get_app_path(&candidate);
        let Some(dir) = path.parent() else { continue };
        if let Some(parent) = dir.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        match std::fs::create_dir(dir) {
            Ok(()) => return Ok(candidate),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("Could not reserve fork namespace {}: {}", dir.display(), e)),
        }
    }
    Err("Could not allocate a fresh fork identity; try again".to_string())
}

fn backup_database_for_import(
    db: &crate::db::XdbDatabase,
    source: &PathBuf,
) -> Result<PathBuf, String> {
    let mut backup_path = db.path().with_extension("db.backup");
    if backup_path.canonicalize().ok().as_ref() == Some(source) {
        // Restoring our last backup must not overwrite that source first.
        backup_path = db
            .path()
            .with_extension(format!("db.backup-{}", uuid::Uuid::new_v4()));
    }
    db.export_to_file(&backup_path).map_err(|e| e.to_string())?;
    Ok(backup_path)
}

/// Setup XDB in a Tauri application: LOCAL databases only (audit XD-01).
///
/// Opening a database never starts peer discovery or listening. Networking
/// starts only when the persisted `NetworkSettings` say `enabled: true`
/// (written by `set_network_enabled` after an explicit user/admin choice).
/// Call this in your `setup` hook.
///
/// ## Example
///
/// ```rust,ignore
/// tauri::Builder::default()
///     .setup(|app| {
///         xdb::tauri::setup_xdb(app)?;
///         Ok(())
///     })
/// ```
pub fn setup_xdb(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    // Get app data directory for database
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;

    // Create the directory if it doesn't exist
    std::fs::create_dir_all(&app_data_dir)?;

    // Create per-app database manager
    let db_manager =
        Arc::new(DbManager::new(app_data_dir.clone()).with_app_handle(app.handle().clone()));
    // Commands and the legacy network must share the same default database.
    // Older orphaned xdb.sqlite files are left untouched for manual recovery.
    let db = db_manager
        .get_db("")
        .map_err(|e| format!("Failed to initialize XDB database: {}", e))?;
    info!(
        "XDB per-app database directory: {:?}",
        app_data_dir.join("apps")
    );

    finish_setup(app, app_data_dir, db, db_manager)
}

/// Shared tail of both setup paths: manage state and start networking ONLY
/// when the persisted settings opt in.
fn finish_setup(
    app: &tauri::App,
    base_dir: PathBuf,
    db: SharedDb,
    db_manager: Arc<DbManager>,
) -> Result<(), Box<dyn std::error::Error>> {
    let settings = NetworkSettings::load(&base_dir);
    let control = Arc::new(NetworkControl::new(base_dir, settings, db.clone()));
    let network = create_shared_network();

    app.manage(db.clone());
    app.manage(db_manager);
    app.manage(network.clone());
    app.manage(control.clone());

    if settings.enabled {
        info!("XDB peer networking enabled by persisted opt-in (trusted LAN)");
        let app_handle = app.handle().clone();
        let gate = control.gate();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = init_network(app_handle, db, network, settings.options(), gate).await {
                error!("Failed to initialize XDB network: {}", e);
            }
        });
    } else {
        info!("XDB running local-only; peer networking is off until explicitly enabled");
    }
    Ok(())
}

/// Setup XDB with a custom database path
pub fn setup_xdb_with_path(
    app: &tauri::App,
    db_path: PathBuf,
) -> Result<(), Box<dyn std::error::Error>> {
    // Create parent directory if it doesn't exist
    let base_dir = db_path
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));
    std::fs::create_dir_all(&base_dir)?;

    info!("XDB database path: {:?}", db_path);

    // Initialize the database
    let db = create_shared_db(db_path)
        .map_err(|e| format!("Failed to initialize XDB database: {}", e))?;

    // Create per-app database manager
    let db_manager = Arc::new(
        DbManager::with_default_database(base_dir.clone(), db.clone())?
            .with_app_handle(app.handle().clone()),
    );

    finish_setup(app, base_dir, db, db_manager)
}

/// Start the P2P network (only ever called after an explicit opt-in).
async fn init_network(
    app_handle: AppHandle,
    db: SharedDb,
    network: SharedNetwork,
    options: NetworkOptions,
    gate: Arc<SyncGate>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // Create broadcast channel for network events
    let (event_tx, event_rx) = broadcast::channel::<NetworkEvent>(100);

    // Start the P2P network node
    let node = NetworkNode::new(db.clone(), event_tx, options, gate).await?;
    info!("XDB Network started with peer ID: {}", node.local_peer_id());

    // Store the network node
    *network.lock().await = Some(node);

    // Setup event forwarding to frontend
    setup_network_events(app_handle, event_rx);

    Ok(())
}

/// Shutdown XDB gracefully
///
/// Call this when your app is closing to ensure clean shutdown.
pub async fn shutdown_xdb(network: &SharedNetwork) {
    let net = { network.lock().await.take() };
    if let Some(net) = net {
        if let Err(e) = net.shutdown().await {
            error!("Failed to shutdown XDB network: {}", e);
        } else {
            info!("XDB network shutdown complete");
        }
    }
}

// ============================================================================
// Tauri Commands
// ============================================================================

/// Create a new record in a collection
#[tauri::command]
pub async fn create_record(
    db_manager: State<'_, SharedDbManager>,
    network: State<'_, SharedNetwork>,
    app_id: Option<String>,
    payload: CreateRecordPayload,
) -> Result<Record, String> {
    let app_id = app_id.unwrap_or_default();
    let db = db_manager.get_db(&app_id)?;
    let (record, update, epoch) = {
        let mut db_lock = db.lock().map_err(|e| e.to_string())?;
        let (record, update) = db_lock
            .create_record(&payload.collection, payload.data)
            .map_err(|e| e.to_string())?;
        let epoch = db_lock.get_epoch(&payload.collection).unwrap_or(0);
        (record, update, epoch)
    };

    db_manager.emit_change(&app_id, "create", Some(&payload.collection));
    broadcast_scoped_update(&network, &app_id, &payload.collection, epoch, update).await;

    info!(
        "Created record {} in collection {}",
        record.id, record.collection
    );
    Ok(record)
}

/// Update an existing record
#[tauri::command]
pub async fn update_record(
    db_manager: State<'_, SharedDbManager>,
    network: State<'_, SharedNetwork>,
    app_id: Option<String>,
    payload: UpdateRecordPayload,
) -> Result<Record, String> {
    let app_id = app_id.unwrap_or_default();
    let db = db_manager.get_db(&app_id)?;
    let (record, update, epoch) = {
        let mut db_lock = db.lock().map_err(|e| e.to_string())?;
        let (record, update) = db_lock
            .update_record(&payload.id, payload.data)
            .map_err(|e| e.to_string())?;
        let epoch = db_lock.get_epoch(&record.collection).unwrap_or(0);
        (record, update, epoch)
    };

    db_manager.emit_change(&app_id, "update", Some(&record.collection));
    broadcast_scoped_update(&network, &app_id, &record.collection, epoch, update).await;

    info!("Updated record {}", record.id);
    Ok(record)
}

/// Update several records in ONE transaction (XD-04 follow-up): one CRDT
/// snapshot per touched collection instead of one per record, all-or-nothing,
/// and the deltas are published only after the commit. Returns the updated
/// records in request order.
#[tauri::command]
pub async fn update_records(
    db_manager: State<'_, SharedDbManager>,
    network: State<'_, SharedNetwork>,
    app_id: Option<String>,
    updates: Vec<UpdateRecordPayload>,
) -> Result<Vec<Record>, String> {
    let app_id = app_id.unwrap_or_default();
    let db = db_manager.get_db(&app_id)?;
    let (records, deltas) = {
        let mut db_lock = db.lock().map_err(|e| e.to_string())?;
        let out = db_lock
            .update_records(updates.into_iter().map(|u| (u.id, u.data)).collect())
            .map_err(|e| e.to_string())?;
        let mut records = Vec::with_capacity(out.len());
        let mut deltas = Vec::with_capacity(out.len());
        for (record, update) in out {
            let epoch = db_lock.get_epoch(&record.collection).unwrap_or(0);
            deltas.push((record.collection.clone(), epoch, update));
            records.push(record);
        }
        (records, deltas)
    };

    let mut touched: Vec<&str> = records.iter().map(|r| r.collection.as_str()).collect();
    touched.sort_unstable();
    touched.dedup();
    for collection in touched {
        db_manager.emit_change(&app_id, "update", Some(collection));
    }
    for (collection, epoch, update) in deltas {
        broadcast_scoped_update(&network, &app_id, &collection, epoch, update).await;
    }

    info!("Updated {} records in one transaction", records.len());
    Ok(records)
}

/// Delete a record (soft delete)
#[tauri::command]
pub async fn delete_record(
    db_manager: State<'_, SharedDbManager>,
    network: State<'_, SharedNetwork>,
    app_id: Option<String>,
    id: String,
) -> Result<bool, String> {
    let app_id = app_id.unwrap_or_default();
    let db = db_manager.get_db(&app_id)?;
    let (collection, update, epoch) = {
        let mut db_lock = db.lock().map_err(|e| e.to_string())?;
        let record = db_lock.get_record(&id).map_err(|e| e.to_string())?;
        let update = db_lock.delete_record(&id).map_err(|e| e.to_string())?;
        let epoch = db_lock.get_epoch(&record.collection).unwrap_or(0);
        (record.collection, update, epoch)
    };

    db_manager.emit_change(&app_id, "delete", Some(&collection));
    broadcast_scoped_update(&network, &app_id, &collection, epoch, update).await;

    info!("Deleted record {}", id);
    Ok(true)
}

/// Upsert a record with a specific ID (for external sync sources)
#[tauri::command]
pub async fn upsert_record(
    db_manager: State<'_, SharedDbManager>,
    network: State<'_, SharedNetwork>,
    app_id: Option<String>,
    record: Record,
) -> Result<Record, String> {
    let app_id = app_id.unwrap_or_default();
    let db = db_manager.get_db(&app_id)?;
    let (update, epoch) = {
        let mut db_lock = db.lock().map_err(|e| e.to_string())?;
        let update = db_lock
            .upsert_record(record.clone())
            .map_err(|e| e.to_string())?;
        let epoch = db_lock.get_epoch(&record.collection).unwrap_or(0);
        (update, epoch)
    };

    db_manager.emit_change(&app_id, "upsert", Some(&record.collection));
    broadcast_scoped_update(&network, &app_id, &record.collection, epoch, update).await;

    Ok(record)
}

/// Bulk import in ONE transaction (audit SN-01): validates the whole batch,
/// applies replace/merge per collection, and returns the summary only after
/// the commit. Deltas are published after the commit, never before.
#[tauri::command]
pub async fn import_records(
    db_manager: State<'_, SharedDbManager>,
    network: State<'_, SharedNetwork>,
    app_id: Option<String>,
    batches: Vec<CollectionImport>,
) -> Result<ImportSummary, String> {
    let app_id = app_id.unwrap_or_default();
    let db = db_manager.get_db(&app_id)?;
    let (summary, deltas) = {
        let mut db_lock = db.lock().map_err(|e| e.to_string())?;
        db_lock.import_records(batches).map_err(|e| e.to_string())?
    };
    for result in &summary.collections {
        db_manager.emit_change(&app_id, "import", Some(&result.collection));
    }
    for (collection, epoch, update) in deltas {
        broadcast_scoped_update(&network, &app_id, &collection, epoch, update).await;
    }
    info!(
        "Imported {} records ({} tombstoned) across {} collections",
        summary.imported,
        summary.tombstoned,
        summary.collections.len()
    );
    Ok(summary)
}

/// Reset a collection (audit XD-03). `scope`:
/// - "local" (default): this node's cache only; peers keep their copy and will
///   repopulate this node on the next reconciliation.
/// - "replicated": an administrative reset of the SHARED dataset — the epoch
///   advances and peers adopt it; stale peers cannot reintroduce old records.
#[tauri::command]
pub async fn reset_collection(
    db_manager: State<'_, SharedDbManager>,
    network: State<'_, SharedNetwork>,
    app_id: Option<String>,
    collection: String,
    scope: Option<String>,
) -> Result<u64, String> {
    let app_id = app_id.unwrap_or_default();
    let scope = scope.unwrap_or_else(|| "local".to_string());
    let db = db_manager.get_db(&app_id)?;
    let epoch = {
        let mut db_lock = db.lock().map_err(|e| e.to_string())?;
        match scope.as_str() {
            "local" => {
                db_lock
                    .clear_collection(&collection)
                    .map_err(|e| e.to_string())?;
                db_lock.get_epoch(&collection).unwrap_or(0)
            }
            "replicated" => db_lock
                .reset_collection(&collection, "local-admin")
                .map_err(|e| e.to_string())?,
            other => return Err(format!("Unknown reset scope '{other}' (local | replicated)")),
        }
    };
    db_manager.emit_change(&app_id, "clear", Some(&collection));
    if scope == "replicated" && supports_legacy_sync(&app_id) {
        let net = { network.lock().await.clone() };
        if let Some(net) = net {
            net.broadcast_reset(&collection, epoch).await?;
        }
    }
    info!("Reset collection {} (scope {}, epoch {})", collection, scope, epoch);
    Ok(epoch)
}

/// Get a single record by ID
#[tauri::command]
pub fn get_record(
    db_manager: State<'_, SharedDbManager>,
    app_id: Option<String>,
    id: String,
) -> Result<Record, String> {
    let db = db_manager.get_db(&app_id.unwrap_or_default())?;
    let db_lock = db.lock().map_err(|e| e.to_string())?;
    db_lock.get_record(&id).map_err(|e| e.to_string())
}

/// Get all records in a collection
#[tauri::command]
pub fn get_collection(
    db_manager: State<'_, SharedDbManager>,
    app_id: Option<String>,
    collection: String,
) -> Result<Vec<Record>, String> {
    let db = db_manager.get_db(&app_id.unwrap_or_default())?;
    let db_lock = db.lock().map_err(|e| e.to_string())?;
    db_lock
        .get_collection(&collection)
        .map_err(|e| e.to_string())
}

/// Get all collection names
#[tauri::command]
pub fn get_collections(
    db_manager: State<'_, SharedDbManager>,
    app_id: Option<String>,
) -> Result<Vec<String>, String> {
    let db = db_manager.get_db(&app_id.unwrap_or_default())?;
    let db_lock = db.lock().map_err(|e| e.to_string())?;
    db_lock.get_collections().map_err(|e| e.to_string())
}

/// LOCAL cache reset of a collection: nothing is replicated (audit XD-03).
/// Use `reset_collection` with scope "replicated" for a shared reset.
#[tauri::command]
pub fn clear_collection(
    db_manager: State<'_, SharedDbManager>,
    app_id: Option<String>,
    collection: String,
) -> Result<bool, String> {
    let app_id = app_id.unwrap_or_default();
    let db = db_manager.get_db(&app_id)?;
    let mut db_lock = db.lock().map_err(|e| e.to_string())?;
    db_lock
        .clear_collection(&collection)
        .map_err(|e| e.to_string())?;
    drop(db_lock);
    db_manager.emit_change(&app_id, "clear", Some(&collection));
    info!("Cleared collection {}", collection);
    Ok(true)
}

/// Get database statistics
#[tauri::command]
pub fn get_db_stats(
    db_manager: State<'_, SharedDbManager>,
    app_id: Option<String>,
) -> Result<DbStats, String> {
    let db = db_manager.get_db(&app_id.unwrap_or_default())?;
    let db_lock = db.lock().map_err(|e| e.to_string())?;
    db_lock.get_stats().map_err(|e| e.to_string())
}

/// Get network status (honest: enabled vs running vs paused, plus counters).
#[tauri::command]
pub async fn get_network_status(
    network: State<'_, SharedNetwork>,
    control: State<'_, SharedNetworkControl>,
) -> Result<NetworkStatus, String> {
    let settings = control.settings();
    let net = { network.lock().await.clone() };
    if let Some(net) = net.filter(NetworkNode::is_running) {
        let options = net.options();
        Ok(NetworkStatus {
            peer_id: net.local_peer_id(),
            connected_peers: net.get_connected_peers().await,
            is_running: true,
            mode: "trusted-lan".to_string(),
            enabled: settings.enabled,
            discovery: options.discovery,
            listening: options.listen,
            sync_paused: net.gate().is_paused(),
            pending_restore: control.pending_restore(),
            stats: net.stats(),
        })
    } else {
        Ok(NetworkStatus {
            peer_id: String::new(),
            connected_peers: vec![],
            is_running: false,
            mode: "local-only".to_string(),
            enabled: settings.enabled,
            discovery: false,
            listening: false,
            sync_paused: control.gate().is_paused(),
            pending_restore: control.pending_restore(),
            stats: SyncStats::default(),
        })
    }
}

/// The persisted networking choice.
#[tauri::command]
pub fn get_network_settings(control: State<'_, SharedNetworkControl>) -> Result<NetworkSettings, String> {
    Ok(control.settings())
}

/// Explicitly enable or disable peer networking (audit XD-01). The choice is
/// persisted; enabling starts discovery/listening now, disabling stops the
/// node and its listeners without touching local persistence.
#[tauri::command]
pub async fn set_network_enabled(
    app: AppHandle,
    network: State<'_, SharedNetwork>,
    control: State<'_, SharedNetworkControl>,
    enabled: bool,
    discovery: Option<bool>,
    listen: Option<bool>,
) -> Result<NetworkSettings, String> {
    let mut settings = control.settings();
    settings.enabled = enabled;
    if let Some(d) = discovery {
        settings.discovery = d;
    }
    if let Some(l) = listen {
        settings.listen = l;
    }
    settings.save(&control.base_dir)?;
    if let Ok(mut guard) = control.settings.lock() {
        *guard = settings;
    }

    // Stop whatever is running; restart only when enabled. The gate is the
    // control's, so an unresolved restore keeps synchronization paused across
    // this switch: enabling networking never implicitly accepts a merge.
    shutdown_xdb(&network).await;
    if enabled {
        init_network(
            app,
            control.default_db.clone(),
            network.inner().clone(),
            settings.options(),
            control.gate(),
        )
        .await
        .map_err(|e| e.to_string())?;
        info!("XDB peer networking enabled (trusted LAN)");
    } else {
        info!("XDB peer networking disabled; local persistence continues");
    }
    Ok(settings)
}

/// Resolve a pending restore: remove the durable record, lift the pause and
/// reconcile (R2-XD-01). For a `replace` restore whose reset plan was never
/// published (network was off), publish it first so peers adopt it.
#[tauri::command]
pub async fn resume_sync(
    network: State<'_, SharedNetwork>,
    control: State<'_, SharedNetworkControl>,
) -> Result<bool, String> {
    // Refused for an unreadable record or a restore interrupted before it was
    // applied (R3-XD-02): the record is the only journal, and clearing it
    // would abandon an unknown data state. `recover_restore` handles those.
    let net = { network.lock().await.clone() };
    let pending = control.resume_decision(net.is_some())?;
    publish_and_resolve(&control, net.as_ref(), pending.as_ref()).await?;
    if let Some(net) = net {
        net.reconcile().await?;
    }
    Ok(true)
}

/// Publish an applied `replace` plan (when a node is running) and resolve
/// the pending record. Publication hands the plan to GossipSub; it is not
/// proof that any peer adopted it, which the repair pass and epoch checks
/// establish afterwards.
async fn publish_and_resolve(
    control: &SharedNetworkControl,
    net: Option<&NetworkNode>,
    pending: Option<&PendingRestore>,
) -> Result<(), String> {
    if let Some(p) = pending {
        NetworkControl::publication_precondition(p, net.is_some())?;
        if let (true, Some(net)) = (p.scope == "replace" && p.phase() == "applied", net) {
            for (collection, epoch) in &p.reset_plan {
                net.broadcast_reset(collection, *epoch).await?;
            }
        }
    }
    control.resolve_restore()
}

/// Recover an interrupted or unreadable restore of the shared database
/// (R3-XD-02). `action`: `discard` (acknowledge a record that changed
/// nothing), `rollback` (restore the pre-restore backup), `complete`
/// (re-apply the journaled restore: snapshot and reset plan in one step, or
/// publish an applied one). The pause lifts only after the chosen step
/// completed; a failing step keeps the record and the pause.
#[tauri::command]
pub async fn recover_restore(
    db_manager: State<'_, SharedDbManager>,
    network: State<'_, SharedNetwork>,
    control: State<'_, SharedNetworkControl>,
    action: String,
) -> Result<RecoveryOutcome, String> {
    let step = control.recovery_plan(&action)?;
    let net = { network.lock().await.clone() };
    let result = match step {
        RecoveryStep::Discard => {
            control.resolve_restore()?;
            "discarded"
        }
        RecoveryStep::Rollback { app_id, backup } => {
            let db = db_manager.get_db(&app_id)?;
            {
                let mut db_lock = db.lock().map_err(|e| e.to_string())?;
                db_lock
                    .replace_from_file(&backup)
                    .map_err(|e| format!("Rollback failed; the record and pause are kept: {e}"))?;
            }
            db_manager.emit_change(&app_id, "import", None);
            control.resolve_restore()?;
            "rolled-back"
        }
        RecoveryStep::Complete { source, pending } => {
            let db = db_manager.get_db(&pending.app_id)?;
            {
                let mut db_lock = db.lock().map_err(|e| e.to_string())?;
                if pending.scope == "replace" {
                    db_lock
                        .apply_authoritative_restore(&source, &pending.reset_plan, "local-restore")
                        .map_err(|e| format!("Completing the restore failed; the record and pause are kept: {e}"))?;
                } else {
                    db_lock
                        .replace_from_file(&source)
                        .map_err(|e| format!("Completing the restore failed; the record and pause are kept: {e}"))?;
                }
                control.update_restore(PendingRestore { phase: "applied".into(), applied: true, ..pending.clone() })?;
            }
            db_manager.emit_change(&pending.app_id, "import", None);
            let applied = PendingRestore { phase: "applied".into(), applied: true, ..pending };
            match NetworkControl::publication_precondition(&applied, net.is_some()) {
                Ok(()) => {
                    publish_and_resolve(&control, net.as_ref(), Some(&applied)).await?;
                    "completed"
                }
                // Applied, but the plan cannot be published yet (R4-XD-01): the
                // record stays in the applied phase and the pause holds until
                // networking is on and resume_sync/complete publishes it.
                Err(_) => "applied-awaiting-publication",
            }
        }
        RecoveryStep::Publish { pending } => {
            NetworkControl::publication_precondition(&pending, net.is_some())?;
            publish_and_resolve(&control, net.as_ref(), Some(&pending)).await?;
            "published"
        }
    };
    if let Some(net) = &net {
        if !control.gate().is_paused() {
            net.reconcile().await?;
        }
    }
    Ok(RecoveryOutcome { action, result: result.to_string(), sync_paused: control.gate().is_paused() })
}

/// Announce local collections and request reconciliation for all of them now
/// (audit XD-02): what a join or repair pass does, on demand.
#[tauri::command]
pub async fn reconcile_network(network: State<'_, SharedNetwork>) -> Result<bool, String> {
    let net = { network.lock().await.clone() };
    match net {
        Some(net) => {
            net.reconcile().await?;
            Ok(true)
        }
        None => Err("Peer networking is disabled (local-only). Enable it explicitly to synchronize.".to_string()),
    }
}

/// Request sync from peers for a collection
#[tauri::command]
pub async fn request_sync(
    db_manager: State<'_, SharedDbManager>,
    network: State<'_, SharedNetwork>,
    app_id: Option<String>,
    collection: String,
) -> Result<bool, String> {
    let app_id = app_id.unwrap_or_default();
    if !supports_legacy_sync(&app_id) {
        return Err("Native P2P sync is only available for the default database; named apps require an app-scoped sync backend".to_string());
    }
    let db = db_manager.get_db(&app_id)?;
    let (state_vector, epoch) = {
        let mut db_lock = db.lock().map_err(|e| e.to_string())?;
        let sv = db_lock
            .get_state_vector(&collection)
            .map_err(|e| e.to_string())?;
        let epoch = db_lock.get_epoch(&collection).map_err(|e| e.to_string())?;
        (sv, epoch)
    };

    let net = { network.lock().await.clone() };
    if let Some(net) = net {
        if net.gate().is_paused() {
            return Err("Synchronization is paused after a local restore; resolve it with resume_sync first".to_string());
        }
        net.request_sync(&collection, epoch, state_vector)
            .await
            .map_err(|e| e.to_string())?;
        info!("Requested sync for collection: {}", collection);
        Ok(true)
    } else {
        Err("Peer networking is disabled (local-only). Enable it explicitly to synchronize.".to_string())
    }
}

/// Export database to a file
#[tauri::command]
pub async fn export_database(
    db_manager: State<'_, SharedDbManager>,
    app_id: Option<String>,
    path: String,
) -> Result<String, String> {
    let db = db_manager.get_db(&app_id.unwrap_or_default())?;
    let export_path = PathBuf::from(&path);

    // Canonicalize parent to resolve path traversal (e.g. ../../etc/passwd)
    let parent = export_path
        .parent()
        .ok_or("Invalid export path: no parent directory")?;
    if !parent.exists() {
        return Err(format!(
            "Export directory does not exist: {}",
            parent.display()
        ));
    }
    let _canonical = parent
        .canonicalize()
        .map_err(|e| format!("Invalid export path: {}", e))?;

    let db_lock = db.lock().map_err(|e| e.to_string())?;
    db_lock
        .export_to_file(&export_path)
        .map_err(|e| e.to_string())?;
    info!("Exported database to: {}", path);
    Ok(path)
}

/// Get the database file path for an app
#[tauri::command]
pub fn get_db_path(
    db_manager: State<'_, SharedDbManager>,
    app_id: Option<String>,
) -> Result<String, String> {
    let db = db_manager.get_db(&app_id.unwrap_or_default())?;
    let db_lock = db.lock().map_err(|e| e.to_string())?;
    Ok(db_lock.path().to_string_lossy().to_string())
}

/// Get the base directory where all app databases are stored
#[tauri::command]
pub fn get_db_base_dir(db_manager: State<'_, SharedDbManager>) -> Result<String, String> {
    Ok(db_manager
        .base_dir()
        .join("apps")
        .to_string_lossy()
        .to_string())
}

/// Import/restore a database file (audit XD-03). `scope` decides what the
/// restore MEANS for synchronized data:
/// - "local" (default): replace this node's data. On the synchronized default
///   database, synchronization is PAUSED until `resume_sync`, because a later
///   sync would otherwise silently merge peer state back over the restore.
/// - "fork": restore into a NEW isolated app namespace; nothing shared changes.
/// - "replace": replace this node's data AND make it authoritative for peers:
///   every collection's epoch advances and peers adopt the reset.
#[tauri::command]
pub async fn import_database(
    app: AppHandle,
    db_manager: State<'_, SharedDbManager>,
    network: State<'_, SharedNetwork>,
    control: State<'_, SharedNetworkControl>,
    app_id: Option<String>,
    source_path: String,
    scope: Option<String>,
) -> Result<ImportOutcome, String> {
    let requested_app = app_id.unwrap_or_default();
    let scope = scope.unwrap_or_else(|| "local".to_string());
    if !matches!(scope.as_str(), "local" | "fork" | "replace") {
        return Err(format!("Unknown import scope '{scope}' (local | fork | replace)"));
    }
    if control.pending_restore().is_some() && supports_legacy_sync(&requested_app) && scope != "fork" {
        return Err("A previous restore of the shared database is still unresolved; call resume_sync (or choose a scope for it) before restoring again".to_string());
    }
    let app_id = if scope == "fork" {
        allocate_fork_id(&db_manager, &requested_app)?
    } else {
        requested_app.clone()
    };
    let db = db_manager.get_db(&app_id)?;
    let source = PathBuf::from(&source_path);
    if !source.exists() {
        return Err("Source file does not exist".to_string());
    }

    // Canonicalize to resolve path traversal
    let source = source
        .canonicalize()
        .map_err(|e| format!("Invalid import path: {}", e))?;

    // Validate source database integrity before replacing
    let source_conn =
        rusqlite::Connection::open_with_flags(&source, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|e| format!("Invalid database file: {}", e))?;
    let integrity: String = source_conn
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|e| format!("Integrity check failed: {}", e))?;
    if integrity != "ok" {
        return Err(format!("Database integrity check failed: {}", integrity));
    }
    drop(source_conn);

    // Shared (default) database: the pending-restore record is written and
    // the pause established BEFORE any byte is replaced, whether or not a
    // network node is running now (R2-XD-01). A crash after this point leaves
    // the record, so startup re-establishes the pause.
    let shared = supports_legacy_sync(&app_id) && scope != "fork";
    let started_at = chrono::Utc::now().to_rfc3339();
    let journal = |phase: &str, applied: bool, backup: Option<&PathBuf>, plan: &crate::db::AuthoritativeRestorePlan| PendingRestore {
        app_id: sanitize_app_id(&app_id),
        scope: scope.clone(),
        started_at: started_at.clone(),
        applied,
        reset_plan: plan.plan.clone(),
        backup_path: backup.map(|b| b.to_string_lossy().to_string()),
        phase: phase.into(),
        prior_catalog: plan.prior.clone(),
        source_path: Some(source.to_string_lossy().to_string()),
        unreadable: None,
    };
    let no_plan = crate::db::AuthoritativeRestorePlan { prior: Vec::new(), plan: Vec::new() };
    if shared {
        control.begin_restore(journal("planned", false, None, &no_plan))?;
    }

    // Serialize import under the DB mutex to prevent concurrent writes. The
    // guard lives only inside this block: it must never be held across an
    // await (the network calls below), so the command future stays Send.
    // The network loop applies inbound updates under this same lock and only
    // while the gate is open, so nothing can apply across the replacement.
    let restored: Result<(Vec<(String, u64)>, PathBuf), String> = (|| {
        let mut db_lock = db.lock().map_err(|e| e.to_string())?;
        // Create backup of current database
        let backup_path = backup_database_for_import(&db_lock, &source)?;
        info!(
            "Saved pre-import database backup: {}",
            backup_path.display()
        );
        // Authoritative replacement (R2-XD-02/R3-XD-02): the plan is computed
        // over the union of both catalogs WITHOUT touching the live database,
        // journaled together with the backup and prior catalog, and only then
        // activated together with the restored data in one step.
        let planned = if scope == "replace" {
            db_lock
                .plan_authoritative_restore(&source)
                .map_err(|e| format!("Failed to plan the authoritative restore: {}", e))?
        } else {
            no_plan.clone()
        };
        if shared {
            control.update_restore(journal("planned", false, Some(&backup_path), &planned))?;
        }
        if scope == "replace" {
            db_lock
                .apply_authoritative_restore(&source, &planned.plan, "local-restore")
                .map_err(|e| format!("Failed to replace database after import: {}", e))?;
        } else {
            db_lock
                .replace_from_file(&source)
                .map_err(|e| format!("Failed to replace database after import: {}", e))?;
        }
        if shared {
            // Written under the database lock: nobody can observe the new
            // data before the journal says it is applied.
            control.update_restore(journal("applied", true, Some(&backup_path), &planned))?;
        }
        Ok((planned.plan, backup_path))
    })();
    let (reset_collections, _backup_path) = match restored {
        Ok(v) => v,
        Err(e) => {
            // The pending record stays in its journaled phase: the pause is
            // kept and recover_restore (rollback | complete) resolves it.
            return Err(e);
        }
    };
    db_manager.emit_change(&app_id, "import", None);
    info!("Imported database from: {} (scope {})", source_path, scope);

    let mut sync_paused = false;
    if shared {
        let net = { network.lock().await.clone() };
        match scope.as_str() {
            "local" => {
                // Stays paused — durably — until resume_sync, whether or not
                // networking is on now or is enabled later.
                sync_paused = true;
                warn!("Synchronization paused after a local restore; call resume_sync once the operator has chosen local/fork/replace");
            }
            "replace" => {
                match net {
                    Some(net) => {
                        // Publish only the COMMITTED plan, then resolve the pause.
                        for (collection, epoch) in &reset_collections {
                            net.broadcast_reset(collection, *epoch).await?;
                        }
                        control.resolve_restore()?;
                        net.reconcile().await?;
                    }
                    None => {
                        // Nothing to publish to yet: the plan stays pending and
                        // is published by resume_sync once networking is on.
                        sync_paused = true;
                    }
                }
            }
            _ => {}
        }
    }

    // Emit event to notify frontend to reload
    let _ = app.emit(
        "db-imported",
        serde_json::json!({ "app_id": sanitize_app_id(&app_id), "scope": scope, "sync_paused": sync_paused }),
    );

    Ok(ImportOutcome {
        app_id: sanitize_app_id(&app_id),
        scope,
        sync_paused,
        reset_collections: reset_collections.into_iter().map(|(c, _)| c).collect(),
    })
}

/// Setup network event listener that emits to frontend
fn setup_network_events(app: AppHandle, mut event_rx: broadcast::Receiver<NetworkEvent>) {
    tokio::spawn(async move {
        loop {
            match event_rx.recv().await {
                Ok(event) => match &event {
                    NetworkEvent::MessageReceived(msg) => match msg {
                        NetworkMessage::SyncUpdate { collection, .. } => {
                            let _ = app.emit(
                                "xdb-sync-event",
                                serde_json::json!({
                                    "type": "sync_update",
                                    "collection": collection
                                }),
                            );
                        }
                        NetworkMessage::SyncResponse { collection, .. } => {
                            let _ = app.emit(
                                "xdb-sync-event",
                                serde_json::json!({
                                    "type": "sync_response",
                                    "collection": collection
                                }),
                            );
                        }
                        NetworkMessage::CollectionReset { collection, epoch, .. } => {
                            let _ = app.emit(
                                "xdb-sync-event",
                                serde_json::json!({
                                    "type": "reset",
                                    "collection": collection,
                                    "epoch": epoch
                                }),
                            );
                        }
                        _ => {}
                    },
                    NetworkEvent::PeerConnected(peer) => {
                        let _ = app.emit(
                            "xdb-peer-event",
                            serde_json::json!({
                                "type": "connected",
                                "peer_id": peer.peer_id,
                                "addresses": peer.addresses
                            }),
                        );
                    }
                    NetworkEvent::PeerDisconnected(peer_id) => {
                        let _ = app.emit(
                            "xdb-peer-event",
                            serde_json::json!({
                                "type": "disconnected",
                                "peer_id": peer_id
                            }),
                        );
                    }
                },
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    error!("Event receiver lagged by {} messages", n);
                }
                Err(broadcast::error::RecvError::Closed) => {
                    info!("Event channel closed");
                    break;
                }
            }
        }
    });
}

/// Returns all XDB command handlers for use with `tauri::generate_handler!`
///
/// ## Example
///
/// ```rust,ignore
/// // In your lib.rs:
/// .invoke_handler(tauri::generate_handler![
///     xdb::tauri::create_record,
///     xdb::tauri::update_record,
///     xdb::tauri::delete_record,
///     xdb::tauri::get_record,
///     xdb::tauri::get_collection,
///     xdb::tauri::get_collections,
///     xdb::tauri::get_db_stats,
///     xdb::tauri::get_network_status,
///     xdb::tauri::request_sync,
///     xdb::tauri::export_database,
///     xdb::tauri::import_database,
///     xdb::tauri::get_db_path,
/// ])
/// ```
#[macro_export]
macro_rules! xdb_commands {
    () => {
        tauri::generate_handler![
            $crate::tauri::create_record,
            $crate::tauri::update_record,
            $crate::tauri::update_records,
            $crate::tauri::delete_record,
            $crate::tauri::upsert_record,
            $crate::tauri::get_record,
            $crate::tauri::get_collection,
            $crate::tauri::get_collections,
            $crate::tauri::clear_collection,
            $crate::tauri::reset_collection,
            $crate::tauri::import_records,
            $crate::tauri::get_db_stats,
            $crate::tauri::get_network_status,
            $crate::tauri::get_network_settings,
            $crate::tauri::set_network_enabled,
            $crate::tauri::resume_sync,
            $crate::tauri::recover_restore,
            $crate::tauri::reconcile_network,
            $crate::tauri::request_sync,
            $crate::tauri::export_database,
            $crate::tauri::import_database,
            $crate::tauri::get_db_path,
            $crate::tauri::get_db_base_dir,
        ]
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_app_aliases_share_one_database_instance() {
        let dir = tempfile::tempdir().unwrap();
        let manager = DbManager::new(dir.path().to_path_buf());
        let default = manager.get_db("").unwrap();
        assert!(Arc::ptr_eq(&default, &manager.get_db("_default").unwrap()));
        assert!(Arc::ptr_eq(&default, &manager.get_db("  ").unwrap()));
        assert_eq!(
            default.lock().unwrap().path(),
            &dir.path().join("apps/_default/data.sqlite")
        );
    }

    #[test]
    fn custom_default_path_is_used_by_commands_and_network() {
        let dir = tempfile::tempdir().unwrap();
        let custom_path = dir.path().join("custom.sqlite");
        let network_db = create_shared_db(custom_path.clone()).unwrap();
        let manager =
            DbManager::with_default_database(dir.path().to_path_buf(), network_db.clone()).unwrap();
        assert!(Arc::ptr_eq(&network_db, &manager.get_db("").unwrap()));
        assert_eq!(manager.get_app_path("_default"), custom_path);
        network_db
            .lock()
            .unwrap()
            .create_record("notes", serde_json::json!({"title": "Shared default"}))
            .unwrap();
        assert_eq!(
            manager
                .get_db("")
                .unwrap()
                .lock()
                .unwrap()
                .get_collection("notes")
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn named_apps_keep_independent_local_records() {
        let dir = tempfile::tempdir().unwrap();
        let manager = DbManager::new(dir.path().to_path_buf());
        let first = manager.get_db("first").unwrap();
        let second = manager.get_db("second").unwrap();
        first
            .lock()
            .unwrap()
            .create_record("notes", serde_json::json!({"title": "Only first"}))
            .unwrap();
        assert!(second
            .lock()
            .unwrap()
            .get_collection("notes")
            .unwrap()
            .is_empty());
        assert!(manager
            .get_db("")
            .unwrap()
            .lock()
            .unwrap()
            .get_collection("notes")
            .unwrap()
            .is_empty());
        assert!(!supports_legacy_sync("first"));
        assert!(!supports_legacy_sync("second"));
    }

    #[test]
    fn only_default_app_aliases_use_the_legacy_sync_protocol() {
        assert!(supports_legacy_sync(""));
        assert!(supports_legacy_sync("   "));
        assert!(supports_legacy_sync("_default"));
        assert!(!supports_legacy_sync("fieldnotes"));
        assert!(!supports_legacy_sync("bundle-123"));
    }

    #[test]
    fn network_settings_default_to_local_only_and_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let loaded = NetworkSettings::load(dir.path());
        assert_eq!(loaded, NetworkSettings::default());
        assert!(!loaded.enabled, "opening a database must never imply networking");

        let chosen = NetworkSettings {
            enabled: true,
            discovery: true,
            listen: false,
        };
        chosen.save(dir.path()).unwrap();
        assert_eq!(NetworkSettings::load(dir.path()), chosen);
        assert_eq!(
            chosen.options(),
            NetworkOptions {
                discovery: true,
                listen: false
            }
        );

        // Damaged settings fail closed (local-only), never open.
        std::fs::write(NetworkSettings::path(dir.path()), b"{not json").unwrap();
        assert!(!NetworkSettings::load(dir.path()).enabled);
        // Older files without the newer fields still parse; enabled stays explicit.
        std::fs::write(NetworkSettings::path(dir.path()), br#"{"enabled":true}"#).unwrap();
        let older = NetworkSettings::load(dir.path());
        assert!(older.enabled && older.discovery && older.listen);
    }

    #[test]
    fn network_control_starts_unpaused_with_the_persisted_settings() {
        let dir = tempfile::tempdir().unwrap();
        let db = create_shared_db(dir.path().join("data.sqlite")).unwrap();
        let control = NetworkControl::new(dir.path().to_path_buf(), NetworkSettings::default(), db);
        assert!(!control.settings().enabled);
        assert!(!control.gate().is_paused());
        control.gate().pause();
        assert!(control.gate().is_paused());
    }

    // ── R2-XD-01: the restore pause is durable and established before mutation ──

    #[test]
    fn pending_restore_survives_restart_and_holds_the_gate_until_resolved() {
        let dir = tempfile::tempdir().unwrap();
        let db = create_shared_db(dir.path().join("data.sqlite")).unwrap();
        let control = NetworkControl::new(dir.path().to_path_buf(), NetworkSettings::default(), db.clone());
        assert!(control.pending_restore().is_none());

        // begin_restore writes the record FIRST, then pauses.
        control
            .begin_restore(PendingRestore {
                app_id: "_default".into(),
                scope: "local".into(),
                started_at: "2026-09-14T00:00:00Z".into(),
                applied: false,
                reset_plan: vec![],
                backup_path: None,
                phase: "planned".into(),
                prior_catalog: vec![],
                source_path: None,
                unreadable: None,
            })
            .unwrap();
        assert!(control.gate().is_paused());
        assert!(PendingRestore::path(dir.path()).exists());

        // "Restart": a fresh control over the same directory loads the record
        // and starts PAUSED, before any network node could exist. Enabling
        // networking later shares this gate, so it cannot lift the pause.
        let restarted = NetworkControl::new(
            dir.path().to_path_buf(),
            NetworkSettings { enabled: true, discovery: true, listen: true },
            db.clone(),
        );
        assert!(restarted.gate().is_paused());
        assert_eq!(restarted.pending_restore().map(|p| p.scope), Some("local".to_string()));

        // Only the explicit resolution clears the record and lifts the pause.
        restarted.resolve_restore().unwrap();
        assert!(!restarted.gate().is_paused());
        assert!(!PendingRestore::path(dir.path()).exists());
        let again = NetworkControl::new(dir.path().to_path_buf(), NetworkSettings::default(), db.clone());
        assert!(!again.gate().is_paused());

        // An unreadable record is treated as pending, never as resolved, and
        // says why; it cannot be resumed, only discarded explicitly (R3-XD-01).
        std::fs::write(PendingRestore::path(dir.path()), b"{garbage").unwrap();
        let damaged = PendingRestore::load(dir.path()).unwrap();
        assert!(damaged.unreadable.as_deref().unwrap_or("").contains("cannot parse"));
        assert!(!damaged.is_resumable());
        let held = NetworkControl::new(dir.path().to_path_buf(), NetworkSettings::default(), db);
        assert!(held.gate().is_paused());
        assert!(held.resume_decision(true).unwrap_err().contains("cannot be read"));
    }

    // ── R3-XD-01: only a confirmed absent file means "no pending restore" ──

    #[test]
    fn pending_restore_read_failure_holds_synchronization_with_a_reason() {
        let dir = tempfile::tempdir().unwrap();
        let db = create_shared_db(dir.path().join("data.sqlite")).unwrap();
        assert!(PendingRestore::load(dir.path()).is_none(), "NotFound is the only absence");
        // A directory where the record belongs: fs::read fails with a non-NotFound error.
        std::fs::create_dir(PendingRestore::path(dir.path())).unwrap();
        let held = PendingRestore::load(dir.path()).expect("an unreadable record is pending");
        assert!(held.unreadable.as_deref().unwrap_or("").contains("cannot read"));
        assert!(!held.is_resumable());
        let control = NetworkControl::new(dir.path().to_path_buf(), NetworkSettings { enabled: true, discovery: true, listen: true }, db);
        assert!(control.gate().is_paused(), "unpaused synchronization must not start");
        let status_record = control.pending_restore().unwrap();
        assert!(status_record.unreadable.is_some(), "get_network_status can show the reason");
        assert!(control.resume_decision(true).is_err());
        // Only an explicit discard acknowledges it; rollback/complete have nothing to work from.
        assert!(control.recovery_plan("rollback").is_err());
        assert!(control.recovery_plan("complete").is_err());
        assert_eq!(control.recovery_plan("discard").unwrap(), RecoveryStep::Discard);
    }

    // ── R3-XD-02: resume refuses an interrupted restore; recovery is explicit ──

    #[test]
    fn an_applied_replace_restore_keeps_its_plan_pending_while_networking_is_off() {
        let dir = tempfile::tempdir().unwrap();
        let db = create_shared_db(dir.path().join("data.sqlite")).unwrap();
        let control = NetworkControl::new(dir.path().to_path_buf(), NetworkSettings::default(), db);
        let applied = PendingRestore {
            app_id: "_default".into(),
            scope: "replace".into(),
            started_at: "2026-09-15T00:00:00Z".into(),
            applied: true,
            reset_plan: vec![("notes".into(), 6), ("tasks".into(), 2)],
            backup_path: Some("data.db.backup".into()),
            phase: "applied".into(),
            prior_catalog: vec![("notes".into(), 5)],
            source_path: Some("snapshot.sqlite".into()),
            unreadable: None,
        };
        control.begin_restore(applied.clone()).unwrap();

        // No node: resume refuses, names the fix, keeps the record and the pause.
        let refusal = control.resume_decision(false).unwrap_err();
        assert!(refusal.contains("has not been published"), "{refusal}");
        assert!(refusal.contains("2 collection(s)"), "{refusal}");
        assert!(refusal.contains("set_network_enabled"), "{refusal}");
        assert!(control.gate().is_paused());
        assert_eq!(PendingRestore::load(dir.path()).unwrap().reset_plan, applied.reset_plan, "the plan is the journal");
        // The recovery route agrees: "complete" on an applied plan is a publish, and it needs a node too.
        assert_eq!(control.recovery_plan("complete").unwrap(), RecoveryStep::Publish { pending: applied.clone() });
        assert!(NetworkControl::publication_precondition(&applied, false).is_err());

        // A restart finds the same pending plan and starts paused.
        let db2 = create_shared_db(dir.path().join("data.sqlite")).unwrap();
        let restarted = NetworkControl::new(dir.path().to_path_buf(), NetworkSettings::default(), db2);
        assert!(restarted.gate().is_paused());
        assert_eq!(restarted.pending_restore().unwrap().reset_plan, applied.reset_plan);

        // With a node the same record may be published and resolved.
        assert_eq!(restarted.resume_decision(true).unwrap().unwrap().reset_plan, applied.reset_plan);

        // A local-scope restore carries no plan: its explicit resume needs no node.
        let local = PendingRestore { scope: "local".into(), reset_plan: vec![], ..applied.clone() };
        restarted.update_restore(local.clone()).unwrap();
        assert_eq!(restarted.resume_decision(false).unwrap().unwrap().scope, "local");
        assert!(NetworkControl::publication_precondition(&local, false).is_ok());
    }

    #[test]
    fn resume_refuses_a_restore_interrupted_before_it_was_applied() {
        let dir = tempfile::tempdir().unwrap();
        let db = create_shared_db(dir.path().join("data.sqlite")).unwrap();
        let control = NetworkControl::new(dir.path().to_path_buf(), NetworkSettings::default(), db);
        let planned = PendingRestore {
            app_id: "_default".into(),
            scope: "replace".into(),
            started_at: "2026-09-14T00:00:00Z".into(),
            applied: false,
            reset_plan: vec![("notes".into(), 6)],
            backup_path: Some("data.db.backup".into()),
            phase: "planned".into(),
            prior_catalog: vec![("notes".into(), 5)],
            source_path: Some("snapshot.sqlite".into()),
            unreadable: None,
        };
        control.begin_restore(planned.clone()).unwrap();
        let refusal = control.resume_decision(true).unwrap_err();
        assert!(refusal.contains("interrupted before it was applied"), "{refusal}");
        assert!(refusal.contains("data.db.backup"), "names the recovery source: {refusal}");
        assert!(control.gate().is_paused());
        assert!(PendingRestore::path(dir.path()).exists(), "the only journal is kept");
        // Recovery choices: a restore that may have touched data cannot be discarded.
        assert!(control.recovery_plan("discard").unwrap_err().contains("Refusing to discard"));
        assert_eq!(
            control.recovery_plan("rollback").unwrap(),
            RecoveryStep::Rollback { app_id: "_default".into(), backup: PathBuf::from("data.db.backup") }
        );
        assert_eq!(
            control.recovery_plan("complete").unwrap(),
            RecoveryStep::Complete { source: PathBuf::from("snapshot.sqlite"), pending: planned.clone() }
        );
        assert!(control.recovery_plan("frobnicate").is_err());

        // Journaled before any backup existed: nothing was changed, discard is honest.
        let untouched = PendingRestore { backup_path: None, ..planned.clone() };
        control.update_restore(untouched).unwrap();
        assert_eq!(control.recovery_plan("discard").unwrap(), RecoveryStep::Discard);
        assert_eq!(control.recovery_plan("rollback").unwrap(), RecoveryStep::Discard);

        // Applied: resumable, and "complete" means publish/resolve.
        let applied = PendingRestore { phase: "applied".into(), applied: true, ..planned.clone() };
        control.update_restore(applied.clone()).unwrap();
        assert_eq!(control.resume_decision(true).unwrap(), Some(applied.clone()));
        assert_eq!(control.recovery_plan("complete").unwrap(), RecoveryStep::Publish { pending: applied });

        // Records written before `phase` existed keep their meaning.
        let legacy: PendingRestore = serde_json::from_str(r#"{"app_id":"_default","scope":"local","started_at":"t","applied":true}"#).unwrap();
        assert_eq!(legacy.phase(), "applied");
        assert!(legacy.is_resumable());
        let legacy_planned: PendingRestore = serde_json::from_str(r#"{"app_id":"_default","scope":"local","started_at":"t"}"#).unwrap();
        assert_eq!(legacy_planned.phase(), "planned");
        assert!(!legacy_planned.is_resumable());
    }

    #[test]
    fn pending_restore_records_the_committed_reset_plan_for_republishing() {
        let dir = tempfile::tempdir().unwrap();
        let pending = PendingRestore {
            app_id: "_default".into(),
            scope: "replace".into(),
            started_at: "2026-09-14T00:00:00Z".into(),
            applied: true,
            reset_plan: vec![("notes".into(), 6), ("tasks".into(), 2)],
            backup_path: Some("x.db.backup".into()),
            phase: "applied".into(),
            prior_catalog: vec![("notes".into(), 5), ("tasks".into(), 1)],
            source_path: Some("snapshot.sqlite".into()),
            unreadable: None,
        };
        pending.save(dir.path()).unwrap();
        assert_eq!(PendingRestore::load(dir.path()).unwrap(), pending);
        PendingRestore::clear(dir.path()).unwrap();
        assert!(PendingRestore::load(dir.path()).is_none());
        PendingRestore::clear(dir.path()).unwrap();
    }

    // ── R2-XD-04: fork identities are unique and create-only ──

    #[test]
    fn fork_identities_are_distinct_within_one_second_and_never_reuse_an_existing_namespace() {
        let dir = tempfile::tempdir().unwrap();
        let manager = DbManager::new(dir.path().to_path_buf());
        let first = allocate_fork_id(&manager, "notes app").unwrap();
        let second = allocate_fork_id(&manager, "notes app").unwrap();
        assert_ne!(first, second);
        assert!(first.starts_with("notes_app-fork-"));
        // Neither exists yet: allocation is create-only and the caller creates it.
        assert!(!manager.get_app_path(&first).exists());
        // An identity that already exists on disk or is already open is never returned.
        manager.get_db(&first).unwrap();
        for _ in 0..20 {
            let next = allocate_fork_id(&manager, "notes app").unwrap();
            assert_ne!(next, first);
            assert!(!manager.get_app_path(&next).exists());
        }
    }

    // ── R3: fork destinations are reserved atomically ──

    #[test]
    fn fork_allocation_reserves_the_destination_and_retries_a_colliding_id() {
        let dir = tempfile::tempdir().unwrap();
        let manager = DbManager::new(dir.path().to_path_buf());
        // Deterministic collision: the id source repeats an id that is already reserved.
        let taken = allocate_fork_id_with(&manager, "notes", || "fixed".to_string()).unwrap();
        assert_eq!(taken, "notes-fork-fixed");
        assert!(manager.get_app_path(&taken).parent().unwrap().is_dir(), "reserved before the caller opens it");
        let mut ids = vec!["fresh", "fixed", "fixed"].into_iter();
        let next = allocate_fork_id_with(&manager, "notes", || ids.next_back().unwrap().to_string()).unwrap();
        assert_eq!(next, "notes-fork-fresh", "collisions are retried, never reused");
        assert!(manager.get_app_path(&next).parent().unwrap().is_dir());
        // An id source that never produces a free id fails instead of overwriting.
        assert!(allocate_fork_id_with(&manager, "notes", || "fixed".to_string()).is_err());
    }

    #[test]
    fn concurrent_fork_allocations_never_share_an_identity() {
        let dir = tempfile::tempdir().unwrap();
        let manager = std::sync::Arc::new(DbManager::new(dir.path().to_path_buf()));
        // Every thread walks the SAME id sequence, so they all race for the same
        // candidates; only the reservation decides who gets which.
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let manager = manager.clone();
                std::thread::spawn(move || {
                    let mut n = 0;
                    allocate_fork_id_with(&manager, "shared", move || {
                        n += 1;
                        format!("seq{n}")
                    })
                    .unwrap()
                })
            })
            .collect();
        let mut ids: Vec<String> = threads.into_iter().map(|t| t.join().unwrap()).collect();
        ids.sort();
        let mut unique = ids.clone();
        unique.dedup();
        assert_eq!(ids, unique, "every allocation got a distinct identity");
        for id in &ids {
            assert!(manager.get_app_path(id).parent().unwrap().is_dir(), "{id} is reserved on disk");
        }
    }

    #[test]
    fn restoring_the_last_backup_preserves_its_original_records() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("data.sqlite");
        let mut db = crate::db::XdbDatabase::open(db_path.clone()).unwrap();
        db.create_record("notes", serde_json::json!({"title": "Original"}))
            .unwrap();
        let source = db_path.with_extension("db.backup");
        db.export_to_file(&source).unwrap();
        let source = source.canonicalize().unwrap();
        db.create_record("notes", serde_json::json!({"title": "Added later"}))
            .unwrap();

        let backup = backup_database_for_import(&db, &source).unwrap();
        assert_ne!(backup.canonicalize().unwrap(), source);
        db.replace_from_file(&source).unwrap();
        assert_eq!(db.get_collection("notes").unwrap().len(), 1);
        let saved_current = crate::db::XdbDatabase::open(backup).unwrap();
        assert_eq!(saved_current.get_collection("notes").unwrap().len(), 2);
    }
}
