// @vitest-environment node
/**
 * public/sw.js answers the runtime's hashed assets cache first. It looked in
 * every cache of the origin, and an app's model downloads share it, under
 * addresses the app's script names (core's model-host.ts): a model fetched as
 * `<page>/assets/index-<hash>.js#.gguf` was kept under the asset's address,
 * as a download, and the app's own runtime was answered with it.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
const SCOPE = 'https://app.test/';

type FetchHandler = (event: { request: Request; respondWith(answer: Promise<Response>): void; waitUntil(work: Promise<unknown>): void }) => void;

function install(stores: Record<string, Record<string, () => Response>>, network: (request: Request) => Promise<Response>) {
  const handlers: Record<string, FetchHandler> = {};
  const deleted: string[] = [];
  const version = /var VERSION = '([^']+)'/.exec(source)![1];
  const self = {
    registration: { scope: SCOPE },
    location: { origin: new URL(SCOPE).origin },
    clients: { claim: async () => {} },
    addEventListener: (type: string, listener: FetchHandler) => { handlers[type] = listener; },
  };
  const open = async (name: string) => ({
    match: async (request: Request | string) => stores[name]?.[typeof request === 'string' ? request : request.url]?.(),
    put: async () => {},
  });
  const caches = {
    keys: async () => Object.keys(stores),
    open,
    delete: async (name: string) => {
      deleted.push(name);
      return delete stores[name];
    },
    match: async (request: Request | string) => {
      for (const name of Object.keys(stores)) {
        const found = await (await open(name)).match(request);
        if (found) return found;
      }
      return undefined;
    },
  };
  new Function('self', 'caches', 'fetch', source)(self, caches, network);
  const fetchFor = async (request: Request) => {
    let answer: Promise<Response> | undefined;
    handlers.fetch({ request, respondWith: (promise) => { answer = promise; }, waitUntil: () => {} });
    return answer!;
  };
  const activate = async () => {
    let work: Promise<unknown> = Promise.resolve();
    handlers.activate({ request: new Request(SCOPE), respondWith: () => {}, waitUntil: (promise) => { work = promise; } });
    await work;
    return deleted;
  };
  return { fetchFor, version, activate };
}

describe('the private host\'s service worker', () => {
  it("answers an asset from its own cache or the network, never from the model cache", async () => {
    const asset = `${SCOPE}assets/index-AbCd1234.js`;
    const { fetchFor } = install(
      { 'softn-models-v1': { [asset]: () => new Response('kept as a model', { headers: { 'content-type': 'application/octet-stream' } }) } },
      async () => new Response('console.log("runtime")', { headers: { 'content-type': 'text/javascript' } })
    );
    const response = await fetchFor(new Request(asset));
    expect(await response.text()).toBe('console.log("runtime")');
  });

  it('answers an asset from its own cache when it has it', async () => {
    const asset = `${SCOPE}assets/index-AbCd1234.js`;
    const { version } = install({}, async () => new Response(''));
    const { fetchFor } = install({ [version]: { [asset]: () => new Response('cached runtime') } }, async () => { throw new TypeError('offline'); });
    expect(await (await fetchFor(new Request(asset))).text()).toBe('cached runtime');
  });

  // Every cache but this worker's own went when it activated, and with them
  // the models apps had downloaded, at every bump of VERSION.
  it('keeps the downloaded models when a new version of it activates', async () => {
    const { version } = install({}, async () => new Response(''));
    const { activate } = install({ 'softn-serve-sw-1': {}, [version]: {}, 'softn-models-v1': {} }, async () => new Response(''));
    expect(await activate()).toEqual(['softn-serve-sw-1']);
  });
});
