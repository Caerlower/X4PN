import type { ProtectedRequestHook } from '@x402/core/server';

import { loadPricingConfig, resolveDurationMinutes } from '../services/pricing.js';
import { probeBoringtunHealth } from '../services/boringtun.js';
import { SessionStore } from '../services/sessionStore.js';
import type { ParsedRequestBody } from '../types/vpn.js';

async function readBody(context: Parameters<ProtectedRequestHook>[0]): Promise<ParsedRequestBody | null> {
  const body = await context.adapter.getBody?.();
  if (!body || typeof body !== 'object') return null;
  return body as ParsedRequestBody;
}

/**
 * Runs before x402 payment on protected routes.
 * - Validates JSON body
 * - For /renew: requires an active session
 */
export function createVpnProtectedRequestHook(sessionStore: SessionStore): ProtectedRequestHook {
  const pricing = loadPricingConfig();

  return async (context) => {
    const body = await readBody(context);
    const wgKey = body?.wireguardPublicKey?.trim();

    if (!wgKey) {
      return { abort: true, reason: 'wireguardPublicKey is required in JSON body' };
    }

    try {
      resolveDurationMinutes(body, pricing);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invalid durationMinutes';
      return { abort: true, reason: message };
    }

    const boringtun = await probeBoringtunHealth();
    if (!boringtun.ok) {
      return {
        abort: true,
        reason: boringtun.message,
      };
    }

    if (context.path === '/renew' || context.routePattern === 'POST /renew') {
      const session = sessionStore.getSession(wgKey);
      if (!session) {
        return { abort: true, reason: 'No active session. Call POST /connect first.' };
      }
    }

    if (context.path === '/connect' || context.routePattern === 'POST /connect') {
      const existing = sessionStore.getSession(wgKey);
      if (existing) {
        return {
          abort: true,
          reason: 'Session already active for this WireGuard key. Use POST /renew instead.',
        };
      }
    }
  };
}
