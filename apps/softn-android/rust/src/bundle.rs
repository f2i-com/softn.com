//! `.softn` v2 Web App Container bundle loader, manifest parser, and capability gatekeeper.
//!
//! Reads a `.softn` ZIP archive into an in-memory VFS, discovers the frontend entry
//! (`manifest.json` or zero-config `index.html` / `public/index.html` / `dist/index.html`),
//! parses `permission.json`, and enforces capability & egress rules natively in Rust.

use std::collections::{HashMap, HashSet};
use std::io::{Cursor, Read};
use std::net::{IpAddr, Ipv4Addr};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

pub const VIRTUAL_ORIGIN: &str = "https://app.softn.local";
const MAX_ARCHIVE_ENTRIES: usize = 10_000;
const MAX_ENTRY_BYTES: usize = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES: usize = 256 * 1024 * 1024;
const MAX_MANIFEST_BYTES: usize = 1024 * 1024;
const MAX_PERMISSION_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct BackendConfig {
    pub runtime: String,
    pub entry: String,
    #[serde(default)]
    pub root: Option<String>,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub routes: Option<Vec<String>>,
    #[serde(default, rename = "interceptOrigins")]
    pub intercept_origins: Option<Vec<String>>,
    #[serde(default)]
    pub env: Option<HashMap<String, String>>,
    #[serde(default, rename = "phpMode")]
    pub php_mode: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct DatabaseConfig {
    pub name: String,
    #[serde(default)]
    pub engine: Option<String>,
    #[serde(default)]
    pub file: Option<String>,
    #[serde(default, rename = "seedSql")]
    pub seed_sql: Option<String>,
    #[serde(default, rename = "seedJson")]
    pub seed_json: Option<Value>,
    #[serde(default)]
    pub persist: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct ContainerManifest {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub main: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub theme: Option<String>,
    #[serde(default, rename = "frontendRoot")]
    pub frontend_root: Option<String>,
    #[serde(default)]
    pub backend: Option<BackendConfig>,
    #[serde(default)]
    pub databases: Option<Vec<DatabaseConfig>>,
    #[serde(default, rename = "ssrEntry")]
    pub ssr_entry: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct NetPermission {
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub allowed_hosts: Option<Vec<String>>,
    #[serde(default)]
    pub allow_http: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct BluetoothPermission {
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub services: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct LocationPermission {
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub precision: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct BoolPermission {
    #[serde(default)]
    pub enabled: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct PermissionsMap {
    #[serde(default)]
    pub net: Option<NetPermission>,
    #[serde(default)]
    pub camera: Option<BoolPermission>,
    #[serde(default)]
    pub mic: Option<BoolPermission>,
    #[serde(default)]
    pub files: Option<BoolPermission>,
    #[serde(default)]
    pub qr: Option<BoolPermission>,
    #[serde(default)]
    pub ai: Option<BoolPermission>,
    #[serde(default)]
    pub gpu: Option<BoolPermission>,
    #[serde(default)]
    pub sync: Option<BoolPermission>,
    #[serde(default)]
    pub storage: Option<BoolPermission>,
    #[serde(default)]
    pub accel: Option<BoolPermission>,
    #[serde(default)]
    pub bluetooth: Option<BluetoothPermission>,
    #[serde(default)]
    pub location: Option<LocationPermission>,
    #[serde(default)]
    pub haptics: Option<BoolPermission>,
    #[serde(default)]
    pub notifications: Option<BoolPermission>,
    #[serde(default)]
    pub clipboard: Option<BoolPermission>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct PermissionFile {
    #[serde(default)]
    pub permissions: PermissionsMap,
}

#[derive(Debug, Clone)]
pub struct SoftnBundle {
    pub app_id: String,
    pub digest: String,
    pub name: String,
    pub version: String,
    pub manifest: ContainerManifest,
    pub permissions: PermissionFile,
    pub entry_path: String,
    pub frontend_root: String,
    pub vfs: Arc<HashMap<String, Vec<u8>>>,
}

/// Strip `VIRTUAL_ORIGIN` only when it matches the full origin boundary (not e.g.
/// `https://app.softn.local.evil.com/...`).
pub fn strip_virtual_origin(raw: &str) -> Option<&str> {
    let rest = raw.strip_prefix(VIRTUAL_ORIGIN)?;
    if rest.is_empty()
        || rest.starts_with('/')
        || rest.starts_with('?')
        || rest.starts_with('#')
    {
        Some(rest)
    } else {
        None
    }
}

/// Canonicalize a Bluetooth GATT 16-bit (`180d`), 32-bit (`0000180d`), or 128-bit UUID
/// into lowercase 128-bit hyphenated form (`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`).
pub fn canonical_ble_uuid(raw: &str) -> Option<String> {
    let s = raw.trim().to_ascii_lowercase();
    let s = s.strip_prefix("0x").unwrap_or(&s);
    if s.len() == 4 && s.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Some(format!("0000{s}-0000-1000-8000-00805f9b34fb"));
    }
    if s.len() == 8 && s.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Some(format!("{s}-0000-1000-8000-00805f9b34fb"));
    }
    if s.len() == 36 {
        let b = s.as_bytes();
        let dashes_ok = b[8] == b'-' && b[13] == b'-' && b[18] == b'-' && b[23] == b'-';
        let hex_ok = b.iter().enumerate().all(|(i, &ch)| {
            matches!(i, 8 | 13 | 18 | 23) || ch.is_ascii_hexdigit()
        });
        if dashes_ok && hex_ok {
            return Some(s.to_string());
        }
    }
    None
}

/// Normalize a virtual filesystem path (strip leading `/`, `./`, collapse `..`).
pub fn normalize_vfs_path(raw: &str) -> String {
    let normalized = raw.replace('\\', "/");
    let mut parts: Vec<&str> = Vec::new();
    for seg in normalized.split('/') {
        match seg {
            "" | "." => continue,
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    parts.join("/")
}

/// The file a URL path names, as a server (and the web container) reads it: the query and
/// fragment dropped and each segment's percent-escapes decoded, so `caf%C3%A9.png` is the
/// archive's `café.png`. None when an escape decodes to a separator or NUL, which no name in
/// the archive holds (`%2F` would otherwise smuggle a `..`). A path whose escapes are not
/// escapes at all (`100%.png`) is taken as written.
fn url_path_to_vfs(raw: &str) -> Option<String> {
    let path = raw.split(['?', '#']).next().unwrap_or(raw);
    if !path.contains('%') {
        return Some(path.to_string());
    }
    let mut out = String::with_capacity(path.len());
    for (i, seg) in path.split('/').enumerate() {
        if i > 0 {
            out.push('/');
        }
        let Some(decoded) = percent_decode_segment(seg) else {
            return Some(path.to_string());
        };
        if decoded.contains(['/', '\\', '\0']) {
            return None;
        }
        out.push_str(&decoded);
    }
    Some(out)
}

/// `%XX` escapes as bytes, then UTF-8; None when an escape is malformed or the bytes are not text.
fn percent_decode_segment(seg: &str) -> Option<String> {
    let bytes = seg.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = bytes.get(i + 1..i + 3)?;
            let hi = (hex[0] as char).to_digit(16)?;
            let lo = (hex[1] as char).to_digit(16)?;
            out.push((hi * 16 + lo) as u8);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Resolve a relative or root-relative URL against `importer_path` and optional `frontend_root`.
pub fn resolve_vfs_url(raw: &str, importer_path: &str, frontend_root: &str) -> Option<String> {
    let stripped = raw
        .split('#')
        .next()
        .unwrap_or(raw)
        .split('?')
        .next()
        .unwrap_or(raw)
        .trim();

    if stripped.is_empty() {
        return None;
    }

    let rel = if let Some(rest) = strip_virtual_origin(stripped) {
        rest
    } else if stripped.starts_with("http://")
        || stripped.starts_with("https://")
        || stripped.starts_with("data:")
        || stripped.starts_with("blob:")
        || stripped.starts_with("softn:")
    {
        return None;
    } else {
        stripped
    };
    let decoded = url_path_to_vfs(rel)?;
    let rel = decoded.as_str();

    if rel.starts_with('/') {
        let clean = normalize_vfs_path(rel);
        if !frontend_root.is_empty() && !clean.starts_with(&format!("{frontend_root}/")) && clean != frontend_root {
            Some(normalize_vfs_path(&format!("{frontend_root}/{clean}")))
        } else {
            Some(clean)
        }
    } else {
        let base_dir = importer_path
            .rsplit_once('/')
            .map(|(dir, _)| dir)
            .unwrap_or("");
        if base_dir.is_empty() {
            Some(normalize_vfs_path(rel))
        } else {
            Some(normalize_vfs_path(&format!("{base_dir}/{rel}")))
        }
    }
}

pub fn mime_type_for(path: &str) -> &'static str {
    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".html") || lower.ends_with(".htm") {
        "text/html; charset=utf-8"
    } else if lower.ends_with(".css") {
        "text/css; charset=utf-8"
    } else if lower.ends_with(".js") || lower.ends_with(".mjs") {
        "application/javascript; charset=utf-8"
    } else if lower.ends_with(".ts") || lower.ends_with(".tsx") || lower.ends_with(".jsx") {
        "text/typescript; charset=utf-8"
    } else if lower.ends_with(".json") {
        "application/json; charset=utf-8"
    } else if lower.ends_with(".svg") {
        "image/svg+xml"
    } else if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        "image/jpeg"
    } else if lower.ends_with(".webp") {
        "image/webp"
    } else if lower.ends_with(".gif") {
        "image/gif"
    } else if lower.ends_with(".ico") {
        "image/x-icon"
    } else if lower.ends_with(".woff2") {
        "font/woff2"
    } else if lower.ends_with(".woff") {
        "font/woff"
    } else if lower.ends_with(".ttf") {
        "font/ttf"
    } else if lower.ends_with(".wasm") {
        "application/wasm"
    } else if lower.ends_with(".txt") || lower.ends_with(".md") {
        "text/plain; charset=utf-8"
    } else {
        "application/octet-stream"
    }
}

fn is_private_asset_path(rel: &str) -> bool {
    let lower = rel.to_ascii_lowercase();
    if lower.is_empty() {
        return false;
    }
    if lower
        .split('/')
        .any(|seg| seg.starts_with('.') && seg != ".well-known")
    {
        return true;
    }
    if lower.starts_with("backend/")
        || lower.starts_with("server/")
        || lower.starts_with("private/")
        || lower.starts_with("db/")
        || lower.starts_with("database/")
        || lower.starts_with("migrations/")
    {
        return true;
    }
    let base = lower.rsplit('/').next().unwrap_or(&lower);
    if matches!(
        base,
        "manifest.json"
            | "permission.json"
            | "cargo.toml"
            | "cargo.lock"
            | "composer.json"
            | "composer.lock"
            | "seed.json"
    ) {
        return true;
    }
    for ext in [
        ".php",
        ".php5",
        ".php7",
        ".php8",
        ".pht",
        ".phps",
        ".phtml",
        ".inc",
        ".phar",
        ".tpl",
        ".py",
        ".rs",
        ".toml",
        ".sql",
        ".db",
        ".db-wal",
        ".db-shm",
        ".db-journal",
        ".sqlite",
        ".sqlite-wal",
        ".sqlite-shm",
        ".sqlite-journal",
        ".sqlite3",
        ".sqlite3-wal",
        ".sqlite3-shm",
        ".sqlite3-journal",
        ".pem",
        ".key",
        ".secret",
        ".ini",
        ".bak",
        ".log",
        ".sh",
        ".logic",
    ] {
        if lower.ends_with(ext) {
            return true;
        }
    }
    false
}

/// Returns `true` for IPs that must never be reachable from sandboxed container apps:
/// loopback, private (RFC1918), link-local (including cloud metadata 169.254.169.254),
/// CGNAT, multicast, broadcast, unspecified, IPv4-mapped/translated IPv6, NAT64, 6to4, and ULA.
pub fn is_blocked_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_blocked_ipv4(&v4),
        IpAddr::V6(v6) => {
            if v6.is_loopback() || v6.is_unspecified() || v6.is_multicast() {
                return true;
            }
            let segments = v6.segments();
            let bits = u128::from(v6);
            if (segments[0] & 0xfe00) == 0xfc00
                || (segments[0] & 0xffc0) == 0xfe80
                || (segments[0] & 0xffc0) == 0xfec0
                || (segments[0] == 0x0100
                    && segments[1] == 0
                    && segments[2] == 0
                    && segments[3] == 0)
                || (segments[0] == 0x2001 && segments[1] == 0x0000)
                // RFC 8215 local-use NAT64 (64:ff9b:1::/48)
                || (segments[0] == 0x0064 && segments[1] == 0xff9b && segments[2] == 0x0001)
                // RFC 5180 benchmarking (2001:2::/48)
                || (segments[0] == 0x2001 && segments[1] == 0x0002 && segments[2] == 0x0000)
                // RFC 4843 / 7343 ORCHID & ORCHIDv2 (2001:10::/28, 2001:20::/28)
                || (segments[0] == 0x2001 && (segments[1] & 0xfff0) == 0x0010)
                || (segments[0] == 0x2001 && (segments[1] & 0xfff0) == 0x0020)
                // RFC 9602 SRv6 SID prefix (5f00::/16)
                || segments[0] == 0x5f00
            {
                return true;
            }
            let low32 = Ipv4Addr::from(bits as u32);
            if segments[0..5] == [0, 0, 0, 0, 0] && (segments[5] == 0xffff || segments[5] == 0) {
                return is_blocked_ipv4(&low32);
            }
            if segments[0..4] == [0, 0, 0, 0] && segments[4] == 0xffff && segments[5] == 0 {
                return is_blocked_ipv4(&low32);
            }
            // RFC 6052 well-known NAT64 prefix (64:ff9b::/96)
            if segments[0] == 0x0064 && segments[1] == 0xff9b && segments[2..6] == [0, 0, 0, 0] {
                return is_blocked_ipv4(&low32);
            }
            if segments[0] == 0x2002 {
                return is_blocked_ipv4(&Ipv4Addr::from((bits >> 80) as u32));
            }
            false
        }
    }
}

fn is_blocked_ipv4(v4: &Ipv4Addr) -> bool {
    let [a, b, c, _] = v4.octets();
    a == 0
        || v4.is_loopback()
        || v4.is_private()
        || v4.is_link_local()
        || (a == 100 && (b & 0xC0) == 64)
        || (a == 192 && b == 0 && c == 0)
        || (a == 198 && (b & 0xFE) == 18)
        || a >= 224
}

impl SoftnBundle {
    pub fn from_zip_bytes(bytes: &[u8]) -> Result<Self, String> {
        let mut hasher = Sha256::new();
        hasher.update(bytes);
        let digest = format!("{:x}", hasher.finalize());

        let reader = Cursor::new(bytes);
        let mut archive = zip::ZipArchive::new(reader)
            .map_err(|e| format!("Invalid .softn ZIP archive: {e}"))?;

        if archive.len() > MAX_ARCHIVE_ENTRIES {
            return Err(format!(
                "Archive exceeds maximum entry count ({MAX_ARCHIVE_ENTRIES})"
            ));
        }

        let mut vfs = HashMap::with_capacity(archive.len());
        let mut seen_lower: HashSet<String> = HashSet::with_capacity(archive.len());
        let mut total_bytes: usize = 0;

        for i in 0..archive.len() {
            let file = archive
                .by_index(i)
                .map_err(|e| format!("Failed to read archive entry #{i}: {e}"))?;
            if file
                .unix_mode()
                .is_some_and(|mode| (mode & 0o170000) == 0o120000)
            {
                return Err(format!("Archive entry #{i} is a symlink (not allowed)"));
            }
            if file.is_dir() {
                continue;
            }
            let raw_name = file
                .name()
                .map_err(|e| format!("Invalid archive entry name #{i}: {e}"))?
                .into_owned();
            if raw_name.bytes().any(|b| b < 0x20 || b == 0x7f) {
                return Err(format!("Archive entry #{i} contains control characters"));
            }
            if raw_name.starts_with('/')
                || raw_name.starts_with('\\')
                || (raw_name.len() >= 2
                    && raw_name.as_bytes()[0].is_ascii_alphabetic()
                    && raw_name.as_bytes()[1] == b':')
            {
                return Err(format!(
                    "Archive entry '{raw_name}' uses an absolute or drive-qualified path"
                ));
            }
            if raw_name.replace('\\', "/").split('/').any(|seg| seg == "..") {
                return Err(format!(
                    "Archive entry '{raw_name}' contains path traversal ('..')"
                ));
            }
            let name = normalize_vfs_path(&raw_name);
            if name.is_empty() {
                continue;
            }
            if !seen_lower.insert(name.to_ascii_lowercase()) {
                return Err(format!(
                    "Archive contains duplicate or case-colliding entry '{name}'"
                ));
            }
            // Stream with a strict take() limit so crafted ZIP bombs cannot OOM-kill the process
            // before the total-size check runs.
            let remaining = MAX_TOTAL_BYTES.saturating_sub(total_bytes);
            let entry_cap = remaining.min(MAX_ENTRY_BYTES);
            let mut buf = Vec::new();
            file.take((entry_cap + 1) as u64)
                .read_to_end(&mut buf)
                .map_err(|e| format!("Failed to decompress '{name}': {e}"))?;
            if buf.len() > entry_cap {
                if buf.len() > MAX_ENTRY_BYTES {
                    return Err(format!(
                        "Archive entry '{name}' exceeds {} MiB uncompressed limit",
                        MAX_ENTRY_BYTES / (1024 * 1024)
                    ));
                }
                return Err(format!(
                    "Archive uncompressed size exceeds {} MiB limit",
                    MAX_TOTAL_BYTES / (1024 * 1024)
                ));
            }
            total_bytes = total_bytes.saturating_add(buf.len());
            vfs.insert(name, buf);
        }

        let manifest: ContainerManifest = match vfs.get("manifest.json") {
            Some(raw) => {
                if raw.len() > MAX_MANIFEST_BYTES {
                    return Err("manifest.json exceeds 1 MiB limit".into());
                }
                serde_json::from_slice(raw)
                    .map_err(|e| format!("Invalid manifest.json: {e}"))?
            }
            None => ContainerManifest::default(),
        };

        let permissions: PermissionFile = match vfs.get("permission.json") {
            Some(raw) => {
                if raw.len() > MAX_PERMISSION_BYTES {
                    return Err("permission.json exceeds 256 KiB limit".into());
                }
                serde_json::from_slice(raw)
                    .map_err(|e| format!("Invalid permission.json: {e}"))?
            }
            None => PermissionFile::default(),
        };

        // Discover entry HTML and frontendRoot
        let (entry_path, frontend_root) = Self::discover_entry(&manifest, &vfs)?;

        let inferred_title = vfs
            .get(&entry_path)
            .and_then(|b| extract_html_title(&String::from_utf8_lossy(b)));

        let name = manifest
            .name
            .clone()
            .filter(|s| !s.trim().is_empty())
            .or(inferred_title)
            .unwrap_or_else(|| "SoftN App".to_string());

        let version = manifest
            .version
            .clone()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "1.0.0".to_string());

        let app_id = manifest
            .id
            .clone()
            .filter(|s| !s.trim().is_empty())
            .map(|id| sanitize_app_id(&id, &digest))
            .unwrap_or_else(|| format!("sha256_{}", &digest[..16]));

        Ok(Self {
            app_id,
            digest,
            name,
            version,
            manifest,
            permissions,
            entry_path,
            frontend_root,
            vfs: Arc::new(vfs),
        })
    }

    /// Directory key under the host's data root for this bundle's persistent state.
    /// In Player Mode (untrusted third-party `.softn` bundles), key by the bundle's
    /// cryptographic SHA-256 digest so a spoofed `manifest.id` cannot hijack another
    /// app's SQLite/localStorage/cookie/IDB state.
    pub fn storage_dir_id(&self, player_mode: bool) -> String {
        if player_mode {
            format!("sha256_{}", &self.digest[..24])
        } else {
            self.app_id.clone()
        }
    }

    fn discover_entry(
        manifest: &ContainerManifest,
        vfs: &HashMap<String, Vec<u8>>,
    ) -> Result<(String, String), String> {
        let declared_root = manifest
            .frontend_root
            .as_deref()
            .map(normalize_vfs_path)
            .unwrap_or_default();

        if let Some(main) = &manifest.main {
            let norm = normalize_vfs_path(main);
            if vfs.contains_key(&norm) {
                let root = if !declared_root.is_empty() {
                    declared_root
                } else {
                    norm.rsplit_once('/').map(|(d, _)| d.to_string()).unwrap_or_default()
                };
                return Ok((norm, root));
            }
        }

        for candidate in ["index.html", "public/index.html", "dist/index.html"] {
            if vfs.contains_key(candidate) {
                let root = if !declared_root.is_empty() {
                    declared_root
                } else {
                    candidate.rsplit_once('/').map(|(d, _)| d.to_string()).unwrap_or_default()
                };
                return Ok((candidate.to_string(), root));
            }
        }

        // SSR-only backend apps may not ship a static index.html
        if manifest.backend.is_some() {
            return Ok((String::new(), declared_root));
        }

        // Last resort: first .html file in archive
        let mut htmls: Vec<&String> = vfs
            .keys()
            .filter(|k| k.ends_with(".html") || k.ends_with(".htm"))
            .collect();
        htmls.sort();
        if let Some(first) = htmls.first() {
            let root = first.rsplit_once('/').map(|(d, _)| d.to_string()).unwrap_or_default();
            return Ok(((*first).clone(), root));
        }

        Err("No index.html or backend entry found in .softn archive".into())
    }

    pub fn read_text(&self, path: &str) -> Option<String> {
        let norm = normalize_vfs_path(path);
        self.vfs
            .get(&norm)
            .map(|b| String::from_utf8_lossy(b).into_owned())
    }

    /// Returns `true` if `path` belongs to private backend, database, or manifest/dotfile assets
    /// that must never be served directly to guest frontend scripts or public asset fetches.
    pub fn is_private_asset(&self, path: &str) -> bool {
        let norm = normalize_vfs_path(path);
        if norm.is_empty() {
            return false;
        }
        if is_private_asset_path(&norm) {
            return true;
        }
        let lower = norm.to_ascii_lowercase();
        if let Some(ref be) = self.manifest.backend {
            let entry = normalize_vfs_path(&be.entry).to_ascii_lowercase();
            if !entry.is_empty() && lower == entry {
                return true;
            }
            if let Some(ref raw_root) = be.root {
                let root = normalize_vfs_path(raw_root).to_ascii_lowercase();
                let fe_root = self.frontend_root.to_ascii_lowercase();
                if !root.is_empty()
                    && root != fe_root
                    && (lower == root || lower.starts_with(&format!("{root}/")))
                {
                    return true;
                }
            }
        }
        if let Some(ref dbs) = self.manifest.databases {
            for db in dbs {
                if let Some(ref f) = db.file {
                    let nf = normalize_vfs_path(f).to_ascii_lowercase();
                    if !nf.is_empty() && lower == nf {
                        return true;
                    }
                }
                if let Some(ref s) = db.seed_sql {
                    let ns = normalize_vfs_path(s).to_ascii_lowercase();
                    if !ns.is_empty() && lower == ns {
                        return true;
                    }
                }
                if let Some(Value::String(ref s)) = db.seed_json {
                    let ns = normalize_vfs_path(s).to_ascii_lowercase();
                    if !ns.is_empty() && lower == ns {
                        return true;
                    }
                }
            }
        }
        false
    }

    pub fn read_public_asset(&self, url_path: &str) -> Option<(String, &'static str, Vec<u8>)> {
        let clean = normalize_vfs_path(&url_path_to_vfs(url_path)?);
        let candidates = if !self.frontend_root.is_empty() {
            vec![
                normalize_vfs_path(&format!("{}/{clean}", self.frontend_root)),
                clean.clone(),
            ]
        } else {
            vec![clean.clone()]
        };

        for cand in candidates {
            if cand.is_empty() || self.is_private_asset(&cand) {
                continue;
            }
            if let Some(bytes) = self.vfs.get(&cand) {
                return Some((cand.clone(), mime_type_for(&cand), bytes.clone()));
            }
        }
        None
    }

    pub fn declared_capabilities(&self) -> Vec<&'static str> {
        let p = &self.permissions.permissions;
        let mut out = Vec::new();
        if p.net.as_ref().and_then(|c| c.enabled) == Some(true) {
            out.push("net");
        }
        if p.camera.as_ref().and_then(|c| c.enabled) == Some(true) {
            out.push("camera");
        }
        if p.mic.as_ref().and_then(|c| c.enabled) == Some(true) {
            out.push("mic");
        }
        if p.files.as_ref().and_then(|c| c.enabled) == Some(true) {
            out.push("files");
        }
        if p.qr.as_ref().and_then(|c| c.enabled) == Some(true) {
            out.push("qr");
        }
        if p.ai.as_ref().and_then(|c| c.enabled) == Some(true) {
            out.push("ai");
        }
        if p.gpu.as_ref().and_then(|c| c.enabled) == Some(true) {
            out.push("gpu");
        }
        if p.sync.as_ref().and_then(|c| c.enabled) == Some(true) {
            out.push("sync");
        }
        if p.storage.as_ref().and_then(|c| c.enabled) == Some(true) {
            out.push("storage");
        }
        if p.accel.as_ref().and_then(|c| c.enabled) == Some(true) {
            out.push("accel");
        }
        if p.bluetooth.as_ref().and_then(|c| c.enabled) == Some(true) {
            out.push("bluetooth");
        }
        if p.location.as_ref().and_then(|c| c.enabled) == Some(true) {
            out.push("location");
        }
        if p.haptics.as_ref().and_then(|c| c.enabled) == Some(true) {
            out.push("haptics");
        }
        if p.notifications.as_ref().and_then(|c| c.enabled) == Some(true) {
            out.push("notifications");
        }
        if p.clipboard.as_ref().and_then(|c| c.enabled) == Some(true) {
            out.push("clipboard");
        }
        out
    }

    pub fn has_capability(&self, cap: &str) -> bool {
        self.declared_capabilities().contains(&cap)
    }

    pub fn allowed_ble_services(&self) -> Option<HashSet<String>> {
        let services = self
            .permissions
            .permissions
            .bluetooth
            .as_ref()?
            .services
            .as_ref()?;
        // If `services` is explicitly specified (even as `[]`), enforce it strictly (fail-closed)
        // using canonical lowercase 128-bit UUIDs so short 16-bit/32-bit aliases cannot bypass it.
        Some(
            services
                .iter()
                .filter_map(|s| canonical_ble_uuid(s))
                .collect(),
        )
    }

    pub fn check_net_url(&self, raw_url: &str) -> Result<(), String> {
        let Some(net) = &self.permissions.permissions.net else {
            return Err("Network access not permitted by permission.json".into());
        };
        if net.enabled != Some(true) {
            return Err("Network access not permitted by permission.json".into());
        }
        let trimmed = raw_url.trim();
        if trimmed.contains('\\') || trimmed.bytes().any(|b| b < 0x20 || b == 0x7f) {
            return Err("Invalid characters in URL".into());
        }
        let parsed = url::Url::parse(trimmed).map_err(|e| format!("Invalid URL: {e}"))?;
        if !parsed.username().is_empty() || parsed.password().is_some() {
            return Err("URLs with embedded credentials are not allowed".into());
        }
        let scheme = parsed.scheme();
        if scheme != "https" && !(scheme == "http" && net.allow_http == Some(true)) {
            return Err(format!("Blocked URL scheme '{scheme}': HTTPS required"));
        }
        let Some(host_raw) = parsed.host_str() else {
            return Err("URL missing host".into());
        };
        let host = host_raw.trim_start_matches('[').trim_end_matches(']');
        let lower_host = host.to_ascii_lowercase();
        let host_clean = lower_host.trim_end_matches('.');
        if host_clean.is_empty() {
            return Err("URL missing host".into());
        }
        if host_clean == "localhost"
            || host_clean.ends_with(".local")
            || host_clean.ends_with(".internal")
            || host_clean.ends_with(".localhost")
            || host_clean.ends_with(".home.arpa")
            || host_clean.ends_with(".localdomain")
        {
            return Err(format!(
                "Host '{host_raw}' is blocked by SSRF protection"
            ));
        }
        if let Ok(ip) = host.parse::<IpAddr>() {
            if is_blocked_ip(ip) {
                return Err(format!(
                    "Requests to private/reserved IP {ip} are blocked (SSRF protection)"
                ));
            }
        }
        if let Some(allowed) = &net.allowed_hosts {
            // An explicitly present empty `allowed_hosts: []` denies all outbound hosts
            // (matches @softn/container and softn-host-rust fail-closed semantics).
            let ok = allowed.iter().any(|rule| {
                let r = rule.trim().to_ascii_lowercase();
                let r = r.trim_end_matches('.');
                if r.is_empty() {
                    return false;
                }
                if let Some(suffix) = r.strip_prefix("*.") {
                    !suffix.is_empty()
                        && (host_clean == suffix || host_clean.ends_with(&format!(".{suffix}")))
                } else {
                    host_clean == r
                }
            });
            if !ok {
                return Err(format!(
                    "Host '{host_raw}' is not in permission.json net.allowed_hosts"
                ));
            }
        }
        Ok(())
    }
}

fn sanitize_app_id(raw: &str, digest: &str) -> String {
    let mut out: String = raw
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    while out.contains("..") {
        out = out.replace("..", "_");
    }
    let trimmed = out.trim_matches(['.', '-', '_']);
    let mut clean = trimmed.to_string();
    if clean.len() > 64 {
        clean.truncate(64);
        clean = clean.trim_end_matches(['.', '-', '_']).to_string();
    }
    if clean.is_empty() || clean == "." || clean == ".." {
        format!("sha256_{}", &digest[..16])
    } else {
        clean
    }
}

fn extract_html_title(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let start = lower.find("<title")?;
    let after_open = html[start..].find('>')? + start + 1;
    let end = lower[after_open..].find("</title>")? + after_open;
    let title = html[after_open..end].trim();
    if title.is_empty() {
        None
    } else {
        Some(title.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn bundle_of(files: &[(&str, &[u8])]) -> SoftnBundle {
        let mut buf = Vec::new();
        {
            let mut zw = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
            let opts = zip::write::SimpleFileOptions::default();
            for (name, data) in files {
                zw.start_file(*name, opts).unwrap();
                zw.write_all(data).unwrap();
            }
            zw.finish().unwrap();
        }
        SoftnBundle::from_zip_bytes(&buf).unwrap()
    }

    #[test]
    fn asset_urls_are_decoded_and_lose_their_fragment_as_a_server_reads_them() {
        let bundle = bundle_of(&[
            ("index.html", b"<html><body></body></html>"),
            ("images/caf\u{e9}.png", b"png"),
            ("docs/my file.txt", b"txt"),
            ("icons.svg", b"<svg/>"),
            ("backend/index.php", b"<?php echo 1;"),
        ]);
        // The page asks for these as a browser writes them: escaped, and with a fragment.
        assert!(bundle.read_public_asset("/images/caf%C3%A9.png").is_some());
        assert!(bundle.read_public_asset("/docs/my%20file.txt").is_some());
        assert!(bundle.read_public_asset("/icons.svg#home").is_some());
        assert!(bundle.read_public_asset("/icons.svg?v=2#home").is_some());
        // What worked before still does.
        assert!(bundle.read_public_asset("/docs/my file.txt").is_some());
        assert!(bundle.read_public_asset("/icons.svg?v=2").is_some());
        // An escaped separator or `..` never reaches a private file.
        assert!(bundle.read_public_asset("/docs%2F..%2Fbackend/index.php").is_none());
        assert!(bundle.read_public_asset("/docs/%2e%2e/backend/index.php").is_none());
        // Scripts, stylesheets and imports resolve the same way.
        assert_eq!(
            resolve_vfs_url("my%20file.txt", "docs/index.html", "").as_deref(),
            Some("docs/my file.txt")
        );
        assert_eq!(resolve_vfs_url("/images/caf%C3%A9.png", "index.html", "").as_deref(), Some("images/caf\u{e9}.png"));
    }
}
