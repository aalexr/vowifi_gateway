import React from "react";
import type { InstanceConfig } from "../../api";
import { Pipeline, RANK } from "./Pipeline";
import { StateBadge } from "./StateBadge";
import { StatusBanner } from "./StatusBanner";
import { LineDetails } from "./LineDetails";
import { LineActions } from "./LineActions";
import { UnprovisionedCard } from "./UnprovisionedCard";
import { readerTitle, type Reader } from "./utils";

interface ReaderCardProps {
  reader: Reader;
  selected: boolean;
  busy: boolean;
  onSelect: (inst: InstanceConfig) => void;
  run: (inst: InstanceConfig, fn: () => Promise<unknown>) => void;
  onSipInfo: (inst: InstanceConfig) => void;
  onConfigure: (inst: InstanceConfig) => void;
  onViewLogs: (inst: InstanceConfig) => void;
  onProvision: (pin: string) => void;
  refresh: () => Promise<void>;
}

// One physical reader: its identity header plus either the live line (provisioned),
// the PIN-gated provisioning flow (unprovisioned SIM) or an empty state.
export const ReaderCard = ({
  reader: r,
  selected,
  busy,
  onSelect,
  run,
  onSipInfo,
  onConfigure,
  onViewLogs,
  onProvision,
  refresh,
}: ReaderCardProps) => {
  const inst = r.instance;
  return (
    <div
      className="card"
      onClick={() => inst && onSelect(inst)}
      style={{
        padding: 20,
        cursor: inst ? "pointer" : "default",
        outline: selected
          ? "2px solid var(--primary)"
          : "1px solid transparent",
        outlineOffset: 2,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "start",
          gap: 10,
        }}
      >
        {/* The line leads; the reader it sits in is secondary. The selected line is
            marked by the card outline alone. */}
        <div style={{ minWidth: 0 }}>
          {inst ? (
            // The card click selects the line for the other tabs; this button is the
            // same action for keyboard and screen-reader users.
            <button
              type="button"
              className="line-title"
              aria-pressed={selected}
              onClick={(e) => {
                e.stopPropagation();
                onSelect(inst);
              }}
            >
              {inst.name || `Line ${inst.id}`}
            </button>
          ) : (
            <div style={{ fontSize: 15, fontWeight: 600 }}>
              {readerTitle(r)}
            </div>
          )}
          {inst && (
            <div
              style={{ fontSize: 12, color: "var(--text-mute)", marginTop: 3 }}
            >
              {readerTitle(r)}
            </div>
          )}
        </div>
        {inst ? (
          <StateBadge st={inst.status} />
        ) : (
          <span className={`pill${r.present ? " pill-warn" : ""}`}>
            <span
              className={`dot st-${r.present ? "REGISTERING" : "NO_CARD"}`}
            />
            {r.present ? "SIM detected" : "No SIM card"}
          </span>
        )}
      </div>

      {inst ? (
        <>
          {/* The pipeline locates a failure; a working or stopped line has none. */}
          {inst.status &&
            inst.status.state in RANK &&
            inst.status.state !== "OK" &&
            inst.status.state !== "STOPPED" && <Pipeline st={inst.status} />}
          <StatusBanner
            status={inst.status}
            onViewLogs={() => onViewLogs(inst)}
          />
          <LineDetails inst={inst} card={r.card} />
          <LineActions
            inst={inst}
            busy={busy}
            run={(fn) => run(inst, fn)}
            onSipInfo={() => onSipInfo(inst)}
            onConfigure={() => onConfigure(inst)}
          />
        </>
      ) : r.present ? (
        <UnprovisionedCard
          card={r.card}
          refresh={refresh}
          onProvision={onProvision}
        />
      ) : null}
    </div>
  );
};
