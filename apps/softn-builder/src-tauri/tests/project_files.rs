//! What page code can do with files, through the IPC the Builder's window
//! has. The preview draws a bundle into that window, so the page is not
//! trusted: these tests call the commands the way any script in it could.
//! The dialogs are answered by `Person`; the native ones are not run here.

use softn_builder_lib::{with_commands, Dialogs, ProjectFiles, SaveKind};
use std::{
    collections::VecDeque,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tauri::{
    http::HeaderMap,
    ipc::{CallbackFn, InvokeBody, InvokeResponseBody},
    test::{get_ipc_response, mock_builder, MockRuntime, INVOKE_KEY},
    webview::InvokeRequest,
    App, Manager, WebviewWindow,
};
use tauri_plugin_fs::FsExt;

/// A folder of the test's own, removed when the test ends.
struct Scratch(PathBuf);

impl Scratch {
    fn join(&self, name: impl AsRef<Path>) -> PathBuf {
        self.0.join(name)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn scratch(name: &str) -> Scratch {
    let dir = std::env::temp_dir().join(format!("softn-builder-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    Scratch(dir)
}

/// The person at the dialogs: each dialog takes the next answer.
#[derive(Clone, Default)]
struct Person(Arc<Mutex<Answers>>);

#[derive(Default)]
struct Answers {
    picks: VecDeque<Option<PathBuf>>,
    suggested: Vec<(SaveKind, String)>,
    discard: bool,
}

impl Person {
    fn picks(&self, path: impl AsRef<Path>) {
        self.0
            .lock()
            .unwrap()
            .picks
            .push_back(Some(path.as_ref().to_path_buf()));
    }
    fn closes_the_dialog(&self) {
        self.0.lock().unwrap().picks.push_back(None);
    }
    fn next(&self) -> Option<PathBuf> {
        self.0
            .lock()
            .unwrap()
            .picks
            .pop_front()
            .expect("a dialog the test did not expect")
    }
}

impl Dialogs for Person {
    fn pick_bundle(&self) -> Option<PathBuf> {
        self.next()
    }
    fn pick_destination(&self, kind: SaveKind, file_name: &str) -> Option<PathBuf> {
        self.0
            .lock()
            .unwrap()
            .suggested
            .push((kind, file_name.to_owned()));
        self.next()
    }
    fn confirm_discard(&self) -> bool {
        self.0.lock().unwrap().discard
    }
}

/// The app as `run()` builds it, from the same config and capability, with `Person` at the dialogs.
fn app() -> (App<MockRuntime>, WebviewWindow<MockRuntime>, Person) {
    let app = with_commands(mock_builder())
        .build(tauri::generate_context!())
        .expect("the app builds");
    let person = Person::default();
    app.manage(ProjectFiles::with_limit(Box::new(person.clone()), 64));
    let main = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .expect("the main window");
    (app, main, person)
}

fn invoke(
    main: &WebviewWindow<MockRuntime>,
    cmd: &str,
    body: InvokeBody,
    headers: HeaderMap,
) -> Result<InvokeResponseBody, serde_json::Value> {
    get_ipc_response(
        main,
        InvokeRequest {
            cmd: cmd.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: if cfg!(windows) {
                "http://tauri.localhost"
            } else {
                "tauri://localhost"
            }
            .parse()
            .unwrap(),
            body,
            headers,
            invoke_key: INVOKE_KEY.into(),
        },
    )
}

fn json(reply: InvokeResponseBody) -> serde_json::Value {
    reply.deserialize().expect("a JSON reply")
}

/// `open_project`: the handle and the bytes, or None when the dialog was closed.
fn open(
    main: &WebviewWindow<MockRuntime>,
) -> Result<Option<(serde_json::Value, Vec<u8>)>, serde_json::Value> {
    let InvokeResponseBody::Raw(reply) = invoke(
        main,
        "open_project",
        InvokeBody::default(),
        HeaderMap::new(),
    )?
    else {
        panic!("open_project replies with bytes");
    };
    if reply.is_empty() {
        return Ok(None);
    }
    let length = u32::from_le_bytes(reply[..4].try_into().unwrap()) as usize;
    let handle = serde_json::from_slice(&reply[4..4 + length]).unwrap();
    Ok(Some((handle, reply[4 + length..].to_vec())))
}

fn use_opened(
    main: &WebviewWindow<MockRuntime>,
    id: &serde_json::Value,
) -> Result<(), serde_json::Value> {
    invoke(
        main,
        "use_opened_project",
        InvokeBody::Json(serde_json::json!({ "id": id })),
        HeaderMap::new(),
    )
    .map(|_| ())
}

/// `save_project`: the handle written, or null when that is not the project's file.
fn save(
    main: &WebviewWindow<MockRuntime>,
    id: &serde_json::Value,
    bytes: &[u8],
) -> serde_json::Value {
    let mut headers = HeaderMap::new();
    headers.insert("softn-file", id.as_str().unwrap().parse().unwrap());
    json(
        invoke(
            main,
            "save_project",
            InvokeBody::Raw(bytes.to_vec()),
            headers,
        )
        .expect("save_project answers"),
    )
}

fn save_as(
    main: &WebviewWindow<MockRuntime>,
    kind: &str,
    name: &str,
    bytes: &[u8],
) -> Result<serde_json::Value, serde_json::Value> {
    let mut headers = HeaderMap::new();
    headers.insert("softn-save-kind", kind.parse().unwrap());
    headers.insert("softn-save-name", name.parse().unwrap());
    invoke(
        main,
        "save_file_as",
        InvokeBody::Raw(bytes.to_vec()),
        headers,
    )
    .map(json)
}

#[test]
fn page_code_cannot_write_a_file_saved_earlier_through_the_fs_plugin() {
    let dir = scratch("fs-plugin");
    let earlier = dir.join("Earlier.softn");
    fs::write(&earlier, b"saved earlier").unwrap();
    let (app, main, _) = app();
    // The person saved Earlier.softn, then opened a stranger's bundle. The
    // dialog plugin adds every file picked in it to the fs scope
    // (tauri-plugin-dialog, commands.rs), where it stays for the session.
    if let Some(scope) = app.try_fs_scope() {
        scope.allow_file(&earlier).unwrap();
        scope.allow_file(dir.join("Stranger.softn")).unwrap();
    }
    let mut headers = HeaderMap::new();
    headers.insert("path", earlier.to_str().unwrap().parse().unwrap());
    let written = invoke(
        &main,
        "plugin:fs|write_file",
        InvokeBody::Raw(b"overwritten".to_vec()),
        headers,
    );
    assert!(
        written.is_err(),
        "the page wrote a file it was not given for this project"
    );
    assert_eq!(fs::read(&earlier).unwrap(), b"saved earlier");
}

#[test]
fn page_code_cannot_open_a_dialog_of_its_own() {
    let (_app, main, _) = app();
    // Without arguments the command itself would refuse them; refused first, it never runs.
    for command in [
        "plugin:dialog|open",
        "plugin:dialog|save",
        "plugin:dialog|message",
    ] {
        let refused = invoke(&main, command, InvokeBody::default(), HeaderMap::new()).unwrap_err();
        assert!(
            refused.to_string().contains("not allowed"),
            "{command}: {refused}"
        );
    }
}

#[test]
fn a_file_saved_earlier_cannot_be_written_once_another_project_is_open() {
    let dir = scratch("earlier");
    let (_app, main, person) = app();
    let mine = dir.join("Mine.softn");
    fs::write(&mine, b"mine as opened").unwrap();
    person.picks(&mine);
    let (handle, bytes) = open(&main).unwrap().unwrap();
    assert_eq!(bytes, b"mine as opened");
    use_opened(&main, &handle["id"]).unwrap();
    assert_eq!(
        save(&main, &handle["id"], b"mine saved")["path"],
        handle["path"]
    );

    // A stranger's bundle, opened next: its code knows (or guesses) the id of the file before.
    let stranger = dir.join("Stranger.softn");
    fs::write(&stranger, b"stranger").unwrap();
    person.picks(&stranger);
    let (theirs, _) = open(&main).unwrap().unwrap();
    use_opened(&main, &theirs["id"]).unwrap();
    assert!(save(&main, &handle["id"], b"overwritten").is_null());
    assert_eq!(fs::read(&mine).unwrap(), b"mine saved");
    // Its own file is the project now open, which Save writes.
    assert_eq!(
        save(&main, &theirs["id"], b"theirs saved")["id"],
        theirs["id"]
    );
    assert_eq!(fs::read(&stranger).unwrap(), b"theirs saved");
    // The bundle picked earlier cannot be taken up again either.
    assert!(use_opened(&main, &handle["id"]).is_err());
}

#[test]
fn a_bundle_picked_but_not_opened_leaves_the_project_its_file() {
    let dir = scratch("declined");
    let (_app, main, person) = app();
    let mine = dir.join("Mine.softn");
    fs::write(&mine, b"mine").unwrap();
    person.picks(&mine);
    let (handle, _) = open(&main).unwrap().unwrap();
    use_opened(&main, &handle["id"]).unwrap();
    // Picked, then not opened: "Open a new project? Unsaved changes will be lost." answered no.
    let other = dir.join("Other.softn");
    fs::write(&other, b"other").unwrap();
    person.picks(&other);
    let (picked, _) = open(&main).unwrap().unwrap();
    assert!(!save(&main, &handle["id"], b"mine saved").is_null());
    assert!(save(&main, &picked["id"], b"overwritten").is_null());
    assert_eq!(fs::read(&other).unwrap(), b"other");
}

#[test]
fn a_new_project_has_no_file() {
    let dir = scratch("forget");
    let (_app, main, person) = app();
    let mine = dir.join("Mine.softn");
    fs::write(&mine, b"mine").unwrap();
    person.picks(&mine);
    let (handle, _) = open(&main).unwrap().unwrap();
    use_opened(&main, &handle["id"]).unwrap();
    invoke(
        &main,
        "forget_project_file",
        InvokeBody::default(),
        HeaderMap::new(),
    )
    .unwrap();
    assert!(save(&main, &handle["id"], b"overwritten").is_null());
    assert_eq!(fs::read(&mine).unwrap(), b"mine");
}

#[test]
fn opens_only_a_softn_file_within_the_limit_and_a_closed_dialog_opens_nothing() {
    let dir = scratch("open");
    let (_app, main, person) = app();
    person.closes_the_dialog();
    assert!(open(&main).unwrap().is_none());

    let secret = dir.join("secret.txt");
    fs::write(&secret, b"secret").unwrap();
    person.picks(&secret);
    assert!(open(&main)
        .unwrap_err()
        .to_string()
        .contains("Choose a .softn file"));

    let large = dir.join("Large.softn");
    fs::write(&large, [0u8; 65]).unwrap();
    person.picks(&large);
    assert!(open(&main).unwrap_err().to_string().contains("too large"));

    let upper = dir.join("Upper.SOFTN");
    fs::write(&upper, [1u8; 64]).unwrap();
    person.picks(&upper);
    assert_eq!(open(&main).unwrap().unwrap().1, [1u8; 64]);
}

#[test]
fn keeps_what_the_file_held_when_it_was_chosen_however_often_it_is_written() {
    let dir = scratch("backup");
    let (_app, main, person) = app();
    let mine = dir.join("Mine.softn");
    fs::write(&mine, b"as opened").unwrap();
    person.picks(&mine);
    let (handle, _) = open(&main).unwrap().unwrap();
    use_opened(&main, &handle["id"]).unwrap();
    save(&main, &handle["id"], b"bad write");
    save(&main, &handle["id"], b"second bad write");
    assert_eq!(fs::read(&mine).unwrap(), b"second bad write");
    assert_eq!(fs::read(dir.join("Mine.softn.bak")).unwrap(), b"as opened");

    // Opened again to undo it, and saved: the copy is still the file before the Builder wrote it.
    person.picks(&mine);
    let (again, _) = open(&main).unwrap().unwrap();
    use_opened(&main, &again["id"]).unwrap();
    save(&main, &again["id"], b"saved again");
    person.picks(&mine);
    save_as(&main, "project", "Mine", b"saved as").unwrap();
    assert_eq!(fs::read(dir.join("Mine.softn.bak")).unwrap(), b"as opened");
}

#[test]
fn save_as_writes_where_the_person_picked_and_that_file_becomes_the_projects() {
    let dir = scratch("save-as");
    let (_app, main, person) = app();
    // Typed without the extension: it is added, and nothing else is written.
    person.picks(dir.join("Notes"));
    let saved = save_as(&main, "project", "..%2F..%2FNotes.softn", b"notes").unwrap();
    assert_eq!(saved["name"], "Notes.softn");
    assert_eq!(fs::read(dir.join("Notes.softn")).unwrap(), b"notes");
    assert!(!dir.join("Notes").exists());
    assert_eq!(
        person.0.lock().unwrap().suggested,
        [(SaveKind::Project, "Notes.softn".to_owned())]
    );
    assert_eq!(save(&main, &saved["id"], b"notes again")["id"], saved["id"]);

    // Typed without the extension where a file with it already is: the dialog never asked to replace that one.
    person.picks(dir.join("Notes"));
    assert!(save_as(&main, "project", "Notes", b"replaced")
        .unwrap_err()
        .to_string()
        .contains("already exists"));
    assert_eq!(fs::read(dir.join("Notes.softn")).unwrap(), b"notes again");

    // A closed dialog writes nothing.
    person.closes_the_dialog();
    assert!(save_as(&main, "project", "Notes", b"x").unwrap().is_null());
}

#[test]
fn an_export_is_a_copy_unless_the_project_has_no_file_and_a_recovery_file_is_never_the_projects() {
    let dir = scratch("export");
    let (_app, main, person) = app();
    // No file yet: the export is where the project is kept.
    person.picks(dir.join("Kept.softn"));
    let kept = save_as(&main, "export", "Kept", b"v1").unwrap();
    assert_eq!(save(&main, &kept["id"], b"v2")["id"], kept["id"]);

    // A copy beside it is not the project's file.
    person.picks(dir.join("Copy.softn"));
    let copy = save_as(&main, "export", "Kept", b"copy").unwrap();
    assert!(save(&main, &copy["id"], b"overwritten").is_null());
    assert_eq!(fs::read(dir.join("Copy.softn")).unwrap(), b"copy");

    // Exported over its own file: that is the project's file still, by the same id.
    person.picks(dir.join("Kept.softn"));
    assert_eq!(
        save_as(&main, "export", "Kept", b"v3").unwrap()["id"],
        kept["id"]
    );

    person.picks(dir.join("session.json"));
    let recovery = save_as(&main, "recovery", "session.json", b"{}").unwrap();
    assert_eq!(recovery["name"], "session.json");
    assert!(save(&main, &recovery["id"], b"overwritten").is_null());
    assert_eq!(save(&main, &kept["id"], b"v4")["id"], kept["id"]);
}

#[test]
fn the_close_question_is_asked_by_rust_with_its_own_words() {
    let (_app, main, person) = app();
    let ask = || {
        json(
            invoke(
                &main,
                "ask_discard_unsaved",
                InvokeBody::default(),
                HeaderMap::new(),
            )
            .unwrap(),
        )
    };
    assert_eq!(ask(), false);
    person.0.lock().unwrap().discard = true;
    assert_eq!(ask(), true);
}
