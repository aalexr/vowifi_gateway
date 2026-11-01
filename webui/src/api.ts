// Thin REST + WebSocket client for the manager API (same origin).
const base = "";

export type InstanceId = string | number;

export type StatusState =
  | "STOPPED"
  | "NO_CARD"
  | "PIN_PROBLEM"
  | "EPDG_UNRESOLVED"
  | "TUNNEL_DOWN"
  | "REGISTERING"
  | "OK"
  | "ERROR";

export interface CardInfo {
  reader: string;
  reader_index: number;
  present: boolean;
  imsi?: string | null;
  mcc?: string | null;
  mnc?: string | null;
  mnc_len?: number | null;
  iccid?: string | null;
  pin_enabled?: boolean | null;
  pin_tries?: number | null;
  smsc?: string | null;
  error?: string | null;
  reader_port?: string | null;
}

export interface DetectedCard {
  index: number;
  name: string;
  present: boolean;
  iccid?: string | null;
  pin_enabled?: boolean | null;
  pin_tries?: number | null;
  matched?: InstanceId | null;
  imsi?: string | null;
  mcc?: string | null;
  mnc?: string | null;
  smsc?: string | null;
  reader_port?: string | null;
}

export interface PinResult {
  ok: boolean;
  error?: string;
  tries?: number;
  card?: DetectedCard;
}

export interface InstanceStatus {
  state: StatusState;
  label: string;
  reason_code: string;
  reason: string;
  detail: Record<string, unknown>;
  retry?: { count: number; max: number };
  frozen?: boolean;
  retrying_network?: boolean;
}

export interface SipExternalAccount {
  username: string;
  password?: string;
}

export interface SipConfig {
  listen_addr?: string;
  transport?: string;
  external?: SipExternalAccount[];
  webrtc?: { enable?: boolean; username?: string; password?: string };
  [key: string]: unknown;
}

export interface PortMap {
  sip_udp?: number;
  sip_tls?: number;
  webrtc?: number;
  ami?: number;
  rtp_start?: number;
  rtp_end?: number;
}

export interface InstanceConfig {
  id: InstanceId;
  name?: string;
  imsi?: string;
  mcc?: string;
  mnc?: string;
  iccid?: string;
  imei?: string;
  imeisv?: string;
  pin?: string;
  has_pin?: boolean;
  reader?: string;
  reader_index?: number;
  reader_port?: string;
  smsc?: string;
  msisdn?: string;
  enabled?: boolean;
  sip?: SipConfig;
  ports?: PortMap;
  apn?: string;
  idr_mode?: string;
  cp_mode?: string;
  debug?: Record<string, boolean>;
  status?: InstanceStatus;
  [key: string]: unknown;
}

export interface ConfiguredInstance extends InstanceConfig {
  has_pin: boolean;
  status: InstanceStatus;
}

export interface Settings {
  http_port?: number;
  bind?: string;
  tls?: {
    self_signed?: boolean;
    domain?: string;
    cert_path?: string;
    key_path?: string;
  };
  debug?: { asterisk?: boolean; charon?: boolean; pcap?: boolean };
  manager_url?: string;
  advertise_address?: string;
  advertise_address_effective?: string;
  advertise_address_managed_by_env?: boolean;
  advertise_address_detected?: string;
  retry?: { max?: number; interval?: number; auto_recover?: boolean };
  rekey?: { minutes?: number };
  ring_timeout?: number;
  webhook?: {
    enabled?: boolean;
    url?: string;
    events?: { incoming_sms?: boolean; incoming_call?: boolean };
  };
  telegram?: {
    enabled?: boolean;
    bot_token?: string;
    chat_id?: string;
    events?: { incoming_sms?: boolean; incoming_call?: boolean };
  };
  esim?: {
    lpac_bin?: string;
    download_timeout?: number;
    auto_process_notifications?: boolean;
  };
}

export interface MessageThread {
  peer: string;
  last_ts: number;
  last_body: string;
  n: number;
}

export interface MessageRecord {
  id: number;
  instance: string;
  direction: "in" | "out";
  peer: string;
  body: string;
  status: string;
  error?: string | null;
  ts: number;
}

export interface CallRecord {
  id: number;
  instance: string;
  direction: "in" | "out";
  peer: string;
  status: string;
  start_ts: number;
  end_ts?: number | null;
}

export interface ReaderSelection {
  reader?: string;
  reader_index?: number;
  se_id?: string;
  seId?: string;
  aid?: string;
}

export type ReaderTarget = string | number | ReaderSelection;

export interface ProvisionRequest extends ReaderSelection {
  pin: string;
  imei: string;
  imeisv?: string;
  name?: string;
  smsc?: string;
  msisdn?: string;
  sip?: SipConfig;
  webrtc?: boolean;
  id?: InstanceId;
  port_mode?: string;
  sip_port?: number;
  apn?: string;
  idr_mode?: string;
  cp_mode?: string;
  debug?: Record<string, boolean>;
}

export type InstanceUpdate = Partial<InstanceConfig>;

export type DeleteMessagesRequest =
  { ids: unknown[] } | { peer: string } | { all: true };

export type DeleteCallsRequest = { ids: unknown[] } | { all: true };

export interface EsimProfile {
  iccid: string;
  [key: string]: unknown;
}

export interface EsimNotification {
  seq: number;
  iccid?: string;
  [key: string]: unknown;
}

export interface EsimSecureElement {
  id: string;
  label?: string;
  aid?: string | null;
  eid?: string;
  chip?: Record<string, unknown> | null;
  freeSpace?: number;
  profiles?: EsimProfile[];
  notifications?: EsimNotification[];
  error?: string;
}

export interface EsimStatus {
  available: boolean;
  lpac_bin: string;
  download_timeout: number;
  auto_process_notifications: boolean;
  busy_readers: string[];
}

export interface EsimReaderRequest extends ReaderSelection {
  imei?: string;
}

export interface EsimDownloadRequest extends EsimReaderRequest {
  activation_code?: string;
  smdp?: string;
  matching_id?: string;
  confirmation_code?: string;
}

export interface EsimNotificationProcessRequest extends EsimReaderRequest {
  seq?: number;
  remove?: boolean;
}

export type WebSocketMessage =
  | { type: "cards"; cards: DetectedCard[] }
  | ({ type: "status"; instance: string } & InstanceStatus)
  | { type: "engine"; instance: string; event: string; args?: unknown[] }
  | {
      type: "sms";
      instance: string;
      deleted?: number;
      update?: boolean;
      message?: MessageRecord;
    }
  | { type: "call"; instance: string; deleted?: number; call?: CallRecord }
  | {
      type: "esim_download";
      reader: string;
      reader_index?: number;
      se_id?: string;
      event: string;
      step?: string;
      data?: unknown;
      metadata?: Record<string, unknown>;
      result?: unknown;
      card?: DetectedCard;
      error?: string;
      imei?: string;
    };

async function j<T>(method: string, path: string, body?: unknown): Promise<T> {
  const opt: RequestInit = { method, headers: {} };
  if (body !== undefined) {
    opt.headers["Content-Type"] = "application/json";
    opt.body = JSON.stringify(body);
  }
  const r = await fetch(base + path, opt);
  const text = await r.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  // detail may be a structured dict (e.g. {code, message}); prefer its message so
  // alerts show readable text instead of "[object Object]".
  const detailMsg =
    data.detail && typeof data.detail === "object"
      ? data.detail.message
      : data.detail;
  if (!r.ok)
    throw Object.assign(new Error(detailMsg || data.error || r.statusText), {
      status: r.status,
      data,
    });
  return data;
}

/** Build query string. Prefer reader NAME (stable); index is optional fallback. */
function readerQuery(readerOrIndex?: ReaderTarget, maybeName?: string) {
  const q = new URLSearchParams();
  if (typeof readerOrIndex === "string" && readerOrIndex) {
    q.set("reader", readerOrIndex);
  } else if (typeof readerOrIndex === "number") {
    q.set("reader_index", String(readerOrIndex));
    if (maybeName) q.set("reader", maybeName);
  } else if (maybeName) {
    q.set("reader", maybeName);
  } else {
    q.set("reader_index", "0");
  }
  return q;
}

function readerBody(
  readerOrIndex?: ReaderTarget,
  extra: Record<string, unknown> = {},
) {
  if (typeof readerOrIndex === "string" && readerOrIndex) {
    return { reader: readerOrIndex, ...extra };
  }
  if (typeof readerOrIndex === "number") {
    return { reader_index: readerOrIndex, ...extra };
  }
  if (readerOrIndex && typeof readerOrIndex === "object") {
    return { ...readerOrIndex, ...extra };
  }
  return { reader_index: 0, ...extra };
}

export const api = {
  readers: () => j<{ readers: string[] }>("GET", "/api/readers"),
  detect: (i = 0) => j<CardInfo>("GET", `/api/sim/detect?reader_index=${i}`),
  // `reader` (PC/SC reader NAME) lets the backend re-resolve the index at request time —
  // indices shift when another reader is unplugged, and a stale index could address the
  // wrong physical SIM.
  verifyPin: (pin: string, reader_index = 0, reader?: string) =>
    j<PinResult>("POST", "/api/sim/verify-pin", { pin, reader_index, reader }),
  changePin: (oldp: string, newp: string, reader_index = 0) =>
    j<PinResult>("POST", "/api/sim/change-pin", {
      old: oldp,
      new: newp,
      reader_index,
    }),
  setPinEnabled: (pin: string, enabled: boolean, reader_index = 0) =>
    j<PinResult>("POST", "/api/sim/pin-enabled", {
      pin,
      enabled,
      reader_index,
    }),

  settings: () => j<Settings>("GET", "/api/settings"),
  saveSettings: (patch: Partial<Settings>) =>
    j<Settings>("PUT", "/api/settings", patch),

  instances: () =>
    j<{ instances: ConfiguredInstance[] }>("GET", "/api/instances"),
  cards: () => j<{ cards: DetectedCard[] }>("GET", "/api/cards"),
  portsSuggest: () =>
    j<{ auto_sip_udp: number; auto_sip_tls: number; min: number; max: number }>(
      "GET",
      "/api/ports/suggest",
    ),
  provision: (body: ProvisionRequest) =>
    j<{ ok: boolean; instance: InstanceConfig }>(
      "POST",
      "/api/provision",
      body,
    ),
  saveInstance: (inst: InstanceUpdate) =>
    j<InstanceConfig & { restart_required: boolean; applied: boolean }>(
      "POST",
      "/api/instances",
      inst,
    ),
  deleteInstance: (id: InstanceId) =>
    j<{ ok: boolean }>("DELETE", `/api/instances/${id}`),
  start: (id: InstanceId, body?: { pin?: string }) =>
    j<{ ok: boolean; container: string }>(
      "POST",
      `/api/instances/${id}/start`,
      body || {},
    ),
  stop: (id: InstanceId) =>
    j<{ ok: boolean }>("POST", `/api/instances/${id}/stop`),
  reprovision: (id: InstanceId, body?: Partial<InstanceConfig>) =>
    j<{ ok: boolean; container: string }>(
      "POST",
      `/api/instances/${id}/reprovision`,
      body || {},
    ),
  clearPin: (id: InstanceId) =>
    j<{ ok: boolean; had_pin: boolean }>(
      "POST",
      `/api/instances/${id}/pin/clear`,
    ),
  status: (id: InstanceId) =>
    j<InstanceStatus>("GET", `/api/instances/${id}/status`),
  logs: (id: InstanceId, tail = 300) =>
    j<{ engine: string; charon: string }>(
      "GET",
      `/api/instances/${id}/logs?tail=${tail}`,
    ),
  register: (id: InstanceId) =>
    j<{ output: string }>("POST", `/api/instances/${id}/register`),

  threads: (id: InstanceId) =>
    j<{ threads: MessageThread[] }>(
      "GET",
      `/api/instances/${id}/messages/threads`,
    ),
  messages: (id: InstanceId, peer: string) =>
    j<{ messages: MessageRecord[] }>(
      "GET",
      `/api/instances/${id}/messages/${encodeURIComponent(peer)}`,
    ),
  sendSms: (id: InstanceId, to: string, body: string) =>
    j<{
      ok: boolean;
      message: MessageRecord;
      error: string | null;
      pending_delivery?: boolean;
    }>("POST", `/api/instances/${id}/sms/send`, { to, body }),
  // delete messages: { ids:[...] } | { peer } (whole conversation) | { all:true }
  deleteMessages: (id: InstanceId, sel: DeleteMessagesRequest) =>
    j<{ ok: boolean; deleted: number }>(
      "POST",
      `/api/instances/${id}/messages/delete`,
      sel,
    ),

  calls: (id: InstanceId) =>
    j<{ calls: CallRecord[] }>("GET", `/api/instances/${id}/calls`),
  // delete call-log entries: { ids:[...] } | { all:true }
  deleteCalls: (id: InstanceId, sel: DeleteCallsRequest) =>
    j<{ ok: boolean; deleted: number }>(
      "POST",
      `/api/instances/${id}/calls/delete`,
      sel,
    ),
  call: (id: InstanceId, to: string, from_endpoint = "webrtc") =>
    j<{ ok: boolean; detail?: string; error?: string }>(
      "POST",
      `/api/instances/${id}/call`,
      { to, from_endpoint },
    ),
  hangup: (id: InstanceId) =>
    j<{ ok: boolean; error?: string }>("POST", `/api/instances/${id}/hangup`),
  softphone: (id: InstanceId) =>
    j<{
      enabled: boolean;
      username: string;
      password: string;
      ws_port: number;
      host: string;
      realm: string;
    }>("GET", `/api/instances/${id}/softphone`),
  sipinfo: (id: InstanceId) =>
    j<{
      host: string;
      domain: string;
      port: number;
      transport: "udp" | "tls";
      accounts: SipExternalAccount[];
      running: boolean;
      dial_plan: string;
      dial_plan_plus00: string;
      msisdn: string;
    }>("GET", `/api/instances/${id}/sipinfo`),

  // eSIM / LPA (lpac) — first arg is usually the PC/SC reader NAME (string).
  // Optional se_id / aid target a specific Secure Element on dual-SE cards.
  esimStatus: () => j<EsimStatus>("GET", "/api/esim/status"),
  esimChip: (readerOrIndex?: ReaderTarget, maybeName?: string) =>
    j<{
      ok: boolean;
      reader: string;
      reader_index: number;
      dual: boolean;
      ses: EsimSecureElement[];
      chip?: Record<string, unknown>;
      imei: string;
      line_running: boolean;
      matched_instance?: InstanceId | null;
    }>("GET", `/api/esim/chip?${readerQuery(readerOrIndex, maybeName)}`),
  esimProfiles: (readerOrIndex?: ReaderTarget, maybeName?: string) =>
    j<{
      ok: boolean;
      reader: string;
      reader_index: number;
      dual: boolean;
      ses: EsimSecureElement[];
      profiles: EsimProfile[];
      imei: string;
      line_running: boolean;
      matched_instance?: InstanceId | null;
      lpa_busy: boolean;
    }>("GET", `/api/esim/profiles?${readerQuery(readerOrIndex, maybeName)}`),
  esimEnable: (iccid: string, readerOrBody: ReaderTarget) =>
    j<{
      ok: boolean;
      iccid: string;
      se_id: string;
      card?: DetectedCard | null;
    }>(
      "POST",
      `/api/esim/profiles/${encodeURIComponent(iccid)}/enable`,
      readerBody(readerOrBody),
    ),
  esimDisable: (iccid: string, readerOrBody: ReaderTarget) =>
    j<{
      ok: boolean;
      iccid: string;
      se_id: string;
      card?: DetectedCard | null;
    }>(
      "POST",
      `/api/esim/profiles/${encodeURIComponent(iccid)}/disable`,
      readerBody(readerOrBody),
    ),
  esimDelete: (iccid: string, readerOrBody: ReaderTarget) => {
    if (readerOrBody && typeof readerOrBody === "object") {
      const q = readerQuery(readerOrBody.reader ?? readerOrBody.reader_index);
      if (readerOrBody.se_id || readerOrBody.seId)
        q.set("se_id", readerOrBody.se_id || readerOrBody.seId);
      if (readerOrBody.aid) q.set("aid", readerOrBody.aid);
      return j<{ ok: boolean; iccid: string; se_id: string }>(
        "DELETE",
        `/api/esim/profiles/${encodeURIComponent(iccid)}?${q}`,
      );
    }
    return j<{ ok: boolean; iccid: string; se_id: string }>(
      "DELETE",
      `/api/esim/profiles/${encodeURIComponent(iccid)}?${readerQuery(readerOrBody)}`,
    );
  },
  esimNickname: (iccid: string, nickname: string, readerOrBody: ReaderTarget) =>
    j<{ ok: boolean; iccid: string; nickname: string; se_id: string }>(
      "POST",
      `/api/esim/profiles/${encodeURIComponent(iccid)}/nickname`,
      readerBody(readerOrBody, { nickname }),
    ),
  esimDownload: (body: EsimDownloadRequest) =>
    j<{
      ok: boolean;
      started: boolean;
      reader: string;
      reader_index: number;
      se_id: string;
      imei: string;
    }>("POST", "/api/esim/download", body),
  esimDownloadCancel: (readerOrBody?: ReaderTarget) =>
    j<{ ok: boolean; cancelled: boolean }>(
      "POST",
      "/api/esim/download/cancel",
      readerBody(readerOrBody),
    ),
  esimDiscovery: (body?: EsimReaderRequest) =>
    j<{
      ok: boolean;
      reader: string;
      se_id: string;
      entries: unknown[];
      imei: string;
    }>("POST", "/api/esim/discovery", body || {}),
  esimNotifications: (readerOrIndex?: ReaderTarget, maybeName?: string) =>
    j<{
      ok: boolean;
      reader: string;
      dual: boolean;
      ses: EsimSecureElement[];
      notifications: EsimNotification[];
    }>(
      "GET",
      `/api/esim/notifications?${readerQuery(readerOrIndex, maybeName)}`,
    ),
  // Aliases used by Esim.jsx
  esimProcessNotifications: (readerOrIndex: ReaderTarget, seq?: number) =>
    j<{ ok: boolean; se_id: string }>(
      "POST",
      "/api/esim/notifications/process",
      readerBody(readerOrIndex, seq == null ? {} : { seq }),
    ),
  esimNotificationsProcess: (body?: EsimNotificationProcessRequest) =>
    j<{ ok: boolean; se_id: string }>(
      "POST",
      "/api/esim/notifications/process",
      body || {},
    ),
  esimRemoveNotification: (seq: number, readerOrBody: ReaderTarget) => {
    if (readerOrBody && typeof readerOrBody === "object") {
      const q = readerQuery(readerOrBody.reader ?? readerOrBody.reader_index);
      if (readerOrBody.se_id || readerOrBody.seId)
        q.set("se_id", readerOrBody.se_id || readerOrBody.seId);
      if (readerOrBody.aid) q.set("aid", readerOrBody.aid);
      return j<{ ok: boolean; seq: number; se_id: string }>(
        "DELETE",
        `/api/esim/notifications/${seq}?${q}`,
      );
    }
    return j<{ ok: boolean; seq: number; se_id: string }>(
      "DELETE",
      `/api/esim/notifications/${seq}?${readerQuery(readerOrBody)}`,
    );
  },
  esimNotificationRemove: (seq: number, readerOrBody: ReaderTarget) => {
    if (readerOrBody && typeof readerOrBody === "object") {
      const q = readerQuery(readerOrBody.reader ?? readerOrBody.reader_index);
      if (readerOrBody.se_id || readerOrBody.seId)
        q.set("se_id", readerOrBody.se_id || readerOrBody.seId);
      if (readerOrBody.aid) q.set("aid", readerOrBody.aid);
      return j<{ ok: boolean; seq: number; se_id: string }>(
        "DELETE",
        `/api/esim/notifications/${seq}?${q}`,
      );
    }
    return j<{ ok: boolean; seq: number; se_id: string }>(
      "DELETE",
      `/api/esim/notifications/${seq}?${readerQuery(readerOrBody)}`,
    );
  },
};

export function connectWs(
  onMsg: (message: WebSocketMessage) => void,
): () => void {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  let ws,
    alive = true;
  const open = () => {
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onmessage = (e) => {
      try {
        onMsg(JSON.parse(e.data) as WebSocketMessage);
      } catch {}
    };
    ws.onclose = () => {
      if (alive) setTimeout(open, 2000);
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {}
    };
  };
  open();
  return () => {
    alive = false;
    try {
      ws.close();
    } catch {}
  };
}
