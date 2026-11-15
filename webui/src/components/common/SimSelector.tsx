import React, { useEffect, useId } from "react";
import type { InstanceConfig, DetectedCard, InstanceId } from "../../api";

const SHORT_LABELS = {
  "Active SIM / line": "Line",
  "Show logs for": "Logs",
  "Configuring line": "Config",
} as const;

interface SimSelectorProps {
  instances?: InstanceConfig[];
  cards?: DetectedCard[];
  selected?: InstanceConfig | null;
  setSelected: (id: InstanceId | null) => void;
  label?: keyof typeof SHORT_LABELS;
  /** List every line, marking the ones whose reader is absent (SIM Config: a line with its
   *  SIM unplugged is exactly the one whose config needs fixing). Off: only present lines. */
  includeAbsent?: boolean;
}

// Per-page SIM/line picker for multi-SIM setups. Labels each line with the physical reader
// it currently occupies (from the detected-cards state) so it's clear which reader's engine
// (docker container) will handle calls/SMS/logs. Switches the global `selected` instance.
//
// By default only lines whose physical reader is currently PRESENT are listed — a provisioned
// line whose reader/card is unplugged is dropped from the dropdown and reappears when the
// reader returns. SIM Config passes `includeAbsent` so those lines stay configurable there.
export default function SimSelector({
  instances = [],
  cards = [],
  selected,
  setSelected,
  label = "Active SIM / line",
  includeAbsent = false,
}: SimSelectorProps) {
  const selectId = useId();
  // A present card that maps to this line (by matched id or ICCID) means its reader is here.
  const readerFor = (i: InstanceConfig) =>
    cards.find(
      (c) =>
        c.present && (c.matched === i.id || (c.iccid && c.iccid === i.iccid)),
    );
  const live = instances.filter((i) => readerFor(i));
  const listed = includeAbsent ? instances : live;

  // If the currently-selected line's reader just went away, move selection to the first
  // still-present line (or clear it) so no view stays pinned to a vanished reader.
  const id = selected?.id != null ? selected.id : "";
  // Wait for the first card scan: the instance list usually arrives before it, and with no
  // cards yet every line looks absent, which would clear a valid selection on page load.
  useEffect(() => {
    if (includeAbsent || !cards.length) return;
    if (id && !live.some((i) => i.id === id)) {
      setSelected(live[0] ? live[0].id : null);
    }
  }, [id, cards.length, live.map((i) => i.id).join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!listed.length) return null;
  const shortLabel = SHORT_LABELS[label] || "Line";
  return (
    <div className="card sim-selector">
      <label htmlFor={selectId} className="sim-selector-label">
        <span className="sim-label-full">{label}</span>
        <span className="sim-label-short">{shortLabel}</span>
      </label>
      <select
        id={selectId}
        className="sim-selector-select"
        value={id || ""}
        onChange={(e) => setSelected(e.currentTarget.value)}
      >
        {!id && <option value="">— select —</option>}
        {listed.map((i) => {
          const c = readerFor(i);
          const rd = c ? `Reader ${c.index}` : "No reader";
          const st = i.status?.label ? ` — ${i.status.label}` : "";
          return (
            <option key={String(i.id)} value={String(i.id)}>
              {`${rd} · `}
              {i.name || i.imsi}
              {st}
            </option>
          );
        })}
      </select>
    </div>
  );
}
