import type { Context } from 'hono';
import { createHash } from 'node:crypto';

import { registerWireGuardPeer, unregisterWireGuardPeer } from '../services/boringtun.js';
import {
  loadPricingConfig,
  priceDescription,
  resolveDurationMinutes,
} from '../services/pricing.js';
import type { SessionStore } from '../services/sessionStore.js';
import type { ParsedRequestBody } from '../types/vpn.js';

export interface ServerEnv {
  sessionStore: SessionStore;
}

function parseBody(c: Context): ParsedRequestBody {
  const body = c.get('parsedBody');
  if (!body || typeof body !== 'object') {
    throw new Error('Invalid JSON body');
  }
  return body as ParsedRequestBody;
}

/**
 * POST /connect — x402 payment verified → register real WireGuard peer via boringtun.
 */
export function createConnectHandler(env: ServerEnv) {
  const pricing = loadPricingConfig();

  return async (c: Context) => {
    try {
      console.log('✓ PAYMENT VERIFIED — POST /connect');

      const body = parseBody(c);
      const wgKey = body.wireguardPublicKey?.trim();
      if (!wgKey) {
        return c.json({ error: 'wireguardPublicKey is required' }, 400);
      }

      const durationMinutes = resolveDurationMinutes(body, pricing);

      // Real VPN: add peer on boringtun (protocol/boringtun http_api.rs)
      const boringtun = await registerWireGuardPeer(wgKey);
      const session = env.sessionStore.createSession(wgKey, durationMinutes, boringtun);
      const sessionId = createHash('sha256').update(wgKey).digest('hex').slice(0, 16);

      return c.json({
        sessionId,
        status: 'ok',
        // Fields match boringtun /v1/register + session metadata (client vpn.rs expects these)
        server_public_key: boringtun.server_public_key,
        endpoint: boringtun.endpoint,
        assigned_ip: boringtun.assigned_ip,
        wireguardPublicKey: wgKey,
        durationMinutes: session.durationMinutes,
        expiresAt: new Date(session.expiresAt).toISOString(),
        pricePaidDescription: priceDescription(durationMinutes, pricing),
      });
    } catch (error) {
      console.error('Connect handler error:', error);
      const message = error instanceof Error ? error.message : 'Internal server error';
      return c.json({ error: message }, 400);
    }
  };
}

/**
 * POST /renew — extend paid session; re-register peer idempotently on boringtun.
 */
export function createRenewHandler(env: ServerEnv) {
  const pricing = loadPricingConfig();

  return async (c: Context) => {
    try {
      console.log('✓ PAYMENT VERIFIED — POST /renew');

      const body = parseBody(c);
      const wgKey = body.wireguardPublicKey?.trim();
      if (!wgKey) {
        return c.json({ error: 'wireguardPublicKey is required' }, 400);
      }

      const existing = env.sessionStore.getSession(wgKey);
      const fallbackMinutes = existing?.durationMinutes;
      const durationMinutes = resolveDurationMinutes(body, pricing, fallbackMinutes);

      const session = env.sessionStore.renewSession(wgKey, durationMinutes, pricing);

      // Keep boringtun peer active (idempotent if already registered)
      await registerWireGuardPeer(wgKey);

      return c.json({
        status: 'ok',
        wireguardPublicKey: wgKey,
        server_public_key: session.serverPublicKey,
        endpoint: session.endpoint,
        assigned_ip: `${session.assignedIp}/32`,
        durationMinutes: session.durationMinutes,
        expiresAt: new Date(session.expiresAt).toISOString(),
        renewedCount: session.renewedCount,
        pricePaidDescription: priceDescription(durationMinutes, pricing),
      });
    } catch (error) {
      console.error('Renew handler error:', error);
      const message = error instanceof Error ? error.message : 'Internal server error';
      return c.json({ error: message }, 400);
    }
  };
}

/** POST /session/clear — dev helper: drop server session + boringtun peer (no payment) */
export function createClearSessionHandler(env: ServerEnv) {
  return async (c: Context) => {
    try {
      const body = parseBody(c);
      const wgKey = body.wireguardPublicKey?.trim();
      if (!wgKey) {
        return c.json({ error: 'wireguardPublicKey is required' }, 400);
      }

      const hadSession = env.sessionStore.deleteSession(wgKey);
      try {
        await unregisterWireGuardPeer(wgKey);
      } catch (err) {
        console.warn('[clear] boringtun unregister:', err);
      }

      return c.json({
        status: 'ok',
        cleared: true,
        hadSession,
        wireguardPublicKey: wgKey,
        message: 'Session cleared. You can POST /connect again with a new payment.',
      });
    } catch (error) {
      console.error('Clear session error:', error);
      const message = error instanceof Error ? error.message : 'Internal server error';
      return c.json({ error: message }, 400);
    }
  };
}

/** GET /pricing — free quote before paying */
export function createPricingHandler() {
  const pricing = loadPricingConfig();

  return (c: Context) => {
    const durationParam = c.req.query('durationMinutes');
    const durationMinutes = durationParam
      ? resolveDurationMinutes({ durationMinutes: parseInt(durationParam, 10) }, pricing)
      : pricing.defaultSessionMinutes;

    return c.json({
      durationMinutes,
      priceUSDC: priceDescription(durationMinutes, pricing),
      pricePerMinuteUSDC: `$${pricing.pricePerMinuteUSDC}`,
      renewWindowSeconds: pricing.renewWindowSeconds,
      minSessionMinutes: pricing.minSessionMinutes,
      maxSessionMinutes: pricing.maxSessionMinutes,
    });
  };
}

/** GET /session/:wireguardPublicKey — session status */
export function createSessionStatusHandler(env: ServerEnv) {
  const pricing = loadPricingConfig();

  return (c: Context) => {
    const wgKey = decodeURIComponent(c.req.param('wireguardPublicKey') || '');
    if (!wgKey) {
      return c.json({ error: 'wireguardPublicKey param required' }, 400);
    }
    const session = env.sessionStore.getSession(wgKey);

    if (!session) {
      return c.json({ active: false, wireguardPublicKey: wgKey }, 200);
    }

    const now = Date.now();
    const timeLeftMs = session.expiresAt - now;

    return c.json({
      active: true,
      wireguardPublicKey: wgKey,
      assignedIp: session.assignedIp,
      serverPublicKey: session.serverPublicKey,
      endpoint: session.endpoint,
      durationMinutes: session.durationMinutes,
      expiresAt: new Date(session.expiresAt).toISOString(),
      secondsRemaining: Math.max(0, Math.floor(timeLeftMs / 1000)),
      canRenew: timeLeftMs > 0,
      renewWindowSeconds: pricing.renewWindowSeconds,
      renewedCount: session.renewedCount,
    });
  };
}
