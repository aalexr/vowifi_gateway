//! auth.rs - WebUI login with the host's Linux account (PAM), signed session cookies, throttle.
//!
//! Contract (unchanged from the Python manager, so existing sessions stay valid across the
//! switch):
//!   * Login = the Linux user the manager runs as (the systemd --user service owner) and that
//!     user's Linux password, checked through PAM (libpam loaded at runtime, no build-time
//!     dependency). An unprivileged process can only verify its OWN account (pam_unix hands the
//!     check to the setuid unix_chkpwd helper, which refuses other users).
//!   * PAM service: $VOWIFI_PAM_SERVICE, else the first of vowifi / system-auth / login that
//!     exists in /etc/pam.d or /usr/lib/pam.d. pam_authenticate AND pam_acct_mgmt must pass.
//!     A stack that asks more than one secret (OTP, U2F) is refused: the form has one field.
//!   * Every /api and /ws request needs a valid session cookie, from any source. Exceptions:
//!     /api/auth/* (login itself; routes there that need a session check it themselves) and
//!     /api/engine/event, which engines call and which must come from one of the host's own
//!     addresses (pasta delivers engine traffic from those).
//!   * Cookie: HttpOnly, Secure, SameSite=Strict (also the CSRF defence), 30 days, value =
//!     base64url(json{exp,user}) "." base64url(HMAC-SHA256) with a random key kept in
//!     $VOWIFI_DATA/auth.json (0600). "Log out everywhere" rotates that key.
use std::collections::HashMap;
use std::ffi::{CStr, CString, c_char, c_int, c_void};
use std::fs;
use std::net::{IpAddr, Ipv6Addr, SocketAddr, UdpSocket};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use hmac::{Hmac, Mac};
use serde_json::{Value, json};
use sha2::Sha256;

use crate::config;

pub const COOKIE_NAME: &str = "vowifi_session";
pub const SESSION_TTL: u64 = 30 * 24 * 3600;
const MAX_PASSWORD_LEN: usize = 1024;

fn now() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

fn auth_path() -> PathBuf {
    config::data_dir().join("auth.json")
}

/// The only account that can log in: the one this process runs as.
pub fn service_user() -> String {
    static USER: OnceLock<String> = OnceLock::new();
    USER.get_or_init(|| {
        nix::unistd::User::from_uid(nix::unistd::geteuid())
            .ok()
            .flatten()
            .map(|u| u.name)
            .unwrap_or_default()
    })
    .clone()
}

// --------------------------------------------------------------------- session key storage
struct KeyCache {
    mtime: Option<i128>,
    secret: Option<Vec<u8>>,
}

static KEY: Mutex<KeyCache> = Mutex::new(KeyCache {
    mtime: None,
    secret: None,
});

fn rotate_locked(cache: &mut KeyCache) -> anyhow::Result<()> {
    let path = auth_path();
    fs::create_dir_all(config::data_dir())?;
    let tmp = path.with_extension("json.tmp");
    let mut secret = [0u8; 32];
    rand::fill(&mut secret);
    let body = json!({"secret": hex::encode(secret), "rotated": now() as i64}).to_string();
    {
        use std::io::Write;
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp)?;
        f.write_all(body.as_bytes())?;
    }
    fs::rename(&tmp, &path)?;
    cache.mtime = None;
    cache.secret = None;
    Ok(())
}

/// The current signing key, or None (fail closed) if auth.json is unreadable.
fn session_key() -> Option<Vec<u8>> {
    let mut cache = KEY.lock().unwrap_or_else(|e| e.into_inner());
    let path = auth_path();
    let meta = match fs::metadata(&path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            if let Err(e) = rotate_locked(&mut cache) {
                tracing::error!("cannot create {}: {e:#}", path.display());
                return None;
            }
            fs::metadata(&path).ok()?
        }
        Err(e) => {
            tracing::error!("cannot stat {}: {e}", path.display());
            return None;
        }
    };
    let mtime = meta.mtime() as i128 * 1_000_000_000 + meta.mtime_nsec() as i128;
    if cache.mtime != Some(mtime) {
        let secret = fs::read_to_string(&path)
            .ok()
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
            .and_then(|v| {
                v.get("secret")
                    .and_then(Value::as_str)
                    .and_then(|s| hex::decode(s).ok())
            })
            .filter(|s| !s.is_empty());
        if secret.is_none() {
            tracing::error!(
                "cannot read {}; no WebUI session is valid until \
                             'vowifi-control logout-all' rewrites it",
                path.display()
            );
        }
        cache.mtime = Some(mtime);
        cache.secret = secret;
    }
    cache.secret.clone()
}

pub fn logout_everywhere() -> anyhow::Result<()> {
    let mut cache = KEY.lock().unwrap_or_else(|e| e.into_inner());
    rotate_locked(&mut cache)?;
    tracing::info!("WebUI session key rotated: every session logged out");
    Ok(())
}

// ------------------------------------------------------------------------------- sessions
fn b64(b: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b)
}

fn sign(body: &str, key: &[u8]) -> Vec<u8> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("hmac accepts any key length");
    mac.update(body.as_bytes());
    mac.finalize().into_bytes().to_vec()
}

pub fn new_session(user: &str) -> anyhow::Result<String> {
    new_session_ttl(user, SESSION_TTL)
}

/// A session for `ttl` seconds (the CLI's short-lived token for local scripts).
pub fn new_session_ttl(user: &str, ttl: u64) -> anyhow::Result<String> {
    let key = session_key().ok_or_else(|| anyhow::anyhow!("session key unavailable"))?;
    let claims = json!({"exp": now() as u64 + ttl, "user": user}).to_string();
    let body = b64(claims.as_bytes());
    let sig = b64(&sign(&body, &key));
    Ok(format!("{body}.{sig}"))
}

/// The logged-in user for a valid cookie, else None.
pub fn session_user(token: Option<&str>) -> Option<String> {
    let token = token?;
    let key = session_key()?;
    let (body, sig) = token.rsplit_once('.')?;
    let sig = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(sig.trim_end_matches('='))
        .ok()?;
    let mut mac = Hmac::<Sha256>::new_from_slice(&key).ok()?;
    mac.update(body.as_bytes());
    mac.verify_slice(&sig).ok()?; // constant-time
    let claims: Value = serde_json::from_slice(
        &base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(body.trim_end_matches('='))
            .ok()?,
    )
    .ok()?;
    let exp = claims
        .get("exp")
        .and_then(|e| e.as_f64().or_else(|| e.as_str()?.parse().ok()))?;
    if exp <= now() {
        return None;
    }
    let user = claims.get("user")?.as_str()?;
    (user == service_user()).then(|| user.to_string())
}

pub fn session_valid(token: Option<&str>) -> bool {
    session_user(token).is_some()
}

pub fn status(token: Option<&str>) -> Value {
    let user = session_user(token);
    json!({"authenticated": user.is_some(), "user": user})
}

// ---------------------------------------------------------------------------- PAM (dlopen)
const PAM_SUCCESS: c_int = 0;
const PAM_CONV_ERR: c_int = 19;
const PAM_RHOST: c_int = 4;
const PAM_PROMPT_ECHO_OFF: c_int = 1;
const PAM_PROMPT_ECHO_ON: c_int = 2;

#[repr(C)]
struct PamMessage {
    msg_style: c_int,
    msg: *const c_char,
}

#[repr(C)]
struct PamResponse {
    resp: *mut c_char,
    resp_retcode: c_int,
}

type ConvFn = unsafe extern "C" fn(
    c_int,
    *mut *const PamMessage,
    *mut *mut PamResponse,
    *mut c_void,
) -> c_int;

#[repr(C)]
struct PamConv {
    conv: ConvFn,
    appdata_ptr: *mut c_void,
}

struct ConvData {
    user: CString,
    secret: CString,
    secrets_asked: u32,
}

/// PAM conversation: answers ONE echo-off prompt with the password and echo-on prompts with
/// the user name. PAM frees the response array and strings with free(), so allocate them with
/// the C allocator.
unsafe extern "C" fn conv(
    n: c_int,
    msgs: *mut *const PamMessage,
    resp: *mut *mut PamResponse,
    data: *mut c_void,
) -> c_int {
    use nix::libc;
    if n <= 0 || msgs.is_null() || resp.is_null() || data.is_null() {
        return PAM_CONV_ERR;
    }
    // SAFETY: PAM hands us `n` message pointers and the appdata pointer we registered.
    unsafe {
        let d = &mut *(data as *mut ConvData);
        let arr = libc::calloc(n as usize, std::mem::size_of::<PamResponse>()) as *mut PamResponse;
        if arr.is_null() {
            return PAM_CONV_ERR;
        }
        for i in 0..n as usize {
            let m = *msgs.add(i);
            if m.is_null() {
                continue;
            }
            match (*m).msg_style {
                PAM_PROMPT_ECHO_OFF => {
                    d.secrets_asked += 1;
                    if d.secrets_asked > 1 {
                        // A second secret (OTP...) we can't supply. Free what we built.
                        for j in 0..n as usize {
                            let r = (*arr.add(j)).resp;
                            if !r.is_null() {
                                libc::free(r as *mut c_void);
                            }
                        }
                        libc::free(arr as *mut c_void);
                        return PAM_CONV_ERR;
                    }
                    (*arr.add(i)).resp = libc::strdup(d.secret.as_ptr());
                }
                PAM_PROMPT_ECHO_ON => {
                    (*arr.add(i)).resp = libc::strdup(d.user.as_ptr());
                }
                _ => {}
            }
        }
        *resp = arr;
    }
    PAM_SUCCESS
}

pub fn pam_service() -> String {
    if let Ok(env) = std::env::var("VOWIFI_PAM_SERVICE")
        && !env.trim().is_empty()
    {
        return env.trim().to_string();
    }
    for name in ["vowifi", "system-auth", "login"] {
        if ["/etc/pam.d", "/usr/lib/pam.d"]
            .iter()
            .any(|d| std::path::Path::new(d).join(name).is_file())
        {
            return name.to_string();
        }
    }
    "login".into()
}

/// (ok, reason). Blocking (pam_unix sleeps ~2 s on failure): call from a blocking thread.
fn pam_check(user: &str, password: &str, rhost: Option<&str>) -> anyhow::Result<(bool, String)> {
    type StartFn = unsafe extern "C" fn(
        *const c_char,
        *const c_char,
        *const PamConv,
        *mut *mut c_void,
    ) -> c_int;
    type SetItemFn = unsafe extern "C" fn(*mut c_void, c_int, *const c_void) -> c_int;
    type FlagsFn = unsafe extern "C" fn(*mut c_void, c_int) -> c_int;
    type StrerrorFn = unsafe extern "C" fn(*mut c_void, c_int) -> *const c_char;

    static LIB: OnceLock<Result<libloading::Library, String>> = OnceLock::new();
    let lib = LIB
        .get_or_init(|| unsafe {
            libloading::Library::new("libpam.so.0").map_err(|e| e.to_string())
        })
        .as_ref()
        .map_err(|e| anyhow::anyhow!("libpam: {e}"))?;
    // SAFETY: symbol types match the Linux-PAM ABI (security/pam_appl.h).
    unsafe {
        let start: libloading::Symbol<StartFn> = lib.get(b"pam_start\0")?;
        let set_item: libloading::Symbol<SetItemFn> = lib.get(b"pam_set_item\0")?;
        let authenticate: libloading::Symbol<FlagsFn> = lib.get(b"pam_authenticate\0")?;
        let acct_mgmt: libloading::Symbol<FlagsFn> = lib.get(b"pam_acct_mgmt\0")?;
        let end: libloading::Symbol<FlagsFn> = lib.get(b"pam_end\0")?;
        let strerror: libloading::Symbol<StrerrorFn> = lib.get(b"pam_strerror\0")?;

        let service = pam_service();
        let c_service = CString::new(service.clone())?;
        let c_user = CString::new(user)?;
        let mut data = Box::new(ConvData {
            user: c_user.clone(),
            secret: CString::new(password)?,
            secrets_asked: 0,
        });
        let conv_s = PamConv {
            conv,
            appdata_ptr: &mut *data as *mut ConvData as *mut c_void,
        };
        let mut handle: *mut c_void = std::ptr::null_mut();
        let rc = start(c_service.as_ptr(), c_user.as_ptr(), &conv_s, &mut handle);
        if rc != PAM_SUCCESS {
            return Ok((false, format!("pam_start({service}) failed: {rc}")));
        }
        if let Some(h) = rhost
            && let Ok(c) = CString::new(h)
        {
            set_item(handle, PAM_RHOST, c.as_ptr() as *const c_void);
        }
        let mut rc = authenticate(handle, 0);
        if rc == PAM_SUCCESS {
            rc = acct_mgmt(handle, 0);
        }
        let reason_p = strerror(handle, rc);
        let reason = if reason_p.is_null() {
            String::new()
        } else {
            CStr::from_ptr(reason_p).to_string_lossy().into_owned()
        };
        end(handle, rc);
        drop(data);
        Ok((rc == PAM_SUCCESS, format!("{service}: {reason}")))
    }
}

/// True if username is this service's own Linux user and password is its Linux password.
/// Blocking.
pub fn check_login(username: &str, password: &str, rhost: Option<&str>) -> bool {
    // pam_unix is commonly `nullok`: never let an empty password through.
    if password.is_empty() || password.len() > MAX_PASSWORD_LEN || password.contains('\0') {
        return false;
    }
    let user = service_user();
    if user.is_empty() || username.trim() != user {
        std::thread::sleep(Duration::from_secs(2)); // same cost as a PAM failure
        return false;
    }
    match pam_check(&user, password, rhost) {
        Ok((true, _)) => true,
        Ok((false, reason)) => {
            tracing::info!("PAM rejected WebUI login ({reason})");
            false
        }
        Err(e) => {
            tracing::error!("PAM unavailable ({e:#}): nobody can log in to the WebUI");
            false
        }
    }
}

// ------------------------------------------------------------------------ source addresses
/// Dual-stack sockets report IPv4 clients as ::ffff:a.b.c.d; normalise to plain IPv4.
pub fn canonical_ip(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => v6
            .to_ipv4_mapped()
            .map(IpAddr::V4)
            .unwrap_or(IpAddr::V6(v6)),
        v4 => v4,
    }
}

/// True if `ip` is loopback or one of this machine's own addresses (bindable).
pub fn is_host_address(ip: Option<IpAddr>) -> bool {
    let Some(ip) = ip.map(canonical_ip) else {
        return false;
    };
    if ip.is_loopback() {
        return true;
    }
    UdpSocket::bind(SocketAddr::new(ip, 0)).is_ok()
}

// -------------------------------------------------------------------------------- throttle
/// Failed-login back-off per source. IPv6 sources are grouped by /64 (one client usually owns
/// a whole /64). 5 free failures, then the wait doubles from 2 s up to 15 min; a success
/// clears it. In memory only. pam_unix itself also delays every failure by ~2 s.
pub struct Throttle {
    fails: Mutex<Option<HashMap<String, (u32, f64)>>>,
}

impl Throttle {
    const FREE: u32 = 5;
    const BASE: f64 = 2.0;
    const CAP: f64 = 900.0;
    const FORGET: f64 = 3600.0;

    pub const fn new() -> Self {
        Throttle {
            fails: Mutex::new(None),
        }
    }

    fn key(ip: Option<IpAddr>) -> String {
        match ip.map(canonical_ip) {
            None => "None".into(),
            Some(IpAddr::V4(v4)) => v4.to_string(),
            Some(IpAddr::V6(v6)) => {
                let s = v6.segments();
                let net = Ipv6Addr::new(s[0], s[1], s[2], s[3], 0, 0, 0, 0);
                format!("{net}/64")
            }
        }
    }

    pub fn retry_after(&self, ip: Option<IpAddr>) -> u64 {
        let f = self.fails.lock().unwrap_or_else(|e| e.into_inner());
        let (n, last) = f
            .as_ref()
            .and_then(|m| m.get(&Self::key(ip)).copied())
            .unwrap_or((0, 0.0));
        if n < Self::FREE {
            return 0;
        }
        let wait =
            (Self::BASE * 2f64.powi((n - Self::FREE) as i32)).min(Self::CAP) - (now() - last);
        if wait <= 0.0 {
            0
        } else {
            (wait + 0.999) as u64
        }
    }

    pub fn fail(&self, ip: Option<IpAddr>) {
        let t = now();
        let mut guard = self.fails.lock().unwrap_or_else(|e| e.into_inner());
        let f = guard.get_or_insert_with(HashMap::new);
        f.retain(|_, (_, last)| t - *last <= Self::FORGET);
        let e = f.entry(Self::key(ip)).or_insert((0, 0.0));
        *e = (e.0 + 1, t);
    }

    pub fn ok(&self, ip: Option<IpAddr>) {
        if let Some(m) = self
            .fails
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_mut()
        {
            m.remove(&Self::key(ip));
        }
    }
}

pub static THROTTLE: Throttle = Throttle::new();

// -------------------------------------------------------------------------- request policy
pub const ENGINE_PATH: &str = "/api/engine/event";

pub fn needs_auth(path: &str) -> bool {
    if path.starts_with("/api/auth/") || path == ENGINE_PATH {
        return false;
    }
    path == "/api"
        || ["/api/", "/ws", "/docs", "/redoc", "/openapi.json"]
            .iter()
            .any(|p| path.starts_with(p))
}

/// Policy for one request (HTTP or WebSocket handshake).
pub fn allowed(path: &str, client: Option<IpAddr>, cookie: Option<&str>) -> bool {
    if path == ENGINE_PATH {
        return is_host_address(client);
    }
    if !needs_auth(path) {
        return true;
    }
    session_valid(cookie)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn policy_paths() {
        assert!(needs_auth("/api/instances"));
        assert!(needs_auth("/ws"));
        assert!(needs_auth("/api"));
        assert!(!needs_auth("/api/auth/login"));
        assert!(!needs_auth("/api/engine/event"));
        assert!(!needs_auth("/assets/index.js"));
        assert!(!needs_auth("/"));
    }

    #[test]
    fn throttle_keys() {
        let a: IpAddr = "2001:db8:1:2:aaaa::1".parse().unwrap();
        assert_eq!(Throttle::key(Some(a)), "2001:db8:1:2::/64");
        let m: IpAddr = "::ffff:192.168.1.5".parse().unwrap();
        assert_eq!(Throttle::key(Some(m)), "192.168.1.5");
    }

    #[test]
    fn host_addresses() {
        assert!(is_host_address(Some("127.0.0.1".parse().unwrap())));
        assert!(is_host_address(Some("::ffff:127.0.0.1".parse().unwrap())));
        assert!(!is_host_address(Some("203.0.113.9".parse().unwrap())));
        assert!(!is_host_address(None));
    }
}
