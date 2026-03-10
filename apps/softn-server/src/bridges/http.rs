use formlogic_core::http_bridge::{HttpBridge, HttpResponse};
use std::time::Duration;

// All timeouts must be lower than the VM wall-time limit (25s) so HTTP
// calls time out before the VM does, producing a clean script-level error
// instead of a silent thread leak. The global timeout (20s) is the hard
// upper bound. Connect and read timeouts are set tighter to fail fast on
// unresponsive hosts and prevent spawn_blocking threads from hanging if
// the tokio::time::timeout fires first (which only cancels the await,
// not the underlying OS thread).
const TIMEOUT_GLOBAL: Duration = Duration::from_secs(20);
const TIMEOUT_CONNECT: Duration = Duration::from_secs(10);
const TIMEOUT_READ: Duration = Duration::from_secs(15);

pub struct NativeHttpBridge {
    agent: ureq::Agent,
}

impl NativeHttpBridge {
    pub fn new() -> Self {
        let agent = ureq::Agent::new_with_config(
            ureq::config::Config::builder()
                .timeout_global(Some(TIMEOUT_GLOBAL))
                .timeout_connect(Some(TIMEOUT_CONNECT))
                .timeout_recv_body(Some(TIMEOUT_READ))
                .http_status_as_error(false)
                .build(),
        );
        Self { agent }
    }
}

fn to_http_response(resp: ureq::http::Response<ureq::Body>) -> Result<HttpResponse, String> {
    let status = resp.status().as_u16();
    let body = resp
        .into_body()
        .read_to_string()
        .map_err(|e| format!("Read body error: {}", e))?;
    Ok(HttpResponse {
        status,
        body,
        ok: (200..300).contains(&status),
    })
}

impl HttpBridge for NativeHttpBridge {
    fn get(&self, url: &str) -> Result<HttpResponse, String> {
        let resp = self.agent
            .get(url)
            .call()
            .map_err(|e| format!("HTTP GET error: {}", e))?;
        to_http_response(resp)
    }

    fn post(&self, url: &str, body: &str, content_type: &str) -> Result<HttpResponse, String> {
        let resp = self.agent
            .post(url)
            .header("Content-Type", content_type)
            .send(body.as_bytes())
            .map_err(|e| format!("HTTP POST error: {}", e))?;
        to_http_response(resp)
    }

    fn put(&self, url: &str, body: &str, content_type: &str) -> Result<HttpResponse, String> {
        let resp = self.agent
            .put(url)
            .header("Content-Type", content_type)
            .send(body.as_bytes())
            .map_err(|e| format!("HTTP PUT error: {}", e))?;
        to_http_response(resp)
    }

    fn delete(&self, url: &str) -> Result<HttpResponse, String> {
        let resp = self.agent
            .delete(url)
            .call()
            .map_err(|e| format!("HTTP DELETE error: {}", e))?;
        to_http_response(resp)
    }
}
