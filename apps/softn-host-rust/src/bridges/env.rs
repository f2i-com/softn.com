use super::EnvBridge;

pub struct NativeEnvBridge;

// Process environment is operator-owned and may contain sibling tenant keys.
// Non-secret application settings belong in the explicitly scoped config bridge.
fn is_allowed_env_name(_name: &str) -> bool { false }

impl EnvBridge for NativeEnvBridge {
    fn get(&self, name: &str) -> Option<String> {
        // Ambient process values can belong to another tenant. Returning None
        // also prevents probing whether a secret exists at all.
        if !is_allowed_env_name(name) {
            return None;
        }
        std::env::var(name).ok()
    }

    fn keys(&self) -> Vec<String> {
        Vec::new()
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
    fn hides_ambient_configuration_and_secrets() {
        assert!(!is_allowed_env_name("SOFTN_REGION"));
        assert!(!is_allowed_env_name("APP_TITLE"));
        assert!(!is_allowed_env_name("NODE_ENV"));
        assert!(!is_allowed_env_name("PORT"));
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
