/**
 * Calls the X4PN boringtun HTTP API (http_api.rs) to add/remove WireGuard peers.
 */

import { resolveReachableLocalBase } from './localHost.js';

export interface BoringtunRegisterResponse {
  status: string;
  server_public_key: string;
  endpoint: string;
  assigned_ip: string;
}

let resolvedBoringtunBase: string | null = null;

function configuredBoringtunBase(): string {
  return (process.env.BORINGTUN_API_URL || 'http://localhost:8080').replace(/\/$/, '');
}

async function boringtunApiUrl(): Promise<string> {
  if (resolvedBoringtunBase) return resolvedBoringtunBase;

  const configured = configuredBoringtunBase();
  resolvedBoringtunBase = await resolveReachableLocalBase(configured, async (base) => {
    try {
      const res = await fetch(`${base}/v1/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ public_key: 'probe' }),
      });
      return res.status >= 200 && res.status < 600;
    } catch {
      return false;
    }
  });

  if (resolvedBoringtunBase !== configured) {
    console.log(
      `[local] loopback unreachable — boringtun API via ${resolvedBoringtunBase} (configured ${configured})`
    );
  }

  return resolvedBoringtunBase;
}

function formatBoringtunError(err: unknown, url: string): string {
  const msg = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error && 'cause' in err ? String((err as { cause?: unknown }).cause) : '';
  if (
    msg.includes('fetch failed') ||
    msg.includes('ECONNREFUSED') ||
    cause.includes('ECONNREFUSED')
  ) {
    return (
      `VPN backend (boringtun) is not running at ${url}. ` +
      'Start boringtun in a separate terminal before connecting.'
    );
  }
  return msg;
}

/** Quick probe — used before x402 payment so we do not charge when boringtun is down. */
export async function probeBoringtunHealth(timeoutMs = 2000): Promise<{
  ok: boolean;
  url: string;
  message: string;
}> {
  const url = await boringtunApiUrl();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}/v1/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ public_key: 'probe' }),
      signal: controller.signal,
    });
    // Any HTTP response means boringtun is listening (400/422 for bad key is fine).
    if (res.status >= 200 && res.status < 600) {
      return { ok: true, url, message: 'boringtun reachable' };
    }
    return { ok: false, url, message: `boringtun returned ${res.status}` };
  } catch (err) {
    return { ok: false, url, message: formatBoringtunError(err, url) };
  } finally {
    clearTimeout(timer);
  }
}

export async function registerWireGuardPeer(
  publicKeyBase64: string
): Promise<BoringtunRegisterResponse> {
  const base = await boringtunApiUrl();
  const url = `${base}/v1/register`;
  console.log(`[boringtun] POST ${url}`);

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ public_key: publicKeyBase64.trim() }),
  }).catch((err) => {
    throw new Error(formatBoringtunError(err, base));
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`boringtun register failed (${res.status}): ${text}`);
  }

  const data = JSON.parse(text) as BoringtunRegisterResponse;
  if (!data.server_public_key || !data.assigned_ip || !data.endpoint) {
    throw new Error(`boringtun register incomplete response: ${text}`);
  }

  console.log(`[boringtun] peer registered ip=${data.assigned_ip} endpoint=${data.endpoint}`);
  return data;
}

export async function unregisterWireGuardPeer(publicKeyBase64: string): Promise<void> {
  const base = await boringtunApiUrl();
  const url = `${base}/v1/unregister`;
  console.log(`[boringtun] POST ${url}`);

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ public_key: publicKeyBase64.trim() }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`boringtun unregister failed (${res.status}): ${text}`);
  }

  console.log('[boringtun] peer unregistered');
}
