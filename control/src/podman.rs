//! podman.rs - Minimal Docker-Engine-API client for the user's ROOTLESS Podman socket.
//!
//! Talks to `DOCKER_HOST` (default `unix://$XDG_RUNTIME_DIR/podman/podman.sock`; `tcp://` also
//! works) through Podman's Docker-compatible API, versioned at /v1.41. Only the handful of
//! calls the manager needs are implemented, each one a plain request on a fresh connection
//! (no pooling: calls are rare and a stale pooled connection to a restarted podman.service
//! would only add failure modes):
//!
//!   inspect  GET    /containers/{name}/json
//!   remove   DELETE /containers/{name}?force=true
//!   create   POST   /containers/create?name=...   + start POST /containers/{id}/start
//!   logs     GET    /containers/{name}/logs?stdout=1&stderr=1&tail=N[&since=T]
//!   exec     POST   /containers/{name}/exec  + POST /exec/{id}/start
//!
//! Logs and exec output come back in the multiplexed stream format of a non-TTY container
//! (8-byte frame header: stream, 0, 0, 0, u32 BE length); `demux` strips the headers.
use std::path::PathBuf;
use std::time::Duration;

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::{Method, Request, StatusCode};
use hyper_util::rt::TokioIo;
use serde_json::{Value, json};

const API: &str = "/v1.41";
const TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone)]
enum Target {
    Unix(PathBuf),
    Tcp(String),
}

#[derive(Debug, Clone)]
pub struct Podman {
    target: Target,
}

#[derive(Debug, thiserror::Error)]
pub enum PodmanError {
    #[error("no such container")]
    NotFound,
    #[error("podman API {status}: {message}")]
    Api { status: u16, message: String },
    #[error("podman API unreachable: {0}")]
    Transport(String),
}

impl Podman {
    pub fn from_env() -> Self {
        let runtime = std::env::var("XDG_RUNTIME_DIR").ok().filter(|s| !s.is_empty())
            .unwrap_or_else(|| format!("/run/user/{}", nix::unistd::getuid()));
        let url = std::env::var("DOCKER_HOST").ok().filter(|s| !s.is_empty())
            .unwrap_or_else(|| format!("unix://{runtime}/podman/podman.sock"));
        let target = if let Some(p) = url.strip_prefix("unix://") {
            Target::Unix(PathBuf::from(p))
        } else if let Some(h) = url.strip_prefix("tcp://").or_else(|| url.strip_prefix("http://")) {
            Target::Tcp(h.trim_end_matches('/').to_string())
        } else {
            Target::Unix(PathBuf::from(url))
        };
        Podman { target }
    }

    async fn send(&self, method: Method, path: &str, body: Option<Value>) -> Result<(StatusCode, Bytes), PodmanError> {
        let fut = async {
            let req = Request::builder()
                .method(method)
                .uri(format!("{API}{path}"))
                .header("Host", "d")
                .header("Content-Type", "application/json")
                .body(Full::new(Bytes::from(body.map(|b| b.to_string()).unwrap_or_default())))
                .map_err(|e| PodmanError::Transport(e.to_string()))?;
            macro_rules! roundtrip {
                ($stream:expr) => {{
                    let (mut sender, conn) = hyper::client::conn::http1::handshake(TokioIo::new($stream))
                        .await.map_err(|e| PodmanError::Transport(e.to_string()))?;
                    tokio::spawn(async move { let _ = conn.await; });
                    let resp = sender.send_request(req).await.map_err(|e| PodmanError::Transport(e.to_string()))?;
                    let status = resp.status();
                    let body = resp.into_body().collect().await
                        .map_err(|e| PodmanError::Transport(e.to_string()))?.to_bytes();
                    Ok::<_, PodmanError>((status, body))
                }};
            }
            match &self.target {
                Target::Unix(p) => {
                    let s = tokio::net::UnixStream::connect(p).await
                        .map_err(|e| PodmanError::Transport(format!("{}: {e}", p.display())))?;
                    roundtrip!(s)
                }
                Target::Tcp(h) => {
                    let s = tokio::net::TcpStream::connect(h).await
                        .map_err(|e| PodmanError::Transport(format!("{h}: {e}")))?;
                    roundtrip!(s)
                }
            }
        };
        tokio::time::timeout(TIMEOUT, fut).await
            .map_err(|_| PodmanError::Transport("request timed out".into()))?
    }

    async fn call(&self, method: Method, path: &str, body: Option<Value>) -> Result<Bytes, PodmanError> {
        let (status, bytes) = self.send(method, path, body).await?;
        if status == StatusCode::NOT_FOUND {
            return Err(PodmanError::NotFound);
        }
        if !status.is_success() {
            let message = serde_json::from_slice::<Value>(&bytes).ok()
                .and_then(|v| v.get("message").and_then(Value::as_str).map(String::from))
                .unwrap_or_else(|| String::from_utf8_lossy(&bytes).trim().to_string());
            return Err(PodmanError::Api { status: status.as_u16(), message });
        }
        Ok(bytes)
    }

    /// `State.Status` of a container ("running", "exited", ...).
    pub async fn status(&self, name: &str) -> Result<String, PodmanError> {
        let b = self.call(Method::GET, &format!("/containers/{}/json", enc(name)), None).await?;
        let v: Value = serde_json::from_slice(&b).map_err(|e| PodmanError::Transport(e.to_string()))?;
        Ok(v.pointer("/State/Status").and_then(Value::as_str).unwrap_or("").to_string())
    }

    /// Force-remove; Ok(false) if it didn't exist.
    pub async fn remove(&self, name: &str) -> Result<bool, PodmanError> {
        match self.call(Method::DELETE, &format!("/containers/{}?force=true", enc(name)), None).await {
            Ok(_) => Ok(true),
            Err(PodmanError::NotFound) => Ok(false),
            Err(e) => Err(e),
        }
    }

    /// Create + start; returns the container id.
    pub async fn run(&self, name: &str, spec: &Value) -> Result<String, PodmanError> {
        let b = self.call(Method::POST, &format!("/containers/create?name={}", enc(name)), Some(spec.clone())).await?;
        let v: Value = serde_json::from_slice(&b).map_err(|e| PodmanError::Transport(e.to_string()))?;
        let id = v.get("Id").and_then(Value::as_str).unwrap_or(name).to_string();
        self.call(Method::POST, &format!("/containers/{}/start", enc(&id)), None).await?;
        Ok(id)
    }

    pub async fn logs(&self, name: &str, tail: usize, since: Option<i64>) -> Result<String, PodmanError> {
        let mut q = format!("/containers/{}/logs?stdout=1&stderr=1&tail={tail}", enc(name));
        if let Some(s) = since {
            q.push_str(&format!("&since={s}"));
        }
        let b = self.call(Method::GET, &q, None).await?;
        Ok(String::from_utf8_lossy(&demux(&b)).into_owned())
    }

    /// Run a command in the container and return its combined output.
    pub async fn exec(&self, name: &str, cmd: &[&str]) -> Result<String, PodmanError> {
        let b = self.call(Method::POST, &format!("/containers/{}/exec", enc(name)),
                          Some(json!({"AttachStdout": true, "AttachStderr": true, "Cmd": cmd}))).await?;
        let v: Value = serde_json::from_slice(&b).map_err(|e| PodmanError::Transport(e.to_string()))?;
        let id = v.get("Id").and_then(Value::as_str)
            .ok_or_else(|| PodmanError::Transport("exec create returned no Id".into()))?.to_string();
        let out = self.call(Method::POST, &format!("/exec/{id}/start"),
                            Some(json!({"Detach": false, "Tty": false}))).await?;
        Ok(String::from_utf8_lossy(&demux(&out)).into_owned())
    }
}

fn enc(s: &str) -> String {
    urlencoding::encode(s).into_owned()
}

/// Strip Docker stream-multiplexing frame headers. Input that doesn't look multiplexed (a TTY
/// container, or an API that sent raw text) is returned unchanged.
pub fn demux(b: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b.len() - i < 8 || !matches!(b[i], 0..=2) || b[i + 1..i + 4] != [0, 0, 0] {
            if i == 0 {
                return b.to_vec();
            }
            out.extend_from_slice(&b[i..]);
            break;
        }
        let len = u32::from_be_bytes([b[i + 4], b[i + 5], b[i + 6], b[i + 7]]) as usize;
        let start = i + 8;
        let end = (start + len).min(b.len());
        out.extend_from_slice(&b[start..end]);
        i = end;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::demux;

    #[test]
    fn demux_frames() {
        let mut b = vec![1, 0, 0, 0, 0, 0, 0, 3];
        b.extend_from_slice(b"abc");
        b.extend_from_slice(&[2, 0, 0, 0, 0, 0, 0, 2]);
        b.extend_from_slice(b"de");
        assert_eq!(demux(&b), b"abcde");
        assert_eq!(demux(b"plain text"), b"plain text");
        assert_eq!(demux(b""), b"");
    }
}
