//! Operator-owned grants and private migration lifecycle, shared by both loaders.
use crate::{
    bridges::{
        crypto::{hex, CryptoDomains, NativeCrypto},
        sql::{self, NativeSql},
    },
    bundle::{ServerBlock, ServerManifest},
};
use rusqlite::OptionalExtension;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct OperatorConfig {
    bundle_path: PathBuf,
    capabilities: Vec<String>,
    #[serde(default)]
    development: bool,
    key_hex: Option<String>,
    #[serde(default)]
    crypto_domains: CryptoDomains,
}

#[derive(Clone, Default)]
pub struct PrivateBackend {
    database: Option<PathBuf>,
    pub crypto: Option<NativeCrypto>,
    pub time: bool,
    pub development: bool,
    pub photos: bool,
}

impl PrivateBackend {
    pub fn load(
        manifest: &ServerManifest,
        bundle_path: &Path,
        data_dir: &Path,
    ) -> Result<Self, String> {
        sql::reject_symlink(data_dir)?;
        let registered = data_dir.join("backend.json").exists();
        if manifest
            .server
            .as_ref()
            .and_then(|s| s.requires.as_ref())
            .is_none()
        {
            if registered {
                return Err(
                    "An operator-registered private backend cannot be opened by a legacy bundle"
                        .into(),
                );
            }
            return Ok(Self::default());
        }
        let server = manifest.server.as_ref().unwrap();
        let required = server.requires.as_ref().unwrap();
        sql::reject_symlink(data_dir)?;
        let config_path = data_dir.join("backend.json");
        sql::reject_symlink(&config_path)?;
        let config_bytes = std::fs::read(&config_path)
            .map_err(|_| "API v1 requires operator-owned backend.json in --data-dir")?;
        if config_bytes.len() > 16_384 {
            return Err("Operator backend configuration is too large".into());
        }
        let config: OperatorConfig =
            serde_json::from_slice(&config_bytes).map_err(|_| "Invalid operator backend.json")?;
        let approved = std::fs::canonicalize(&config.bundle_path)
            .map_err(|_| "Operator bundlePath is not an existing deployment directory")?;
        let actual = std::fs::canonicalize(bundle_path)
            .map_err(|_| "Cannot resolve private bundle directory")?;
        if approved != actual {
            return Err("This bundle does not own the configured private backend directory".into());
        }
        let canonical_data =
            std::fs::canonicalize(data_dir).map_err(|_| "Cannot resolve private data directory")?;
        if canonical_data.starts_with(&actual) || actual.starts_with(&canonical_data) {
            return Err(
                "The private data directory and deployment directory must not overlap".into(),
            );
        }
        let granted: HashSet<&str> = config.capabilities.iter().map(String::as_str).collect();
        for capability in &required.capabilities {
            if !granted.contains(capability.as_str()) {
                return Err(format!(
                    "Operator has not granted required capability: {capability}"
                ));
            }
        }
        let requested = |c: &str| required.capabilities.iter().any(|r| r == c);
        let crypto = if requested("crypto") {
            Some(NativeCrypto::from_hex(
                config
                    .key_hex
                    .as_deref()
                    .ok_or("Crypto requires operator keyHex in backend.json")?,
                &config.crypto_domains,
            )?)
        } else {
            None
        };
        let database = if requested("sql") {
            let db = server
                .database
                .as_ref()
                .ok_or("SQL requires a private database declaration")?;
            if db.kind != "private-sqlite" {
                return Err("Unsupported private database kind".into());
            }
            let path = data_dir.join("application.sqlite");
            apply_migrations(&path, bundle_path, server)?;
            Some(path)
        } else {
            None
        };
        Ok(Self {
            database,
            crypto,
            time: requested("time"),
            development: config.development,
            photos: requested("photos"),
        })
    }

    pub fn sql(&self) -> Option<NativeSql> {
        self.database.clone().map(NativeSql::new)
    }
}

pub fn sync_enabled(manifest: &ServerManifest) -> bool {
    manifest
        .server
        .as_ref()
        .and_then(|s| s.sync.as_ref())
        .is_none_or(|s| s.enabled)
}

fn apply_migrations(path: &Path, bundle: &Path, server: &ServerBlock) -> Result<(), String> {
    let conn = sql::open_connection(path)?;
    conn.execute_batch("CREATE TABLE IF NOT EXISTS _migrations(name TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at INTEGER NOT NULL) STRICT;")
        .map_err(|_| "Cannot open migration ledger")?;
    let mut migrations = server.database.as_ref().unwrap().migrations.clone();
    migrations.sort();
    if migrations.windows(2).any(|m| m[0] == m[1]) {
        return Err("Duplicate migration path".into());
    }
    let mut names = HashSet::new();
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|_| "Private migration database is busy")?;
    let result = (|| {
        for relative in migrations {
            let full = crate::bundle::validate_script_path(bundle, &relative)?;
            let name = full
                .file_name()
                .and_then(|s| s.to_str())
                .ok_or("Invalid migration filename")?;
            if !name.ends_with(".sql") || !names.insert(name.to_string()) {
                return Err("Migration filenames must be unique .sql files".into());
            }
            let bytes = std::fs::read(&full).map_err(|_| "Cannot read declared migration")?;
            if bytes.len() > 256 * 1024 {
                return Err("Migration exceeds byte limit".into());
            }
            let script = std::str::from_utf8(&bytes).map_err(|_| "Migration must be UTF-8")?;
            let checksum = hex(&Sha256::digest(&bytes));
            let previous: Option<String> = conn
                .query_row("SELECT sha256 FROM _migrations WHERE name=?", [name], |r| {
                    r.get(0)
                })
                .optional()
                .map_err(|_| "Cannot read migration ledger")?;
            if let Some(previous) = previous {
                if previous != checksum {
                    return Err(format!("Applied migration checksum changed: {name}"));
                }
                continue;
            }
            let deadline = Instant::now() + Duration::from_secs(10);
            let mut steps = 0u64;
            conn.progress_handler(
                1000,
                Some(move || {
                    steps += 1000;
                    steps > 5_000_000 || Instant::now() > deadline
                }),
            );
            conn.authorizer(Some(|ctx: rusqlite::hooks::AuthContext<'_>| {
                sql::authorize(ctx, true, true)
            }));
            let applied = conn.execute_batch(script);
            sql::clear_authorizer(&conn);
            conn.progress_handler(0, None::<fn() -> bool>);
            applied.map_err(|e| format!("Migration {name} failed: {e}"))?;
            conn.execute(
                "INSERT INTO _migrations VALUES(?,?,?)",
                rusqlite::params![name, checksum, chrono::Utc::now().timestamp()],
            )
            .map_err(|_| "Cannot update migration ledger")?;
        }
        let existing: Vec<String> = conn
            .prepare("SELECT name FROM _migrations")
            .map_err(|_| "Cannot read migration ledger")?
            .query_map([], |r| r.get(0))
            .map_err(|_| "Cannot read migration ledger")?
            .collect::<Result<_, _>>()
            .map_err(|_| "Cannot read migration ledger")?;
        if existing.iter().any(|name| !names.contains(name)) {
            return Err("Deployment removed a previously applied migration".into());
        }
        Ok(())
    })();
    match result {
        Ok(()) => conn
            .execute_batch("COMMIT")
            .map_err(|_| "Cannot commit migrations".into()),
        Err(e) => {
            sql::clear_authorizer(&conn);
            let _ = conn.execute_batch("ROLLBACK");
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn operator_registration_and_grants_fail_closed() {
        let root = std::env::temp_dir().join(format!("softn-grants-{}", uuid::Uuid::new_v4()));
        let bundle = root.join("bundle");
        let data = root.join("data");
        let sibling = root.join("sibling");
        for path in [&bundle, &data, &sibling] {
            std::fs::create_dir_all(path).unwrap();
        }
        let manifest: ServerManifest = serde_json::from_value(serde_json::json!({
            "id":"com.example.private", "name":"Private", "version":"1",
            "server":{"requires":{"apiVersion":1,"capabilities":["crypto","time"]}}
        }))
        .unwrap();
        assert!(PrivateBackend::load(&manifest, &bundle, &data).is_err());
        let mut config = serde_json::json!({"bundlePath":bundle,"capabilities":["crypto","time"],"development":false,"keyHex":"11".repeat(32)});
        let write = |value: &serde_json::Value| {
            std::fs::write(
                data.join("backend.json"),
                serde_json::to_vec(value).unwrap(),
            )
            .unwrap()
        };
        write(&config);
        assert!(PrivateBackend::load(&manifest, &bundle, &data).is_ok());
        assert!(PrivateBackend::load(&manifest, &sibling, &data).is_err());
        let legacy: ServerManifest = serde_json::from_value(serde_json::json!({
            "id":"com.example.private", "name":"application", "version":"1"
        }))
        .unwrap();
        assert!(PrivateBackend::load(&legacy, &sibling, &data).is_err());
        config["capabilities"] = serde_json::json!(["time"]);
        write(&config);
        assert!(PrivateBackend::load(&manifest, &bundle, &data).is_err());
        config["capabilities"] = serde_json::json!(["crypto", "time"]);
        config["keyHex"] = "invalid".into();
        write(&config);
        assert!(PrivateBackend::load(&manifest, &bundle, &data).is_err());
    }

    #[test]
    fn migrations_are_atomic_checksummed_and_cannot_escape() {
        let root = std::env::temp_dir().join(format!("softn-migrations-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("server")).unwrap();
        let path = root.join("application.sqlite");
        let migration = root.join("server/001_initial.sql");
        std::fs::write(&migration, "CREATE TABLE users(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT) STRICT; CREATE INDEX users_name ON users(name);").unwrap();
        let server: ServerBlock = serde_json::from_value(serde_json::json!({"database":{"kind":"private-sqlite","migrations":["server/001_initial.sql"]}})).unwrap();
        apply_migrations(&path, &root, &server).unwrap();
        apply_migrations(&path, &root, &server).unwrap();
        std::fs::write(&migration, "CREATE TABLE changed(x);").unwrap();
        assert!(apply_migrations(&path, &root, &server)
            .unwrap_err()
            .contains("checksum changed"));
        let bad: ServerBlock = serde_json::from_value(serde_json::json!({"database":{"kind":"private-sqlite","migrations":["../outside.sql"]}})).unwrap();
        assert!(apply_migrations(&path, &root, &bad).is_err());
        std::fs::write(
            &migration,
            "CREATE TABLE temporary_app_data(x); ATTACH DATABASE ':memory:' AS escape;",
        )
        .unwrap();
        let new_path = root.join("new.sqlite");
        assert!(apply_migrations(&new_path, &root, &server).is_err());
        let conn = sql::open_connection(&new_path).unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name='temporary_app_data'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
    }
}
