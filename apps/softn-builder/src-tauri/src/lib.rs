use std::path::PathBuf;

/// Validate that a path does not contain traversal sequences and is absolute.
/// The builder should only operate on user-chosen file paths (from save/open dialogs).
fn validate_path(path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    // Reject paths containing traversal components
    for component in p.components() {
        if let std::path::Component::ParentDir = component {
            return Err("Path traversal not allowed".to_string());
        }
    }
    // Require absolute paths (from file dialogs)
    if !p.is_absolute() {
        return Err("Only absolute paths are allowed".to_string());
    }
    Ok(p)
}

#[tauri::command]
async fn save_project(path: String, data: Vec<u8>) -> Result<(), String> {
    let p = validate_path(&path)?;
    std::fs::write(&p, &data).map_err(|e| e.to_string())
}

#[tauri::command]
async fn load_project(path: String) -> Result<Vec<u8>, String> {
    let p = validate_path(&path)?;
    std::fs::read(&p).map_err(|e| e.to_string())
}

#[tauri::command]
async fn export_bundle(path: String, data: Vec<u8>) -> Result<(), String> {
    let p = validate_path(&path)?;
    std::fs::write(&p, &data).map_err(|e| e.to_string())
}

#[tauri::command]
async fn read_file(path: String) -> Result<Vec<u8>, String> {
    let p = validate_path(&path)?;
    std::fs::read(&p).map_err(|e| e.to_string())
}

#[tauri::command]
async fn write_file(path: String, data: Vec<u8>) -> Result<(), String> {
    let p = validate_path(&path)?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&p, &data).map_err(|e| e.to_string())
}

#[tauri::command]
async fn file_exists(path: String) -> Result<bool, String> {
    let p = validate_path(&path)?;
    Ok(p.exists())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            save_project,
            load_project,
            export_bundle,
            read_file,
            write_file,
            file_exists,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
