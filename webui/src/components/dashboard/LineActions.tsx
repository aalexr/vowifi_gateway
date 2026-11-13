import { api, InstanceConfig } from "../../api";
import { Play, Square, Wrench, MonitorSmartphone } from "lucide-react";

interface LineActionsProps {
  inst: InstanceConfig;
  busy: boolean;
  run: (fn: () => Promise<unknown>) => void;
  onSipInfo: () => void;
  onConfigure: () => void;
}

export const LineActions = ({
  inst,
  busy,
  run,
  onSipInfo,
  onConfigure,
}: LineActionsProps) => {
  const state = inst.status?.state;
  const running = state !== "STOPPED" && state !== "ERROR";
  return (
    <div
      style={{ display: "flex", gap: 8, marginTop: 18, flexWrap: "wrap" }}
      onClick={(e) => e.stopPropagation()}
    >
      {state === "STOPPED" ? (
        <button
          className="btn btn-primary"
          disabled={busy}
          onClick={() => run(() => api.start(inst.id))}
        >
          <Play size={16} /> Start
        </button>
      ) : state === "ERROR" ? (
        <button
          className="btn btn-primary"
          disabled={busy}
          onClick={() => run(() => api.reprovision(inst.id))}
        >
          Re-provision
        </button>
      ) : (
        <button
          className="btn btn-ghost"
          disabled={busy}
          onClick={() => run(() => api.stop(inst.id))}
        >
          <Square size={16} /> Stop
        </button>
      )}
      {running && (
        <>
          <button
            className="btn btn-ghost"
            disabled={busy}
            onClick={() => run(() => api.register(inst.id))}
          >
            Re-register
          </button>
          <button
            className="btn btn-ghost"
            disabled={busy}
            onClick={() => run(() => api.reprovision(inst.id))}
          >
            Re-provision
          </button>
        </>
      )}
      <button className="btn btn-ghost" onClick={onSipInfo}>
        <MonitorSmartphone size={16} /> SIP info
      </button>
      <button className="btn btn-ghost" onClick={onConfigure}>
        <Wrench size={16} /> Configure
      </button>
    </div>
  );
};
