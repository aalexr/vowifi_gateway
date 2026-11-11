"""auth.py - WebUI login with the host's Linux account (PAM), signed session cookies, throttle.

Contract:
  * Login = the Linux user the manager runs as (the systemd --user service owner) and that
    user's Linux password, checked through PAM (libpam via ctypes, no extra dependency). An
    unprivileged process can only verify its OWN account (pam_unix hands the check to the
    setuid unix_chkpwd helper, which refuses other users), so no other account can log in.
    Changing the Linux password (passwd) changes the WebUI login.
  * PAM service: $VOWIFI_PAM_SERVICE, else the first of vowifi / system-auth / login that exists
    in /etc/pam.d or /usr/lib/pam.d. Drop in /etc/pam.d/vowifi to give the WebUI its own stack.
    Both pam_authenticate and pam_acct_mgmt must succeed (locked / expired accounts fail).
    A stack that asks more than one secret (OTP, U2F) is refused: the form has one field.
  * Every /api, /ws and API-docs request needs a valid session cookie, from any source
    (loopback and LAN included). Exceptions: /api/auth/* (login itself; routes there that need a
    session check it themselves) and /api/engine/event, which engines call. Under pasta those
    arrive from one of the host's own addresses, which is what is checked (a remote client can't
    complete a TCP handshake with a spoofed host address).
  * Cookie: HttpOnly, Secure, SameSite=Strict (also the CSRF defence: JSON API + strict cookie),
    30 days, value = base64(json{exp,user}) "." HMAC-SHA256 with a random key kept in
    $VOWIFI_DATA/auth.json (0600). "Log out everywhere" rotates that key. A Linux password change
    does NOT end existing sessions (PAM gives no hook for that); use "log out everywhere".

CLI (run from control/ with VOWIFI_DATA set):
  python -m app.auth logout-all    invalidate every WebUI session
"""
from __future__ import annotations

import base64
import ctypes
import ctypes.util
import hashlib
import hmac
import ipaddress
import json
import logging
import os
import pwd
import secrets
import socket
import threading
import time

from .config import DATA_DIR

log = logging.getLogger("vowifi.auth")

AUTH_PATH = os.path.join(DATA_DIR, "auth.json")
COOKIE_NAME = "vowifi_session"
SESSION_TTL = 30 * 24 * 3600
MAX_PASSWORD_LEN = 1024

_lock = threading.RLock()
_cache: dict = {"mtime": None, "data": {}}


def service_user() -> str:
    """The only account that can log in: the one this process runs as."""
    return pwd.getpwuid(os.geteuid()).pw_name


# ----------------------------------------------------------------- session key storage
def _load() -> dict:
    with _lock:
        try:
            mtime = os.stat(AUTH_PATH).st_mtime_ns
        except FileNotFoundError:
            _rotate_locked()
            return _cache["data"]
        if mtime != _cache["mtime"]:
            try:
                with open(AUTH_PATH) as f:
                    data = json.load(f) or {}
                bytes.fromhex(data["secret"])
            except (OSError, ValueError, KeyError, TypeError) as e:
                # Fail closed: no session validates until the file is fixed or rotated.
                log.error("cannot read %s (%s); no WebUI session is valid until "
                          "'python -m app.auth logout-all' rewrites it", AUTH_PATH, e)
                data = {"secret": None}
            _cache.update(mtime=mtime, data=data)
        return _cache["data"]


def _rotate_locked() -> None:
    os.makedirs(DATA_DIR, exist_ok=True)
    tmp = AUTH_PATH + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump({"secret": secrets.token_hex(32), "rotated": int(time.time())}, f)
    os.replace(tmp, AUTH_PATH)
    _cache.update(mtime=None, data={})
    _load()


def logout_everywhere() -> None:
    with _lock:
        _rotate_locked()
    log.info("WebUI session key rotated: every session logged out")


# ----------------------------------------------------------------- PAM (ctypes)
_PAM_SUCCESS = 0
_PAM_CONV_ERR = 19
_PAM_RHOST = 4
_PAM_PROMPT_ECHO_OFF, _PAM_PROMPT_ECHO_ON = 1, 2


class _PamMessage(ctypes.Structure):
    _fields_ = [("msg_style", ctypes.c_int), ("msg", ctypes.c_char_p)]


class _PamResponse(ctypes.Structure):
    _fields_ = [("resp", ctypes.c_void_p), ("resp_retcode", ctypes.c_int)]


_CONV_FUNC = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_int,
                              ctypes.POINTER(ctypes.POINTER(_PamMessage)),
                              ctypes.POINTER(ctypes.POINTER(_PamResponse)), ctypes.c_void_p)


class _PamConv(ctypes.Structure):
    _fields_ = [("conv", _CONV_FUNC), ("appdata_ptr", ctypes.c_void_p)]


_libs: dict = {}


def _pam_libs():
    if not _libs:
        pam = ctypes.CDLL(ctypes.util.find_library("pam") or "libpam.so.0")
        libc = ctypes.CDLL(ctypes.util.find_library("c") or "libc.so.6")
        pam.pam_start.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.POINTER(_PamConv),
                                  ctypes.POINTER(ctypes.c_void_p)]
        pam.pam_set_item.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p]
        pam.pam_authenticate.argtypes = [ctypes.c_void_p, ctypes.c_int]
        pam.pam_acct_mgmt.argtypes = [ctypes.c_void_p, ctypes.c_int]
        pam.pam_end.argtypes = [ctypes.c_void_p, ctypes.c_int]
        pam.pam_strerror.argtypes = [ctypes.c_void_p, ctypes.c_int]
        pam.pam_strerror.restype = ctypes.c_char_p
        libc.calloc.argtypes = [ctypes.c_size_t, ctypes.c_size_t]
        libc.calloc.restype = ctypes.c_void_p
        libc.strdup.argtypes = [ctypes.c_char_p]
        libc.strdup.restype = ctypes.c_void_p
        _libs.update(pam=pam, libc=libc)
    return _libs["pam"], _libs["libc"]


def pam_service() -> str:
    env = os.environ.get("VOWIFI_PAM_SERVICE", "").strip()
    if env:
        return env
    for name in ("vowifi", "system-auth", "login"):
        if any(os.path.isfile(os.path.join(d, name)) for d in ("/etc/pam.d", "/usr/lib/pam.d")):
            return name
    return "login"


def _pam_check(user: str, password: str, rhost: str | None) -> tuple[bool, str]:
    """(ok, reason). Blocking (pam_unix sleeps ~2 s on failure): call from a thread."""
    pam, libc = _pam_libs()
    secret = password.encode()
    asked = {"secrets": 0}

    def conv(n, msgs, resp, _data):
        # PAM frees the response array and each resp string with free(): allocate with libc.
        arr = libc.calloc(n, ctypes.sizeof(_PamResponse))
        if not arr:
            return _PAM_CONV_ERR
        resp[0] = ctypes.cast(arr, ctypes.POINTER(_PamResponse))
        for i in range(n):
            style = msgs[i].contents.msg_style
            if style == _PAM_PROMPT_ECHO_OFF:
                asked["secrets"] += 1
                if asked["secrets"] > 1:
                    return _PAM_CONV_ERR      # a second secret (OTP...) we can't supply
                resp[0][i].resp = libc.strdup(secret)
            elif style == _PAM_PROMPT_ECHO_ON:
                resp[0][i].resp = libc.strdup(user.encode())
        return _PAM_SUCCESS

    conv_cb = _CONV_FUNC(conv)                # keep a reference for the whole transaction
    handle = ctypes.c_void_p()
    service = pam_service()
    rc = pam.pam_start(service.encode(), user.encode(),
                       ctypes.byref(_PamConv(conv_cb, None)), ctypes.byref(handle))
    if rc != _PAM_SUCCESS:
        return False, f"pam_start({service}) failed: {rc}"
    try:
        if rhost:
            pam.pam_set_item(handle, _PAM_RHOST, ctypes.c_char_p(rhost.encode()))
        rc = pam.pam_authenticate(handle, 0)
        if rc == _PAM_SUCCESS:
            rc = pam.pam_acct_mgmt(handle, 0)
        reason = (pam.pam_strerror(handle, rc) or b"").decode(errors="replace")
        return rc == _PAM_SUCCESS, f"{service}: {reason}"
    finally:
        pam.pam_end(handle, rc)


def check_login(username, password, rhost: str | None = None) -> bool:
    """True if username is this service's own Linux user and password is its Linux password."""
    if not isinstance(username, str) or not isinstance(password, str):
        return False
    # pam_unix is commonly configured `nullok`: never let an empty password through.
    if not password or len(password) > MAX_PASSWORD_LEN or "\0" in password:
        return False
    user = service_user()
    if username.strip() != user:
        time.sleep(2)                         # same cost as a PAM failure
        return False
    try:
        ok, reason = _pam_check(user, password, rhost)
    except OSError as e:
        log.error("PAM unavailable (%s): nobody can log in to the WebUI", e)
        return False
    if not ok:
        log.info("PAM rejected WebUI login (%s)", reason)
    return ok


# ----------------------------------------------------------------- sessions
def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _sign(body: str, secret: str) -> str:
    return _b64(hmac.new(bytes.fromhex(secret), body.encode(), hashlib.sha256).digest())


def new_session(user: str) -> str:
    secret = _load().get("secret")
    if not secret:
        raise RuntimeError("session key unavailable")
    body = _b64(json.dumps({"exp": int(time.time()) + SESSION_TTL, "user": user}).encode())
    return body + "." + _sign(body, secret)


def session_user(token: str | None) -> str | None:
    """The logged-in user for a valid cookie, else None."""
    secret = _load().get("secret")
    if not token or not secret or "." not in token:
        return None
    body, sig = token.rsplit(".", 1)
    try:
        if not hmac.compare_digest(sig, _sign(body, secret)):
            return None
        claims = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
        if int(claims.get("exp", 0)) <= time.time():
            return None
        user = claims.get("user")
        return user if user == service_user() else None
    except (ValueError, TypeError):
        return None


def session_valid(token: str | None) -> bool:
    return session_user(token) is not None


# ----------------------------------------------------------------- source addresses
def _ip(host: str | None):
    try:
        ip = ipaddress.ip_address((host or "").split("%", 1)[0])
    except ValueError:
        return None
    # Dual-stack socket: IPv4 clients appear as ::ffff:a.b.c.d.
    if ip.version == 6 and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return ip


def is_host_address(host: str | None) -> bool:
    """True if `host` is loopback or one of this machine's own addresses (bindable)."""
    ip = _ip(host)
    if ip is None:
        return False
    if ip.is_loopback:
        return True
    fam = socket.AF_INET6 if ip.version == 6 else socket.AF_INET
    s = socket.socket(fam, socket.SOCK_DGRAM)
    try:
        s.bind((str(ip), 0))
        return True
    except OSError:
        return False
    finally:
        s.close()


# ----------------------------------------------------------------- throttle
class Throttle:
    """Failed-login back-off per source. IPv6 sources are grouped by /64 (one client usually
    owns a whole /64 and could otherwise rotate addresses). 5 free failures, then the wait
    doubles from 2 s up to 15 min; a success clears it. In memory: a restart resets it, which
    is fine for an attacker who can't restart the service. On top of this, pam_unix itself
    delays every failure by ~2 s."""
    FREE, BASE, CAP, FORGET = 5, 2, 900, 3600

    def __init__(self):
        self._f: dict[str, tuple[int, float]] = {}
        self._lock = threading.Lock()

    @staticmethod
    def key(host: str | None) -> str:
        ip = _ip(host)
        if ip is None:
            return str(host)
        if ip.version == 6:
            return str(ipaddress.ip_network(f"{ip}/64", strict=False))
        return str(ip)

    def retry_after(self, host: str | None) -> int:
        with self._lock:
            n, last = self._f.get(self.key(host), (0, 0.0))
            if n < self.FREE:
                return 0
            wait = min(self.CAP, self.BASE * 2 ** (n - self.FREE)) - (time.time() - last)
            return max(0, int(wait + 0.999))

    def fail(self, host: str | None) -> None:
        now = time.time()
        with self._lock:
            for k in [k for k, (_, t) in self._f.items() if now - t > self.FORGET]:
                del self._f[k]
            n, _ = self._f.get(self.key(host), (0, 0.0))
            self._f[self.key(host)] = (n + 1, now)

    def ok(self, host: str | None) -> None:
        with self._lock:
            self._f.pop(self.key(host), None)


throttle = Throttle()


# ----------------------------------------------------------------- request policy
PUBLIC_PREFIXES = ("/api/auth/",)
ENGINE_PATHS = ("/api/engine/event",)
PROTECTED_PREFIXES = ("/api/", "/ws", "/docs", "/redoc", "/openapi.json")


def needs_auth(path: str) -> bool:
    if path.startswith(PUBLIC_PREFIXES) or path in ENGINE_PATHS:
        return False
    return path == "/api" or path.startswith(PROTECTED_PREFIXES)


def allowed(path: str, client_host: str | None, cookie: str | None) -> bool:
    """Policy for one request (HTTP or WebSocket handshake)."""
    if path in ENGINE_PATHS:
        return is_host_address(client_host)
    if not needs_auth(path):
        return True
    return session_valid(cookie)


def status(cookie: str | None) -> dict:
    user = session_user(cookie)
    return {"authenticated": user is not None, "user": user}


def _cli(argv: list[str]) -> int:
    if argv[:1] == ["logout-all"]:
        logout_everywhere()
        print("every WebUI session was logged out")
        return 0
    print(__doc__.split("CLI", 1)[1])
    return 2


if __name__ == "__main__":
    import sys
    raise SystemExit(_cli(sys.argv[1:]))
