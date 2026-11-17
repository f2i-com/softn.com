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

  // The page's offline copy was looked up in every cache of the origin, the model cache too,
  // where an app's script names what is kept and under which address.
  it("answers the page offline from its own cache, never from the model cache", async () => {
    const navigate = new Request(SCOPE);
    Object.defineProperty(navigate, 'mode', { value: 'navigate' });
    const { version } = install({}, async () => new Response(''));
    // Kept under the scope's path, which is what the worker asks for.
    const page = new URL(SCOPE).pathname;
    const { fetchFor } = install(
      {
        'softn-models-v1': { [page]: () => new Response('kept as a model') },
        [version]: { [page]: () => new Response('<!doctype html>the page') },
      },
      async () => { throw new TypeError('offline'); }
    );
    expect(await (await fetchFor(navigate)).text()).toBe('<!doctype html>the page');
  });

  it('answers an asset from its own cache when it has it', async () => {
    const asset = `${SCOPE}assets/index-AbCd1234.js`;
    const { version } = install({}, async () => new Response(''));
    const { fetchFor } = install({ [version]: { [asset]: () => new Response('cached runtime') } }, async () => { throw new TypeError('offline'); });
    expect(await (await fetchFor(new Request(asset))).text()).toBe('cached runtime');
  });

  // The workers' files keep their names from release to release. Cache first, a returning
  // visitor ran the last release's script and sandbox workers with this release's page.
  it('asks the network first for the runtime’s workers, and answers from its copy only without one', async () => {
    const worker = `${SCOPE}assets/core-runtime/runtime/sandbox-worker.js`;
    const torch = `${SCOPE}assets/core-runtime/zipp_torch.wasm`;
    const { version } = install({}, async () => new Response(''));
    const kept = { [version]: { [worker]: () => new Response('/* sandbox worker of release A */'), [torch]: () => new Response('torch A') } };

    const online = install(kept, async (request) => new Response(`/* release B: ${new URL(request.url).pathname} */`));
    expect(await (await online.fetchFor(new Request(worker))).text()).toBe('/* release B: /assets/core-runtime/runtime/sandbox-worker.js */');
    expect(await (await online.fetchFor(new Request(torch))).text()).toBe('/* release B: /assets/core-runtime/zipp_torch.wasm */');

    const offline = install(kept, async () => {
      throw new TypeError('offline');
    });
    expect(await (await offline.fetchFor(new Request(worker))).text()).toBe('/* sandbox worker of release A */');
    // Nothing kept and no network: the request fails, as it would with no worker at all.
    await expect(offline.fetchFor(new Request(`${SCOPE}assets/core-runtime/runtime/model-worker.js`))).rejects.toThrow('offline');

    // A file named by its contents is still answered from the copy, with no request.
    const hashed = `${SCOPE}assets/index-AbCd1234.js`;
    const asked: string[] = [];
    const cached = install({ [version]: { [hashed]: () => new Response('cached runtime') } }, async (request) => {
      asked.push(request.url);
      return new Response('from the network');
    });
    expect(await (await cached.fetchFor(new Request(hashed))).text()).toBe('cached runtime');
    expect(asked).toEqual([]);
    // And so is the container's, whose folder is named by the digest of what is in it.
    const container = `${SCOPE}assets/container-runtime/e03138f892dd/container-worker.js`;
    const digest = install({ [version]: { [container]: () => new Response('container worker') } }, async () => new Response('from the network'));
    expect(await (await digest.fetchFor(new Request(container))).text()).toBe('container worker');
  });

  // Every cache but this worker's own went when it activated, and with them
  // the models apps had downloaded, at every bump of VERSION.
  it('keeps the downloaded models when a new version of it activates', async () => {
    const { version } = install({}, async () => new Response(''));
    const { activate } = install({ 'softn-serve-sw-1': {}, [version]: {}, 'softn-models-v1': {} }, async () => new Response(''));
    expect(await activate()).toEqual(['softn-serve-sw-1']);
  });
});
