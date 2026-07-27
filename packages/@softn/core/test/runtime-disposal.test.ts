/**
 * A runtime disposed mid-load must not go on to execute the script.
 *
 * `loadScript` is a long async chain, and `cleanup()` only disposed an engine
 * that already existed — so a cleanup arriving while the first await was still
 * pending disposed nothing, and the continuation then built a fresh engine and
 * ran the `.logic` top level in it. Under `React.StrictMode`, which all four
 * apps use, that happened on every mount: measured against the real app with a
 * bundle whose top level calls `db.create`, two records appeared where the
 * author wrote one.
 *
 * This drives the runtime directly rather than through React. Mounting a
 * component does not reproduce it under jsdom — the engine is already
 * initialised there, so the first await resolves before cleanup can land and
 * the race window never opens.
 */

import { describe, it, expect } from 'vitest';
import { createScriptRuntime, type ScriptContext } from '../src/runtime/script-runtime';

function context(): ScriptContext {
  return {
    state: {},
    setState: () => {},
    updateContext: () => {},
    data: {},
    xdb: undefined,
    nav: undefined,
    console: undefined,
  } as unknown as ScriptContext;
}

const SCRIPT = {
  code: 'let seen = 1\nfunction value() { return seen }',
  lang: 'js',
} as unknown as Parameters<ReturnType<typeof createScriptRuntime>['loadScript']>[0];

describe('cleanup during an in-flight load', () => {
  it('abandons the load instead of executing into an orphaned engine', async () => {
    const runtime = createScriptRuntime(context());

    // Cleanup lands while loadScript is still inside its first await.
    const loading = runtime.loadScript(SCRIPT);
    runtime.cleanup();
    const result = await loading;

    // Nothing was executed, so there are no functions to hand back.
    expect(Object.keys(result.functions)).toHaveLength(0);
    expect(Object.keys(result.syncFunctions)).toHaveLength(0);
    expect(Object.keys(result.state)).toHaveLength(0);
  });

  it('still loads normally when no cleanup interferes', async () => {
    const runtime = createScriptRuntime(context());
    const result = await runtime.loadScript(SCRIPT);

    expect(Object.keys(result.syncFunctions)).toContain('value');
    runtime.cleanup();
  });

  it('is idempotent — a second cleanup is harmless', async () => {
    const runtime = createScriptRuntime(context());
    await runtime.loadScript(SCRIPT);
    runtime.cleanup();
    expect(() => runtime.cleanup()).not.toThrow();
  });
});
