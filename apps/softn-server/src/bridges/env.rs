use formlogic_core::env_bridge::EnvBridge;

pub struct NativeEnvBridge;

impl EnvBridge for NativeEnvBridge {
    fn get(&self, name: &str) -> Option<String> {
        std::env::var(name).ok()
    }

    fn keys(&self) -> Vec<String> {
        // Only expose vars with app-relevant prefixes to prevent
        // scripts from enumerating secrets (AWS_SECRET_*, GITHUB_TOKEN, etc.).
        std::env::vars()
            .map(|(k, _)| k)
            .filter(|k| {
                let upper = k.to_ascii_uppercase();
                upper.starts_with("SOFTN_")
                    || upper.starts_with("APP_")
                    || upper == "NODE_ENV"
                    || upper == "PORT"
            })
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
