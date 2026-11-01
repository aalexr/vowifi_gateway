import React, { useEffect, useId, useState } from "react";
import { ChevronDown } from "lucide-react";

const STORAGE_PREFIX = "simconfig.section.";

function readOpen(id: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(STORAGE_PREFIX + id);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}

interface CollapsibleCardProps {
  /** Stable key used to remember the open/closed state across reloads. */
  id: string;
  title: React.ReactNode;
  /** Short text shown next to the title while the section is collapsed. */
  summary?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}

/** A `.card` panel whose body can be folded away by clicking its header. */
export default function CollapsibleCard({
  id,
  title,
  summary,
  defaultOpen = true,
  children,
}: CollapsibleCardProps) {
  const [open, setOpen] = useState(() => readOpen(id, defaultOpen));
  const bodyId = useId();

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_PREFIX + id, open ? "1" : "0");
    } catch {
      /* storage unavailable (private mode) — state just won't persist */
    }
  }, [id, open]);

  return (
    <section
      className="card"
      style={{ flex: "1 1 380px", minWidth: 0, alignSelf: "flex-start" }}
    >
      <h3 style={{ margin: 0 }}>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls={bodyId}
          className="flex w-full cursor-pointer items-center gap-2 rounded-[var(--radius)] border-0 bg-transparent text-left"
          style={{
            padding: "16px 20px",
            font: "inherit",
            color: "inherit",
          }}
        >
          <ChevronDown
            size={18}
            aria-hidden
            className="shrink-0 transition-transform duration-150"
            style={{
              transform: open ? undefined : "rotate(-90deg)",
              color: "var(--text-mute)",
            }}
          />
          <span>{title}</span>
          {!open && summary && (
            <span
              className="mono ml-auto truncate"
              style={{
                fontSize: 12,
                fontWeight: 400,
                color: "var(--text-mute)",
              }}
            >
              {summary}
            </span>
          )}
        </button>
      </h3>
      {open && (
        <div id={bodyId} style={{ padding: "0 20px 20px" }}>
          {children}
        </div>
      )}
    </section>
  );
}
