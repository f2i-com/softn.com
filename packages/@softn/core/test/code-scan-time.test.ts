/**
 * The passes the runtime makes over a page's logic before it runs it, held to
 * time that grows with the logic's length: each used a pattern that scanned to
 * the end again from every opener that never closed, so a page's logic of
 * `/* ` or of blank lines repeated held the main thread for seconds, before
 * the app was asked for anything.
 */
import { describe, expect, it } from 'vitest';
import { blankCommentsAndStrings } from '../src/runtime/code-text';
import { detectWorkerIncompatibilities } from '../src/runtime/script-runtime';
import { inlineLogicImports } from '../src/runtime/logic-imports';
import {
  composeBundleSource,
  pageLogicSources,
  pageStylesheetHrefs,
  UI_IMPORT_DECLARATION_PATTERN,
} from '../src/bundle/source-composer';

const quickly = (run: () => unknown, ms = 1500): boolean => {
  const started = performance.now();
  run();
  return performance.now() - started < ms;
};

describe('blanking comments and strings', () => {
  it('takes comments out and empties strings, and leaves code', () => {
    expect(blankCommentsAndStrings('db.get(1) // db.put\n/* host.call */ x = "window.y" + `navigator.z` + \'a\'')).toBe(
      'db.get(1) \n x = "" + "" + ""'
    );
  });

  it('reads a comment or a string left open to the end', () => {
    expect(blankCommentsAndStrings('a /* b')).toBe('a ');
    expect(blankCommentsAndStrings('a "b\\" c')).toBe('a ""');
  });

  it('is read in time that grows with its length', () => {
    expect(quickly(() => blankCommentsAndStrings('/* '.repeat(80_000)))).toBe(true);
    expect(quickly(() => blankCommentsAndStrings('"'.repeat(80_001)))).toBe(true);
  });
});

describe('the check of what logic needs the main thread for', () => {
  it('finds a bridge used in code, and not one named in a comment or a string', () => {
    expect(detectWorkerIncompatibilities('const n = db.get("x");')).toContain('uses db bridge (synchronous host access)');
    expect(detectWorkerIncompatibilities('// db.get\nconst s = "window.x";')).toEqual([]);
  });

  it('is read in time that grows with its length', () => {
    expect(quickly(() => detectWorkerIncompatibilities('/* '.repeat(80_000)))).toBe(true);
  });
});

describe('composing a page written to hold the page', () => {
  // Each opener that never closed made the composer read its attributes, or
  // look for its end tag, to the end of the page again: `<style ` repeated in
  // half a megabyte (a few kilobytes of a zip) took close to a minute, before
  // the app was asked for anything.
  const compose = (page: string) => () => {
    try {
      composeBundleSource(new Map([['main.ui', `<p>hi</p>${page}`]]), 'main.ui');
    } catch {
      // What the page means is not the question here, only how long it takes.
    }
    pageLogicSources(page);
    pageStylesheetHrefs(page);
    return [...page.matchAll(new RegExp(UI_IMPORT_DECLARATION_PATTERN.source, 'g'))].length;
  };

  it('is read in time that grows with its length', () => {
    for (const page of [
      '<style '.repeat(80_000),
      '<link '.repeat(40_000),
      '<logic>'.repeat(40_000),
      '<script x="'.repeat(20_000) + '>',
      '<style "x"'.repeat(20_000) + '">',
      '<import {'.repeat(40_000),
    ]) {
      expect(quickly(compose(page), 3000), JSON.stringify(page.slice(0, 12))).toBe(true);
    }
  });

  it('still reads a tag whose quoted values hold `>`, however long', () => {
    const page = `<link rel="stylesheet" href="a.css" data-x="${'>'.repeat(10_000)}"><script src="main.js" data-y='>'></script>`;
    expect(pageStylesheetHrefs(page)).toEqual(['a.css']);
    expect(pageLogicSources(page)).toEqual(['main.js']);
  });

  it('still leaves alone a tag written inside a textarea or a comment', () => {
    const page = '<textarea><script src="no.js"></script></textarea><!-- <link rel="stylesheet" href="no.css"> --><script src="yes.js"></script>';
    expect(pageLogicSources(page)).toEqual(['yes.js']);
    expect(pageStylesheetHrefs(page)).toEqual([]);
  });
});

describe('inlining logic imports', () => {
  const imports = (files: Record<string, string>) => ({
    resolver: async (path: string) => files[path] ?? null,
    included: new Set<string>(),
  });

  it('leaves the text around an import as it was, blank lines and all', async () => {
    const code = 'let a = 1;\n\nimport "./b.logic";\n\nlet c = 3;\n';
    const out = await inlineLogicImports(code, imports({ 'b.logic': 'let b = 2;' }), new Set(), 'main.logic');
    expect(out).toContain('let b = 2;');
    expect(out.startsWith('let a = 1;\n\n')).toBe(true);
    expect(out.endsWith('\n\nlet c = 3;\n')).toBe(true);
  });

  it('is read in time that grows with its length', async () => {
    const started = performance.now();
    await inlineLogicImports('\n'.repeat(80_000), imports({}), new Set(), 'main.logic');
    expect(performance.now() - started).toBeLessThan(1500);
  });
});
