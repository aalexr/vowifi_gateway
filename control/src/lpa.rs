//! lpa.rs - Thin async wrapper around a locally built lpac binary (PC/SC APDU + curl HTTP).
//!
//! lpac speaks NDJSON on stdout (`type: progress` lines, then one final `type: lpa`). One
//! process per operation, pinned to a reader with LPAC_APDU_PCSC_DRV_NAME (and to an ISD-R
//! with LPAC_CUSTOM_ISD_R_AID on dual-SE cards); progress lines go to an optional channel.
//! Cancel/timeout send SIGINT so lpac can end the ES9+/ES10b session cleanly.
//!
//! Concurrency with our own PC/SC access is the caller's job (per-reader locks + the
//! running-engine gate in api/esim.rs): lpac opens the card SCARD_SHARE_EXCLUSIVE.
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::sync::mpsc::UnboundedSender;

use crate::config;
use crate::estkme;

#[derive(Debug, Clone)]
pub struct LpaError {
    pub message: String,
    pub detail: Value,
    pub code: i64,
}

impl LpaError {
    fn new(message: impl Into<String>) -> Self {
        LpaError { message: message.into(), detail: Value::Null, code: -1 }
    }

    /// User-facing text; maps raw lpac function names to plain language.
    pub fn user_message(&self) -> String {
        let msg = self.message.trim().to_lowercase();
        let detail = match &self.detail {
            Value::Null => String::new(),
            Value::String(s) => s.trim().to_string(),
            Value::Object(o) if o.is_empty() => String::new(),
            other => other.to_string(),
        };
        if msg.starts_with("euicc_init") {
            return "This card does not appear to be an eUICC / eSIM. \
                    Ordinary USIM cards cannot be managed here.".into();
        }
        if msg == "cancelled" || msg == "cancel" {
            return "Operation cancelled.".into();
        }
        if msg.contains("timed out") {
            return "eSIM operation timed out. Try again.".into();
        }
        if !detail.is_empty() {
            return format!("{}: {detail}", self.message);
        }
        format!("eUICC operation failed ({}).", self.message)
    }
}

impl std::fmt::Display for LpaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

/// One `type: progress` line, as handed to the progress channel.
#[derive(Debug, Clone)]
pub struct Progress {
    pub step: String,
    pub data: Value,
}

/// In-flight download per reader name (pid), for cancel_download.
static ACTIVE: Mutex<Option<HashMap<String, u32>>> = Mutex::new(None);

fn active() -> std::sync::MutexGuard<'static, Option<HashMap<String, u32>>> {
    ACTIVE.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn lpac_bin() -> std::path::PathBuf {
    config::get_settings().esim.lpac_bin_path()
}

pub fn lpac_available() -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(lpac_bin()).map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false)
}

fn sigint(pid: u32) {
    let _ = nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid as i32), nix::sys::signal::Signal::SIGINT);
}

pub struct Run<'a> {
    pub args: Vec<String>,
    pub reader: &'a str,
    pub aid: Option<&'a str>,
    pub timeout: Duration,
    pub progress: Option<UnboundedSender<Progress>>,
    pub track: bool,
}

/// Run `lpac <args>`; Ok(final payload data) or LpaError (non-zero code, missing binary,
/// timeout, cancel).
pub async fn run_lpac(run: Run<'_>) -> Result<Value, LpaError> {
    let binary = lpac_bin();
    if !binary.is_file() {
        return Err(LpaError::new(format!("lpac binary not found at {}. Build it with: ./install.sh build-lpac",
                                         binary.display())));
    }
    if !lpac_available() {
        return Err(LpaError::new(format!("lpac binary is not executable: {}", binary.display())));
    }
    let aid = run.aid.map(|a| a.trim().to_uppercase().replace(' ', "")).filter(|a| !a.is_empty());
    tracing::info!("lpac exec reader={} aid={} cmd={} {}", run.reader,
                   aid.as_deref().map(|a| &a[..a.len().min(16)]).unwrap_or("-"),
                   binary.display(), run.args.join(" "));
    let mut cmd = tokio::process::Command::new(&binary);
    cmd.args(&run.args)
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .env("LPAC_APDU", "pcsc").env("LPAC_HTTP", "curl")
        // Host-level overrides would pick the wrong reader / ISD-R.
        .env_remove("LPAC_APDU_PCSC_DRV_IFID").env_remove("DRIVER_IFID");
    if run.reader.is_empty() {
        cmd.env_remove("LPAC_APDU_PCSC_DRV_NAME").env_remove("DRIVER_NAME");
    } else {
        cmd.env("LPAC_APDU_PCSC_DRV_NAME", run.reader);
    }
    match &aid {
        Some(a) => { cmd.env("LPAC_CUSTOM_ISD_R_AID", a); }
        None => { cmd.env_remove("LPAC_CUSTOM_ISD_R_AID"); }
    }
    let mut child = cmd.spawn().map_err(|e| LpaError::new(format!("failed to spawn lpac: {e}")))?;
    let pid = child.id();
    if run.track
        && let Some(pid) = pid {
            active().get_or_insert_with(HashMap::new).insert(run.reader.to_string(), pid);
        }
    let mut stderr = child.stderr.take();
    let stderr_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        if let Some(s) = stderr.as_mut() {
            let _ = s.read_to_end(&mut buf).await;
        }
        String::from_utf8_lossy(&buf).trim().to_string()
    });
    let stdout = child.stdout.take().expect("piped stdout");
    let mut lines = BufReader::new(stdout).lines();
    let mut final_payload: Option<Value> = None;

    let reading = async {
        while let Ok(Some(line)) = lines.next_line().await {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let Ok(obj) = serde_json::from_str::<Value>(line) else {
                tracing::debug!("lpac non-json stdout: {}", &line[..line.len().min(200)]);
                continue;
            };
            match obj.get("type").and_then(Value::as_str) {
                Some("progress") => {
                    let p = obj.get("payload").cloned().unwrap_or(Value::Null);
                    let ev = Progress {
                        step: p.get("message").and_then(Value::as_str).unwrap_or("").to_string(),
                        data: p.get("data").cloned().unwrap_or(Value::Null),
                    };
                    if let Some(tx) = &run.progress {
                        let _ = tx.send(ev);
                    }
                }
                Some("lpa") => final_payload = Some(obj.get("payload").cloned().unwrap_or(json!({}))),
                _ => {} // type=driver etc.
            }
        }
    };
    let timed_out = tokio::time::timeout(run.timeout, reading).await.is_err();
    if timed_out {
        if let Some(pid) = pid {
            sigint(pid);
        }
        // Give lpac a moment to close the eUICC session before the reader lock is released.
        if tokio::time::timeout(Duration::from_secs(5), child.wait()).await.is_err() {
            let _ = child.kill().await;
        }
    }
    let rc = child.wait().await.ok().and_then(|s| s.code()).unwrap_or(-1);
    let stderr_txt = stderr_task.await.unwrap_or_default();
    if run.track
        && let Some(map) = active().as_mut()
            && map.get(run.reader) == pid.as_ref() {
                map.remove(run.reader);
            }
    if timed_out {
        return Err(LpaError::new("lpac timed out"));
    }
    let Some(fin) = final_payload else {
        // Died without a final envelope (e.g. the driver failed to open the reader).
        let detail = if stderr_txt.is_empty() { format!("exit={rc}") } else { stderr_txt };
        return Err(LpaError { message: format!("lpac produced no result ({detail})"), detail: json!(detail),
                              code: if rc == 0 { -1 } else { rc as i64 } });
    };
    let code = fin.get("code").and_then(Value::as_i64).unwrap_or(-1);
    let data = fin.get("data").cloned().unwrap_or(Value::Null);
    if code != 0 {
        let message = fin.get("message").and_then(Value::as_str).unwrap_or("error").to_string();
        let empty = matches!(&data, Value::Null) || data == json!("") || data == json!({});
        let detail = if !empty { data } else if !stderr_txt.is_empty() { json!(stderr_txt) } else { Value::Null };
        return Err(LpaError { message, detail, code });
    }
    Ok(data)
}

/// SIGINT an in-flight download for this reader; true if one was signalled.
pub fn cancel_download(reader: &str) -> bool {
    let pid = active().as_ref().and_then(|m| m.get(reader).copied());
    match pid {
        Some(pid) => {
            sigint(pid);
            true
        }
        None => false,
    }
}

fn simple<'a>(args: &[&str], reader: &'a str, aid: Option<&'a str>, secs: u64) -> Run<'a> {
    Run { args: args.iter().map(|s| s.to_string()).collect(), reader, aid,
          timeout: Duration::from_secs(secs), progress: None, track: false }
}

pub async fn chip_info(reader: &str, aid: Option<&str>) -> Result<Value, LpaError> {
    let data = run_lpac(simple(&["chip", "info"], reader, aid, 60)).await?;
    let info2 = data.get("EUICCInfo2").cloned().unwrap_or(json!({}));
    let ext = info2.get("extCardResource").cloned().unwrap_or(json!({}));
    let addrs = data.get("EuiccConfiguredAddresses").cloned().unwrap_or(json!({}));
    let eid = data.get("eidValue").or_else(|| data.get("eid")).cloned()
        .filter(|v| v.as_str().is_some_and(|s| !s.is_empty())).unwrap_or(json!(""));
    let sas = info2.get("sasAccreditationNumber").filter(|v| !v.is_null() && *v != &json!(""))
        .or_else(|| info2.get("sasAcreditationNumber")).cloned().unwrap_or(Value::Null);
    Ok(json!({
        "eid": eid,
        "defaultDpAddress": addrs.get("defaultDpAddress").cloned().unwrap_or(Value::Null),
        "rootDsAddress": addrs.get("rootDsAddress").cloned().unwrap_or(Value::Null),
        "freeNonVolatileMemory": ext.get("freeNonVolatileMemory").cloned().unwrap_or(Value::Null),
        "freeVolatileMemory": ext.get("freeVolatileMemory").cloned().unwrap_or(Value::Null),
        "sasAccreditationNumber": sas,
        "raw": data,
    }))
}

fn list_of(v: Value) -> Vec<Value> {
    match v {
        Value::Array(a) => a,
        _ => Vec::new(),
    }
}

pub async fn profile_list(reader: &str, aid: Option<&str>) -> Result<Vec<Value>, LpaError> {
    Ok(list_of(run_lpac(simple(&["profile", "list"], reader, aid, 60)).await?))
}

pub async fn profile_enable(reader: &str, iccid: &str, aid: Option<&str>) -> Result<Value, LpaError> {
    let r = run_lpac(simple(&["profile", "enable", iccid], reader, aid, 90)).await?;
    maybe_process_notifications(reader, aid).await;
    Ok(r)
}

pub async fn profile_disable(reader: &str, iccid: &str, aid: Option<&str>) -> Result<Value, LpaError> {
    let r = run_lpac(simple(&["profile", "disable", iccid], reader, aid, 90)).await?;
    maybe_process_notifications(reader, aid).await;
    Ok(r)
}

pub async fn profile_delete(reader: &str, iccid: &str, aid: Option<&str>) -> Result<Value, LpaError> {
    let r = run_lpac(simple(&["profile", "delete", iccid], reader, aid, 90)).await?;
    maybe_process_notifications(reader, aid).await;
    Ok(r)
}

pub async fn profile_nickname(reader: &str, iccid: &str, nickname: &str, aid: Option<&str>) -> Result<Value, LpaError> {
    run_lpac(simple(&["profile", "nickname", iccid, nickname], reader, aid, 60)).await
}

#[derive(Debug, Default)]
pub struct DownloadArgs {
    pub activation_code: Option<String>,
    pub smdp: Option<String>,
    pub matching_id: Option<String>,
    pub confirmation_code: Option<String>,
    pub imei: Option<String>,
}

pub async fn download(reader: &str, a: DownloadArgs, aid: Option<&str>,
                      progress: Option<UnboundedSender<Progress>>) -> Result<Value, LpaError> {
    let some = |o: &Option<String>| o.clone().filter(|s| !s.is_empty());
    let mut args: Vec<String> = vec!["profile".into(), "download".into()];
    if let Some(ac) = some(&a.activation_code) {
        args.extend(["-a".into(), ac]);
    } else {
        if let Some(s) = some(&a.smdp) {
            args.extend(["-s".into(), s]);
        }
        if let Some(m) = some(&a.matching_id) {
            args.extend(["-m".into(), m]);
        }
    }
    if let Some(c) = some(&a.confirmation_code) {
        args.extend(["-c".into(), c]);
    }
    if let Some(i) = some(&a.imei) {
        args.extend(["-i".into(), i]);
    }
    let timeout = Duration::from_secs(config::get_settings().esim.download_timeout_s());
    let r = run_lpac(Run { args, reader, aid, timeout, progress, track: true }).await?;
    maybe_process_notifications(reader, aid).await;
    Ok(r)
}

pub async fn discovery(reader: &str, imei: Option<&str>, smds: Option<&str>, aid: Option<&str>) -> Result<Value, LpaError> {
    let mut args = vec!["profile", "discovery"];
    if let Some(s) = smds.filter(|s| !s.is_empty()) {
        args.extend(["-s", s]);
    }
    if let Some(i) = imei.filter(|s| !s.is_empty()) {
        args.extend(["-i", i]);
    }
    run_lpac(simple(&args, reader, aid, 120)).await
}

pub async fn notification_list(reader: &str, aid: Option<&str>) -> Result<Vec<Value>, LpaError> {
    Ok(list_of(run_lpac(simple(&["notification", "list"], reader, aid, 60)).await?))
}

/// `seq` None = all notifications.
pub async fn notification_process(reader: &str, seq: Option<i64>, autoremove: bool, aid: Option<&str>)
    -> Result<Value, LpaError>
{
    let mut args: Vec<String> = vec!["notification".into(), "process".into()];
    if seq.is_none() {
        args.push("-a".into());
    }
    if autoremove {
        args.push("-r".into());
    }
    if let Some(s) = seq {
        args.push(s.to_string());
    }
    run_lpac(Run { args, reader, aid, timeout: Duration::from_secs(180), progress: None, track: false }).await
}

pub async fn notification_remove(reader: &str, seq: i64, aid: Option<&str>) -> Result<Value, LpaError> {
    let s = seq.to_string();
    run_lpac(simple(&["notification", "remove", &s], reader, aid, 60)).await
}

/// Best-effort SGP.22 notification delivery after profile mutations.
pub async fn maybe_process_notifications(reader: &str, aid: Option<&str>) {
    if !config::get_settings().esim.auto_process_notifications {
        return;
    }
    if let Err(e) = notification_process(reader, None, true, aid).await {
        tracing::warn!("auto notification process failed reader={reader}: {} (code {}, {})", e.message, e.code, e.detail);
    }
}

fn tag(v: Value, se: &estkme::Se, eid: &Value) -> Value {
    match v {
        Value::Object(mut m) => {
            m.insert("seId".into(), json!(se.id));
            m.insert("seLabel".into(), json!(se.label));
            m.insert("seEid".into(), eid.clone());
            Value::Object(m)
        }
        other => other,
    }
}

/// Discover the SEs and load chip info + profiles + notifications for each:
/// {ses: [{id,label,aid,eid,freeSpace,...,profiles,notifications,error}], dual}.
pub async fn load_all_ses(reader: &str) -> Value {
    let name = reader.to_string();
    let ses = tokio::task::spawn_blocking(move || estkme::discover_ses(&name)).await
        .unwrap_or_else(|_| Vec::new());
    let mut out = Vec::new();
    for se in &ses {
        let aid = se.aid.as_deref();
        let mut entry = json!({
            "id": se.id, "label": se.label, "aid": se.aid, "eid": null, "freeSpace": null,
            "defaultDpAddress": null, "rootDsAddress": null, "profiles": [], "notifications": [],
            "error": null,
        });
        let loaded: Result<(), LpaError> = async {
            let chip = chip_info(reader, aid).await?;
            let eid = chip.get("eid").filter(|e| e.as_str().is_some_and(|s| !s.is_empty())).cloned()
                .unwrap_or(Value::Null);
            entry["eid"] = eid.clone();
            entry["freeSpace"] = chip["freeNonVolatileMemory"].clone();
            entry["defaultDpAddress"] = chip["defaultDpAddress"].clone();
            entry["rootDsAddress"] = chip["rootDsAddress"].clone();
            entry["chip"] = chip;
            let profiles = profile_list(reader, aid).await?;
            entry["profiles"] = Value::Array(profiles.into_iter().map(|p| tag(p, se, &eid)).collect());
            let notes = notification_list(reader, aid).await.unwrap_or_default();
            entry["notifications"] = Value::Array(notes.into_iter().map(|n| tag(n, se, &eid)).collect());
            Ok(())
        }.await;
        if let Err(e) = loaded {
            tracing::info!("SE {} load failed reader={reader}: {}", se.id, e.message);
            entry["error"] = json!(e.user_message());
        }
        out.push(entry);
    }
    let dual = out.len() > 1;
    json!({"ses": out, "dual": dual})
}
