use crate::app::AppContext;
use crate::bundle;
use crate::tenant::{TenantContext, TenantManager};
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

// ── Single-tenant serve (unchanged) ──

pub async fn serve(ctx: Arc<AppContext>, host: &str, port: u16, dev_mode: bool, trusted_proxy: bool) -> Result<(), String> {
    if trusted_proxy {
        tracing::info!("Trusted proxy mode: using X-Forwarded-For for client IP attribution");
    }
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
    let router = build_single_tenant_router(ctx, dev_mode, conn_tx, trusted_proxy);
    let addr = format!("{}:{}", host, port);
    tracing::info!("Listening on http://{}", addr);

    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .map_err(|e| format!("Failed to bind: {}", e))?;

    axum::serve(
        listener,
        router.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal_single(shutdown_tx))
    .await
    .map_err(|e| format!("Server error: {}", e))?;

    // Wait for all WebSocket connections to close (senders dropped),
    // with a timeout to prevent hanging indefinitely on stuck connections.
    let _ = tokio::time::timeout(
        std::time::Duration::from_secs(40),
        conn_rx.recv(),
    ).await;

    Ok(())
}

// ── Multi-tenant serve ──

pub async fn serve_multi(manager: Arc<TenantManager>, host: &str, port: u16, dev_mode: bool, trusted_proxy: bool) -> Result<(), String> {
    if trusted_proxy {
        tracing::info!("Trusted proxy mode: using X-Forwarded-For for client IP attribution");
    }

    // Start ticket cleanup for each tenant
    for tenant in manager.tenants() {
        tenant.sync_manager.spawn_ticket_cleanup();
    }

    let shutdown_tx = manager.shutdown.clone();
    let (conn_tx, mut conn_rx) = tokio::sync::mpsc::channel::<()>(1);
    let router = build_multi_tenant_router(manager.clone(), dev_mode, conn_tx, trusted_proxy);
    let addr = format!("{}:{}", host, port);

    let tenant_ids = manager.tenant_ids();
    tracing::info!(
        "Multi-tenant mode: {} tenant(s) on http://{}",
        tenant_ids.len(), addr
    );
    for id in &tenant_ids {
        tracing::info!("  /{}/... -> tenant '{}'", id, id);
    }

    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .map_err(|e| format!("Failed to bind: {}", e))?;

    axum::serve(
        listener,
        router.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal_multi(shutdown_tx))
    .await
    .map_err(|e| format!("Server error: {}", e))?;

    let _ = tokio::time::timeout(
        std::time::Duration::from_secs(40),
        conn_rx.recv(),
    ).await;

    Ok(())
}

// ── Single-tenant router (original, renamed) ──

fn build_single_tenant_router(ctx: Arc<AppContext>, dev_mode: bool, conn_tx: tokio::sync::mpsc::Sender<()>, trusted_proxy: bool) -> Router {
    // CORS: restrict origins if config.server.allowedOrigins is set.
    let cors = build_cors(&ctx.manifest, dev_mode);

    let mut router = Router::new()
        .route("/health", get(health))
        .route("/manifest.json", get(serve_manifest))
        .route("/sync", get(ws_upgrade))
        .route("/sync/ticket", axum::routing::post(issue_ticket));

    // Explicit body limit for API routes (2MB default).
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
            router = register_api_routes(router, routes, false);
        }
    }

    // Serve client bundle files
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
        .layer(axum::Extension(TrustedProxy(trusted_proxy)))
        .with_state(ctx)
}

// ── Multi-tenant router ──

fn build_multi_tenant_router(
    manager: Arc<TenantManager>,
    dev_mode: bool,
    conn_tx: tokio::sync::mpsc::Sender<()>,
    trusted_proxy: bool,
) -> Router {
    // Global routes (not tenant-scoped).
    // Convert to Router<()> via .with_state() so we can merge with tenant
    // sub-routers that also have their own state baked in.
    let mut app: Router<()> = Router::new()
        .route("/health", get(health_multi))
        .route("/tenants", get(list_tenants))
        .with_state(manager.clone());

    // Build a sub-router for each tenant, nested under /<tenant-id>/
    for tenant in manager.tenants() {
        let tenant_id = tenant.tenant_id.clone();
        let tenant_arc = tenant.clone();

        let cors = if dev_mode {
            CorsLayer::new().allow_origin(Any).allow_methods(Any).allow_headers(Any)
        } else {
            build_cors(&tenant.manifest, false)
        };

        let max_body = tenant.manifest.config.as_ref()
            .and_then(|c| c.get("server"))
            .and_then(|s| s.get("maxBodySize"))
            .and_then(|v| v.as_u64())
            .map(|n| n.min(16 * 1024 * 1024))
            .unwrap_or(2 * 1024 * 1024) as usize;

        let mut tenant_router: Router<Arc<TenantContext>> = Router::new()
            .route("/manifest.json", get(tenant_serve_manifest))
            .route("/sync", get(tenant_ws_upgrade))
            .route("/sync/ticket", axum::routing::post(tenant_issue_ticket));

        // Register tenant's API routes
        if let Some(server) = &tenant.manifest.server {
            if let Some(routes) = &server.routes {
                tenant_router = register_api_routes_tenant(tenant_router, routes);
            }
        }

        // Static files
        for &prefix in ALLOWED_STATIC_DIRS {
            let dir = tenant.bundle_path.join(prefix);
            tenant_router = tenant_router.nest_service(
                &format!("/{}", prefix),
                ServeDir::new(dir),
            );
        }

        // Convert tenant router to Router<()> by baking in its state
        let tenant_router: Router<()> = tenant_router
            .layer(DefaultBodyLimit::max(max_body))
            .layer(cors)
            .with_state(tenant_arc);

        let path = format!("/{}", tenant_id);
        tracing::debug!("Nesting tenant router at {}", path);
        app = app.nest(&path, tenant_router);
    }

    app
        .layer(TraceLayer::new_for_http())
        .layer(axum::Extension(conn_tx))
        .layer(axum::Extension(TrustedProxy(trusted_proxy)))
}

/// Register API routes from manifest onto a single-tenant router.
fn register_api_routes(mut router: Router<Arc<AppContext>>, routes: &[crate::bundle::RouteDefinition], _is_tenant: bool) -> Router<Arc<AppContext>> {
    let mut registered = std::collections::HashSet::<String>::new();

    for route in routes {
        let handler_name = route.handler.clone();
        let method = route.method.to_uppercase();
        let path = normalize_route_path(&route.path);

        if let Some(reason) = validate_route_path(&path) {
            tracing::warn!("Skipping route {} {} -> {}: {}", method, path, handler_name, reason);
            continue;
        }

        let route_key = format!("{} {}", method, path);
        if !registered.insert(route_key.clone()) {
            tracing::warn!("Skipping duplicate route: {} -> {}", route_key, handler_name);
            continue;
        }

        tracing::info!("Registering route: {} {} -> {}", method, path, handler_name);

        let make_handler = |name: String, is_public: bool| {
            move |
                State(ctx): State<Arc<AppContext>>,
                method: axum::http::Method,
                uri: axum::http::Uri,
                headers: axum::http::HeaderMap,
                query: axum::extract::Query<HashMap<String, String>>,
                body: axum::body::Bytes,
            | {
                api_handler_single(ctx, name, is_public, method, uri, headers, query, body)
            }
        };
        let is_public = route.public;

        router = add_method_route(router, &method, &path, make_handler(handler_name, is_public));
    }

    router
}

/// Register API routes for a tenant router.
/// Uses relaxed validation: tenant routes are nested under `/<tenant-id>/`,
/// so paths like `/health` or `/sync` don't conflict with global routes.
/// Only wildcards/params and static dir conflicts are checked.
fn register_api_routes_tenant(mut router: Router<Arc<TenantContext>>, routes: &[crate::bundle::RouteDefinition]) -> Router<Arc<TenantContext>> {
    let mut registered = std::collections::HashSet::<String>::new();

    for route in routes {
        let handler_name = route.handler.clone();
        let method = route.method.to_uppercase();
        let path = normalize_route_path(&route.path);

        // Tenant routes only need to avoid conflicts within their own namespace.
        // Built-in routes (/manifest.json, /sync, /sync/ticket) are already
        // registered on the tenant router, so reject those. Static dirs and
        // wildcards are also rejected. But /health is fine — it becomes
        // /<tenant-id>/health after nesting, not the global /health.
        if path == "/manifest.json" || path == "/sync" || path == "/sync/ticket" {
            tracing::warn!("Skipping route {} {} -> {}: conflicts with built-in tenant route", method, path, handler_name);
            continue;
        }
        if ALLOWED_STATIC_DIRS.iter().any(|dir| {
            path == format!("/{}", dir) || path.starts_with(&format!("/{}/", dir))
        }) {
            tracing::warn!("Skipping route {} {} -> {}: conflicts with static directory mount", method, path, handler_name);
            continue;
        }
        if path.contains('*') || path.contains(':') || path.contains('{') || path.contains('}') {
            tracing::warn!("Skipping route {} {} -> {}: wildcards and path params are not allowed", method, path, handler_name);
            continue;
        }

        let route_key = format!("{} {}", method, path);
        if !registered.insert(route_key.clone()) {
            tracing::warn!("Skipping duplicate route: {} -> {}", route_key, handler_name);
            continue;
        }

        tracing::info!("Registering route: {} {} -> {}", method, path, handler_name);

        let make_handler = |name: String, is_public: bool| {
            move |
                State(tenant): State<Arc<TenantContext>>,
                method: axum::http::Method,
                uri: axum::http::Uri,
                headers: axum::http::HeaderMap,
                query: axum::extract::Query<HashMap<String, String>>,
                body: axum::body::Bytes,
            | {
                api_handler_tenant(tenant, name, is_public, method, uri, headers, query, body)
            }
        };
        let is_public = route.public;

        router = add_method_route_tenant(router, &method, &path, make_handler(handler_name, is_public));
    }

    router
}

// ── Shared helpers ──

fn normalize_route_path(path: &str) -> String {
    let path = if !path.starts_with('/') {
        format!("/{}", path)
    } else {
        path.to_string()
    };
    if path.len() > 1 && path.ends_with('/') {
        tracing::warn!("Route path '{}' has trailing slash — stripped", path);
        path[..path.len() - 1].to_string()
    } else {
        path
    }
}

fn validate_route_path(path: &str) -> Option<&'static str> {
    if path == "/health" || path == "/manifest.json" || path == "/sync" || path == "/sync/ticket" {
        return Some("conflicts with built-in route");
    }
    if ALLOWED_STATIC_DIRS.iter().any(|dir| {
        path == format!("/{}", dir) || path.starts_with(&format!("/{}/", dir))
    }) {
        return Some("conflicts with static directory mount");
    }
    if path.contains('*') || path.contains(':') || path.contains('{') || path.contains('}') {
        return Some("wildcards and path params are not allowed");
    }
    None
}

fn add_method_route<H, T>(router: Router<Arc<AppContext>>, method: &str, path: &str, handler: H) -> Router<Arc<AppContext>>
where
    H: axum::handler::Handler<T, Arc<AppContext>> + Clone + Send + 'static,
    T: 'static,
{
    match method {
        "GET" => router.route(path, get(handler)),
        "POST" => router.route(path, axum::routing::post(handler)),
        "PUT" => router.route(path, axum::routing::put(handler)),
        "DELETE" => router.route(path, axum::routing::delete(handler)),
        "PATCH" => router.route(path, axum::routing::patch(handler)),
        _ => {
            tracing::warn!("Unsupported method: {}", method);
            router
        }
    }
}

fn add_method_route_tenant<H, T>(router: Router<Arc<TenantContext>>, method: &str, path: &str, handler: H) -> Router<Arc<TenantContext>>
where
    H: axum::handler::Handler<T, Arc<TenantContext>> + Clone + Send + 'static,
    T: 'static,
{
    match method {
        "GET" => router.route(path, get(handler)),
        "POST" => router.route(path, axum::routing::post(handler)),
        "PUT" => router.route(path, axum::routing::put(handler)),
        "DELETE" => router.route(path, axum::routing::delete(handler)),
        "PATCH" => router.route(path, axum::routing::patch(handler)),
        _ => {
            tracing::warn!("Unsupported method: {}", method);
            router
        }
    }
}

fn build_cors(manifest: &crate::bundle::ServerManifest, dev_mode: bool) -> CorsLayer {
    let allowed_origins: Option<Vec<String>> = manifest.config.as_ref()
        .and_then(|c| c.get("server"))
        .and_then(|s| s.get("allowedOrigins"))
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect());

    if let Some(origins) = allowed_origins.filter(|o| !o.is_empty()) {
        let parsed: Vec<axum::http::HeaderValue> = origins.iter()
            .filter_map(|s| s.parse().ok())
            .collect();
        if parsed.is_empty() {
            let invalid: Vec<&str> = origins.iter().map(String::as_str).collect();
            tracing::error!(
                "config.server.allowedOrigins contains no valid origins — \
                 rejecting all cross-origin requests. Invalid entries: {:?}.",
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
        CorsLayer::new()
    }
}

// ── Single-tenant handlers ──

async fn health() -> &'static str {
    "ok"
}

async fn serve_manifest(State(ctx): State<Arc<AppContext>>) -> Json<serde_json::Value> {
    Json(bundle::client_manifest(&ctx.manifest))
}

/// Max incoming WebSocket message size (4MB).
const MAX_WS_MESSAGE_SIZE: usize = 4 * 1024 * 1024;

// ── IP-based rate limiter for the ticket endpoint ──

const TICKET_RATE_LIMIT: u32 = 10;
const TICKET_RATE_WINDOW: std::time::Duration = std::time::Duration::from_secs(60);

struct RateLimitEntry {
    count: u32,
    window_start: std::time::Instant,
}

struct IpRateLimiter {
    entries: Mutex<HashMap<std::net::IpAddr, RateLimitEntry>>,
}

impl IpRateLimiter {
    fn new() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
        }
    }

    fn check(&self, ip: std::net::IpAddr) -> Result<(), ()> {
        let mut entries = self.entries.lock().unwrap_or_else(|p| p.into_inner());
        let now = std::time::Instant::now();

        if entries.len() > 1000 {
            entries.retain(|_, e| now.duration_since(e.window_start) < TICKET_RATE_WINDOW);
        }

        let entry = entries.entry(ip).or_insert(RateLimitEntry {
            count: 0,
            window_start: now,
        });

        if now.duration_since(entry.window_start) >= TICKET_RATE_WINDOW {
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

static TICKET_RATE_LIMITER: std::sync::OnceLock<IpRateLimiter> = std::sync::OnceLock::new();

fn ticket_rate_limiter() -> &'static IpRateLimiter {
    TICKET_RATE_LIMITER.get_or_init(IpRateLimiter::new)
}

async fn issue_ticket(
    State(ctx): State<Arc<AppContext>>,
    info: ConnectInfo<SocketAddr>,
    axum::Extension(proxy): axum::Extension<TrustedProxy>,
    headers: axum::http::HeaderMap,
) -> axum::response::Response {
    let client_ip = extract_client_ip(&headers, info.0.ip(), proxy.0);
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

async fn ws_upgrade(
    ws: WebSocketUpgrade,
    State(ctx): State<Arc<AppContext>>,
    axum::extract::Query(params): axum::extract::Query<HashMap<String, String>>,
    axum::Extension(conn_tx): axum::Extension<tokio::sync::mpsc::Sender<()>>,
) -> axum::response::Response {
    let sync = ctx.sync_manager.clone();
    let app_version = params.get("appVersion").map(String::as_str);

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

async fn api_handler_single(
    ctx: Arc<AppContext>,
    handler_name: String,
    is_public: bool,
    method: axum::http::Method,
    uri: axum::http::Uri,
    headers: axum::http::HeaderMap,
    query: axum::extract::Query<HashMap<String, String>>,
    body: axum::body::Bytes,
) -> impl IntoResponse {
    // Auth check
    if !is_public {
        if let Some(rejection) = check_auth(&headers, ctx.auth_token.as_deref()) {
            return rejection;
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

    execute_api_handler(runtime, handler_name, method, uri, headers, query, body).await
}

// ── Multi-tenant handlers ──

async fn health_multi(State(manager): State<Arc<TenantManager>>) -> Json<serde_json::Value> {
    let tenant_ids: Vec<&str> = manager.tenant_ids();
    Json(serde_json::json!({
        "status": "ok",
        "tenants": tenant_ids.len(),
    }))
}

async fn list_tenants(State(manager): State<Arc<TenantManager>>) -> Json<serde_json::Value> {
    let tenants: Vec<serde_json::Value> = manager.tenants()
        .map(|t| serde_json::json!({
            "id": t.tenant_id,
            "name": t.manifest.name,
            "version": t.manifest.version,
        }))
        .collect();
    Json(serde_json::json!({ "tenants": tenants }))
}

async fn tenant_serve_manifest(
    State(tenant): State<Arc<TenantContext>>,
) -> Json<serde_json::Value> {
    Json(bundle::client_manifest(&tenant.manifest))
}

async fn tenant_issue_ticket(
    State(tenant): State<Arc<TenantContext>>,
    info: ConnectInfo<SocketAddr>,
    axum::Extension(proxy): axum::Extension<TrustedProxy>,
    headers: axum::http::HeaderMap,
) -> axum::response::Response {
    let client_ip = extract_client_ip(&headers, info.0.ip(), proxy.0);
    if ticket_rate_limiter().check(client_ip).is_err() {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            "Rate limited — too many ticket requests, try again later",
        )
            .into_response();
    }

    let sync = tenant.sync_manager.clone();
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

async fn tenant_ws_upgrade(
    ws: WebSocketUpgrade,
    State(tenant): State<Arc<TenantContext>>,
    axum::extract::Query(params): axum::extract::Query<HashMap<String, String>>,
    axum::Extension(conn_tx): axum::Extension<tokio::sync::mpsc::Sender<()>>,
) -> axum::response::Response {
    let sync = tenant.sync_manager.clone();
    let app_version = params.get("appVersion").map(String::as_str);

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

    let shutdown_rx = tenant.shutdown.subscribe();
    ws.max_message_size(MAX_WS_MESSAGE_SIZE)
        .on_upgrade(move |socket| ws::handle_ws(socket, sync, shutdown_rx, cid, conn_tx))
        .into_response()
}

async fn api_handler_tenant(
    tenant: Arc<TenantContext>,
    handler_name: String,
    is_public: bool,
    method: axum::http::Method,
    uri: axum::http::Uri,
    headers: axum::http::HeaderMap,
    query: axum::extract::Query<HashMap<String, String>>,
    body: axum::body::Bytes,
) -> impl IntoResponse {
    if !is_public {
        if let Some(rejection) = check_auth(&headers, tenant.auth_token.as_deref()) {
            return rejection;
        }
    }

    let runtime = match &tenant.runtime {
        Some(r) => r.clone(),
        None => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(serde_json::json!({"error": "Runtime not available"})),
            );
        }
    };

    execute_api_handler(runtime, handler_name, method, uri, headers, query, body).await
}

// ── Shared helpers ──

fn check_auth(
    headers: &axum::http::HeaderMap,
    expected: Option<&str>,
) -> Option<(StatusCode, Json<serde_json::Value>)> {
    let expected = expected?;
    let provided = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    match provided {
        Some(token) => {
            use sha2::Digest;
            use subtle::ConstantTimeEq;
            let hash_t = sha2::Sha256::digest(token.as_bytes());
            let hash_e = sha2::Sha256::digest(expected.as_bytes());
            if !bool::from(hash_t.ct_eq(&hash_e)) {
                Some((
                    StatusCode::UNAUTHORIZED,
                    Json(serde_json::json!({"error": "Invalid auth token"})),
                ))
            } else {
                None
            }
        }
        None => Some((
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({"error": "Authorization required"})),
        )),
    }
}

/// Maximum JSON body size for API handlers.
const MAX_JSON_PARSE_SIZE: usize = 2 * 1024 * 1024;

async fn execute_api_handler(
    runtime: Arc<crate::runtime::ServerRuntime>,
    handler_name: String,
    method: axum::http::Method,
    uri: axum::http::Uri,
    headers: axum::http::HeaderMap,
    query: axum::extract::Query<HashMap<String, String>>,
    body: axum::body::Bytes,
) -> (StatusCode, Json<serde_json::Value>) {
    if body.len() > MAX_JSON_PARSE_SIZE {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            Json(serde_json::json!({"error": format!("Body too large ({} bytes, max {})", body.len(), MAX_JSON_PARSE_SIZE)})),
        );
    }

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

    let result = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        tokio::task::spawn_blocking(move || {
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
const ALLOWED_STATIC_DIRS: &[&str] = &["ui", "assets", "styles", "fonts", "images", "icons"];

#[derive(Clone, Copy)]
struct TrustedProxy(bool);

fn extract_client_ip(
    headers: &axum::http::HeaderMap,
    socket_ip: std::net::IpAddr,
    trusted_proxy: bool,
) -> std::net::IpAddr {
    if !trusted_proxy {
        return socket_ip;
    }
    headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|xff| {
            xff.rsplit(',')
                .next()
                .and_then(|ip_str| ip_str.trim().parse::<std::net::IpAddr>().ok())
        })
        .unwrap_or(socket_ip)
}

async fn shutdown_signal_single(shutdown_tx: tokio::sync::watch::Sender<bool>) {
    match tokio::signal::ctrl_c().await {
        Ok(()) => {
            tracing::info!("Shutting down...");
            let _ = shutdown_tx.send(true);
        }
        Err(e) => {
            tracing::error!("Failed to install CTRL+C handler: {}", e);
            std::future::pending::<()>().await;
        }
    }
}

async fn shutdown_signal_multi(shutdown_tx: tokio::sync::watch::Sender<bool>) {
    match tokio::signal::ctrl_c().await {
        Ok(()) => {
            tracing::info!("Shutting down multi-tenant server...");
            let _ = shutdown_tx.send(true);
        }
        Err(e) => {
            tracing::error!("Failed to install CTRL+C handler: {}", e);
            std::future::pending::<()>().await;
        }
    }
}
