use crate::app::AppContext;
use crate::bundle;
use crate::util;
use crate::ws;
use axum::extract::ws::WebSocketUpgrade;
use axum::extract::{ConnectInfo, DefaultBodyLimit, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Json};
use axum::routing::get;
use axum::Router;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use tower_http::cors::{Any, CorsLayer};
use tower_http::services::ServeDir;
use tower_http::trace::TraceLayer;

pub async fn serve(ctx: Arc<AppContext>, host: &str, port: u16, dev_mode: bool) -> Result<(), String> {
    let shutdown_tx = ctx.shutdown.clone();
    // Start background ticket cleanup so expired tickets are pruned even when
    // no new issue/redeem requests arrive (prevents attacker lock-out via
    // ticket table exhaustion).
    ctx.sync_manager.spawn_ticket_cleanup();
    // Connection drain: each WebSocket connection holds a clone of conn_tx.
    // After shutdown, we wait for all clones to drop (= all connections closed)
    // instead of using a fixed sleep, avoiding the race condition where
    // 250ms isn't enough for writer tasks to flush Close frames under load.
    let (conn_tx, mut conn_rx) = tokio::sync::mpsc::channel::<()>(1);
    let router = build_router(ctx, dev_mode, conn_tx);
    let addr = format!("{}:{}", host, port);
    tracing::info!("Listening on http://{}", addr);

    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .map_err(|e| format!("Failed to bind: {}", e))?;

    axum::serve(
        listener,
        router.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal(shutdown_tx))
    .await
    .map_err(|e| format!("Server error: {}", e))?;

    // Wait for all WebSocket connections to close (senders dropped),
    // with a timeout to prevent hanging indefinitely on stuck connections.
    // Must exceed the maximum handler timeout (35s in ws.rs HANDLER_TIMEOUT)
    // so in-flight sync operations and API calls can complete cleanly before
    // the process exits. A 40s timeout gives 5s of margin.
    let _ = tokio::time::timeout(
        std::time::Duration::from_secs(40),
        conn_rx.recv(), // returns None when all senders are dropped
    ).await;

    Ok(())
}

fn build_router(ctx: Arc<AppContext>, dev_mode: bool, conn_tx: tokio::sync::mpsc::Sender<()>) -> Router {
    // CORS: restrict origins if config.server.allowedOrigins is set.
    // In production (no --dev flag), missing allowedOrigins defaults to rejecting
    // cross-origin requests to prevent CSRF. Use --dev for permissive CORS during
    // local development.
    let cors = {
        let allowed_origins: Option<Vec<String>> = ctx.manifest.config.as_ref()
            .and_then(|c| c.get("server"))
            .and_then(|s| s.get("allowedOrigins"))
            .and_then(|v| v.as_array())
            .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect());

        if let Some(origins) = allowed_origins.filter(|o| !o.is_empty()) {
            let parsed: Vec<axum::http::HeaderValue> = origins.iter()
                .filter_map(|s| s.parse().ok())
                .collect();
            if parsed.is_empty() {
                // Fail closed: if the developer explicitly configured allowedOrigins
                // but all entries failed to parse (e.g. typos), reject cross-origin
                // requests rather than silently opening the API to the entire internet.
                // Log every invalid origin so the developer can see exactly what failed.
                let invalid: Vec<&str> = origins.iter().map(String::as_str).collect();
                tracing::error!(
                    "config.server.allowedOrigins contains no valid origins — \
                     rejecting all cross-origin requests. Invalid entries: {:?}. \
                     Valid origins must include the scheme (e.g. \"https://example.com\", \
                     not \"example.com\"). Fix in manifest.json config.server.allowedOrigins.",
                    invalid
                );
                CorsLayer::new()
            } else {
                tracing::info!("CORS restricted to {} origin(s)", parsed.len());
                CorsLayer::new().allow_origin(parsed).allow_methods(Any).allow_headers(Any)
            }
        } else if dev_mode {
            tracing::warn!("Dev mode: CORS open to all origins");
            CorsLayer::new().allow_origin(Any).allow_methods(Any).allow_headers(Any)
        } else {
            // Production default: no Access-Control-Allow-Origin header is sent,
            // so browsers will reject cross-origin requests (CSRF protection).
            tracing::info!("No allowedOrigins configured — cross-origin requests will be rejected (use --dev for open CORS)");
            CorsLayer::new()
        }
    };

    let mut router = Router::new()
        .route("/health", get(health))
        .route("/manifest.json", get(serve_manifest))
        .route("/sync", get(ws_upgrade))
        .route("/sync/ticket", axum::routing::post(issue_ticket));

    // Explicit body limit for API routes (2MB default).
    // Configurable via manifest config.server.maxBodySize if needed.
    // Cap at 16MB at the HTTP layer. Note: JSON parsing is further limited
    // to 2MB by MAX_JSON_PARSE_SIZE in api_handler (serde_json::Value can
    // use 5-10x the input size in RAM). The HTTP layer limit is higher to
    // accommodate future non-JSON endpoints (e.g. file uploads).
    const MAX_BODY_CEILING: u64 = 16 * 1024 * 1024;
    let max_body = ctx.manifest.config.as_ref()
        .and_then(|c| c.get("server"))
        .and_then(|s| s.get("maxBodySize"))
        .and_then(|v| v.as_u64())
        .map(|n| n.min(MAX_BODY_CEILING))
        .unwrap_or(2 * 1024 * 1024) as usize;

    // Register custom API routes from manifest
    if let Some(server) = &ctx.manifest.server {
        if let Some(routes) = &server.routes {
            let mut registered_routes = std::collections::HashSet::<String>::new();
            for route in routes {
                let handler_name = route.handler.clone();
                let method = route.method.to_uppercase();
                let path = route.path.clone();

                // Validate path: must start with '/' and not conflict with builtins
                let path = if !path.starts_with('/') {
                    format!("/{}", path)
                } else {
                    path
                };
                // Normalize: strip trailing slash (except root "/") to prevent
                // Axum router panics from overlapping routes like /api and /api/.
                let path = if path.len() > 1 && path.ends_with('/') {
                    tracing::warn!("Route path '{}' has trailing slash — stripped to '{}'", path, &path[..path.len() - 1]);
                    path[..path.len() - 1].to_string()
                } else {
                    path
                };
                if path == "/health" || path == "/manifest.json" || path == "/sync" {
                    tracing::warn!("Skipping route {} {} -> {}: conflicts with built-in route", method, path, handler_name);
                    continue;
                }
                // Reject routes that overlap with static directory mounts.
                // Axum panics on overlapping routes (nest_service vs route),
                // which would crash the host process at startup.
                if ALLOWED_STATIC_DIRS.iter().any(|dir| {
                    path == format!("/{}", dir) || path.starts_with(&format!("/{}/", dir))
                }) {
                    tracing::warn!("Skipping route {} {} -> {}: conflicts with static directory mount", method, path, handler_name);
                    continue;
                }
                // Reject paths with Axum wildcards (*), path params (:param),
                // or braces ({param}) to prevent router collisions.
                if path.contains('*') || path.contains(':') || path.contains('{') || path.contains('}') {
                    tracing::warn!("Skipping route {} {} -> {}: wildcards and path params are not allowed", method, path, handler_name);
                    continue;
                }
                // Prevent duplicate (method, path) registrations — Axum panics
                // on overlapping routes, which would crash the host process.
                let route_key = format!("{} {}", method, path);
                if !registered_routes.insert(route_key.clone()) {
                    tracing::warn!(
                        "Skipping duplicate route: {} -> {} (may result from trailing slash normalization)",
                        route_key, handler_name
                    );
                    continue;
                }

                tracing::info!("Registering route: {} {} -> {}", method, path, handler_name);

                // All methods use the same extractor pattern
                let make_handler = |name: String, is_public: bool| {
                    move |
                        State(ctx): State<Arc<AppContext>>,
                        method: axum::http::Method,
                        uri: axum::http::Uri,
                        headers: axum::http::HeaderMap,
                        query: axum::extract::Query<std::collections::HashMap<String, String>>,
                        body: axum::body::Bytes,
                    | {
                        api_handler(ctx, name, is_public, method, uri, headers, query, body)
                    }
                };
                let is_public = route.public;

                match method.as_str() {
                    "GET" => {
                        router = router.route(&path, get(make_handler(handler_name.clone(), is_public)));
                    }
                    "POST" => {
                        router = router.route(&path, axum::routing::post(make_handler(handler_name.clone(), is_public)));
                    }
                    "PUT" => {
                        router = router.route(&path, axum::routing::put(make_handler(handler_name.clone(), is_public)));
                    }
                    "DELETE" => {
                        router = router.route(&path, axum::routing::delete(make_handler(handler_name.clone(), is_public)));
                    }
                    "PATCH" => {
                        router = router.route(&path, axum::routing::patch(make_handler(handler_name.clone(), is_public)));
                    }
                    _ => {
                        tracing::warn!("Unsupported method: {}", method);
                    }
                }
            }
        }
    }

    // Serve client bundle files via per-prefix ServeDir mounts.
    // Each allowed directory gets its own scoped ServeDir, which eliminates:
    // - Manual path traversal checks (ServeDir handles it internally)
    // - TOCTOU races from separate canonicalize + serve steps
    // - Blacklist maintenance (only whitelisted prefixes are reachable)
    // tower-http's ServeDir provides ETag, Last-Modified, and Content-Type.
    let bundle_path = ctx.bundle_path.clone();
    for &prefix in ALLOWED_STATIC_DIRS {
        let dir = bundle_path.join(prefix);
        router = router.nest_service(
            &format!("/{}", prefix),
            ServeDir::new(dir),
        );
    }

    router
        .layer(DefaultBodyLimit::max(max_body))
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .layer(axum::Extension(conn_tx))
        .with_state(ctx)
}

async fn health() -> &'static str {
    "ok"
}

async fn serve_manifest(State(ctx): State<Arc<AppContext>>) -> Json<serde_json::Value> {
    Json(bundle::client_manifest(&ctx.manifest))
}

/// Max incoming WebSocket message size (4MB).
/// Axum/Tungstenite defaults to 64MB which bypasses the HTTP body limit.
/// Sync messages are typically small (a few KB per op), so 4MB is generous.
const MAX_WS_MESSAGE_SIZE: usize = 4 * 1024 * 1024;

// ── IP-based rate limiter for the ticket endpoint ──

/// Maximum ticket requests per IP within the rate-limit window.
/// Prevents an attacker from continuously hitting the ticket endpoint
/// to fill MAX_PENDING_TICKETS and lock out legitimate users.
const TICKET_RATE_LIMIT: u32 = 10;
/// Rate-limit window duration.
const TICKET_RATE_WINDOW: std::time::Duration = std::time::Duration::from_secs(60);

struct RateLimitEntry {
    count: u32,
    window_start: std::time::Instant,
}

/// Simple in-memory IP rate limiter. Uses a Mutex<HashMap> which is fine
/// for the ticket endpoint's low request volume. Entries are lazily evicted
/// when their window expires.
struct IpRateLimiter {
    entries: Mutex<HashMap<std::net::IpAddr, RateLimitEntry>>,
}

impl IpRateLimiter {
    fn new() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
        }
    }

    /// Returns Ok(()) if the request is allowed, Err(()) if rate-limited.
    fn check(&self, ip: std::net::IpAddr) -> Result<(), ()> {
        let mut entries = self.entries.lock().unwrap_or_else(|p| p.into_inner());
        let now = std::time::Instant::now();

        // Lazy eviction: prune expired entries periodically to bound memory.
        // Only run when the table grows large to avoid O(n) on every request.
        if entries.len() > 1000 {
            entries.retain(|_, e| now.duration_since(e.window_start) < TICKET_RATE_WINDOW);
        }

        let entry = entries.entry(ip).or_insert(RateLimitEntry {
            count: 0,
            window_start: now,
        });

        if now.duration_since(entry.window_start) >= TICKET_RATE_WINDOW {
            // Window expired — reset
            entry.count = 1;
            entry.window_start = now;
            Ok(())
        } else if entry.count < TICKET_RATE_LIMIT {
            entry.count += 1;
            Ok(())
        } else {
            Err(())
        }
    }
}

/// Lazily-initialized global rate limiter for the ticket endpoint.
static TICKET_RATE_LIMITER: std::sync::OnceLock<IpRateLimiter> = std::sync::OnceLock::new();

fn ticket_rate_limiter() -> &'static IpRateLimiter {
    TICKET_RATE_LIMITER.get_or_init(IpRateLimiter::new)
}

/// Issue a single-use, 30-second ticket for WebSocket authentication.
/// Clients POST here with `Authorization: Bearer <token>` and receive a
/// short-lived ticket to use in the WebSocket URL instead of their long-lived
/// auth token. This prevents tokens from appearing in proxy access logs.
///
/// Rate-limited per IP to prevent ticket table exhaustion DoS.
async fn issue_ticket(
    State(ctx): State<Arc<AppContext>>,
    info: ConnectInfo<SocketAddr>,
    headers: axum::http::HeaderMap,
) -> axum::response::Response {
    // Rate-limit by client IP to prevent ticket table exhaustion.
    let client_ip = info.0.ip();
    if ticket_rate_limiter().check(client_ip).is_err() {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            "Rate limited — too many ticket requests, try again later",
        )
            .into_response();
    }

    let sync = ctx.sync_manager.clone();
    let token = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|s| s.to_string());

    match sync.issue_ticket(token.as_deref(), None) {
        Ok(ticket) => Json(serde_json::json!({ "ticket": ticket })).into_response(),
        Err(reason) => (StatusCode::UNAUTHORIZED, reason).into_response(),
    }
}

/// Pre-upgrade auth: validate credentials from query params before allocating
/// WebSocket resources. This rejects unauthenticated connections at the HTTP
/// level (401), preventing attackers from exhausting file descriptors by
/// opening thousands of connections that sit idle during post-upgrade auth.
///
/// Preferred flow (avoids tokens in URLs/logs):
///   1. POST /sync/ticket with Authorization header → { ticket: "..." }
///   2. Connect to /sync?ticket=<ticket>
///
/// Fallback (backward-compatible): pass `?token=...` directly.
async fn ws_upgrade(
    ws: WebSocketUpgrade,
    State(ctx): State<Arc<AppContext>>,
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
    axum::Extension(conn_tx): axum::Extension<tokio::sync::mpsc::Sender<()>>,
) -> axum::response::Response {
    let sync = ctx.sync_manager.clone();
    let app_version = params.get("appVersion").map(String::as_str);

    // Prefer ticket-based auth (short-lived, single-use, not logged by proxies).
    // Fall back to raw token for backward compatibility.
    let cid = if let Some(ticket) = params.get("ticket") {
        match sync.redeem_ticket(ticket) {
            Ok(cid) => cid,
            Err(reason) => {
                return (StatusCode::UNAUTHORIZED, reason).into_response();
            }
        }
    } else {
        let token = params.get("token").map(String::as_str);
        match sync.handle_auth(token, app_version) {
            Ok(cid) => cid,
            Err(reason) => {
                return (StatusCode::UNAUTHORIZED, reason).into_response();
            }
        }
    };

    let shutdown_rx = ctx.shutdown.subscribe();
    ws.max_message_size(MAX_WS_MESSAGE_SIZE)
        .on_upgrade(move |socket| ws::handle_ws(socket, sync, shutdown_rx, cid, conn_tx))
        .into_response()
}

async fn api_handler(
    ctx: Arc<AppContext>,
    handler_name: String,
    is_public: bool,
    method: axum::http::Method,
    uri: axum::http::Uri,
    headers: axum::http::HeaderMap,
    query: axum::extract::Query<std::collections::HashMap<String, String>>,
    body: axum::body::Bytes,
) -> impl IntoResponse {
    // Auth check: when auth_token is configured, require Bearer token for
    // non-public routes. CORS only protects browser clients — non-browser
    // clients (curl, scripts, bots) bypass CORS entirely, so auth must be
    // enforced at the framework level for all API routes by default.
    if !is_public {
        if let Some(expected) = &ctx.auth_token {
            let provided = headers
                .get("authorization")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.strip_prefix("Bearer "));
            match provided {
                Some(token) => {
                    // Constant-time comparison via SHA-256 hash (same as sync auth)
                    use sha2::Digest;
                    use subtle::ConstantTimeEq;
                    let hash_t = sha2::Sha256::digest(token.as_bytes());
                    let hash_e = sha2::Sha256::digest(expected.as_bytes());
                    if !bool::from(hash_t.ct_eq(&hash_e)) {
                        return (
                            StatusCode::UNAUTHORIZED,
                            Json(serde_json::json!({"error": "Invalid auth token"})),
                        );
                    }
                }
                None => {
                    return (
                        StatusCode::UNAUTHORIZED,
                        Json(serde_json::json!({"error": "Authorization required"})),
                    );
                }
            }
        }
    }

    let runtime = match &ctx.runtime {
        Some(r) => r.clone(),
        None => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(serde_json::json!({"error": "Runtime not available"})),
            );
        }
    };

    // Reject oversized bodies before doing any work — no point parsing
    // headers or spawning a blocking task for a body we won't process.
    // serde_json::Value can use 5-10x the input size in RAM, and the value
    // is then copied again into VM Objects. Keep this aligned with the
    // default body limit (2MB). Larger payloads should use the FS bridge.
    const MAX_JSON_PARSE_SIZE: usize = 2 * 1024 * 1024;
    if body.len() > MAX_JSON_PARSE_SIZE {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            Json(serde_json::json!({"error": format!("Body too large ({} bytes, max {})", body.len(), MAX_JSON_PARSE_SIZE)})),
        );
    }

    // Collect lightweight metadata on the reactor; defer heavy work to spawn_blocking.
    let headers_json: serde_json::Map<String, serde_json::Value> = headers
        .iter()
        .filter_map(|(k, v)| {
            v.to_str().ok().map(|val| {
                (k.as_str().to_lowercase(), serde_json::Value::String(val.to_string()))
            })
        })
        .collect();
    let query_json = serde_json::to_value(&query.0).unwrap_or_default();
    let method_str = method.to_string();
    let path_str = uri.path().to_string();

    // Run body parsing AND script execution off the Tokio reactor (30s timeout).
    // INVARIANT: This timeout (30s) must exceed the VM wall-time limit (25s,
    // set in runtime.rs init_state). If the VM limit is ever raised above this
    // timeout, the HTTP handler returns 504 but the spawn_blocking thread
    // continues running until the VM terminates, silently leaking blocking
    // threads under load. Keep these values aligned.
    // JSON parsing can be CPU-intensive for large payloads, and running it on
    // the reactor would block all async I/O (WebSocket pings, health checks,
    // etc.) causing severe latency spikes.
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        tokio::task::spawn_blocking(move || {
            // Parse body off the reactor (can be CPU-intensive for large JSON).
            // Depth limit prevents stack overflow from deeply nested payloads.
            let body_json = if body.is_empty() {
                serde_json::Value::Null
            } else {
                match std::str::from_utf8(&body) {
                    Ok(text) => util::parse_json_bounded(text, util::MAX_JSON_DEPTH)
                        .unwrap_or_else(|_| serde_json::Value::String(text.to_string())),
                    Err(_) => serde_json::json!({ "__binary": true, "size": body.len() }),
                }
            };

            let request = serde_json::json!({
                "method": method_str,
                "path": path_str,
                "body": body_json,
                "query": query_json,
                "headers": headers_json,
            });

            runtime.call(&handler_name, vec![request])
        }),
    )
    .await;

    let call_result = match result {
        Ok(Ok(r)) => r,
        Ok(Err(e)) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": format!("Task join error: {}", e)})),
            );
        }
        Err(_) => {
            tracing::error!("API handler timed out after 30s");
            return (
                StatusCode::GATEWAY_TIMEOUT,
                Json(serde_json::json!({"error": "Handler timed out"})),
            );
        }
    };

    match call_result {
        Ok(result) => {
            // Check if result has { status, body } structure
            if let Some(obj) = result.as_object() {
                let status = obj
                    .get("status")
                    .and_then(|s| s.as_u64())
                    .and_then(|n| u16::try_from(n).ok())
                    .unwrap_or(200);
                let body = obj
                    .get("body")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null);
                let status_code = StatusCode::from_u16(status).unwrap_or_else(|_| {
                    tracing::warn!("Script returned invalid HTTP status: {}", status);
                    StatusCode::INTERNAL_SERVER_ERROR
                });
                (status_code, Json(body))
            } else {
                (StatusCode::OK, Json(result))
            }
        }
        Err(e) => {
            tracing::error!("Script handler error: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": "Internal server error"})),
            )
        }
    }
}

/// Allowed client-facing directories for static file serving.
/// Each directory gets its own scoped ServeDir mount, so only these
/// prefixes are reachable. server/ and data/ are never exposed.
const ALLOWED_STATIC_DIRS: &[&str] = &["ui", "assets", "styles", "fonts", "images", "icons"];

async fn shutdown_signal(shutdown_tx: tokio::sync::watch::Sender<bool>) {
    match tokio::signal::ctrl_c().await {
        Ok(()) => {
            tracing::info!("Shutting down...");
            // Signal all WebSocket connections to send Close frames and disconnect
            // before the process exits, preventing unclean termination.
            let _ = shutdown_tx.send(true);
        }
        Err(e) => {
            tracing::error!("Failed to install CTRL+C handler: {}", e);
            // Don't return — keep the server running rather than shutting down immediately
            std::future::pending::<()>().await;
        }
    }
}
