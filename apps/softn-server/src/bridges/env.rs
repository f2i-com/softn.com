use super::EnvBridge;

pub struct NativeEnvBridge;

/// Names the server keeps for itself. These live inside the `SOFTN_` prefix the
/// allowlist below grants to scripts, so without an explicit denial a script
/// could simply ask for the token that guards every authenticated route
/// (`http::check_auth`) and the sync socket — the one secret the allowlist most
/// needs to protect. `SOFTN_AUTH_TOKEN_<TENANT>` makes it worse under
/// multi-tenancy: `GET /tenants` is unauthenticated, so one tenant's script can
/// enumerate the others and then read their tokens out of `keys()`.
///
/// Matched by prefix so per-tenant suffixes are covered too.
const RESERVED_PREFIXES: [&str; 2] = ["SOFTN_AUTH_TOKEN", "SOFTN_ALLOW_ALL_CAPABILITIES"];

fn is_reserved_env_name(upper: &str) -> bool {
    RESERVED_PREFIXES.iter().any(|p| upper.starts_with(p))
}

/// Shared allowlist for both `get()` and `keys()`. Only vars matching these
/// prefixes are accessible to scripts. Everything else is hidden to prevent
/// secret exfiltration (AWS_SECRET_*, DATABASE_URL, signing keys, etc.).
fn is_allowed_env_name(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    if is_reserved_env_name(&upper) {
        return false;
    }
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
        // Truncate on a char boundary: slicing at a raw byte offset panics when
        // a multi-byte character straddles it, and every `console.*` call in a
        // script reaches this method.
        let msg = if message.len() > MAX_LOG_LEN {
            let mut end = MAX_LOG_LEN;
            while end > 0 && !message.is_char_boundary(end) {
                end -= 1;
            }
            &message[..end]
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reserves_the_servers_own_auth_token() {
        // The allowlist grants the whole `SOFTN_` namespace, which is exactly
        // where the token guarding every authenticated route lives.
        assert!(!is_allowed_env_name("SOFTN_AUTH_TOKEN"));
        assert!(!is_allowed_env_name("softn_auth_token"));
    }

    #[test]
    fn reserves_per_tenant_tokens() {
        assert!(!is_allowed_env_name("SOFTN_AUTH_TOKEN_ACME"));
        assert!(!is_allowed_env_name("SOFTN_ALLOW_ALL_CAPABILITIES"));
    }

    #[test]
    fn still_allows_ordinary_app_configuration() {
        assert!(is_allowed_env_name("SOFTN_REGION"));
        assert!(is_allowed_env_name("APP_TITLE"));
        assert!(is_allowed_env_name("NODE_ENV"));
        assert!(is_allowed_env_name("PORT"));
    }

    #[test]
    fn still_hides_unrelated_secrets() {
        assert!(!is_allowed_env_name("AWS_SECRET_ACCESS_KEY"));
        assert!(!is_allowed_env_name("DATABASE_URL"));
    }

    #[test]
    fn get_and_keys_agree() {
        // A name `keys()` hides must not be readable by `get()`, or the filter
        // only stops enumeration and not the actual read.
        std::env::set_var("SOFTN_AUTH_TOKEN", "s3cret");
        let bridge = NativeEnvBridge;
        assert_eq!(bridge.get("SOFTN_AUTH_TOKEN"), None);
        assert!(!bridge.keys().iter().any(|k| k == "SOFTN_AUTH_TOKEN"));
        std::env::remove_var("SOFTN_AUTH_TOKEN");
    }
}
