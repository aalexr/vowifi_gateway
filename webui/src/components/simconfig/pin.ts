import type { CardInfo, DetectedCard, InstanceStatus } from "../../api";

/** What the SIM Config panel knows about the card in the selected reader. */
export interface CardFacts {
  present: boolean;
  iccid?: string | null;
  imsi?: string | null;
  reader_port?: string | null;
  pin_enabled?: boolean | null;
  pin_tries?: number | null;
}

/**
 * The freshest facts for the selected reader, without touching the card: an explicit
 * "Detect card" result for this reader wins, else the host card monitor's last scan
 * (pushed over the WebSocket), else nothing.
 */
export function cardFacts(
  readerIdx: number,
  detected: CardInfo | null,
  monitored: DetectedCard[],
): CardFacts | null {
  if (detected && detected.reader_index === readerIdx) return detected;
  const live = monitored.find((c) => c.index === readerIdx);
  return live || null;
}

/** Remaining CHV1 attempts from whichever source has them (card, then the engine's PIN keeper). */
export function pinTries(
  facts: CardFacts | null,
  status?: InstanceStatus | null,
): number | null {
  if (facts?.pin_tries != null) return facts.pin_tries;
  const keeper = status?.detail?.pin?.tries_left;
  return keeper != null ? keeper : null;
}

/**
 * Whether the SIM has its PIN enabled: from the card when it says, else from the running
 * engine's PIN keeper (the host card monitor doesn't read it), else unknown (null).
 */
export function pinEnabled(
  facts: CardFacts | null,
  status?: InstanceStatus | null,
): boolean | null {
  if (facts?.pin_enabled != null) return facts.pin_enabled;
  const state = status?.detail?.pin?.state;
  if (!state || state === "NO_READER" || state === "NO_CARD" || state === "ERROR")
    return null;
  return state !== "PIN_DISABLED";
}

/**
 * How far a PIN attempt from this page may go. Attempts are finite and a blocked SIM needs the
 * PUK, so the UI never offers a blind try: with the count unknown the card must be read first,
 * at 0 entry is closed, and the last attempt needs an explicit acknowledgement.
 */
export type PinGuard = "unknown" | "blocked" | "last" | "low" | "ok";

export function pinGuard(tries: number | null): PinGuard {
  if (tries == null) return "unknown";
  if (tries <= 0) return "blocked";
  if (tries === 1) return "last";
  if (tries === 2) return "low";
  return "ok";
}

/**
 * Whether PIN entry belongs on screen without being asked for: the line reports a PIN
 * problem, or the card is present with its PIN enabled but the IMSI still unreadable (locked).
 */
export function pinNeeded(
  facts: CardFacts | null,
  status?: InstanceStatus | null,
): boolean {
  if (status?.state === "PIN_PROBLEM") return true;
  return !!(facts?.present && pinEnabled(facts, status) && !facts.imsi);
}
