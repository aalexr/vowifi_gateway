import { useEffect, useState } from "react";
import { api, InstanceConfig } from "../../api";
import {
  Play,
  Square,
  RefreshCw,
  RotateCcw,
  Wrench,
  MonitorSmartphone,
} from "lucide-react";

interface LineActionsProps {
  inst: InstanceConfig;
  busy: boolean;
  run: (fn: () => Promise<unknown>) => void;
  onSipInfo: () => void;
  onConfigure: () => void;
}

type Action = "start" | "stop" | "register" | "reprovision";

const PENDING_LABEL: Record<Action, string> = {
  start: "Starting…",
  stop: "Stopping…",
  register: "Re-registering…",
  reprovision: "Re-provisioning…",
};

export const LineActions = ({
  inst,
  busy,
  run,
  onSipInfo,
  onConfigure,
}: LineActionsProps) => {
  const state = inst.status?.state;
  const running = state !== "STOPPED" && state !== "ERROR";
  // Which button started the running action, so only that one says what is happening.
  const [pending, setPending] = useState<Action | null>(null);
  useEffect(() => {
    if (!busy) setPending(null);
  }, [busy]);

  const act = (a: Action, fn: () => Promise<unknown>) => () => {
    setPending(a);
    run(fn);
  };
  const label = (a: Action, idle: string) =>
    busy && pending === a ? PENDING_LABEL[a] : idle;

  return (
    <div
      aria-busy={busy}
      style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}
      onClick={(e) => e.stopPropagation()}
    >
      {state === "STOPPED" ? (
        <button
          className="btn btn-primary"
          disabled={busy}
          onClick={act("start", () => api.start(inst.id))}
        >
          <Play size={16} /> {label("start", "Start")}
        </button>
      ) : state === "ERROR" ? (
        <button
          className="btn btn-primary"
          disabled={busy}
          onClick={act("reprovision", () => api.reprovision(inst.id))}
        >
          <RotateCcw size={16} /> {label("reprovision", "Re-provision")}
        </button>
      ) : (
        <button
          className="btn btn-ghost"
          disabled={busy}
          onClick={act("stop", () => api.stop(inst.id))}
        >
          <Square size={16} /> {label("stop", "Stop")}
        </button>
      )}
      {running && (
        <>
          <button
            className="btn btn-ghost"
            disabled={busy}
            onClick={act("register", () => api.register(inst.id))}
          >
            <RefreshCw size={16} /> {label("register", "Re-register")}
          </button>
          {/* Recreating the engine is a recovery step: offered only while the line isn't OK. */}
          {state !== "OK" && (
            <button
              className="btn btn-ghost"
              disabled={busy}
              onClick={act("reprovision", () => api.reprovision(inst.id))}
            >
              <RotateCcw size={16} /> {label("reprovision", "Re-provision")}
            </button>
          )}
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
