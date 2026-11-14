//! front_proxy.rs - line export for an optional, separate SIP front proxy (the sip-front add-on).
//!
//! sip-front (a Kamailio container in its own repo) gives a FRITZ!Box ONE trunk account on
//! host port 5060 that carries every line's phone number, and registers to each engine as an
//! ordinary external SIP client using that line's default phone-number account
//! (`config::ensure_default_account`). This module only writes the file sip-front reads; the
//! engines are not involved and vowifi never calls sip-front.
//!
//! Contract (`settings.front_proxy.lines_file`, JSON, mode 0600 - it holds SIP passwords):
//!
//! ```json
//! [{"line": "1", "name": "MTS", "number": "79161234567", "enabled": true,
//!   "target": "192.168.178.44:5080", "transport": "udp",
//!   "username": "79161234567", "password": "..."}]
//! ```
//!
//! `number` is E.164 digits without `+` (sip-front renders it as `00…` for the FRITZ!Box).
//! Only lines with a default account are listed. Disabled when `lines_file` is unset.

use std::path::PathBuf;

use serde_json::{Value, json};

use crate::config::{Instance, Settings};

/// Address sip-front (host networking) reaches the engines' published SIP ports on. It must be
/// the host's LAN address, NOT 127.0.0.1: pasta shows a packet from the host's own LAN address
/// to the engine as coming from `host.containers.internal` (169.254.1.2), so Asterisk's
/// `rewrite_contact` stores an address that leads back to sip-front on the host. A packet from
/// 127.0.0.1 instead shows up as the engine's own (copied) LAN address, and MT calls would loop
/// inside the container. Verified with podman 6.1 / pasta 2026-10.
fn default_engine_host() -> String {
    crate::config::host_lan_ipv4()
}

fn expand_home(p: &str) -> PathBuf {
    match (p.strip_prefix("~/"), std::env::var_os("HOME")) {
        (Some(rest), Some(home)) => PathBuf::from(home).join(rest),
        _ => PathBuf::from(p),
    }
}

/// The configured export path, or None when the export is off.
pub fn lines_file(settings: &Settings) -> Option<PathBuf> {
    let fp = settings.front_proxy.as_ref()?;
    let p = fp
        .lines_file
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())?;
    Some(expand_home(p))
}

/// The export document for these lines (pure; see the module doc for the format).
pub fn render<'a>(settings: &Settings, instances: impl IntoIterator<Item = &'a Instance>) -> Value {
    let host = settings
        .front_proxy
        .as_ref()
        .and_then(|f| f.engine_host.as_deref())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map_or_else(default_engine_host, str::to_string);
    let mut out = Vec::new();
    for inst in instances {
        let Some(user) = inst.default_account.as_deref().filter(|u| !u.is_empty()) else {
            continue;
        };
        let sip = inst.sip();
        let Some(acct) = sip
            .external_accounts()
            .iter()
            .find(|a| a.username.trim() == user && !a.password.is_empty())
        else {
            // The user deleted the default account: nothing to route to.
            continue;
        };
        let ports = inst.ports_or_nominal();
        let port = if sip.transport() == "tls" {
            ports.sip_tls
        } else {
            ports.sip_udp
        };
        out.push(json!({
            "line": inst.id,
            "name": inst.name.clone().unwrap_or_default(),
            "number": user,
            "enabled": inst.enabled(),
            "target": format!("{host}:{port}"),
            "transport": sip.transport(),
            "username": acct.username.trim(),
            "password": acct.password,
        }));
    }
    Value::Array(out)
}

/// Write the export if enabled. Errors are logged, never fatal: sip-front is an add-on.
pub fn export<'a>(settings: &Settings, instances: impl IntoIterator<Item = &'a Instance>) {
    let Some(path) = lines_file(settings) else {
        return;
    };
    let doc = render(settings, instances);
    let n = doc.as_array().map_or(0, Vec::len);
    let text = match serde_json::to_string_pretty(&doc) {
        Ok(t) => t + "\n",
        Err(e) => {
            tracing::warn!("front proxy export: {e}");
            return;
        }
    };
    // Unchanged content: don't touch the file (sip-front reloads on every change).
    if std::fs::read_to_string(&path).is_ok_and(|old| old == text) {
        return;
    }
    match crate::config::write_atomic(&path, text.as_bytes(), 0o600) {
        Ok(()) => tracing::info!("front proxy: exported {n} line(s) to {}", path.display()),
        Err(e) => tracing::warn!("front proxy export to {} failed: {e:#}", path.display()),
    }
}
