use super::{HttpBridge, HttpResponse};
use std::io::Read;
use std::net::{IpAddr, Ipv4Addr};
use std::time::Duration;
use ureq::unversioned::resolver::{DefaultResolver, ResolvedSocketAddrs, Resolver};
use ureq::unversioned::transport::DefaultConnector;

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

/// Maximum response body size (5MB), enforced on BOTH compressed wire bytes
/// and decompressed output bytes to defeat gzip decompression bombs.
const MAX_RESPONSE_BODY: u64 = 5 * 1024 * 1024;
/// Maximum outbound request body size (5MB) for POST/PUT.
const MAX_REQUEST_BODY: usize = 5 * 1024 * 1024;

#[derive(Clone)]
pub struct NativeHttpBridge {
    agent: ureq::Agent,
}

impl NativeHttpBridge {
    pub fn new() -> Self {
        let config = ureq::config::Config::builder()
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
            // ureq reads HTTP_PROXY/HTTPS_PROXY by default. Through a proxy
            // the target is resolved by the proxy, so SsrfSafeResolver would
            // check only the proxy's address and a script could reach any
            // internal host the proxy can.
            .proxy(None)
            .build();

        // Use a custom resolver that wraps ureq's DefaultResolver but checks
        // all resolved IPs against our SSRF blocklist. This closes the DNS
        // rebinding TOCTOU gap: the validation happens at the same DNS lookup
        // that ureq uses to connect, so there is no window for an attacker's
        // DNS server to return a different IP between check and connection.
        let agent = ureq::Agent::with_parts(
            config,
            DefaultConnector::default(),
            SsrfSafeResolver::new(),
        );

        Self { agent }
    }
}

fn to_http_response(resp: ureq::http::Response<ureq::Body>) -> Result<HttpResponse, String> {
    let status = resp.status().as_u16();
    let mut body = resp.into_body();
    // Enforce MAX_RESPONSE_BODY on both wire bytes (via `.limit()`) AND
    // post-decompression output bytes (via `.take(MAX_RESPONSE_BODY + 1)`) so a
    // gzip decompression bomb cannot expand a 5 MiB wire body into gigabytes.
    let mut reader = body
        .with_config()
        .limit(MAX_RESPONSE_BODY)
        .reader()
        .take(MAX_RESPONSE_BODY + 1);
    let mut buf = Vec::new();
    reader
        .read_to_end(&mut buf)
        .map_err(|e| format!("Read body error: {}", e))?;
    if (buf.len() as u64) > MAX_RESPONSE_BODY {
        return Err(format!(
            "Read body error: response exceeded {} byte limit",
            MAX_RESPONSE_BODY
        ));
    }
    let text = String::from_utf8(buf)
        .unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned());
    Ok(HttpResponse {
        status,
        body: text,
        ok: (200..300).contains(&status),
    })
}

// ── SSRF protection ──

/// Custom DNS resolver that wraps ureq's DefaultResolver and validates
/// all resolved IPs against the SSRF blocklist before returning them.
///
/// This eliminates the DNS rebinding TOCTOU gap: an attacker who controls
/// a DNS server and alternates between safe/unsafe IPs cannot bypass the
/// check, because the IPs returned by this resolver are the exact IPs
/// ureq will connect to — there is no second DNS lookup.
#[derive(Debug)]
struct SsrfSafeResolver {
    inner: DefaultResolver,
}

impl SsrfSafeResolver {
    fn new() -> Self {
        Self {
            inner: DefaultResolver::default(),
        }
    }
}

impl Resolver for SsrfSafeResolver {
    fn resolve(
        &self,
        uri: &ureq::http::Uri,
        config: &ureq::config::Config,
        timeout: ureq::unversioned::transport::NextTimeout,
    ) -> Result<ResolvedSocketAddrs, ureq::Error> {
        let addrs = self.inner.resolve(uri, config, timeout)?;

        // Check every resolved IP against the blocklist.
        // If ANY resolved address is blocked, reject the entire request.
        for addr in addrs.iter() {
            if is_blocked_ip(addr.ip()) {
                // Return HostNotFound — we don't want to reveal which internal
                // IP the hostname resolved to.
                return Err(ureq::Error::HostNotFound);
            }
        }

        Ok(addrs)
    }
}

/// Validate a URL for SSRF safety before making a request.
/// Rejects non-HTTP schemes, private/reserved IPs, and known-dangerous hostnames.
///
/// This performs static string-level checks. The DNS-level IP validation is
/// handled by SsrfSafeResolver at connection time (zero TOCTOU gap).
fn validate_url(url: &str) -> Result<(), String> {
    let trimmed = url.trim();
    if trimmed.contains('\\') || trimmed.bytes().any(|b| b < 0x20 || b == 0x7f) {
        return Err("Invalid characters in URL".into());
    }
    let uri: ureq::http::Uri = trimmed
        .parse()
        .map_err(|_| "Invalid URL".to_string())?;
    let scheme = uri
        .scheme_str()
        .ok_or_else(|| "Only http:// and https:// URLs are allowed".to_string())?;
    if !scheme.eq_ignore_ascii_case("http") && !scheme.eq_ignore_ascii_case("https") {
        return Err("Only http:// and https:// URLs are allowed".into());
    }
    let authority = uri
        .authority()
        .ok_or_else(|| "Empty host in URL".to_string())?;
    if authority.as_str().contains('@') {
        return Err("URLs with embedded credentials are not allowed".into());
    }
    let host_raw = authority.host();
    if host_raw.is_empty() {
        return Err("Empty host in URL".into());
    }
    let host = host_raw.trim_start_matches('[').trim_end_matches(']');
    let host_lower = host.to_ascii_lowercase();
    let host_clean = host_lower.trim_end_matches('.');

    if host_clean == "localhost" {
        return Err("Requests to localhost are blocked (SSRF protection)".into());
    }
    if host_clean.ends_with(".local")
        || host_clean.ends_with(".internal")
        || host_clean.ends_with(".localhost")
        || host_clean.ends_with(".home.arpa")
        || host_clean.ends_with(".localdomain")
    {
        return Err("Requests to local/internal hostnames are blocked (SSRF protection)".into());
    }
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
            if v6.is_loopback() || v6.is_unspecified() || v6.is_multicast() {
                return true;
            }
            let segments = v6.segments();
            let bits = u128::from(v6);
            // fc00::/7 unique-local (AWS's IPv6 metadata service is
            // fd00:ec2::254), fe80::/10 link-local, fec0::/10 site-local,
            // 100::/64 discard-only, 2001:0000::/32 Teredo, 2001:2::/48
            // benchmarking, 2001:10::/28 & 2001:20::/28 ORCHID, 5f00::/16 SRv6,
            // and 64:ff9b:1::/48 (RFC 8215 local-use NAT64 prefix).
            if (segments[0] & 0xfe00) == 0xfc00
                || (segments[0] & 0xffc0) == 0xfe80
                || (segments[0] & 0xffc0) == 0xfec0
                || (segments[0] == 0x0100 && segments[1] == 0 && segments[2] == 0 && segments[3] == 0)
                || (segments[0] == 0x2001 && segments[1] == 0x0000)
                || (segments[0] == 0x2001 && segments[1] == 0x0002 && segments[2] == 0)
                || (segments[0] == 0x2001 && (segments[1] & 0xfff0) == 0x0010)
                || (segments[0] == 0x2001 && (segments[1] & 0xfff0) == 0x0020)
                || segments[0] == 0x5f00
                || (segments[0] == 0x0064 && segments[1] == 0xff9b && segments[2] == 0x0001)
            {
                return true;
            }
            // Addresses that carry an IPv4 address a gateway or the stack
            // will reach: ::ffff:a.b.c.d (mapped), ::ffff:0:a.b.c.d (IPv4-translated),
            // ::a.b.c.d (compatible, deprecated), 64:ff9b::/96 (well-known NAT64)
            // with the IPv4 address in the low 32 bits, 2002::/16 (6to4) with it in
            // bits 16-47.
            let low32 = Ipv4Addr::from(bits as u32);
            if segments[0..5] == [0, 0, 0, 0, 0] && (segments[5] == 0xffff || segments[5] == 0) {
                return is_blocked_ipv4(&low32);
            }
            if segments[0..4] == [0, 0, 0, 0] && segments[4] == 0xffff && segments[5] == 0 {
                return is_blocked_ipv4(&low32);
            }
            if segments[0] == 0x64 && segments[1] == 0xff9b && segments[2..6] == [0, 0, 0, 0] {
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
    a == 0                                          // 0.0.0.0/8 ("this network"; 0.x reaches loopback on Linux)
        || v4.is_loopback()                         // 127.0.0.0/8
        || v4.is_private()                          // 10/8, 172.16/12, 192.168/16
        || v4.is_link_local()                       // 169.254.0.0/16 (metadata)
        || (a == 100 && (b & 0xC0) == 64)           // 100.64.0.0/10 (CGN)
        || (a == 192 && b == 0 && c == 0)           // 192.0.0.0/24 (IETF protocol assignments)
        || (a == 198 && (b & 0xFE) == 18)           // 198.18.0.0/15 (benchmarking)
        || a >= 224                                 // 224/4 multicast, 240/4 reserved, broadcast
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
        if body.len() > MAX_REQUEST_BODY {
            return Err(format!("HTTP POST body exceeds {} byte limit", MAX_REQUEST_BODY));
        }
        let resp = self.agent
            .post(url)
            .header("Content-Type", content_type)
            .send(body.as_bytes())
            .map_err(|e| format!("HTTP POST error: {}", e))?;
        to_http_response(resp)
    }

    fn put(&self, url: &str, body: &str, content_type: &str) -> Result<HttpResponse, String> {
        validate_url(url)?;
        if body.len() > MAX_REQUEST_BODY {
            return Err(format!("HTTP PUT body exceeds {} byte limit", MAX_REQUEST_BODY));
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_and_translated_ranges_are_blocked() {
        for blocked in [
            "127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1",
            "0.0.0.0", "0.1.2.3", "192.0.0.170", "198.18.0.1", "224.0.0.251", "240.0.0.1", "255.255.255.255",
            "::1", "::", "::ffff:127.0.0.1", "::127.0.0.1",
            // AWS's IPv6 instance metadata service is unique-local.
            "fd00:ec2::254", "fc00::1", "fe80::1", "fec0::1", "ff02::1",
            // NAT64 and 6to4 carry an IPv4 address the gateway will reach.
            "64:ff9b::7f00:1", "64:ff9b:1::a00:1", "2002:7f00:1::1", "2002:a9fe:a9fe::1",
        ] {
            assert!(is_blocked_ip(blocked.parse().unwrap()), "{blocked} is reachable");
        }
        for public in ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "2002:808:808::1", "64:ff9b::808:808"] {
            assert!(!is_blocked_ip(public.parse().unwrap()), "{public} is blocked");
        }
    }

    /// A proxy from HTTP_PROXY/HTTPS_PROXY would resolve the target itself,
    /// so the resolver's check would only ever see the proxy's address.
    #[test]
    fn the_environment_proxy_is_not_used() {
        std::env::set_var("HTTPS_PROXY", "http://proxy.example:3128");
        std::env::set_var("HTTP_PROXY", "http://proxy.example:3128");
        let bridge = NativeHttpBridge::new();
        std::env::remove_var("HTTPS_PROXY");
        std::env::remove_var("HTTP_PROXY");
        assert!(bridge.agent.config().proxy().is_none());
    }
}
