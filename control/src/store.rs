//! store.rs - SQLite persistence for SMS threads/messages and the call log.
//!
//! One DB per manager at $VOWIFI_DATA/vowifi.sqlite (same schema as the Python manager, so an
//! existing database is used as-is). Messages carry the instance id so a multi-SIM setup keeps
//! separate conversations. Callers broadcast new rows to the WebSocket layer.
//!
//! Calls carry the carrier leg's SDP codecs as the engine reported them in `call_result`
//! (`CallMedia`): on an incoming call the carrier's offer is every codec that network accepts,
//! which `carrier_codecs_seen` sums up per line.
//!
//! All functions are blocking (SQLite + fsync): async code calls them through
//! `tokio::task::spawn_blocking` (see `api::blocking`).
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OptionalExtension, Row, params, params_from_iter};
use serde::Serialize;

use crate::config;

fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

static DB: OnceLock<Mutex<Connection>> = OnceLock::new();

fn open() -> anyhow::Result<Connection> {
    std::fs::create_dir_all(config::data_dir())?;
    let c = Connection::open(config::data_dir().join("vowifi.sqlite"))?;
    // WAL + synchronous=NORMAL: one fsync per checkpoint instead of several per commit (each
    // can take tens to hundreds of ms on an SD card). A crash loses at most the last commit;
    // the DB stays consistent.
    c.pragma_update(None, "journal_mode", "WAL")?;
    c.pragma_update(None, "synchronous", "NORMAL")?;
    c.busy_timeout(std::time::Duration::from_secs(5))?;
    Ok(c)
}

fn with<T>(f: impl FnOnce(&mut Connection) -> rusqlite::Result<T>) -> anyhow::Result<T> {
    let m = DB.get().ok_or_else(|| anyhow::anyhow!("store not initialised"))?;
    let mut c = m.lock().unwrap_or_else(|e| e.into_inner());
    Ok(f(&mut c)?)
}

pub fn init() -> anyhow::Result<()> {
    let c = open()?;
    c.execute_batch(
        "CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            instance TEXT NOT NULL,
            direction TEXT NOT NULL,        -- 'in' | 'out'
            peer TEXT NOT NULL,             -- phone number / address
            body TEXT NOT NULL,
            status TEXT DEFAULT 'ok',       -- ok|pending|sent|delivered|failed
            ts INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_msg_inst_peer ON messages(instance, peer, ts);
        CREATE TABLE IF NOT EXISTS calls (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            instance TEXT NOT NULL,
            direction TEXT NOT NULL,        -- 'in' | 'out'
            peer TEXT NOT NULL,
            status TEXT DEFAULT '',         -- ringing|answered|missed|...
            start_ts INTEGER NOT NULL,
            end_ts INTEGER
        );
        -- Parts of inbound concatenated SMS, joined into one messages row (msg_id).
        CREATE TABLE IF NOT EXISTS sms_parts (
            instance TEXT NOT NULL,
            peer TEXT NOT NULL,
            ref INTEGER NOT NULL,           -- UDH concat reference
            total INTEGER NOT NULL,
            seq INTEGER NOT NULL,           -- 1-based part number
            body TEXT NOT NULL,
            msg_id INTEGER NOT NULL,
            ts INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_parts_group ON sms_parts(instance, peer, ref, total, ts);",
    )?;
    // Migration: per-message failure detail (added later). Fails harmlessly once present.
    let has_error: bool = c.prepare("SELECT 1 FROM pragma_table_info('messages') WHERE name='error'")?
        .exists([])?;
    if !has_error {
        c.execute("ALTER TABLE messages ADD COLUMN error TEXT", [])?;
    }
    // Migration: per-call SDP codecs (CallMedia, added later).
    for col in ["carrier_sdp", "carrier_bw", "our_sdp", "client_sdp"] {
        let has: bool = c.prepare("SELECT 1 FROM pragma_table_info('calls') WHERE name=?")?
            .exists([col])?;
        if !has {
            c.execute(&format!("ALTER TABLE calls ADD COLUMN {col} TEXT"), [])?;
        }
    }
    let _ = DB.set(Mutex::new(c));
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
pub struct Message {
    pub id: i64,
    pub instance: String,
    pub direction: String,
    pub peer: String,
    pub body: String,
    pub status: Option<String>,
    pub ts: i64,
    pub error: Option<String>,
}

impl Message {
    fn from_row(r: &Row) -> rusqlite::Result<Self> {
        Ok(Message {
            id: r.get("id")?,
            instance: r.get("instance")?,
            direction: r.get("direction")?,
            peer: r.get("peer")?,
            body: r.get("body")?,
            status: r.get("status")?,
            ts: r.get("ts")?,
            error: r.get("error")?,
        })
    }
}

/// One call's SDP codecs, comma-separated as chan_pjsip's CHANNEL(pjsip,*_sdp_*) prints them
/// ("EVS/16000,AMR-WB/16000,telephone-event/16000"). Empty = no SDP (call not answered,
/// or an engine image without the accessor).
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct CallMedia {
    /// The carrier's SDP: its offer on an incoming call, its answer on an outgoing one.
    pub carrier_sdp: String,
    /// The carrier SDP's b= lines ("AS:88,RS:0").
    pub carrier_bw: String,
    /// Our SDP to the carrier: the answer on an incoming call, the offer on an outgoing one.
    pub our_sdp: String,
    /// The answer on the local client leg (the client's on incoming calls, ours on outgoing).
    pub client_sdp: String,
}

impl CallMedia {
    /// Parse the engine's "rs=..&bw=..&ls=..&cl=.." string (extensions.conf.j2). Characters
    /// outside chan_pjsip's sanitised set are dropped, unknown keys ignored.
    pub fn parse(s: &str) -> Self {
        let mut m = CallMedia::default();
        for pair in s.trim().split('&') {
            let Some((k, v)) = pair.split_once('=') else { continue };
            let v: String = v.chars()
                .filter(|c| c.is_ascii_alphanumeric() || "/._+:-,".contains(*c))
                .take(512)
                .collect();
            match k {
                "rs" => m.carrier_sdp = v,
                "bw" => m.carrier_bw = v,
                "ls" => m.our_sdp = v,
                "cl" => m.client_sdp = v,
                _ => {}
            }
        }
        m
    }

    pub fn is_empty(&self) -> bool {
        *self == CallMedia::default()
    }
}

/// The speech codecs of an SDP codec list, in order (DTMF, comfort noise and unnamed payload
/// types dropped). The first one of an ANSWER is the codec the call uses.
pub fn speech_codecs(sdp: &str) -> Vec<&str> {
    sdp.split(',')
        .map(str::trim)
        .filter(|c| {
            let name = c.split('/').next().unwrap_or("").to_ascii_lowercase();
            !name.is_empty() && !name.starts_with("pt")
                && !["telephone-event", "cn", "red"].contains(&name.as_str())
        })
        .collect()
}

#[derive(Debug, Clone, Serialize)]
pub struct Call {
    pub id: i64,
    pub instance: String,
    pub direction: String,
    pub peer: String,
    pub status: Option<String>,
    pub start_ts: i64,
    pub end_ts: Option<i64>,
    #[serde(flatten)]
    pub media: CallMedia,
    /// Speech codec on the carrier leg (first of the answer), if known.
    pub carrier_codec: Option<String>,
    /// Speech codec on the local client leg, if known.
    pub client_codec: Option<String>,
}

impl Call {
    fn from_row(r: &Row) -> rusqlite::Result<Self> {
        let text = |col: &str| -> rusqlite::Result<String> {
            Ok(r.get::<_, Option<String>>(col)?.unwrap_or_default())
        };
        let media = CallMedia {
            carrier_sdp: text("carrier_sdp")?,
            carrier_bw: text("carrier_bw")?,
            our_sdp: text("our_sdp")?,
            client_sdp: text("client_sdp")?,
        };
        let direction: String = r.get("direction")?;
        let answer = if direction == "in" { &media.our_sdp } else { &media.carrier_sdp };
        let first = |sdp: &str| speech_codecs(sdp).first().map(|c| c.to_string());
        Ok(Call {
            id: r.get("id")?,
            instance: r.get("instance")?,
            peer: r.get("peer")?,
            status: r.get("status")?,
            start_ts: r.get("start_ts")?,
            end_ts: r.get("end_ts")?,
            carrier_codec: first(answer),
            client_codec: first(&media.client_sdp),
            media,
            direction,
        })
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Thread {
    pub peer: String,
    pub last_ts: i64,
    pub last_body: Option<String>,
    pub n: i64,
}

pub fn set_message_status(mid: i64, status: &str, error: Option<&str>) -> anyhow::Result<()> {
    with(|c| c.execute("UPDATE messages SET status=?, error=? WHERE id=?", params![status, error, mid]))?;
    Ok(())
}

pub fn add_message(instance: &str, direction: &str, peer: &str, body: &str, status: &str) -> anyhow::Result<Message> {
    let ts = now();
    let id = with(|c| {
        c.execute("INSERT INTO messages(instance,direction,peer,body,status,ts) VALUES(?,?,?,?,?,?)",
                  params![instance, direction, peer, body, status, ts])?;
        Ok(c.last_insert_rowid())
    })?;
    Ok(Message { id, instance: instance.into(), direction: direction.into(), peer: peer.into(),
                 body: body.into(), status: Some(status.into()), ts, error: None })
}

/// A concat reference is only 8/16 bits and senders reuse it: parts only join a group that
/// started recently, and older part rows are pruned.
const PART_GROUP_WINDOW_S: i64 = 24 * 3600;
const PART_KEEP_S: i64 = 7 * 24 * 3600;
pub const PART_GAP: &str = "[…]";

pub struct PartResult {
    pub message: Message,
    /// This part started a new row.
    pub created: bool,
    /// False for a re-delivered part (the SMSC resends a part whose RP-ACK it never got).
    pub changed: bool,
    pub complete: bool,
}

/// Store one part of an inbound concatenated SMS and (re)build its message row: the body is
/// the parts joined in order with PART_GAP for parts not received yet, so nothing is hidden
/// while the rest is in flight.
pub fn add_message_part(instance: &str, peer: &str, r#ref: i64, total: i64, seq: i64, body: &str)
    -> anyhow::Result<PartResult>
{
    let now = now();
    with(|c| {
        let tx = c.transaction()?;
        tx.execute("DELETE FROM sms_parts WHERE ts < ?", params![now - PART_KEEP_S])?;
        let mut msg_id: Option<i64> = tx.query_row(
            "SELECT msg_id FROM sms_parts WHERE instance=? AND peer=? AND ref=? AND total=? \
             AND ts >= ? ORDER BY ts DESC LIMIT 1",
            params![instance, peer, r#ref, total, now - PART_GROUP_WINDOW_S], |r| r.get(0)).optional()?;
        if let Some(mid) = msg_id {
            let same: Option<String> = tx.query_row(
                "SELECT body FROM sms_parts WHERE msg_id=? AND seq=?", params![mid, seq], |r| r.get(0))
                .optional()?;
            if let Some(same) = same {
                if same != body {
                    msg_id = None; // reference reused by a new message
                } else {
                    let m = tx.query_row("SELECT * FROM messages WHERE id=?", params![mid], Message::from_row)
                        .optional()?;
                    if let Some(m) = m {
                        let have: i64 = tx.query_row(
                            "SELECT COUNT(DISTINCT seq) FROM sms_parts WHERE msg_id=?", params![mid], |r| r.get(0))?;
                        tx.commit()?;
                        return Ok(PartResult { message: m, created: false, changed: false, complete: have >= total });
                    }
                    msg_id = None; // the message was deleted meanwhile
                }
            }
        }
        if let Some(mid) = msg_id {
            let exists = tx.query_row("SELECT 1 FROM messages WHERE id=?", params![mid], |_| Ok(()))
                .optional()?.is_some();
            if !exists {
                msg_id = None;
            }
        }
        let created = msg_id.is_none();
        let mid = match msg_id {
            Some(m) => m,
            None => {
                tx.execute("INSERT INTO messages(instance,direction,peer,body,status,ts) VALUES(?,?,?,?,?,?)",
                           params![instance, "in", peer, body, "ok", now])?;
                tx.last_insert_rowid()
            }
        };
        tx.execute("INSERT INTO sms_parts(instance,peer,ref,total,seq,body,msg_id,ts) VALUES(?,?,?,?,?,?,?,?)",
                   params![instance, peer, r#ref, total, seq, body, mid, now])?;
        let mut parts = std::collections::HashMap::new();
        {
            let mut st = tx.prepare("SELECT seq, body FROM sms_parts WHERE msg_id=?")?;
            let rows = st.query_map(params![mid], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?;
            for row in rows {
                let (s, b) = row?;
                parts.insert(s, b);
            }
        }
        let full: String = (1..=total).map(|s| parts.get(&s).map(String::as_str).unwrap_or(PART_GAP)).collect();
        tx.execute("UPDATE messages SET body=? WHERE id=?", params![full, mid])?;
        let m = tx.query_row("SELECT * FROM messages WHERE id=?", params![mid], Message::from_row)?;
        tx.commit()?;
        Ok(PartResult { message: m, created, changed: true, complete: parts.len() as i64 >= total })
    })
}

pub fn list_threads(instance: &str) -> anyhow::Result<Vec<Thread>> {
    with(|c| {
        let mut st = c.prepare(
            "SELECT peer, MAX(ts) AS last_ts,
                    (SELECT body FROM messages m2 WHERE m2.instance=m.instance AND m2.peer=m.peer
                     ORDER BY ts DESC LIMIT 1) AS last_body,
                    COUNT(*) AS n
             FROM messages m WHERE instance=? GROUP BY peer ORDER BY last_ts DESC")?;
        let rows = st.query_map(params![instance], |r| Ok(Thread {
            peer: r.get(0)?, last_ts: r.get(1)?, last_body: r.get(2)?, n: r.get(3)?,
        }))?;
        rows.collect()
    })
}

pub fn list_messages(instance: &str, peer: &str, limit: i64) -> anyhow::Result<Vec<Message>> {
    with(|c| {
        let mut st = c.prepare("SELECT * FROM messages WHERE instance=? AND peer=? ORDER BY ts ASC LIMIT ?")?;
        let rows = st.query_map(params![instance, peer, limit], Message::from_row)?;
        rows.collect()
    })
}

fn placeholders(n: usize) -> String {
    vec!["?"; n].join(",")
}

fn delete_ids(table: &str, instance: &str, ids: &[i64]) -> anyhow::Result<usize> {
    if ids.is_empty() {
        return Ok(0);
    }
    let sql = format!("DELETE FROM {table} WHERE instance=? AND id IN ({})", placeholders(ids.len()));
    let mut args: Vec<rusqlite::types::Value> = vec![instance.to_string().into()];
    args.extend(ids.iter().map(|i| rusqlite::types::Value::Integer(*i)));
    with(|c| c.execute(&sql, params_from_iter(args)))
}

pub fn delete_messages(instance: &str, ids: &[i64]) -> anyhow::Result<usize> {
    delete_ids("messages", instance, ids)
}

pub fn delete_thread(instance: &str, peer: &str) -> anyhow::Result<usize> {
    with(|c| c.execute("DELETE FROM messages WHERE instance=? AND peer=?", params![instance, peer]))
}

pub fn clear_messages(instance: &str) -> anyhow::Result<usize> {
    with(|c| c.execute("DELETE FROM messages WHERE instance=?", params![instance]))
}

pub fn add_call(instance: &str, direction: &str, peer: &str, status: &str) -> anyhow::Result<Call> {
    let ts = now();
    let id = with(|c| {
        c.execute("INSERT INTO calls(instance,direction,peer,status,start_ts) VALUES(?,?,?,?,?)",
                  params![instance, direction, peer, status, ts])?;
        Ok(c.last_insert_rowid())
    })?;
    Ok(Call { id, instance: instance.into(), direction: direction.into(), peer: peer.into(),
              status: Some(status.into()), start_ts: ts, end_ts: None,
              media: CallMedia::default(), carrier_codec: None, client_codec: None })
}

/// The most recent still-open call for (instance, direction), no older than `within_s`.
fn get_open_call(instance: &str, direction: &str, within_s: Option<i64>) -> anyhow::Result<Option<Call>> {
    let row = with(|c| c.query_row(
        "SELECT * FROM calls WHERE instance=? AND direction=? AND end_ts IS NULL \
         ORDER BY start_ts DESC LIMIT 1", params![instance, direction], Call::from_row).optional())?;
    Ok(row.filter(|r| within_s.is_none_or(|w| now() - r.start_ts <= w)))
}

/// Insert an inbound-call record, coalescing duplicate `call_in` events for the SAME
/// still-ringing call into one row. The IMS can deliver one INVITE several times (VoLTE
/// preconditions / GRUU fork / retransmit), all before the call_result, so the record is
/// still open and is reused. An anonymous dup ('') matches anything; a numbered one must match
/// (or fill in) the open record's peer — a different number is a distinct call.
pub fn add_call_deduped(instance: &str, direction: &str, peer: &str, status: &str) -> anyhow::Result<Call> {
    if let Some(mut open) = get_open_call(instance, direction, Some(90))?
        && (peer.is_empty() || open.peer.is_empty() || peer == open.peer) {
            if !peer.is_empty() && open.peer.is_empty() {
                with(|c| c.execute("UPDATE calls SET peer=? WHERE id=?", params![peer, open.id]))?;
                open.peer = peer.to_string();
            }
            return Ok(open);
        }
    add_call(instance, direction, peer, status)
}

/// Finalize the most recent open call for (instance, direction[, peer]). `peer` may be empty:
/// Asterisk's 'h' handler loses pre-Dial variables when the caller hangs up mid-Dial, and with
/// one call at a time "the latest open call of that direction" is unambiguous.
pub fn update_last_call(instance: &str, direction: &str, peer: Option<&str>, status: &str,
                        media: &CallMedia) -> anyhow::Result<Option<Call>>
{
    with(|c| {
        let id: Option<i64> = match peer.filter(|p| !p.is_empty()) {
            Some(p) => c.query_row(
                "SELECT id FROM calls WHERE instance=? AND direction=? AND peer=? AND end_ts IS NULL \
                 ORDER BY start_ts DESC LIMIT 1", params![instance, direction, p], |r| r.get(0)).optional()?,
            None => c.query_row(
                "SELECT id FROM calls WHERE instance=? AND direction=? AND end_ts IS NULL \
                 ORDER BY start_ts DESC LIMIT 1", params![instance, direction], |r| r.get(0)).optional()?,
        };
        let Some(id) = id else { return Ok(None) };
        c.execute("UPDATE calls SET status=?, end_ts=? WHERE id=?", params![status, now(), id])?;
        if !media.is_empty() {
            c.execute("UPDATE calls SET carrier_sdp=?, carrier_bw=?, our_sdp=?, client_sdp=? WHERE id=?",
                      params![media.carrier_sdp, media.carrier_bw, media.our_sdp, media.client_sdp, id])?;
        }
        c.query_row("SELECT * FROM calls WHERE id=?", params![id], Call::from_row).optional()
    })
}

pub fn list_calls(instance: &str, limit: i64) -> anyhow::Result<Vec<Call>> {
    with(|c| {
        let mut st = c.prepare("SELECT * FROM calls WHERE instance=? ORDER BY start_ts DESC LIMIT ?")?;
        let rows = st.query_map(params![instance, limit], Call::from_row)?;
        rows.collect()
    })
}

/// One codec (or b= value) seen from a carrier, over the logged calls.
#[derive(Debug, Clone, Serialize)]
pub struct SeenCodec {
    pub name: String,
    pub calls: i64,
    pub last_ts: i64,
}

/// What the carrier of a line has shown in SDP, from its call log: `offered` = every speech
/// codec in its incoming-call offers (what the network accepts), `answered` = the codec it
/// picked when answering our outgoing calls, `bandwidth` = its b= values. Each in order of
/// how many calls had it.
#[derive(Debug, Clone, Default, Serialize)]
pub struct CarrierCodecs {
    pub offered: Vec<SeenCodec>,
    pub answered: Vec<SeenCodec>,
    pub bandwidth: Vec<SeenCodec>,
    pub incoming_calls: i64,
    pub outgoing_calls: i64,
}

pub fn carrier_codecs_seen(instance: &str) -> anyhow::Result<CarrierCodecs> {
    let rows: Vec<(String, String, String, i64)> = with(|c| {
        let mut st = c.prepare(
            "SELECT direction, carrier_sdp, COALESCE(carrier_bw,''), start_ts FROM calls \
             WHERE instance=? AND COALESCE(carrier_sdp,'') != '' ORDER BY start_ts")?;
        let rows = st.query_map(params![instance], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?;
        rows.collect()
    })?;
    fn bump(list: &mut Vec<SeenCodec>, name: &str, ts: i64) {
        match list.iter_mut().find(|s| s.name.eq_ignore_ascii_case(name)) {
            Some(s) => { s.calls += 1; s.last_ts = s.last_ts.max(ts); }
            None => list.push(SeenCodec { name: name.to_string(), calls: 1, last_ts: ts }),
        }
    }
    let mut out = CarrierCodecs::default();
    for (direction, sdp, bw, ts) in &rows {
        let codecs = speech_codecs(sdp);
        // An offer may list a codec several times (MTS: AMR-WB x2, AMR x3 with other modes).
        let mut seen: Vec<&str> = Vec::new();
        if direction == "in" {
            out.incoming_calls += 1;
            for c in codecs {
                if !seen.iter().any(|s| s.eq_ignore_ascii_case(c)) {
                    seen.push(c);
                    bump(&mut out.offered, c, *ts);
                }
            }
        } else {
            out.outgoing_calls += 1;
            if let Some(c) = codecs.first() {
                bump(&mut out.answered, c, *ts);
            }
        }
        for b in bw.split(',').map(str::trim).filter(|b| !b.is_empty()) {
            bump(&mut out.bandwidth, b, *ts);
        }
    }
    // Stable sort: equally frequent codecs keep first-seen (= offer) order.
    for list in [&mut out.offered, &mut out.answered, &mut out.bandwidth] {
        list.sort_by_key(|s| std::cmp::Reverse(s.calls));
    }
    Ok(out)
}

pub fn delete_calls(instance: &str, ids: &[i64]) -> anyhow::Result<usize> {
    delete_ids("calls", instance, ids)
}

pub fn clear_calls(instance: &str) -> anyhow::Result<usize> {
    with(|c| c.execute("DELETE FROM calls WHERE instance=?", params![instance]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn call_media_parse_and_speech_codecs() {
        let m = CallMedia::parse("rs=EVS/16000,AMR-WB/16000,PCMA/8000,telephone-event/16000\
                                  &bw=AS:88&ls=AMR-WB/16000,telephone-event/16000&cl=G722/8000,PCMA/8000&x=1");
        assert_eq!(m.carrier_bw, "AS:88");
        assert_eq!(m.client_sdp, "G722/8000,PCMA/8000");
        assert_eq!(speech_codecs(&m.carrier_sdp), ["EVS/16000", "AMR-WB/16000", "PCMA/8000"]);
        assert_eq!(speech_codecs("telephone-event/8000,CN/8000,pt98,AMR/8000"), ["AMR/8000"]);
        // Shell/HTML metacharacters never survive.
        assert_eq!(CallMedia::parse("rs=AMR/8000;rm -rf <x>").carrier_sdp, "AMR/8000rm-rfx");
        assert!(CallMedia::parse("rs=&bw=&ls=&cl=").is_empty());
        assert!(CallMedia::parse("").is_empty());
    }
}
