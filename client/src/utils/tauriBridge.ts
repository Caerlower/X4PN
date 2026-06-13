import { invoke as tauriInvoke, isTauri as apiIsTauri } from '@tauri-apps/api/core';
import { listen as tauriListen } from '@tauri-apps/api/event';

export function isTauri(): boolean {
  if (typeof window === 'undefined') return false;
  if (apiIsTauri()) return true;

  const w = window as Window & {
    __TAURI__?: unknown;
    __TAURI_INTERNALS__?: unknown;
    __TAURI_IPC__?: unknown;
    isTauri?: boolean;
  };

  return Boolean(w.isTauri || w.__TAURI__ || w.__TAURI_INTERNALS__ || w.__TAURI_IPC__);
}

/** Probe whether Tauri IPC works (reliable in dev with remote devUrl). */
export async function probeTauriIpc(): Promise<boolean> {
  try {
    await tauriInvoke('get_status');
    return true;
  } catch {
    return false;
  }
}

export async function tauriInvokeSafe<T>(
  cmd: string,
  args?: Record<string, unknown>
): Promise<T> {
  return tauriInvoke<T>(cmd, args);
}

export function tauriListenSafe<T>(
  event: string,
  handler: (payload: T) => void
): Promise<() => void> {
  return tauriListen<T>(event, (e) => handler(e.payload));
}
