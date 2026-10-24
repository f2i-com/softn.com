//! XDB's data commands, held to the app the person opened.
//!
//! Each is XDB's own command (xdb::tauri) with one step in front: the app id the page names
//! must be the one data_identity.rs bound for the bundle open now, or the call is refused.
//! Registered from XDB directly, the page's `appId` decided whose data a call reached, and
//! the page can name any installed app's id. The pre-upgrade snapshot is taken here too;
//! its restore (`restore_database` in lib.rs) is held to the same app.

use crate::data_identity::DataIdentity;
use tauri::State;
use xdb::tauri::{CreateRecordPayload, SharedDbManager, SharedNetworkState, UpdateRecordPayload};
use xdb::{CollectionImport, DbStats, ImportSummary, Record};

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
) -> Result<bool, String> {
    let app_id = identity.require(app_id.as_deref())?;
    xdb::tauri::delete_record(db_manager, network, Some(app_id), id, collection).await
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
) -> Result<Vec<Record>, String> {
    let app_id = identity.require(app_id.as_deref())?;
    xdb::tauri::get_collection(db_manager, Some(app_id), collection)
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

/// Snapshot an app's database beside itself before an upgrade and return the
/// snapshot's path. Wraps XDB's export so the webview never learns or chooses
/// a file system path: the location is always the database's own directory.
/// Only the data of the app open now (data_identity.rs) can be snapshotted.
#[tauri::command]
pub async fn backup_database(
    db_manager: State<'_, SharedDbManager>,
    identity: State<'_, DataIdentity>,
    app_id: Option<String>,
) -> Result<String, String> {
    let app_id = Some(identity.require(app_id.as_deref())?);
    let db_path = std::path::PathBuf::from(xdb::tauri::get_db_path(db_manager.clone(), app_id.clone())?);
    let directory = db_path
        .parent()
        .ok_or("The database has no parent directory")?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let target = directory.join(format!("pre-upgrade-{:x}.sqlite", stamp));
    xdb::tauri::export_database(db_manager, app_id, target.to_string_lossy().to_string()).await
}
