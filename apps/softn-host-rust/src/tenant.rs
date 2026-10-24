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
use std::collections::{HashMap, HashSet};
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
    pub api_limiter: Option<Arc<crate::limiter::AddressLimiter>>,
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

        // What there is to load, in name order: which of two bundles is read
        // first was the directory's own order, different from one start to
        // the next.
        let mut candidates: Vec<(String, PathBuf)> = Vec::new();
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
            candidates.push((name_str.into_owned(), path));
        }
        candidates.sort();

        // `app.softn` and `app.zip` both unpack to `app_bundle`
        // (bundle.rs `extract_softn_zip`): the second replaced the first's
        // files under it, and the first tenant served the second's. The
        // first by name is kept.
        let mut stems = HashSet::new();
        candidates.retain(|(_, path)| {
            let Some(stem) = path.is_file().then(|| path.file_stem()).flatten() else { return true };
            if stems.insert(stem.to_string_lossy().to_lowercase()) {
                return true;
            }
            let reason = "another archive of the same name is unpacked to the same directory; rename one of them";
            tracing::error!("Failed to load bundle {}: {}", path.display(), reason);
            errors.push(format!("{}: {}", path.display(), reason));
            false
        });

        // Two bundles that claim one id: decided before either is loaded.
        let losers = contested_losers(&candidates, data_dir);
        let fair_workers = fair_workers(candidates.len());
        if std::env::var("SOFTN_SYNC_TOKEN").is_ok_and(|s| !s.is_empty()) {
            tracing::warn!("SOFTN_SYNC_TOKEN is not read when serving many apps: every browser of each app holds its sync token, so one token would open every tenant's /sync. Set SOFTN_SYNC_TOKEN_<TENANT_ID>, or config.server.token in each manifest.");
        }

        for (name, path) in candidates {
            if tenants.len() >= MAX_TENANTS {
                tracing::error!(
                    "Tenant limit reached ({}) — skipping {}",
                    MAX_TENANTS, path.display()
                );
                continue;
            }

            // Whether this bundle may be the tenant it says it is, asked
            // before anything of its is opened or run. These checks used to
            // follow the load: a bundle declaring another tenant's id had by
            // then opened that tenant's database and files and run its own
            // top level and onStart against them, and only afterwards was
            // logged as a duplicate and dropped.
            if let Some(owner) = losers.get(&name) {
                // Not unpacked, not opened, not run.
                let reason = format!("it claims the tenant ID of the bundle '{}', which is that tenant", owner);
                tracing::error!("Failed to load bundle {}: {}", path.display(), reason);
                errors.push(format!("{}: {}", path.display(), reason));
                continue;
            }
            let refuse_id = |id: &str| -> Option<String> {
                // Reserved names conflict with global routes.
                if RESERVED_TENANT_IDS.contains(&id) {
                    return Some(format!("Tenant ID '{}' is reserved (conflicts with global route)", id));
                }
                // By `tenant_key`: on Windows and macOS `App` and `app` are
                // one data directory, and on Windows `app.` is too, so two
                // such tenants would share a database.
                if tenants.keys().any(|k: &String| tenant_key(k) == tenant_key(id)) {
                    return Some(format!("Duplicate tenant ID '{}'", id));
                }
                None
            };
            match load_tenant(&path, data_dir, workers_per_tenant, fair_workers, allow_all_capabilities, &shutdown, &refuse_id) {
                Ok(tenant) => {
                    let id = tenant.tenant_id.clone();
                    tracing::info!(
                        "Loaded tenant '{}' ({})",
                        id, tenant.manifest.name
                    );
                    record_owner(&tenant.data_dir, &name);
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

/// Each bundle's share of the process's worker threads, of that many to load
/// (no more than MAX_TENANTS of them are).
fn fair_workers(bundles: usize) -> usize {
    (crate::runtime::MAX_GLOBAL_WORKER_THREADS / bundles.clamp(1, MAX_TENANTS)).max(1)
}

/// The file in a tenant's data directory that names the bundle which last
/// served it: the bundle's own name in the bundles directory.
const OWNER_FILE: &str = ".bundle";

/// Note which bundle is serving this data. Best effort: it only ever settles
/// a dispute, and without it a dispute is settled as it was before.
fn record_owner(data_dir: &Path, bundle_name: &str) {
    let file = data_dir.join(OWNER_FILE);
    if std::fs::read_to_string(&file).is_ok_and(|recorded| recorded.trim() == bundle_name) {
        return;
    }
    if let Err(e) = std::fs::write(&file, bundle_name) {
        tracing::warn!("Could not record which bundle serves {}: {}", data_dir.display(), e);
    }
}

/// Where a tenant's data lives, by the rule `load_tenant` applies.
fn tenant_data_dir(data_dir_base: Option<&Path>, bundle_path: &Path, tenant_id: &str) -> PathBuf {
    if let Some(base) = data_dir_base {
        base.join(crate::util::directory_name(tenant_id))
    } else if let Some(base) = dirs::data_dir() {
        base.join("softn").join(crate::util::directory_name(tenant_id))
    } else {
        bundle_path.parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."))
            .join(format!("{}-data", tenant_id))
    }
}

/// What makes two tenant ids one tenant: the data directory they name. Case
/// is set aside, as Windows and macOS set it aside in a directory name, and
/// so are the dots at the end, which Windows drops from one: `Shop`, `shop`
/// and `shop.` are one directory there. Held to on every system, so a set of
/// bundles loads the same tenants wherever it is served.
fn tenant_key(id: &str) -> String {
    id.trim_end_matches('.').to_ascii_lowercase()
}

/// The id a bundle will claim, read without unpacking or running anything:
/// `manifest.id`, else `manifest.name`, as `load_tenant` takes it.
fn peek_tenant_id(path: &Path) -> Option<String> {
    let bytes = if path.is_dir() {
        std::fs::read(path.join("manifest.json")).ok()?
    } else {
        use std::io::Read;
        let mut archive = zip::ZipArchive::new(std::fs::File::open(path).ok()?).ok()?;
        // The entry unpacking writes as `manifest.json` (bundle.rs
        // `extract_softn_zip`, by its enclosed name, which `./manifest.json`
        // is too), found as Windows and macOS find that file. Looked up by
        // its exact name, `./manifest.json` was missed here and still
        // unpacked, so a bundle could claim another tenant's id unseen.
        let index = (0..archive.len()).find(|&i| {
            archive.by_index_raw(i).ok().is_some_and(|entry| {
                !entry.is_dir() && entry.enclosed_name().is_some_and(|name| bundle::entry_file_key(&name) == "manifest.json")
            })
        })?;
        let entry = archive.by_index(index).ok()?;
        let mut bytes = Vec::new();
        entry.take(1024 * 1024).read_to_end(&mut bytes).ok()?;
        bytes
    };
    let manifest: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    manifest.get("id").and_then(|v| v.as_str())
        .or_else(|| manifest.get("name").and_then(|v| v.as_str()))
        .map(String::from)
}

/// Of the bundles that claim an id another bundle claims too, the ones that
/// are not that tenant: bundle name to the name of the bundle that is.
///
/// One id, two bundles: one of them is served and the other refused, and
/// which was which used to be whichever the directory listed first. A copy
/// left behind (`shop-old/`) could be the one that ran against the live
/// data on the next start, and so could a bundle put there to do exactly
/// that. The tenant is now the bundle that served that data before, which
/// its data directory records ([`OWNER_FILE`]). The record only settles a
/// dispute: a bundle that is renamed or moved, with no rival for its id, is
/// loaded as ever and the record follows it. With no record (a first start,
/// or one from before there was a record) the first by name is the tenant,
/// which is at least the same one every time.
fn contested_losers(candidates: &[(String, PathBuf)], data_dir_base: Option<&Path>) -> HashMap<String, String> {
    let mut claims: HashMap<String, Vec<(&String, &PathBuf, String)>> = HashMap::new();
    for (name, path) in candidates {
        if let Some(id) = peek_tenant_id(path) {
            claims.entry(tenant_key(&id)).or_default().push((name, path, id));
        }
    }
    let mut losers = HashMap::new();
    for (_, claimants) in claims {
        if claimants.len() < 2 {
            continue;
        }
        let recorded = claimants.iter().find(|(name, path, id)| {
            std::fs::read_to_string(tenant_data_dir(data_dir_base, path, id).join(OWNER_FILE))
                .is_ok_and(|owner| owner.trim() == name.as_str())
        });
        let (owner, _, id) = recorded.unwrap_or(&claimants[0]);
        let names: Vec<&str> = claimants.iter().map(|(name, _, _)| name.as_str()).collect();
        if recorded.is_some() {
            tracing::error!(
                "Tenant ID '{}' is claimed by {} bundles ({}). '{}' served this tenant's data before and is loaded; the rest are refused.",
                id, names.len(), names.join(", "), owner
            );
        } else {
            tracing::error!(
                "Tenant ID '{}' is claimed by {} bundles ({}) and none is on record as having served its data. '{}' (first by name) is loaded and the rest are refused; remove the others.",
                id, names.len(), names.join(", "), owner
            );
        }
        for (name, _, _) in &claimants {
            if name != owner {
                losers.insert((*name).clone(), (*owner).clone());
            }
        }
    }
    losers
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
    fair_workers: usize,
    allow_all_capabilities: bool,
    shutdown: &tokio::sync::watch::Sender<bool>,
    refuse_id: &dyn Fn(&str) -> Option<String>,
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
    // Dots alone name the data directory itself or its parent: `..` does
    // everywhere, and on Windows, which drops the dots at the end of a
    // directory name, `...` is the directory every tenant's is in. An id
    // that only ends in dots is a tenant of its own unless another's is the
    // same without them (see `tenant_key`).
    if tenant_id.bytes().all(|b| b == b'.') {
        return Err(format!("Tenant ID '{}' must not be dots alone", tenant_id));
    }
    // Before the data directory is so much as named: see the caller.
    if let Some(reason) = refuse_id(&tenant_id) {
        return Err(reason);
    }

    // Data directory: <base>/<tenant_id>/
    let data_dir = tenant_data_dir(data_dir_base, &bundle_path, &tenant_id);
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
        // 16 read connections, file descriptors of the shared process, at
        // most: a bundle could ask for 64 of them, each tenant.
        .map(|n| (n as u32).clamp(2, 16))
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
    // The sync token: SOFTN_SYNC_TOKEN_<TENANT_ID> → manifest. There is no
    // process-wide fallback, unlike the operator's token: one sync token, which
    // every browser of an app holds, would open every tenant's /sync.
    let sync_auth = bundle::sync_auth(
        &manifest,
        auth_token.clone(),
        std::env::var(format!("SOFTN_SYNC_TOKEN_{}", tenant_id.to_uppercase().replace(['.', '-'], "_"))).ok(),
    )?;

    // The sync stream, before the runtime whose `db` bridge writes into it
    // (as in app.rs).
    let stream = crate::sync::sync_stream();

    // Load runtime
    let runtime = if let Some(server) = &manifest.server {
        let source = bundle::load_server_scripts(&bundle_path, server)?;

        let db_for_factory = db.clone();
        let stream_for_factory = stream.clone();
        let fs_root = data_dir.join("files");
        std::fs::create_dir_all(&fs_root)
            .map_err(|e| format!("Failed to create files dir: {}", e))?;
        let fs_root_for_factory = fs_root.clone();

        // Worker count: prefer explicit per-tenant, then manifest, then auto-size.
        // Multi-tenant default: 4 workers (vs single-tenant default of 16-50).
        // What a bundle asks for itself is held to its share of the
        // process-wide budget: one bundle asking for 200, loaded first, took
        // every thread, and each tenant after it failed to load. The
        // operator's --workers-per-tenant is not held to it.
        let configured_workers = workers_per_tenant.or_else(|| {
            manifest.config.as_ref()
                .and_then(|c| c.get("server"))
                .and_then(|s| s.get("workers"))
                .and_then(|v| v.as_u64())
                .map(|n| (n as usize).min(fair_workers))
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

        let app_config = bundle::app_config(&manifest);
        let rt = ServerRuntime::new(move || BridgeSet {
            db: Some(Box::new(NativeDbBridge::with_stream(db_for_factory.clone(), stream_for_factory.clone()))),
            http: if allow_http { Some(Box::new(NativeHttpBridge::new())) } else { None },
            fs: if allow_fs { Some(Box::new(NativeFsBridge::new(fs_root_for_factory.clone()))) } else { None },
            env: Some(Box::new(NativeEnvBridge)),
            sql: private_backend.sql(),
            crypto: private_backend.crypto.clone(),
            allow_time: private_backend.time,
            development: private_backend.development,
            allow_photos: private_backend.photos,
            app_config: app_config.clone(),
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

    let api_limiter = bundle::requests_per_minute(&manifest).map(|n| Arc::new(crate::limiter::AddressLimiter::per_minute(n)));
    let sync_manager = SyncManager::with_stream(
        db.clone(), runtime.clone(), sync_auth,
        db_path, crate::sync::SyncSettings::from_manifest(&manifest, true),
        stream,
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
        let root = crate::test_dirs::temp_path("softn-tenants-case", "");
        bundle(&root.join("bundles").join("upper"), "Shop");
        bundle(&root.join("bundles").join("lower"), "shop");
        let manager = TenantManager::load(&root.join("bundles"), Some(&root.join("data")), Some(1), false).unwrap();
        assert_eq!(manager.tenant_ids().len(), 1, "{:?}", manager.tenant_ids());
    }

    /// Windows drops the dots at the end of a directory name: `shop.` and
    /// `shop..` are the directory `shop`, and a name of dots alone is the
    /// data directory itself or its parent. Ids that are one once their
    /// trailing dots and their case are set aside are one tenant, on every
    /// system alike, and the bundles after the first are refused as a case
    /// twin is: a bundle claiming `shop.` cannot open the `shop` tenant's
    /// database. An id of dots alone is refused. A name that only ends in
    /// dots, with no twin, is a tenant as it always was.
    #[test]
    fn tenant_ids_that_differ_only_in_trailing_dots_are_one_tenant() {
        let root = crate::test_dirs::temp_path("softn-tenants-dot", "");
        let bundles = root.join("bundles");
        bundle(&bundles.join("a"), "shop");
        bundle(&bundles.join("b"), "shop.");
        // With no id the name is the tenant id, and a name may end in dots.
        for (dir, name) in [("c", "Shop.."), ("d", "..."), ("e", "Notes...")] {
            std::fs::create_dir_all(bundles.join(dir)).unwrap();
            let manifest = serde_json::json!({"name": name, "version": "1"});
            std::fs::write(bundles.join(dir).join("manifest.json"), serde_json::to_vec(&manifest).unwrap()).unwrap();
        }
        let data = root.join("data");
        let manager = TenantManager::load(&bundles, Some(&data), Some(1), false).unwrap();
        let mut ids = manager.tenant_ids();
        ids.sort();
        // Served on every system: on Windows its data directory is `Notes`,
        // and its database is opened there.
        assert_eq!(ids, vec!["Notes...", "shop"]);
        // `shop`, and `Notes...` (which Windows names `Notes`): nothing of the others'.
        assert_eq!(std::fs::read_dir(&data).unwrap().count(), 2);
        assert_eq!(std::fs::read_to_string(data.join("shop").join(OWNER_FILE)).unwrap(), "a", "another bundle wrote itself into the shop's record");
        // The rule itself, on its own: dots alone are refused, a name that
        // only ends in them is not.
        let (shutdown, _) = tokio::sync::watch::channel(false);
        let alone = |dir: &str| load_tenant(&bundles.join(dir), Some(&root.join("alone")), Some(1), 4, false, &shutdown, &|_| None).err();
        assert!(alone("d").is_some_and(|e| e.contains("dots alone")), "{:?}", alone("d"));
        assert!(alone("e").is_none(), "{:?}", alone("e"));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A bundle that may not be the tenant it names is refused before
    /// anything of that tenant's is opened: no data directory, no database.
    #[test]
    fn a_refused_tenant_id_touches_no_data() {
        let root = crate::test_dirs::temp_path("softn-tenants-refused", "");
        let reserved = RESERVED_TENANT_IDS[0];
        bundle(&root.join("bundles").join("ok"), "shop");
        bundle(&root.join("bundles").join("taken"), reserved);
        let data = root.join("data");
        let manager = TenantManager::load(&root.join("bundles"), Some(&data), Some(1), false).unwrap();
        assert_eq!(manager.tenant_ids(), vec!["shop"]);
        assert!(data.join("shop").is_dir());
        assert!(!data.join(reserved).exists(), "a refused tenant's data directory was created");
    }

    /// Two bundles claiming one id: the second never reaches the first's
    /// data. On a file system that tells `Shop` from `shop` the loser's
    /// directory is not created either.
    #[test]
    fn a_duplicate_tenant_is_refused_before_its_data_is_opened() {
        let root = crate::test_dirs::temp_path("softn-tenants-dup", "");
        bundle(&root.join("bundles").join("upper"), "Shop");
        bundle(&root.join("bundles").join("lower"), "shop");
        let data = root.join("data");
        let manager = TenantManager::load(&root.join("bundles"), Some(&data), Some(1), false).unwrap();
        assert_eq!(manager.tenant_ids().len(), 1);
        let directories = std::fs::read_dir(&data).unwrap().count();
        assert_eq!(directories, 1, "the refused duplicate left a data directory behind");
    }

    #[test]
    fn an_archive_and_its_unpacked_copy_are_one_tenant() {
        let root = crate::test_dirs::temp_path("softn-tenants-zip", "");
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

    fn versioned(dir: &Path, id: &str, version: &str) {
        std::fs::create_dir_all(dir).unwrap();
        let manifest = serde_json::json!({"id": id, "name": id, "version": version});
        std::fs::write(dir.join("manifest.json"), serde_json::to_vec(&manifest).unwrap()).unwrap();
    }

    /// One id, two bundles: the tenant is the one that served that data
    /// before, however the two are named, and it is the same one each start.
    #[test]
    fn of_two_bundles_claiming_an_id_the_one_that_served_its_data_before_is_the_tenant() {
        let root = crate::test_dirs::temp_path("softn-tenants-owner", "");
        let bundles = root.join("bundles");
        let data = root.join("data");
        let version = |bundles: &Path| {
            let manager = TenantManager::load(bundles, Some(&data), Some(1), false).unwrap();
            assert_eq!(manager.tenant_ids(), vec!["shop"]);
            manager.get("shop").unwrap().manifest.version.clone()
        };
        // The shop, alone: served, and on record.
        versioned(&bundles.join("shop"), "shop", "real");
        assert_eq!(version(&bundles), "real");
        assert_eq!(std::fs::read_to_string(data.join("shop").join(OWNER_FILE)).unwrap(), "shop");
        // A second bundle with its id, named to be read first.
        versioned(&bundles.join("a-copy"), "shop", "impostor");
        for _ in 0..2 {
            assert_eq!(version(&bundles), "real", "a bundle that never served this data took the tenant");
        }
        assert_eq!(std::fs::read_to_string(data.join("shop").join(OWNER_FILE)).unwrap(), "shop");

        // The archive form is read without being unpacked, and loses the same way.
        std::fs::remove_dir_all(bundles.join("a-copy")).unwrap();
        let mut zip = zip::ZipWriter::new(std::fs::File::create(bundles.join("a-shop.softn")).unwrap());
        zip.start_file("manifest.json", zip::write::SimpleFileOptions::default()).unwrap();
        zip.write_all(br#"{"id":"shop","name":"shop","version":"archived impostor"}"#).unwrap();
        zip.finish().unwrap();
        assert_eq!(version(&bundles), "real");
        assert!(!bundles.join("a-shop_bundle").exists(), "the refused archive was unpacked to find out its id");
        // Its manifest stored as `./manifest.json`, which unpacks as
        // `manifest.json`: read as unpacking reads it, and refused the same.
        std::fs::remove_file(bundles.join("a-shop.softn")).unwrap();
        let mut zip = zip::ZipWriter::new(std::fs::File::create(bundles.join("a-shop.softn")).unwrap());
        zip.start_file("./manifest.json", zip::write::SimpleFileOptions::default()).unwrap();
        zip.write_all(br#"{"id":"shop","name":"shop","version":"hidden impostor"}"#).unwrap();
        zip.finish().unwrap();
        assert_eq!(peek_tenant_id(&bundles.join("a-shop.softn")).as_deref(), Some("shop"));
        assert_eq!(version(&bundles), "real");
        assert!(!bundles.join("a-shop_bundle").exists(), "the refused archive was unpacked");
    }

    /// `game.softn` and `game.zip` would unpack to one directory: the first
    /// by name is loaded, and the other refused before it is unpacked over it.
    #[test]
    fn two_archives_of_one_name_are_not_unpacked_over_each_other() {
        let root = crate::test_dirs::temp_path("softn-tenants-stem", "");
        let bundles = root.join("bundles");
        std::fs::create_dir_all(&bundles).unwrap();
        for (file, id) in [("game.softn", "game"), ("game.zip", "other")] {
            let mut zip = zip::ZipWriter::new(std::fs::File::create(bundles.join(file)).unwrap());
            zip.start_file("manifest.json", zip::write::SimpleFileOptions::default()).unwrap();
            zip.write_all(serde_json::json!({"id": id, "name": id, "version": "1"}).to_string().as_bytes()).unwrap();
            zip.finish().unwrap();
        }
        let manager = TenantManager::load(&bundles, Some(&root.join("data")), Some(1), false).unwrap();
        assert_eq!(manager.tenant_ids(), vec!["game"]);
        let unpacked = std::fs::read_to_string(bundles.join("game_bundle").join("manifest.json")).unwrap();
        assert!(unpacked.contains(r#""id":"game""#), "{unpacked}");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A bundle's own `workers` is held to its share of the process's 200:
    /// with fifty bundles, the default four each.
    #[test]
    fn each_bundle_has_a_fair_share_of_the_worker_threads() {
        assert_eq!(fair_workers(1), 200);
        assert_eq!(fair_workers(3), 66);
        assert_eq!(fair_workers(50), 4);
        assert_eq!(fair_workers(500), 4);
        assert_eq!(fair_workers(0), 200);
    }

    /// The record settles a dispute and nothing else: a bundle renamed or
    /// moved, with no rival, is the tenant it always was.
    #[test]
    fn a_renamed_bundle_is_still_its_tenant() {
        let root = crate::test_dirs::temp_path("softn-tenants-rename", "");
        let data = root.join("data");
        versioned(&root.join("bundles").join("shop-1.0"), "shop", "1.0");
        TenantManager::load(&root.join("bundles"), Some(&data), Some(1), false).unwrap();
        std::fs::rename(root.join("bundles").join("shop-1.0"), root.join("bundles").join("shop-1.1")).unwrap();
        let manager = TenantManager::load(&root.join("bundles"), Some(&data), Some(1), false).unwrap();
        assert_eq!(manager.tenant_ids(), vec!["shop"]);
        assert_eq!(std::fs::read_to_string(data.join("shop").join(OWNER_FILE)).unwrap(), "shop-1.1");
        // And a whole new bundles directory elsewhere, as a release does it.
        versioned(&root.join("release-2").join("shop-1.1"), "shop", "1.1");
        let manager = TenantManager::load(&root.join("release-2"), Some(&data), Some(1), false).unwrap();
        assert_eq!(manager.tenant_ids(), vec!["shop"]);
    }

    /// With nothing on record the first by name is the tenant, every time.
    #[test]
    fn with_no_record_the_same_bundle_wins_every_start() {
        let root = crate::test_dirs::temp_path("softn-tenants-first", "");
        versioned(&root.join("bundles").join("b"), "shop", "b");
        versioned(&root.join("bundles").join("a"), "shop", "a");
        versioned(&root.join("bundles").join("c"), "shop", "c");
        for attempt in 0..3 {
            let data = root.join(format!("data-{attempt}"));
            let manager = TenantManager::load(&root.join("bundles"), Some(&data), Some(1), false).unwrap();
            assert_eq!(manager.get("shop").unwrap().manifest.version, "a");
        }
    }
}
