use serde::Deserialize;
use std::collections::HashMap;
use std::fs;
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

pub fn load_manifest(bundle_path: &Path) -> Result<ServerManifest, String> {
    let manifest_path = if bundle_path.is_dir() {
        bundle_path.join("manifest.json")
    } else {
        return Err("ZIP bundles not yet supported; use a directory".into());
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

