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
#[cfg(desktop)]
use tauri_plugin_dialog::DialogExt;
use tracing::info;

mod net;

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

impl OpenableFiles {
    fn allow(&self, path: &Path) {
        if let Ok(mut set) = self.paths.lock() {
            set.insert(canonical(path));
        }
    }

    fn permits(&self, path: &Path) -> bool {
        self.paths
            .lock()
            .map(|set| set.contains(&canonical(path)))
            .unwrap_or(false)
    }
}

/// Record a bundle the user opened from outside the window (CLI, file
/// association, second instance) so the webview may read it.
fn remember_opened(app: &tauri::AppHandle, path: &str) {
    if let Some(files) = app.try_state::<OpenableFiles>() {
        files.allow(Path::new(path));
    }
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

/// Read a .softn bundle file from disk (binary ZIP format). Only a file the
/// user opened through this process (see `OpenableFiles`) can be read.
#[tauri::command]
fn read_softn_bundle(files: State<'_, OpenableFiles>, path: String) -> Result<Vec<u8>, String> {
    let path = PathBuf::from(&path);

    // Ensure it's a .softn file
    if !is_softn_path(&path.to_string_lossy()) {
        return Err("Only .softn files can be read".to_string());
    }

    if !files.permits(&path) {
        return Err("This file was not opened through the app; use Open, drop it onto the window, or open it from your file manager".to_string());
    }

    // Check if file exists
    if !path.exists() {
        return Err(format!("File not found: {}", path.display()));
    }

    fs::read(&path).map_err(|e| format!("Failed to read file: {}", e))
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
    app.state::<OpenableFiles>().allow(&path);
    Ok(Some(path.to_string_lossy().to_string()))
}

/// Snapshot an app's database beside itself before an upgrade and return the
/// snapshot's path. Wraps XDB's export so the webview never learns or chooses
/// a file system path: the location is always the database's own directory.
#[cfg(desktop)]
#[tauri::command]
async fn backup_database(
    db_manager: State<'_, xdb::tauri::SharedDbManager>,
    app_id: Option<String>,
) -> Result<String, String> {
    let db_path = PathBuf::from(xdb::tauri::get_db_path(db_manager.clone(), app_id.clone())?);
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

/// Restore an app's database from a snapshot `backup_database` wrote (local
/// scope: this device only). Only a `pre-upgrade-*.sqlite` file inside the
/// database's own directory is accepted.
#[cfg(desktop)]
#[tauri::command]
async fn restore_database(
    app: tauri::AppHandle,
    db_manager: State<'_, xdb::tauri::SharedDbManager>,
    network: State<'_, xdb::tauri::SharedNetworkState>,
    control: State<'_, xdb::tauri::SharedNetworkControl>,
    app_id: Option<String>,
    backup: String,
) -> Result<xdb::tauri::ImportOutcome, String> {
    let db_path = PathBuf::from(xdb::tauri::get_db_path(db_manager.clone(), app_id.clone())?);
    let directory = canonical(db_path.parent().ok_or("The database has no parent directory")?);
    let source = PathBuf::from(&backup);
    let name = source
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("The backup path has no file name")?;
    let inside = source.parent().map(canonical).is_some_and(|parent| parent == directory);
    if !inside || !name.starts_with("pre-upgrade-") || !name.ends_with(".sqlite") {
        return Err("Only a pre-upgrade snapshot beside the database can be restored".to_string());
    }
    xdb::tauri::import_database(app, db_manager, network, control, app_id, backup, Some("local".to_string())).await
}

/// Get the file path from CLI arguments (for double-click opening)
#[tauri::command]
fn get_opened_file(state: State<'_, OpenedFile>) -> Option<String> {
    let guard = state.path.lock().ok()?;
    guard.clone()
}

/// Read a cached .softn bundle from the app cache directory (for Android intent-opened files)
#[tauri::command]
fn read_cached_bundle(app: tauri::AppHandle, filename: String) -> Result<Vec<u8>, String> {
    // Reject filenames with path separators or traversal
    if filename.contains('/') || filename.contains('\\') || filename.contains("..") {
        return Err("Invalid filename".to_string());
    }
    let cache_dir = app.path().app_cache_dir()
        .map_err(|e| format!("Failed to get cache dir: {}", e))?;
    let path = cache_dir.join(&filename);
    if !is_softn_path(&path.to_string_lossy()) {
        return Err("Only .softn files can be read".to_string());
    }
    fs::read(&path).map_err(|e| format!("Failed to read cached file: {}", e))
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
        // A drop onto the window is a choice made with the pointer, outside
        // the page: record it before the webview's own drop handler can ask
        // to read it (Tauri forwards the event to the page asynchronously,
        // so this handler runs first).
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                let files = window.state::<OpenableFiles>();
                for path in paths {
                    if is_softn_path(&path.to_string_lossy()) {
                        files.allow(path);
                    }
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
                    backup_database,
                    restore_database,
                    // XDB P2P Database commands
                    xdb::tauri::create_record,
                    xdb::tauri::update_record,
                    xdb::tauri::update_records,
                    xdb::tauri::delete_record,
                    xdb::tauri::upsert_record,
                    xdb::tauri::get_record,
                    xdb::tauri::get_collection,
                    xdb::tauri::get_collections,
                    xdb::tauri::clear_collection,
                    xdb::tauri::get_db_stats,
                    xdb::tauri::get_network_status,
                    xdb::tauri::get_network_settings,
                    xdb::tauri::set_network_enabled,
                    xdb::tauri::resume_sync,
                    xdb::tauri::recover_restore,
                    xdb::tauri::reconcile_network,
                    xdb::tauri::request_sync,
                    xdb::tauri::import_records,
                    xdb::tauri::reset_collection,
                    xdb::tauri::get_db_base_dir,
                ]
            }
            #[cfg(not(desktop))]
            {
                tauri::generate_handler![
                    read_softn_bundle,
                    read_cached_bundle,
                    get_opened_file,
                    net::net_fetch,
                    // XDB P2P Database commands
                    xdb::tauri::create_record,
                    xdb::tauri::update_record,
                    xdb::tauri::update_records,
                    xdb::tauri::delete_record,
                    xdb::tauri::upsert_record,
                    xdb::tauri::get_record,
                    xdb::tauri::get_collection,
                    xdb::tauri::get_collections,
                    xdb::tauri::clear_collection,
                    xdb::tauri::get_db_stats,
                    xdb::tauri::get_network_status,
                    xdb::tauri::get_network_settings,
                    xdb::tauri::set_network_enabled,
                    xdb::tauri::resume_sync,
                    xdb::tauri::recover_restore,
                    xdb::tauri::reconcile_network,
                    xdb::tauri::request_sync,
                    xdb::tauri::import_records,
                    xdb::tauri::reset_collection,
                    xdb::tauri::export_database,
                    xdb::tauri::import_database,
                    xdb::tauri::get_db_path,
                    xdb::tauri::get_db_base_dir,
                ]
            }
        })
        .setup(|app| {
            // Initialize XDB local databases. Peer networking is OFF unless the
            // user explicitly enabled it (persisted network-settings.json); see
            // xdb.org docs/networking-and-restore-policy.md (audit XD-01).
            info!("Initializing XDB local database (peer networking opt-in)...");
            xdb::tauri::setup_xdb(app)?;
            info!("XDB initialized successfully");

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
