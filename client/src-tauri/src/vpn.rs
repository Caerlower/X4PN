/// VPN connection manager.
///
/// Single connect/disconnect lifecycle:
///  1. Generate WireGuard key pair
///  2. Register with server API → get assigned IP + server pubkey
///  3. Launch boringtun-cli subprocess
///  4. Poll until TUN interface is ready
///  5. Configure WireGuard peer (UAPI socket, wg CLI fallback)
///  6. Save original gateway + DNS
///  7. Configure full-tunnel routing
///  8. Set DNS
///
/// On disconnect: reverse all steps, restore original state.
/// On any failure: rollback all completed steps automatically.
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

#[cfg(unix)]
use std::os::unix::net::UnixStream;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use hkdf::Hkdf;
use k256::ecdsa::SigningKey;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use sha3::{Digest, Keccak256};
use tauri::Emitter;
use tokio_util::sync::CancellationToken;
use x25519_dalek::{PublicKey, StaticSecret};

// ── Server config (env overridable) ──────────────────────────────────────────

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

lazy_static::lazy_static! {
    static ref API_BASE: String = env_or("X4PN_API_BASE", "http://204.168.211.96:8080");
    static ref SERVER_IP: String = env_or("X4PN_SERVER_IP", "204.168.211.96");
    static ref GATEWAY_API: String = env_or("X4PN_GATEWAY_API", "https://gateway-api-testnet.circle.com");
}
const ARC_DOMAIN: u32 = 26;

// ── Types ────────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ConnectedInfo {
    pub assigned_ip: String,
    pub server_endpoint: String,
    pub wallet_address: String,
    pub gateway_balance: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VpnStatus {
    Disconnected,
    Connecting,
    Connected,
    Disconnecting,
    Error,
}

#[derive(Debug, Clone, Serialize)]
pub struct VpnStateEvent {
    pub status: VpnStatus,
    pub assigned_ip: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct HealthEvent {
    pub connected: bool,
    pub process_alive: bool,
    pub handshake_age_secs: Option<u64>,
}

#[derive(Debug, Deserialize)]
pub struct PaidSessionRegistration {
    pub server_public_key: String,
    pub endpoint: String,
    pub assigned_ip: String,
    #[serde(default)]
    pub expires_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RegisterResponse {
    server_public_key: String,
    endpoint: String,
    assigned_ip: String,
}

/// Saved system state for restoring on disconnect.
struct ConnectionContext {
    iface: String,
    boringtun_proc: Child,
    original_gateway: String,
    #[allow(dead_code)]
    original_phys_iface: String,
    original_dns: OriginalDns,
    server_ip: String,
    health_cancel: CancellationToken,
}

#[cfg(target_os = "macos")]
struct OriginalDns {
    service: String,
    servers: Vec<String>,
}

#[cfg(target_os = "linux")]
struct OriginalDns {
    resolv_conf_backup: String,
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
struct OriginalDns;

// ── VpnManager ───────────────────────────────────────────────────────────────

pub struct VpnManager {
    ctx: Option<ConnectionContext>,
}

impl VpnManager {
    pub fn new() -> Self {
        VpnManager { ctx: None }
    }

    pub fn is_connected(&self) -> bool {
        self.ctx.is_some()
    }

    pub fn status(&self) -> VpnStatus {
        if self.ctx.is_some() {
            VpnStatus::Connected
        } else {
            VpnStatus::Disconnected
        }
    }

    /// Connect after x402 payment — registration already done via POST /connect.
    pub async fn connect_paid(
        &mut self,
        app_handle: tauri::AppHandle,
        reg: PaidSessionRegistration,
        server_ip: Option<String>,
        algorand_address: Option<String>,
    ) -> Result<ConnectedInfo, String> {
        if self.ctx.is_some() {
            return Err("Already connected".into());
        }

        let active_server_ip = server_ip.as_deref().unwrap_or(&SERVER_IP);
        let server_pub = reg.server_public_key;
        let assigned_ip = reg.assigned_ip.clone();
        let endpoint = reg.endpoint;
        let ip_bare = assigned_ip
            .split('/')
            .next()
            .unwrap_or(&assigned_ip)
            .to_string();

        log::info!(
            "[vpn] x402 session: server_pub={server_pub} ip={assigned_ip} endpoint={endpoint} expires={:?}",
            reg.expires_at
        );

        self.establish_tunnel(
            app_handle,
            active_server_ip,
            server_pub,
            assigned_ip,
            endpoint,
            ip_bare,
            algorand_address.unwrap_or_else(|| "algorand".into()),
        )
        .await
    }

    pub async fn connect(
        &mut self,
        app_handle: tauri::AppHandle,
        world_proof: Option<serde_json::Value>,
        server_ip: Option<String>,
    ) -> Result<ConnectedInfo, String> {
        if self.ctx.is_some() {
            return Err("Already connected".into());
        }

        let active_server_ip = server_ip.as_deref().unwrap_or(&SERVER_IP);
        let active_api_base = format!("http://{}:8080", active_server_ip);

        // ── 1. Load or generate persistent key pair + derive wallet ────────
        let private = load_or_create_key()?;
        let public = PublicKey::from(&private);
        let priv_b64 = B64.encode(private.as_bytes());
        let pub_b64 = B64.encode(public.as_bytes());

        let wallet_address = derive_evm_address(private.as_bytes());
        log::info!("[vpn] derived wallet: {wallet_address}");

        // ── 2. Register with server (legacy direct API — dev only) ─────────
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .map_err(|e| format!("HTTP client error: {e}"))?;

        let mut body = serde_json::json!({ "public_key": pub_b64 });
        if let Some(proof) = world_proof {
            body["world_proof"] = proof;
        }

        let resp = client
            .post(format!("{}/v1/register", active_api_base))
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Failed to reach server: {e}"))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("Server returned {status}: {text}"));
        }

        let reg: RegisterResponse = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse register response: {e}"))?;

        let server_pub = reg.server_public_key;
        let assigned_ip = reg.assigned_ip.clone();
        let endpoint = reg.endpoint;
        let ip_bare = assigned_ip
            .split('/')
            .next()
            .unwrap_or(&assigned_ip)
            .to_string();

        log::info!("[vpn] registered: server_pub={server_pub} ip={assigned_ip} endpoint={endpoint}");

        self.establish_tunnel(
            app_handle,
            active_server_ip,
            server_pub,
            assigned_ip,
            endpoint,
            ip_bare,
            wallet_address,
        )
        .await
    }

    async fn establish_tunnel(
        &mut self,
        app_handle: tauri::AppHandle,
        active_server_ip: &str,
        server_pub: String,
        assigned_ip: String,
        endpoint: String,
        ip_bare: String,
        wallet_address: String,
    ) -> Result<ConnectedInfo, String> {
        let private = load_or_create_key()?;
        let priv_b64 = B64.encode(private.as_bytes());

        // ── 3. Launch boringtun-cli ────────────────────────────────────────
        kill_stale_client_boringtun();
        let iface = find_available_iface()?;
        let boringtun_path = boringtun_binary()?;

        let BoringtunSpawn { proc, tunnel_pid } =
            spawn_client_boringtun(&boringtun_path, &iface)?;

        // From here, every error must clean up previous steps.
        let mut cleanup = Cleanup::new();
        let _iface_clone = iface.clone();
        cleanup.push("kill client boringtun", move || {
            let _ = Command::new("pkill")
                .args(["-f", CLIENT_TUNNEL_PKILL_PATTERN])
                .status();
            let _ = Command::new("sudo")
                .args(["-n", "pkill", "-f", CLIENT_TUNNEL_PKILL_PATTERN])
                .status();
            std::thread::sleep(Duration::from_millis(200));
        });

        if !client_tunnel_process_alive() {
            cleanup.run();
            let log_tail = boringtun_log_tail();
            return Err(format!(
                "boringtun-cli is not running. {SUDO_HINT} Log: {log_tail}"
            ));
        }

        // ── 4. Wait for interface + UAPI socket ────────────────────────────
        if let Err(e) = wait_for_interface(&iface, Duration::from_secs(10)).await {
            cleanup.run();
            return Err(e);
        }

        let uapi_iface = match wait_and_resolve_uapi_iface(&iface, Duration::from_secs(20)) {
            Ok(name) => name,
            Err(e) => {
                cleanup.run();
                return Err(e);
            }
        };
        if uapi_iface != iface {
            log::info!("[vpn] resolved UAPI interface {iface} -> {uapi_iface}");
        }

        // ── 5. Configure WireGuard peer ────────────────────────────────────
        if let Err(e) = configure_wireguard(&uapi_iface, &priv_b64, &server_pub, &endpoint) {
            cleanup.run();
            return Err(e);
        }

        // ── 6. Set interface IP and bring up ───────────────────────────────
        if let Err(e) = configure_interface_ip(&uapi_iface, &ip_bare, &assigned_ip) {
            cleanup.run();
            return Err(e);
        }

        let iface_clone2 = uapi_iface.clone();
        cleanup.push("teardown interface", move || {
            teardown_interface(&iface_clone2);
        });

        // ── 7. Save original gateway + DNS ─────────────────────────────────
        let original_gw = match get_default_gateway() {
            Ok(gw) => gw,
            Err(e) => {
                cleanup.run();
                return Err(format!("Failed to get default gateway: {e}"));
            }
        };

        let original_dns = match save_original_dns() {
            Ok(dns) => dns,
            Err(e) => {
                cleanup.run();
                return Err(format!("Failed to save DNS state: {e}"));
            }
        };

        #[cfg(target_os = "macos")]
        let original_phys_iface = get_default_interface().unwrap_or_else(|_| "en0".into());
        #[cfg(not(target_os = "macos"))]
        let original_phys_iface = String::new();

        log::info!("[vpn] original gateway={original_gw} iface={original_phys_iface}");

        // ── 8. Configure full-tunnel routing ───────────────────────────────
        if let Err(e) = configure_full_tunnel(&uapi_iface, active_server_ip, &original_gw) {
            cleanup.run();
            return Err(e);
        }

        let iface_clone3 = uapi_iface.clone();
        let gw_clone = original_gw.clone();
        let server_ip_clone = active_server_ip.to_string();
        cleanup.push("teardown routes", move || {
            teardown_routes(&iface_clone3, &server_ip_clone, &gw_clone);
        });

        // ── 9. Set DNS ─────────────────────────────────────────────────────
        if let Err(e) = set_vpn_dns() {
            cleanup.run();
            return Err(e);
        }

        cleanup.push("restore DNS", move || {
            let _ = restore_dns_best_effort();
        });

        // ── Success: disarm cleanup, store context ─────────────────────────
        cleanup.disarm();

        let health_cancel = CancellationToken::new();
        start_health_check(app_handle, uapi_iface.clone(), health_cancel.clone(), tunnel_pid);

        self.ctx = Some(ConnectionContext {
            iface: uapi_iface,
            boringtun_proc: proc,
            original_gateway: original_gw,
            original_phys_iface,
            original_dns,
            server_ip: active_server_ip.to_string(),
            health_cancel,
        });

        // ── 10. Session info ───────────────────────────────────────────────
        let gateway_balance = if wallet_address.starts_with("0x") {
            query_gateway_balance(&wallet_address)
                .await
                .unwrap_or_else(|e| {
                    log::warn!("[vpn] balance query failed: {e}");
                    "0.000000".to_string()
                })
        } else {
            "paid via x402".to_string()
        };

        Ok(ConnectedInfo {
            assigned_ip: ip_bare,
            server_endpoint: endpoint,
            wallet_address,
            gateway_balance,
        })
    }

    pub fn disconnect(&mut self) -> Result<(), String> {
        let mut ctx = self
            .ctx
            .take()
            .ok_or_else(|| "Not connected".to_string())?;

        log::info!("[vpn] disconnecting...");

        // Stop health check
        ctx.health_cancel.cancel();

        // Restore DNS first (while we still have connectivity context)
        let _ = restore_dns(&ctx.original_dns);

        // Remove full-tunnel routes
        teardown_routes(&ctx.iface, &ctx.server_ip, &ctx.original_gateway);

        // Tear down interface
        teardown_interface(&ctx.iface);

        // Kill client tunnel only (never pkill the server boringtun on :8080)
        let _ = ctx.boringtun_proc.kill();
        let _ = ctx.boringtun_proc.wait();
        kill_stale_client_boringtun();

        log::info!("[vpn] disconnected");
        Ok(())
    }

    /// Check if tunnel is healthy. Used by health check loop.
    pub fn check_health(&mut self) -> HealthEvent {
        let ctx = match &mut self.ctx {
            Some(c) => c,
            None => {
                return HealthEvent {
                    connected: false,
                    process_alive: false,
                    handshake_age_secs: None,
                }
            }
        };

        let process_alive = match ctx.boringtun_proc.try_wait() {
            Ok(None) => true,  // still running
            Ok(Some(_)) => false, // exited
            Err(_) => false,
        };

        let handshake_age = get_handshake_age(&ctx.iface);

        let connected = process_alive && handshake_age.map(|a| a < 600).unwrap_or(true);

        HealthEvent {
            connected,
            process_alive,
            handshake_age_secs: handshake_age,
        }
    }
}

// ── Cleanup guard ────────────────────────────────────────────────────────────

struct Cleanup {
    steps: Vec<(&'static str, Box<dyn FnOnce() + Send>)>,
    armed: bool,
}

impl Cleanup {
    fn new() -> Self {
        Cleanup {
            steps: Vec::new(),
            armed: true,
        }
    }

    fn push<F: FnOnce() + Send + 'static>(&mut self, name: &'static str, f: F) {
        self.steps.push((name, Box::new(f)));
    }

    fn disarm(&mut self) {
        self.armed = false;
    }

    fn run(&mut self) {
        if !self.armed {
            return;
        }
        self.armed = false;
        for (name, step) in self.steps.drain(..).rev() {
            log::info!("[vpn] cleanup: {name}");
            step();
        }
    }
}

impl Drop for Cleanup {
    fn drop(&mut self) {
        if self.armed {
            self.run();
        }
    }
}

// ── Health check ─────────────────────────────────────────────────────────────

fn start_health_check(
    app_handle: tauri::AppHandle,
    iface: String,
    cancel: CancellationToken,
    tunnel_pid: u32,
) {
    tokio::spawn(async move {
        // Grace period after connect — tunnel + handshake need time on localhost
        tokio::time::sleep(Duration::from_secs(10)).await;

        let mut dead_checks = 0u32;

        loop {
            tokio::select! {
                _ = cancel.cancelled() => break,
                _ = tokio::time::sleep(Duration::from_secs(5)) => {
                    let process_alive =
                        is_tunnel_process_alive(tunnel_pid) || client_tunnel_process_alive();

                    if process_alive {
                        dead_checks = 0;
                    } else {
                        dead_checks += 1;
                    }

                    let handshake_age = get_handshake_age(&iface);
                    let connected = process_alive
                        && handshake_age.map(|a| a < 600).unwrap_or(true);

                    let event = HealthEvent {
                        connected,
                        process_alive,
                        handshake_age_secs: handshake_age,
                    };

                    let _ = app_handle.emit("vpn-health", &event);

                    if dead_checks >= 3 {
                        let _ = app_handle.emit("vpn-state", &VpnStateEvent {
                            status: VpnStatus::Error,
                            assigned_ip: None,
                            error: Some(
                                "VPN tunnel stopped. Click DISCONNECT, run sudo -v, then CONNECT again."
                                    .into(),
                            ),
                        });
                        break;
                    }
                }
            }
        }
    });
}

fn is_tunnel_process_alive(pid: u32) -> bool {
    Command::new("sudo")
        .args(["-n", "kill", "-0", &pid.to_string()])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn get_handshake_age(iface: &str) -> Option<u64> {
    uapi_get_handshake_age(iface).or_else(|| wg_cli_get_handshake_age(iface))
}

#[cfg(unix)]
fn uapi_get_handshake_age(iface: &str) -> Option<u64> {
    let response = uapi_get_raw(iface).ok()?;
    let mut last_sec: Option<u64> = None;
    for line in response.lines() {
        if let Some(val) = line.strip_prefix("last_handshake_time_sec=") {
            last_sec = val.parse().ok();
        }
    }
    let sec = last_sec?;
    if sec == 0 {
        return None;
    }
    // boringtun UAPI reports seconds since last handshake (not unix epoch)
    Some(sec)
}

#[cfg(not(unix))]
fn uapi_get_handshake_age(_iface: &str) -> Option<u64> {
    None
}

fn wg_cli_get_handshake_age(iface: &str) -> Option<u64> {
    let output = Command::new("sudo")
        .arg("-n")
        .args(["wg", "show", iface, "latest-handshakes"])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let text = String::from_utf8_lossy(&output.stdout);
    let ts_str = text.split_whitespace().nth(1)?;
    let ts: u64 = ts_str.parse().ok()?;
    if ts == 0 {
        return None;
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs();
    Some(now.saturating_sub(ts))
}

// ── WireGuard configuration ─────────────────────────────────────────────────

const UAPI_SOCK_DIR: &str = "/var/run/wireguard";

fn wg_key_b64_to_hex(b64: &str) -> Result<String, String> {
    let bytes = B64
        .decode(b64.trim())
        .map_err(|e| format!("invalid WireGuard key (base64): {e}"))?;
    if bytes.len() != 32 {
        return Err(format!("invalid WireGuard key length: {}", bytes.len()));
    }
    Ok(hex::encode(bytes))
}

#[cfg(unix)]
fn find_uapi_socket_for_hint(hint: &str) -> Option<String> {
    let exact = format!("{UAPI_SOCK_DIR}/{hint}.sock");
    if std::path::Path::new(&exact).exists() {
        return Some(hint.to_string());
    }

    let dir = std::fs::read_dir(UAPI_SOCK_DIR).ok()?;
    for entry in dir.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with(hint) && name.ends_with(".sock") {
            return Some(name.trim_end_matches(".sock").to_string());
        }
    }
    None
}

/// Wait until boringtun creates its UAPI socket file (root-owned; do not require user connect).
#[cfg(unix)]
fn wait_and_resolve_uapi_iface(hint: &str, timeout: Duration) -> Result<String, String> {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if let Some(resolved) = find_uapi_socket_for_hint(hint) {
            return Ok(resolved);
        }
        std::thread::sleep(Duration::from_millis(200));
    }

    let log_hint = std::fs::read_to_string("/tmp/boringtun.log")
        .ok()
        .map(|s| {
            let tail: String = s.chars().rev().take(200).collect();
            format!(" Log: {}", tail.chars().rev().collect::<String>())
        })
        .filter(|s| s.len() > 6)
        .unwrap_or_default();

    Err(format!(
        "WireGuard UAPI socket not ready for {hint} in {UAPI_SOCK_DIR}.{log_hint} \
         Run sudo -v in Terminal, then CONNECT again."
    ))
}

#[cfg(not(unix))]
fn wait_and_resolve_uapi_iface(_hint: &str, _timeout: Duration) -> Result<String, String> {
    Err("WireGuard UAPI is not supported on this platform".into())
}

#[cfg(unix)]
fn uapi_get_raw(iface: &str) -> Result<String, String> {
    let path = format!("{UAPI_SOCK_DIR}/{iface}.sock");
    uapi_get_privileged(&path).or_else(|_| uapi_get_direct(&path))
}

#[cfg(unix)]
fn uapi_get_direct(path: &str) -> Result<String, String> {
    let mut stream =
        UnixStream::connect(path).map_err(|e| format!("UAPI connect {path}: {e}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .ok();
    stream
        .write_all(b"get=1\n\n")
        .map_err(|e| format!("UAPI write: {e}"))?;
    let reader = BufReader::new(stream);
    let mut response = String::new();
    for line in reader.lines() {
        let line = line.map_err(|e| format!("UAPI read: {e}"))?;
        response.push_str(&line);
        response.push('\n');
    }
    Ok(response)
}

#[cfg(unix)]
fn uapi_get_privileged(path: &str) -> Result<String, String> {
    let mut child = Command::new("sudo")
        .arg("-n")
        .arg("nc")
        .arg("-U")
        .arg(path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("sudo nc UAPI get failed: {e}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(b"get=1\n\n")
            .map_err(|e| format!("UAPI get stdin: {e}"))?;
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("UAPI get wait: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("UAPI get failed: {}", stderr.trim()));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[cfg(unix)]
fn uapi_run_set(iface: &str, config_body: &str) -> Result<(), String> {
    let path = format!("{UAPI_SOCK_DIR}/{iface}.sock");
    let payload = format!("set=1\n{config_body}");
    // Client boringtun runs as root — socket is root-owned; prefer sudo nc.
    let response = uapi_exchange_privileged(&path, &payload)
        .or_else(|_| uapi_exchange_direct(&path, &payload))?;
    if response.trim().starts_with("errno=0") {
        Ok(())
    } else {
        Err(format!("WireGuard UAPI set failed: {}", response.trim()))
    }
}

#[cfg(not(unix))]
fn uapi_run_set(_iface: &str, _config_body: &str) -> Result<(), String> {
    Err("WireGuard UAPI is not supported on this platform".into())
}

#[cfg(unix)]
fn uapi_exchange_direct(path: &str, payload: &str) -> Result<String, String> {
    let mut stream =
        UnixStream::connect(path).map_err(|e| format!("UAPI connect {path}: {e}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .ok();
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .ok();
    stream
        .write_all(payload.as_bytes())
        .map_err(|e| format!("UAPI write: {e}"))?;
    let mut reader = BufReader::new(stream);
    let mut response = String::new();
    reader
        .read_line(&mut response)
        .map_err(|e| format!("UAPI read: {e}"))?;
    Ok(response)
}

#[cfg(unix)]
fn uapi_exchange_privileged(path: &str, payload: &str) -> Result<String, String> {
    let mut child = Command::new("sudo")
        .arg("-n")
        .arg("nc")
        .arg("-U")
        .arg(path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("sudo nc UAPI failed: {e}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(payload.as_bytes())
            .map_err(|e| format!("UAPI stdin write: {e}"))?;
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("UAPI nc wait: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "UAPI via sudo nc failed: {}",
            stderr.trim()
        ));
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn wg_binary() -> Option<String> {
    if let Ok(path) = std::env::var("X4PN_WG_CLI") {
        if std::path::Path::new(&path).exists() {
            return Some(path);
        }
    }

    for path in [
        "/opt/homebrew/bin/wg",
        "/usr/local/bin/wg",
        "/opt/local/bin/wg",
    ] {
        if std::path::Path::new(path).exists() {
            return Some(path.to_string());
        }
    }

    Command::new("which")
        .arg("wg")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
}

fn configure_wireguard_wg_cli(
    iface: &str,
    priv_key: &str,
    server_pub: &str,
    endpoint: &str,
    wg_path: &str,
) -> Result<(), String> {
    let key_file = format!("/tmp/x4pn_{iface}.key");
    std::fs::write(&key_file, priv_key).map_err(|e| format!("Failed to write key file: {e}"))?;

    let result = run_sudo(&[
        wg_path,
        "set",
        iface,
        "private-key",
        &key_file,
        "peer",
        server_pub,
        "allowed-ips",
        "0.0.0.0/0",
        "endpoint",
        endpoint,
        "persistent-keepalive",
        "25",
    ]);

    let _ = std::fs::remove_file(&key_file);
    result
}

fn configure_wireguard(
    iface: &str,
    priv_key: &str,
    server_pub: &str,
    endpoint: &str,
) -> Result<(), String> {
    let private_key_hex = wg_key_b64_to_hex(priv_key)?;
    let peer_key_hex = wg_key_b64_to_hex(server_pub)?;
    let config = format!(
        "private_key={private_key_hex}\npublic_key={peer_key_hex}\nreplace_allowed_ips=true\nallowed_ip=0.0.0.0/0\nendpoint={endpoint}\npersistent_keepalive_interval=25\n\n"
    );

    if let Ok(()) = uapi_run_set(iface, &config) {
        return Ok(());
    }

    if let Some(wg_path) = wg_binary() {
        return configure_wireguard_wg_cli(iface, priv_key, server_pub, endpoint, &wg_path);
    }

    Err(
        "Could not configure WireGuard tunnel via UAPI. Run sudo -v, or: brew install wireguard-tools"
            .into(),
    )
}

// ── Interface IP configuration ───────────────────────────────────────────────

#[cfg(target_os = "macos")]
fn configure_interface_ip(iface: &str, ip_bare: &str, _assigned_ip: &str) -> Result<(), String> {
    run_sudo(&["ifconfig", iface, ip_bare, ip_bare, "up"])
}

#[cfg(target_os = "linux")]
fn configure_interface_ip(iface: &str, _ip_bare: &str, assigned_ip: &str) -> Result<(), String> {
    let ip_cidr = if assigned_ip.contains('/') {
        assigned_ip.to_string()
    } else {
        format!("{assigned_ip}/32")
    };
    run_sudo(&["ip", "addr", "add", &ip_cidr, "dev", iface])?;
    run_sudo(&["ip", "link", "set", iface, "up"])
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn configure_interface_ip(_: &str, _: &str, _: &str) -> Result<(), String> {
    Err("Unsupported platform".into())
}

// ── Full-tunnel routing ──────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
fn configure_full_tunnel(iface: &str, server_ip: &str, original_gw: &str) -> Result<(), String> {
    // Find the physical interface for the default route (e.g. en0)
    let _phys_iface = get_default_interface().unwrap_or_else(|_| "en0".to_string());

    // 1. Explicit route for server via original gateway on physical interface
    //    This MUST come before the split routes so WG UDP packets bypass the tunnel
    run_sudo(&[
        "route", "add", "-host", server_ip, original_gw,
    ])?;
    // 2. Split default: 0.0.0.0/1 + 128.0.0.0/1 override default without deleting it
    run_sudo(&["route", "add", "-net", "0.0.0.0/1", "-interface", iface])?;
    run_sudo(&["route", "add", "-net", "128.0.0.0/1", "-interface", iface])?;
    Ok(())
}

#[cfg(target_os = "linux")]
fn configure_full_tunnel(iface: &str, _server_ip: &str, _original_gw: &str) -> Result<(), String> {
    // fwmark approach (same as wg-quick)
    run_sudo(&["wg", "set", iface, "fwmark", "51820"])?;
    run_sudo(&["ip", "rule", "add", "not", "fwmark", "51820", "table", "51820"])?;
    run_sudo(&["ip", "route", "add", "default", "dev", iface, "table", "51820"])?;
    run_sudo(&[
        "ip", "rule", "add", "table", "main", "suppress_prefixlength", "0",
    ])?;
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn configure_full_tunnel(_: &str, _: &str, _: &str) -> Result<(), String> {
    Err("Unsupported platform".into())
}

#[cfg(target_os = "macos")]
fn teardown_routes(iface: &str, server_ip: &str, _original_gw: &str) {
    let _ = run_sudo(&["route", "delete", "-net", "0.0.0.0/1", "-interface", iface]);
    let _ = run_sudo(&["route", "delete", "-net", "128.0.0.0/1", "-interface", iface]);
    let _ = run_sudo(&["route", "delete", "-host", server_ip]);
}

#[cfg(target_os = "linux")]
fn teardown_routes(iface: &str, _server_ip: &str, _original_gw: &str) {
    let _ = run_sudo(&["ip", "rule", "delete", "not", "fwmark", "51820", "table", "51820"]);
    let _ = run_sudo(&["ip", "rule", "delete", "table", "main", "suppress_prefixlength", "0"]);
    let _ = run_sudo(&["ip", "route", "flush", "table", "51820"]);
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn teardown_routes(_: &str, _: &str, _: &str) {}

// ── Default gateway detection ────────────────────────────────────────────────

#[cfg(target_os = "macos")]
fn get_default_gateway() -> Result<String, String> {
    let output = Command::new("route")
        .args(["-n", "get", "default"])
        .output()
        .map_err(|e| format!("route -n get default failed: {e}"))?;

    let text = String::from_utf8_lossy(&output.stdout);
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("gateway:") {
            return Ok(trimmed
                .strip_prefix("gateway:")
                .unwrap()
                .trim()
                .to_string());
        }
    }
    Err("Could not determine default gateway".into())
}

#[cfg(target_os = "macos")]
fn get_default_interface() -> Result<String, String> {
    let output = Command::new("route")
        .args(["-n", "get", "default"])
        .output()
        .map_err(|e| format!("route -n get default failed: {e}"))?;

    let text = String::from_utf8_lossy(&output.stdout);
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("interface:") {
            return Ok(trimmed
                .strip_prefix("interface:")
                .unwrap()
                .trim()
                .to_string());
        }
    }
    Err("Could not determine default interface".into())
}

#[cfg(target_os = "linux")]
fn get_default_gateway() -> Result<String, String> {
    let output = Command::new("ip")
        .args(["route", "show", "default"])
        .output()
        .map_err(|e| format!("ip route show default failed: {e}"))?;

    let text = String::from_utf8_lossy(&output.stdout);
    // "default via 192.168.1.1 dev eth0 ..."
    let parts: Vec<&str> = text.split_whitespace().collect();
    if parts.len() >= 3 && parts[0] == "default" && parts[1] == "via" {
        return Ok(parts[2].to_string());
    }
    Err("Could not determine default gateway".into())
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn get_default_gateway() -> Result<String, String> {
    Err("Unsupported platform".into())
}

// ── DNS management ───────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
fn get_primary_network_service() -> Result<String, String> {
    // Find the interface used for default route
    let output = Command::new("route")
        .args(["-n", "get", "default"])
        .output()
        .map_err(|e| format!("route failed: {e}"))?;

    let text = String::from_utf8_lossy(&output.stdout);
    let mut iface = None;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("interface:") {
            iface = Some(
                trimmed
                    .strip_prefix("interface:")
                    .unwrap()
                    .trim()
                    .to_string(),
            );
            break;
        }
    }

    let iface = iface.ok_or("Could not find default interface")?;

    // Map interface to network service name
    let output = Command::new("networksetup")
        .args(["-listallhardwareports"])
        .output()
        .map_err(|e| format!("networksetup failed: {e}"))?;

    let text = String::from_utf8_lossy(&output.stdout);
    let mut current_service = String::new();
    for line in text.lines() {
        if let Some(name) = line.strip_prefix("Hardware Port: ") {
            current_service = name.to_string();
        }
        if let Some(dev) = line.strip_prefix("Device: ") {
            if dev.trim() == iface {
                return Ok(current_service);
            }
        }
    }

    // Fallback
    Ok("Wi-Fi".to_string())
}

#[cfg(target_os = "macos")]
fn save_original_dns() -> Result<OriginalDns, String> {
    let service = get_primary_network_service()?;

    let output = Command::new("networksetup")
        .args(["-getdnsservers", &service])
        .output()
        .map_err(|e| format!("networksetup -getdnsservers failed: {e}"))?;

    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();

    let servers = if text.contains("any DNS Servers set") {
        vec![] // no custom DNS configured
    } else {
        text.lines().map(|l| l.trim().to_string()).collect()
    };

    log::info!("[vpn] saved DNS for service={service}: {servers:?}");

    Ok(OriginalDns { service, servers })
}

#[cfg(target_os = "macos")]
fn set_vpn_dns() -> Result<(), String> {
    let service = get_primary_network_service()?;
    // Use public DNS that will be routed through the tunnel
    run_sudo(&[
        "networksetup",
        "-setdnsservers",
        &service,
        "1.1.1.1",
        "8.8.8.8",
    ])
}

#[cfg(target_os = "macos")]
fn restore_dns(dns: &OriginalDns) -> Result<(), String> {
    if dns.servers.is_empty() {
        // Reset to DHCP-provided DNS
        run_sudo(&["networksetup", "-setdnsservers", &dns.service, "Empty"])
    } else {
        let mut args = vec!["networksetup", "-setdnsservers", &dns.service];
        let refs: Vec<&str> = dns.servers.iter().map(|s| s.as_str()).collect();
        args.extend(refs);
        run_sudo(&args)
    }
}

#[cfg(target_os = "macos")]
fn restore_dns_best_effort() -> Result<(), String> {
    // Used during cleanup when we may not have the original context
    let service = get_primary_network_service().unwrap_or_else(|_| "Wi-Fi".into());
    run_sudo(&["networksetup", "-setdnsservers", &service, "Empty"])
}

#[cfg(target_os = "linux")]
fn save_original_dns() -> Result<OriginalDns, String> {
    let content = std::fs::read_to_string("/etc/resolv.conf")
        .unwrap_or_default();
    Ok(OriginalDns {
        resolv_conf_backup: content,
    })
}

#[cfg(target_os = "linux")]
fn set_vpn_dns() -> Result<(), String> {
    // Write DNS through resolvconf if available, otherwise direct write
    let output = Command::new("which")
        .arg("resolvconf")
        .output();

    if output.map(|o| o.status.success()).unwrap_or(false) {
        let child = Command::new("sudo")
            .arg("-n")
            .args(["resolvconf", "-a", "tun.x4pn"])
            .stdin(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("resolvconf failed: {e}"))?;

        if let Some(mut stdin) = child.stdin {
            use std::io::Write;
            let _ = write!(stdin, "nameserver 1.1.1.1\nnameserver 8.8.8.8\n");
        }
    } else {
        std::fs::write(
            "/etc/resolv.conf",
            "# Set by X4PN\nnameserver 1.1.1.1\nnameserver 8.8.8.8\n",
        )
        .map_err(|e| format!("Failed to write resolv.conf: {e}"))?;
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn restore_dns(dns: &OriginalDns) -> Result<(), String> {
    if !dns.resolv_conf_backup.is_empty() {
        std::fs::write("/etc/resolv.conf", &dns.resolv_conf_backup)
            .map_err(|e| format!("Failed to restore resolv.conf: {e}"))?;
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn restore_dns_best_effort() -> Result<(), String> {
    // Try resolvconf first
    let _ = Command::new("sudo")
        .args(["-n", "resolvconf", "-d", "tun.x4pn"])
        .status();
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn save_original_dns() -> Result<OriginalDns, String> {
    Ok(OriginalDns)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn set_vpn_dns() -> Result<(), String> {
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn restore_dns(_: &OriginalDns) -> Result<(), String> {
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn restore_dns_best_effort() -> Result<(), String> {
    Ok(())
}

// ── Interface readiness polling ──────────────────────────────────────────────

async fn wait_for_interface(iface: &str, timeout: Duration) -> Result<(), String> {
    let start = Instant::now();
    loop {
        if interface_exists(iface) {
            return Ok(());
        }
        if start.elapsed() > timeout {
            return Err(format!(
                "Interface {iface} not ready after {}s",
                timeout.as_secs()
            ));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[cfg(target_os = "macos")]
fn interface_exists(iface: &str) -> bool {
    Command::new("ifconfig")
        .arg(iface)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[cfg(target_os = "linux")]
fn interface_exists(iface: &str) -> bool {
    std::path::Path::new(&format!("/sys/class/net/{iface}")).exists()
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn interface_exists(_: &str) -> bool {
    false
}

// ── Interface teardown ───────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
fn teardown_interface(iface: &str) {
    let _ = run_sudo(&["ifconfig", iface, "down"]);
    let _ = run_sudo(&["ifconfig", iface, "destroy"]);
}

#[cfg(target_os = "linux")]
fn teardown_interface(iface: &str) {
    let _ = run_sudo(&["ip", "link", "delete", iface]);
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn teardown_interface(_: &str) {}

// ── Helpers ──────────────────────────────────────────────────────────────────

fn boringtun_binary() -> Result<String, String> {
    if let Ok(path) = std::env::var("X4PN_BORINGTUN_CLI") {
        if std::path::Path::new(&path).exists() {
            return Ok(path);
        }
    }

    let manifest = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let workspace = manifest.join("../..");
    let candidates = [
        workspace.join("target/release/boringtun-cli"),
        workspace.join("target/debug/boringtun-cli"),
        manifest.join("../../../target/release/boringtun-cli"),
        std::path::PathBuf::from("/usr/local/bin/boringtun-cli"),
        std::path::PathBuf::from("/opt/homebrew/bin/boringtun-cli"),
    ];

    for path in &candidates {
        if path.exists() {
            return Ok(path.to_string_lossy().to_string());
        }
    }

    let output = Command::new("which")
        .arg("boringtun-cli")
        .output()
        .map_err(|_| "boringtun-cli not found".to_string())?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err(format!(
            "boringtun-cli not found. Build it: cd x402-Project && cargo build --release -p boringtun-cli"
        ))
    }
}

/// Returns true when passwordless sudo works, or on macOS when the user is an admin
/// (GUI apps cannot see Terminal `sudo -v` when timestamp_type=tty — connect uses osascript fallback).
pub fn check_sudo_available() -> bool {
    if sudo_noninteractive_ok() {
        return true;
    }
    #[cfg(target_os = "macos")]
    {
        return is_macos_admin_user();
    }
    false
}

fn sudo_noninteractive_ok() -> bool {
    Command::new("sudo")
        .args(["-n", "true"])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[cfg(target_os = "macos")]
fn is_macos_admin_user() -> bool {
    Command::new("id")
        .args(["-Gn"])
        .output()
        .map(|o| {
            o.status.success()
                && String::from_utf8_lossy(&o.stdout)
                    .split_whitespace()
                    .any(|g| g == "admin")
        })
        .unwrap_or(false)
}

#[cfg(not(target_os = "macos"))]
fn is_macos_admin_user() -> bool {
    false
}

#[cfg(target_os = "macos")]
fn find_available_iface() -> Result<String, String> {
    let output = Command::new("ifconfig")
        .arg("-l")
        .output()
        .map_err(|e| format!("ifconfig -l failed: {e}"))?;
    let existing = String::from_utf8_lossy(&output.stdout);

    for i in 9..=30 {
        let name = format!("utun{i}");
        if !existing.split_whitespace().any(|x| x == name) {
            return Ok(name);
        }
    }
    Err("No available utun interface found".into())
}

#[cfg(target_os = "linux")]
fn find_available_iface() -> Result<String, String> {
    let output = Command::new("ip")
        .args(["link", "show"])
        .output()
        .map_err(|e| format!("ip link show failed: {e}"))?;
    let existing = String::from_utf8_lossy(&output.stdout);

    for i in 0..=20 {
        let name = format!("wg{i}");
        if !existing.contains(&format!("{name}:")) {
            return Ok(name);
        }
    }
    Err("No available wg interface found".into())
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn find_available_iface() -> Result<String, String> {
    Ok("wg0".to_string())
}

/// Matches only X4PN **client** tunnel processes. The server boringtun (Terminal 1,
/// registration API on :8080) must NOT be killed when the desktop app connects.
const CLIENT_TUNNEL_PKILL_PATTERN: &str = "--disable-drop-privileges";

struct BoringtunSpawn {
    proc: Child,
    tunnel_pid: u32,
}

fn spawn_client_boringtun(path: &str, iface: &str) -> Result<BoringtunSpawn, String> {
    let bt_log = std::fs::File::create("/tmp/boringtun.log")
        .map_err(|e| format!("Failed to create boringtun log: {e}"))?;
    let bt_err = bt_log
        .try_clone()
        .map_err(|e| format!("Failed to clone log handle: {e}"))?;

    let mut proc = match Command::new("sudo")
        .args([
            "-n",
            path,
            iface,
            "--disable-drop-privileges",
            "--foreground",
        ])
        .stdout(Stdio::from(bt_log))
        .stderr(Stdio::from(bt_err))
        .spawn()
    {
        Ok(child) => child,
        Err(e) => {
            log::warn!("[vpn] sudo -n boringtun spawn failed: {e}");
            return spawn_client_boringtun_elevated(path, iface);
        }
    };

    std::thread::sleep(Duration::from_millis(800));
    if let Ok(Some(status)) = proc.try_wait() {
        if !status.success() {
            let log_tail = boringtun_log_tail();
            if log_tail.contains("password") || log_tail.contains("askpass") {
                log::warn!("[vpn] boringtun sudo -n needs password, using osascript");
                return spawn_client_boringtun_elevated(path, iface);
            }
            if log_tail.trim().is_empty() {
                return Err(SUDO_HINT.to_string());
            }
            return Err(format!(
                "boringtun-cli exited immediately. {SUDO_HINT} Log: {log_tail}"
            ));
        }
    }

    Ok(BoringtunSpawn {
        tunnel_pid: proc.id(),
        proc,
    })
}

#[cfg(target_os = "macos")]
fn spawn_client_boringtun_elevated(path: &str, iface: &str) -> Result<BoringtunSpawn, String> {
    let _ = std::fs::write("/tmp/boringtun.log", "");

    let shell_cmd = format!(
        "nohup {} {} --disable-drop-privileges --foreground >> /tmp/boringtun.log 2>&1 & \
         sleep 0.8; pgrep -f '{}' | head -1",
        shlex_quote(path),
        shlex_quote(iface),
        CLIENT_TUNNEL_PKILL_PATTERN,
    );
    let escaped = shell_cmd.replace('\\', "\\\\").replace('"', "\\\"");
    let script = format!("do shell script \"{}\" with administrator privileges", escaped);
    log::info!("[vpn] osascript admin: start boringtun-cli {iface}");

    let output = Command::new("osascript")
        .args(["-e", &script])
        .output()
        .map_err(|e| format!("Failed to request admin access: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("User canceled") || stderr.contains("-128") {
            return Err("Admin password prompt was cancelled.".into());
        }
        return Err(format!("{SUDO_HINT} ({stderr})"));
    }

    let pid_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let tunnel_pid: u32 = pid_str
        .parse()
        .map_err(|_| format!("boringtun started but PID unknown (got {pid_str:?})"))?;

    if !client_tunnel_process_alive() {
        let log_tail = boringtun_log_tail();
        return Err(format!(
            "boringtun-cli exited immediately after admin launch. Log: {log_tail}"
        ));
    }

    // Placeholder child — real process is detached; disconnect uses pkill pattern.
    let proc = Command::new("sleep")
        .arg("999999")
        .spawn()
        .map_err(|e| format!("Failed to track tunnel process: {e}"))?;

    Ok(BoringtunSpawn { proc, tunnel_pid })
}

#[cfg(not(target_os = "macos"))]
fn spawn_client_boringtun_elevated(_path: &str, _iface: &str) -> Result<BoringtunSpawn, String> {
    Err(SUDO_HINT.to_string())
}

fn boringtun_log_tail() -> String {
    std::fs::read_to_string("/tmp/boringtun.log")
        .unwrap_or_default()
        .chars()
        .rev()
        .take(400)
        .collect::<String>()
        .chars()
        .rev()
        .collect()
}

fn kill_stale_client_boringtun() {
    let _ = Command::new("pkill")
        .args(["-f", CLIENT_TUNNEL_PKILL_PATTERN])
        .status();
    let _ = Command::new("sudo")
        .args(["-n", "pkill", "-f", CLIENT_TUNNEL_PKILL_PATTERN])
        .status();
    std::thread::sleep(Duration::from_millis(300));
}

fn client_tunnel_process_alive() -> bool {
    Command::new("pgrep")
        .args(["-f", CLIENT_TUNNEL_PKILL_PATTERN])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn key_path() -> std::path::PathBuf {
    let dir = dirs::home_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join(".x4pn");
    let _ = std::fs::create_dir_all(&dir);
    dir.join("client_key")
}

fn load_or_create_key() -> Result<StaticSecret, String> {
    let path = key_path();
    if path.exists() {
        let bytes = std::fs::read(&path)
            .map_err(|e| format!("Failed to read key file: {e}"))?;
        if bytes.len() != 32 {
            return Err("Invalid key file (expected 32 bytes)".into());
        }
        let mut arr = [0u8; 32];
        arr.copy_from_slice(&bytes);
        Ok(StaticSecret::from(arr))
    } else {
        let secret = StaticSecret::random_from_rng(rand_core::OsRng);
        std::fs::write(&path, secret.as_bytes())
            .map_err(|e| format!("Failed to write key file: {e}"))?;
        log::info!("[vpn] created new key at {}", path.display());
        Ok(secret)
    }
}

const SUDO_HINT: &str = "Admin access needed for VPN tunnel. Approve the macOS password prompt when connecting.";

fn shlex_quote(s: &str) -> String {
    if s.is_empty() {
        return "''".into();
    }
    if s.chars()
        .all(|c| c.is_ascii_alphanumeric() || "/._-:".contains(c))
    {
        return s.to_string();
    }
    format!("'{}'", s.replace('\'', "'\\''"))
}

#[cfg(target_os = "macos")]
fn run_as_admin_macos(args: &[&str]) -> Result<(), String> {
    let bin = match args.first() {
        Some(&"route") => "/sbin/route",
        Some(&"ifconfig") => "/sbin/ifconfig",
        Some(&"networksetup") => "/usr/sbin/networksetup",
        Some(&"kill") => "/bin/kill",
        Some(&"pkill") => "/usr/bin/pkill",
        Some(&"nc") => "/usr/bin/nc",
        _ => {
            return Err(format!(
                "{SUDO_HINT} (unsupported privileged command: {})",
                args.first().unwrap_or(&"?")
            ));
        }
    };

    let mut cmd = bin.to_string();
    for arg in args.iter().skip(1) {
        cmd.push(' ');
        cmd.push_str(&shlex_quote(arg));
    }

    let escaped = cmd.replace('\\', "\\\\").replace('"', "\\\"");
    let script = format!("do shell script \"{}\" with administrator privileges", escaped);
    log::info!("[vpn] osascript admin: {cmd}");

    let output = Command::new("osascript")
        .args(["-e", &script])
        .output()
        .map_err(|e| format!("Failed to request admin access: {e}"))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("User canceled") || stderr.contains("-128") {
            Err("Admin password prompt was cancelled.".into())
        } else {
            Err(format!("{SUDO_HINT} ({stderr})"))
        }
    }
}

fn run_sudo_n(args: &[&str]) -> Result<(), String> {
    log::info!("[vpn] sudo -n {}", args.join(" "));
    let output = Command::new("sudo")
        .arg("-n")
        .args(args)
        .output()
        .map_err(|e| format!("Failed to run sudo {:?}: {e}", args))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let msg = stderr.trim();
        if msg.is_empty() || msg.contains("password") || msg.contains("askpass") {
            Err(SUDO_HINT.to_string())
        } else {
            Err(format!(
                "Command failed: sudo {} — {}",
                args.join(" "),
                msg
            ))
        }
    }
}

fn run_sudo(args: &[&str]) -> Result<(), String> {
    if run_sudo_n(args).is_ok() {
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        return run_as_admin_macos(args);
    }

    Err(SUDO_HINT.to_string())
}

// ── Wallet derivation (same as server's payment::wallet) ─────────────────────

fn derive_evm_address(x25519_private_bytes: &[u8; 32]) -> String {
    let hk = Hkdf::<Sha256>::new(Some(b"boringtun-payment-v1"), x25519_private_bytes);
    let mut derived = [0u8; 32];
    hk.expand(b"secp256k1-signing-key", &mut derived)
        .expect("32 bytes is valid HKDF output");

    let signing_key =
        SigningKey::from_bytes((&derived).into()).expect("HKDF output is valid scalar");

    let verify_key = k256::ecdsa::VerifyingKey::from(&signing_key);
    let pubkey_point = verify_key.to_encoded_point(false);
    let pubkey_bytes = pubkey_point.as_bytes();
    // Skip 0x04 prefix, hash x||y (64 bytes)
    let hash = Keccak256::digest(&pubkey_bytes[1..]);
    format!("0x{}", hex::encode(&hash[12..]))
}

pub fn api_base() -> String {
    API_BASE.clone()
}

pub fn get_wallet_address() -> Result<String, String> {
    let key = load_or_create_key()?;
    Ok(derive_evm_address(key.as_bytes()))
}

pub fn get_pubkey_b64() -> Result<String, String> {
    let private = load_or_create_key()?;
    let public = x25519_dalek::PublicKey::from(&private);
    Ok(B64.encode(public.as_bytes()))
}

// ── Gateway balance query ────────────────────────────────────────────────────

pub async fn query_gateway_balance(wallet_address: &str) -> Result<String, String> {
    let body = serde_json::json!({
        "token": "USDC",
        "sources": [{
            "domain": ARC_DOMAIN,
            "depositor": wallet_address,
        }]
    });

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;

    let resp: serde_json::Value = client
        .post(format!("{}/v1/balances", *GATEWAY_API))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Balance request failed: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Balance parse failed: {e}"))?;

    let balance = resp["balances"]
        .as_array()
        .and_then(|arr| arr.first())
        .and_then(|b| b["balance"].as_str())
        .unwrap_or("0");

    Ok(balance.to_string())
}
