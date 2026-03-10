use formlogic_core::env_bridge::EnvBridge;

pub struct NativeEnvBridge;

/// Shared allowlist for both `get()` and `keys()`. Only vars matching these
/// prefixes are accessible to scripts. Everything else is hidden to prevent
/// secret exfiltration (AWS_SECRET_*, DATABASE_URL, signing keys, etc.).
fn is_allowed_env_name(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    upper.starts_with("SOFTN_")
        || upper.starts_with("APP_")
        || upper == "NODE_ENV"
        || upper == "PORT"
}

impl EnvBridge for NativeEnvBridge {
    fn get(&self, name: &str) -> Option<String> {
        // Apply the same prefix filter as keys() to prevent scripts from
        // reading arbitrary secrets (AWS_SECRET_*, DATABASE_URL, signing keys).
        // Without this, a script that knows (or guesses) an env var name can
        // exfiltrate it via the HTTP bridge. Returns None (indistinguishable
        // from "not set") to prevent probing which vars exist.
        if !is_allowed_env_name(name) {
            return None;
        }
        std::env::var(name).ok()
    }

    fn keys(&self) -> Vec<String> {
        // Only expose vars with app-relevant prefixes to prevent
        // scripts from enumerating secrets (AWS_SECRET_*, GITHUB_TOKEN, etc.).
        std::env::vars()
            .map(|(k, _)| k)
            .filter(|k| is_allowed_env_name(k))
            .collect()
    }

    fn log(&self, level: &str, message: &str) {
        // Truncate to prevent scripts from flooding logs with huge messages.
        const MAX_LOG_LEN: usize = 8192;
        let msg = if message.len() > MAX_LOG_LEN {
            &message[..MAX_LOG_LEN]
        } else {
            message
        };
        match level {
            "WARN" => tracing::warn!(target: "softn_script", "{}", msg),
            "ERROR" => tracing::error!(target: "softn_script", "{}", msg),
            _ => tracing::info!(target: "softn_script", "{}", msg),
        }
    }
}
