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
}

// Per-page SIM/line picker for multi-SIM setups. Labels each line with the physical reader
// it currently occupies (from the detected-cards state) so it's clear which reader's engine
// (docker container) will handle calls/SMS/logs. Switches the global `selected` instance.
//
// Only lines whose physical reader is currently PRESENT are listed — a provisioned line
// whose reader/card is unplugged is dropped from the dropdown (its config stays under SIM
// Config and it reappears when the reader returns).
export default function SimSelector({
  instances = [],
  cards = [],
  selected,
  setSelected,
  label = "Active SIM / line",
}: SimSelectorProps) {
  const selectId = useId();
  // A present card that maps to this line (by matched id or ICCID) means its reader is here.
  const readerFor = (i: InstanceConfig) =>
    cards.find(
      (c) =>
        c.present && (c.matched === i.id || (c.iccid && c.iccid === i.iccid)),
    );
  const live = instances.filter((i) => readerFor(i));

  // If the currently-selected line's reader just went away, move selection to the first
  // still-present line (or clear it) so no view stays pinned to a vanished reader.
  const id = selected?.id != null ? selected.id : "";
  useEffect(() => {
    if (id && !live.some((i) => i.id === id)) {
      setSelected(live[0] ? live[0].id : null);
    }
  }, [id, live.map((i) => i.id).join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!live.length) return null;
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
        onChange={(e) => setSelected(e.target.value)}
      >
        {!id && <option value="">— select —</option>}
        {live.map((i) => {
          const c = readerFor(i);
          const rd = c ? `Reader ${c.index}` : null;
          const st = i.status?.label ? ` — ${i.status.label}` : "";
          return (
            <option key={String(i.id)} value={String(i.id)}>
              {rd ? `${rd} · ` : ""}
              {i.name || i.imsi}
              {st}
            </option>
          );
        })}
      </select>
      {live.length === 1 && (
        <span className="sim-selector-hint">only line</span>
      )}
    </div>
  );
}
