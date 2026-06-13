import { unregisterWireGuardPeer } from './boringtun.js';
import type { SessionStore } from './sessionStore.js';

const CHECK_INTERVAL_MS = 10_000;

/**
 * When a paid session expires, remove the WireGuard peer from boringtun.
 */
export function startSessionExpiryWorker(sessionStore: SessionStore): void {
  setInterval(async () => {
    const expired = sessionStore.listExpired();
    for (const session of expired) {
      try {
        await unregisterWireGuardPeer(session.wireguardPublicKey);
        sessionStore.deleteSession(session.wireguardPublicKey);
        console.log(
          `[expiry] removed peer ${session.wireguardPublicKey.slice(0, 12)}… (session ended)`
        );
      } catch (err) {
        console.error('[expiry] failed to remove peer:', err);
      }
    }
  }, CHECK_INTERVAL_MS);

  console.log('[expiry] session expiry worker started');
}
