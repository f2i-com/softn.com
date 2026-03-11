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
use crate::bundle::{self, ServerConfig, ServerManifest};
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

                    if tenants.contains_key(&id) {
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

    // Open DB
    let db_path = data_dir.join(format!("{}.sqlite", manifest.name));
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
        .or_else(|| {
            manifest.config.as_ref()
                .and_then(|c| c.get("server"))
                .and_then(|s| serde_json::from_value::<ServerConfig>(s.clone()).ok())
                .and_then(|sc| sc.auth_token)
        });

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
        let allow_http = if permissions.is_none() && allow_all_capabilities {
            true
        } else {
            permissions
                .and_then(|p| p.get("http"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
        };
        let allow_fs = if permissions.is_none() && allow_all_capabilities {
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
        }, configured_workers);

        rt.init(source)?;

        // Validate route handlers
        if let Some(routes) = server.routes.as_ref() {
            for route in routes {
                if !rt.has_function(&route.handler) {
                    tracing::warn!(
                        "[{}] Route {} {} references undefined handler '{}'",
                        tenant_id, route.method, route.path, route.handler
                    );
                }
            }
        }

        // Call onStart
        if rt.has_function("onStart") {
            match rt.call("onStart", vec![]) {
                Ok(_) => tracing::info!("[{}] onStart() completed", tenant_id),
                Err(e) => tracing::error!("[{}] onStart() error: {}", tenant_id, e),
            }
        }

        Some(rt)
    } else {
        None
    };

    // SyncManager
    let max_storage_bytes = manifest.config.as_ref()
        .and_then(|c| c.get("server"))
        .and_then(|s| s.get("maxStorageMB"))
        .and_then(|v| v.as_u64())
        .map(|mb| mb.min(10 * 1024) * 1024 * 1024)
        .unwrap_or(512 * 1024 * 1024);

    let sync_permits = manifest.config.as_ref()
        .and_then(|c| c.get("server"))
        .and_then(|s| s.get("syncPermits"))
        .and_then(|v| v.as_u64())
        .map(|n| (n as usize).clamp(4, 64))
        .unwrap_or(16); // Lower default for multi-tenant

    let force_server_timestamps = manifest.config.as_ref()
        .and_then(|c| c.get("server"))
        .and_then(|s| s.get("forceServerTimestamps"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let sync_manager = SyncManager::new(
        db.clone(), runtime.clone(), auth_token.clone(),
        db_path, max_storage_bytes, sync_permits,
        force_server_timestamps,
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
    })
}
