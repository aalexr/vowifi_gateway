//! api - The management REST API, the /ws live feed and the static WebUI.
//!
//! The JSON contract is the one the WebUI (webui/src/api.ts) and the engines (notify.py) were
//! written against: errors are `{"detail": <string | object>}` with the same status codes and
//! structured codes (`pin_required`, `card_mismatch`, `duplicate_sip_username`, ...).
//!
//! Every /api route and /ws sits behind the WebUI login (auth.rs); the only exemptions are
//! /api/auth/* and the host-address-only /api/engine/event (`require_login`).
use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, FromRequest, Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde_json::{Map, Value, json};
use tokio::sync::broadcast::error::RecvError;

use crate::auth;
use crate::hub::{Hub, WsOut};
use crate::lenient;

mod esim;
mod events;
mod instances;
mod session;
mod sim;

pub type AppState = Arc<Hub>;

// ----------------------------------------------------------------------------------- errors
/// `{"detail": ...}` with a status code, like FastAPI's HTTPException.
#[derive(Debug)]
pub struct ApiError {
    status: StatusCode,
    detail: Value,
    headers: Vec<(header::HeaderName, String)>,
}

impl ApiError {
    pub fn new(status: u16, detail: impl Into<Value>) -> Self {
        ApiError { status: StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
                   detail: detail.into(), headers: Vec::new() }
    }

    pub fn header(mut self, name: header::HeaderName, value: String) -> Self {
        self.headers.push((name, value));
        self
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut r = (self.status, Json(json!({"detail": self.detail}))).into_response();
        for (k, v) in self.headers {
            if let Ok(v) = HeaderValue::from_str(&v) {
                r.headers_mut().insert(k, v);
            }
        }
        r
    }
}

impl From<anyhow::Error> for ApiError {
    fn from(e: anyhow::Error) -> Self {
        tracing::error!("request failed: {e:#}");
        ApiError::new(500, format!("{e:#}"))
    }
}

pub type ApiResult<T = Json<Value>> = Result<T, ApiError>;

pub fn ok(v: Value) -> ApiResult {
    Ok(Json(v))
}

// ------------------------------------------------------------------------------- extractors
/// A JSON-object request body. An empty body reads as `{}` (routes whose body is optional);
/// anything but an object is a 422.
pub struct Body(pub Map<String, Value>);

impl<S: Send + Sync> FromRequest<S> for Body {
    type Rejection = ApiError;

    async fn from_request(req: Request, state: &S) -> Result<Self, ApiError> {
        let bytes = Bytes::from_request(req, state).await
            .map_err(|e| ApiError::new(400, e.to_string()))?;
        if bytes.iter().all(u8::is_ascii_whitespace) {
            return Ok(Body(Map::new()));
        }
        match serde_json::from_slice::<Value>(&bytes) {
            Ok(Value::Object(m)) => Ok(Body(m)),
            Ok(Value::Null) => Ok(Body(Map::new())),
            Ok(_) => Err(ApiError::new(422, "request body must be a JSON object")),
            Err(e) => Err(ApiError::new(422, format!("invalid JSON body: {e}"))),
        }
    }
}

impl Body {
    pub fn get(&self, k: &str) -> Option<&Value> {
        self.0.get(k).filter(|v| !v.is_null())
    }

    /// Optional string field ("" counts as absent).
    pub fn str(&self, k: &str) -> Option<String> {
        self.get(k).map(|v| lenient::string(Some(v))).filter(|s| !s.is_empty())
    }

    /// Required field as a string (422 if missing).
    pub fn req_str(&self, k: &str) -> ApiResult<String> {
        match self.get(k) {
            Some(v) => Ok(lenient::string(Some(v))),
            None => Err(ApiError::new(422, format!("field required: {k}"))),
        }
    }
}

/// Query parameters as strings, read leniently per field.
pub type Q = axum::extract::Query<HashMap<String, String>>;

pub fn q_int(q: &Q, k: &str, default: i64) -> ApiResult<i64> {
    match q.get(k).map(|s| s.trim()).filter(|s| !s.is_empty()) {
        None => Ok(default),
        Some(s) => s.parse().map_err(|_| ApiError::new(422, format!("query parameter {k} must be an integer"))),
    }
}

pub fn q_str(q: &Q, k: &str) -> Option<String> {
    q.get(k).cloned().filter(|s| !s.is_empty())
}

pub fn cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    headers.get_all(header::COOKIE).iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|kv| kv.trim().split_once('='))
        .find(|(k, _)| *k == name)
        .map(|(_, v)| v.trim_matches('"').to_string())
}

/// The request's Host without the port; IPv6 literals keep their brackets.
pub fn request_host(headers: &HeaderMap) -> String {
    let h = headers.get(header::HOST).and_then(|v| v.to_str().ok()).unwrap_or("").trim();
    if let Some(rest) = h.strip_prefix('[') {
        return match rest.split_once(']') {
            Some((ip, _)) => format!("[{ip}]"),
            None => h.to_string(),
        };
    }
    h.split(':').next().unwrap_or("").to_string()
}

// ------------------------------------------------------------------------------ middleware
async fn require_login(ConnectInfo(peer): ConnectInfo<SocketAddr>, req: Request, next: Next) -> Response {
    let path = req.uri().path().to_string();
    // The WebSocket handshake applies the policy itself (it must accept, then close 4401).
    if path != "/ws" {
        let c = cookie(req.headers(), auth::COOKIE_NAME);
        let ip = peer.ip();
        let allowed = if path == auth::ENGINE_PATH {
            crate::hub::blocking(move || auth::allowed(auth::ENGINE_PATH, Some(ip), None)).await
        } else {
            auth::allowed(&path, Some(ip), c.as_deref())
        };
        if !allowed {
            if path == auth::ENGINE_PATH {
                return ApiError::new(403, "forbidden").into_response();
            }
            return ApiError::new(401, json!({"code": "auth_required", "message": "Login required"})).into_response();
        }
    }
    next.run(req).await
}

// ------------------------------------------------------------------------------- websocket
async fn ws_endpoint(State(hub): State<AppState>, ConnectInfo(peer): ConnectInfo<SocketAddr>,
                     headers: HeaderMap, upgrade: WebSocketUpgrade) -> Response {
    let c = cookie(&headers, auth::COOKIE_NAME);
    let ok = auth::allowed("/ws", Some(peer.ip()), c.as_deref());
    upgrade.on_upgrade(move |socket| async move {
        if !ok {
            // Accept, then close with 4401: a rejected handshake reaches the browser only as an
            // anonymous 1006 the WebUI can't tell apart from a network drop.
            close_4401(socket).await;
            return;
        }
        ws_session(hub, socket).await;
    })
}

async fn close_4401(mut socket: WebSocket) {
    let _ = socket.send(Message::Close(Some(CloseFrame { code: 4401, reason: "".into() }))).await;
}

async fn ws_session(hub: AppState, mut socket: WebSocket) {
    let mut rx = hub.subscribe();
    loop {
        tokio::select! {
            msg = rx.recv() => match msg {
                Ok(WsOut::Json(text)) => {
                    if socket.send(Message::Text(text.as_ref().into())).await.is_err() {
                        return;
                    }
                }
                Ok(WsOut::CloseAll) => {
                    close_4401(socket).await;
                    return;
                }
                Err(RecvError::Lagged(n)) => tracing::debug!("ws client lagged; {n} messages dropped"),
                Err(RecvError::Closed) => return,
            },
            inbound = socket.recv() => match inbound {
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return,
                Some(Ok(_)) => {} // keepalive / ignored
            },
        }
    }
}

// ------------------------------------------------------------------------------ static UI
pub fn webui_dir() -> PathBuf {
    if let Ok(d) = std::env::var("VOWIFI_WEBUI")
        && !d.is_empty() {
            return PathBuf::from(d);
        }
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let sibling = cwd.join("..").join("webui").join("dist");
    if sibling.is_dir() { sibling } else { cwd.join("webui").join("dist") }
}

// ---------------------------------------------------------------------------------- router
pub fn router(hub: AppState) -> Router {
    let api = Router::new()
        .route("/api/auth/status", get(session::status))
        .route("/api/auth/login", post(session::login))
        .route("/api/auth/logout", post(session::logout))
        .route("/api/auth/logout-all", post(session::logout_all))
        .route("/api/readers", get(sim::readers))
        .route("/api/sim/detect", get(sim::detect))
        .route("/api/sim/verify-pin", post(sim::verify_pin))
        .route("/api/sim/change-pin", post(sim::change_pin))
        .route("/api/sim/pin-enabled", post(sim::pin_enabled))
        .route("/api/cards", get(sim::cards))
        .route("/api/ports/suggest", get(sim::ports_suggest))
        .route("/api/provision", post(sim::provision))
        .route("/api/settings", get(instances::get_settings).put(instances::put_settings))
        .route("/api/instances", get(instances::list).post(instances::upsert))
        .route("/api/instances/{iid}", delete(instances::remove))
        .route("/api/instances/{iid}/start", post(instances::start))
        .route("/api/instances/{iid}/reprovision", post(instances::reprovision))
        .route("/api/instances/{iid}/pin/clear", post(instances::clear_pin))
        .route("/api/instances/{iid}/stop", post(instances::stop))
        .route("/api/instances/{iid}/status", get(instances::status))
        .route("/api/instances/{iid}/logs", get(instances::logs))
        .route("/api/instances/{iid}/register", post(instances::register))
        .route("/api/instances/{iid}/messages/threads", get(instances::threads))
        .route("/api/instances/{iid}/messages/delete", post(instances::messages_delete))
        .route("/api/instances/{iid}/messages/{peer}", get(instances::messages))
        .route("/api/instances/{iid}/sms/send", post(instances::sms_send))
        .route("/api/instances/{iid}/calls", get(instances::calls))
        .route("/api/instances/{iid}/calls/delete", post(instances::calls_delete))
        .route("/api/instances/{iid}/carrier-codecs", get(instances::carrier_codecs))
        .route("/api/instances/{iid}/call", post(instances::call))
        .route("/api/instances/{iid}/hangup", post(instances::hangup))
        .route("/api/instances/{iid}/softphone", get(instances::softphone))
        .route("/api/instances/{iid}/sipinfo", get(instances::sipinfo))
        .route("/api/engine/event", post(events::engine_event))
        .route("/api/esim/status", get(esim::status))
        .route("/api/esim/chip", get(esim::chip))
        .route("/api/esim/profiles", get(esim::profiles))
        .route("/api/esim/profiles/{iccid}/enable", post(esim::enable))
        .route("/api/esim/profiles/{iccid}/disable", post(esim::disable))
        .route("/api/esim/profiles/{iccid}", delete(esim::delete_profile))
        .route("/api/esim/profiles/{iccid}/nickname", post(esim::nickname))
        .route("/api/esim/download", post(esim::download))
        .route("/api/esim/download/cancel", post(esim::download_cancel))
        .route("/api/esim/discovery", post(esim::discovery))
        .route("/api/esim/notifications", get(esim::notifications))
        .route("/api/esim/notifications/process", post(esim::notifications_process))
        .route("/api/esim/notifications/{seq}", delete(esim::notification_remove))
        .route("/ws", get(ws_endpoint));

    let dir = webui_dir();
    let app = if dir.is_dir() {
        let index = dir.join("index.html");
        let spa = tower_http::services::ServeDir::new(&dir)
            .fallback(tower_http::services::ServeFile::new(index));
        api.fallback_service(spa)
    } else {
        tracing::warn!("WebUI not found at {} (set VOWIFI_WEBUI or build webui/dist)", dir.display());
        api.fallback(|| async { (StatusCode::NOT_FOUND, Json(json!({"error": "webui not built"}))) })
    };
    app.layer(middleware::from_fn(require_login)).with_state(hub)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_header() {
        let mut h = HeaderMap::new();
        h.insert(header::HOST, HeaderValue::from_static("gw.example:8443"));
        assert_eq!(request_host(&h), "gw.example");
        h.insert(header::HOST, HeaderValue::from_static("[2001:db8::1]:8443"));
        assert_eq!(request_host(&h), "[2001:db8::1]");
        h.insert(header::COOKIE, HeaderValue::from_static("a=1; vowifi_session=abc.def; b=2"));
        assert_eq!(cookie(&h, "vowifi_session").as_deref(), Some("abc.def"));
    }
}
