#!/bin/sh
# install.sh — one-click installer / lifecycle manager for the VoWiFi→SIP gateway.
#
# Deploys the gateway on any systemd Linux with Podman and a PC/SC reader, ROOTLESS:
#   - the control plane (manager + WebUI, a Rust binary built from control/ with a per-user
#     rustup toolchain) runs natively from this checkout as a `systemd --user` service
#     (vowifi-control) of YOUR account;
#   - one engine container per SIM runs in YOUR rootless Podman on pasta networking
#     (forced NAT-T, per-engine IKE source ports — see control/src/engine.rs);
#   - lingering is enabled so both start at boot without a login; the user podman-restart.service
#     brings the engines back.
# The WebUI is compiled with a throwaway Node container, so the host needs no Node/JS toolchain.
#
# Shared with the host:
#   - host pcscd owns the reader; containers are its clients over /run/pcscd. pcsc-lite is
#     version-LOCKED (PCSC_VERSION) between the host and the engine image so the PC/SC
#     client/server protocol matches (distro defaults differ -> "Failed to establish context").
#   - the engine image is built from source with all bug-fix patches baked in (engine/patches/*).
#
# Usage (as your normal user — NOT root, NOT sudo):
#   ./install.sh install                 # full install
#   ./install.sh reload [--no-cache] [--engines]
#   ./install.sh build-lpac [--lpac-src PATH] [--dest DIR]   # local eSIM LPA (lpac)
#   ./install.sh start | stop | restart | status | logs
#   ./install.sh enable-autostart | disable-autostart
#   ./install.sh firewall                # (re)open the gateway ports to the LAN in firewalld
#   ./install.sh uninstall [--purge]     # --purge also deletes ./data (+ the control build)
#
# PRIVILEGES: root is only needed for one-time host setup, and the script asks sudo for exactly
# those steps: distro packages, the pinned pcscd / CCID driver, `modprobe tun`, lingering, the
# polkit rule that lets this user reach pcscd, the firewalld service and the SELinux label on
# the control binary (install / uninstall / build-lpac / patch* / firewall). reload, start/stop/restart,
# status, logs and autostart never need root.
#
# Installs made by older versions (rootful Podman, system unit or the privileged "container"
# deploy mode) are migrated by `install`: the old unit and root's vowifi containers are removed,
# root's engine image is copied instead of rebuilt, and ./data is handed to you.
#
# Config via env (or a .env file next to this script):
#   VOWIFI_PORT            WebUI port                                 (default 8443)
#   VOWIFI_DATA_DIR        runtime data dir                           (default <repo>/data)
#   VOWIFI_ADVERTISE_ADDR  host LAN IP for SIP/WebRTC media           (default: auto-detect)
#   VOWIFI_BIND            control bind addr                          (default :: = IPv6 + IPv4)
#   VOWIFI_FW_INSTANCES    SIM port blocks opened in firewalld        (default 10)
#   VOWIFI_FW_ZONE         firewalld zone to open them in             (default: the LAN's zone)
#   VOWIFI_FW_SOURCE       source subnet allowed through firewalld    (default: the LAN subnet)
#   VOWIFI_FW_WEBUI_SOURCE6  IPv6 prefixes allowed to the WebUI port   (default: none; "any" = all)
#   VOWIFI_FW_ZONE6        firewalld zone for those IPv6 rules        (default: the IPv6 uplink's zone)
#   PCSC_VERSION           pinned pcsc-lite version                   (default 2.3.3)
#   LPAC_SRC               optional path to lpac source (for build-lpac)
#   CMAKE_FETCH_VER        Kitware cmake version if system is too old (default 3.31.12)
set -eu

# ------------------------------------------------------------------ paths & config
SELF_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
REPO_DIR="$SELF_DIR"
[ -f "$REPO_DIR/.env" ] && . "$REPO_DIR/.env"

VOWIFI_PORT="${VOWIFI_PORT:-8443}"
VOWIFI_DATA_DIR="${VOWIFI_DATA_DIR:-$REPO_DIR/data}"
VOWIFI_BIND="${VOWIFI_BIND:-::}"
VOWIFI_ADVERTISE_ADDR="${VOWIFI_ADVERTISE_ADDR:-}"

# Fully qualified: podman stores locally built images under localhost/.
ENGINE_IMAGE="localhost/vowifi/engine"
ENGINE_PREFIX="vowifi-engine-"
# Base image for the throwaway WebUI build (fully qualified: podman doesn't assume docker.io).
NODE_IMAGE="docker.io/library/node:22-alpine"

# The control plane: built with cargo, installed to control/bin (its own dir, so the SELinux
# label below covers it and a rebuild never swaps the binary of the running service mid-flight).
CONTROL_SRC="$REPO_DIR/control"
CONTROL_BIN="$REPO_DIR/control/bin/vowifi-control"
# Per-user Rust toolchain (rustup); never root. An existing ~/.cargo is reused.
CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}"
RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}"
export CARGO_HOME RUSTUP_HOME
# Oldest rustc that builds control/ (Cargo.toml rust-version).
RUST_MIN=1.88
# The Python control plane of earlier versions; removed by install/reload.
LEGACY_VENV_DIR="$REPO_DIR/control/.venv"
WEBUI_DIST="$REPO_DIR/webui/dist"
# The control plane: a systemd USER unit of the installing account.
USER_UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
USER_UNIT="$USER_UNIT_DIR/vowifi-control.service"
# Oldest podman whose pasta networking maps host.containers.internal to the host (--map-guest-addr);
# before 5.3 that name resolved to the container's own (host-copied) address under pasta.
PODMAN_MIN=5.3

# Left behind by installs from older versions (rootful); only used to migrate them away.
LEGACY_SYSTEM_UNIT="/etc/systemd/system/vowifi-control.service"
LEGACY_CONTROL_IMAGE="localhost/vowifi/control"
# Instance ids whose engines were running under a rootful install, restarted after migration.
MIGRATE_RESTART_FILE="$VOWIFI_DATA_DIR/.migrate-restart"

# pcsc-lite version pinned across the host + the engine image so the PC/SC client/server
# protocol always matches (distro defaults differ -> "Failed to establish context").
PCSC_VERSION="${PCSC_VERSION:-2.3.3}"
# Set by ensure_pcscd: 1 if we source-built pcsc-lite on the host (headers already in /usr),
# 0 if the distro package already matched the pin (need the distro -dev pkg for pyscard headers).
PCSC_SOURCE_BUILT=0
# CCID USB driver version, built from source ON THE HOST with local fixes (patches/ccid/*).
# NOT installed by default — run `./install.sh patch` to build + install it. Needed only
# for the HSIC CCID-Reader (1d99:0016): its firmware always answers "no ICC present" to
# GetSlotStatus even while a card is inserted and powered, so stock libccid never powers
# the card. NotifySlotChange only sets a pending flag; IFDHICCPresence tick probes
# via IccPowerOn/ATR (debounced) and restores prior power state.
# Keep this >= 1.6.2: that release added 1d99:0016 to the supported-reader table, so the
# built driver recognizes the VID/PID out of the box (older/distro libccid < 1.6.2 would
# additionally need the device whitelisted by hand in the bundle's Info.plist).
CCID_VERSION="${CCID_VERSION:-1.6.2}"

# ------------------------------------------------------------------ pretty output
if [ -t 1 ]; then B=$(printf '\033[1m'); G=$(printf '\033[32m'); Y=$(printf '\033[33m'); R=$(printf '\033[31m'); N=$(printf '\033[0m'); else B=; G=; Y=; R=; N=; fi
info() { printf '%s==>%s %s\n' "$G$B" "$N" "$*"; }
warn() { printf '%s!!%s %s\n'  "$Y$B" "$N" "$*"; }
err()  { printf '%sxx%s %s\n'  "$R$B" "$N" "$*" >&2; }
die()  { err "$@"; exit 1; }

# ------------------------------------------------------------------ privileges
# Admin tools (semanage, restorecon, ldconfig, pcscd, firewall-cmd) live in sbin, which is not on
# a normal user's PATH on Debian-likes — append it so `have` finds them.
PATH="$PATH:/usr/local/sbin:/usr/sbin:/sbin"; export PATH

# Everything (podman storage, the user unit, ./data) belongs to the account running this script,
# so it must never run as root: a root run would install into root's Podman and systemd instead.
if [ "$(id -u)" -eq 0 ]; then
  die "run install.sh as the user that will own the gateway, not as root or via sudo — it asks for sudo itself where needed"
fi
ME=$(id -un)

# Run one host-setup command as root (sudo can't run shell functions — real commands only).
as_root() { sudo -- "$@"; }

# Commands that change the host call this first: make sure we CAN escalate, and ask for the
# sudo password once, up front, instead of halfway through a 20-minute build.
SUDO_READY=0
need_sudo() {
  [ "$SUDO_READY" = 1 ] && return 0
  command -v sudo >/dev/null 2>&1 || die "'$CMD' needs sudo for one-time host setup, and sudo is not installed"
  # Try a non-interactive run first: `sudo -v` alone demands a password whenever ANY matching
  # sudoers entry needs one (verifypw=all), even if a NOPASSWD rule would let every command through.
  if ! sudo -n true 2>/dev/null; then
    info "'$CMD' needs root for one-time host setup (packages, pcscd, firewall) — sudo may ask for your password"
    sudo -v || die "could not obtain sudo privileges"
  fi
  SUDO_READY=1
}

# Remove a tree that may still be root-owned from an install by an older (rootful) version.
rm_tree() { rm -rf "$1" 2>/dev/null || as_root rm -rf "$1"; }

# ------------------------------------------------------------------ helpers
have() { command -v "$1" >/dev/null 2>&1; }

# Best-effort primary LAN IPv4 of THIS host (the address SIP/WebRTC clients must reach).
detect_lan_ip() {
  # Prefer a real LAN NIC over the default-route source. With a full-tunnel VPN the
  # latter is commonly a private tunnel address that LAN SIP clients cannot reach.
  ip=""
  if have ip; then
    ip=$(ip -4 -o addr show scope global 2>/dev/null | awk '
      $2 ~ /^(podman|docker|br-|veth|virbr|cni|flannel|tun|tap|wg|ipsec|vti|uk-|nordlynx|tailscale|zerotier|zt|ppp)/ { next }
      $2 == "lo" { next }
      {
        split($4, a, "/")
        addr = a[1]
        if (addr ~ /^127\./ || addr ~ /^169\.254\./ || addr ~ /^172\.17\./ || addr ~ /^10\.88\./) next
        print addr
        exit
      }')
  fi
  if [ -z "$ip" ] && have hostname; then
    ip=$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^192\.168\.' | head -n1)
  fi
  if [ -z "$ip" ] && have hostname; then
    ip=$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.' \
      | grep -Ev '^(127\.|169\.254\.|172\.17\.|10\.88\.)' | head -n1)
  fi
  if [ -z "$ip" ] && have ip; then
    ip=$(ip route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -n1)
  fi
  printf '%s' "$ip"
}

# Detect the host package manager and install the given packages.
pkg_install() {
  if   have apt-get; then as_root apt-get update -qq && as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y "$@"
  elif have dnf;     then as_root dnf install -y "$@"
  elif have yum;     then as_root yum install -y "$@"
  elif have pacman;  then as_root pacman -Sy --noconfirm "$@"
  elif have zypper;  then as_root zypper install -y "$@"
  elif have apk;     then as_root apk add --no-cache "$@"
  else die "no supported package manager found (apt/dnf/yum/pacman/zypper/apk)"
  fi
}

svc_enable_start() {
  # Enable+start a system service across init systems (best-effort).
  if have systemctl; then as_root systemctl enable --now "$1" 2>/dev/null || as_root systemctl start "$1" 2>/dev/null || true
  elif have rc-update; then as_root rc-update add "$1" default 2>/dev/null || true; as_root rc-service "$1" start 2>/dev/null || true
  elif have service; then as_root service "$1" start 2>/dev/null || true
  fi
}

# Ensure pcscd is running AND set to start on boot. pcscd ships differently across distros:
# some socket-activate it (pcscd.socket starts the daemon on first client), some don't enable
# it at all (seen on Armbian) — so a plain `systemctl enable --now pcscd` may leave it stopped
# and not persistent. We enable both the socket and the service, start the daemon now, and
# verify it actually came up (falling back to a manual daemon launch if the units don't exist).
enable_pcscd_autostart() {
  if have systemctl; then
    # Enable the socket (on-boot autostart, incl. socket-activated setups) and the service.
    as_root systemctl enable pcscd.socket 2>/dev/null || true
    as_root systemctl enable pcscd.service 2>/dev/null || as_root systemctl enable pcscd 2>/dev/null || true
    # Start now: the socket triggers the daemon on first use; also start the service directly
    # for distros where the service isn't socket-activated.
    as_root systemctl start pcscd.socket 2>/dev/null || true
    as_root systemctl start pcscd.service 2>/dev/null || as_root systemctl start pcscd 2>/dev/null || true
    # Verify. If neither the daemon nor its socket is present, force the service up once.
    if ! systemctl is-active --quiet pcscd 2>/dev/null && [ ! -S /run/pcscd/pcscd.comm ]; then
      as_root systemctl restart pcscd.service 2>/dev/null || as_root systemctl restart pcscd 2>/dev/null || true
    fi
  else
    svc_enable_start pcscd
  fi
  # Last-resort: if systemd units are absent/broken but the binary exists, launch it detached so
  # the reader is usable this session (autostart on non-systemd hosts is best-effort).
  if [ ! -S /run/pcscd/pcscd.comm ] && have pcscd && ! pgrep -x pcscd >/dev/null 2>&1; then
    as_root mkdir -p /run/pcscd
    as_root pcscd 2>/dev/null || true   # daemonizes by default; harmless if a unit already owns it
  fi
}

data_dir_abs() { CDPATH= cd -- "$VOWIFI_DATA_DIR" 2>/dev/null && pwd -P || printf '%s' "$VOWIFI_DATA_DIR"; }

installed() { [ -f "$USER_UNIT" ]; }

# True (0) if the control plane is currently running.
control_running() { have systemctl && systemctl --user is-active --quiet vowifi-control; }

engine_names() { podman ps -a --format '{{.Names}}' 2>/dev/null | grep "^${ENGINE_PREFIX}" || true; }

# ------------------------------------------------------------------ prerequisites
# Distro pcscd builds (Fedora, Debian, Arch…) authorise clients via polkit: only root and
# processes in an ACTIVE local login session may talk to the reader. The control plane
# (systemd --user service, started at boot via lingering) and its engines (container root =
# this user on the host) are in no session, so pcscd answers "Access denied" (0x8010006A,
# "NOT authorized for action: access_pcsc"). Grant exactly this user the two pcsc-lite actions.
# Not needed for our source-built pcscd (-Dpolkit=false), harmless there.
PCSC_POLKIT_RULE=/etc/polkit-1/rules.d/50-vowifi-pcsc.rules
ensure_pcsc_polkit_rule() {
  [ -d /etc/polkit-1/rules.d ] || return 0
  rule=$(cat <<EOF
// Installed by vowifi_gateway install.sh: let the gateway user (control plane +
// rootless engine containers, which run outside any login session) use the PC/SC reader.
polkit.addRule(function(action, subject) {
  if ((action.id == "org.debian.pcsc-lite.access_pcsc" ||
       action.id == "org.debian.pcsc-lite.access_card") && subject.user == "$1") {
    return polkit.Result.YES;
  }
});
EOF
)
  if [ "$(cat "$PCSC_POLKIT_RULE" 2>/dev/null)" != "$rule" ]; then
    info "allowing $1 to use the PC/SC reader outside a login session (polkit rule $PCSC_POLKIT_RULE)"
    printf '%s\n' "$rule" | as_root tee "$PCSC_POLKIT_RULE" >/dev/null
  fi
}

# version_ge A B: true if dotted version A >= B (major.minor compare is all we need).
version_ge() {
  a1=${1%%.*}; a2=${1#*.}; a2=${a2%%.*}
  b1=${2%%.*}; b2=${2#*.}; b2=${b2%%.*}
  [ "$a1" -gt "$b1" ] 2>/dev/null && return 0
  [ "$a1" -eq "$b1" ] 2>/dev/null && [ "$a2" -ge "$b2" ] 2>/dev/null
}

# Rootless Podman + the one-time host bits it needs. The containers themselves never get root:
# NET_ADMIN, the ipsec0 tun device, routes and net.* sysctls all live in each engine's own
# network namespace, owned by this user's user namespace.
ensure_podman() {
  have podman || { info "installing Podman…"; pkg_install podman; }
  # pasta (from the passt package) is rootless podman's network: it preserves client source
  # addresses (SIP needs them) and forwards published ports without a root-owned bridge.
  have pasta || { info "installing passt (pasta networking for rootless podman)…"; pkg_install passt; }
  have pasta || die "pasta not found after installing passt"
  pv=$(podman version --format '{{.Client.Version}}' 2>/dev/null || podman --version | awk '{print $3}')
  version_ge "$pv" "$PODMAN_MIN" \
    || die "needs podman >= $PODMAN_MIN (found $pv): older pasta setups can't reach host.containers.internal"
  grep -q "^${ME}:" /etc/subuid 2>/dev/null && grep -q "^${ME}:" /etc/subgid 2>/dev/null || {
    err "no subordinate UID/GID range for $ME (needed by rootless podman). Add one, then re-run:"
    printf '\n  sudo usermod --add-subuids 100000-165535 --add-subgids 100000-165535 %s\n  podman system migrate\n\n' "$ME" >&2
    exit 1
  }
  [ -c /dev/net/tun ] || as_root modprobe tun 2>/dev/null || true
  [ -c /dev/net/tun ] || die "/dev/net/tun missing — the engine's SWu tunnel needs the tun module"
  # Published SIP/WebUI ports must be bindable by an unprivileged user.
  ups=$(cat /proc/sys/net/ipv4/ip_unprivileged_port_start 2>/dev/null || echo 1024)
  [ "$ups" -le 5060 ] && [ "$ups" -le "$VOWIFI_PORT" ] \
    || die "net.ipv4.ip_unprivileged_port_start=$ups blocks the SIP/WebUI ports for a normal user"
  [ -n "${XDG_RUNTIME_DIR:-}" ] || die "XDG_RUNTIME_DIR is not set — run from a real login session (ssh/console), not su/sudo"
  podman info >/dev/null 2>&1 || die "rootless podman is not working (podman info failed)"
  # Docker-compatible API socket the control plane drives engines through (socket-activated),
  # and the unit that restarts restart=always containers when the user manager starts.
  systemctl --user enable --now podman.socket >/dev/null 2>&1 || warn "could not enable the user podman.socket"
  systemctl --user enable podman-restart.service >/dev/null 2>&1 || warn "could not enable the user podman-restart.service (engines won't autostart on boot)"
  ensure_linger
  [ -S "$XDG_RUNTIME_DIR/podman/podman.sock" ] || die "user Podman API socket missing ($XDG_RUNTIME_DIR/podman/podman.sock)"
  info "rootless Podman ready ($pv, pasta)"
}

# Without lingering the user's systemd (so the control plane + engines) only runs while logged in.
linger_on() { [ "$(loginctl show-user "$ME" -p Linger --value 2>/dev/null)" = yes ]; }
ensure_linger() {
  linger_on && return 0
  info "enabling lingering for $ME so the gateway starts at boot without a login…"
  as_root loginctl enable-linger "$ME" || warn "could not enable lingering — the gateway stops when you log out"
}

# Migrate an install made by an older, ROOTFUL version of this script: its system unit and root's
# vowifi containers (engines, or the privileged control container of the old "container" mode)
# would hold the WebUI/SIP ports, and its ./data, venv and webui/dist are root-owned.
migrate_legacy_rootful() {
  legacy=0
  [ -f "$LEGACY_SYSTEM_UNIT" ] && legacy=1
  root_ctrs=$(as_root podman ps -a --format '{{.Names}}' 2>/dev/null | grep '^vowifi-' || true)
  [ -n "$root_ctrs" ] && legacy=1
  if [ "$legacy" = 1 ]; then
    warn "removing the previous rootful install (system unit + root's vowifi containers); data is kept"
    # Engines owe their uptime to restart=always, and the manager never starts lines on its own,
    # so remember which ones were RUNNING (stopped/frozen lines stay stopped) and start them again
    # through the manager once it is up (restore_migrated_engines). Kept in a file so a failed
    # install that is re-run still restores them.
    running=$(as_root podman ps --filter status=running --format '{{.Names}}' 2>/dev/null \
      | sed -n "s/^${ENGINE_PREFIX}//p" || true)
    [ -n "$running" ] && MIGRATE_RESTART_IDS="$running"
    if [ -f "$LEGACY_SYSTEM_UNIT" ]; then
      as_root systemctl disable --now vowifi-control >/dev/null 2>&1 || true
      as_root rm -f "$LEGACY_SYSTEM_UNIT"
      as_root systemctl daemon-reload 2>/dev/null || true
    fi
    for n in $root_ctrs; do as_root podman rm -f "$n" >/dev/null 2>&1 || true; done
    as_root podman rmi -f "$LEGACY_CONTROL_IMAGE" >/dev/null 2>&1 || true
  fi
  # Root's engine image is stale for rootless use (see ensure_engine_image); just free the space.
  if as_root podman image exists "$ENGINE_IMAGE" >/dev/null 2>&1; then
    info "removing root's old engine image — the rootless one is rebuilt from the current sources"
    as_root podman rmi -f "$ENGINE_IMAGE" >/dev/null 2>&1 || true
  fi
  for d in "$VOWIFI_DATA_DIR" "$LEGACY_VENV_DIR" "$REPO_DIR/control/target" "$REPO_DIR/control/bin"; do
    if [ -d "$d" ] && [ -n "$(find "$d" ! -user "$ME" -print -quit 2>/dev/null)" ]; then
      info "handing $d to $ME"
      as_root chown -R "$(id -u):$(id -g)" "$d"
    fi
  done
  [ -d "$WEBUI_DIST" ] && [ "$(stat -c %u "$WEBUI_DIST")" != "$(id -u)" ] && rm_tree "$WEBUI_DIST"
  # State files of the removed deploy-mode switch.
  rm -f "$VOWIFI_DATA_DIR/install-mode" "$VOWIFI_DATA_DIR/install-rootless" 2>/dev/null || true
  if [ -n "${MIGRATE_RESTART_IDS:-}" ]; then
    mkdir -p "$VOWIFI_DATA_DIR"
    printf '%s\n' $MIGRATE_RESTART_IDS >> "$MIGRATE_RESTART_FILE"
  fi
}

# Start the lines that were running under the old rootful install, through the manager's normal
# Start path (/api/instances/<id>/start: PIN preflight, card-identity check, reader rebind) — never
# by recreating containers behind its back. A line the preflight refuses (PIN needed, card gone)
# is reported and left for the user to start from the WebUI. The API sits behind the WebUI login:
# `vowifi-control session-token` signs a 2-minute session with the key in the data dir (0600,
# readable only by you), minted fresh for each request.
restore_migrated_engines() {
  [ -s "$MIGRATE_RESTART_FILE" ] || return 0
  case "$VOWIFI_BIND" in 0.0.0.0|::|'') host=127.0.0.1 ;; *:*) host="[$VOWIFI_BIND]" ;; *) host=$VOWIFI_BIND ;; esac
  base="https://$host:$VOWIFI_PORT"
  info "restarting the lines that were running before the migration…"
  tok() { VOWIFI_DATA="$(data_dir_abs)" "$CONTROL_BIN" session-token 2>/dev/null; }
  waited=0
  until curl -skf -o /dev/null --max-time 5 -b "vowifi_session=$(tok)" "$base/api/instances"; do
    waited=$((waited + 2))
    if [ "$waited" -ge 90 ]; then
      warn "manager not reachable at $base — kept $MIGRATE_RESTART_FILE; the next './install.sh install' retries"
      return 0
    fi
    sleep 2
  done
  for iid in $(awk 'NF && !seen[$0]++' "$MIGRATE_RESTART_FILE"); do
    out=$(curl -sk --max-time 120 -w '\n%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' \
          -b "vowifi_session=$(tok)" "$base/api/instances/$iid/start" 2>&1) || true
    code=$(printf '%s\n' "$out" | tail -n 1)
    body=$(printf '%s\n' "$out" | sed '$d' | head -c 200)
    case "$code" in
      2??) printf '   %s: started\n' "$iid" ;;
      404) printf '   %s: no longer configured — skipped\n' "$iid" ;;
      *)   printf '!! %s: not started (%s %s) — start it from the WebUI\n' "$iid" "$code" "$body" ;;
    esac
  done
  # Every line was attempted (or reported) once — don't repeat it on later installs.
  rm -f "$MIGRATE_RESTART_FILE"
}

ensure_pcscd() {
  # We PIN pcsc-lite to $PCSC_VERSION everywhere (host pcscd + container client libs) so the
  # PC/SC client/server protocol always matches — distro-default versions differ and cause
  # "Failed to establish context" between a client and the host daemon. The reader is owned by
  # the HOST pcscd; the control plane and the engine containers are its clients over /run/pcscd.
  installed_ver=""
  if have pcscd; then installed_ver=$(pcscd --version 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1); fi

  # pcsc-lite's meson defaults to systemdunit=user, so builds by older versions of this script
  # installed only per-user units: nothing started pcscd as root at boot and the reader vanished
  # after a reboot. A matching version without a system unit is such a build — redo it.
  missing_unit=0
  if [ "$installed_ver" = "$PCSC_VERSION" ] && have systemctl \
     && ! systemctl cat pcscd.socket >/dev/null 2>&1; then
    missing_unit=1
  fi

  if [ "$installed_ver" = "$PCSC_VERSION" ] && [ "$missing_unit" = 0 ]; then
    info "host pcscd already at pinned version $PCSC_VERSION"
    PCSC_SOURCE_BUILT=0
  else
    # Install the CCID USB driver from the distro (its IFDHandler ABI is stable across pcscd
    # 2.x, so the distro driver works with our source-built pcscd), plus build deps.
    if [ "$missing_unit" = 1 ]; then
      info "host pcscd $PCSC_VERSION has no system unit (won't start on boot) — rebuilding…"
    else
      info "host pcscd is '${installed_ver:-none}', pinning to $PCSC_VERSION (building from source)…"
    fi
    if   have apt-get; then
      # Debian 13+/Ubuntu 24.04+ moved systemd.pc (meson's "systemd" dependency) out of the
      # systemd package into systemd-dev; older releases don't have that package at all.
      systemd_dev=""
      apt-cache show systemd-dev >/dev/null 2>&1 && systemd_dev=systemd-dev
      pkg_install libccid libudev-dev libsystemd-dev $systemd_dev meson ninja-build flex pkg-config gcc wget ca-certificates
    elif have dnf || have yum; then pkg_install ccid systemd-devel meson ninja-build flex pkgconf-pkg-config gcc perl-podlators wget
    elif have pacman;  then pkg_install ccid meson ninja flex pkgconf gcc wget
    elif have zypper;  then pkg_install pcsc-ccid systemd-devel meson ninja flex pkg-config gcc wget
    else pkg_install ccid meson ninja flex gcc wget
    fi
    _build_pcsclite_host
    PCSC_SOURCE_BUILT=1
  fi
  enable_pcscd_autostart
  # pcscd may be socket-activated (daemon starts on first client), so the socket can be absent
  # until a reader is used — that's fine. If it IS present, confirm; else just note it.
  if [ -S /run/pcscd/pcscd.comm ] || { have systemctl && systemctl is-active --quiet pcscd 2>/dev/null; }; then
    info "host pcscd running + set to start on boot"
  else
    warn "pcscd not active yet — it is enabled for boot and will start on first reader use"
  fi
}

# Build + install the CCID USB driver $CCID_VERSION from source with a chosen SET of the
# fixes under patches/ccid/* applied. Args: $1 = short set label (used for the idempotency
# marker + logs), remaining args = patch filenames (under patches/ccid/) to apply in order.
# Patch sets (see the `patch*` subcommands):
#   01_hsic_slot_status.patch   HSIC 1d99:0016 broken GetSlotStatus — firmware always reports
#                               "no ICC present". NotifySlotChange sets pending; IFDHICCPresence
#                               tick probes via IccPowerOn/ATR (debounced). Base fix; safe for all cards.
#   02_hsic_malformed_atr.patch HSIC firmware drops the final TCK byte from the ATR; this
#                               patch synthesizes it at power-on (ISO 7816-3 XOR) and falls back
#                               to relaxed validation if repair fails. Fixes SCardConnect 607
#                               for (U)SIMs that work on other readers.
# The build installs into the pcsc-lite usbdropdir, replacing the distro libccid bundle files.
# Idempotent via a per-set marker file (switching sets rebuilds); on apt systems the distro
# libccid package is held so an upgrade can't clobber the patched driver.
# OPT-IN: not part of `install` — run `./install.sh patch | patch2 | patchall`.
ensure_ccid_host() {
  set_label="$1"; shift
  ccid_patches="$*"
  drivers_dir=$(pkg-config libpcsclite --variable usbdropdir 2>/dev/null || true)
  [ -n "$drivers_dir" ] || drivers_dir=/usr/lib/pcsc/drivers
  ccid_marker="$drivers_dir/ifd-ccid.bundle/Contents/.vowifi-ccid-${CCID_VERSION}-${set_label}"
  if [ -f "$ccid_marker" ]; then
    info "patched CCID driver $CCID_VERSION (set: $set_label) already installed ($drivers_dir)"
    return
  fi
  info "building CCID driver $CCID_VERSION from source — patch set '$set_label' ($ccid_patches)…"
  if   have apt-get; then
    pkg_install meson ninja-build flex gcc pkg-config perl patch wget ca-certificates libusb-1.0-0-dev zlib1g-dev
    [ -f /usr/include/PCSC/pcsclite.h ] || pkg_install libpcsclite-dev
  elif have dnf || have yum; then
    pkg_install meson ninja-build flex gcc pkgconf-pkg-config perl patch wget libusb1-devel zlib-devel
    [ -f /usr/include/PCSC/pcsclite.h ] || pkg_install pcsc-lite-devel
  elif have pacman;  then
    pkg_install meson ninja flex gcc pkgconf perl patch wget libusb zlib
  elif have zypper;  then
    pkg_install meson ninja flex gcc pkg-config perl patch wget libusb-1_0-devel zlib-devel
    [ -f /usr/include/PCSC/pcsclite.h ] || pkg_install pcsc-lite-devel
  elif have apk;     then
    pkg_install meson ninja flex gcc pkgconfig perl patch wget musl-dev libusb-dev zlib-dev
    [ -f /usr/include/PCSC/pcsclite.h ] || pkg_install pcsc-lite-dev
  fi
  tmp=$(mktemp -d)
  ( cd "$tmp" \
    && { curl -fsSLo ccid.tar.gz "https://github.com/LudovicRousseau/CCID/archive/refs/tags/${CCID_VERSION}.tar.gz" \
         || wget -qO ccid.tar.gz "https://github.com/LudovicRousseau/CCID/archive/refs/tags/${CCID_VERSION}.tar.gz"; } \
    && tar xf ccid.tar.gz && cd "CCID-${CCID_VERSION}" \
    && for p in $ccid_patches; do echo "applying $p"; patch -p1 < "$REPO_DIR/patches/ccid/$p" || exit 1; done \
    && meson setup builddir \
    && ninja -C builddir && as_root ninja -C builddir install \
  ) || die "failed to build CCID driver $CCID_VERSION from source"
  rm_tree "$tmp"   # `ninja install` ran as root and left root-owned files in builddir
  # drop any other-set markers so `status`/idempotency reflect the set just installed
  as_root sh -c 'rm -f "$1"/.vowifi-ccid-"$2"-*' _ "$drivers_dir/ifd-ccid.bundle/Contents" "$CCID_VERSION" 2>/dev/null || true
  as_root touch "$ccid_marker" 2>/dev/null || true
  # keep a distro libccid upgrade from clobbering the patched bundle files
  if have apt-mark; then as_root apt-mark hold libccid >/dev/null 2>&1 || true; fi
  # reload the driver if pcscd is already running
  if have systemctl; then as_root systemctl restart pcscd 2>/dev/null || true; fi
  info "patched CCID driver $CCID_VERSION (set: $set_label) installed to $drivers_dir"
}

_build_pcsclite_host() {
  # Build + install pcsc-lite $PCSC_VERSION to /usr on the host (client lib + headers + daemon),
  # and install a systemd unit so it runs as the reader daemon. Idempotent.
  tmp=$(mktemp -d)
  ( cd "$tmp" \
    && { curl -fsSLo pcsc.tar.gz "https://github.com/LudovicRousseau/PCSC/archive/refs/tags/${PCSC_VERSION}.tar.gz" \
         || wget -qO pcsc.tar.gz "https://github.com/LudovicRousseau/PCSC/archive/refs/tags/${PCSC_VERSION}.tar.gz"; } \
    && tar xf pcsc.tar.gz && cd "PCSC-${PCSC_VERSION}" \
    && meson setup builddir --prefix=/usr -Dpolkit=false -Dsystemdunit=system \
    && ninja -C builddir && as_root ninja -C builddir install \
  ) || die "failed to build pcsc-lite $PCSC_VERSION from source"
  as_root ldconfig 2>/dev/null || true
  rm_tree "$tmp"   # `ninja install` ran as root and left root-owned files in builddir
  # meson installs pcscd.service + pcscd.socket under /usr/lib/systemd/system (-Dsystemdunit=system).
  # Drop per-user units left by earlier builds (meson's default): a user-session pcscd can't
  # create /run/pcscd and only logs "Permission denied". Keep any a distro package owns.
  for u in /usr/lib/systemd/user/pcscd.socket /usr/lib/systemd/user/pcscd.service; do
    [ -f "$u" ] || continue
    if { have dpkg && dpkg -S "$u" >/dev/null 2>&1; } || { have rpm && rpm -qf "$u" >/dev/null 2>&1; }; then
      continue
    fi
    as_root rm -f "$u"
  done
  if have systemctl; then as_root systemctl daemon-reload 2>/dev/null || true; fi
  info "host pcscd built + installed at $PCSC_VERSION"
}

# ------------------------------------------------------------------ image builds
# Build the engine image ONLY if it is missing, or if forced ($1 non-empty / --no-cache).
# The engine image is large and slow to build (~10-15 min: compiles Asterisk + pcsc-lite + the
# Python SWu tunnel deps), and it bakes every bug-fix patch under engine/patches/* via the
# Containerfile — so an unforced reinstall reuses the existing patched image instead of rebuilding it.
ensure_engine_image() {
  force="${1:-}"
  if [ -z "$force" ] && [ -z "$NOCACHE_FLAG" ] && podman image exists "$ENGINE_IMAGE" >/dev/null 2>&1; then
    info "engine image $ENGINE_IMAGE present — reusing (patches from engine/patches/* are baked in). Use 'reload --engines' or '--no-cache' to force a rebuild."
    return
  fi
  # No shortcut for upgrades from a rootful install: root's old engine image predates the
  # rootless SWu changes (unprivileged IKE/NAT-T source ports, forced NAT-T — without them no
  # tunnel comes up behind pasta) and may carry another pcsc-lite than $PCSC_VERSION, so it is
  # never reused; migrate_legacy_rootful deletes it and this builds from the current sources.
  info "building engine image ($ENGINE_IMAGE) from source — long; compiles Asterisk+pcsc-lite+Python SWu tunnel deps and bakes engine/patches/*…"
  # shellcheck disable=SC2086
  podman build $NOCACHE_FLAG --build-arg "PCSC_VERSION=$PCSC_VERSION" -t "$ENGINE_IMAGE" "$REPO_DIR/engine"
  info "engine image built"
}

# Compile the React WebUI to webui/dist using a throwaway Node container — so the host needs no
# Node/JS toolchain. Builds in an isolated dir inside the container (ignores any host
# node_modules that might be built for another arch), then copies dist back to the host.
build_webui() {
  info "building WebUI (webui/dist) via a throwaway node:22-alpine container (no host Node needed)…"
  # label=disable: the repo checkout isn't labelled for container access on SELinux hosts.
  # --userns=keep-id: the container user is you, so dist/ comes out owned by you.
  podman run --rm --security-opt label=disable --userns=keep-id -e HOME=/tmp \
      -v "$REPO_DIR/webui":/host-webui "$NODE_IMAGE" sh -euc '
    cp -a /host-webui /tmp/build && cd /tmp/build && rm -rf node_modules dist
    npm ci
    npm run build
    rm -rf /host-webui/dist && cp -a /tmp/build/dist /host-webui/dist
  '
  [ -f "$WEBUI_DIST/index.html" ] || die "WebUI build produced no dist/index.html"
  info "WebUI built at $WEBUI_DIST"
}

# ------------------------------------------------------------------ control plane (user service)
# Host packages the control plane BUILD needs: a C toolchain (the Rust linker driver, plus the
# bundled SQLite and ring's assembly), pkg-config + the pcsc-lite client headers the PC/SC crate
# links against (from our source build if we did one, else the distro -dev package, whose
# version already matches the pin since ensure_pcscd aligned it), and curl for rustup. Rust
# itself comes from rustup, per user (ensure_rust): distro toolchains are often older than
# RUST_MIN. At runtime the binary only needs libpcsclite + libpam (both already on the host).
ensure_control_deps() {
  info "installing control-plane build dependencies (C toolchain, pkg-config, pcsc-lite headers, curl)…"
  if   have apt-get; then
    pkg_install gcc libc6-dev pkg-config curl ca-certificates
    if [ "$PCSC_SOURCE_BUILT" = 0 ] && [ ! -f /usr/include/PCSC/pcsclite.h ]; then pkg_install libpcsclite-dev; fi
  elif have dnf || have yum; then
    pkg_install gcc pkgconf-pkg-config curl
    if [ "$PCSC_SOURCE_BUILT" = 0 ] && [ ! -f /usr/include/PCSC/pcsclite.h ]; then pkg_install pcsc-lite-devel; fi
  elif have pacman;  then
    pkg_install gcc pkgconf curl
    if [ "$PCSC_SOURCE_BUILT" = 0 ] && [ ! -f /usr/include/PCSC/pcsclite.h ]; then pkg_install pcsclite; fi
  elif have zypper;  then
    pkg_install gcc pkg-config curl
    if [ "$PCSC_SOURCE_BUILT" = 0 ] && [ ! -f /usr/include/PCSC/pcsclite.h ]; then pkg_install pcsc-lite-devel; fi
  elif have apk;     then
    pkg_install gcc musl-dev pkgconfig curl
    if [ "$PCSC_SOURCE_BUILT" = 0 ] && [ ! -f /usr/include/PCSC/pcsclite.h ]; then pkg_install pcsc-lite-dev; fi
  fi
}

# reload stays root-free, so it can't add packages: an install from before the Rust control plane
# must run `install` once to get the build dependencies.
control_deps_present() {
  { have cc || have gcc; } && have pkg-config && pkg-config --exists libpcsclite
}

# SELinux: has install labelled control/bin bin_t yet? (reload can't run semanage.)
selinux_control_ready() {
  have selinuxenabled && selinuxenabled 2>/dev/null || return 0
  [ -d "$REPO_DIR/control/bin" ] && ls -Zd "$REPO_DIR/control/bin" 2>/dev/null | grep -q ':bin_t:'
}

# Version compare: 0 if $1 >= $2 (dotted numbers; awk, so busybox hosts work too).
version_ge() {
  awk -v a="$1" -v b="$2" 'BEGIN { n = split(a, x, "."); m = split(b, y, ".");
    for (i = 1; i <= (n > m ? n : m); i++) { if (x[i] + 0 > y[i] + 0) exit 0; if (x[i] + 0 < y[i] + 0) exit 1 }
    exit 0 }'
}

# The user's rustup toolchain (installed on first use into ~/.cargo + ~/.rustup, no root, no
# shell-profile edits). Updated when older than RUST_MIN.
ensure_rust() {
  PATH="$CARGO_HOME/bin:$PATH"; export PATH
  if ! have rustup; then
    have curl || die "curl is needed to install the Rust toolchain — run: $0 install"
    info "installing the Rust toolchain for $ME (rustup, into $CARGO_HOME)…"
    tmp=$(mktemp -d)
    curl --proto '=https' --tlsv1.2 -fsSLo "$tmp/rustup-init.sh" https://sh.rustup.rs \
      || die "could not download rustup"
    sh "$tmp/rustup-init.sh" -y --no-modify-path --profile minimal --default-toolchain stable >/dev/null \
      || die "rustup install failed"
    rm -rf "$tmp"
  fi
  rustc_ver=$(rustc --version 2>/dev/null | awk '{print $2}')
  if [ -z "$rustc_ver" ] || ! version_ge "$rustc_ver" "$RUST_MIN"; then
    info "updating the Rust toolchain (have ${rustc_ver:-none}, need >= $RUST_MIN)…"
    rustup toolchain install stable --profile minimal >/dev/null && rustup default stable >/dev/null \
      || die "could not update the Rust toolchain"
  fi
}

# Build the control plane (release) and install it to control/bin. `install` writes a new file,
# so a running service keeps its old binary until run_control restarts it. The first build
# downloads + compiles the crate dependencies (a few minutes; ~15+ on a Raspberry Pi-class board).
build_control() {
  info "building the control plane (cargo build --release; the first build takes a while)…"
  ( cd "$CONTROL_SRC" && cargo build --release --locked ) || die "control plane build failed"
  mkdir -p "$(dirname "$CONTROL_BIN")"
  install -m 0755 "$CONTROL_SRC/target/release/vowifi-control" "$CONTROL_BIN"
  info "control plane built: $CONTROL_BIN"
}

# SELinux (Fedora/RHEL, enforcing): the binary lives in the repo, typically under /home, so it is
# labelled user_home_t — and the service manager may not execute that (status=203/EXEC). A
# persistent fcontext rule labels control/bin as bin_t (survives relabels; the file `install`
# writes there on later builds inherits the directory's label).
SELINUX_CONTROL_FCONTEXT="$REPO_DIR/control/bin(/.*)?"
# The rule earlier versions added for the Python venv.
SELINUX_VENV_FCONTEXT="$LEGACY_VENV_DIR/bin(/.*)?"
selinux_label_control() {
  have selinuxenabled && selinuxenabled 2>/dev/null || return 0
  if ! have semanage; then
    if have dnf || have yum; then pkg_install policycoreutils-python-utils; fi
  fi
  have semanage || { warn "SELinux is enabled but semanage is missing — vowifi-control may fail with 203/EXEC"; return 0; }
  as_root semanage fcontext -a -t bin_t "$SELINUX_CONTROL_FCONTEXT" 2>/dev/null \
    || as_root semanage fcontext -m -t bin_t "$SELINUX_CONTROL_FCONTEXT" 2>/dev/null \
    || warn "could not add SELinux file context for $REPO_DIR/control/bin"
  as_root restorecon -R "$REPO_DIR/control/bin" 2>/dev/null || true
  info "SELinux: labelled $REPO_DIR/control/bin as bin_t"
}

selinux_unlabel_control() {
  have selinuxenabled && selinuxenabled 2>/dev/null && have semanage || return 0
  as_root semanage fcontext -d "$SELINUX_CONTROL_FCONTEXT" 2>/dev/null || true
  as_root semanage fcontext -d "$SELINUX_VENV_FCONTEXT" 2>/dev/null || true
  [ -d "$REPO_DIR/control/bin" ] && as_root restorecon -R "$REPO_DIR/control/bin" 2>/dev/null || true
}

# The Python control plane of earlier versions: its venv goes once the new binary is in place
# (the unit no longer points at it). With root (install) its SELinux rule goes too.
remove_legacy_venv() {
  if [ "${1:-}" = root ] && have selinuxenabled && selinuxenabled 2>/dev/null && have semanage; then
    as_root semanage fcontext -d "$SELINUX_VENV_FCONTEXT" 2>/dev/null || true
  fi
  [ -d "$LEGACY_VENV_DIR" ] || return 0
  info "removing the old Python control-plane venv ($LEGACY_VENV_DIR)"
  rm -rf "$LEGACY_VENV_DIR" 2>/dev/null || warn "could not remove $LEGACY_VENV_DIR"
}

# Write + (re)start the control-plane user unit. It runs ON the host from this checkout, so the
# data paths it hands to engine bind-mounts are real host paths. Engines reach it back over
# host.containers.internal:<port> (podman adds that name to every container's /etc/hosts).
# %t = $XDG_RUNTIME_DIR, where the user's podman.socket lives. A user unit can't order itself
# after system units (pcscd); pcscd is socket-activated, so that's fine.
run_control() {
  have systemctl || die "needs systemd (systemctl not found)"
  mkdir -p "$VOWIFI_DATA_DIR" "$USER_UNIT_DIR"
  DATA_ABS=$(data_dir_abs)
  LAN_IP="$VOWIFI_ADVERTISE_ADDR"
  [ -z "$LAN_IP" ] && LAN_IP=$(detect_lan_ip)
  [ -z "$LAN_IP" ] && warn "could not auto-detect a LAN IP; set VOWIFI_ADVERTISE_ADDR — SIP/WebRTC audio needs a routable host address"
  info "installing systemd user unit $USER_UNIT"
  cat > "$USER_UNIT" <<EOF
[Unit]
Description=VoWiFi Gateway control surface (manager + WebUI)
After=network-online.target podman.socket
Wants=network-online.target podman.socket

[Service]
Type=simple
WorkingDirectory=$REPO_DIR/control
Environment=VOWIFI_DATA=$DATA_ABS
Environment=VOWIFI_WEBUI=$WEBUI_DIST
Environment=VOWIFI_HTTP_PORT=$VOWIFI_PORT
Environment=VOWIFI_BIND=$VOWIFI_BIND
Environment=VOWIFI_ADVERTISE_ADDR=$LAN_IP
Environment=VOWIFI_ENGINE_IMAGE=$ENGINE_IMAGE
Environment=VOWIFI_MANAGER_URL=https://host.containers.internal:$VOWIFI_PORT
Environment=DOCKER_HOST=unix://%t/podman/podman.sock
Environment=VOWIFI_PCSCD_DIR=/run/pcscd
Environment=RUST_LOG=info
ExecStart=$CONTROL_BIN
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable vowifi-control >/dev/null 2>&1 || true
  systemctl --user restart vowifi-control
  info "started control plane on https://${LAN_IP:-<host>}:${VOWIFI_PORT}"
}

remove_control() {
  have systemctl || return 0
  systemctl --user disable --now vowifi-control >/dev/null 2>&1 || true
  rm -rf "$USER_UNIT" "$USER_UNIT.d"
  systemctl --user daemon-reload 2>/dev/null || true
}

# ------------------------------------------------------------------ subcommands
cmd_install() {
  need_sudo
  info "VoWiFi gateway install — repo: $REPO_DIR (rootless, user $ME)"
  # The engine image compiles pcsc-lite + the Python SWu tunnel deps (and Asterisk, unless the fork's
  # CI published a prebuilt tarball for ASTERISK_REF) from source. On low-power ARM boards
  # (Raspberry Pi, Armbian SBCs) this first build can take 20-30 minutes — only once, since later
  # installs reuse the built image. Warn up front so a long, quiet build isn't mistaken for a hang.
  if ! podman image exists "$ENGINE_IMAGE" 2>/dev/null; then
    warn "the engine image builds from source (pcsc-lite + SWu tunnel deps; Asterisk too if no prebuilt"
    warn "tarball exists for ASTERISK_REF). On low-power ARM machines a full build can take 20-30 minutes —"
    warn "this is normal, please be patient. It runs only once; later installs/reloads reuse the image."
  fi
  ensure_podman
  migrate_legacy_rootful
  ensure_pcscd
  ensure_pcsc_polkit_rule "$ME"
  ensure_firewall
  ensure_engine_image
  build_webui
  ensure_control_deps
  ensure_rust
  build_control
  selinux_label_control
  run_control
  remove_legacy_venv root
  restore_migrated_engines
  DATA_ABS=$(data_dir_abs)
  LAN_IP="${VOWIFI_ADVERTISE_ADDR:-$(detect_lan_ip)}"
  printf '\n'
  info "install complete"
  printf '   %sWebUI:%s   https://%s:%s\n' "$B" "$N" "${LAN_IP:-<host-ip>}" "$VOWIFI_PORT"
  printf '   %sData:%s    %s\n' "$B" "$N" "$DATA_ABS"
  printf '   %sControl:%s systemd --user service vowifi-control; engines in your rootless Podman\n' "$B" "$N"
  printf '   %sManage:%s  %s status | logs | reload | disable-autostart | uninstall\n' "$B" "$N" "$0"
  printf '   Accept the self-signed cert in your browser, then provision your SIM in the dashboard.\n'
}

# Rebuild + restart from the checkout. No root: system packages, pcscd, polkit, firewall and the
# SELinux file context were set up by install (a rebuilt control/bin file inherits its bin_t label).
cmd_reload() {
  installed || die "not installed yet — run: $0 install"
  RECREATE_ENGINES=0
  for a in $ARGS; do [ "$a" = "--engines" ] && RECREATE_ENGINES=1; done
  info "reload"
  # Engine image: only rebuilt on --engines or --no-cache (otherwise reuse the patched image).
  if [ "$RECREATE_ENGINES" = 1 ] || [ -n "$NOCACHE_FLAG" ]; then
    ensure_engine_image force
  else
    ensure_engine_image
  fi
  build_webui
  { control_deps_present && selinux_control_ready; } \
    || die "the control plane is now built from Rust: run '$0 install' once (it asks sudo for the build packages and the SELinux label); the running control plane was left untouched"
  ensure_rust
  build_control
  run_control
  remove_legacy_venv
  if [ "$RECREATE_ENGINES" = 1 ]; then
    warn "engines will be re-created by the control plane on next start/provision (image updated)"
    for n in $(engine_names); do podman rm -f "$n" >/dev/null 2>&1 || true; done
  fi
  info "reload complete (data preserved)"
}

cmd_start() {
  systemctl --user start vowifi-control && info "control plane started" || warn "could not start vowifi-control"
}

cmd_stop() {
  systemctl --user stop vowifi-control && info "control plane stopped" || warn "could not stop vowifi-control"
  info "note: engine containers keep running; the control plane just stops managing them until restarted"
}

cmd_restart() {
  systemctl --user restart vowifi-control && info "control plane restarted" || warn "could not restart vowifi-control"
}

cmd_enable_autostart() {
  systemctl --user enable vowifi-control >/dev/null 2>&1 && info "control autostart ON" || warn "systemd user unit not found"
  for n in $(engine_names); do podman update --restart always "$n" >/dev/null 2>&1 || true; done
  systemctl --user enable podman-restart.service >/dev/null 2>&1 || true
  linger_on || warn "lingering is off: user services only start once you log in. Fix: sudo loginctl enable-linger $ME"
}

cmd_disable_autostart() {
  systemctl --user disable vowifi-control >/dev/null 2>&1 && info "control autostart OFF" || warn "systemd user unit not found"
  for n in $(engine_names); do podman update --restart no "$n" >/dev/null 2>&1 || true; done
  info "note: already-running components keep running until stopped or the host reboots"
}

cmd_uninstall() {
  need_sudo
  PURGE=0
  for a in $ARGS; do [ "$a" = "--purge" ] && PURGE=1; done
  info "uninstalling…"
  remove_control
  selinux_unlabel_control
  [ -f "$PCSC_POLKIT_RULE" ] && as_root rm -f "$PCSC_POLKIT_RULE"
  remove_firewall
  info "removing vowifi containers…"
  for n in $(engine_names); do podman rm -f "$n" >/dev/null 2>&1 || true; done
  if [ "$PURGE" = 1 ]; then
    # Full teardown: also drop the (slow, patched) engine image, data and the control build.
    info "removing the engine image…"
    podman rmi -f "$ENGINE_IMAGE" >/dev/null 2>&1 || true
    warn "purging data dir: $(data_dir_abs) and the control build (control/target, control/bin)"
    # Files an engine wrote as a non-root container user belong to a subordinate UID;
    # `podman unshare` deletes them inside the user namespace without root.
    rm -rf "$REPO_DIR/control/target" "$REPO_DIR/control/bin" "$LEGACY_VENV_DIR" 2>/dev/null || true
    rm -rf "$VOWIFI_DATA_DIR" 2>/dev/null || podman unshare rm -rf "$VOWIFI_DATA_DIR"
  else
    # Keep the ~15-20 min patched engine image so a reinstall reuses it. Data + build are kept too.
    info "data kept at $(data_dir_abs); engine image + control build preserved (use --purge to delete all). Podman, pcscd and lingering left as they are."
  fi
  info "uninstall complete"
}

# ------------------------------------------------------------------ host firewall (firewalld)
# The WebUI on $VOWIFI_PORT and every port an engine publishes through pasta are plain host
# sockets of this user, so firewalld drops them unless allowed.
# We define one firewalld service, "vowifi" (the exact ports, nothing in between), and allow it
# through a rich rule that ALSO matches the LAN subnet as source, in the zone the host's LAN
# traffic lands in (a zone bound to the LAN subnet as a source wins over the interface's zone).
# The source match matters: a zone is not "the LAN" — on hosts where the LAN and WAN interfaces
# share a zone (often `public`, the default zone) a bare --add-service would open the gateway to
# every source on every interface in it. Every run first strips the service / our rules from ALL
# zones, so changing the zone or subnet leaves nothing open in the old one.
# Port blocks follow control/src/config.rs (PORT_BASE + index*PORT_STRIDE, RTP_SPAN 60) and the
# protocols engine.py publishes, for up to VOWIFI_FW_INSTANCES SIMs. AMI (5038+) stays closed:
# the manager reaches it over loopback.
VOWIFI_FW_INSTANCES="${VOWIFI_FW_INSTANCES:-10}"
FW_SERVICE=vowifi
# WebUI port only, for the opt-in IPv6 rule (VOWIFI_FW_WEBUI_SOURCE6). A separate service so the
# IPv6 rule never opens SIP/RTP, and a changed VOWIFI_PORT leaves no stale port rule behind.
FW_WEBUI_SERVICE=vowifi-webui
VOWIFI_FW_WEBUI_SOURCE6="${VOWIFI_FW_WEBUI_SOURCE6:-}"

# IPv4 subnet of the LAN (the on-link route of the interface carrying the advertised address),
# or VOWIFI_FW_SOURCE. Empty if it can't be determined.
fw_lan_source() {
  [ -n "${VOWIFI_FW_SOURCE:-}" ] && { printf '%s' "$VOWIFI_FW_SOURCE"; return; }
  lan_ip="${VOWIFI_ADVERTISE_ADDR:-$(detect_lan_ip)}"
  lan_if=$(ip -4 -o addr show 2>/dev/null | awk -v ip="$lan_ip" '{split($4,a,"/"); if (a[1]==ip) {print $2; exit}}')
  [ -n "$lan_if" ] || return 0
  ip -4 -o route show dev "$lan_if" scope link 2>/dev/null | awk '{print $1; exit}'
}

# Zone that LAN clients' packets are classified into: one with the LAN subnet ($1) as a source,
# else the zone of the interface on that subnet, else the default zone. Override: VOWIFI_FW_ZONE.
fw_lan_zone() {
  [ -n "${VOWIFI_FW_ZONE:-}" ] && { printf '%s' "$VOWIFI_FW_ZONE"; return; }
  lan_net="$1"
  if [ -n "$lan_net" ]; then
    z=$(as_root firewall-cmd --get-zone-of-source="$lan_net" 2>/dev/null) && [ -n "$z" ] && { printf '%s' "$z"; return; }
    lan_if=$(ip -4 -o route show "$lan_net" scope link 2>/dev/null | awk '{for (i=1;i<NF;i++) if ($i=="dev") {print $(i+1); exit}}')
    if [ -n "$lan_if" ]; then
      z=$(as_root firewall-cmd --get-zone-of-interface="$lan_if" 2>/dev/null) && [ -n "$z" ] && { printf '%s' "$z"; return; }
    fi
  fi
  as_root firewall-cmd --get-default-zone
}

# Zone that inbound IPv6 from outside lands in: the zone of the IPv6 default-route interface,
# else the default zone. Override: VOWIFI_FW_ZONE6.
fw_wan6_zone() {
  [ -n "${VOWIFI_FW_ZONE6:-}" ] && { printf '%s' "$VOWIFI_FW_ZONE6"; return; }
  wan_if=$(ip -6 route show default 2>/dev/null | awk '{for (i=1;i<NF;i++) if ($i=="dev") {print $(i+1); exit}}')
  if [ -n "$wan_if" ]; then
    z=$(as_root firewall-cmd --get-zone-of-interface="$wan_if" 2>/dev/null) && [ -n "$z" ] && { printf '%s' "$z"; return; }
  fi
  as_root firewall-cmd --get-default-zone
}

# Remove our services and every rich rule referencing them from all permanent zones.
fw_clear_zones() {
  for z in $(as_root firewall-cmd --permanent --get-zones 2>/dev/null); do
    for svc in "$FW_SERVICE" "$FW_WEBUI_SERVICE"; do
      as_root firewall-cmd --permanent --zone="$z" --remove-service="$svc" >/dev/null 2>&1 || true
      as_root firewall-cmd --permanent --zone="$z" --list-rich-rules 2>/dev/null \
        | grep -F "service name=\"$svc\"" \
        | while IFS= read -r rule; do
            as_root firewall-cmd --permanent --zone="$z" --remove-rich-rule="$rule" >/dev/null 2>&1 || true
          done
    done
  done
}

# Opt-in: let VOWIFI_FW_WEBUI_SOURCE6 (IPv6 prefixes, comma/space separated, or "any") reach the
# WebUI port. Nothing else (SIP/WSS/RTP) is opened for IPv6. Called after fw_clear_zones.
fw_webui_ipv6() {
  srcs=$(printf '%s' "$VOWIFI_FW_WEBUI_SOURCE6" | tr ',' ' ')
  if [ -z "$srcs" ]; then
    as_root firewall-cmd --permanent --delete-service="$FW_WEBUI_SERVICE" >/dev/null 2>&1 || true
    return 0
  fi
  if ! as_root firewall-cmd --permanent --info-service="$FW_WEBUI_SERVICE" >/dev/null 2>&1; then
    as_root firewall-cmd --permanent --new-service="$FW_WEBUI_SERVICE" >/dev/null
  fi
  as_root firewall-cmd --permanent --service="$FW_WEBUI_SERVICE" --set-short="VoWiFi gateway WebUI" >/dev/null
  for old in $(as_root firewall-cmd --permanent --service="$FW_WEBUI_SERVICE" --get-ports 2>/dev/null); do
    as_root firewall-cmd --permanent --service="$FW_WEBUI_SERVICE" --remove-port="$old" >/dev/null
  done
  as_root firewall-cmd --permanent --service="$FW_WEBUI_SERVICE" --add-port="$VOWIFI_PORT/tcp" >/dev/null
  zone6=$(fw_wan6_zone)
  for s6 in $srcs; do
    case "$s6" in
      any|::/0)
        rule="rule family=\"ipv6\" service name=\"$FW_WEBUI_SERVICE\" accept"
        warn "firewalld: WebUI port $VOWIFI_PORT/tcp open to ALL IPv6 sources — the login is your Linux" \
          "password, so the whole internet can try it (throttled); keep it strong" ;;
      *:*) rule="rule family=\"ipv6\" source address=\"$s6\" service name=\"$FW_WEBUI_SERVICE\" accept" ;;
      *) die "VOWIFI_FW_WEBUI_SOURCE6: '$s6' is not an IPv6 prefix (or 'any')" ;;
    esac
    as_root firewall-cmd --permanent --zone="$zone6" --add-rich-rule="$rule" >/dev/null
  done
  info "firewalld: WebUI $VOWIFI_PORT/tcp allowed over IPv6 from: $srcs (zone '$zone6')"
}

ensure_firewall() {
  have firewall-cmd && systemctl is-active --quiet firewalld 2>/dev/null || return 0
  n=$VOWIFI_FW_INSTANCES
  if ! as_root firewall-cmd --permanent --info-service="$FW_SERVICE" >/dev/null 2>&1; then
    as_root firewall-cmd --permanent --new-service="$FW_SERVICE" >/dev/null
  fi
  as_root firewall-cmd --permanent --service="$FW_SERVICE" --set-short="VoWiFi gateway" >/dev/null
  as_root firewall-cmd --permanent --service="$FW_SERVICE" \
    --set-description="VoWiFi->SIP gateway: WebUI, SIP UDP/TLS, WebRTC WSS and RTP for $n instances" >/dev/null
  # Replace the port list wholesale so a changed VOWIFI_PORT / instance count leaves nothing stale.
  for old in $(as_root firewall-cmd --permanent --service="$FW_SERVICE" --get-ports 2>/dev/null); do
    as_root firewall-cmd --permanent --service="$FW_SERVICE" --remove-port="$old" >/dev/null
  done
  # Exactly what engine.py publishes per block k — no ranges spanning the gaps between blocks.
  ports="$VOWIFI_PORT/tcp"
  k=0
  while [ "$k" -lt "$n" ]; do
    rtp=$((10000 + 2000 * k))
    ports="$ports $((5060 + 10 * k))/udp $((5061 + 10 * k))/tcp $((8089 + 10 * k))/tcp $rtp-$((rtp + 59))/udp"
    k=$((k + 1))
  done
  for port in $ports; do
    as_root firewall-cmd --permanent --service="$FW_SERVICE" --add-port="$port" >/dev/null
  done
  fw_clear_zones
  fw_webui_ipv6
  src=$(fw_lan_source)
  zone=$(fw_lan_zone "$src")
  if [ -z "$src" ]; then
    as_root firewall-cmd --reload >/dev/null
    warn "firewalld: couldn't determine the LAN subnet — gateway ports NOT opened." \
      "Set VOWIFI_FW_SOURCE=<lan cidr> (e.g. 192.168.1.0/24) and run './install.sh firewall'."
    return 0
  fi
  as_root firewall-cmd --permanent --zone="$zone" \
    --add-rich-rule="rule family=\"ipv4\" source address=\"$src\" service name=\"$FW_SERVICE\" accept" >/dev/null
  as_root firewall-cmd --reload >/dev/null
  last=$((n - 1))
  info "firewalld: service '$FW_SERVICE' allowed from $src only (zone '$zone'): $VOWIFI_PORT/tcp + $n port blocks" \
    "(SIP 5060+10k udp, TLS 5061+10k, WSS 8089+10k, RTP 10000+2000k..+59; k=0..$last)"
}

remove_firewall() {
  have firewall-cmd && systemctl is-active --quiet firewalld 2>/dev/null || return 0
  as_root firewall-cmd --permanent --info-service="$FW_SERVICE" >/dev/null 2>&1 || return 0
  fw_clear_zones
  as_root firewall-cmd --permanent --delete-service="$FW_SERVICE" >/dev/null 2>&1 || true
  as_root firewall-cmd --permanent --delete-service="$FW_WEBUI_SERVICE" >/dev/null 2>&1 || true
  as_root firewall-cmd --reload >/dev/null 2>&1 || true
}

cmd_firewall() {
  need_sudo
  have firewall-cmd && systemctl is-active --quiet firewalld 2>/dev/null || { info "firewalld not active — nothing to do"; return; }
  ensure_firewall
}

cmd_status() {
  printf '%sControl:%s\n' "$B" "$N"
  if have systemctl && installed; then
    systemctl --user is-active vowifi-control >/dev/null 2>&1 \
      && printf '  vowifi-control  %s\n' "$(systemctl --user show -p ActiveState -p SubState --value vowifi-control 2>/dev/null | tr '\n' ' ')" \
      || printf '  vowifi-control  (not running)\n'
  else
    printf '  (not installed)\n'
  fi
  printf '%sEngines:%s\n' "$B" "$N"
  podman ps -a --filter "name=^${ENGINE_PREFIX}" --format '  {{.Names}}  {{.Status}}' 2>/dev/null || true
}

# Opt-in: build + install the patched CCID driver (patches/ccid/*) on the host. Kept out of
# the default install because it replaces the distro libccid — only needed for quirky readers
# (e.g. HSIC 1d99:0016, whose GetSlotStatus always reports "no card").
#   patch     base fix only (01) — HSIC presence detection; safe for every card incl. eSIM.
#   patch2    compatibility fix only (02) — synthesize missing ATR TCK for HSIC reader.
#   patchall  both (01 + 02).
cmd_patch() {
  need_sudo
  ensure_ccid_host slot 01_hsic_slot_status.patch
}

cmd_patch2() {
  need_sudo
  ensure_ccid_host atr 02_hsic_malformed_atr.patch
}

cmd_patchall() {
  need_sudo
  ensure_ccid_host all 01_hsic_slot_status.patch 02_hsic_malformed_atr.patch
}

cmd_build_lpac() {
  # Compile lpac (PC/SC + curl, STANDALONE) into $VOWIFI_DATA_DIR/lpac for the eSIM UI.
  #
  # lpac STANDALONE uses cmake_policy(CMP0177) which needs CMake >= 3.31.
  # Ubuntu 22.04 / Armbian ship 3.22 — we fetch a Kitware binary toolchain into
  # $VOWIFI_DATA_DIR/tools/cmake when needed.
  need_sudo   # build dependencies only
  LPAC_SRC="${LPAC_SRC:-}"
  DEST=""
  CMAKE_MIN=3.31
  CMAKE_FETCH_VER="${CMAKE_FETCH_VER:-3.31.12}"
  # shellcheck disable=SC2086
  set -- $ARGS
  while [ $# -gt 0 ]; do
    case "$1" in
      --lpac-src)
        [ $# -ge 2 ] || die "--lpac-src requires a path"
        LPAC_SRC="$2"; shift 2 ;;
      --dest)
        [ $# -ge 2 ] || die "--dest requires a path"
        DEST="$2"; shift 2 ;;
      *) die "unknown build-lpac arg: $1 (supported: --lpac-src PATH, --dest DIR)" ;;
    esac
  done
  DEST="${DEST:-$VOWIFI_DATA_DIR/lpac}"

  if [ -z "$LPAC_SRC" ]; then
    if [ -d "$REPO_DIR/../lpac" ]; then
      LPAC_SRC=$(CDPATH= cd -- "$REPO_DIR/../lpac" && pwd -P)
    elif [ -d "$REPO_DIR/lpac" ]; then
      LPAC_SRC=$(CDPATH= cd -- "$REPO_DIR/lpac" && pwd -P)
    else
      err "lpac source not found (looked for ../lpac and ./lpac)."
      err "Clone it next to this repo, then re-run:"
      printf '\n  git clone https://github.com/estkme-group/lpac.git ../lpac\n' >&2
      printf '  %s build-lpac\n\n' "$0" >&2
      err "Or point at an existing tree: $0 build-lpac --lpac-src /path/to/lpac"
      exit 1
    fi
  fi
  [ -f "$LPAC_SRC/CMakeLists.txt" ] || die "not an lpac source tree: $LPAC_SRC"

  cmake_version_ok() {
    ver=$("$1" --version 2>/dev/null | head -1 | sed -n 's/.* \([0-9][0-9]*\.[0-9][0-9]*\).*/\1/p')
    [ -n "$ver" ] || return 1
    major=${ver%%.*}
    minor=${ver#*.}; minor=${minor%%.*}
    need_major=${CMAKE_MIN%%.*}
    need_minor=${CMAKE_MIN#*.}; need_minor=${need_minor%%.*}
    if [ "$major" -gt "$need_major" ] 2>/dev/null; then return 0; fi
    if [ "$major" -eq "$need_major" ] && [ "$minor" -ge "$need_minor" ] 2>/dev/null; then return 0; fi
    return 1
  }

  ensure_cmake() {
    if have cmake && cmake_version_ok "$(command -v cmake)"; then
      CMAKE_BIN=$(command -v cmake)
      info "using system cmake $($CMAKE_BIN --version | head -1)"
      return 0
    fi
    TOOLS="$VOWIFI_DATA_DIR/tools"
    CMAKE_HOME="$TOOLS/cmake-$CMAKE_FETCH_VER"
    CMAKE_BIN="$CMAKE_HOME/bin/cmake"
    if [ -x "$CMAKE_BIN" ] && cmake_version_ok "$CMAKE_BIN"; then
      info "using cached Kitware cmake at $CMAKE_BIN"
      export PATH="$CMAKE_HOME/bin:$PATH"
      return 0
    fi
    arch=$(uname -m)
    case "$arch" in
      x86_64|amd64)  cmake_arch=x86_64 ;;
      aarch64|arm64) cmake_arch=aarch64 ;;
      *) die "no Kitware cmake binary for arch=$arch; install cmake >= $CMAKE_MIN manually" ;;
    esac
    url="https://github.com/Kitware/CMake/releases/download/v${CMAKE_FETCH_VER}/cmake-${CMAKE_FETCH_VER}-linux-${cmake_arch}.tar.gz"
    info "system cmake too old (need >= $CMAKE_MIN); fetching Kitware $CMAKE_FETCH_VER ($cmake_arch)"
    mkdir -p "$TOOLS"
    tmp=$(mktemp -d)
    if have curl; then
      curl -fsSL "$url" -o "$tmp/cmake.tgz"
    elif have wget; then
      wget -qO "$tmp/cmake.tgz" "$url"
    else
      pkg_install curl ca-certificates
      curl -fsSL "$url" -o "$tmp/cmake.tgz"
    fi
    tar -xzf "$tmp/cmake.tgz" -C "$tmp"
    rm_tree "$CMAKE_HOME"
    mv "$tmp/cmake-${CMAKE_FETCH_VER}-linux-${cmake_arch}" "$CMAKE_HOME"
    rm -rf "$tmp"
    export PATH="$CMAKE_HOME/bin:$PATH"
    CMAKE_BIN="$CMAKE_HOME/bin/cmake"
    info "installed $("$CMAKE_BIN" --version | head -1) -> $CMAKE_HOME"
  }

  info "building lpac into $DEST (src: $LPAC_SRC)"
  info "ensuring build dependencies"
  if have apt-get; then
    pkg_install build-essential pkg-config libpcsclite-dev libcurl4-openssl-dev git ca-certificates curl
  elif have dnf || have yum; then
    pkg_install gcc make pkgconfig pcsc-lite-devel libcurl-devel git curl
  elif have zypper; then
    pkg_install gcc make pkg-config pcsc-lite-devel libcurl-devel git curl
  elif have pacman; then
    pkg_install gcc make pkgconf pcsclite curl git
  else
    have gcc || die "missing gcc"
    have pkg-config || die "missing pkg-config"
  fi

  ensure_cmake

  BUILD_DIR="$LPAC_SRC/build-vowifi"
  STAGE_DIR=$(mktemp -d)
  # shellcheck disable=SC2064
  trap 'rm_tree "$STAGE_DIR"' EXIT

  info "configuring lpac (STANDALONE, PCSC+curl) in $BUILD_DIR"
  rm_tree "$BUILD_DIR"
  # BUILD_TESTING=OFF: lpac's unit tests need the Criterion library, which we don't install.
  "$CMAKE_BIN" -S "$LPAC_SRC" -B "$BUILD_DIR" \
    -DCMAKE_BUILD_TYPE=Release \
    -DBUILD_TESTING=OFF \
    -DSTANDALONE_MODE=ON \
    -DLPAC_WITH_APDU_PCSC=ON \
    -DLPAC_WITH_HTTP_CURL=ON \
    -DLPAC_WITH_APDU_AT=OFF \
    -DLPAC_WITH_APDU_QMI=OFF \
    -DLPAC_WITH_APDU_QMI_QRTR=OFF \
    -DLPAC_WITH_APDU_UQMI=OFF \
    -DLPAC_WITH_APDU_MBIM=OFF \
    -DLPAC_WITH_APDU_GBINDER=OFF

  info "building"
  "$CMAKE_BIN" --build "$BUILD_DIR" --parallel "$(nproc 2>/dev/null || echo 2)"

  info "installing to staging"
  env DESTDIR="$STAGE_DIR" "$CMAKE_BIN" --install "$BUILD_DIR"

  SRC_BIN="$STAGE_DIR/executables"
  if [ ! -x "$SRC_BIN/lpac" ]; then
    if [ -x "$STAGE_DIR/usr/executables/lpac" ]; then
      SRC_BIN="$STAGE_DIR/usr/executables"
    else
      find "$STAGE_DIR" -type f -name lpac 2>/dev/null || true
      die "lpac binary not found after install under $STAGE_DIR"
    fi
  fi

  info "deploying to $DEST"
  mkdir -p "$(dirname -- "$DEST")"
  rm_tree "$DEST.tmp"
  mkdir -p "$DEST.tmp"
  cp -a "$SRC_BIN/lpac" "$DEST.tmp/lpac"
  [ -d "$SRC_BIN/lib" ] && cp -a "$SRC_BIN/lib" "$DEST.tmp/lib"
  [ -d "$SRC_BIN/driver" ] && cp -a "$SRC_BIN/driver" "$DEST.tmp/driver"
  chmod +x "$DEST.tmp/lpac"
  rm_tree "$DEST"
  mv "$DEST.tmp" "$DEST"

  info "self-check: lpac driver apdu list"
  if ! "$DEST/lpac" driver apdu list >/dev/null; then
    warn "lpac driver apdu list failed (pcscd may be down); binary is installed at $DEST/lpac"
  else
    "$DEST/lpac" version || true
    info "OK: $DEST/lpac"
  fi
  trap - EXIT
  rm_tree "$STAGE_DIR"
}

cmd_logs() {
  have systemctl || die "systemd not available"
  # `|| true` so that Ctrl-C'ing out of a follow (non-zero exit) doesn't abort the caller —
  # matters when invoked from the interactive control menu.
  journalctl --user -fu vowifi-control || true
}

# Log every browser out of the WebUI (rotates the session key; the manager picks it up on its
# next request). Runs as you, no root.
cmd_logout_all() {
  [ -x "$CONTROL_BIN" ] || die "control plane not built ($CONTROL_BIN) — run './install.sh install' first"
  VOWIFI_DATA="$(data_dir_abs)" "$CONTROL_BIN" logout-all
}

# Default action when invoked with no subcommand. Multi-functional:
#   - NOT installed  -> run the installer.
#   - installed      -> offer basic controls. On a TTY this is an interactive menu;
#                       non-interactively it prints status + the command list.
cmd_auto() {
  if ! installed; then
    info "no existing installation detected — installing…"
    cmd_install
    return
  fi
  info "existing installation detected"
  cmd_status
  if [ ! -t 0 ]; then
    printf '\n%sControls:%s %s start | stop | restart | enable-autostart | disable-autostart | reload | logs | uninstall\n' \
      "$B" "$N" "$0"
    return
  fi
  # Interactive control menu.
  autostart_state() { systemctl --user is-enabled --quiet vowifi-control 2>/dev/null && echo on || echo off; }
  while :; do
    control_running && run="running" || run="stopped"
    printf '\n%sVoWiFi control — %s, autostart %s%s\n' "$B" "$run" "$(autostart_state)" "$N"
    printf '  1) %s control plane\n' "$([ "$run" = running ] && echo stop || echo start)"
    printf '  2) restart control plane\n'
    printf '  3) %s autostart\n' "$([ "$(autostart_state)" = on ] && echo disable || echo enable)"
    printf '  4) status\n'
    printf '  5) logs (follow)\n'
    printf '  6) reload (rebuild + restart)\n'
    printf '  7) uninstall\n'
    printf '  q) quit\n'
    printf 'choose: '
    read -r choice || break
    case "$choice" in
      1) [ "$run" = running ] && cmd_stop || cmd_start ;;
      2) cmd_restart ;;
      3) [ "$(autostart_state)" = on ] && cmd_disable_autostart || cmd_enable_autostart ;;
      4) cmd_status ;;
      5) cmd_logs ;;
      6) cmd_reload ;;
      7) cmd_uninstall; break ;;
      q|Q|"") break ;;
      *) warn "unknown choice: $choice" ;;
    esac
  done
}

usage() {
  cat <<EOF
${B}VoWiFi→SIP gateway installer${N}  (run as your normal user, not root/sudo)

  $0                      auto: install if absent, else show status + control menu
  $0 install              build + run (asks sudo for one-time host setup)
  $0 reload [--no-cache] [--engines]   rebuild + restart, keep data (no root)
  $0 start | stop | restart          control-plane lifecycle (systemd --user)
  $0 enable-autostart     start on boot (lingering)
  $0 disable-autostart    do not start on boot
  $0 uninstall [--purge]  remove the service + engines (--purge also deletes image, data and the control build)
  $0 status               show component status
  $0 logs                 follow control-plane logs
  $0 firewall             (re)open the gateway ports to the LAN in firewalld (also done by install)
  $0 logout-all           log every browser out of the WebUI (login = your Linux user + password)
  $0 build-lpac [--lpac-src PATH] [--dest DIR]   compile lpac into data/lpac (local eSIM LPA)
  $0 patch                build + install the CCID driver with the base HSIC fix (01) — opt-in,
                          for the HSIC 1d99:0016 reader (safe for every card, incl. physical eSIM)
  $0 patch2               add only the ATR-compatibility fix (02) for non-compliant (U)SIM ATRs
  $0 patchall             apply both CCID patches (01 + 02); use for SIMs that need the ATR fix

The control plane runs as a systemd --user service of your account; one engine container per
SIM runs in your rootless Podman (pasta networking). pcsc-lite is version-locked ($PCSC_VERSION)
between the host and the engine image.

Env: VOWIFI_PORT(=$VOWIFI_PORT) VOWIFI_DATA_DIR(=$VOWIFI_DATA_DIR) VOWIFI_ADVERTISE_ADDR(auto)
     VOWIFI_BIND(=$VOWIFI_BIND) VOWIFI_FW_INSTANCES(=10) VOWIFI_FW_ZONE(auto) VOWIFI_FW_SOURCE(auto) VOWIFI_FW_WEBUI_SOURCE6(none) VOWIFI_FW_ZONE6(auto) PCSC_VERSION(=$PCSC_VERSION)
EOF
}

# ------------------------------------------------------------------ dispatch
CMD="${1:-}"; [ $# -gt 0 ] && shift || true

# Collect args into ARGS and note --no-cache. The deploy-mode switches of older versions are
# accepted where harmless, and refused with an explanation where they asked for root.
ARGS=""
NOCACHE_FLAG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --mode|--mode=*)
      m="${1#--mode=}"; if [ "$1" = --mode ]; then [ $# -ge 2 ] || die "--mode requires a value"; m="$2"; shift; fi
      [ "$m" = local ] || die "--mode $m was removed: the gateway runs rootless only (the old container mode needed a privileged rootful control container)" ;;
    --rootless) ;;   # the default (and only) mode now
    --rootful)  die "--rootful was removed: the gateway runs rootless only" ;;
    --no-cache) NOCACHE_FLAG="--no-cache"; ARGS="$ARGS $1" ;;
    *)          ARGS="$ARGS $1" ;;
  esac
  shift
done
[ "${VOWIFI_MODE:-local}" = local ] || die "VOWIFI_MODE=$VOWIFI_MODE was removed: the gateway runs rootless only"

case "$CMD" in
  install)            cmd_install ;;
  reload)             cmd_reload ;;
  start)              cmd_start ;;
  stop)               cmd_stop ;;
  restart)            cmd_restart ;;
  enable-autostart)   cmd_enable_autostart ;;
  disable-autostart)  cmd_disable_autostart ;;
  uninstall)          cmd_uninstall ;;
  status)             cmd_status ;;
  logs)               cmd_logs ;;
  firewall)           cmd_firewall ;;
  logout-all)         cmd_logout_all ;;
  build-lpac)         cmd_build_lpac ;;
  patch)              cmd_patch ;;
  patch2)             cmd_patch2 ;;
  patchall)           cmd_patchall ;;
  "")                 cmd_auto ;;
  -h|--help|help)     usage ;;
  *) err "unknown command: $CMD"; usage; exit 1 ;;
esac
