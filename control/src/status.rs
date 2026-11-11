//! status.rs - Per-instance status state machine with failure classification.
//!
//! `compute` returns a live snapshot {state, label, reason_code, reason, detail}. The hub's
//! health tracker (hub.rs `apply_health`) overlays retry counters and, on exhaustion, an ERROR
//! state (network-class freezes auto re-provision once the ePDG resolves again).
//!
//! States (the WebUI depends on these names):
//!   STOPPED, NO_CARD, PIN_PROBLEM, EPDG_UNRESOLVED, TUNNEL_DOWN, REGISTERING, OK (+ ERROR)
//! reason_code: machine key for the WebUI; reason: a user-facing sentence.
//! detail:      raw signals (pin, pcscf, registration, ike classification) for the advanced view.
use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::ami::AmiClient;
use crate::config::Instance;
use crate::engine;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum State {
    Stopped,
    NoCard,
    PinProblem,
    EpdgUnresolved,
    TunnelDown,
    Registering,
    Ok,
    Error,
}

impl State {
    pub fn label(self) -> &'static str {
        match self {
            State::Stopped => "Stopped",
            State::NoCard => "No SIM card",
            State::PinProblem => "PIN error",
            State::EpdgUnresolved => "Cannot resolve ePDG",
            State::TunnelDown => "Establishing VoWiFi tunnel",
            State::Registering => "Registering to IMS",
            State::Ok => "Working",
            State::Error => "Failed",
        }
    }
}

/// reason_code -> user-facing message.
pub fn reason(code: &str) -> &'static str {
    match code {
        "no_card" => "No SIM card detected in the reader.",
        "pin_wrong" => "SIM PIN is incorrect.",
        "pin_blocked" => "SIM PIN is blocked — PUK required.",
        "epdg_unresolved" => "Can't resolve the carrier's VoWiFi (ePDG) address — the carrier may \
                              not support Wi-Fi Calling, or check DNS / internet connectivity.",
        "tunnel_network" => "Can't establish the VoWiFi tunnel — network problem (no response from \
                             the carrier's ePDG).",
        "tunnel_sim_auth" => "Can't establish the VoWiFi tunnel — SIM authentication (EAP-AKA) was \
                              rejected by the carrier.",
        "tunnel_not_authorized" => "Can't establish the VoWiFi tunnel — the carrier's ePDG refused the \
                                    identity before checking the SIM. The line is likely not provisioned \
                                    for Wi-Fi Calling, or the ePDG blocks connections from this network/region.",
        "tunnel_proposal" => "Can't establish the VoWiFi tunnel — the carrier rejected the encryption \
                              settings (IKE proposal).",
        "tunnel_setup" => "Establishing the VoWiFi (IPsec/ePDG) tunnel…",
        "registering" => "VoWiFi tunnel is up — registering to the carrier's IMS…",
        "reg_rejected" => "Can't register to the carrier's IMS (authentication or provisioning issue).",
        "ims_rejected" => "The carrier's IMS accepted the registration but then removed it again \
                           (network-initiated, reg event) — calls and SMS won't work. The carrier \
                           likely refuses this device or client for Wi-Fi Calling.",
        "ok" => "Working — connected to the carrier over Wi-Fi.",
        _ => "",
    }
}

/// A status snapshot (serialised flat into the WebSocket `status` message and the API).
#[derive(Debug, Clone, Serialize)]
pub struct Status {
    pub state: State,
    pub label: &'static str,
    pub reason_code: Option<String>,
    pub reason: Option<String>,
    pub detail: Map<String, Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frozen: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retrying_network: Option<bool>,
}

impl Status {
    fn new(state: State, code: &str, detail: Map<String, Value>) -> Self {
        Status { state, label: state.label(), reason_code: Some(code.into()),
                 reason: Some(reason(code).into()), detail, retry: None, frozen: None,
                 retrying_network: None }
    }

    pub fn code(&self) -> &str {
        self.reason_code.as_deref().unwrap_or("")
    }

    pub fn to_json(&self) -> Map<String, Value> {
        match serde_json::to_value(self) {
            Ok(Value::Object(m)) => m,
            _ => Map::new(),
        }
    }
}

pub async fn resolve_epdg(fqdn: &str) -> bool {
    tokio::net::lookup_host((fqdn, 0)).await.map(|mut a| a.next().is_some()).unwrap_or(false)
}

/// Why isn't the tunnel up? Classified from the recent IKE log + the USIM bridge status.
pub fn classify_ike(iid: &str) -> &'static str {
    let low = engine::charon_log(iid, 400).to_lowercase();
    let usim = engine::usim_status(iid);
    let has = |needles: &[&str]| needles.iter().any(|n| low.contains(n));
    // ePDG refused the IKE_AUTH identity BEFORE any EAP-AKA challenge (SIM never queried): an
    // authorization/subscription/geo decision, not a SIM fault. swu_ike logs a clear marker.
    if has(&["before any eap-aka challenge", "authentication_failed before", "not provisioned for vowifi"]) {
        return "tunnel_not_authorized";
    }
    let usim_state = usim.get("state").and_then(Value::as_str).unwrap_or("");
    if ["AUTH_FAIL", "PIN_FAIL", "NO_CARD"].contains(&usim_state)
        || has(&["eap_aka failed", "eap-aka failed", "authentication_failed", "eap method eap_aka fail",
                 "received auth_failed", "authentication failed"])
    {
        return "tunnel_sim_auth";
    }
    if has(&["invalid_syntax", "no_proposal_chosen", "invalid_ke", "no proposal"]) {
        return "tunnel_proposal";
    }
    if has(&["retransmit", "giving up", "no route", "destination unreachable", "timeout"]) {
        return "tunnel_network";
    }
    "tunnel_setup"
}

pub async fn compute(inst: &Instance, ami: Option<&AmiClient>) -> Status {
    let iid = inst.id.as_str();
    let opt = |v: &Option<String>| v.as_deref().filter(|s| !s.is_empty()).map(|s| json!(s)).unwrap_or(Value::Null);
    let mut detail = Map::new();
    detail.insert("msisdn".into(), opt(&inst.msisdn));
    detail.insert("smsc".into(), opt(&inst.smsc));
    detail.insert("iccid".into(), opt(&inst.iccid));

    if !inst.enabled() || !engine::is_running(iid).await {
        let mut s = Status::new(State::Stopped, "stopped", detail);
        s.reason = Some("Stopped.".into());
        return s;
    }

    let pin = engine::read_run_json(iid, "pin_status.json").unwrap_or_else(|| json!({}));
    let pstate = pin.get("state").and_then(Value::as_str).map(String::from);
    detail.insert("pin".into(), pin);
    match pstate.as_deref() {
        None | Some("NO_CARD") => return Status::new(State::NoCard, "no_card", detail),
        Some("WRONG_PIN") => return Status::new(State::PinProblem, "pin_wrong", detail),
        Some("PIN_BLOCKED") => return Status::new(State::PinProblem, "pin_blocked", detail),
        _ => {}
    }

    if !resolve_epdg(&inst.epdg_fqdn()).await {
        return Status::new(State::EpdgUnresolved, "epdg_unresolved", detail);
    }

    if !engine::tunnel_installed(iid) {
        let code = classify_ike(iid);
        detail.insert("ike_reason".into(), json!(code));
        return Status::new(State::TunnelDown, code, detail);
    }

    detail.insert("pcscf".into(), engine::read_pcscf(iid).map(Value::String).unwrap_or(Value::Null));
    let reg = match ami {
        Some(a) => a.registration_state().await,
        None => "unknown".into(),
    };
    detail.insert("registration".into(), json!(reg));
    match reg.as_str() {
        "Registered" => {
            // Asterisk keeps "Registered" after the network terminated the registration; the
            // reg-event NOTIFY state (stored by the engine) is authoritative.
            let reginfo = match ami {
                Some(a) => a.reginfo_state().await,
                None => String::new(),
            };
            if !reginfo.is_empty() {
                detail.insert("reg_event".into(), json!(reginfo));
            }
            if reginfo.starts_with("terminated") {
                Status::new(State::Registering, "ims_rejected", detail)
            } else {
                Status::new(State::Ok, "ok", detail)
            }
        }
        "Rejected" => Status::new(State::Registering, "reg_rejected", detail),
        _ => Status::new(State::Registering, "registering", detail),
    }
}
