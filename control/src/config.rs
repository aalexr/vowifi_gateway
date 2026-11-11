//! config.rs - Persistent manager state (global settings + per-SIM instances).
//!
//! Stored as YAML at `$VOWIFI_DATA/config.yaml` (the same file and layout the Python manager
//! wrote, so an existing install is picked up unchanged). The file is re-read on every access so
//! a hand edit takes effect without a restart; writes are atomic (tmp + rename) and serialised by
//! a process-wide lock that also covers the read-modify-write of `upsert_instance`.
//!
//! Every field is decoded leniently (see lenient.rs): unknown keys are kept verbatim (`extra`),
//! odd types are coerced, and an unreadable value falls back to its default instead of failing
//! the whole load. `render_instance_json` converts an instance into the engine's
//! `/config/instance.json` contract (consumed by engine/render.py).
use std::collections::HashSet;
use std::fs;
use std::io::Write as _;
use std::net::{Ipv4Addr, SocketAddr, UdpSocket};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use anyhow::Context as _;
use base64::Engine as _;
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::lenient;
use crate::lenient_or;
use crate::mcc::mcc_to_iso2;

// ------------------------------------------------------------------------------------- paths
pub fn data_dir() -> &'static Path {
    static DIR: OnceLock<PathBuf> = OnceLock::new();
    DIR.get_or_init(|| match std::env::var("VOWIFI_DATA") {
        Ok(d) if !d.is_empty() => PathBuf::from(d),
        _ => std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")).join("data"),
    })
}

pub fn config_path() -> PathBuf {
    data_dir().join("config.yaml")
}

pub fn instance_dir(iid: &str) -> PathBuf {
    data_dir().join("instances").join(iid)
}

pub fn default_lpac_bin() -> PathBuf {
    data_dir().join("lpac").join("lpac")
}

static LOCK: Mutex<()> = Mutex::new(());

/// A user-facing validation problem (the WebUI shows the message as-is).
#[derive(Debug, thiserror::Error)]
pub enum CfgError {
    #[error("{0}")]
    Invalid(String),
    #[error(transparent)]
    Other(#[from] anyhow::Error),
}

fn invalid<T>(msg: impl Into<String>) -> Result<T, CfgError> {
    Err(CfgError::Invalid(msg.into()))
}

// ----------------------------------------------------------------------------------- settings
lenient_or!(de_http_port, u16, 8443);
lenient_or!(de_bind, String, "::".into());
lenient_or!(de_string, String, String::new());
lenient_or!(de_true, bool, true);
lenient_or!(de_false, bool, false);
lenient_or!(de_retry_max, i64, 3);
lenient_or!(de_retry_interval, i64, 30);
lenient_or!(de_rekey_minutes, i64, 30);
lenient_or!(de_ring_timeout, i64, 35);
lenient_or!(de_download_timeout, i64, 300);

/// `deserialize_with` for a nested struct: anything but an object becomes its default.
fn de_nested<'de, D, T>(d: D) -> Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::de::DeserializeOwned + Default,
{
    let v = Value::deserialize(d)?;
    Ok(match v {
        Value::Object(_) => serde_json::from_value(v).unwrap_or_default(),
        _ => T::default(),
    })
}

fn de_nested_opt<'de, D, T>(d: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::de::DeserializeOwned,
{
    let v = Value::deserialize(d)?;
    Ok(match v {
        Value::Object(_) => serde_json::from_value(v).ok(),
        _ => None,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Tls {
    #[serde(deserialize_with = "de_true")]
    pub self_signed: bool,
    #[serde(deserialize_with = "de_string")]
    pub domain: String,
    #[serde(deserialize_with = "de_string")]
    pub cert_path: String,
    #[serde(deserialize_with = "de_string")]
    pub key_path: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Default for Tls {
    fn default() -> Self {
        Tls { self_signed: true, domain: String::new(), cert_path: String::new(),
              key_path: String::new(), extra: Map::new() }
    }
}

impl Tls {
    /// The configured cert/key pair, if both files exist.
    pub fn configured_pair(&self) -> Option<(PathBuf, PathBuf)> {
        if !self.cert_path.is_empty() && !self.key_path.is_empty()
            && Path::new(&self.cert_path).exists() && Path::new(&self.key_path).exists()
        {
            Some((PathBuf::from(&self.cert_path), PathBuf::from(&self.key_path)))
        } else {
            None
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Retry {
    #[serde(deserialize_with = "de_retry_max")]
    pub max: i64,
    #[serde(deserialize_with = "de_retry_interval")]
    pub interval: i64,
    /// After a network-class freeze (ePDG/DNS/tunnel timeout), probe connectivity and
    /// re-provision automatically once the network returns. Off = sticky ERROR.
    #[serde(deserialize_with = "de_true")]
    pub auto_recover: bool,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Default for Retry {
    fn default() -> Self {
        Retry { max: 3, interval: 30, auto_recover: true, extra: Map::new() }
    }
}

/// Proactive IKEv2 CHILD-SA rekey period. IKEv2 doesn't negotiate SA lifetimes on the wire
/// (RFC 7296), so this is local policy (TS 24.302 7.2.2C). 0 = passive only.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Rekey {
    #[serde(deserialize_with = "de_rekey_minutes")]
    pub minutes: i64,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Default for Rekey {
    fn default() -> Self {
        Rekey { minutes: 30, extra: Map::new() }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct PushEvents {
    #[serde(deserialize_with = "de_true")]
    pub incoming_sms: bool,
    #[serde(deserialize_with = "de_true")]
    pub incoming_call: bool,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Default for PushEvents {
    fn default() -> Self {
        PushEvents { incoming_sms: true, incoming_call: true, extra: Map::new() }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Webhook {
    #[serde(deserialize_with = "de_false")]
    pub enabled: bool,
    #[serde(deserialize_with = "de_string")]
    pub url: String,
    #[serde(deserialize_with = "de_nested")]
    pub events: PushEvents,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Telegram {
    #[serde(deserialize_with = "de_false")]
    pub enabled: bool,
    #[serde(deserialize_with = "de_string")]
    pub bot_token: String,
    /// Chat ids are numeric; YAML may well hold them as integers.
    #[serde(deserialize_with = "de_string")]
    pub chat_id: String,
    #[serde(deserialize_with = "de_nested")]
    pub events: PushEvents,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Esim {
    /// Locally built lpac (`./install.sh build-lpac`); empty = `$VOWIFI_DATA/lpac/lpac`.
    #[serde(deserialize_with = "de_string")]
    pub lpac_bin: String,
    #[serde(deserialize_with = "de_download_timeout")]
    pub download_timeout: i64,
    #[serde(deserialize_with = "de_true")]
    pub auto_process_notifications: bool,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Default for Esim {
    fn default() -> Self {
        Esim { lpac_bin: String::new(), download_timeout: 300,
               auto_process_notifications: true, extra: Map::new() }
    }
}

impl Esim {
    pub fn lpac_bin_path(&self) -> PathBuf {
        if self.lpac_bin.trim().is_empty() {
            default_lpac_bin()
        } else {
            PathBuf::from(&self.lpac_bin)
        }
    }

    /// Seconds; 0/negative falls back to 300 (the old `int(x or 300)`).
    pub fn download_timeout_s(&self) -> u64 {
        if self.download_timeout > 0 { self.download_timeout as u64 } else { 300 }
    }
}

/// Asterisk debug is off by default: nothing in the manager reads the engine log any more, and
/// debug level floods it (AMI actions every few seconds). Turn it on to troubleshoot.
fn default_debug() -> Value {
    json!({"asterisk": false, "charon": false, "pcap": false})
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    #[serde(deserialize_with = "de_http_port")]
    pub http_port: u16,
    /// "::" = one dual-stack socket (see server.rs).
    #[serde(deserialize_with = "de_bind")]
    pub bind: String,
    #[serde(deserialize_with = "de_nested")]
    pub tls: Tls,
    /// Opaque per-component debug switches, handed to the engine as-is.
    pub debug: Value,
    /// Reachable URL engines POST events to (auto if empty).
    #[serde(deserialize_with = "de_string")]
    pub manager_url: String,
    /// Host IP/hostname advertised to LOCAL SIP/WebRTC clients (Contact + SDP). Empty =
    /// auto-detect a LAN NIC.
    #[serde(deserialize_with = "de_string")]
    pub advertise_address: String,
    #[serde(deserialize_with = "de_nested")]
    pub retry: Retry,
    #[serde(deserialize_with = "de_nested")]
    pub rekey: Rekey,
    /// Outbound ring timeout (s) before Asterisk CANCELs; most carriers roll to voicemail ~30s.
    #[serde(deserialize_with = "de_ring_timeout")]
    pub ring_timeout: i64,
    #[serde(deserialize_with = "de_nested")]
    pub webhook: Webhook,
    #[serde(deserialize_with = "de_nested")]
    pub telegram: Telegram,
    #[serde(deserialize_with = "de_nested")]
    pub esim: Esim,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            http_port: 8443,
            bind: "::".into(),
            tls: Tls::default(),
            debug: default_debug(),
            manager_url: String::new(),
            advertise_address: String::new(),
            retry: Retry::default(),
            rekey: Rekey::default(),
            ring_timeout: 35,
            webhook: Webhook::default(),
            telegram: Telegram::default(),
            esim: Esim::default(),
            extra: Map::new(),
        }
    }
}

// ---------------------------------------------------------------------------------- instances
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ports {
    pub sip_udp: u32,
    pub sip_tls: u32,
    pub webrtc: u32,
    pub ami: u32,
    pub rtp_start: u32,
    pub rtp_end: u32,
}

impl<'de> Deserialize<'de> for PortsLenient {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let v = Value::deserialize(d)?;
        let Value::Object(m) = v else { return Ok(PortsLenient(None)) };
        let base = alloc_ports(0);
        let g = |k: &str, dflt: u32| lenient::or(m.get(k), dflt);
        Ok(PortsLenient(Some(Ports {
            sip_udp: g("sip_udp", base.sip_udp),
            sip_tls: g("sip_tls", base.sip_tls),
            webrtc: g("webrtc", base.webrtc),
            ami: g("ami", base.ami),
            rtp_start: g("rtp_start", base.rtp_start),
            rtp_end: g("rtp_end", base.rtp_end),
        })))
    }
}

struct PortsLenient(Option<Ports>);

fn de_ports<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Ports>, D::Error> {
    Ok(PortsLenient::deserialize(d)?.0)
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ExternalAccount {
    #[serde(deserialize_with = "de_string")]
    pub username: String,
    #[serde(deserialize_with = "de_string")]
    pub password: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct WebRtc {
    #[serde(deserialize_with = "lenient::opt", skip_serializing_if = "Option::is_none")]
    pub enable: Option<bool>,
    #[serde(deserialize_with = "lenient::opt", skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(deserialize_with = "lenient::opt", skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

fn de_accounts<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Vec<ExternalAccount>>, D::Error> {
    let v = Value::deserialize(d)?;
    Ok(match v {
        Value::Array(items) => Some(
            items.into_iter()
                .filter(|a| a.is_object())
                .filter_map(|a| serde_json::from_value(a).ok())
                .collect(),
        ),
        _ => None,
    })
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Sip {
    #[serde(deserialize_with = "lenient::opt", skip_serializing_if = "Option::is_none")]
    pub listen_addr: Option<String>,
    #[serde(deserialize_with = "lenient::opt", skip_serializing_if = "Option::is_none")]
    pub transport: Option<String>,
    #[serde(deserialize_with = "de_accounts", skip_serializing_if = "Option::is_none")]
    pub external: Option<Vec<ExternalAccount>>,
    #[serde(deserialize_with = "de_nested_opt", skip_serializing_if = "Option::is_none")]
    pub webrtc: Option<WebRtc>,
    #[serde(deserialize_with = "lenient::opt", skip_serializing_if = "Option::is_none")]
    pub ring_timeout: Option<i64>,
    #[serde(deserialize_with = "lenient::opt", skip_serializing_if = "Option::is_none")]
    pub user_agent: Option<String>,
    /// Raw P-Access-Network-Info override; when set the pani_* knobs are ignored.
    #[serde(deserialize_with = "lenient::opt", skip_serializing_if = "Option::is_none")]
    pub pani: Option<String>,
    #[serde(deserialize_with = "lenient::opt", skip_serializing_if = "Option::is_none")]
    pub pani_access_type: Option<String>,
    #[serde(deserialize_with = "lenient::opt", skip_serializing_if = "Option::is_none")]
    pub pani_country_enable: Option<bool>,
    #[serde(deserialize_with = "lenient::opt", skip_serializing_if = "Option::is_none")]
    pub pani_country: Option<String>,
    #[serde(deserialize_with = "lenient::opt", skip_serializing_if = "Option::is_none")]
    pub pani_node_id_enable: Option<bool>,
    #[serde(deserialize_with = "lenient::opt", skip_serializing_if = "Option::is_none")]
    pub pani_node_id: Option<String>,
    #[serde(deserialize_with = "lenient::opt", skip_serializing_if = "Option::is_none")]
    pub pani_local_time_zone: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Sip {
    pub fn external_accounts(&self) -> &[ExternalAccount] {
        self.external.as_deref().unwrap_or(&[])
    }

    pub fn transport(&self) -> &str {
        self.transport.as_deref().unwrap_or("udp")
    }
}

/// One provisioned line. Optional fields stay `None` when the stored config never set them,
/// so a save writes back exactly what was there (plus whatever the edit changed).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Instance {
    #[serde(deserialize_with = "de_string")]
    pub id: String,
    #[serde(deserialize_with = "lenient::opt", skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(deserialize_with = "de_string")]
    pub imsi: String,
    #[serde(deserialize_with = "de_string")]
    pub mcc: String,
    #[serde(deserialize_with = "de_string")]
    pub mnc: String,
    #[serde(deserialize_with = "lenient::opt", skip_serializing_if = "Option::is_none")]
    pub iccid: Option<String>,
    #[serde(deserialize_with = "lenient::opt", skip_serializing_if = "Option::is_none")]
    pub imei: Option<String>,
    #[serde(deserialize_with = "lenient::opt", skip_serializing_if = "Option::is_none")]
    pub imeisv: Option<String>,
    /// The saved SIM PIN (locally stored credential, used on every engine start).
    #[serde(deserialize_with = "lenient::opt", skip_serializing_if = "Option::is_none")]
    pub pin: Option<String>,
    #[serde(deserialize_with = "lenient::opt", skip_serializing_if = "Option::is_none")]
    pub reader: Option<String>,
    #[serde(deserialize_with = "lenient::opt", skip_serializing_if = "Option::is_none")]
    pub reader_index: Option<i64>,
    /// Stable physical USB port path of the reader (usbreader.rs), e.g. "3-2".
    #[serde(deserialize_with = "lenient::opt", skip_serializing_if = "Option::is_none")]
    pub reader_port: Option<String>,
    #[serde(deserialize_with = "lenient::opt", skip_serializing_if = "Option::is_none")]
    pub smsc: Option<String>,
    #[serde(deserialize_with = "lenient::opt", skip_serializing_if = "Option::is_none")]
    pub msisdn: Option<String>,
    #[serde(deserialize_with = "lenient::opt", skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(deserialize_with = "de_nested_opt", skip_serializing_if = "Option::is_none")]
    pub sip: Option<Sip>,
    #[serde(deserialize_with = "de_ports", skip_serializing_if = "Option::is_none")]
    pub ports: Option<Ports>,
    /// Persistent, unique per-line index (IKE source ports 45000+2k / 45001+2k).
    #[serde(deserialize_with = "lenient::opt", skip_serializing_if = "Option::is_none")]
    pub index: Option<i64>,
    #[serde(deserialize_with = "lenient::opt", skip_serializing_if = "Option::is_none")]
    pub ami_user: Option<String>,
    #[serde(deserialize_with = "lenient::opt", skip_serializing_if = "Option::is_none")]
    pub ami_secret: Option<String>,
    #[serde(deserialize_with = "lenient::opt", skip_serializing_if = "Option::is_none")]
    pub apn: Option<String>,
    #[serde(deserialize_with = "lenient::opt", skip_serializing_if = "Option::is_none")]
    pub idr_mode: Option<String>,
    #[serde(deserialize_with = "lenient::opt", skip_serializing_if = "Option::is_none")]
    pub cp_mode: Option<String>,
    #[serde(deserialize_with = "lenient::opt", skip_serializing_if = "Option::is_none")]
    pub cp_mode_source: Option<String>,
    #[serde(deserialize_with = "lenient::opt", skip_serializing_if = "Option::is_none")]
    pub use_reauth_id: Option<bool>,
    #[serde(deserialize_with = "lenient::opt", skip_serializing_if = "Option::is_none")]
    pub ims_domain: Option<String>,
    #[serde(deserialize_with = "lenient::opt", skip_serializing_if = "Option::is_none")]
    pub reg_geolocation_country: Option<String>,
    #[serde(deserialize_with = "lenient::opt", skip_serializing_if = "Option::is_none")]
    pub reg_srvcc_tags: Option<bool>,
    #[serde(deserialize_with = "lenient::opt", skip_serializing_if = "Option::is_none")]
    pub reg_imei_urn_spare_zero: Option<bool>,
    #[serde(deserialize_with = "lenient::opt", skip_serializing_if = "Option::is_none")]
    pub dial_00_to_plus: Option<bool>,
    #[serde(deserialize_with = "lenient::opt", skip_serializing_if = "Option::is_none")]
    pub update_after_prack: Option<bool>,
    /// Incoming calls use QoS preconditions only when the INVITE *requires* them (Asterisk
    /// fork PATCH_MT_PRECONDITION_REQUIRE_ONLY). Off by default.
    #[serde(deserialize_with = "lenient::opt", skip_serializing_if = "Option::is_none")]
    pub mt_precondition_require_only: Option<bool>,
    /// Carrier (IMS) leg codecs in preference order (`normalize_ims_codecs`); unset = the
    /// phone-like default. Kept as raw JSON so a hand-edited odd value can't fail the load.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ims_codecs: Option<Value>,
    #[serde(deserialize_with = "lenient::opt", skip_serializing_if = "Option::is_none")]
    pub rekey_minutes: Option<i64>,
    #[serde(deserialize_with = "lenient::opt", skip_serializing_if = "Option::is_none")]
    pub epdg: Option<String>,
    #[serde(deserialize_with = "lenient::opt", skip_serializing_if = "Option::is_none")]
    pub pcscf: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub debug: Option<Value>,
    /// Per-line override of settings.retry (same keys).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry: Option<Value>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

fn non_empty(v: &Option<String>) -> Option<&str> {
    v.as_deref().filter(|s| !s.is_empty())
}

impl Instance {
    pub fn enabled(&self) -> bool {
        self.enabled.unwrap_or(true)
    }
    pub fn has_pin(&self) -> bool {
        non_empty(&self.pin).is_some()
    }
    pub fn pin(&self) -> Option<&str> {
        non_empty(&self.pin)
    }
    pub fn iccid(&self) -> Option<&str> {
        non_empty(&self.iccid)
    }
    pub fn msisdn(&self) -> &str {
        self.msisdn.as_deref().unwrap_or("")
    }
    pub fn reader_port(&self) -> Option<&str> {
        non_empty(&self.reader_port)
    }
    pub fn ami_user(&self) -> &str {
        self.ami_user.as_deref().unwrap_or("vowifi")
    }
    pub fn sip(&self) -> Sip {
        self.sip.clone().unwrap_or_default()
    }
    pub fn ports_or_nominal(&self) -> Ports {
        self.ports.unwrap_or_else(|| alloc_ports(self.index.unwrap_or(0).max(0) as u32))
    }
    pub fn realm(&self) -> String {
        ims_realm(&self.mcc, &self.mnc)
    }
    /// ePDG FQDN (TS 23.003 19.4.2.9), MNC zero-padded to 3 digits; `epdg` overrides.
    pub fn epdg_fqdn(&self) -> String {
        match non_empty(&self.epdg) {
            Some(e) => e.to_string(),
            None => format!("epdg.epc.mnc{:0>3}.mcc{}.pub.3gppnetwork.org", self.mnc, self.mcc),
        }
    }
    /// The instance as returned to the WebUI: everything but the PIN.
    pub fn public_json(&self) -> Map<String, Value> {
        let mut v = match serde_json::to_value(self) {
            Ok(Value::Object(m)) => m,
            _ => Map::new(),
        };
        v.remove("pin");
        v
    }
}

#[derive(Debug, Default, Serialize)]
struct ConfigFile {
    settings: Settings,
    instances: IndexMap<String, Instance>,
}

// --------------------------------------------------------------------------- YAML load / save
/// YAML -> JSON value; mapping keys are stringified (a hand edit may leave `1:` unquoted).
fn yaml_to_json(v: serde_yaml::Value) -> Value {
    use serde_yaml::Value as Y;
    match v {
        Y::Null => Value::Null,
        Y::Bool(b) => Value::Bool(b),
        Y::Number(n) => {
            if let Some(i) = n.as_i64() {
                json!(i)
            } else if let Some(u) = n.as_u64() {
                json!(u)
            } else {
                n.as_f64().map(|f| json!(f)).unwrap_or(Value::Null)
            }
        }
        Y::String(s) => Value::String(s),
        Y::Sequence(s) => Value::Array(s.into_iter().map(yaml_to_json).collect()),
        Y::Mapping(m) => {
            let mut out = Map::new();
            for (k, v) in m {
                let key = match yaml_to_json(k) {
                    Value::String(s) => s,
                    Value::Null => "null".into(),
                    other => other.to_string(),
                };
                out.insert(key, yaml_to_json(v));
            }
            Value::Object(out)
        }
        Y::Tagged(t) => yaml_to_json(t.value),
    }
}

fn write_atomic(path: &Path, data: &[u8], mode: u32) -> anyhow::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension(format!(
        "{}.tmp",
        path.extension().and_then(|e| e.to_str()).unwrap_or("")
    ));
    {
        let mut f = fs::OpenOptions::new().write(true).create(true).truncate(true)
            .mode(mode).open(&tmp)
            .with_context(|| format!("open {}", tmp.display()))?;
        f.write_all(data)?;
        f.sync_all()?;
    }
    fs::rename(&tmp, path).with_context(|| format!("replace {}", path.display()))?;
    Ok(())
}

fn load_locked() -> anyhow::Result<ConfigFile> {
    let path = config_path();
    if !path.exists() {
        let fresh = ConfigFile::default();
        write_atomic(&path, serde_yaml::to_string(&fresh)?.as_bytes(), 0o600)?;
        return Ok(fresh);
    }
    let text = fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))?;
    let raw: serde_yaml::Value = serde_yaml::from_str(&text)
        .with_context(|| format!("parse {}", path.display()))?;
    let raw = yaml_to_json(raw);
    let settings = match raw.get("settings") {
        Some(s @ Value::Object(_)) => serde_json::from_value(s.clone()).unwrap_or_default(),
        _ => Settings::default(),
    };
    let mut instances = IndexMap::new();
    if let Some(Value::Object(m)) = raw.get("instances") {
        for (key, v) in m {
            if !v.is_object() {
                tracing::warn!("config: instance {key:?} is not a mapping; ignored");
                continue;
            }
            match serde_json::from_value::<Instance>(v.clone()) {
                Ok(mut inst) => {
                    if inst.id.is_empty() {
                        inst.id = key.clone();
                    }
                    instances.insert(key.clone(), inst);
                }
                Err(e) => tracing::warn!("config: instance {key:?} unreadable ({e}); ignored"),
            }
        }
    }
    Ok(ConfigFile { settings, instances })
}

fn save_locked(data: &ConfigFile) -> anyhow::Result<()> {
    // 0600: the file holds SIM PINs, AMI and SIP secrets.
    write_atomic(&config_path(), serde_yaml::to_string(data)?.as_bytes(), 0o600)
}

fn with_lock<T>(f: impl FnOnce() -> T) -> T {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    f()
}

fn load() -> anyhow::Result<ConfigFile> {
    with_lock(load_locked)
}

pub fn get_settings() -> Settings {
    match load() {
        Ok(c) => c.settings,
        Err(e) => {
            tracing::error!("config load failed: {e:#}");
            Settings::default()
        }
    }
}

pub fn list_instances() -> Vec<Instance> {
    match load() {
        Ok(c) => c.instances.into_values().collect(),
        Err(e) => {
            tracing::error!("config load failed: {e:#}");
            Vec::new()
        }
    }
}

pub fn get_instance(iid: &str) -> Option<Instance> {
    load().ok()?.instances.shift_remove(iid)
}

pub fn instance_by_iccid(iccid: Option<&str>) -> Option<Instance> {
    let iccid = iccid.filter(|s| !s.is_empty())?;
    list_instances().into_iter().find(|i| i.iccid.as_deref() == Some(iccid))
}

// -------------------------------------------------------------------------- advertise address
fn iface_is_lan_candidate(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    if n.is_empty() || n == "lo" {
        return false;
    }
    const SKIP: &[&str] = &[
        "podman", "docker", "br-", "veth", "virbr", "cni", "flannel", "tun", "tap", "wg",
        "ipsec", "vti", "gre", "gretap", "erspan", "sit", "nlmon", "uk-", "nordlynx",
        "tailscale", "zerotier", "zt", "ppp",
    ];
    !SKIP.iter().any(|p| n.starts_with(p) || n == p.trim_end_matches('-'))
}

fn usable_v4(ip: &str) -> bool {
    !ip.is_empty() && !ip.starts_with("127.") && !ip.starts_with("169.254.") && !ip.starts_with("172.17.")
}

/// Best-effort primary LAN IPv4 of this host: the address Asterisk advertises to LOCAL SIP
/// clients (Contact + SDP). Prefers an address on a real LAN NIC: on a multi-homed host a
/// full-tunnel VPN can make its tunnel address the route source for 1.1.1.1, and advertising
/// that breaks LAN RTP / RFC 4733 DTMF.
pub fn host_lan_ipv4() -> String {
    if let Ok(addrs) = nix::ifaddrs::getifaddrs() {
        let mut by_iface: IndexMap<String, Vec<Ipv4Addr>> = IndexMap::new();
        for a in addrs {
            if !iface_is_lan_candidate(&a.interface_name) {
                continue;
            }
            if let Some(sin) = a.address.as_ref().and_then(|s| s.as_sockaddr_in()) {
                by_iface.entry(a.interface_name.clone()).or_default().push(sin.ip());
            }
        }
        let mut names: Vec<String> = by_iface.keys().cloned().collect();
        let pref = |n: &str| {
            let l = n.to_ascii_lowercase();
            !(l.starts_with("en") || l.starts_with("eth") || l.starts_with("wl"))
        };
        names.sort_by(|a, b| (pref(a), a).cmp(&(pref(b), b)));
        for n in names {
            if let Some(ip) = by_iface[&n].first() {
                let s = ip.to_string();
                if usable_v4(&s) {
                    return s;
                }
            }
        }
    }
    // Fallbacks for minimal hosts: the route-selected source, preferring a 192.168/16 address
    // from `hostname -I` when the route source looks like a VPN 10/8 address.
    let route_ip = UdpSocket::bind("0.0.0.0:0")
        .and_then(|s| { s.connect("1.1.1.1:80")?; s.local_addr() })
        .map(|a| a.ip().to_string())
        .unwrap_or_default();
    let extras: Vec<String> = std::process::Command::new("hostname").arg("-I").output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).split_whitespace()
            .filter(|p| !p.contains(':') && usable_v4(p)).map(String::from).collect())
        .unwrap_or_default();
    if let Some(p) = extras.iter().find(|ip| ip.starts_with("192.168."))
        && (route_ip.is_empty() || route_ip.starts_with("10.")) {
            return p.clone();
        }
    if usable_v4(&route_ip) {
        return route_ip;
    }
    extras.first().cloned().unwrap_or_default()
}

pub fn ims_realm(mcc: &str, mnc: &str) -> String {
    // ims.mnc<MNC>.mcc<MCC>.3gppnetwork.org, MNC zero-padded to 3 (matches engine render.py).
    format!("ims.mnc{mnc:0>3}.mcc{mcc}.3gppnetwork.org")
}

pub fn normalize_advertise_address(value: &str) -> Result<String, CfgError> {
    let v = value.trim();
    if v.chars().any(char::is_whitespace) || v.contains("://") {
        return invalid("advertise_address must be a bare IP address or hostname \
                        (for example 192.168.6.239), not a URL");
    }
    Ok(v.to_string())
}

fn env_advertise() -> String {
    std::env::var("VOWIFI_ADVERTISE_ADDR").unwrap_or_default().trim().to_string()
}

pub fn advertise_address_managed_by_env() -> bool {
    !env_advertise().is_empty()
}

/// Precedence: installer/env pin > stored setting > TLS domain > LAN auto-detection. The env
/// pin must win even over a TLS domain: multi-homed installs use it to pin the RTP/Contact
/// address.
pub fn advertise_address(settings: &Settings) -> String {
    if let Ok(env) = normalize_advertise_address(&env_advertise())
        && !env.is_empty() {
            return env;
        }
    if let Ok(stored) = normalize_advertise_address(&settings.advertise_address)
        && !stored.is_empty() {
            return stored;
        }
    let domain = settings.tls.domain.trim();
    if !domain.is_empty() {
        return domain.to_string();
    }
    host_lan_ipv4()
}

/// Settings payload for the WebUI, with the resolved advertise-address diagnostics.
pub fn public_settings() -> Value {
    let settings = get_settings();
    let stored = normalize_advertise_address(&settings.advertise_address).unwrap_or_default();
    let effective = advertise_address(&settings);
    let mut v = serde_json::to_value(&settings).unwrap_or_else(|_| json!({}));
    if let Value::Object(m) = &mut v {
        m.insert("advertise_address".into(), json!(stored));
        m.insert("advertise_address_effective".into(), json!(effective));
        m.insert("advertise_address_managed_by_env".into(), json!(advertise_address_managed_by_env()));
        m.insert("advertise_address_detected".into(), json!(host_lan_ipv4()));
    }
    v
}

/// Shallow-merge a settings patch (nested objects replace wholesale, then defaults refill).
pub fn update_settings(mut patch: Map<String, Value>) -> Result<Value, CfgError> {
    for k in ["advertise_address_effective", "advertise_address_managed_by_env",
              "advertise_address_detected"] {
        patch.remove(k);
    }
    if let Some(v) = patch.get("advertise_address") {
        let n = normalize_advertise_address(&lenient::string(Some(v)))?;
        patch.insert("advertise_address".into(), json!(n));
    }
    let (settings, instances, changed) = with_lock(|| -> Result<_, CfgError> {
        let mut data = load_locked()?;
        let previous = normalize_advertise_address(&data.settings.advertise_address).unwrap_or_default();
        let mut cur = match serde_json::to_value(&data.settings) {
            Ok(Value::Object(m)) => m,
            _ => Map::new(),
        };
        let touched_adv = patch.contains_key("advertise_address");
        for (k, v) in patch {
            cur.insert(k, v);
        }
        data.settings = serde_json::from_value(Value::Object(cur)).unwrap_or_default();
        save_locked(&data)?;
        let current = normalize_advertise_address(&data.settings.advertise_address).unwrap_or_default();
        Ok((data.settings, data.instances, touched_adv || current != previous))
    })?;
    // Refresh the host-mounted instance.json files; running engines still need Stop -> Start.
    if changed {
        for inst in instances.values() {
            if let Err(e) = write_instance_json(inst, &settings) {
                tracing::warn!(instance = %inst.id, "instance {}: instance.json refresh failed: {e:#}", inst.id);
            }
        }
    }
    Ok(public_settings())
}

// ------------------------------------------------------------------------------------- ports
/// Per-instance port block layout (see AGENTS.md: keep in sync with engine.rs, install.sh
/// ensure_firewall and the README).
const PORT_BASE: Ports = Ports { sip_udp: 5060, sip_tls: 5061, webrtc: 8089, ami: 5038,
                                 rtp_start: 10000, rtp_end: 11000 };
const PORT_STRIDE: Ports = Ports { sip_udp: 10, sip_tls: 10, webrtc: 10, ami: 10,
                                   rtp_start: 2000, rtp_end: 2000 };
/// RTP host ports an engine actually publishes (engine.rs binds rtp_start..+RTP_SPAN).
pub const RTP_SPAN: u32 = 60;
pub const MIN_USER_PORT: u32 = 1024;
pub const MAX_USER_PORT: u32 = 65535;

pub fn alloc_ports(index: u32) -> Ports {
    let b = PORT_BASE;
    let s = PORT_STRIDE;
    Ports {
        sip_udp: b.sip_udp + index * s.sip_udp,
        sip_tls: b.sip_tls + index * s.sip_tls,
        webrtc: b.webrtc + index * s.webrtc,
        ami: b.ami + index * s.ami,
        rtp_start: b.rtp_start + index * s.rtp_start,
        rtp_end: b.rtp_end + index * s.rtp_end,
    }
}

fn block_ports(b: &Ports) -> HashSet<u32> {
    let mut s: HashSet<u32> = [b.sip_udp, b.sip_tls, b.webrtc, b.ami].into_iter().collect();
    s.extend(b.rtp_start..b.rtp_start + RTP_SPAN);
    s
}

fn block_max(b: &Ports) -> u32 {
    block_ports(b).into_iter().max().unwrap_or(0)
}

fn reserved_ports(data: &ConfigFile, exclude: Option<&str>) -> HashSet<u32> {
    let mut used = HashSet::new();
    for (iid, inst) in &data.instances {
        if exclude == Some(iid.as_str()) {
            continue;
        }
        if let Some(p) = &inst.ports {
            used.extend(block_ports(p));
        }
    }
    used
}

/// True unless the host already has a TCP or UDP socket on this port (IPv4 wildcard probe,
/// SO_REUSEADDR off so a live listener is detected).
fn host_port_free(port: u32) -> bool {
    use socket2::{Domain, Socket, Type};
    let Ok(port) = u16::try_from(port) else { return false };
    let addr: SocketAddr = (Ipv4Addr::UNSPECIFIED, port).into();
    for ty in [Type::STREAM, Type::DGRAM] {
        // A socket we can't even create says nothing about the port: don't block on it.
        let Ok(s) = Socket::new(Domain::IPV4, ty, None) else { continue };
        if s.bind(&addr.into()).is_err() {
            return false;
        }
    }
    true
}

fn block_free(block: &Ports, reserved: &HashSet<u32>) -> bool {
    if !block_ports(block).is_disjoint(reserved) {
        return false;
    }
    // Only the 4 service ports are probed on the host (60 RTP probes per try is slow; RTP
    // clashes with other lines are caught by the reserved set).
    [block.sip_udp, block.sip_tls, block.webrtc, block.ami].into_iter().all(host_port_free)
}

fn alloc_ports_auto_in(data: &ConfigFile, exclude: Option<&str>) -> Result<Ports, CfgError> {
    // Scan from index 0 so moving a line back to Auto reclaims the lowest free block.
    let reserved = reserved_ports(data, exclude);
    for index in 0..500 {
        let block = alloc_ports(index);
        if block_max(&block) > MAX_USER_PORT {
            break;
        }
        if block_free(&block, &reserved) {
            return Ok(block);
        }
    }
    invalid("no free port block available for a new line")
}

/// Automatic port allocation (conflict-checked against other lines and host listeners).
pub fn alloc_ports_auto(exclude: Option<&str>) -> Result<Ports, CfgError> {
    let data = load()?;
    alloc_ports_auto_in(&data, exclude)
}

/// Manual selection: the user picks the SIP UDP port; the rest of the block keeps the
/// nominal offsets. Validated for range and conflicts, with user-facing messages.
pub fn ports_from_sip_base(sip_udp: i64, exclude: Option<&str>) -> Result<Ports, CfgError> {
    if !(MIN_USER_PORT as i64..=MAX_USER_PORT as i64).contains(&sip_udp) {
        return invalid(format!("port must be between {MIN_USER_PORT} and {MAX_USER_PORT}"));
    }
    let sip_udp = sip_udp as u32;
    let b0 = alloc_ports(0);
    let off = |v: u32| v - b0.sip_udp;
    let block = Ports {
        sip_udp,
        sip_tls: sip_udp + off(b0.sip_tls),
        webrtc: sip_udp + off(b0.webrtc),
        ami: sip_udp - (b0.sip_udp - b0.ami),
        rtp_start: sip_udp + off(b0.rtp_start),
        rtp_end: sip_udp + off(b0.rtp_end),
    };
    if block_max(&block) > MAX_USER_PORT {
        return invalid(format!("port {sip_udp} is too high — its RTP range would exceed {MAX_USER_PORT}"));
    }
    let data = load()?;
    let reserved = reserved_ports(&data, exclude);
    let clash: Vec<u32> = block_ports(&block).intersection(&reserved).copied().collect();
    if !clash.is_empty() {
        if clash.contains(&sip_udp) || clash.contains(&block.sip_tls) {
            return invalid(format!("port {sip_udp} is already used by another line. \
                                    Choose a different port or use Automatic."));
        }
        let first = clash.iter().min().copied().unwrap_or(0);
        return invalid(format!("port {sip_udp} overlaps another line's port range \
                                (conflict at {first}). Try a port at least 10 away, or use Automatic."));
    }
    for (port, name) in [(block.sip_udp, "SIP/UDP"), (block.sip_tls, "SIP/TLS"),
                         (block.webrtc, "WebRTC"), (block.ami, "control")] {
        if !host_port_free(port) {
            return invalid(format!("port {port} ({name}) is already in use on the host. \
                                    Choose a different port or use Automatic."));
        }
    }
    Ok(block)
}

fn next_index(data: &ConfigFile) -> i64 {
    let used: HashSet<i64> = data.instances.values().map(|i| i.index.unwrap_or(0)).collect();
    (0..).find(|i| !used.contains(i)).unwrap_or(0)
}

// ---------------------------------------------------------------------------- SIP accounts
const SIP_RESERVED_USERNAMES: &[&str] = &[
    "global", "system", "volte_ims", "endpoint-local", "auth-local", "aor-local",
    "transport-local", "transport-wss",
];

/// Reject external SIP names that would collide in the rendered pjsip config.
pub fn validate_sip_external_usernames(sip: &Sip) -> Result<(), CfgError> {
    let webrtc_user = sip.webrtc.as_ref().and_then(|w| w.username.clone())
        .filter(|u| !u.is_empty()).unwrap_or_else(|| "webrtc".into());
    let webrtc_user = webrtc_user.trim();
    let mut seen: std::collections::HashMap<String, usize> = Default::default();
    for (index, account) in sip.external_accounts().iter().enumerate() {
        let username = account.username.trim();
        if username.is_empty() {
            continue;
        }
        if SIP_RESERVED_USERNAMES.contains(&username) || (!webrtc_user.is_empty() && username == webrtc_user) {
            return invalid(format!("SIP username '{username}' is reserved (used by the built-in \
                                    softphone or Asterisk internals). Choose a different name."));
        }
        if let Some(prev) = seen.get(username) {
            return invalid(format!("SIP username '{username}' is used more than once on this line \
                                    (accounts #{} and #{}). Each account needs a unique username.",
                                   prev + 1, index + 1));
        }
        seen.insert(username.to_string(), index);
    }
    Ok(())
}

/// Validate the `sip` member of a raw request body (as the WebUI sent it).
pub fn validate_sip_value(sip: Option<&Value>) -> Result<(), CfgError> {
    let sip: Sip = match sip {
        Some(v @ Value::Object(_)) => serde_json::from_value(v.clone()).unwrap_or_default(),
        _ => Sip::default(),
    };
    validate_sip_external_usernames(&sip)
}

/// Preserve an external account's secret when a save omits or blanks its password.
fn merge_external_sip_accounts(new_list: &Value, old: &[ExternalAccount]) -> Result<Value, CfgError> {
    let mut merged = Vec::new();
    for account in new_list.as_array().map(Vec::as_slice).unwrap_or(&[]) {
        let Value::Object(acc) = account else { continue };
        let username = lenient::string(acc.get("username")).trim().to_string();
        if username.is_empty() {
            continue;
        }
        let given = lenient::string(acc.get("password"));
        let password = if !given.trim().is_empty() {
            given
        } else {
            old.iter().find(|o| o.username.trim() == username)
                .map(|o| o.password.clone()).unwrap_or_default()
        };
        if password.is_empty() {
            return invalid(format!("SIP account '{username}' needs a password \
                                    (third-party SIP clients will get Unauthorized without one)."));
        }
        let mut out = acc.clone();
        out.insert("username".into(), json!(username));
        out.insert("password".into(), json!(password));
        merged.push(Value::Object(out));
    }
    Ok(Value::Array(merged))
}

/// URL-safe random token of `n` bytes (Python's secrets.token_urlsafe).
pub fn token_urlsafe(n: usize) -> String {
    let mut buf = vec![0u8; n];
    rand::fill(&mut buf[..]);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buf)
}

fn obj(v: Option<&Value>) -> Map<String, Value> {
    match v {
        Some(Value::Object(m)) => m.clone(),
        _ => Map::new(),
    }
}

/// Create or update an instance from a (partial) JSON patch. Mirrors the established merge
/// rules: index and an existing port block are kept, blank secrets/PIN never overwrite stored
/// ones, `sip` merges one level deeper (and `sip.webrtc` / external passwords two), and the
/// WebRTC softphone credential is made stable.
pub fn upsert_instance(mut patch: Map<String, Value>) -> Result<Instance, CfgError> {
    let iid = lenient::string(patch.get("id"));
    if iid.is_empty() {
        return invalid("id required");
    }
    with_lock(|| {
        let mut data = load_locked()?;
        // Runtime-only fields that ride along on API instance objects: never persist them.
        patch.remove("status");
        patch.remove("has_pin");
        patch.insert("id".into(), json!(iid));
        if let Some(v) = patch.get("ims_codecs") {
            let codecs = normalize_ims_codecs(Some(v))?;
            patch.insert("ims_codecs".into(), json!(codecs));
        }
        let existing_typed = data.instances.get(&iid).cloned();
        let existing = existing_typed.as_ref()
            .map(|e| match serde_json::to_value(e) { Ok(Value::Object(m)) => m, _ => Map::new() })
            .unwrap_or_default();

        let index = existing_typed.as_ref().and_then(|e| e.index).unwrap_or_else(|| next_index(&data));
        patch.insert("index".into(), json!(index));
        if !patch.contains_key("ports") {
            let ports = match existing_typed.as_ref().and_then(|e| e.ports) {
                Some(p) => p,
                None => alloc_ports_auto_in(&data, Some(&iid))?,
            };
            patch.insert("ports".into(), serde_json::to_value(ports).map_err(anyhow::Error::from)?);
        }
        // A blank secret from the WebUI must never replace the real one (the manager would
        // then log in to the engine's AMI with the wrong credential forever).
        if !lenient::truthy(patch.get("ami_secret")) {
            let keep = existing_typed.as_ref().and_then(|e| e.ami_secret.clone())
                .filter(|s| !s.is_empty()).unwrap_or_else(|| token_urlsafe(16));
            patch.insert("ami_secret".into(), json!(keep));
        }
        // The saved PIN survives edits that don't carry a new non-empty one; clearing is
        // deliberate (clear_pin).
        if !lenient::truthy(patch.get("pin")) {
            patch.remove("pin");
            if let Some(p) = existing_typed.as_ref().and_then(|e| e.pin()) {
                patch.insert("pin".into(), json!(p));
            }
        }
        if patch.contains_key("sip") {
            let old_sip = obj(existing.get("sip"));
            let new_sip = obj(patch.get("sip"));
            let mut merged_sip = old_sip.clone();
            for (k, v) in &new_sip {
                merged_sip.insert(k.clone(), v.clone());
            }
            if old_sip.contains_key("webrtc") || new_sip.contains_key("webrtc") {
                let mut wr = obj(old_sip.get("webrtc"));
                for (k, v) in obj(new_sip.get("webrtc")) {
                    wr.insert(k, v);
                }
                merged_sip.insert("webrtc".into(), Value::Object(wr));
            }
            if let Some(ext) = new_sip.get("external") {
                let old_accounts = existing_typed.as_ref().map(|e| e.sip().external.unwrap_or_default())
                    .unwrap_or_default();
                merged_sip.insert("external".into(), merge_external_sip_accounts(ext, &old_accounts)?);
            }
            patch.insert("sip".into(), Value::Object(merged_sip));
        }
        let mut merged = existing;
        for (k, v) in patch {
            merged.insert(k, v);
        }
        // A STABLE WebRTC softphone credential (Asterisk config and the softphone endpoint
        // must agree).
        let mut sip = obj(merged.get("sip"));
        let mut wr = obj(sip.get("webrtc"));
        wr.entry("username").or_insert(json!("webrtc"));
        if !lenient::truthy(wr.get("password")) {
            let prev = existing_typed.as_ref().and_then(|e| e.sip.as_ref())
                .and_then(|s| s.webrtc.as_ref()).and_then(|w| w.password.clone())
                .filter(|p| !p.is_empty()).unwrap_or_else(|| token_urlsafe(12));
            wr.insert("password".into(), json!(prev));
        }
        sip.insert("webrtc".into(), Value::Object(wr));
        merged.insert("sip".into(), Value::Object(sip));

        let inst: Instance = serde_json::from_value(Value::Object(merged)).map_err(anyhow::Error::from)?;
        validate_sip_external_usernames(&inst.sip())?;
        data.instances.insert(iid.clone(), inst.clone());
        save_locked(&data)?;
        Ok(inst)
    })
}

/// Delete the saved PIN. Returns whether one was stored.
pub fn clear_pin(iid: &str) -> bool {
    with_lock(|| {
        let Ok(mut data) = load_locked() else { return false };
        let Some(inst) = data.instances.get_mut(iid) else { return false };
        let had = inst.has_pin();
        inst.pin = Some(String::new());
        if let Err(e) = save_locked(&data) {
            tracing::error!(instance = %iid, "clear_pin {iid}: save failed: {e:#}");
        }
        had
    })
}

pub fn delete_instance(iid: &str) -> anyhow::Result<()> {
    with_lock(|| {
        let mut data = load_locked()?;
        data.instances.shift_remove(iid);
        save_locked(&data)
    })
}

// ----------------------------------------------------------------------- field normalisers
pub fn normalize_imei(imei: &str) -> String {
    imei.chars().filter(char::is_ascii_digit).collect()
}

/// 16-digit IMEISV for the ePDG DEVICE_IDENTITY: an explicit IMEISV wins (digits, padded /
/// truncated to 16); otherwise the IMEI's 14-digit TAC+SNR (check digit dropped) + 2-digit SVN.
pub fn imeisv_from_imei(imei: &str, imeisv: &str, svn: &str) -> String {
    let isv: String = imeisv.chars().filter(char::is_ascii_digit).collect();
    if !isv.is_empty() {
        return format!("{isv:0<16}")[..16].to_string();
    }
    let digits = normalize_imei(imei);
    if digits.is_empty() {
        return String::new();
    }
    let base14 = format!("{:0<14}", &digits[..digits.len().min(14)]);
    let svn_digits: String = svn.chars().filter(char::is_ascii_digit).collect();
    let svn_digits = if svn_digits.is_empty() { "00".to_string() } else { svn_digits };
    let svn2 = format!("{:0>2}", &svn_digits[..svn_digits.len().min(2)]);
    base14 + &svn2
}

/// 0 disables proactive rekey; otherwise clamp to 1..1440 minutes.
pub fn clamp_rekey(m: i64) -> i64 {
    if m <= 0 { 0 } else { m.clamp(1, 1440) }
}

/// APN for the SWu tunnel; blank = the standard IMS APN.
pub fn normalize_apn(apn: &str) -> String {
    let a = apn.trim().to_lowercase();
    if a.is_empty() { "ims".into() } else { a }
}

/// IDr encoding (TS 24.302 7.2.2.1): 'apn' (bare APN, the widely accepted default) or 'fqdn'
/// (<apn>.apn.epc.mnc<MNC>.mcc<MCC>.pub.3gppnetwork.org, needed by a few strict ePDGs and
/// rejected by others).
pub fn normalize_idr_mode(mode: &str) -> String {
    let m = mode.trim().to_lowercase();
    if m == "apn" || m == "fqdn" { m } else { "apn".into() }
}

/// SWu CFG request address family; must match the carrier's IMS PDN or the ePDG rejects the
/// PDN connection at the final IKE_AUTH. 'auto' walks a discovery ladder (engine side).
pub fn normalize_cp_mode(mode: &str) -> String {
    let m = mode.trim().to_lowercase();
    if ["auto", "v6", "v4", "dual"].contains(&m.as_str()) { m } else { "auto".into() }
}

/// TS 24.229 7.2A.4.3 WLAN access-type values (+ 3GPP-WLAN seen in osmocom references).
const PANI_ACCESS_TYPES: &[&str] = &[
    "IEEE-802.11", "IEEE-802.11a", "IEEE-802.11b", "IEEE-802.11g", "IEEE-802.11n",
    "IEEE-802.11ac", "IEEE-802.11ax", "IEEE-802.11be", "IEEE-802.11j", "IEEE-802.11p",
    "IEEE-802.11y", "IEEE-802.11ad", "IEEE-802.11af", "IEEE-802.11ah", "IEEE-802.11aj",
    "IEEE-802.11ay", "IEEE-802.11bd", "3GPP-WLAN",
];

/// Codecs a line may offer/accept on the carrier (IMS) leg. AMR-WB + AMR is what a phone
/// offers; G.722 / G.711 are opt-in for carriers that accept them (O2 DE offers G.722 itself),
/// so a G.722 local client (FRITZ!Box DECT HD) is bridged without transcoding. AMR before
/// AMR-WB is for carriers that fail AMR-WB answers (Beeline RU incoming calls). No EVS: the
/// fork's codec_vevs needs the proprietary libvocal.so, which the image lacks.
pub const IMS_CODECS_ALLOWED: &[&str] = &["amrwb", "amr", "g722", "alaw", "ulaw"];

pub fn ims_codecs_default() -> Vec<String> {
    vec!["amrwb".into(), "amr".into()]
}

/// Ordered, de-duplicated carrier-leg codec list; None/null/empty -> the phone-like default.
/// Accepts a list or a comma-separated string. Unknown codecs, or a list without AMR-WB/AMR,
/// are rejected: every IMS core supports AMR, and a list without it fails calls the carrier
/// routes without a transcoder.
pub fn normalize_ims_codecs(value: Option<&Value>) -> Result<Vec<String>, CfgError> {
    let items: Vec<String> = match value {
        None | Some(Value::Null) => return Ok(ims_codecs_default()),
        Some(Value::String(s)) => s.split(',').map(String::from).collect(),
        Some(Value::Array(a)) => a.iter().map(|v| lenient::string(Some(v))).collect(),
        Some(_) => return invalid("ims_codecs must be a list of codec names"),
    };
    let mut out: Vec<String> = Vec::new();
    for c in items {
        let c = c.trim().to_lowercase();
        if c.is_empty() {
            continue;
        }
        if !IMS_CODECS_ALLOWED.contains(&c.as_str()) {
            return invalid(format!("unknown carrier codec '{c}' (allowed: {})", IMS_CODECS_ALLOWED.join(", ")));
        }
        if !out.contains(&c) {
            out.push(c);
        }
    }
    if out.is_empty() {
        return Ok(ims_codecs_default());
    }
    if !out.iter().any(|c| c == "amrwb" || c == "amr") {
        return invalid("ims_codecs must include amrwb or amr");
    }
    Ok(out)
}

pub fn normalize_pani_country(c: &str) -> String {
    let s: String = c.trim().to_uppercase().chars().filter(|ch| ch.is_alphabetic()).collect();
    if s.chars().count() == 2 { s } else { String::new() }
}

/// WLAN BSSID for i-wlan-node-id: 12 lower-case hex digits, separators stripped.
pub fn normalize_pani_node_id(m: &str) -> String {
    let s: String = m.chars().filter(|c| c.is_alphanumeric()).collect::<String>().to_lowercase();
    if s.len() == 12 && s.chars().all(|c| c.is_ascii_hexdigit()) { s } else { String::new() }
}

pub fn normalize_pani_access_type(t: &str) -> String {
    let s = t.trim();
    if PANI_ACCESS_TYPES.contains(&s) { s.into() } else { "IEEE-802.11".into() }
}

/// Unescaped P-Access-Network-Info for the engine (render.py escapes it for pjsip.conf).
/// Raw `sip.pani` overrides; else access-type, `country=` (explicit or MCC-derived, on by
/// default), optional `i-wlan-node-id=` and `local-time-zone=` (RFC 7315 / TS 24.229).
/// Default shape matches a real UE: `IEEE-802.11;country=GB`.
pub fn build_pani(inst: &Instance, sip: &Sip) -> String {
    let raw = sip.pani.as_deref().unwrap_or("").trim();
    if !raw.is_empty() {
        return raw.to_string();
    }
    let mut parts = vec![normalize_pani_access_type(sip.pani_access_type.as_deref().unwrap_or(""))];
    if sip.pani_country_enable.unwrap_or(true) {
        let mut country = normalize_pani_country(sip.pani_country.as_deref().unwrap_or(""));
        if country.is_empty() {
            country = mcc_to_iso2(&inst.mcc).to_string();
        }
        if !country.is_empty() {
            parts.push(format!("country={country}"));
        }
    }
    if sip.pani_node_id_enable.unwrap_or(false) {
        let node = normalize_pani_node_id(sip.pani_node_id.as_deref().unwrap_or(""));
        if !node.is_empty() {
            parts.push(format!("i-wlan-node-id={node}"));
        }
    }
    let mut tz = sip.pani_local_time_zone.as_deref().unwrap_or("").trim().to_string();
    if !tz.is_empty() {
        if (tz.contains(' ') || tz.contains(';')) && !(tz.starts_with('"') && tz.ends_with('"')) {
            tz = format!("\"{}\"", tz.replace('"', ""));
        }
        parts.push(format!("local-time-zone={tz}"));
    }
    parts.join(";")
}

/// CP-mode probe-order HINT per "mcc-mnc" (the first rung of the engine's auto ladder, not a
/// required carrier preset — see AGENTS.md "No carrier database").
const CARRIER_CP_PREF: &[(&str, &str)] = &[
    ("302-220", "v6"),  // Telus (CA): IPv6 IMS PDN; v4/dual return no P-CSCF
    ("234-15", "dual"), // Vodafone UK: IPv4 IMS PDN; v6-only rejected with Notify 16375
    ("234-30", "v6"),   // EE (UK)
    ("234-33", "v6"),   // EE/CTExcel MVNO (UK)
];
const CP_MODE_LADDER_DEFAULT: &[&str] = &["v6", "dual", "v4"];

pub fn cp_mode_order_for(mcc: &str, mnc: &str) -> String {
    let stripped = mnc.trim_start_matches('0');
    let keys = [
        format!("{mcc}-{mnc}"),
        format!("{mcc:0>3}-{mnc:0>3}"),
        format!("{mcc}-{}", if stripped.is_empty() { mnc } else { stripped }),
    ];
    let mut order: Vec<&str> = Vec::new();
    if let Some(pref) = keys.iter().find_map(|k| CARRIER_CP_PREF.iter().find(|(c, _)| c == k).map(|(_, m)| *m)) {
        order.push(pref);
    }
    for m in CP_MODE_LADDER_DEFAULT {
        if !order.contains(m) {
            order.push(m);
        }
    }
    order.join(",")
}

fn manager_url(settings: &Settings) -> String {
    if !settings.manager_url.is_empty() {
        return settings.manager_url.clone();
    }
    match std::env::var("VOWIFI_MANAGER_URL") {
        Ok(u) if !u.is_empty() => u,
        _ => format!("https://host.containers.internal:{}", settings.http_port),
    }
}

/// The engine's /config/instance.json (engine/render.py is the consumer).
pub fn render_instance_json(inst: &Instance, settings: &Settings) -> Value {
    let ports = inst.ports_or_nominal();
    let sip = inst.sip();
    let webrtc = sip.webrtc.clone().unwrap_or_default();
    let ring = sip.ring_timeout.filter(|r| *r != 0).unwrap_or(settings.ring_timeout).clamp(5, 180);
    let imei = inst.imei.clone().unwrap_or_default();
    let imeisv = match non_empty(&inst.imeisv) {
        Some(s) => s.to_string(),
        None => imeisv_from_imei(&imei, "", "00"),
    };
    json!({
        "id": inst.id,
        "imsi": inst.imsi,
        "mcc": inst.mcc,
        "mnc": inst.mnc,
        "imei": imei,
        // Optional registrar domain override (REGISTER request-URI); empty = IMSI realm.
        "ims_domain": inst.ims_domain.as_deref().unwrap_or("").trim(),
        // Native-UE REGISTER extras (Asterisk fork), off unless set.
        "reg_geolocation_country": inst.reg_geolocation_country.as_deref().unwrap_or("").trim().to_uppercase(),
        "reg_srvcc_tags": inst.reg_srvcc_tags.unwrap_or(false),
        "reg_imei_urn_spare_zero": inst.reg_imei_urn_spare_zero.unwrap_or(false),
        "dial_00_to_plus": inst.dial_00_to_plus.unwrap_or(false),
        "update_after_prack": inst.update_after_prack.unwrap_or(false),
        "mt_precondition_require_only": inst.mt_precondition_require_only.unwrap_or(false),
        // Carrier (IMS) leg codecs, in preference order. A stored value that no longer
        // validates renders as the default instead of failing the start.
        "ims_codecs": normalize_ims_codecs(inst.ims_codecs.as_ref()).unwrap_or_else(|_| ims_codecs_default()),
        "imeisv": imeisv,
        "pin": inst.pin.clone().unwrap_or_default(),
        "reader": non_empty(&inst.reader).map(String::from).unwrap_or_else(|| format!("imsi:{}", inst.imsi)),
        // MUST be emitted: render.py defaults to 0, and a line on another reader would then
        // authenticate against the wrong SIM (USIM AUTHENTICATE 0x9862 "incorrect MAC").
        "reader_index": inst.reader_index.unwrap_or(0),
        // The engine resolves this back to a live PC/SC index in-container (usbreader).
        "reader_port": inst.reader_port.clone().unwrap_or_default(),
        "iccid": inst.iccid.clone().unwrap_or_default(),
        "msisdn": inst.msisdn(),
        "smsc": inst.smsc.clone().unwrap_or_default(),
        "pcscf": inst.pcscf.clone().unwrap_or_default(),
        "ami_user": inst.ami_user(),
        "ami_secret": inst.ami_secret.clone().unwrap_or_default(),
        "manager_url": manager_url(settings),
        "domain": settings.tls.domain,
        "rtp_start": ports.rtp_start,
        // Host ports the local SIP transport is published on: the engine advertises these in
        // Contact/Via, or a LAN client sends ACK/BYE to another line's 5060.
        "host_sip_udp_port": ports.sip_udp,
        "host_sip_tls_port": ports.sip_tls,
        // Only rtp_start..+RTP_SPAN-1 is published: the Asterisk RTP pool must stay inside it.
        "rtp_end": ports.rtp_end.min(ports.rtp_start + RTP_SPAN - 1),
        "sip": {
            "listen_addr": sip.listen_addr.as_deref().unwrap_or("0.0.0.0"),
            "transport": sip.transport(),
            "udp_port": 5060,
            "tls_port": 5061,
            "external": sip.external.clone().unwrap_or_default(),
            "advertise_address": advertise_address(settings),
            "ring_timeout": ring,
            "user_agent": sip.user_agent.as_deref().unwrap_or("iOS/26.6 iPhone"),
            "pani": build_pani(inst, &sip),
            "pani_country_enable": sip.pani_country_enable.unwrap_or(true),
            "pani_country": normalize_pani_country(sip.pani_country.as_deref().unwrap_or("")),
            "pani_node_id_enable": sip.pani_node_id_enable.unwrap_or(false),
            "pani_node_id": normalize_pani_node_id(sip.pani_node_id.as_deref().unwrap_or("")),
            "pani_access_type": normalize_pani_access_type(sip.pani_access_type.as_deref().unwrap_or("")),
            "pani_local_time_zone": sip.pani_local_time_zone.as_deref().unwrap_or("").trim(),
            "webrtc": {
                "enable": webrtc.enable.unwrap_or(true),
                "username": webrtc.username.as_deref().unwrap_or("webrtc"),
                "password": non_empty(&webrtc.password).unwrap_or("webrtc-secret"),
                "port": 8089,
            },
        },
        "debug": inst.debug.clone().unwrap_or_else(|| settings.debug.clone()),
        "rekey_minutes": clamp_rekey(inst.rekey_minutes.unwrap_or(settings.rekey.minutes)),
        "apn": normalize_apn(inst.apn.as_deref().unwrap_or("")),
        "idr_mode": normalize_idr_mode(inst.idr_mode.as_deref().unwrap_or("")),
        "cp_mode": normalize_cp_mode(inst.cp_mode.as_deref().unwrap_or("")),
        "cp_mode_order": cp_mode_order_for(&inst.mcc, &inst.mnc),
        // EAP-AKA fast re-authentication identity (RFC 4187 AT_NEXT_REAUTH_ID), default on.
        "use_reauth_id": inst.use_reauth_id.unwrap_or(true),
    })
}

pub fn write_instance_json(inst: &Instance, settings: &Settings) -> anyhow::Result<PathBuf> {
    let path = instance_dir(&inst.id).join("instance.json");
    let body = serde_json::to_vec_pretty(&render_instance_json(inst, settings))?;
    // 0644 like before: the engine reads it through a bind mount.
    write_atomic(&path, &body, 0o644)?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ims_codecs() {
        let n = |v: Value| normalize_ims_codecs(Some(&v)).map_err(|e| e.to_string());
        assert_eq!(normalize_ims_codecs(None).unwrap(), vec!["amrwb", "amr"]);
        assert_eq!(n(Value::Null).unwrap(), vec!["amrwb", "amr"]);
        assert_eq!(n(json!([])).unwrap(), vec!["amrwb", "amr"]);
        assert_eq!(n(json!(" AMR , amrwb,amr")).unwrap(), vec!["amr", "amrwb"]);
        assert_eq!(n(json!(["g722", "amrwb", "amr"])).unwrap(), vec!["g722", "amrwb", "amr"]);
        assert!(n(json!(["g722"])).unwrap_err().contains("amrwb or amr"));
        assert!(n(json!(["evs", "amr"])).unwrap_err().contains("unknown carrier codec"));
        assert!(n(json!(5)).is_err());
    }

    #[test]
    fn imeisv() {
        assert_eq!(imeisv_from_imei("35-209900-176148-1", "", "00"), "3520990017614800");
        assert_eq!(imeisv_from_imei("", "12", "00"), "1200000000000000");
        assert_eq!(imeisv_from_imei("123", "", "7"), "1230000000000007");
        assert_eq!(imeisv_from_imei("", "", "00"), "");
    }

    #[test]
    fn cp_order() {
        assert_eq!(cp_mode_order_for("234", "15"), "dual,v6,v4");
        assert_eq!(cp_mode_order_for("234", "015"), "dual,v6,v4");
        assert_eq!(cp_mode_order_for("262", "03"), "v6,dual,v4");
    }

    #[test]
    fn pani() {
        let inst = Instance { mcc: "234".into(), ..Default::default() };
        assert_eq!(build_pani(&inst, &Sip::default()), "IEEE-802.11;country=GB");
        let sip = Sip { pani_node_id_enable: Some(true), pani_node_id: Some("AA:BB:CC:DD:EE:FF".into()),
                        pani_country_enable: Some(false), ..Default::default() };
        assert_eq!(build_pani(&inst, &sip), "IEEE-802.11;i-wlan-node-id=aabbccddeeff");
    }

    #[test]
    fn ports_manual_offsets() {
        let b0 = alloc_ports(0);
        assert_eq!(b0.ami, 5038);
        let b3 = alloc_ports(3);
        assert_eq!((b3.sip_udp, b3.webrtc, b3.ami, b3.rtp_start), (5090, 8119, 5068, 16000));
    }

    #[test]
    fn lenient_instance() {
        let v = json!({"id": 1, "mcc": 234, "mnc": "15", "imsi": "234150000000000",
                       "reader_index": "2", "enabled": "false", "rekey_minutes": "",
                       "ports": {"sip_udp": 5070}, "custom_key": [1, 2],
                       "sip": {"external": [{"username": "a", "password": "p", "x": 1}, "junk"]}});
        let i: Instance = serde_json::from_value(v).unwrap();
        assert_eq!(i.id, "1");
        assert_eq!(i.mcc, "234");
        assert_eq!(i.reader_index, Some(2));
        assert_eq!(i.enabled, Some(false));
        assert_eq!(i.rekey_minutes, None);
        assert_eq!(i.ports.unwrap().sip_udp, 5070);
        assert_eq!(i.ports.unwrap().ami, 5038);
        assert_eq!(i.extra.get("custom_key"), Some(&json!([1, 2])));
        let ext = i.sip().external.unwrap();
        assert_eq!(ext.len(), 1);
        assert_eq!(ext[0].extra.get("x"), Some(&json!(1)));
    }

    #[test]
    fn settings_defaults_fill() {
        let s: Settings = serde_json::from_value(json!({"retry": {"max": "5"}, "telegram": null,
                                                        "webhook": {"events": {"incoming_sms": false}}}))
            .unwrap();
        assert_eq!(s.retry.max, 5);
        assert_eq!(s.retry.interval, 30);
        assert!(s.retry.auto_recover);
        assert!(!s.webhook.events.incoming_sms);
        assert!(s.webhook.events.incoming_call);
        assert_eq!(s.http_port, 8443);
        assert_eq!(s.esim.download_timeout_s(), 300);
    }
}
