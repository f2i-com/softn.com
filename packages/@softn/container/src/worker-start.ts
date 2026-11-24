/**
 * Start the container's Worker so that the embedding page's service worker stands behind it.
 *
 * The SoftN site places its module entry inside each app's service-worker scope. That
 * worker and the shared implementation and bindings it imports can all load offline.
 * For other hosts that put the entry outside their scope, a blob bootstrap inherits the
 * page's controller on browsers that support it. Firefox needs an in-scope entry.
 *
 * The same rule as `startModuleWorker` in @softn/core (runtime/module-worker.ts), kept here
 * as well because this package runs without core.
 */

/** Whether a Worker script at `href` would be fetched without the service worker that controls this page. */
export function outsideServiceWorkerScope(href: string): boolean {
  try {
    // Access to navigator.serviceWorker itself can throw in an opaque sandbox.
    const controller = typeof navigator !== 'undefined' ? navigator.serviceWorker?.controller : null;
    if (!controller) return false;
    return !href.startsWith(new URL('./', controller.scriptURL).href);
  } catch {
    return false;
  }
}

const BOOTSTRAP_KEPT_MS = 60_000;

export function startModuleWorker(url: string, options: WorkerOptions = {}): Worker {
  const settings: WorkerOptions = { ...options, type: 'module' };
  let parsed: URL;
  try {
    parsed = new URL(url, typeof location !== 'undefined' ? location.href : undefined);
  } catch {
    return new Worker(url, settings);
  }
  const href = parsed.href;
  const httpScheme = parsed.protocol === 'https:' || parsed.protocol === 'http:';
  if (globalThis.origin === 'null' && httpScheme && typeof URL.createObjectURL === 'function') {
    // Chromium refuses a module worker's initial blob:null module fetch. A classic
    // blob worker inherits the frame's policy and imports the exact same ESM entry.
    // Hold the init message until that module has registered its listener.
    const source = `
      const pending = [];
      const hold = event => pending.push(event.data);
      self.addEventListener('message', hold);
      import(${JSON.stringify(href)}).then(() => {
        self.removeEventListener('message', hold);
        for (const data of pending) self.dispatchEvent(new MessageEvent('message', { data }));
      }).catch(error => setTimeout(() => { throw error; }, 0));
    `;
    const entry = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    try {
      return new Worker(entry, { ...options, type: 'classic' });
    } finally {
      setTimeout(() => URL.revokeObjectURL(entry), BOOTSTRAP_KEPT_MS);
    }
  }
  // Only wrap in a same-origin blob bootstrap when `href` is strictly same-origin HTTP(S) so
  // an active ServiceWorker can never bypass `new Worker()`'s Same-Origin Policy for remote/data URLs.
  const sameOriginHttp =
    httpScheme &&
    typeof globalThis.origin === 'string' &&
    globalThis.origin !== 'null' &&
    parsed.origin === globalThis.origin;
  if (!sameOriginHttp || !outsideServiceWorkerScope(href) || typeof URL.createObjectURL !== 'function') {
    return new Worker(url, settings);
  }
  const bootstrap = URL.createObjectURL(new Blob([`import ${JSON.stringify(href)};`], { type: 'text/javascript' }));
  try {
    return new Worker(bootstrap, settings);
  } finally {
    setTimeout(() => URL.revokeObjectURL(bootstrap), BOOTSTRAP_KEPT_MS);
  }
}
