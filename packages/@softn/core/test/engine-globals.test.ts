/**
 * App logic on ZIPP has no WebAssembly and nothing of Node.
 *
 * ZIPP 0.0.31 gave its command line and native embeddings a `WebAssembly`
 * global and a Node layer (`process`, `require`, `Buffer`, …). Its browser
 * modules have neither, and the logic SoftN runs must not either: a module an
 * app compiled would run outside the instruction budget the app is held to,
 * and Node's names would tell a bundle it runs in Node.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createConsoleModule,
  createMockNavModule,
  createMockXDBModule,
  createScriptRuntime,
  type ScriptContext,
} from '../src/runtime/script-runtime';
import { logicEngineIsSandboxed } from '../src/runtime/vm-adapter';

afterEach(() => {
  vi.restoreAllMocks();
});

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

const NAMES = ['WebAssembly', 'process', 'require', 'Buffer', 'module', 'exports', '__dirname', 'Deno', 'Bun'];

// On the host-JavaScript engine (vitest.host-js.config.ts) the logic is the
// host's own JavaScript, and under vitest the host is Node.
describe.skipIf(!logicEngineIsSandboxed())('app logic on ZIPP', () => {
  it('has no WebAssembly and none of Node’s names', async () => {
    const runtime = createScriptRuntime(context());
    try {
      const code = `function names() { return [${NAMES.map((name) => `typeof ${name}`).join(', ')}] }`;
      const loaded = await runtime.loadScript({ type: 'LogicBlock', code, loc: { line: 1, column: 0, start: 0, end: code.length } });
      expect(await loaded.functions.names()).toEqual(NAMES.map(() => 'undefined'));
    } finally {
      runtime.cleanup();
    }
  });
});
