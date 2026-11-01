import type { SipConfig } from "../../api";
import type { InstanceForm } from "./types";

export const PANI_ACCESS_TYPES = [
  "IEEE-802.11",
  "IEEE-802.11a",
  "IEEE-802.11b",
  "IEEE-802.11g",
  "IEEE-802.11n",
  "IEEE-802.11ac",
  "IEEE-802.11ax",
  "IEEE-802.11be",
  "3GPP-WLAN",
] as const;

// Preview-only MCC→ISO hints (authoritative table lives in control/app/mcc_country.py).
export const PREVIEW_MCC_ISO: Readonly<Record<string, string>> = {
  "202": "GR",
  "204": "NL",
  "206": "BE",
  "208": "FR",
  "214": "ES",
  "216": "HU",
  "219": "HR",
  "222": "IT",
  "226": "RO",
  "228": "CH",
  "230": "CZ",
  "232": "AT",
  "234": "GB",
  "235": "GB",
  "238": "DK",
  "240": "SE",
  "242": "NO",
  "244": "FI",
  "250": "RU",
  "255": "UA",
  "260": "PL",
  "262": "DE",
  "268": "PT",
  "272": "IE",
  "286": "TR",
  "302": "CA",
  "310": "US",
  "311": "US",
  "312": "US",
  "313": "US",
  "314": "US",
  "315": "US",
  "316": "US",
  "334": "MX",
  "404": "IN",
  "405": "IN",
  "440": "JP",
  "441": "JP",
  "450": "KR",
  "454": "HK",
  "455": "MO",
  "460": "CN",
  "461": "CN",
  "466": "TW",
  "502": "MY",
  "505": "AU",
  "510": "ID",
  "515": "PH",
  "520": "TH",
  "525": "SG",
  "530": "NZ",
  "602": "EG",
  "655": "ZA",
  "724": "BR",
};

export const emptyInstance = (): InstanceForm => ({
  id: "",
  name: "",
  imsi: "",
  mcc: "",
  mnc: "",
  imei: "",
  imeisv: "",
  pin: "",
  reader: "",
  reader_index: 0,
  reader_port: "",
  msisdn: "",
  smsc: "",
  enabled: true,
  apn: "ims",
  idr_mode: "apn",
  cp_mode: "auto",
  use_reauth_id: true,
  ims_domain: "",
  reg_geolocation_country: "",
  reg_srvcc_tags: false,
  reg_imei_urn_spare_zero: false,
  dial_00_to_plus: false,
  update_after_prack: false,
  sip: {
    listen_addr: "0.0.0.0",
    transport: "udp",
    external: [],
    webrtc: { enable: true },
    pani_country_enable: true,
    pani_country: "",
    pani_node_id_enable: false,
    pani_node_id: "",
    pani_access_type: "IEEE-802.11",
  },
  debug: { asterisk: true, charon: false },
});

export function normalizePreviewCountry(c: string = "") {
  const s = c
    .trim()
    .toUpperCase()
    .replace(/[^A-Z]/g, "");
  return s.length === 2 ? s : "";
}

export function normalizePreviewNodeId(m: string = "") {
  const s = m.replace(/[^0-9a-fA-F]/g, "").toLowerCase();
  return /^[0-9a-f]{12}$/.test(s) ? s : "";
}

/** Client-side preview of the P-Access-Network-Info header that will be sent. */
export function previewPani(sip: SipConfig | undefined, mcc = "") {
  const s: SipConfig = sip || {};
  const override = (s.pani || "").trim();
  if (override) return override;
  const parts = [s.pani_access_type || "IEEE-802.11"];
  if (s.pani_country_enable !== false) {
    let c = normalizePreviewCountry(s.pani_country);
    if (!c) {
      const key = String(mcc || "")
        .replace(/\D/g, "")
        .slice(0, 3)
        .padStart(3, "0");
      c = PREVIEW_MCC_ISO[key] || "";
    }
    if (c) parts.push(`country=${c}`);
    else if (mcc) parts.push("country=<from SIM MCC>");
  }
  if (s.pani_node_id_enable) {
    const n = normalizePreviewNodeId(s.pani_node_id);
    if (n) parts.push(`i-wlan-node-id=${n}`);
  }
  return parts.join(";");
}

export function sipUsernameConflict(sip: SipConfig) {
  const accounts = sip?.external || [];
  const webrtcUser = (sip?.webrtc?.username || "webrtc").trim();
  const reserved = new Set(
    [
      "global",
      "system",
      "volte_ims",
      "endpoint-local",
      "auth-local",
      "aor-local",
      "transport-local",
      "transport-wss",
      webrtcUser,
    ].filter(Boolean),
  );
  const seen = new Map();
  for (let i = 0; i < accounts.length; i++) {
    const username = String(accounts[i]?.username || "").trim();
    if (!username) continue;
    if (reserved.has(username)) {
      return `SIP username '${username}' is reserved for the built-in softphone or Asterisk.`;
    }
    if (seen.has(username)) {
      return `SIP username '${username}' is used more than once (accounts #${seen.get(username) + 1} and #${i + 1}).`;
    }
    seen.set(username, i);
  }
  return "";
}
