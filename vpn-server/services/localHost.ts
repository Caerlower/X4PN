import os from 'os';

/** Primary non-loopback IPv4 (e.g. en0). Used when 127.0.0.1 is broken after VPN routes. */
export function primaryLanIpv4(): string | undefined {
  const prefer = ['en0', 'en1', 'wlan0', 'eth0'];
  const nets = os.networkInterfaces();

  for (const name of prefer) {
    const addrs = nets[name];
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        return addr.address;
      }
    }
  }

  for (const addrs of Object.values(nets)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        return addr.address;
      }
    }
  }

  return undefined;
}

/** Pick the first local URL that responds (loopback often breaks after WireGuard full-tunnel). */
export async function resolveReachableLocalBase(
  configuredBase: string,
  probe: (base: string) => Promise<boolean>,
  timeoutMs = 2000
): Promise<string> {
  const normalized = configuredBase.replace(/\/$/, '');
  let port = '80';
  try {
    port = new URL(normalized).port || port;
  } catch {
    /* keep default */
  }

  const lanIp = primaryLanIpv4();
  const candidates = [
    normalized,
    normalized.replace('localhost', '127.0.0.1'),
    normalized.replace('127.0.0.1', 'localhost'),
    ...(lanIp ? [`http://${lanIp}:${port}`] : []),
  ];

  const seen = new Set<string>();
  for (const base of candidates) {
    if (seen.has(base)) continue;
    seen.add(base);

    const ok = await Promise.race([
      probe(base),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
    ]);
    if (ok) return base;
  }

  return normalized;
}
