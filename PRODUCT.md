# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primarily the maintainer: one technically fluent person running the gateway on their own Linux
host for their own SIMs (several carriers at once, e.g. O2, Vodafone, MTS, Beeline). They know
SIP, IMS, ePDG, PC/SC and the carriers' quirks, and they work from the README and logs as much as
from the UI. Others who clone the public repository are a secondary audience: they get
README-level documentation, not hand-holding inside the UI.

## Product Purpose

The WebUI is the control plane of a VoWiFi→SIP gateway. A physical VoWiFi-capable SIM in a PC/SC
reader becomes an IMS endpoint (IKEv2/IPsec ePDG tunnel + IMS registration), re-exposed as a
SIP/RTP and WebRTC line. The UI provisions SIMs, shows and recovers each line's health, configures
lines and global settings, manages eSIM profiles, and offers a browser softphone, SMS messages and
call/SMS logs.

Its main job is **keeping lines healthy**: seeing at a glance whether each line is working, and,
when it isn't, where in the pipeline it fails and what to do about it. Calling and messaging are
real daily uses but secondary to that.

Success: a broken line is noticed and located in seconds; recovery takes the fewest, safest steps.

## Positioning

Turns a SIM the user physically owns into a SIP line without a carrier database: carrier values
are derived from the SIM and IMSI, the card itself answers every AKA challenge (Ki/OPc never leave
it), and everything runs rootless on the user's own host.

## Operating Context

- **Desktop browser on the LAN**: provisioning, monitoring, line and global settings, eSIM work,
  log reading.
- **Phone browser**: softphone calls and reading/sending SMS, on the LAN or from outside (WebUI
  over IPv6).
- Served over HTTPS (self-signed by default, or a real certificate); login is the service user's
  Linux account.
- Alongside the UI: `install.sh`, journald logs, external SIP clients (FRITZ!Box/DECT, MicroSIP,
  Zoiper), the sip-front add-on.

## Capabilities and Constraints

- Tabs: Dashboard (`/`), SIM config, Softphone, Messages, eSIM, Settings, Logs.
- Per-line state machine, names fixed (WebUI and backend depend on them):
  `NO_CARD → PIN_PROBLEM → EPDG_UNRESOLVED → TUNNEL_DOWN → REGISTERING → OK`, plus `STOPPED`.
- Several lines run in parallel, one per SIM/reader, each with its own engine and port block.
- **SIM safety**: PIN retries are finite. The UI must never invite blind PIN retries and must
  respect the preflight/locked checks.
- eSIM operations need exclusive reader access: the line on that reader has to be stopped first.
- Live updates come over a WebSocket; status changes are pushed, not polled by the user.
- Stack (existing): Preact via `preact/compat`, Vite, Tailwind v4, TypeScript, JsSIP, lucide icons.
  No `react` deps or React-19-only APIs.
- Domain terms are used as-is: IMSI, ICCID, SMSC, ePDG, P-CSCF, IMS, PANI, EVS/AMR-WB, etc.

## Brand Commitments

- Name: "VoWiFi gateway" (wordmark in `webui/src/components/sidebar/AppBrand.tsx`).
- Light and dark themes are both supported and must both be checked.
- Fonts already shipped: Adwaita Sans and Adwaita Mono (`@fontsource`).

## Evidence on Hand

- Screenshots: `screenshots/dashboard.jpg`, `softphone.jpg`, `message.jpg`, `esim.jpg`.
- Tested-carrier and per-carrier codec tables in `README.md` (real results from live lines).
- No users, testimonials or metrics beyond that; don't invent any.

## Product Principles

1. **Health first.** The state of every line, and the step where it fails, is the first thing
   the UI answers.
2. **Precise over friendly.** Speak the protocol's language to an expert; show real values
   (states, codecs, addresses, reject causes) instead of softened summaries.
3. **Safe with finite resources.** PIN attempts, exclusive reader access and running lines are
   protected by the UI, not just by the backend.
4. **Works on the desk and on the phone.** Monitoring and config are desktop jobs; calls and SMS
   must work well in a phone browser.
5. **No carrier presets required.** The UI shows what was derived from the SIM and lets the user
   override it; it never depends on a carrier database.
