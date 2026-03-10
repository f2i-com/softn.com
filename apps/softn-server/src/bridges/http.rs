use formlogic_core::http_bridge::{HttpBridge, HttpResponse};
use std::net::{IpAddr, Ipv4Addr};
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

/// Maximum response body size (5MB). Prevents memory exhaustion from scripts
/// fetching attacker-controlled endpoints that return massive payloads.
/// ureq defaults to 10MB; we tighten it since scripts rarely need large responses.
const MAX_RESPONSE_BODY: u64 = 5 * 1024 * 1024;

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
                // Disable automatic redirect following to prevent SSRF bypasses.
                // Attackers can set up a public URL that 302-redirects to internal
                // services (169.254.169.254, localhost, etc.) — ureq would follow
                // the redirect silently, bypassing our validate_url() check on the
                // initial request. Scripts receive the 3xx response and can implement
                // their own redirect logic if needed.
                .max_redirects(0)
                .build(),
        );
        Self { agent }
    }
}

fn to_http_response(resp: ureq::http::Response<ureq::Body>) -> Result<HttpResponse, String> {
    let status = resp.status().as_u16();
    let mut body = resp.into_body();
    let text = body
        .with_config()
        .limit(MAX_RESPONSE_BODY)
        .read_to_string()
        .map_err(|e| format!("Read body error: {}", e))?;
    Ok(HttpResponse {
        status,
        body: text,
        ok: (200..300).contains(&status),
    })
}

// ── SSRF protection ──

/// Validate a URL for SSRF safety before making a request.
/// Rejects non-HTTP schemes, private/reserved IPs, and known-dangerous hostnames.
/// This is the primary defence against scripts (or script inputs) that try to
/// reach cloud metadata endpoints, internal services, or localhost.
fn validate_url(url: &str) -> Result<(), String> {
    // Require http:// or https:// scheme. Blocks file://, ftp://, gopher://, etc.
    let rest = if let Some(r) = url.strip_prefix("https://") {
        r
    } else if let Some(r) = url.strip_prefix("http://") {
        r
    } else {
        return Err("Only http:// and https:// URLs are allowed".into());
    };

    // Extract host from authority (strip userinfo@, :port, and /path).
    let authority = rest.split('/').next().unwrap_or(rest);
    let host_port = match authority.rfind('@') {
        Some(at) => &authority[at + 1..],
        None => authority,
    };

    // Handle IPv6 brackets: [::1]:8080
    let host = if host_port.starts_with('[') {
        host_port
            .split(']')
            .next()
            .unwrap_or(host_port)
            .trim_start_matches('[')
    } else {
        // IPv4 or hostname — strip port
        host_port.split(':').next().unwrap_or(host_port)
    };

    if host.is_empty() {
        return Err("Empty host in URL".into());
    }

    let host_lower = host.to_lowercase();

    // Block localhost variants
    if host_lower == "localhost" || host_lower == "localhost." {
        return Err("Requests to localhost are blocked (SSRF protection)".into());
    }

    // Block .local / .internal / .localhost TLDs
    if host_lower.ends_with(".local")
        || host_lower.ends_with(".internal")
        || host_lower.ends_with(".localhost")
    {
        return Err("Requests to local/internal hostnames are blocked (SSRF protection)".into());
    }

    // If it's a literal IP address, check against blocked ranges
    if let Ok(ip) = host.parse::<IpAddr>() {
        if is_blocked_ip(ip) {
            return Err(format!(
                "Requests to private/reserved IP {} are blocked (SSRF protection)",
                ip
            ));
        }
    }

    Ok(())
}

/// Returns true for IPs that should never be reachable from server scripts:
/// loopback, private (RFC1918), link-local (includes cloud metadata 169.254.169.254),
/// broadcast, unspecified, and carrier-grade NAT (100.64.0.0/10).
fn is_blocked_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_blocked_ipv4(&v4),
        IpAddr::V6(v6) => {
            if v6.is_loopback() || v6.is_unspecified() {
                return true;
            }
            // Check IPv4-mapped IPv6 addresses (::ffff:x.x.x.x)
            let segments = v6.segments();
            if segments[0..5] == [0, 0, 0, 0, 0] && segments[5] == 0xffff {
                let v4 = Ipv4Addr::new(
                    (segments[6] >> 8) as u8,
                    segments[6] as u8,
                    (segments[7] >> 8) as u8,
                    segments[7] as u8,
                );
                return is_blocked_ipv4(&v4);
            }
            false
        }
    }
}

fn is_blocked_ipv4(v4: &Ipv4Addr) -> bool {
    v4.is_loopback()                                                    // 127.0.0.0/8
        || v4.is_private()                                              // 10/8, 172.16/12, 192.168/16
        || v4.is_link_local()                                           // 169.254.0.0/16 (metadata)
        || v4.is_broadcast()                                            // 255.255.255.255
        || v4.is_unspecified()                                          // 0.0.0.0
        || (v4.octets()[0] == 100 && (v4.octets()[1] & 0xC0) == 64)    // 100.64.0.0/10 (CGN)
}

impl HttpBridge for NativeHttpBridge {
    fn get(&self, url: &str) -> Result<HttpResponse, String> {
        validate_url(url)?;
        let resp = self.agent
            .get(url)
            .call()
            .map_err(|e| format!("HTTP GET error: {}", e))?;
        to_http_response(resp)
    }

    fn post(&self, url: &str, body: &str, content_type: &str) -> Result<HttpResponse, String> {
        validate_url(url)?;
        let resp = self.agent
            .post(url)
            .header("Content-Type", content_type)
            .send(body.as_bytes())
            .map_err(|e| format!("HTTP POST error: {}", e))?;
        to_http_response(resp)
    }

    fn put(&self, url: &str, body: &str, content_type: &str) -> Result<HttpResponse, String> {
        validate_url(url)?;
        let resp = self.agent
            .put(url)
            .header("Content-Type", content_type)
            .send(body.as_bytes())
            .map_err(|e| format!("HTTP PUT error: {}", e))?;
        to_http_response(resp)
    }

    fn delete(&self, url: &str) -> Result<HttpResponse, String> {
        validate_url(url)?;
        let resp = self.agent
            .delete(url)
            .call()
            .map_err(|e| format!("HTTP DELETE error: {}", e))?;
        to_http_response(resp)
    }
}
