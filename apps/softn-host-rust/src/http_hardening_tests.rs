//! Over a real socket: who may reach the host by which name, what a page on
//! another site may do, and the shapes errors come back in.
use super::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// A legacy bundle with one public route whose handler answers the status it
/// is asked for.
fn legacy_app(server: serde_json::Value) -> Arc<AppContext> {
    let root = std::env::temp_dir().join(format!("softn-hardening-{}", uuid::Uuid::new_v4()));
    let bundle = root.join("bundle");
    std::fs::create_dir_all(bundle.join("server")).unwrap();
    let manifest = serde_json::json!({"id":"com.example.hardening","name":"Hardening","version":"1",
        "config":{"server":server},
        "server":{"routes":[{"method":"POST","path":"/api/echo","handler":"echo","public":true}]}});
    std::fs::write(bundle.join("manifest.json"), serde_json::to_vec(&manifest).unwrap()).unwrap();
    std::fs::write(
        bundle.join("server/main.logic"),
        "function echo(req) { return { status: (req.body && req.body.status) || 200, body: { ok: true } }; }",
    )
    .unwrap();
    AppContext::load(bundle, Some(root.join("data")), Some(1), false).unwrap()
}

async fn serve(ctx: Arc<AppContext>) -> SocketAddr {
    let (conn_tx, conn_rx) = tokio::sync::mpsc::channel::<()>(1);
    std::mem::forget(conn_rx);
    let router = build_single_tenant_router(ctx, &test_options(false), conn_tx);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(serve_router(listener, router, HEADER_READ_TIMEOUT, std::future::pending()));
    addr
}

/// Status, lower-cased head, and body of one raw request.
async fn send(addr: SocketAddr, request: String) -> (u16, String, String) {
    let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        let n = tokio::time::timeout(std::time::Duration::from_secs(5), stream.read(&mut chunk))
            .await
            .unwrap()
            .unwrap_or(0);
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
        let text = String::from_utf8_lossy(&buf);
        if let Some(end) = text.find("\r\n\r\n") {
            let head = text[..end].to_ascii_lowercase();
            let wanted = if head.starts_with("http/1.1 101") {
                2
            } else {
                head.lines()
                    .find_map(|l| l.strip_prefix("content-length:"))
                    .and_then(|n| n.trim().parse::<usize>().ok())
                    .unwrap_or(0)
            };
            if buf.len() >= end + 4 + wanted {
                break;
            }
        }
    }
    let text = String::from_utf8_lossy(&buf).to_string();
    let status = text[9..12].parse().unwrap();
    let (head, body) = text
        .split_once("\r\n\r\n")
        .map(|(h, b)| (h.to_ascii_lowercase(), b.to_string()))
        .unwrap_or_default();
    (status, head, body)
}

fn post(host: &str, path: &str, origin: Option<&str>, body: &str, content_type: &str) -> String {
    let origin = origin.map(|o| format!("Origin: {o}\r\n")).unwrap_or_default();
    format!(
        "POST {path} HTTP/1.1\r\nHost: {host}\r\n{origin}Content-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

fn upgrade(host: &str, query: &str, origin: &str) -> String {
    format!(
        "GET /sync{query} HTTP/1.1\r\nHost: {host}\r\nOrigin: {origin}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"
    )
}

fn json_error(body: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(body).is_ok_and(|v| v["error"].is_string())
}

/// DNS rebinding: a page at http://evil.example:PORT whose name now resolves
/// to this host sends its own name as Host and as Origin. That is not this
/// host's page, whatever the two agree on.
#[tokio::test]
async fn a_rebound_name_is_not_the_hosts_own() {
    let addr = serve(legacy_app(serde_json::json!({}))).await;
    let evil = format!("evil.example:{}", addr.port());
    let origin = format!("http://{evil}");
    assert_eq!(send(addr, upgrade(&evil, "", &origin)).await.0, 403);
    assert_eq!(send(addr, post(&evil, "/api/echo", Some(&origin), "{}", "application/json")).await.0, 403);
    let (status, _, body) = send(addr, post(&evil, "/api/echo", None, "{}", "application/json")).await;
    assert_eq!(status, 403);
    assert!(json_error(&body), "{body}");
    // Names a browser cannot be tricked into: an address literal and localhost.
    let own = addr.to_string();
    assert_eq!(send(addr, upgrade(&own, "", &format!("http://{own}"))).await.0, 101);
    let local = format!("localhost:{}", addr.port());
    assert_eq!(
        send(addr, post(&local, "/api/echo", Some(&format!("http://{local}")), "{}", "application/json")).await.0,
        200
    );
    // The health check answers whatever name a probe uses.
    assert_eq!(
        send(addr, format!("GET /health HTTP/1.1\r\nHost: {evil}\r\nConnection: close\r\n\r\n")).await.0,
        200
    );
}

/// A page on another site may not run a handler: CORS only hides the answer,
/// and a text/plain POST needs no preflight.
#[tokio::test]
async fn a_foreign_origin_cannot_run_a_handler_or_take_a_ticket() {
    let addr = serve(legacy_app(serde_json::json!({"allowedOrigins":["https://app.example"]}))).await;
    let host = addr.to_string();
    assert_eq!(send(addr, post(&host, "/api/echo", Some("https://evil.example"), "{}", "text/plain")).await.0, 403);
    assert_eq!(send(addr, post(&host, "/api/echo", Some("https://app.example"), "{}", "application/json")).await.0, 200);
    assert_eq!(
        send(addr, post(&host, "/api/echo", Some(&format!("http://{host}")), "{}", "application/json")).await.0,
        200
    );
    assert_eq!(send(addr, post(&host, "/sync/ticket", Some("https://evil.example"), "", "application/json")).await.0, 403);
}

#[tokio::test]
async fn ticket_bursts_pass_and_throttling_says_when_to_retry() {
    let addr = serve(legacy_app(serde_json::json!({}))).await;
    let host = addr.to_string();
    for i in 0..20 {
        assert_eq!(send(addr, post(&host, "/sync/ticket", None, "", "application/json")).await.0, 200, "ticket {i}");
    }
    let (status, head, body) = send(addr, post(&host, "/sync/ticket", None, "", "application/json")).await;
    assert_eq!(status, 429);
    assert!(head.contains("retry-after:"), "{head}");
    assert!(json_error(&body), "{body}");
}

#[tokio::test]
async fn errors_are_json_and_scripts_cannot_answer_a_non_http_status() {
    let addr = serve(legacy_app(serde_json::json!({"maxBodySize": 64}))).await;
    let host = addr.to_string();
    let (status, _, body) = send(addr, format!("GET /api/nope HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n")).await;
    assert_eq!(status, 404);
    assert!(json_error(&body), "{body}");
    let (status, _, body) = send(addr, format!("GET /api/echo HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n")).await;
    assert_eq!(status, 405);
    assert!(json_error(&body), "{body}");
    let (status, _, body) = send(addr, post(&host, "/api/echo", None, &"x".repeat(100), "application/json")).await;
    assert_eq!(status, 413);
    assert!(json_error(&body), "{body}");
    for bad in [999, 600, 101] {
        let (status, _, _) = send(addr, post(&host, "/api/echo", None, &format!("{{\"status\":{bad}}}"), "application/json")).await;
        assert_eq!(status, 500, "a handler answered {bad}");
    }
}

#[tokio::test]
async fn sync_connections_are_capped() {
    let addr = serve(legacy_app(serde_json::json!({"maxSyncConnections": 1}))).await;
    let host = addr.to_string();
    let origin = format!("http://{host}");
    let mut first = tokio::net::TcpStream::connect(addr).await.unwrap();
    first.write_all(upgrade(&host, "", &origin).as_bytes()).await.unwrap();
    let mut buf = [0u8; 12];
    first.read_exact(&mut buf).await.unwrap();
    assert_eq!(&buf[9..12], b"101");
    assert_eq!(send(addr, upgrade(&host, "", &origin)).await.0, 503);
    drop(first);
    // The slot comes back when the socket goes.
    let mut freed = false;
    for _ in 0..100 {
        if send(addr, upgrade(&host, "", &origin)).await.0 == 101 {
            freed = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert!(freed);
}

/// Slowloris: a client that sends its headers a byte at a time used to hold
/// the connection for ever (axum::serve gives hyper no timer, so hyper's
/// header-read timeout never ran).
#[tokio::test]
async fn a_client_that_never_finishes_its_headers_is_disconnected() {
    let ctx = legacy_app(serde_json::json!({}));
    let (conn_tx, conn_rx) = tokio::sync::mpsc::channel::<()>(1);
    std::mem::forget(conn_rx);
    let router = build_single_tenant_router(ctx, &test_options(false), conn_tx);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(serve_router(listener, router, std::time::Duration::from_millis(300), std::future::pending()));
    let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
    stream.write_all(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Slow: ").await.unwrap();
    let mut buf = Vec::new();
    let closed = tokio::time::timeout(std::time::Duration::from_secs(5), stream.read_to_end(&mut buf)).await;
    assert!(closed.is_ok(), "the connection was still open five seconds later");
}

/// A trusted proxy answers for the names it forwards; `--allowed-hosts` and
/// the hosts of `allowedOrigins` name the host directly.
#[tokio::test]
async fn listed_names_and_trusted_proxies_are_served() {
    let ctx = legacy_app(serde_json::json!({"allowedOrigins":["https://app.example"]}));
    let (conn_tx, conn_rx) = tokio::sync::mpsc::channel::<()>(1);
    std::mem::forget(conn_rx);
    let options = ServeOptions {
        dev_mode: false,
        trusted_proxy: TrustedProxy::Nobody,
        allowed_hosts: ServeOptions::parse_allowed_hosts(&["Tables.Example:8443".into()]).unwrap(),
    };
    let router = build_single_tenant_router(ctx.clone(), &options, conn_tx.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(serve_router(listener, router, HEADER_READ_TIMEOUT, std::future::pending()));
    let get = |host: &str| format!("GET /manifest.json HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n");
    assert_eq!(send(addr, get("tables.example")).await.0, 200);
    assert_eq!(send(addr, get("app.example:443")).await.0, 200);
    assert_eq!(send(addr, get("other.example")).await.0, 403);
    // Through a proxy the operator trusts, the proxy vouches for the name.
    let proxied = ServeOptions { trusted_proxy: TrustedProxy::parse(Some("127.0.0.1")).unwrap(), ..test_options(false) };
    let router = build_single_tenant_router(ctx, &proxied, conn_tx);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(serve_router(listener, router, HEADER_READ_TIMEOUT, std::future::pending()));
    assert_eq!(send(addr, get("softn.example")).await.0, 200);
    // And the page it serves under that name is the host's own.
    let request = "POST /api/echo HTTP/1.1\r\nHost: 127.0.0.1:9877\r\nX-Forwarded-Host: softn.example\r\nOrigin: https://softn.example\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}";
    assert_eq!(send(addr, request.to_string()).await.0, 200);
}

#[tokio::test]
async fn each_tenant_is_held_to_its_own_names() {
    let root = std::env::temp_dir().join(format!("softn-tenant-hosts-{}", uuid::Uuid::new_v4()));
    for (dir, id, origin) in [("a", "alpha", "https://alpha.example"), ("b", "beta", "https://beta.example")] {
        let bundle = root.join("bundles").join(dir);
        std::fs::create_dir_all(&bundle).unwrap();
        let manifest = serde_json::json!({"id":id,"name":id,"version":"1","config":{"server":{"allowedOrigins":[origin]}}});
        std::fs::write(bundle.join("manifest.json"), serde_json::to_vec(&manifest).unwrap()).unwrap();
    }
    let manager = TenantManager::load(&root.join("bundles"), Some(&root.join("data")), Some(1), false).unwrap();
    let (conn_tx, conn_rx) = tokio::sync::mpsc::channel::<()>(1);
    std::mem::forget(conn_rx);
    let router = build_multi_tenant_router(manager, &test_options(false), conn_tx);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(serve_router(listener, router, HEADER_READ_TIMEOUT, std::future::pending()));
    let get = |path: &str, host: &str| format!("GET {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n");
    assert_eq!(send(addr, get("/alpha/manifest.json", "alpha.example")).await.0, 200);
    assert_eq!(send(addr, get("/alpha/manifest.json", "beta.example")).await.0, 403, "beta's list does not speak for alpha");
    assert_eq!(send(addr, get("/health", "anything.example")).await.0, 200);
    let (status, _, body) = send(addr, get("/nobody/manifest.json", "127.0.0.1")).await;
    assert_eq!(status, 404);
    assert!(json_error(&body), "{body}");
}

/// API v1 hands a handler the client's address only with the
/// `trusted-client-ip` capability, as the PHP host does.
#[test]
fn only_a_trusted_client_ip_grant_reveals_the_address() {
    let block = |capabilities: serde_json::Value| -> crate::bundle::ServerBlock {
        serde_json::from_value(serde_json::json!({"requires":{"apiVersion":1,"capabilities":capabilities}})).unwrap()
    };
    assert!(!RouteContext::of(&block(serde_json::json!(["sql"]))).client_ip);
    assert!(RouteContext::of(&block(serde_json::json!(["sql", "trusted-client-ip"]))).client_ip);
    let legacy: crate::bundle::ServerBlock = serde_json::from_value(serde_json::json!({})).unwrap();
    assert!(RouteContext::of(&legacy).client_ip);
}

#[tokio::test]
async fn a_handler_without_the_grant_sees_no_client_ip() {
    let runtime = crate::runtime::ServerRuntime::new(|| crate::host::BridgeSet {
        db: None, http: None, fs: None, env: None, sql: None, crypto: None,
        allow_time: false, development: true, allow_photos: false,
    }, Some(1)).unwrap();
    runtime
        .init("function ip(req) { return {status:200, body:{has: req.client_ip !== undefined, ip: req.client_ip || null}}; }".into())
        .unwrap();
    for (granted, expected) in [
        (false, serde_json::json!({"has":false,"ip":null})),
        (true, serde_json::json!({"has":true,"ip":"203.0.113.9"})),
    ] {
        let (status, Json(body)) = execute_api_handler(runtime.clone(), "ip".into(), ApiRouteOptions {
            transaction: TransactionMode::None, input_limit: 100, private_api: true, host_auth: false, client_ip: granted, poll: false, upload: false,
        }, "203.0.113.9".parse().unwrap(), axum::http::Method::GET, "/api/ip".parse().unwrap(),
            axum::http::HeaderMap::new(), axum::extract::Query(HashMap::new()), Vec::new().into()).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, expected);
    }
}

#[test]
fn host_names_and_allowed_host_flags_are_parsed() {
    assert_eq!(host_name("App.Example:8080"), "app.example");
    assert_eq!(host_name("[::1]:3000"), "::1");
    assert_eq!(host_name("localhost."), "localhost");
    assert_eq!(
        ServeOptions::parse_allowed_hosts(&["a.example, B.example:443".into()]).unwrap(),
        vec!["a.example", "b.example"]
    );
    for bad in ["https://a.example", "a.example/path", "*.example"] {
        assert!(ServeOptions::parse_allowed_hosts(&[bad.into()]).is_err(), "{bad}");
    }
    let policy = RequestPolicy::from_manifest(
        &serde_json::from_value(serde_json::json!({"name":"x","version":"1"})).unwrap(),
        &test_options(false),
    );
    for own in ["127.0.0.1:3000", "[::1]:3000", "localhost:3000", "app.localhost", "192.168.1.10"] {
        assert!(policy.host_allowed(own), "{own}");
    }
    for foreign in ["evil.example", "localhost.evil.example", "127.0.0.1.evil.example"] {
        assert!(!policy.host_allowed(foreign), "{foreign}");
    }
}

/// A polled route answers with an ETag, and with an empty 304 when the client
/// already has that body; the handler runs either way.
#[test]
fn a_polled_route_answers_not_modified_for_an_unchanged_body() {
    let body = serde_json::json!({"rooms": [1, 2]});
    let first = api_response(true, None, StatusCode::OK, body.clone());
    assert_eq!(first.status(), StatusCode::OK);
    let etag = first.headers().get("etag").unwrap().clone();
    assert_eq!(first.headers().get("x-softn-poll-interval").unwrap(), "5000");
    let again = api_response(true, Some(&etag), StatusCode::OK, body.clone());
    assert_eq!(again.status(), StatusCode::NOT_MODIFIED);
    let changed = api_response(true, Some(&etag), StatusCode::OK, serde_json::json!({"rooms": [1]}));
    assert_eq!(changed.status(), StatusCode::OK);
    // Not a polled route, or not a 200: as it was.
    assert!(api_response(false, Some(&etag), StatusCode::OK, body.clone()).headers().get("etag").is_none());
    assert_eq!(api_response(true, Some(&etag), StatusCode::UNAUTHORIZED, body).status(), StatusCode::UNAUTHORIZED);
}

/// `upload: "photo"`: the host sanitizes `data_url` and the handler gets the
/// result as `req.upload` with an empty body; a bad photo never reaches it.
#[tokio::test]
async fn a_photo_upload_route_hands_the_handler_a_sanitized_photo() {
    use base64::Engine;
    let runtime = crate::runtime::ServerRuntime::new(|| crate::host::BridgeSet {
        db: None, http: None, fs: None, env: None, sql: None, crypto: None,
        allow_time: false, development: true, allow_photos: true,
    }, Some(1)).unwrap();
    runtime
        .init("function photo(req) { return {status:200, body:{sanitized: req.upload.sanitized, thumb: req.upload.thumbnail.slice(0, 23), keys: Object.keys(req.body).length}}; }".into())
        .unwrap();
    let options = ApiRouteOptions {
        transaction: TransactionMode::None, input_limit: crate::bundle::PHOTO_UPLOAD_BODY_LIMIT, private_api: true,
        host_auth: false, client_ip: false, poll: false, upload: true,
    };
    let mut png = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(64, 64).write_to(&mut png, image::ImageFormat::Png).unwrap();
    let data_url = format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png.into_inner()));
    let call = |body: serde_json::Value| {
        let mut headers = axum::http::HeaderMap::new();
        headers.insert("content-type", "application/json".parse().unwrap());
        execute_api_handler(runtime.clone(), "photo".into(), options, "127.0.0.1".parse().unwrap(),
            axum::http::Method::POST, "/api/photo".parse().unwrap(), headers,
            axum::extract::Query(HashMap::new()), serde_json::to_vec(&body).unwrap().into())
    };
    let (status, Json(body)) = call(serde_json::json!({"data_url": data_url})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body, serde_json::json!({"sanitized": true, "thumb": "data:image/jpeg;base64,", "keys": 0}));
    let (status, Json(body)) = call(serde_json::json!({"data_url": "data:image/svg+xml;base64,PHN2Zy8+"})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["code"], "photo_rejected");
}

/// The PHP host's answers for the same conditions.
#[tokio::test]
async fn failures_answer_with_the_php_hosts_codes() {
    let runtime = crate::runtime::ServerRuntime::new(|| crate::host::BridgeSet {
        db: None, http: None, fs: None, env: None, sql: None, crypto: None,
        allow_time: false, development: true, allow_photos: false,
    }, Some(1)).unwrap();
    runtime.init("function boom() { throw new Error('private detail'); }".into()).unwrap();
    let (status, Json(body)) = execute_api_handler(runtime.clone(), "boom".into(), ApiRouteOptions {
        transaction: TransactionMode::None, input_limit: 100, private_api: true, host_auth: false,
        client_ip: false, poll: false, upload: false,
    }, "127.0.0.1".parse().unwrap(), axum::http::Method::GET, "/api/boom".parse().unwrap(),
        axum::http::HeaderMap::new(), axum::extract::Query(HashMap::new()), Vec::new().into()).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(body["code"], "host_error");
    assert!(!body.to_string().contains("private detail"));
    assert_eq!(runner_unavailable().0, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(runner_unavailable().1 .0["code"], "runner_unavailable");
}

#[tokio::test]
async fn a_client_over_the_request_rate_is_told_to_wait() {
    let addr = serve(legacy_app(serde_json::json!({"requestsPerMinute": 3}))).await;
    let host = addr.to_string();
    for i in 0..3 {
        assert_eq!(send(addr, post(&host, "/api/echo", None, "{}", "application/json")).await.0, 200, "request {i}");
    }
    let (status, head, body) = send(addr, post(&host, "/api/echo", None, "{}", "application/json")).await;
    assert_eq!(status, 429);
    assert!(head.contains("retry-after:"), "{head}");
    assert!(body.contains("rate_limited"), "{body}");
}

#[tokio::test]
async fn an_ipv6_host_binds() {
    assert!(bind("127.0.0.1", 0).await.is_ok());
    assert!(bind("localhost", 0).await.is_ok());
    // `::1` used to be spliced into "::1:3000", which never binds. A machine
    // without IPv6 cannot bind it either way; the error then names it.
    match bind("::1", 0).await {
        Ok(listener) => assert!(listener.local_addr().unwrap().is_ipv6()),
        Err(e) => assert!(e.contains("::1"), "{e}"),
    }
}
