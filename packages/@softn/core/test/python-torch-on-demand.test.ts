/**
 * When the runtime loads ZIPP's torch package: only for a Python project
 * that declares torch, once per page, fetched from beside core's chunk, and
 * again after a load that failed.
 *
 * The package is process-wide for the engine's WASM instance, and this file
 * has one instance of its own, so the cases run in order and each starts
 * where the last left off: nothing loaded, a preload that adds nothing, a
 * failed fetch, a load, and loads that find it there. ZIPP's loader is the real one, observed through a spy;
 * `fetch` is stubbed, answering the installed bytes the way a server would.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { addTorch } = vi.hoisted(() => ({ addTorch: vi.fn() }));
vi.mock('../wasm-zipp-torch/zipp_torch.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../wasm-zipp-torch/zipp_torch.js')>();
  addTorch.mockImplementation(real.addTorch);
  return { ...real, addTorch };
});

// Resolved here, before the runtime first imports it: the runtime's first
// import races its fetch, and a mock whose async factory is still running when
// that import is first asked for can be bypassed.
expect((await import('../wasm-zipp-torch/zipp_torch.js')).addTorch).toBe(addTorch);
const { PythonLogicAdapter } = await import('../src/runtime/python/python-logic-adapter');
const { configureZippTorchSource, ensureZippTorch, preloadZippTorch, zippPythonPackages, zippTorchWasmUrl } = await import('../src/runtime/zipp-wasm-loader');

const TORCH_BYTES = new Uint8Array(readFileSync('wasm-zipp-torch/zipp_torch.wasm'));
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const TORCH_APP = { files: { app: 'import torch\n\ntotal = float(torch.tensor([1.0, 2.0, 3.0]).sum())\n' }, modules: ['app'], packages: ['torch'] };

afterEach(() => {
  vi.unstubAllGlobals();
});

function serving(...responses: (() => Response)[]) {
  const fetch = vi.fn(async (_url: string | URL, _init?: RequestInit) => (responses.shift() ?? (() => new Response('', { status: 500 })))());
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

async function run(project: { files: Record<string, string>; modules: string[]; packages?: string[] }) {
  const adapter = await PythonLogicAdapter.create();
  try {
    return await adapter.initializePythonProject(project);
  } finally {
    adapter.dispose();
  }
}

describe('the torch package, on demand', () => {
  it('is never fetched or added for a Python app that does not declare it', async () => {
    const fetch = serving();
    const symbols = await run({ files: { app: 'count = 1\n' }, modules: ['app'] });
    expect([...symbols.keys()]).toContain('count');
    expect(fetch).not.toHaveBeenCalled();
    expect(addTorch).not.toHaveBeenCalled();
    expect(await zippPythonPackages()).not.toContain('torch');
    // Nothing started, so a source could still be given; not a malformed one.
    expect(() => configureZippTorchSource(new Uint8Array(2))).toThrow(TypeError);
  });

  it('lives beside core\'s chunk, in the core-runtime copy every app ships', () => {
    const url = zippTorchWasmUrl();
    // Here that is the source module's folder; in a build, core's chunk's.
    expect(url.pathname).toMatch(/\/src\/runtime\/core-runtime\/zipp_torch\.wasm$/);
  });

  it('can be fetched for an offline install without being added, and without fixing its source', async () => {
    const fetch = serving(() => new Response(TORCH_BYTES), () => new Response('', { status: 503 }));
    await preloadZippTorch();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0][0])).toBe(zippTorchWasmUrl().href);
    expect(fetch.mock.calls[0][1]).toMatchObject({ cache: 'reload', credentials: 'same-origin' });
    await expect(preloadZippTorch()).rejects.toThrow(/\/core-runtime\/zipp_torch\.wasm answered 503$/);
    expect(addTorch).not.toHaveBeenCalled();
    expect(await zippPythonPackages()).not.toContain('torch');
  });

  it('refuses a declaring app with the reason when the package cannot be fetched, and loads nothing', async () => {
    const fetch = serving(() => new Response('not here', { status: 404 }));
    await expect(run(TORCH_APP)).rejects.toThrow(
      /^This app uses the Python package torch, and the engine this page loaded does not provide it: \/.*\/core-runtime\/zipp_torch\.wasm answered 404$/
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0][0])).toBe(zippTorchWasmUrl().href);
    expect(addTorch).not.toHaveBeenCalled();
    expect(await zippPythonPackages()).not.toContain('torch');
  });

  it('tries again after a failed load, and concurrent apps share one fetch and one load', async () => {
    const fetch = serving(() => new Response(TORCH_BYTES, { headers: { 'Content-Type': 'application/wasm' } }));
    const [first, second] = await Promise.all([run(TORCH_APP), run(TORCH_APP)]);
    expect([...first.keys()]).toContain('total');
    expect([...second.keys()]).toContain('total');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(addTorch).toHaveBeenCalledTimes(1);
    // ZIPP's loader, handed the engine's addPythonPackage and the fetched bytes.
    const [host, source] = addTorch.mock.calls[0];
    expect(typeof (host as { addPythonPackage?: unknown }).addPythonPackage).toBe('function');
    expect(digest(source as Uint8Array)).toBe(digest(TORCH_BYTES));
    expect(await zippPythonPackages()).toContain('torch');
  }, 60_000);

  it('is added once per page: later apps and later calls load nothing', async () => {
    const fetch = serving();
    await run(TORCH_APP);
    await ensureZippTorch();
    expect(fetch).not.toHaveBeenCalled();
    expect(addTorch).toHaveBeenCalledTimes(1);
  }, 60_000);

  it('cannot be given another source once a load has started', () => {
    expect(() => configureZippTorchSource(TORCH_BYTES)).toThrow('The torch package source must be configured before it is first loaded');
  });
});
