export interface ConnectRequestBody {
  /** Client WireGuard public key (base64). Required. */
  wireguardPublicKey: string;
  /** How long the VPN session should last. Payment = duration × price-per-minute. */
  durationMinutes?: number;
}

export interface RenewRequestBody {
  /** Must match an active session from /connect. */
  wireguardPublicKey: string;
  /** Optional: extend by a new duration. Defaults to the original session length. */
  durationMinutes?: number;
}

export interface VpnSession {
  wireguardPublicKey: string;
  durationMinutes: number;
  expiresAt: number;
  assignedIp: string;
  serverPublicKey: string;
  endpoint: string;
  createdAt: number;
  renewedCount: number;
}

export interface VpnConnectResponse {
  sessionId: string;
  wireguardPublicKey: string;
  serverPublicKey: string;
  endpoint: string;
  assignedIp: string;
  durationMinutes: number;
  expiresAt: string;
  pricePaidDescription: string;
}

export interface VpnRenewResponse {
  wireguardPublicKey: string;
  durationMinutes: number;
  expiresAt: string;
  renewedCount: number;
  pricePaidDescription: string;
}

export interface PricingQuoteResponse {
  durationMinutes: number;
  priceUSDC: string;
  pricePerMinuteUSDC: string;
  renewWindowSeconds: number;
  minSessionMinutes: number;
  maxSessionMinutes: number;
}

export interface ParsedRequestBody {
  wireguardPublicKey?: string;
  durationMinutes?: number;
}
