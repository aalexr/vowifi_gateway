//! hub.rs - Shared manager state and the background loops.
//!
//! The Hub holds the AMI client per instance, the WebSocket fan-out, the live reader/card
//! table (keyed by reader NAME: PC/SC indices shift when a reader is unplugged), per-instance
//! health (bounded auto-retry), per-reader locks serialising our APDU access, and the set of
//! readers an LPA (lpac) operation currently owns exclusively.
//!
//! Background tasks: `card_monitor` (reader hotplug + card insert/remove; stops the engine of a
//! removed card) and `status_poller` (every 4 s: status -> apply_health -> broadcast).
//!
//! Invariants kept from the Python manager:
//!   * A card (re)appearing never auto-starts a line; the user presses Start / Re-provision.
//!     Only network-class freezes (NETWORK_RECOVERABLE) re-provision themselves once the ePDG
//!     resolves again, and a manual Stop never sets frozen_code, so it's never undone.
//!   * PIN safety: the preflight never verifies blindly; a stale saved PIN is cleared and the
//!     user must re-enter it. Card access is skipped while an engine or lpac holds the reader.
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use indexmap::{IndexMap, IndexSet};
use regex::Regex;
use serde::Serialize;
use serde_json::{Map, Value, json};
use tokio::sync::broadcast;

use crate::ami::AmiClient;
use crate::config::{self, Instance};
use crate::status::{self, State, Status};
use crate::{card, engine, push, sim, usbreader};

/// Run blocking work (PC/SC, SQLite, PAM, file IO) off the async workers.
pub async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> T {
    match tokio::task::spawn_blocking(f).await {
        Ok(v) => v,
        Err(e) => std::panic::resume_unwind(e.into_panic()),
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// One detected reader (and its card, when present) as the WebUI sees it.
#[derive(Debug, Clone, Default, Serialize)]
pub struct CardEntry {
    pub index: Option<usize>,
    pub name: String,
    pub present: bool,
    pub iccid: Option<String>,
    pub pin_enabled: Option<bool>,
    pub pin_tries: Option<u8>,
    pub matched: Option<String>,
    pub imsi: Option<String>,
    pub mcc: Option<String>,
    pub mnc: Option<String>,
    pub smsc: Option<String>,
    pub reader_port: Option<String>,
}

impl CardEntry {
    fn blank(index: usize, name: &str, present: bool) -> Self {
        CardEntry { index: Some(index), name: name.into(), present, ..Default::default() }
    }

    /// Copy the probed identity of a fresh card read into this entry.
    pub fn apply(&mut self, c: &sim::CardInfo) {
        self.present = true;
        self.iccid = c.iccid.clone();
        self.imsi = c.imsi.clone();
        self.mcc = c.mcc.clone();
        self.mnc = c.mnc.clone();
        self.pin_enabled = c.pin_enabled;
        self.pin_tries = c.pin_tries;
        self.smsc = c.smsc.clone();
    }
}

#[derive(Debug, Default, Clone)]
struct Health {
    fail_start: Option<Instant>,
    frozen_code: Option<String>,
    frozen_reason: Option<String>,
    recovering: bool,
    last_recover_try: Option<Instant>,
}

/// One MO-SMS submit report from an engine (notify.py `sms_report`, fed by the Asterisk fork's
/// VOWIFI_SMS_REPORT): the SMSC's RP-ACK / RP-ERROR, or a SIP failure of the MO MESSAGE.
#[derive(Debug, Clone, PartialEq)]
pub struct SmsReport {
    /// Unix seconds of arrival at the manager.
    pub ts: i64,
    /// "ack" | "error" | "sip"
    pub kind: String,
    /// RP-Cause (TS 24.011 8.2.5.4) of an RP-ERROR.
    pub rp_cause: Option<u8>,
    /// Final SIP status of a failed MO MESSAGE; 0 = no response / not registered.
    pub sip_status: Option<u16>,
    pub reason: String,
}

/// Reports kept per instance: enough for a multi-part SMS plus stragglers.
const SMS_REPORTS_KEPT: usize = 32;

/// WebSocket fan-out message.
#[derive(Debug, Clone)]
pub enum WsOut {
    Json(Arc<str>),
    /// Close with 4401 (session key rotated).
    CloseAll,
}

/// Result of the PIN preflight before an engine start.
#[derive(Debug, Clone)]
pub enum Preflight {
    Ok,
    Fail { code: &'static str, clear: bool, tries: Option<u8> },
}

/// Reason codes that are likely transient network/DNS problems: after freeze + stop the
/// poller probes the ePDG and re-provisions once it resolves. Permanent faults (SIM auth, not
/// authorized, proposal, PIN, reg reject) stay sticky.
pub const NETWORK_RECOVERABLE: &[&str] = &["epdg_unresolved", "tunnel_network", "tunnel_setup"];

pub struct Hub {
    ami: tokio::sync::Mutex<HashMap<String, Arc<AmiClient>>>,
    ami_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    ws: broadcast::Sender<WsOut>,
    pub cards: Mutex<IndexMap<String, CardEntry>>,
    pub scanned: AtomicBool,
    learning: Mutex<HashSet<String>>,
    msisdn_tries: Mutex<HashMap<String, u32>>,
    health: Mutex<HashMap<String, Health>>,
    pushed_calls: Mutex<IndexSet<i64>>,
    reader_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    lpa_busy: Mutex<IndexSet<String>>,
    sms_reports: Mutex<HashMap<String, VecDeque<SmsReport>>>,
}

impl Hub {
    pub fn new() -> Arc<Self> {
        let (ws, _) = broadcast::channel(256);
        Arc::new(Hub {
            ami: Default::default(),
            ami_locks: Default::default(),
            ws,
            cards: Default::default(),
            scanned: AtomicBool::new(false),
            learning: Default::default(),
            msisdn_tries: Default::default(),
            health: Default::default(),
            pushed_calls: Default::default(),
            reader_locks: Default::default(),
            lpa_busy: Default::default(),
            sms_reports: Default::default(),
        })
    }

    // ------------------------------------------------------------------- MO-SMS submit reports
    pub fn push_sms_report(&self, iid: &str, report: SmsReport) {
        let mut all = lock(&self.sms_reports);
        let q = all.entry(iid.to_string()).or_default();
        if q.len() >= SMS_REPORTS_KEPT {
            q.pop_front();
        }
        q.push_back(report);
    }

    /// Reports for `iid` that arrived at or after `since` (unix seconds), oldest first.
    pub fn sms_reports_since(&self, iid: &str, since: i64) -> Vec<SmsReport> {
        lock(&self.sms_reports).get(iid)
            .map(|q| q.iter().filter(|r| r.ts >= since).cloned().collect())
            .unwrap_or_default()
    }

    // ----------------------------------------------------------------------- websocket fan-out
    pub fn subscribe(&self) -> broadcast::Receiver<WsOut> {
        self.ws.subscribe()
    }

    pub fn broadcast(&self, msg: Value) {
        let _ = self.ws.send(WsOut::Json(Arc::from(msg.to_string())));
    }

    pub fn close_all_ws(&self) {
        let _ = self.ws.send(WsOut::CloseAll);
    }

    pub fn broadcast_status(&self, iid: &str, st: &Status) {
        let mut m = Map::new();
        m.insert("type".into(), json!("status"));
        m.insert("instance".into(), json!(iid));
        m.extend(st.to_json());
        self.broadcast(Value::Object(m));
    }

    pub fn broadcast_cards(&self) {
        self.broadcast(json!({"type": "cards", "cards": self.cards_list()}));
    }

    // ---------------------------------------------------------------------------- readers
    pub fn reader_lock(&self, name: &str) -> Arc<tokio::sync::Mutex<()>> {
        lock(&self.reader_locks).entry(name.to_string()).or_default().clone()
    }

    pub fn lpa_busy(&self, name: &str) -> bool {
        lock(&self.lpa_busy).contains(name)
    }

    /// Claim a reader for an LPA op; false if it was already claimed.
    pub fn set_lpa_busy(&self, name: &str) -> bool {
        lock(&self.lpa_busy).insert(name.to_string())
    }

    pub fn clear_lpa_busy(&self, name: &str) {
        lock(&self.lpa_busy).shift_remove(name);
    }

    pub fn busy_readers(&self) -> Vec<String> {
        lock(&self.lpa_busy).iter().cloned().collect()
    }

    pub fn card(&self, name: &str) -> Option<CardEntry> {
        lock(&self.cards).get(name).cloned()
    }

    pub fn set_card(&self, entry: CardEntry) {
        lock(&self.cards).insert(entry.name.clone(), entry);
    }

    /// Reader/card entries sorted by current PC/SC index (the UI display order).
    pub fn cards_list(&self) -> Vec<CardEntry> {
        let mut v: Vec<CardEntry> = lock(&self.cards).values().cloned().collect();
        v.sort_by(|a, b| (a.index.is_none(), a.index.unwrap_or(0), &a.name)
            .cmp(&(b.index.is_none(), b.index.unwrap_or(0), &b.name)));
        v
    }

    /// Recompute each card's matched instance. Only for entries with a known ICCID: entries
    /// mapped through a running engine's pin_status (identity not probed) keep their match.
    pub fn refresh_card_matches(&self) {
        let instances = config::list_instances();
        for c in lock(&self.cards).values_mut() {
            if c.present && c.iccid.as_deref().is_some_and(|s| !s.is_empty()) {
                c.matched = instances.iter().find(|i| i.iccid == c.iccid).map(|i| i.id.clone());
            }
        }
    }

    // -------------------------------------------------------------------------------- AMI
    /// The AMI client for a running instance, (re)built when missing, dead or pointing at an
    /// old endpoint. Serialised per instance so concurrent callers can't orphan each other's
    /// client.
    pub async fn ami_for(&self, iid: &str) -> Option<Arc<AmiClient>> {
        let l = lock(&self.ami_locks).entry(iid.to_string()).or_default().clone();
        let _g = l.lock().await;
        let inst = config::get_instance(iid);
        let running = match &inst {
            Some(_) => engine::is_running(iid).await,
            None => false,
        };
        let ep = inst.as_ref().filter(|_| running).map(engine::ami_endpoint);
        {
            let map = self.ami.lock().await;
            if let (Some(c), Some((host, port))) = (map.get(iid), &ep)
                && c.connected() && &c.host == host && c.port == *port {
                    return Some(c.clone());
                }
        }
        self.drop_ami(iid).await;
        let (inst, (host, port)) = (inst?, ep?);
        let client = AmiClient::new(iid, &host, port, inst.ami_user(), inst.ami_secret.as_deref().unwrap_or(""),
                                    &inst.realm(), inst.msisdn());
        client.connect().await;
        self.ami.lock().await.insert(iid.to_string(), client.clone());
        Some(client)
    }

    /// Tear down and forget an instance's AMI client. Call whenever its engine is stopped or
    /// recreated.
    pub async fn drop_ami(&self, iid: &str) {
        let c = self.ami.lock().await.remove(iid);
        if let Some(c) = c {
            c.close().await;
        }
    }

    pub async fn close_all_ami(&self) {
        let all: Vec<_> = self.ami.lock().await.drain().map(|(_, c)| c).collect();
        for c in all {
            c.close().await;
        }
    }

    // ------------------------------------------------------------------------------ health
    pub fn reset_health(&self, iid: &str) {
        lock(&self.health).insert(iid.to_string(), Health::default());
    }

    pub fn forget_msisdn_tries(&self, iid: &str) {
        lock(&self.msisdn_tries).remove(iid);
    }

    fn set_frozen(&self, iid: &str, code: &str, reason: String) {
        let mut h = lock(&self.health);
        let e = h.entry(iid.to_string()).or_default();
        e.frozen_code = Some(code.into());
        e.frozen_reason = Some(reason);
    }

    /// Overlay bounded auto-retry state on a live status. After `max` x `interval` seconds of
    /// continuous failure (SIM still present) the engine is stopped and the status frozen to
    /// ERROR + reason. Network-class freezes keep probing the ePDG and re-provision once it
    /// resolves (when auto_recover is on).
    pub async fn apply_health(self: &Arc<Self>, iid: &str, inst: &Instance, mut st: Status) -> Status {
        let settings = config::get_settings();
        let rcfg = match &inst.retry {
            Some(v) if crate::lenient::truthy(Some(v)) => v.clone(),
            _ => serde_json::to_value(&settings.retry).unwrap_or_else(|_| json!({})),
        };
        let rmax = crate::lenient::or(rcfg.get("max"), 3i64).max(1);
        let rint = crate::lenient::or(rcfg.get("interval"), 40i64).max(5);
        let auto_recover = crate::lenient::or(rcfg.get("auto_recover"), true);
        let interval = Duration::from_secs(rint as u64);

        let frozen = |h: &Health, st: &Status, retrying: bool| -> Status {
            Status {
                state: State::Error,
                label: State::Error.label(),
                reason_code: h.frozen_code.clone(),
                reason: h.frozen_reason.clone(),
                detail: st.detail.clone(),
                retry: Some(json!({"count": rmax, "max": rmax})),
                frozen: Some(true),
                retrying_network: retrying.then_some(true),
            }
        };

        if st.state == State::Ok {
            self.reset_health(iid);
            st.retry = Some(json!({"count": 0, "max": rmax}));
            return st;
        }
        let snapshot = lock(&self.health).entry(iid.to_string()).or_default().clone();
        if let Some(code) = snapshot.frozen_code.clone() {
            let recoverable = NETWORK_RECOVERABLE.contains(&code.as_str());
            if recoverable && auto_recover && !snapshot.recovering && inst.enabled() {
                let due = snapshot.last_recover_try.is_none_or(|t| t.elapsed() >= interval);
                if due && status::resolve_epdg(&inst.epdg_fqdn()).await {
                    let start = {
                        let mut h = lock(&self.health);
                        let e = h.entry(iid.to_string()).or_default();
                        if e.recovering {
                            false
                        } else {
                            e.last_recover_try = Some(Instant::now());
                            e.recovering = true;
                            true
                        }
                    };
                    if start {
                        tokio::spawn(Self::auto_recover_task(self.clone(), iid.to_string()));
                    }
                }
            }
            return frozen(&snapshot, &st, recoverable && auto_recover);
        }
        match st.state {
            State::Stopped => {
                st.retry = Some(json!({"count": 0, "max": rmax}));
                return st;
            }
            State::NoCard => {
                // Absent SIM is the card monitor's business: not a retry.
                lock(&self.health).entry(iid.to_string()).or_default().fail_start = None;
                st.retry = Some(json!({"count": 0, "max": rmax}));
                return st;
            }
            State::PinProblem => {
                // A wrong/blocked PIN won't recover by retrying: surface immediately.
                let mut h = lock(&self.health);
                let e = h.entry(iid.to_string()).or_default();
                e.frozen_code = st.reason_code.clone();
                e.frozen_reason = st.reason.clone();
                return frozen(e, &st, false);
            }
            _ => {}
        }
        // EPDG_UNRESOLVED / TUNNEL_DOWN / REGISTERING: the engine retries internally; bound the
        // total time, then give up (network-class freezes can still auto-recover).
        let (elapsed, freeze) = {
            let mut h = lock(&self.health);
            let e = h.entry(iid.to_string()).or_default();
            let start = *e.fail_start.get_or_insert_with(Instant::now);
            let elapsed = start.elapsed();
            let freeze = elapsed >= interval * rmax as u32;
            if freeze {
                e.frozen_code = st.reason_code.clone();
                e.frozen_reason = st.reason.clone();
                // Seed the recover cooldown: no stop -> restart in the same breath while the
                // network is still down.
                if NETWORK_RECOVERABLE.contains(&st.code()) {
                    e.last_recover_try = Some(Instant::now());
                }
            }
            (elapsed, freeze.then(|| e.clone()))
        };
        if let Some(h) = freeze {
            tracing::warn!(instance = %iid, "instance {iid}: giving up after {}s ({}) -> engine stopped", elapsed.as_secs(), st.code());
            if let Err(e) = engine::stop(iid).await {
                tracing::warn!(instance = %iid, "instance {iid}: stop after freeze failed: {e:#}");
            }
            self.drop_ami(iid).await;
            let retrying = NETWORK_RECOVERABLE.contains(&st.code()) && auto_recover;
            return frozen(&h, &st, retrying);
        }
        let count = ((elapsed.as_secs() / rint as u64) as i64 + 1).min(rmax);
        st.retry = Some(json!({"count": count, "max": rmax}));
        st
    }

    /// Boxed with an explicit `Send` type: auto_recover -> push_status -> apply_health spawns
    /// auto_recover again, and an unboxed recursive async type can't be checked for Send.
    fn auto_recover_task(hub: Arc<Self>, iid: String) -> futures::future::BoxFuture<'static, ()> {
        Box::pin(async move { hub.auto_recover(&iid).await })
    }

    /// Re-provision a line frozen for a recoverable network reason once the ePDG resolves.
    /// Mirrors Start (identity check, PIN preflight, reader rebind). A permanent preflight
    /// failure upgrades the freeze; a transient no_card leaves it for the next interval.
    async fn auto_recover(self: &Arc<Self>, iid: &str) {
        let r: anyhow::Result<()> = async {
            let Some(inst) = config::get_instance(iid) else { return Ok(()) };
            if !inst.enabled() {
                return Ok(());
            }
            let code = lock(&self.health).get(iid).and_then(|h| h.frozen_code.clone()).unwrap_or_default();
            if !NETWORK_RECOVERABLE.contains(&code.as_str()) {
                return Ok(());
            }
            if let Some((reader, iccid)) = self.card_identity_mismatch(&inst).await {
                self.set_frozen(iid, "card_mismatch", format!(
                    "The card in {reader} now has a different identity (ICCID {iccid}; this line expects {}). \
                     Provision the active profile as its own line, or switch back, then start.",
                    inst.iccid.as_deref().unwrap_or("")));
                tracing::warn!(instance = %iid, "auto-recover aborted — card mismatch instance={iid}");
                return Ok(());
            }
            // Rebind first: preflight must address the reader the SIM is in now (see launch).
            let inst = self.rebind_reader(inst, "auto-recover").await?;
            match self.preflight_pin(&inst).await {
                Preflight::Ok => {}
                Preflight::Fail { code: "no_card", .. } => {
                    tracing::info!(instance = %iid, "auto-recover deferred — no card instance={iid}");
                    return Ok(());
                }
                Preflight::Fail { code, clear, .. } => {
                    if clear {
                        blocking({ let id = iid.to_string(); move || config::clear_pin(&id) }).await;
                    }
                    let reason = status::reason(code);
                    let reason = if reason.is_empty() { "SIM PIN required or invalid — enter PIN and start again." } else { reason };
                    self.set_frozen(iid, code, reason.into());
                    tracing::warn!(instance = %iid, "auto-recover aborted — {code} instance={iid}");
                    return Ok(());
                }
            }
            self.forget_msisdn_tries(iid);
            // frozen_code stays until the start succeeds: a failed start leaves the freeze for
            // the next recover interval (and `recovering` blocks double-scheduling meanwhile).
            self.drop_ami(iid).await;
            tracing::info!(instance = %iid, "auto-recover re-provisioning instance={iid} (network restored)");
            engine::start(&inst, &config::get_settings()).await?;
            self.reset_health(iid);
            let hub = self.clone();
            let id = iid.to_string();
            tokio::spawn(async move { hub.push_status(&id).await });
            Ok(())
        }.await;
        if let Err(e) = r {
            tracing::warn!(instance = %iid, "auto-recover failed instance={iid}: {e:#}");
        }
        lock(&self.health).entry(iid.to_string()).or_default().recovering = false;
    }

    /// Compute + broadcast one instance's status now (event-driven).
    pub async fn push_status(self: &Arc<Self>, iid: &str) {
        let Some(inst) = config::get_instance(iid) else { return };
        let ami = self.ami_for(iid).await;
        let st = status::compute(&inst, ami.as_deref()).await;
        let st = self.apply_health(iid, &inst, st).await;
        self.broadcast_status(iid, &st);
    }

    pub async fn status_for(self: &Arc<Self>, inst: &Instance) -> Status {
        let ami = self.ami_for(&inst.id).await;
        let st = status::compute(inst, ami.as_deref()).await;
        self.apply_health(&inst.id, inst, st).await
    }

    pub fn spawn_push_status(self: &Arc<Self>, iid: &str) {
        let hub = self.clone();
        let id = iid.to_string();
        tokio::spawn(async move { hub.push_status(&id).await });
    }

    pub async fn status_poller(self: Arc<Self>) {
        loop {
            for inst in config::list_instances() {
                let iid = inst.id.clone();
                let ami = self.ami_for(&iid).await;
                let st = status::compute(&inst, ami.as_deref()).await;
                if st.state == State::Ok && inst.msisdn().is_empty() {
                    let start = {
                        let mut tries = lock(&self.msisdn_tries);
                        let mut learning = lock(&self.learning);
                        let n = tries.entry(iid.clone()).or_insert(0);
                        if !learning.contains(&iid) && *n < 4 {
                            *n += 1;
                            learning.insert(iid.clone());
                            true
                        } else {
                            false
                        }
                    };
                    if start {
                        let hub = self.clone();
                        let id = iid.clone();
                        tokio::spawn(async move { hub.learn_msisdn(&id).await });
                    }
                }
                let st = self.apply_health(&iid, &inst, st).await;
                self.broadcast_status(&iid, &st);
            }
            tokio::time::sleep(Duration::from_secs(4)).await;
        }
    }

    /// Learn the registered MSISDN from the REGISTER 200 OK's P-Associated-URI, which the engine's
    /// Asterisk stores in astdb volte/pau (fork patch VOWIFI_PAU_DB). It is there before the line
    /// reaches OK, so no re-REGISTER is needed (a forced one right after the initial REGISTER can
    /// be rate-limited by the IMS: Telefonica DE answers 503 + Retry-After, which then reads as
    /// reg_rejected). Attempts are capped by the poller.
    async fn learn_msisdn(self: &Arc<Self>, iid: &str) {
        let pau = match self.ami_for(iid).await {
            Some(ami) => ami.db_get("volte", "pau").await,
            None => String::new(),
        };
        if let Some(m) = msisdn_from_pau(&pau) {
            let mut patch = Map::new();
            patch.insert("id".into(), json!(iid));
            patch.insert("msisdn".into(), json!(m));
            match blocking(move || config::upsert_instance(patch)).await {
                Ok(_) => {
                    if let Some(c) = self.ami.lock().await.get(iid) {
                        c.set_msisdn(&m);
                    }
                    tracing::info!(instance = %iid, "learned MSISDN {m} for instance {iid}");
                    self.broadcast(json!({"type": "engine", "instance": iid, "event": "msisdn", "args": [m]}));
                }
                Err(e) => tracing::debug!("learn_msisdn persist failed: {e}"),
            }
        }
        lock(&self.learning).remove(iid);
    }

    /// Push-notify an inbound call once per call record (bounded dedupe set).
    pub fn first_push_for_call(&self, call_id: i64) -> bool {
        let mut s = lock(&self.pushed_calls);
        if !s.insert(call_id) {
            return false;
        }
        if s.len() > 512 {
            let drop_n = s.len() - 256;
            s.drain(..drop_n);
        }
        true
    }

    pub fn dispatch_push(&self, event: &'static str, iid: &str, source: &str, text: Option<String>) {
        let Some(inst) = config::get_instance(iid) else { return };
        let settings = config::get_settings();
        if !push::any_enabled(&settings) {
            return;
        }
        tokio::spawn(push::dispatch(settings, event, inst, source.to_string(), text));
    }

    // -------------------------------------------------------------- reader <-> line binding
    /// The running instance whose pin_keeper reports using this reader NAME.
    pub async fn find_running_by_reader(&self, name: &str) -> Option<Instance> {
        if name.is_empty() {
            return None;
        }
        for i in config::list_instances() {
            if !engine::is_running(&i.id).await {
                continue;
            }
            let ps = engine::read_run_json(&i.id, "pin_status.json");
            if ps.as_ref().and_then(|p| p.get("reader")).and_then(Value::as_str) == Some(name) {
                return Some(i);
            }
        }
        None
    }

    /// The live PC/SC index this instance should address: its STABLE USB port binding first
    /// (survives pcscd swapping two identical readers), else an ICCID match in the monitor.
    pub async fn reader_index_for_instance(&self, inst: &Instance) -> Option<usize> {
        if let Some(port) = inst.reader_port().map(String::from)
            && let Some(idx) = blocking(move || usbreader::index_for_port(&port)).await {
                return Some(idx);
            }
        let iccid = inst.iccid()?;
        lock(&self.cards).values().find(|c| c.present && c.iccid.as_deref() == Some(iccid)).and_then(|c| c.index)
    }

    /// The USB port this instance's SIM sits at now (by ICCID, from the live monitor).
    pub fn reader_port_for_instance(&self, inst: &Instance) -> Option<String> {
        let iccid = inst.iccid()?;
        lock(&self.cards).values()
            .find(|c| c.present && c.iccid.as_deref() == Some(iccid) && c.reader_port.is_some())
            .and_then(|c| c.reader_port.clone())
    }

    /// (reader label, ICCID) when the reader this line uses now holds a DIFFERENT identity —
    /// an eSIM profile switch, or another line's SIM swapped into the same reader. Starting
    /// anyway would run EAP-AKA with this line's IMSI against the wrong keys (rejected) and the
    /// engine would VERIFY this line's PIN on someone else's card. Only a positive, known
    /// conflict blocks; absent readers / unknown ICCIDs fail open.
    pub async fn card_identity_mismatch(&self, inst: &Instance) -> Option<(String, String)> {
        let want = inst.iccid()?.trim().to_string();
        let cards = lock(&self.cards);
        // This line's SIM is in some reader right now: no conflict (rebind_reader moves the
        // binding there). Not `reader_index_for_instance`: that resolves the saved USB port
        // whatever card sits in it, which is exactly the swapped-card case this guards.
        if cards.values().any(|c| c.present && c.iccid.as_deref().map(str::trim) == Some(want.as_str())) {
            return None;
        }
        let port = inst.reader_port().unwrap_or("").trim().to_string();
        let idx = inst.reader_index.and_then(|i| usize::try_from(i).ok());
        for c in cards.values().filter(|c| c.present) {
            let same_reader = if !port.is_empty() { c.reader_port.as_deref() == Some(port.as_str()) }
                              else { c.index == idx };
            if !same_reader {
                continue;
            }
            let got = c.iccid.as_deref().unwrap_or("").trim();
            if !got.is_empty() && got != want {
                let label = if !c.name.is_empty() { c.name.clone() }
                            else if !port.is_empty() { format!("USB {port}") }
                            else { format!("reader {}", idx.map(|i| i.to_string()).unwrap_or_default()) };
                return Some((label, got.to_string()));
            }
        }
        None
    }

    /// Check the SIM's PIN state BEFORE starting an engine (never bring the tunnel up against
    /// a locked card). Fails OPEN when the card can't be located/read (an engine may hold it).
    pub async fn preflight_pin(&self, inst: &Instance) -> Preflight {
        let fail_open = Preflight::Ok;
        let Some(idx) = self.reader_index_for_instance(inst).await else { return fail_open };
        let rname = blocking(card::list_readers).await.into_iter().nth(idx);
        if rname.as_deref().is_some_and(|n| self.lpa_busy(n)) {
            return fail_open; // lpac owns the reader exclusively; let the engine try later
        }
        let l = self.reader_lock(&rname.unwrap_or_else(|| format!("idx:{idx}")));
        // Busy reader (another op holds it): fail open rather than wait.
        let Ok(_g) = tokio::time::timeout(Duration::from_millis(50), l.lock_owned()).await else {
            return fail_open;
        };
        let saved = inst.pin().map(String::from);
        blocking(move || preflight_locked(idx, saved.as_deref())).await
    }

    /// Persist the reader the SIM sits in NOW (USB port by ICCID, then the live index from
    /// that port), so a line follows its SIM and survives pcscd re-enumerating identical
    /// readers. The engine also re-resolves port -> index itself on self-heal restarts.
    pub async fn rebind_reader(&self, mut inst: Instance, why: &str) -> anyhow::Result<Instance> {
        let mut patch = Map::new();
        if let Some(port) = self.reader_port_for_instance(&inst)
            && inst.reader_port() != Some(port.as_str()) {
                tracing::info!(instance = %inst.id, "{why} instance {}: reader port {:?} -> {port}", inst.id, inst.reader_port);
                patch.insert("reader_port".into(), json!(port));
                inst.reader_port = Some(port);
            }
        if let Some(idx) = self.reader_index_for_instance(&inst).await
            && inst.reader_index != Some(idx as i64) {
                tracing::info!(instance = %inst.id, "{why} instance {}: reader index {:?} -> {idx}", inst.id, inst.reader_index);
                patch.insert("reader_index".into(), json!(idx));
            }
        if patch.is_empty() {
            return Ok(inst);
        }
        patch.insert("id".into(), json!(inst.id));
        Ok(blocking(move || config::upsert_instance(patch)).await?)
    }

    // ------------------------------------------------------------------------ card monitor
    async fn on_card_insert(&self, name: &str, idx: usize) {
        let mut info = CardEntry::blank(idx, name, true);
        // Stable USB port for this index (DIRECT connect, no APDU: safe while an engine holds
        // the card).
        info.reader_port = blocking(move || usbreader::port_for_index(idx)).await;
        let prev = self.card(name).unwrap_or_default();
        // A running engine may already hold this card (manager restart, pcscd flap): map the
        // reader to it instead of probing. Skip probing while lpac owns the reader too (its
        // profile switch REFRESH looks like remove + insert).
        if let Some(inst) = self.find_running_by_reader(name).await {
            info.iccid = inst.iccid.clone();
            info.imsi = Some(inst.imsi.clone());
            info.matched = Some(inst.id.clone());
            info.smsc = inst.smsc.clone();
        } else if self.lpa_busy(name) {
            info = CardEntry { index: Some(idx), name: name.into(), present: true, reader_port: info.reader_port,
                               ..prev };
            tracing::info!("card insert during LPA busy — skipping probe reader={name}");
        } else {
            let l = self.reader_lock(name);
            let Ok(guard) = tokio::time::timeout(Duration::from_millis(50), l.lock_owned()).await else {
                info.iccid = prev.iccid;
                info.imsi = prev.imsi;
                info.matched = prev.matched;
                info.smsc = prev.smsc;
                self.set_card(info);
                tracing::debug!("card probe skipped — reader lock busy: {name}");
                return;
            };
            let c = blocking(move || sim::read_card(idx, None)).await;
            drop(guard);
            info.iccid = c.iccid.clone();
            info.pin_enabled = c.pin_enabled;
            info.pin_tries = c.pin_tries;
            info.imsi = c.imsi.clone();
            info.mcc = c.mcc.clone();
            info.mnc = c.mnc.clone();
            info.smsc = c.smsc.clone();
            if let Some(inst) = config::instance_by_iccid(info.iccid.as_deref()) {
                info.matched = Some(inst.id.clone());
                if info.imsi.is_none() {
                    info.imsi = Some(inst.imsi.clone());
                }
            }
        }
        tracing::info!("card inserted reader={idx} ({name}) iccid={:?} matched={:?}", info.iccid, info.matched);
        self.set_card(info);
        // Deliberately NO auto-start here: a reappearing card leaves the line stopped until
        // the user presses Start (avoids insert -> start -> fail -> stop loops and respects a
        // manual stop).
    }

    /// Card pulled (or the whole reader unplugged): stop the engine serving that card. `entry`
    /// is the reader's LAST-KNOWN state. Returns true when a running line was stopped.
    async fn on_card_remove(&self, entry: CardEntry, reader_unplugged: bool) -> bool {
        if !reader_unplugged {
            let mut blank = CardEntry::blank(entry.index.unwrap_or(0), &entry.name, false);
            blank.index = entry.index;
            self.set_card(blank);
        }
        tracing::info!("{} reader={:?} ({}) (was iccid={:?} matched={:?})",
                       if reader_unplugged { "reader unplugged" } else { "card removed" },
                       entry.index, entry.name, entry.iccid, entry.matched);
        let mut target = entry.matched.as_deref().and_then(config::get_instance);
        if target.is_none() {
            target = config::instance_by_iccid(entry.iccid.as_deref());
        }
        if target.is_none() {
            // Unknown identity: map by the reader NAME the running engine reports. Guessing
            // "the single running instance" could stop a healthy line on ANOTHER reader.
            target = self.find_running_by_reader(&entry.name).await;
        }
        let Some(t) = target else { return false };
        if !engine::is_running(&t.id).await {
            return false;
        }
        if let Err(e) = engine::stop(&t.id).await {
            tracing::warn!("stop engine {} after card removal failed: {e:#}", t.id);
        }
        self.drop_ami(&t.id).await;
        self.broadcast(json!({"type": "engine", "instance": t.id,
                              "event": if reader_unplugged { "reader_lost" } else { "card_removed" },
                              "args": [entry.name]}));
        self.broadcast(json!({"type": "status", "instance": t.id, "state": "NO_CARD",
                              "label": if reader_unplugged { "Reader unplugged" } else { "No SIM card (removed)" },
                              "detail": {}}));
        true
    }

    /// Real-time monitor for reader hotplug AND card insert/remove. Between scans it blocks in
    /// card::wait_for_change (PnP-aware SCardGetStatusChange): hotplug shows up near-instantly
    /// without hammering pcscd.
    pub async fn card_monitor(self: Arc<Self>) {
        let mut first = true;
        loop {
            let Some(states) = blocking(card::reader_states).await else {
                // Transient PC/SC error (pcscd restarting?) — NOT "all readers gone".
                tracing::debug!("card monitor: PC/SC unavailable, skipping scan");
                tokio::time::sleep(Duration::from_millis(1200)).await;
                continue;
            };
            let current: IndexMap<String, card::ReaderPresence> =
                states.into_iter().map(|s| (s.name.clone(), s)).collect();
            let mut changed = false;

            let gone: Vec<String> = lock(&self.cards).keys().filter(|n| !current.contains_key(*n)).cloned().collect();
            for name in gone {
                let Some(entry) = lock(&self.cards).shift_remove(&name) else { continue };
                if !self.on_card_remove(entry, true).await {
                    // on_card_remove already broadcast the more specific "reader_lost"; only
                    // emit the generic one when no line was affected (one toast in the UI).
                    self.broadcast(json!({"type": "engine", "instance": "", "event": "reader_removed", "args": [name]}));
                }
                changed = true;
            }

            for (name, st) in &current {
                let entry = self.card(name);
                if self.lpa_busy(name) {
                    // lpac holds the reader and its REFRESH looks like remove + insert: keep the
                    // last-known state.
                    match entry {
                        None => {
                            self.set_card(CardEntry::blank(st.index, name, st.present));
                            changed = true;
                        }
                        Some(mut e) if e.index != Some(st.index) => {
                            e.index = Some(st.index);
                            self.set_card(e);
                            changed = true;
                        }
                        _ => {}
                    }
                    continue;
                }
                let Some(mut e) = entry else {
                    if !first {
                        tracing::info!("reader plugged in: {name}");
                        self.broadcast(json!({"type": "engine", "instance": "", "event": "reader_added", "args": [name]}));
                    }
                    if st.present {
                        self.on_card_insert(name, st.index).await;
                    } else {
                        self.set_card(CardEntry::blank(st.index, name, false));
                    }
                    changed = true;
                    continue;
                };
                if e.index != Some(st.index) {
                    // Indices shift on unplug; the physical reader behind this name may have
                    // changed too, so refresh its USB port binding.
                    e.index = Some(st.index);
                    let idx = st.index;
                    e.reader_port = blocking(move || usbreader::port_for_index(idx)).await.or(e.reader_port);
                    self.set_card(e.clone());
                    changed = true;
                }
                if e.present != st.present {
                    if st.present {
                        self.on_card_insert(name, st.index).await;
                    } else {
                        self.on_card_remove(e, false).await;
                    }
                    changed = true;
                }
            }
            if changed {
                self.broadcast_cards();
            }
            // Only a completed scan counts (a failed first scan must retry as "first").
            self.scanned.store(true, Ordering::SeqCst);
            first = false;
            blocking(|| card::wait_for_change(Duration::from_millis(2500))).await;
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }
}

/// PIN preflight body — the caller holds the reader lock. Blocking.
fn preflight_locked(idx: usize, saved: Option<&str>) -> Preflight {
    let probe = sim::read_card(idx, None); // no VERIFY: learns presence + pin_enabled
    if !probe.present {
        return Preflight::Fail { code: "no_card", clear: false, tries: None };
    }
    if probe.pin_enabled == Some(false) {
        return Preflight::Ok;
    }
    let Some(saved) = saved else {
        return Preflight::Fail { code: "pin_required", clear: false, tries: probe.pin_tries };
    };
    let chk = sim::read_card(idx, Some(saved));
    if chk.pin_error() {
        return Preflight::Fail { code: "pin_invalid", clear: true, tries: chk.pin_tries };
    }
    Preflight::Ok
}

/// The MSISDN in a P-Associated-URI value ("<sip:+491...@ims...>, <tel:+491...>", possibly
/// several headers comma-joined): the first tel:/sip: identity that is an E.164 number.
/// Identities without one (sip:<IMSI>@...) are skipped.
fn msisdn_from_pau(pau: &str) -> Option<String> {
    static RE: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
        Regex::new(r"(?i)<(?:tel|sip):(\+\d+)").expect("valid regex")
    });
    RE.captures(pau).map(|c| c[1].to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn msisdn_from_pau_values() {
        assert_eq!(msisdn_from_pau("<sip:+4915112345678@ims.mnc003.mcc262.3gppnetwork.org>, <tel:+4915112345678>"),
                   Some("+4915112345678".into()));
        assert_eq!(msisdn_from_pau("<sip:262031234567890@ims.example>, <tel:+4915112345678;cpc=x>"),
                   Some("+4915112345678".into()));
        assert_eq!(msisdn_from_pau("<sip:262031234567890@ims.example>"), None);
        assert_eq!(msisdn_from_pau(""), None);
    }

    #[test]
    fn sms_reports_window() {
        let hub = Hub::new();
        let r = |ts, kind: &str| SmsReport { ts, kind: kind.into(), rp_cause: None, sip_status: None,
                                             reason: String::new() };
        for i in 0..40 {
            hub.push_sms_report("1", r(i, "ack"));
        }
        let got = hub.sms_reports_since("1", 30);
        assert_eq!(got.len(), 10);
        assert_eq!(got[0].ts, 30);
        assert_eq!(hub.sms_reports_since("1", 0).len(), SMS_REPORTS_KEPT);
        assert!(hub.sms_reports_since("2", 0).is_empty());
    }
}
