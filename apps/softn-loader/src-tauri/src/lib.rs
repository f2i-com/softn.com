//! SoftN Loader - Application Runtime
//!
//! This is the Rust backend for the SoftN application runtime.
//! Handles file opening and .softn bundle loading.
//! Integrates XDB for local persistence; peer sync across the local network is an explicit opt-in.

use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
#[cfg(desktop)]
use image::GenericImageView;
use tauri::{Emitter, Manager, State};
#[cfg(desktop)]
use tauri::image::Image;
#[cfg(desktop)]
use tauri_plugin_cli::CliExt;
use tauri_plugin_dialog::DialogExt;
use tracing::info;

mod consent;
pub mod data_identity;
mod net;
pub mod scoped_xdb;

use data_identity::DataIdentity;

/// State for the opened file path
struct OpenedFile {
    path: Mutex<Option<String>>,
}

/// The files this process may read as bundles: exactly those the person
/// running it chose — on the command line or by double-click, in the file
/// picker this side opens, or by dropping onto the window. `read_softn_bundle`
/// refuses anything else. The webview is trusted with the app it shows, not
/// with the disk: a script that got into the page (a renderer bug; bundle
/// logic itself runs in ZIPP) still cannot walk the file system for other
/// `.softn` files, because every path it could name is one the user already
/// opened here.
#[derive(Default)]
struct OpenableFiles {
    paths: Mutex<HashSet<PathBuf>>,
}

/// One spelling per file, so `..`, symlinks and case differences on Windows
/// do not make two names for one allowance.
fn canonical(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// Whether looking `path` up on disk stays on this machine's own drives. On Windows a path
/// may name another machine (`\\host\share\...`, in any of its spellings) or a device, and
/// merely resolving one makes Windows connect and sign in to that host.
fn is_on_this_machine(path: &Path) -> bool {
    #[cfg(windows)]
    {
        use std::path::{Component, Prefix};
        let mut components = path.components();
        match components.next() {
            Some(Component::Prefix(prefix)) => {
                matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_))
            }
            // `\??\` is Windows's own namespace, which it takes as written: `\??\UNC\host\share`
            // is a share on another machine, where Rust reads a folder `??` at the root.
            Some(Component::RootDir) => {
                components.next() != Some(Component::Normal(std::ffi::OsStr::new("??")))
            }
            _ => true,
        }
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        true
    }
}

impl OpenableFiles {
    /// Record a file the user chose, under the path it was chosen by and under the one
    /// spelling of the file on disk.
    fn allow(&self, path: &Path) {
        if let Ok(mut set) = self.paths.lock() {
            set.insert(path.to_path_buf());
            set.insert(canonical(path));
        }
    }

    /// `path` is whatever the page sent. A path exactly as the user chose it is permitted as
    /// written. Any other is looked up on disk to find which file it names, and only when
    /// that look stays on this machine: the page does not get to make this process reach
    /// for a host of its choosing.
    fn permits(&self, path: &Path) -> bool {
        let Ok(set) = self.paths.lock() else {
            return false;
        };
        set.contains(path) || (is_on_this_machine(path) && set.contains(&canonical(path)))
    }
}

/// The person chose `path` (the picker, a drop, the command line, a file opened from the
/// file manager, a second launch): the webview may read it, and it is the app open now for
/// the consent questions and for whose data the page may use.
fn bundle_chosen(app: &tauri::AppHandle, path: &Path) {
    if let Some(files) = app.try_state::<OpenableFiles>() {
        files.allow(path);
    }
    if let Some(consent) = app.try_state::<consent::Consent>() {
        consent.bundle_opened(path);
    }
    if let Some(identity) = app.try_state::<DataIdentity>() {
        identity.bundle_chosen(path);
    }
}

/// Record a bundle the user opened from outside the window (CLI, file
/// association, second instance) so the webview may read it.
fn remember_opened(app: &tauri::AppHandle, path: &str) {
    bundle_chosen(app, Path::new(path));
}

/// The largest icon a bundle may hand the window: a 1 MiB file and, after
/// decoding, 1024 px on a side. `image` reads the header first, so an
/// oversized PNG is refused before its pixels are allocated.
#[cfg(desktop)]
const ICON_MAX_BYTES: usize = 1024 * 1024;
#[cfg(desktop)]
const ICON_MAX_SIDE: u32 = 1024;

/// Event emitted when a file is opened via CLI/double-click
#[derive(Clone, Serialize)]
struct FileOpenedEvent {
    path: String,
}

fn is_softn_path(path: &str) -> bool {
    std::path::Path::new(path).extension().and_then(|e| e.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("softn"))
}

/// Whether `path` is an Android content URI, which is what the system picker returns there.
fn is_content_uri(path: &str) -> bool {
    cfg!(mobile) && path.starts_with("content://")
}

/// Read a .softn bundle file from disk (binary ZIP format). Only a file the
/// user opened through this process (see `OpenableFiles`) can be read. The bytes
/// of the file the person chose last are the bundle open now (data_identity.rs).
#[tauri::command]
fn read_softn_bundle(
    #[allow(unused_variables)] app: tauri::AppHandle,
    files: State<'_, OpenableFiles>,
    identity: State<'_, DataIdentity>,
    path: String,
) -> Result<Vec<u8>, String> {
    let uri = is_content_uri(&path);
    let path = PathBuf::from(&path);

    // Ensure it's a .softn file. A content URI names no extension; it is read only when the
    // person picked it in this side's picker, which on Android cannot filter by one.
    if !uri && !is_softn_path(&path.to_string_lossy()) {
        return Err("Only .softn files can be read".to_string());
    }

    if !files.permits(&path) {
        return Err("This file was not opened through the app; use Open, drop it onto the window, or open it from your file manager".to_string());
    }

    #[cfg(mobile)]
    if uri {
        let bytes = read_content_uri(&app, &path.to_string_lossy())?;
        identity.bundle_read(&path, &bytes);
        return Ok(bytes);
    }

    // Check if file exists
    if !path.exists() {
        return Err(format!("File not found: {}", path.display()));
    }

    let bytes = fs::read(&path).map_err(|e| format!("Failed to read file: {}", e))?;
    identity.bundle_read(&path, &bytes);
    Ok(bytes)
}

/// Read what a content URI the person picked names, through the file system plugin.
#[cfg(mobile)]
fn read_content_uri(app: &tauri::AppHandle, uri: &str) -> Result<Vec<u8>, String> {
    use tauri_plugin_fs::FsExt;
    let url = url::Url::parse(uri).map_err(|e| format!("Not a file the picker returned: {}", e))?;
    app.fs()
        .read(tauri_plugin_fs::FilePath::Url(url))
        .map_err(|e| format!("Failed to read file: {}", e))
}

/// Open the system file picker for one `.softn` file, record the choice as
/// readable, and return its path (or nothing when the picker was dismissed).
/// The dialog runs here rather than in the webview so the choice is one this
/// side witnessed; blocking, hence an async command off the main thread.
#[cfg(desktop)]
#[tauri::command]
async fn pick_softn_bundle(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let picked = app
        .dialog()
        .file()
        .add_filter("SoftN Bundle", &["softn"])
        .blocking_pick_file();
    let Some(file) = picked else { return Ok(None) };
    let path = file.into_path().map_err(|e| format!("The picker returned something that is not a file path: {}", e))?;
    if !is_softn_path(&path.to_string_lossy()) {
        return Err("Only .softn files can be opened".to_string());
    }
    bundle_chosen(&app, &path);
    Ok(Some(path.to_string_lossy().to_string()))
}

/// The picker on Android, run here for the same reason: the page is given no file system or
/// dialog plugin of its own. The system picker cannot filter by extension there and returns a
/// content URI, which `read_softn_bundle` reads through the file system plugin.
#[cfg(mobile)]
#[tauri::command]
async fn pick_softn_bundle(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let Some(file) = app.dialog().file().blocking_pick_file() else { return Ok(None) };
    let chosen = file.to_string();
    bundle_chosen(&app, Path::new(&chosen));
    Ok(Some(chosen))
}

/// Whether `backup` is a snapshot `backup_database` (scoped_xdb.rs) wrote for the database in
/// `directory`: a `pre-upgrade-*.sqlite` file directly inside it. `backup` is whatever the page
/// sent, so as in `OpenableFiles::permits` it is looked up on disk only when that stays on
/// this machine; the path `backup_database` returned matches as written.
fn is_own_snapshot(directory: &Path, backup: &Path) -> bool {
    let named = backup
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with("pre-upgrade-") && name.ends_with(".sqlite"));
    named
        && backup.parent().is_some_and(|parent| {
            parent == directory
                || (is_on_this_machine(backup) && canonical(parent) == canonical(directory))
        })
}

/// Restore an app's database from a snapshot `backup_database` wrote (local
/// scope: this device only). Only a `pre-upgrade-*.sqlite` file inside the
/// database's own directory is accepted, and only for the app open now.
#[tauri::command]
async fn restore_database(
    app: tauri::AppHandle,
    db_manager: State<'_, xdb::tauri::SharedDbManager>,
    network: State<'_, xdb::tauri::SharedNetworkState>,
    control: State<'_, xdb::tauri::SharedNetworkControl>,
    identity: State<'_, DataIdentity>,
    app_id: Option<String>,
    backup: String,
) -> Result<xdb::tauri::ImportOutcome, String> {
    let app_id = Some(identity.require(app_id.as_deref())?);
    let db_path = PathBuf::from(xdb::tauri::get_db_path(db_manager.clone(), app_id.clone())?);
    let directory = db_path.parent().ok_or("The database has no parent directory")?;
    if !is_own_snapshot(directory, Path::new(&backup)) {
        return Err("Only a pre-upgrade snapshot beside the database can be restored".to_string());
    }
    xdb::tauri::import_database(app, db_manager, network, control, app_id, backup, Some("local".to_string())).await
}

/// Take over the page's installation registry, once, before any bundle has run in the page
/// (data_identity.rs says why then and never after).
#[tauri::command]
fn import_installations(
    identity: State<'_, DataIdentity>,
    registry: Option<String>,
) -> Result<data_identity::ImportSummary, String> {
    identity.import_page_registry(registry.as_deref())
}

/// Let the data commands use `data_id`'s data for the bundle open now (`bundle_id`, the digest
/// the page computed). Its own data, or data the person let it use before, needs nothing;
/// another installed app's data is put to the person in a native dialog. `start` marks the
/// runtime's last bind before it starts the app; after it, this open binds nothing else.
#[tauri::command]
async fn bind_data_identity(
    app: tauri::AppHandle,
    identity: State<'_, DataIdentity>,
    bundle_id: String,
    data_id: String,
    name: Option<String>,
    version: Option<String>,
    start: Option<bool>,
) -> Result<(), String> {
    identity
        .require_bind(&app, &bundle_id, &data_id, name.as_deref(), version.as_deref(), start == Some(true))
        .await
}

/// The bundle open now is new to this runtime and repeats an installed app's name: ask the
/// person, in a native dialog, whether it is a new version of that app (src/upgradeFlow.ts).
#[tauri::command]
async fn choose_data_identity(
    app: tauri::AppHandle,
    identity: State<'_, DataIdentity>,
    bundle_id: String,
    candidates: Vec<String>,
) -> Result<data_identity::Choice, String> {
    identity.require_choice(&app, &bundle_id, &candidates).await
}

/// Whether a change to the peer network settings switches on something that is off now.
fn turns_peer_sync_on(
    current: &xdb::tauri::NetworkSettings,
    enabled: bool,
    discovery: Option<bool>,
    listen: Option<bool>,
) -> bool {
    enabled
        && (!current.enabled
            || (discovery == Some(true) && !current.discovery)
            || (listen == Some(true) && !current.listen))
}

/// XDB's `set_network_enabled`, behind a question. Turning peer sync on makes this machine
/// announce itself and share app data on the local network, and the setting is kept across
/// restarts. The call can come from anything running in the page, so the person is asked
/// here first (consent.rs). Turning it off, or leaving it as it is, needs no question.
#[tauri::command]
async fn set_network_enabled(
    app: tauri::AppHandle,
    network: State<'_, xdb::tauri::SharedNetworkState>,
    control: State<'_, xdb::tauri::SharedNetworkControl>,
    consent: State<'_, consent::Consent>,
    enabled: bool,
    discovery: Option<bool>,
    listen: Option<bool>,
) -> Result<xdb::tauri::NetworkSettings, String> {
    if turns_peer_sync_on(&control.settings(), enabled, discovery, listen) {
        consent.require_peer_sync(&app).await?;
    }
    xdb::tauri::set_network_enabled(app, network, control, enabled, discovery, listen).await
}

/// Get the file path from CLI arguments (for double-click opening)
#[tauri::command]
fn get_opened_file(state: State<'_, OpenedFile>) -> Option<String> {
    let guard = state.path.lock().ok()?;
    guard.clone()
}

/// Where the cached bundle called `filename` is: directly inside `cache_dir`, or nowhere.
fn cached_bundle_path(cache_dir: &Path, filename: &str) -> Result<PathBuf, String> {
    // Reject filenames with path separators or traversal
    if filename.contains('/') || filename.contains('\\') || filename.contains("..") {
        return Err("Invalid filename".to_string());
    }
    // The name must also be one the path parser reads as a single file name. On Windows
    // `D:app.softn` is a drive and a name: joined to a folder it leaves the folder for
    // drive D's current directory. A colon anywhere else there names a stream of a file.
    let mut parts = Path::new(filename).components();
    let one_name = matches!((parts.next(), parts.next()), (Some(std::path::Component::Normal(_)), None));
    if !one_name || (cfg!(windows) && filename.contains(':')) {
        return Err("Invalid filename".to_string());
    }
    let path = cache_dir.join(filename);
    if !is_softn_path(&path.to_string_lossy()) {
        return Err("Only .softn files can be read".to_string());
    }
    Ok(path)
}

/// Read a cached .softn bundle from the app cache directory (for Android intent-opened files).
/// The page names the file, so reading one is not the person choosing it: these bytes do not
/// become the bundle open now, and give no app's data.
#[tauri::command]
fn read_cached_bundle(app: tauri::AppHandle, identity: State<'_, DataIdentity>, filename: String) -> Result<Vec<u8>, String> {
    let cache_dir = app.path().app_cache_dir()
        .map_err(|e| format!("Failed to get cache dir: {}", e))?;
    let path = cached_bundle_path(&cache_dir, &filename)?;
    let bytes = fs::read(&path).map_err(|e| format!("Failed to read cached file: {}", e))?;
    identity.bundle_handed_over();
    Ok(bytes)
}

/// Set the window icon from raw image bytes (PNG format)
#[cfg(desktop)]
#[tauri::command]
fn set_window_icon(app: tauri::AppHandle, icon_data: Vec<u8>) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("Failed to get main window")?;

    if icon_data.len() > ICON_MAX_BYTES {
        return Err(format!("Icon is {} bytes; the window icon may be at most {} bytes", icon_data.len(), ICON_MAX_BYTES));
    }

    // Decode with limits: the header is checked before pixels are allocated,
    // so a bundle cannot make the runtime allocate gigabytes for its icon.
    let mut reader = image::ImageReader::new(std::io::Cursor::new(&icon_data))
        .with_guessed_format()
        .map_err(|e| format!("Failed to read image: {}", e))?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(ICON_MAX_SIDE);
    limits.max_image_height = Some(ICON_MAX_SIDE);
    limits.max_alloc = Some(16 * 1024 * 1024);
    reader.limits(limits);
    let img = reader
        .decode()
        .map_err(|e| format!("Failed to decode image: {}", e))?;

    let (width, height) = img.dimensions();
    let rgba = img.to_rgba8().into_raw();

    let icon = Image::new_owned(rgba, width, height);

    window
        .set_icon(icon)
        .map_err(|e| format!("Failed to set window icon: {}", e))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialize tracing for logging
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env()
            .add_directive("xdb=info".parse().unwrap())
            .add_directive("softn_loader=info".parse().unwrap()))
        .init();

    // Only include plugins strictly needed by the loader.
    // shell plugin removed — untrusted bundles must not reach OS command execution.
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init());

    // Add desktop-only plugins (single-instance, CLI)
    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_cli::init())
            .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // When another instance tries to open, check for file argument
            if argv.len() > 1 {
                let file_path = &argv[1];
                if is_softn_path(file_path) {
                    remember_opened(app, file_path);
                    // Store the opened file path
                    if let Some(state) = app.try_state::<OpenedFile>() {
                        if let Ok(mut guard) = state.path.lock() {
                            *guard = Some(file_path.clone());
                        }
                    }

                    // Emit event to frontend
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.emit(
                            "file-opened",
                            FileOpenedEvent {
                                path: file_path.clone(),
                            },
                        );
                        let _ = window.set_focus();
                    }
                }
            }
        }));
    }

    builder
        .manage(OpenedFile {
            path: Mutex::new(None),
        })
        .manage(OpenableFiles::default())
        .manage(consent::Consent::default())
        // A drop onto the window is a choice made with the pointer, outside
        // the page: record it before the webview's own drop handler can ask
        // to read it (Tauri forwards the event to the page asynchronously,
        // so this handler runs first). The page opens the first .softn file
        // dropped, so that one is the app open now.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                let files = window.state::<OpenableFiles>();
                let mut softn = paths.iter().filter(|path| is_softn_path(&path.to_string_lossy()));
                if let Some(first) = softn.next() {
                    bundle_chosen(window.app_handle(), first);
                }
                for path in softn {
                    files.allow(path);
                }
            }
        })
        .invoke_handler({
            #[cfg(desktop)]
            {
                tauri::generate_handler![
                    read_softn_bundle,
                    read_cached_bundle,
                    get_opened_file,
                    net::net_fetch,
                    pick_softn_bundle,
                    set_window_icon,
                    scoped_xdb::backup_database,
                    restore_database,
                    import_installations,
                    bind_data_identity,
                    choose_data_identity,
                    // XDB P2P Database commands, held to the app open now
                    scoped_xdb::create_record,
                    scoped_xdb::update_record,
                    scoped_xdb::update_records,
                    scoped_xdb::delete_record,
                    scoped_xdb::upsert_record,
                    scoped_xdb::get_record,
                    scoped_xdb::get_collection,
                    scoped_xdb::get_collections,
                    scoped_xdb::clear_collection,
                    scoped_xdb::get_db_stats,
                    xdb::tauri::get_network_status,
                    xdb::tauri::get_network_settings,
                    set_network_enabled,
                    xdb::tauri::resume_sync,
                    xdb::tauri::recover_restore,
                    xdb::tauri::reconcile_network,
                    scoped_xdb::request_sync,
                    scoped_xdb::import_records,
                    scoped_xdb::reset_collection,
                ]
            }
            #[cfg(not(desktop))]
            {
                tauri::generate_handler![
                    read_softn_bundle,
                    read_cached_bundle,
                    get_opened_file,
                    net::net_fetch,
                    pick_softn_bundle,
                    // As on the desktop. XDB's export_database and import_database took a
                    // path from the page (write or read any file this app can), and
                    // get_db_path and get_db_base_dir told it where the databases live.
                    scoped_xdb::backup_database,
                    restore_database,
                    import_installations,
                    bind_data_identity,
                    choose_data_identity,
                    // XDB P2P Database commands, held to the app open now
                    scoped_xdb::create_record,
                    scoped_xdb::update_record,
                    scoped_xdb::update_records,
                    scoped_xdb::delete_record,
                    scoped_xdb::upsert_record,
                    scoped_xdb::get_record,
                    scoped_xdb::get_collection,
                    scoped_xdb::get_collections,
                    scoped_xdb::clear_collection,
                    scoped_xdb::get_db_stats,
                    xdb::tauri::get_network_status,
                    xdb::tauri::get_network_settings,
                    set_network_enabled,
                    xdb::tauri::resume_sync,
                    xdb::tauri::recover_restore,
                    xdb::tauri::reconcile_network,
                    scoped_xdb::request_sync,
                    scoped_xdb::import_records,
                    scoped_xdb::reset_collection,
                ]
            }
        })
        .setup(|app| {
            // Initialize XDB local databases. Peer networking is OFF unless the
            // user explicitly enabled it (persisted network-settings.json); see
            // docs/engineering/xdb/networking-and-restore-policy.md (audit XD-01).
            info!("Initializing XDB local database (peer networking opt-in)...");
            xdb::tauri::setup_xdb(app)?;
            info!("XDB initialized successfully");

            // Which app's data the page may use is decided from this side's own record, in
            // the same folder as the databases. Managed before the command line is read: a
            // file named there is the first app opened.
            let data_dir = app.state::<xdb::tauri::SharedDbManager>().base_dir().clone();
            app.manage(DataIdentity::open(&data_dir));

            // Desktop-only: Handle CLI arguments and set window icon
            #[cfg(desktop)]
            {
                // Handle CLI arguments (file opened via double-click or command line)
                match app.cli().matches() {
                    Ok(matches) => {
                        if let Some(file_arg) = matches.args.get("file") {
                            if let serde_json::Value::String(path) = &file_arg.value {
                                if is_softn_path(path) {
                                    remember_opened(app.handle(), path);
                                    // Store the opened file path
                                    let opened_file: State<'_, OpenedFile> = app.state();
                                    if let Ok(mut guard) = opened_file.path.lock() {
                                        *guard = Some(path.clone());
                                    }

                                    // Emit event to frontend
                                    if let Some(window) = app.get_webview_window("main") {
                                        let _ = window.emit(
                                            "file-opened",
                                            FileOpenedEvent { path: path.clone() },
                                        );
                                    }

                                    // Update window title
                                    if let Some(window) = app.get_webview_window("main") {
                                        let path_buf = PathBuf::from(path);
                                        let file_name = path_buf
                                            .file_stem()
                                            .and_then(|s| s.to_str())
                                            .unwrap_or("SoftN")
                                            .to_string();
                                        let _ = window.set_title(&format!("{} - SoftN", file_name));
                                    }
                                }
                            }
                        }
                    }
                    Err(e) => {
                        eprintln!("Failed to parse CLI arguments: {}", e);
                    }
                }

                // Set default window icon
                if let Some(window) = app.get_webview_window("main") {
                    let icon_bytes = include_bytes!("../icons/icon.png");
                    if let Ok(img) = image::load_from_memory(icon_bytes) {
                        let (width, height) = img.dimensions();
                        let rgba = img.to_rgba8().into_raw();
                        let icon = Image::new_owned(rgba, width, height);
                        let _ = window.set_icon(icon);
                    }
                }
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cache_dir() -> PathBuf {
        if cfg!(windows) {
            PathBuf::from(r"C:\Users\someone\AppData\Local\com.softn.runtime")
        } else {
            PathBuf::from("/data/user/0/com.softn.runtime/cache")
        }
    }

    #[test]
    fn a_cached_bundle_is_a_file_directly_inside_the_cache_folder() {
        let cache = cache_dir();
        assert_eq!(cached_bundle_path(&cache, "opened-1.softn").unwrap(), cache.join("opened-1.softn"));
        assert_eq!(cached_bundle_path(&cache, "My App.SOFTN").unwrap(), cache.join("My App.SOFTN"));
        for name in ["", ".", "..", "../other.softn", "sub/app.softn", "sub\\app.softn", "/etc/app.softn", "app.txt", "app.softn/"] {
            assert!(cached_bundle_path(&cache, name).is_err(), "{:?} was accepted", name);
        }
    }

    /// `D:app.softn` has no separator and no `..`, and joined to a folder it still names a
    /// file in drive D's current directory.
    #[cfg(windows)]
    #[test]
    fn a_cached_bundle_name_cannot_name_another_drive_or_a_stream() {
        let cache = cache_dir();
        for name in ["D:app.softn", "C:app.softn", "c:app.softn", "notes.txt:app.softn", "app.softn::$DATA"] {
            match cached_bundle_path(&cache, name) {
                Err(_) => {}
                Ok(path) => panic!("{:?} was accepted as {}", name, path.display()),
            }
        }
    }

    #[cfg(windows)]
    #[test]
    fn only_a_path_on_this_machine_is_looked_up_on_disk() {
        for path in [
            r"\\files.example.net\share\app.softn",
            "//files.example.net/share/app.softn",
            r"\\?\UNC\files.example.net\share\app.softn",
            r"\\.\pipe\app.softn",
            r"\\?\GLOBALROOT\Device\Mup\files.example.net\share\app.softn",
            r"\??\UNC\files.example.net\share\app.softn",
            "/??/UNC/files.example.net/share/app.softn",
        ] {
            assert!(!is_on_this_machine(Path::new(path)), "{} would be resolved", path);
        }
        for path in [r"C:\Users\someone\app.softn", r"\\?\C:\Users\someone\app.softn", r"apps\app.softn", r"\apps\app.softn", "D:app.softn"] {
            assert!(is_on_this_machine(Path::new(path)), "{} would not be resolved", path);
        }
    }

    #[test]
    fn a_bundle_is_readable_under_any_spelling_of_the_file_that_was_opened() {
        let dir = std::env::temp_dir().join(format!("softn-loader-openable-{}", std::process::id()));
        fs::create_dir_all(dir.join("sub")).unwrap();
        let opened = dir.join("app.softn");
        let other = dir.join("other.softn");
        fs::write(&opened, b"PK").unwrap();
        fs::write(&other, b"PK").unwrap();

        let files = OpenableFiles::default();
        files.allow(&opened);
        assert!(files.permits(&opened));
        assert!(files.permits(&dir.join("sub").join("..").join("app.softn")));
        assert!(!files.permits(&other));
        assert!(!files.permits(&dir.join("missing.softn")));
        let _ = fs::remove_dir_all(&dir);
    }

    /// Whatever the desktop page may call, a bundle drawn in that page may call too. The page
    /// asks this side for its file picker (`pick_softn_bundle`), so it needs no dialog, file
    /// or shell plugin of its own, and a bundle is not handed native dialogs to word as it likes.
    #[test]
    fn the_desktop_page_is_granted_no_dialog_file_or_shell_plugin() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        let granted: Vec<&str> = capability["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|permission| permission.as_str().or_else(|| permission["identifier"].as_str()).unwrap())
            .collect();
        assert!(granted.contains(&"core:default"));
        for permission in &granted {
            for plugin in ["dialog:", "fs:", "shell:", "opener:"] {
                assert!(!permission.starts_with(plugin), "the desktop page is granted {}", permission);
            }
        }
    }

    /// The same on Android, where the page picked and read the bundle itself: `fs:default`
    /// let it read the app's own folders, where every app's database and its snapshots are,
    /// and `fs:allow-read-file` reads a `file://` or `content://` URL with no scope check at
    /// all (tauri-plugin-fs, `resolve_file` on mobile). The picker and the read are this
    /// side's now (`pick_softn_bundle`, `read_softn_bundle`).
    #[test]
    fn the_android_page_is_granted_no_dialog_or_file_plugin() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/android.json")).unwrap();
        let granted: Vec<&str> = capability["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|permission| permission.as_str().or_else(|| permission["identifier"].as_str()).unwrap())
            .collect();
        assert!(granted.contains(&"core:default"));
        for permission in &granted {
            for plugin in ["dialog:", "fs:", "shell:", "opener:"] {
                assert!(!permission.starts_with(plugin), "the Android page is granted {}", permission);
            }
        }
    }

    #[test]
    fn only_switching_peer_sync_on_is_a_question() {
        let settings = |enabled, discovery, listen| xdb::tauri::NetworkSettings { enabled, discovery, listen };
        let off = settings(false, true, true);
        assert!(turns_peer_sync_on(&off, true, None, None));
        assert!(turns_peer_sync_on(&off, true, Some(false), Some(false)));
        // Off stays off, and switching off is never a question.
        assert!(!turns_peer_sync_on(&off, false, Some(true), Some(true)));
        let on = settings(true, false, false);
        assert!(!turns_peer_sync_on(&on, false, None, None));
        // On already: the same settings again are not a question, a part newly on is.
        assert!(!turns_peer_sync_on(&on, true, None, None));
        assert!(!turns_peer_sync_on(&on, true, Some(false), Some(false)));
        assert!(turns_peer_sync_on(&on, true, Some(true), None));
        assert!(turns_peer_sync_on(&on, true, None, Some(true)));
        assert!(!turns_peer_sync_on(&settings(true, true, true), true, Some(true), Some(true)));
    }

    #[test]
    fn only_a_snapshot_beside_the_database_can_be_restored() {
        let dir = std::env::temp_dir().join(format!("softn-loader-snapshot-{}", std::process::id()));
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::write(dir.join("pre-upgrade-19a.sqlite"), b"").unwrap();
        fs::write(dir.join("sub").join("pre-upgrade-19a.sqlite"), b"").unwrap();

        assert!(is_own_snapshot(&dir, &dir.join("pre-upgrade-19a.sqlite")));
        assert!(is_own_snapshot(&dir, &dir.join("sub").join("..").join("pre-upgrade-19a.sqlite")));
        assert!(!is_own_snapshot(&dir, &dir.join("sub").join("pre-upgrade-19a.sqlite")));
        assert!(!is_own_snapshot(&dir, &dir.join("data.sqlite")));
        assert!(!is_own_snapshot(&dir, &dir.join("pre-upgrade-19a.sqlite.txt")));
        assert!(!is_own_snapshot(&dir, Path::new("pre-upgrade-19a.sqlite")));
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn a_snapshot_path_on_another_machine_is_refused_as_written() {
        let dir = std::env::temp_dir();
        // 192.0.2.1 is a documentation address: resolving this path would wait on it.
        let started = std::time::Instant::now();
        assert!(!is_own_snapshot(&dir, Path::new(r"\\192.0.2.1\share\pre-upgrade-19a.sqlite")));
        assert!(started.elapsed() < std::time::Duration::from_secs(2), "the path was looked up over the network");
        // A database that itself lives on a share restores from the path it was backed up to.
        let share = Path::new(r"\\?\UNC\files.example.net\profiles\someone\xdb");
        assert!(is_own_snapshot(share, &share.join("pre-upgrade-19a.sqlite")));
    }

    /// Every XDB command that takes an app id is registered through the loader's own
    /// wrapper, which holds it to the app the person opened. Registered from xdb directly,
    /// the page's `appId` decides.
    #[test]
    fn no_xdb_command_that_takes_an_app_id_is_registered_directly() {
        let source = include_str!("lib.rs");
        let handlers = source.split("generate_handler![").skip(1).take(2);
        for handler in handlers {
            let list = &handler[..handler.find(']').unwrap()];
            for command in list.lines().map(|line| line.trim().trim_end_matches(',')).filter(|line| line.starts_with("xdb::tauri::")) {
                let name = command.trim_start_matches("xdb::tauri::");
                assert!(
                    ["get_network_status", "get_network_settings", "resume_sync", "recover_restore", "reconcile_network"].contains(&name),
                    "{} is registered as xdb wrote it, so the page names the app",
                    command
                );
            }
        }
    }

    /// The page is not told where the data lives. It reads and writes through the commands
    /// above, which name no path; a folder's path is of use only to a bundle looking for a
    /// way to the files, and says whose account they are in. xdb's `get_db_base_dir` was
    /// registered, and no page asked for it.
    #[test]
    fn the_page_is_not_told_where_the_data_lives() {
        let source = include_str!("lib.rs");
        for handler in source.split("generate_handler![").skip(1).take(2) {
            let list = &handler[..handler.find(']').unwrap()];
            for name in ["get_db_base_dir", "get_db_path"] {
                assert!(
                    !list.lines().any(|line| line.trim().trim_end_matches(',').rsplit("::").next() == Some(name)),
                    "{} is registered",
                    name
                );
            }
        }
    }

    /// A share the user opened a bundle from stays readable by the path it was opened with,
    /// which needs no look at the disk; another path on some other machine is refused without
    /// one, because looking would make Windows sign in to whatever host the page named.
    #[cfg(windows)]
    #[test]
    fn a_path_on_another_machine_is_judged_as_written() {
        let files = OpenableFiles::default();
        let opened = Path::new(r"\\?\UNC\files.example.net\share\app.softn");
        files.paths.lock().unwrap().insert(opened.to_path_buf());
        assert!(files.permits(opened));
        // 192.0.2.1 is a documentation address: resolving this path would wait on it.
        let started = std::time::Instant::now();
        assert!(!files.permits(Path::new(r"\\192.0.2.1\share\app.softn")));
        assert!(started.elapsed() < std::time::Duration::from_secs(2), "the path was looked up over the network");
    }
}
