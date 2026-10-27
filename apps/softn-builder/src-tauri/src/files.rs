//! The Builder's file work. The page names no path: Rust shows the open and
//! save dialogs itself, and the page may write only the one file the person
//! chose for the project now open.
//!
//! The preview draws a bundle, which may be a stranger's, into the Builder's
//! own window, so whatever command the Builder can call, the bundle can call
//! too. Each command here is safe for a caller that is not the Builder: it
//! can show these dialogs, with their own titles and filters, read the bundle
//! the person picks in one, and write the file kept for the project now open,
//! and nothing else. Ids are not secrets; the slots below are the boundary.

use serde::{Deserialize, Serialize};
use std::{
    borrow::Cow,
    collections::HashSet,
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
};
use tauri::{
    ipc::{InvokeBody, Request, Response},
    AppHandle, Manager, Runtime, State,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

/// The largest bundle the Builder opens: MAX_ZIP_INPUT_BYTES in @softn/bundle-format.
pub const MAX_BUNDLE_BYTES: u64 = 200 * 1024 * 1024;

/// What a save dialog is for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SaveKind {
    /// Save: the file picked is the project's from then on.
    Project,
    /// Export: the project's file if it has none yet, otherwise a copy.
    Export,
    /// A quarantined session, as JSON: never the project's file.
    Recovery,
}

impl SaveKind {
    pub fn extension(self) -> &'static str {
        match self {
            SaveKind::Project | SaveKind::Export => "softn",
            SaveKind::Recovery => "json",
        }
    }
}

/// The native dialogs, behind a trait so tests can answer for the person.
pub trait Dialogs: Send + Sync {
    /// The bundle picked in the open dialog, or None when it was closed.
    fn pick_bundle(&self) -> Option<PathBuf>;
    /// The place picked in the save dialog, or None when it was closed.
    fn pick_destination(&self, kind: SaveKind, file_name: &str) -> Option<PathBuf>;
    /// Whether the person chose to close the Builder and lose unsaved changes.
    fn confirm_discard(&self) -> bool;
}

/// A file as the page knows it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct FileHandle {
    pub id: String,
    pub name: String,
    pub path: String,
}

struct Chosen {
    id: u64,
    path: PathBuf,
}

impl Chosen {
    fn handle(&self) -> FileHandle {
        FileHandle {
            id: self.id.to_string(),
            name: file_name(&self.path),
            path: self.path.to_string_lossy().into_owned(),
        }
    }

    fn is(&self, id: &str) -> bool {
        id.parse::<u64>().ok() == Some(self.id)
    }
}

#[derive(Default)]
struct Slots {
    last_id: u64,
    /// The file of the project now open: the only one the page may write.
    project: Option<Chosen>,
    /// The bundle last picked to open, until the Builder takes it as the
    /// project's file. Until then the file before it is still the project's,
    /// so a person who decides not to open it after all saves where they did.
    opened: Option<Chosen>,
    /// The files already copied to `<name>.bak` while the app has been running.
    backed_up: HashSet<PathBuf>,
}

impl Slots {
    fn choose(&mut self, path: PathBuf) -> Chosen {
        self.last_id += 1;
        Chosen {
            id: self.last_id,
            path,
        }
    }
}

/// The first time the app writes a file, what the file held is copied to
/// `<name>.bak` beside it, and never again while the app runs: however often
/// it is written after, by Save or by a bundle's code, and if it is opened
/// again, the copy is the file as it was before the Builder first wrote it.
fn write_file(backed_up: &mut HashSet<PathBuf>, path: &Path, bytes: &[u8]) -> Result<(), String> {
    let known = |path: &Path| fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let before = known(path);
    if !backed_up.contains(&before) {
        if path.is_file() {
            fs::copy(path, backup_of(path)).map_err(|e| {
                format!(
                    "Could not keep a copy of {} before writing it: {e}",
                    file_name(path)
                )
            })?;
        }
        backed_up.insert(before);
    }
    replace_whole(path, bytes).map_err(|e| format!("Could not write {}: {e}", file_name(path)))?;
    // A file the write created is known by its full name from now on.
    backed_up.insert(known(path));
    Ok(())
}

/// Write `bytes` to `path` whole or not at all: into a file beside it, then
/// put in its place. `fs::write` emptied the file and wrote it where it lay,
/// so a disk that filled or a drive that went partway through Save left the
/// project short or empty, with only the `.bak` from before the session.
/// A link is written through, to the file it names.
fn replace_whole(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let target = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let name = target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let partial = target.with_file_name(format!(".{name}.saving"));
    let written = (|| {
        let mut file = fs::File::create(&partial)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        if let Ok(meta) = fs::metadata(&target) {
            fs::set_permissions(&partial, meta.permissions())?;
        }
        fs::rename(&partial, &target)
    })();
    if written.is_err() {
        let _ = fs::remove_file(&partial);
    }
    written
}

pub struct ProjectFiles {
    dialogs: Box<dyn Dialogs>,
    max_bytes: u64,
    slots: Mutex<Slots>,
}

impl ProjectFiles {
    pub fn new(dialogs: Box<dyn Dialogs>) -> Self {
        Self::with_limit(dialogs, MAX_BUNDLE_BYTES)
    }

    pub fn with_limit(dialogs: Box<dyn Dialogs>, max_bytes: u64) -> Self {
        Self {
            dialogs,
            max_bytes,
            slots: Mutex::default(),
        }
    }

    fn slots(&self) -> MutexGuard<'_, Slots> {
        self.slots
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The open dialog: a `.softn` file, read whole. None when it was closed.
    pub fn open(&self) -> Result<Option<(FileHandle, Vec<u8>)>, String> {
        let Some(path) = self.dialogs.pick_bundle() else {
            return Ok(None);
        };
        // The dialog's filter is a suggestion the person can type past.
        if !has_extension(&path, "softn") {
            return Err(format!(
                "{} is not a Softn app. Choose a .softn file.",
                file_name(&path)
            ));
        }
        let unreadable = |e: std::io::Error| format!("Could not read {}: {e}", file_name(&path));
        let too_large = || {
            format!(
                "This bundle is too large. The maximum file size is {} MB.",
                self.max_bytes / (1024 * 1024)
            )
        };
        let file = File::open(&path).map_err(unreadable)?;
        let size = file.metadata().map_err(unreadable)?.len();
        if size > self.max_bytes {
            return Err(too_large());
        }
        let mut bytes = Vec::with_capacity(size as usize);
        file.take(self.max_bytes + 1)
            .read_to_end(&mut bytes)
            .map_err(unreadable)?;
        if bytes.len() as u64 > self.max_bytes {
            return Err(too_large());
        }
        let mut slots = self.slots();
        let opened = slots.choose(path);
        let handle = opened.handle();
        slots.opened = Some(opened);
        Ok(Some((handle, bytes)))
    }

    /// The bundle just opened is now the project's file, and the file before it no longer is.
    pub fn use_opened(&self, id: &str) -> Result<(), String> {
        let mut slots = self.slots();
        if slots.project.as_ref().is_some_and(|project| project.is(id)) {
            return Ok(());
        }
        match slots.opened.take() {
            Some(opened) if opened.is(id) => {
                slots.project = Some(opened);
                Ok(())
            }
            other => {
                slots.opened = other;
                Err("This file is not the one just opened. Open it again.".into())
            }
        }
    }

    /// The project now open has no file: the next save asks where.
    pub fn forget(&self) {
        let mut slots = self.slots();
        slots.project = None;
        slots.opened = None;
    }

    /// Save over the project's file. None when `id` is not it: the caller asks where instead.
    pub fn save(&self, id: &str, bytes: &[u8]) -> Result<Option<FileHandle>, String> {
        let mut slots = self.slots();
        let Slots {
            project, backed_up, ..
        } = &mut *slots;
        match project {
            Some(project) if project.is(id) => {
                write_file(backed_up, &project.path, bytes)?;
                Ok(Some(project.handle()))
            }
            _ => Ok(None),
        }
    }

    /// The save dialog, then the write. None when it was closed.
    pub fn save_as(
        &self,
        kind: SaveKind,
        name: &str,
        bytes: &[u8],
    ) -> Result<Option<FileHandle>, String> {
        let Some(picked) = self
            .dialogs
            .pick_destination(kind, &suggested_name(name, kind))
        else {
            return Ok(None);
        };
        let path = with_extension(picked, kind.extension())?;
        let mut slots = self.slots();
        let slots = &mut *slots;
        write_file(&mut slots.backed_up, &path, bytes)?;
        // The project's own file, picked again, is still the project's file.
        if let Some(project) = slots
            .project
            .as_ref()
            .filter(|project| same_file(&project.path, &path))
        {
            return Ok(Some(project.handle()));
        }
        let chosen = slots.choose(path);
        let handle = chosen.handle();
        let becomes_the_projects = match kind {
            SaveKind::Project => true,
            SaveKind::Export => slots.project.is_none(),
            SaveKind::Recovery => false,
        };
        if becomes_the_projects {
            slots.project = Some(chosen);
            slots.opened = None;
        }
        Ok(Some(handle))
    }

    pub fn ask_discard(&self) -> bool {
        self.dialogs.confirm_discard()
    }
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string())
}

fn has_extension(path: &Path, extension: &str) -> bool {
    path.extension()
        .and_then(|found| found.to_str())
        .is_some_and(|found| found.eq_ignore_ascii_case(extension))
}

fn backup_of(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(".bak");
    PathBuf::from(name)
}

/// The page's suggestion as a file name only: no folder, and the extension the dialog is for.
fn suggested_name(name: &str, kind: SaveKind) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or_default().trim();
    let base = if base.is_empty() { "app" } else { base };
    if has_extension(Path::new(base), kind.extension()) {
        base.to_owned()
    } else {
        format!("{base}.{}", kind.extension())
    }
}

/// A name typed without the extension gets it. The dialog asked before
/// replacing the file that was picked, not the one with the extension added,
/// so that one is never replaced unasked.
fn with_extension(picked: PathBuf, extension: &str) -> Result<PathBuf, String> {
    if has_extension(&picked, extension) {
        return Ok(picked);
    }
    let mut named = picked.into_os_string();
    named.push(".");
    named.push(extension);
    let named = PathBuf::from(named);
    if named.exists() {
        return Err(format!(
            "{} already exists. Save again and pick it to replace it, or choose another name.",
            file_name(&named)
        ));
    }
    Ok(named)
}

/// Whether two paths name one file: a dialog may spell it in another case or form.
fn same_file(a: &Path, b: &Path) -> bool {
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

/// The native dialogs, over the main window.
pub struct NativeDialogs<R: Runtime>(pub AppHandle<R>);

impl<R: Runtime> NativeDialogs<R> {
    fn file(&self) -> tauri_plugin_dialog::FileDialogBuilder<R> {
        let dialog = self.0.dialog().file();
        #[cfg(desktop)]
        if let Some(main) = self.0.get_webview_window("main") {
            return dialog.set_parent(&main);
        }
        dialog
    }
}

impl<R: Runtime> Dialogs for NativeDialogs<R> {
    fn pick_bundle(&self) -> Option<PathBuf> {
        self.file()
            .set_title("Open a Softn app")
            .add_filter("Softn app", &["softn"])
            .blocking_pick_file()?
            .into_path()
            .ok()
    }

    fn pick_destination(&self, kind: SaveKind, file_name: &str) -> Option<PathBuf> {
        let filter = match kind {
            SaveKind::Project | SaveKind::Export => "Softn app",
            SaveKind::Recovery => "Recovery file",
        };
        self.file()
            .set_title("Save your Softn app")
            .set_file_name(file_name)
            .add_filter(filter, &[kind.extension()])
            .blocking_save_file()?
            .into_path()
            .ok()
    }

    fn confirm_discard(&self) -> bool {
        let message = self
            .0
            .dialog()
            .message("Close Builder and discard unsaved changes? Save your app first to keep them.")
            .title("Unsaved changes")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Discard and close".into(),
                "Keep editing".into(),
            ));
        #[cfg(desktop)]
        let message = match self.0.get_webview_window("main") {
            Some(main) => message.parent(&main),
            None => message,
        };
        message.blocking_show()
    }
}

fn header<'a>(request: &'a Request<'_>, name: &str) -> Result<&'a str, String> {
    request
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| format!("The request has no {name} header."))
}

fn body<'a>(request: &'a Request<'_>) -> Result<Cow<'a, [u8]>, String> {
    match request.body() {
        InvokeBody::Raw(bytes) => Ok(Cow::Borrowed(bytes)),
        // The postMessage transport sends bytes as a list of numbers.
        InvokeBody::Json(serde_json::Value::Array(values)) => values
            .iter()
            .map(|value| value.as_u64().and_then(|byte| u8::try_from(byte).ok()))
            .collect::<Option<Vec<u8>>>()
            .map(Cow::Owned)
            .ok_or_else(|| "The file's contents are not bytes.".into()),
        _ => Err("The file's contents did not arrive.".into()),
    }
}

/// `encodeURIComponent` undone.
fn percent_decoded(text: &str) -> Option<String> {
    let mut bytes = Vec::with_capacity(text.len());
    let mut rest = text.as_bytes();
    while let Some((&first, tail)) = rest.split_first() {
        if first == b'%' {
            let hex = std::str::from_utf8(tail.get(..2)?).ok()?;
            bytes.push(u8::from_str_radix(hex, 16).ok()?);
            rest = &tail[2..];
        } else {
            bytes.push(first);
            rest = tail;
        }
    }
    String::from_utf8(bytes).ok()
}

/// The open dialog. The reply is the file's handle as JSON, after its length
/// in four bytes (little-endian), then the file; empty when the dialog was closed.
#[tauri::command]
pub async fn open_project(files: State<'_, ProjectFiles>) -> Result<Response, String> {
    let Some((handle, bytes)) = files.open()? else {
        return Ok(Response::new(Vec::new()));
    };
    let head = serde_json::to_vec(&handle).map_err(|e| e.to_string())?;
    let mut reply = Vec::with_capacity(4 + head.len() + bytes.len());
    reply.extend_from_slice(&(head.len() as u32).to_le_bytes());
    reply.extend_from_slice(&head);
    reply.extend_from_slice(&bytes);
    Ok(Response::new(reply))
}

#[tauri::command]
pub async fn use_opened_project(files: State<'_, ProjectFiles>, id: String) -> Result<(), String> {
    files.use_opened(&id)
}

#[tauri::command]
pub async fn forget_project_file(files: State<'_, ProjectFiles>) -> Result<(), String> {
    files.forget();
    Ok(())
}

/// The bytes are the request's body; the file's id is the `softn-file` header.
#[tauri::command]
pub async fn save_project(
    files: State<'_, ProjectFiles>,
    request: Request<'_>,
) -> Result<Option<FileHandle>, String> {
    files.save(header(&request, "softn-file")?, &body(&request)?)
}

/// The bytes are the request's body; `softn-save-kind` and the
/// percent-encoded `softn-save-name` headers say what for and the name to suggest.
#[tauri::command]
pub async fn save_file_as(
    files: State<'_, ProjectFiles>,
    request: Request<'_>,
) -> Result<Option<FileHandle>, String> {
    let kind: SaveKind = serde_json::from_value(serde_json::Value::String(
        header(&request, "softn-save-kind")?.into(),
    ))
    .map_err(|_| "The request does not say what the file is for.".to_string())?;
    let name = percent_decoded(header(&request, "softn-save-name")?)
        .ok_or_else(|| "The suggested file name is not readable.".to_string())?;
    files.save_as(kind, &name, &body(&request)?)
}

#[tauri::command]
pub async fn ask_discard_unsaved(files: State<'_, ProjectFiles>) -> Result<bool, String> {
    Ok(files.ask_discard())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("softn-builder-write-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_save_replaces_the_file_whole_and_leaves_nothing_beside_it() {
        let dir = scratch("whole");
        let project = dir.join("app.softn");
        fs::write(&project, b"before").unwrap();
        let mut backed_up = HashSet::new();
        write_file(&mut backed_up, &project, b"after, longer").unwrap();
        assert_eq!(fs::read(&project).unwrap(), b"after, longer");
        assert_eq!(fs::read(backup_of(&project)).unwrap(), b"before");
        let names: Vec<_> = fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names.len(), 2, "{names:?}");
        let _ = fs::remove_dir_all(&dir);
    }

    /// A save that fails partway leaves the project as it was: it was emptied
    /// first and written where it lay.
    #[test]
    fn a_save_that_fails_leaves_the_project_as_it_was() {
        let dir = scratch("fails");
        let project = dir.join("app.softn");
        fs::write(&project, b"the work of the session").unwrap();
        // The file the save is written into first cannot be made.
        fs::create_dir_all(dir.join(".app.softn.saving")).unwrap();
        let mut backed_up = HashSet::new();
        assert!(write_file(&mut backed_up, &project, b"new").is_err());
        assert_eq!(fs::read(&project).unwrap(), b"the work of the session");
        let _ = fs::remove_dir_all(&dir);
    }
}
