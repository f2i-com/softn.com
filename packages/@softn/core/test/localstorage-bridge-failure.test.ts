/**
 * A localStorage write the browser refuses reaches the script as a failure.
 *
 * The bridge used to catch the browser's exception, log it, and return, so a
 * script's `try { localStorage.setItem(...) } catch (e) { ... }` took the
 * success branch after a failed write — and told the player their game was
 * saved. What is pinned: the exception crosses the VM boundary into the
 * script's catch, carrying the browser's name for what went wrong; a read
 * of an unreadable store is still empty rather than an error; and a write
 * that succeeds is untouched.
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  createScriptRuntime,
  createMockXDBModule,
  createMockNavModule,
  createConsoleModule,
  type ScriptContext,
} from '../src/runtime/script-runtime';
import type { ScriptBlock } from '../src/parser/ast';

function script(code: string): ScriptBlock {
  return { type: 'ScriptBlock', code, loc: { line: 1, column: 0, start: 0, end: code.length } };
}

async function load(code: string) {
  const state: Record<string, unknown> = {};
  const context: ScriptContext = {
    state,
    setState: (path: string, value: unknown) => {
      state[path] = value;
    },
    data: {},
    xdb: createMockXDBModule(),
    nav: createMockNavModule(),
    console: createConsoleModule(),
  };
  const failures: Array<{ operation: string; key: string; error: Error }> = [];
  const runtime = createScriptRuntime(context, undefined, undefined, undefined, undefined, {
    onPersistenceFailure: (failure) => failures.push(failure),
  });
  const result = await runtime.loadScript(script(code));
  return { state, result, failures };
}

const SAVE = `
  let outcome = "";
  function save() {
    try {
      localStorage.setItem("slot", "data");
      outcome = "saved";
    } catch (e) {
      outcome = "failed: " + e.message;
    }
  }
  function read() {
    outcome = "read: " + (localStorage.getItem("slot") === null ? "nothing" : "something");
  }
`;

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('a refused localStorage write', () => {
  it("lands in the script's catch, and reaches the host with the browser's reason", async () => {
    const quota = new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw quota;
    });
    const { state, result, failures } = await load(SAVE);
    await result.functions.save();
    // The engine hands the script a generic failure, which is enough for the
    // catch; the host is told what the browser actually said.
    expect(String(state.outcome)).toMatch(/^failed: /);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ operation: 'setItem', key: 'slot' });
    expect(failures[0].error.name).toBe('QuotaExceededError');
  });

  it('is the exception, not the rule: a write the browser keeps is reported as saved', async () => {
    const { state, result, failures } = await load(SAVE);
    await result.functions.save();
    expect(state.outcome).toBe('saved');
    expect(localStorage.getItem('softn:_default:slot')).toBe('data');
    expect(failures).toHaveLength(0);
  });

  it('does not make a refused read into an error', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('Access is denied.', 'SecurityError');
    });
    const { state, result } = await load(SAVE);
    await result.functions.read();
    expect(state.outcome).toBe('read: nothing');
  });
});
