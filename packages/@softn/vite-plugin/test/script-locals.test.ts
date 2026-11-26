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

describe('variables declared inside a function of the script block', () => {
  it('stay local to the function and are not made state', () => {
    // Only a `let` of the script itself is state. A `let` inside a function
    // body was taken for one too: it got a useState hook of its own, and the
    // assignment rewrite turned the declaration into `let setNext(count + 1);`.
    const code = generate(`<script>
let count = 0;
function bump() {
  let next = count + 1;
  for (let i = 0; i < 2; i++) { next = next + i; }
  count = next;
}
</script>
<div>{count}</div>`);
    expect(() => parses(code)).not.toThrow();
    expect(code).toContain('const [count, setCount] = useState(0);');
    expect(code).not.toContain('setNext');
    expect(code).not.toContain('useState(count + 1)');
    expect(code).toContain('let next = count + 1;');
    expect(code).toContain('setCount(next);');
  });

  it('reads a function to the brace that closes it', () => {
    // The body used to end at the first line starting with `}`: here the close
    // of the object literal, which left `count = 0;` and the real `}` outside.
    const code = generate(`<script>
let count = 0;
function save() {
  const payload = {
    count: count,
  };
  function inner() {
    return "}";
  }
  count = 0; // reset }
}
function other() {
  return 1;
}
</script>
<div>{count}</div>`);
    expect(() => parses(code)).not.toThrow();
    expect(code).toContain('setCount(0);');
    expect(code).toContain('function inner() {');
    expect(code).not.toContain('const inner = useCallback');
    expect(code).toContain('const other = useCallback');
    expect(code).toContain('functions: { save, other }');
  });

  it('leaves a local that shares a state variable’s name declared', () => {
    const code = generate(`<script>
let count = 0;
function preview() {
  let count = 5;
  return count;
}
</script>
<div>{count}</div>`);
    expect(() => parses(code)).not.toThrow();
    expect(code).toContain('let count = 5;');
  });

  it('keeps every state variable of the script, after functions as well', () => {
    const code = generate(`<script>
let first = 1;
function f() {
  return first;
}
let second = 'two';
</script>
<div>{first}{second}</div>`);
    expect(() => parses(code)).not.toThrow();
    expect(code).toContain('const [first, setFirst] = useState(1);');
    expect(code).toContain(`const [second, setSecond] = useState('two');`);
  });
});
