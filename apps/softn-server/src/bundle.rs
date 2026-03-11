use serde::Deserialize;
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

#[derive(Debug, Deserialize)]
pub struct ServerManifest {
    pub name: String,
    pub version: String,
    pub main: Option<String>,
    pub files: Option<HashMap<String, Vec<String>>>,
    pub server: Option<ServerBlock>,
    pub config: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
pub struct ServerBlock {
    pub entry: Option<String>,
    pub scripts: Option<Vec<String>>,
    pub routes: Option<Vec<RouteDefinition>>,
    #[allow(dead_code)]
    pub permissions: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RouteDefinition {
    pub method: String,
    pub path: String,
    pub handler: String,
    /// If true, this route does not require auth even when `auth_token` is set.
    /// Defaults to false (authenticated). Use for public-facing endpoints like
    /// webhooks or health checks exposed through the script layer.
    #[serde(default)]
    pub public: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ServerConfig {
    pub auth_token: Option<String>,
}

/// Console shim prepended to server scripts so `console.log` etc. work.
/// Logs stream directly to the Rust tracing subscriber via `env.log()` —
/// no JS-side buffering, so runaway logging cannot cause OOM.
pub const SERVER_SHIM: &str = r#"
function __fmt(a, b, c, d, e, f, g, h, i, j) {
    let s = '' + a;
    if (b !== undefined) { s = s + ' ' + b; }
    if (c !== undefined) { s = s + ' ' + c; }
    if (d !== undefined) { s = s + ' ' + d; }
    if (e !== undefined) { s = s + ' ' + e; }
    if (f !== undefined) { s = s + ' ' + f; }
    if (g !== undefined) { s = s + ' ' + g; }
    if (h !== undefined) { s = s + ' ' + h; }
    if (i !== undefined) { s = s + ' ' + i; }
    if (j !== undefined) { s = s + ' ' + j; }
    return s;
}
let console = {
    log: function(a, b, c, d, e, f, g, h, i, j) { env.log('INFO', __fmt(a, b, c, d, e, f, g, h, i, j)); },
    warn: function(a, b, c, d, e, f, g, h, i, j) { env.log('WARN', __fmt(a, b, c, d, e, f, g, h, i, j)); },
    error: function(a, b, c, d, e, f, g, h, i, j) { env.log('ERROR', __fmt(a, b, c, d, e, f, g, h, i, j)); },
    info: function(a, b, c, d, e, f, g, h, i, j) { env.log('INFO', __fmt(a, b, c, d, e, f, g, h, i, j)); },
};
"#;

/// Extract a `.softn` ZIP bundle to a directory.
/// Returns the path to the extracted directory. The caller is responsible for
/// using this path as the bundle_path for all subsequent operations.
///
/// Uses a two-phase extract-then-rename strategy to prevent race conditions:
/// if the old server is still running and serving files from the previous
/// extraction directory, extracting to a temp directory first and then
/// renaming ensures the old directory remains intact until the new one is
/// fully ready. The old directory is removed only after the rename succeeds.
pub fn extract_softn_zip(zip_path: &Path) -> Result<PathBuf, String> {
    let file = fs::File::open(zip_path)
        .map_err(|e| format!("Failed to open {}: {}", zip_path.display(), e))?;

    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("Invalid .softn bundle: {}", e))?;

    let stem = zip_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("bundle");
    let parent = zip_path.parent().unwrap_or(Path::new("."));
    let final_dir = parent.join(format!("{}_bundle", stem));

    // Phase 1: Extract into a temporary sibling directory.
    // If we crash mid-extraction, only the temp dir is left (easily cleaned up),
    // and any existing extraction at final_dir remains untouched.
    let temp_dir = parent.join(format!("{}_bundle_new", stem));
    if temp_dir.exists() {
        fs::remove_dir_all(&temp_dir)
            .map_err(|e| format!("Failed to clean temp extract dir: {}", e))?;
    }

    const MAX_ENTRIES: usize = 10_000;
    const MAX_TOTAL_BYTES: u64 = 500 * 1024 * 1024;
    const MAX_FILE_BYTES: u64 = 50 * 1024 * 1024;

    if archive.len() > MAX_ENTRIES {
        return Err(format!("Bundle has too many files ({})", archive.len()));
    }

    let mut total_bytes: u64 = 0;
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("Failed to read ZIP entry: {}", e))?;

        // Security: reject symlinks to prevent sandbox escapes. A malicious
        // ZIP can contain a symlink entry pointing to `../../etc/shadow`;
        // extracting it would create a symlink inside the bundle directory
        // that, when followed, reads/writes outside the sandbox.
        if entry.is_symlink() {
            tracing::warn!("Skipping symlink ZIP entry: {}", entry.name());
            continue;
        }

        // Use enclosed_name() as the primary zip-slip defense. It returns None
        // for entries that would escape the extraction directory (absolute paths,
        // excessive `..` traversal, null bytes, Windows drive prefixes, etc.).
        // This is the zip crate's recommended approach — it handles edge cases
        // that manual string checks can miss (e.g. `foo/../../../../etc/passwd`
        // where the `..` count exceeds the depth of preceding directories).
        let safe_name = match entry.enclosed_name() {
            Some(name) => name.to_owned(),
            None => {
                tracing::warn!("Skipping unsafe ZIP entry: {}", entry.name());
                continue;
            }
        };

        if entry.is_dir() {
            fs::create_dir_all(temp_dir.join(&safe_name))
                .map_err(|e| format!("Failed to create dir {}: {}", safe_name.display(), e))?;
            continue;
        }

        if entry.size() > MAX_FILE_BYTES {
            return Err(format!("File too large in bundle: {} ({}B)", safe_name.display(), entry.size()));
        }
        total_bytes += entry.size();
        if total_bytes > MAX_TOTAL_BYTES {
            return Err("Bundle contents too large".into());
        }

        let out_path = temp_dir.join(&safe_name);
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create dir for {}: {}", safe_name.display(), e))?;
        }

        let mut buf = Vec::with_capacity(entry.size() as usize);
        entry.read_to_end(&mut buf)
            .map_err(|e| format!("Failed to read {}: {}", safe_name.display(), e))?;
        fs::write(&out_path, &buf)
            .map_err(|e| format!("Failed to write {}: {}", safe_name.display(), e))?;
    }

    // Phase 2: Atomically swap the old extraction directory with the new one.
    // Move the old directory aside (if it exists) before renaming the new one
    // into place. This minimizes the window where no directory exists at the
    // final path, and ensures the old server can still serve from the old
    // directory until the rename completes.
    let old_dir = parent.join(format!("{}_bundle_old", stem));
    if final_dir.exists() {
        // Remove any leftover _old directory from a previous run
        if old_dir.exists() {
            let _ = fs::remove_dir_all(&old_dir);
        }
        fs::rename(&final_dir, &old_dir)
            .map_err(|e| format!("Failed to move old bundle aside: {}", e))?;
    }
    fs::rename(&temp_dir, &final_dir)
        .map_err(|e| format!("Failed to rename extracted bundle: {}", e))?;
    // Clean up old directory (best-effort — not critical if it fails)
    if old_dir.exists() {
        let _ = fs::remove_dir_all(&old_dir);
    }

    tracing::info!("Extracted .softn bundle to {}", final_dir.display());
    Ok(final_dir)
}

pub fn load_manifest(bundle_path: &Path) -> Result<ServerManifest, String> {
    let manifest_path = if bundle_path.is_dir() {
        bundle_path.join("manifest.json")
    } else {
        return Err("Expected a directory. Use extract_softn_zip() first for .softn files.".into());
    };

    let content = fs::read_to_string(&manifest_path)
        .map_err(|e| format!("Failed to read manifest: {}", e))?;
    let manifest: ServerManifest = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse manifest: {}", e))?;

    // Validate manifest fields
    if manifest.name.is_empty() || manifest.name.len() > 64 {
        return Err("Manifest name must be 1-64 characters".into());
    }
    if !manifest.name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-' || b == b'.') {
        return Err("Manifest name must be alphanumeric, dash, underscore, or dot".into());
    }
    if manifest.version.is_empty() {
        return Err("Manifest version must not be empty".into());
    }

    Ok(manifest)
}

/// Validate a script path stays within the bundle directory.
fn validate_script_path(bundle_path: &Path, relative: &str) -> Result<PathBuf, String> {
    // Reject path traversal and absolute paths (which would overwrite the base in join())
    if relative.contains("..") || Path::new(relative).is_absolute() {
        return Err(format!("Path traversal rejected in script path: {}", relative));
    }
    let full = bundle_path.join(relative);
    // Verify it resolves inside bundle
    if full.exists() {
        let canonical = fs::canonicalize(&full)
            .map_err(|e| format!("Failed to resolve {}: {}", relative, e))?;
        let canonical_bundle = fs::canonicalize(bundle_path)
            .map_err(|e| format!("Failed to resolve bundle path: {}", e))?;
        if !canonical.starts_with(&canonical_bundle) {
            return Err(format!("Script path escapes bundle: {}", relative));
        }
    }
    Ok(full)
}

/// Load all server scripts concatenated, with the console shim prepended.
pub fn load_server_scripts(bundle_path: &Path, server: &ServerBlock) -> Result<String, String> {
    let entry = server.entry.as_deref().unwrap_or("server/main.logic");
    let mut source = String::from(SERVER_SHIM);

    // Load entry script
    let entry_path = validate_script_path(bundle_path, entry)?;
    let entry_src = fs::read_to_string(&entry_path)
        .map_err(|e| format!("Failed to read {}: {}", entry, e))?;
    source.push_str(&entry_src);
    source.push('\n');

    // Load additional scripts
    if let Some(scripts) = &server.scripts {
        for script in scripts {
            let script_path = validate_script_path(bundle_path, script)?;
            let script_src = fs::read_to_string(&script_path)
                .map_err(|e| format!("Failed to read {}: {}", script, e))?;
            source.push_str(&script_src);
            source.push('\n');
        }
    }

    Ok(source)
}

/// Build a client-safe manifest (strip server block and server/ file paths).
pub fn client_manifest(manifest: &ServerManifest) -> serde_json::Value {
    let mut val = serde_json::json!({
        "name": manifest.name,
        "version": manifest.version,
    });
    if let Some(main) = &manifest.main {
        val["main"] = serde_json::json!(main);
    }
    if let Some(files) = &manifest.files {
        // Filter out any file paths that start with "server/" (case-insensitive
        // to handle case-insensitive file systems on Windows/macOS)
        let filtered: HashMap<String, Vec<String>> = files
            .iter()
            .map(|(k, v)| {
                let safe: Vec<String> = v
                    .iter()
                    .filter(|p| {
                        let lower = p.to_lowercase();
                        !lower.starts_with("server/") && !lower.starts_with("server\\")
                    })
                    .cloned()
                    .collect();
                (k.clone(), safe)
            })
            .filter(|(_, v)| !v.is_empty())
            .collect();
        val["files"] = serde_json::to_value(filtered).unwrap_or_default();
    }
    // Include config (contains server URL, theme, etc. needed by clients)
    if let Some(config) = &manifest.config {
        val["config"] = config.clone();
    }
    val
}
