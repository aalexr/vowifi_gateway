//! api/sim.rs - Readers, SIM detection, PIN management, the live card table and provisioning.
use axum::extract::State;
use serde_json::{Map, Value, json};

use super::{ApiError, ApiResult, AppState, Body, Q, ok, q_int};
use crate::config::{self, CfgError};
use crate::hub::{CardEntry, blocking};
use crate::{card, engine, sim as simio, usbreader};

pub async fn readers() -> ApiResult {
    ok(json!({"readers": blocking(card::list_readers).await}))
}

pub async fn detect(State(hub): State<AppState>, q: Q) -> ApiResult {
    let idx = q_int(&q, "reader_index", 0)?;
    let rlist = blocking(card::list_readers).await;
    let Some(name) = usize::try_from(idx).ok().and_then(|i| rlist.get(i).cloned()) else {
        return Err(ApiError::new(400, "reader index out of range"));
    };
    let l = hub.reader_lock(&name);
    let _g = l.lock().await;
    let info = blocking(move || simio::read_card(idx as usize, None)).await;
    ok(serde_json::to_value(info).map_err(anyhow::Error::from)?)
}

/// The target reader of an index-taking SIM API. When the caller names the reader, the index
/// is re-resolved now: indices shift on unplug, and a UI-cached index could point at ANOTHER
/// physical reader (and e.g. burn a PIN try on the wrong SIM).
pub async fn resolve_reader_index(body: &Body) -> ApiResult<(usize, String)> {
    let idx = crate::lenient::or(body.get("reader_index"), 0i64);
    let rlist = blocking(card::list_readers).await;
    if let Some(rname) = body.str("reader") {
        return match rlist.iter().position(|r| *r == rname) {
            Some(i) => Ok((i, rname)),
            None => Err(ApiError::new(409, format!("reader '{rname}' is no longer connected"))),
        };
    }
    let idx = usize::try_from(idx).map_err(|_| ApiError::new(400, "reader index out of range"))?;
    let name = rlist.get(idx).cloned().unwrap_or_else(|| format!("idx:{idx}"));
    Ok((idx, name))
}

pub async fn verify_pin(State(hub): State<AppState>, body: Body) -> ApiResult {
    let (idx, name) = resolve_reader_index(&body).await?;
    let pin = body.req_str("pin")?;
    let l = hub.reader_lock(&name);
    let _g = l.lock().await;
    let mut res = blocking({ let p = pin.clone(); move || simio::verify_pin(&p, idx) }).await;
    if res.get("ok") == Some(&json!(true)) {
        // PIN satisfied: re-read the (previously locked) IMSI + SMSC so the dashboard can move
        // from "locked" to "ready to provision". Keyed strictly by the reader NAME the read
        // used, never merged into another reader's entry.
        let c = blocking(move || simio::read_card(idx, Some(&pin))).await;
        if !c.reader.is_empty() {
            let mut entry = hub.card(&c.reader).unwrap_or(CardEntry {
                index: Some(idx), name: c.reader.clone(), present: true, ..Default::default()
            });
            entry.apply(&c);
            entry.matched = config::instance_by_iccid(c.iccid.as_deref()).map(|i| i.id);
            hub.set_card(entry.clone());
            res["card"] = serde_json::to_value(entry).map_err(anyhow::Error::from)?;
            hub.broadcast_cards();
        }
    }
    ok(res)
}

pub async fn change_pin(State(hub): State<AppState>, body: Body) -> ApiResult {
    let (idx, name) = resolve_reader_index(&body).await?;
    let (old, new) = (body.req_str("old")?, body.req_str("new")?);
    let l = hub.reader_lock(&name);
    let _g = l.lock().await;
    ok(blocking(move || simio::change_pin(&old, &new, idx)).await)
}

pub async fn pin_enabled(State(hub): State<AppState>, body: Body) -> ApiResult {
    let (idx, name) = resolve_reader_index(&body).await?;
    let pin = body.req_str("pin")?;
    let Some(enabled) = body.get("enabled") else { return Err(ApiError::new(422, "field required: enabled")) };
    let enabled = crate::lenient::truthy(Some(enabled));
    let l = hub.reader_lock(&name);
    let _g = l.lock().await;
    ok(blocking(move || simio::set_pin_enabled(&pin, enabled, idx)).await)
}

/// Physically detected readers/cards (from the live monitor).
pub async fn cards(State(hub): State<AppState>) -> ApiResult {
    if !hub.scanned.load(std::sync::atomic::Ordering::SeqCst) {
        // The monitor's first scan hasn't finished (manager just started): answer from a live
        // reader scan so the UI never flashes "no readers". Present cards are mapped to running
        // engines by pin_status reader name (no card access).
        let mut out = Vec::new();
        for st in blocking(card::reader_states).await.unwrap_or_default() {
            let inst = if st.present { hub.find_running_by_reader(&st.name).await } else { None };
            out.push(CardEntry {
                index: Some(st.index), name: st.name, present: st.present,
                iccid: inst.as_ref().and_then(|i| i.iccid.clone()),
                imsi: inst.as_ref().map(|i| i.imsi.clone()),
                matched: inst.map(|i| i.id),
                ..Default::default()
            });
        }
        return ok(json!({"cards": out}));
    }
    hub.refresh_card_matches();
    ok(json!({"cards": hub.cards_list()}))
}

/// Preview the SIP port the automatic allocator would pick for a NEW line right now.
pub async fn ports_suggest() -> ApiResult {
    match blocking(|| config::alloc_ports_auto(None)).await {
        Ok(b) => ok(json!({"auto_sip_udp": b.sip_udp, "auto_sip_tls": b.sip_tls,
                           "min": config::MIN_USER_PORT, "max": config::MAX_USER_PORT})),
        Err(e) => Err(ApiError::new(409, format!("no free port block: {e}"))),
    }
}

/// Map an upsert failure to the WebUI's structured 400.
pub fn upsert_error(e: CfgError) -> ApiError {
    match e {
        CfgError::Invalid(message) => {
            let code = if message.contains("more than once") || message.contains("reserved") {
                "duplicate_sip_username"
            } else if message.contains("ims_codecs") || message.contains("carrier codec") {
                "invalid_ims_codecs"
            } else {
                "invalid_sip_account"
            };
            ApiError::new(400, json!({"code": code, "message": message}))
        }
        CfgError::Other(e) => e.into(),
    }
}

/// A free id for a new line: the next number after the line count, skipping ids in use (so
/// a gap from a deleted line can't make a new provision overwrite an existing one).
fn new_instance_id() -> String {
    let used: std::collections::HashSet<String> = config::list_instances().into_iter().map(|i| i.id).collect();
    (used.len() + 1..).map(|n| n.to_string()).find(|id| !used.contains(id)).unwrap_or_else(|| "1".into())
}

/// Provision a detected card: verify the PIN, read the identity, create the line and start it.
/// Required: pin (if enabled), imei. Optional: imeisv (derived when blank), name, smsc,
/// reader_index / reader, sip, webrtc, id, port_mode ('auto'|'manual') + sip_port, apn,
/// idr_mode, cp_mode, msisdn, debug.
pub async fn provision(State(hub): State<AppState>, body: Body) -> ApiResult {
    let (idx, rname) = resolve_reader_index(&body).await?;
    let pin = body.str("pin");
    let c = {
        let l = hub.reader_lock(&rname);
        let _g = l.lock().await;
        let p = pin.clone();
        blocking(move || simio::read_card(idx, p.as_deref())).await
    };
    if c.pin_error() {
        return Err(ApiError::new(400, format!("PIN error: {} ({} tries left)",
                                              c.error.clone().unwrap_or_default(),
                                              c.pin_tries.map(|t| t.to_string()).unwrap_or_else(|| "None".into()))));
    }
    let Some(imsi) = c.imsi.clone() else {
        return Err(ApiError::new(400, "could not read IMSI (is the PIN correct?)"));
    };
    let mut sip = match body.get("sip") {
        Some(Value::Object(m)) if !m.is_empty() => m.clone(),
        _ => json!({"listen_addr": "0.0.0.0", "transport": "udp", "external": []}).as_object().cloned().unwrap_or_default(),
    };
    let webrtc_enable = body.get("webrtc").map(|v| crate::lenient::truthy(Some(v))).unwrap_or(true);
    sip.entry("webrtc").or_insert(json!({"enable": webrtc_enable}));
    config::validate_sip_value(Some(&Value::Object(sip.clone())))
        .map_err(|e| ApiError::new(400, json!({"code": "duplicate_sip_username", "message": e.to_string()})))?;
    // SMSC: a manual value wins; else EF_SMSP from the SIM. No carrier presets: ask the user.
    let smsc = body.str("smsc").map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).or(c.smsc.clone());
    let Some(smsc) = smsc else {
        return Err(ApiError::new(422, "smsc_unreadable: could not read the SMS centre from the SIM — \
                                       please provide it manually."));
    };
    let mcc = c.mcc.clone().unwrap_or_default();
    let mnc = c.mnc.clone().unwrap_or_default();
    let iid = body.str("id").unwrap_or_else(new_instance_id);
    let imei = body.str("imei").unwrap_or_default();
    // IMEISV for DEVICE_IDENTITY: the user's value, else the IMEI base + a random 2-digit SVN
    // (each line looks like a distinct handset build).
    let imeisv = body.str("imeisv").map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
        .unwrap_or_else(|| config::imeisv_from_imei(&imei, "", &format!("{:02}", rand::random_range(0..100))));
    let reader_port = match c.reader_port.clone() {
        Some(p) => p,
        None => blocking(move || usbreader::port_for_index(idx)).await.unwrap_or_default(),
    };
    let mut inst = Map::new();
    inst.insert("id".into(), json!(iid));
    inst.insert("name".into(), json!(body.str("name").unwrap_or_else(|| format!("{mcc}-{mnc}"))));
    inst.insert("imsi".into(), json!(imsi));
    inst.insert("mcc".into(), json!(mcc));
    inst.insert("mnc".into(), json!(mnc));
    inst.insert("iccid".into(), json!(c.iccid.clone().unwrap_or_default()));
    inst.insert("imei".into(), json!(imei));
    inst.insert("imeisv".into(), json!(imeisv));
    inst.insert("pin".into(), json!(pin.clone().unwrap_or_default()));
    inst.insert("reader".into(), json!(format!("imsi:{imsi}")));
    inst.insert("reader_index".into(), json!(idx));
    // Primary reader binding at start time (resolved back to a live index): sticks to the
    // physical socket even when pcscd swaps two identical readers.
    inst.insert("reader_port".into(), json!(reader_port));
    inst.insert("smsc".into(), json!(smsc));
    inst.insert("msisdn".into(), json!(body.str("msisdn").unwrap_or_default()));
    inst.insert("enabled".into(), json!(true));
    inst.insert("sip".into(), Value::Object(sip));
    inst.insert("apn".into(), json!(config::normalize_apn(&body.str("apn").unwrap_or_default())));
    inst.insert("idr_mode".into(), json!(config::normalize_idr_mode(&body.str("idr_mode").unwrap_or_default())));
    inst.insert("cp_mode".into(), json!(config::normalize_cp_mode(&body.str("cp_mode").unwrap_or_default())));
    // A per-line `debug` overrides Settings → debug defaults, so only store one the request
    // carries; otherwise the line keeps what it has (upsert merges) or follows the defaults.
    if let Some(d) = body.get("debug").filter(|d| crate::lenient::truthy(Some(d))) {
        inst.insert("debug".into(), d.clone());
    }
    // Port mapping: 'manual' pins the user's SIP UDP port (rest of the block derived from it);
    // 'auto' (default) allocates a conflict-free block now, re-allocating on re-provision so
    // switching a line back to Auto really moves it off a manual port.
    let manual = body.str("port_mode").as_deref() == Some("manual");
    let sip_port = crate::lenient::or(body.get("sip_port"), 0i64);
    let id2 = iid.clone();
    let ports = blocking(move || if manual {
        config::ports_from_sip_base(sip_port, Some(&id2))
    } else {
        config::alloc_ports_auto(Some(&id2))
    }).await.map_err(|e| ApiError::new(422, format!("port_error: {e}")))?;
    inst.insert("ports".into(), serde_json::to_value(ports).map_err(anyhow::Error::from)?);
    let inst = blocking(move || config::upsert_instance(inst)).await.map_err(upsert_error)?;
    hub.forget_msisdn_tries(&inst.id);
    hub.reset_health(&inst.id);
    // engine::start force-removes any old container: retire AMI first so a cached client
    // can't keep logging in to the old engine with a stale secret.
    hub.drop_ami(&inst.id).await;
    engine::start(&inst, &config::get_settings()).await?;
    hub.refresh_card_matches();
    hub.broadcast_cards();
    ok(json!({"ok": true, "instance": inst.public_json()}))
}
