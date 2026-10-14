//! Paths the tests make under the system temp folder. Each is removed, with
//! what is in it, when the test that asked for it ends, passed or failed:
//! libtest runs every test on a thread of its own, and the list is that
//! thread's. Before, every run left a folder behind for each such test
//! (thousands of them, gigabytes, where the suite runs often).
use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

struct Made(Vec<PathBuf>);

/// Gone, or not removable yet. On Windows a database a worker thread of the
/// test's app still holds cannot be deleted until that thread lets it go,
/// which it does just after the test ends: so try again, for a second.
fn remove(path: &Path) -> bool {
    if path.is_dir() {
        return std::fs::remove_dir_all(path).is_ok() || !path.exists();
    }
    // A database file, and the journal SQLite may have left beside it.
    let mut gone = true;
    for suffix in ["", "-wal", "-shm", "-journal"] {
        let mut name = path.as_os_str().to_owned();
        name.push(suffix);
        let name = PathBuf::from(name);
        gone &= std::fs::remove_file(&name).is_ok() || !name.exists();
    }
    gone
}

impl Drop for Made {
    fn drop(&mut self) {
        let deadline = Instant::now() + Duration::from_secs(1);
        let mut left: Vec<PathBuf> = self.0.drain(..).rev().collect();
        while !left.is_empty() {
            left.retain(|path| !remove(path));
            if left.is_empty() || Instant::now() >= deadline {
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }
}

thread_local! {
    static MADE: RefCell<Made> = const { RefCell::new(Made(Vec::new())) };
}

/// `<temp>/<prefix>-<uuid><suffix>`, not created here; removed when this test ends.
pub(crate) fn temp_path(prefix: &str, suffix: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!("{prefix}-{}{suffix}", uuid::Uuid::new_v4()));
    MADE.with(|made| made.borrow_mut().0.push(path.clone()));
    path
}
