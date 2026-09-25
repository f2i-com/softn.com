use crate::app::AppContext;
use crate::bundle;
use crate::bundle::{AuthorizationMode, TransactionMode};
use crate::tenant::{TenantContext, TenantManager};
use crate::util;
use crate::ws;
use axum::extract::rejection::BytesRejection;
use axum::extract::ws::WebSocketUpgrade;
use axum::extract::{ConnectInfo, DefaultBodyLimit, FromRequest, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Json};
use axum::routing::get;
use axum::Router;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tower_http::cors::{Any, CorsLayer};
use tower_http::services::ServeDir;
use tower_http::trace::TraceLayer;

/// How long a client may take to send a request's headers, and how long an
/// idle keep-alive connection is kept.
const HEADER_READ_TIMEOUT: Duration = Duration::from_secs(30);
/// The longest a request body may go without a byte arriving (a gap limit,
/// reset by every piece of the body). The body as a whole is held to the
/// app's `bodyTimeoutSeconds` ([`limit_body_time`]); this one frees a stalled
/// client sooner when that is raised.
const REQUEST_BODY_TIMEOUT: Duration = Duration::from_secs(60);

/// A request body held to a deadline for the whole of it, set when the
/// request's headers were read. `tower_http`'s body timeout starts again with
/// every piece, so a client sending a byte every 59 seconds used to hold a
/// connection, and a task, for as long as it liked.
struct DeadlineBody {
    inner: axum::body::Body,
    deadline: std::pin::Pin<Box<tokio::time::Sleep>>,
    limit: Duration,
}

/// The error a body past its deadline ends with. `body_rejection` answers it
/// 408 `request_timeout`, as it does the gap limit's.
#[derive(Debug)]
struct BodyDeadlineElapsed(Duration);

impl std::fmt::Display for BodyDeadlineElapsed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "the request body timed out: it took longer than {} s to arrive", self.0.as_secs())
    }
}

impl std::error::Error for BodyDeadlineElapsed {}

impl hyper::body::Body for DeadlineBody {
    type Data = axum::body::Bytes;
    type Error = axum::BoxError;

    fn poll_frame(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Result<hyper::body::Frame<Self::Data>, Self::Error>>> {
        let this = self.get_mut();
        if std::future::Future::poll(this.deadline.as_mut(), cx).is_ready() {
            return std::task::Poll::Ready(Some(Err(Box::new(BodyDeadlineElapsed(this.limit)))));
        }
        std::pin::Pin::new(&mut this.inner).poll_frame(cx).map_err(Into::into)
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }

    fn size_hint(&self) -> hyper::body::SizeHint {
        self.inner.size_hint()
    }
}

/// Hold every request's body to `limit` from now (see [`DeadlineBody`]).
async fn limit_body_time(
    State(limit): State<Duration>,
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let deadline = Box::pin(tokio::time::sleep(limit));
    next.run(request.map(|inner| axum::body::Body::new(DeadlineBody { inner, deadline, limit }))).await
}

/// How the process was asked to serve, from the command line.
#[derive(Clone, Debug)]
pub struct ServeOptions {
    /// `--dev`: permissive CORS and sync origins when a bundle lists none.
    pub dev_mode: bool,
    pub trusted_proxy: TrustedProxy,
    /// `--allowed-hosts`: names this host answers to besides address literals
    /// and `localhost`, lower-case and without a port.
    pub allowed_hosts: Vec<String>,
}

impl ServeOptions {
    /// Check `--allowed-hosts` entries: host names, a port allowed and ignored.
    pub fn parse_allowed_hosts(values: &[String]) -> Result<Vec<String>, String> {
        let mut hosts = Vec::new();
        for value in values.iter().flat_map(|v| v.split(',')) {
            let value = value.trim();
            if value.is_empty() {
                continue;
            }
            let name = host_name(value);
            if value.contains("://") || value.contains(['/', ' ', '*']) || name.is_empty() {
                return Err(format!(
                    "--allowed-hosts: '{value}' is not a host name (write app.example, not https://app.example/)"
                ));
            }
            hosts.push(name);
        }
        Ok(hosts)
    }
}

/// The host part of a `Host` header or URL authority: lower-case, without
/// its port, IPv6 brackets or a trailing dot.
fn host_name(authority: &str) -> String {
    let authority = authority.trim().to_ascii_lowercase();
    let name = match authority.strip_prefix('[') {
        Some(rest) => rest.split(']').next().unwrap_or("").to_string(),
        None => match authority.rsplit_once(':') {
            Some((host, port)) if port.bytes().all(|b| b.is_ascii_digit()) => host.to_string(),
            _ => authority.clone(),
        },
    };
    name.trim_end_matches('.').to_string()
}

/// Bind the listener. `--host` may be an IPv4 or IPv6 address (with or
/// without brackets) or a name such as `localhost`; `format!("{host}:{port}")`
/// could not bind `::1`.
async fn bind(host: &str, port: u16) -> Result<tokio::net::TcpListener, String> {
    let literal = host.trim_start_matches('[').trim_end_matches(']');
    let result = match literal.parse::<std::net::IpAddr>() {
        Ok(ip) => tokio::net::TcpListener::bind(SocketAddr::new(ip, port)).await,
        Err(_) => tokio::net::TcpListener::bind((host, port)).await,
    };
    result.map_err(|e| format!("Failed to bind {host}:{port}: {e}"))
}

// ── Single-tenant serve ──

pub async fn serve(ctx: Arc<AppContext>, host: &str, port: u16, options: ServeOptions) -> Result<(), String> {
    options.trusted_proxy.announce();
    let policy = RequestPolicy::from_manifest(&ctx.manifest, &options);
    policy.announce_hosts(None, &options.trusted_proxy);
    if crate::private_backend::sync_enabled(&ctx.manifest) {
        policy.announce_sync(None, &ctx.sync_manager);
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
    let router = build_single_tenant_router(ctx, &options, conn_tx);
    let listener = bind(host, port).await?;
    tracing::info!("Listening on http://{}", listener.local_addr().map(|a| a.to_string()).unwrap_or_default());

    serve_router(listener, router, HEADER_READ_TIMEOUT, shutdown_signal(shutdown_tx, "Shutting down...")).await?;

    // Wait for all WebSocket connections to close (senders dropped),
    // with a timeout to prevent hanging indefinitely on stuck connections.
    let _ = tokio::time::timeout(Duration::from_secs(40), conn_rx.recv()).await;

    Ok(())
}

// ── Multi-tenant serve ──

pub async fn serve_multi(manager: Arc<TenantManager>, host: &str, port: u16, options: ServeOptions) -> Result<(), String> {
    options.trusted_proxy.announce();

    // Start ticket cleanup for each tenant
    for tenant in manager.tenants() {
        tenant.sync_manager.spawn_ticket_cleanup();
        let policy = RequestPolicy::from_manifest(&tenant.manifest, &options);
        policy.announce_hosts(Some(&tenant.tenant_id), &options.trusted_proxy);
        if crate::private_backend::sync_enabled(&tenant.manifest) {
            policy.announce_sync(Some(&tenant.tenant_id), &tenant.sync_manager);
        }
    }

    let shutdown_tx = manager.shutdown.clone();
    let (conn_tx, mut conn_rx) = tokio::sync::mpsc::channel::<()>(1);
    let router = build_multi_tenant_router(manager.clone(), &options, conn_tx);
    let listener = bind(host, port).await?;
    let addr = listener.local_addr().map(|a| a.to_string()).unwrap_or_default();

    let tenant_ids = manager.tenant_ids();
    tracing::info!("Multi-tenant mode: {} tenant(s) on http://{}", tenant_ids.len(), addr);
    for id in &tenant_ids {
        tracing::info!("  /{}/... -> tenant '{}'", id, id);
    }

    serve_router(listener, router, HEADER_READ_TIMEOUT, shutdown_signal(shutdown_tx, "Shutting down multi-tenant server...")).await?;

    let _ = tokio::time::timeout(Duration::from_secs(40), conn_rx.recv()).await;

    Ok(())
}

/// Accept connections and serve `router` on each until `shutdown` resolves,
/// then let the requests in flight finish.
///
/// This is `axum::serve` with a timer. axum builds each hyper connection
/// without one, which leaves hyper's header-read timeout switched off: a
/// client could hold a connection, and a file descriptor, for ever by sending
/// a request's headers a byte at a time. The same timeout closes keep-alive
/// connections that sit idle. Upgraded (WebSocket) connections leave hyper
/// and are bounded by the sync layer's own idle timeout.
pub async fn serve_router<F>(
    listener: tokio::net::TcpListener,
    router: Router,
    header_timeout: Duration,
    shutdown: F,
) -> Result<(), String>
where
    F: std::future::Future<Output = ()> + Send + 'static,
{
    let (signal_tx, signal_rx) = tokio::sync::watch::channel(());
    let (close_tx, close_rx) = tokio::sync::watch::channel(());
    tokio::pin!(shutdown);
    loop {
        let (stream, peer) = tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok(pair) => pair,
                Err(e) => {
                    // Out of file descriptors, most often: back off rather
                    // than spin, as axum::serve does.
                    tracing::warn!("accept failed: {e}");
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    continue;
                }
            },
            _ = &mut shutdown => break,
        };
        let _ = stream.set_nodelay(true);
        let router = router.clone();
        let mut signal_rx = signal_rx.clone();
        let close_rx = close_rx.clone();
        tokio::spawn(async move {
            let service = hyper::service::service_fn(move |mut request: hyper::Request<hyper::body::Incoming>| {
                request.extensions_mut().insert(ConnectInfo(peer));
                tower::ServiceExt::oneshot(router.clone(), request.map(axum::body::Body::new))
            });
            let mut builder = hyper_util::server::conn::auto::Builder::new(hyper_util::rt::TokioExecutor::new());
            builder.http1().timer(hyper_util::rt::TokioTimer::new()).header_read_timeout(header_timeout);
            let connection = builder.serve_connection_with_upgrades(hyper_util::rt::TokioIo::new(stream), service);
            tokio::pin!(connection);
            tokio::select! {
                _ = connection.as_mut() => {}
                _ = signal_rx.changed() => {
                    connection.as_mut().graceful_shutdown();
                    let _ = connection.as_mut().await;
                }
            }
            drop(close_rx);
        });
    }
    drop(listener);
    let _ = signal_tx.send(());
    drop(close_rx);
    close_tx.closed().await;
    Ok(())
}

// ── Single-tenant router ──

fn build_single_tenant_router(ctx: Arc<AppContext>, options: &ServeOptions, conn_tx: tokio::sync::mpsc::Sender<()>) -> Router {
    // CORS: restrict origins if config.server.allowedOrigins is set.
    let cors = build_cors(&ctx.manifest, options.dev_mode);
    let policy = RequestPolicy::from_manifest(&ctx.manifest, options);

    let mut router = Router::new()
        .route("/health", get(health))
        .route("/manifest.json", get(serve_manifest));
    if crate::private_backend::sync_enabled(&ctx.manifest) {
        router = router.route("/sync", get(ws_upgrade))
            .route("/sync/ticket", axum::routing::post(issue_ticket));
    }

    let max_body = max_body_size(&ctx.manifest);

    // Register custom API routes from manifest
    if let Some(server) = &ctx.manifest.server {
        if let Some(routes) = &server.routes {
            router = register_api_routes(router, routes, &RouteContext::of(server), &ctx.manifest);
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

    let guard = HostGuard { policy: policy.clone(), proxy: options.trusted_proxy.clone(), exempt_health: true };
    let body_time = bundle::body_timeout(&ctx.manifest);
    router
        .fallback(not_found)
        .method_not_allowed_fallback(method_not_allowed)
        .layer(DefaultBodyLimit::max(max_body))
        .layer(tower_http::timeout::RequestBodyTimeoutLayer::new(REQUEST_BODY_TIMEOUT))
        .layer(axum::middleware::from_fn_with_state(body_time, limit_body_time))
        .layer(cors)
        .layer(axum::Extension(policy))
        .layer(axum::middleware::from_fn_with_state(guard, guard_host))
        .layer(TraceLayer::new_for_http().make_span_with(request_span))
        .layer(axum::Extension(conn_tx))
        .layer(axum::Extension(options.trusted_proxy.clone()))
        .with_state(ctx)
}

/// The most any route of this bundle accepts, which is what the body
/// extractor is held to; each route then holds its body to its own limit
/// (`bundle::route_body_limit`: the smaller of the route's and the app's
/// `maxBodySize` when either is declared, as on the PHP host).
fn max_body_size(manifest: &crate::bundle::ServerManifest) -> usize {
    let app = manifest.config.as_ref()
        .and_then(|c| c.get("server"))
        .and_then(|s| s.get("maxBodySize"))
        .and_then(|v| v.as_u64())
        .map(|n| n as usize)
        .unwrap_or(crate::bundle::DEFAULT_BODY_LIMIT);
    manifest.server.as_ref()
        .and_then(|s| s.routes.as_ref())
        .into_iter()
        .flatten()
        .map(|route| crate::bundle::route_body_limit(route, manifest))
        .fold(app, usize::max)
        .min(crate::bundle::MAX_BODY_LIMIT)
}

// ── Multi-tenant router ──

fn build_multi_tenant_router(
    manager: Arc<TenantManager>,
    options: &ServeOptions,
    conn_tx: tokio::sync::mpsc::Sender<()>,
) -> Router {
    // Global routes (not tenant-scoped).
    // Convert to Router<()> via .with_state() so we can merge with tenant
    // sub-routers that also have their own state baked in.
    // The tenant listing names every bundle on the host. That is a convenience
    // for a development box and nothing a public multi-tenant host should
    // hand out unauthenticated, so it is served in --dev only.
    let global: Router<Arc<TenantManager>> = Router::new().route("/health", get(health_multi));
    let global = if options.dev_mode {
        // Held to the command line's hosts: no tenant's list speaks for it.
        let guard = HostGuard {
            policy: RequestPolicy { allowed_hosts: options.allowed_hosts.clone(), ..RequestPolicy::default() },
            proxy: options.trusted_proxy.clone(),
            exempt_health: true,
        };
        global.route("/tenants", get(list_tenants).layer(axum::middleware::from_fn_with_state(guard, guard_host)))
    } else {
        global
    };
    let mut app: Router<()> = global.with_state(manager.clone());

    // Build a sub-router for each tenant, nested under /<tenant-id>/
    for tenant in manager.tenants() {
        let tenant_id = tenant.tenant_id.clone();
        let tenant_arc = tenant.clone();

        // The same rule as a single app: a tenant's own list is honoured in
        // --dev too, and --dev opens only a tenant that lists nothing.
        let cors = build_cors(&tenant.manifest, options.dev_mode);
        let policy = RequestPolicy::from_manifest(&tenant.manifest, options);
        let max_body = max_body_size(&tenant.manifest);

        let mut tenant_router: Router<Arc<TenantContext>> = Router::new()
            .route("/manifest.json", get(tenant_serve_manifest));
        if crate::private_backend::sync_enabled(&tenant.manifest) {
            tenant_router = tenant_router.route("/sync", get(tenant_ws_upgrade))
                .route("/sync/ticket", axum::routing::post(tenant_issue_ticket));
        }

        // Register tenant's API routes
        if let Some(server) = &tenant.manifest.server {
            if let Some(routes) = &server.routes {
                tenant_router = register_api_routes_tenant(tenant_router, routes, &RouteContext::of(server), &tenant.manifest);
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

        // Convert tenant router to Router<()> by baking in its state. The
        // host guard is the tenant's: another tenant's allowedOrigins must
        // not make a name acceptable here.
        let guard = HostGuard { policy: policy.clone(), proxy: options.trusted_proxy.clone(), exempt_health: false };
        let body_time = bundle::body_timeout(&tenant.manifest);
        let tenant_router: Router<()> = tenant_router
            .fallback(not_found)
            .method_not_allowed_fallback(method_not_allowed)
            .layer(DefaultBodyLimit::max(max_body))
            .layer(tower_http::timeout::RequestBodyTimeoutLayer::new(REQUEST_BODY_TIMEOUT))
            .layer(axum::middleware::from_fn_with_state(body_time, limit_body_time))
            .layer(cors)
            .layer(axum::Extension(policy))
            .layer(axum::middleware::from_fn_with_state(guard, guard_host))
            .with_state(tenant_arc);

        let path = format!("/{}", tenant_id);
        tracing::debug!("Nesting tenant router at {}", path);
        app = app.nest(&path, tenant_router);
    }

    app
        .fallback(not_found)
        .layer(TraceLayer::new_for_http().make_span_with(request_span))
        .layer(axum::Extension(conn_tx))
        .layer(axum::Extension(options.trusted_proxy.clone()))
}

/// What every route of one bundle shares.
#[derive(Clone, Copy)]
struct RouteContext {
    /// API v1 (`server.requires` present).
    private_api: bool,
    /// Whether a handler is told the client's address: always for a legacy
    /// bundle, and for API v1 only with the `trusted-client-ip` capability,
    /// as on the PHP host.
    client_ip: bool,
}

impl RouteContext {
    fn of(server: &crate::bundle::ServerBlock) -> Self {
        let client_ip = match &server.requires {
            None => true,
            Some(required) => required.capabilities.iter().any(|c| c == "trusted-client-ip"),
        };
        Self { private_api: server.requires.is_some(), client_ip }
    }
}

/// Register API routes from manifest onto a single-tenant router.
fn register_api_routes(mut router: Router<Arc<AppContext>>, routes: &[crate::bundle::RouteDefinition], context: &RouteContext, manifest: &crate::bundle::ServerManifest) -> Router<Arc<AppContext>> {
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

        let make_handler = |name: String, is_public: bool, options: ApiRouteOptions| {
            move |
                State(ctx): State<Arc<AppContext>>,
                info: ConnectInfo<SocketAddr>,
                axum::Extension(proxy): axum::Extension<TrustedProxy>,
                axum::Extension(policy): axum::Extension<RequestPolicy>,
                method: axum::http::Method,
                uri: axum::http::Uri,
                headers: axum::http::HeaderMap,
                query: axum::extract::Query<HashMap<String, String>>,
                request: axum::extract::Request,
            | async move {
                // Who may ask comes before what they sent: the Host was held
                // to the allowlist by `guard_host`, and Origin and the rate
                // are checked here, all before the body is read.
                let peer_is_proxy = proxy.is_proxy(info.0.ip());
                if let Some(rejection) = check_origin(&policy, &headers, peer_is_proxy) {
                    return rejection;
                }
                let client_ip = extract_client_ip(&headers, info.0.ip(), &proxy);
                if let Some(rejection) = check_rate(ctx.api_limiter.as_deref(), client_ip) {
                    return rejection;
                }
                // The body is read only now: a request the checks above
                // refuse is answered without the host reading a byte of it.
                let body = match axum::body::Bytes::from_request(request, &()).await {
                    Ok(body) => body,
                    Err(rejection) => return body_rejection(rejection),
                };
                let if_none_match = headers.get(axum::http::header::IF_NONE_MATCH).cloned();
                let (status, Json(value)) = api_handler_single(ctx, name, is_public, options, client_ip, method, uri, headers, query, body).await;
                api_response(options.poll, if_none_match.as_ref(), status, value)
            }
        };
        let is_public = route.public || matches!(route.authorization, Some(AuthorizationMode::Application | AuthorizationMode::Anonymous));

        router = add_method_route(router, &method, &path, make_handler(handler_name, is_public, ApiRouteOptions::for_route(route, context, manifest)));
    }

    router
}

/// Register API routes for a tenant router.
/// Uses relaxed validation: tenant routes are nested under `/<tenant-id>/`,
/// so paths like `/health` or `/sync` don't conflict with global routes.
/// Only wildcards/params and static dir conflicts are checked.
fn register_api_routes_tenant(mut router: Router<Arc<TenantContext>>, routes: &[crate::bundle::RouteDefinition], context: &RouteContext, manifest: &crate::bundle::ServerManifest) -> Router<Arc<TenantContext>> {
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

        let make_handler = |name: String, is_public: bool, options: ApiRouteOptions| {
            move |
                State(tenant): State<Arc<TenantContext>>,
                info: ConnectInfo<SocketAddr>,
                axum::Extension(proxy): axum::Extension<TrustedProxy>,
                axum::Extension(policy): axum::Extension<RequestPolicy>,
                method: axum::http::Method,
                uri: axum::http::Uri,
                headers: axum::http::HeaderMap,
                query: axum::extract::Query<HashMap<String, String>>,
                request: axum::extract::Request,
            | async move {
                // Who may ask comes before what they sent: the Host was held
                // to the allowlist by `guard_host`, and Origin and the rate
                // are checked here, all before the body is read.
                let peer_is_proxy = proxy.is_proxy(info.0.ip());
                if let Some(rejection) = check_origin(&policy, &headers, peer_is_proxy) {
                    return rejection;
                }
                let client_ip = extract_client_ip(&headers, info.0.ip(), &proxy);
                if let Some(rejection) = check_rate(tenant.api_limiter.as_deref(), client_ip) {
                    return rejection;
                }
                // The body is read only now: a request the checks above
                // refuse is answered without the host reading a byte of it.
                let body = match axum::body::Bytes::from_request(request, &()).await {
                    Ok(body) => body,
                    Err(rejection) => return body_rejection(rejection),
                };
                let if_none_match = headers.get(axum::http::header::IF_NONE_MATCH).cloned();
                let (status, Json(value)) = api_handler_tenant(tenant, name, is_public, options, client_ip, method, uri, headers, query, body).await;
                api_response(options.poll, if_none_match.as_ref(), status, value)
            }
        };
        let is_public = route.public || matches!(route.authorization, Some(AuthorizationMode::Application | AuthorizationMode::Anonymous));

        router = add_method_route_tenant(router, &method, &path, make_handler(handler_name, is_public, ApiRouteOptions::for_route(route, context, manifest)));
    }

    router
}

/// Spend one request of the client's allowance for the app's routes, or
/// answer 429 as the PHP host does.
fn check_rate(limiter: Option<&crate::sync::AddressLimiter>, client_ip: std::net::IpAddr) -> Option<axum::response::Response> {
    let wait = limiter?.check(client_ip).err()?;
    let mut response = json_error(StatusCode::TOO_MANY_REQUESTS, "Too many requests.", "rate_limited");
    response.headers_mut().insert(axum::http::header::RETRY_AFTER, wait.as_secs().max(1).into());
    Some(response)
}

/// A handler's answer. On a polled route a 200 carries an `ETag` (the
/// SHA-256 of the body) and `X-SoftN-Poll-Interval`, and becomes an empty
/// 304 when the client already holds that body — after the handler ran, so
/// a revoked session is still refused.
fn api_response(
    poll: bool,
    if_none_match: Option<&axum::http::HeaderValue>,
    status: StatusCode,
    value: serde_json::Value,
) -> axum::response::Response {
    if !poll || status != StatusCode::OK {
        return (status, Json(value)).into_response();
    }
    use sha2::Digest;
    let bytes = serde_json::to_vec(&value).unwrap_or_default();
    let etag = format!("\"{}\"", crate::bridges::crypto::hex(&sha2::Sha256::digest(&bytes)));
    let matches = if_none_match
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.split(',').any(|tag| {
            let tag = tag.trim();
            tag == "*" || tag.trim_start_matches("W/") == etag
        }));
    let mut response = if matches {
        StatusCode::NOT_MODIFIED.into_response()
    } else {
        (
            [(axum::http::header::CONTENT_TYPE, axum::http::HeaderValue::from_static("application/json"))],
            bytes,
        )
            .into_response()
    };
    if let Ok(value) = axum::http::HeaderValue::from_str(&etag) {
        response.headers_mut().insert(axum::http::header::ETAG, value);
    }
    response.headers_mut().insert("x-softn-poll-interval", axum::http::HeaderValue::from_static("5000"));
    response
}

// ── Errors in the shape handlers use ──

fn json_error(status: StatusCode, message: &str, code: &str) -> axum::response::Response {
    (status, Json(serde_json::json!({ "error": message, "code": code }))).into_response()
}

async fn not_found() -> axum::response::Response {
    json_error(StatusCode::NOT_FOUND, "Endpoint not found.", "not_found")
}

async fn method_not_allowed() -> axum::response::Response {
    json_error(StatusCode::METHOD_NOT_ALLOWED, "Method not allowed.", "method_not_allowed")
}

/// A body the host would not read: over the size limit (413), too slow
/// (408), or broken off.
fn body_rejection(rejection: BytesRejection) -> axum::response::Response {
    let status = rejection.status();
    if status == StatusCode::PAYLOAD_TOO_LARGE {
        return json_error(status, "Request too large.", "payload_too_large");
    }
    let text = rejection.body_text();
    if text.to_ascii_lowercase().contains("timed out") || text.to_ascii_lowercase().contains("timeout") {
        return json_error(StatusCode::REQUEST_TIMEOUT, "The request body took too long to arrive.", "request_timeout");
    }
    json_error(StatusCode::BAD_REQUEST, "The request body could not be read.", "invalid_request")
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
        "OPTIONS" => router.route(path, axum::routing::options(handler)),
        "HEAD" => router.route(path, axum::routing::head(handler)),
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
        "OPTIONS" => router.route(path, axum::routing::options(handler)),
        "HEAD" => router.route(path, axum::routing::head(handler)),
        _ => {
            tracing::warn!("Unsupported method: {}", method);
            router
        }
    }
}

/// Response headers a cross-origin page may read: a polled route's.
const POLL_HEADERS: [axum::http::HeaderName; 2] = [
    axum::http::header::ETAG,
    axum::http::HeaderName::from_static("x-softn-poll-interval"),
];

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
            CorsLayer::new().allow_origin(parsed).allow_methods(Any).allow_headers(Any).expose_headers(POLL_HEADERS)
        }
    } else if dev_mode {
        tracing::warn!("Dev mode: CORS open to all origins");
        CorsLayer::new().allow_origin(Any).allow_methods(Any).allow_headers(Any).expose_headers(POLL_HEADERS)
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

// ── Who may reach the host, by which name, from which page ──

/// Which names this host answers to and which pages may use it.
///
/// **Host.** DNS rebinding points a name the attacker owns at this host (a
/// developer's loopback port, a LAN address); a page at
/// `http://evil.example:3000` then reaches it with `Host: evil.example:3000`
/// and `Origin: http://evil.example:3000`, which agree with each other, so an
/// Origin check alone waves it through to the database. A request is served
/// only when its `Host` is an address literal, `localhost` (or a
/// `*.localhost` name, which browsers resolve to loopback themselves), a name
/// from `--allowed-hosts`, or the host of an `allowedOrigins` entry, or when
/// it came through a trusted proxy (`--trusted-proxy`), which answers for the
/// names it forwards.
///
/// **Origin.** A browser sends `Origin` on a WebSocket handshake and on
/// every cross-origin request (and same-origin POSTs). The page's own origin
/// is allowed, as are `config.server.allowedOrigins` (the list CORS uses);
/// `--dev` with no list allows any origin, as its CORS does. Neither CORS nor
/// the socket stops a foreign page's request from running — CORS only hides
/// the answer — so a foreign `Origin` is refused before a handler runs, as the
/// PHP host does.
#[derive(Clone, Debug, Default)]
pub struct RequestPolicy {
    allowed_origins: Vec<String>,
    any_origin: bool,
    /// Lower-case host names, no port.
    allowed_hosts: Vec<String>,
}

impl RequestPolicy {
    pub fn from_manifest(manifest: &crate::bundle::ServerManifest, options: &ServeOptions) -> Self {
        let allowed_origins: Vec<String> = manifest.config.as_ref()
            .and_then(|c| c.get("server"))
            .and_then(|s| s.get("allowedOrigins"))
            .and_then(|v| v.as_array())
            .map(|arr| arr.iter()
                .filter_map(|v| v.as_str())
                .map(|o| o.trim().trim_end_matches('/').to_ascii_lowercase())
                .filter(|o| !o.is_empty())
                .collect())
            .unwrap_or_default();
        let mut allowed_hosts = options.allowed_hosts.clone();
        for origin in &allowed_origins {
            if let Some((_, authority)) = origin.split_once("://") {
                let name = host_name(authority);
                if !name.is_empty() && !allowed_hosts.contains(&name) {
                    allowed_hosts.push(name);
                }
            }
        }
        let any_origin = options.dev_mode && allowed_origins.is_empty();
        Self { allowed_origins, any_origin, allowed_hosts }
    }

    /// Whether a `Host` value names this host (see the type's comment).
    fn host_allowed(&self, host: &str) -> bool {
        let name = host_name(host);
        name.parse::<std::net::IpAddr>().is_ok()
            || name == "localhost"
            || name.ends_with(".localhost")
            || self.allowed_hosts.contains(&name)
    }

    /// Whether a request carrying `origin` may proceed. `hosts` are the names
    /// this request was addressed to (its `Host`, and a trusted proxy's
    /// `X-Forwarded-Host`): an origin naming one of them is the host's own
    /// page. The guard has already held `Host` to [`Self::host_allowed`].
    fn origin_allowed(&self, origin: &str, hosts: &[&str]) -> bool {
        if self.any_origin {
            return true;
        }
        let origin = origin.trim().trim_end_matches('/').to_ascii_lowercase();
        if self.allowed_origins.contains(&origin) {
            return true;
        }
        let Some((scheme, authority)) = origin.split_once("://") else { return false };
        if (scheme != "http" && scheme != "https") || authority.is_empty() || authority.contains('/') {
            return false;
        }
        let own = without_default_port(authority, scheme);
        hosts.iter().any(|h| without_default_port(&h.trim().to_ascii_lowercase(), scheme) == own)
    }

    /// The startup line naming who may reach the host by name.
    fn announce_hosts(&self, tenant: Option<&str>, proxy: &TrustedProxy) {
        let label = tenant.map(|t| format!(" for tenant '{}'", t)).unwrap_or_default();
        if matches!(proxy, TrustedProxy::Anyone) {
            tracing::info!("Host names{}: every peer is a trusted proxy, which answers for the names it forwards", label);
        } else {
            tracing::info!(
                "Host names{}: address literals, localhost and {:?}; any other name is refused (403) unless it comes through --trusted-proxy or is listed with --allowed-hosts",
                label, self.allowed_hosts
            );
        }
    }

    /// The startup line: who may connect, and the warning when nothing but
    /// the Origin check stands between a client and the database.
    fn announce_sync(&self, tenant: Option<&str>, sync: &crate::sync::SyncManager) {
        let label = tenant.map(|t| format!(" for tenant '{}'", t)).unwrap_or_default();
        if self.any_origin {
            tracing::warn!("Sync{}: --dev with no allowedOrigins — any web page may open /sync", label);
        } else {
            tracing::info!("Sync{}: /sync accepts its own origin and {} listed origin(s)", label, self.allowed_origins.len());
        }
        tracing::info!(
            "Sync{}: at most {} socket(s) per visitor (an address, or an IPv6 /64; config.server.maxSyncConnectionsPerVisitor)",
            label, sync.max_connections_per_visitor()
        );
        if !sync.has_auth() {
            tracing::warn!(
                "Sync{} is enabled with no auth token: any page that passes the Origin check, and any non-browser client with a ticket from /sync/ticket, can read and write this app's database. Set SOFTN_AUTH_TOKEN, or turn sync off with server.sync.enabled: false in the manifest.",
                label
            );
        }
    }
}

fn without_default_port<'a>(authority: &'a str, scheme: &str) -> &'a str {
    let default = if scheme == "https" { ":443" } else { ":80" };
    authority.strip_suffix(default).unwrap_or(authority)
}

/// The names a request was addressed to: its `Host` (or, lacking one, the
/// URI's authority), and a trusted proxy's first `X-Forwarded-Host`.
fn request_hosts<'a>(headers: &'a axum::http::HeaderMap, uri: Option<&'a axum::http::Uri>, behind_trusted_proxy: bool) -> Vec<&'a str> {
    let mut hosts: Vec<&str> = headers.get(axum::http::header::HOST)
        .and_then(|v| v.to_str().ok())
        .or_else(|| uri.and_then(|u| u.authority()).map(|a| a.as_str()))
        .into_iter()
        .collect();
    if behind_trusted_proxy {
        if let Some(forwarded) = headers.get("x-forwarded-host").and_then(|v| v.to_str().ok()) {
            hosts.extend(forwarded.split(',').next().map(str::trim));
        }
    }
    hosts
}

/// State for [`guard_host`].
#[derive(Clone)]
struct HostGuard {
    policy: RequestPolicy,
    proxy: TrustedProxy,
    /// `/health` answers any name, so a probe may use whichever it likes.
    exempt_health: bool,
}

/// Refuse a request addressed to a name this host does not answer to (DNS
/// rebinding; see [`RequestPolicy`]).
async fn guard_host(
    State(guard): State<HostGuard>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    if (guard.exempt_health && request.uri().path() == "/health") || guard.proxy.is_proxy(peer.ip()) {
        return next.run(request).await;
    }
    let host = request.headers().get(axum::http::header::HOST)
        .and_then(|v| v.to_str().ok())
        .or_else(|| request.uri().authority().map(|a| a.as_str()));
    match host {
        Some(host) if !guard.policy.host_allowed(host) => {
            tracing::debug!(host = %host_name(host), "Refused a request addressed to a name this host does not answer to");
            json_error(
                StatusCode::FORBIDDEN,
                "This host does not answer to that name. The operator can list it with --allowed-hosts.",
                "host_not_allowed",
            )
        }
        _ => next.run(request).await,
    }
}

/// Refuse a request from a page the policy does not allow, before any
/// handler runs. `None` lets it through.
fn check_origin(policy: &RequestPolicy, headers: &axum::http::HeaderMap, behind_trusted_proxy: bool) -> Option<axum::response::Response> {
    let origin = headers.get(axum::http::header::ORIGIN)?;
    let allowed = origin.to_str().is_ok_and(|origin| {
        policy.origin_allowed(origin, &request_hosts(headers, None, behind_trusted_proxy))
    });
    (!allowed).then(|| json_error(StatusCode::FORBIDDEN, "Origin not allowed.", "origin_not_allowed"))
}

/// Decide a `/sync` handshake before it is upgraded, and name the client.
///
/// A browser's handshake carries `Origin`, which must pass the policy above
/// whatever credential comes with it. A handshake with no `Origin` is not a
/// browser's and must present a credential: a ticket from `/sync/ticket`, or
/// the host's token as `?token=` (kept for existing scripts; a browser should
/// use the ticket, which keeps the long-lived token out of URLs and logs).
/// With a token configured every handshake needs one or the other, as before.
fn authorize_sync_upgrade(
    sync: &crate::sync::SyncManager,
    params: &HashMap<String, String>,
    headers: &axum::http::HeaderMap,
    policy: &RequestPolicy,
    behind_trusted_proxy: bool,
) -> Result<String, (StatusCode, &'static str)> {
    let origin = match headers.get(axum::http::header::ORIGIN) {
        None => None,
        Some(v) => Some(v.to_str().map_err(|_| (StatusCode::FORBIDDEN, "Origin not allowed"))?),
    };
    if let Some(origin) = origin {
        if !policy.origin_allowed(origin, &request_hosts(headers, None, behind_trusted_proxy)) {
            return Err((StatusCode::FORBIDDEN, "Origin not allowed"));
        }
    }
    if let Some(ticket) = params.get("ticket") {
        return sync.redeem_ticket(ticket).map_err(|_| (StatusCode::UNAUTHORIZED, "Authentication failed"));
    }
    let token = params.get("token").map(String::as_str);
    if origin.is_none() && (token.is_none() || !sync.has_auth()) {
        return Err((StatusCode::UNAUTHORIZED, "A client that sends no Origin must present a ticket from /sync/ticket"));
    }
    sync.handle_auth(token, params.get("appVersion").map(String::as_str))
        .map_err(|_| (StatusCode::UNAUTHORIZED, "Authentication failed"))
}

/// The span every request is traced under: method and path, never the query.
/// `/sync?token=…` is how a script may still authenticate, and the default
/// span wrote the whole URI, token included, into the debug log.
fn request_span<B>(request: &axum::http::Request<B>) -> tracing::Span {
    tracing::debug_span!("request", method = %request.method(), uri = %redacted_uri(request.uri()))
}

/// A URI as it may be logged: the path, and `?<redacted>` in place of any query.
fn redacted_uri(uri: &axum::http::Uri) -> String {
    match uri.query() {
        Some(_) => format!("{}?<redacted>", uri.path()),
        None => uri.path().to_string(),
    }
}

// ── /sync/ticket and /sync, shared by both routers ──

/// `POST /sync/ticket`: trade the token (if the host has one) for a
/// short-lived, single-use ticket.
fn ticket_response(
    sync: &crate::sync::SyncManager,
    policy: &RequestPolicy,
    peer: SocketAddr,
    proxy: &TrustedProxy,
    headers: &axum::http::HeaderMap,
) -> axum::response::Response {
    let behind_proxy = proxy.is_proxy(peer.ip());
    if let Some(rejection) = check_origin(policy, headers, behind_proxy) {
        return rejection;
    }
    let client_ip = extract_client_ip(headers, peer.ip(), proxy);
    let token = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    match sync.issue_ticket(token, client_ip) {
        Ok(ticket) => Json(serde_json::json!({ "ticket": ticket })).into_response(),
        Err(crate::sync::TicketError::Unauthorized) => {
            json_error(StatusCode::UNAUTHORIZED, "Authentication failed", "unauthorized")
        }
        Err(crate::sync::TicketError::RateLimited(wait)) => {
            let mut response = json_error(StatusCode::TOO_MANY_REQUESTS, "Too many ticket requests; retry later.", "rate_limited");
            response.headers_mut().insert(axum::http::header::RETRY_AFTER, wait.as_secs().max(1).into());
            response
        }
        Err(crate::sync::TicketError::Busy) => {
            let mut response = json_error(StatusCode::SERVICE_UNAVAILABLE, "The sync host is busy; retry shortly.", "server_busy");
            response.headers_mut().insert(axum::http::header::RETRY_AFTER, 5u64.into());
            response
        }
    }
}

async fn issue_ticket(
    State(ctx): State<Arc<AppContext>>,
    info: ConnectInfo<SocketAddr>,
    axum::Extension(proxy): axum::Extension<TrustedProxy>,
    axum::Extension(policy): axum::Extension<RequestPolicy>,
    headers: axum::http::HeaderMap,
) -> axum::response::Response {
    ticket_response(&ctx.sync_manager, &policy, info.0, &proxy, &headers)
}

/// `GET /sync`: authorize the handshake, claim a connection slot, upgrade.
#[allow(clippy::too_many_arguments)]
fn upgrade_response(
    ws: WebSocketUpgrade,
    sync: Arc<crate::sync::SyncManager>,
    shutdown_rx: tokio::sync::watch::Receiver<bool>,
    peer: SocketAddr,
    params: &HashMap<String, String>,
    headers: &axum::http::HeaderMap,
    conn_tx: tokio::sync::mpsc::Sender<()>,
    proxy: &TrustedProxy,
    policy: &RequestPolicy,
) -> axum::response::Response {
    let cid = match authorize_sync_upgrade(&sync, params, headers, policy, proxy.is_proxy(peer.ip())) {
        Ok(cid) => cid,
        Err((status, message)) => return json_error(status, message, if status == StatusCode::FORBIDDEN { "origin_not_allowed" } else { "unauthorized" }),
    };
    // Counted against the visitor the rate limits name: the socket peer, or
    // the client a trusted proxy forwards for, an IPv6 /64 counting as one.
    let client_ip = extract_client_ip(headers, peer.ip(), proxy);
    let slot = match sync.try_open_connection(client_ip) {
        Ok(slot) => slot,
        Err(crate::sync::ConnectionRefused::Full) => {
            tracing::warn!("Sync connection refused: the app is at its maxSyncConnections limit");
            let mut response = json_error(StatusCode::SERVICE_UNAVAILABLE, "Too many sync connections; retry shortly.", "server_busy");
            response.headers_mut().insert(axum::http::header::RETRY_AFTER, 5u64.into());
            return response;
        }
        Err(crate::sync::ConnectionRefused::VisitorFull) => {
            tracing::debug!("Sync connection refused: the visitor is at its maxSyncConnectionsPerVisitor limit");
            let mut response = json_error(
                StatusCode::TOO_MANY_REQUESTS,
                "Too many sync connections from this address; close one and retry.",
                "too_many_connections",
            );
            response.headers_mut().insert(axum::http::header::RETRY_AFTER, 5u64.into());
            return response;
        }
    };
    // The frame limit matters as much as the message limit: tungstenite's
    // default frame limit is 16 MiB, buffered before the message check runs.
    ws.max_message_size(MAX_WS_MESSAGE_SIZE)
        .max_frame_size(MAX_WS_MESSAGE_SIZE)
        .on_upgrade(move |socket| ws::handle_ws(socket, sync, shutdown_rx, cid, conn_tx, slot))
        .into_response()
}

#[allow(clippy::too_many_arguments)]
async fn ws_upgrade(
    ws: WebSocketUpgrade,
    State(ctx): State<Arc<AppContext>>,
    info: ConnectInfo<SocketAddr>,
    axum::extract::Query(params): axum::extract::Query<HashMap<String, String>>,
    headers: axum::http::HeaderMap,
    axum::Extension(conn_tx): axum::Extension<tokio::sync::mpsc::Sender<()>>,
    axum::Extension(proxy): axum::Extension<TrustedProxy>,
    axum::Extension(policy): axum::Extension<RequestPolicy>,
) -> axum::response::Response {
    upgrade_response(ws, ctx.sync_manager.clone(), ctx.shutdown.subscribe(), info.0, &params, &headers, conn_tx, &proxy, &policy)
}

#[allow(clippy::too_many_arguments)]
async fn api_handler_single(
    ctx: Arc<AppContext>,
    handler_name: String,
    is_public: bool,
    options: ApiRouteOptions,
    client_ip: std::net::IpAddr,
    method: axum::http::Method,
    uri: axum::http::Uri,
    headers: axum::http::HeaderMap,
    query: axum::extract::Query<HashMap<String, String>>,
    body: axum::body::Bytes,
) -> (StatusCode, Json<serde_json::Value>) {
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

    let options = ApiRouteOptions { host_auth: !is_public && ctx.auth_token.is_some(), ..options };
    execute_api_handler(runtime, handler_name, options, client_ip, method, uri, headers, query, body).await
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
    axum::Extension(policy): axum::Extension<RequestPolicy>,
    headers: axum::http::HeaderMap,
) -> axum::response::Response {
    ticket_response(&tenant.sync_manager, &policy, info.0, &proxy, &headers)
}

#[allow(clippy::too_many_arguments)]
async fn tenant_ws_upgrade(
    ws: WebSocketUpgrade,
    State(tenant): State<Arc<TenantContext>>,
    info: ConnectInfo<SocketAddr>,
    axum::extract::Query(params): axum::extract::Query<HashMap<String, String>>,
    headers: axum::http::HeaderMap,
    axum::Extension(conn_tx): axum::Extension<tokio::sync::mpsc::Sender<()>>,
    axum::Extension(proxy): axum::Extension<TrustedProxy>,
    axum::Extension(policy): axum::Extension<RequestPolicy>,
) -> axum::response::Response {
    upgrade_response(ws, tenant.sync_manager.clone(), tenant.shutdown.subscribe(), info.0, &params, &headers, conn_tx, &proxy, &policy)
}

#[allow(clippy::too_many_arguments)]
async fn api_handler_tenant(
    tenant: Arc<TenantContext>,
    handler_name: String,
    is_public: bool,
    options: ApiRouteOptions,
    client_ip: std::net::IpAddr,
    method: axum::http::Method,
    uri: axum::http::Uri,
    headers: axum::http::HeaderMap,
    query: axum::extract::Query<HashMap<String, String>>,
    body: axum::body::Bytes,
) -> (StatusCode, Json<serde_json::Value>) {
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

    let options = ApiRouteOptions { host_auth: !is_public && tenant.auth_token.is_some(), ..options };
    execute_api_handler(runtime, handler_name, options, client_ip, method, uri, headers, query, body).await
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

/// The default body limit, as the tests name it.
#[cfg(test)]
const MAX_JSON_PARSE_SIZE: usize = crate::bundle::DEFAULT_BODY_LIMIT;

#[derive(Clone, Copy)]
struct ApiRouteOptions {
    transaction: TransactionMode,
    input_limit: usize,
    private_api: bool,
    /// The host checked this request's `Authorization` against its own
    /// token (a route that is not public, on a host with a token). That
    /// header is the operator's secret, not the application's, and is
    /// withheld from the script. Set per request, where the token is known.
    host_auth: bool,
    /// Whether the request the script sees carries `client_ip`.
    client_ip: bool,
    /// A polled GET route (ETag, 304).
    poll: bool,
    /// A photo upload route: `data_url` is sanitized into `req.upload`.
    upload: bool,
}

impl ApiRouteOptions {
    fn for_route(route: &crate::bundle::RouteDefinition, context: &RouteContext, manifest: &crate::bundle::ServerManifest) -> Self {
        Self {
            transaction: route.transaction,
            input_limit: crate::bundle::route_body_limit(route, manifest),
            private_api: context.private_api,
            host_auth: false,
            client_ip: context.client_ip,
            poll: route.poll == Some(true) && route.method.eq_ignore_ascii_case("GET"),
            upload: route.upload.as_deref() == Some("photo"),
        }
    }
}

/// The request headers a script may read. Cookies and proxy credentials are
/// never the script's: an app authenticates with its own bearer session,
/// which is what the PHP host forwards too. `Authorization` is forwarded on
/// an application or anonymous route, where it is the app's session, and
/// withheld on a host-token route, where it is the operator's token.
fn script_headers(headers: &axum::http::HeaderMap, host_auth: bool) -> serde_json::Map<String, serde_json::Value> {
    headers
        .iter()
        .filter(|(k, _)| {
            let name = k.as_str();
            !(name.eq_ignore_ascii_case("cookie")
                || name.eq_ignore_ascii_case("proxy-authorization")
                || (host_auth && name.eq_ignore_ascii_case("authorization")))
        })
        .filter_map(|(k, v)| {
            v.to_str().ok().map(|val| {
                (k.as_str().to_lowercase(), serde_json::Value::String(val.to_string()))
            })
        })
        .collect()
}

#[allow(clippy::too_many_arguments)]
async fn execute_api_handler(
    runtime: Arc<crate::runtime::ServerRuntime>,
    handler_name: String,
    options: ApiRouteOptions,
    client_ip: std::net::IpAddr,
    method: axum::http::Method,
    uri: axum::http::Uri,
    headers: axum::http::HeaderMap,
    query: axum::extract::Query<HashMap<String, String>>,
    body: axum::body::Bytes,
) -> (StatusCode, Json<serde_json::Value>) {
    let input_limit = options.input_limit;
    if body.len() > input_limit {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            Json(serde_json::json!({"error": "Request too large.", "code": "payload_too_large"})),
        );
    }

    let private_body = if options.private_api {
        if body.is_empty() { Some(serde_json::json!({})) } else {
            let media_type = headers.get("content-type").and_then(|v| v.to_str().ok())
                .and_then(|v| v.split(';').next()).unwrap_or("").trim();
            if !media_type.eq_ignore_ascii_case("application/json") {
                return (StatusCode::UNSUPPORTED_MEDIA_TYPE, Json(serde_json::json!({"error":"Use application/json","code":"unsupported_media_type"})));
            }
            let parsed = std::str::from_utf8(&body).ok()
                .and_then(|text| util::parse_json_bounded(text, util::MAX_JSON_DEPTH).ok());
            match parsed {
                Some(value) if value.is_object() => Some(value),
                _ => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error":"Request body must be a JSON object","code":"invalid_request"}))),
            }
        }
    } else { None };

    // A photo upload: the host decodes and re-encodes the image before the
    // handler sees anything, which gets the result as `req.upload` and an
    // empty body, as on the PHP host.
    let (private_body, upload) = if options.upload {
        let data_url = private_body.as_ref()
            .and_then(|b| b.get("data_url"))
            .and_then(|v| v.as_str())
            .map(String::from);
        let sanitized = tokio::task::spawn_blocking(move || {
            data_url.ok_or_else(|| "missing data_url".to_string())
                .and_then(|url| crate::bridges::media::sanitize_photo(&url))
        }).await;
        match sanitized {
            Ok(Ok(upload)) => (Some(serde_json::json!({})), Some(upload)),
            _ => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({
                "error": "Photo rejected. Use a still JPEG, PNG or WebP under 4 MB, 16 megapixels and 8192 pixels a side.",
                "code": "photo_rejected",
            }))),
        }
    } else {
        (private_body, None)
    };

    let headers_json = script_headers(&headers, options.host_auth);
    let query_json = serde_json::to_value(&query.0).unwrap_or_default();
    let method_str = method.to_string();
    let path_str = uri.path().to_string();

    // Must exceed the runtime's own wait, or this fires first on a handler that
    // was about to answer — and the blocking task keeps running either way.
    let cancellation = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let _request_lifetime = ApiCancellation(cancellation.clone());
    let result = tokio::time::timeout(
        crate::runtime::MAX_CALL_WAIT + std::time::Duration::from_secs(5),
        tokio::task::spawn_blocking(move || {
            let body_json = if let Some(value) = private_body { value } else if body.is_empty() {
                serde_json::Value::Null
            } else {
                match std::str::from_utf8(&body) {
                    Ok(text) => util::parse_json_bounded(text, util::MAX_JSON_DEPTH)
                        .unwrap_or_else(|_| serde_json::Value::String(text.to_string())),
                    Err(_) => serde_json::json!({ "__binary": true, "size": body.len() }),
                }
            };

            let mut request = serde_json::json!({
                "method": method_str,
                "path": path_str,
                "body": body_json,
                "query": query_json,
                "headers": headers_json,
            });
            if options.client_ip {
                request["client_ip"] = serde_json::Value::String(client_ip.to_string());
            }
            if let Some(upload) = upload {
                request["upload"] = upload;
            }

            runtime.call_transaction(&handler_name, vec![request], options.transaction, cancellation)
        }),
    )
    .await;

    let call_result = match result {
        Ok(Ok(r)) => r,
        Ok(Err(e)) => {
            // A panic's message is for the log, not the client.
            tracing::error!("API handler task failed: {}", e);
            return host_error();
        }
        Err(_) => {
            tracing::error!("API handler timed out after {}s", (crate::runtime::MAX_CALL_WAIT + std::time::Duration::from_secs(5)).as_secs());
            return runner_unavailable();
        }
    };

    match call_result {
        Ok(result) => {
            // SQL routes validate before committing. Other API v1 routes still
            // share the exact same response shape and serialized byte bound.
            if options.private_api && options.transaction == TransactionMode::None
                && crate::runtime::validate_private_response(&result).is_err() {
                return host_error();
            }
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
                // 200-599, as the PHP host allows and as API v1 already
                // validates. `StatusCode` accepts 100-999: a 1xx is an
                // interim response a client does not expect a body after, and
                // 600-999 are not HTTP.
                let status_code = StatusCode::from_u16(status)
                    .ok()
                    .filter(|_| (200..=599).contains(&status))
                    .unwrap_or_else(|| {
                        tracing::warn!("Script returned invalid HTTP status: {}", status);
                        StatusCode::INTERNAL_SERVER_ERROR
                    });
                (status_code, Json(body))
            } else {
                (StatusCode::OK, Json(result))
            }
        }
        Err(e) => {
            if e.starts_with("Worker queue full") || e.starts_with("Private database is busy") {
                return (StatusCode::SERVICE_UNAVAILABLE, Json(serde_json::json!({"error":"The server is busy. Please retry.","code":"database_busy"})));
            }
            if e.starts_with("Handler did not return") || e.starts_with("Request cancelled") {
                return runner_unavailable();
            }
            tracing::error!("Script handler error: {}", e);
            host_error()
        }
    }
}

/// A handler that threw, or answered something the host would not send: the
/// PHP host's 500 `host_error`. Any writes were rolled back.
fn host_error() -> (StatusCode, Json<serde_json::Value>) {
    (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "The request could not be completed.", "code": "host_error"})))
}

/// A handler that did not finish in time: the PHP host's 503
/// `runner_unavailable` (this host used to answer 504), retryable.
fn runner_unavailable() -> (StatusCode, Json<serde_json::Value>) {
    (StatusCode::SERVICE_UNAVAILABLE, Json(serde_json::json!({"error": "The request could not be completed. Please retry.", "code": "runner_unavailable"})))
}

/// Allowed client-facing directories for static file serving.
const ALLOWED_STATIC_DIRS: &[&str] = &["ui", "assets", "styles", "fonts", "images", "icons"];

/// An address or CIDR range a reverse proxy may connect from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProxyPeer {
    addr: std::net::IpAddr,
    prefix: u8,
}

impl ProxyPeer {
    fn parse(text: &str) -> Result<ProxyPeer, String> {
        let text = text.trim();
        let (addr, prefix) = match text.split_once('/') {
            Some((a, p)) => (a, Some(p)),
            None => (text, None),
        };
        let addr: std::net::IpAddr = addr
            .parse()
            .map_err(|_| format!("--trusted-proxy: '{}' is not an IP address or CIDR range", text))?;
        let addr = canonical_ip(addr);
        let bits = if addr.is_ipv4() { 32 } else { 128 };
        let prefix = match prefix {
            None => bits,
            Some(p) => p
                .parse::<u8>()
                .ok()
                .filter(|p| *p <= bits)
                .ok_or_else(|| format!("--trusted-proxy: '{}' has a prefix length past /{}", text, bits))?,
        };
        Ok(ProxyPeer { addr, prefix })
    }

    fn contains(&self, ip: std::net::IpAddr) -> bool {
        let ip = canonical_ip(ip);
        match (self.addr, ip) {
            (std::net::IpAddr::V4(net), std::net::IpAddr::V4(ip)) => {
                let mask = if self.prefix == 0 { 0 } else { u32::MAX << (32 - u32::from(self.prefix)) };
                (u32::from(net) & mask) == (u32::from(ip) & mask)
            }
            (std::net::IpAddr::V6(net), std::net::IpAddr::V6(ip)) => {
                let mask = if self.prefix == 0 { 0 } else { u128::MAX << (128 - u32::from(self.prefix)) };
                (u128::from(net) & mask) == (u128::from(ip) & mask)
            }
            _ => false,
        }
    }
}

/// An IPv4 address that arrived as IPv4-mapped IPv6 (a dual-stack listener
/// on `::`) is the IPv4 address for every comparison.
fn canonical_ip(ip: std::net::IpAddr) -> std::net::IpAddr {
    match ip {
        std::net::IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => std::net::IpAddr::V4(v4),
            None => ip,
        },
        v4 => v4,
    }
}

/// Who may assert a client's address through `X-Forwarded-For`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TrustedProxy {
    /// The default: the socket peer is the client.
    Nobody,
    /// Bare `--trusted-proxy`: whatever connects is a proxy (the pre-CIDR
    /// behaviour, for a listener no client can reach directly).
    Anyone,
    /// `--trusted-proxy=<peers>`: only these peers are proxies, and the
    /// header is walked from the right past every listed hop.
    Peers(Vec<ProxyPeer>),
}

impl TrustedProxy {
    /// `None` is the flag absent; `Some("any")` the bare flag; anything else
    /// a comma-separated list of addresses or CIDR ranges.
    pub fn parse(value: Option<&str>) -> Result<TrustedProxy, String> {
        match value {
            None => Ok(TrustedProxy::Nobody),
            Some("any") => Ok(TrustedProxy::Anyone),
            Some(list) => {
                let peers = list
                    .split(',')
                    .filter(|s| !s.trim().is_empty())
                    .map(ProxyPeer::parse)
                    .collect::<Result<Vec<_>, _>>()?;
                if peers.is_empty() {
                    return Err("--trusted-proxy: name at least one address or CIDR range, or pass the bare flag to trust any peer".into());
                }
                Ok(TrustedProxy::Peers(peers))
            }
        }
    }

    fn is_proxy(&self, ip: std::net::IpAddr) -> bool {
        match self {
            TrustedProxy::Nobody => false,
            TrustedProxy::Anyone => true,
            TrustedProxy::Peers(peers) => peers.iter().any(|p| p.contains(ip)),
        }
    }

    fn announce(&self) {
        match self {
            TrustedProxy::Nobody => {}
            TrustedProxy::Anyone => tracing::info!("Trusted proxy mode: X-Forwarded-For from any peer names the client"),
            TrustedProxy::Peers(peers) => tracing::info!("Trusted proxy mode: X-Forwarded-For honoured from {} listed peer range(s)", peers.len()),
        }
    }
}

/// The client's address: the socket peer, unless that peer is a trusted
/// proxy, in which case `X-Forwarded-For` is walked from the right. With a
/// peer list every hop that is itself a listed proxy is skipped and the
/// first address that is not one is the client, so a client cannot choose
/// its identity: whatever it prepends sits left of the entry the edge
/// appended. With the bare flag the rightmost entry is the client, as it
/// always was. An entry that is not an address stops the walk at the last
/// good hop (the proxy itself when there is none).
fn extract_client_ip(
    headers: &axum::http::HeaderMap,
    socket_ip: std::net::IpAddr,
    trusted_proxy: &TrustedProxy,
) -> std::net::IpAddr {
    if !trusted_proxy.is_proxy(socket_ip) {
        return socket_ip;
    }
    let Some(xff) = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()) else {
        return socket_ip;
    };
    let mut client = socket_ip;
    for entry in xff.rsplit(',') {
        let Ok(ip) = entry.trim().parse::<std::net::IpAddr>() else { break };
        let ip = canonical_ip(ip);
        client = ip;
        if matches!(trusted_proxy, TrustedProxy::Anyone) || !trusted_proxy.is_proxy(ip) {
            break;
        }
    }
    client
}

#[cfg(test)]
mod trusted_proxy_tests {
    use super::*;
    use std::net::IpAddr;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    fn headers(xff: &str) -> axum::http::HeaderMap {
        let mut h = axum::http::HeaderMap::new();
        h.insert("x-forwarded-for", xff.parse().unwrap());
        h
    }

    #[test]
    fn flag_absent_is_the_socket_peer_whatever_the_header_says() {
        let policy = TrustedProxy::parse(None).unwrap();
        assert_eq!(extract_client_ip(&headers("1.2.3.4"), ip("10.0.0.5"), &policy), ip("10.0.0.5"));
    }

    #[test]
    fn bare_flag_keeps_the_old_rule_rightmost_entry_from_any_peer() {
        let policy = TrustedProxy::parse(Some("any")).unwrap();
        assert_eq!(policy, TrustedProxy::Anyone);
        assert_eq!(extract_client_ip(&headers("9.9.9.9, 1.2.3.4"), ip("203.0.113.7"), &policy), ip("1.2.3.4"));
        assert_eq!(extract_client_ip(&axum::http::HeaderMap::new(), ip("203.0.113.7"), &policy), ip("203.0.113.7"));
    }

    #[test]
    fn a_peer_list_trusts_only_listed_peers_and_walks_past_listed_hops() {
        let policy = TrustedProxy::parse(Some("10.0.0.5, 10.1.0.0/16,2001:db8::/32")).unwrap();
        // An unlisted peer asserting a header is the client itself.
        assert_eq!(extract_client_ip(&headers("1.2.3.4"), ip("203.0.113.7"), &policy), ip("203.0.113.7"));
        // The edge appended the client; a hop inside the listed range is skipped.
        assert_eq!(extract_client_ip(&headers("1.2.3.4, 10.1.2.3"), ip("10.0.0.5"), &policy), ip("1.2.3.4"));
        // What the client prepended sits left of the edge's entry and is ignored.
        assert_eq!(extract_client_ip(&headers("8.8.8.8, 1.2.3.4"), ip("10.0.0.5"), &policy), ip("1.2.3.4"));
        // Every entry a proxy: the leftmost proxy is what is known.
        assert_eq!(extract_client_ip(&headers("10.1.9.9"), ip("10.0.0.5"), &policy), ip("10.1.9.9"));
        // A malformed entry stops the walk at the last good hop.
        assert_eq!(extract_client_ip(&headers("unknown, 10.1.2.3"), ip("10.0.0.5"), &policy), ip("10.1.2.3"));
        // IPv6 range and an IPv4-mapped IPv6 peer on a dual-stack listener.
        assert_eq!(extract_client_ip(&headers("1.2.3.4"), ip("2001:db8:1::9"), &policy), ip("1.2.3.4"));
        assert_eq!(extract_client_ip(&headers("1.2.3.4"), ip("::ffff:10.0.0.5"), &policy), ip("1.2.3.4"));
    }

    #[test]
    fn peer_lists_are_validated() {
        assert!(TrustedProxy::parse(Some("")).is_err());
        assert!(TrustedProxy::parse(Some("10.0.0.0/33")).is_err());
        assert!(TrustedProxy::parse(Some("not-an-address")).is_err());
        assert!(TrustedProxy::parse(Some("::1/129")).is_err());
        assert_eq!(TrustedProxy::parse(Some("0.0.0.0/0")).unwrap(), TrustedProxy::Peers(vec![ProxyPeer { addr: ip("0.0.0.0"), prefix: 0 }]));
        assert!(ProxyPeer::parse("0.0.0.0/0").unwrap().contains(ip("198.51.100.1")));
        assert!(!ProxyPeer::parse("10.0.0.0/8").unwrap().contains(ip("11.0.0.1")));
        assert!(!ProxyPeer::parse("10.0.0.0/8").unwrap().contains(ip("2001:db8::1")));
    }
}

/// Resolve on Ctrl+C or, on Unix, SIGTERM — what `systemctl stop`, `docker
/// stop` and Kubernetes send. Listening for Ctrl+C alone meant a service
/// manager's stop skipped the graceful path: requests in flight were cut off
/// and sync clients got no Close frame. Then tell the WebSocket tasks.
async fn shutdown_signal(shutdown_tx: tokio::sync::watch::Sender<bool>, message: &'static str) {
    let ctrl_c = async {
        if let Err(e) = tokio::signal::ctrl_c().await {
            tracing::error!("Failed to install CTRL+C handler: {}", e);
            std::future::pending::<()>().await;
        }
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(e) => {
                tracing::error!("Failed to install SIGTERM handler: {}", e);
                std::future::pending::<()>().await;
            }
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {}
        _ = terminate => {}
    }
    tracing::info!("{}", message);
    let _ = shutdown_tx.send(true);
}

// Dropping the HTTP future (including disconnects/timeouts) prevents a worker
// still computing from committing its transaction after the caller is gone.
struct ApiCancellation(Arc<std::sync::atomic::AtomicBool>);
impl Drop for ApiCancellation {
    fn drop(&mut self) { self.0.store(true, std::sync::atomic::Ordering::Relaxed); }
}

#[cfg(test)]
mod private_api_tests {
    use super::*;

    #[tokio::test]
    async fn validates_json_and_route_limits_without_requiring_sql() {
        let runtime = crate::runtime::ServerRuntime::new(|| crate::host::BridgeSet {
            db: None, http: None, fs: None, env: None, sql: None, crypto: None,
            allow_time: false, development: true, allow_photos: false,
        }, Some(1)).unwrap();
        runtime.init("function inspect(req) { if(req.body.invalid) return {status:999,body:{}}; if(req.body.large) return {status:200,body:{a:req.body.value,b:req.body.value}}; return {status:200,body:{length:req.body.value ? req.body.value.length : 0, ip:req.client_ip}}; }".into()).unwrap();
        let invoke = |body: Vec<u8>, content_type: &'static str, input_limit: usize| {
            let mut headers = axum::http::HeaderMap::new();
            headers.insert("content-type", content_type.parse().unwrap());
            execute_api_handler(runtime.clone(), "inspect".into(), ApiRouteOptions {
                transaction: TransactionMode::None, input_limit, private_api: true, host_auth: false, client_ip: true, poll: false, upload: false,
            }, "127.0.0.1".parse().unwrap(), axum::http::Method::POST,
                "/api/attachments".parse().unwrap(), headers,
                axum::extract::Query(HashMap::new()), body.into())
        };
        assert_eq!(invoke(b"{}".to_vec(), "text/plain", 100).await.0, StatusCode::UNSUPPORTED_MEDIA_TYPE);
        for invalid in [b"[]".as_slice(), b"null", b"{bad", &[0xff]] {
            assert_eq!(invoke(invalid.to_vec(), "application/json", 100).await.0, StatusCode::BAD_REQUEST);
        }
        let body = serde_json::to_vec(&serde_json::json!({"value":"x".repeat(MAX_JSON_PARSE_SIZE)})).unwrap();
        assert_eq!(invoke(body.clone(), "application/json", MAX_JSON_PARSE_SIZE).await.0, StatusCode::PAYLOAD_TOO_LARGE);
        let (status, Json(value)) = invoke(body, "application/json; charset=utf-8", MAX_JSON_PARSE_SIZE + 100).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(value["length"], MAX_JSON_PARSE_SIZE);
        assert_eq!(value["ip"], "127.0.0.1");
        assert_eq!(invoke(Vec::new(), "application/json", 100).await.0, StatusCode::OK);
        assert_eq!(invoke(br#"{"invalid":true}"#.to_vec(), "application/json", 100).await.0, StatusCode::INTERNAL_SERVER_ERROR);
        let oversized = serde_json::to_vec(&serde_json::json!({"large":true,"value":"x".repeat(MAX_JSON_PARSE_SIZE / 2)})).unwrap();
        assert_eq!(invoke(oversized, "application/json", MAX_JSON_PARSE_SIZE).await.0, StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[tokio::test]
    async fn a_script_never_sees_cookies_or_the_host_token() {
        let runtime = crate::runtime::ServerRuntime::new(|| crate::host::BridgeSet {
            db: None, http: None, fs: None, env: None, sql: None, crypto: None,
            allow_time: false, development: true, allow_photos: false,
        }, Some(1)).unwrap();
        runtime.init("function headers(req) { return {status:200, body:req.headers}; }".into()).unwrap();
        let invoke = |host_auth: bool| {
            let mut headers = axum::http::HeaderMap::new();
            headers.insert("authorization", "Bearer secret".parse().unwrap());
            headers.insert("cookie", "session=abc".parse().unwrap());
            headers.insert("proxy-authorization", "Basic eA==".parse().unwrap());
            headers.insert("x-custom", "kept".parse().unwrap());
            execute_api_handler(runtime.clone(), "headers".into(), ApiRouteOptions {
                transaction: TransactionMode::None, input_limit: 100, private_api: false, host_auth, client_ip: true, poll: false, upload: false,
            }, "127.0.0.1".parse().unwrap(), axum::http::Method::GET,
                "/api/headers".parse().unwrap(), headers,
                axum::extract::Query(HashMap::new()), Vec::new().into())
        };
        let (status, Json(seen)) = invoke(true).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(seen["x-custom"], "kept");
        for withheld in ["cookie", "proxy-authorization", "authorization"] {
            assert!(seen.get(withheld).is_none(), "{withheld} reached the script: {seen}");
        }
        // On an application route the bearer is the app's own session.
        let (_, Json(seen)) = invoke(false).await;
        assert_eq!(seen["authorization"], "Bearer secret");
        assert!(seen.get("cookie").is_none());
    }
}

/// The options a test serves with: no proxy, no extra host names.
#[cfg(test)]
fn test_options(dev_mode: bool) -> ServeOptions {
    ServeOptions { dev_mode, trusted_proxy: TrustedProxy::Nobody, allowed_hosts: Vec::new() }
}

#[cfg(test)]
#[path = "http_hardening_tests.rs"]
mod hardening_tests;

#[cfg(test)]
mod sync_upgrade_tests {
    //! The `/sync` handshake, driven over a real socket against the real
    //! router: what the shipped client does (a ticket from `/sync/ticket`,
    //! then the upgrade), and what a page on another site may not do.
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn app(server: serde_json::Value) -> Arc<AppContext> {
        let root = std::env::temp_dir().join(format!("softn-sync-auth-{}", uuid::Uuid::new_v4()));
        let bundle = root.join("bundle");
        std::fs::create_dir_all(&bundle).unwrap();
        let manifest = serde_json::json!({"id":"com.example.sync","name":"SyncAuth","version":"1","config":{"server":server}});
        std::fs::write(bundle.join("manifest.json"), serde_json::to_vec(&manifest).unwrap()).unwrap();
        AppContext::load(bundle, Some(root.join("data")), Some(1), false).unwrap()
    }

    async fn serve(ctx: Arc<AppContext>, dev: bool) -> SocketAddr {
        let (conn_tx, conn_rx) = tokio::sync::mpsc::channel::<()>(1);
        std::mem::forget(conn_rx);
        let router = build_single_tenant_router(ctx, &test_options(dev), conn_tx);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(serve_router(listener, router, HEADER_READ_TIMEOUT, std::future::pending()));
        addr
    }

    /// One raw request; the status code and whatever followed the headers
    /// (the body, or the first WebSocket frame after a 101).
    async fn send(addr: SocketAddr, request: String) -> (u16, String) {
        let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut buf = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            let n = tokio::time::timeout(std::time::Duration::from_secs(5), stream.read(&mut chunk)).await.unwrap().unwrap();
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&chunk[..n]);
            let text = String::from_utf8_lossy(&buf);
            // The connection stays open (keep-alive, or a 101): stop at the
            // end of the body, or at the first frame after an upgrade.
            if let Some(end) = text.find("\r\n\r\n") {
                let head = text[..end].to_ascii_lowercase();
                let wanted = if head.starts_with("http/1.1 101") { 2 } else {
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
        let rest = text.split_once("\r\n\r\n").map(|(_, b)| b.to_string()).unwrap_or_default();
        (status, rest)
    }

    async fn upgrade(addr: SocketAddr, query: &str, origin: Option<&str>) -> (u16, String) {
        upgrade_at(addr, "/sync", query, origin).await
    }

    async fn upgrade_at(addr: SocketAddr, path: &str, query: &str, origin: Option<&str>) -> (u16, String) {
        let origin = origin.map(|o| format!("Origin: {}\r\n", o)).unwrap_or_default();
        send(addr, format!(
            "GET {}{} HTTP/1.1\r\nHost: {}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n{}\r\n",
            path, query, addr, origin)).await
    }

    async fn ticket(addr: SocketAddr, bearer: Option<&str>) -> (u16, Option<String>) {
        let auth = bearer.map(|t| format!("Authorization: Bearer {}\r\n", t)).unwrap_or_default();
        let (status, body) = send(addr, format!(
            "POST /sync/ticket HTTP/1.1\r\nHost: {}\r\n{}Content-Length: 0\r\nConnection: close\r\n\r\n", addr, auth)).await;
        let ticket = body.find('{')
            .and_then(|i| serde_json::from_str::<serde_json::Value>(&body[i..]).ok())
            .and_then(|v| v["ticket"].as_str().map(String::from));
        (status, ticket)
    }

    #[tokio::test]
    async fn a_client_with_a_token_connects_through_a_ticket() {
        let addr = serve(app(serde_json::json!({"auth_token":"s3cret","allowedOrigins":["https://app.example"]})), false).await;
        // What the client used to do: connect bare and send the token in a
        // first message. The host refuses the upgrade before any message.
        assert_eq!(upgrade(addr, "", Some("https://app.example")).await.0, 401);
        assert_eq!(ticket(addr, Some("wrong")).await.0, 401);
        let (status, issued) = ticket(addr, Some("s3cret")).await;
        assert_eq!(status, 200);
        let issued = issued.unwrap();
        let (status, frame) = upgrade(addr, &format!("?ticket={}", issued), Some("https://app.example")).await;
        assert_eq!(status, 101);
        assert!(frame.contains("auth_ok"), "the upgraded socket answers auth_ok at once: {frame:?}");
        // A ticket is spent by its first use.
        assert_eq!(upgrade(addr, &format!("?ticket={}", issued), Some("https://app.example")).await.0, 401);
    }

    #[tokio::test]
    async fn a_page_on_another_site_cannot_open_the_socket() {
        let addr = serve(app(serde_json::json!({"allowedOrigins":["https://app.example"]})), false).await;
        assert_eq!(upgrade(addr, "", Some("https://evil.example")).await.0, 403);
        assert_eq!(upgrade(addr, "", Some("null")).await.0, 403);
        // A credential does not make a foreign origin acceptable.
        let (_, issued) = ticket(addr, None).await;
        assert_eq!(upgrade(addr, &format!("?ticket={}", issued.unwrap()), Some("https://evil.example")).await.0, 403);
        // The listed origin, and the host's own, are.
        assert_eq!(upgrade(addr, "", Some("https://app.example")).await.0, 101);
        assert_eq!(upgrade(addr, "", Some(&format!("http://{}", addr))).await.0, 101);
        // No Origin: not a browser, so a credential or nothing. With no token
        // configured, a `?token=` proves nothing; a ticket does.
        assert_eq!(upgrade(addr, "", None).await.0, 401);
        assert_eq!(upgrade(addr, "?token=anything", None).await.0, 401);
        let (_, issued) = ticket(addr, None).await;
        assert_eq!(upgrade(addr, &format!("?ticket={}", issued.unwrap()), None).await.0, 101);
    }

    #[tokio::test]
    async fn a_tenant_socket_is_held_to_its_own_origins() {
        let root = std::env::temp_dir().join(format!("softn-sync-tenants-{}", uuid::Uuid::new_v4()));
        let bundle = root.join("bundles").join("tenant");
        std::fs::create_dir_all(&bundle).unwrap();
        let manifest = serde_json::json!({"id":"synctenant","name":"SyncTenant","version":"1",
            "config":{"server":{"allowedOrigins":["https://tenant.example"]}}});
        std::fs::write(bundle.join("manifest.json"), serde_json::to_vec(&manifest).unwrap()).unwrap();
        let manager = TenantManager::load(&root.join("bundles"), Some(&root.join("data")), Some(1), false).unwrap();
        let (conn_tx, conn_rx) = tokio::sync::mpsc::channel::<()>(1);
        std::mem::forget(conn_rx);
        let router = build_multi_tenant_router(manager, &test_options(false), conn_tx);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(serve_router(listener, router, HEADER_READ_TIMEOUT, std::future::pending()));
        assert_eq!(upgrade_at(addr, "/synctenant/sync", "", Some("https://evil.example")).await.0, 403);
        assert_eq!(upgrade_at(addr, "/synctenant/sync", "", None).await.0, 401);
        assert_eq!(upgrade_at(addr, "/synctenant/sync", "", Some("https://tenant.example")).await.0, 101);
        assert_eq!(upgrade_at(addr, "/synctenant/sync", "", Some(&format!("http://{}", addr))).await.0, 101);
    }

    #[tokio::test]
    async fn dev_mode_without_a_list_is_open_like_its_cors() {
        let addr = serve(app(serde_json::json!({})), true).await;
        assert_eq!(upgrade(addr, "", Some("http://localhost:5173")).await.0, 101);
    }

    #[test]
    fn origins_compare_by_scheme_host_and_port() {
        let manifest: crate::bundle::ServerManifest = serde_json::from_value(serde_json::json!({
            "name":"x","version":"1","config":{"server":{"allowedOrigins":["https://App.Example/"]}}})).unwrap();
        let policy = RequestPolicy::from_manifest(&manifest, &test_options(true));
        assert!(policy.origin_allowed("https://app.example", &[]), "a list is honoured in --dev too, case and slash aside");
        assert!(!policy.origin_allowed("https://app.example.evil", &[]));
        assert!(policy.origin_allowed("https://site.example", &["site.example:443"]));
        assert!(policy.origin_allowed("http://site.example:8080", &["SITE.example:8080"]));
        assert!(!policy.origin_allowed("http://site.example:8081", &["site.example:8080"]));
        assert!(!policy.origin_allowed("https://site.example", &["other.example"]));
        assert!(!policy.origin_allowed("file://", &[""]));
    }

    #[test]
    fn traces_never_carry_a_query() {
        assert_eq!(redacted_uri(&"/sync?token=s3cret&appVersion=1".parse().unwrap()), "/sync?<redacted>");
        assert_eq!(redacted_uri(&"/api/items".parse().unwrap()), "/api/items");
    }

    #[test]
    fn scripts_see_no_cookie_proxy_credential_or_host_token() {
        let mut headers = axum::http::HeaderMap::new();
        headers.insert("authorization", "Bearer app-session".parse().unwrap());
        headers.insert("cookie", "sid=1".parse().unwrap());
        headers.insert("proxy-authorization", "Basic eA==".parse().unwrap());
        headers.insert("x-custom", "kept".parse().unwrap());
        let app_route = script_headers(&headers, false);
        assert_eq!(app_route.get("authorization").and_then(|v| v.as_str()), Some("Bearer app-session"));
        assert_eq!(app_route.get("x-custom").and_then(|v| v.as_str()), Some("kept"));
        assert!(!app_route.contains_key("cookie") && !app_route.contains_key("proxy-authorization"));
        let host_route = script_headers(&headers, true);
        assert!(!host_route.contains_key("authorization"));
        assert!(host_route.contains_key("x-custom"));
    }
}
