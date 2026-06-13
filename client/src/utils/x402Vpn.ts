import { x402Client, wrapFetchWithPayment, decodePaymentResponseHeader } from '@x402/fetch';
import { ALGORAND_TESTNET_CAIP2 } from '@x402/avm';
import type { ClientAvmSigner } from '@x402/avm';
import { ExactAvmScheme } from '@x402/avm/exact/client';
import { isTauri, tauriInvokeSafe } from './tauriBridge';

const X402_API = normalizeLoopbackUrl(
  import.meta.env.VITE_X402_API_URL || 'http://localhost:4021'
);

let cachedApiBase: string | null = null;

/** macOS can listen on IPv6 localhost while 127.0.0.1 is unreachable — prefer localhost. */
function normalizeLoopbackUrl(url: string): string {
  return url.replace(/\/\/127\.0\.0\.1(?=[:/]|$)/g, '//localhost');
}

function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '::1';
}

export function setCachedApiBase(base: string): void {
  cachedApiBase = base.replace(/\/$/, '');
}

/** Resolve x402 API base URL for local or remote VPN server. */
export function x402ApiBase(serverIp?: string): string {
  if (cachedApiBase) return cachedApiBase;
  if (!serverIp || isLoopbackHost(serverIp)) {
    return X402_API;
  }
  return `http://${serverIp}:4021`;
}

/** Probe reachable base (Tauri uses LAN IP when loopback is broken after VPN routes). */
export async function ensureX402ApiBase(serverIp?: string): Promise<string> {
  if (cachedApiBase) return cachedApiBase;

  if (isTauri()) {
    try {
      const base = await tauriInvokeSafe<string>('get_x402_api_base', {
        serverIp: serverIp ?? null,
      });
      setCachedApiBase(base);
      return base;
    } catch {
      /* fall through to fetch probe */
    }
  }

  const candidates = [
    X402_API,
    x402ApiBase(serverIp),
    X402_API.replace('localhost', '127.0.0.1'),
  ].filter((v, i, a) => a.indexOf(v) === i);

  for (const base of candidates) {
    try {
      const res = await fetchWithTimeout(`${base}/health`, 2000);
      if (res.ok) {
        setCachedApiBase(base);
        return base;
      }
    } catch {
      /* try next */
    }
  }

  const fallback = x402ApiBase(serverIp);
  setCachedApiBase(fallback);
  return fallback;
}

async function fetchWithTimeout(url: string, ms: number, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export interface VpnConnectResponse {
  status: string;
  server_public_key: string;
  endpoint: string;
  assigned_ip: string;
  expiresAt?: string;
  durationMinutes?: number;
  pricePaidDescription?: string;
}

export interface VpnRenewResponse {
  status: string;
  server_public_key: string;
  endpoint: string;
  assigned_ip: string;
  expiresAt: string;
  durationMinutes: number;
  renewedCount?: number;
  pricePaidDescription?: string;
}

export interface SessionStatus {
  active: boolean;
  wireguardPublicKey?: string;
  secondsRemaining?: number;
  canRenew?: boolean;
  expiresAt?: string;
  renewWindowSeconds?: number;
  assignedIp?: string;
  serverPublicKey?: string;
  endpoint?: string;
  durationMinutes?: number;
}

/** Build x402-aware fetch using connected Algorand wallet. */
export async function createX402Fetch(walletSigner: {
  address: string;
  signTransactions: (
    txns: Uint8Array[],
    indexesToSign?: number[]
  ) => Promise<Uint8Array[] | (Uint8Array | null)[] | unknown>;
}) {
  const client = new x402Client();

  const x402Signer: ClientAvmSigner = {
    address: walletSigner.address,
    signTransactions: async (txns: Uint8Array[], indexesToSign?: number[]) => {
      const walletResult = await walletSigner.signTransactions(txns, indexesToSign);

      if (!Array.isArray(walletResult)) {
        throw new Error('Wallet did not return signed transactions');
      }

      const requiredIndexes = indexesToSign ?? txns.map((_, i) => i);

      return txns.map((_, i) => {
        const item = walletResult[i];
        const mustSign = requiredIndexes.includes(i);

        if (item === null || item === undefined) {
          if (mustSign) {
            throw new Error('Payment cancelled — approve the transaction in Pera wallet.');
          }
          return null;
        }

        if (item instanceof Uint8Array) return item;

        if (typeof item === 'string') {
          const binaryString = atob(item);
          const bytes = new Uint8Array(binaryString.length);
          for (let j = 0; j < binaryString.length; j++) {
            bytes[j] = binaryString.charCodeAt(j);
          }
          return bytes;
        }

        if (mustSign) {
          throw new Error('Payment cancelled — wallet returned an invalid signature.');
        }
        return null;
      });
    },
  };

  client.register(ALGORAND_TESTNET_CAIP2, new ExactAvmScheme(x402Signer));
  return wrapFetchWithPayment(fetch, client);
}

/** Pay via x402 and connect VPN session on the server (registers WireGuard peer). */
export async function vpnConnectWithPayment(
  walletSigner: {
    address: string;
    signTransactions: (txns: Uint8Array[], indexesToSign?: number[]) => Promise<unknown>;
  },
  wireguardPublicKey: string,
  durationMinutes: number,
  serverIp?: string
): Promise<VpnConnectResponse> {
  const base = await ensureX402ApiBase(serverIp);
  const fetchFn = await createX402Fetch(walletSigner);

  const response = await fetchFn(`${base}/connect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wireguardPublicKey, durationMinutes }),
  });

  if (!response.ok) {
    throw new Error(await formatPaymentError(response, 'Connect'));
  }

  return response.json();
}

/** Pay via x402 and extend an active VPN session. */
export async function vpnRenewWithPayment(
  walletSigner: { address: string; signTransactions: (txns: Uint8Array[]) => Promise<unknown> },
  wireguardPublicKey: string,
  durationMinutes: number,
  serverIp?: string
): Promise<VpnRenewResponse> {
  const base = await ensureX402ApiBase(serverIp);
  const fetchFn = await createX402Fetch(walletSigner);

  const response = await fetchFn(`${base}/renew`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wireguardPublicKey, durationMinutes }),
  });

  if (!response.ok) {
    throw new Error(await formatPaymentError(response, 'Renew'));
  }

  return response.json();
}

/** Drop server-side session + boringtun peer (no payment). */
export async function clearServerSession(wireguardPublicKey: string, serverIp?: string) {
  const base = await ensureX402ApiBase(serverIp);
  const response = await fetch(`${base}/session/clear`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wireguardPublicKey }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Clear session failed (${response.status}): ${text}`);
  }

  return response.json();
}

export async function fetchSessionStatus(
  wireguardPublicKey: string,
  serverIp?: string
): Promise<SessionStatus> {
  const base = await ensureX402ApiBase(serverIp);
  const response = await fetch(`${base}/session/${encodeURIComponent(wireguardPublicKey)}`);

  if (!response.ok) {
    throw new Error(`Session status failed (${response.status})`);
  }

  const data = (await response.json()) as SessionStatus;
  return data.active ? data : { active: false, wireguardPublicKey };
}

export interface ServerHealth {
  serverReachable: boolean;
  boringtunOk: boolean;
  message: string | null;
  apiBase?: string;
}

/** Check vpn-server + boringtun before opening wallet payment. Never throws. */
export async function fetchServerHealth(serverIp?: string): Promise<ServerHealth> {
  if (isTauri()) {
    try {
      const health = await tauriInvokeSafe<ServerHealth>('fetch_server_health', {
        serverIp: serverIp ?? null,
      });
      if (health.apiBase) setCachedApiBase(health.apiBase);
      return health;
    } catch {
      /* fall through */
    }
  }

  const base = await ensureX402ApiBase(serverIp);
  try {
    const response = await fetchWithTimeout(`${base}/health`, 5000);
    if (!response.ok) {
      return {
        serverReachable: true,
        boringtunOk: false,
        message: `VPN server error (${response.status}) at ${base}`,
        apiBase: base,
      };
    }

    const data = await response.json();
    const boringtunOk = Boolean(data?.boringtun?.ok);
    if (!boringtunOk) {
      return {
        serverReachable: true,
        boringtunOk: false,
        message:
          data?.boringtun?.message ||
          'VPN backend (boringtun) is not running on port 8080. Start Terminal 1 (see docs).',
        apiBase: base,
      };
    }

    return { serverReachable: true, boringtunOk: true, message: null, apiBase: base };
  } catch {
    return {
      serverReachable: false,
      boringtunOk: false,
      message: `VPN server not running at ${base}. Start Terminal 2: cd vpn-server && pnpm dev`,
      apiBase: base,
    };
  }
}

async function formatPaymentError(response: Response, action: string): Promise<string> {
  const text = await response.text();

  let paymentDetail: string | undefined;
  const paymentResponseHeader =
    response.headers.get('payment-response') || response.headers.get('x-payment-response');
  if (paymentResponseHeader) {
    try {
      const decoded = decodePaymentResponseHeader(paymentResponseHeader) as {
        errorMessage?: string;
        errorReason?: string;
        invalidMessage?: string;
        invalidReason?: string;
      };
      paymentDetail =
        decoded.errorMessage ||
        decoded.errorReason ||
        decoded.invalidMessage ||
        decoded.invalidReason;
    } catch {
      /* ignore decode errors */
    }
  }

  if (paymentDetail) {
    return `${action} failed (${response.status}): ${paymentDetail}`;
  }

  try {
    const body = JSON.parse(text) as {
      error?: string;
      reason?: string;
      message?: string;
      hint?: string;
    };
    const detail = body.error || body.reason || body.message;
    if (detail) {
      const hint = body.hint ? ` ${body.hint}` : '';
      return `${action} failed (${response.status}): ${detail}${hint}`;
    }
  } catch {
    /* use raw text */
  }

  if (response.status === 402) {
    return `${action} failed: payment was not accepted. Ensure you have TestNet USDC in Pera and approve both transactions.`;
  }

  return `${action} failed (${response.status}): ${text || 'unknown error'}`;
}

export async function fetchPricing(durationMinutes: number, serverIp?: string) {
  const base = await ensureX402ApiBase(serverIp);
  const res = await fetch(`${base}/pricing?durationMinutes=${durationMinutes}`);
  if (!res.ok) throw new Error(`Pricing request failed: ${res.status}`);
  return res.json();
}
