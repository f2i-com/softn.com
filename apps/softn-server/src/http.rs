use crate::app::AppContext;
use crate::bundle;
use crate::util;
use crate::ws;
use axum::extract::ws::WebSocketUpgrade;
use axum::extract::{DefaultBodyLimit, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Json};
use axum::routing::get;
use axum::Router;
use std::sync::Arc;
use tower_http::cors::{Any, CorsLayer};
use tower_http::services::ServeDir;
use tower_http::trace::TraceLayer;

pub async fn serve(ctx: Arc<AppContext>, port: u16) -> Result<(), String> {
    let shutdown_tx = ctx.shutdown.clone();
    let router = build_router(ctx);
    let addr = format!("0.0.0.0:{}", port);
    tracing::info!("Listening on http://{}", addr);

    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .map_err(|e| format!("Failed to bind: {}", e))?;

    axum::serve(listener, router)
        .with_graceful_shutdown(shutdown_signal(shutdown_tx))
        .await
        .map_err(|e| format!("Server error: {}", e))?;

    Ok(())
}

fn build_router(ctx: Arc<AppContext>) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let mut router = Router::new()
        .route("/health", get(health))
        .route("/manifest.json", get(serve_manifest))
        .route("/sync", get(ws_upgrade));

    // Explicit body limit for API routes (2MB default).
    // Configurable via manifest config.server.maxBodySize if needed.
    // Cap at 256MB to prevent unreasonable values from exhausting memory.
    const MAX_BODY_CEILING: u64 = 256 * 1024 * 1024;
    let max_body = ctx.manifest.config.as_ref()
        .and_then(|c| c.get("server"))
        .and_then(|s| s.get("maxBodySize"))
        .and_then(|v| v.as_u64())
        .map(|n| n.min(MAX_BODY_CEILING))
        .unwrap_or(2 * 1024 * 1024) as usize;

    // Register custom API routes from manifest
    if let Some(server) = &ctx.manifest.server {
        if let Some(routes) = &server.routes {
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
                if path == "/health" || path == "/manifest.json" || path == "/sync" {
                    tracing::warn!("Skipping route {} {} -> {}: conflicts with built-in route", method, path, handler_name);
                    continue;
                }
                // Reject paths with Axum wildcards (*), path params (:param),
                // or braces ({param}) to prevent router collisions.
                if path.contains('*') || path.contains(':') || path.contains('{') || path.contains('}') {
                    tracing::warn!("Skipping route {} {} -> {}: wildcards and path params are not allowed", method, path, handler_name);
                    continue;
                }

                tracing::info!("Registering route: {} {} -> {}", method, path, handler_name);

                // All methods use the same extractor pattern
                let make_handler = |name: String| {
                    move |
                        State(ctx): State<Arc<AppContext>>,
                        method: axum::http::Method,
                        uri: axum::http::Uri,
                        headers: axum::http::HeaderMap,
                        query: axum::extract::Query<std::collections::HashMap<String, String>>,
                        body: axum::body::Bytes,
                    | {
                        api_handler(ctx, name, method, uri, headers, query, body)
                    }
                };

                match method.as_str() {
                    "GET" => {
                        router = router.route(&path, get(make_handler(handler_name.clone())));
                    }
                    "POST" => {
                        router = router.route(&path, axum::routing::post(make_handler(handler_name.clone())));
                    }
                    "PUT" => {
                        router = router.route(&path, axum::routing::put(make_handler(handler_name.clone())));
                    }
                    "DELETE" => {
                        router = router.route(&path, axum::routing::delete(make_handler(handler_name.clone())));
                    }
                    "PATCH" => {
                        router = router.route(&path, axum::routing::patch(make_handler(handler_name.clone())));
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

async fn ws_upgrade(
    ws: WebSocketUpgrade,
    State(ctx): State<Arc<AppContext>>,
) -> impl IntoResponse {
    let sync = ctx.sync_manager.clone();
    let shutdown_rx = ctx.shutdown.subscribe();
    ws.max_message_size(MAX_WS_MESSAGE_SIZE)
        .on_upgrade(move |socket| ws::handle_ws(socket, sync, shutdown_rx))
}

async fn api_handler(
    ctx: Arc<AppContext>,
    handler_name: String,
    method: axum::http::Method,
    uri: axum::http::Uri,
    headers: axum::http::HeaderMap,
    query: axum::extract::Query<std::collections::HashMap<String, String>>,
    body: axum::body::Bytes,
) -> impl IntoResponse {
    let runtime = match &ctx.runtime {
        Some(r) => r.clone(),
        None => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(serde_json::json!({"error": "Runtime not available"})),
            );
        }
    };

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
    // JSON parsing can be CPU-intensive for large payloads (up to 10MB), and
    // running it on the reactor would block all async I/O (WebSocket pings,
    // health checks, etc.) causing severe latency spikes.
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        tokio::task::spawn_blocking(move || {
            // Parse body off the reactor (can be CPU-intensive for large JSON).
            // Cap at 10MB — serde_json::Value can use 5-10x the input size in RAM.
            // Also enforces depth limit to prevent stack overflow from nested payloads.
            const MAX_JSON_PARSE_SIZE: usize = 10 * 1024 * 1024;
            let body_json = if body.is_empty() {
                serde_json::Value::Null
            } else if body.len() > MAX_JSON_PARSE_SIZE {
                serde_json::json!({ "__oversized": true, "size": body.len() })
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
