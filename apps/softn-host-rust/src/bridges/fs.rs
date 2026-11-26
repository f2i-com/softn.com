use super::FsBridge;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// Strip the Windows UNC `\\?\` prefix from canonicalized paths while
/// preserving `\\?\UNC\server\share` as `\\server\share`.
fn strip_unc_prefix(path: PathBuf) -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        let s = path.to_string_lossy();
        if let Some(unc) = s.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{unc}"));
        }
        if let Some(stripped) = s.strip_prefix(r"\\?\") {
            return PathBuf::from(stripped);
        }
    }
    path
}

fn is_windows_reserved_name(segment: &str) -> bool {
    let trimmed = segment.trim_end_matches([' ', '.']);
    let stem = trimmed.split('.').next().unwrap_or("");
    matches!(
        stem.to_ascii_uppercase().as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    )
}

const MAX_SANDBOX_FILE_BYTES: usize = 64 * 1024 * 1024;
const MAX_SANDBOX_TOTAL_BYTES: u64 = 256 * 1024 * 1024;
const MAX_SANDBOX_ENTRIES: usize = 4096;
const MAX_LIST_DIR_ENTRIES: usize = 10_000;
const MAX_PATH_BYTES: usize = 1024;
const MAX_PATH_DEPTH: usize = 32;
/// The longest name the common filesystems take. A longer one fails only when it is tried, by
/// which time `create_dir_all` has made the directories above it.
const MAX_PATH_SEGMENT_BYTES: usize = 255;

#[derive(Default)]
struct FsUsageState {
    cached: Option<(u64, usize)>,
}

/// Per-app filesystem write serialization & incremental disk-quota guard shared across all
/// worker threads of an app/tenant.
#[derive(Default)]
pub struct FsQuota {
    state: Mutex<FsUsageState>,
}

impl FsQuota {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }
}

fn dir_usage(root: &Path) -> Result<(u64, usize), String> {
    let mut total_bytes: u64 = 0;
    let mut entries: usize = 0;
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let rd = match std::fs::read_dir(&dir) {
            Ok(rd) => rd,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(format!("Quota scan error: {}", e)),
        };
        for item in rd.flatten() {
            let path = item.path();
            let meta = match std::fs::symlink_metadata(&path) {
                Ok(m) => m,
                Err(_) => continue,
            };
            if meta.file_type().is_symlink() {
                continue;
            }
            entries += 1;
            if entries > MAX_SANDBOX_ENTRIES {
                return Ok((total_bytes, entries));
            }
            if meta.is_dir() {
                stack.push(path);
            } else if meta.is_file() {
                total_bytes = total_bytes.saturating_add(meta.len());
            }
        }
    }
    Ok((total_bytes, entries))
}

pub struct NativeFsBridge {
    root_dir: PathBuf,
    canonical_root: Option<PathBuf>,
    quota: Arc<FsQuota>,
}

impl NativeFsBridge {
    #[allow(dead_code)]
    pub fn new(root_dir: PathBuf) -> Self {
        Self::with_quota(root_dir, FsQuota::new())
    }

    pub fn with_quota(root_dir: PathBuf, quota: Arc<FsQuota>) -> Self {
        let canonical_root = std::fs::canonicalize(&root_dir).ok().map(strip_unc_prefix);
        Self {
            root_dir,
            canonical_root,
            quota,
        }
    }

    fn canonical_root(&self) -> Result<PathBuf, String> {
        if let Some(ref c) = self.canonical_root {
            return Ok(c.clone());
        }
        std::fs::canonicalize(&self.root_dir)
            .map(strip_unc_prefix)
            .map_err(|e| format!("Root resolve error: {}", e))
    }

    /// Resolve a path relative to root, rejecting traversal, absolute paths,
    /// Windows Alternate Data Streams (`:`), Windows reserved device names,
    /// NUL bytes, excessive depth/length, and symlinks (including dangling).
    fn resolve(&self, path: &str) -> Result<PathBuf, String> {
        if path.len() > MAX_PATH_BYTES {
            return Err("Path exceeds maximum length".into());
        }
        if path.contains('\0') {
            return Err("NUL byte in path rejected".into());
        }
        {
            use std::path::Component;
            let requested = std::path::Path::new(path);
            if requested.is_absolute() {
                return Err("Path traversal or absolute path rejected".into());
            }
            let mut depth = 0usize;
            for c in requested.components() {
                match c {
                    Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                        return Err("Path traversal or absolute path rejected".into());
                    }
                    Component::Normal(s) => {
                        depth += 1;
                        if depth > MAX_PATH_DEPTH {
                            return Err("Path exceeds maximum directory depth".into());
                        }
                        let seg = s.to_string_lossy();
                        if seg.contains(':') || is_windows_reserved_name(&seg) {
                            return Err("Reserved or invalid path segment rejected".into());
                        }
                        if seg.len() > MAX_PATH_SEGMENT_BYTES {
                            return Err("Path segment exceeds maximum length".into());
                        }
                    }
                    Component::CurDir => {}
                }
            }
        }

        // Canonicalize root first and join onto it so component counts always match.
        let canonical_root = self.canonical_root()?;
        let joined = canonical_root.join(path);

        // Always walk every component under canonical_root with symlink_metadata
        // (lstat) BEFORE exists(), catching dangling symlinks too.
        self.reject_symlinks_in_path(&joined, &canonical_root)?;

        if joined.exists() {
            let canonical = strip_unc_prefix(
                std::fs::canonicalize(&joined)
                    .map_err(|e| format!("Path resolve error: {}", e))?,
            );
            if !canonical.starts_with(&canonical_root) {
                return Err("Path traversal rejected".into());
            }
            Ok(canonical)
        } else {
            let mut ancestor = joined.parent();
            while let Some(dir) = ancestor {
                if dir.exists() {
                    self.reject_symlinks_in_path(dir, &canonical_root)?;

                    let canonical_ancestor = strip_unc_prefix(
                        std::fs::canonicalize(dir)
                            .map_err(|e| format!("Path resolve error: {}", e))?,
                    );
                    if !canonical_ancestor.starts_with(&canonical_root) {
                        return Err("Path traversal rejected".into());
                    }
                    break;
                }
                ancestor = dir.parent();
            }
            if ancestor.is_none() {
                return Err("Path resolve error: no valid ancestor".into());
            }
            Ok(joined)
        }
    }

    /// Walk each component of `path` that is inside `canonical_root` and reject
    /// any that are symlinks (including dangling symlinks). Uses `symlink_metadata`
    /// directly rather than `exists()`, because `exists()` follows symlinks and
    /// returns false for dangling targets.
    fn reject_symlinks_in_path(
        &self,
        path: &std::path::Path,
        canonical_root: &std::path::Path,
    ) -> Result<(), String> {
        let canonical_root_components: usize = canonical_root.components().count();
        let mut current = PathBuf::new();
        for (i, component) in path.components().enumerate() {
            current.push(component);
            if i >= canonical_root_components {
                match std::fs::symlink_metadata(&current) {
                    Ok(meta) => {
                        if meta.file_type().is_symlink() {
                            return Err("Symlinks are not allowed in sandboxed paths".into());
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => break,
                    Err(e) => return Err(format!("Path check error: {}", e)),
                }
            }
        }
        Ok(())
    }

    /// Ensure parent directory exists for a write operation.
    fn ensure_parent(&self, path: &std::path::Path) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("mkdir failed: {}", e))?;
        }
        Ok(())
    }
}

#[cfg(unix)]
pub(crate) const fn unix_o_nofollow() -> i32 {
    #[cfg(any(
        target_os = "macos",
        target_os = "ios",
        target_os = "freebsd",
        target_os = "openbsd",
        target_os = "netbsd",
        target_os = "dragonfly"
    ))]
    {
        0x0100
    }
    #[cfg(all(
        target_os = "linux",
        any(target_arch = "aarch64", target_arch = "arm", target_arch = "powerpc", target_arch = "powerpc64")
    ))]
    {
        0o100000
    }
    #[cfg(all(
        target_os = "linux",
        not(any(target_arch = "aarch64", target_arch = "arm", target_arch = "powerpc", target_arch = "powerpc64"))
    ))]
    {
        0o400000
    }
    #[cfg(not(any(
        target_os = "linux",
        target_os = "macos",
        target_os = "ios",
        target_os = "freebsd",
        target_os = "openbsd",
        target_os = "netbsd",
        target_os = "dragonfly"
    )))]
    {
        0
    }
}

fn open_nofollow(opts: &mut std::fs::OpenOptions, path: &Path) -> std::io::Result<std::fs::File> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let flag = unix_o_nofollow();
        if flag != 0 {
            opts.custom_flags(flag);
        }
    }
    opts.open(path)
}

impl FsBridge for NativeFsBridge {
    fn read_file(&self, path: &str) -> Result<String, String> {
        let resolved = self.resolve(path)?;
        let mut opts = std::fs::OpenOptions::new();
        opts.read(true);
        let file = open_nofollow(&mut opts, &resolved)
            .map_err(|e| format!("Read error: {}", e))?;
        let mut buf = Vec::new();
        file.take(MAX_SANDBOX_FILE_BYTES as u64 + 1)
            .read_to_end(&mut buf)
            .map_err(|e| format!("Read error: {}", e))?;
        if buf.len() > MAX_SANDBOX_FILE_BYTES {
            return Err("File exceeds sandbox size limit".into());
        }
        String::from_utf8(buf).map_err(|e| format!("Read error: {}", e))
    }

    fn write_file(&mut self, path: &str, content: &str) -> Result<(), String> {
        use std::io::Write;
        if content.len() > MAX_SANDBOX_FILE_BYTES {
            return Err("File content exceeds sandbox size limit".into());
        }
        let mut usage_guard = self.quota.state.lock().unwrap_or_else(|e| e.into_inner());
        let resolved = self.resolve(path)?;
        let canonical_root = self.canonical_root()?;
        let (used_bytes, used_entries) = match usage_guard.cached {
            Some(pair) => pair,
            None => {
                let pair = dir_usage(&canonical_root)?;
                usage_guard.cached = Some(pair);
                pair
            }
        };
        let existing_meta = std::fs::symlink_metadata(&resolved).ok();
        let existing_len = existing_meta.as_ref().map(|m| m.len()).unwrap_or(0);
        let missing_dirs = resolved
            .parent()
            .map(|p| count_missing_ancestors(&canonical_root, p))
            .unwrap_or(0);
        let new_entries = missing_dirs.saturating_add(if existing_meta.is_some() { 0 } else { 1 });
        if used_entries.saturating_add(new_entries) > MAX_SANDBOX_ENTRIES {
            return Err("Sandbox file count quota exceeded".into());
        }
        let next_total = used_bytes
            .saturating_sub(existing_len)
            .saturating_add(content.len() as u64);
        if next_total > MAX_SANDBOX_TOTAL_BYTES {
            return Err("Sandbox total storage quota exceeded".into());
        }
        // Some of the directories may have been made before the one that failed: count
        // again next time, as `mkdir` does, or they are never held against the entry quota.
        if let Err(e) = self.ensure_parent(&resolved) {
            usage_guard.cached = None;
            return Err(e);
        }
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        let mut file = match open_nofollow(&mut opts, &resolved) {
            Ok(f) => f,
            Err(e) => {
                if missing_dirs > 0 {
                    usage_guard.cached = None;
                }
                return Err(format!("Write error: {}", e));
            }
        };
        if let Err(e) = file.write_all(content.as_bytes()) {
            usage_guard.cached = None;
            return Err(format!("Write error: {}", e));
        }
        usage_guard.cached = Some((next_total, used_entries.saturating_add(new_entries)));
        Ok(())
    }

    fn append_file(&mut self, path: &str, content: &str) -> Result<(), String> {
        use std::io::Write;
        if content.len() > MAX_SANDBOX_FILE_BYTES {
            return Err("File content exceeds sandbox size limit".into());
        }
        let mut usage_guard = self.quota.state.lock().unwrap_or_else(|e| e.into_inner());
        let resolved = self.resolve(path)?;
        let canonical_root = self.canonical_root()?;
        let (used_bytes, used_entries) = match usage_guard.cached {
            Some(pair) => pair,
            None => {
                let pair = dir_usage(&canonical_root)?;
                usage_guard.cached = Some(pair);
                pair
            }
        };
        let existing_meta = std::fs::symlink_metadata(&resolved).ok();
        let existing_len = existing_meta.as_ref().map(|m| m.len()).unwrap_or(0);
        if existing_len.saturating_add(content.len() as u64) > MAX_SANDBOX_FILE_BYTES as u64 {
            return Err("File would exceed sandbox size limit".into());
        }
        let missing_dirs = resolved
            .parent()
            .map(|p| count_missing_ancestors(&canonical_root, p))
            .unwrap_or(0);
        let new_entries = missing_dirs.saturating_add(if existing_meta.is_some() { 0 } else { 1 });
        if used_entries.saturating_add(new_entries) > MAX_SANDBOX_ENTRIES {
            return Err("Sandbox file count quota exceeded".into());
        }
        let next_total = used_bytes.saturating_add(content.len() as u64);
        if next_total > MAX_SANDBOX_TOTAL_BYTES {
            return Err("Sandbox total storage quota exceeded".into());
        }
        if let Err(e) = self.ensure_parent(&resolved) {
            usage_guard.cached = None;
            return Err(e);
        }
        let mut opts = std::fs::OpenOptions::new();
        opts.create(true).append(true);
        let mut file = match open_nofollow(&mut opts, &resolved) {
            Ok(f) => f,
            Err(e) => {
                if missing_dirs > 0 {
                    usage_guard.cached = None;
                }
                return Err(format!("Append error: {}", e));
            }
        };
        if let Err(e) = file.write_all(content.as_bytes()) {
            usage_guard.cached = None;
            return Err(format!("Write error: {}", e));
        }
        usage_guard.cached = Some((next_total, used_entries.saturating_add(new_entries)));
        Ok(())
    }

    fn exists(&self, path: &str) -> bool {
        self.resolve(path).map(|p| p.exists()).unwrap_or(false)
    }

    fn list_dir(&self, path: &str) -> Result<Vec<String>, String> {
        let resolved = self.resolve(path)?;
        let entries = std::fs::read_dir(&resolved)
            .map_err(|e| format!("List error: {}", e))?;
        let mut names = Vec::new();
        for e in entries.flatten() {
            if names.len() >= MAX_LIST_DIR_ENTRIES {
                return Err(format!(
                    "Directory exceeds maximum listing limit ({})",
                    MAX_LIST_DIR_ENTRIES
                ));
            }
            names.push(e.file_name().to_string_lossy().to_string());
        }
        Ok(names)
    }

    fn delete_file(&mut self, path: &str) -> Result<(), String> {
        let mut usage_guard = self.quota.state.lock().unwrap_or_else(|e| e.into_inner());
        let resolved = self.resolve(path)?;
        let prev_len = std::fs::symlink_metadata(&resolved).map(|m| m.len()).unwrap_or(0);
        std::fs::remove_file(&resolved)
            .map_err(|e| format!("Delete error: {}", e))?;
        if let Some((used_bytes, used_entries)) = usage_guard.cached {
            usage_guard.cached = Some((
                used_bytes.saturating_sub(prev_len),
                used_entries.saturating_sub(1),
            ));
        }
        Ok(())
    }

    fn mkdir(&mut self, path: &str) -> Result<(), String> {
        let mut usage_guard = self.quota.state.lock().unwrap_or_else(|e| e.into_inner());
        let resolved = self.resolve(path)?;
        let canonical_root = self.canonical_root()?;
        let (used_bytes, used_entries) = match usage_guard.cached {
            Some(pair) => pair,
            None => {
                let pair = dir_usage(&canonical_root)?;
                usage_guard.cached = Some(pair);
                pair
            }
        };
        let new_dirs = count_missing_ancestors(&canonical_root, &resolved);
        if used_entries.saturating_add(new_dirs) > MAX_SANDBOX_ENTRIES {
            return Err("Sandbox file count quota exceeded".into());
        }
        if new_dirs > 0 {
            if let Err(e) = std::fs::create_dir_all(&resolved) {
                usage_guard.cached = None;
                return Err(format!("Mkdir error: {}", e));
            }
            usage_guard.cached = Some((used_bytes, used_entries.saturating_add(new_dirs)));
        }
        Ok(())
    }
}

/// Count how many missing directory entries `create_dir_all(target)` will create
/// under `canonical_root` (inclusive of `target`).
fn count_missing_ancestors(canonical_root: &Path, target: &Path) -> usize {
    let mut missing = 0usize;
    let mut cur = target;
    while cur != canonical_root && !cur.exists() {
        missing = missing.saturating_add(1);
        match cur.parent() {
            Some(parent) => cur = parent,
            None => break,
        }
    }
    missing
}

#[cfg(test)]
mod tests {
    use super::NativeFsBridge;
    use crate::bridges::FsBridge;

    fn sandbox(tag: &str) -> std::path::PathBuf {
        let dir = crate::test_dirs::temp_path(&format!("softn-fs-{tag}"), "");
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn dots_inside_a_name_are_a_name_and_traversal_is_a_component() {
        let dir = sandbox("dots");
        let mut fs = NativeFsBridge::new(dir.clone());
        fs.write_file("notes..v2.txt", "kept").unwrap();
        assert_eq!(fs.read_file("notes..v2.txt").unwrap(), "kept");
        fs.write_file("drafts/..hidden", "also kept").unwrap();
        assert_eq!(fs.read_file("drafts/..hidden").unwrap(), "also kept");
        assert!(fs.exists("notes..v2.txt"));
        for bad in ["../escape.txt", "drafts/../../escape.txt", "a/../b.txt", "..", "/rooted.txt"] {
            assert!(fs.write_file(bad, "no").is_err(), "{bad} was accepted");
            assert!(!fs.exists(bad), "{bad} exists");
        }
        assert!(!dir.parent().unwrap().join("escape.txt").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The bytes and entries the quota believes the sandbox holds.
    fn counted(fs: &NativeFsBridge) -> Option<(u64, usize)> {
        fs.quota.state.lock().unwrap().cached
    }

    /// A name no filesystem takes is refused before the directories above it are made. It
    /// used to fail in `create_dir_all`, after them, and they were never counted: a script
    /// could make directories without end under a quota of 4,096 entries.
    #[test]
    fn a_name_too_long_to_make_is_refused_before_the_directories_above_it() {
        let dir = sandbox("long");
        let mut fs = NativeFsBridge::new(dir.clone());
        let long = "x".repeat(256);
        for path in [format!("made/{long}/f.txt"), format!("made/sub/{long}")] {
            assert!(fs.write_file(&path, "no").is_err());
            assert!(fs.append_file(&path, "no").is_err());
            assert!(fs.mkdir(&path).is_err());
            assert!(!fs.exists(&path));
        }
        assert!(!dir.join("made").exists());
        fs.write_file("made/f.txt", "kept").unwrap();
        assert_eq!(counted(&fs), Some((4, 2)));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// When making a file's directories fails part way, the ones made are counted: the usage
    /// is read from the disk again, as after a failed `mkdir`. Windows has names that are
    /// well-formed paths and still cannot be made, which is how this fails there.
    #[cfg(windows)]
    #[test]
    fn directories_made_before_a_write_fails_are_counted() {
        let dir = sandbox("partial");
        let mut fs = NativeFsBridge::new(dir.clone());
        fs.write_file("first.txt", "1").unwrap();
        assert_eq!(counted(&fs), Some((1, 1)));
        assert!(fs.write_file("made/a*b/f.txt", "no").is_err());
        assert!(dir.join("made").is_dir());
        assert_eq!(counted(&fs), None);
        assert!(fs.append_file("more/a*b/f.txt", "no").is_err());
        assert!(dir.join("more").is_dir());
        assert_eq!(counted(&fs), None);
        fs.write_file("second.txt", "2").unwrap();
        assert_eq!(counted(&fs), Some((2, 4)));
        std::fs::remove_dir_all(&dir).ok();
    }
}
