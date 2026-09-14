use super::FsBridge;
use std::path::PathBuf;

/// Strip the Windows UNC `\\?\` prefix from canonicalized paths.
/// `std::fs::canonicalize` on Windows returns extended-length paths like
/// `\\?\C:\Users\...`. If the incremental path builder in `reject_symlinks_in_path`
/// doesn't include the `\\?\` prefix, `starts_with` comparisons against the
/// canonical root will fail, causing false rejections. Stripping the prefix
/// normalizes both sides to regular `C:\...` paths for reliable comparison.
/// On non-Windows platforms this is a no-op.
fn strip_unc_prefix(path: PathBuf) -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        let s = path.to_string_lossy();
        if let Some(stripped) = s.strip_prefix(r"\\?\") {
            return PathBuf::from(stripped);
        }
    }
    path
}

pub struct NativeFsBridge {
    root_dir: PathBuf,
}

impl NativeFsBridge {
    pub fn new(root_dir: PathBuf) -> Self {
        Self { root_dir }
    }

    /// Resolve a path relative to root, rejecting traversal, absolute paths,
    /// and symlinks.
    ///
    /// Symlinks are rejected to close TOCTOU (time-of-check to time-of-use)
    /// gaps: without this, a symlink could be swapped between canonicalize()
    /// and the actual fs::read/write, redirecting the operation outside root.
    /// By rejecting symlinks in all existing path components, the only way to
    /// escape the sandbox requires creating a symlink *after* our check and
    /// *before* the kernel opens the file — which requires concurrent write
    /// access to the sandbox directory itself (not possible from scripts).
    fn resolve(&self, path: &str) -> Result<PathBuf, String> {
        // Reject traversal and absolute paths before any filesystem interaction.
        // Absolute (and rooted, and drive-prefixed) paths would make join() ignore
        // the root. The check is by path component, not by substring: `..` as a
        // component is a traversal, `notes..v2.txt` is a file name, and the JS
        // `fs` shim accepts the latter, so this bridge must too.
        {
            use std::path::Component;
            let requested = std::path::Path::new(path);
            if requested.is_absolute()
                || requested.components().any(|c| matches!(c, Component::ParentDir | Component::RootDir | Component::Prefix(_)))
            {
                return Err("Path traversal or absolute path rejected".into());
            }
        }

        let joined = self.root_dir.join(path);

        // Normalize without touching the filesystem: ensure it stays under root.
        // We check both the logical path and (if it exists) the canonical path.
        let canonical_root = strip_unc_prefix(
            std::fs::canonicalize(&self.root_dir)
                .map_err(|e| format!("Root resolve error: {}", e))?,
        );

        if joined.exists() {
            // Reject symlinks anywhere in the path to close TOCTOU gaps.
            self.reject_symlinks_in_path(&joined, &canonical_root)?;

            let canonical = strip_unc_prefix(
                std::fs::canonicalize(&joined)
                    .map_err(|e| format!("Path resolve error: {}", e))?,
            );
            if !canonical.starts_with(&canonical_root) {
                return Err("Path traversal rejected".into());
            }
            Ok(canonical)
        } else {
            // File doesn't exist yet — walk up to find the nearest existing ancestor
            // and verify it's within root. This prevents the exploit where both the
            // file and its parent don't exist, skipping canonicalization entirely.
            let mut ancestor = joined.parent();
            while let Some(dir) = ancestor {
                if dir.exists() {
                    // Check for symlinks in the existing portion of the path
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
            // If no ancestor exists at all (shouldn't happen since root exists),
            // reject as a safety measure
            if ancestor.is_none() {
                return Err("Path resolve error: no valid ancestor".into());
            }
            Ok(joined)
        }
    }

    /// Walk each component of `path` that is inside `canonical_root` and reject
    /// any that are symlinks. Uses `symlink_metadata` (lstat) which does NOT
    /// follow symlinks, so it detects them reliably.
    fn reject_symlinks_in_path(
        &self,
        path: &std::path::Path,
        canonical_root: &std::path::Path,
    ) -> Result<(), String> {
        // Build the path incrementally from root, checking each component
        let canonical_root_components: usize = canonical_root.components().count();
        let mut current = PathBuf::new();
        for (i, component) in path.components().enumerate() {
            current.push(component);
            // Only check components within/below the root directory
            if i >= canonical_root_components && current.exists() {
                let meta = std::fs::symlink_metadata(&current)
                    .map_err(|e| format!("Path check error: {}", e))?;
                if meta.file_type().is_symlink() {
                    return Err("Symlinks are not allowed in sandboxed paths".into());
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

impl FsBridge for NativeFsBridge {
    fn read_file(&self, path: &str) -> Result<String, String> {
        let resolved = self.resolve(path)?;
        std::fs::read_to_string(&resolved)
            .map_err(|e| format!("Read error: {}", e))
    }

    fn write_file(&mut self, path: &str, content: &str) -> Result<(), String> {
        let resolved = self.resolve(path)?;
        self.ensure_parent(&resolved)?;
        std::fs::write(&resolved, content)
            .map_err(|e| format!("Write error: {}", e))
    }

    fn append_file(&mut self, path: &str, content: &str) -> Result<(), String> {
        use std::io::Write;
        let resolved = self.resolve(path)?;
        self.ensure_parent(&resolved)?;
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&resolved)
            .map_err(|e| format!("Append error: {}", e))?;
        file.write_all(content.as_bytes())
            .map_err(|e| format!("Write error: {}", e))
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
            names.push(e.file_name().to_string_lossy().to_string());
        }
        Ok(names)
    }

    fn delete_file(&mut self, path: &str) -> Result<(), String> {
        let resolved = self.resolve(path)?;
        std::fs::remove_file(&resolved)
            .map_err(|e| format!("Delete error: {}", e))
    }

    fn mkdir(&mut self, path: &str) -> Result<(), String> {
        let resolved = self.resolve(path)?;
        std::fs::create_dir_all(&resolved)
            .map_err(|e| format!("Mkdir error: {}", e))
    }
}

#[cfg(test)]
mod tests {
    use super::NativeFsBridge;
    use crate::bridges::FsBridge;

    fn sandbox(tag: &str) -> std::path::PathBuf {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("softn-fs-{}-{}-{}", tag, std::process::id(), nanos));
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
}
