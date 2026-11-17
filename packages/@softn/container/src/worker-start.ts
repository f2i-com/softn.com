/**
 * Start the container's Worker so that the embedding page's service worker stands behind it.
 *
 * A browser chooses the service worker for a Worker by the address of the Worker's own
 * script, not by the page that starts it. In a SoftN site the container's files are kept once
 * under /shared/container-runtime/, outside every app's service-worker scope, so its Worker
 * was fetched with no service worker at all, and so was the engine's bindings it imports:
 * an app that had run a hundred times did not start offline.
 *
 * A Worker started from a `blob:` address takes the service worker of the page that made it.
 * So where the page is controlled and the script lies outside that worker's folder, the
 * Worker is started from a one-line module that imports the script by its address; the import
 * is then an ordinary request of a controlled Worker. Everywhere else it is started as
 * written, and a host's policy is asked for no `worker-src blob:`.
 *
 * The same rule as `startModuleWorker` in @softn/core (runtime/module-worker.ts), kept here
 * as well because this package runs without core.
 */

/** Whether a Worker script at `href` would be fetched without the service worker that controls this page. */
export function outsideServiceWorkerScope(href: string): boolean {
  const controller = typeof navigator !== 'undefined' ? navigator.serviceWorker?.controller : null;
  if (!controller) return false;
  try {
    return !href.startsWith(new URL('./', controller.scriptURL).href);
  } catch {
    return false;
  }
}

const BOOTSTRAP_KEPT_MS = 60_000;

export function startModuleWorker(url: string, options: WorkerOptions = {}): Worker {
  const settings: WorkerOptions = { ...options, type: 'module' };
  let href: string;
  try {
    href = new URL(url, typeof location !== 'undefined' ? location.href : undefined).href;
  } catch {
    return new Worker(url, settings);
  }
  if (!outsideServiceWorkerScope(href) || typeof URL.createObjectURL !== 'function') return new Worker(url, settings);
  const bootstrap = URL.createObjectURL(new Blob([`import ${JSON.stringify(href)};`], { type: 'text/javascript' }));
  try {
    return new Worker(bootstrap, settings);
  } finally {
    setTimeout(() => URL.revokeObjectURL(bootstrap), BOOTSTRAP_KEPT_MS);
  }
}
