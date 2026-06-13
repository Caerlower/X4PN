import type { VpnSession } from '../types/vpn.js';
import type { PricingConfig } from './pricing.js';
import type { BoringtunRegisterResponse } from './boringtun.js';

/**
 * Tracks paid VPN sessions. WireGuard peers are provisioned via boringtun API.
 */
export class SessionStore {
  private sessions = new Map<string, VpnSession>();

  createSession(
    wireguardPublicKey: string,
    durationMinutes: number,
    boringtun: BoringtunRegisterResponse
  ): VpnSession {
    const now = Date.now();
    const assignedIp = boringtun.assigned_ip.replace(/\/32$/, '');

    const existing = this.sessions.get(wireguardPublicKey);
    if (existing && existing.expiresAt > now) {
      throw new Error('Session already active for this WireGuard key. Use /renew instead.');
    }

    const session: VpnSession = {
      wireguardPublicKey,
      durationMinutes,
      expiresAt: now + durationMinutes * 60 * 1000,
      assignedIp,
      serverPublicKey: boringtun.server_public_key,
      endpoint: boringtun.endpoint,
      createdAt: now,
      renewedCount: 0,
    };

    this.sessions.set(wireguardPublicKey, session);
    return session;
  }

  renewSession(
    wireguardPublicKey: string,
    durationMinutes: number,
    _config: PricingConfig
  ): VpnSession {
    const session = this.sessions.get(wireguardPublicKey);
    if (!session) {
      throw new Error('No active session found. Call /connect first.');
    }

    const now = Date.now();
    if (session.expiresAt <= now) {
      this.sessions.delete(wireguardPublicKey);
      throw new Error('Session expired. Call /connect to start a new session.');
    }

    session.expiresAt = session.expiresAt + durationMinutes * 60 * 1000;
    session.durationMinutes = durationMinutes;
    session.renewedCount += 1;
    this.sessions.set(wireguardPublicKey, session);
    return session;
  }

  getSession(wireguardPublicKey: string): VpnSession | undefined {
    const session = this.sessions.get(wireguardPublicKey);
    if (!session) return undefined;
    if (session.expiresAt <= Date.now()) {
      return undefined;
    }
    return session;
  }

  deleteSession(wireguardPublicKey: string): boolean {
    return this.sessions.delete(wireguardPublicKey);
  }

  /** Sessions past expiresAt (still in map until cleaned up). */
  listExpired(now = Date.now()): VpnSession[] {
    const expired: VpnSession[] = [];
    for (const session of this.sessions.values()) {
      if (session.expiresAt <= now) {
        expired.push(session);
      }
    }
    return expired;
  }
}
