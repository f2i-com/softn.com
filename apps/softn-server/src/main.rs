mod app;
mod bridges;
mod bundle;
mod http;
mod pool;
mod runtime;
mod sync;
mod tenant;
mod util;
mod ws;

use clap::{Parser, Subcommand};
use std::path::PathBuf;

#[derive(Parser)]
#[command(name = "softn-server", about = "SoftN application server")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Run a single .softn bundle (single-tenant mode)
    Run {
        /// Path to .softn bundle (directory or ZIP)
        path: PathBuf,
        /// Port to listen on
        #[arg(short, long, default_value = "3000")]
        port: u16,
        /// Host address to bind to (default: 127.0.0.1 for safety;
        /// use 0.0.0.0 to expose to the network)
        #[arg(long, default_value = "127.0.0.1")]
        host: String,
        /// Data directory for XDB and files
        #[arg(long)]
        data_dir: Option<PathBuf>,
        /// Number of script worker threads (default: auto-detect based on CPU count)
        #[arg(long)]
        workers: Option<usize>,
        /// Development mode: permissive CORS (allow all origins) when no
        /// allowedOrigins are configured. Without this flag, missing
        /// allowedOrigins defaults to rejecting cross-origin requests.
        #[arg(long)]
        dev: bool,
        /// Allow all script capabilities (http, fs) even when the bundle's
        /// manifest.json has no server.permissions block. Only use for
        /// trusted bundles. Can also be set via SOFTN_ALLOW_ALL_CAPABILITIES=1.
        #[arg(long)]
        allow_all_capabilities: bool,
        /// Trust X-Forwarded-For header from a reverse proxy for rate limiting
        /// and client IP attribution. Enable this when running behind nginx,
        /// Cloudflare, or similar. Without this, all clients behind a proxy
        /// share the proxy's IP for rate limiting.
        #[arg(long)]
        trusted_proxy: bool,
    },
    /// Run multiple .softn bundles (multi-tenant mode)
    ///
    /// Each bundle in the directory becomes a tenant, routed via URL path
    /// prefix: /<tenant-id>/... Tenant ID is the manifest `id` or `name`.
    ServeMulti {
        /// Directory containing .softn bundles (directories or ZIP files)
        bundles_dir: PathBuf,
        /// Port to listen on
        #[arg(short, long, default_value = "3000")]
        port: u16,
        /// Host address to bind to
        #[arg(long, default_value = "127.0.0.1")]
        host: String,
        /// Base data directory (each tenant gets a subdirectory)
        #[arg(long)]
        data_dir: Option<PathBuf>,
        /// Worker threads per tenant (default: 4)
        #[arg(long)]
        workers_per_tenant: Option<usize>,
        /// Development mode: permissive CORS
        #[arg(long)]
        dev: bool,
        /// Allow all script capabilities (http, fs) for ALL tenants.
        /// WARNING: This elevates privileges for every hosted bundle.
        /// Do NOT use when hosting untrusted bundles alongside trusted ones.
        /// Can also be set via SOFTN_ALLOW_ALL_CAPABILITIES=1.
        #[arg(long)]
        allow_all_capabilities: bool,
        /// Trust X-Forwarded-For header
        #[arg(long)]
        trusted_proxy: bool,
    },
    /// Show bundle info
    Info {
        /// Path to .softn bundle
        path: PathBuf,
    },
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter("softn_server=info,softn_script=info,tower_http=debug")
        .init();

    let cli = Cli::parse();

    match cli.command {
        Commands::Run { path, port, host, data_dir, workers, dev, allow_all_capabilities, trusted_proxy } => {
            // Check both CLI flag and env var for allow-all-capabilities
            let allow_all = allow_all_capabilities || std::env::var("SOFTN_ALLOW_ALL_CAPABILITIES")
                .ok()
                .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
                .unwrap_or(false);
            let ctx = app::AppContext::load(path, data_dir, workers, allow_all)?;
            http::serve(ctx, &host, port, dev, trusted_proxy).await?;
        }
        Commands::ServeMulti { bundles_dir, port, host, data_dir, workers_per_tenant, dev, allow_all_capabilities, trusted_proxy } => {
            let allow_all = allow_all_capabilities || std::env::var("SOFTN_ALLOW_ALL_CAPABILITIES")
                .ok()
                .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
                .unwrap_or(false);
            let manager = tenant::TenantManager::load(
                &bundles_dir,
                data_dir.as_deref(),
                workers_per_tenant,
                allow_all,
            )?;
            http::serve_multi(manager, &host, port, dev, trusted_proxy).await?;
        }
        Commands::Info { path } => {
            let manifest = bundle::load_manifest(&path)?;
            println!("Name: {}", manifest.name);
            println!("Version: {}", manifest.version);
            if let Some(server) = &manifest.server {
                println!("Server entry: {}", server.entry.as_deref().unwrap_or("server/main.logic"));
                if let Some(routes) = &server.routes {
                    println!("Routes:");
                    for r in routes {
                        println!("  {} {} -> {}", r.method, r.path, r.handler);
                    }
                }
            }
        }
    }

    Ok(())
}
