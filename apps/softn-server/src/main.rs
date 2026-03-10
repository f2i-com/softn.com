mod app;
mod bridges;
mod bundle;
mod http;
mod pool;
mod runtime;
mod sync;
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
    /// Run a .softn bundle
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
        Commands::Run { path, port, host, data_dir, workers } => {
            let ctx = app::AppContext::load(path, data_dir, workers)?;
            http::serve(ctx, &host, port).await?;
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
