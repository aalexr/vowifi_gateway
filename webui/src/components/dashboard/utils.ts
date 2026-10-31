// Build one row per PHYSICAL reader. Each reader has: {index, name, present, card, instance}.
// - present + matched instance  -> live line status
// - present + unprovisioned card -> provision prompt
// - no card                     -> empty state
// Provisioned lines whose reader is unplugged are NOT shown here — the dashboard
// reflects physical readers only (their config stays available under SIM Config, and
// the line reappears automatically when its reader/card returns).
export function buildReaders(cards, instances) {
  return [...cards]
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((c) => {
      let inst = null;
      if (c.matched)
        inst = instances.find((i) => String(i.id) === String(c.matched));
      if (!inst && c.iccid) inst = instances.find((i) => i.iccid === c.iccid);
      return {
        index: c.index,
        name: c.name,
        present: !!c.present,
        card: c,
        instance: inst,
      };
    });
}

export function readerTitle(r) {
  const port = r.index != null ? `Reader ${r.index}` : "Reader";
  // "Alcor Link AK9563 00 00" — keep the human name after the port label
  return r.name ? `${port} · ${r.name}` : port;
}

export const PIN_RE = /^\d{4,8}$/; // basic client-side validity: 4–8 digits, numeric only
