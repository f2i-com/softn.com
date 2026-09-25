//! Multi-tenant manager: loads and routes to multiple `.softn` bundles
//! hosted on a single server process.
//!
//! Each tenant gets its own isolated:
//! - SQLite database (separate file)
//! - File storage directory
//! - ServerRuntime (worker threads for script execution)
//! - SyncManager (WebSocket broadcast channel)
//! - Auth token
//!
//! Tenants are identified by their manifest `id` (preferred) or `name`,
//! and routed via URL path prefix: `/<tenant-id>/...`.

use crate::bridges::{db::NativeDbBridge, env::NativeEnvBridge, fs::NativeFsBridge, http::NativeHttpBridge};
use crate::bundle::{self, ServerManifest};
use crate::pool::ServerDb;
use crate::runtime::{BridgeSet, ServerRuntime};
use crate::sync::SyncManager;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Per-tenant context — equivalent to the single-tenant AppContext but
/// scoped to one bundle. Each tenant is fully isolated: separate DB,
/// separate runtime, separate sync channel.
#[allow(dead_code)]
pub struct TenantContext {
    pub tenant_id: String,
    pub manifest: ServerManifest,
    pub bundle_path: PathBuf,
    pub data_dir: PathBuf,
    pub db: ServerDb,
    pub runtime: Option<Arc<ServerRuntime>>,
    pub sync_manager: Arc<SyncManager>,
    pub auth_token: Option<String>,
    /// Shared shutdown signal — WebSocket connections subscribe to this
    /// to receive clean shutdown notifications.
    pub shutdown: tokio::sync::watch::Sender<bool>,
    /// Per-address allowance for the app's routes (see bundle::requests_per_minute).
    pub api_limiter: Option<Arc<crate::sync::AddressLimiter>>,
}

/// Top-level multi-tenant manager. Holds all loaded tenants and provides
/// lookup by tenant ID for request routing.
pub struct TenantManager {
    tenants: HashMap<String, Arc<TenantContext>>,
    /// Shutdown signal shared across all tenants.
    pub shutdown: tokio::sync::watch::Sender<bool>,
}

/// Reserved tenant IDs that would conflict with global routes.
const RESERVED_TENANT_IDS: &[&str] = &["health", "tenants"];

/// Maximum number of tenants to prevent OS resource exhaustion.
/// Each tenant creates worker threads (default 4), DB connections (default 4),
/// a broadcast channel, and background cleanup tasks. 50 tenants ≈ 200 threads
/// + 200 DB connections, which is a reasonable upper bound.
const MAX_TENANTS: usize = 50;

impl TenantManager {
    /// Load all bundles from a directory. Each subdirectory or `.softn` file
    /// becomes a tenant. Returns an error only if zero tenants load successfully.
    pub fn load(
        bundles_dir: &Path,
        data_dir: Option<&Path>,
        workers_per_tenant: Option<usize>,
        allow_all_capabilities: bool,
    ) -> Result<Arc<Self>, String> {
        let bundles_dir = std::fs::canonicalize(bundles_dir)
            .map_err(|e| format!("Invalid bundles directory: {}", e))?;

        let entries = std::fs::read_dir(&bundles_dir)
            .map_err(|e| format!("Failed to read bundles directory: {}", e))?;

        // Create the shutdown sender upfront so all tenants share it.
        // When shutdown is signaled, all tenant WebSocket connections
        // receive the notification for clean Close frame delivery.
        let (shutdown, _) = tokio::sync::watch::channel(false);

        let mut tenants = HashMap::new();
        let mut errors = Vec::new();

        for entry in entries {
            let entry = match entry {
                Ok(e) => e,
                Err(e) => {
                    tracing::warn!("Failed to read directory entry: {}", e);
                    continue;
                }
            };

            let path = entry.path();

            // Skip hidden files/dirs and non-bundle entries
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if name_str.starts_with('.') {
                continue;
            }

            let is_bundle_dir = path.is_dir() && path.join("manifest.json").exists();
            let is_softn_file = path.is_file() && {
                let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
                ext == "softn" || ext == "zip"
            };

            if !is_bundle_dir && !is_softn_file {
                continue;
            }
            if is_bundle_dir && is_extraction_of_sibling_archive(&bundles_dir, &name_str) {
                // `app.softn` is unpacked beside itself as `app_bundle`
                // (with `_bundle_new`/`_bundle_old` during the swap). Loaded
                // as a directory as well, it was a second copy of the tenant:
                // its onStart ran, and whichever copy was read first won.
                continue;
            }

            if tenants.len() >= MAX_TENANTS {
                tracing::error!(
                    "Tenant limit reached ({}) — skipping {}",
                    MAX_TENANTS, path.display()
                );
                continue;
            }

            match load_tenant(&path, data_dir, workers_per_tenant, allow_all_capabilities, &shutdown) {
                Ok(tenant) => {
                    let id = tenant.tenant_id.clone();

                    // Check for reserved names that conflict with global routes
                    if RESERVED_TENANT_IDS.contains(&id.as_str()) {
                        tracing::error!(
                            "Tenant ID '{}' is reserved (conflicts with global route) — skipping {}",
                            id, path.display()
                        );
                        continue;
                    }

                    // Case-insensitively: on Windows and macOS `App` and
                    // `app` are one data directory, so two such tenants
                    // would share a database.
                    if tenants.keys().any(|k: &String| k.eq_ignore_ascii_case(&id)) {
                        tracing::error!(
                            "Duplicate tenant ID '{}' — skipping {}",
                            id, path.display()
                        );
                        continue;
                    }
                    tracing::info!(
                        "Loaded tenant '{}' ({})",
                        id, tenant.manifest.name
                    );
                    tenants.insert(id, Arc::new(tenant));
                }
                Err(e) => {
                    tracing::error!("Failed to load bundle {}: {}", path.display(), e);
                    errors.push(format!("{}: {}", path.display(), e));
                }
            }
        }

        if tenants.is_empty() {
            return Err(format!(
                "No tenants loaded from {}. Errors: {}",
                bundles_dir.display(),
                errors.join("; ")
            ));
        }

        tracing::info!(
            "Loaded {} tenant(s), {} failed",
            tenants.len(),
            errors.len()
        );

        Ok(Arc::new(Self { tenants, shutdown }))
    }

    /// Look up a tenant by ID.
    #[allow(dead_code)]
    pub fn get(&self, tenant_id: &str) -> Option<&Arc<TenantContext>> {
        self.tenants.get(tenant_id)
    }

    /// List all tenant IDs.
    pub fn tenant_ids(&self) -> Vec<&str> {
        self.tenants.keys().map(String::as_str).collect()
    }

    /// Iterate over all tenants.
    pub fn tenants(&self) -> impl Iterator<Item = &Arc<TenantContext>> {
        self.tenants.values()
    }
}

/// Whether directory `name` in `dir` is where a sibling `.softn`/`.zip` was
/// (or is being) unpacked by `bundle::extract_softn_zip`.
fn is_extraction_of_sibling_archive(dir: &Path, name: &str) -> bool {
    ["_bundle", "_bundle_new", "_bundle_old"].iter().any(|suffix| {
        name.strip_suffix(suffix).is_some_and(|stem| {
            !stem.is_empty()
                && ["softn", "zip"].iter().any(|ext| dir.join(format!("{stem}.{ext}")).is_file())
        })
    })
}

/// Load a single tenant from a bundle path (directory or .softn file).
fn load_tenant(
    bundle_path: &Path,
    data_dir_base: Option<&Path>,
    workers_per_tenant: Option<usize>,
    allow_all_capabilities: bool,
    shutdown: &tokio::sync::watch::Sender<bool>,
) -> Result<TenantContext, String> {
    // Extract ZIP if needed
    let bundle_path = if bundle_path.is_file() {
        let ext = bundle_path.extension().and_then(|e| e.to_str()).unwrap_or("");
        if ext == "softn" || ext == "zip" {
            bundle::extract_softn_zip(bundle_path)?
        } else {
            return Err(format!("Unsupported file type: .{}", ext));
        }
    } else {
        std::fs::canonicalize(bundle_path)
            .map_err(|e| format!("Invalid bundle path: {}", e))?
    };

    let manifest = bundle::load_manifest(&bundle_path)?;
    if manifest.server.as_ref().is_some_and(|s| s.requires.is_some()) && data_dir_base.is_none() {
        return Err("API v1 tenants require an explicit operator --data-dir".into());
    }

    // Tenant ID: prefer manifest.id, fall back to manifest.name
    let tenant_id = manifest.id.clone().unwrap_or_else(|| manifest.name.clone());
    // Validate tenant ID for URL safety
    if tenant_id.is_empty() || tenant_id.len() > 128 {
        return Err("Tenant ID must be 1-128 characters".into());
    }
    if !tenant_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-' || b == b'.') {
        return Err(format!(
            "Tenant ID '{}' contains invalid characters (must be alphanumeric, dash, underscore, or dot)",
            tenant_id
        ));
    }

    // Data directory: <base>/<tenant_id>/
    let data_dir = if let Some(base) = data_dir_base {
        base.join(&tenant_id)
    } else if let Some(base) = dirs::data_dir() {
        base.join("softn").join(&tenant_id)
    } else {
        bundle_path.parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."))
            .join(format!("{}-data", tenant_id))
    };
    std::fs::create_dir_all(&data_dir)
        .map_err(|e| format!("Failed to create data dir: {}", e))?;
    let private_backend = crate::private_backend::PrivateBackend::load(&manifest, &bundle_path, &data_dir)?;

    // Open DB
    let db_path = data_dir.join(if manifest.server.as_ref().is_some_and(|s| s.requires.is_some()) {
        "xdb.sqlite".to_string()
    } else { format!("{}.sqlite", manifest.name) });
    crate::bridges::sql::reject_symlink(&db_path)?;
    let shared_db = xdb::create_shared_db(db_path.clone())
        .map_err(|e| format!("Failed to open DB: {}", e))?;
    let read_pool_size = manifest.config.as_ref()
        .and_then(|c| c.get("server"))
        .and_then(|s| s.get("readPoolSize"))
        .and_then(|v| v.as_u64())
        .map(|n| (n as u32).clamp(2, 64))
        .unwrap_or(4);
    let db = ServerDb::new(shared_db, &db_path, read_pool_size)?;

    // Auth token: SOFTN_AUTH_TOKEN_<TENANT_ID> → SOFTN_AUTH_TOKEN → manifest
    let env_key = format!(
        "SOFTN_AUTH_TOKEN_{}",
        tenant_id.to_uppercase().replace(['.', '-'], "_")
    );
    let auth_token = std::env::var(&env_key).ok()
        .filter(|s| !s.is_empty())
        .or_else(|| std::env::var("SOFTN_AUTH_TOKEN").ok().filter(|s| !s.is_empty()))
        .or_else(|| bundle::manifest_auth_token(&manifest));

    if auth_token.is_none() && manifest.server.as_ref().is_some_and(|s|
        s.requires.is_some() && s.routes.as_ref().is_some_and(|routes|
            routes.iter().any(|r| r.authorization == Some(bundle::AuthorizationMode::HostToken)))) {
        return Err("A host-token route requires an operator authentication token".into());
    }

    // Load runtime
    let runtime = if let Some(server) = &manifest.server {
        let source = bundle::load_server_scripts(&bundle_path, server)?;

        let db_for_factory = db.clone();
        let fs_root = data_dir.join("files");
        std::fs::create_dir_all(&fs_root)
            .map_err(|e| format!("Failed to create files dir: {}", e))?;
        let fs_root_for_factory = fs_root.clone();

        // Worker count: prefer explicit per-tenant, then manifest, then auto-size.
        // Multi-tenant default: 4 workers (vs single-tenant default of 16-50).
        let configured_workers = workers_per_tenant.or_else(|| {
            manifest.config.as_ref()
                .and_then(|c| c.get("server"))
                .and_then(|s| s.get("workers"))
                .and_then(|v| v.as_u64())
                .map(|n| n as usize)
        }).or(Some(4)); // Multi-tenant default

        // Capabilities
        let permissions = server.permissions.as_ref();
        let allow_http = if server.requires.is_some() { false } else if permissions.is_none() && allow_all_capabilities {
            true
        } else {
            permissions
                .and_then(|p| p.get("http"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
        };
        let allow_fs = if server.requires.is_some() { false } else if permissions.is_none() && allow_all_capabilities {
            true
        } else {
            permissions
                .and_then(|p| p.get("fs"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
        };

        let rt = ServerRuntime::new(move || BridgeSet {
            db: Some(Box::new(NativeDbBridge::new(db_for_factory.clone()))),
            http: if allow_http { Some(Box::new(NativeHttpBridge::new())) } else { None },
            fs: if allow_fs { Some(Box::new(NativeFsBridge::new(fs_root_for_factory.clone()))) } else { None },
            env: Some(Box::new(NativeEnvBridge)),
            sql: private_backend.sql(),
            crypto: private_backend.crypto.clone(),
            allow_time: private_backend.time,
            development: private_backend.development,
                allow_photos: private_backend.photos,
        }, configured_workers)?;

        rt.init(source)?;

        // Validate route handlers
        if let Some(routes) = server.routes.as_ref() {
            for route in routes {
                if !rt.has_function(&route.handler) {
                    return Err(format!(
                        "[{}] Route {} {} references undefined handler '{}'",
                        tenant_id, route.method, route.path, route.handler
                    ));
                }
            }
        }

        // Call onStart
        if rt.has_function("onStart") {
            match rt.call("onStart", vec![]) {
                Ok(_) => tracing::info!("[{}] onStart() completed", tenant_id),
                Err(e) => return Err(format!("[{tenant_id}] onStart() failed: {e}")),
            }
        }

        Some(rt)
    } else {
        None
    };

    let api_limiter = bundle::requests_per_minute(&manifest).map(|n| Arc::new(crate::sync::AddressLimiter::per_minute(n)));
    let sync_manager = SyncManager::new(
        db.clone(), runtime.clone(), auth_token.clone(),
        db_path, crate::sync::SyncSettings::from_manifest(&manifest, true),
    );

    Ok(TenantContext {
        tenant_id,
        manifest,
        bundle_path,
        data_dir,
        db,
        runtime,
        sync_manager,
        auth_token,
        shutdown: shutdown.clone(),
        api_limiter,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn bundle(dir: &Path, id: &str) {
        std::fs::create_dir_all(dir).unwrap();
        let manifest = serde_json::json!({"id": id, "name": id, "version": "1"});
        std::fs::write(dir.join("manifest.json"), serde_json::to_vec(&manifest).unwrap()).unwrap();
    }

    #[test]
    fn tenant_ids_that_differ_only_in_case_are_one_tenant() {
        let root = std::env::temp_dir().join(format!("softn-tenants-case-{}", uuid::Uuid::new_v4()));
        bundle(&root.join("bundles").join("upper"), "Shop");
        bundle(&root.join("bundles").join("lower"), "shop");
        let manager = TenantManager::load(&root.join("bundles"), Some(&root.join("data")), Some(1), false).unwrap();
        assert_eq!(manager.tenant_ids().len(), 1, "{:?}", manager.tenant_ids());
    }

    #[test]
    fn an_archive_and_its_unpacked_copy_are_one_tenant() {
        let root = std::env::temp_dir().join(format!("softn-tenants-zip-{}", uuid::Uuid::new_v4()));
        let bundles = root.join("bundles");
        std::fs::create_dir_all(&bundles).unwrap();
        let mut zip = zip::ZipWriter::new(std::fs::File::create(bundles.join("game.softn")).unwrap());
        zip.start_file("manifest.json", zip::write::SimpleFileOptions::default()).unwrap();
        zip.write_all(br#"{"id":"game","name":"game","version":"2"}"#).unwrap();
        zip.finish().unwrap();
        // What a previous start left beside the archive.
        bundle(&bundles.join("game_bundle"), "game");
        bundle(&bundles.join("game_bundle_old"), "game");
        let manager = TenantManager::load(&bundles, Some(&root.join("data")), Some(1), false).unwrap();
        assert_eq!(manager.tenant_ids(), vec!["game"]);
        assert_eq!(manager.get("game").unwrap().manifest.version, "2", "the archive, not a stale copy, is the tenant");
    }
}
