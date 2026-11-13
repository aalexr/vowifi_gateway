//! push.rs - Outbound push notifications for incoming events (SMS / calls).
//!
//! Two independent channels from the global settings: a webhook (HTTP POST of a JSON body) and
//! a Telegram bot message. Both fire on the same events (incoming_sms, incoming_call) with the
//! same core fields (line ICCID, the line's own MSISDN, the source number, the SMS text).
//! Delivery is best-effort and never blocks the engine-event path: `dispatch` is spawned
//! fire-and-forget and every failure only logs a warning.
use std::time::Duration;

use serde_json::{Value, json};

use crate::config::{Instance, PushEvents, Settings};

pub const EV_INCOMING_SMS: &str = "incoming_sms";
pub const EV_INCOMING_CALL: &str = "incoming_call";

const TIMEOUT: Duration = Duration::from_secs(8);

fn wants(events: &PushEvents, event: &str) -> bool {
    match event {
        EV_INCOMING_SMS => events.incoming_sms,
        EV_INCOMING_CALL => events.incoming_call,
        _ => false,
    }
}

pub fn any_enabled(s: &Settings) -> bool {
    s.webhook.enabled || s.telegram.enabled
}

/// The canonical event body both channels are built from.
pub fn build_payload(event: &str, inst: &Instance, source: &str, text: Option<&str>) -> Value {
    json!({
        "event": event,
        "instance": inst.id,
        "sim_name": inst.name.clone().unwrap_or_default(),
        "iccid": inst.iccid.clone().unwrap_or_default(),
        "msisdn": inst.msisdn(),
        "from": source,
        "text": if event == EV_INCOMING_SMS { json!(text.unwrap_or("")) } else { Value::Null },
    })
}

async fn post_webhook(url: &str, payload: &Value) {
    let url = url.trim();
    if url.is_empty() {
        tracing::warn!("webhook enabled but no URL configured; skipping");
        return;
    }
    // Webhook targets are often internal hosts with self-signed TLS; we push low-sensitivity
    // event metadata and accept nothing back, so a cert mismatch must not drop notifications.
    let client = match reqwest::Client::builder()
        .timeout(TIMEOUT)
        .danger_accept_invalid_certs(true)
        .user_agent("vowifi-gateway")
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!("webhook client: {e}");
            return;
        }
    };
    match client.post(url).json(payload).send().await {
        Ok(r) => tracing::info!(
            "webhook {} -> {url} ({})",
            payload["event"],
            r.status().as_u16()
        ),
        Err(e) => tracing::warn!("webhook POST to {url} failed: {e}"),
    }
}

fn telegram_text(p: &Value) -> String {
    let s = |k: &str| p.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let sms = s("event") == EV_INCOMING_SMS;
    let head = if sms {
        "📩 Incoming SMS"
    } else {
        "📞 Incoming call"
    };
    let name = [s("sim_name"), s("iccid"), s("instance")]
        .into_iter()
        .find(|v| !v.is_empty())
        .unwrap_or_default();
    let msisdn = s("msisdn");
    let sim_line = if msisdn.is_empty() {
        format!("SIM: {name}")
    } else {
        format!("SIM: {name} ({msisdn})")
    };
    let from = s("from");
    let mut lines = vec![
        head.to_string(),
        sim_line,
        format!("From: {}", if from.is_empty() { "unknown" } else { &from }),
    ];
    if sms {
        lines.push(String::new());
        lines.push(s("text"));
    }
    lines.join("\n")
}

async fn post_telegram(token: &str, chat: &str, payload: &Value) {
    let (token, chat) = (token.trim(), chat.trim());
    if token.is_empty() || chat.is_empty() {
        tracing::warn!("telegram enabled but bot_token/chat_id missing; skipping");
        return;
    }
    let client = match reqwest::Client::builder().timeout(TIMEOUT).build() {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!("telegram client: {e}");
            return;
        }
    };
    let body =
        json!({"chat_id": chat, "text": telegram_text(payload), "disable_web_page_preview": true});
    // The token is part of the URL: never log the URL itself.
    match client
        .post(format!("https://api.telegram.org/bot{token}/sendMessage"))
        .json(&body)
        .send()
        .await
    {
        Ok(r) if r.status().as_u16() == 200 => {
            tracing::info!("telegram {} -> chat {chat} ok", payload["event"])
        }
        Ok(r) => {
            let status = r.status().as_u16();
            let text = r.text().await.unwrap_or_default();
            tracing::warn!(
                "telegram sendMessage -> {status} {}",
                &text[..text.len().min(200)]
            );
        }
        Err(e) => tracing::warn!("telegram sendMessage failed: {}", e.without_url()),
    }
}

/// Fire every enabled channel for one event (each gated on its enable flag + event checkbox).
pub async fn dispatch(
    settings: Settings,
    event: &'static str,
    inst: Instance,
    source: String,
    text: Option<String>,
) {
    let payload = build_payload(event, &inst, &source, text.as_deref());
    if settings.webhook.enabled && wants(&settings.webhook.events, event) {
        post_webhook(&settings.webhook.url, &payload).await;
    }
    if settings.telegram.enabled && wants(&settings.telegram.events, event) {
        post_telegram(
            &settings.telegram.bot_token,
            &settings.telegram.chat_id,
            &payload,
        )
        .await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn telegram_format() {
        let inst = Instance {
            id: "2".into(),
            name: Some("Blau".into()),
            msisdn: Some("+49176".into()),
            ..Default::default()
        };
        let p = build_payload(EV_INCOMING_SMS, &inst, "+4930", Some("hi"));
        assert_eq!(
            telegram_text(&p),
            "📩 Incoming SMS\nSIM: Blau (+49176)\nFrom: +4930\n\nhi"
        );
        let p = build_payload(EV_INCOMING_CALL, &inst, "", None);
        assert_eq!(p["text"], Value::Null);
        assert!(telegram_text(&p).ends_with("From: unknown"));
    }
}
