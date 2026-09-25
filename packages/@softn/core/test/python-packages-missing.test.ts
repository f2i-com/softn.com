/**
 * A declared Python package the loaded engine cannot provide is refused by
 * name before the project compiles.
 *
 * The engine the repository vendors (ZIPP's `web-python-base`) has no torch
 * built in, and the runtime adds ZIPP's torch package on demand
 * (`python-torch.test.tsx`). The engine that cannot provide it — one whose
 * package would not load, offline or refused by the engine, or a host's other
 * bytes — is stood in for by answering no packages and a load that fails.
 * Everything else is the real engine.
 */

import { describe, expect, it, vi } from 'vitest';

// Hoisted with the mock that uses it.
const { ensureZippTorch } = vi.hoisted(() => ({
  ensureZippTorch: vi.fn(async () => {
    throw new Error('/assets/core-runtime/zipp_torch.wasm answered 404');
  }),
}));

vi.mock('../src/runtime/zipp-wasm-loader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/runtime/zipp-wasm-loader')>()),
  zippPythonPackages: async () => [],
  ensureZippTorch,
}));

const { PythonLogicAdapter } = await import('../src/runtime/python/python-logic-adapter');

describe('a declared package the engine lacks', () => {
  it('is loaded first, refused by name with the reason only when that fails, and the engine is not left half-started', async () => {
    const adapter = await PythonLogicAdapter.create();
    await expect(
      adapter.initializePythonProject({ files: { app: 'import torch\n' }, modules: ['app'], packages: ['torch'] })
    ).rejects.toThrow(
      'This app uses the Python package torch, and the engine this page loaded does not provide it: /assets/core-runtime/zipp_torch.wasm answered 404'
    );
    expect(ensureZippTorch).toHaveBeenCalledTimes(1);
    expect(adapter.terminated).toBe(true);
    adapter.dispose();
  });

  it('does not stand in the way of a project that declares nothing, and loads nothing for it', async () => {
    ensureZippTorch.mockClear();
    const adapter = await PythonLogicAdapter.create();
    const symbols = await adapter.initializePythonProject({ files: { app: 'count = 1\n' }, modules: ['app'] });
    expect([...symbols.keys()]).toContain('count');
    expect(ensureZippTorch).not.toHaveBeenCalled();
    adapter.dispose();
  });
});
