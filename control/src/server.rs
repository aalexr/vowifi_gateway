//! server.rs - HTTPS listener: TLS material and the dual-stack socket.
//!
//! The configured cert/key (settings.tls) is used when both files exist; otherwise a
//! self-signed RSA-2048 pair is generated once under $VOWIFI_DATA/certs (CN vowifi-gateway,
//! SAN localhost + the host's IPs, 10 years). RSA rather than ECDSA because the engines mount the
//! same pair for Asterisk's SIP-TLS (5061) and WSS (8089), and older SIP clients only do RSA.
//!
//! Bind "::" (the default) is ONE dual-stack socket (IPv6 + IPv4 via v4-mapped addresses) with
//! IPV6_V6ONLY cleared explicitly, so a host with net.ipv6.bindv6only=1 still serves IPv4. Hosts
//! without IPv6 fall back to 0.0.0.0; any other value binds just that address.
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs};
use std::path::{Path, PathBuf};

use anyhow::Context as _;
use socket2::{Domain, Socket, Type};

use crate::config::{self, Settings};

pub fn tls_pair(settings: &Settings) -> anyhow::Result<(PathBuf, PathBuf)> {
    if let Some(pair) = settings.tls.configured_pair() {
        return Ok(pair);
    }
    let dir = config::data_dir().join("certs");
    let (crt, key) = (dir.join("self-signed.crt"), dir.join("self-signed.key"));
    if !(crt.exists() && key.exists()) {
        tracing::info!("generating self-signed certificate...");
        self_signed(&crt, &key)?;
    }
    Ok((crt, key))
}

fn self_signed(cert_path: &Path, key_path: &Path) -> anyhow::Result<()> {
    use rsa::pkcs1::EncodeRsaPrivateKey;
    use rsa::pkcs8::EncodePrivateKey;

    let key = rsa::RsaPrivateKey::new(&mut rand_core06::OsRng, 2048).context("RSA key generation")?;
    let pkcs8 = key.to_pkcs8_der().context("PKCS#8 encode")?;
    let der = rustls::pki_types::PrivatePkcs8KeyDer::from(pkcs8.as_bytes().to_vec());
    let kp = rcgen::KeyPair::from_pkcs8_der_and_sign_algo(&der, &rcgen::PKCS_RSA_SHA256).context("signing key")?;

    let mut params = rcgen::CertificateParams::new(vec!["localhost".to_string()])?;
    let mut dn = rcgen::DistinguishedName::new();
    dn.push(rcgen::DnType::CommonName, "vowifi-gateway");
    params.distinguished_name = dn;
    let mut ips: Vec<IpAddr> = Vec::new();
    // The host's own address (what a LAN browser/softphone connects to) ...
    if let Ok(host) = nix::unistd::gethostname() {
        let host = host.to_string_lossy().into_owned();
        if let Ok(addrs) = (host.as_str(), 0).to_socket_addrs()
            && let Some(v4) = addrs.map(|a| a.ip()).find(IpAddr::is_ipv4) {
                ips.push(v4);
            }
    }
    // ... the installer-pinned advertise address, and loopback. The 8443 WebUI and the engines'
    // 8089 WSS share this cert.
    if let Ok(adv) = std::env::var("VOWIFI_ADVERTISE_ADDR")
        && let Ok(ip) = adv.trim().parse() {
            ips.push(ip);
        }
    ips.push(IpAddr::V4(Ipv4Addr::LOCALHOST));
    for ip in ips {
        if !params.subject_alt_names.contains(&rcgen::SanType::IpAddress(ip)) {
            params.subject_alt_names.push(rcgen::SanType::IpAddress(ip));
        }
    }
    let now = time::OffsetDateTime::now_utc();
    params.not_before = now - time::Duration::days(1);
    params.not_after = now + time::Duration::days(3650);
    let mut serial = [0u8; 16];
    rand::fill(&mut serial);
    serial[0] &= 0x7f;
    params.serial_number = Some(rcgen::SerialNumber::from_slice(&serial));
    let cert = params.self_signed(&kp)?;

    std::fs::create_dir_all(cert_path.parent().unwrap_or(Path::new(".")))?;
    let key_pem = key.to_pkcs1_pem(rsa::pkcs8::LineEnding::LF).context("PKCS#1 encode")?;
    write_mode(key_path, key_pem.as_bytes(), 0o600)?;
    write_mode(cert_path, cert.pem().as_bytes(), 0o644)?;
    Ok(())
}

fn write_mode(path: &Path, data: &[u8], mode: u32) -> anyhow::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(mode).open(path)
        .with_context(|| format!("write {}", path.display()))?;
    f.write_all(data)?;
    Ok(())
}

/// The bound, listening, non-blocking TCP socket for `bind`/`port`.
pub fn listen_socket(bind: &str, port: u16) -> anyhow::Result<std::net::TcpListener> {
    let bind = bind.trim();
    let mut target = bind.to_string();
    if bind.is_empty() || bind == "::" {
        match dual_stack(port) {
            Ok(l) => return Ok(l),
            Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
                return Err(anyhow::Error::from(e).context(format!("[::]:{port} is already in use")));
            }
            Err(e) => {
                tracing::warn!("can't bind [::]:{port} ({e}); listening on IPv4 0.0.0.0 only");
                target = "0.0.0.0".into();
            }
        }
    }
    let ip: IpAddr = target.trim_matches(|c| c == '[' || c == ']').parse()
        .with_context(|| format!("bind address {target:?} is not an IP address"))?;
    let addr = SocketAddr::new(ip, port);
    let s = Socket::new(Domain::for_address(addr), Type::STREAM, None)?;
    s.set_reuse_address(true)?;
    if ip.is_ipv6() {
        s.set_only_v6(true)?;
    }
    s.bind(&addr.into()).with_context(|| format!("bind {addr}"))?;
    s.listen(1024)?;
    s.set_nonblocking(true)?;
    Ok(s.into())
}

fn dual_stack(port: u16) -> std::io::Result<std::net::TcpListener> {
    let s = Socket::new(Domain::IPV6, Type::STREAM, None)?;
    s.set_reuse_address(true)?;
    s.set_only_v6(false)?;
    s.bind(&SocketAddr::new(IpAddr::V6(Ipv6Addr::UNSPECIFIED), port).into())?;
    s.listen(1024)?;
    s.set_nonblocking(true)?;
    Ok(s.into())
}
