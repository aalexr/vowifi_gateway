// Build one row per PHYSICAL reader. Each reader has: {index, name, present, card, instance}.
// - present + matched instance  -> live line status
// - present + unprovisioned card -> provision prompt
// - no card                     -> empty state
// Provisioned lines whose reader is unplugged are NOT shown here — the dashboard
// reflects physical readers only (their config stays available under SIM Config, and

import { DetectedCard, InstanceConfig } from "../../api";

interface Reader {
  index?: number;
  name?: string;
  present: boolean;
  card: DetectedCard;
  instance?: InstanceConfig | null;
}

// the line reappears automatically when its reader/card returns).
export function buildReaders(
  cards: DetectedCard[],
  instances: InstanceConfig[],
): Reader[] {
  return [...cards]
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((c) => {
      let inst: InstanceConfig | undefined | null = null;
      if (c.matched) {
        inst = instances.find((i) => i.id === c.matched);
      }
      if (!inst && c.iccid) inst = instances.find((i) => i.iccid === c.iccid);
      return {
        index: c.index,
        name: c.name,
        present: !!c.present,
        card: c,
        instance: inst,
      } satisfies Reader;
    });
}

export function readerTitle(r: Reader) {
  const port = r.index != null ? `Reader ${r.index}` : "Reader";
  // "Alcor Link AK9563 00 00" — keep the human name after the port label
  return r.name ? `${port} · ${r.name}` : port;
}

export const PIN_RE = /^\d{4,8}$/; // basic client-side validity: 4–8 digits, numeric only
