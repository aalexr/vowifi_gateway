//! usbreader.rs - Map live PC/SC reader indices to their STABLE physical USB port path.
//!
//! Two *identical* readers without a USB serial (e.g. Alcor AK9563 2ce3:9563) can only be told
//! apart by enumeration order, which races at boot / pcscd restart, so the reader name suffix
//! and index can flip between physically untouched readers. A line bound to "index 1" would
//! then authenticate against the wrong (or an empty) reader -> DEFAULT RES/CK/IK -> EAP-AKA
//! rejected. Lines therefore bind to the reader's USB port path (e.g. "3-2"), which only changes
//! when the reader is moved to another socket.
//!
//! Mapping: live index --SCARD_ATTR_CHANNEL_ID--> (bus, devnum) --/sys/bus/usb/devices/*-->
//! port. For USB readers CHANNEL_ID is a little-endian u32 0x0020_0000 | bus<<8 | devnum. The
//! query uses a SHARE_DIRECT connection: no card needed, no APDU sent, so a card an engine is
//! using is not disturbed. Best-effort throughout: an unresolvable reader is simply omitted.
use std::collections::BTreeMap;

use pcsc::Attribute;

use crate::card;

fn channel_id_bus_dev(ctx: &pcsc::Context, name: &str) -> Option<(u32, u32)> {
    let mut conn = card::Conn::direct(ctx, name).ok()?;
    let val = conn.card().get_attribute_owned(Attribute::ChannelId).ok()?;
    if val.len() < 4 {
        return None;
    }
    let v = u32::from_le_bytes([val[0], val[1], val[2], val[3]]);
    if v >> 16 != 0x0020 {
        return None; // not a USB transport
    }
    Some(((v >> 8) & 0xff, v & 0xff))
}

fn port_path_for(bus: u32, devnum: u32) -> Option<String> {
    let rd = std::fs::read_dir("/sys/bus/usb/devices").ok()?;
    for e in rd.flatten() {
        let d = e.path();
        let read = |f: &str| {
            std::fs::read_to_string(d.join(f))
                .ok()?
                .trim()
                .parse::<u32>()
                .ok()
        };
        if read("busnum") == Some(bus) && read("devnum") == Some(devnum) {
            return Some(e.file_name().to_string_lossy().into_owned());
        }
    }
    None
}

/// {live index: USB port path} for every resolvable reader. Blocking.
pub fn reader_port_paths() -> BTreeMap<usize, String> {
    let mut out = BTreeMap::new();
    // One context for the whole scan, released on drop (pcscd caps clients at 200 contexts and
    // this runs on API polls).
    let Ok(ctx) = card::context() else { return out };
    let Ok(readers) = ctx.list_readers_owned() else {
        return out;
    };
    for (i, r) in readers.iter().enumerate() {
        let name = r.to_string_lossy();
        if let Some((bus, dev)) = channel_id_bus_dev(&ctx, &name)
            && let Some(p) = port_path_for(bus, dev)
        {
            out.insert(i, p);
        }
    }
    out
}

pub fn port_for_index(index: usize) -> Option<String> {
    reader_port_paths().remove(&index)
}

pub fn index_for_port(port: &str) -> Option<usize> {
    if port.is_empty() {
        return None;
    }
    reader_port_paths()
        .into_iter()
        .find(|(_, p)| p == port)
        .map(|(i, _)| i)
}
