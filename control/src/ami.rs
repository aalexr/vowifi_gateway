//! ami.rs - Async Asterisk Manager Interface client (one per running engine instance).
//!
//! The manager uses it to read IMS registration state, send SMS (MessageSend to the volte_ims
//! endpoint), place calls (Originate) and hang up. Incoming calls/SMS arrive through the
//! engine's notify.py HTTP hook, not AMI events, so the session logs in with `Events: off`
//! (list responses such as PJSIPShowRegistrationsDetailed are still delivered: Asterisk writes
//! them to the requesting session directly).
//!
//! Design: one TCP session; a reader task parses `Key: Value` blocks and completes the
//! pending action with the same ActionID (collecting `EventList: start` ... `Complete`
//! events into one reply). A 15 s Ping detects a dead peer. There is deliberately NO
//! reconnect loop inside the client: once the session dies `connected()` turns false and the
//! hub replaces the client, so a client for a stopped/recreated engine can never keep dialing
//! it with a stale secret (the failure mode the old auto-reconnecting client had).
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use base64::Engine as _;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::net::tcp::OwnedWriteHalf;
use tokio::sync::{Mutex, oneshot};
use tokio::task::JoinHandle;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(6);
const ACTION_TIMEOUT: Duration = Duration::from_secs(8);
const PING_EVERY: Duration = Duration::from_secs(15);

/// One AMI message: ordered `Key: Value` pairs (keys may repeat, e.g. `Output`).
#[derive(Debug, Clone, Default)]
pub struct Msg(pub Vec<(String, String)>);

impl Msg {
    pub fn get(&self, key: &str) -> Option<&str> {
        self.0.iter().find(|(k, _)| k.eq_ignore_ascii_case(key)).map(|(_, v)| v.as_str())
    }
    pub fn all<'a>(&'a self, key: &'a str) -> impl Iterator<Item = &'a str> + 'a {
        self.0.iter().filter(move |(k, _)| k.eq_ignore_ascii_case(key)).map(|(_, v)| v.as_str())
    }
}

struct PendingAction {
    tx: oneshot::Sender<Vec<Msg>>,
    collected: Vec<Msg>,
}

type Pending = Arc<std::sync::Mutex<HashMap<String, PendingAction>>>;

pub struct AmiClient {
    pub instance_id: String,
    pub host: String,
    pub port: u16,
    username: String,
    secret: String,
    realm: String,
    msisdn: std::sync::Mutex<String>,
    writer: Mutex<Option<OwnedWriteHalf>>,
    pending: Pending,
    alive: Arc<AtomicBool>,
    next_id: AtomicU64,
    tasks: std::sync::Mutex<Vec<JoinHandle<()>>>,
}

/// AMI header values are CRLF-delimited: strip line breaks so a value can't inject headers
/// or a second action.
fn clean(v: &str) -> String {
    v.replace(['\r', '\n'], " ")
}

impl AmiClient {
    pub fn new(instance_id: &str, host: &str, port: u16, username: &str, secret: &str,
               realm: &str, msisdn: &str) -> Arc<Self> {
        Arc::new(AmiClient {
            instance_id: instance_id.into(),
            host: host.into(),
            port,
            username: username.into(),
            secret: secret.into(),
            realm: realm.into(),
            msisdn: std::sync::Mutex::new(msisdn.into()),
            writer: Mutex::new(None),
            pending: Arc::new(std::sync::Mutex::new(HashMap::new())),
            alive: Arc::new(AtomicBool::new(false)),
            next_id: AtomicU64::new(1),
            tasks: std::sync::Mutex::new(Vec::new()),
        })
    }

    pub fn set_msisdn(&self, m: &str) {
        *self.msisdn.lock().unwrap_or_else(|e| e.into_inner()) = m.to_string();
    }

    fn msisdn(&self) -> String {
        self.msisdn.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn connected(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    /// Connect + Login (bounded). Failure leaves the client disconnected (logged).
    pub async fn connect(self: &Arc<Self>) {
        match tokio::time::timeout(CONNECT_TIMEOUT, self.connect_inner()).await {
            Ok(Ok(())) => tracing::info!(instance = %self.instance_id, "AMI connected instance={} {}:{}", self.instance_id, self.host, self.port),
            Ok(Err(e)) => {
                self.close().await;
                tracing::warn!(instance = %self.instance_id, "AMI connect failed instance={}: {e:#}", self.instance_id);
            }
            Err(_) => {
                self.close().await;
                tracing::warn!(instance = %self.instance_id, "AMI connect failed instance={}: timed out", self.instance_id);
            }
        }
    }

    async fn connect_inner(self: &Arc<Self>) -> anyhow::Result<()> {
        let stream = TcpStream::connect((self.host.as_str(), self.port)).await?;
        stream.set_nodelay(true).ok();
        let (rd, wr) = stream.into_split();
        let mut reader = BufReader::new(rd);
        let mut banner = String::new();
        reader.read_line(&mut banner).await?;
        if !banner.starts_with("Asterisk Call Manager") {
            anyhow::bail!("unexpected AMI banner {:?}", banner.trim());
        }
        *self.writer.lock().await = Some(wr);
        self.alive.store(true, Ordering::SeqCst);
        let pending = self.pending.clone();
        let alive = self.alive.clone();
        let iid = self.instance_id.clone();
        let reader_task = tokio::spawn(async move {
            if let Err(e) = read_loop(reader, &pending).await {
                tracing::debug!("AMI reader instance={iid} ended: {e:#}");
            }
            alive.store(false, Ordering::SeqCst);
            // Fail every in-flight action at once instead of letting each run into its timeout.
            pending.lock().unwrap_or_else(|e| e.into_inner()).clear();
        });
        self.tasks.lock().unwrap_or_else(|e| e.into_inner()).push(reader_task);

        let reply = self.raw_action(&[("Action", "Login"), ("Username", &self.username),
                                      ("Secret", &self.secret), ("Events", "off")], ACTION_TIMEOUT).await?;
        let first = reply.first().cloned().unwrap_or_default();
        if first.get("Response") != Some("Success") {
            anyhow::bail!("login rejected: {}", first.get("Message").unwrap_or("no reason"));
        }
        let me = Arc::downgrade(self);
        let pinger = tokio::spawn(async move {
            loop {
                tokio::time::sleep(PING_EVERY).await;
                let Some(c) = me.upgrade() else { return };
                if !c.connected() {
                    return;
                }
                if c.raw_action(&[("Action", "Ping")], ACTION_TIMEOUT).await.is_err() {
                    tracing::warn!(instance = %c.instance_id, "AMI ping failed instance={} -> marking disconnected", c.instance_id);
                    c.alive.store(false, Ordering::SeqCst);
                    return;
                }
            }
        });
        self.tasks.lock().unwrap_or_else(|e| e.into_inner()).push(pinger);
        Ok(())
    }

    async fn raw_action(&self, fields: &[(&str, &str)], timeout: Duration) -> anyhow::Result<Vec<Msg>> {
        let id = format!("vowifi-{}", self.next_id.fetch_add(1, Ordering::Relaxed));
        let mut text = String::new();
        for (k, v) in fields {
            text.push_str(&format!("{}: {}\r\n", clean(k), clean(v)));
        }
        text.push_str(&format!("ActionID: {id}\r\n\r\n"));
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap_or_else(|e| e.into_inner())
            .insert(id.clone(), PendingAction { tx, collected: Vec::new() });
        let sent = async {
            let mut w = self.writer.lock().await;
            let w = w.as_mut().ok_or_else(|| anyhow::anyhow!("AMI not connected"))?;
            w.write_all(text.as_bytes()).await?;
            anyhow::Ok(())
        }.await;
        if let Err(e) = sent {
            self.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
            self.alive.store(false, Ordering::SeqCst);
            return Err(e);
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(msgs)) => Ok(msgs),
            Ok(Err(_)) => anyhow::bail!("AMI connection closed"),
            Err(_) => {
                self.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
                anyhow::bail!("AMI action timed out")
            }
        }
    }

    /// An action with a hard timeout. A wedged connection (socket up, Asterisk silent) would
    /// otherwise hang the status poller and the API; on timeout the client is marked
    /// disconnected so the hub rebuilds it.
    async fn action(&self, fields: &[(&str, &str)], timeout: Duration) -> anyhow::Result<Vec<Msg>> {
        let r = self.raw_action(fields, timeout).await;
        if let Err(e) = &r
            && e.to_string().contains("timed out") {
                tracing::warn!(instance = %self.instance_id, "AMI action timed out instance={} action={} -> marking disconnected",
                               self.instance_id, fields.first().map(|f| f.1).unwrap_or("?"));
                self.alive.store(false, Ordering::SeqCst);
            }
        r
    }

    pub async fn close(&self) {
        self.alive.store(false, Ordering::SeqCst);
        for t in self.tasks.lock().unwrap_or_else(|e| e.into_inner()).drain(..) {
            t.abort();
        }
        if let Some(mut w) = self.writer.lock().await.take() {
            let _ = w.shutdown().await;
        }
        self.pending.lock().unwrap_or_else(|e| e.into_inner()).clear();
    }

    async fn command_output(&self, command: &str) -> anyhow::Result<String> {
        let msgs = self.action(&[("Action", "Command"), ("Command", command)], ACTION_TIMEOUT).await?;
        Ok(msgs.iter().flat_map(|m| m.all("Output").map(|l| format!("{l}\n"))).collect())
    }

    /// 'Registered' | 'Rejected' | 'Unregistered' | ... | 'unknown'.
    pub async fn registration_state(&self) -> String {
        if !self.connected() {
            return "unknown".into();
        }
        match self.action(&[("Action", "PJSIPShowRegistrationsDetailed")], ACTION_TIMEOUT).await {
            Ok(msgs) => {
                if let Some(s) = msgs.iter().filter_map(|m| m.get("Status")).map(str::trim).find(|s| !s.is_empty()) {
                    return s.to_string();
                }
            }
            Err(e) => tracing::debug!("reg state error: {e:#}"),
        }
        if let Ok(text) = self.command_output("pjsip show registrations").await {
            for s in ["Registered", "Rejected", "Unregistered"] {
                if text.contains(s) {
                    return s.into();
                }
            }
        }
        "unknown".into()
    }

    /// The IMS reg-event state the engine stores in astdb ("<state>;<event>", e.g.
    /// "terminated;rejected"), or "". Asterisk keeps showing the outbound registration as
    /// Registered after a network-initiated removal; this is the only way to see it.
    pub async fn reginfo_state(&self) -> String {
        if !self.connected() {
            return String::new();
        }
        match self.command_output("database get volte reginfo").await {
            Ok(text) => text.lines().map(str::trim).find_map(|l| l.strip_prefix("Value:"))
                .map(|v| v.trim().to_string()).unwrap_or_default(),
            Err(e) => {
                tracing::debug!("reginfo state error: {e:#}");
                String::new()
            }
        }
    }

    pub async fn send_sms(&self, to: &str, body: &str) -> Value {
        if !self.connected() {
            return json!({"ok": false, "error": "AMI not connected"});
        }
        let dest = format!("pjsip:volte_ims/{to}@volte_ims");
        let msisdn = self.msisdn();
        let frm = format!("sip:{}@{}", if msisdn.is_empty() { to } else { &msisdn }, self.realm);
        // A header value can't carry line breaks: multi-line texts go base64-encoded.
        let encoded;
        let body_field = if body.contains(['\r', '\n']) {
            encoded = base64::engine::general_purpose::STANDARD.encode(body);
            ("Base64Body", encoded.as_str())
        } else {
            ("Body", body)
        };
        match self.action(&[("Action", "MessageSend"), ("To", &dest), ("From", &frm), body_field],
                          ACTION_TIMEOUT).await {
            Ok(msgs) => {
                let m = msgs.first().cloned().unwrap_or_default();
                json!({"ok": m.get("Response") == Some("Success"), "detail": m.get("Message").unwrap_or("")})
            }
            Err(e) => json!({"ok": false, "error": format!("{e:#}")}),
        }
    }

    /// Ring `from_endpoint` (a local endpoint / softphone) and bridge to the dialed number over
    /// IMS, via the from-local dialplan.
    pub async fn originate(&self, to: &str, from_endpoint: &str) -> Value {
        if !self.connected() {
            return json!({"ok": false, "error": "AMI not connected"});
        }
        let msisdn = self.msisdn();
        let channel = format!("PJSIP/{from_endpoint}");
        let cid = if msisdn.is_empty() { "gateway".to_string() } else { msisdn };
        match self.action(&[("Action", "Originate"), ("Channel", &channel), ("Exten", to),
                            ("Context", "from-local"), ("Priority", "1"), ("CallerID", &cid),
                            ("Async", "true")], Duration::from_secs(12)).await {
            Ok(msgs) => {
                let m = msgs.first().cloned().unwrap_or_default();
                json!({"ok": m.get("Response") == Some("Success"), "detail": m.get("Message").unwrap_or("")})
            }
            Err(e) => json!({"ok": false, "error": format!("{e:#}")}),
        }
    }

    pub async fn hangup_all(&self) -> Value {
        if !self.connected() {
            return json!({"ok": false, "error": "AMI not connected"});
        }
        match self.action(&[("Action", "Command"), ("Command", "channel request hangup all")],
                          ACTION_TIMEOUT).await {
            Ok(_) => json!({"ok": true}),
            Err(e) => json!({"ok": false, "error": format!("{e:#}")}),
        }
    }
}

impl Drop for AmiClient {
    fn drop(&mut self) {
        for t in self.tasks.get_mut().unwrap_or_else(|e| e.into_inner()).drain(..) {
            t.abort();
        }
    }
}

/// Parse AMI messages and route them to pending actions by ActionID.
async fn read_loop(mut reader: BufReader<tokio::net::tcp::OwnedReadHalf>, pending: &Pending) -> anyhow::Result<()> {
    let mut cur = Msg::default();
    let mut line = String::new();
    loop {
        line.clear();
        if reader.read_line(&mut line).await? == 0 {
            anyhow::bail!("EOF");
        }
        let l = line.trim_end_matches(['\r', '\n']);
        if l.is_empty() {
            if !cur.0.is_empty() {
                dispatch(std::mem::take(&mut cur), pending);
            }
            continue;
        }
        if l == "--END COMMAND--" {
            continue;
        }
        match l.split_once(':') {
            Some((k, v)) if !k.is_empty() && !k.contains(' ') => {
                cur.0.push((k.to_string(), v.strip_prefix(' ').unwrap_or(v).to_string()));
            }
            // Legacy "Response: Follows" command output: bare text lines.
            _ => cur.0.push(("Output".into(), l.to_string())),
        }
    }
}

fn dispatch(msg: Msg, pending: &Pending) {
    let Some(id) = msg.get("ActionID").map(str::to_string) else { return };
    let mut p = pending.lock().unwrap_or_else(|e| e.into_inner());
    let Some(entry) = p.get_mut(&id) else { return };
    let list_start = msg.get("EventList").is_some_and(|s| s.eq_ignore_ascii_case("start"));
    let list_end = msg.get("EventList").is_some_and(|s| s.eq_ignore_ascii_case("Complete"));
    let is_response = msg.get("Response").is_some();
    entry.collected.push(msg);
    // A plain response completes the action; a list keeps collecting until its Complete event.
    if ((is_response && !list_start) || list_end)
        && let Some(done) = p.remove(&id) {
            let _ = done.tx.send(done.collected);
        }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dispatch_lists() {
        let pending: Pending = Arc::new(std::sync::Mutex::new(HashMap::new()));
        let (tx, mut rx) = oneshot::channel();
        pending.lock().unwrap().insert("a".into(), PendingAction { tx, collected: vec![] });
        let m = |pairs: &[(&str, &str)]| Msg(pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect());
        dispatch(m(&[("Response", "Success"), ("ActionID", "a"), ("EventList", "start")]), &pending);
        assert!(rx.try_recv().is_err());
        dispatch(m(&[("Event", "OutboundRegistrationDetail"), ("ActionID", "a"), ("Status", "Registered")]), &pending);
        dispatch(m(&[("Event", "OutboundRegistrationDetailComplete"), ("ActionID", "a"), ("EventList", "Complete")]), &pending);
        let got = rx.try_recv().unwrap();
        assert_eq!(got.len(), 3);
        assert_eq!(got[1].get("status"), Some("Registered"));
    }

    #[test]
    fn clean_strips_crlf() {
        assert_eq!(clean("1\r\nAction: Command"), "1  Action: Command");
    }
}
