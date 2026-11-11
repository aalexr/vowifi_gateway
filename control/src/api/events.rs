//! api/events.rs - The engine event hook (notify.py -> POST /api/engine/event) and the
//! background MO-SMS delivery watcher.
use std::time::Duration;

use axum::extract::State;
use base64::Engine as _;
use serde_json::{Map, Value, json};

use super::{ApiResult, AppState, Body, ok};
use crate::config;
use crate::hub::{SmsReport, blocking};
use crate::{engine, push, store};

// ------------------------------------------------------------------- MO SMS delivery verdict
// For an MO SMS the SIP 202 only means the IMS took the MESSAGE; the SMSC's async RP-ACK /
// RP-ERROR submit report is the delivery verdict. The engine's Asterisk (fork patch
// VOWIFI_SMS_REPORT) passes it, and any SIP failure of the MO MESSAGE itself, to the dialplan,
// which posts `sms_report` events here; the hub keeps them per line for `watch_sms_delivery`.

/// RP-Cause (TS 24.011 8.2.5.4, values per TS 24.008) -> reason.
fn rp_cause(c: u8) -> Option<&'static str> {
    Some(match c {
        1 => "unassigned/unallocated number",
        8 => "operator determined barring",
        10 => "call barred",
        11 => "reserved",
        21 => "short message transfer rejected",
        22 => "memory capacity exceeded",
        27 => "destination out of order",
        28 => "unidentified subscriber",
        29 => "facility rejected",
        30 => "unknown subscriber",
        38 => "network out of order",
        41 => "temporary failure",
        42 => "congestion",
        47 => "resources unavailable",
        50 => "requested facility not subscribed",
        69 => "requested facility not implemented",
        81 => "invalid short message reference value",
        95 => "invalid message",
        96 => "invalid mandatory information",
        97 => "message type non-existent",
        98 => "message not compatible with SM protocol state",
        99 => "information element non-existent",
        111 => "protocol error",
        127 => "interworking, unspecified",
        _ => return None,
    })
}

#[derive(Debug, PartialEq)]
enum Verdict {
    Delivered,
    /// The carrier refused it: an RP-ERROR (code None) or a SIP error response (code Some).
    Failed { reason: String, code: Option<u16> },
    /// It never reached the carrier: no SIP response, or IMS not registered.
    NotSent(String),
    Unknown,
}

/// The MO SMS outcome from the submit reports that arrived since it was sent. Any failure wins
/// (one failed part fails a multi-part SMS); otherwise an RP-ACK means delivered to the SMSC.
fn sms_verdict(reports: &[SmsReport]) -> Verdict {
    for r in reports {
        match r.kind.as_str() {
            "error" => {
                let reason = match r.rp_cause {
                    Some(c) => rp_cause(c).map(String::from).unwrap_or_else(|| format!("cause {c}")),
                    None => "delivery failed".into(),
                };
                return Verdict::Failed { reason, code: None };
            }
            "sip" => {
                return match r.sip_status {
                    Some(code) if code >= 300 => Verdict::Failed { reason: r.reason.clone(), code: Some(code) },
                    _ if r.reason == "not registered" => {
                        Verdict::NotSent("the line is not registered with the IMS".into())
                    }
                    _ => Verdict::NotSent("no response from the IMS".into()),
                };
            }
            _ => {}
        }
    }
    if reports.iter().any(|r| r.kind == "ack") { Verdict::Delivered } else { Verdict::Unknown }
}

/// Resolve an MO SMS's REAL outcome after the IMS accepted it (stored as 'sent'): wait for the
/// SMSC's submit report (or a SIP failure) and flip the record to 'delivered' / 'failed', each
/// change broadcast. On timeout it stays 'sent' (accepted, unconfirmed).
pub async fn watch_sms_delivery(hub: AppState, iid: String, mid: i64, since: i64) {
    for _ in 0..40 {
        tokio::time::sleep(Duration::from_secs(1)).await;
        let (status, err) = match sms_verdict(&hub.sms_reports_since(&iid, since)) {
            Verdict::Delivered => ("delivered", None),
            Verdict::Failed { reason, code } => {
                let reason = if reason.is_empty() { "unknown".to_string() } else { reason };
                let sip = code.map(|c| format!(" (SIP {c})")).unwrap_or_default();
                ("failed", Some(format!("Carrier rejected the SMS: {reason}{sip}")))
            }
            Verdict::NotSent(why) => ("failed", Some(format!("SMS not sent: {why}"))),
            Verdict::Unknown => {
                if !engine::is_running(&iid).await {
                    return;
                }
                continue;
            }
        };
        let e = err.clone();
        if let Err(e) = blocking(move || store::set_message_status(mid, status, e.as_deref())).await {
            tracing::warn!(instance = %iid, "sms {mid}: status update failed: {e:#}");
        }
        hub.broadcast(json!({"type": "sms", "instance": iid,
                             "message": {"id": mid, "status": status, "direction": "out", "error": err}}));
        return;
    }
}

// ------------------------------------------------------------------------ call dispositions
/// Asterisk DIALSTATUS + Q.850 cause -> outcome. Inbound calls read the same DIALSTATUS
/// differently: their Dial targets our local softphone, so BUSY/decline means WE declined and
/// CANCEL/NOANSWER means we missed it.
fn call_disposition(dialstatus: &str, cause: i64, direction: &str) -> String {
    if dialstatus == "ANSWER" {
        return "answered".into();
    }
    if direction == "in" {
        return if dialstatus == "BUSY" || cause == 21 { "rejected" } else { "missed" }.into();
    }
    match (dialstatus, cause) {
        (_, 21) => "rejected".into(),             // 603 Decline
        ("BUSY", _) | (_, 17) => "busy".into(),
        ("NOANSWER", _) | (_, 19) => "no answer".into(),
        ("CANCEL", _) => "cancelled".into(),
        ("CONGESTION" | "CHANUNAVAIL", _) => "failed".into(),
        // Empty DIALSTATUS in the hangup handler: the caller hung up before/while dialing.
        ("", _) => "cancelled".into(),
        (other, _) => other.to_lowercase(),
    }
}

/// "ref:total:seq" (UDH concat IE) -> (ref, total, seq); None if not a valid part.
fn parse_sms_concat(v: &str) -> Option<(i64, i64, i64)> {
    let mut it = v.split(':').map(|x| x.trim().parse::<i64>());
    let (r, t, s) = (it.next()?.ok()?, it.next()?.ok()?, it.next()?.ok()?);
    if it.next().is_some() || t < 2 || !(1..=t).contains(&s) {
        return None;
    }
    Some((r, t, s))
}

fn arg(args: &[Value], i: usize) -> String {
    crate::lenient::string(args.get(i))
}

fn int_arg(args: &[Value], i: usize) -> i64 {
    let s = arg(args, i);
    if !s.is_empty() && s.chars().all(|c| c.is_ascii_digit()) { s.parse().unwrap_or(0) } else { 0 }
}

/// notify.py callbacks from the engines.
pub async fn engine_event(State(hub): State<AppState>, body: Body) -> ApiResult {
    let iid = crate::lenient::string(body.get("instance"));
    let event = crate::lenient::string(body.get("event"));
    let args: Vec<Value> = body.get("args").and_then(Value::as_array).cloned().unwrap_or_default();
    match event.as_str() {
        "sms_in" if args.len() >= 2 => {
            let raw = arg(&args, 1);
            let text = base64::engine::general_purpose::STANDARD.decode(raw.trim())
                .map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or(raw);
            let sender = arg(&args, 0);
            // An inbound MESSAGE without human-readable text is IMS-internal signalling (the
            // IP-SM-GW/SMSC's non-user MESSAGEs from a bare private-IP URI) or a binary/OTA SIM
            // data-download SMS (TP-DCS 0xF6 class 2) that decodes to "". A genuine text always
            // has a non-empty body, so nothing real is lost.
            if text.trim().is_empty() {
                tracing::info!(instance = %iid, "dropping empty-body inbound SMS from {sender:?} (internal signalling / \
                                binary/OTA SIM message — no displayable text)");
                return ok(json!({"ok": true, "dropped": "empty_body"}));
            }
            // Concatenated SMS: each part is its own event with "ref:total:seq"; join them
            // into one row that fills in as parts land, push once when complete.
            if let Some((r, total, seq)) = parse_sms_concat(&arg(&args, 2)) {
                let (i, s, t) = (iid.clone(), sender.clone(), text.clone());
                let part = blocking(move || store::add_message_part(&i, &s, r, total, seq, &t)).await?;
                if !part.changed {
                    tracing::info!(instance = %iid, "ignoring re-delivered SMS part {seq}/{total} (ref {r}) from {sender:?}");
                    return ok(json!({"ok": true, "duplicate": true}));
                }
                hub.broadcast(json!({"type": "sms", "instance": iid, "message": part.message,
                                     "update": !part.created}));
                if part.complete {
                    hub.dispatch_push(push::EV_INCOMING_SMS, &iid, &sender, Some(part.message.body.clone()));
                }
                return ok(json!({"ok": true}));
            }
            let (i, s, t) = (iid.clone(), sender.clone(), text.clone());
            let rec = blocking(move || store::add_message(&i, "in", &s, &t, "ok")).await?;
            hub.broadcast(json!({"type": "sms", "instance": iid, "message": rec}));
            hub.dispatch_push(push::EV_INCOMING_SMS, &iid, &sender, Some(text));
        }
        "sms_out" if args.len() >= 2 => {} // already stored by the send path
        // <ack|error|sip> <rp_ref> <rp_cause> <sip_status> <reason_b64>: an MO SMS's outcome.
        "sms_report" if !args.is_empty() => {
            let kind = arg(&args, 0);
            if !["ack", "error", "sip"].contains(&kind.as_str()) {
                return ok(json!({"ok": false, "error": "unknown report kind"}));
            }
            let num = |i: usize| arg(&args, i).trim().parse::<i64>().ok();
            let reason = base64::engine::general_purpose::STANDARD.decode(arg(&args, 4).trim())
                .map(|b| String::from_utf8_lossy(&b).trim().to_string()).unwrap_or_default();
            let report = SmsReport {
                ts: now(),
                rp_cause: num(2).and_then(|c| u8::try_from(c).ok()),
                sip_status: num(3).and_then(|c| u16::try_from(c).ok()),
                reason,
                kind,
            };
            tracing::info!(instance = %iid, "SMS submit report: {} ref={} cause={:?} sip={:?} {}",
                           report.kind, arg(&args, 1), report.rp_cause, report.sip_status, report.reason);
            hub.push_sms_report(&iid, report);
        }
        "call_in" => {
            // Logged even when the caller withholds the number (peer ""), so the 'h'
            // disposition can finalize it. The IMS delivers one INVITE several times
            // (preconditions / GRUU fork / retransmit); add_call_deduped folds them.
            let peer = arg(&args, 0);
            let (i, p) = (iid.clone(), peer.clone());
            let rec = blocking(move || store::add_call_deduped(&i, "in", &p, "ringing")).await?;
            hub.broadcast(json!({"type": "call", "instance": iid, "call": rec}));
            // Push ONCE per real call (keyed on the folded record). An anonymous first event
            // whose number arrives on a later duplicate would push too early, so wait for the
            // number, or ~4 s if the caller really withheld it.
            let age = now() - rec.start_ts;
            if (!peer.is_empty() || age >= 4) && hub.first_push_for_call(rec.id) {
                let who = if rec.peer.is_empty() { peer } else { rec.peer.clone() };
                hub.dispatch_push(push::EV_INCOMING_CALL, &iid, &who, None);
            }
        }
        "call_out" if !args.is_empty() => {
            let (i, p) = (iid.clone(), arg(&args, 0));
            let rec = blocking(move || store::add_call(&i, "out", &p, "dialing")).await?;
            hub.broadcast(json!({"type": "call", "instance": iid, "call": rec}));
        }
        "call_result" if !args.is_empty() => {
            // New form: call_result <direction> <peer> <dialstatus> <cause> (both directions,
            // from the 'h' handler). Legacy: call_result <peer> <dialstatus> <cause> (outgoing).
            let first = arg(&args, 0);
            let (direction, to, dialstatus, cause) = if first == "in" || first == "out" {
                (first, arg(&args, 1), arg(&args, 2).to_uppercase(), int_arg(&args, 3))
            } else {
                ("out".to_string(), first, arg(&args, 1).to_uppercase(), int_arg(&args, 2))
            };
            let disp = call_disposition(&dialstatus, cause, &direction);
            let (i, d, t, s) = (iid.clone(), direction.clone(), to.clone(), disp.clone());
            let mut rec = blocking(move || store::update_last_call(&i, &d, Some(&t), &s)).await?;
            if rec.is_none() && !to.is_empty() {
                // The exact peer matched no open record ('h' lost the number to a masquerade,
                // or call_out stored another form): finalize the latest open call of this
                // direction so it never stays stuck on dialing/ringing.
                let (i, d, s) = (iid.clone(), direction.clone(), disp.clone());
                rec = blocking(move || store::update_last_call(&i, &d, None, &s)).await?;
            }
            if let Some(rec) = rec {
                hub.broadcast(json!({"type": "call", "instance": iid, "call": rec}));
            }
        }
        "cp_mode_resolved" if !args.is_empty() => {
            // CP auto-discovery found the address family that yields a usable PDN: repin an
            // 'auto' line to it so future starts don't re-walk the ladder. A pinned line
            // ignores a stray report.
            let resolved = arg(&args, 0).trim().to_lowercase();
            if ["v6", "v4", "dual"].contains(&resolved.as_str())
                && let Some(inst) = config::get_instance(&iid)
                    && config::normalize_cp_mode(inst.cp_mode.as_deref().unwrap_or("")) == "auto" {
                        let mut patch = Map::new();
                        patch.insert("id".into(), json!(iid));
                        patch.insert("cp_mode".into(), json!(resolved));
                        patch.insert("cp_mode_source".into(), json!("auto"));
                        match blocking(move || config::upsert_instance(patch)).await {
                            Ok(_) => tracing::info!(instance = %iid, "instance {iid}: CP auto-discovery resolved to {resolved} (repinned)"),
                            Err(e) => tracing::warn!(instance = %iid, "cp_mode_resolved persist failed for {iid}: {e}"),
                        }
                    }
            hub.broadcast(json!({"type": "engine", "instance": iid, "event": event, "args": args}));
        }
        _ => hub.broadcast(json!({"type": "engine", "instance": iid, "event": event, "args": args})),
    }
    // Real-time: any tunnel/registration transition triggers an immediate status push.
    if ["tunnel_up", "tunnel_down", "pcscf", "registered", "unregistered"].contains(&event.as_str()) {
        hub.spawn_push_status(&iid);
    }
    ok(json!({"ok": true}))
}

fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sms_verdicts() {
        let r = |kind: &str, rp_cause, sip_status, reason: &str| SmsReport {
            ts: 0, kind: kind.into(), rp_cause, sip_status, reason: reason.into() };
        assert_eq!(sms_verdict(&[]), Verdict::Unknown);
        assert_eq!(sms_verdict(&[r("ack", None, None, "")]), Verdict::Delivered);
        assert_eq!(sms_verdict(&[r("error", Some(38), None, "")]),
                   Verdict::Failed { reason: "network out of order".into(), code: None });
        assert_eq!(sms_verdict(&[r("error", Some(200), None, "")]),
                   Verdict::Failed { reason: "cause 200".into(), code: None });
        // One failed part fails a multi-part SMS, whatever the order.
        assert_eq!(sms_verdict(&[r("ack", None, None, ""), r("error", None, None, "")]),
                   Verdict::Failed { reason: "delivery failed".into(), code: None });
        assert_eq!(sms_verdict(&[r("sip", None, Some(403), "Forbidden")]),
                   Verdict::Failed { reason: "Forbidden".into(), code: Some(403) });
        assert_eq!(sms_verdict(&[r("sip", None, Some(0), "not registered")]),
                   Verdict::NotSent("the line is not registered with the IMS".into()));
        assert_eq!(sms_verdict(&[r("sip", None, Some(0), "")]),
                   Verdict::NotSent("no response from the IMS".into()));
    }

    #[test]
    fn dispositions_and_concat() {
        assert_eq!(call_disposition("ANSWER", 16, "out"), "answered");
        assert_eq!(call_disposition("", 21, "out"), "rejected");
        assert_eq!(call_disposition("BUSY", 0, "in"), "rejected");
        assert_eq!(call_disposition("CANCEL", 0, "in"), "missed");
        assert_eq!(call_disposition("", 16, "out"), "cancelled");
        assert_eq!(call_disposition("WEIRD", 0, "out"), "weird");
        assert_eq!(parse_sms_concat("12:3:2"), Some((12, 3, 2)));
        assert_eq!(parse_sms_concat("12:1:1"), None);
        assert_eq!(parse_sms_concat("12:3:4"), None);
        assert_eq!(parse_sms_concat(""), None);
    }
}
