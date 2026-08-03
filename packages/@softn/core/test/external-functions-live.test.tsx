import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { SoftNRenderer } from '../src/loader/SoftNRenderer';
import type { ScriptBlock } from '../src/parser/ast';
import {
  createConsoleModule,
  createMockNavModule,
  createMockXDBModule,
  createScriptRuntime,
  type ScriptContext,
} from '../src/runtime/script-runtime';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeContext(): ScriptContext {
  const state: Record<string, unknown> = {};
  return {
    state,
    setState: (path, value) => {
      state[path] = value;
    },
    data: {},
    xdb: createMockXDBModule(),
    nav: createMockNavModule(),
    console: createConsoleModule(),
  };
}

const SCRIPT: ScriptBlock = {
  type: 'ScriptBlock',
  code: `
    let runtimeLoads = 0;
    runtimeLoads = runtimeLoads + 1;

    function readWallet() { return walletAddress(); }
    function readRuntimeLoads() { return runtimeLoads; }
  `,
  loc: { line: 1, column: 0, start: 0, end: 180 },
};

describe('live external functions', () => {
  it('refreshes a compiled bridge slot without rebuilding the VM', async () => {
    const externalFunctions: Record<string, (...args: unknown[]) => unknown> = {
      walletAddress: () => 'alpha',
    };
    const runtime = createScriptRuntime(
      makeContext(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      externalFunctions
    );

    const result = await runtime.loadScript(SCRIPT);
    expect(result.syncFunctions.readWallet()).toBe('alpha');

    // This happens inside the sync-call cache window on purpose: replacing a
    // bridge must invalidate answers produced with the previous host value.
    externalFunctions.walletAddress = () => 'beta';
    expect(result.syncFunctions.readWallet()).toBe('beta');

    delete externalFunctions.walletAddress;
    expect(result.syncFunctions.readWallet()).toBeUndefined();

    externalFunctions.walletAddress = () => 'gamma';
    expect(await result.functions.readWallet()).toBe('gamma');
    expect(result.syncFunctions.readRuntimeLoads()).toBe(1);

    runtime.cleanup();
  });

  it('keeps the renderer runtime alive when the functions prop changes', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const source = `<logic>${SCRIPT.code}</logic>
      <span class="wallet">{readWallet()}</span>
      <span class="loads">{readRuntimeLoads()}</span>`;

    const render = (walletAddress: () => string) =>
      root.render(
        <SoftNRenderer
          source={source}
          appId="LiveExternalFunctions"
          scriptExecutionMode="main"
          functions={{ walletAddress }}
        />
      );

    await act(async () => render(() => 'alpha'));
    for (let attempt = 0; attempt < 60; attempt++) {
      if (container.querySelector('.wallet')?.textContent === 'alpha') break;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
      });
    }
    expect(container.querySelector('.wallet')?.textContent).toBe('alpha');
    expect(container.querySelector('.loads')?.textContent).toBe('1');

    await act(async () => render(() => 'beta'));
    expect(container.querySelector('.wallet')?.textContent).toBe('beta');
    expect(container.querySelector('.loads')?.textContent).toBe('1');

    await act(async () => root.unmount());
    container.remove();
  }, 30_000);
});
