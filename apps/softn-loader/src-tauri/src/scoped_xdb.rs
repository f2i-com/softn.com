//! XDB's data commands, held to the app the person opened.
//!
//! Each is XDB's own command (xdb::tauri) with one step in front: the app id the page names
//! must be the one data_identity.rs bound for the bundle open now, or the call is refused.
//! Registered from XDB directly, the page's `appId` decided whose data a call reached, and
//! the page can name any installed app's id. The pre-upgrade snapshot is taken here too;
//! its restore (`restore_database` in lib.rs) is held to the same app.

use crate::data_identity::DataIdentity;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::LazyLock;
use tauri::State;
use xdb::tauri::{
    CreateRecordPayload, NetworkStatus, PendingRestore, RecoveryOutcome, SharedDbManager,
    SharedNetworkControl, SharedNetworkState, UpdateRecordPayload,
};
use xdb::{CollectionImport, DbStats, ImportSummary, Record};

static BACKUP_SEQ: AtomicU64 = AtomicU64::new(0);
static BACKUP_LOCK: LazyLock<tauri::async_runtime::Mutex<()>> =
    LazyLock::new(|| tauri::async_runtime::Mutex::new(()));

#[tauri::command]
pub async fn create_record(
    db_manager: State<'_, SharedDbManager>,
    network: State<'_, SharedNetworkState>,
    identity: State<'_, DataIdentity>,
    app_id: Option<String>,
    payload: CreateRecordPayload,
) -> Result<Record, String> {
    let app_id = identity.require(app_id.as_deref())?;
    xdb::tauri::create_record(db_manager, network, Some(app_id), payload).await
}

#[tauri::command]
pub async fn update_record(
    db_manager: State<'_, SharedDbManager>,
    network: State<'_, SharedNetworkState>,
    identity: State<'_, DataIdentity>,
    app_id: Option<String>,
    payload: UpdateRecordPayload,
) -> Result<Record, String> {
    let app_id = identity.require(app_id.as_deref())?;
    xdb::tauri::update_record(db_manager, network, Some(app_id), payload).await
}

#[tauri::command]
pub async fn update_records(
    db_manager: State<'_, SharedDbManager>,
    network: State<'_, SharedNetworkState>,
    identity: State<'_, DataIdentity>,
    app_id: Option<String>,
    updates: Vec<UpdateRecordPayload>,
) -> Result<Vec<Record>, String> {
    let app_id = identity.require(app_id.as_deref())?;
    xdb::tauri::update_records(db_manager, network, Some(app_id), updates).await
}

#[tauri::command]
pub async fn delete_record(
    db_manager: State<'_, SharedDbManager>,
    network: State<'_, SharedNetworkState>,
    identity: State<'_, DataIdentity>,
    app_id: Option<String>,
    id: String,
    collection: Option<String>,
    updated_at: Option<String>,
) -> Result<bool, String> {
    let app_id = identity.require(app_id.as_deref())?;
    xdb::tauri::delete_record(db_manager, network, Some(app_id), id, collection, updated_at).await
}

#[tauri::command]
pub async fn remove_records(
    db_manager: State<'_, SharedDbManager>,
    network: State<'_, SharedNetworkState>,
    identity: State<'_, DataIdentity>,
    app_id: Option<String>,
    collection: String,
    ids: Vec<String>,
) -> Result<Vec<String>, String> {
    let app_id = identity.require(app_id.as_deref())?;
    xdb::tauri::remove_records(db_manager, network, Some(app_id), collection, ids).await
}

#[tauri::command]
pub async fn upsert_record(
    db_manager: State<'_, SharedDbManager>,
    network: State<'_, SharedNetworkState>,
    identity: State<'_, DataIdentity>,
    app_id: Option<String>,
    record: Record,
) -> Result<Record, String> {
    let app_id = identity.require(app_id.as_deref())?;
    xdb::tauri::upsert_record(db_manager, network, Some(app_id), record).await
}

#[tauri::command]
pub async fn upsert_records(
    db_manager: State<'_, SharedDbManager>,
    network: State<'_, SharedNetworkState>,
    identity: State<'_, DataIdentity>,
    app_id: Option<String>,
    records: Vec<Record>,
) -> Result<Vec<String>, String> {
    let app_id = identity.require(app_id.as_deref())?;
    xdb::tauri::upsert_records(db_manager, network, Some(app_id), records).await
}

#[tauri::command]
pub async fn import_records(
    db_manager: State<'_, SharedDbManager>,
    network: State<'_, SharedNetworkState>,
    identity: State<'_, DataIdentity>,
    app_id: Option<String>,
    batches: Vec<CollectionImport>,
) -> Result<ImportSummary, String> {
    let app_id = identity.require(app_id.as_deref())?;
    xdb::tauri::import_records(db_manager, network, Some(app_id), batches).await
}

#[tauri::command]
pub async fn reset_collection(
    db_manager: State<'_, SharedDbManager>,
    network: State<'_, SharedNetworkState>,
    identity: State<'_, DataIdentity>,
    app_id: Option<String>,
    collection: String,
    scope: Option<String>,
) -> Result<u64, String> {
    let app_id = identity.require(app_id.as_deref())?;
    xdb::tauri::reset_collection(db_manager, network, Some(app_id), collection, scope).await
}

#[tauri::command]
pub async fn request_sync(
    db_manager: State<'_, SharedDbManager>,
    network: State<'_, SharedNetworkState>,
    identity: State<'_, DataIdentity>,
    app_id: Option<String>,
    collection: String,
) -> Result<bool, String> {
    let app_id = identity.require(app_id.as_deref())?;
    xdb::tauri::request_sync(db_manager, network, Some(app_id), collection).await
}

#[tauri::command]
pub fn get_record(
    db_manager: State<'_, SharedDbManager>,
    identity: State<'_, DataIdentity>,
    app_id: Option<String>,
    id: String,
) -> Result<Record, String> {
    let app_id = identity.require(app_id.as_deref())?;
    xdb::tauri::get_record(db_manager, Some(app_id), id)
}

#[tauri::command]
pub fn get_collection(
    db_manager: State<'_, SharedDbManager>,
    identity: State<'_, DataIdentity>,
    app_id: Option<String>,
    collection: String,
    include_deleted: Option<bool>,
) -> Result<Vec<Record>, String> {
    let app_id = identity.require(app_id.as_deref())?;
    xdb::tauri::get_collection(db_manager, Some(app_id), collection, include_deleted)
}

#[tauri::command]
pub fn get_collections(
    db_manager: State<'_, SharedDbManager>,
    identity: State<'_, DataIdentity>,
    app_id: Option<String>,
) -> Result<Vec<String>, String> {
    let app_id = identity.require(app_id.as_deref())?;
    xdb::tauri::get_collections(db_manager, Some(app_id))
}

#[tauri::command]
pub fn clear_collection(
    db_manager: State<'_, SharedDbManager>,
    identity: State<'_, DataIdentity>,
    app_id: Option<String>,
    collection: String,
) -> Result<bool, String> {
    let app_id = identity.require(app_id.as_deref())?;
    xdb::tauri::clear_collection(db_manager, Some(app_id), collection)
}

#[tauri::command]
pub fn get_db_stats(
    db_manager: State<'_, SharedDbManager>,
    identity: State<'_, DataIdentity>,
    app_id: Option<String>,
) -> Result<DbStats, String> {
    let app_id = identity.require(app_id.as_deref())?;
    xdb::tauri::get_db_stats(db_manager, Some(app_id))
}

/// Snapshot an app's database beside itself before an upgrade and return only
/// the opaque snapshot filename (never a full OS path). Wraps XDB's export so
/// the webview never learns or chooses a file system path: the location is
/// always the database's own directory. Only the data of the app open now
/// (data_identity.rs) can be snapshotted, and only while the snapshot leaves
/// room on the disk (disk.rs).
#[tauri::command]
pub async fn backup_database(
    db_manager: State<'_, SharedDbManager>,
    identity: State<'_, DataIdentity>,
    app_id: Option<String>,
) -> Result<String, String> {
    let _backup_guard = BACKUP_LOCK.lock().await;
    let app_id = Some(identity.require(app_id.as_deref())?);
    let db_path = std::path::PathBuf::from(xdb::tauri::get_db_path(db_manager.clone(), app_id.clone())?);
    let directory = db_path
        .parent()
        .ok_or("The database has no parent directory")?;
    let size = crate::disk::database_size(&db_path).map_err(|e| format!("the database's size could not be read: {}", e))?;
    let free = crate::disk::free_bytes(directory).map_err(|e| format!("the free space on the database's disk could not be read: {}", e))?;
    if let Some(refusal) = crate::disk::snapshot_refusal(free, size) {
        return Err(refusal);
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let seq = BACKUP_SEQ.fetch_add(1, Ordering::Relaxed);
    let filename = format!("pre-upgrade-{:x}-{}.sqlite", stamp, seq);
    let target = directory.join(&filename);
    xdb::tauri::export_database(db_manager, app_id, target.to_string_lossy().to_string()).await?;
    Ok(filename)
}

/// Redact an OS path to its basename so directory structures and usernames are
/// never disclosed to the webview.
fn redact_path(path: Option<String>) -> Option<String> {
    path.and_then(|raw| {
        Path::new(&raw)
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
    })
}

/// Strip the database base directory (and any embedded pending-restore paths) from
/// error messages returned to the webview so local filesystem layout stays private.
fn sanitize_error_paths(mut message: String, base_dir: &Path, control: &SharedNetworkControl) -> String {
    let base = base_dir.to_string_lossy();
    if !base.is_empty() {
        message = message.replace(base.as_ref(), "<data>");
    }
    if let Ok(canon) = std::fs::canonicalize(base_dir) {
        let canon_str = canon.to_string_lossy();
        if !canon_str.is_empty() {
            message = message.replace(canon_str.as_ref(), "<data>");
        }
    }
    if let Some(pending) = control.pending_restore() {
        if let Some(backup) = pending.backup_path.as_deref() {
            let redacted = redact_path(Some(backup.to_string())).unwrap_or_else(|| "<backup>".to_string());
            message = message.replace(backup, &redacted);
        }
        if let Some(source) = pending.source_path.as_deref() {
            let redacted = redact_path(Some(source.to_string())).unwrap_or_else(|| "<snapshot>".to_string());
            message = message.replace(source, &redacted);
        }
        if let Some(reason) = pending.unreadable.as_deref() {
            message = message.replace(reason, "pending-restore record is unreadable");
        }
    }
    message
}

/// The id XDB gives the shared database: the only one it journals a restore for, and the id
/// it puts on a record it could not read (`xdb::tauri::PendingRestore`).
const SHARED_DATABASE: &str = "_default";

/// Whether the app open now may see and resolve `pending`.
///
/// Only a readable record that names an app's own database is kept to that app. No bundle is
/// bound to the shared database, so a record held to the bound app's id could be neither
/// shown nor cleared when it was one XDB could not read, or one a restore of the shared
/// database left behind: a truncated `pending-restore.json` kept synchronization paused for
/// good, with nothing to say why. XDB shows an unreadable record in the status and lets it
/// be acknowledged with `recover_restore` "discard" and nothing else, which changes no data.
fn pending_restore_is_reachable(pending: &PendingRestore, bound: Option<&str>) -> bool {
    pending.unreadable.is_some() || pending.app_id == SHARED_DATABASE || bound == Some(pending.app_id.as_str())
}

/// Network status with OS paths inside `pending_restore` redacted to basenames
/// and any pending restore belonging to another app hidden from the open bundle.
#[tauri::command]
pub async fn get_network_status(
    network: State<'_, SharedNetworkState>,
    control: State<'_, SharedNetworkControl>,
    identity: State<'_, DataIdentity>,
) -> Result<NetworkStatus, String> {
    let mut status = xdb::tauri::get_network_status(network, control).await?;
    status.pending_restore = shown_pending_restore(status.pending_restore.take(), identity.bound().as_deref());
    Ok(status)
}

/// A pending restore as the page is shown it: not at all when it is another app's, and
/// otherwise with its OS paths cut to their names and the reason it is unreadable, which
/// holds one, left out.
fn shown_pending_restore(pending: Option<PendingRestore>, bound: Option<&str>) -> Option<PendingRestore> {
    let mut pending = pending.filter(|pending| pending_restore_is_reachable(pending, bound))?;
    pending.backup_path = redact_path(pending.backup_path.take());
    pending.source_path = redact_path(pending.source_path.take());
    if pending.unreadable.is_some() {
        pending.unreadable = Some("pending-restore record is unreadable".to_string());
    }
    Some(pending)
}

fn require_pending_restore_owner(
    control: &SharedNetworkControl,
    identity: &DataIdentity,
) -> Result<(), String> {
    if !identity.open_started() {
        return Err("Refused: no app is open".to_string());
    }
    let bound = identity.bound();
    if let Some(pending) = control.pending_restore() {
        if !pending_restore_is_reachable(&pending, bound.as_deref()) {
            return Err("Refused: pending restore belongs to another app".to_string());
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn resume_sync(
    db_manager: State<'_, SharedDbManager>,
    network: State<'_, SharedNetworkState>,
    control: State<'_, SharedNetworkControl>,
    identity: State<'_, DataIdentity>,
) -> Result<bool, String> {
    require_pending_restore_owner(&control, &identity)?;
    let base_dir = db_manager.base_dir().clone();
    let control_ref = control.inner().clone();
    xdb::tauri::resume_sync(network, control)
        .await
        .map_err(|err| sanitize_error_paths(err, &base_dir, &control_ref))
}

#[tauri::command]
pub async fn recover_restore(
    db_manager: State<'_, SharedDbManager>,
    network: State<'_, SharedNetworkState>,
    control: State<'_, SharedNetworkControl>,
    identity: State<'_, DataIdentity>,
    action: String,
) -> Result<RecoveryOutcome, String> {
    require_pending_restore_owner(&control, &identity)?;
    let base_dir = db_manager.base_dir().clone();
    let control_ref = control.inner().clone();
    xdb::tauri::recover_restore(db_manager, network, control, action)
        .await
        .map_err(|err| sanitize_error_paths(err, &base_dir, &control_ref))
}

#[tauri::command]
pub async fn reconcile_network(
    network: State<'_, SharedNetworkState>,
    identity: State<'_, DataIdentity>,
) -> Result<bool, String> {
    if !identity.open_started() {
        return Err("Refused: no app is open".to_string());
    }
    xdb::tauri::reconcile_network(network).await
}

#[cfg(test)]
mod tests {
    //! A restore XDB left pending, as these commands decide who may see and resolve it.
    //! No app is built here, not even a mock one: on Windows a test executable of this
    //! library that builds one does not start (build.rs gives the manifest it would need to
    //! the tests in tests/ only), so the commands' rules are called without their `State`.
    use super::*;
    use crate::data_identity::{bundle_digest, Step};
    use std::path::PathBuf;
    use std::sync::Arc;
    use xdb::tauri::RecoveryStep;

    const APP: &[u8] = b"the app open now";

    /// Removed when the test ends, after the database opened in it has been let go.
    struct Folder(PathBuf);
    impl Drop for Folder {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// A runtime started on a data folder that holds `record` as its `pending-restore.json`.
    /// Fields are dropped in the order they are declared: the folder last.
    struct Runtime {
        control: SharedNetworkControl,
        identity: DataIdentity,
        dir: Folder,
    }

    impl Runtime {
        fn starting_with(name: &str, record: &str) -> Runtime {
            let dir = std::env::temp_dir().join(format!("softn-loader-pending-{}-{}", name, std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(dir.join("apps").join(SHARED_DATABASE)).unwrap();
            std::fs::write(PendingRestore::path(&dir), record).unwrap();
            let shared = xdb::create_shared_db(dir.join("apps").join(SHARED_DATABASE).join("data.sqlite")).unwrap();
            let control = Arc::new(xdb::NetworkControl::new(dir.clone(), xdb::NetworkSettings::default(), shared));
            Runtime { control, identity: DataIdentity::open(&dir), dir: Folder(dir) }
        }

        /// The person opens the app and it starts on its own data.
        fn open_app(&self) {
            let path = self.dir.0.join("app.softn");
            self.identity.bundle_chosen(&path);
            self.identity.bundle_read(&path, APP);
            let digest = bundle_digest(APP);
            assert!(matches!(self.identity.prepare_bind(&digest, &digest, None, None, true), Ok(Step::Settled(()))));
        }

        /// What `resume_sync` and `recover_restore` ask before they do anything.
        fn may_resolve(&self) -> Result<(), String> {
            require_pending_restore_owner(&self.control, &self.identity)
        }

        /// What `get_network_status` shows of the record.
        fn shown(&self) -> Option<PendingRestore> {
            shown_pending_restore(self.control.pending_restore(), self.identity.bound().as_deref())
        }

        fn record_is_kept(&self) -> bool {
            PendingRestore::path(&self.dir.0).exists()
        }
    }

    fn record(app_id: &str, backup: Option<&std::path::Path>) -> String {
        serde_json::json!({
            "app_id": app_id, "scope": "local", "started_at": "2026-01-01T00:00:00Z", "applied": true,
            "backup_path": backup.map(|path| path.to_string_lossy()),
        })
        .to_string()
    }

    /// A record cut short as it was written holds synchronization, as XDB means it to, and
    /// XDB's way out of it is open: the status shows it and "discard" acknowledges it. It was
    /// hidden and every way of resolving it refused, since no bundle is bound to the shared
    /// database's id, which XDB puts on a record it cannot read.
    #[test]
    fn an_unreadable_pending_restore_is_shown_and_can_be_discarded() {
        let runtime = Runtime::starting_with("unreadable", r#"{"app_id":"_default","scope":"loc"#);
        assert!(runtime.control.gate().is_paused());
        // Nobody resolves anything before an app is open.
        assert_eq!(runtime.may_resolve().unwrap_err(), "Refused: no app is open");
        runtime.open_app();
        assert_eq!(runtime.may_resolve(), Ok(()));

        // Shown, without the reason XDB gives, which names the data folder.
        let folder = runtime.dir.0.to_string_lossy().into_owned();
        assert!(runtime.control.pending_restore().unwrap().unreadable.unwrap().contains(&folder));
        let shown = runtime.shown().expect("the record is in the status");
        assert_eq!(shown.unreadable.as_deref(), Some("pending-restore record is unreadable"));

        // XDB's own rules are what is left: such a record is not resumed, rolled back or
        // completed, and its refusal reaches the page without the folder's path.
        let refusal = runtime.control.resume_decision(false).unwrap_err();
        let said = sanitize_error_paths(refusal, &runtime.dir.0, &runtime.control);
        assert!(said.contains("cannot be read") && !said.contains(&folder), "{said}");
        assert!(runtime.control.recovery_plan("rollback").is_err());
        assert!(runtime.control.recovery_plan("complete").is_err());
        assert_eq!(runtime.control.recovery_plan("discard"), Ok(RecoveryStep::Discard));
        runtime.control.resolve_restore().unwrap();
        assert!(!runtime.record_is_kept() && !runtime.control.gate().is_paused());
        assert_eq!(runtime.shown(), None);
    }

    /// A restore of the shared database that an earlier version left unresolved is the
    /// runtime's own, not another app's: it is shown, paths cut to their names, and resumed.
    #[test]
    fn a_restore_of_the_shared_database_is_shown_and_can_be_resumed() {
        let backup = std::env::temp_dir().join("softn-loader-pending-elsewhere").join("data.sqlite.backup");
        let runtime = Runtime::starting_with("shared", &record(SHARED_DATABASE, Some(&backup)));
        runtime.open_app();
        assert_eq!(runtime.may_resolve(), Ok(()));
        let shown = runtime.shown().expect("the record is in the status");
        assert_eq!((shown.app_id.as_str(), shown.backup_path.as_deref()), (SHARED_DATABASE, Some("data.sqlite.backup")));
        assert!(runtime.control.resume_decision(false).unwrap().is_some());
    }

    /// A readable record that names an app's own database stays that app's: hidden from any
    /// other, which can neither resume it nor recover it.
    #[test]
    fn a_restore_of_an_apps_own_database_is_kept_to_that_app() {
        let other = format!("bundle-{}", "b".repeat(64));
        let runtime = Runtime::starting_with("other-app", &record(&other, None));
        runtime.open_app();
        assert_eq!(runtime.may_resolve().unwrap_err(), "Refused: pending restore belongs to another app");
        assert_eq!(runtime.shown(), None);
        assert!(runtime.record_is_kept() && runtime.control.gate().is_paused());

        let runtime = Runtime::starting_with("own-app", &record(&bundle_digest(APP), None));
        runtime.open_app();
        assert_eq!(runtime.may_resolve(), Ok(()));
        assert_eq!(runtime.shown().map(|shown| shown.app_id), Some(bundle_digest(APP)));
    }
}
