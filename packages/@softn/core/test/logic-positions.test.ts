/**
 * The positions the engine reports count from the app's logic.
 *
 * The runtimes compile code of their own ahead of the app's (the bridges,
 * the timers, a strict app's directive and `$:` globals, the document shell),
 * and up to ZIPP 0.0.28 every position counted those lines too: a frame read
 * `at save (<anonymous>:4012:5)`. Since 0.0.29 the engine takes an origin,
 * and the runtimes give it `logic` and minus their own lines
 * (logic-origin.ts), so the logic's first line is line 1 however much is
 * ahead of it. A syntax error's position is replaced by its line, quoted.
 * Each is checked on the main thread and in the worker.
 *
 * The positions are ZIPP's. Run with the host-JavaScript engine behind the
 * seam (vitest.host-js.config.ts), the main thread's logic is the host's own
 * JavaScript, whose stack the browser writes and which is given no document
 * of SoftN's: there the stacks are not checked, and a syntax error is the
 * host engine's, placed by acorn. The worker always runs ZIPP.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createConsoleModule,
  createMockNavModule,
  createMockXDBModule,
  createScriptRuntime,
  type ScriptContext,
  type ScriptRuntimeHandle,
} from '../src/runtime/script-runtime';
import type { ScriptBlock } from '../src/parser/ast';
import { DocumentShell } from '../src/document-shell/host';
import { zippEngineForWorker } from '../src/runtime/zipp-wasm-loader';
import { placeSyntaxError } from '../src/runtime/logic-syntax';
import { logicEngineIsSandboxed } from '../src/runtime/vm-adapter';
import {
  endLine,
  engineSyntaxPosition,
  logicOrigin,
  placeEngineSyntaxError,
  quoteLogicLine,
} from '../src/runtime/logic-origin';

/** A function whose `new Error` is on its second line, and a top level that throws its stack. */
const WHERE = 'function where() {\n  return new Error("here").stack\n}\nthrow new Error(where())\n';
const SYNTAX = "SyntaxError: unexpected token ';', at this line of the logic: let c = ;";

/** What may come ahead of the code under test, and what it turns on in the runtime. */
const STRICT = '"use strict"\n';
const SHELL = 'var heading = document.title\n';
const COMPUTED = 'let n = 1\n$: doubled = n * 2\n';

function lines(text: string): number {
  return text.split('\n').length - 1;
}

/** Every combination of the three, as [label, prefix]. */
function prefixes(parts: Record<string, string>): Array<[string, string]> {
  let out: Array<[string, string]> = [['plain', '']];
  for (const [name, text] of Object.entries(parts)) {
    out = out.flatMap(([label, prefix]): Array<[string, string]> => [
      [label, prefix],
      [label === 'plain' ? name : `${label}+${name}`, prefix + text],
    ]);
  }
  // A strict app's directive comes first, where the engine reads it.
  return out.map(([label, prefix]) => [label, prefix.includes(STRICT) ? STRICT + prefix.replace(STRICT, '') : prefix]);
}

describe('on the main thread', () => {
  const sandboxed = logicEngineIsSandboxed();
  const runtimes: ScriptRuntimeHandle[] = [];
  afterEach(() => {
    for (const runtime of runtimes.splice(0)) runtime.cleanup();
    vi.restoreAllMocks();
  });

  async function failure(code: string): Promise<string> {
    // The `$:` fallback says it is falling back; that is not what is checked.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
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
    let made = 0;
    const runtime = createScriptRuntime(context, undefined, 'logic-positions', undefined, undefined, {
      mode: 'main',
      documentShell: {
        create: async () => {
          made++;
          return new DocumentShell([], () => false);
        },
      },
    });
    runtimes.push(runtime);
    const script: ScriptBlock = { type: 'ScriptBlock', code, loc: { line: 1, column: 0, start: 0, end: 0 } };
    try {
      await runtime.loadScript(script);
    } catch (error) {
      // The shell is made for code that uses the document, and only then.
      expect(made).toBe(sandboxed && code.includes(SHELL) ? 1 : 0);
      return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
    throw new Error('the logic loaded');
  }

  for (const [label, prefix] of prefixes({ strict: STRICT, shell: SHELL, computed: COMPUTED })) {
    it.skipIf(!sandboxed)(`counts a stack's lines from the logic's first (${label})`, async () => {
      const said = await failure(prefix + WHERE);
      const at = lines(prefix);
      expect(said).toContain(`at where (logic:${at + 2}:`);
      expect(said).toContain(`at logic:${at + 4}:`);
      expect(said).not.toContain('<anonymous>');
    });

    it(`quotes a syntax error's line in place of its position (${label})`, async () => {
      const said = await failure(`${prefix}let a = 1\nlet c = ;\n`);
      if (sandboxed) expect(said).toBe(SYNTAX);
      else expect(said).toMatch(/^SyntaxError: [^\n]+, at this line of the logic: let c = ;$/);
    });
  }
});

describe('in the worker', () => {
  type Reply = { id: number; ok: boolean; result?: Record<string, unknown>; error?: string };
  const scope = self as unknown as {
    postMessage: (message: unknown) => void;
    onmessage: ((event: { data: unknown }) => unknown) | null;
  };
  const realPostMessage = scope.postMessage;
  const replies: Reply[] = [];
  let nextId = 1;

  async function send(type: string, payload: Record<string, unknown>): Promise<Reply> {
    const id = nextId++;
    await scope.onmessage!({ data: { id, type, payload } });
    return replies.find((candidate) => candidate.id === id)!;
  }

  async function failure(code: string, externalPreamble: string): Promise<string> {
    await send('dispose', {});
    const reply = await send('init', {
      script: { type: 'ScriptBlock', code, loc: { line: 1, column: 0, start: 0, end: 0 } },
      observedStateNames: null,
      drawnNames: null,
      preIncludedLogicPaths: [],
      externalPreamble,
    });
    expect(reply.ok).toBe(false);
    return reply.error!;
  }

  beforeAll(async () => {
    scope.postMessage = (message: unknown) => {
      replies.push(message as Reply);
    };
    await import('../src/runtime/script-worker');
    await scope.onmessage!({ data: { type: 'engine', engine: await zippEngineForWorker() } });
  });

  afterAll(async () => {
    await send('dispose', {});
    scope.postMessage = realPostMessage;
    scope.onmessage = null;
  });

  // The host's values are declared ahead of the logic, a line each.
  const EXTERNAL = 'let __softnExt = [1];\nfunction hostValue() { return __softnExt[0]; }\n';
  for (const [label, prefix] of prefixes({ strict: STRICT })) {
    for (const external of ['', EXTERNAL]) {
      const name = `${label}${external ? ', with host values' : ''}`;

      it(`counts a stack's lines from the logic's first (${name})`, async () => {
        const said = await failure(prefix + WHERE, external);
        expect(said).toContain(`at where (logic:${lines(prefix) + 2}:`);
        expect(said).not.toContain('<anonymous>');
      });

      it(`quotes a syntax error's line in place of its position (${name})`, async () => {
        expect(await failure(`${prefix}let a = 1\nlet c = ;\n`, external)).toBe(SYNTAX);
      });
    }
  }
});

describe('placeSyntaxError', () => {
  it("takes the engine's position in the logic over acorn's reading", async () => {
    // acorn would stop at line 2; the engine is what refused the code.
    expect(await placeSyntaxError("SyntaxError: x\n    at logic:1:1", 'let a = 1\nlet c = ;\n')).toBe(
      'SyntaxError: x, at this line of the logic: let a = 1'
    );
  });

  it('reads the logic with acorn where the engine names no line of it, and drops that position', async () => {
    expect(await placeSyntaxError("SyntaxError: unexpected token ';'\n    at <anonymous>:58:9", 'let a = 1\nlet c = ;\n')).toBe(
      SYNTAX
    );
  });
});

describe('logic-origin', () => {
  it('starts the logic on a line of its own and takes the lines ahead of it off', () => {
    expect(endLine('')).toBe('');
    expect(endLine('a;')).toBe('a;\n');
    expect(endLine('a;\n')).toBe('a;\n');
    expect(logicOrigin('')).toEqual({ name: 'logic', lineOffset: 0, columnOffset: 0 });
    // Lines as the engine counts them: CR LF is one break, CR and U+2028 are each one.
    expect(logicOrigin('a\r\nb\rc\u2028d\n').lineOffset).toBe(-4);
  });

  it('reads a position only in the logic', () => {
    expect(engineSyntaxPosition("SyntaxError: unexpected token ';'\n    at logic:2:9")).toEqual({
      said: "SyntaxError: unexpected token ';'",
      line: 2,
    });
    expect(engineSyntaxPosition("SyntaxError: unexpected token ';'\n    at <anonymous>:2:9")).toEqual({
      said: "SyntaxError: unexpected token ';'",
      line: null,
    });
    expect(engineSyntaxPosition('SyntaxError: unexpected token Semi')).toEqual({
      said: 'SyntaxError: unexpected token Semi',
      line: null,
    });
  });

  it('names the end of the logic for a position past its last line, and keeps what it cannot place', () => {
    expect(quoteLogicLine('E', 'a {\n\n', 3)).toMatch(/at the end of the logic/);
    expect(quoteLogicLine('E', 'a\n\nb', 2)).toBeNull();
    expect(placeEngineSyntaxError('SyntaxError: x\n    at logic:2:1', 'a\n\nb')).toBe('SyntaxError: x\n    at logic:2:1');
    expect(placeEngineSyntaxError('TypeError: y\n    at logic:1:1', 'a')).toBe('TypeError: y\n    at logic:1:1');
    const thrown = new SyntaxError("unexpected token ';'\n    at logic:1:7");
    const placed = placeEngineSyntaxError(thrown, 'let c = ;') as Error;
    expect(placed.name).toBe('SyntaxError');
    expect(placed.message).toBe("unexpected token ';', at this line of the logic: let c = ;");
  });
});
