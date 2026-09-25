mod app;
mod bridges;
mod bundle;
mod host;
mod http;
mod pool;
mod private_backend;
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
        /// Trust X-Forwarded-For from a reverse proxy for rate limiting and
        /// client IP attribution. `--trusted-proxy=10.0.0.5,10.1.0.0/16,::1`
        /// names the peers allowed to assert it (addresses or CIDR ranges,
        /// IPv4 and IPv6); the header is walked from the right past every
        /// listed hop to the first address that is not one. Bare
        /// `--trusted-proxy` trusts whatever connects, as before: only for a
        /// listener no client can reach directly. Without the flag every
        /// client behind a proxy shares the proxy's address.
        #[arg(long, alias = "trust-proxy", num_args = 0..=1, require_equals = true, default_missing_value = "any", value_name = "PEERS")]
        trusted_proxy: Option<String>,
        /// Host names this server answers to besides address literals and
        /// localhost, comma-separated (`--allowed-hosts=app.example,www.app.example`).
        /// A request naming any other host is refused (403) unless it comes
        /// through --trusted-proxy: that is what stops a DNS-rebinding page
        /// from reaching a server on this machine or network. The hosts of
        /// config.server.allowedOrigins are accepted too.
        #[arg(long, value_name = "HOSTS", value_delimiter = ',')]
        allowed_hosts: Vec<String>,
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
        /// Trust X-Forwarded-For: bare, from any peer; `=<peers>` for a list
        /// of addresses or CIDR ranges (see `run`).
        #[arg(long, alias = "trust-proxy", num_args = 0..=1, require_equals = true, default_missing_value = "any", value_name = "PEERS")]
        trusted_proxy: Option<String>,
        /// Host names this server answers to (see `run`).
        #[arg(long, value_name = "HOSTS", value_delimiter = ',')]
        allowed_hosts: Vec<String>,
    },
    /// Show bundle info
    Info {
        /// Path to .softn bundle
        path: PathBuf,
    },
}

/// The command-line options every serving mode shares, checked.
fn serve_options(dev: bool, trusted_proxy: Option<&str>, allowed_hosts: &[String], host: &str) -> Result<http::ServeOptions, String> {
    let options = http::ServeOptions {
        dev_mode: dev,
        trusted_proxy: http::TrustedProxy::parse(trusted_proxy)?,
        allowed_hosts: http::ServeOptions::parse_allowed_hosts(allowed_hosts)?,
    };
    let loopback = host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .parse::<std::net::IpAddr>()
        .map(|ip| ip.is_loopback())
        .unwrap_or_else(|_| host.eq_ignore_ascii_case("localhost"));
    if dev && !loopback {
        tracing::warn!(
            "--dev on {}, which is not a loopback address: every page on the network may use this server's CORS \
             and, where a bundle lists no allowedOrigins, open /sync. --dev is for a development machine.",
            host
        );
    }
    Ok(options)
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // RUST_LOG, when set, replaces the default filter (e.g. RUST_LOG=softn_server=debug).
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("softn_server=info,softn_script=info,tower_http=debug"));
    tracing_subscriber::fmt().with_env_filter(filter).init();

    let cli = Cli::parse();

    match cli.command {
        Commands::Run { path, port, host, data_dir, workers, dev, allow_all_capabilities, trusted_proxy, allowed_hosts } => {
            let options = serve_options(dev, trusted_proxy.as_deref(), &allowed_hosts, &host)?;
            // Check both CLI flag and env var for allow-all-capabilities
            let allow_all = allow_all_capabilities || std::env::var("SOFTN_ALLOW_ALL_CAPABILITIES")
                .ok()
                .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
                .unwrap_or(false);
            let ctx = app::AppContext::load(path, data_dir, workers, allow_all)?;
            http::serve(ctx, &host, port, options).await?;
        }
        Commands::ServeMulti { bundles_dir, port, host, data_dir, workers_per_tenant, dev, allow_all_capabilities, trusted_proxy, allowed_hosts } => {
            let options = serve_options(dev, trusted_proxy.as_deref(), &allowed_hosts, &host)?;
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
            http::serve_multi(manager, &host, port, options).await?;
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
