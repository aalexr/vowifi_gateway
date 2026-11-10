# AGENTS.md

Guidance for coding agents working in this repository. User-facing docs live in
[README.md](README.md); read its **Architecture**, **Development** and **Troubleshooting**
sections before making non-trivial changes.

## What this is

A VoWiFi→SIP gateway: a physical VoWiFi-capable SIM (read over PC/SC) is turned into an IMS
endpoint (IKEv2/IPsec ePDG tunnel + IMS registration) and re-exposed as a SIP/RTP + WebRTC
server, with SMS and eSIM (lpac) management. Two planes:

| Plane | Where | What |
|-------|-------|------|
| **engine** (one container per SIM) | `engine/` | `swu_ike.py` (pure-Python SWu IKEv2 + EAP-AKA + userspace ESP on `ipsec0`), sysmocom Asterisk (IMS PJSIP), USIM bridges (`pin_keeper.py`, `ami_usim.py`), `notify.py` event hook |
| **control** (singleton) | `control/` + `webui/` | FastAPI manager (Docker SDK against the user's Podman API socket, pyscard, SQLite) + React/Vite/Tailwind WebUI served by the manager |

Everything runs **rootless** under the installing user: the control plane is a native venv +
`vowifi-control` **`systemd --user`** service (lingering for boot), engines run in that user's
**rootless Podman** on pasta networking. There is no Docker dependency, no rootful mode and no
containerized control plane (both were removed; `install.sh install` migrates such old installs).

## Layout

- `control/run.py` — HTTPS launcher (uvicorn; self-signed cert under `$VOWIFI_DATA/certs` if none configured).
- `control/app/main.py` — all FastAPI routes (`/api/...`, `/ws`), health/state machine logic (`apply_health`), provisioning.
- `control/app/engine.py` — engine container lifecycle (mounts, caps, port blocks, dev mounts).
- `control/app/config.py` — `config.yaml` + per-instance config, settings defaults.
- `control/app/sim.py`, `card.py`, `usbreader.py` — PC/SC reader/card detection, PIN ops, EF reads, USB-port reader binding.
- `control/app/lpa.py`, `estkme.py` — eSIM via local `lpac` binary; ESTKme dual-SE handling.
- `control/app/ami.py` — Asterisk AMI client (panoramisk); `store.py` — SQLite SMS/call log; `notify_push.py` — push notifications; `mcc_country.py` — MCC→ISO country (PANI header).
- `engine/entrypoint.sh` — render → PIN keeper → SWu tunnel supervisor → P-CSCF discovery → Asterisk.
- `engine/render.py` + `engine/templates/*.j2` — `/config/instance.json` → Asterisk configs + `engine.env`.
- Asterisk changes live in the fork [aalexr/asterisk](https://github.com/aalexr/asterisk), branch `vowifi/20.7.0` (sysmocom/20.7.0 + our commits); `engine/Containerfile` builds it pinned by SHA (`ASTERISK_REF`). Commit there, then bump `ASTERISK_REF`.
- `patches/ccid/*.patch` — opt-in host CCID driver patches (`install.sh patch|patch2|patchall`).
- `webui/src/views/*.tsx` — one file per tab; `webui/src/components/<group>/` — one file per React component (plus `utils.ts`/`constants.ts` helpers) grouped by owning view (`dashboard`, `esim`, `settings`, `simconfig`, `softphone`) or `common` for shared ones; `api.ts` = fetch/WS helpers; `softphone.ts` = JsSIP wrapper. TypeScript (`npm run typecheck`).
- `data/` — runtime state (configs, SQLite, logs, certs, saved PINs/secrets). **Gitignored; never commit its contents.**

## Build, run, verify

There is **no automated test suite, linter config or CI**. Verify changes by the cheapest means available:

```bash
# Python syntax check (control + engine)
python3 -m py_compile control/app/*.py control/run.py engine/*.py

# WebUI build (catches JSX/import errors)
cd webui && npm ci && npm run build

# Shell scripts
bash -n install.sh engine/entrypoint.sh

# Images
podman build -t localhost/vowifi/engine engine/        # slow: compiles Asterisk + pcsc-lite
```

Running for real needs a PC/SC reader, a SIM and carrier access — usually not available to an
agent. Don't claim end-to-end verification you couldn't do; say what was checked.

Dev loops (see README **Development**):
- Control plane by hand: venv, `pip install -r control/requirements.txt`, `VOWIFI_DATA=./data python control/run.py`.
- WebUI: `cd webui && npm run dev` (proxies `/api` and `/ws` to `VOWIFI_DEV_API`, default `https://localhost:8443`).
- Engine scripts without rebuild: give the control plane `VOWIFI_DEV_MOUNTS=1` via a user drop-in (README **Development**), then `podman restart vowifi-engine-<id>`. Mounted scripts need their executable bit (git mode 100755).
- Installed system: `./install.sh restart` (control), `./install.sh reload [--engines]` — never as root; `install.sh` refuses root and calls `sudo` itself (`as_root`) only for one-time host setup (packages, pcscd, polkit rule, firewalld, lingering, SELinux label). `reload`/start/stop/status/logs must stay root-free.

Don't run `install.sh` install/uninstall/patch/purge commands or anything touching host pcscd,
systemd, firewalld or the user's Podman containers unless the user asks — they modify the host.

## Invariants — don't break these

- **pcsc-lite version lock**: `PCSC_VERSION` (default `2.3.3`) must stay identical in `install.sh` and `engine/Containerfile`. The host pcscd owns the reader; containers are clients via the bind-mounted `/run/pcscd` socket. Distro pcscd builds check polkit — the installer's rule `/etc/polkit-1/rules.d/50-vowifi-pcsc.rules` is what lets the user service and engines in.
- **Per-instance port blocks** (`config.py` `PORT_BASE` + `index*PORT_STRIDE`): block `k` uses SIP UDP `5060+10k`, TLS `5061+10k`, WSS `8089+10k`, AMI `5038+10k` (host loopback only), RTP `10000+2000k` (+59). IKE source ports `45000+2n`/`45001+2n` come from the instance's unique `index`. Keep `config.py`, `engine.py`, the firewalld port list in `install.sh` (`ensure_firewall`) and README consistent.
- **Contract between control and engine** is `instance.json` (written by control, consumed by `render.py`) plus the env vars exported in `entrypoint.sh` and status files in the bind-mounted run dir (e.g. `swu_status.json`, `pin_status.json`). Adding a setting usually touches: `config.py` defaults → `main.py`/`engine.py` → `render.py` → template and/or `entrypoint.sh` export list → WebUI view (`SimConfig.jsx` / `Settings.jsx`) → README.
- **State machine**: `NO_CARD → PIN_PROBLEM → EPDG_UNRESOLVED → TUNNEL_DOWN → REGISTERING → OK` (+ `STOPPED`). The WebUI and `apply_health` depend on these names.
- **Rootless only**: nothing may need host root at runtime or rely on a container bridge IP. Engines run on pasta (`engine._network_mode()`, MTU pinned to the host uplink), so `swu_ike` must keep `SWU_FORCE_NATT=1` (pasta carries no raw ESP) and unprivileged per-engine `SWU_IKE_LOCAL_PORT`/`SWU_NATT_LOCAL_PORT` (pasta drops source ports < 1024). The manager reaches AMI at `127.0.0.1:<ami port>`. Published ports are plain host sockets, so new ones must also be added to `ensure_firewall`.
- **Podman specifics**: images are tagged `localhost/vowifi/*` and `FROM` lines are fully qualified (no short-name resolution). Engines use `restart_policy=always` (what the user's `podman-restart.service` revives) and `label=disable` (SELinux, for the pcscd socket + data mounts). Engines reach the manager at `host.containers.internal` (pasta maps it; podman ≥ 5.3). `control/app/engine.py` talks to `DOCKER_HOST` (default `unix://$XDG_RUNTIME_DIR/podman/podman.sock`) via the Docker SDK — keep to API calls Podman's compat layer supports.
- **No carrier database**: carrier values are derived from IMSI/SIM (ePDG FQDN, realm, SMSC from EF_SMSP). `CARRIER_CP_PREF` is only a probe-order hint; don't make carrier presets required.
- **SIM safety**: PIN retries are finite. Never add code paths that retry PIN verification blindly; respect the existing preflight/locked checks (`_preflight_pin_locked`, `pin_keeper.py`). Exclusive PC/SC access (eSIM ops) must stay guarded against a running engine on the same reader.
- **3GPP behaviour** in `swu_ike.py` (TS 24.302 reject classification + back-off, DPD/liveness, rekey/reauth, RFC 7383 fragmentation) was tuned against live networks — change conservatively and explain the spec reasoning in comments.
- Asterisk `.conf` values: `;` starts a comment — escape with `escape_pani_for_asterisk`-style helpers when rendering user/carrier strings.
- Never log or commit secrets: PINs, Ki/OPc, AMI secrets, TLS keys, `.env`.

## Code style

- Python: module docstring at top describing purpose and contract (`"""name.py - ..."""`), `from __future__ import annotations`, stdlib `logging` with `vowifi.*` logger names, explanatory comments for protocol/hardware quirks. No formatter is enforced; match the surrounding file.
- Engine scripts are standalone executables (`#!/usr/bin/env python3`), installed to `/usr/local/bin` in the image; keep their dependencies within what `engine/Containerfile` installs.
- New control-plane deps go in `control/requirements.txt`; new WebUI deps in `webui/package.json` (commit `package-lock.json`).
- WebUI: React 18 function components + hooks, Tailwind v4 utility classes, light and dark themes both supported — check both.

## Commits & PRs

- Branch from `main`; commit only when asked.
- Subject prefix names the touched area(s), lowercase, slash-separated: `engine/swu: ...`, `control/webui: ...`, `engine/control/webui: ...`, `docs: ...`, `ccid: ...`.
- Update README.md when changing user-visible behaviour, settings, env vars, ports or install commands.
