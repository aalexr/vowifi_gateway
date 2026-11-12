import React, { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { InstanceId, InstanceConfig, DetectedCard } from "../api";
import {
  NoReadersBanner,
  ProvisionModal,
  ReaderCard,
  SipInfoModal,
  StartPinModal,
  buildReaders,
  pinError,
  NoSimBanner,
} from "../components/dashboard";
import { CommonViewProps } from "./common-view-props";

interface PinPrompt {
  inst: InstanceConfig;
  tries?: number;
  error: string;
}

interface Provision {
  card: DetectedCard;
  pin: string;
}

export default function Dashboard({
  instances,
  cards = [],
  noReaders,
  cardsKnown,
  refresh,
  setSelected,
  selected,
  showToast,
}: CommonViewProps) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState<InstanceId | null>(null);
  const [provision, setProvision] = useState<Provision | null>(null);
  const [sipInfo, setSipInfo] = useState<InstanceConfig | null>(null);
  const [pinPrompt, setPinPrompt] = useState<PinPrompt | null>(null); // {inst, tries, error} when a start needs a PIN

  const act = async (id: InstanceId, fn: () => Promise<unknown>) => {
    setBusy(id);
    try {
      await fn();
      await refresh();
    } catch (e) {
      const pe = pinError(e);
      const inst = pe && instances.find((i) => i.id === id);
      if (pe && inst)
        setPinPrompt({
          inst,
          tries: pe.tries,
          error:
            pe.code === "pin_invalid"
              ? "Saved PIN was wrong — enter it again."
              : "",
        });
      else {
        console.error(e);
      }
    }
    setBusy(null);
  };

  const rows = useMemo(
    () => buildReaders(cards, instances),
    [cards, instances],
  );

  // Nothing known yet (first /api/cards still in flight) — render nothing instead of
  // flashing a wrong "no readers" message.
  if (!cardsKnown && rows.length === 0) {
    return (
      <div style={{ color: "var(--text-mute)", fontSize: 13 }}>
        Detecting card readers…
      </div>
    );
  }

  if (noReaders) return <NoReadersBanner />;

  return (
    <div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill,minmax(360px,1fr))",
          gap: 16,
        }}
      >
        {rows.length === 0 ? (
          <NoSimBanner />
        ) : (
          rows.map((r) => (
            <ReaderCard
              key={`rdr-${r.name || r.index}`}
              reader={r}
              selected={!!r.instance && selected?.id === r.instance.id}
              busy={!!r.instance && busy === r.instance.id}
              onSelect={(inst) => setSelected(inst.id)}
              run={(inst, fn) => act(inst.id, fn)}
              onSipInfo={setSipInfo}
              onConfigure={(inst) => {
                setSelected(inst.id);
                navigate("/sims");
              }}
              onViewLogs={(inst) => {
                setSelected(inst.id);
                navigate("/logs");
              }}
              onProvision={(pin) => setProvision({ card: r.card, pin })}
              refresh={refresh}
            />
          ))
        )}
      </div>
      {provision && (
        <ProvisionModal
          card={provision.card}
          pin={provision.pin}
          onClose={() => setProvision(null)}
          onDone={refresh}
        />
      )}
      {sipInfo && (
        <SipInfoModal
          instance={sipInfo}
          onClose={() => setSipInfo(null)}
          setSelected={setSelected}
        />
      )}
      {pinPrompt && (
        <StartPinModal
          inst={pinPrompt.inst}
          tries={pinPrompt.tries}
          error={pinPrompt.error}
          onClose={() => setPinPrompt(null)}
          onDone={refresh}
        />
      )}
    </div>
  );
}
