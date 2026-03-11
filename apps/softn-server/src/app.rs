use crate::bridges::{db::NativeDbBridge, env::NativeEnvBridge, fs::NativeFsBridge, http::NativeHttpBridge};
use crate::bundle::{self, ServerConfig, ServerManifest};
use crate::pool::ServerDb;
use crate::runtime::{BridgeSet, ServerRuntime};
use crate::sync::SyncManager;
use std::path::PathBuf;
use std::sync::Arc;

#[allow(dead_code)]
pub struct AppContext {
    pub manifest: ServerManifest,
    pub bundle_path: PathBuf,
    pub data_dir: PathBuf,
    pub db: ServerDb,
    pub runtime: Option<Arc<ServerRuntime>>,
    pub sync_manager: Arc<SyncManager>,
    /// Auth token for API routes (same token used for sync).
    /// Stored here for quick access in the API auth middleware.
    pub auth_token: Option<String>,
    /// Shutdown signal — when `true` is sent, WebSocket connections should
    /// send a clean Close frame and disconnect before the process exits.
    pub shutdown: tokio::sync::watch::Sender<bool>,
}

impl AppContext {
    pub fn load(bundle_path: PathBuf, data_dir: Option<PathBuf>, workers: Option<usize>) -> Result<Arc<Self>, String> {
        let bundle_path = std::fs::canonicalize(&bundle_path)
            .map_err(|e| format!("Invalid bundle path: {}", e))?;

        // If the path is a .softn ZIP file, extract it first
        let bundle_path = if bundle_path.is_file() {
            let ext = bundle_path.extension().and_then(|e| e.to_str()).unwrap_or("");
            if ext == "softn" || ext == "zip" {
                bundle::extract_softn_zip(&bundle_path)?
            } else {
                return Err(format!("Unsupported file type: .{}", ext));
            }
        } else {
            bundle_path
        };

        let manifest = bundle::load_manifest(&bundle_path)?;
        tracing::info!("Loaded app: {} v{}", manifest.name, manifest.version);

        // Data directory: prefer explicit --data-dir, then platform data dir,
        // then fall back to a sibling directory alongside the bundle.
        // Placing data alongside (not inside) the bundle prevents accidentally
        // packaging live databases/files when zipping the bundle directory.
        let data_dir = data_dir.unwrap_or_else(|| {
            if let Some(base) = dirs::data_dir() {
                // Use the manifest `id` (e.g. "com.mybrand.appname") if provided
                // — it's stable across moves/renames and globally unique by
                // convention. Fall back to name + path-hash for unnamed bundles,
                // with a warning since this is volatile (moving the bundle creates
                // a new empty database, appearing as data loss).
                if let Some(ref id) = manifest.id {
                    base.join("softn").join(id)
                } else {
                    tracing::warn!(
                        "No 'id' in manifest — data directory is derived from the bundle path. \
                         Moving or renaming the .softn file will create a new database. \
                         Add an 'id' field (e.g. \"com.yourname.{}\") to manifest.json for stable data storage.",
                        manifest.name
                    );
                    use sha2::Digest;
                    let path_hash = sha2::Sha256::digest(bundle_path.to_string_lossy().as_bytes());
                    let short_hash: String = path_hash.iter().take(6).map(|b| format!("{:02x}", b)).collect();
                    base.join("softn").join(format!("{}-{}", manifest.name, short_hash))
                }
            } else {
                // parent() returns "" for bare filenames like "app.softn",
                // which would create an invalid path. Default to "." (cwd).
                let base = bundle_path.parent()
                    .filter(|p| !p.as_os_str().is_empty())
                    .unwrap_or_else(|| std::path::Path::new("."))
                    .to_path_buf();
                base.join(format!("{}-data", manifest.name))
            }
        });
        std::fs::create_dir_all(&data_dir)
            .map_err(|e| format!("Failed to create data dir: {}", e))?;

        // Open XDB (writer) and create a read-only connection pool.
        // Read pool size: 2x CPUs, capped at 32. SQLite WAL reads are fast and
        // non-blocking, but under high concurrency (HTTP + WebSocket sync_pull)
        // a larger pool prevents simple reads from queuing behind long queries.
        let db_path = data_dir.join(format!("{}.sqlite", manifest.name));
        let shared_db = xdb::create_shared_db(db_path.clone())
            .map_err(|e| format!("Failed to open DB: {}", e))?;
        let read_pool_size = manifest.config.as_ref()
            .and_then(|c| c.get("server"))
            .and_then(|s| s.get("readPoolSize"))
            .and_then(|v| v.as_u64())
            .map(|n| (n as u32).clamp(2, 128))
            .unwrap_or_else(|| {
                std::thread::available_parallelism()
                    .map(|n| (n.get() * 2).min(32) as u32)
                    .unwrap_or(8)
            });
        let db = ServerDb::new(shared_db, &db_path, read_pool_size)?;
        tracing::info!("Database opened (read pool: {} connections)", read_pool_size);

        // Auth token from config
        let auth_token = manifest
            .config
            .as_ref()
            .and_then(|c| c.get("server"))
            .and_then(|s| serde_json::from_value::<ServerConfig>(s.clone()).ok())
            .and_then(|sc| sc.auth_token);

        // Load and run server scripts
        let runtime = if let Some(server) = &manifest.server {
            let source = bundle::load_server_scripts(&bundle_path, server)?;
            tracing::info!("Loaded server scripts ({} bytes)", source.len());

            let db_for_factory = db.clone();
            let fs_root = data_dir.join("files");
            std::fs::create_dir_all(&fs_root)
                .map_err(|e| format!("Failed to create files dir: {}", e))?;
            let fs_root_for_factory = fs_root.clone();

            // bridge_factory is Fn (not FnOnce) — called once per worker thread.
            // Each worker gets its own bridge instances but shares the same DB (Arc).
            // Worker count: prefer CLI --workers, then manifest config, then auto-detect.
            let configured_workers = workers.or_else(|| {
                manifest.config.as_ref()
                    .and_then(|c| c.get("server"))
                    .and_then(|s| s.get("workers"))
                    .and_then(|v| v.as_u64())
                    .map(|n| n as usize)
            });

            // Parse capability permissions from manifest server.permissions.
            // If set, only explicitly enabled bridges are available to scripts.
            // If not set, all bridges are enabled (backward compatible).
            // This implements deny-by-default for sensitive capabilities (http, fs)
            // when the developer explicitly opts into the permissions model.
            let permissions = server.permissions.as_ref();
            let allow_http = permissions
                .and_then(|p| p.get("http"))
                .and_then(|v| v.as_bool())
                .unwrap_or_else(|| permissions.is_none()); // default: on if no permissions block
            let allow_fs = permissions
                .and_then(|p| p.get("fs"))
                .and_then(|v| v.as_bool())
                .unwrap_or_else(|| permissions.is_none());

            if let Some(_p) = permissions {
                tracing::info!(
                    "Capabilities: db=always, env=always, http={}, fs={}",
                    allow_http, allow_fs
                );
            }

            let rt = ServerRuntime::new(move || BridgeSet {
                db: Some(Box::new(NativeDbBridge::new(db_for_factory.clone()))),
                http: if allow_http { Some(Box::new(NativeHttpBridge::new())) } else { None },
                fs: if allow_fs { Some(Box::new(NativeFsBridge::new(fs_root_for_factory.clone()))) } else { None },
                // env is always enabled (provides console.log via env.log)
                env: Some(Box::new(NativeEnvBridge)),
            }, configured_workers);

            // Initialize all worker threads with the same source
            rt.init(source)?;
            tracing::info!("Server scripts initialized");

            // Validate that all manifest route handlers exist in the script
            if let Some(routes) = server.routes.as_ref() {
                for route in routes {
                    if !rt.has_function(&route.handler) {
                        tracing::warn!(
                            "Route {} {} references handler '{}' which is not defined in the script",
                            route.method, route.path, route.handler
                        );
                    }
                }
            }

            // Call onStart if defined
            if rt.has_function("onStart") {
                match rt.call("onStart", vec![]) {
                    Ok(_) => tracing::info!("onStart() completed"),
                    Err(e) => tracing::error!("onStart() error: {}", e),
                }
            }

            Some(rt)
        } else {
            None
        };

        // Configurable pool limits — tunable via manifest config.server for
        // small VPS deployments where the auto-detected CPU-based defaults
        // (4x CPUs for sync, 2x CPUs for read pool) may be too restrictive.
        let max_storage_bytes = manifest.config.as_ref()
            .and_then(|c| c.get("server"))
            .and_then(|s| s.get("maxStorageMB"))
            .and_then(|v| v.as_u64())
            .map(|mb| mb.min(10 * 1024) * 1024 * 1024) // cap at 10TB
            .unwrap_or(512 * 1024 * 1024); // 512MB default

        let sync_permits = manifest.config.as_ref()
            .and_then(|c| c.get("server"))
            .and_then(|s| s.get("syncPermits"))
            .and_then(|v| v.as_u64())
            .map(|n| (n as usize).clamp(4, 256))
            .unwrap_or_else(|| {
                std::thread::available_parallelism()
                    .map(|n| (n.get() * 4).min(64))
                    .unwrap_or(32)
            });

        let sync_manager = SyncManager::new(
            db.clone(), runtime.clone(), auth_token.clone(),
            db_path.clone(), max_storage_bytes, sync_permits,
        );
        let (shutdown, _) = tokio::sync::watch::channel(false);

        Ok(Arc::new(Self {
            manifest,
            bundle_path,
            data_dir,
            db,
            runtime,
            sync_manager,
            auth_token,
            shutdown,
        }))
    }
}
