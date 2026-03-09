use formlogic_core::fs_bridge::FsBridge;
use std::path::PathBuf;

pub struct NativeFsBridge {
    root_dir: PathBuf,
}

impl NativeFsBridge {
    pub fn new(root_dir: PathBuf) -> Self {
        Self { root_dir }
    }

    /// Resolve a path relative to root, rejecting traversal.
    /// Does NOT create directories — callers must do that after validation.
    fn resolve(&self, path: &str) -> Result<PathBuf, String> {
        // Reject obvious traversal patterns before any filesystem interaction
        if path.contains("..") {
            return Err("Path traversal rejected".into());
        }

        let joined = self.root_dir.join(path);

        // Normalize without touching the filesystem: ensure it stays under root
        // We check both the logical path and (if it exists) the canonical path
        let canonical_root = std::fs::canonicalize(&self.root_dir)
            .map_err(|e| format!("Root resolve error: {}", e))?;

        if joined.exists() {
            let canonical = std::fs::canonicalize(&joined)
                .map_err(|e| format!("Path resolve error: {}", e))?;
            if !canonical.starts_with(&canonical_root) {
                return Err("Path traversal rejected".into());
            }
            Ok(canonical)
        } else {
            // File doesn't exist yet — validate the parent
            let parent = joined.parent().ok_or("Invalid path")?;
            if parent.exists() {
                let canonical_parent = std::fs::canonicalize(parent)
                    .map_err(|e| format!("Path resolve error: {}", e))?;
                if !canonical_parent.starts_with(&canonical_root) {
                    return Err("Path traversal rejected".into());
                }
            }
            // Return the logical path (caller will create parent dirs if needed)
            Ok(joined)
        }
    }

    /// Ensure parent directory exists for a write operation.
    fn ensure_parent(&self, path: &PathBuf) -> Result<(), String> {
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
        for entry in entries {
            if let Ok(e) = entry {
                names.push(e.file_name().to_string_lossy().to_string());
            }
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
