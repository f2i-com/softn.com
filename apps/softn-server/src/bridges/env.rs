use formlogic_core::env_bridge::EnvBridge;

pub struct NativeEnvBridge;

impl EnvBridge for NativeEnvBridge {
    fn get(&self, name: &str) -> Option<String> {
        std::env::var(name).ok()
    }

    fn keys(&self) -> Vec<String> {
        std::env::vars().map(|(k, _)| k).collect()
    }
}
