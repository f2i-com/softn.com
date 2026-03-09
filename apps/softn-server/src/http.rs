use crate::app::AppContext;
use crate::bundle;
use crate::ws;
use axum::extract::ws::WebSocketUpgrade;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Json};
use axum::routing::get;
use axum::Router;
use std::sync::Arc;
use tower_http::cors::{Any, CorsLayer};
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

    // Register custom API routes from manifest
    if let Some(server) = &ctx.manifest.server {
        if let Some(routes) = &server.routes {
            for route in routes {
                let handler_name = route.handler.clone();
                let method = route.method.to_uppercase();
                let path = route.path.clone();

                tracing::info!("Registering route: {} {} -> {}", method, path, handler_name);

                match method.as_str() {
                    "GET" => {
                        let name = handler_name.clone();
                        router = router.route(
                            &path,
                            get(move |State(ctx): State<Arc<AppContext>>, query: axum::extract::Query<std::collections::HashMap<String, String>>, body: String| {
                                api_handler(ctx, name, query, body)
                            }),
                        );
                    }
                    "POST" => {
                        let name = handler_name.clone();
                        router = router.route(
                            &path,
                            axum::routing::post(
                                move |State(ctx): State<Arc<AppContext>>, query: axum::extract::Query<std::collections::HashMap<String, String>>, body: String| {
                                    api_handler(ctx, name, query, body)
                                },
                            ),
                        );
                    }
                    "PUT" => {
                        let name = handler_name.clone();
                        router = router.route(
                            &path,
                            axum::routing::put(
                                move |State(ctx): State<Arc<AppContext>>, query: axum::extract::Query<std::collections::HashMap<String, String>>, body: String| {
                                    api_handler(ctx, name, query, body)
                                },
                            ),
                        );
                    }
                    "DELETE" => {
                        let name = handler_name.clone();
                        router = router.route(
                            &path,
                            axum::routing::delete(
                                move |State(ctx): State<Arc<AppContext>>, query: axum::extract::Query<std::collections::HashMap<String, String>>, body: String| {
                                    api_handler(ctx, name, query, body)
                                },
                            ),
                        );
                    }
                    "PATCH" => {
                        let name = handler_name.clone();
                        router = router.route(
                            &path,
                            axum::routing::patch(
                                move |State(ctx): State<Arc<AppContext>>, query: axum::extract::Query<std::collections::HashMap<String, String>>, body: String| {
                                    api_handler(ctx, name, query, body)
                                },
                            ),
                        );
                    }
                    _ => {
                        tracing::warn!("Unsupported method: {}", method);
                    }
                }
            }
        }
    }

    router
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
    query: axum::extract::Query<std::collections::HashMap<String, String>>,
    body: String,
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

    // Build request object with body and query params
    let query_json = serde_json::to_value(&query.0).unwrap_or_default();
    let request = serde_json::json!({
        "body": if body.is_empty() { serde_json::Value::Null } else {
            serde_json::from_str(&body).unwrap_or(serde_json::Value::String(body.clone()))
        },
        "query": query_json,
    });

    // Run the blocking runtime.call() off the tokio reactor (30s timeout)
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
