/**
 * The host's functions the logic is handed are read by calling them, and only
 * the ones the logic names are read.
 *
 * A host hands the page its functions for the markup as well as for the logic
 * (`functions={{ logout }}` for `@click={logout}`). Every one was called with
 * no arguments as the app loaded, to learn whether it was a getter; one that
 * answered nothing (`undefined`, as an action does) was then declared and
 * called again before every call into the logic. So `logout` ran as the app
 * opened, and again at each click on anything.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createConsoleModule,
  createMockNavModule,
  createMockXDBModule,
  createScriptRuntime,
  type ScriptContext,
} from '../src/runtime/script-runtime';
import { WorkerScriptRuntime } from '../src/runtime/script-worker-runtime';
import { collectExternalValues, namedInLogic } from '../src/runtime/external-values';
import { withInProcessWorker } from './helpers/in-process-worker';

function context(): ScriptContext {
  const state: Record<string, unknown> = {};
  return {
    state,
    setState: (path: string, value: unknown) => {
      state[path] = value;
    },
    data: {},
    xdb: createMockXDBModule(),
    nav: createMockNavModule(),
    console: createConsoleModule(),
  };
}

const block = (code: string) => ({ type: 'LogicBlock' as const, code, loc: { line: 1, column: 0, start: 0, end: 0 } });

const LOGIC = `
  let clicks = 0;
  function readWallet() { return walletAddress(); }
  function click() { clicks = clicks + 1; }
`;

describe('the host functions the logic is handed', () => {
  it('reads only the ones the logic names', () => {
    const logout = vi.fn();
    const walletAddress = vi.fn(() => 'alpha');
    const read = collectExternalValues({ logout, walletAddress }, LOGIC);
    expect(read).toEqual({ names: ['walletAddress'], values: ['alpha'] });
    expect(logout).not.toHaveBeenCalled();
    // A longer name holding it is not it; written alone, in a template or after a dot, it is.
    expect(namedInLogic('let walletAddresses = 1; xwalletAddress();', 'walletAddress')).toBe(false);
    expect(namedInLogic('let a = `${walletAddress()}`;', 'walletAddress')).toBe(true);
    expect(namedInLogic('host.walletAddress', 'walletAddress')).toBe(true);
  });

  it('never calls one the logic does not name, on the main thread', async () => {
    const logout = vi.fn();
    const functions = { logout, walletAddress: () => 'alpha' };
    const runtime = createScriptRuntime(context(), undefined, 'r4-external-main', undefined, undefined, { mode: 'main' }, undefined, functions);
    try {
      const loaded = await runtime.loadScript(block(LOGIC));
      await loaded.functions.click!();
      await loaded.functions.click!();
      expect(await loaded.functions.readWallet!()).toBe('alpha');
      expect(loaded.syncFunctions.readWallet!()).toBe('alpha');
      expect(logout).not.toHaveBeenCalled();
    } finally {
      runtime.cleanup();
    }
  });

  it('nor in a worker, where one named only in an imported file is still read', async () => {
    await withInProcessWorker(async () => {
      const logout = vi.fn();
      const functions = { logout, walletAddress: () => 'alpha' };
      const files: Record<string, string> = {
        'logic/wallet.logic': 'function readWallet() { return walletAddress(); }',
      };
      const runtime = new WorkerScriptRuntime(context(), undefined, 'r4-external-worker', async (path) => files[path] ?? null, 'logic/main.logic', {
        externalFunctions: functions,
      });
      try {
        const loaded = await runtime.loadScript(block('import "./wallet.logic";\nlet clicks = 0;\nfunction click() { clicks = clicks + 1; }'));
        await loaded.functions.click!();
        expect(await loaded.functions.readWallet!()).toBe('alpha');
        expect(logout).not.toHaveBeenCalled();
      } finally {
        runtime.cleanup();
      }
    });
  });
});
