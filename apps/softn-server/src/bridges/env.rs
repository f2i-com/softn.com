use formlogic_core::env_bridge::EnvBridge;

pub struct NativeEnvBridge;

impl EnvBridge for NativeEnvBridge {
    fn get(&self, name: &str) -> Option<String> {
        std::env::var(name).ok()
    }

    fn keys(&self) -> Vec<String> {
        std::env::vars().map(|(k, _)| k).collect()
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
