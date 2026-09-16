/**
 * One Python, not two: Softn's value normalizer against FormLogic's.
 *
 * `softn.py` and FormLogic's `formlogic.py` each carry a `_plain()` that decides
 * what a Python value becomes when it leaves the guest. They were written to be
 * the same dialect on purpose — the owner wants Python usable in a Softn app, in
 * a FormLogic automation logic block and on the Desktop, which only means
 * anything if a snippet means the same thing in all three.
 *
 * A comment saying so holds nothing in place. This runs FormLogic's own
 * value-conversion cases, vendored into `fixtures/`, against Softn's `_plain` on
 * the real web-python engine, and fails if the two stop agreeing. Softn does not
 * import anything from formlogic.com: the fixture is a copy, and its header says
 * where it came from, at which commit, and what to do when it fails.
 *
 * Excluded from the host-JavaScript run for the same reason `python-logic` is:
 * there is no Python there to normalize.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  createConsoleModule,
  createMockNavModule,
  createMockXDBModule,
  createScriptRuntime,
  type ScriptContext,
} from '../src/runtime/script-runtime';
import { SOFTN_PY } from '../src/runtime/python/python-runtime-source';
import type { ScriptBlock } from '../src/parser/ast';

const EMPTY_LOGIC: ScriptBlock = {
  type: 'ScriptBlock',
  code: '',
  loc: { line: 1, column: 0, start: 0, end: 0 },
};

interface Case {
  id: string;
  formlogicId?: string;
  formlogicSource?: string;
  addedBySoftn?: string;
  setup?: string;
  /** The expression already calls `_plain`; do not wrap it again. */
  raw?: boolean;
  value: string;
  pins: string;
  expect: {
    ok?: unknown;
    raises?: 'ValueError' | 'TypeError';
    names?: string;
    refusedAtTheBoundary?: string;
  };
}

interface Corpus {
  vendoredFrom: Record<string, string>;
  cases: Case[];
}

const corpus: Corpus = JSON.parse(
  readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/formlogic-python-value-corpus.json'),
    'utf8'
  )
);

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

/**
 * One module holding every case, so the whole corpus costs one engine rather
 * than one each. Each case is a function that hands its value to Softn's
 * `_plain` and reports what happened, in the guest, so the exception class is
 * the guest's own and not something inferred from a message.
 */
function corpusModule(cases: readonly Case[]): string {
  const lines: string[] = ['import softn', ''];
  for (const c of cases) if (c.setup) lines.push(c.setup);
  cases.forEach((c, i) => {
    lines.push(`def case_${i}():`);
    lines.push('    try:');
    lines.push(`        return ["ok", ${c.raw ? c.value : `softn._plain(${c.value})`}]`);
    lines.push('    except ValueError as e:');
    lines.push('        return ["ValueError", str(e)]');
    lines.push('    except TypeError as e:');
    lines.push('        return ["TypeError", str(e)]');
    lines.push('');
  });
  return lines.join('\n');
}

describe('Softn and FormLogic convert a Python value the same way', () => {
  it('says where the cases came from, so a failure can be traced to a commit', () => {
    // Not decoration: this is the only link between the two repositories, and
    // "re-vendor from the commit that has the agreed behaviour" is the
    // instruction in the fixture's own header.
    expect(corpus.vendoredFrom.contract).toBe('formlogic-python/1');
    expect(corpus.vendoredFrom.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(corpus.vendoredFrom.corpusBlob).toMatch(/^[0-9a-f]{40}$/);
    expect(corpus.vendoredFrom.normalizerBlob).toMatch(/^[0-9a-f]{40}$/);
    expect(corpus.cases.length).toBeGreaterThanOrEqual(10);
    // Every case either came from FormLogic's corpus or says why Softn added it.
    for (const c of corpus.cases) {
      expect(c.formlogicId ?? c.addedBySoftn, c.id).toBeTruthy();
      expect(c.pins, c.id).toBeTruthy();
    }
  });

  it('declares the same limits as FormLogic’s normalizer', () => {
    // The two constants the dialect is built on. FormLogic writes the first as
    // `2 ** 53 - 1`; this is the same number, and the depth cap is the same 64.
    expect(SOFTN_PY).toContain('_SAFE_INTEGER = 9007199254740991');
    expect(SOFTN_PY).toContain('_MAX_DEPTH = 64');
    expect(2 ** 53 - 1).toBe(9007199254740991);
  });

  it('gives FormLogic’s answer for every vendored case', async () => {
    const cases = corpus.cases;
    const runtime = createScriptRuntime(makeContext(), undefined, 'formlogic-dialect', undefined, undefined, {
      mode: 'main',
      pythonProject: { files: { app: corpusModule(cases) }, modules: ['app'] },
    });
    await runtime.loadScript(EMPTY_LOGIC);
    const engine = (runtime as unknown as { vmEngine: { callFunction(n: string, a: unknown[]): unknown } }).vmEngine;

    const disagreements: string[] = [];
    cases.forEach((c, i) => {
      let outcome: [string, unknown] | { boundary: string };
      try {
        outcome = engine.callFunction(`case_${i}`, []) as [string, unknown];
      } catch (error) {
        // The normalizer let it through and the ENGINE refused it on the way
        // out. FormLogic sees this at the same place.
        outcome = { boundary: (error as Error).message };
      }

      const say = (what: string) => disagreements.push(`${c.id}: ${what}`);
      if (c.expect.refusedAtTheBoundary !== undefined) {
        if (!('boundary' in outcome)) return say(`expected the engine to refuse it, got ${JSON.stringify(outcome)}`);
        if (!outcome.boundary.includes(c.expect.refusedAtTheBoundary)) {
          return say(`expected a refusal about "${c.expect.refusedAtTheBoundary}", got ${outcome.boundary}`);
        }
        return;
      }
      if ('boundary' in outcome) return say(`the engine refused it unexpectedly: ${outcome.boundary}`);

      const [kind, payload] = outcome;
      if (c.expect.raises !== undefined) {
        if (kind !== c.expect.raises) return say(`expected ${c.expect.raises}, got ${kind} ${JSON.stringify(payload)}`);
        if (c.expect.names && !String(payload).includes(c.expect.names)) {
          return say(`the ${kind} should name "${c.expect.names}", said: ${payload}`);
        }
        return;
      }
      if (kind !== 'ok') return say(`expected a value, got ${kind}: ${payload}`);
      // Compared as JSON, the way FormLogic's corpus compares its own.
      if (JSON.stringify(payload) !== JSON.stringify(c.expect.ok)) {
        return say(`expected ${JSON.stringify(c.expect.ok)}, got ${JSON.stringify(payload)}`);
      }
    });

    expect(disagreements, disagreements.join('\n')).toEqual([]);
    runtime.cleanup();
  }, 60_000);
});
