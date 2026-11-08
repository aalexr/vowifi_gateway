#!/usr/bin/env python3
"""
fixed_sms.py - Fixed-line SMS bridge (ETSI ES 201 912 "Festnetz-SMS") <-> IMS SMS.

A DECT base with landline SMS (e.g. a Gigaset analog base on a FRITZ!Box FON port) sends and
receives SMS as an FSK "modem" call to/from its configured SMS centre number. Asterisk's app_sms
speaks that protocol as the SMS centre; this script moves messages between app_sms's text-file
queues and the IMS side. All file formats are app_sms's (apps/app_sms.c, sms_readfile /
sms_writefile):

  /var/spool/asterisk/sms/morx/<queue>.*  messages the base SENT (mobile-originated, received by
                                          us acting as SMSC; written by SMS(<queue>,sa))
  /var/spool/asterisk/sms/mttx/<queue>.*  messages to DELIVER to the base (read and deleted by
                                          SMS(<queue>,s) on a call we place to the base)

Commands (called from the Asterisk dialplan, see templates/extensions.conf.j2):

  fixed_sms.py pop [--plus00]
      Print the next message the base sent as "<dest>|<base64 utf-8 body>" (no newline) and
      remove it from morx; print nothing when the queue is empty. Concatenated parts (UDH IE
      0x00/0x08) present in the queue are joined into one body. --plus00 rewrites a leading
      international 00 to + (the line's dial_00_to_plus setting).

  fixed_sms.py deliver <account> <smsc_number> <from> <body_b64>
      Queue an IMS SMS for the base (split to 160 GSM 7-bit chars per message) and place a call
      to PJSIP/<account> with caller ID <smsc_number>; the base recognises its SMS centre by
      that CLIP and picks up silently. No-op when a delivery call is already pending.

  fixed_sms.py kick <account> <smsc_number>
      Called after a delivery call ends: if messages are still queued (one arrived while the
      call was up), schedule another call a few seconds later.

Never raises into the dialplan: errors are logged to stderr (Asterisk console) and the script
exits 0, so a bad file can't wedge the dialplan loop (pop always removes what it read).
"""
from __future__ import annotations

import base64
import os
import re
import sys
import time
import unicodedata

QUEUE = "fixedsms"
SPOOL = os.environ.get("AST_SPOOL_DIR", "/var/spool/asterisk")
MORX = os.path.join(SPOOL, "sms", "morx")
MTTX = os.path.join(SPOOL, "sms", "mttx")
OUTGOING = os.path.join(SPOOL, "outgoing")
TMP = os.path.join(SPOOL, "tmp")          # same filesystem as OUTGOING, for an atomic rename
CALLFILE_PREFIX = "fixed-sms"

# GSM 03.38 default alphabet and extension table, exactly as app_sms's packsms7 encodes them
# (defaultalphabet[] / escapes[]). A character outside both makes app_sms fall back to 8-bit or
# UCS-2, which landline SMS bases generally can't display, so outgoing text is folded into these.
# U+00A0 is deliberately absent: app_sms uses it as the internal marker for ESC (27).
GSM_BASIC = set(
    "@£$¥èéùìòçØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?"
    "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà\n\r"
)
GSM_EXT = set("\f^{}\\[~]|€")
SMSLEN = 160
FOLD = {
    " ": " ", "‘": "'", "’": "'", "‚": "'", "“": '"', "”": '"',
    "„": '"', "«": '"', "»": '"', "–": "-", "—": "-", "−": "-",
    "…": "...", "\t": " ", "`": "'", "´": "'",
}


def log(msg: str) -> None:
    print(f"fixed_sms: {msg}", file=sys.stderr)


def to_gsm(text: str) -> str:
    """Fold text into the GSM 7-bit alphabet: typographic punctuation to ASCII, accented letters
    without a GSM code point to their base letter, anything else (emoji, CJK) to '?'."""
    out = []
    for ch in text:
        if ch in GSM_BASIC or ch in GSM_EXT:
            out.append(ch)
            continue
        if ch in FOLD:
            out.append(FOLD[ch])
            continue
        base = "".join(c for c in unicodedata.normalize("NFKD", ch) if not unicodedata.combining(c))
        out.append(base if base and all(c in GSM_BASIC or c in GSM_EXT for c in base) else "?")
    return "".join(out)


def split_gsm(text: str) -> list[str]:
    """Split into chunks of at most SMSLEN septets (extension chars cost two). app_sms truncates
    longer user data, and plain landline SMS carry no concatenation header, so each chunk is
    delivered as its own message."""
    chunks, cur, n = [], [], 0
    for ch in text:
        w = 2 if ch in GSM_EXT else 1
        if n + w > SMSLEN:
            chunks.append("".join(cur))
            cur, n = [], 0
        cur.append(ch)
        n += w
    if cur or not chunks:
        chunks.append("".join(cur))
    return chunks


def sender_number(uri: str) -> tuple[str, str]:
    """IMS From (sip:+4917...@realm;user=phone, tel:+49..., or "Name" <sip:...>) -> (digits for
    the SMS originating address, display text). app_sms's oa holds digits and a leading + only."""
    m = re.search(r"<([^>]*)>", uri)
    u = m.group(1) if m else uri
    u = re.sub(r"^(sips?|tel):", "", u.strip(), flags=re.I)
    user = u.split("@", 1)[0].split(";", 1)[0]
    num = re.sub(r"[^0-9+]", "", user)
    num = ("+" if num.startswith("+") else "") + num.replace("+", "")
    return (num if re.search(r"\d", num) else ""), user


def _atomic_write(directory: str, name: str, content: str, mtime: float | None = None) -> None:
    """Write via a dot-file + rename: app_sms (readdirqueue) and pbx_spool both skip dot files,
    so neither ever reads a half-written file."""
    os.makedirs(directory, exist_ok=True)
    tmp = os.path.join(directory, "." + name)
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(content)
    if mtime is not None:
        os.utime(tmp, (mtime, mtime))
    os.rename(tmp, os.path.join(directory, name))


def _queued(directory: str) -> list[str]:
    try:
        names = os.listdir(directory)
    except FileNotFoundError:
        return []
    return sorted(n for n in names if n.startswith(QUEUE + "."))


def _ucs2_hex(text: str) -> str:
    # ud## (UCS-2 hex) is the one app_sms ud form that carries every GSM character, including
    # LF/CR, which would end a plain "ud=" line. Without an explicit dcs, app_sms still packs
    # it as 7-bit when all characters are in the GSM alphabet (sms_readfile -> packsms7).
    return "".join("%04X" % ord(c) for c in text)


def call_file(account: str, number: str, delay: float = 0.0) -> None:
    """Have pbx_spool call the base. The call runs [fixed-sms-mt] (SMS(<queue>,s)), whose hangup
    handler runs `kick` for anything that arrived meanwhile."""
    body = (
        f"Channel: PJSIP/{account}\n"
        f'CallerID: "{number}" <{number}>\n'
        "MaxRetries: 5\n"
        "RetryTime: 60\n"
        "WaitTime: 45\n"
        "Context: fixed-sms-mt\n"
        "Extension: s\n"
        "Priority: 1\n"
        "Archive: no\n"
    )
    name = f"{CALLFILE_PREFIX}-{int(time.time() * 1000)}-{os.getpid()}.call"
    os.makedirs(TMP, exist_ok=True)
    tmp = os.path.join(TMP, name)
    with open(tmp, "w") as f:
        f.write(body)
    # pbx_spool treats an mtime in the future as "call at that time".
    t = time.time() + delay
    os.utime(tmp, (t, t))
    os.makedirs(OUTGOING, exist_ok=True)
    os.rename(tmp, os.path.join(OUTGOING, name))
    log(f"delivery call to PJSIP/{account} scheduled ({name})")


def call_pending() -> bool:
    try:
        return any(n.startswith(CALLFILE_PREFIX) for n in os.listdir(OUTGOING))
    except FileNotFoundError:
        return False


def cmd_deliver(account: str, number: str, frm: str, body_b64: str) -> None:
    try:
        text = base64.b64decode(body_b64).decode("utf-8", "replace")
    except Exception:
        text = ""
    oa, shown = sender_number(frm)
    if not oa:
        # Alphanumeric sender (e.g. a bank or parcel service): the SMS originating address can
        # only carry digits, so show the name in the text and use the SMS centre as sender.
        text = f"{shown}: {text}"
        oa = number
    parts = split_gsm(to_gsm(text))
    stamp = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())
    for i, part in enumerate(parts):
        name = f"{QUEUE}.{stamp}-{os.getpid()}-{i:02d}"
        _atomic_write(MTTX, name, f"oa={oa}\nud##{_ucs2_hex(part)}\nscts={stamp}\n")
    log(f"queued {len(parts)} message(s) from {oa} for the base")
    if not call_pending():
        call_file(account, number)


def cmd_kick(account: str, number: str) -> None:
    if _queued(MTTX):
        # Give the base a few seconds to go back on hook before ringing it again.
        call_file(account, number, delay=8)


def _parse_rx(path: str) -> dict:
    """Read one app_sms received-message file. ud## (UCS-2 hex) beats ud# (UCS-1 hex) beats
    ud= (UTF-8): app_sms writes the hex forms whenever the text holds control characters such
    as a line break, and then comments out the ud= line with a leading ';'."""
    msg: dict = {"da": "", "udh": b"", "ud": None, "ud_rank": -1}
    with open(path, "rb") as f:
        raw = f.read().decode("utf-8", "replace")
    for line in raw.splitlines():
        if not line or line.startswith(";"):
            continue
        if line.startswith("ud##"):
            h = line[4:]
            msg["ud"], msg["ud_rank"] = "".join(chr(int(h[i:i + 4], 16)) for i in range(0, len(h) - 3, 4)), 2
        elif line.startswith("ud#") and msg["ud_rank"] < 1:
            msg["ud"], msg["ud_rank"] = bytes.fromhex(line[3:]).decode("latin-1"), 1
        elif line.startswith("ud=") and msg["ud_rank"] < 0:
            msg["ud"], msg["ud_rank"] = line[3:], 0
        elif line.startswith("udh#"):
            msg["udh"] = bytes.fromhex(line[4:])
        elif line.startswith("da="):
            msg["da"] = line[3:].strip()
    msg["ud"] = msg["ud"] or ""
    return msg


def _concat_ie(udh: bytes) -> tuple[int, int, int] | None:
    """(ref, total, seq) from a concatenation IE (0x00 8-bit ref / 0x08 16-bit ref), else None.
    app_sms stores the UDH without its length octet (UDHL); tolerate one anyway."""
    if udh and udh[0] == len(udh) - 1:
        udh = udh[1:]
    i = 0
    while i + 1 < len(udh):
        iei, ln = udh[i], udh[i + 1]
        v = udh[i + 2:i + 2 + ln]
        if iei == 0x00 and ln == 3 and len(v) == 3:
            return v[0], v[1], v[2]
        if iei == 0x08 and ln == 4 and len(v) == 4:
            return (v[0] << 8) | v[1], v[2], v[3]
        i += 2 + ln
    return None


def cmd_pop(plus00: bool) -> None:
    names = _queued(MORX)
    if not names:
        return
    first = os.path.join(MORX, names[0])
    try:
        msg = _parse_rx(first)
    except Exception as e:
        log(f"dropping unreadable {first}: {e!r}")
        os.unlink(first)
        return
    used = [first]
    body = msg["ud"]
    ie = _concat_ie(msg["udh"])
    if ie:
        # Join every part of this concatenated message present in the queue (they arrive in the
        # same call). Missing parts are marked like the WebUI does for incoming SMS.
        ref, total, _ = ie
        parts: dict[int, str] = {}
        for n in names:
            p = os.path.join(MORX, n)
            try:
                m = _parse_rx(p)
            except Exception:
                continue
            c = _concat_ie(m["udh"])
            if c and c[0] == ref and c[1] == total and m["da"] == msg["da"]:
                parts.setdefault(c[2], m["ud"])
                if p not in used:
                    used.append(p)
        body = "".join(parts.get(s, "[…]") for s in range(1, total + 1))
    for p in used:
        try:
            os.unlink(p)
        except FileNotFoundError:
            pass
    dest = re.sub(r"[^0-9+*#]", "", msg["da"])
    if plus00 and dest.startswith("00"):
        dest = "+" + dest[2:]
    if not dest:
        log("dropping a message without a destination number")
        return
    sys.stdout.write(f"{dest}|{base64.b64encode(body.encode('utf-8')).decode()}")


def main(argv: list[str]) -> int:
    try:
        cmd = argv[1] if len(argv) > 1 else ""
        if cmd == "pop":
            cmd_pop("--plus00" in argv[2:])
        elif cmd == "deliver" and len(argv) >= 6:
            cmd_deliver(argv[2], argv[3], argv[4], argv[5])
        elif cmd == "kick" and len(argv) >= 4:
            cmd_kick(argv[2], argv[3])
        else:
            log(f"usage error: {argv[1:]}")
    except Exception as e:
        log(f"{argv[1:2]} failed: {e!r}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
