use formlogic_core::fs_bridge::FsBridge;
use std::path::PathBuf;

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
        // Reject traversal patterns and absolute paths before any filesystem interaction.
        // Absolute paths would cause join() to ignore the root entirely.
        if path.contains("..") || std::path::Path::new(path).is_absolute() {
            return Err("Path traversal or absolute path rejected".into());
        }

        let joined = self.root_dir.join(path);

        // Normalize without touching the filesystem: ensure it stays under root.
        // We check both the logical path and (if it exists) the canonical path.
        let canonical_root = std::fs::canonicalize(&self.root_dir)
            .map_err(|e| format!("Root resolve error: {}", e))?;

        if joined.exists() {
            // Reject symlinks anywhere in the path to close TOCTOU gaps.
            self.reject_symlinks_in_path(&joined, &canonical_root)?;

            let canonical = std::fs::canonicalize(&joined)
                .map_err(|e| format!("Path resolve error: {}", e))?;
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

                    let canonical_ancestor = std::fs::canonicalize(dir)
                        .map_err(|e| format!("Path resolve error: {}", e))?;
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
