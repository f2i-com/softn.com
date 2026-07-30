/**
 * Reading string constants out of a .logic file for the design canvas.
 *
 * The file belongs to whoever built the .softn bundle, so the two halves of
 * this are equally load-bearing: the declarations a designer expects to see
 * previewed still resolve, and no expression is ever evaluated to find out
 * what it would produce.
 */

import { describe, it, expect } from 'vitest';
import { parseStringLiteralVariables } from './logicStringLiterals';

/** Set by any payload below that manages to run. */
let sideEffect: string | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).__markExecuted = () => {
  sideEffect = 'executed';
  return 'executed';
};

describe('declarations it resolves', () => {
  it('reads quoted literals, either quote', () => {
    const values = parseStringLiteralVariables(`const a = "one"\nlet b = 'two'\nvar c = \`three\``);

    expect(values).toEqual({ a: 'one', b: 'two', c: 'three' });
  });

  it('reads escapes the way JavaScript does', () => {
    const values = parseStringLiteralVariables(
      String.raw`const a = "a\tb\nA\x42\u{1f600}\q\""`
    );

    expect(values.a).toBe('a\tb\nAB\u{1f600}q"');
  });

  it('concatenates literals and variables already resolved', () => {
    const values = parseStringLiteralVariables(
      `const base = "assets"\nconst logo = base + "/" + \`logo.png\`\n`
    );

    expect(values.logo).toBe('assets/logo.png');
  });

  it('substitutes resolved variables into a template', () => {
    const values = parseStringLiteralVariables(
      `let dir = "img"\nlet path = \`./\${dir}/hero.webp\`\n`
    );

    expect(values.path).toBe('./img/hero.webp');
  });

  it('applies the URI encoders to a literal argument', () => {
    // The one shape in the demo bundles that needs more than concatenation:
    // an inline SVG icon encoded into a data URL.
    const values = parseStringLiteralVariables(
      `let icon = "data:image/svg+xml," + encodeURIComponent("<svg id='a'/>")`
    );

    expect(values.icon).toBe('data:image/svg+xml,' + encodeURIComponent("<svg id='a'/>"));
  });

  it('ignores a variable it could not resolve earlier', () => {
    const values = parseStringLiteralVariables(
      `const stamp = Date.now()\nconst name = "run-" + stamp\n`
    );

    expect(values).toEqual({});
  });
});

describe('declarations it refuses to evaluate', () => {
  const payloads: Record<string, string> = {
    'a call': `const x = __markExecuted()`,
    'a call inside a concatenation': `const x = "a" + __markExecuted()`,
    'a call inside a template': 'const x = `a${__markExecuted()}`',
    'an immediately invoked function': `const x = (() => __markExecuted())()`,
    'the Function constructor': `const x = ''.constructor.constructor('__markExecuted()')()`,
    'a property read': `const x = globalThis.__markExecuted.name`,
    'an assignment': `const x = (globalThis.stolen = __markExecuted())`,
    'a comma sequence': `const x = __markExecuted(), y = "z"`,
    'a ternary': `const x = __markExecuted() ? "a" : "b"`,
    'a method on a literal': `const x = "AB".toLowerCase()`,
    'an encoder wrapping a call': `const x = encodeURIComponent(__markExecuted())`,
    'a function that is not on the allowlist': `const x = String("a")`,
  };

  for (const [shape, source] of Object.entries(payloads)) {
    it(`leaves ${shape} unresolved and unrun`, () => {
      sideEffect = null;

      const values = parseStringLiteralVariables(source);

      expect(sideEffect).toBeNull();
      expect(values.x).toBeUndefined();
    });
  }

  it('resolves nothing through the prototype chain', () => {
    const values = parseStringLiteralVariables(`const path = constructor + "/x"`);

    expect(values.path).toBeUndefined();
    expect(values.toString).toBeUndefined();
  });

  it('gives up on a malformed URI sequence instead of throwing', () => {
    expect(() => parseStringLiteralVariables(`const x = decodeURIComponent("%E0%A4%A")`)).not.toThrow();
    expect(parseStringLiteralVariables(`const x = decodeURIComponent("%E0%A4%A")`).x).toBeUndefined();
  });
});
