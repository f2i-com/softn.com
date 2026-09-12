import { describe, it, expect, vi } from 'vitest';
import { createScriptRuntime, createMockXDBModule, createMockNavModule, createConsoleModule, type ScriptRuntimeOptions } from '../src/runtime/script-runtime';
import { XDBService, getXDB } from '../src/runtime/xdb';

async function load(backendCall?: ScriptRuntimeOptions['backendCall'], action = 'saveNote', input = '{text:"hello"}') {
  const state: Record<string, unknown> = {};
  const runtime = createScriptRuntime({ state, setState: (key, value) => { state[key] = value; }, data: {}, xdb: createMockXDBModule(), nav: createMockNavModule(), console: createConsoleModule() }, undefined, undefined, undefined, undefined, { backendCall });
  const code = `let answer = null; function run() { softn.backend.call(${JSON.stringify(action)}, ${input}, function(result) { answer = result; }); }`;
  const result = await runtime.loadScript({ type: 'ScriptBlock', code, loc: { line: 1, column: 0, start: 0, end: code.length } });
  await result.functions.run();
  await vi.waitFor(() => expect(state.answer).not.toBeNull());
  return { state, runtime };
}
describe('Host-owned backend bridge', () => {
  it('round trips from real .logic through the selected host without tokens or URLs', async () => {
    const host = vi.fn(async () => ({ result: { id: 'saved' } }));
    const {state, runtime} = await load(host);
    expect(host).toHaveBeenCalledWith('saveNote', {text:'hello'});
    expect(state.answer).toEqual({result:{id:'saved'}});
    runtime.cleanup();
  });
  it('fails explicitly for downloaded apps with no host', async () => {
    const {state,runtime} = await load();
    expect(state.answer).toEqual({error:'This app has no connected backend.'});
    runtime.cleanup();
  });
  it('does not call the host for paths or array input', async () => {
    const host = vi.fn(async () => null);
    for (const [action,input] of [['../other-app','{}'],['save','[]']]) {
      const {state,runtime} = await load(host,action,input);
      expect(state.answer).toHaveProperty('error');
      runtime.cleanup();
    }
    expect(host).not.toHaveBeenCalled();
  });
  it('reports host failures through the callback', async () => {
    const {state,runtime}=await load(async()=>{throw new Error('Not a member');});
    expect(state.answer).toEqual({error:'Not a member'});
    runtime.cleanup();
  });
  it('can initialize XDB when even reading localStorage throws', () => {
    const original = Object.getOwnPropertyDescriptor(window,'localStorage')!;
    Object.defineProperty(window,'localStorage',{configurable:true,get(){throw new DOMException('Sandbox','SecurityError');}});
    try { expect(() => new XDBService()).not.toThrow(); expect(() => getXDB("sandbox-test")).not.toThrow(); }
    finally { Object.defineProperty(window,'localStorage',original); }
  });
});
