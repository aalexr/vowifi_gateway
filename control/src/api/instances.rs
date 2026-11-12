//! api/instances.rs - Settings, line lifecycle (start/stop/reprovision), logs, SMS, calls and
//! the softphone / SIP-client provisioning endpoints.
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::{Path, State};
use axum::http::HeaderMap;
use serde_json::{Map, Value, json};

use super::{ApiError, ApiResult, AppState, Body, Q, ok, q_int, request_host};
use super::sim::upsert_error;
use crate::config::{self, CfgError, Instance};
use crate::hub::{Preflight, blocking};
use crate::{engine, sim, store};

fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn instance_or_404(iid: &str) -> ApiResult<Instance> {
    config::get_instance(iid).ok_or_else(|| ApiError::new(404, "no such instance"))
}

// --------------------------------------------------------------------------------- settings
pub async fn get_settings() -> ApiResult {
    ok(blocking(config::public_settings).await)
}

pub async fn put_settings(body: Body) -> ApiResult {
    match blocking(move || config::update_settings(body.0)).await {
        Ok(v) => ok(v),
        Err(CfgError::Invalid(m)) => Err(ApiError::new(400, json!({"code": "invalid_settings", "message": m}))),
        Err(CfgError::Other(e)) => Err(e.into()),
    }
}

// -------------------------------------------------------------------------------- instances
pub async fn list(State(hub): State<AppState>) -> ApiResult {
    let mut out = Vec::new();
    for inst in config::list_instances() {
        let st = hub.status_for(&inst).await;
        let mut safe = inst.public_json();
        safe.insert("has_pin".into(), json!(inst.has_pin()));
        // The reader index that PHYSICALLY holds this SIM now (indices shift on unplug; a
        // stale one would make "Detect card" probe a reader that no longer exists), and the
        // SIM's current USB port.
        if let Some(idx) = hub.reader_index_for_instance(&inst).await {
            safe.insert("reader_index".into(), json!(idx));
        }
        if let Some(port) = hub.reader_port_for_instance(&inst) {
            safe.insert("reader_port".into(), json!(port));
        }
        safe.insert("id".into(), json!(inst.id));
        safe.insert("status".into(), Value::Object(st.to_json()));
        out.push(Value::Object(safe));
    }
    ok(json!({"instances": out}))
}

/// Persist configuration without recreating a running engine (the live container keeps its
/// rendered config until Stop -> Start, avoiding an unexpected IMS interruption).
pub async fn upsert(body: Body) -> ApiResult {
    let Some(id) = body.str("id") else { return Err(ApiError::new(400, "id required")) };
    if body.0.contains_key("sip") {
        config::validate_sip_value(body.get("sip"))
            .map_err(|e| ApiError::new(400, json!({"code": "duplicate_sip_username", "message": e.to_string()})))?;
    }
    let was_running = engine::is_running(&id).await;
    let inst = blocking(move || config::upsert_instance(body.0)).await.map_err(upsert_error)?;
    let mut safe = inst.public_json();
    safe.insert("restart_required".into(), json!(was_running));
    safe.insert("applied".into(), json!(false)); // compatibility with older WebUI clients
    ok(Value::Object(safe))
}

pub async fn remove(State(hub): State<AppState>, Path(iid): Path<String>) -> ApiResult {
    engine::stop(&iid).await?;
    hub.drop_ami(&iid).await;
    blocking({ let id = iid.clone(); move || config::delete_instance(&id) }).await?;
    hub.refresh_card_matches();
    hub.broadcast_cards();
    ok(json!({"ok": true}))
}

fn card_mismatch_error(inst: &Instance, reader: &str, iccid: &str) -> ApiError {
    let line = inst.iccid.clone().unwrap_or_default();
    // Name the line that card belongs to, when it is one of ours (SIMs swapped between lines).
    let owner = config::instance_by_iccid(Some(iccid)).filter(|o| o.id != inst.id);
    let message = match &owner {
        Some(o) => {
            let who = o.name.as_deref().filter(|n| !n.is_empty()).unwrap_or(&o.id);
            format!("{reader} holds the SIM of line {who} (ICCID {iccid}), not this line's (ICCID {line}). \
                     Insert this line's SIM — any reader will do — then start again.")
        }
        None => format!("The card in {reader} now has a different identity (ICCID {iccid}; this line \
                         expects {line}): another SIM was inserted, or the eSIM profile was switched. Insert \
                         this line's SIM, provision the active profile as its own line, or switch the eSIM \
                         back to this profile, then start again."),
    };
    ApiError::new(409, json!({
        "code": "card_mismatch",
        "reader": reader,
        "card_iccid": iccid,
        "line_iccid": line,
        "card_line": owner.as_ref().map(|o| o.id.clone()),
        "message": message,
    }))
}

/// The common tail of Start / Re-provision: identity check, PIN preflight, reader rebind,
/// state reset, (re)create the engine.
async fn launch(hub: &AppState, mut inst: Instance) -> ApiResult {
    let iid = inst.id.clone();
    // eSIM-profile-switch guard: EAP-AKA with a mismatched IMSI/keys is guaranteed to be
    // rejected (and could burn PIN tries on the wrong profile).
    if let Some((reader, iccid)) = hub.card_identity_mismatch(&inst).await {
        return Err(card_mismatch_error(&inst, &reader, &iccid));
    }
    // Follow the SIM to the reader it sits in NOW before the PIN preflight: preflight addresses
    // the saved USB port first, which after a move may hold another line's card.
    inst = hub.rebind_reader(inst, "start").await?;
    if let Preflight::Fail { code, clear, tries } = hub.preflight_pin(&inst).await {
        if clear {
            // Stale saved PIN: force re-entry next time.
            blocking({ let id = iid.clone(); move || config::clear_pin(&id) }).await;
        }
        return Err(ApiError::new(409, json!({"code": code, "tries": tries})));
    }
    hub.forget_msisdn_tries(&iid);
    hub.reset_health(&iid);
    // engine::start recreates the container: the cached AMI client is stale.
    hub.drop_ami(&iid).await;
    let cid = engine::start(&inst, &config::get_settings()).await?;
    hub.spawn_push_status(&iid);
    ok(json!({"ok": true, "container": cid}))
}

/// Start (or restart) a line. The SIM PIN state is checked first: with a PIN required and no
/// valid saved one, the start is refused with a structured error so the UI can prompt — the
/// IPsec/IMS engine never comes up against a locked card. A PIN in the body (re-entry) is
/// verified, saved, and used.
pub async fn start(State(hub): State<AppState>, Path(iid): Path<String>, body: Body) -> ApiResult {
    let mut inst = instance_or_404(&iid)?;
    if let Some((reader, iccid)) = hub.card_identity_mismatch(&inst).await {
        return Err(card_mismatch_error(&inst, &reader, &iccid));
    }
    if let Some(supplied) = body.str("pin") {
        if let Some(idx) = hub.reader_index_for_instance(&inst).await {
            let name = blocking(crate::card::list_readers).await.into_iter().nth(idx)
                .unwrap_or_else(|| format!("idx:{idx}"));
            let l = hub.reader_lock(&name);
            let _g = l.lock().await;
            let p = supplied.clone();
            let chk = blocking(move || sim::read_card(idx, Some(&p))).await;
            if chk.pin_error() {
                let tries = chk.pin_tries.map(|t| format!(" ({t} tries left)")).unwrap_or_default();
                return Err(ApiError::new(400, format!("PIN error: {}{tries}", chk.error.unwrap_or_default())));
            }
        }
        let mut patch = Map::new();
        patch.insert("id".into(), json!(iid));
        patch.insert("pin".into(), json!(supplied));
        inst = blocking(move || config::upsert_instance(patch)).await.map_err(upsert_error)?;
    }
    launch(&hub, inst).await
}

/// Manual re-provision: reset retry state and re-establish the line from the stored config.
/// An optional body overrides fields (e.g. sip.user_agent) before the restart.
pub async fn reprovision(State(hub): State<AppState>, Path(iid): Path<String>, body: Body) -> ApiResult {
    let mut inst = instance_or_404(&iid)?;
    if !body.0.is_empty() {
        let mut patch = body.0;
        patch.insert("id".into(), json!(iid));
        inst = blocking(move || config::upsert_instance(patch)).await.map_err(upsert_error)?;
    }
    launch(&hub, inst).await
}

/// Delete the saved SIM PIN. A running line is stopped: the next start must re-run the PIN
/// flow (the point of forgetting the PIN).
pub async fn clear_pin(State(hub): State<AppState>, Path(iid): Path<String>) -> ApiResult {
    instance_or_404(&iid)?;
    let had = blocking({ let id = iid.clone(); move || config::clear_pin(&id) }).await;
    if engine::is_running(&iid).await {
        engine::stop(&iid).await?;
        hub.drop_ami(&iid).await;
        hub.spawn_push_status(&iid);
    }
    ok(json!({"ok": true, "had_pin": had}))
}

pub async fn stop(State(hub): State<AppState>, Path(iid): Path<String>) -> ApiResult {
    engine::stop(&iid).await?;
    // The AMI client must go too, or it keeps dialing a removed container.
    hub.drop_ami(&iid).await;
    ok(json!({"ok": true}))
}

pub async fn status(State(hub): State<AppState>, Path(iid): Path<String>) -> ApiResult {
    let inst = instance_or_404(&iid)?;
    ok(Value::Object(hub.status_for(&inst).await.to_json()))
}

pub async fn logs(Path(iid): Path<String>, q: Q) -> ApiResult {
    let tail = q_int(&q, "tail", 200)?.clamp(0, 100_000) as usize;
    let engine_log = engine::logs(&iid, tail, None).await;
    let charon = engine::run_text_tail(&iid, "charon.log", 200);
    ok(json!({"engine": engine_log, "charon": charon}))
}

pub async fn register(Path(iid): Path<String>) -> ApiResult {
    ok(json!({"output": engine::exec_cli(&iid, "pjsip send register volte_ims").await}))
}

// -------------------------------------------------------------------------------------- SMS
pub async fn threads(Path(iid): Path<String>) -> ApiResult {
    ok(json!({"threads": blocking(move || store::list_threads(&iid)).await?}))
}

pub async fn messages(Path((iid, peer)): Path<(String, String)>) -> ApiResult {
    ok(json!({"messages": blocking(move || store::list_messages(&iid, &peer, 200)).await?}))
}

fn ids(v: &Value) -> ApiResult<Vec<i64>> {
    v.as_array().map(Vec::as_slice).unwrap_or(&[]).iter()
        .map(|x| crate::lenient::FromLenient::from_lenient(x).ok_or_else(|| ApiError::new(422, "ids must be integers")))
        .collect()
}

/// {ids:[...]} for specific messages, {peer:"..."} for one conversation, {all:true} for all.
pub async fn messages_delete(State(hub): State<AppState>, Path(iid): Path<String>, body: Body) -> ApiResult {
    let id = iid.clone();
    let n = if crate::lenient::truthy(body.get("all")) {
        blocking(move || store::clear_messages(&id)).await?
    } else if let Some(peer) = body.get("peer") {
        let peer = crate::lenient::string(Some(peer));
        blocking(move || store::delete_thread(&id, &peer)).await?
    } else if crate::lenient::truthy(body.get("ids")) {
        let list = ids(body.get("ids").unwrap_or(&Value::Null))?;
        blocking(move || store::delete_messages(&id, &list)).await?
    } else {
        return Err(ApiError::new(400, "provide ids, peer, or all"));
    };
    hub.broadcast(json!({"type": "sms", "instance": iid, "deleted": n}));
    ok(json!({"ok": true, "deleted": n}))
}

pub async fn sms_send(State(hub): State<AppState>, Path(iid): Path<String>, body: Body) -> ApiResult {
    let to = body.req_str("to")?;
    let text = body.req_str("body")?;
    let Some(ami) = hub.ami_for(&iid).await else {
        return Err(ApiError::new(409, "Line is not running / control channel unavailable."));
    };
    let since = now();
    let mut rec = blocking({ let (i, t, b) = (iid.clone(), to.clone(), text.clone());
                             move || store::add_message(&i, "out", &t, &b, "pending") }).await?;
    let res = ami.send_sms(&to, &text).await;
    if res.get("ok") != Some(&json!(true)) {
        // Asterisk itself refused to dispatch (endpoint down, bad address...): final failure.
        let err = [res.get("detail"), res.get("error")].into_iter().flatten()
            .filter_map(Value::as_str).find(|s| !s.is_empty())
            .unwrap_or("Send rejected by the line.").to_string();
        let (mid, e) = (rec.id, err.clone());
        blocking(move || store::set_message_status(mid, "failed", Some(&e))).await?;
        rec.status = Some("failed".into());
        rec.error = Some(err.clone());
        hub.broadcast(json!({"type": "sms", "instance": iid, "message": rec}));
        return ok(json!({"ok": false, "message": rec, "error": err}));
    }
    // The IMS accepted the MESSAGE (SIP 202). NOT delivery: mark 'sent' and resolve the real
    // outcome from the SMSC's RP submit report in the background.
    let mid = rec.id;
    blocking(move || store::set_message_status(mid, "sent", None)).await?;
    rec.status = Some("sent".into());
    rec.error = None;
    hub.broadcast(json!({"type": "sms", "instance": iid, "message": rec}));
    let h = hub.clone();
    tokio::spawn(async move { super::events::watch_sms_delivery(h, iid, rec.id, since).await });
    ok(json!({"ok": true, "message": rec, "error": null, "pending_delivery": true}))
}

// ------------------------------------------------------------------------------------ calls
pub async fn calls(Path(iid): Path<String>) -> ApiResult {
    ok(json!({"calls": blocking(move || store::list_calls(&iid, 100)).await?}))
}

/// The codecs this line's carrier has shown in the logged calls (store::carrier_codecs_seen).
pub async fn carrier_codecs(Path(iid): Path<String>) -> ApiResult {
    ok(json!(blocking(move || store::carrier_codecs_seen(&iid)).await?))
}

/// {ids:[...]} for specific calls or {all:true} for the whole log.
pub async fn calls_delete(State(hub): State<AppState>, Path(iid): Path<String>, body: Body) -> ApiResult {
    let id = iid.clone();
    let n = if crate::lenient::truthy(body.get("all")) {
        blocking(move || store::clear_calls(&id)).await?
    } else if crate::lenient::truthy(body.get("ids")) {
        let list = ids(body.get("ids").unwrap_or(&Value::Null))?;
        blocking(move || store::delete_calls(&id, &list)).await?
    } else {
        return Err(ApiError::new(400, "provide ids or all"));
    };
    hub.broadcast(json!({"type": "call", "instance": iid, "deleted": n}));
    ok(json!({"ok": true, "deleted": n}))
}

pub async fn call(State(hub): State<AppState>, Path(iid): Path<String>, body: Body) -> ApiResult {
    let to = body.req_str("to")?;
    let Some(ami) = hub.ami_for(&iid).await else { return Err(ApiError::new(409, "instance not running")) };
    let from = body.str("from_endpoint").unwrap_or_else(|| "webrtc".into());
    let res = ami.originate(&to, &from).await;
    blocking(move || store::add_call(&iid, "out", &to, "ringing")).await?;
    ok(res)
}

pub async fn hangup(State(hub): State<AppState>, Path(iid): Path<String>) -> ApiResult {
    let Some(ami) = hub.ami_for(&iid).await else { return Err(ApiError::new(409, "instance not running")) };
    ok(ami.hangup_all().await)
}

/// Provisioning for the browser softphone (JsSIP over WSS).
pub async fn softphone(Path(iid): Path<String>, headers: HeaderMap) -> ApiResult {
    let inst = instance_or_404(&iid)?;
    let wr = inst.sip().webrtc.unwrap_or_default();
    ok(json!({
        "enabled": wr.enable.unwrap_or(true),
        "username": wr.username.as_deref().unwrap_or("webrtc"),
        "password": wr.password.as_deref().unwrap_or(""),
        "ws_port": inst.ports.map(|p| p.webrtc).unwrap_or(8089),
        "host": request_host(&headers),
        "realm": inst.realm(),
    }))
}

/// Connection parameters for a standard (non-WebRTC) SIP client: one Asterisk endpoint per
/// sip.external[] account; the client registers to this host's published SIP port and dials
/// E.164 numbers, which go out over IMS.
pub async fn sipinfo(Path(iid): Path<String>, headers: HeaderMap) -> ApiResult {
    let inst = instance_or_404(&iid)?;
    let sip = inst.sip();
    let transport = sip.transport().to_string();
    let port = match (inst.ports, transport.as_str()) {
        (Some(p), "tls") => p.sip_tls,
        (None, "tls") => 5061,
        (Some(p), _) => p.sip_udp,
        (None, _) => 5060,
    };
    let accounts: Vec<Value> = sip.external_accounts().iter().filter(|a| !a.username.is_empty())
        .map(|a| json!({"username": a.username, "password": a.password})).collect();
    let host = request_host(&headers);
    ok(json!({
        "host": host,
        "domain": host,
        "port": port,
        "transport": transport,
        "accounts": accounts,
        "running": engine::is_running(&iid).await,
        // from-local passes the dialled number straight to IMS: E.164 (with +) is what the
        // carrier expects. The +->00 variant is for clients that strip '+'.
        "dial_plan": "x.",
        "dial_plan_plus00": "<+:00>x.|x.",
        "msisdn": inst.msisdn(),
    }))
}
