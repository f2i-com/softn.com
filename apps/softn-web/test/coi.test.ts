// @vitest-environment node
/**
 * public/coi.js, the service worker's answer to a navigation or a worker
 * script when the network fails or stalls: a copy from the site's own caches.
 *
 * It looked in every cache of the origin, the model cache included, and an
 * app's script names what goes in that one by address (core's model-host.ts):
 * a model URL of `<site>/web/?.gguf` put the site's page under `/web/` there,
 * stored as a download, and offline SoftN Web opened as that download.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../public/coi.js', import.meta.url), 'utf8');
const SCOPE = 'https://softn.test/web/';

type FetchHandler = (event: { request: Request; respondWith(answer: Promise<Response>): void }) => void;

/** Runs coi.js against caches by name, each a map from address to a response, matched as the Cache API does. */
function install(stores: Record<string, Record<string, () => Response>>) {
  let handler: FetchHandler | undefined;
  const self = {
    registration: { scope: SCOPE },
    addEventListener: (type: string, listener: FetchHandler) => { if (type === 'fetch') handler = listener; },
  };
  const strip = (url: string) => url.split('?')[0];
  const open = async (name: string) => ({
    match: async (request: Request | string, options?: { ignoreSearch?: boolean }) => {
      const url = typeof request === 'string' ? request : request.url;
      const kept = Object.entries(stores[name] ?? {}).find(([key]) => (options?.ignoreSearch ? strip(key) === strip(url) : key === url));
      return kept?.[1]();
    },
  });
  const caches = {
    keys: async () => Object.keys(stores),
    open,
    // What a lookup across every cache of the origin finds: the first match, in the order the caches were made.
    match: async (request: Request | string) => {
      for (const name of Object.keys(stores)) {
        const found = await (await open(name)).match(request);
        if (found) return found;
      }
      return undefined;
    },
  };
  const offline = async () => { throw new TypeError('Failed to fetch'); };
  new Function('self', 'caches', 'fetch', source)(self, caches, offline);
  return async (request: Request) => {
    let answer: Promise<Response> | undefined;
    handler!({ request, respondWith: (promise) => { answer = promise; } });
    return answer!;
  };
}

function navigation(url: string): Request {
  const request = new Request(url);
  Object.defineProperty(request, 'mode', { value: 'navigate' });
  return request;
}

describe('coi.js offline', () => {
  it("answers SoftN Web's page from the site's cache, not from what an app put in the model cache", async () => {
    const answer = install({
      // Made first, as a model loaded before the site's caches were filled would make it.
      'softn-models-v1': { [SCOPE]: () => new Response('the site page, kept as a model', { headers: { 'content-type': 'application/octet-stream' } }) },
      'workbox-precache-v2': { [`${SCOPE}index.html`]: () => new Response('<!doctype html>SoftN Web', { headers: { 'content-type': 'text/html' } }) },
    });
    const response = await answer(navigation(SCOPE));
    expect(await response.text()).toBe('<!doctype html>SoftN Web');
    expect(response.headers.get('content-type')).toBe('text/html');
    expect(response.headers.get('cross-origin-embedder-policy')).toBe('credentialless');
  });

  it('still answers a navigation from the cache that holds that page', async () => {
    const answer = install({ 'workbox-precache-v2': { [`${SCOPE}docs/`]: () => new Response('docs') } });
    expect(await (await answer(navigation(`${SCOPE}docs/?q=1`))).text()).toBe('docs');
  });

  // A runtime cache holds what was fetched by whatever address it was asked for: an app's
  // <img src="/web/?n=1/assets/a.js"> kept SoftN Web's page there, and with the query set
  // aside `/web/` was answered with it, a copy that went stale with the next release.
  it('sets a query aside only in the precache', async () => {
    const answer = install({
      'softn-feature-chunks': { [`${SCOPE}?n=1/assets/a.js`]: () => new Response('planted') },
      'workbox-precache-v2': { [`${SCOPE}index.html`]: () => new Response('<!doctype html>SoftN Web') },
    });
    expect(await (await answer(navigation(SCOPE))).text()).toBe('<!doctype html>SoftN Web');
  });
});
