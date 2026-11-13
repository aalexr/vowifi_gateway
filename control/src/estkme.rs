//! estkme.rs - ESTKme dual-SE detection (ATR + product AID SKU), as in sigmo's lpa/estkme.go.
//!
//! Dual SE only for SKU "ESTKme Max" / "ESTKme Plus+":
//!   SE1 (se0) ISD-R AID A06573746B6D65FFFF4953442D522030
//!   SE2 (se1) ISD-R AID A06573746B6D65FFFF4953442D522031
//! Anything else is a single default eUICC (lpac probes the GSMA ISD-R AID itself).
//! Blocking (PC/SC): call through spawn_blocking.
use serde::Serialize;

use crate::card::{self, Conn, hx, transmit};

const ESTK_PRODUCT_AID: &str = "A06573746B6D65FFFFFFFFFFFF6D6774";
const ESTK_SE0_AID: &str = "A06573746B6D65FFFF4953442D522030";
const ESTK_SE1_AID: &str = "A06573746B6D65FFFF4953442D522031";

/// Historical bytes spelling "estk.me", present on known ESTKme ATRs.
const ESTK_MARKER: &[u8] = b"estk.me";

const ESTKME_ATRS: &[&[u8]] = &[
    &[
        0x3B, 0x9F, 0x96, 0x80, 0x1F, 0xC7, 0x80, 0x31, 0xE0, 0x73, 0xFE, 0x21, 0x15, 0x57, 0x65,
        0x73, 0x74, 0x6B, 0x2E, 0x6D, 0x65, 0xC1,
    ],
    &[
        0x3B, 0x9F, 0x96, 0x80, 0x3F, 0xC7, 0x82, 0x80, 0x31, 0xE0, 0x73, 0xFE, 0x21, 0x15, 0x57,
        0x65, 0x73, 0x74, 0x6B, 0x2E, 0x6D, 0x65, 0x63,
    ],
    &[
        0x3B, 0xBF, 0x93, 0x00, 0x80, 0x1F, 0xC6, 0x80, 0x31, 0xE0, 0x73, 0xFE, 0x21, 0x13, 0x57,
        0x65, 0x73, 0x74, 0x6B, 0x2E, 0x6D, 0x65, 0xE3,
    ],
];

/// One secure element (ISD-R) to address. `aid` None = lpac's default GSMA ISD-R.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Se {
    pub id: String,
    pub label: String,
    pub aid: Option<String>,
}

fn default_se() -> Se {
    Se {
        id: "default".into(),
        label: "eUICC".into(),
        aid: None,
    }
}

fn dual_ses() -> Vec<Se> {
    vec![
        Se {
            id: "se0".into(),
            label: "SE1".into(),
            aid: Some(ESTK_SE0_AID.into()),
        },
        Se {
            id: "se1".into(),
            label: "SE2".into(),
            aid: Some(ESTK_SE1_AID.into()),
        },
    ]
}

pub fn is_estkme_atr(atr: &[u8]) -> bool {
    !atr.is_empty()
        && (ESTKME_ATRS.contains(&atr) || atr.windows(ESTK_MARKER.len()).any(|w| w == ESTK_MARKER))
}

fn is_dual_sku(sku: &str) -> bool {
    matches!(sku.trim(), "ESTKme Max" | "ESTKme Plus+")
}

/// CLA for a logical channel (ISO 7816-4: basic 0-3, further 4-19).
fn set_cla(cla: u8, channel: u8) -> u8 {
    if channel < 4 {
        (cla & 0x9C) | channel
    } else if channel < 20 {
        (cla & 0xB0) | 0x40 | (channel - 4)
    } else {
        cla
    }
}

/// ESTKme SKU string, or None if the ATR / product AID / SKU read doesn't match.
pub fn read_estk_sku(reader_name: &str) -> Option<String> {
    let ctx = card::context().ok()?;
    let name = card::list_readers()
        .into_iter()
        .find(|r| r.contains(reader_name))?;
    let mut conn = match Conn::shared(&ctx, &name) {
        Ok(c) => c,
        Err(e) => {
            tracing::info!("ESTKme connect failed: {e}");
            return None;
        }
    };
    let c = conn.card();
    let atr = c
        .status2_owned()
        .ok()
        .map(|s| s.atr().to_vec())
        .unwrap_or_default();
    let atr_hex: String = atr.iter().map(|b| format!("{b:02X}")).collect();
    if !is_estkme_atr(&atr) {
        tracing::info!(
            "ESTKme ATR not matched reader={name} atr={} (single eUICC path)",
            if atr_hex.is_empty() { "-" } else { &atr_hex }
        );
        return None;
    }
    tracing::info!("ESTKme ATR matched reader={name} atr={atr_hex} — reading SKU");
    // MANAGE CHANNEL open
    let (data, s1, s2) = transmit(c, &[0x00, 0x70, 0x00, 0x00, 0x01]).ok()?;
    if (s1, s2) != (0x90, 0x00) || data.is_empty() {
        tracing::info!("ESTKme MANAGE CHANNEL open failed {s1:02X}{s2:02X}");
        return None;
    }
    let ch = data[0];
    let sku = (|| {
        let aid = hx(ESTK_PRODUCT_AID);
        let mut sel = vec![set_cla(0x00, ch), 0xA4, 0x04, 0x00, aid.len() as u8];
        sel.extend_from_slice(&aid);
        let (_, s1, s2) = transmit(c, &sel).ok()?;
        if s1 == 0x61 {
            transmit(c, &[set_cla(0x00, ch), 0xC0, 0x00, 0x00, s2]).ok()?;
        } else if (s1, s2) != (0x90, 0x00) {
            tracing::info!("ESTKme product SELECT failed {s1:02X}{s2:02X}");
            return None;
        }
        // INS=00 P1=03: ESTKme "read SKU string". Some cards reject Le=0 with 6Cxx (correct
        // length in SW2): retry with that Le.
        let (mut resp, mut s1, mut s2) =
            transmit(c, &[set_cla(0x00, ch), 0x00, 0x03, 0x00, 0x00]).ok()?;
        if s1 == 0x6C {
            (resp, s1, s2) = transmit(c, &[set_cla(0x00, ch), 0x00, 0x03, 0x00, s2]).ok()?;
        } else if s1 == 0x61 {
            (resp, s1, s2) = transmit(c, &[set_cla(0x00, ch), 0xC0, 0x00, 0x00, s2]).ok()?;
        }
        if (s1, s2) != (0x90, 0x00) {
            tracing::info!("ESTKme SKU read failed {s1:02X}{s2:02X}");
            return None;
        }
        let sku = String::from_utf8_lossy(&resp).trim().to_string();
        tracing::info!("ESTKme SKU reader={name} sku={sku:?}");
        Some(sku)
    })();
    let _ = transmit(c, &[0x00, 0x70, 0x80, ch, 0x00]); // MANAGE CHANNEL close
    sku
}

/// SE descriptors for the card in this reader (dual SE or the single default).
pub fn discover_ses(reader_name: &str) -> Vec<Se> {
    if let Some(sku) = read_estk_sku(reader_name) {
        if is_dual_sku(&sku) {
            tracing::info!("ESTKme dual SE detected reader={reader_name} sku={sku:?}");
            return dual_ses();
        }
        tracing::info!("ESTKme SKU is not dual-SE reader={reader_name} sku={sku:?} — single eUICC");
    }
    vec![default_se()]
}

/// Pick an SE: explicit AID first (a custom AID not in the list is allowed), then se_id; a
/// single-SE card needs neither.
pub fn resolve_se(ses: &[Se], se_id: Option<&str>, aid: Option<&str>) -> Result<Se, String> {
    if let Some(aid) = aid.filter(|a| !a.is_empty()) {
        let n = aid.trim().to_uppercase().replace(' ', "");
        if let Some(se) = ses
            .iter()
            .find(|s| s.aid.as_deref().map(str::to_uppercase).as_deref() == Some(n.as_str()))
        {
            return Ok(se.clone());
        }
        let id = se_id.filter(|s| !s.is_empty());
        return Ok(Se {
            id: id.unwrap_or("custom").into(),
            label: id.unwrap_or("eUICC").into(),
            aid: Some(n),
        });
    }
    if let Some(id) = se_id.filter(|s| !s.is_empty()) {
        return ses
            .iter()
            .find(|s| s.id == id)
            .cloned()
            .ok_or_else(|| format!("eUICC SE not found: {id}"));
    }
    if ses.len() == 1 {
        return Ok(ses[0].clone());
    }
    Err("eUICC SE is required for dual-SE cards".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn se_resolution() {
        let d = dual_ses();
        assert_eq!(
            resolve_se(&d, Some("se1"), None).unwrap().aid.as_deref(),
            Some(ESTK_SE1_AID)
        );
        assert!(resolve_se(&d, None, None).is_err());
        assert_eq!(
            resolve_se(&d, None, Some(&ESTK_SE0_AID.to_lowercase()))
                .unwrap()
                .id,
            "se0"
        );
        assert_eq!(
            resolve_se(&[default_se()], None, None).unwrap().id,
            "default"
        );
        assert_eq!(set_cla(0x00, 5), 0x41);
        assert!(is_estkme_atr(ESTKME_ATRS[0]));
        assert!(!is_estkme_atr(&[0x3B, 0x00]));
    }
}
