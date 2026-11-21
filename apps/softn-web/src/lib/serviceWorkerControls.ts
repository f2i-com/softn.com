/** How long to wait for a worker that is installing to take the page. */
const SERVICE_WORKER_WAIT_MS = 10_000;

/**
 * Whether a service worker holds this page's fetches.
 *
 * `ready` resolves once a worker is active for the scope, and the runtime's
 * worker claims open pages as it activates (`clientsClaim`), so on a first
 * visit the controller can arrive a moment after the app has opened; it is
 * waited for, briefly. A page with no worker at all — a dev server, a
 * browser without them, a private window that refuses registration —
 * resolves false, and the install says so rather than counting a fetch
 * nothing kept.
 */
export async function serviceWorkerControls(): Promise<boolean> {
  const container = typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined;
  if (!container) return false;
  if (container.controller) return true;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      container.removeEventListener('controllerchange', onChange);
      resolve(value);
    };
    const onChange = (): void => finish(Boolean(container.controller));
    const timer = setTimeout(() => finish(Boolean(container.controller)), SERVICE_WORKER_WAIT_MS);
    container.addEventListener('controllerchange', onChange);
    container.ready.then(
      () => {
        // Active, and either already in control or about to say so.
        if (container.controller) finish(true);
      },
      () => finish(false)
    );
  });
}
