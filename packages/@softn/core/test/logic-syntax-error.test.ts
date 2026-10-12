/**
 * A `.logic` file that does not compile says where.
 *
 * ZIPP reports one as `SyntaxError: unexpected token Semi` and nothing else:
 * no line, no column. That is what the page showed, and what Studio's check
 * handed the AI, which then had the whole of the logic to search. The line
 * the error is on is now quoted with it (logic-syntax.ts).
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  createConsoleModule,
  createMockNavModule,
  createMockXDBModule,
  createScriptRuntime,
  type ScriptContext,
  type ScriptRuntimeHandle,
} from '../src/runtime/script-runtime';
import type { ScriptBlock } from '../src/parser/ast';

const runtimes: ScriptRuntimeHandle[] = [];
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.cleanup();
});

function load(code: string): Promise<unknown> {
  const state: Record<string, unknown> = {};
  const context: ScriptContext = {
    state,
    setState: (path, value) => {
      state[path] = value;
    },
    data: {},
    xdb: createMockXDBModule(),
    nav: createMockNavModule(),
    console: createConsoleModule(),
  };
  const runtime = createScriptRuntime(context, undefined, 'logic-syntax', undefined, undefined, { mode: 'main' });
  runtimes.push(runtime);
  const script: ScriptBlock = { type: 'ScriptBlock', code, loc: { line: 1, column: 0, start: 0, end: 0 } };
  return runtime.loadScript(script);
}

/** What a load failed with, as the renderer and Studio's check show it. */
async function failure(code: string): Promise<string> {
  try {
    await load(code);
  } catch (error) {
    // ZIPP throws its message as a string; the host-JavaScript engine throws
    // a SyntaxError whose name is not in its message.
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
  throw new Error('the logic loaded');
}

describe('logic that does not compile', () => {
  it('quotes the line the mistake is on', async () => {
    const said = await failure('let a = 1\nlet c = ;\nfunction ok() { return a }\n');
    expect(said).toMatch(/SyntaxError/);
    expect(said).toMatch(/at this line of the logic: let c = ;$/);
  });

  it('quotes a name declared twice where it is declared again', async () => {
    expect(await failure('let total = 0\nlet count = 1\nlet total = 2\n')).toMatch(
      /at this line of the logic: let total = 2$/
    );
  });

  it('says a brace left open runs to the end', async () => {
    expect(await failure('function add(a, b) {\n  return a + b\n\nlet total = 0\n')).toMatch(
      /at the end of the logic: a brace, bracket or string opened before it is never closed$/
    );
  });

  it('says nothing more about a script that throws as it runs', async () => {
    const said = await failure('let a = null\nlet b = a.x\n');
    expect(said).toMatch(/TypeError/);
    expect(said).not.toMatch(/at this line of the logic/);
  });
});
