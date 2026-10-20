//! The tests of data_identity.rs: which data a bundle may bind, the upgrade question and
//! its answer, the import of the page's registry and the record file kept on disk, driven
//! without a window (the native dialog is replaced by an `ask` the test answers).

use super::*;
use std::cell::RefCell;

const A1: &str = "bundle-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

struct Folder(PathBuf);
impl Folder {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("softn-loader-identity-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Folder(dir)
    }
    fn stored(&self) -> serde_json::Value {
        serde_json::from_slice(&std::fs::read(self.0.join(REGISTRY_FILE)).unwrap()).unwrap()
    }
}
impl Drop for Folder {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// The person chooses `file` and the page reads `bytes` from it; the digest is returned.
fn open(identity: &DataIdentity, file: &str, bytes: &[u8]) -> String {
    let path = PathBuf::from(file);
    identity.bundle_chosen(&path);
    identity.bundle_read(&path, bytes);
    bundle_digest(bytes)
}

/// As `open`, for a digest given outright (the imported registry's are made up).
fn opened_with_digest(identity: &DataIdentity, file: &str, digest: &str) {
    identity.bundle_chosen(Path::new(file));
    let mut state = identity.lock();
    state.page_ran_bundle = true;
    state.open.digest = Some(digest.to_string());
}

fn never(_: &Question) -> Answer {
    panic!("a question was put")
}

#[test]
fn the_digest_is_the_one_the_page_computes() {
    // SHA-256 of "abc", as `crypto.subtle.digest` gives it.
    assert_eq!(bundle_digest(b"abc"), "bundle-ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    assert!(is_bundle_id(&bundle_digest(b"")));
    for id in ["_default", "", "bundle-", "bundle-ABC", "../apps/bundle-x", &format!("{}0", A1), &A1.to_uppercase()] {
        assert!(!is_bundle_id(id), "{:?}", id);
    }
}

#[test]
fn a_bundle_uses_its_own_data_unasked_and_nothing_else_without_a_yes() {
    let folder = Folder::new("own");
    let identity = DataIdentity::open(&folder.0);
    let a = open(&identity, "notes.softn", b"notes v1");
    assert_eq!(identity.decide_bind(&a, &a, never), Ok(()));
    assert_eq!(identity.require(Some(&a)), Ok(a.clone()));
    // Recorded as an installation this side knows, with the file it was opened from.
    assert_eq!(folder.stored()["installations"][&a]["file"], "notes.softn");

    let b = open(&identity, "funny-cats.softn", b"something else");
    // A had been bound and stays bound until B binds: A's last writes still land in A.
    assert_eq!(identity.require(Some(&a)), Ok(a.clone()));
    let asked = RefCell::new(0);
    let refused = identity.decide_bind(&b, &a, |question| {
        *asked.borrow_mut() += 1;
        assert!(question.text.contains("funny-cats.softn"), "{}", question.text);
        Answer::Cancel
    });
    assert!(refused.is_err());
    assert_eq!(*asked.borrow(), 1);
    // Asking again and again does not raise the dialog again.
    assert!(identity.decide_bind(&b, &a, never).is_err());
    assert_eq!(identity.decide_bind(&b, &b, never), Ok(()));
    assert!(identity.require(Some(&a)).is_err(), "B is open now; A's id is refused");
    assert_eq!(identity.require(Some(&b)), Ok(b.clone()));
}

#[test]
fn a_data_call_must_name_the_data_bound_now() {
    let folder = Folder::new("require");
    let identity = DataIdentity::open(&folder.0);
    assert!(identity.require(Some(A1)).is_err(), "nothing bound yet");
    let a = open(&identity, "a.softn", b"a");
    identity.decide_bind(&a, &a, never).unwrap();
    assert!(identity.require(None).is_err(), "no id is the shared default database, not this app's");
    assert!(identity.require(Some("")).is_err());
    assert!(identity.require(Some(A1)).is_err());
    assert!(identity.require(Some(&format!(" {}", a))).is_err());
    assert_eq!(identity.require(Some(&a)), Ok(a));
}

#[test]
fn only_the_bytes_of_the_chosen_file_are_the_open_bundle() {
    let folder = Folder::new("chosen");
    let identity = DataIdentity::open(&folder.0);
    let a = open(&identity, "a.softn", b"a");
    identity.decide_bind(&a, &a, never).unwrap();
    identity.bundle_chosen(Path::new("b.softn"));
    // The page reads A again (it was opened before, so it may) and asks to bind it.
    identity.bundle_read(Path::new("a.softn"), b"a");
    assert!(identity.decide_bind(&a, &a, never).unwrap_err().contains("No app was opened"));
    identity.bundle_read(Path::new("b.softn"), b"b");
    assert!(identity.decide_bind(&a, &a, never).unwrap_err().contains("not the app that was opened"));
    let b = bundle_digest(b"b");
    assert_eq!(identity.decide_bind(&b, &b, never), Ok(()));
    // The same file read again with other bytes is another bundle.
    identity.bundle_read(Path::new("b.softn"), b"b changed");
    assert!(identity.decide_bind(&b, &b, never).is_err());
}

#[test]
fn an_upgrade_is_the_persons_yes_in_the_native_question_and_it_is_kept() {
    let folder = Folder::new("upgrade");
    let identity = DataIdentity::open(&folder.0);
    let v1 = open(&identity, r"C:\Apps\notes-1.softn", b"notes 1");
    identity.prepare_bind(&v1, &v1, Some("Notes"), Some("1.0"), false).unwrap();
    let v2 = open(&identity, r"C:\Apps\notes-2.softn", b"notes 2");
    let text = RefCell::new(String::new());
    let choice = identity.decide_choose(&v2, &[v1.clone()], |question| {
        *text.borrow_mut() = format!("{}\n{}", question.title, question.text);
        assert!(question.offer_new);
        Answer::UseData
    });
    assert_eq!(choice, Ok(Choice::Upgrade { data_id: v1.clone() }));
    let text = text.into_inner();
    assert!(text.contains("Open the new version of \"Notes\" with the data of the version you had?"), "{}", text);
    assert!(text.contains("notes-2.softn") && text.contains("version 1.0") && text.contains("notes-1.softn"), "{}", text);
    assert_eq!(identity.bound(), Some(v1.clone()));
    // The page's flow binds again before its backup and before it starts the app: no question.
    assert_eq!(identity.decide_bind(&v2, &v1, never), Ok(()));
    // The same question asked again in this open is answered as before, unasked.
    assert_eq!(identity.decide_choose(&v2, &[v1.clone()], never), Ok(Choice::Upgrade { data_id: v1.clone() }));

    // Kept: a later run opens the new version on that data without asking.
    drop(identity);
    let identity = DataIdentity::open(&folder.0);
    let again = open(&identity, r"C:\Apps\notes-2.softn", b"notes 2");
    assert_eq!(identity.decide_bind(&again, &v1, never), Ok(()));
    // And the old version still reaches it too.
    let old = open(&identity, r"C:\Apps\notes-1.softn", b"notes 1");
    assert_eq!(identity.decide_bind(&old, &v1, never), Ok(()));
}

#[test]
fn open_as_new_and_cancel_bind_nothing_of_the_installed_app() {
    let folder = Folder::new("new");
    let identity = DataIdentity::open(&folder.0);
    let v1 = open(&identity, "notes.softn", b"1");
    identity.decide_bind(&v1, &v1, never).unwrap();
    let other = open(&identity, "notes-copy.softn", b"2");
    assert_eq!(identity.decide_choose(&other, &[v1.clone()], |_| Answer::New), Ok(Choice::New));
    assert!(identity.decide_bind(&other, &v1, never).is_err(), "a no stands for this open");
    assert_eq!(identity.decide_bind(&other, &other, never), Ok(()));
    let third = open(&identity, "notes-3.softn", b"3");
    assert_eq!(identity.decide_choose(&third, &[v1.clone()], |_| Answer::Cancel), Ok(Choice::Cancel));
    assert_eq!(identity.bound(), Some(other.clone()), "nothing new was bound");
    // Choosing the file again asks afresh.
    let third = open(&identity, "notes-3.softn", b"3");
    assert_eq!(identity.decide_choose(&third, &[v1.clone()], |_| Answer::UseData), Ok(Choice::Upgrade { data_id: v1 }));
}

#[test]
fn a_candidate_this_side_does_not_know_is_not_offered() {
    let folder = Folder::new("unknown");
    let identity = DataIdentity::open(&folder.0);
    let b = open(&identity, "b.softn", b"b");
    // The page names data ids it read from its registry; only installations recorded here
    // are offered, and the bundle's own id is not an upgrade of itself.
    assert_eq!(identity.decide_choose(&b, &[A1.to_string(), b.clone()], never), Ok(Choice::New));
    assert!(identity.decide_bind(&b, A1, never).unwrap_err().contains("No installed app"));
    assert!(identity.decide_bind(&b, "_default", never).is_err());
}

#[test]
fn an_answer_given_while_another_file_was_chosen_counts_for_neither() {
    let folder = Folder::new("race");
    let identity = DataIdentity::open(&folder.0);
    let v1 = open(&identity, "v1.softn", b"1");
    identity.decide_bind(&v1, &v1, never).unwrap();
    let v2 = open(&identity, "v2.softn", b"2");
    let outcome = identity.decide_choose(&v2, &[v1.clone()], |_| {
        open(&identity, "v3.softn", b"3");
        Answer::UseData
    });
    assert!(outcome.unwrap_err().contains("another app was opened"));
    assert_eq!(identity.bound(), Some(v1.clone()));
    assert!(!folder.stored()["installations"][&v1]["bundles"].as_array().unwrap().iter().any(|d| d == &serde_json::json!(v2)));
}

/// The page's registry as src/installations.ts writes it today: an installation, an
/// upgrade completed in the page, an upgrade approved but not yet started, a record in
/// recovery, and damaged records.
fn todays_registry() -> (String, [String; 7]) {
    let d = |c: char| format!("bundle-{}", c.to_string().repeat(64));
    let (notes, notes2, todo, todo2, cards, bad, lone) = (d('1'), d('2'), d('3'), d('4'), d('5'), d('6'), d('7'));
    let registry = serde_json::json!({
        "version": 1,
        "revision": 7,
        "installations": {
            notes.clone(): {
                "dataId": notes, "name": "Notes", "bundleIds": [notes, notes2], "version": "2.0",
                "createdAt": "2026-09-01T00:00:00.000Z", "updatedAt": "2026-09-14T00:00:00.000Z",
                "ledger": [{ "from": null, "to": notes, "at": "2026-09-01T00:00:00.000Z" }, { "from": notes, "to": notes2, "at": "2026-09-14T00:00:00.000Z", "backup": "C:/x/pre-upgrade-1.sqlite" }]
            },
            todo.clone(): {
                "dataId": todo, "name": "Todo", "bundleIds": [todo],
                "createdAt": "2026-09-01T00:00:00.000Z", "updatedAt": "2026-09-01T00:00:00.000Z", "ledger": [],
                "pendingUpgrade": { "from": todo, "to": todo2, "backup": "C:/x/pre-upgrade-2.sqlite", "at": "2026-09-20T00:00:00.000Z" }
            },
            cards.clone(): {
                "dataId": cards, "name": "Cards", "bundleIds": [cards],
                "recoveryRequired": { "backup": "C:/x/pre-upgrade-3.sqlite", "reason": "disk full", "at": "2026-09-21T00:00:00.000Z" }
            },
            // Damaged: the data id does not match its key.
            bad.clone(): { "dataId": lone, "name": "Bad", "bundleIds": [bad] },
            // Damaged: the mapping is not a list of digests.
            lone.clone(): { "dataId": lone, "name": "Lone", "bundleIds": "everything" },
            // Damaged: a key that is not a digest, which would name the shared database.
            "_default": { "dataId": "_default", "name": "Default", "bundleIds": [lone] }
        }
    });
    (registry.to_string(), [notes, notes2, todo, todo2, cards, bad, lone])
}

#[test]
fn the_page_registry_is_imported_once_in_todays_shape() {
    let folder = Folder::new("import");
    let identity = DataIdentity::open(&folder.0);
    let (raw, [notes, notes2, todo, todo2, cards, bad, lone]) = todays_registry();
    assert_eq!(identity.import_page_registry(Some(&raw)), Ok(ImportSummary { imported: 3, skipped: 3 }));
    let stored = folder.stored();
    assert_eq!(stored["pageRegistryImported"], true);
    assert_eq!(stored["installations"][&notes]["bundles"], serde_json::json!([notes, notes2]));
    assert_eq!(stored["installations"][&notes]["name"], "Notes");
    // An upgrade the person approved in the page and that has not started yet resumes.
    assert_eq!(stored["installations"][&todo]["bundles"], serde_json::json!([todo, todo2]));
    assert_eq!(stored["installations"][&cards]["bundles"], serde_json::json!([cards]));
    for left_out in [&bad, &lone, &"_default".to_string()] {
        assert!(stored["installations"].get(left_out.as_str()).is_none(), "{} was imported", left_out);
    }

    // What was imported opens as before, unasked: both versions of Notes reach Notes' data,
    // and the approved Todo upgrade reaches Todo's.
    opened_with_digest(&identity, "notes-2.softn", &notes2);
    assert_eq!(identity.decide_bind(&notes2, &notes, never), Ok(()));
    opened_with_digest(&identity, "notes-1.softn", &notes);
    assert_eq!(identity.decide_bind(&notes, &notes, never), Ok(()));
    opened_with_digest(&identity, "todo-2.softn", &todo2);
    assert_eq!(identity.decide_bind(&todo2, &todo, never), Ok(()));
    // The damaged records gave nothing: the bundle they named gets only its own data.
    opened_with_digest(&identity, "bad.softn", &bad);
    assert!(identity.decide_bind(&bad, &lone, never).is_err());
    assert_eq!(identity.decide_bind(&bad, &bad, never), Ok(()));

    // Never again, in this run or the next.
    assert!(identity.import_page_registry(Some(&raw)).is_err());
    drop(identity);
    let identity = DataIdentity::open(&folder.0);
    assert!(identity.import_page_registry(Some(&raw)).unwrap_err().contains("no longer taken from the page"));
}

#[test]
fn no_import_after_a_bundle_reached_the_page() {
    let (raw, _) = todays_registry();
    // A bundle read in this run, then an import.
    let folder = Folder::new("late-import");
    let identity = DataIdentity::open(&folder.0);
    identity.bundle_chosen(Path::new("x.softn"));
    assert!(identity.import_page_registry(Some(&raw)).is_ok(), "chosen but not yet read: the page has run nothing");
    let folder = Folder::new("late-import-2");
    let identity = DataIdentity::open(&folder.0);
    open(&identity, "x.softn", b"x");
    assert!(identity.import_page_registry(Some(&raw)).unwrap_err().contains("before the installation records were imported"));
    // And not in the next run either: the record says so.
    drop(identity);
    let identity = DataIdentity::open(&folder.0);
    assert!(identity.import_page_registry(Some(&raw)).is_err());
    // Bytes handed over another way count the same.
    let folder = Folder::new("late-import-3");
    let identity = DataIdentity::open(&folder.0);
    identity.bundle_handed_over();
    assert!(identity.import_page_registry(Some(&raw)).is_err());
}

#[test]
fn an_empty_missing_or_unreadable_page_registry_imports_nothing_and_closes_the_import() {
    for raw in [None, Some(""), Some("{not json"), Some("{\"version\":2,\"installations\":{}}"), Some("[]")] {
        let folder = Folder::new("empty-import");
        let identity = DataIdentity::open(&folder.0);
        assert_eq!(identity.import_page_registry(raw), Ok(ImportSummary { imported: 0, skipped: 0 }), "{:?}", raw);
        assert!(identity.import_page_registry(Some(&todays_registry().0)).is_err(), "{:?}", raw);
    }
}

#[test]
fn a_damaged_record_file_is_kept_aside_and_takes_no_import() {
    let folder = Folder::new("damaged-file");
    std::fs::write(folder.0.join(REGISTRY_FILE), b"{ half written").unwrap();
    let identity = DataIdentity::open(&folder.0);
    let kept: Vec<_> = std::fs::read_dir(&folder.0)
        .unwrap()
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_name().to_string_lossy().starts_with("installations.json.damaged-"))
        .collect();
    assert_eq!(kept.len(), 1);
    assert_eq!(std::fs::read(kept[0].path()).unwrap(), b"{ half written");
    assert!(identity.import_page_registry(Some(&todays_registry().0)).is_err());
    let a = open(&identity, "a.softn", b"a");
    assert_eq!(identity.decide_bind(&a, &a, never), Ok(()));
}

/// With the record set aside, an app's data is still reached: by the bundle whose digest
/// names its folder, as always, and by a later version after the person says yes again.
#[test]
fn a_record_set_aside_is_rebuilt_from_the_data_folders() {
    let folder = Folder::new("rebuilt");
    let v1 = bundle_digest(b"notes 1");
    std::fs::create_dir_all(folder.0.join("apps").join(&v1)).unwrap();
    std::fs::create_dir_all(folder.0.join("apps").join("_default")).unwrap();
    std::fs::write(folder.0.join(REGISTRY_FILE), b"\0\0\0").unwrap();
    let identity = DataIdentity::open(&folder.0);
    let installations = folder.stored()["installations"].clone();
    assert_eq!(installations.as_object().unwrap().keys().collect::<Vec<_>>(), vec![&v1]);
    let v2 = open(&identity, "notes-2.softn", b"notes 2");
    let asked = RefCell::new(String::new());
    assert_eq!(
        identity.decide_bind(&v2, &v1, |question| {
            *asked.borrow_mut() = question.text.clone();
            Answer::UseData
        }),
        Ok(())
    );
    assert!(asked.borrow().contains("an app you opened before"), "{}", asked.borrow());
}

/// Once the runtime has started the app on its data, what runs in the page may be the
/// bundle: it cannot move the binding to other data, even data this bundle was let use
/// before, nor raise the question at a moment of its choosing.
#[test]
fn a_started_app_binds_no_other_data_and_raises_no_question() {
    let folder = Folder::new("started");
    let identity = DataIdentity::open(&folder.0);
    let bank = open(&identity, "bank.softn", b"bank");
    identity.prepare_bind(&bank, &bank, Some("Bank"), None, true).unwrap();
    let e = open(&identity, "bank-2.softn", b"bank 2");
    // E was let use Bank's data once (the yes stands even if that upgrade was undone).
    assert_eq!(identity.decide_choose(&e, &[bank.clone()], |_| Answer::UseData), Ok(Choice::Upgrade { data_id: bank.clone() }));
    let e = open(&identity, "bank-2.softn", b"bank 2");
    // This time the runtime's flow opened E on its own data and started it there.
    assert_eq!(identity.decide_bind_for(&e, &e, true, never), Ok(()));
    // Now the page asks to switch to Bank's data, which E was let use: refused unasked.
    assert!(identity.decide_bind_for(&e, &bank, false, never).unwrap_err().starts_with("Refused"));
    assert!(identity.decide_bind_for(&e, &bank, true, never).unwrap_err().starts_with("Refused"));
    assert!(identity.decide_choose(&e, &[bank.clone()], never).unwrap_err().starts_with("Refused"));
    assert_eq!(identity.require(Some(&e)), Ok(e.clone()));
    // The same data again is fine (a reload of the page binds it again).
    assert_eq!(identity.decide_bind_for(&e, &e, true, never), Ok(()));
    // The file read again with other bytes does not make a new open.
    identity.bundle_read(Path::new("bank-2.softn"), b"bank 3");
    assert!(identity.decide_bind_for(&bundle_digest(b"bank 3"), &bundle_digest(b"bank 3"), true, never).is_err());
    // Choosing the file again starts over.
    let e = open(&identity, "bank-2.softn", b"bank 2");
    assert_eq!(identity.decide_bind_for(&e, &bank, true, never), Ok(()));
}

/// Every way the page's flow (src/upgradeFlow.ts) binds data before it starts the app:
/// a restore or backup binds first, and the start binds the same data, or after a recovery
/// the question may still be put.
#[test]
fn the_runtime_flow_binds_before_it_starts_and_starts_on_one_data_id() {
    let folder = Folder::new("flow");
    let identity = DataIdentity::open(&folder.0);
    let x = open(&identity, "notes-1.softn", b"1");
    identity.prepare_bind(&x, &x, Some("Notes"), None, true).unwrap();
    // Upgrade: the question binds X, the backup binds X, the start binds X.
    let d = open(&identity, "notes-2.softn", b"2");
    assert_eq!(identity.decide_choose(&d, &[x.clone()], |_| Answer::UseData), Ok(Choice::Upgrade { data_id: x.clone() }));
    assert_eq!(identity.decide_bind_for(&d, &x, false, never), Ok(()));
    assert_eq!(identity.decide_bind_for(&d, &x, true, never), Ok(()));
    // Recovery of a failed upgrade: the restore binds X, then the package that failed is no
    // longer mapped in the page and the question is put again; it opens as new.
    let d = open(&identity, "notes-2.softn", b"2");
    assert_eq!(identity.decide_bind_for(&d, &x, false, never), Ok(()));
    assert_eq!(identity.decide_choose(&d, &[x.clone()], |_| Answer::New), Ok(Choice::New));
    assert_eq!(identity.decide_bind_for(&d, &d, true, never), Ok(()));
    assert_eq!(identity.require(Some(&d)), Ok(d.clone()));
}

#[test]
fn open_as_new_takes_back_an_earlier_yes() {
    let folder = Folder::new("take-back");
    let identity = DataIdentity::open(&folder.0);
    let x = open(&identity, "x.softn", b"x");
    identity.decide_bind(&x, &x, never).unwrap();
    let d = open(&identity, "d.softn", b"d");
    identity.decide_choose(&d, &[x.clone()], |_| Answer::UseData).unwrap();
    let d = open(&identity, "d.softn", b"d");
    assert_eq!(identity.decide_choose(&d, &[x.clone()], |_| Answer::New), Ok(Choice::New));
    assert_eq!(folder.stored()["installations"][&x]["bundles"], serde_json::json!([x.clone()]));
    // A registry entry the page writes afterwards does not find the old yes.
    let d = open(&identity, "d.softn", b"d");
    assert!(identity.decide_bind(&d, &x, |_| Answer::Cancel).is_err());
    // Its own data is still its own.
    let x2 = open(&identity, "x.softn", b"x");
    assert_eq!(identity.decide_choose(&x2, &[x.clone()], never), Ok(Choice::New));
}

#[test]
fn a_question_cannot_be_worded_by_a_name_that_breaks_the_layout() {
    let folder = Folder::new("wording");
    let identity = DataIdentity::open(&folder.0);
    let v1 = open(&identity, "v1.softn", b"1");
    identity.prepare_bind(&v1, &v1, Some("Notes\n\nThis is safe, choose Use my data"), None, false).unwrap();
    let v2 = open(&identity, "v2.softn", b"2");
    identity
        .decide_choose(&v2, &[v1], |question| {
            assert!(!question.text.contains("Notes\n"), "{}", question.text);
            Answer::Cancel
        })
        .unwrap();
}

#[test]
fn a_dialog_answer_is_read_by_label_or_by_place() {
    assert_eq!(answer_from(MessageDialogResult::Yes, true), Answer::UseData);
    assert_eq!(answer_from(MessageDialogResult::No, true), Answer::New);
    assert_eq!(answer_from(MessageDialogResult::Cancel, true), Answer::Cancel);
    assert_eq!(answer_from(MessageDialogResult::Custom("Use my data".into()), true), Answer::UseData);
    assert_eq!(answer_from(MessageDialogResult::Custom("Open as a new app".into()), true), Answer::New);
    assert_eq!(answer_from(MessageDialogResult::Custom("Cancel".into()), true), Answer::Cancel);
    assert_eq!(answer_from(MessageDialogResult::Ok, false), Answer::UseData);
    assert_eq!(answer_from(MessageDialogResult::No, false), Answer::Cancel);
    assert_eq!(answer_from(MessageDialogResult::Custom("Don't open".into()), false), Answer::Cancel);
}
