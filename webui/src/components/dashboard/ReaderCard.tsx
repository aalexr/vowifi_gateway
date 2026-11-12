import React from "react";
import type { InstanceConfig } from "../../api";
import { Pipeline } from "./Pipeline";
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
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 15, fontWeight: 700 }}>
              {readerTitle(r)}
            </span>
            {selected && (
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  color: "var(--primary)",
                  border: "1px solid var(--primary)",
                  borderRadius: 6,
                  padding: "1px 6px",
                }}
              >
                ACTIVE
              </span>
            )}
          </div>
          <div
            style={{ fontSize: 12, color: "var(--text-mute)", marginTop: 3 }}
          >
            {inst
              ? inst.name || `Line ${inst.id}`
              : r.present
                ? "Unprovisioned SIM"
                : "Empty"}
          </div>
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
          <Pipeline st={inst.status} />
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
      ) : (
        <div style={{ marginTop: 14, fontSize: 13, color: "var(--text-mute)" }}>
          No SIM card inserted in this reader.
        </div>
      )}
    </div>
  );
};
