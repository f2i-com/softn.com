/**
 * Start a module Worker so that the page's service worker stands behind it.
 *
 * A browser chooses the service worker for a Worker by the address of the Worker's own
 * script, not by the page that starts it: a script outside the service worker's scope is
 * fetched with no service worker at all, and so is everything that Worker then asks for.
 * Offline, such a Worker does not start. That is the arrangement of the site build, where
 * every app's built files, the workers' among them, are kept once under /shared/assets/
 * (scripts/build/shared-assets.mjs) and each app's service worker has the app's own folder
 * for its scope.
 *
 * A Worker started from a `blob:` address is the exception the rule itself makes: it takes
 * the service worker of the page that made it. So when the page is controlled and the
 * script lies outside that worker's folder, the Worker is started from a one-line module
 * that imports the script by its address. The import is then an ordinary request of a
 * controlled Worker, answered from the precache or a runtime cache like any other; inside
 * the script `import.meta.url` is still its own address, so what it names beside itself is
 * found where it was.
 *
 * Everywhere else (an app built alone, whose workers are under its own base; a page no
 * service worker controls; the desktop and FormLogic hosts) the Worker is started as written,
 * and nothing here asks a host's policy for `worker-src blob:`.
 */

/** Whether a Worker script at `href` would be fetched without the service worker that controls this page. */
export function outsideServiceWorkerScope(href: string): boolean {
  const controller = typeof navigator !== 'undefined' ? navigator.serviceWorker?.controller : null;
  if (!controller) return false;
  try {
    // A service worker's widest scope is its own folder, and SoftN's apps register theirs with it.
    return !href.startsWith(new URL('./', controller.scriptURL).href);
  } catch {
    return false;
  }
}

/** How long the one-line module's address is kept: past any start, and the blob is a few bytes. */
const BOOTSTRAP_KEPT_MS = 60_000;

/** `new Worker(url, { ...options, type: 'module' })`, behind the page's service worker wherever the script is. */
export function startModuleWorker(url: string | URL, options: WorkerOptions = {}): Worker {
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

/**
 * `startModuleWorker` as a constructor, for a Worker the bundler builds from its source:
 *
 *     import { ScopedWorker as Worker } from '@softn/core';
 *     new Worker(new URL('./zipWorker.ts', import.meta.url), { type: 'module' });
 *
 * Vite builds a Worker's script when it reads exactly `new Worker(new URL(…, import.meta.url))`,
 * so the call keeps that spelling and the name is bound to this instead of the browser's own.
 */
export const ScopedWorker = function ScopedWorker(url: string | URL, options?: WorkerOptions): Worker {
  return startModuleWorker(url, options);
} as unknown as { new (url: string | URL, options?: WorkerOptions): Worker };
