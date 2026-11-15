import React from "react";
import type { InstanceStatus } from "../../api";

// Reason line under the pipeline for lines that are neither OK nor STOPPED.
export const StatusBanner = ({
  status,
  onViewLogs,
}: {
  status?: InstanceStatus | null;
  onViewLogs: () => void;
}) => {
  if (
    !status ||
    status.state === "OK" ||
    status.state === "STOPPED" ||
    !status.reason
  )
    return null;
  const isError = status.state === "ERROR";
  return (
    <div
      className={`banner ${isError ? "banner-danger" : "banner-warn"}`}
      style={{ marginTop: 12 }}
    >
      {status.reason}
      {status.retry && status.retry.count > 0 && !isError && (
        <span style={{ color: "var(--text-mute)" }}>
          {" "}
          · attempt {status.retry.count}/{status.retry.max}
        </span>
      )}
      {isError && (
        <span>
          {" "}
          ·{" "}
          <button
            type="button"
            className="link-btn"
            onClick={(e) => {
              e.stopPropagation();
              onViewLogs();
            }}
          >
            view logs
          </button>
        </span>
      )}
    </div>
  );
};
