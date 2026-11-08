// @vitest-environment jsdom
/**
 * The engine half of the hosted editor bridge (`engine: 1`): an editor in
 * FormLogic names the ZIPP build it was made with, and takes that build's bytes
 * from the host when it connects, so the editor FormLogic installs carries no
 * engine of its own. A host from before it sends none, and the editor fetches
 * its own as it always did.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

type Mod = typeof import('../src/hostedEditor');

async function loadModule(): Promise<Mod> {
  vi.resetModules();
  return import('../src/hostedEditor');
}

function hostedLocation() {
  Object.defineProperty(window, 'location', { value: { ...window.location, search: '?formlogicEditor=1', origin: 'http://formlogic.test', href: 'http://formlogic.test/app-editors/builder/index.html?formlogicEditor=1' }, configurable: true, writable: true });
  Object.defineProperty(window, 'parent', { value: { postMessage: vi.fn() }, configurable: true, writable: true });
}

function connect(data: Record<string, unknown>) {
  const channel = new MessageChannel();
  window.dispatchEvent(new MessageEvent('message', {
    data: { kind: 'formlogic-editor-connect', protocol: 1, ...data },
    origin: location.origin,
    source: window.parent as unknown as Window,
    ports: [channel.port1],
  }));
  return channel;
}

const BUILD = { version: 'v0.0.33', sha256: 'a'.repeat(64) };
const engineBytes = () => new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
const readyMessages = () => (window.parent.postMessage as ReturnType<typeof vi.fn>).mock.calls.map(([data]) => data as Record<string, unknown>).filter((data) => data.kind === 'formlogic-editor-ready');

afterEach(() => { vi.restoreAllMocks(); });

describe('the engine a hosted editor takes from FormLogic', () => {
  it('names the build it was made with, and takes the bytes the host sends when it connects', async () => {
    hostedLocation();
    const mod = await loadModule();
    const source = mod.hostedEngineSource(BUILD);
    const dispose = mod.connectHostedEditor({ open: async () => {}, export: () => new Uint8Array([1]) });
    expect(readyMessages()[0]).toMatchObject({ engine: mod.HOSTED_ENGINE_VERSION, zipp: BUILD });
    connect({ zippWasm: engineBytes() });
    expect(await source).toEqual(engineBytes());
    dispose();
  });

  it('takes an ArrayBuffer as well, and settles once: a second connect changes nothing', async () => {
    hostedLocation();
    const mod = await loadModule();
    const source = mod.hostedEngineSource(BUILD);
    const dispose = mod.connectHostedEditor({ open: async () => {}, export: () => new Uint8Array([1]) });
    connect({ zippWasm: engineBytes().buffer });
    connect({ zippWasm: new Uint8Array(16) });
    expect(await source).toEqual(engineBytes());
    dispose();
  });

  it('settles with null for a host that sends none, or something that is not engine bytes', async () => {
    for (const zippWasm of [undefined, 'https://elsewhere.example/engine.wasm', new Uint8Array(4), { length: 8 }]) {
      hostedLocation();
      const mod = await loadModule();
      const source = mod.hostedEngineSource(BUILD);
      const dispose = mod.connectHostedEditor({ open: async () => {}, export: () => new Uint8Array([1]) });
      connect(zippWasm === undefined ? {} : { zippWasm });
      expect(await source).toBeNull();
      dispose();
    }
  });

  it('announces no engine when the editor does not ask for one (the standalone Builder and Studio)', async () => {
    hostedLocation();
    const mod = await loadModule();
    const dispose = mod.connectHostedEditor({ open: async () => {}, export: () => new Uint8Array([1]) });
    expect(readyMessages()[0]).not.toHaveProperty('engine');
    expect(readyMessages()[0]).not.toHaveProperty('zipp');
    dispose();
  });
});

describe("a host's own ZIPP in an editor (glue: 1)", () => {
  const glue = { url: 'http://formlogic.test/zipp/a844efe3d7d0/zipp_wasm.js', sha256: 'c'.repeat(64) };

  it('says it takes one, and takes the glue the host names in its ZIPP folder with the engine', async () => {
    hostedLocation();
    const mod = await loadModule();
    const engine = mod.hostedEngineSource(BUILD);
    const named = mod.hostedGlueSource();
    const dispose = mod.connectHostedEditor({ open: async () => {}, export: () => new Uint8Array([1]) });
    expect(readyMessages()[0]).toMatchObject({ engine: 1, glue: mod.HOSTED_GLUE_VERSION, zipp: BUILD });
    expect(mod.hostedZippFolder()).toBe('http://formlogic.test/zipp/');
    const torch = { url: 'http://formlogic.test/zipp/a844efe3d7d0/zipp_torch.wasm', sha256: 'd'.repeat(64) };
    connect({ zippWasm: engineBytes(), zippGlue: glue, zippTorch: torch });
    expect(await named).toEqual({ glue, torch });
    expect(await engine).toEqual(engineBytes());
    dispose();
  });

  it('takes the glue without a torch package the host does not name, or names outside its folder', async () => {
    for (const zippTorch of [undefined, { url: 'http://formlogic.test/assets/zipp_torch.wasm', sha256: 'd'.repeat(64) }]) {
      hostedLocation();
      const mod = await loadModule();
      mod.hostedEngineSource(BUILD);
      const named = mod.hostedGlueSource();
      const dispose = mod.connectHostedEditor({ open: async () => {}, export: () => new Uint8Array([1]) });
      connect({ zippWasm: engineBytes(), zippGlue: glue, ...(zippTorch ? { zippTorch } : {}) });
      expect(await named).toEqual({ glue });
      dispose();
    }
  });

  it('takes none from elsewhere, without its digest, or without the engine it goes with, and then not that engine either', async () => {
    for (const [zippGlue, zippWasm] of [
      [{ ...glue, url: 'http://formlogic.test/assets/zipp_wasm.js' }, engineBytes()],
      [{ ...glue, url: 'http://elsewhere.test/zipp/a844efe3d7d0/zipp_wasm.js' }, engineBytes()],
      [{ ...glue, url: 'http://formlogic.test/zipp/../assets/app.js' }, engineBytes()],
      [{ ...glue, url: 'http://formlogic.test/zipp/..%2fassets/zipp_wasm.js' }, engineBytes()],
      [{ ...glue, url: 'http://formlogic.test/zipp/x/zipp_wasm.js' }, engineBytes()],
      [{ url: glue.url }, engineBytes()],
      [glue, undefined],
    ] as const) {
      hostedLocation();
      const mod = await loadModule();
      const engine = mod.hostedEngineSource(BUILD);
      const named = mod.hostedGlueSource();
      const dispose = mod.connectHostedEditor({ open: async () => {}, export: () => new Uint8Array([1]) });
      connect({ ...(zippWasm ? { zippWasm } : {}), zippGlue });
      expect(await named).toBeNull();
      // The engine was sent for the glue that was refused: the editor does not start it on its own glue.
      expect(await engine).toBeNull();
      dispose();
    }
  });

  it('does not say it takes one when the editor did not ask', async () => {
    hostedLocation();
    const mod = await loadModule();
    mod.hostedEngineSource(BUILD);
    const dispose = mod.connectHostedEditor({ open: async () => {}, export: () => new Uint8Array([1]) });
    expect(readyMessages()[0]).toMatchObject({ engine: 1 });
    expect(readyMessages()[0]).not.toHaveProperty('glue');
    dispose();
  });
});