# VoWiFi→SIP Gateway

A **containerized VoWiFi→SIP gateway** that turns a physical VoWiFi-capable SIM into an IMS endpoint you can call/text via standard SIP clients (softphones, desk phones, Asterisk trunks). One SIM = one routable phone number; multiple SIMs can run in parallel (each gets its own engine container + port block).

**What it does:**
- Uses the SIM over PC/SC: reads its identity (IMSI, SMSC) and has the card itself answer every EAP-AKA / IMS-AKA challenge (Ki/OPc never leave the SIM, so the card must stay in the reader)
- Establishes an IPsec ePDG tunnel + IMS registration to your carrier's VoWiFi core
- Presents the registered line as a **WebRTC endpoint** (browser softphone in the control-plane WebUI) and a **SIP/RTP server** (for MicroSIP, Zoiper, Asterisk trunks, etc.) with two-way voice
- Routes outbound calls (`INVITE` to the SIP server → IMS `INVITE` over the tunnel) and inbound calls (IMS `INVITE` → rings your SIP clients)
- Sends/receives SMS via SIP MESSAGE (to/from the engine's SIP transport)
- Manages **eSIM / eUICC** profiles locally via [lpac](https://github.com/estkme-group/lpac) (download, enable/disable/delete, notifications), including **ESTKme dual-SE** cards (SE1/SE2)

**What you need:**
- A Linux host (amd64/arm64, Raspberry Pi works) with `/dev/net/tun` + kernel ESP/XFRM
- **Podman ≥ 5.3** with `passt` (the installer adds both from your distro if missing), systemd, and a normal user account with a `/etc/subuid` range — everything runs **rootless** under that account
- **Node.js ≥ 26** (the current LTS line) + `npm` on the host, on the `PATH` of the user running `install.sh` — it builds the WebUI. The installer does **not** install it (distro packages often lag the LTS; use yours if it's new enough, or [nodejs.org](https://nodejs.org) / nvm / fnm — `webui/.nvmrc` pins the major)
- A **PC/SC smart-card reader** (USB CCID)
- A **VoWiFi-capable SIM** from a carrier that allows ePDG (tested: Telus Canada 302-220; T-Mobile US + many EU carriers should work)
- *(Optional, for the eSIM tab)* an **eUICC** in the reader, plus a one-time local lpac build (`git clone` [estkme-group/lpac](https://github.com/estkme-group/lpac) next to this repo, then `./install.sh build-lpac`)

---

## Screenshots

The control-plane WebUI — dashboard, browser softphone, SMS messaging, and eSIM management (light theme; a dark theme is also built in):

| Dashboard | Softphone | Messages | eSIM |
|:---:|:---:|:---:|:---:|
| [![Dashboard — per-SIM line status, IMS registration, and controls](screenshots/dashboard.jpg)](screenshots/dashboard.jpg) | [![Softphone — in-browser WebRTC dialer](screenshots/softphone.jpg)](screenshots/softphone.jpg) | [![Messages — SIP MESSAGE ↔ carrier SMS inbox/outbox](screenshots/message.jpg)](screenshots/message.jpg) | [![eSIM — chip info, dual-SE profiles, download and notifications](screenshots/esim.jpg)](screenshots/esim.jpg) |

- **Dashboard** — live per-SIM status (SIM → ePDG DNS → tunnel → IMS reg → working), carrier/number/IMSI/ICCID/SMSC/P-CSCF, PIN state, and per-line controls (stop, re-register, re-provision, SIP info, configure).
- **Softphone** — browser-based WebRTC dialer for placing and receiving calls on the registered line, no external client needed.
- **Messages** — per-line SMS inbox/outbox, bridging SIP MESSAGE ↔ carrier SMS. Long (concatenated) incoming SMS are joined into one message that fills in as the parts arrive (`[…]` marks a part not received yet); SIP clients still get each part separately.
- **eSIM** — local LPA (lpac) for eUICC chips: EID / free space, profile list (enable / disable / delete / nickname), activation-code download with progress, and pending notifications. Dual-SE cards (e.g. ESTKme Max / Plus+) show EID1/EID2 and require an explicit SE pick before download. Loading eSIM info needs exclusive PC/SC access — stop the VoWiFi line on that reader first.

---

## Architecture

The gateway has two planes:

1. **`vowifi/engine`** (per-SIM, always a Podman container): a pure-Python SWu IKEv2/IPsec client (`swu_ike.py`, based on [fasferraz/SWu-IKEv2](https://github.com/fasferraz/SWu-IKEv2)) for the ePDG tunnel (IKEv2 + EAP-AKA, userspace ESP) + sysmocom Asterisk (IMS PJSIP) + USIM bridge scripts (PIN keeper, AMI ↔ PC/SC). One container per SIM, each with `NET_ADMIN` + `/dev/net/tun` + its own port block (5060+, 10000+ RTP). The tunnel client carries VoWiFi resilience: it verifies the SIM PIN (CHV1) in its own PC/SC connection on every EAP-AKA authentication, sends NAT-T keepalives to hold the tunnel open when idle, runs an initiator-side liveness/DPD check to detect a silently-dead ePDG, re-syncs the P-CSCF into PJSIP on reconnect, advertises IKEv2 fragmentation (RFC 7383) and reassembles fragmented ePDG responses (fragmenting its own oversized messages too), classifies reject Notifies per 3GPP TS 24.302 §7.2.2.2 (honouring an attached back-off timer instead of hammering the network), answers the ePDG's IKEv2 `DEVICE_IDENTITY`/DPD/P-CSCF-restoration requests, and records every received 3GPP Notify — so it rekeys/re-auths and self-heals after a full re-establishment (see [Troubleshooting](#troubleshooting)).
2. **control plane** (singleton): manager + WebUI dashboard (Preact), a single Rust binary (`control/`, axum/tokio). Runs natively from the checkout as a **`systemd --user` service** (`vowifi-control`), manages the engine containers through your user's Podman API socket (`$XDG_RUNTIME_DIR/podman/podman.sock`, Docker-compatible API), and reads the SIM over PC/SC through the host pcscd socket. The installer builds it with a per-user [rustup](https://rustup.rs) toolchain (`~/.cargo`, no root). The WebUI is compiled with the host's Node.js (≥ 26 LTS, a prerequisite you install).

### Rootless by design

Everything runs under **your own account** — rootless Podman for the engines, a user service for the control plane — and `./data`, the control build (`control/target`, `control/bin`) and `webui/dist` all belong to you. Nothing in the engine needs host root: `NET_ADMIN`/`NET_RAW`, the `ipsec0` tun device, routes and `net.*` sysctls all act on the container's own network namespace, which your user namespace owns. Lingering is enabled so the control plane and engines start at boot without a login (the user `podman-restart.service` brings back the `restart=always` engines).

Engines use **pasta** networking, which keeps SIP clients' real source addresses. What that implies inside the engine:
- **Forced NAT-T** (`SWU_FORCE_NATT=1`): pasta forwards only TCP/UDP/ICMP, so raw ESP (IP protocol 50) can never leave the host. `swu_ike` sends a deliberately non-matching `NAT_DETECTION_SOURCE_IP` (RFC 7296 §2.23, like strongSwan's `encap=yes`) so the ePDG moves the SA to ESP-in-UDP:4500 even when the host has a public IP. Ignored if the ePDG doesn't do NAT-T at all.
- **Unprivileged IKE source ports**: pasta silently drops datagrams sent from source ports below 1024 and re-sends each flow from the same host port, so every engine sends IKE from its own pair (`45000+2n` / `45001+2n`, `n` = the line's internal index, 0 for the first line; base via `VOWIFI_IKE_LOCAL_PORT_BASE`) to the ePDG's 500/4500. RFC 7296 §2.11 has the ePDG answer whatever port the request came from.
- **MTU**: pasta is an L4 proxy, so PMTU discovery inside the container never sees the real path. Engines start with `pasta:--mtu,<host default-route NIC MTU>` (override with `VOWIFI_ENGINE_NETWORK`, or pin `SWU_OUTER_MTU`) so the tunnel's outer-MTU sensing still works.
- **AMI** is published on host loopback only; the manager connects to `127.0.0.1:<ami port>`.
- **Manager callbacks**: `host.containers.internal` is a link-local address under pasta that an IPv4 IMS PDN's `/1` routes would capture; `swu_ike` pins it to the LAN gateway when that happens.

The reader is owned by the **host's pcscd**, and **pcsc-lite is version-locked** (`PCSC_VERSION`, default 2.3.3) between the host and the engine image so the PC/SC client/server protocol always matches. Distro pcscd builds authorise clients through polkit (only root or an active login session), so the installer adds a polkit rule that lets exactly your user use the reader from the user service and its engines. Runtime data (`config.yaml`, per-instance configs, SQLite call logs, TLS certs) lives in `./data`.

---

## Quick Start

```bash
git clone https://github.com/pagecat/vowifi_gateway.git
cd vowifi_gateway
./install.sh install
```

Run it as your **normal user — not as root and not via `sudo`**. Root is only needed for one-time host setup, and the script asks sudo for exactly those steps: distro packages, the pinned pcscd (if your distro's version differs from `PCSC_VERSION`), `modprobe tun`, lingering, the pcscd polkit rule, the firewalld service, and the SELinux label on the control binary. `reload`, `start`/`stop`/`restart`, `status`, `logs` and autostart never need root.

The installer:
- Installs Podman + passt (distro packages, if missing), enables your user's `podman.socket` / `podman-restart.service` and lingering, and the host pcscd, **version-locked** to `PCSC_VERSION`
- Opens the gateway's ports to your **LAN only** in firewalld, if it is active (a rich rule allowing the `vowifi` service from the LAN subnet, in the zone your LAN traffic lands in; see [Per-instance ports](#per-instance-ports))
- Builds the engine image (compiles pcsc-lite + the Python SWu tunnel deps, bakes `engine/patches/*`; Asterisk is downloaded prebuilt from the fork's CI release for `ASTERISK_REF` when one exists, otherwise compiled from source, ~10–15 min on a Pi)
- Compiles the WebUI with the host's Node.js (`npm ci && npm run build` in `webui/`; it stops right away if Node ≥ 26 is missing), installs the Rust toolchain for your user if needed (rustup into `~/.cargo`), builds the control plane (`cargo build --release` → `control/bin/vowifi-control`; the first build downloads and compiles its crates — a few minutes, ~15+ on a Raspberry Pi-class board), and starts the `vowifi-control` user service. The C toolchain, `pkg-config`, pcsc-lite headers and `curl` it needs to build are installed as distro packages
- Autostart is enabled; prints `https://<host-lan-ip>:8443` — open it in your browser

**Upgrading from an older, rootful install** (system unit, `sudo ./install.sh`, or the removed `--mode container`): just run `./install.sh install`. It removes the old system unit and root's vowifi containers and root's old engine image (it predates the rootless tunnel changes, so the engine image is rebuilt — ~10–15 min), and hands `./data` to you. Your SIM configs, SMS and call history are kept. Lines that were running before are started again through the manager once it is up (same PIN checks as the Start button; a line that needs a PIN is reported and left for you to start); lines you had stopped stay stopped.

Accept the self-signed cert, then **provision your SIM** in the dashboard:
1. Insert the SIM into the reader; the `/` tab shows detected cards
2. Click **Provision** → enter the SIM PIN, set the IMEI + AMI secret. The ePDG is auto-derived from the SIM's IMSI and the SMSC is read from the SIM (EF_SMSP); if the SIM doesn't carry an SMSC you'll be asked to type one. **IMEISV** is optional — leave it blank to auto-generate one (14-digit IMEI base + a 2-digit software version); it's used to answer the carrier's IKEv2 `DEVICE_IDENTITY` request.
3. The engine container spins up and walks the state machine: `TUNNEL_DOWN` → `REGISTERING` → `OK` (IMS registered)
4. Once `OK`, the **Softphone** tab lets you dial out from the browser; external SIP clients connect to `<host-ip>:5060` (UDP) or `:5061` (TLS) / `:8089` (WebRTC/WSS)

---

## Configuration

Set via **env vars** (or a `.env` file next to `install.sh`) before running `install`:

| Env var | Default | What |
|---------|---------|------|
| `VOWIFI_PORT` | `8443` | Host port the WebUI is served/published on |
| `VOWIFI_DATA_DIR` | `<repo>/data` | Runtime data directory (config, logs, DB, certs) |
| `VOWIFI_ADVERTISE_ADDR` | auto-detect | Host LAN IP advertised to local SIP/WebRTC clients for RTP, Contact and SDP. It overrides **Settings → SIP / WebRTC advertise address**. Auto-detection prefers a real LAN NIC and skips common VPN/container interfaces; pin it explicitly on multi-homed hosts. |
| `VOWIFI_BIND` | `::` | Bind address for the control plane. `::` is one dual-stack socket (IPv6 + IPv4, even with `net.ipv6.bindv6only=1`); it falls back to `0.0.0.0` on hosts without IPv6. Set `0.0.0.0` for IPv4 only, or a specific address. |
| `PCSC_VERSION` | `2.3.3` | pcsc-lite version pinned between the host pcscd and the engine image. If your distro already ships a newer pcsc-lite, set it to that version (e.g. in `.env`) instead of having the installer replace the host's pcscd. Keep it set for later `reload`s, which rebuild the engine image with it. |
| `VOWIFI_FW_INSTANCES` | `10` | How many SIM port blocks the firewalld `vowifi` service opens |
| `VOWIFI_FW_ZONE` | auto | firewalld zone to add the rule to (default: the zone your LAN subnet/interface is in) |
| `VOWIFI_FW_SOURCE` | auto | IPv4 subnet allowed through firewalld (default: the on-link subnet of the LAN interface, e.g. `192.168.1.0/24`) |
| `VOWIFI_FW_WEBUI_SOURCE6` | *(none)* | IPv6 prefixes (comma/space separated) allowed to reach the **WebUI port only** through firewalld, e.g. `2001:db8:1234::/48`; `any` allows every IPv6 source. Empty = no IPv6 rule. See [WebUI over IPv6](#webui-over-ipv6). |
| `VOWIFI_FW_ZONE6` | auto | firewalld zone for the IPv6 WebUI rule (default: the zone of the IPv6 default-route interface) |
| `VOWIFI_LOG_RETENTION` | *(none)* | journald time span (e.g. `30day`): journal entries older than this are dropped. Applies **host-wide**; empty = the host's journald policy. See [Logs](#logs). |

Example:
```bash
VOWIFI_PORT=9443 VOWIFI_ADVERTISE_ADDR=192.168.1.100 ./install.sh install
```

---

## Lifecycle

```bash
# Check status (control service + engine containers)
./install.sh status

# View control-plane logs (live) — journalctl --user -u vowifi-control; `logs <id>` for an engine
./install.sh logs

# Start / stop / restart just the control plane (systemd --user service)
./install.sh start
./install.sh stop
./install.sh restart

# Run with NO arguments: installs if nothing is present, otherwise
# opens an interactive control menu (start/stop, autostart, status, logs, reload, uninstall).
./install.sh

# Rebuild + restart the control plane (preserves data, no root): rebuilds the WebUI and the
# control binary and restarts the user service. The engine image is reused unless forced.
# An install from before the Rust control plane needs one `./install.sh install` first (build
# packages); it also removes the old Python venv (control/.venv).
./install.sh reload

# Rebuild from scratch (no Podman build cache; also forces an engine-image rebuild)
./install.sh reload --no-cache

# Rebuild + also recreate engine containers (forces an engine-image rebuild — e.g. after
# changing engine code/patches)
./install.sh reload --engines

# Build/install a local lpac binary for the eSIM tab (PC/SC + curl, STANDALONE).
# Output: $VOWIFI_DATA_DIR/lpac/lpac (or <repo>/data/lpac/lpac). Needed once before
# using WebUI → eSIM; safe to re-run after lpac upgrades.
# Requires the lpac source next to this repo (or pass --lpac-src /path/to/lpac):
git clone https://github.com/estkme-group/lpac.git ../lpac
./install.sh build-lpac
# Or: ./install.sh build-lpac --lpac-src /path/to/lpac

# (Re)open the gateway's ports to the LAN in firewalld (install already does this)
./install.sh firewall

# Log every browser out of the WebUI (login = your Linux user + password)
./install.sh logout-all

# Disable autostart (control + engines won't restart on reboot)
./install.sh disable-autostart

# Re-enable autostart
./install.sh enable-autostart

# Uninstall (removes the engines, the user service, the polkit rule and the firewalld service;
# KEEPS the patched engine image, control build, Podman, pcscd, lingering and ./data so a reinstall is fast)
./install.sh uninstall

# Uninstall + delete everything (engine image, control build, and ./data)
./install.sh uninstall --purge

# OPT-IN: build + install a patched CCID driver (patches/ccid/*) on the host, replacing the
# distro libccid. Only needed for readers with firmware quirks — e.g. the HSIC CCID-Reader
# (1d99:0016), whose GetSlotStatus always answers "no card" so the stock driver never powers
# the SIM. Idempotent; safe to re-run. NOT part of the default install.
# The driver is built from CCID 1.6.2, which already lists 1d99:0016 in its supported-reader
# table — no manual Info.plist whitelisting needed after `patch`. (Distro libccid older than
# 1.6.2, e.g. 1.5.x, does NOT know this VID/PID: without `patch` you'd have to add it to the
# ifdVendorID/ifdProductID/ifdFriendlyName arrays in the driver's Info.plist by hand — and the
# reader still can't power the SIM, because the GetSlotStatus firmware bug needs the patch.)
#
# There are three patch levels — pick ONE based on your card:
#   patch      base fix only (01): HSIC card-presence detection. Standards-compliant cards,
#              incl. physical eSIM, work with just this. RECOMMENDED default.
#   patch2     compatibility fix only (02): HSIC firmware omits the ATR TCK byte; the patch
#              synthesizes it at power-on so normal PTS/SCardConnect can proceed.
#   patchall   both (01 + 02): for such quirky (U)SIMs on the HSIC reader.
# COMPATIBILITY NOTE: patch2/patchall add HSIC-specific ATR handling. If you use a physical eSIM
# (or any compliant card), DON'T run `patchall` — just `./install.sh patch` is enough.
./install.sh patch        # base HSIC fix (recommended; fine for physical eSIM)
./install.sh patch2       # only the ATR-compatibility fix
./install.sh patchall     # both — only for SIMs whose ATR the stock driver rejects
```

### Logs

All logs go to your user journal. The control plane logs there because it is a `systemd --user` service. Each engine logs there through Podman's journald log driver, tagged `CONTAINER_NAME=vowifi-engine-<id>`. The engine's output includes the Asterisk console with SIP traces, plus the entrypoint and supervisor lines.

```bash
./install.sh logs                                   # follow the control plane
./install.sh logs 1                                 # follow engine 1
journalctl --user -a CONTAINER_NAME=vowifi-engine-1 --since "1 hour ago"   # -a: Asterisk colours
journalctl --user -u vowifi-control INSTANCE=1      # control-plane events for line 1
```

Control-plane events carry structured journal fields, so you can filter on them directly. `INSTANCE` is the line id. Run `journalctl --user -u vowifi-control -o verbose` to see all of them.

Logs are for people only; nothing in the gateway parses them. The engine reports structured state instead:

| What | How the control plane gets it |
|------|-------------------------------|
| Outgoing SMS outcome (*delivered* / *failed*) | The SMSC's RP-ACK or RP-ERROR, or a SIP error on the outgoing MESSAGE. Asterisk passes it to the `volte_ims_msg` dialplan, which posts a `notify.py sms_report` event. |
| The line's MSISDN | The REGISTER 200 OK's P-Associated-URI, which Asterisk stores in astdb `volte/pau`; the control plane reads it over AMI `DBGet`. |
| Why the tunnel is down | `swu_ike` writes `ike_reason` to `swu_status.json`. |

So Asterisk debug logging can stay off. **Settings → Asterisk verbose/debug logging** is off by default and only adds detail for troubleshooting. At debug level the engine log is mostly the control plane's AMI polling (`Running action 'Ping'` / `'Command'` every few seconds). Lines provisioned before this change keep their own `debug:` block in `config.yaml`, and it overrides Settings. To make such a line follow Settings again, delete the block, then restart the line.

Inside an engine, two working copies stay for interactive debugging. Asterisk's `/var/log/asterisk/full` holds the same content as the journal. The SWu/IKE log `run/charon.log` is very chatty, so it is kept off the journal. The entrypoint caps each file at 50 MB plus one `.1` generation. Both are lost when the engine is recreated.

`install.sh install` makes the journal persistent by creating `/var/log/journal` where the distro keeps it in RAM only. Retention follows the host's journald policy, which by default caps the journal at 10 % of the filesystem. The engine logs contain phone numbers and IMSIs, so consider a time limit: `VOWIFI_LOG_RETENTION=30day ./install.sh install` adds `/etc/systemd/journald.conf.d/50-vowifi.conf` with `MaxRetentionSec=30day`. This limit applies to the **whole** host journal. Call and SMS history doesn't depend on any of this, because it lives in the SQLite DB in the data dir.

---

## Per-instance ports

Each provisioned SIM gets a port block (no collisions across SIMs). Block `k` (0, 1, 2, …; a new SIM takes the first block whose ports are all free on the host, so a block held by another program is skipped):
- SIP UDP: `5060 + 10*k`
- SIP TLS: `5061 + 10*k`
- WebRTC/WSS: `8089 + 10*k`
- AMI: `5038 + 10*k` — published on **host loopback only** (the manager is its only client)
- RTP: `10000 + 2000*k` through `+59` (60-port range per instance)
- IKE source ports toward the ePDG (outbound only): `45000 + 2*n` and `45001 + 2*n`, where `n` is the line's internal index (0 for the first line provisioned; usually equal to `k`)

Example: the first block is 5060/5061/8089 with RTP 10000–10059, the second 5070/5071/8099 with RTP 12000–12059. The dashboard's **SIP info** shows a line's actual ports.

With firewalld active, `install` (or `./install.sh firewall`) opens the WebUI port plus exactly the SIP UDP, TLS, WSS and 60-port RTP range of each of the first `VOWIFI_FW_INSTANCES` (10) blocks — **only to sources in the LAN subnet** (`VOWIFI_FW_SOURCE`), through a rich rule in the LAN's zone, so a zone shared with a WAN interface stays closed to everything else. Each run first removes the service and its rules from every zone, so changing `VOWIFI_FW_ZONE`/`VOWIFI_FW_SOURCE` leaves nothing open behind. Lines moved to non-default ports are not covered; open those yourself. If the LAN subnet can't be detected, nothing is opened and the installer says so.

### WebUI over IPv6

The control plane listens dual-stack (`VOWIFI_BIND=::`), so the WebUI answers on the host's IPv6 addresses, e.g. `https://[2001:db8::10]:8443`. The `vowifi` rich rule above is IPv4-only, so with firewalld active IPv6 clients are blocked until you opt in. `VOWIFI_FW_WEBUI_SOURCE6` adds a separate `vowifi-webui` service: the WebUI port only, never SIP/WSS/RTP. It is allowed from the listed prefixes, in the zone of the IPv6 uplink (`VOWIFI_FW_ZONE6`):

```bash
VOWIFI_FW_WEBUI_SOURCE6=2001:db8:1234::/48 ./install.sh firewall   # or put it in .env, so later installs keep it
```

> ⚠️ The [login](#login) is your Linux account's password, so exposing the WebUI exposes that password to guessing and, with a self-signed certificate, to interception. Use a real certificate (Settings → TLS) and a strong password. Prefer specific prefixes (your mobile carrier's or your office's) over `any`. Your router's IPv6 firewall usually blocks inbound connections too and needs its own exception for this host and port. Hosts that use temporary (privacy) addresses change them, so point clients at the stable address or a DNS name.

---

## WebUI

Open `https://<host-ip>:<VOWIFI_PORT>` (default 8443).

### Login

You log in with the **Linux account the gateway runs as**: the user that ran `./install.sh install` and owns the `vowifi-control` user service, and that user's normal Linux password. Change it with `passwd`; there is no separate WebUI password.
- The login is required from every client, including localhost and the LAN.
- **Only the service's own user can log in.** The check goes through PAM. An unprivileged process can only verify its own account's password: `pam_unix` hands the check to the setuid `unix_chkpwd` helper, which refuses other users. Empty passwords are always refused, even if PAM is configured `nullok`. Locked or expired accounts fail too.
- **PAM stack:** `/etc/pam.d/vowifi` if you create one, otherwise `system-auth` (Fedora/RHEL), otherwise `login`. `VOWIFI_PAM_SERVICE` picks another one. A stack that asks for a second secret (OTP, U2F) is refused, because the form has one password field.
- **The WebUI password is your Linux password.** Anyone who learns it can also log in to the host (SSH, Cockpit, console) and use `sudo`. Serve the WebUI with a real certificate (Settings → TLS), and on a distro with `pam_faillock`, failed WebUI logins can count toward locking your account.
- **Sessions:** an HttpOnly, `SameSite=Strict` cookie valid for 30 days. **Log out** is in the sidebar and in Settings. Changing the Linux password does not end existing sessions, so use **Settings → Log out everywhere** or `./install.sh logout-all` after changing it. The session key lives in `$VOWIFI_DATA_DIR/auth.json` (mode 0600).
- **Throttle:** failed logins are throttled per client (per `/64` for IPv6). After 5 failures the wait doubles from 2 s up to 15 min, on top of PAM's own ~2 s delay per failure.
- **Engine events:** engines post SMS/call events to `/api/engine/event`, which is not behind the login. Under pasta those requests come from one of the host's own addresses, and the manager accepts the endpoint only from those.

Tabs (see [Screenshots](#screenshots) above):
- **/** (Dashboard) — reader/card status, provision a SIM, engine state per instance
- **/softphone** — browser-based WebRTC dialer (click-to-call from the dashboard, or dial manually; supports inbound calls, DTMF, call recording)
- **/messages** — SMS inbox/outbox (SIP MESSAGE ↔ carrier SMS, per instance)
- **/esim** — eUICC profile management via local lpac (chip info, download, enable/disable/delete, notifications; dual-SE aware). Requires cloning [lpac](https://github.com/estkme-group/lpac) next to this repo and running `./install.sh build-lpac` once.
- **/settings** — global config (TLS domain for Let's Encrypt, Asterisk debug toggles, ring timeout, etc.)
- **/logs** — call/SMS logs with filtering

---

## External SIP clients

Once an instance reaches `OK`, connect any SIP client to the **engine's** published ports (not the control-plane port). Credentials are in the dashboard under the instance's **SIP** section:
- **Username**: `<imsi>` (15-digit, read from the SIM)
- **Password**: the **AMI secret** you set during provisioning (shared between SIP auth and Asterisk AMI)
- **Domain/Server**: `<host-ip>` (or the FQDN in `settings.tls.domain` if you set one)
- **Transport**: UDP (port 5060+offset), TLS (5061+offset), or WebRTC/WSS (8089+offset; path `/ws`)

### Default phone-number account

Every line gets one external SIP account named after its phone number as soon as the number is known (read from the SIM, or learned from the network at the first registration):
- **Username**: the number in international form, digits only, with no `+` (e.g. `79161234567`). Phone numbers are unique, so two SIMs from the same carrier never clash. External account usernames now have to be unique across all lines.
- **Password**: 24 random letters and digits, stored with the other secrets in `data/config.yaml` (mode 0600).
- It's added next to any accounts you already have and never replaces one. If you delete it, it isn't recreated. A line that is already running picks it up at its next start.

To list the accounts, run `VOWIFI_DATA=<data dir> control/bin/vowifi-control sip-accounts`. Add `--show-secrets` to include passwords. The default account is shown with its number in FRITZ!Box format (`00…`).

### One FRITZ!Box trunk for all lines (sip-front add-on)

The separate **sip-front** add-on (a Kamailio container in its own repo) gives a FRITZ!Box **one** account on host port 5060. Every line's number goes under *Other Phone Numbers* on that account. sip-front registers to each engine with that line's default account, so the engines don't change. To feed it, point vowifi at its lines file in `config.yaml` (there's no WebUI setting):

```yaml
settings:
  front_proxy:
    lines_file: ~/.config/sip-front/lines.d/vowifi.json   # written atomically, mode 0600 (holds SIP passwords)
    # engine_host: 192.168.178.44                          # default: the host LAN IPv4 (not 127.0.0.1)
```

In the FRITZ!Box account, tick **Use phone number for registration**: without it the box doesn't say which number an outgoing call uses. The steps are in the sip-front README.

vowifi rewrites the file whenever a line, an account or the settings change. Each entry holds the line, its number, `target` (`<engine_host>:<SIP port>`), `transport`, `username` and `password`. Lines without a default account are left out. vowifi never calls sip-front.

Tested clients: **MicroSIP** (Windows), **Zoiper** (multi-platform), Asterisk PJSIP trunk. Phones that can't dial `+` (e.g. FRITZ!Box DECT handsets) can dial `00…` instead if the line has **SIM Config → Dial a leading 00 as +** enabled; the gateway then sends `+…` to the carrier. Use it for carriers that don't accept `00` as the international prefix (MTS RU); it's off by default. The engine's `/` context accepts any `INVITE` and hairpins it to the IMS trunk (so you dial the **target number** directly, no prefix).

### Codecs

Each call has two legs, and Asterisk converts between them when their codecs differ:

| Leg | Codecs, in preference order |
|-----|-----------------------------|
| Carrier (IMS) | **SIM Config → Carrier codecs**, per line. Default: AMR-WB, AMR, what a phone offers. |
| External SIP clients | G.722, PCMU, PCMA, Opus, AMR (the gateway's order wins over the client's) |
| Browser softphone | Opus, G.722, PCMU, PCMA |

SIP clients get G.722 whenever they offer it, even if they list Opus or PCM first. An AMR-WB or EVS carrier call is converted once and stays wideband: 16 kHz, the widest audio any carrier codec has inside the gateway (EVS is decoded and encoded at 16 kHz). Opus couldn't carry more, so it's only a fallback for SIP clients. The browser softphone keeps Opus first, for its packet-loss resilience over the internet.

On outgoing calls, the gateway offers the carrier exactly this list, in this order, like a phone (3GPP codecs only, no codecs taken from the calling client). The far end picks from the front, so put the codec you want first. AMR and AMR-WB are offered with `mode-change-capability=2`, which a network needs before it can answer AMR-WB restricted for circuit-switched interworking (`mode-set=0,1,2;mode-change-period=2`); without it Beeline RU answered narrowband AMR only. The dialled number is sent as `sip:<number>@<realm>;user=phone`: without `user=phone` MTS RU routed calls over its circuit-switched side (slow setup, narrowband).

On incoming calls, the gateway answers the carrier with every codec from this list that the carrier offered. With the default list they're in the carrier's offer order; with any other list, in **this list's** order. **SIM Config → Incoming calls: answer with a single speech codec** makes the answer carry only the first of them (plus `telephone-event` for DTMF), as 3GPP TS 24.229 asks of a terminating phone. Off by default: MTS RU then never sends audio (see **Troubleshooting**), and none of the tested carriers needs it.

Presets besides the default:
- **G.722 first, then AMR-WB, AMR**, for carriers that accept G.722 themselves (O2 Germany offers it on incoming calls):
  - G.722 calls with a SIP client pass through the gateway without any conversion; the carrier converts to AMR-WB where the far end needs it.
  - The SDP bandwidth (`b=AS`) is raised from 41 to 88 kbit/s, the 64 kbit/s G.722 stream plus IPv6/UDP/RTP headers.
- **AMR, then AMR-WB**, for carriers that end incoming calls answered with AMR-WB or EVS (see **Troubleshooting**, Beeline RU). Calls are then narrowband (8 kHz) end to end. A custom list may name more codecs after `amr`, e.g. `amr, evs, amrwb, g722, alaw, ulaw`: AMR stays the one incoming calls use, the rest are offered too.
- **EVS first, then AMR-WB, AMR**: needs an EVS engine image, see **EVS** below.
- **Custom**: any order of `evs`, `amrwb`, `amr`, `g722`, `alaw`, `ulaw`. The list must keep AMR-WB or AMR, so calls the carrier can't convert still work.

Only use G.722 where you've tested an answered call in both directions: a carrier listing G.722 in its offer doesn't prove it carries it. Check the carrier's `b=AS` in its offer, too: G.722 needs about 88 kbit/s with IPv6/UDP/RTP headers.
- **O2 Germany:** offers `b=AS:88` with G.722. Works.
- **Vodafone Germany:** offers G.722 with only `b=AS:50`, and polices the call to that. Both directions lost a steady ~44 % of packets (RTCP), heard as clipped voice. Leave G.722 out there: EVS (`evs, amrwb, amr`, 49 kbit/s with headers) or the default AMR-WB fits.

Per-carrier results are in **Tested carriers → Codecs per carrier**.

**EVS** is off by default and opt-in per installation. The Asterisk fork's EVS codec (`codec_vevs`) loads a codec library, `libvocal.so`, at runtime. The gateway can build one from the 3GPP EVS reference code (TS 26.443, floating point) with a small shim (`engine/evs/`), but it doesn't ship that code:
- EVS is covered by patents licensed through a patent pool, and 3GPP publishes the reference code for standardisation and evaluation. Whether you may use it for calls is for you to check.
- So the code is never committed here, isn't part of the prebuilt Asterisk tarball, and the default image has no EVS. With `EVS_CODEC=1` the engine build downloads it from 3gpp.org on your machine (checksum-pinned), compiles `libvocal.so`, runs an offline encode/decode test, and installs the library to `/usr/lib` in the image. Keep that image to yourself; don't push it to a registry.

To use EVS:
1. Build the engine image with it, for example by adding `EVS_CODEC=1` to `.env` and running `./install.sh reload --engines`. Plain `podman build --build-arg EVS_CODEC=1 …` works too. This restarts the lines.
2. Put `evs` in the line's carrier codecs: the **EVS first** preset, or a custom list. EVS worked on O2 DE and Vodafone DE (outgoing calls are answered EVS-only there) and on an outgoing MTS RU call to an iPhone; Beeline RU offers it but ended calls answered with it.
3. Restart the line.

On an image without EVS, `evs` in a list is ignored at engine start (logged as `[render] ims_codecs: evs needs an engine image built with EVS_CODEC=1`), so a line never negotiates EVS it can't convert.

What the gateway offers and answers:
- EVS Primary, wideband (16 kHz, the gateway's internal audio rate), with DTX unless the carrier sets `dtx=0`.
- Its offer carries `br=5.9-24.4;bw=nb-swb;max-red=220`, what an iPhone offers. It accepts super-wideband but sends wideband. An answer, and any later offer in the same call, carries `br` and `bw` as the overlap with the other side's (the other side's band when there's no overlap: an offer with `bw=swb` only is answered `bw=swb` and gets wideband audio) and repeats the other side's `cmr`, `evs-mode-switch` and `ch-aw-recv`. Inside the agreed `br` range the gateway sends the highest rate up to 24.4 kbit/s (13.2 if the other side named no `br` at all). `b=AS` is 49 kbit/s.
- Incoming EVS frames are decoded at any rate, compact or header-full, including the AMR-WB IO mode. Lost frames are concealed.
- Redundancy is received, not sent: when a packet carries several frames, a redundant copy stands in for a frame whose own packet was lost.
- Not supported: channel-aware mode, reacting to CMR rate requests, and sending redundancy.

EVS on the carrier leg is still converted for the local clients (EVS ↔ G.722/Opus/AMR-WB …), like any other carrier codec.

The codec setting is rendered into the engine's `pjsip.conf`. Changing it needs the engine image rebuilt once after upgrading (`./install.sh reload --engines`) and the line restarted.

#### Which codecs a carrier supports

Every call records the codecs from its SDP. The engine reads them through the Asterisk fork's `CHANNEL(pjsip,remote_sdp_codecs|remote_sdp_bw|local_sdp_codecs)`, and they're stored with the call in the call log:
- **Softphone → Recent calls** shows the codec of each call, carrier leg ↔ local client (for example `AMR-WB ↔ G.722`). Hover over it for the full SDP lists and the carrier's `b=` lines.
- **SIM Config → Carrier codecs → Seen from this carrier** sums the logged calls up per line. An incoming call's offer lists every speech codec the network accepts. On an outgoing call the carrier picks one from our offer, and the pick depends on the far end, so that row only shows what was answered. Codecs on the line's own list are highlighted.
- The control log has one line per call (`call in|out <peer>: carrier SDP [...] b=[...], our answer|negotiated [...], client [...]`). On an outgoing call our own SDP is only read after the answer, when it has been narrowed to the negotiated codecs, so the full offer isn't in the log.

To find out what a new carrier supports, make one incoming call on the line. Calls from before this feature, and calls through an engine image built before it, have no codecs recorded.

---

## Carrier parameters (no required database)

There is **no required carrier database** — every carrier-specific value is derived from the SIM or the standard 3GPP naming scheme, so any VoWiFi-capable SIM works without a preset:

- **ePDG FQDN** — derived from the SIM's IMSI (MCC/MNC): `epdg.epc.mnc<MNC>.mcc<MCC>.pub.3gppnetwork.org`, resolved via DNS.
- **IMS realm / EAP NAI** — likewise derived: `ims.mnc<MNC>.mcc<MCC>.3gppnetwork.org`.
- **SMSC** — read from the SIM's **EF_SMSP** (`6F42`, authoritative per-SIM). If the SIM doesn't carry one, provisioning asks you to enter it, and you can always override it per-line in **SIM Config**.
- **IMEI / IMEISV** — you set the IMEI per line; the IMEISV (used to answer the ePDG's `DEVICE_IDENTITY` request) is auto-derived from it (14-digit IMEI base + a 2-digit software version) unless you provide one explicitly.
- **IMS address family** — auto-detected per line (see the SWu client notes). A small built-in per-carrier *hint* table (`CARRIER_CP_PREF`) only seeds the probe order to speed up the first attach; it is never required — an unknown carrier just probes the default ladder.

Nothing to preseed or reload — insert the SIM and provision it.

### P-Access-Network-Info (country / BSSID)

IMS REGISTER and subsequent SIP requests carry a `P-Access-Network-Info` header so the
carrier can see the Wi-Fi access context. The default matches real VoWiFi handsets:

```text
P-Access-Network-Info: IEEE-802.11;country=GB
```

`country` is the ISO 3166-1 alpha-2 code derived from the SIM's MCC (E.212 → ISO table in
`control/src/mcc.rs`). Configure per line in **SIM Config → P-Access-Network-Info**:

| Option | Default | Meaning |
|--------|---------|---------|
| Report country code | on | Append `country=XX`. Leave the text box empty to derive XX from the SIM MCC; type e.g. `GB` to pin it. |
| Report Wi-Fi AP BSSID | off | Append `i-wlan-node-id=<12 hex>` (TS 24.229 WLAN AP MAC). Off by default — real phones often omit a forged BSSID. |
| Access type | `IEEE-802.11` | PANI access-type token (`IEEE-802.11*`, or `3GPP-WLAN`). |

Advanced (config.yaml / API only, not in the UI):

- `sip.pani` — raw header override; if non-empty, all of the knobs above are ignored.
- `sip.pani_local_time_zone` — optional `local-time-zone=…` (24.229 says the UE should not insert this; leave unset unless a carrier demands it).

**Migration note:** older builds sent `IEEE-802.11;i-wlan-node-id=ffffffffffff` (no country,
forged BSSID). After upgrade, the next line restart / save emits `IEEE-802.11;country=<home>`.
If a carrier regresses, turn on **Report Wi-Fi AP BSSID** (optionally with a real AP MAC) or set
`sip.pani` to the exact legacy string.

---

## Troubleshooting

**Engine stuck at `EPDG_UNRESOLVED` or `TUNNEL_DOWN`:**  
Check the ePDG FQDN resolves + is reachable on UDP 500/4500. Some carriers restrict ePDG access by geo/IP; a VPN exit in the carrier's home country can help.

**Repeated `AUTHENTICATION_FAILED (24)` right after a reconnect, but a fresh start works:**  
The ePDG rejected the EAP-AKA *fast re-authentication identity* (RFC 4187 `AT_NEXT_REAUTH_ID`) that
the AAA issued on the previous attach and has since expired — the IKE_AUTH reply carries only the
Notify, with no EAP challenge, so the SIM is never queried. swu_ike detects this, drops the stale
identity and retries immediately with the permanent IMSI NAI (look for `the AAA has expired it` in
the engine log); it does not offer another fast re-auth identity for the rest of that run. For a
carrier where this happens on every reconnect, skip the wasted round trip by unticking **Use EAP-AKA
fast re-authentication** in **SIM Config** (stored as `use_reauth_id: false` on the line, passed to
the engine as `SWU_USE_REAUTH_ID=0`).

Note this is distinct from a genuine `AUTHENTICATION_FAILED` on the permanent NAI, which the WebUI
reports as *not provisioned for Wi-Fi Calling* — the fallback path deliberately avoids that wording
so the two are not confused.

**`PIN_PROBLEM`:**  
Wrong PIN, or the SIM locked (PUK needed). Re-provision with the correct PIN; if the SIM is locked, unlock it first (SIM manager tool outside this gateway).

**Start refused with *card mismatch*, or `NO_CARD` — "The card in this line's reader is a different SIM":**  
Each line remembers its SIM's ICCID and its reader (USB port). When that reader now holds another
SIM (cards swapped between lines, or an eSIM profile switch), the manager refuses to start the line,
and an engine that comes up anyway (boot, self-heal restart) leaves the card alone: `pin_keeper`,
`swu_ike` and `ami_usim` read the ICCID first and never send this line's PIN to another SIM. Insert
the line's own SIM (it may go in any reader: the line follows its ICCID) and start it again.

**`REGISTERING` → timeout:**  
The tunnel is up (so the SIM already passed EAP-AKA), but IMS-AKA on `REGISTER` fails. The gateway never sees Ki/OPc — `ami_usim.py` forwards each SIP challenge to the card's AUTHENTICATE command — so check `usim_status.json` in the instance's run dir (`/run/vowifi` inside the engine): `AUTH_FAIL` means the card rejected the challenge, `PIN_FAIL`/`NO_CARD` means the SIP auth path can't reach the card (PIN or reader binding). If the card answers (`AUTH_OK`) and the network still rejects, the line is most likely not provisioned for IMS / Wi-Fi Calling — check with your carrier.

**Tunnel drops after a while, or a call drops mid-session:**  
Handled automatically by the Python SWu tunnel client. Behind NAT the ESP-in-UDP flow would
otherwise be dropped by the router/conntrack when idle, so the client sends periodic NAT-T
keepalives to hold it open. It also runs an **initiator-side liveness check** (RFC 7296 /
3GPP TS 24.302 §7.2.2A): after an idle period (`SWU_LIVENESS_PERIOD`, default 20 s) it sends an
acknowledged empty `INFORMATIONAL` probe, and if several consecutive probes go unanswered
(`SWU_LIVENESS_RETRIES`, default 4) it declares the ePDG dead and tears the tunnel down so the
supervisor re-establishes it — instead of sitting "connected" on a black-holed tunnel. An
unanswered probe is retransmitted with the same IKE message ID (the IKEv2 window is one request),
and no rekey starts while one is outstanding. If the ePDG still refuses one of our requests with
`INVALID_MESSAGE_ID`, the IKE SA can no longer send requests, so the client re-establishes the
tunnel (`reason_code=ike_msgid_desync`). Carriers
also periodically rekey or force a full re-authentication; because the client re-verifies the SIM
PIN (CHV1) in its own PC/SC connection on every EAP-AKA run, and a supervisor restarts it on any
exit, the tunnel recovers on its own (a brief media blip) instead of dying on a locked card — and
the newly assigned P-CSCF is re-synced into PJSIP so calls/SMS keep routing. No action needed;
watch it in the IKE (SWu) log (`VoWiFi: VERIFY CHV1 ok`, `tunnel CONNECTED`, `liveness: …`).

**Diagnosing an unexpected tunnel drop:**  
The SWu client records **every** IKEv2 Notify the ePDG sends (3GPP TS 24.302 error + status
types), with a friendly description. Notify types it doesn't specifically act on are logged with
an extra `UNHANDLED Notify …` line carrying the full payload hex — so when a carrier tears a
tunnel down for a non-obvious reason (backoff timer, PLMN/RAT restriction, reactivation request,
a vendor-private code, …), the cause is captured in the IKE (SWu) log rather than lost. Look for
`received Notify:` / `UNHANDLED Notify` around the disconnect.

**SWu client — 3GPP TS 24.302 conformance & non-goals:**  
The client implements the parts of TS 24.302 that matter for a stable single-PDN VoWiFi attach:
EAP-AKA over IKEv2; a CFG (config-request) address family that matches the carrier's IMS PDN —
`auto` (default) probes families after SIM auth and pins the one that yields a usable PDN (a
CONNECTED tunnel *with* a P-CSCF), or you can pin `v6`/`v4`/`dual` per line (`SWU_CP_MODE`); for IPv6
it accepts either an `INTERNAL_IP6_ADDRESS` or an `INTERNAL_IP6_SUBNET` prefix, from which a stable
inner address is derived, and Asterisk's IMS transport binds the matching family; on an IPv4 PDN a
source-based policy route keeps the container's own LAN traffic (the WebRTC WSS softphone, DNS) off the
full-IPv4 tunnel default while IMS still traverses it; `DEVICE_IDENTITY`;
P-CSCF restoration (plus optional reselection-support advertisement, `SWU_PCSCF_RESELECTION_SUPPORT`);
IKEv2 fragmentation (RFC 7383) — advertised, with inbound reassembly **and** outbound fragmentation
of an oversized message; reject-Notify back-off classification (§7.2.2.2); initiator liveness/DPD
refreshed by both IKE and ESP traffic (§7.2.2A); correct handling of ePDG-initiated `CREATE_CHILD_SA`
(classified as IKE-rekey / ESP-rekey / additional-bearer and answered with the right Notify) and
`DELETE` (SPI-mapped response, `INVALID_SPI` on an unknown SPI, `REACTIVATION_REQUESTED_CAUSE`
honoured); IKE request retransmission with responder-side duplicate-request suppression; and an
env-selectable APN-FQDN IDr (§7.2.2.1, `SWU_IDR_MODE=fqdn`; the Telus-verified bare-APN form is the
default). The following are **conscious non-goals** (out of scope for this gateway — where the
network requests them the client refuses cleanly and the supervisor re-establishes): in-place
IKE-SA / ePDG-initiated ESP-SA rekey *acceptance* (a UE-initiated proactive ESP rekey with PFS is
done instead); multiple-bearer PDN (additional bearers are safely refused with `NO_ADDITIONAL_SAS`;
no EPS-QoS/TFT); ePDG AUTH-payload signature verification (EAP-AKA `AT_MAC` already gives mutual auth
in practice); MOBIKE / `UPDATE_SA_ADDRESSES` (the host has a stable wired IP); multiple-authentication
/ external-AAA (PAP/CHAP); and emergency sessions / N1-mode-5GS.

**Browser softphone won't connect / stuck "connecting":**  
- Hard-refresh (Ctrl+Shift+R) to load the latest WebUI bundle, and accept the self-signed cert for the line's WSS port (the browser needs a per-port exception; the WebUI port and each line's WebRTC port use the same cert but are trusted separately).
- On an **IPv4 IMS carrier** (e.g. Vodafone UK) the engine installs a source-based policy route so the tunnel's full-IPv4 default route doesn't blackhole the container's own LAN return traffic (the WSS handshake). This is automatic; if you run a heavily customised network, the table id / rule preference are overridable via `SWU_LAN_BYPASS_TABLE` / `SWU_LAN_BYPASS_PREF`.

**Audio one-way or none:**  
- **Browser softphone silent**: hard-refresh (Ctrl+Shift+R) to load the latest WebUI bundle (the audio attach fix). Check the browser Console for `audioblocked` or autoplay errors.
- **Status "The carrier's IMS accepted the registration but then removed it again"** (`ims_rejected`): after each IMS registration the engine subscribes to the `reg` event package like a phone (3GPP TS 24.229) and tracks the network's NOTIFYs. Some carriers accept the REGISTER and then terminate it within a second (`event="rejected"`, seen on MTS RU); calls then fail with `403 Forbidden - 4003 User not registered`. It's a carrier-side check of how the client looks, not a tunnel or SIM problem; check the engine log for `VoLTE: network terminated our IMS registration`. Fix it per line under **SIM Config → IMS registration (advanced)**, all off by default and affecting only that line:
  - **Geolocation in REGISTER (country)**: adds a `Geolocation` header and a PIDF-LO body with the civic-address country (RFC 6442), as iPhones do. **MTS RU needs exactly this** (set the country you are in, e.g. `DE`).
  - **Registrar home domain**: REGISTER request-URI instead of the IMSI-derived `ims.mnc…mcc….3gppnetwork.org` (iPhones on MTS use `rf.ims.mts.ru`); identities stay IMSI-derived.
  - **Advertise SRVCC capabilities in REGISTER**: `+g.3gpp.mid-call;+g.3gpp.srvcc-alerting;+g.3gpp.ps2cs-srvcc-orig-pre-alerting` in the Contact.
  - **IMEI with spare digit 0**: `+sip.instance` as `urn:gsma:imei:TAC-SNR-0` (RFC 7254) instead of ending in the check digit.
- **Outgoing calls fail with `491 Request Pending` followed by `500 Server Internal Error` (Q.850 cause 47)**: the engine sent the precondition `UPDATE` while the carrier was still processing the `PRACK` for its `183`. Enable **SIM Config → Send the call-setup UPDATE only after the PRACK is answered** for that line (needed on MTS RU for calls to other Russian operators). Off by default.
- **Incoming calls connect but have no audio in either direction (outgoing calls are fine)**: the carrier's `INVITE` lists `precondition` in `Supported` (not `Require`) and reports its own side ready (`a=curr:qos local sendrecv`). The engine answers `183` with `curr:qos local none` and waits for the carrier's `UPDATE`, while the carrier waits for ours. Neither is sent, and the carrier never opens the media path. Enable **SIM Config → Incoming calls: skip QoS preconditions unless the carrier requires them** for that line (needed on Vodafone DE). Incoming calls then go without preconditions, like on carriers that don't offer them (O2 DE). Over VoWiFi there's no radio bearer to reserve, so nothing is lost. Off by default.
- **Incoming calls never ring, or end the moment you answer, with `Media Negotiation Failed`** (Beeline RU; outgoing calls are fine): the carrier sends `CANCEL` (before ringing) or `BYE` (right after answering) with `Reason: Q.850;cause=31 … Media Negotiation Failed`. Find it with `grep 'Media Negotiation' /var/log/asterisk/full` in the engine. Beeline's Huawei core rejects two things other carriers accept, and needs both settings:
  1. QoS preconditions when its `INVITE` only *supports* them: enable **SIM Config → Incoming calls: skip QoS preconditions unless the carrier requires them**.
  2. Any codec but AMR-NB as the one used (the first in the answer), though it offers EVS and AMR-WB; it also answers our outgoing calls with AMR-NB whatever we offer: put `amr` first in **SIM Config → Carrier codecs** (**AMR, then AMR-WB**, or a custom list such as `amr, evs, amrwb, g722, alaw, ulaw`). Answers with several codecs are fine as long as AMR comes first; the single-codec option isn't needed.
- **Incoming calls connect but have no audio, the carrier's `PRACK` has no SDP** (MTS RU; outgoing calls are fine): the line has **SIM Config → Incoming calls: answer with a single speech codec** enabled. MTS's P-CSCF sets up media only after it re-offers the chosen codec in the `PRACK` for our `183`, and it skips that re-offer when the answer already has one codec. The local client's `X-RTP-Stat` in the `BYE` then shows `PR=0`. Turn the option off for that line.
- **External client no audio**: confirm `VOWIFI_ADVERTISE_ADDR` is the correct LAN IP (not 127.x). Check that the firewall allows RTP from the client (`./install.sh firewall` opens UDP 10000+ for the LAN in firewalld).
- **WebUI or SIP unreachable from the LAN, fine on the host itself**: the ports are plain host sockets of your user, so the host firewall filters them. `./install.sh firewall` (re)adds the rule allowing the `vowifi` firewalld service from your LAN subnet; set `VOWIFI_FW_SOURCE` / `VOWIFI_FW_ZONE` if it picked the wrong subnet or zone.
- **Outbound works, inbound fails**: your router's NAT may mangle the SIP `Contact` header. Use the TLS transport (port 5061) if your client supports it, or set `settings.tls.domain` to a public FQDN + port-forward.

**Control plane won't start:**  
Check its logs with `./install.sh logs` (`journalctl --user -u vowifi-control`). Common causes: `/run/pcscd/pcscd.comm` missing (host pcscd not running), the user Podman API not reachable (`systemctl --user status podman.socket`), or no SIM/reader visible with `Access denied (0x8010006A)` — the distro pcscd's polkit check; re-run `./install.sh install` to restore the `/etc/polkit-1/rules.d/50-vowifi-pcsc.rules` rule for your user.

**Gateway gone after logout / not back after reboot:** lingering is off (`loginctl show-user $USER -p Linger`). Enable it with `sudo loginctl enable-linger $USER` (install does this).

**Tunnel never answers (`IKE request retransmit 3/3` for `IKE_SA_INIT`):** check that the engine shows its `SWU_IKE_LOCAL_PORT` (≥ 1024) in `podman inspect vowifi-engine-<id>`, and that nothing else on the host holds that UDP port (`ss -uanp | grep 4500`). pasta drops flows it can't bind on the host.

---

## Development

**The installed system already IS the dev-friendly path**: the control plane runs natively from `control/`, so after editing `control/src/` a `./install.sh reload` rebuilds and restarts it (quicker, control only: `cd control && cargo build --release && install -m 0755 target/release/vowifi-control bin/ && ../install.sh restart`). To live-edit **engine** scripts without rebuilding the image, give the control plane `VOWIFI_DEV_MOUNTS=1` with a user drop-in (no root needed):

```bash
mkdir -p ~/.config/systemd/user/vowifi-control.service.d
printf '[Service]\nEnvironment=VOWIFI_DEV_MOUNTS=1\n' > ~/.config/systemd/user/vowifi-control.service.d/dev-mounts.conf
systemctl --user daemon-reload && ./install.sh restart
```

The manager then bind-mounts the local `engine/*.py`, `entrypoint.sh` and templates into each engine container as read-only overlays, so an edit + restarting the line (or `podman restart vowifi-engine-<id>`) applies immediately. The mounted scripts must keep their executable bit (Asterisk runs `notify.py` directly).

**Control-plane only, by hand** (outside the installer): `cd control && VOWIFI_DATA=../data cargo run --release` (needs a C toolchain, `pkg-config` and the pcsc-lite headers; `RUST_LOG=debug` for verbose logs). `cargo test` runs the unit tests; `cargo clippy` lints. Read-only probes against a live install (Podman inspect/logs, AMI registration state, reader presence — no APDUs, no container changes): `VOWIFI_DATA=../data VOWIFI_LIVE_IID=1 cargo test live_ -- --ignored --nocapture`. The TypeScript WebUI dev server (`cd webui && npm run dev`) proxies `/api` + `/ws` to the control plane — point it with `VOWIFI_DEV_API=https://<gateway-host>:8443` (defaults to `localhost:8443`). Run `npm run typecheck` from `webui/` to type-check without building; `npm run build` type-checks and bundles the app.

**Asterisk changes**: the engine builds Asterisk from the fork [aalexr/asterisk](https://github.com/aalexr/asterisk), branch `vowifi/20.7.0` — sysmocom's `sysmocom/20.7.0` plus the AMR cherry-pick and this project's IMS fixes as ordinary commits. To change Asterisk, commit to that branch, then set `ASTERISK_REF` in `engine/Containerfile` to the new commit SHA and rebuild the engine image. pjproject is sysmocom's `sysmocom/2.14`, pinned by `PJPROJECT_REF`. Both can be overridden for a test build with `--build-arg ASTERISK_REPO=… --build-arg ASTERISK_REF=…`.

**Prebuilt Asterisk**: the fork's `VowifiBuild` GitHub Actions workflow builds every commit pushed to a `vowifi/**` branch on the engine's Fedora 40 base for x86_64 and aarch64, and publishes the installed tree to the release `build-<commit sha>` (`asterisk-fedora40-<arch>-pj<pjproject sha12>.tar.gz` + `SHA256SUMS`). The engine build downloads the matching tarball for `ASTERISK_REF`/`PJPROJECT_REF`, verifies the checksum and unpacks it, so a Pi doesn't have to compile Asterisk. If there is no such release (CI not finished, or a different `ASTERISK_REPO`), it compiles from source as before. To bump Asterisk, wait for the workflow on the new commit to finish before setting `ASTERISK_REF`. `--build-arg ASTERISK_PREBUILT=never` always compiles; `=always` fails the build if no prebuilt tarball exists.

**Manual build**:
```bash
podman build -t localhost/vowifi/engine engine/
```

**EVS shim** (`engine/evs/`, see **Codecs → EVS**): `libvocal_evs.c` implements the `libvocal.so` API that `codec_vevs` loads (documented in `vocal.h`) on top of the 3GPP reference code; `build-libvocal.sh` downloads that code and builds the library. Without the engine image, `EVS_TEST=1 engine/evs/build-libvocal.sh /tmp/evs-out /tmp/evs-work` builds it on the host (gcc, curl, unzip) and runs the offline round-trip test (`test_libvocal.c`): 16 kHz audio through EVS at 5.9, 9.6, 13.2 and 24.4 kbit/s with DTX, a lost frame, and several instances interleaved and on parallel threads.

---

## State machine (per instance)

```
NO_CARD → (card inserted) → PIN_PROBLEM → (PIN verified) →
EPDG_UNRESOLVED → (DNS + routing ok) →
TUNNEL_DOWN → (IKEv2 EAP-AKA succeeds) →
REGISTERING → (IMS REGISTER 200 OK) →
OK
```
`STOPPED` = user-initiated stop. Each transition logs to the engine's journal (`./install.sh logs <id>`) and posts an event to the control plane (state + timestamp in the dashboard). The control plane also polls engine status files (`/run/<id>/status`, bind-mounted from the data dir).

---

## License

Released under the [MIT License](LICENSE). The build pulls in third-party components under their own licenses:
- [phcoder/asterisk-docker](https://github.com/phcoder/asterisk-docker) (sysmocom VoWiFi-enabled Asterisk)
- [sysmocom Asterisk](https://gitea.sysmocom.de/sysmocom/asterisk) + [pjproject](https://gitea.sysmocom.de/sysmocom/pjproject), built from the fork [aalexr/asterisk](https://github.com/aalexr/asterisk) (GPLv2)
- [fasferraz/SWu-IKEv2](https://github.com/fasferraz/SWu-IKEv2) (pure-Python SWu ePDG IKEv2/IPsec client)
- [mitshell/CryptoMobile](https://github.com/mitshell/CryptoMobile) + [mitshell/card](https://github.com/mitshell/card) (Milenage / USIM helpers)
- [pyscard](https://pyscard.sourceforge.io/) (PC/SC, LGPL)
- [estkme-group/lpac](https://github.com/estkme-group/lpac) (local LPA for the eSIM tab)

---

## Tested carriers

| MCC-MNC | Carrier | Status | Notes |
|---------|---------|--------|-------|
| 302-220 | Telus (CA) | ✓ works | ePDG auto-derived from IMSI, full two-way voice + SMS; IPv6 IMS PDN |
| 234 (EE) | CTExcel (UK, on EE) | ✓ works | China Telecom MVNO on EE's UK network; IPv6 IMS PDN |
| 234-15 | Vodafone (UK) | ✓ works | IPv4 IMS PDN (needs the IPv4/dual CFG family — auto-detected) |
| 262-02 | Vodafone (DE) | ✓ works | needs the incoming-call precondition option; EVS both ways (codecs below) |
| 262-03 | O2 (DE) | ✓ works | EVS both ways, G.722 carried (codecs below) |
| 250-01 | MTS (RU) | ✓ works | needs Geolocation country; keep the single-codec answer off (no audio otherwise); AMR-WB |
| 250-99 | Beeline (RU) | ✓ works | needs the incoming-call precondition option and `amr` first in its carrier codecs (AMR-NB only) |
| 208-15 | Free (FR) | ✓ works | |
| 310-260 | T-Mobile (US) | untested | should work; ePDG auto-derived from IMSI |

Any VoWiFi-capable SIM should work without configuration: the ePDG/realm are derived from the IMSI,
the SMSC from the SIM, and the IMS address family is **auto-detected** (a per-carrier hint DB seeds
the probe order, then the client falls back through the remaining families until one attaches). Reports
of additional working carriers welcome.

### Codecs per carrier

From answered calls in both directions on each line (2026-11), read from the per-call codec log
(**Codecs → Which codecs a carrier supports**). "Offers" is the carrier's offer on incoming calls,
i.e. every codec it accepts; "Picks" is what it answered on outgoing calls, where we offered EVS or
all six codecs first. The far end matters on outgoing calls, so the pick can differ by callee.

| Carrier | Offers (incoming) | `b=` | Picks (outgoing) | Works best with | Carrier codecs setting |
|---------|-------------------|------|------------------|-----------------|------------------------|
| O2 (DE) | EVS, AMR-WB, AMR, G.722, PCMA, PCMU | `AS:88` | EVS | EVS both ways; G.722 also works | `evs, g722, amrwb, amr` |
| Vodafone (DE) | EVS (up to `bw=swb`), AMR-WB, G.722, AMR, PCMA | `AS:50` | EVS | EVS both ways. G.722 is offered but policed to 50 kbit/s: ~44 % loss | `evs, amrwb, amr` |
| MTS (RU) | AMR-WB (`mode-set=0,1,2`, max 12.65 kbit/s), AMR, PCMA | `AS:88` | AMR-NB (to a Beeline phone) | AMR-WB. No EVS, no G.722 | default (`amrwb, amr`) |
| Beeline (RU) | EVS (`bw=swb` and `bw=wb`), AMR-WB, AMR | `RR:0`, `RS:0` | AMR-NB, whatever we offer | AMR-NB only. Answers with EVS or AMR-WB as the used codec end in `Media Negotiation Failed`; a multi-codec answer with AMR first is fine | `amr` first, e.g. `amr, evs, amrwb, g722, alaw, ulaw` |

EVS needs an engine image built with `EVS_CODEC=1` (**Codecs → EVS**); without it, use AMR-WB on
O2 and Vodafone. With a FRITZ!Box DECT HD handset (G.722) an EVS or AMR-WB carrier call is converted
once and stays wideband; on O2 the handset's calls ran EVS ↔ G.722 without loss. Calls that cross
into another operator's network can still arrive narrowband in a wideband codec (one Beeline → MTS
call did): that is the interconnect, not the line.

---

## Credits

Concept + implementation: exploring IMS/VoWiFi as a SIP bridge use case. Builds on the excellent work by phcoder (sysmocom Asterisk VoWiFi integration), fasferraz (SWu-IKEv2 ePDG client), mitshell (CryptoMobile / card), and the pySIM community.
