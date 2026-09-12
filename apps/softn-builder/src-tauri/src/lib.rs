#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Open/save dialogs add only selected paths to this session's file scope.
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
