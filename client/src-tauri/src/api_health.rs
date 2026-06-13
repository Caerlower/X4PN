use serde::Serialize;
use std::process::Command;
use std::time::Duration;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerHealthResult {
    pub server_reachable: bool,
    pub boringtun_ok: bool,
    pub message: Option<String>,
    pub api_base: String,
}

fn primary_lan_ipv4() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        for iface in ["en0", "en1"] {
            if let Ok(out) = Command::new("ipconfig").args(["getifaddr", iface]).output() {
                if out.status.success() {
                    let ip = String::from_utf8_lossy(&out.stdout).trim().to_string();
                    if !ip.is_empty() {
                        return Some(ip);
                    }
                }
            }
        }
    }
    None
}

fn is_loopback_host(host: &str) -> bool {
    matches!(
        host.trim().to_lowercase().as_str(),
        "127.0.0.1" | "localhost" | "::1"
    )
}

fn x402_candidates(server_ip: Option<String>) -> Vec<String> {
    let port = 4021;
    let mut candidates = Vec::new();

    if let Ok(env) = std::env::var("X4PN_X402_API_URL") {
        candidates.push(env.trim_end_matches('/').to_string());
    }

    if let Some(ip) = server_ip {
        if is_loopback_host(&ip) {
            candidates.push(format!("http://localhost:{port}"));
            candidates.push(format!("http://127.0.0.1:{port}"));
        } else {
            candidates.push(format!("http://{ip}:{port}"));
        }
    } else {
        candidates.push(format!("http://localhost:{port}"));
        candidates.push(format!("http://127.0.0.1:{port}"));
    }

    if let Some(lan) = primary_lan_ipv4() {
        candidates.push(format!("http://{lan}:{port}"));
    }

    let mut seen = std::collections::HashSet::new();
    candidates
        .into_iter()
        .filter(|c| seen.insert(c.clone()))
        .collect()
}

pub async fn resolve_x402_api_base(server_ip: Option<String>) -> String {
    let candidates = x402_candidates(server_ip.clone());
    let fallback = candidates
        .first()
        .cloned()
        .unwrap_or_else(|| "http://localhost:4021".into());

    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
    {
        Ok(c) => c,
        Err(_) => return fallback,
    };

    for base in candidates {
        let url = format!("{base}/health");
        if client
            .get(&url)
            .send()
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false)
        {
            log::info!("[api] x402 server reachable at {base}");
            return base;
        }
    }

    fallback
}

#[tauri::command]
pub async fn get_x402_api_base(server_ip: Option<String>) -> Result<String, String> {
    Ok(resolve_x402_api_base(server_ip).await)
}

#[tauri::command]
pub async fn fetch_server_health(server_ip: Option<String>) -> Result<ServerHealthResult, String> {
    let api_base = resolve_x402_api_base(server_ip).await;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;

    let url = format!("{api_base}/health");
    match client.get(&url).send().await {
        Ok(res) if res.status().is_success() => {
            let body: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
            let boringtun_ok = body
                .get("boringtun")
                .and_then(|b| b.get("ok"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false);

            let message = if boringtun_ok {
                None
            } else {
                Some(
                    body.get("boringtun")
                        .and_then(|b| b.get("message"))
                        .and_then(|m| m.as_str())
                        .unwrap_or(
                            "VPN backend (boringtun) is not running on port 8080. Start Terminal 1.",
                        )
                        .to_string(),
                )
            };

            Ok(ServerHealthResult {
                server_reachable: true,
                boringtun_ok,
                message,
                api_base,
            })
        }
        Ok(res) => Ok(ServerHealthResult {
            server_reachable: true,
            boringtun_ok: false,
            message: Some(format!("VPN server error ({}) at {api_base}", res.status())),
            api_base,
        }),
        Err(_) => Ok(ServerHealthResult {
            server_reachable: false,
            boringtun_ok: false,
            message: Some(format!(
                "VPN server not running at {api_base}. Start Terminal 2: cd vpn-server && pnpm dev"
            )),
            api_base,
        }),
    }
}
