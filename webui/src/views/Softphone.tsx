import { useEffect, useRef, useState, useCallback } from "react";
import { Link } from "react-router";
import { api, asApiError, CallRecord, type InstanceId } from "../api";
import { Softphone as Phone, type EndInfo } from "../softphone";
import SimSelector from "../components/common/SimSelector";
import {
  Phone as PhoneIcon,
  PhoneOff,
  Mic,
  MicOff,
  Grid3x3,
  CircleDot,
  Delete,
  RefreshCw,
} from "lucide-react";
import { KEYS, fmtDur } from "../components/softphone/constants";
import Avatar from "../components/softphone/Avatar";
import RoundBtn from "../components/softphone/RoundBtn";
import IncomingCall from "../components/softphone/IncomingCall";
import CallHistory from "../components/softphone/CallHistory";
import LineStatus, {
  browserRegLabel,
  type BrowserReg,
} from "../components/softphone/LineStatus";
import { describeEnd, sipDetail } from "../components/softphone/endCause";
import { CommonViewProps } from "./common-view-props";

type SoftphoneProvisioning = Awaited<ReturnType<typeof api.softphone>>;

interface Call {
  dir: "in" | "out";
  number: string;
  state: "active" | "ended" | "ringing" | "incoming" | "calling";
  startedAt?: number;
  /** Why it ended (SIP status, Reason header, originator); set once state is "ended". */
  end?: EndInfo;
}

/** A normal ending (BYE, own cancel/decline) clears itself after this long; a failure stays
 *  until dismissed so its SIP cause can be read. */
const ENDED_MS = 2500;
/** Holding the 0 key this long types "+", as on a phone keypad. */
const PLUS_HOLD_MS = 550;

// Pasted numbers often carry spacing and punctuation ("+49 (152) 123-45"); keep digits and
// the dialable symbols, drop the formatting. Letters stay, for SIP user names.
const normaliseNumber = (v: string) => v.replace(/[\s().\-–]/g, "");

export default function Softphone({
  selected,
  subscribe,
  instances,
  cards,
  setSelected,
  showToast,
}: CommonViewProps) {
  const id = selected?.id;
  const [prov, setProv] = useState<SoftphoneProvisioning | null>(null);
  const [reg, setReg] = useState<BrowserReg>("idle");
  const [regInfo, setRegInfo] = useState<EndInfo | null>(null); // why registration failed
  const [call, setCall] = useState<Call | null>(null);
  const [num, setNum] = useState("");
  const [dur, setDur] = useState(0);
  const [muted, setMuted] = useState(false);
  const [keypad, setKeypad] = useState(false);
  const [dtmfSeq, setDtmfSeq] = useState(""); // digits/symbols entered since the keypad opened
  const [recording, setRecording] = useState(false);
  const [calls, setCalls] = useState<CallRecord[]>([]);
  const [mobilePane, setMobilePane] = useState<"phone" | "history">("phone");
  const [callSelMode, setCallSelMode] = useState(false);
  const [callSel, setCallSel] = useState(() => new Set<number>());
  const phone = useRef<Phone | null>(null);
  const numRef = useRef<HTMLInputElement | null>(null);
  const plusHold = useRef<{ timer?: number; fired: boolean }>({ fired: false });
  // Persistent, DOM-rendered <audio> sink. One stable element (primed on the first click via
  // unlockAudio) is what makes remote WebRTC audio play under Chrome/Edge autoplay policy.
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const loadCalls = useCallback(() => {
    if (id == null || id === "") return;
    api
      .calls(id)
      .then((r) => setCalls(r.calls || []))
      .catch(() => {});
  }, [id]);
  useEffect(() => {
    loadCalls();
  }, [loadCalls]);
  useEffect(() => {
    setCallSelMode(false);
    setCallSel(new Set());
    setMobilePane("phone");
  }, [id]);
  // if the list empties (own delete, or another client's clear-all over WS), leave select
  // mode so the toolbar/checkbox UI can't get stranded on an empty list.
  useEffect(() => {
    if (!calls.length) {
      setCallSelMode(false);
      setCallSel(new Set());
    }
  }, [calls.length]);
  useEffect(
    () =>
      subscribe &&
      subscribe((m) => {
        if (m.type === "call" && String(m.instance) === String(id)) loadCalls();
      }),
    [subscribe, id, loadCalls],
  );
  useEffect(() => {
    if (call?.state === "ended") loadCalls();
  }, [call?.state, loadCalls]);

  const toast = (m: string) => (showToast ? showToast(m) : null);
  const toggleCallSel = (cid: number) =>
    setCallSel((s) => {
      const n = new Set(s);
      n.has(cid) ? n.delete(cid) : n.add(cid);
      return n;
    });
  const setSelMode = (on: boolean) => {
    setCallSelMode(on);
    if (!on) setCallSel(new Set());
  };
  // Reload only if still on the same line (a delete may resolve after the user switched SIMs).
  const reloadIfSame = (forId: InstanceId) => {
    if (String(forId) === String(id)) loadCalls();
  };

  const deleteSelectedCalls = async () => {
    if (!id || !callSel.size) return;
    if (
      !confirm(
        `Delete ${callSel.size} selected call${callSel.size > 1 ? "s" : ""}?`,
      )
    )
      return;
    const forId = id;
    try {
      await api.deleteCalls(forId, { ids: [...callSel] });
      setSelMode(false);
      reloadIfSame(forId);
      toast("Calls deleted");
    } catch (e) {
      toast("Delete failed: " + asApiError(e).message);
    }
  };
  const clearAllCalls = async () => {
    if (!id || !calls.length) return;
    if (!confirm("Clear the entire call history for this line?")) return;
    const forId = id;
    try {
      await api.deleteCalls(forId, { all: true });
      setSelMode(false);
      reloadIfSame(forId);
      toast("Call history cleared");
    } catch (e) {
      toast("Delete failed: " + asApiError(e).message);
    }
  };

  // provisioning + connect (only while this page is mounted => only listens for incoming here)
  useEffect(() => {
    if (!id) return;
    let alive = true;
    setReg("idle");
    setRegInfo(null);
    setCall(null);
    api
      .softphone(id)
      .then((p) => {
        if (alive) setProv(p);
      })
      .catch(() => {});
    return () => {
      alive = false;
      if (phone.current) {
        phone.current.stop();
        phone.current = null;
      }
    };
  }, [id]);

  const resetControls = () => {
    setKeypad(false);
    setMuted(false);
    setRecording(false);
  };
  // Move the call to "ended" with its cause. Normal endings clear after ENDED_MS; failures
  // stay until dismissed. Only an "ended" screen is ever cleared, so a timer from a previous
  // call can't wipe a new one.
  const endCall = (end?: EndInfo) => {
    setCall((c) => (c ? { ...c, state: "ended", end: end ?? c.end } : null));
    resetControls();
    if (!describeEnd(end).failed)
      setTimeout(
        () => setCall((c) => (c && c.state === "ended" && !describeEnd(c.end).failed ? null : c)),
        ENDED_MS,
      );
  };

  const connect = useCallback(() => {
    if (!prov || !prov.enabled || phone.current) return;
    const ph = new Phone((type, data) => {
      if (type === "registered") {
        setReg(data ? "registered" : "unregistered");
        if (data) setRegInfo(null);
      } else if (type === "ws")
        setReg((r) =>
          data === "connected"
            ? r === "registered"
              ? r
              : "connecting"
            : "disconnected",
        );
      else if (type === "regfail") {
        setReg("failed");
        setRegInfo(data || null);
      } else if (type === "incoming")
        setCall({
          dir: "in",
          number: data.from || "Unknown",
          state: "incoming",
        });
      else if (type === "calling")
        setCall({ dir: "out", number: data.to, state: "calling" });
      // 'progress' fires for BOTH directions. On an incoming call JsSIP auto-sends 180 and
      // emits progress('local'); mapping that to 'ringing' would blow away the 'incoming'
      // state and hide the Answer/Decline overlay. Only an OUTGOING call still in the
      // dialing/ringing phase should advance to 'ringing' — leave incoming/active/ended alone.
      else if (type === "progress")
        setCall((c) =>
          c &&
          c.dir === "out" &&
          (c.state === "calling" || c.state === "ringing")
            ? { ...c, state: "ringing" }
            : c,
        );
      else if (type === "active")
        setCall((c) =>
          c ? { ...c, state: "active", startedAt: Date.now() } : c,
        );
      else if (type === "ended" || type === "failed") endCall(data);
    }, audioRef.current);
    ph.start(prov, prov.host || location.hostname);
    phone.current = ph;
    setReg("connecting");
  }, [prov]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (prov && prov.enabled && !phone.current) connect();
  }, [prov, connect]);

  // Tear the UA down and register afresh: the manual way out of "failed"/"disconnected"
  // (JsSIP retries the WebSocket by itself, but not a rejected REGISTER).
  const reconnect = () => {
    if (call && call.state !== "ended") return;
    phone.current?.stop();
    phone.current = null;
    setRegInfo(null);
    setReg("connecting");
    connect();
  };

  // The <audio> element mounts with the component; make sure the phone (which may have been
  // created before the ref attached) points at it.
  useEffect(() => {
    if (phone.current && audioRef.current)
      phone.current.setAudioEl(audioRef.current);
  });

  // in-call duration timer
  useEffect(() => {
    const startedAt = call?.startedAt;
    if (call?.state !== "active" || !startedAt) {
      setDur(0);
      return;
    }
    const t = setInterval(
      () => setDur(Math.floor((Date.now() - startedAt) / 1000)),
      500,
    );
    return () => clearInterval(t);
  }, [call?.state, call?.startedAt]);

  // Physical-keyboard DTMF: while the in-call keypad is open, let the user type 0-9 * #
  // directly instead of only clicking. Clear the echo strip each time the keypad opens.
  useEffect(() => {
    if (!(keypad && call?.state === "active")) return;
    setDtmfSeq("");
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // Shift+3 produces '#'; a bare '3' should stay '3'. e.key already reflects the shifted
      // character, so match on the resulting character directly.
      const k = e.key;
      if (/^[0-9*#]$/.test(k)) {
        e.preventDefault();
        pressDTMF(k);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [keypad, call?.state]);

  // Watchdog: a call parked in a non-terminal setup phase (calling/ringing/incoming) that
  // never advances to 'active' or 'ended' — e.g. a BYE/terminal JsSIP event was dropped —
  // would otherwise strand the UI forever. Force it back to idle after a timeout. 'active'
  // has no timeout (calls can be long); 'ended' clears via endCall or Dismiss.
  useEffect(() => {
    if (!call || call.state === "active" || call.state === "ended") return;
    const ms = call.state === "incoming" ? 60000 : 65000;
    const t = setTimeout(() => {
      // Ask the phone to tear down whatever it thinks it has, then reset the UI.
      try {
        phone.current?.hangup();
      } catch {}
      setCall(null);
      resetControls();
    }, ms);
    return () => clearTimeout(t);
  }, [call?.state]);

  const dialKey = (k: string) => {
    setNum((n) => n + k);
    numRef.current?.focus({ preventScroll: true });
  };
  // "0" doubles as "+" when held, the way a phone keypad does it.
  const plusDown = () => {
    plusHold.current.fired = false;
    plusHold.current.timer = window.setTimeout(() => {
      plusHold.current.fired = true;
      dialKey("+");
    }, PLUS_HOLD_MS);
  };
  const plusUp = () => window.clearTimeout(plusHold.current.timer);
  const keyClick = (k: string) => {
    if (k === "0" && plusHold.current.fired) {
      plusHold.current.fired = false;
      return;
    }
    dialKey(k);
  };
  // In-call DTMF: send the tone and echo it into the keypad's display strip.
  const pressDTMF = (k: string) => {
    phone.current?.sendDTMF(k);
    setDtmfSeq((s) => (s + k).slice(-32));
  };
  const canCall = reg === "registered";
  const placeCall = (target = num) => {
    if (!phone.current || !target || !canCall) return;
    phone.current.unlockAudio();
    phone.current.call(target);
    setNum("");
  };
  const answer = () => {
    phone.current?.unlockAudio();
    phone.current?.answer();
  };
  // Optimistically end on a local hangup. JsSIP will still fire 'ended' (→ endCall with the
  // real cause), but if that event is delayed or missed the UI has already left the call.
  const hangup = () => {
    phone.current?.hangup();
    endCall({ cause: "Terminated", originator: "local" });
  };
  // Declining a ringing incoming call must send 603 (→ "declined"), not a bare hangup
  // (→ "missed"). reject() picks the right signalling for an un-answered incoming session.
  const decline = () => {
    phone.current?.reject();
    endCall({ cause: "Rejected", originator: "local" });
  };
  const toggleMute = () => {
    const m = !muted;
    setMuted(m);
    phone.current?.setMuted(m);
  };
  const toggleRecord = async () => {
    if (!phone.current) return;
    if (recording) {
      const blob = await phone.current.stopRecording();
      setRecording(false);
      if (blob) {
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
        const name = `call-${call?.number || "rec"}-${stamp}.webm`;
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        toast(`Recording saved as ${name}`);
      }
    } else {
      const ok = await phone.current.startRecording();
      setRecording(ok);
      if (!ok) toast("Recording could not start in this browser");
    }
  };

  if (!id)
    return (
      <div>
        <SimSelector
          instances={instances}
          cards={cards}
          selected={selected}
          setSelected={setSelected}
        />
        <p className="softphone-empty">Select a SIM / line to use the softphone.</p>
      </div>
    );

  const ended = call?.state === "ended" ? describeEnd(call.end) : null;
  const regProblem = reg === "failed" || reg === "disconnected";
  const lineName = selected?.name || "this line";
  const fabTitle = !canCall
    ? `WebRTC ${browserRegLabel(reg).toLowerCase()}: can't call yet`
    : !num
      ? "Enter a number"
      : `Call ${num}`;

  // One polite announcement for screen readers; the incoming call is an alertdialog instead.
  const announce =
    call?.state === "calling"
      ? `Calling ${call.number}`
      : call?.state === "ringing"
        ? `Ringing ${call.number}`
        : call?.state === "active"
          ? `Connected to ${call.number}`
          : ended
            ? [ended.title, ended.detail].filter(Boolean).join(". ")
            : `WebRTC ${browserRegLabel(reg)}`;

  return (
    <div className="softphone-page">
      {/* Persistent remote-audio sink: JsSIP writes the remote MediaStream here. autoPlay +
          a stable DOM element + unlockAudio() on the first click = reliable playback. */}
      <audio ref={audioRef} autoPlay hidden />
      <div className="sr-only" role="status" aria-live="polite">
        {announce}
      </div>
      <div className="softphone-chrome">
        <SimSelector
          instances={instances}
          cards={cards}
          selected={selected}
          setSelected={setSelected}
        />
      </div>
      <div className="mobile-softphone-tabs">
        <button
          type="button"
          className={`btn ${mobilePane === "phone" ? "btn-primary" : "btn-ghost"}`}
          aria-pressed={mobilePane === "phone"}
          onClick={() => setMobilePane("phone")}
        >
          Phone
        </button>
        <button
          type="button"
          className={`btn ${mobilePane === "history" ? "btn-primary" : "btn-ghost"}`}
          aria-pressed={mobilePane === "history"}
          onClick={() => setMobilePane("history")}
        >
          Recent
        </button>
        <LineStatus carrier={selected?.status} reg={reg} compact />
      </div>
      {call?.state === "incoming" && (
        <IncomingCall
          number={call.number}
          line={lineName}
          onAnswer={answer}
          onDecline={decline}
        />
      )}
      <div
        className={`split-pane softphone ${mobilePane === "history" ? "is-detail" : "is-list"}`}
      >
        {/* ---- Phone panel ---- */}
        <section className="card pane-list softphone-phone" aria-label="Phone">
          <div className="softphone-meta">
            <LineStatus carrier={selected?.status} reg={reg} />
          </div>

          {!prov?.enabled && prov && (
            <div className="banner banner-warn softphone-banner">
              WebRTC is off for this line. Turn on <b>Enable browser softphone</b>{" "}
              in <Link to="/sims">SIM Config</Link> (needs HTTPS/TLS).
            </div>
          )}

          {regProblem && prov?.enabled && (
            <div className="banner banner-danger softphone-banner softphone-regfail">
              <div>
                <div>
                  WebRTC {reg === "failed" ? "registration failed" : "disconnected"}
                </div>
                {sipDetail(regInfo) && (
                  <div className="mono softphone-detail">{sipDetail(regInfo)}</div>
                )}
              </div>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={reconnect}
                disabled={!!call && call.state !== "ended"}
              >
                <RefreshCw size={14} aria-hidden="true" />
                Reconnect
              </button>
            </div>
          )}

          {/* ===== OUTGOING: calling / ringing ===== */}
          {(call?.state === "calling" || call?.state === "ringing") && (
            <div className="call-screen">
              <Avatar />
              <div>
                <div className="mono call-number">{call.number}</div>
                <div className="call-sub">
                  {call.state === "ringing" ? "Ringing…" : "Calling…"}
                </div>
              </div>
              <div className="call-controls">
                <RoundBtn
                  icon={<PhoneOff size={24} aria-hidden="true" />}
                  label="End"
                  variant="hangup"
                  onClick={hangup}
                />
              </div>
            </div>
          )}

          {/* ===== IN CALL ===== */}
          {call?.state === "active" && (
            <div className={`call-screen is-active${keypad ? " has-keypad" : ""}`}>
              {!keypad && <Avatar />}
              <div className="call-head">
                <div className="mono call-number">{call.number || "Unknown"}</div>
                <div className="call-timer">{fmtDur(dur)}</div>
                {recording && (
                  <div className="call-recording">
                    <span className="rec-dot" aria-hidden="true" />
                    Recording
                  </div>
                )}
              </div>
              {keypad && (
                <div className="dtmf-wrap">
                  {/* Echo strip: every digit/symbol entered via click or physical keyboard.
                      Overflow drops the oldest digits on the left. */}
                  <div
                    className={`mono dtmf-echo${dtmfSeq ? "" : " is-empty"}`}
                    aria-live="polite"
                  >
                    <span>{dtmfSeq || "Type or tap keys"}</span>
                  </div>
                  <div className="dtmf-pad">
                    {KEYS.map(([k]) => (
                      <button
                        key={k}
                        type="button"
                        className="dial-key"
                        onClick={() => pressDTMF(k)}
                      >
                        {k}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <div className="call-controls">
                <RoundBtn
                  icon={muted ? <MicOff size={22} aria-hidden="true" /> : <Mic size={22} aria-hidden="true" />}
                  label="Mute"
                  onClick={toggleMute}
                  pressed={muted}
                />
                <RoundBtn
                  icon={<Grid3x3 size={22} aria-hidden="true" />}
                  label="Keypad"
                  onClick={() => setKeypad((v) => !v)}
                  pressed={keypad}
                />
                <RoundBtn
                  icon={<CircleDot size={22} aria-hidden="true" />}
                  label="Record"
                  onClick={toggleRecord}
                  pressed={recording}
                />
              </div>
              <div className="call-controls">
                <RoundBtn
                  icon={<PhoneOff size={24} aria-hidden="true" />}
                  label="Hang up"
                  variant="hangup"
                  onClick={hangup}
                />
              </div>
            </div>
          )}

          {/* ===== ENDED ===== */}
          {call?.state === "ended" && ended && (
            <div className={`call-screen is-ended${ended.failed ? " is-failed" : ""}`}>
              <Avatar ended />
              <div>
                <div className="mono call-number">{call.number || "Unknown"}</div>
                <div className="call-end-title">{ended.title}</div>
                {ended.detail && (
                  <div className="mono softphone-detail">{ended.detail}</div>
                )}
                {ended.hint && <div className="call-end-hint">{ended.hint}</div>}
              </div>
              {ended.failed && (
                <div className="call-controls">
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => setCall(null)}
                  >
                    Dismiss
                  </button>
                  {call.dir === "out" && call.number && (
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={!canCall}
                      onClick={() => {
                        setCall(null);
                        placeCall(call.number);
                      }}
                    >
                      Call again
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ===== DIALER (idle) ===== */}
          {!call && (
            <form
              className="softphone-idle"
              onSubmit={(e) => {
                e.preventDefault();
                placeCall();
              }}
            >
              <input
                ref={numRef}
                type="tel"
                inputMode="tel"
                autoComplete="off"
                aria-label="Number to call"
                value={num}
                onChange={(e) => setNum(normaliseNumber(e.currentTarget.value))}
                placeholder="Enter a number"
                className="mono softphone-num"
              />
              <div className="dial-pad">
                {KEYS.map(([k, sub]) => (
                  <button
                    key={k}
                    type="button"
                    className="dial-key"
                    aria-label={k === "0" ? "0, hold for +" : k}
                    onClick={() => keyClick(k)}
                    {...(k === "0"
                      ? {
                          onPointerDown: plusDown,
                          onPointerUp: plusUp,
                          onPointerLeave: plusUp,
                          onPointerCancel: plusUp,
                          onContextMenu: (e: { preventDefault(): void }) => e.preventDefault(),
                        }
                      : {})}
                  >
                    <span className="dial-digit">{k}</span>
                    <span className="dial-letters" aria-hidden="true">
                      {sub || " "}
                    </span>
                  </button>
                ))}
              </div>
              <div className="softphone-actions">
                <span className="softphone-actions-spacer" />
                <button
                  type="submit"
                  className="call-fab"
                  disabled={!canCall || !num}
                  aria-label={num ? `Call ${num}` : "Call"}
                  title={fabTitle}
                >
                  <PhoneIcon size={26} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className={`icon-action${num ? "" : " is-idle"}`}
                  onClick={() => setNum((n) => n.slice(0, -1))}
                  aria-label="Delete last digit"
                >
                  <Delete size={24} aria-hidden="true" />
                </button>
              </div>
            </form>
          )}
        </section>

        {/* ---- Recent calls ---- */}
        <CallHistory
          calls={calls}
          selMode={callSelMode}
          sel={callSel}
          onToggleSel={toggleCallSel}
          onSelMode={setSelMode}
          onDeleteSelected={deleteSelectedCalls}
          onClearAll={clearAllCalls}
          canCall={canCall}
          onCall={(peer) => placeCall(peer)}
          onPick={(peer) => {
            setNum(peer);
            setMobilePane("phone");
          }}
        />
      </div>
    </div>
  );
}
