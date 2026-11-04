//! What SoftN says when it cannot open its own data as it starts.
//!
//! XDB's databases are opened in Tauri's setup, before any window is shown. A release build
//! has no console, and Tauri ends the process when setup fails, so a default database that is
//! damaged, or a data folder that cannot be written, left SoftN doing nothing at all each time
//! it was opened. The failure is put to the person in a native dialog instead (lib.rs,
//! `open_local_data`); this module holds the words and the setting aside, so they can be tested.

use std::path::{Path, PathBuf};

/// SQLite's own words for a file it cannot read as a database (SQLITE_NOTADB and
/// SQLITE_CORRUPT), as rusqlite reports them. A damaged row of the file's own schema is
/// SQLITE_CORRUPT in words of its own: "malformed database schema (idx) - invalid rootpage".
const DAMAGED: [&str; 3] = ["file is not a database", "database disk image is malformed", "malformed database schema"];

/// The label of the button that sets a damaged file aside.
pub const SET_ASIDE: &str = "Set it aside and start";
/// The label of the button that leaves everything as it is.
pub const QUIT: &str = "Quit";

/// Whether SQLite refused the file itself as damaged, rather than the disk or the folder.
pub fn looks_damaged(error: &str) -> bool {
    DAMAGED.iter().any(|words| error.contains(words))
}

/// The database and the files SQLite keeps beside it, each with the name it is set aside
/// under: `data.sqlite` becomes `data.sqlite.damaged-<stamp>`, and its `-wal`, `-shm` and
/// `-journal` files take the same stamp. A new database would read an old one's write-ahead
/// log as its own, and SQLite deletes a rollback journal it finds beside an empty database:
/// either may be what mends the damaged one.
pub fn aside_names(file: &Path, stamp: u64) -> Vec<(PathBuf, PathBuf)> {
    ["", "-wal", "-shm", "-journal"]
        .iter()
        .map(|suffix| {
            let mut from = file.as_os_str().to_owned();
            from.push(suffix);
            let mut to = file.as_os_str().to_owned();
            to.push(format!(".damaged-{stamp}{suffix}"));
            (PathBuf::from(from), PathBuf::from(to))
        })
        .collect()
}

/// Why the files could not be set aside, and those already moved that could not be put back either:
/// still set aside, under these names.
#[derive(Debug)]
pub struct NotSetAside {
    pub error: std::io::Error,
    pub left: Vec<PathBuf>,
}

/// Renames the database and those of its `-wal`, `-shm` and `-journal` files that are there. Nothing is
/// deleted and nothing is written over: if a name is taken, or a file cannot be moved, what
/// was already moved is put back and the error returned, with what could not be put back.
pub fn set_aside(file: &Path, stamp: u64) -> Result<Vec<(PathBuf, PathBuf)>, NotSetAside> {
    let mut moved = Vec::new();
    for (from, to) in aside_names(file, stamp) {
        if !from.exists() {
            continue;
        }
        let step = if to.exists() {
            Err(std::io::Error::new(std::io::ErrorKind::AlreadyExists, format!("{} is already there", to.display())))
        } else {
            std::fs::rename(&from, &to)
        };
        if let Err(error) = step {
            return Err(NotSetAside { error, left: put_back(&moved) });
        }
        moved.push((from, to));
    }
    Ok(moved)
}

/// What is said when files set aside could not all be put back: where they are, and that they go back
/// before SoftN is opened again (a new database made beside them would lose a log they need).
pub fn still_aside_text(left: &[PathBuf]) -> String {
    let names: Vec<String> = left.iter().map(|path| path.display().to_string()).collect();
    format!(
        "SoftN could not put its data back as it was. Still set aside:\n\n{}\n\n\
         Rename each back, without its .damaged-… part, before opening SoftN again.",
        names.join("\n")
    )
}

/// Puts back what `set_aside` moved. The names it could not put back, which are still set aside.
pub fn put_back(moved: &[(PathBuf, PathBuf)]) -> Vec<PathBuf> {
    moved.iter().rev().filter(|(from, to)| std::fs::rename(to, from).is_err()).map(|(_, to)| to.clone()).collect()
}

/// When SoftN still cannot start after setting the files aside: what that start made under
/// their names (a new database, and its `-wal` and `-shm` if it got that far) is removed, as it
/// holds nothing of the person's, and the old files are put back. Left there, a new database's
/// write-ahead log would be read as the old file's own, and its first checkpoint would write
/// into the file the person was told is left as it was. The names not put back, as `put_back`.
pub fn undo(file: &Path, stamp: u64, moved: &[(PathBuf, PathBuf)]) -> Vec<PathBuf> {
    for (made, _) in aside_names(file, stamp) {
        let _ = std::fs::remove_file(made);
    }
    put_back(moved)
}

/// The name the file will be set aside under, for the dialog.
pub fn aside_name(file: &Path, stamp: u64) -> String {
    aside_names(file, stamp)[0].1.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

/// The question put when SQLite refuses the default database itself.
pub fn damaged_text(file: &Path, stamp: u64, error: &str) -> String {
    format!(
        "SoftN could not open its data file, which looks damaged:\n\n{}\n\n({})\n\n\
         SoftN can set the file aside in the same folder, renamed {}, and start with a new one. \
         Nothing is deleted, but what was kept in that file is not in SoftN unless the file is put back.",
        file.display(),
        error,
        aside_name(file, stamp)
    )
}

/// What is said when the data cannot be opened for any other reason (a full disk, a folder
/// that cannot be written, a file another program holds), or setting aside did not help.
pub fn cannot_open_text(folder: Option<&Path>, error: &str) -> String {
    let place = folder.map(|f| format!(" in this folder:\n\n{}", f.display())).unwrap_or_else(|| ".".to_string());
    format!(
        "SoftN could not open its data{place}\n\n({error})\n\n\
         Check that the disk has room, that the folder can be written to, and that no other program has the file open, then open SoftN again."
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("softn-loader-startup-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn only_sqlites_words_for_a_damaged_file_count_as_damage() {
        assert!(looks_damaged("Failed to initialize XDB database: SQLite error: file is not a database"));
        assert!(looks_damaged("Failed to initialize XDB database: SQLite error: database disk image is malformed"));
        assert!(looks_damaged("Failed to initialize XDB database: SQLite error: malformed database schema (idx_collection) - invalid rootpage"));
        for other in [
            "Failed to initialize XDB database: SQLite error: disk I/O error",
            "Failed to initialize XDB database: SQLite error: database or disk is full",
            "Failed to initialize XDB database: SQLite error: unable to open database file",
            "Failed to initialize XDB database: SQLite error: database is locked",
            "Access is denied. (os error 5)",
        ] {
            assert!(!looks_damaged(other), "{other}");
        }
    }

    #[test]
    fn a_damaged_file_and_its_journal_are_set_aside_together_and_nothing_is_lost() {
        let dir = scratch("aside");
        let file = dir.join("data.sqlite");
        std::fs::write(&file, b"not a database").unwrap();
        std::fs::write(dir.join("data.sqlite-wal"), b"its journal").unwrap();
        std::fs::write(dir.join("data.sqlite-journal"), b"its rollback journal").unwrap();
        let moved = set_aside(&file, 7).unwrap();
        assert_eq!(moved.len(), 3, "the file, its -wal and its -journal; there was no -shm");
        assert!(!file.exists() && !dir.join("data.sqlite-wal").exists() && !dir.join("data.sqlite-journal").exists());
        assert_eq!(std::fs::read(dir.join("data.sqlite.damaged-7")).unwrap(), b"not a database");
        assert_eq!(std::fs::read(dir.join("data.sqlite.damaged-7-wal")).unwrap(), b"its journal");
        assert_eq!(std::fs::read(dir.join("data.sqlite.damaged-7-journal")).unwrap(), b"its rollback journal");
        assert!(put_back(&moved).is_empty());
        assert_eq!(std::fs::read(&file).unwrap(), b"not a database");
        assert_eq!(std::fs::read(dir.join("data.sqlite-wal")).unwrap(), b"its journal");
        assert_eq!(std::fs::read(dir.join("data.sqlite-journal")).unwrap(), b"its rollback journal");
        assert!(!dir.join("data.sqlite.damaged-7").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_start_that_fails_after_setting_aside_leaves_the_old_files_and_none_of_the_new() {
        let dir = scratch("undo");
        let file = dir.join("data.sqlite");
        std::fs::write(&file, b"damaged").unwrap();
        let moved = set_aside(&file, 7).unwrap();
        // What the second start made before it failed: a new database in WAL mode.
        std::fs::write(&file, b"new").unwrap();
        std::fs::write(dir.join("data.sqlite-wal"), b"the new one's log").unwrap();
        std::fs::write(dir.join("data.sqlite-shm"), b"its index").unwrap();
        assert!(undo(&file, 7, &moved).is_empty());
        assert_eq!(std::fs::read(&file).unwrap(), b"damaged");
        let mut names: Vec<_> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name()).collect();
        names.sort();
        assert_eq!(names, ["data.sqlite"], "no new log beside the old file, and nothing still set aside");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_name_already_taken_is_not_written_over_and_nothing_is_left_half_moved() {
        let dir = scratch("taken");
        let file = dir.join("data.sqlite");
        std::fs::write(&file, b"damaged").unwrap();
        std::fs::write(dir.join("data.sqlite-wal"), b"journal").unwrap();
        std::fs::write(dir.join("data.sqlite.damaged-7-wal"), b"set aside before").unwrap();
        let refused = set_aside(&file, 7).err().expect("refused");
        assert_eq!(refused.error.kind(), std::io::ErrorKind::AlreadyExists);
        assert!(refused.left.is_empty(), "everything moved was put back");
        assert!(still_aside_text(&[dir.join("data.sqlite.damaged-7")]).contains("data.sqlite.damaged-7"));
        assert_eq!(std::fs::read(&file).unwrap(), b"damaged", "the file moved first is back");
        assert_eq!(std::fs::read(dir.join("data.sqlite-wal")).unwrap(), b"journal");
        assert_eq!(std::fs::read(dir.join("data.sqlite.damaged-7-wal")).unwrap(), b"set aside before");
        assert!(!dir.join("data.sqlite.damaged-7").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_dialogs_name_the_file_or_folder_and_what_sqlite_said() {
        let file = Path::new("C:/data/apps/_default/data.sqlite");
        let text = damaged_text(file, 9, "SQLite error: file is not a database");
        assert!(text.contains("data.sqlite.damaged-9") && text.contains("file is not a database") && text.contains("Nothing is deleted"));
        assert!(text.contains(&file.display().to_string()));
        let text = cannot_open_text(Some(Path::new("C:/data")), "SQLite error: database or disk is full");
        assert!(text.contains("C:/data") && text.contains("database or disk is full") && text.contains("room"));
        assert!(cannot_open_text(None, "no folder").starts_with("SoftN could not open its data."));
    }
}
