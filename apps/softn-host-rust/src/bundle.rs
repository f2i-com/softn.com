use serde::Deserialize;
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

#[derive(Debug, Deserialize)]
pub struct ServerManifest {
    pub name: String,
    pub version: String,
    /// Stable unique identifier for data directory isolation (e.g.
    /// "com.mybrand.appname"). If provided, the data directory is keyed by
    /// this value instead of a volatile hash of the bundle's filesystem path.
    /// Without this, moving the `.softn` file to a different folder changes
    /// the path hash and creates a new empty database, appearing as data loss.
    pub id: Option<String>,
    pub main: Option<String>,
    pub files: Option<HashMap<String, Vec<String>>>,
    pub server: Option<ServerBlock>,
    pub config: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ServerBlock {
    pub entry: Option<String>,
    pub scripts: Option<Vec<String>>,
    pub routes: Option<Vec<RouteDefinition>>,
    #[allow(dead_code)]
    pub permissions: Option<serde_json::Value>,
    pub requires: Option<ServerRequirements>,
    pub database: Option<PrivateDatabase>,
    pub sync: Option<SyncConfig>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ServerRequirements {
    #[serde(rename = "apiVersion")]
    pub api_version: u32,
    pub capabilities: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PrivateDatabase {
    pub kind: String,
    pub migrations: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SyncConfig { pub enabled: bool }

#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AuthorizationMode { #[default] HostToken, Application, Anonymous }

#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TransactionMode { #[default] None, Read, Write }

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RouteDefinition {
    pub method: String,
    pub path: String,
    pub handler: String,
    /// If true, this route does not require auth even when `auth_token` is set.
    /// Defaults to false (authenticated). Use for public-facing endpoints like
    /// webhooks or health checks exposed through the script layer.
    #[serde(default)]
    pub public: bool,
    #[serde(default)]
    pub authorization: Option<AuthorizationMode>,
    #[serde(default)]
    pub transaction: TransactionMode,
    /// Per-route JSON body limit, also bounded by config.server.maxBodySize.
    #[serde(default, rename = "maxBodySize")]
    pub max_body_size: Option<usize>,
    /// A GET route clients poll: a 200 carries an `ETag` and
    /// `X-SoftN-Poll-Interval`, and a matching `If-None-Match` is a 304 (the
    /// handler still runs, so revocation is never skipped). As on the PHP host.
    #[serde(default)]
    pub poll: Option<bool>,
    /// `"photo"`: the body's `data_url` is sanitized by the host before the
    /// handler runs and handed over as `req.upload` (`{sanitized, image,
    /// thumbnail}`), with an empty body. POST only; needs `photos`. As on the
    /// PHP host.
    #[serde(default)]
    pub upload: Option<String>,
}

/// Requests a minute one client address may make to the app's routes:
/// `config.server.requestsPerMinute`, else 120 for an API v1 app (the PHP
/// host's fixed limit, so the shared contract behaves alike) and no limit for
/// a legacy bundle, whose clients (a polling game table) were never held to
/// one. 0 turns it off.
pub fn requests_per_minute(manifest: &ServerManifest) -> Option<u32> {
    let configured = manifest.config.as_ref()
        .and_then(|c| c.get("server"))
        .and_then(|s| s.get("requestsPerMinute"))
        .and_then(|v| v.as_u64());
    let api_v1 = manifest.server.as_ref().is_some_and(|s| s.requires.is_some());
    match configured {
        Some(0) => None,
        Some(n) => Some(n.min(u64::from(u32::MAX)) as u32),
        None if api_v1 => Some(120),
        None => None,
    }
}

/// Default request-body limit for a route that declares none (the PHP host's
/// default is 256 KB; this host has always allowed 2 MiB).
pub const DEFAULT_BODY_LIMIT: usize = 2 * 1024 * 1024;
/// The body a photo upload route may carry by default: a 4 MB image as base64
/// plus its JSON wrapper, as on the PHP host.
pub const PHOTO_UPLOAD_BODY_LIMIT: usize = 5_600_100;
/// The most any route may accept.
pub const MAX_BODY_LIMIT: usize = 16 * 1024 * 1024;

/// How long a request's whole body may take to arrive, by default. The
/// largest body a route may accept (16 MiB) needs about 280 KB/s over this; a
/// photo upload (5.6 MB) about 95 KB/s.
pub const DEFAULT_BODY_TIMEOUT_SECS: u64 = 60;
/// The longest `config.server.bodyTimeoutSeconds` may set.
pub const MAX_BODY_TIMEOUT_SECS: u64 = 600;

/// How long a request's whole body may take to arrive, from when its headers
/// were read: `config.server.bodyTimeoutSeconds`, else 60 seconds. Past it the
/// request is answered 408 and the connection closed, however steadily the
/// bytes were coming.
pub fn body_timeout(manifest: &ServerManifest) -> std::time::Duration {
    let seconds = manifest.config.as_ref()
        .and_then(|c| c.get("server"))
        .and_then(|s| s.get("bodyTimeoutSeconds"))
        .and_then(|v| v.as_u64())
        .unwrap_or(DEFAULT_BODY_TIMEOUT_SECS)
        .clamp(1, MAX_BODY_TIMEOUT_SECS);
    std::time::Duration::from_secs(seconds)
}

/// The body `route` accepts: the smaller of its own `maxBodySize` and the
/// app's `config.server.maxBodySize` when either is declared, else the
/// default (larger for a photo upload). The PHP host's rule, with this host's
/// own default and ceiling.
pub fn route_body_limit(route: &RouteDefinition, manifest: &ServerManifest) -> usize {
    let app = manifest.config.as_ref()
        .and_then(|c| c.get("server"))
        .and_then(|s| s.get("maxBodySize"))
        .and_then(|v| v.as_u64())
        .map(|n| n as usize);
    let declared: Vec<usize> = route.max_body_size.into_iter().chain(app).collect();
    let limit = declared.into_iter().min().unwrap_or(if route.upload.is_some() {
        PHOTO_UPLOAD_BODY_LIMIT
    } else {
        DEFAULT_BODY_LIMIT
    });
    limit.min(MAX_BODY_LIMIT)
}

/// The token a bundle's manifest sets in `config.server`, under `auth_token`
/// or `authToken`. `client_manifest` has always redacted both spellings, but
/// the server read only the first, so a manifest using the second ran with
/// no authentication at all. `validate_server_config` has already refused
/// empty, non-string and conflicting values.
pub fn manifest_auth_token(manifest: &ServerManifest) -> Option<String> {
    let server = manifest.config.as_ref()?.get("server")?;
    server
        .get("auth_token")
        .or_else(|| server.get("authToken"))
        .and_then(|v| v.as_str())
        .map(String::from)
}

/// Check the `config.server` keys the host reads, so a wrong type is a clear
/// startup error rather than a silent default: `"auth_token": 123` used to
/// start with no authentication, `"maxBodySize": 0` refused every body, and
/// `"allowedOrigins": ["*"]` panicked while the router was built (in
/// multi-tenant mode taking every tenant down with it). Keys the host does not
/// read (`url`, and whatever the client uses) are left alone.
fn validate_server_config(manifest: &ServerManifest) -> Result<(), String> {
    let Some(server) = manifest.config.as_ref().and_then(|c| c.get("server")) else {
        return Ok(());
    };
    let server = server.as_object().ok_or("config.server must be an object")?;
    let mut tokens = Vec::new();
    for key in ["auth_token", "authToken"] {
        if let Some(value) = server.get(key) {
            match value.as_str() {
                Some(token) if !token.is_empty() => tokens.push(token),
                _ => return Err(format!("config.server.{key} must be a non-empty string")),
            }
        }
    }
    if tokens.len() == 2 && tokens[0] != tokens[1] {
        return Err("config.server.auth_token and authToken disagree; set one".into());
    }
    if let Some(origins) = server.get("allowedOrigins") {
        let origins = origins.as_array().ok_or("config.server.allowedOrigins must be an array of origins")?;
        for origin in origins {
            let text = origin.as_str().ok_or("config.server.allowedOrigins must be an array of origins")?;
            if text == "null" {
                // Every sandboxed iframe and file: page on every site sends
                // `Origin: null`; honoured as listed, as the PHP host does.
                tracing::warn!("config.server.allowedOrigins lists \"null\": any sandboxed page on any site may call this app");
                continue;
            }
            let valid = text
                .split_once("://")
                .is_some_and(|(scheme, rest)| {
                    matches!(scheme.to_ascii_lowercase().as_str(), "http" | "https")
                        && !rest.trim_end_matches('/').is_empty()
                        && !rest.trim_end_matches('/').contains(['/', '?', '#', '*', ' '])
                });
            if !valid {
                return Err(format!(
                    "config.server.allowedOrigins entry {text:?} is not an origin like \"https://app.example\" \
                     (a wildcard is not accepted: list the origins, or run with --dev on a development machine)"
                ));
            }
        }
    }
    if let Some(size) = server.get("maxBodySize") {
        if !size.as_u64().is_some_and(|n| (1..=16 * 1024 * 1024).contains(&n)) {
            return Err("config.server.maxBodySize must be a whole number of bytes between 1 and 16777216".into());
        }
    }
    if let Some(seconds) = server.get("bodyTimeoutSeconds") {
        if !seconds.as_u64().is_some_and(|n| (1..=MAX_BODY_TIMEOUT_SECS).contains(&n)) {
            return Err(format!("config.server.bodyTimeoutSeconds must be a whole number of seconds between 1 and {MAX_BODY_TIMEOUT_SECS}"));
        }
    }
    for key in ["workers", "readPoolSize", "syncPermits", "maxStorageMB", "maxSyncConnections", "maxSyncConnectionsPerVisitor", "requestsPerMinute"] {
        if server.get(key).is_some_and(|v| v.as_u64().is_none()) {
            return Err(format!("config.server.{key} must be a non-negative whole number"));
        }
    }
    if server.get("forceServerTimestamps").is_some_and(|v| !v.is_boolean()) {
        return Err("config.server.forceServerTimestamps must be true or false".into());
    }
    Ok(())
}



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
    let mut manifest: ServerManifest = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse manifest: {}", e))?;
    default_route_transactions(&mut manifest);

    // Validate manifest fields. The name is what people read — "Texas
    // Hold'em" — and only becomes a path when there is no `id` to name the
    // data directory by; so with an id it need only be printable, and
    // without one it is held to the characters a directory name can take.
    if manifest.name.is_empty() || manifest.name.len() > 64 {
        return Err("Manifest name must be 1-64 characters".into());
    }
    if manifest.name.chars().any(|c| c.is_control()) {
        return Err("Manifest name must not contain control characters".into());
    }
    if manifest.name == "." || manifest.name == ".." || manifest.name.contains(['/', '\\', ':']) {
        return Err("Manifest name cannot contain path separators or a drive prefix".into());
    }
    if manifest.id.is_none()
        && !manifest.name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-' || b == b'.')
    {
        return Err("Manifest name must be alphanumeric, dash, underscore, or dot when the manifest has no `id` (the name then names the data directory)".into());
    }
    if let Some(ref id) = manifest.id {
        if id.is_empty() || id.len() > 128 || id == "." || id.contains("..") {
            return Err("Manifest id must be 1-128 characters".into());
        }
        // Allow reverse-domain style: alphanumeric, dash, underscore, dot
        if !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-' || b == b'.') {
            return Err("Manifest id must be alphanumeric, dash, underscore, or dot".into());
        }
    }
    if manifest.version.is_empty() {
        return Err("Manifest version must not be empty".into());
    }
    validate_server_config(&manifest)?;

    if let Some(server) = &manifest.server {
        if server.requires.is_some() && manifest.id.is_none() {
            return Err("API v1 requires a stable application id".into());
        }
        if server.requires.is_some() && server.permissions.as_ref().is_some_and(|p|
            p.get("http").and_then(|v| v.as_bool()) == Some(true)
                || p.get("fs").and_then(|v| v.as_bool()) == Some(true)) {
            return Err("API v1 private apps do not support general http/fs grants; use an operator-side service".into());
        }
        if let Some(required) = &server.requires {
            if required.api_version != 1 { return Err("Unsupported server API version".into()); }
            for cap in &required.capabilities {
                if !matches!(cap.as_str(), "sql" | "crypto" | "time" | "trusted-client-ip" | "transaction-scope" | "photos") {
                    return Err(format!("Unsupported required server capability: {cap}"));
                }
            }
        }
        if let Some(db) = &server.database {
            if db.kind != "private-sqlite" || db.migrations.is_empty() || db.migrations.len() > 100 {
                return Err("Private database requires kind private-sqlite and 1-100 migrations".into());
            }
            if !server.requires.as_ref().is_some_and(|r| r.capabilities.iter().any(|c| c == "sql")) {
                return Err("Private database must require the sql capability".into());
            }
        }
        if let Some(routes) = &server.routes {
            let mut seen = std::collections::HashSet::new();
            for route in routes {
                if route.max_body_size.is_some_and(|n| n == 0 || n > 16 * 1024 * 1024) {
                    return Err("Route maxBodySize must be between 1 and 16777216 bytes".into());
                }
                if server.requires.is_some() {
                    if !matches!(route.method.as_str(), "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD")
                        || !route.path.starts_with("/api/")
                        || route.path.contains(['{', '}', '*', ':', '?', '#', '\\'])
                        || route.path.ends_with('/') || route.path.contains("..")
                        || !seen.insert((route.method.clone(), route.path.clone())) {
                        return Err("API v1 requires unique explicit /api/ routes with supported HTTP methods".into());
                    }
                    if route.public { return Err("API v1 routes must use explicit authorization instead of public".into()); }
                    if route.authorization.is_none() { return Err("API v1 routes require explicit authorization".into()); }
                }
                if route.poll == Some(true) && route.method != "GET" {
                    return Err(format!("Route {} {}: poll is for GET routes", route.method, route.path));
                }
                if route.poll == Some(true) && route.transaction == TransactionMode::Write {
                    return Err(format!("Route {} {}: a polled route must be a read", route.method, route.path));
                }
                if let Some(upload) = &route.upload {
                    let photos = server.requires.as_ref().is_some_and(|r| r.capabilities.iter().any(|c| c == "photos"));
                    if upload != "photo" || route.method != "POST" || !photos {
                        return Err(format!(
                            "Route {} {}: upload must be \"photo\", on a POST route of an API v1 app that requires the photos capability",
                            route.method, route.path
                        ));
                    }
                }
            }
        }
    }
    Ok(manifest)
}

/// An API v1 route of an app with a private database runs in a transaction:
/// one that declares none (or `"none"`) gets a read for GET and a write for
/// anything else, as on the PHP host, where a manifest without `transaction`
/// loads. An app without a database has no SQL to scope, so a declared
/// transaction there is ignored, with a warning, rather than refusing the app.
fn default_route_transactions(manifest: &mut ServerManifest) {
    let Some(server) = manifest.server.as_mut() else { return };
    if server.requires.is_none() {
        return;
    }
    let has_database = server.database.is_some();
    for route in server.routes.iter_mut().flatten() {
        if has_database && route.transaction == TransactionMode::None {
            route.transaction = if route.method.eq_ignore_ascii_case("GET") { TransactionMode::Read } else { TransactionMode::Write };
        } else if !has_database && route.transaction != TransactionMode::None {
            tracing::warn!(
                "Route {} {} declares a transaction but the app has no private database; it runs without one",
                route.method, route.path
            );
            route.transaction = TransactionMode::None;
        }
    }
}

/// Validate a script path stays within the bundle directory.
pub(crate) fn validate_script_path(bundle_path: &Path, relative: &str) -> Result<PathBuf, String> {
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

/// Load all server scripts concatenated. `console` and the host bindings come
/// from the runtime preamble, not from here.
pub fn load_server_scripts(bundle_path: &Path, server: &ServerBlock) -> Result<String, String> {
    let entry = server.entry.as_deref().unwrap_or("server/main.logic");
    let mut source = String::new();

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
    if let Some(id) = &manifest.id {
        val["id"] = serde_json::json!(id);
    }
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
        if let Some(server) = val["config"].get_mut("server").and_then(|s| s.as_object_mut()) {
            server.remove("auth_token");
            server.remove("authToken");
        }
    }
    val
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_critical_server_fields_and_redacts_private_declarations() {
        let root = std::env::temp_dir().join(format!("softn-manifest-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let mut value = serde_json::json!({"id":"com.example.private", "name":"Private app", "version":"1",
            "server":{"requires":{"apiVersion":1,"capabilities":["sql"]},
                "database":{"kind":"private-sqlite","migrations":["server/001.sql"]},
                "routes":[{"method":"POST","path":"/api/test","handler":"api","authorization":"application","transaction":"write"}]},
            "files":{"logic":["server/private.logic","logic/public.logic"]}});
        let write = |v: &serde_json::Value| std::fs::write(root.join("manifest.json"), serde_json::to_vec(v).unwrap()).unwrap();
        write(&value);
        let manifest = load_manifest(&root).unwrap();
        let public = client_manifest(&manifest);
        assert!(public.get("server").is_none());
        assert_eq!(public["files"]["logic"], serde_json::json!(["logic/public.logic"]));
        value["server"]["routes"][0]["maxBodySize"] = 5_600_100.into(); write(&value);
        assert_eq!(load_manifest(&root).unwrap().server.unwrap().routes.unwrap()[0].max_body_size, Some(5_600_100));
        for size in [0, 16 * 1024 * 1024 + 1] {
            value["server"]["routes"][0]["maxBodySize"] = size.into(); write(&value);
            assert!(load_manifest(&root).is_err());
        }
        value["server"]["routes"][0].as_object_mut().unwrap().remove("maxBodySize");
        value["server"]["requires"]["apiVersion"] = 2.into(); write(&value);
        assert!(load_manifest(&root).is_err());
        value["server"]["requires"]["apiVersion"] = 1.into();
        value["server"]["requires"]["capabilities"] = serde_json::json!(["arbitrary-files"]); write(&value);
        assert!(load_manifest(&root).is_err());
        value["server"]["requires"]["capabilities"] = serde_json::json!(["sql"]);
        value["server"]["routes"][0].as_object_mut().unwrap().remove("authorization"); write(&value);
        assert!(load_manifest(&root).is_err());
        value["id"] = "..".into(); write(&value);
        assert!(load_manifest(&root).is_err());
    }

    /// A manifest written for the PHP host loads here: `poll` and `upload`
    /// route fields, and SQL routes that leave `transaction` to the method.
    #[test]
    fn php_host_route_declarations_load() {
        let root = std::env::temp_dir().join(format!("softn-parity-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let mut value = serde_json::json!({"id":"com.example.parity","name":"Parity","version":"1",
            "server":{"requires":{"apiVersion":1,"capabilities":["sql","photos"]},
                "database":{"kind":"private-sqlite","migrations":["server/001.sql"]},
                "routes":[
                    {"method":"GET","path":"/api/feed","handler":"feed","authorization":"application","poll":true},
                    {"method":"POST","path":"/api/photo","handler":"photo","authorization":"application","upload":"photo"},
                    {"method":"DELETE","path":"/api/item","handler":"remove","authorization":"application","transaction":"none"}
                ]}});
        let write = |v: &serde_json::Value| std::fs::write(root.join("manifest.json"), serde_json::to_vec(v).unwrap()).unwrap();
        write(&value);
        let manifest = load_manifest(&root).unwrap();
        let routes = manifest.server.as_ref().unwrap().routes.as_ref().unwrap();
        assert_eq!(routes[0].transaction, TransactionMode::Read);
        assert_eq!(routes[1].transaction, TransactionMode::Write);
        assert_eq!(routes[2].transaction, TransactionMode::Write);
        assert_eq!(route_body_limit(&routes[1], &manifest), PHOTO_UPLOAD_BODY_LIMIT);
        assert_eq!(route_body_limit(&routes[0], &manifest), DEFAULT_BODY_LIMIT);
        assert_eq!(requests_per_minute(&manifest), Some(120));
        // What the PHP host refuses, this host refuses.
        for (index, field, bad) in [
            (0, "poll", serde_json::json!("yes")),
            (1, "poll", serde_json::json!(true)),
            (1, "upload", serde_json::json!("video")),
            (0, "upload", serde_json::json!("photo")),
        ] {
            let mut broken = value.clone();
            broken["server"]["routes"][index][field] = bad.clone();
            write(&broken);
            assert!(load_manifest(&root).is_err(), "{field}: {bad} on route {index}");
        }
        value["server"]["requires"]["capabilities"] = serde_json::json!(["sql"]);
        write(&value);
        assert!(load_manifest(&root).is_err(), "a photo upload needs the photos capability");
    }

    /// The smaller of the route's and the app's declared limits, as on the
    /// PHP host; the app's alone used to cap a route that declared more.
    #[test]
    fn a_route_body_limit_is_the_smaller_declared_one() {
        let manifest = |server: serde_json::Value| -> ServerManifest {
            serde_json::from_value(serde_json::json!({"name":"x","version":"1","config":{"server":server}})).unwrap()
        };
        let route = |max: Option<usize>| -> RouteDefinition {
            serde_json::from_value(serde_json::json!({"method":"POST","path":"/api/x","handler":"h","maxBodySize":max})).unwrap()
        };
        assert_eq!(route_body_limit(&route(Some(5_000_000)), &manifest(serde_json::json!({}))), 5_000_000);
        assert_eq!(route_body_limit(&route(Some(5_000_000)), &manifest(serde_json::json!({"maxBodySize": 1000}))), 1000);
        assert_eq!(route_body_limit(&route(None), &manifest(serde_json::json!({"maxBodySize": 1000}))), 1000);
        assert_eq!(route_body_limit(&route(None), &manifest(serde_json::json!({}))), DEFAULT_BODY_LIMIT);
        assert_eq!(requests_per_minute(&manifest(serde_json::json!({}))), None, "a legacy bundle has no limit unless it sets one");
        assert_eq!(requests_per_minute(&manifest(serde_json::json!({"requestsPerMinute": 30}))), Some(30));
        assert_eq!(body_timeout(&manifest(serde_json::json!({}))), std::time::Duration::from_secs(DEFAULT_BODY_TIMEOUT_SECS));
        assert_eq!(body_timeout(&manifest(serde_json::json!({"bodyTimeoutSeconds": 5}))), std::time::Duration::from_secs(5));
    }

    #[test]
    fn server_config_types_are_checked_and_both_token_spellings_count() {
        let root = std::env::temp_dir().join(format!("softn-config-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let load = |server: serde_json::Value| {
            let manifest = serde_json::json!({"id":"com.example.config","name":"Config","version":"1","config":{"server":server}});
            std::fs::write(root.join("manifest.json"), serde_json::to_vec(&manifest).unwrap()).unwrap();
            load_manifest(&root)
        };
        for bad in [
            serde_json::json!({"auth_token": 123}),
            serde_json::json!({"auth_token": ""}),
            serde_json::json!({"auth_token": "a", "authToken": "b"}),
            serde_json::json!({"allowedOrigins": ["*"]}),
            serde_json::json!({"allowedOrigins": "https://app.example"}),
            serde_json::json!({"allowedOrigins": ["app.example"]}),
            serde_json::json!({"maxBodySize": 0}),
            serde_json::json!({"maxBodySize": 16 * 1024 * 1024 + 1}),
            serde_json::json!({"workers": "4"}),
            serde_json::json!({"forceServerTimestamps": "yes"}),
            serde_json::json!({"bodyTimeoutSeconds": 0}),
            serde_json::json!({"bodyTimeoutSeconds": 601}),
            serde_json::json!({"bodyTimeoutSeconds": 1.5}),
            serde_json::json!({"maxSyncConnectionsPerVisitor": "8"}),
        ] {
            assert!(load(bad.clone()).is_err(), "{bad} was accepted");
        }
        let manifest = load(serde_json::json!({"authToken": "camel", "allowedOrigins": ["https://App.example/"],
            "maxBodySize": 1024, "url": "wss://anything"})).unwrap();
        assert_eq!(manifest_auth_token(&manifest).as_deref(), Some("camel"));
        let manifest = load(serde_json::json!({"auth_token": "snake"})).unwrap();
        assert_eq!(manifest_auth_token(&manifest).as_deref(), Some("snake"));
        assert!(load(serde_json::json!({"allowedOrigins": ["null"]})).is_ok(), "listed on purpose, as the PHP host allows");
    }
}
