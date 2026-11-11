//! vowifi-control - VoWiFi gateway control plane (manager + WebUI server).
//!
//! Serves the management REST API, the /ws live feed and the built WebUI over HTTPS, runs the
//! card monitor and status poller, and drives one engine container per SIM through the user's
//! rootless Podman (engine.rs) and each engine's Asterisk AMI (ami.rs).
//!
//! Usage:
//!   vowifi-control              serve (the systemd --user unit runs this)
//!   vowifi-control logout-all   invalidate every WebUI session (rotates the session key)
//!   vowifi-control session-token
//!                               print a 2-minute WebUI session cookie value for local scripts
//!                               (install.sh); needs read access to $VOWIFI_DATA/auth.json
//!
//! Env:
//!   VOWIFI_DATA        data dir (default ./data)
//!   VOWIFI_HTTP_PORT   listen port (default settings.http_port, 8443)
//!   VOWIFI_BIND        bind address (default settings.bind, "::" = IPv6 + IPv4)
//!   VOWIFI_WEBUI       built WebUI dir (default ../webui/dist)
//!   VOWIFI_ADVERTISE_ADDR, VOWIFI_MANAGER_URL, VOWIFI_ENGINE_IMAGE, VOWIFI_ENGINE_NETWORK,
//!   VOWIFI_PCSCD_DIR, VOWIFI_IKE_LOCAL_PORT_BASE, VOWIFI_DEV_MOUNTS, VOWIFI_PAM_SERVICE,
//!   DOCKER_HOST, RUST_LOG (default "info")
#![recursion_limit = "256"]

mod ami;
mod api;
mod auth;
mod card;
mod config;
mod engine;
mod estkme;
mod hub;
mod lenient;
mod lpa;
mod mcc;
mod podman;
mod push;
mod server;
mod sim;
mod status;
mod store;
mod usbreader;

use std::net::SocketAddr;
use std::time::Duration;

use anyhow::Context as _;

/// Under systemd (JOURNAL_STREAM set: stderr already IS the journal) log natively to journald,
/// so event fields become journal fields: `tracing::info!(instance = %iid, ...)` is filterable as
/// `journalctl --user -u vowifi-control INSTANCE=1`, and levels map to journal priorities. No
/// field prefix (the crate's default would make that F_INSTANCE). Anywhere else (a terminal,
/// `cargo run`), or if the journal socket is unavailable, plain text on stderr.
fn init_logging() {
    use std::io::IsTerminal;
    use tracing_subscriber::prelude::*;
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    let journald = std::env::var_os("JOURNAL_STREAM")
        .and_then(|_| tracing_journald::layer().ok())
        .map(|l| l.with_field_prefix(None).with_syslog_identifier("vowifi-control".into()));
    let registry = tracing_subscriber::registry().with(filter);
    match journald {
        Some(layer) => registry.with(layer).init(),
        None => registry
            .with(tracing_subscriber::fmt::layer()
                .with_ansi(std::io::stderr().is_terminal())
                .with_writer(std::io::stderr))
            .init(),
    }
}

fn main() -> anyhow::Result<()> {
    init_logging();
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        None | Some("serve") => {}
        Some("logout-all") => {
            auth::logout_everywhere()?;
            println!("every WebUI session was logged out");
            return Ok(());
        }
        Some("session-token") => {
            println!("{}", auth::new_session_ttl(&auth::service_user(), 120)?);
            return Ok(());
        }
        Some("-h" | "--help" | "help") => {
            println!("usage: vowifi-control [serve | logout-all | session-token]");
            return Ok(());
        }
        Some(other) => anyhow::bail!("unknown command {other:?} (usage: vowifi-control [serve | logout-all | session-token])"),
    }
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build()?;
    rt.block_on(serve())
}

async fn serve() -> anyhow::Result<()> {
    rustls::crypto::ring::default_provider().install_default()
        .map_err(|_| anyhow::anyhow!("rustls crypto provider already installed"))?;
    let settings = config::get_settings();
    let port: u16 = match std::env::var("VOWIFI_HTTP_PORT") {
        Ok(p) if !p.is_empty() => p.trim().parse().context("VOWIFI_HTTP_PORT")?,
        _ => settings.http_port,
    };
    let bind = std::env::var("VOWIFI_BIND").ok().filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| settings.bind.clone());

    store::init().context("SQLite store")?;
    let (cert, key) = server::tls_pair(&settings)?;
    let tls = axum_server::tls_rustls::RustlsConfig::from_pem_file(&cert, &key).await
        .with_context(|| format!("load TLS {} / {}", cert.display(), key.display()))?;
    let listener = server::listen_socket(&bind, port)?;
    let local = listener.local_addr()?;
    let dual = local.ip().is_ipv6() && local.ip().is_unspecified();
    let host = if local.ip().is_ipv6() { format!("[{}]", local.ip()) } else { local.ip().to_string() };
    tracing::info!("serving https://{host}:{port}{}", if dual { " (IPv6 + IPv4)" } else { "" });

    let hub = hub::Hub::new();
    let poller = tokio::spawn(hub.clone().status_poller());
    let monitor = tokio::spawn(hub.clone().card_monitor());
    let app = api::router(hub.clone());

    let handle = axum_server::Handle::new();
    let shutdown = handle.clone();
    tokio::spawn(async move {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("SIGTERM handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = term.recv() => {}
        }
        tracing::info!("shutting down");
        shutdown.graceful_shutdown(Some(Duration::from_secs(5)));
    });
    axum_server::from_tcp_rustls(listener, tls)?
        .handle(handle)
        .serve(app.into_make_service_with_connect_info::<SocketAddr>())
        .await?;
    poller.abort();
    monitor.abort();
    hub.close_all_ami().await;
    Ok(())
}

/// Read-only probes against a live install, run by hand (never touch a SIM with APDUs, never
/// create/stop containers):
///   VOWIFI_DATA=../data VOWIFI_LIVE_IID=1 cargo test live_ -- --ignored --nocapture
#[cfg(test)]
mod live_tests {
    use super::*;

    fn iid() -> String {
        std::env::var("VOWIFI_LIVE_IID").unwrap_or_else(|_| "1".into())
    }

    #[tokio::test]
    #[ignore]
    async fn live_podman_readonly() {
        let id = iid();
        println!("running: {}", engine::is_running(&id).await);
        let logs = engine::logs(&id, 3, None).await;
        println!("logs tail: {logs:?}");
        println!("exec: {:?}", engine::exec_cli(&id, "core show uptime").await);
        println!("missing container running: {}", engine::is_running("does-not-exist").await);
    }

    #[tokio::test]
    #[ignore]
    async fn live_ami_readonly() {
        let inst = config::get_instance(&iid()).expect("instance");
        let (host, port) = engine::ami_endpoint(&inst);
        let c = ami::AmiClient::new(&inst.id, &host, port, inst.ami_user(),
                                    inst.ami_secret.as_deref().unwrap_or(""), &inst.realm(), inst.msisdn());
        c.connect().await;
        println!("connected: {}", c.connected());
        println!("registration: {}", c.registration_state().await);
        println!("reginfo: {:?}", c.reginfo_state().await);
        println!("pau: {:?}", c.db_get("volte", "pau").await);
        let st = status::compute(&inst, Some(&c)).await;
        println!("status: {}", serde_json::to_string(&st).unwrap());
        c.close().await;
    }

    #[tokio::test]
    #[ignore]
    async fn live_pcsc_readonly() {
        println!("readers: {:?}", card::list_readers());
        println!("states: {:?}", card::reader_states());
        println!("ports: {:?}", usbreader::reader_port_paths());
        let t = std::time::Instant::now();
        card::wait_for_change(std::time::Duration::from_millis(1500));
        println!("wait_for_change returned after {:?}", t.elapsed());
    }
}
