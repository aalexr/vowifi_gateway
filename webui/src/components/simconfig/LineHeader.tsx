import React from "react";
import type { InstanceConfig } from "../../api";
import { Pipeline } from "../dashboard/Pipeline";
import { StateBadge } from "../dashboard/StateBadge";
import { StatusBanner } from "../dashboard/StatusBanner";

/**
 * The line being configured and its health, same lamps and pipeline as the Dashboard, so a
 * broken line's failing step and reason stay in view while its config is edited.
 */
export default function LineHeader({
  line,
  readerLabel,
  onViewLogs,
}: {
  line: InstanceConfig;
  /** "Reader 0" or "No reader" (where the SIM physically is now). */
  readerLabel: string;
  onViewLogs: () => void;
}) {
  const st = line.status;
  return (
    <section className="card simcfg-head" aria-labelledby="simcfg-title">
      <div className="simcfg-head-row">
        <div className="simcfg-head-id">
          <h1 id="simcfg-title" className="simcfg-title">
            {line.name || `Line ${line.id}`}
          </h1>
          <div className="simcfg-head-meta">
            <span>Line {line.id}</span>
            <span>{readerLabel}</span>
            {line.imsi && <span className="mono">IMSI {line.imsi}</span>}
          </div>
        </div>
        <StateBadge st={st} />
      </div>
      {st && st.state !== "STOPPED" && <Pipeline st={st} />}
      <StatusBanner status={st} onViewLogs={onViewLogs} />
    </section>
  );
}
