import React from "react";
import { Plug } from "lucide-react";

// No PC/SC reader connected at all — friendly hint; the reader monitor updates
// this live, so the banner disappears the moment a reader is plugged in.
export const NoReadersBanner = () => {
  return (
    <div
      className="card"
      style={{
        padding: "32px 28px",
        textAlign: "center",
        marginBottom: 16,
      }}
    >
      <div
        style={{
          color: "var(--text-mute)",
          display: "flex",
          justifyContent: "center",
        }}
      >
        <Plug size={36} strokeWidth={1.5} />
      </div>
      <div style={{ fontSize: 16, fontWeight: 700, marginTop: 10 }}>
        No PC/SC smart-card reader found
      </div>
      <div
        style={{
          fontSize: 13,
          color: "var(--text-mute)",
          marginTop: 8,
          lineHeight: 1.6,
          maxWidth: 520,
          marginLeft: "auto",
          marginRight: "auto",
        }}
      >
        Connect a USB smart-card reader with your SIM inserted — it is detected
        automatically and this page updates in real time. Softphone, Messages
        and SIM Config are disabled until a reader is present.
      </div>
    </div>
  );
};
