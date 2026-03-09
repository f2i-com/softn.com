use crate::app::AppContext;
use crate::bundle;
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
    let router = build_router(ctx);
    let addr = format!("0.0.0.0:{}", port);
    tracing::info!("Listening on http://{}", addr);

    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .map_err(|e| format!("Failed to bind: {}", e))?;

    axum::serve(listener, router)
        .with_graceful_shutdown(shutdown_signal())
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
    let max_body = ctx.manifest.config.as_ref()
        .and_then(|c| c.get("server"))
        .and_then(|s| s.get("maxBodySize"))
        .and_then(|v| v.as_u64())
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
                // Reject paths with Axum wildcards (*) or path params (:param)
                // to prevent router collisions and unexpected capture behavior.
                if path.contains('*') || path.contains(':') {
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

    // Serve client bundle files via tower-http ServeDir.
    // This handles ETag, Last-Modified, and correct MIME types automatically.
    // We wrap it in a security filter that blocks server/ and data/ paths.
    let bundle_path = ctx.bundle_path.clone();
    let serve_dir = ServeDir::new(&bundle_path);

    // Use a fallback handler that validates paths before delegating to ServeDir
    let bundle_path_for_fallback = bundle_path.clone();
    router = router.fallback(move |req: axum::extract::Request| {
        let serve_dir = serve_dir.clone();
        let bundle_path = bundle_path_for_fallback.clone();
        async move {
            let path = req.uri().path().trim_start_matches('/');

            // Security: reject path traversal (both literal and URL-decoded).
            // percent_decode handles %2e%2e%2f → ../
            let decoded = decode_uri_path(path);
            if decoded.contains("..") || path.contains("..")
                || decoded.contains('\0') {
                return (StatusCode::FORBIDDEN, "Forbidden").into_response();
            }

            // Blacklist: never serve server-side or data files.
            let normalized = decoded.replace('\\', "/");
            if normalized.starts_with("server/") || normalized.starts_with("data/") {
                return (StatusCode::FORBIDDEN, "Forbidden").into_response();
            }

            // Whitelist: file must be in an allowed directory AND have an allowed extension
            let in_allowed_dir = ALLOWED_PREFIXES.iter().any(|p| path.starts_with(p));
            let has_allowed_ext = path.rsplit('.').next()
                .map(|ext| {
                    let lower = ext.to_ascii_lowercase();
                    ALLOWED_EXTENSIONS.iter().any(|a| *a == lower)
                })
                .unwrap_or(false);

            if !in_allowed_dir || !has_allowed_ext {
                return StatusCode::NOT_FOUND.into_response();
            }

            // Extra safety: verify the resolved path stays within the bundle
            let file_path = bundle_path.join(path);
            if file_path.exists() {
                if let (Ok(canonical), Ok(canonical_bundle)) = (
                    std::fs::canonicalize(&file_path),
                    std::fs::canonicalize(&bundle_path),
                ) {
                    if !canonical.starts_with(&canonical_bundle) {
                        return (StatusCode::FORBIDDEN, "Forbidden").into_response();
                    }
                }
            }

            // Delegate to ServeDir for proper ETag, Last-Modified, Content-Type
            use tower::ServiceExt;
            match serve_dir.oneshot(req).await {
                Ok(resp) => resp.into_response(),
                Err(e) => {
                    tracing::error!("Static file serving error: {}", e);
                    StatusCode::INTERNAL_SERVER_ERROR.into_response()
                }
            }
        }
    });

    router
        .layer(DefaultBodyLimit::max(max_body))
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .with_state(ctx)
}

/// Decode percent-encoded path segments for security validation.
/// Uses the `percent-encoding` crate for correct handling of malformed
/// UTF-8, null bytes, and other edge cases that manual parsers can miss.
fn decode_uri_path(s: &str) -> String {
    percent_encoding::percent_decode_str(s)
        .decode_utf8_lossy()
        .into_owned()
}

async fn health() -> &'static str {
    "ok"
}

async fn serve_manifest(State(ctx): State<Arc<AppContext>>) -> Json<serde_json::Value> {
    Json(bundle::client_manifest(&ctx.manifest))
}

async fn ws_upgrade(
    ws: WebSocketUpgrade,
    State(ctx): State<Arc<AppContext>>,
) -> impl IntoResponse {
    let sync = ctx.sync_manager.clone();
    ws.on_upgrade(move |socket| ws::handle_ws(socket, sync))
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

    // Build headers map (only include safe, non-binary headers)
    let headers_json: serde_json::Map<String, serde_json::Value> = headers
        .iter()
        .filter_map(|(k, v)| {
            v.to_str().ok().map(|val| {
                (k.as_str().to_lowercase(), serde_json::Value::String(val.to_string()))
            })
        })
        .collect();

    // Build request object with body, query params, headers, method, and path.
    // Attempt to parse body as UTF-8 text/JSON; binary payloads get a size marker.
    let body_json = if body.is_empty() {
        serde_json::Value::Null
    } else {
        match std::str::from_utf8(&body) {
            Ok(text) => serde_json::from_str(text)
                .unwrap_or_else(|_| serde_json::Value::String(text.to_string())),
            Err(_) => {
                // Binary payload — scripts don't handle raw bytes yet
                serde_json::json!({
                    "__binary": true,
                    "size": body.len(),
                })
            }
        }
    };

    let query_json = serde_json::to_value(&query.0).unwrap_or_default();
    let request = serde_json::json!({
        "method": method.as_str(),
        "path": uri.path(),
        "body": body_json,
        "query": query_json,
        "headers": headers_json,
    });

    // Run the blocking runtime.call() off the tokio reactor (30s timeout).
    // Note: if all 50 script workers are busy, this queues in the crossbeam
    // channel until a worker is free. The 30s timeout covers total wait+exec.
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        tokio::task::spawn_blocking(move || {
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
                    .unwrap_or(200) as u16;
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
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e})),
        ),
    }
}

/// Allowed client-facing directories for static file serving.
const ALLOWED_PREFIXES: &[&str] = &["ui/", "assets/", "styles/", "fonts/", "images/", "icons/"];

/// File extensions allowed to be served statically.
const ALLOWED_EXTENSIONS: &[&str] = &[
    "html", "htm", "css", "js", "mjs", "json", "ui", "logic",
    "svg", "png", "jpg", "jpeg", "gif", "webp", "ico",
    "woff", "woff2", "ttf", "otf",
    "mp3", "wav", "mp4", "webm",
    "pdf", "xml", "txt", "softn",
];

async fn shutdown_signal() {
    match tokio::signal::ctrl_c().await {
        Ok(()) => tracing::info!("Shutting down..."),
        Err(e) => {
            tracing::error!("Failed to install CTRL+C handler: {}", e);
            // Don't return — keep the server running rather than shutting down immediately
            std::future::pending::<()>().await;
        }
    }
}
