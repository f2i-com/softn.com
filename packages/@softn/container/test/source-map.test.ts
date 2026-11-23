import { describe, expect, it } from 'vitest';
import {
  SourceMapRegistry,
  findInlineScriptStartLines,
  formatCodeFrame,
} from '../src/source-map';

describe('findInlineScriptStartLines', () => {
  it('locates 1-based start lines of inline and external script tags while skipping comments', () => {
    const html = [
      '<!doctype html>',
      '<html>',
      '<head>',
      '  <!-- <script>ignored()</script> -->',
      '  <script src="lib.js"></script>',
      '  <script>',
      '    const x = 1;',
      '  </script>',
      '</head>',
      '<body>',
      '  <script type="module">',
      '    console.log("<script>inside string</script>");',
      '    boom();',
      '  </script>',
      '</body>',
      '</html>',
    ].join('\n');

    expect(findInlineScriptStartLines(html)).toEqual([5, 6, 11]);
  });
});

describe('SourceMapRegistry', () => {
  it('maps combined ZIPP line numbers back to original module file, line, column, and code frame', () => {
    const map = new SourceMapRegistry();
    const appCode = [
      'export function greet(name) {',
      '  const upper = name.toUpperCase();',
      '  return missingHelper(upper);',
      '}',
    ].join('\n');

    map.addSegment({
      file: 'src/app.js',
      combinedStart: 4000,
      combinedEnd: 4010,
      sourceStartLine: 1,
      wrapperLines: 2, // define(...) + 1 export getter line
      sourceText: appCode,
    });

    const err = new ReferenceError('missingHelper is not defined at :4004:10');
    err.stack = 'ReferenceError: missingHelper is not defined\n    at greet (:4004:10)';

    const enriched = map.enrichError(err);
    expect(enriched.file).toBe('src/app.js');
    expect(enriched.line).toBe(3);
    expect(enriched.column).toBe(10);
    expect(enriched.message).toContain('src/app.js:3:10');
    expect(enriched.stack).toContain('src/app.js:3:10');
    expect(enriched.snippet).toContain('> 3 |   return missingHelper(upper);');
    expect(enriched.snippet).toContain('         ^');
  });

  it('maps inline HTML scripts to their true line inside the HTML document', () => {
    const map = new SourceMapRegistry();
    const inlineCode = '\nconst a = 1;\nconst b = brokenVar + a;\n';

    const enriched = map.enrichError(
      new ReferenceError('brokenVar is not defined at <eval>:3:11'),
      { file: 'about.html', startLine: 20, sourceText: inlineCode },
    );

    expect(enriched.file).toBe('about.html');
    expect(enriched.line).toBe(22);
    expect(enriched.column).toBe(11);
    expect(enriched.message).toContain('about.html:22:11');
    expect(enriched.snippet).toContain('> 22 | const b = brokenVar + a;');
  });

  it('formats multi-line code frames cleanly', () => {
    const frame = formatCodeFrame('line1\nline2\nline3\nline4', 2, 12, 3);
    expect(frame).toContain('  11 | line1');
    expect(frame).toContain('> 12 | line2');
    expect(frame).toContain('     |   ^');
    expect(frame).toContain('  13 | line3');
  });
});
