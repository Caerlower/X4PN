import { ALGORAND_TESTNET_CAIP2, USDC_TESTNET_ASA_ID } from '@x402/avm';
import type { RoutesConfig, HTTPRequestContext } from '@x402/core/server';

import { loadPricingConfig, priceForDuration, resolveDurationMinutes } from './services/pricing.js';
import type { SessionStore } from './services/sessionStore.js';
import type { ParsedRequestBody } from './types/vpn.js';

export type { RoutesConfig as EndpointConfig };

async function readBody(context: HTTPRequestContext): Promise<ParsedRequestBody | null> {
  const body = await context.adapter.getBody?.();
  if (!body || typeof body !== 'object') return null;
  return body as ParsedRequestBody;
}

function requireWireGuardKey(body: ParsedRequestBody | null): string {
  const key = body?.wireguardPublicKey?.trim();
  if (!key) {
    throw new Error('wireguardPublicKey is required in the JSON body');
  }
  return key;
}

/**
 * x402 payment routes for X4PN.
 *
 * POST /connect — first-time VPN access (user picks session duration → price)
 * POST /renew   — extend session in the last 30 seconds before expiry
 */
export function createPaymentConfig(avmAddress: string, sessionStore: SessionStore): RoutesConfig {
  const pricing = loadPricingConfig();

  const dynamicPrice =
    (route: 'connect' | 'renew') =>
    async (context: HTTPRequestContext): Promise<string> => {
      const body = await readBody(context);
      const wgKey = requireWireGuardKey(body);

      let fallbackMinutes: number | undefined;
      if (route === 'renew') {
        fallbackMinutes = sessionStore.getSession(wgKey)?.durationMinutes;
      }

      const minutes = resolveDurationMinutes(body, pricing, fallbackMinutes);
      return priceForDuration(minutes, pricing);
    };

  return {
    'POST /connect': {
      accepts: [
        {
          scheme: 'exact',
          price: dynamicPrice('connect'),
          network: ALGORAND_TESTNET_CAIP2,
          payTo: avmAddress,
          extra: { asset: Number(USDC_TESTNET_ASA_ID) },
        },
      ],
      description: 'X4PN VPN connect — pay for encrypted tunnel access (duration × price/min)',
      mimeType: 'application/json',
      unpaidResponseBody: async () => ({
        contentType: 'application/json',
        body: {
          error: 'payment_required',
          endpoint: '/connect',
          message:
            'Pay to connect to the VPN. Send JSON body with wireguardPublicKey and durationMinutes.',
          hint: 'Call GET /pricing first to see rates, then POST /connect with payment.',
        },
      }),
    },

    'POST /renew': {
      accepts: [
        {
          scheme: 'exact',
          price: dynamicPrice('renew'),
          network: ALGORAND_TESTNET_CAIP2,
          payTo: avmAddress,
          extra: { asset: Number(USDC_TESTNET_ASA_ID) },
        },
      ],
      description: 'X4PN VPN renew — extend an active session',
      mimeType: 'application/json',
      unpaidResponseBody: async () => ({
        contentType: 'application/json',
        body: {
          error: 'payment_required',
          endpoint: '/renew',
          message: 'Pay to extend your active VPN session.',
          hint: 'Send wireguardPublicKey in JSON body. Optional durationMinutes for extension length.',
        },
      }),
    },
  };
}

export default createPaymentConfig;
