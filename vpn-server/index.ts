/**
 * X4PN — x402 Resource Server (Algorand)
 *
 * Two payment-protected endpoints:
 *   POST /connect — pay to start a VPN session
 *   POST /renew   — pay to extend session (last 30s before expiry)
 *
 * Pattern matches x402-demo-server in this repo.
 */

import { config } from 'dotenv';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { paymentMiddlewareFromHTTPServer } from '@x402/hono';
import { x402ResourceServer, HTTPFacilitatorClient, x402HTTPResourceServer } from '@x402/core/server';
import { ExactAvmScheme } from '@x402/avm/exact/server';
import { ALGORAND_TESTNET_CAIP2 } from '@x402/avm';

import createPaymentConfig from './endpoints.config.js';
import { createVpnProtectedRequestHook } from './hooks/vpnHooks.js';
import {
  createConnectHandler,
  createRenewHandler,
  createClearSessionHandler,
  createPricingHandler,
  createSessionStatusHandler,
} from './handlers/vpn.js';
import { SessionStore } from './services/sessionStore.js';
import { loadPricingConfig } from './services/pricing.js';
import { probeBoringtunHealth } from './services/boringtun.js';
import { startSessionExpiryWorker } from './services/sessionExpiry.js';

config();

const avmAddress = process.env.AVM_ADDRESS;
const facilitatorUrl = process.env.FACILITATOR_URL;
const port = parseInt(process.env.PORT || '4021', 10);
const boringtunApi = process.env.BORINGTUN_API_URL || 'http://127.0.0.1:8080';

if (!avmAddress || !facilitatorUrl) {
  console.error(
    '❌ Missing required environment variables:\n' +
      '   AVM_ADDRESS — Algorand wallet receiving USDC\n' +
      '   FACILITATOR_URL — x402 facilitator URL'
  );
  process.exit(1);
}

const pricing = loadPricingConfig();
const sessionStore = new SessionStore();
const serverEnv = { sessionStore };
startSessionExpiryWorker(sessionStore);

console.log('\n' + '═'.repeat(60));
console.log('X4PN — x402 Resource Server');
console.log('═'.repeat(60));
console.log(`  Receiver:     ${avmAddress}`);
console.log(`  Facilitator:  ${facilitatorUrl}`);
console.log(`  Port:         ${port}`);
console.log(`  Price/min:    $${pricing.pricePerMinuteUSDC} USDC`);
console.log(`  Boringtun API: ${boringtunApi}`);
console.log(`  Renew window: last ${pricing.renewWindowSeconds}s before expiry`);

const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });
const x402Server = new x402ResourceServer(facilitatorClient);
x402Server.register(ALGORAND_TESTNET_CAIP2, new ExactAvmScheme());

const paymentConfig = createPaymentConfig(avmAddress, sessionStore);
const httpResourceServer = new x402HTTPResourceServer(x402Server, paymentConfig).onProtectedRequest(
  createVpnProtectedRequestHook(sessionStore)
);

console.log('📋 Payment-protected endpoints:');
console.log('   POST /connect — VPN session start (duration × price/min)');
console.log(`   POST /renew   — extend session (last ${pricing.renewWindowSeconds}s only)`);
console.log();

const app = new Hono();

// Cache JSON body so x402 dynamic pricing + hooks can read it
app.use('*', async (c, next) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Expose-Headers': '*',
    'Access-Control-Max-Age': '86400',
  };

  if (c.req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  Object.entries(corsHeaders).forEach(([key, value]) => c.header(key, value));

  if (c.req.method === 'POST') {
    try {
      const body = await c.req.raw.clone().json();
      c.set('parsedBody', body);
      c.req.json = async () => body;
    } catch {
      c.set('parsedBody', undefined);
    }
  }

  await next();
});

app.use('*', async (c, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${c.req.method} ${c.req.path}`);
  if (c.req.header('payment-signature')) {
    console.log('  ✓ Payment-Signature header present');
  }
  await next();
  console.log(`  → ${c.res.status}`);
});

app.use(paymentMiddlewareFromHTTPServer(httpResourceServer));

// Paid handlers (only run after x402 verifies payment)
app.post('/connect', createConnectHandler(serverEnv));
app.post('/renew', createRenewHandler(serverEnv));

// Free helpers (not in payment config — no x402 required)
app.post('/session/clear', createClearSessionHandler(serverEnv));
app.get('/health', async (c) => {
  const boringtun = await probeBoringtunHealth();
  return c.json({
    status: boringtun.ok ? 'ok' : 'degraded',
    service: 'x4pn-x402',
    uptime: process.uptime(),
    boringtun,
  });
});

app.get('/pricing', createPricingHandler());

app.get('/session/:wireguardPublicKey', createSessionStatusHandler(serverEnv));

app.get('/info', (c) =>
  c.json({
    service: 'x4pn-x402',
    network: 'Algorand TestNet',
    receiver: avmAddress,
    endpoints: {
      paid: ['POST /connect', 'POST /renew'],
      free: ['GET /health', 'GET /info', 'GET /pricing', 'GET /session/:wireguardPublicKey', 'POST /session/clear'],
    },
    pricing: {
      pricePerMinuteUSDC: pricing.pricePerMinuteUSDC,
      defaultSessionMinutes: pricing.defaultSessionMinutes,
      renewWindowSeconds: pricing.renewWindowSeconds,
    },
  })
);

app.notFound((c) =>
  c.json({ error: 'Not found', path: c.req.path, hint: 'Try GET /info' }, 404)
);

const server = serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, () => {
  console.log(`\n✅ X4PN server running at http://localhost:${port}\n`);
  console.log('Quick test:');
  console.log(`  curl http://localhost:${port}/health`);
  console.log(`  curl "http://localhost:${port}/pricing?durationMinutes=5"`);
  console.log(`  curl -X POST http://localhost:${port}/connect  → 402 Payment Required\n`);
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ Port ${port} is already in use (EADDRINUSE).`);
    console.error('   Another vpn-server instance is probably still running.');
    console.error('\n   Fix:');
    console.error('   • Stop the other terminal running `pnpm dev`, or');
    console.error(`   • Free the port:  lsof -ti :${port} | xargs kill`, '\n');
    process.exit(1);
  }
  console.error('Server error:', err);
  process.exit(1);
});

function shutdown(signal: string) {
  console.log(`\n[${signal}] Shutting down...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

declare module 'hono' {
  interface ContextVariableMap {
    parsedBody: unknown;
  }
}
