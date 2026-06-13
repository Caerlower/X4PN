import { useState, useEffect, useCallback } from "react";
import { useWallet } from "./WalletApp";
import { tauriInvokeSafe, tauriListenSafe, probeTauriIpc } from "./utils/tauriBridge";
import type { SessionStatus } from "./utils/x402Vpn";
import logo from "./logo.svg";

const SERVER_IP = import.meta.env.VITE_SERVER_IP || "127.0.0.1";
const SESSION_MINUTES = Number(import.meta.env.VITE_SESSION_MINUTES || "5");

type VpnStatus = "disconnected" | "connecting" | "connected" | "disconnecting" | "error";

interface ConnectedInfo {
  assigned_ip: string;
  server_endpoint: string;
  wallet_address: string;
  gateway_balance: string;
}

interface VpnStateEvent {
  status: VpnStatus;
  assigned_ip: string | null;
  error: string | null;
}

interface HealthEvent {
  connected: boolean;
  process_alive: boolean;
  handshake_age_secs: number | null;
}

type ConnectPhase = "paying" | "tunnel" | "renew" | null;
type SessionAction = "clear" | "renew" | null;

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(message)), ms);
    }),
  ]);
}

export default function App() {
  const [tauriReady, setTauriReady] = useState<boolean | null>(null);
  const [connectPhase, setConnectPhase] = useState<ConnectPhase>(null);
  const { wallets, activeAddress, isReady, signTransactions } = useWallet();
  const [status, setStatus] = useState<VpnStatus>("disconnected");
  const [assignedIp, setAssignedIp] = useState<string | null>(null);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [balance, setBalance] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthEvent | null>(null);
  const [walletModalOpen, setWalletModalOpen] = useState(false);
  const [walletConnecting, setWalletConnecting] = useState(false);
  const [sessionInfo, setSessionInfo] = useState<SessionStatus | null>(null);
  const [renewModalOpen, setRenewModalOpen] = useState(false);
  const [renewMinutes, setRenewMinutes] = useState(SESSION_MINUTES);
  const [renewPrice, setRenewPrice] = useState<string | null>(null);
  const [sessionAction, setSessionAction] = useState<SessionAction>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [backendReady, setBackendReady] = useState<boolean | null>(null);
  const [backendMessage, setBackendMessage] = useState<string | null>(null);
  const [sudoReady, setSudoReady] = useState<boolean | null>(null);
  const [publicIpBefore, setPublicIpBefore] = useState<string | null>(null);
  const [publicIpAfter, setPublicIpAfter] = useState<string | null>(null);
  const [publicIpLoading, setPublicIpLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;

    probeTauriIpc().then((ok) => {
      if (!cancelled) setTauriReady(ok);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (tauriReady !== true) return;

    tauriInvokeSafe<VpnStatus>("get_status")
      .then((s) => {
        setStatus(s);
        if (s !== "connecting") setConnectPhase(null);
      })
      .catch(() => {});

    const unsubs: Array<() => void> = [];

    tauriListenSafe<VpnStateEvent>("vpn-state", (payload) => {
      setStatus(payload.status);
      if (payload.assigned_ip) setAssignedIp(payload.assigned_ip);
      if (payload.status === "error") {
        setConnectPhase(null);
        if (payload.error) setError(payload.error);
      }
      if (payload.status === "disconnected" || payload.status === "error") {
        setConnectPhase(null);
      }
      if (payload.status === "disconnected") {
        setAssignedIp(null);
        setHealth(null);
      }
      if (payload.status === "connecting") setError(null);
      if (payload.status === "connected") {
        setConnectPhase(null);
        setError(null);
      }
    }).then((unsub) => unsubs.push(unsub));

    tauriListenSafe<HealthEvent>("vpn-health", (payload) => {
      setHealth(payload);
    }).then((unsub) => unsubs.push(unsub));

    return () => {
      unsubs.forEach((fn) => fn());
    };
  }, [tauriReady]);

  useEffect(() => {
    if (activeAddress) {
      setWalletAddress(activeAddress);
      setBalance("x402");
    }
  }, [activeAddress]);

  const refreshSessionStatus = useCallback(async () => {
    if (tauriReady !== true) return;
    try {
      const wgPubkey = await tauriInvokeSafe<string>("get_pubkey");
      const { fetchSessionStatus } = await import("./utils/x402Vpn");
      const info = await fetchSessionStatus(wgPubkey, SERVER_IP);
      setSessionInfo(info.active ? info : null);
    } catch {
      setSessionInfo(null);
    }
  }, [tauriReady]);

  useEffect(() => {
    if (!activeAddress || tauriReady !== true) {
      setSessionInfo(null);
      return;
    }

    refreshSessionStatus();
    const intervalMs = sessionInfo?.active ? 5000 : 30000;
    const id = setInterval(refreshSessionStatus, intervalMs);
    return () => clearInterval(id);
  }, [activeAddress, tauriReady, refreshSessionStatus, sessionInfo?.active]);

  useEffect(() => {
    if (tauriReady !== true) return;

    tauriInvokeSafe<boolean>("check_sudo")
      .then((ok) => setSudoReady(ok))
      .catch(() => setSudoReady(false));

    const id = setInterval(() => {
      tauriInvokeSafe<boolean>("check_sudo")
        .then((ok) => setSudoReady(ok))
        .catch(() => setSudoReady(false));
    }, 15000);

    return () => clearInterval(id);
  }, [tauriReady]);

  useEffect(() => {
    if (tauriReady !== true) return;

    let cancelled = false;
    let failures = 0;

    const checkBackend = async () => {
      const { fetchServerHealth } = await import("./utils/x402Vpn");
      const health = await fetchServerHealth(SERVER_IP);
      if (cancelled) return;

      const ready = health.serverReachable && health.boringtunOk;
      if (ready) {
        failures = 0;
        setBackendReady(true);
        setBackendMessage(null);
        return;
      }

      failures += 1;
      setBackendReady(false);
      // Grace period on startup — services may still be coming up
      if (failures >= 2) {
        setBackendMessage(health.message);
      }
    };

    checkBackend();
    const id = setInterval(checkBackend, 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [tauriReady]);

  useEffect(() => {
    if (!renewModalOpen) return;

    let cancelled = false;
    import("./utils/x402Vpn")
      .then(({ fetchPricing }) => fetchPricing(renewMinutes, SERVER_IP))
      .then((quote) => {
        if (!cancelled) setRenewPrice(quote.priceUSDC ?? null);
      })
      .catch(() => {
        if (!cancelled) setRenewPrice(null);
      });

    return () => {
      cancelled = true;
    };
  }, [renewModalOpen, renewMinutes]);

  const refreshPublicIp = useCallback(async (target: "before" | "after") => {
    setPublicIpLoading(true);
    try {
      const { fetchPublicIp } = await import("./utils/publicIp");
      const ip = await fetchPublicIp();
      if (target === "before") setPublicIpBefore(ip);
      else setPublicIpAfter(ip);
    } catch {
      if (target === "before") setPublicIpBefore(null);
      else setPublicIpAfter(null);
    } finally {
      setPublicIpLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tauriReady !== true || status === "connected") return;
    refreshPublicIp("before");
  }, [tauriReady, status, refreshPublicIp]);

  const doConnect = async () => {
    if (tauriReady === false) {
      setError("Use the X4PN desktop window (menu bar icon), not a browser tab.");
      return;
    }

    if (!activeAddress) {
      setWalletModalOpen(true);
      setError("Connect your Pera wallet first, then click CONNECT.");
      return;
    }

    try {
      setError(null);
      setSuccessMessage(null);

      const sudoOk = await tauriInvokeSafe<boolean>("check_sudo");
      setSudoReady(sudoOk);
      // Don't block — macOS GUI apps can't detect Terminal sudo -v; tunnel setup uses osascript fallback.
      const { fetchServerHealth, fetchSessionStatus, vpnConnectWithPayment } = await import(
        "./utils/x402Vpn"
      );
      const health = await fetchServerHealth(SERVER_IP);
      if (!health.serverReachable) {
        setBackendReady(false);
        setBackendMessage(health.message);
        throw new Error(health.message ?? "VPN server unreachable");
      }
      if (!health.boringtunOk) {
        setBackendReady(false);
        setBackendMessage(health.message);
        throw new Error(
          `${health.message}\n\nStart boringtun in Terminal 1:\nsudo WG_SUDO=1 BT_REGISTRATION_API=1 BT_HTTP_BIND=0.0.0.0:8080 BT_PUBLIC_IP=127.0.0.1 BT_WG_PORT=51820 cargo run --release --features payment -p boringtun-cli -- utun --foreground`
        );
      }

      const wgPubkey = await tauriInvokeSafe<string>("get_pubkey");
      const existingSession = await fetchSessionStatus(wgPubkey, SERVER_IP);

      let paid: {
        server_public_key: string;
        endpoint: string;
        assigned_ip: string;
        expiresAt?: string;
      };

      if (
        existingSession.active &&
        existingSession.serverPublicKey &&
        existingSession.endpoint &&
        existingSession.assignedIp
      ) {
        setSuccessMessage("Paid session active — starting VPN tunnel (no new payment).");
        paid = {
          server_public_key: existingSession.serverPublicKey,
          endpoint: existingSession.endpoint,
          assigned_ip: existingSession.assignedIp.includes("/")
            ? existingSession.assignedIp
            : `${existingSession.assignedIp}/32`,
          expiresAt: existingSession.expiresAt,
        };
      } else {
        setConnectPhase("paying");
        paid = await vpnConnectWithPayment(
          {
            address: activeAddress,
            signTransactions: (txns: Uint8Array[], indexesToSign?: number[]) =>
              signTransactions(txns, indexesToSign),
          },
          wgPubkey,
          SESSION_MINUTES,
          SERVER_IP
        );
      }

      setConnectPhase("tunnel");
      setStatus("connecting");

      if (!publicIpBefore) {
        await refreshPublicIp("before");
      }

      const info = await withTimeout(
        tauriInvokeSafe<ConnectedInfo>("connect_paid", {
          registration: {
            server_public_key: paid.server_public_key,
            endpoint: paid.endpoint,
            assigned_ip: paid.assigned_ip,
            expires_at: paid.expiresAt,
          },
          serverIp: SERVER_IP,
          algorandAddress: activeAddress,
        }),
        45_000,
        "VPN setup timed out. In Terminal run: sudo -v (enter Mac password), then click CONNECT again."
      );

      setAssignedIp(info.assigned_ip);
      setWalletAddress(info.wallet_address);
      setBalance(info.gateway_balance);
      setStatus("connected");
      setConnectPhase(null);
      await refreshPublicIp("after");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setStatus("disconnected");
      setConnectPhase(null);
      if (msg.includes("Session already active")) {
        refreshSessionStatus();
      }
    }
  };

  const handleClearSession = async () => {
    if (tauriReady !== true) {
      setError("Use the X4PN desktop window (menu bar icon), not a browser tab.");
      return;
    }

    setSessionAction("clear");
    setError(null);
    setSuccessMessage(null);

    try {
      const wgPubkey = await tauriInvokeSafe<string>("get_pubkey");
      const { clearServerSession } = await import("./utils/x402Vpn");
      await clearServerSession(wgPubkey, SERVER_IP);
      setSessionInfo(null);
      setSuccessMessage("Server session cleared. You can connect again.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSessionAction(null);
    }
  };

  const handleRenewConfirm = async () => {
    if (!activeAddress) {
      setWalletModalOpen(true);
      setError("Connect your Pera wallet first.");
      return;
    }

    if (tauriReady !== true) {
      setError("Use the X4PN desktop window (menu bar icon), not a browser tab.");
      return;
    }

    setSessionAction("renew");
    setConnectPhase("renew");
    setError(null);
    setSuccessMessage(null);

    try {
      const wgPubkey = await tauriInvokeSafe<string>("get_pubkey");
      const { vpnRenewWithPayment } = await import("./utils/x402Vpn");
      const renewed = await vpnRenewWithPayment(
        {
          address: activeAddress,
          signTransactions: (txns: Uint8Array[], indexesToSign?: number[]) =>
            signTransactions(txns, indexesToSign),
        },
        wgPubkey,
        renewMinutes,
        SERVER_IP
      );

      setSessionInfo({
        active: true,
        wireguardPublicKey: wgPubkey,
        secondsRemaining: renewMinutes * 60,
        canRenew: false,
        expiresAt: renewed.expiresAt,
        assignedIp: renewed.assigned_ip.replace(/\/32$/, ""),
        durationMinutes: renewed.durationMinutes,
      });
      setRenewModalOpen(false);
      setSuccessMessage(
        renewed.pricePaidDescription
          ? `Renewed — ${renewed.pricePaidDescription}`
          : `Session extended by ${renewMinutes} min`
      );
      await refreshSessionStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSessionAction(null);
      setConnectPhase(null);
    }
  };

  const handleWalletConnect = async (walletId: string) => {
    const wallet = wallets?.find((w) => w.id === walletId);
    if (!wallet) return;

    setWalletConnecting(true);
    setWalletError(null);
    setError(null);
    try {
      await wallet.connect();
      wallet.setActive();
      setWalletModalOpen(false);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes("CONNECT_MODAL_CLOSED") && !msg.toLowerCase().includes("closed")) {
        setWalletError(msg);
      }
    } finally {
      setWalletConnecting(false);
    }
  };

  const handleClick = async () => {
    if (status === "connected" || status === "error") {
      setConnectPhase(null);
      setStatus("disconnecting");
      try {
        await tauriInvokeSafe("disconnect");
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
      setStatus("disconnected");
      setAssignedIp(null);
      setHealth(null);
      setPublicIpAfter(null);
      setError(null);
      refreshPublicIp("before");
    } else if (status === "disconnected") {
      await doConnect();
    }
  };

  const isLoading = status === "connecting" || status === "disconnecting" || connectPhase !== null;
  const isConnected = status === "connected";
  const isError = status === "error";
  const staleSessionError = error?.includes("Session already active");
  const showSessionActions = Boolean(activeAddress && (sessionInfo?.active || staleSessionError));

  const statusLabel = isConnected
    ? "SECURED"
    : isError
      ? "ERROR"
      : connectPhase === "paying" || connectPhase === "renew"
        ? "PAYING..."
        : connectPhase === "tunnel" || status === "connecting"
          ? "STARTING VPN..."
          : status === "disconnecting"
            ? "DISCONNECTING..."
            : "UNSECURED";

  const shortAddr = (addr: string) => `${addr.slice(0, 6)}...${addr.slice(-4)}`;

  return (
    <div className={`app ${isConnected ? "secured" : ""}`}>
      {tauriReady === false && (
        <div className="error-bar">
          Open this from the X4PN desktop window (menu bar tray icon), not a Chrome tab at localhost:1420.
        </div>
      )}

      {sudoReady === false && (
        <div className="error-bar">
          Admin access required for VPN tunnel. Click CONNECT — macOS will prompt for your password.
        </div>
      )}

      {backendReady === false && backendMessage && (
        <div className="error-bar">{backendMessage}</div>
      )}

      <div className="header">
        <img src={logo} alt="X4PN" className="header-logo" />
        <div className={`header-status ${isConnected ? "on" : ""} ${isError ? "err" : ""}`}>
          <span className={`status-dot ${isConnected ? "on" : ""} ${isError ? "err" : ""}`} />
          <span className="header-status-text">{statusLabel}</span>
        </div>
      </div>

      {walletAddress && (
        <div className="wallet-bar">
          <div className="wallet-left">
            <span className="wallet-label">ALGO</span>
            <span className="wallet-addr">{shortAddr(walletAddress)}</span>
          </div>
          <div className="wallet-right">
            <span className="wallet-bal">{balance}</span>
          </div>
        </div>
      )}

      {!activeAddress && (
        <button className="wallet-connect-btn" type="button" onClick={() => setWalletModalOpen(true)}>
          Connect Algorand Wallet
        </button>
      )}

      {walletModalOpen && (
        <div className="modal-overlay" onClick={() => !walletConnecting && setWalletModalOpen(false)}>
          <div className="modal-box" onClick={(e) => e.stopPropagation()}>
            <h3>Select wallet</h3>
            <p style={{ fontSize: 12, opacity: 0.8, margin: "0 0 8px" }}>
              Pera opens a QR code — scan with the Pera mobile app (TestNet).
            </p>
            {!isReady && <p>Loading wallets…</p>}
            {walletError && <p className="error-bar">{walletError}</p>}
            {wallets?.map((w) => (
              <button
                key={w.id}
                type="button"
                disabled={walletConnecting}
                onClick={() => handleWalletConnect(w.id)}
              >
                {walletConnecting ? "Connecting…" : w.metadata.name}
              </button>
            ))}
            <button type="button" disabled={walletConnecting} onClick={() => setWalletModalOpen(false)}>
              Close
            </button>
          </div>
        </div>
      )}

      <div className="ip-bar">
        <div className="ip-row">
          <span className="ip-label">Public IP</span>
          <span className="ip-value">
            {publicIpLoading && !publicIpBefore && !publicIpAfter
              ? "…"
              : publicIpBefore ?? "—"}
            {isConnected && (
              <>
                <span className="ip-arrow"> → </span>
                {publicIpAfter ?? (publicIpLoading ? "…" : "—")}
              </>
            )}
          </span>
        </div>
        {assignedIp && isConnected && (
          <div className="ip-row">
            <span className="ip-label">Tunnel IP</span>
            <span className="ip-value accent">{assignedIp}</span>
          </div>
        )}
      </div>

      <div className="connected-bar">
        <span className="connected-ip">Server: {SERVER_IP}</span>
        {sessionInfo?.active && sessionInfo.secondsRemaining != null && (
          <span className="connected-ping session-timer">
            {sessionInfo.secondsRemaining}s left
          </span>
        )}
        {health?.handshake_age_secs != null && health.handshake_age_secs < 3600 && (
          <span className="connected-ping">{health.handshake_age_secs}s ago</span>
        )}
      </div>

      {successMessage && <div className="success-bar">{successMessage}</div>}

      {error && <div className="error-bar">{error}</div>}

      {showSessionActions && (
        <div className="btn-row">
          <button
            type="button"
            className="btn-secondary"
            disabled={sessionAction !== null || isLoading}
            onClick={handleClearSession}
          >
            {sessionAction === "clear" ? "CLEARING..." : "CLEAR SESSION"}
          </button>
          {sessionInfo?.active && (
            <button
              type="button"
              className="btn-secondary accent"
              disabled={sessionAction !== null || isLoading}
              onClick={() => {
                setRenewMinutes(SESSION_MINUTES);
                setRenewModalOpen(true);
              }}
            >
              RENEW
            </button>
          )}
        </div>
      )}

      {renewModalOpen && (
        <div
          className="modal-overlay"
          onClick={() => sessionAction !== "renew" && setRenewModalOpen(false)}
        >
          <div className="modal-box" onClick={(e) => e.stopPropagation()}>
            <h3>Renew session</h3>
            <p className="modal-hint">
              Choose how long to extend your VPN session. Payment is via x402 (USDC on Algorand).
            </p>
            <label className="modal-label">
              Duration (minutes)
              <input
                type="number"
                min={1}
                max={60}
                value={renewMinutes}
                disabled={sessionAction === "renew"}
                onChange={(e) => setRenewMinutes(Math.max(1, Math.min(60, Number(e.target.value) || 1)))}
              />
            </label>
            {renewPrice && <p className="modal-price">{renewPrice}</p>}
            <div className="modal-actions">
              <button
                type="button"
                className="btn-secondary accent"
                disabled={sessionAction === "renew"}
                onClick={handleRenewConfirm}
              >
                {sessionAction === "renew" ? "PAYING..." : "PAY & RENEW"}
              </button>
              <button
                type="button"
                className="btn-secondary"
                disabled={sessionAction === "renew"}
                onClick={() => setRenewModalOpen(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      <button
        className={`btn-action ${isConnected || isError ? "disconnect" : ""} ${isLoading ? "loading" : ""}`}
        onClick={handleClick}
        disabled={isLoading || backendReady === false}
      >
        {isLoading ? (connectPhase === "paying" || connectPhase === "renew" ? "PAY..." : "...") : isConnected || isError ? "DISCONNECT" : "CONNECT"}
      </button>

      <div className="footer">
        <span>
          x402 · {SESSION_MINUTES} min session
          {sessionInfo?.active && ` · ${sessionInfo.secondsRemaining ?? "?"}s left`}
        </span>
      </div>
    </div>
  );
}
