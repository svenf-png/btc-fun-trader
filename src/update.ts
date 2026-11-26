// Detects a newer deployed build and reloads into it.
// Every build writes version.json with its build id; the running app compares
// that file (fetched without any cache) with the id it was built with.

export const BUILD_ID: string = __BUILD_ID__;

/** True when the server reports a different, non-empty build id. */
export function isNewer(current: string, remote: unknown): boolean {
  return typeof remote === 'string' && remote.trim() !== '' && remote !== current;
}

export async function fetchRemoteBuild(base: string): Promise<string | null> {
  try {
    const res = await fetch(`${base}version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return null;
    const data = (await res.json()) as { build?: unknown };
    return typeof data.build === 'string' ? data.build : null;
  } catch {
    return null; // offline or dev server without version.json
  }
}

/** Load the new version: refresh the service worker, drop old caches, reload. */
export async function reloadToLatest(): Promise<void> {
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    await reg?.update();
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch {
    /* reload anyway */
  }
  // Warm the page through the network, bypassing the HTTP cache (max-age=600 on GitHub Pages),
  // so the reload below cannot get a stale index.html even from an older service worker.
  try {
    await fetch(window.location.href.split('#')[0], { cache: 'reload' });
  } catch {
    /* offline: the reload falls back to the cached shell */
  }
  window.location.reload();
}
