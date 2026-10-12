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

/// The statuses the page's `fetch` treats as a redirect. The rest of the 3xx range sends the
/// request nowhere (304 answers a conditional request, 300 offers a choice) and reaches the
/// script as any other status does.
fn is_redirect(status: u16) -> bool {
    matches!(status, 301 | 302 | 303 | 307 | 308)
}

/// Headers the script does not get to write: where the request goes, and how its body is
/// framed. The page's `fetch` drops these without a word, and so does this. `Host` is the
/// one the grant depends on: sent as written it asks the allowed host's server for another
/// site at the same address, which is a destination `allowed_hosts` does not name.
fn is_reserved_header(name: &str) -> bool {
    const RESERVED: [&str; 9] = [
        "host",
        "content-length",
        "transfer-encoding",
        "connection",
        "keep-alive",
        "te",
        "trailer",
        "upgrade",
        "expect",
    ];
    let name = name.trim().to_ascii_lowercase();
    RESERVED.contains(&name.as_str()) || name.starts_with("proxy-")
}

/// The request as it will be sent: to the destination the grant permits, with the script's
/// method, headers and body.
fn outgoing(client: &reqwest::Client, request: NetRequest) -> Result<reqwest::RequestBuilder, String> {
    let url = check_destination(&request.url, request.allow_http, &request.allowed_hosts)?;
    let method = request.method.as_deref().unwrap_or("GET").to_ascii_uppercase();
    let method = reqwest::Method::from_bytes(method.as_bytes())
        .map_err(|_| format!("Invalid request method: {}", method))?;

    let mut outgoing = client.request(method, url);
    for (name, value) in request.headers.unwrap_or_default() {
        if is_reserved_header(&name) {
            continue;
        }
        outgoing = outgoing.header(name, value);
    }
    if let Some(body) = request.body.filter(|body| !body.is_empty()) {
        outgoing = outgoing.body(body);
    }
    Ok(outgoing)
}

/// Make one request the granted `net` entry permits.
#[tauri::command]
pub async fn net_fetch(
    app: tauri::AppHandle,
    consent: tauri::State<'_, crate::consent::Consent>,
    request: NetRequest,
) -> Result<NetResponse, String> {
    // What the rules themselves refuse is refused before anyone is asked about them.
    check_destination(&request.url, request.allow_http, &request.allowed_hosts)?;
    // The rules arrive with the request, from a page that also runs the bundle, so they may
    // be any caller's invention. Whether the network may be used under them is asked of
    // the person here (consent.rs), once for the bundle that is open.
    #[cfg(desktop)]
    consent
        .require_net(&app, &crate::consent::NetPolicy::new(request.allow_http, &request.allowed_hosts))
        .await?;
    #[cfg(not(desktop))]
    let _ = (&app, &consent);
    send(request).await
}

/// Send one request and read its response under the size cap.
async fn send(request: NetRequest) -> Result<NetResponse, String> {
    let timeout = timeout_for(request.timeout_ms);
    let mut response = outgoing(&client(timeout)?, request)?
        .send()
        .await
        .map_err(|e| format!("Network request failed: {}", e))?;
    let status = response.status();
    if is_redirect(status.as_u16()) {
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

    fn request(url: &str, headers: &[(&str, &str)]) -> NetRequest {
        NetRequest {
            url: url.to_string(),
            method: Some("post".to_string()),
            headers: Some(headers.iter().map(|(name, value)| (name.to_string(), value.to_string())).collect()),
            body: Some("{}".to_string()),
            timeout_ms: None,
            allow_http: false,
            allowed_hosts: hosts(&["api.example.com"]),
        }
    }

    #[test]
    fn a_script_cannot_ask_an_allowed_host_for_another_site() {
        // `Host` as the script wrote it would reach a second site served from the allowed
        // host's address, which is the destination `allowed_hosts` exists to rule out.
        let client = client(timeout_for(None)).unwrap();
        let built = outgoing(
            &client,
            request(
                "https://api.example.com/v1/items",
                &[("Host", "intranet.example.net"), ("X-Api-Key", "k1"), ("Content-Type", "application/json")],
            ),
        )
        .unwrap()
        .build()
        .unwrap();
        assert_eq!(built.url().host_str(), Some("api.example.com"));
        assert_eq!(built.headers().get("host"), None);
        // What the script may say is sent as written.
        assert_eq!(built.headers().get("x-api-key").unwrap(), "k1");
        assert_eq!(built.headers().get("content-type").unwrap(), "application/json");
        assert_eq!(built.method(), "POST");
    }

    #[test]
    fn a_script_does_not_frame_the_request_itself() {
        let client = client(timeout_for(None)).unwrap();
        let built = outgoing(
            &client,
            request(
                "https://api.example.com/v1/items",
                &[
                    ("content-length", "0"),
                    ("Transfer-Encoding", "chunked"),
                    ("Connection", "upgrade"),
                    ("Upgrade", "websocket"),
                    ("TE", "trailers"),
                    ("Trailer", "X-Sum"),
                    ("Keep-Alive", "timeout=600"),
                    ("Expect", "100-continue"),
                    ("Proxy-Authorization", "Basic eDp5"),
                    ("Authorization", "Bearer t"),
                ],
            ),
        )
        .unwrap()
        .build()
        .unwrap();
        let sent: Vec<&str> = built.headers().keys().map(|name| name.as_str()).collect();
        assert_eq!(sent, vec!["authorization"], "only the script's own header is left");
    }

    #[test]
    fn only_a_redirect_is_refused_as_one() {
        for status in [301, 302, 303, 307, 308] {
            assert!(is_redirect(status), "{} is a redirect", status);
        }
        // 304 answers a conditional request and 300 offers a choice: neither sends the
        // request anywhere, and the page's `fetch` hands both to the script.
        for status in [200, 204, 300, 304, 305, 306, 400, 404, 500] {
            assert!(!is_redirect(status), "{} is not a redirect", status);
        }
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
        let refused = tauri::async_runtime::block_on(send(request)).unwrap_err();
        assert_eq!(refused, "Host not allowed: evil.example.net");
    }
}
