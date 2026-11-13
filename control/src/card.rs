//! card.rs - PC/SC context helpers and non-intrusive reader/card presence detection.
//!
//! Presence uses SCardGetStatusChange (reader state only: no APDUs, no card connect), so it
//! runs continuously alongside the engines' card access without disturbing it. Indices are
//! aligned with `list_readers()` (what sim.rs uses). Everything here is blocking: async code
//! calls it via spawn_blocking.
use std::ffi::CString;
use std::time::Duration;

use pcsc::{Context, Disposition, Protocols, ReaderState, Scope, ShareMode};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct ReaderPresence {
    pub index: usize,
    pub name: String,
    pub present: bool,
}

pub fn context() -> Result<Context, pcsc::Error> {
    Context::establish(Scope::User)
}

fn names(ctx: &Context) -> Result<Vec<CString>, pcsc::Error> {
    ctx.list_readers_owned()
}

/// Reader names in PC/SC order (empty on any PC/SC error).
pub fn list_readers() -> Vec<String> {
    context()
        .and_then(|c| names(&c))
        .map(|v| {
            v.into_iter()
                .map(|n| n.to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default()
}

/// [{index, name, present}] per reader. `Some(vec![])` ONLY when pcscd authoritatively reports
/// zero readers; `None` on transient PC/SC errors (pcscd down/restarting) so the caller skips
/// that cycle instead of treating an outage as "every reader was unplugged" and stopping engines.
pub fn reader_states() -> Option<Vec<ReaderPresence>> {
    let ctx = context().ok()?;
    let readers = match names(&ctx) {
        Ok(r) => r,
        Err(pcsc::Error::NoReadersAvailable) => return Some(Vec::new()),
        Err(_) => return None,
    };
    if readers.is_empty() {
        return Some(Vec::new());
    }
    let mut rs: Vec<ReaderState> = readers
        .iter()
        .map(|n| ReaderState::new(n.clone(), pcsc::State::UNAWARE))
        .collect();
    ctx.get_status_change(Duration::ZERO, &mut rs).ok()?;
    Some(
        rs.iter()
            .enumerate()
            .map(|(i, r)| {
                let ev = r.event_state();
                ReaderPresence {
                    index: i,
                    name: r.name().to_string_lossy().into_owned(),
                    present: ev.contains(pcsc::State::PRESENT) && !ev.contains(pcsc::State::EMPTY),
                }
            })
            .collect(),
    )
}

/// Block until a reader is plugged/unplugged or a card moves, or until `timeout`.
/// Event-driven: the current readers plus pcscd's PnP pseudo-reader (which fires on reader-list
/// changes). Any PC/SC error degrades to a short sleep so the caller's scan loop keeps going.
pub fn wait_for_change(timeout: Duration) {
    let fallback = timeout.min(Duration::from_millis(1200));
    let Ok(ctx) = context() else {
        std::thread::sleep(fallback);
        return;
    };
    let mut readers = names(&ctx).unwrap_or_default();
    readers.push(pcsc::PNP_NOTIFICATION().to_owned());
    let mut rs: Vec<ReaderState> = readers
        .into_iter()
        .map(|n| ReaderState::new(n, pcsc::State::UNAWARE))
        .collect();
    // The first call resolves UNAWARE into the current state. With zero real readers pcsc-lite
    // reports nothing CHANGED for the PnP reader and the 0-timeout call returns TIMEOUT; the
    // states are still the resolved snapshot, so both codes proceed to the blocking wait.
    match ctx.get_status_change(Duration::ZERO, &mut rs) {
        Ok(()) | Err(pcsc::Error::Timeout) => {}
        Err(_) => {
            std::thread::sleep(fallback);
            return;
        }
    }
    // ...the second call blocks until any state differs from that snapshot. The snapshot keeps
    // the event counter (high word: card events, or the reader count for the PnP reader) but
    // must drop CHANGED, or pcsc-lite would report a change immediately.
    let mut rs: Vec<ReaderState> = rs
        .iter()
        .map(|r| {
            // DWORD is u64 on 64-bit Linux and u32 on 32-bit ARM: convert, don't assume.
            #[allow(clippy::useless_conversion)] // a no-op on 64-bit only
            let raw =
                r.event_state().bits() | (u64::from(r.event_count()) << 16).try_into().unwrap_or(0);
            let snapshot = pcsc::State::from_bits_retain(raw) - pcsc::State::CHANGED;
            ReaderState::new(r.name().to_owned(), snapshot)
        })
        .collect();
    let _ = ctx.get_status_change(timeout, &mut rs);
}

/// A card connection that ALWAYS ends with an explicit SCardDisconnect. The pcsc crate's own
/// Drop uses SCARD_RESET_CARD, which could reset a SIM an engine is using; this guard
/// disconnects with UNPOWER_CARD instead (pyscard's default: pcscd only powers the card down
/// when no other handle holds it). That matters for PIN state too: a VERIFY must not outlive
/// our connection, or the next probe would see the IMSI readable and report the PIN as off.
/// If the disconnect itself fails the handle is leaked (pcscd drops it with the context)
/// rather than reset.
pub struct Conn {
    card: Option<pcsc::Card>,
    disposition: Disposition,
}

impl Conn {
    pub fn shared(ctx: &Context, name: &str) -> Result<Conn, pcsc::Error> {
        let c = CString::new(name).map_err(|_| pcsc::Error::UnknownReader)?;
        let card = ctx.connect(&c, ShareMode::Shared, Protocols::ANY)?;
        Ok(Conn {
            card: Some(card),
            disposition: Disposition::UnpowerCard,
        })
    }

    pub fn direct(ctx: &Context, name: &str) -> Result<Conn, pcsc::Error> {
        let c = CString::new(name).map_err(|_| pcsc::Error::UnknownReader)?;
        let card = ctx.connect(&c, ShareMode::Direct, Protocols::T0 | Protocols::T1)?;
        Ok(Conn {
            card: Some(card),
            disposition: Disposition::LeaveCard,
        })
    }

    pub fn card(&mut self) -> &mut pcsc::Card {
        self.card.as_mut().expect("connection is open until drop")
    }
}

impl Drop for Conn {
    fn drop(&mut self) {
        if let Some(card) = self.card.take()
            && let Err((card, _)) = card.disconnect(self.disposition)
        {
            std::mem::forget(card);
        }
    }
}

/// One APDU -> (data, SW1, SW2).
pub fn transmit(card: &pcsc::Card, apdu: &[u8]) -> Result<(Vec<u8>, u8, u8), pcsc::Error> {
    let mut buf = [0u8; pcsc::MAX_BUFFER_SIZE_EXTENDED];
    let r = card.transmit(apdu, &mut buf)?;
    if r.len() < 2 {
        return Err(pcsc::Error::InvalidValue);
    }
    let (data, sw) = r.split_at(r.len() - 2);
    Ok((data.to_vec(), sw[0], sw[1]))
}

/// Run `f` inside a PC/SC transaction when one can be started (keeps a multi-APDU sequence from
/// interleaving with an engine's access to the same card); degrades to no transaction.
pub fn with_transaction<T>(card: &mut pcsc::Card, f: impl FnOnce(&pcsc::Card) -> T) -> T {
    match card.transaction2() {
        Ok(tx) => {
            let r = f(&tx);
            drop(tx); // SCardEndTransaction(LEAVE_CARD)
            r
        }
        Err((card, _)) => f(card),
    }
}

pub fn hx(s: &str) -> Vec<u8> {
    let s: String = s.chars().filter(|c| !c.is_whitespace()).collect();
    (0..s.len() / 2)
        .filter_map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).ok())
        .collect()
}
