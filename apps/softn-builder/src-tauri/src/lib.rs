mod files;

pub use files::{Dialogs, FileHandle, ProjectFiles, SaveKind, MAX_BUNDLE_BYTES};
use tauri::{webview::PageLoadEvent, Builder, Manager, Runtime};

/// The app's plugins and commands, for `run()` and for the tests in `tests/`.
/// The page has no file system or dialog permission: it opens and saves
/// through the commands in files.rs, which show the dialogs themselves.
#[doc(hidden)]
pub fn with_commands<R: Runtime>(builder: Builder<R>) -> Builder<R> {
    builder
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            files::open_project,
            files::use_opened_project,
            files::forget_project_file,
            files::save_project,
            files::save_file_as,
            files::ask_discard_unsaved,
        ])
        // A page loaded again starts with no file, as the Builder in it does.
        .on_page_load(|webview, payload| {
            if payload.event() == PageLoadEvent::Started {
                if let Some(files) = webview.try_state::<ProjectFiles>() {
                    files.forget();
                }
            }
        })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    with_commands(tauri::Builder::default())
        .setup(|app| {
            app.manage(ProjectFiles::new(Box::new(files::NativeDialogs(
                app.handle().clone(),
            ))));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
