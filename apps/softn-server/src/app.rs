use crate::bridges::{db::NativeDbBridge, env::NativeEnvBridge, fs::NativeFsBridge, http::NativeHttpBridge};
use crate::bundle::{self, ServerConfig, ServerManifest};
use crate::runtime::{BridgeSet, ServerRuntime};
use crate::sync::SyncManager;
use std::path::PathBuf;
use std::sync::Arc;
use xdb::SharedDb;

#[allow(dead_code)]
pub struct AppContext {
    pub manifest: ServerManifest,
    pub bundle_path: PathBuf,
    pub data_dir: PathBuf,
    pub db: SharedDb,
    pub runtime: Option<Arc<ServerRuntime>>,
    pub sync_manager: Arc<SyncManager>,
}

impl AppContext {
    pub fn load(bundle_path: PathBuf, data_dir: Option<PathBuf>) -> Result<Arc<Self>, String> {
        let bundle_path = std::fs::canonicalize(&bundle_path)
            .map_err(|e| format!("Invalid bundle path: {}", e))?;

        let manifest = bundle::load_manifest(&bundle_path)?;
        tracing::info!("Loaded app: {} v{}", manifest.name, manifest.version);

        // Data directory
        let data_dir = data_dir.unwrap_or_else(|| {
            bundle_path.join("data")
        });
        std::fs::create_dir_all(&data_dir)
            .map_err(|e| format!("Failed to create data dir: {}", e))?;

        // Open XDB
        let db_path = data_dir.join(format!("{}.sqlite", manifest.name));
        let db = xdb::create_shared_db(db_path)
            .map_err(|e| format!("Failed to open DB: {}", e))?;
        tracing::info!("Database opened");

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

            let db_clone = db.clone();
            let fs_root = data_dir.join("files");
            std::fs::create_dir_all(&fs_root)
                .map_err(|e| format!("Failed to create files dir: {}", e))?;

            let rt = ServerRuntime::new(move || BridgeSet {
                db: Some(Box::new(NativeDbBridge::new(db_clone))),
                http: Some(Box::new(NativeHttpBridge::new())),
                fs: Some(Box::new(NativeFsBridge::new(fs_root))),
                env: Some(Box::new(NativeEnvBridge)),
            });

            // Initialize scripts
            rt.init(source)?;
            tracing::info!("Server scripts initialized");

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
