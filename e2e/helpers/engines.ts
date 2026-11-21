import type { BrowserContext, Page } from '@playwright/test';

export const fullEngine = /\/zipp_wasm_bg-[\w-]+\.wasm$/;
export const liteEngine = /\/zipp-javascript-lite\.wasm$/;

/** Include the service worker's own requests as well as the page's. */
export function requestedWasm(context: BrowserContext): Set<string> {
  const paths = new Set<string>();
  context.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.endsWith('.wasm')) paths.add(path);
  });
  return paths;
}

/** Inspect the browser's actual precache and runtime caches after install. */
export async function cachedWasm(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const buckets = await caches.keys();
    const requests = await Promise.all(buckets.map(async (name) => (await caches.open(name)).keys()));
    return [...new Set(requests.flat().map((request) => new URL(request.url).pathname))]
      .filter((path) => path.endsWith('.wasm'));
  });
}
