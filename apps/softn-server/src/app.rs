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
        // then fall back to a sibling "data" dir for local development.
        // If bundle_path is a file (e.g. ZIP), use its parent directory.
        let data_dir = data_dir.unwrap_or_else(|| {
            if let Some(base) = dirs::data_dir() {
                base.join("softn").join(&manifest.name)
            } else {
                let base = if bundle_path.is_file() {
                    bundle_path.parent().unwrap_or(&bundle_path).to_path_buf()
                } else {
                    bundle_path.clone()
                };
                base.join("data")
            }
        });
        std::fs::create_dir_all(&data_dir)
            .map_err(|e| format!("Failed to create data dir: {}", e))?;

        // Open XDB (writer) and create a read-only connection pool.
        // Read pool size: min(cpu_count, 8) — enough for concurrent sync_pull + script reads.
        let db_path = data_dir.join(format!("{}.sqlite", manifest.name));
        let shared_db = xdb::create_shared_db(db_path.clone())
            .map_err(|e| format!("Failed to open DB: {}", e))?;
        let read_pool_size = std::thread::available_parallelism()
            .map(|n| n.get().min(8) as u32)
            .unwrap_or(4);
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

            let rt = ServerRuntime::new(move || BridgeSet {
                db: Some(Box::new(NativeDbBridge::new(db_for_factory.clone()))),
                http: Some(Box::new(NativeHttpBridge::new())),
                fs: Some(Box::new(NativeFsBridge::new(fs_root_for_factory.clone()))),
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

        let sync_manager = SyncManager::new(db.clone(), runtime.clone(), auth_token);

        Ok(Arc::new(Self {
            manifest,
            bundle_path,
            data_dir,
            db,
            runtime,
            sync_manager,
        }))
    }
}
