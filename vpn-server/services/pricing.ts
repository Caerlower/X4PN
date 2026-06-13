import type { ParsedRequestBody } from '../types/vpn.js';

const DEFAULT_PRICE_PER_MINUTE = 0.001;
const DEFAULT_SESSION_MINUTES = 5;
const DEFAULT_MIN_MINUTES = 1;
const DEFAULT_MAX_MINUTES = 60;

export interface PricingConfig {
  pricePerMinuteUSDC: number;
  defaultSessionMinutes: number;
  minSessionMinutes: number;
  maxSessionMinutes: number;
  renewWindowSeconds: number;
}

export function loadPricingConfig(): PricingConfig {
  return {
    pricePerMinuteUSDC: parseFloat(
      process.env.PRICE_PER_MINUTE_USDC || String(DEFAULT_PRICE_PER_MINUTE)
    ),
    defaultSessionMinutes: parseInt(
      process.env.DEFAULT_SESSION_MINUTES || String(DEFAULT_SESSION_MINUTES),
      10
    ),
    minSessionMinutes: parseInt(
      process.env.MIN_SESSION_MINUTES || String(DEFAULT_MIN_MINUTES),
      10
    ),
    maxSessionMinutes: parseInt(
      process.env.MAX_SESSION_MINUTES || String(DEFAULT_MAX_MINUTES),
      10
    ),
    renewWindowSeconds: parseInt(process.env.RENEW_WINDOW_SECONDS || '30', 10),
  };
}

/** Normalize and validate session duration from request body. */
export function resolveDurationMinutes(
  body: ParsedRequestBody | null | undefined,
  config: PricingConfig,
  fallbackMinutes?: number
): number {
  const raw = body?.durationMinutes ?? fallbackMinutes ?? config.defaultSessionMinutes;

  if (!Number.isFinite(raw) || raw < config.minSessionMinutes || raw > config.maxSessionMinutes) {
    throw new Error(
      `durationMinutes must be between ${config.minSessionMinutes} and ${config.maxSessionMinutes}`
    );
  }

  return Math.floor(raw);
}

/** Human-readable x402 price string, e.g. "$0.005" for 5 minutes at $0.001/min. */
export function priceForDuration(minutes: number, config: PricingConfig): string {
  const total = minutes * config.pricePerMinuteUSDC;
  return `$${total.toFixed(6).replace(/\.?0+$/, '') || '0'}`;
}

export function priceDescription(minutes: number, config: PricingConfig): string {
  return `${priceForDuration(minutes, config)} USDC for ${minutes} minute VPN session`;
}
