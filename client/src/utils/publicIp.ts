const IP_SERVICES = [
  'https://api4.ipify.org?format=json',
  'https://ipv4.icanhazip.com',
];

export async function fetchPublicIp(): Promise<string> {
  let lastError: unknown;

  for (const url of IP_SERVICES) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;

      const text = (await res.text()).trim();
      if (url.includes('ipify')) {
        const data = JSON.parse(text) as { ip?: string };
        if (data.ip) return data.ip;
      } else if (text) {
        return text.split('\n')[0].trim();
      }
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Could not detect public IP');
}
