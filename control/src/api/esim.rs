//! api/esim.rs - eSIM / LPA (lpac) routes.
//!
//! lpac needs EXCLUSIVE PC/SC access, so every operation is gated: refused while a VoWiFi
//! engine runs on the reader (`guard_engine`), serialised by the per-reader lock, and the
//! reader is flagged lpa_busy for the duration (the card monitor then ignores the eUICC
//! REFRESH that a profile switch causes, instead of treating it as remove + insert). The SE
//! discovery APDUs also run only after the engine gate, under the reader lock.
use std::future::Future;

use axum::extract::{Path, State};
use serde_json::{Value, json};

use super::{ApiError, ApiResult, AppState, Body, Q, ok, q_int, q_str};
use crate::config;
use crate::estkme::{self, Se};
use crate::hub::{CardEntry, blocking};
use crate::lpa::{self, LpaError};
use crate::{card, sim};

/// (reader name, index); the NAME wins when given.
async fn resolve_reader(reader_index: i64, reader: Option<String>) -> ApiResult<(String, usize)> {
    let rlist = blocking(card::list_readers).await;
    if rlist.is_empty() {
        return Err(ApiError::new(409, "no PC/SC readers connected"));
    }
    if let Some(r) = reader {
        return match rlist.iter().position(|n| *n == r) {
            Some(i) => Ok((r, i)),
            None => Err(ApiError::new(409, format!("reader '{r}' is no longer connected"))),
        };
    }
    match usize::try_from(reader_index).ok().filter(|i| *i < rlist.len()) {
        Some(i) => Ok((rlist[i].clone(), i)),
        None => Err(ApiError::new(400, "reader index out of range")),
    }
}

fn body_reader(body: &Body) -> (i64, Option<String>) {
    (crate::lenient::or(body.get("reader_index"), 0i64), body.str("reader"))
}

async fn query_reader(q: &Q) -> ApiResult<(String, usize)> {
    resolve_reader(q_int(q, "reader_index", 0)?, q_str(q, "reader")).await
}

/// Refuse LPA while a VoWiFi engine holds the card.
async fn guard_engine(hub: &AppState, name: &str) -> ApiResult<()> {
    if let Some(inst) = hub.find_running_by_reader(name).await {
        return Err(ApiError::new(409, format!(
            "Line {} is running on this reader — stop it before eSIM operations", inst.id)));
    }
    Ok(())
}

/// Which ISD-R to target. Dual-SE cards need se_id or aid when `require`.
async fn resolve_se(hub: &AppState, name: &str, se_id: Option<String>, aid: Option<String>, require: bool)
    -> ApiResult<Se>
{
    guard_engine(hub, name).await?;
    let l = hub.reader_lock(name);
    let ses = {
        let _g = l.lock().await;
        let n = name.to_string();
        blocking(move || estkme::discover_ses(&n)).await
    };
    if require && ses.len() > 1 && se_id.is_none() && aid.is_none() {
        return Err(ApiError::new(400, "eUICC SE is required for dual-SE cards"));
    }
    estkme::resolve_se(&ses, se_id.as_deref(), aid.as_deref()).map_err(|e| ApiError::new(400, e))
}

fn body_se(body: &Body) -> (Option<String>, Option<String>) {
    (body.str("se_id").or_else(|| body.str("seId")), body.str("aid"))
}

fn imei_for_reader(hub: &AppState, name: &str, override_: Option<String>) -> String {
    if let Some(o) = override_.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        return o;
    }
    hub.card(name).and_then(|c| c.matched).and_then(|m| config::get_instance(&m))
        .and_then(|i| i.imei).unwrap_or_default()
}

/// Re-probe the USIM identity after a profile enable/disable/download and broadcast it.
async fn refresh_card(hub: &AppState, name: &str, idx: usize) -> CardEntry {
    let mut info = hub.card(name).unwrap_or(CardEntry { name: name.into(), present: true, ..Default::default() });
    let c = blocking(move || sim::read_card(idx, None)).await;
    info.index = Some(idx);
    info.name = name.to_string();
    info.present = true;
    if c.present {
        info.apply(&c);
        info.matched = config::instance_by_iccid(c.iccid.as_deref()).map(|i| i.id);
    } else {
        tracing::debug!("post-LPA card refresh failed: {:?}", c.error);
    }
    hub.set_card(info.clone());
    hub.broadcast_cards();
    info
}

fn lpa_error(e: LpaError) -> ApiError {
    ApiError::new(400, e.user_message())
}

/// Serialise one LPA call: engine gate + reader lock + lpa_busy (+ optional card refresh).
async fn run<T, F>(hub: &AppState, name: &str, idx: usize, refresh: bool, op: F) -> ApiResult<T>
where
    F: Future<Output = Result<T, LpaError>>,
{
    guard_engine(hub, name).await?;
    let l = hub.reader_lock(name);
    let _g = l.lock().await;
    hub.set_lpa_busy(name);
    let r = op.await;
    if r.is_ok() && refresh {
        refresh_card(hub, name, idx).await;
    }
    hub.clear_lpa_busy(name);
    r.map_err(lpa_error)
}

pub async fn status(State(hub): State<AppState>) -> ApiResult {
    let s = config::get_settings().esim;
    ok(json!({
        "available": lpa::lpac_available(),
        "lpac_bin": s.lpac_bin_path().display().to_string(),
        "download_timeout": s.download_timeout_s(),
        "auto_process_notifications": s.auto_process_notifications,
        "busy_readers": hub.busy_readers(),
    }))
}

async fn load(hub: &AppState, name: &str, idx: usize) -> ApiResult<Value> {
    let n = name.to_string();
    run(hub, name, idx, false, async move { Ok::<_, LpaError>(lpa::load_all_ses(&n).await) }).await
}

fn matched(hub: &AppState, name: &str, running: &Option<config::Instance>) -> Value {
    match running {
        Some(i) => json!(i.id),
        None => json!(hub.card(name).and_then(|c| c.matched)),
    }
}

/// Chip info for every SE on the card (dual SE -> two entries).
pub async fn chip(State(hub): State<AppState>, q: Q) -> ApiResult {
    let (name, idx) = query_reader(&q).await?;
    let running = hub.find_running_by_reader(&name).await;
    let payload = load(&hub, &name, idx).await?;
    let ses = payload["ses"].as_array().cloned().unwrap_or_default();
    // Backward-compatible single-chip view = the first SE that loaded.
    let primary = ses.iter().find(|s| !s["chip"].is_null()).or(ses.first()).cloned().unwrap_or(Value::Null);
    ok(json!({
        "ok": true, "reader": name, "reader_index": idx, "dual": payload["dual"].as_bool().unwrap_or(false),
        "ses": ses, "chip": primary.get("chip").cloned().unwrap_or(Value::Null),
        "imei": imei_for_reader(&hub, &name, None), "line_running": running.is_some(),
        "matched_instance": matched(&hub, &name, &running),
    }))
}

/// Profiles grouped per SE (same load as chip).
pub async fn profiles(State(hub): State<AppState>, q: Q) -> ApiResult {
    let (name, idx) = query_reader(&q).await?;
    let running = hub.find_running_by_reader(&name).await;
    let payload = load(&hub, &name, idx).await?;
    let ses = payload["ses"].as_array().cloned().unwrap_or_default();
    let flat: Vec<Value> = ses.iter().flat_map(|s| s["profiles"].as_array().cloned().unwrap_or_default()).collect();
    ok(json!({
        "ok": true, "reader": name, "reader_index": idx, "dual": payload["dual"].as_bool().unwrap_or(false),
        "ses": ses, "profiles": flat, "imei": imei_for_reader(&hub, &name, None),
        "line_running": running.is_some(), "matched_instance": matched(&hub, &name, &running),
        "lpa_busy": hub.lpa_busy(&name),
    }))
}

pub async fn enable(State(hub): State<AppState>, Path(iccid): Path<String>, body: Body) -> ApiResult {
    let (ri, r) = body_reader(&body);
    let (name, idx) = resolve_reader(ri, r).await?;
    let (se_id, aid) = body_se(&body);
    let se = resolve_se(&hub, &name, se_id, aid, true).await?;
    run(&hub, &name, idx, true, lpa::profile_enable(&name, &iccid, se.aid.as_deref())).await?;
    ok(json!({"ok": true, "iccid": iccid, "se_id": se.id, "card": hub.card(&name)}))
}

pub async fn disable(State(hub): State<AppState>, Path(iccid): Path<String>, body: Body) -> ApiResult {
    let (ri, r) = body_reader(&body);
    let (name, idx) = resolve_reader(ri, r).await?;
    let (se_id, aid) = body_se(&body);
    let se = resolve_se(&hub, &name, se_id, aid, true).await?;
    run(&hub, &name, idx, true, lpa::profile_disable(&name, &iccid, se.aid.as_deref())).await?;
    ok(json!({"ok": true, "iccid": iccid, "se_id": se.id, "card": hub.card(&name)}))
}

pub async fn delete_profile(State(hub): State<AppState>, Path(iccid): Path<String>, q: Q) -> ApiResult {
    let (name, idx) = query_reader(&q).await?;
    let se = resolve_se(&hub, &name, q_str(&q, "se_id"), q_str(&q, "aid"), true).await?;
    run(&hub, &name, idx, true, lpa::profile_delete(&name, &iccid, se.aid.as_deref())).await?;
    ok(json!({"ok": true, "iccid": iccid, "se_id": se.id}))
}

pub async fn nickname(State(hub): State<AppState>, Path(iccid): Path<String>, body: Body) -> ApiResult {
    let (ri, r) = body_reader(&body);
    let (name, idx) = resolve_reader(ri, r).await?;
    let (se_id, aid) = body_se(&body);
    let se = resolve_se(&hub, &name, se_id, aid, true).await?;
    let nick = body.get("nickname").map(|v| crate::lenient::string(Some(v))).unwrap_or_default();
    run(&hub, &name, idx, false, lpa::profile_nickname(&name, &iccid, &nick, se.aid.as_deref())).await?;
    ok(json!({"ok": true, "iccid": iccid, "nickname": nick, "se_id": se.id}))
}

/// Start a profile download in the background; progress arrives over WS (type=esim_download).
pub async fn download(State(hub): State<AppState>, body: Body) -> ApiResult {
    let (ri, r) = body_reader(&body);
    let (name, idx) = resolve_reader(ri, r).await?;
    let (se_id, aid) = body_se(&body);
    let se = resolve_se(&hub, &name, se_id, aid, true).await?;
    if hub.lpa_busy(&name) {
        return Err(ApiError::new(409, "an eSIM operation is already running on this reader"));
    }
    guard_engine(&hub, &name).await?;
    let imei = imei_for_reader(&hub, &name, body.str("imei"));
    // Claim busy before returning so a second concurrent POST can't start another job.
    if !hub.set_lpa_busy(&name) {
        return Err(ApiError::new(409, "an eSIM operation is already running on this reader"));
    }
    let args = lpa::DownloadArgs {
        activation_code: body.str("activation_code"),
        smdp: body.str("smdp"),
        matching_id: body.str("matching_id"),
        confirmation_code: body.str("confirmation_code"),
        imei: Some(imei.clone()).filter(|s| !s.is_empty()),
    };
    let (job_hub, job_name, job_se) = (hub.clone(), name.clone(), se.clone());
    let job_imei = imei.clone();
    tokio::spawn(async move {
        let (hub, name, se) = (job_hub, job_name, job_se);
        let base = |event: &str| json!({"type": "esim_download", "reader": name, "reader_index": idx,
                                        "se_id": se.id, "event": event});
        {
            let l = hub.reader_lock(&name);
            let _g = l.lock().await;
            let mut started = base("started");
            started["step"] = json!("started");
            started["imei"] = json!(job_imei);
            hub.broadcast(started);
            let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<lpa::Progress>();
            let fwd_hub = hub.clone();
            let progress_base = base("progress");
            let forwarder = tokio::spawn(async move {
                while let Some(p) = rx.recv().await {
                    let mut msg = progress_base.clone();
                    msg["step"] = json!(p.step);
                    if p.data.is_object() {
                        msg["metadata"] = p.data.clone();
                        if p.step == "es8p_metadata_parse" {
                            msg["event"] = json!("preview");
                        }
                    }
                    if !p.data.is_null() {
                        msg["data"] = p.data;
                    }
                    fwd_hub.broadcast(msg);
                }
            });
            let result = lpa::download(&name, args, se.aid.as_deref(), Some(tx)).await;
            let _ = forwarder.await; // every progress line goes out before the verdict
            match result {
                Ok(result) => {
                    let card = refresh_card(&hub, &name, idx).await;
                    let mut done = base("completed");
                    done["step"] = json!("completed");
                    done["result"] = result;
                    done["card"] = serde_json::to_value(card).unwrap_or(Value::Null);
                    hub.broadcast(done);
                }
                Err(e) => {
                    // lpac names the failing function in `message` (e.g. es9p_authenticate_client).
                    let mut err = base("error");
                    let step = e.message.trim();
                    err["step"] = if step.is_empty() { Value::Null } else { json!(step) };
                    err["error"] = json!(e.user_message());
                    hub.broadcast(err);
                }
            }
        }
        hub.clear_lpa_busy(&name);
    });
    ok(json!({"ok": true, "started": true, "reader": name, "reader_index": idx, "se_id": se.id, "imei": imei}))
}

pub async fn download_cancel(State(hub): State<AppState>, body: Body) -> ApiResult {
    let (ri, r) = body_reader(&body);
    let (name, _idx) = resolve_reader(ri, r).await?;
    let cancelled = lpa::cancel_download(&name);
    if cancelled {
        hub.broadcast(json!({"type": "esim_download", "reader": name, "event": "cancelling", "step": "cancelling"}));
    }
    ok(json!({"ok": true, "cancelled": cancelled}))
}

pub async fn discovery(State(hub): State<AppState>, body: Body) -> ApiResult {
    let (ri, r) = body_reader(&body);
    let (name, idx) = resolve_reader(ri, r).await?;
    let (se_id, aid) = body_se(&body);
    let se = resolve_se(&hub, &name, se_id, aid, true).await?;
    let imei = imei_for_reader(&hub, &name, body.str("imei"));
    let smds = body.str("smds");
    let entries = run(&hub, &name, idx, false,
                      lpa::discovery(&name, Some(&imei).filter(|s| !s.is_empty()).map(|s| s.as_str()),
                                     smds.as_deref(), se.aid.as_deref())).await?;
    let entries = if entries.is_null() { json!([]) } else { entries };
    ok(json!({"ok": true, "reader": name, "se_id": se.id, "entries": entries, "imei": imei}))
}

pub async fn notifications(State(hub): State<AppState>, q: Q) -> ApiResult {
    let (name, idx) = query_reader(&q).await?;
    let payload = load(&hub, &name, idx).await?;
    let ses = payload["ses"].as_array().cloned().unwrap_or_default();
    let flat: Vec<Value> = ses.iter().flat_map(|s| s["notifications"].as_array().cloned().unwrap_or_default()).collect();
    ok(json!({"ok": true, "reader": name, "dual": payload["dual"].as_bool().unwrap_or(false),
              "ses": ses, "notifications": flat}))
}

pub async fn notifications_process(State(hub): State<AppState>, body: Body) -> ApiResult {
    let (ri, r) = body_reader(&body);
    let (name, idx) = resolve_reader(ri, r).await?;
    let (se_id, aid) = body_se(&body);
    let se = resolve_se(&hub, &name, se_id, aid, true).await?;
    let seq: Option<i64> = body.get("seq").map(|v| crate::lenient::FromLenient::from_lenient(v)
        .ok_or_else(|| ApiError::new(422, "seq must be an integer"))).transpose()?;
    let remove = body.get("remove").map(|v| crate::lenient::truthy(Some(v))).unwrap_or(true);
    run(&hub, &name, idx, false, lpa::notification_process(&name, seq, remove, se.aid.as_deref())).await?;
    ok(json!({"ok": true, "se_id": se.id}))
}

pub async fn notification_remove(State(hub): State<AppState>, Path(seq): Path<i64>, q: Q) -> ApiResult {
    let (name, idx) = query_reader(&q).await?;
    let se = resolve_se(&hub, &name, q_str(&q, "se_id"), q_str(&q, "aid"), true).await?;
    run(&hub, &name, idx, false, lpa::notification_remove(&name, seq, se.aid.as_deref())).await?;
    ok(json!({"ok": true, "seq": seq, "se_id": se.id}))
}
