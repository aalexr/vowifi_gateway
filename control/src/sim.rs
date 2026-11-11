//! sim.rs - Physical USIM access via PC/SC (shared host pcscd).
//!
//! Reader/SIM detection and PIN management for the manager. Every multi-APDU sequence runs
//! inside a PC/SC transaction so it can't interleave with an engine's swu_ike / ami_usim /
//! pin_keeper access to the same card.
//!
//! SIM safety (PIN retries are finite): the retry counter is read with an empty VERIFY (63Cx),
//! which does not consume a try, and nothing here spends a try when `MIN_TRIES` or fewer
//! remain. A PIN must be 4-8 characters (TS 31.101 CHV) before any VERIFY is sent, so a typo
//! of the wrong length is refused locally instead of being sent to the card.
//!
//! All functions are blocking; call them through spawn_blocking.
use serde::Serialize;
use serde_json::{Value, json};

use crate::card::{self, Conn, hx, transmit, with_transaction};
use crate::usbreader;

/// Never verify/spend when this many or fewer attempts remain (avoid a PUK lock).
pub const MIN_TRIES: u8 = 2;

#[derive(Debug, Clone, Default, Serialize)]
pub struct CardInfo {
    pub reader: String,
    pub reader_index: usize,
    pub present: bool,
    pub imsi: Option<String>,
    pub mcc: Option<String>,
    pub mnc: Option<String>,
    pub mnc_len: Option<u8>,
    pub iccid: Option<String>,
    pub pin_enabled: Option<bool>,
    pub pin_tries: Option<u8>,
    pub smsc: Option<String>,
    pub error: Option<String>,
    /// Stable physical USB port path of this reader (usbreader.rs).
    pub reader_port: Option<String>,
}

impl CardInfo {
    /// The card reported a PIN problem (the established "PIN" in error check).
    pub fn pin_error(&self) -> bool {
        self.error.as_deref().is_some_and(|e| e.to_uppercase().contains("PIN"))
    }
}

type Card = pcsc::Card;
type R<T> = Result<T, pcsc::Error>;

fn hexs(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn swap_nibbles(s: &str) -> String {
    let c: Vec<char> = s.chars().collect();
    c.chunks(2).flat_map(|p| if p.len() == 2 { vec![p[1], p[0]] } else { vec![] }).collect()
}

fn dec_imsi(ef_hex: &str) -> Option<String> {
    if ef_hex.len() < 4 {
        return None;
    }
    let swapped = swap_nibbles(&ef_hex[2..]);
    let swapped = swapped.trim_end_matches('f');
    (!swapped.is_empty()).then(|| swapped[1..].to_string())
}

fn dec_iccid(ef_hex: &str) -> String {
    swap_nibbles(ef_hex).trim_end_matches('f').to_string()
}

/// 3GPP USIM application AID prefix (RID A000000087 + app code 1002). EF_DIR record 1 is not
/// always the USIM (China Telecom lists CSIM first), so the records are scanned for it.
const USIM_AID_PREFIX: &str = "A0000000871002";

fn usim_aid_from_dir(c: &Card) -> R<Option<Vec<u8>>> {
    let (_, s1, s2) = transmit(c, &hx("00a40004022f0000"))?;
    if s1 != 0x61 {
        return Ok(None);
    }
    let (fcp, s1, _) = transmit(c, &[0x00, 0xC0, 0x00, 0x00, s2])?;
    if s1 != 0x90 || fcp.len() < 8 {
        return Ok(None);
    }
    let rec_len = fcp[7];
    let mut first = None;
    for rec in 1..=10u8 {
        let (d, s1, _) = transmit(c, &[0x00, 0xB2, rec, 0x04, rec_len])?;
        // record template: 61 <len> 4F <aidlen> <AID...> [50 <len> label]
        if s1 != 0x90 || d.len() < 5 || d[0] != 0x61 || d[2] != 0x4F {
            break;
        }
        let aid_len = d[3] as usize;
        if d.len() < 4 + aid_len {
            break;
        }
        let aid = d[4..4 + aid_len].to_vec();
        if hexs(&aid).to_uppercase().starts_with(USIM_AID_PREFIX) {
            return Ok(Some(aid));
        }
        first.get_or_insert(aid);
    }
    Ok(first)
}

fn select_adf_usim(c: &Card) -> R<bool> {
    transmit(c, &hx("00a40004023f0000"))?;
    let Some(aid) = usim_aid_from_dir(c)? else { return Ok(false) };
    let mut apdu = vec![0x00, 0xA4, 0x04, 0x04, aid.len() as u8];
    apdu.extend_from_slice(&aid);
    let (_, s1, _) = transmit(c, &apdu)?;
    Ok(s1 == 0x61)
}

fn read_binary(c: &Card, fid: &str, len: u8) -> R<(Vec<u8>, u8, u8)> {
    transmit(c, &hx(&format!("00a4000402{fid}00")))?;
    transmit(c, &[0x00, 0xB0, 0x00, 0x00, len])
}

/// [len, TON/NPI, BCD...] -> E.164 string ("+" for international TON); None if unset.
fn decode_ton_bcd(field: &[u8]) -> Option<String> {
    if field.is_empty() || field[0] == 0x00 || field[0] == 0xFF || field.len() < 2 {
        return None;
    }
    let ln = field[0] as usize;
    let ton = field[1];
    let mut digits = String::new();
    for b in field.iter().skip(2).take(ln.saturating_sub(1)) {
        if b & 0x0F != 0x0F {
            digits.push(char::from(b'0' + (b & 0x0F).min(9)));
        }
        if (b >> 4) & 0x0F != 0x0F {
            digits.push(char::from(b'0' + ((b >> 4) & 0x0F).min(9)));
        }
    }
    if digits.is_empty() {
        return None;
    }
    Some(if ton & 0x70 == 0x10 { format!("+{digits}") } else { digits })
}

/// SMSC from EF_SMSP (6F42, under ADF_USIM) record 1 — the per-SIM SMS centre a real phone
/// uses. Needs ADF_USIM selected and CHV1 satisfied. TS 31.102 4.2.27 record layout:
/// [alpha(Y)][PI][TP-DA(12)][TP-SC(12)][PID][DCS][VP], Y = rec_len - 28.
fn read_smsc(c: &Card) -> R<Option<String>> {
    let (_, s1, s2) = transmit(c, &hx("00a40004026f4200"))?;
    if s1 != 0x61 {
        return Ok(None);
    }
    let (fcp, _, _) = transmit(c, &[0x00, 0xC0, 0x00, 0x00, s2])?;
    // FCP template 62 <len> <TLVs>; File Descriptor 82 bytes 3-4 = record length.
    let body: &[u8] = if fcp.len() >= 2 && fcp[0] == 0x62 {
        &fcp[2..(2 + fcp[1] as usize).min(fcp.len())]
    } else {
        &fcp
    };
    let mut rec_len = 0usize;
    let mut i = 0;
    while i + 1 < body.len() {
        let (t, l) = (body[i], body[i + 1] as usize);
        let v = &body[(i + 2).min(body.len())..(i + 2 + l).min(body.len())];
        if t == 0x82 && l >= 4 && v.len() >= 4 {
            rec_len = ((v[2] as usize) << 8) | v[3] as usize;
        }
        i += 2 + l;
    }
    if !(28..=255).contains(&rec_len) {
        return Ok(None);
    }
    let y = rec_len - 28;
    let (d, s1, _) = transmit(c, &[0x00, 0xB2, 0x01, 0x04, rec_len as u8])?;
    if s1 != 0x90 || d.len() < rec_len {
        return Ok(None);
    }
    Ok(decode_ton_bcd(&d[y + 13..y + 25]))
}

/// Retry counter via an empty VERIFY (does not consume a try). None = already verified in
/// this session / unknown.
fn pin_tries(c: &Card) -> R<Option<u8>> {
    let (_, s1, s2) = transmit(c, &hx("0020000100"))?;
    Ok(match (s1, s2) {
        (0x63, _) => Some(s2 & 0x0F),
        (0x69, 0x83) => Some(0),
        _ => None,
    })
}

fn valid_pin(pin: &str) -> bool {
    (4..=8).contains(&pin.len()) && pin.is_ascii()
}

fn pin_block(pin: &str) -> [u8; 8] {
    let mut b = [0xFFu8; 8];
    for (i, c) in pin.bytes().take(8).enumerate() {
        b[i] = c;
    }
    b
}

fn reader_name(index: usize) -> Option<String> {
    card::list_readers().into_iter().nth(index)
}

/// Read card identity. With `pin`, CHV1 is verified on the SAME connection before reading the
/// IMSI (PIN state does not survive a disconnect when no other handle holds the card).
pub fn read_card(reader_index: usize, pin: Option<&str>) -> CardInfo {
    let mut info = CardInfo { reader_index, ..Default::default() };
    let Some(name) = reader_name(reader_index) else {
        info.error = Some("reader index out of range".into());
        return info;
    };
    info.reader = name.clone();
    info.reader_port = usbreader::port_for_index(reader_index);
    let ctx = match card::context() {
        Ok(c) => c,
        Err(e) => {
            info.error = Some(format!("no card: {e}"));
            return info;
        }
    };
    let mut conn = match Conn::shared(&ctx, &name) {
        Ok(c) => c,
        Err(e) => {
            info.error = Some(format!("no card: {e}"));
            return info;
        }
    };
    info.present = true;
    let res = with_transaction(conn.card(), |c| read_card_body(c, pin, &mut info));
    if let Err(e) = res {
        info.error = Some(format!("{e:?}"));
    }
    info
}

fn read_card_body(c: &Card, pin: Option<&str>, info: &mut CardInfo) -> R<()> {
    // ICCID (EF 2FE2 under MF): no PIN needed.
    transmit(c, &hx("00a40004023f0000"))?;
    let (d, s1, _) = read_binary(c, "2fe2", 10)?;
    if s1 == 0x90 {
        info.iccid = Some(dec_iccid(&hexs(&d)));
    }
    if !select_adf_usim(c)? {
        info.error = Some("ADF.USIM select failed".into());
        return Ok(());
    }
    // Provisional PIN status from the retry counter; refined below by whether EF_IMSI reads.
    let tries = pin_tries(c)?;
    info.pin_tries = tries;
    info.pin_enabled = Some(tries.is_some());
    let pin = pin.filter(|p| !p.is_empty());
    if let (Some(p), Some(t)) = (pin, tries)
        && t >= MIN_TRIES {
            if !valid_pin(p) {
                info.error = Some("PIN must be 4-8 digits".into());
            } else {
                let mut apdu = vec![0x00, 0x20, 0x00, 0x01, 0x08];
                apdu.extend_from_slice(&pin_block(p));
                let (_, s1, s2) = transmit(c, &apdu)?;
                if (s1, s2) != (0x90, 0x00) {
                    info.error = Some(if s1 == 0x63 { "wrong PIN".into() } else { format!("pin sw={s1:02x}{s2:02x}") });
                }
            }
        }
    // IMSI (normally behind the PIN).
    transmit(c, &hx("00a40004026f0700"))?;
    let (d, s1, s2) = transmit(c, &hx("00b0000009"))?;
    if s1 == 0x90 {
        if let Some(imsi) = dec_imsi(&hexs(&d)) {
            info.mcc = Some(imsi.chars().take(3).collect());
            info.imsi = Some(imsi);
        }
        if pin.is_none() {
            // Readable WITHOUT our VERIFY -> no PIN needed right now (disabled, or satisfied by
            // another holder). Some cards answer 63Cx even with the PIN disabled, so the retry
            // query alone can't be trusted for "enabled".
            info.pin_enabled = Some(false);
        }
    } else if (s1, s2) == (0x69, 0x82) {
        info.pin_enabled = Some(true); // security status not satisfied
    }
    // EF_AD (6FAD) byte 4 = MNC length.
    transmit(c, &hx("00a40004026fad00"))?;
    let (d, s1, _) = transmit(c, &hx("00b0000004"))?;
    if s1 == 0x90 && d.len() >= 4 {
        info.mnc_len = Some(d[3]);
        if let Some(imsi) = &info.imsi {
            let n = d[3] as usize;
            info.mnc = Some(imsi.chars().skip(3).take(n).collect());
        }
    }
    info.smsc = read_smsc(c).ok().flatten();
    Ok(())
}

/// Open a connection for a PIN op, or an {"ok": false} error body.
fn open(reader_index: usize) -> Result<(pcsc::Context, String), Value> {
    let Some(name) = reader_name(reader_index) else {
        return Err(json!({"ok": false, "error": "reader index out of range"}));
    };
    let ctx = card::context().map_err(|_| json!({"ok": false, "error": "No SIM card in this reader."}))?;
    Ok((ctx, name))
}

fn pin_op(reader_index: usize, f: impl FnOnce(&Card) -> R<Value>) -> Value {
    let (ctx, name) = match open(reader_index) {
        Ok(v) => v,
        Err(e) => return e,
    };
    let mut conn = match Conn::shared(&ctx, &name) {
        Ok(c) => c,
        Err(_) => return json!({"ok": false, "error": "No SIM card in this reader."}),
    };
    with_transaction(conn.card(), f).unwrap_or_else(|e| json!({"ok": false, "error": format!("{e}")}))
}

pub fn verify_pin(pin: &str, reader_index: usize) -> Value {
    if !valid_pin(pin) {
        return json!({"ok": false, "error": "PIN must be 4-8 digits"});
    }
    pin_op(reader_index, |c| {
        if !select_adf_usim(c)? {
            return Ok(json!({"ok": false, "error": "ADF.USIM select failed"}));
        }
        let tries = pin_tries(c)?;
        if tries == Some(0) {
            return Ok(json!({"ok": false, "error": "PIN blocked", "tries": 0}));
        }
        if let Some(t) = tries.filter(|t| *t < MIN_TRIES) {
            return Ok(json!({"ok": false, "error": format!("refusing: only {t} tries left"), "tries": t}));
        }
        let mut apdu = vec![0x00, 0x20, 0x00, 0x01, 0x08];
        apdu.extend_from_slice(&pin_block(pin));
        let (_, s1, s2) = transmit(c, &apdu)?;
        Ok(match (s1, s2) {
            (0x90, 0x00) => json!({"ok": true, "tries": 3}),
            (0x63, _) => json!({"ok": false, "error": "wrong PIN", "tries": s2 & 0x0F}),
            (0x69, 0x83) => json!({"ok": false, "error": "PIN blocked", "tries": 0}),
            _ => json!({"ok": false, "error": format!("sw={s1:02x}{s2:02x}")}),
        })
    })
}

pub fn change_pin(old: &str, new: &str, reader_index: usize) -> Value {
    if !valid_pin(old) || !valid_pin(new) {
        return json!({"ok": false, "error": "PIN must be 4-8 digits"});
    }
    pin_op(reader_index, |c| {
        if !select_adf_usim(c)? {
            return Ok(json!({"ok": false, "error": "ADF.USIM select failed"}));
        }
        if let Some(t) = pin_tries(c)?.filter(|t| *t < MIN_TRIES) {
            return Ok(json!({"ok": false, "error": format!("refusing: only {t} tries left")}));
        }
        // CHANGE CHV1: 00 24 00 01 10 <old padded FF> <new padded FF>
        let mut apdu = vec![0x00, 0x24, 0x00, 0x01, 0x10];
        apdu.extend_from_slice(&pin_block(old));
        apdu.extend_from_slice(&pin_block(new));
        let (_, s1, s2) = transmit(c, &apdu)?;
        Ok(match (s1, s2) {
            (0x90, 0x00) => json!({"ok": true}),
            (0x63, _) => json!({"ok": false, "error": "wrong old PIN", "tries": s2 & 0x0F}),
            _ => json!({"ok": false, "error": format!("sw={s1:02x}{s2:02x}")}),
        })
    })
}

/// ENABLE (0x28) / DISABLE (0x26) CHV1.
pub fn set_pin_enabled(pin: &str, enabled: bool, reader_index: usize) -> Value {
    if !valid_pin(pin) {
        return json!({"ok": false, "error": "PIN must be 4-8 digits"});
    }
    let ins = if enabled { 0x28 } else { 0x26 };
    pin_op(reader_index, |c| {
        if !select_adf_usim(c)? {
            return Ok(json!({"ok": false, "error": "ADF.USIM select failed"}));
        }
        if let Some(t) = pin_tries(c)?.filter(|t| *t < MIN_TRIES) {
            return Ok(json!({"ok": false, "error": format!("refusing: only {t} tries left")}));
        }
        let mut apdu = vec![0x00, ins, 0x00, 0x01, 0x08];
        apdu.extend_from_slice(&pin_block(pin));
        let (_, s1, s2) = transmit(c, &apdu)?;
        Ok(match (s1, s2) {
            (0x90, 0x00) => json!({"ok": true}),
            (0x63, _) => json!({"ok": false, "error": "wrong PIN", "tries": s2 & 0x0F}),
            _ => json!({"ok": false, "error": format!("sw={s1:02x}{s2:02x}")}),
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decoders() {
        // EF_IMSI 08 29 43 01 ... -> "234..." (first nibble is the parity/type digit)
        assert_eq!(dec_imsi("082943010000000010").as_deref(), Some("234100000000001"));
        assert_eq!(dec_iccid("98440000000000000020"), "89440000000000000002");
        assert_eq!(decode_ton_bcd(&[0x07, 0x91, 0x44, 0x77, 0x58, 0x10, 0x06, 0xF0]).as_deref(),
                   Some("+44778501600"));
        assert_eq!(decode_ton_bcd(&[0xFF, 0xFF]), None);
        assert_eq!(pin_block("1234"), [0x31, 0x32, 0x33, 0x34, 0xFF, 0xFF, 0xFF, 0xFF]);
        assert!(!valid_pin("123"));
        assert!(!valid_pin("123456789"));
    }
}
