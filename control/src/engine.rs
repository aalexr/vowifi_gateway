//! engine.rs - Per-SIM engine container lifecycle against the user's ROOTLESS Podman.
//!
//! Each instance runs one `localhost/vowifi/engine` container that owns its ePDG tunnel and
//! Asterisk. The manager renders instance.json, (re)creates the container with the right
//! mounts/caps/ports, and reads the engine's status files from the bind-mounted run dir
//! (swu_status.json {state: CONNECTED} = tunnel up, pin_status.json, usim_status.json, pcscf).
//!
//! Rootless specifics (engines live in this user's user namespace, on pasta networking):
//!   * NET_ADMIN/NET_RAW, /dev/net/tun (ipsec0), routes and net.* sysctls act on the engine's
//!     OWN network namespace — no host root involved.
//!   * pasta is an L4 proxy: published ports keep the client's source address (SIP needs it),
//!     but PMTU discovery inside never sees the real path, so the container MTU is pinned to
//!     the host's default-route NIC (swu_ike's outer-MTU sensing keeps working).
//!   * SWU_FORCE_NATT=1: pasta forwards only TCP/UDP/ICMP, never raw ESP (IP proto 50).
//!   * SWU_IKE_LOCAL_PORT / SWU_NATT_LOCAL_PORT: unprivileged per-engine IKE source ports
//!     (pasta drops source ports < 1024, and engines would collide on host 4500).
//!   * no container IP: AMI is the published host port on loopback (manager.conf permits it).
//!
//! PC/SC: engines are pcscd CLIENTS of the host pcscd socket (/run/pcscd); the engine image's
//! pcsc-lite is pinned to the host's version (Containerfile PCSC_VERSION == install.sh).
use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

use crate::config::{self, Instance, Settings};
use crate::podman::{Podman, PodmanError};

fn podman() -> Podman {
    Podman::from_env()
}

fn image() -> String {
    std::env::var("VOWIFI_ENGINE_IMAGE").ok().filter(|s| !s.is_empty())
        .unwrap_or_else(|| "localhost/vowifi/engine".into())
}

fn pcscd_dir() -> String {
    std::env::var("VOWIFI_PCSCD_DIR").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/run/pcscd".into())
}

pub fn container_name(iid: &str) -> String {
    format!("vowifi-engine-{iid}")
}

/// MTU of the host's default-route interface (lowest metric), 0 if unknown. Handed to pasta so
/// the container NIC reports the real uplink MTU (a WireGuard/1420 default route included).
fn host_uplink_mtu() -> u32 {
    let Ok(routes) = std::fs::read_to_string("/proc/net/route") else { return 0 };
    let best = routes.lines().skip(1)
        .filter_map(|l| {
            let p: Vec<&str> = l.split_whitespace().collect();
            (p.len() >= 7 && p[1] == "00000000").then(|| (p[6].parse::<u64>().ok(), p[0].to_string()))
        })
        .filter_map(|(m, n)| m.map(|m| (m, n)))
        .min_by_key(|(m, _)| *m);
    best.and_then(|(_, iface)| std::fs::read_to_string(format!("/sys/class/net/{iface}/mtu")).ok())
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0)
}

/// pasta, MTU pinned to the host uplink. VOWIFI_ENGINE_NETWORK overrides.
pub fn network_mode() -> String {
    if let Ok(n) = std::env::var("VOWIFI_ENGINE_NETWORK")
        && !n.trim().is_empty() {
            return n.trim().to_string();
        }
    let mtu = host_uplink_mtu();
    if mtu >= 1280 { format!("pasta:--mtu,{mtu}") } else { "pasta".into() }
}

fn run_dir(iid: &str) -> PathBuf {
    config::instance_dir(iid).join("run")
}

fn abs(p: &Path) -> PathBuf {
    std::path::absolute(p).unwrap_or_else(|_| p.to_path_buf())
}

/// Repo checkout's engine/ dir (dev mounts): $VOWIFI_ENGINE_SRC, else ../engine next to the
/// control/ dir the binary was started from.
fn engine_src_dir() -> PathBuf {
    if let Ok(d) = std::env::var("VOWIFI_ENGINE_SRC")
        && !d.is_empty() {
            return PathBuf::from(d);
        }
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let candidate = cwd.join("..").join("engine");
    if candidate.is_dir() { abs(&candidate) } else { abs(&cwd.join("engine")) }
}

pub fn dev_mounts_enabled() -> bool {
    std::env::var("VOWIFI_DEV_MOUNTS").as_deref() == Ok("1")
}

/// (Re)create and start the engine container for an instance. Returns the container id.
pub async fn start(inst: &Instance, settings: &Settings) -> anyhow::Result<String> {
    let iid = inst.id.clone();
    config::write_instance_json(inst, settings)?;
    let base = abs(&config::instance_dir(&iid));
    std::fs::create_dir_all(base.join("run"))?;
    std::fs::create_dir_all(base.join("logs"))?;
    let ports = inst.ports_or_nominal();
    let pm = podman();
    pm.remove(&container_name(&iid)).await?;

    let mut binds = vec![
        format!("{}:/config/instance.json:ro", base.join("instance.json").display()),
        format!("{}:/logs:rw", base.join("logs").display()),
        format!("{}:/run/vowifi:rw", base.join("run").display()),
        format!("{}:/run/pcscd:rw", pcscd_dir()),
    ];
    // TLS cert for the local SIP-TLS / WebRTC (WSS 8089) transport: the configured pair, else
    // the control plane's own self-signed one, so Asterisk can always bind 8089 (without it the
    // browser softphone can't connect).
    let pair = settings.tls.configured_pair().map(|(c, k)| (abs(&c), abs(&k))).or_else(|| {
        let crt = abs(&config::data_dir().join("certs").join("self-signed.crt"));
        let key = abs(&config::data_dir().join("certs").join("self-signed.key"));
        (crt.exists() && key.exists()).then_some((crt, key))
    });
    match pair {
        Some((crt, key)) => {
            binds.push(format!("{}:/etc/asterisk/certificate.crt:ro", crt.display()));
            binds.push(format!("{}:/etc/asterisk/certificate.key:ro", key.display()));
        }
        None => tracing::warn!(instance = %iid, "no TLS cert available for engine {iid} WSS/8089 — the browser softphone \
                                will not connect until a cert exists"),
    }
    if dev_mounts_enabled() {
        let eng = engine_src_dir();
        for f in ["pin_keeper.py", "ami_usim.py", "render.py", "notify.py", "swu_ike.py"] {
            binds.push(format!("{}:/usr/local/bin/{f}:ro", eng.join(f).display()));
        }
        binds.push(format!("{}:/entrypoint.sh:ro", eng.join("entrypoint.sh").display()));
        binds.push(format!("{}:/opt/vowifi/templates:ro", eng.join("templates").display()));
    }

    let mut port_bindings = Map::new();
    let mut exposed = Map::new();
    let mut bind_port = |container: String, host_ip: &str, host_port: u32| {
        exposed.insert(container.clone(), json!({}));
        port_bindings.insert(container, json!([{"HostIp": host_ip, "HostPort": host_port.to_string()}]));
    };
    bind_port("5060/udp".into(), "", ports.sip_udp);
    bind_port("5061/tcp".into(), "", ports.sip_tls);
    bind_port("8089/tcp".into(), "", ports.webrtc);
    // AMI on host loopback only: the manager is its sole client.
    bind_port("5038/tcp".into(), "127.0.0.1", ports.ami);
    for p in ports.rtp_start..ports.rtp_start + config::RTP_SPAN {
        bind_port(format!("{p}/udp"), "", p);
    }

    // pasta maps each container source port to the same host port and drops privileged ones,
    // so every engine gets its own unprivileged IKE / NAT-T pair: 45000+2k / 45001+2k with k =
    // the instance's persistent, unique `index` (not the SIP port: a manual SIP port could map
    // two lines to one pair).
    let k = inst.index.unwrap_or(0).max(0) as u32;
    let ike_base: u32 = std::env::var("VOWIFI_IKE_LOCAL_PORT_BASE").ok()
        .and_then(|s| s.parse().ok()).unwrap_or(45000);
    let env = vec![
        format!("VOWIFI_ID={iid}"),
        "SWU_FORCE_NATT=1".to_string(),
        format!("SWU_IKE_LOCAL_PORT={}", ike_base + 2 * k),
        format!("SWU_NATT_LOCAL_PORT={}", ike_base + 2 * k + 1),
    ];
    let network = network_mode();
    let spec = json!({
        "Image": image(),
        "Env": env,
        "ExposedPorts": exposed,
        "HostConfig": {
            "Binds": binds,
            // Capabilities inside the engine's own user + network namespace (not on the host).
            // NET_RAW: swu_ike's raw ESP socket. Podman's default set omits NET_RAW, MKNOD and
            // AUDIT_WRITE (Docker granted them), so they're added explicitly.
            "CapAdd": ["NET_ADMIN", "NET_RAW", "MKNOD", "AUDIT_WRITE"],
            "Devices": [{"PathOnHost": "/dev/net/tun", "PathInContainer": "/dev/net/tun",
                         "CgroupPermissions": "rwm"}],
            "NetworkMode": network,
            "PortBindings": port_bindings,
            // "always": the user's podman-restart.service only revives "always" containers;
            // stop() removes the container, so a user stop is never undone.
            "RestartPolicy": {"Name": "always", "MaximumRetryCount": 0},
            // The pcscd socket + data mounts carry host SELinux labels a confined container
            // can't use.
            "SecurityOpt": ["label=disable"],
            // No SLAAC on the tunnel: the PGW's RA on ipsec0 would make the kernel invent a
            // second /64 address and prefer it as the SIP source over the ePDG-assigned
            // INTERNAL_IP6_ADDRESS; strict P-CSCFs (MTS RU) answer "403 User not registered".
            // /proc/sys is read-only inside, so it must be set at creation.
            "Sysctls": {"net.ipv6.conf.default.autoconf": "0"},
        },
    });
    let id = pm.run(&container_name(&iid), &spec).await?;
    tracing::info!(instance = %iid, "started engine container {} (network {network})", container_name(&iid));
    Ok(id)
}

/// Remove the engine container. Ok(false) if there was none.
pub async fn stop(iid: &str) -> anyhow::Result<bool> {
    Ok(podman().remove(&container_name(iid)).await?)
}

pub async fn is_running(iid: &str) -> bool {
    matches!(podman().status(&container_name(iid)).await.as_deref(), Ok("running"))
}

/// (host, port) of an instance's AMI: its published loopback port.
pub fn ami_endpoint(inst: &Instance) -> (String, u16) {
    ("127.0.0.1".into(), u16::try_from(inst.ports_or_nominal().ami).unwrap_or(5038))
}

pub fn read_run_json(iid: &str, name: &str) -> Option<Value> {
    let text = std::fs::read_to_string(run_dir(iid).join(name)).ok()?;
    serde_json::from_str(&text).ok()
}

pub fn read_pcscf(iid: &str) -> Option<String> {
    let v = std::fs::read_to_string(run_dir(iid).join("pcscf")).ok()?;
    let v = v.trim();
    (!v.is_empty()).then(|| v.to_string())
}

/// SWu tunnel up: swu_ike writes run/swu_status.json {state: CONNECTED}.
pub fn tunnel_installed(iid: &str) -> bool {
    read_run_json(iid, "swu_status.json")
        .and_then(|v| v.get("state").and_then(Value::as_str).map(|s| s == "CONNECTED"))
        .unwrap_or(false)
}

pub async fn exec_cli(iid: &str, command: &str) -> String {
    match podman().exec(&container_name(iid), &["asterisk", "-rx", command]).await {
        Ok(out) => out,
        Err(e) => format!("error: {}", err_text(&e)),
    }
}

pub async fn logs(iid: &str, tail: usize, since: Option<i64>) -> String {
    match podman().logs(&container_name(iid), tail, since).await {
        Ok(out) => out,
        Err(e) => format!("error: {}", err_text(&e)),
    }
}

fn err_text(e: &PodmanError) -> String {
    e.to_string()
}

/// Last `tail` lines of a text file in the instance run dir ("" if missing).
pub fn run_text_tail(iid: &str, name: &str, tail: usize) -> String {
    let Ok(bytes) = std::fs::read(run_dir(iid).join(name)) else { return String::new() };
    let text = String::from_utf8_lossy(&bytes);
    let lines: Vec<&str> = text.split_inclusive('\n').collect();
    lines[lines.len().saturating_sub(tail)..].concat()
}

/// Recent SWu tunnel (IKE) log lines. Named charon.log for WebUI compatibility.
pub fn charon_log(iid: &str, tail: usize) -> String {
    run_text_tail(iid, "charon.log", tail)
}

pub fn usim_status(iid: &str) -> Value {
    read_run_json(iid, "usim_status.json").unwrap_or_else(|| json!({}))
}
