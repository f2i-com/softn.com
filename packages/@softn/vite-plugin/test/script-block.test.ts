import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import type { Plugin } from 'vite';
import softnPlugin from '../src/index';

/** The module the plugin generates for `source`, as text. */
function generate(source: string): string {
  const plugin: Plugin = softnPlugin({ sourceMaps: false, hmr: false, cache: false });
  const hook = plugin.transform;
  if (!hook) throw new Error('transform hook is missing');
  const handler = (typeof hook === 'function' ? hook : hook.handler) as unknown as (
    this: { error(error: unknown): never },
    code: string,
    id: string
  ) => { code: string } | null;
  const result = handler.call(
    {
      error(error: unknown): never {
        throw error instanceof Error ? error : new Error(JSON.stringify(error));
      },
    },
    source,
    '/src/counter.softn'
  );
  if (!result) throw new Error('the file was not transformed');
  return result.code;
}

/** Throws with the parser's first message when the generated module is not JavaScript. */
function parses(code: string): void {
  const { diagnostics = [] } = ts.transpileModule(code, {
    fileName: 'counter.js',
    reportDiagnostics: true,
    compilerOptions: { allowJs: true, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  if (diagnostics.length > 0) throw new Error(ts.flattenDiagnosticMessageText(diagnostics[0].messageText, '\n'));
}

describe('the script block of a .softn file', () => {
  it('keeps a comparison of a state variable a comparison', () => {
    // Assignments to a state variable become calls to its setter. The pattern
    // that finds them took the first `=` of `===` for one, and what came out
    // was `setCount(== 0) { count = 1);`, which is not JavaScript.
    const code = generate(`<script>
let count = 0;
function bump() {
  if (count === 0) { count = 1; }
  if (count >= 10 || count <= -10 || count != 3) { count = 0; }
}
</script>
<div>{count}</div>`);
    expect(() => parses(code)).not.toThrow();
    expect(code).toContain('if (count === 0) { setCount(1); }');
    expect(code).toContain('if (count >= 10 || count <= -10 || count != 3) { setCount(0); }');
  });

  it('does not take a longer name, a property or an arrow function’s parameter for a state variable', () => {
    const code = generate(`<script>
let count = 0;
function reset() {
  const discount = 5;
  const tally = { count: 0 };
  tally.count = discount;
  const doubled = [1, 2].map(count => count * 2);
  count = doubled.length;
}
</script>
<div>{count}</div>`);
    expect(() => parses(code)).not.toThrow();
    expect(code).toContain('const discount = 5;');
    expect(code).toContain('tally.count = discount;');
    expect(code).toContain('[1, 2].map(count => count * 2);');
    expect(code).toContain('setCount(doubled.length);');
  });
});
