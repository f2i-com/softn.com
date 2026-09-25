//! `softn.net.fetch` for the desktop runtime, made from this side.
//!
//! The webview's CSP keeps `connect-src` to the runtime itself and the few
//! hosts it downloads from, so a bundle's network access cannot be the page's
//! `fetch`. The page hands the request here instead (the renderer's
//! `netFetchHandler`, see src/nativeNetFetch.ts), together with the `net`
//! entry the person granted, and this makes the request only when that entry
//! permits the destination.
//!
//! The rules are the runtime's own (`describeNetDestination` in @softn/core's
//! egress-policy.ts): http(s) only, plain HTTP only with `allow_http`, and a
//! non-empty `allowed_hosts` names every host that may be reached. The page
//! checks the same rules before it asks; this repeats them where the request
//! is actually made, and for the redirect the page never sees, which is
//! refused rather than followed — as the page's `fetch` does with
//! `redirect: 'error'` — so an allowed host cannot forward the request to one
//! that is not.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Duration;
use url::Url;

/// The same cap the script runtime puts on a response it reads itself.
pub const MAX_RESPONSE_BYTES: usize = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS: u64 = 15_000;
const MAX_TIMEOUT_MS: u64 = 60_000;

/// One request, as the page's handler sends it.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetRequest {
    pub url: String,
    #[serde(default)]
    pub method: Option<String>,
    #[serde(default)]
    pub headers: Option<HashMap<String, String>>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub timeout_ms: Option<f64>,
    /// The granted `net.allow_http`.
    #[serde(default)]
    pub allow_http: bool,
    /// The granted `net.allowed_hosts`; empty means every host.
    #[serde(default)]
    pub allowed_hosts: Vec<String>,
}

/// What `softn.net.fetch` answers with: the shape the script runtime returns.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetResponse {
    pub ok: bool,
    pub status: u16,
    pub status_text: String,
    pub body: String,
    pub headers: HashMap<String, String>,
}

/// Whether the granted `net` entry permits this URL, in the runtime's words.
pub fn check_destination(url: &str, allow_http: bool, allowed_hosts: &[String]) -> Result<Url, String> {
    let parsed = Url::parse(url).map_err(|_| format!("Invalid URL: {}", url))?;
    match parsed.scheme() {
        "https" => {}
        "http" if allow_http => {}
        "http" => {
            return Err(format!(
                "HTTP not allowed (only HTTPS). Set net.allow_http in permission.json to allow: {}",
                url
            ))
        }
        other => return Err(format!("Scheme not allowed: {}:", other)),
    }
    if !allowed_hosts.is_empty() {
        // `host_str` is the WHATWG hostname the page's URL reports: lowercased,
        // punycoded, an IPv6 address in brackets. The list is compared as
        // written, exactly as the runtime compares it.
        let host = parsed.host_str().unwrap_or("");
        if !allowed_hosts.iter().any(|allowed| allowed == host) {
            return Err(format!("Host not allowed: {}", host));
        }
    }
    Ok(parsed)
}

/// The script's `timeout`, clamped as the runtime clamps it.
pub fn timeout_for(requested: Option<f64>) -> Duration {
    let ms = match requested {
        Some(value) if value.is_finite() => value.max(1.0).min(MAX_TIMEOUT_MS as f64) as u64,
        _ => DEFAULT_TIMEOUT_MS,
    };
    Duration::from_millis(ms)
}

fn client(timeout: Duration) -> Result<reqwest::Client, String> {
    let builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(timeout);
    #[cfg(target_os = "android")]
    let builder = builder.tls_certs_only(
        webpki_root_certs::TLS_SERVER_ROOT_CERTS
            .iter()
            .filter_map(|der| reqwest::Certificate::from_der(der.as_ref()).ok()),
    );
    builder.build().map_err(|e| format!("The network client could not start: {}", e))
}

/// Make one request the granted `net` entry permits.
#[tauri::command]
pub async fn net_fetch(request: NetRequest) -> Result<NetResponse, String> {
    let url = check_destination(&request.url, request.allow_http, &request.allowed_hosts)?;
    let method = request.method.as_deref().unwrap_or("GET").to_ascii_uppercase();
    let method = reqwest::Method::from_bytes(method.as_bytes())
        .map_err(|_| format!("Invalid request method: {}", method))?;

    let mut outgoing = client(timeout_for(request.timeout_ms))?.request(method, url);
    for (name, value) in request.headers.unwrap_or_default() {
        outgoing = outgoing.header(name, value);
    }
    if let Some(body) = request.body.filter(|body| !body.is_empty()) {
        outgoing = outgoing.body(body);
    }

    let mut response = outgoing
        .send()
        .await
        .map_err(|e| format!("Network request failed: {}", e))?;
    let status = response.status();
    if status.is_redirection() {
        return Err(format!(
            "Network request failed: the server redirected ({}), and redirects are not followed",
            status.as_u16()
        ));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err("Network response is too large".to_string());
    }

    let mut headers: HashMap<String, String> = HashMap::new();
    for (name, value) in response.headers() {
        let value = String::from_utf8_lossy(value.as_bytes()).into_owned();
        headers
            .entry(name.as_str().to_string())
            .and_modify(|existing| {
                existing.push_str(", ");
                existing.push_str(&value);
            })
            .or_insert(value);
    }

    let mut bytes: Vec<u8> = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("Network request failed: {}", e))?
    {
        if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err("Network response is too large".to_string());
        }
        bytes.extend_from_slice(&chunk);
    }

    Ok(NetResponse {
        ok: status.is_success(),
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or("").to_string(),
        body: String::from_utf8_lossy(&bytes).into_owned(),
        headers,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hosts(list: &[&str]) -> Vec<String> {
        list.iter().map(|host| host.to_string()).collect()
    }

    #[test]
    fn an_empty_host_list_permits_every_https_host() {
        assert!(check_destination("https://api.example.com/v1", false, &[]).is_ok());
    }

    #[test]
    fn a_host_list_permits_only_the_hosts_it_names() {
        let allowed = hosts(&["api.example.com"]);
        assert!(check_destination("https://api.example.com/v1?q=1", false, &allowed).is_ok());
        assert_eq!(
            check_destination("https://evil.example.net/", false, &allowed).unwrap_err(),
            "Host not allowed: evil.example.net"
        );
        // A subdomain is another host, and a lookalike suffix is not a match.
        assert!(check_destination("https://x.api.example.com/", false, &allowed).is_err());
        assert!(check_destination("https://api.example.com.evil.net/", false, &allowed).is_err());
    }

    #[test]
    fn the_host_is_judged_as_the_url_resolves_it_not_as_written() {
        let allowed = hosts(&["api.example.com"]);
        // Credentials before the @ are not the host.
        assert!(check_destination("https://api.example.com@evil.example.net/", false, &allowed).is_err());
        // Case is normalised as the page's URL normalises it.
        assert!(check_destination("https://API.Example.com/", false, &allowed).is_ok());
        // A port does not change the host.
        assert!(check_destination("https://api.example.com:8443/", false, &allowed).is_ok());
    }

    #[test]
    fn plain_http_needs_allow_http() {
        assert!(check_destination("http://localhost:8080/", false, &[])
            .unwrap_err()
            .starts_with("HTTP not allowed"));
        assert!(check_destination("http://localhost:8080/", true, &[]).is_ok());
        assert!(check_destination("http://localhost:8080/", true, &hosts(&["api.example.com"])).is_err());
    }

    #[test]
    fn only_http_schemes_are_requests() {
        for url in ["file:///C:/Windows/win.ini", "ftp://example.com/", "data:text/plain,hi", "javascript:alert(1)"] {
            assert!(check_destination(url, true, &[]).is_err(), "{} was allowed", url);
        }
        assert_eq!(check_destination("not a url", true, &[]).unwrap_err(), "Invalid URL: not a url");
    }

    #[test]
    fn timeouts_are_clamped_as_the_runtime_clamps_them() {
        assert_eq!(timeout_for(None), Duration::from_millis(15_000));
        assert_eq!(timeout_for(Some(f64::NAN)), Duration::from_millis(15_000));
        assert_eq!(timeout_for(Some(0.0)), Duration::from_millis(1));
        assert_eq!(timeout_for(Some(5_000.0)), Duration::from_millis(5_000));
        assert_eq!(timeout_for(Some(3_600_000.0)), Duration::from_millis(60_000));
    }

    #[test]
    fn a_request_the_grant_does_not_permit_is_never_sent() {
        let request = NetRequest {
            url: "https://evil.example.net/steal".to_string(),
            method: None,
            headers: None,
            body: None,
            timeout_ms: None,
            allow_http: false,
            allowed_hosts: hosts(&["api.example.com"]),
        };
        let refused = tauri::async_runtime::block_on(net_fetch(request)).unwrap_err();
        assert_eq!(refused, "Host not allowed: evil.example.net");
    }
}
