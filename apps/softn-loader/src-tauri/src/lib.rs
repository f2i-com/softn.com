//! SoftN Loader - Application Runtime
//!
//! This is the Rust backend for the SoftN application runtime.
//! Handles file opening and .softn bundle loading.
//! Integrates XDB for P2P database sync across local network.

use serde::Serialize;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
#[cfg(desktop)]
use image::GenericImageView;
use tauri::{Emitter, Manager, State};
#[cfg(desktop)]
use tauri::image::Image;
#[cfg(desktop)]
use tauri_plugin_cli::CliExt;
use tracing::info;

/// State for the opened file path
struct OpenedFile {
    path: Mutex<Option<String>>,
}

/// Event emitted when a file is opened via CLI/double-click
#[derive(Clone, Serialize)]
struct FileOpenedEvent {
    path: String,
}

/// Read a .softn bundle file from disk (binary ZIP format)
#[tauri::command]
fn read_softn_bundle(path: String) -> Result<Vec<u8>, String> {
    let path = PathBuf::from(&path);

    // Ensure it's a .softn file
    if path.extension().and_then(|e| e.to_str()) != Some("softn") {
        return Err("Only .softn files can be read".to_string());
    }

    // Check if file exists
    if !path.exists() {
        return Err(format!("File not found: {}", path.display()));
    }

    fs::read(&path).map_err(|e| format!("Failed to read file: {}", e))
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
    let cache_dir = app.path().app_cache_dir()
        .map_err(|e| format!("Failed to get cache dir: {}", e))?;
    let path = cache_dir.join(&filename);
    if path.extension().and_then(|e| e.to_str()) != Some("softn") {
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

    // Decode PNG image
    let img = image::load_from_memory(&icon_data)
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

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
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
                if file_path.ends_with(".softn") {
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
        .invoke_handler({
            #[cfg(desktop)]
            {
                tauri::generate_handler![
                    read_softn_bundle,
                    read_cached_bundle,
                    get_opened_file,
                    set_window_icon,
                    // XDB P2P Database commands
                    xdb::tauri::create_record,
                    xdb::tauri::update_record,
                    xdb::tauri::delete_record,
                    xdb::tauri::upsert_record,
                    xdb::tauri::get_record,
                    xdb::tauri::get_collection,
                    xdb::tauri::get_collections,
                    xdb::tauri::clear_collection,
                    xdb::tauri::get_db_stats,
                    xdb::tauri::get_network_status,
                    xdb::tauri::request_sync,
                    xdb::tauri::export_database,
                    xdb::tauri::import_database,
                    xdb::tauri::get_db_path,
                    xdb::tauri::get_db_base_dir,
                ]
            }
            #[cfg(not(desktop))]
            {
                tauri::generate_handler![
                    read_softn_bundle,
                    read_cached_bundle,
                    get_opened_file,
                    // XDB P2P Database commands
                    xdb::tauri::create_record,
                    xdb::tauri::update_record,
                    xdb::tauri::delete_record,
                    xdb::tauri::upsert_record,
                    xdb::tauri::get_record,
                    xdb::tauri::get_collection,
                    xdb::tauri::get_collections,
                    xdb::tauri::clear_collection,
                    xdb::tauri::get_db_stats,
                    xdb::tauri::get_network_status,
                    xdb::tauri::request_sync,
                    xdb::tauri::export_database,
                    xdb::tauri::import_database,
                    xdb::tauri::get_db_path,
                    xdb::tauri::get_db_base_dir,
                ]
            }
        })
        .setup(|app| {
            // Initialize XDB P2P database
            info!("Initializing XDB P2P database...");
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
                                if path.ends_with(".softn") {
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
