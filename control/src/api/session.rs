//! api/session.rs - /api/auth/*: login status, Linux-account login, logout, logout everywhere.
use std::net::SocketAddr;

use axum::Json;
use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, HeaderValue, header};
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};

use super::{ApiError, ApiResult, AppState, Body, cookie};
use crate::auth;
use crate::hub::blocking;

fn with_cookie(mut r: Response, value: &str) -> Response {
    if let Ok(v) = HeaderValue::from_str(value) {
        r.headers_mut().append(header::SET_COOKIE, v);
    }
    r
}

fn session_cookie(token: &str) -> String {
    format!(
        "{}={token}; HttpOnly; Max-Age={}; Path=/; SameSite=strict; Secure",
        auth::COOKIE_NAME,
        auth::SESSION_TTL
    )
}

fn cleared_cookie() -> String {
    format!(
        "{}=\"\"; expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Max-Age=0; Path=/; SameSite=strict; Secure",
        auth::COOKIE_NAME
    )
}

pub async fn status(headers: HeaderMap) -> Json<Value> {
    let c = cookie(&headers, auth::COOKIE_NAME);
    Json(auth::status(c.as_deref()))
}

/// Linux-account login (PAM): user name + password of the service's own user.
pub async fn login(ConnectInfo(peer): ConnectInfo<SocketAddr>, body: Body) -> ApiResult<Response> {
    let ip = Some(peer.ip());
    let wait = auth::THROTTLE.retry_after(ip);
    if wait > 0 {
        return Err(ApiError::new(429, json!({"code": "throttled", "retry_after": wait,
                                             "message": format!("Too many failed attempts; try again in {wait} s")}))
            .header(header::RETRY_AFTER, wait.to_string()));
    }
    // Only real strings count (a number or object is a failed login, not a coerced one).
    let username = body
        .get("username")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let password = body
        .get("password")
        .and_then(Value::as_str)
        .map(String::from);
    let rhost = auth::canonical_ip(peer.ip()).to_string();
    let ok = match password {
        Some(pw) => blocking(move || auth::check_login(&username, &pw, Some(&rhost))).await,
        None => false,
    };
    if !ok {
        auth::THROTTLE.fail(ip);
        tracing::warn!("failed WebUI login from {}", peer.ip());
        return Err(ApiError::new(401, "wrong user name or password"));
    }
    auth::THROTTLE.ok(ip);
    let user = auth::service_user();
    tracing::info!("WebUI login as {user} from {}", peer.ip());
    let token = blocking({
        let u = user.clone();
        move || auth::new_session(&u)
    })
    .await?;
    Ok(with_cookie(
        Json(json!({"ok": true})).into_response(),
        &session_cookie(&token),
    ))
}

pub async fn logout() -> Response {
    with_cookie(Json(json!({"ok": true})).into_response(), &cleared_cookie())
}

/// Rotate the session key: every browser (this one included) must log in again.
pub async fn logout_all(
    State(hub): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let c = cookie(&headers, auth::COOKIE_NAME);
    if !auth::session_valid(c.as_deref()) {
        return Err(ApiError::new(401, "Login required"));
    }
    blocking(auth::logout_everywhere).await?;
    // Live feeds were authorised under the old key: drop them; their reconnect must log in.
    hub.close_all_ws();
    tracing::info!("WebUI: all sessions logged out by {}", peer.ip());
    Ok(logout().await)
}
