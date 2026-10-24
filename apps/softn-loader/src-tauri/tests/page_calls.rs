//! What a call from the page reaches, made the way the page makes it: an IPC message naming a
//! command and its arguments. The page that draws a bundle holds the IPC, and it holds every
//! other app's data id as soon as it has read the installation records, so naming one is easy.

use softn_loader_lib::data_identity::{bundle_digest, DataIdentity, Step};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, MockRuntime, INVOKE_KEY};
use tauri::Manager;

const APP_A: &str = "bundle-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

/// The runtime's data folder for one test, removed when the test ends, passed or failed.
///
/// On Windows a SQLite file cannot be deleted while a handle to it is open, so this is removed
/// only after the database manager holding them is gone (see `Page`'s `Drop`). It used to be
/// removed while they were open: the removal failed, and every run left one folder per test
/// behind. A worker thread can still be letting a database go just after the manager does, so
/// the removal is tried again for a second, as in apps/softn-host-rust's test_dirs.rs.
struct DataFolder(PathBuf);

impl Drop for DataFolder {
    fn drop(&mut self) {
        let deadline = Instant::now() + Duration::from_secs(1);
        while fs::remove_dir_all(&self.0).is_err() && self.0.exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(25));
        }
    }
}

/// Fields are dropped in the order they are declared, after `Drop::drop` below: the page and
/// the app, then the test's own handle on the database manager, and the folder the databases
/// are in after all of them.
struct Page {
    webview: tauri::WebviewWindow<MockRuntime>,
    app: tauri::App<MockRuntime>,
    manager: xdb::tauri::SharedDbManager,
    dir: DataFolder,
}

impl Drop for Page {
    fn drop(&mut self) {
        // Dropping the app does not drop its state. The mock runtime runs no event loop, so it
        // never reports the page's window destroyed, and the window and the app keep each other
        // alive until the process ends -- with them the database manager the app was given, and
        // every SQLite file it opened. So the manager is taken out of the state here, when the
        // test is over and nothing borrows it; the `manager` field is then its last handle.
        #[allow(deprecated)]
        drop(self.app.unmanage::<xdb::tauri::SharedDbManager>());
    }
}

impl Page {
    fn call(&self, cmd: &str, args: serde_json::Value) -> Result<serde_json::Value, serde_json::Value> {
        get_ipc_response(
            &self.webview,
            tauri::webview::InvokeRequest {
                cmd: cmd.into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: if cfg!(any(windows, target_os = "android")) { "http://tauri.localhost" } else { "tauri://localhost" }
                    .parse()
                    .unwrap(),
                body: tauri::ipc::InvokeBody::Json(args),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        )
        .map(|body| body.deserialize::<serde_json::Value>().unwrap())
    }

    fn notes_of(&self, app_id: &str) -> usize {
        self.manager.get_db(app_id).unwrap().lock().unwrap().get_collection("notes").unwrap().len()
    }

    /// The person opens a bundle (`file`, holding `bytes`), the page reads it and binds its own
    /// data. Returns its data id.
    fn open_own(&self, file: &str, bytes: &[u8]) -> String {
        let identity = self.app.state::<DataIdentity>();
        let path = self.dir.0.join(file);
        identity.bundle_chosen(&path);
        identity.bundle_read(&path, bytes);
        let digest = bundle_digest(bytes);
        assert!(matches!(identity.prepare_bind(&digest, &digest, None, None, true), Ok(Step::Settled(()))));
        digest
    }
}

/// A runtime whose data folder holds app A's notes, with the data commands the loader registers.
fn with_app_a_data(name: &str) -> Page {
    let dir = std::env::temp_dir().join(format!("softn-loader-page-{}-{}", name, std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let manager = Arc::new(xdb::tauri::DbManager::new(dir.clone()));
    manager
        .get_db(APP_A)
        .unwrap()
        .lock()
        .unwrap()
        .create_record("notes", serde_json::json!({ "text": "A's own note" }))
        .unwrap();
    let app = mock_builder()
        .manage(manager.clone())
        .manage(xdb::create_shared_network())
        .manage(DataIdentity::open(&dir))
        .invoke_handler(tauri::generate_handler![
            softn_loader_lib::scoped_xdb::get_collection,
            softn_loader_lib::scoped_xdb::get_collections,
            softn_loader_lib::scoped_xdb::clear_collection,
            softn_loader_lib::scoped_xdb::create_record,
            softn_loader_lib::scoped_xdb::delete_record,
            softn_loader_lib::scoped_xdb::import_records,
            softn_loader_lib::scoped_xdb::backup_database,
        ])
        .build(mock_context(noop_assets()))
        .unwrap();
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default()).build().unwrap();
    Page { webview, app, manager, dir: DataFolder(dir) }
}

/// App B is the app the person opened. Whatever runs in the page while B is open must not
/// read, change or delete what app A saved.
#[test]
fn a_page_call_naming_another_apps_data_does_not_reach_it() {
    let page = with_app_a_data("other-app");
    let b = page.open_own("b.softn", b"app B");
    let read = page.call("get_collection", serde_json::json!({ "appId": APP_A, "collection": "notes" }));
    let reached = read.as_ref().ok().and_then(|records| records.as_array()).map_or(0, |records| records.len());
    assert_eq!(reached, 0, "app B's page read app A's notes: {:?}", read);
    let _ = page.call("clear_collection", serde_json::json!({ "appId": APP_A, "collection": "notes" }));
    assert_eq!(page.notes_of(APP_A), 1, "app B's page deleted app A's notes");

    // Every other way in is refused the same way, and leaves A's data as it was.
    for (cmd, args) in [
        ("get_collections", serde_json::json!({ "appId": APP_A })),
        ("create_record", serde_json::json!({ "appId": APP_A, "payload": { "collection": "notes", "data": { "text": "planted" } } })),
        ("import_records", serde_json::json!({ "appId": APP_A, "batches": [{ "collection": "notes", "replace": true, "records": [] }] })),
        // No id at all is the shared default database, which is no bundle's.
        ("get_collections", serde_json::json!({})),
        ("create_record", serde_json::json!({ "payload": { "collection": "notes", "data": {} } })),
    ] {
        let outcome = page.call(cmd, args.clone());
        let refused = outcome.as_ref().err().and_then(|error| error.as_str()).is_some_and(|error| error.starts_with("Refused"));
        assert!(refused, "{} {} was answered: {:?}", cmd, args, outcome);
    }
    assert_eq!(page.notes_of(APP_A), 1);

    // B's own data works as before.
    page.call("create_record", serde_json::json!({ "appId": b, "payload": { "collection": "notes", "data": { "text": "B's note" } } }))
        .unwrap();
    let mine = page.call("get_collection", serde_json::json!({ "appId": b, "collection": "notes" })).unwrap();
    assert_eq!(mine.as_array().unwrap().len(), 1);
    assert_eq!(page.notes_of(APP_A), 1);
}

/// Opening another app ends the last one's reach: its calls are refused once the new app's
/// data is bound, instead of landing in the new app's data.
#[test]
fn the_app_open_before_is_refused_once_the_next_one_is_bound() {
    let page = with_app_a_data("next-app");
    let first = page.open_own("first.softn", b"first");
    page.call("create_record", serde_json::json!({ "appId": first, "payload": { "collection": "notes", "data": {} } }))
        .unwrap();
    let identity = page.app.state::<DataIdentity>();
    identity.bundle_chosen(&page.dir.0.join("second.softn"));
    // Chosen, not yet bound: the first app's last write still lands in its own data.
    page.call("create_record", serde_json::json!({ "appId": first, "payload": { "collection": "notes", "data": {} } }))
        .unwrap();
    let second = page.open_own("second.softn", b"second");
    assert!(page
        .call("create_record", serde_json::json!({ "appId": first, "payload": { "collection": "notes", "data": {} } }))
        .is_err());
    assert_eq!(page.notes_of(&first), 2);
    assert_eq!(page.notes_of(&second), 0);
}

/// A delete that names its collection deletes from that collection alone. Records are kept by
/// id across collections, and a removal heard in one collection (from a peer, or the sync
/// server) reached the record of another that had the id.
#[test]
fn a_delete_naming_a_collection_does_not_reach_another() {
    let page = with_app_a_data("delete-collection");
    let b = page.open_own("b.softn", b"app B");
    let kept = page
        .call("create_record", serde_json::json!({ "appId": b, "payload": { "collection": "private", "data": { "secret": 1 } } }))
        .unwrap();
    let id = kept["id"].as_str().unwrap().to_string();
    let private = |page: &Page| page.manager.get_db(&b).unwrap().lock().unwrap().get_collection("private").unwrap().len();

    let outcome = page.call("delete_record", serde_json::json!({ "appId": b, "id": id, "collection": "public" }));
    assert_eq!(outcome, Ok(serde_json::json!(false)));
    assert_eq!(private(&page), 1, "a delete in `public` removed a record of `private`");

    page.call("delete_record", serde_json::json!({ "appId": b, "id": id, "collection": "private" })).unwrap();
    assert_eq!(private(&page), 0);

    // A page from before names no collection, and deletes by id as it did.
    let other = page
        .call("create_record", serde_json::json!({ "appId": b, "payload": { "collection": "private", "data": {} } }))
        .unwrap();
    assert_eq!(page.call("delete_record", serde_json::json!({ "appId": b, "id": other["id"] })), Ok(serde_json::json!(true)));
    assert_eq!(private(&page), 0);
}

/// A snapshot is taken only of the data of the app open now.
#[test]
fn a_backup_is_only_of_the_app_open_now() {
    let page = with_app_a_data("backup");
    let b = page.open_own("b.softn", b"app B");
    assert!(page.call("backup_database", serde_json::json!({ "appId": APP_A })).is_err());
    let a_folder = page.manager.get_app_path(APP_A).parent().unwrap().to_path_buf();
    let snapshots = |folder: &Path| {
        fs::read_dir(folder)
            .map(|entries| entries.filter_map(|e| e.ok()).filter(|e| e.file_name().to_string_lossy().starts_with("pre-upgrade-")).count())
            .unwrap_or(0)
    };
    assert_eq!(snapshots(&a_folder), 0);
    let written = page.call("backup_database", serde_json::json!({ "appId": b })).unwrap();
    let written = PathBuf::from(written.as_str().unwrap());
    assert_eq!(written.parent().unwrap(), page.manager.get_app_path(&b).parent().unwrap());
    assert!(written.exists());
}
