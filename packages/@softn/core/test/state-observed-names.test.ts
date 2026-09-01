/**
 * Which state variables are considered "observed" by the document.
 *
 * The runtime holds a variable back from the React sync when no reference to it
 * appears anywhere in the document, because reading a global rebuilds its whole
 * value and a variable nothing renders is pure cost. The test for that is
 * deliberately crude — does this identifier appear in the document at all — and
 * deliberately over-collects, because the two failure modes are not symmetric:
 * keeping a variable nobody reads costs a little speed, while dropping one that
 * IS read silently freezes part of the UI.
 *
 * It was tokenising with an ASCII-only pattern, so it fell the wrong way for
 * every non-ASCII name. `café` tokenised as "caf", `счётчик` as nothing at all,
 * and the engine accepts both as identifiers.
 */
import { describe, it, expect } from 'vitest';
import { collectObservedStateNames } from '../src/runtime/script-runtime';
import { parse } from '../src/parser';

function observed(source: string): ReadonlySet<string> | null {
  return collectObservedStateNames(parse(source) as never);
}

describe('collectObservedStateNames', () => {
  it('finds an ordinary ASCII name', () => {
    expect(observed('<Text>{count}</Text>')).toContain('count');
  });

  for (const name of ['café', 'naïve', 'ölmenge', 'счётчик', '数', 'ñandú']) {
    it(`finds the Unicode name ${name} whole`, () => {
      const set = observed(`<Text>{${name}}</Text>`);
      expect(set).toContain(name);
    });
  }

  it('does not settle for the ASCII prefix of a Unicode name', () => {
    // The specific way it failed: "café" reached the set as "caf", so a lookup
    // for the real name missed and the variable was held back.
    const set = observed('<Text>{café}</Text>')!;
    expect(set.has('café')).toBe(true);
  });

  it('still reports a name used only in an attribute or handler', () => {
    const set = observed('<Box @click={résumé} class={estado} />')!;
    expect(set.has('résumé')).toBe(true);
    expect(set.has('estado')).toBe(true);
  });

  it('keeps over-collecting rather than under-collecting', () => {
    // A name in ordinary prose still counts. That is the intended bias.
    const set = observed('<Text>the tötal is shown below</Text>')!;
    expect(set.has('tötal')).toBe(true);
  });

  it('always includes the framework-observed names', () => {
    expect(observed('<Text>nothing</Text>')).toContain('currentPage');
  });
});
