/**
 * What the canvas writes back into a page is its template, and the page's
 * frame stays as the page wrote it.
 *
 * An HTML page's frame is its `<html>` and its `<body>`. The parser reads the
 * body as a `div` with the body's attributes, and the first edit on the
 * canvas wrote that `div` in the body's place and dropped `</body></html>`
 * (sourceFrame.ts). And a page saved with CR LF came back from one edit with
 * its template in LF and its head and tail in CR LF.
 */

import { describe, expect, it } from 'vitest';
import { parse } from '@softn/core';
import { parseSource } from './sourceParser';
import { writeBack } from './sourceFrame';
import type { CanvasElement } from '../types/builder';

/** `source` read into the model, `edit` made on it, and the page written back. */
function editedOnce(source: string, edit: (elements: Map<string, CanvasElement>) => void): string {
  const parsed = parseSource(source);
  expect(parsed.fidelity.reasons).toEqual([]);
  const elements = new Map([...parsed.elements].map(([id, element]) => [id, { ...element, props: { ...element.props } }]));
  edit(elements);
  return writeBack(source, parse(source), elements, parsed.rootId);
}

const byTag = (elements: Map<string, CanvasElement>, tag: string) => [...elements.values()].find((element) => element.componentType === tag)!;

const PAGE = `<!DOCTYPE html>
<html>
<head>
  <title>Tasks</title>
  <script src="main.js"></script>
</head>
<body class="app" data-x="1">
  <h1>Tasks</h1>
  <p class="lead">Things to do.</p>
</body>
</html>
`;

describe('an HTML page edited on the canvas', () => {
  it('keeps its <body> and its </body></html>', () => {
    const written = editedOnce(PAGE, (elements) => void (byTag(elements, 'h1').props.children = 'Chores'));
    expect(written).toContain('<h1>Chores</h1>');
    expect(written).toContain('<body class="app" data-x="1">');
    expect(written).not.toContain('<div class="app"');
    expect(written.endsWith('</body>\n</html>\n')).toBe(true);
    expect(written.startsWith('<!DOCTYPE html>\n<html>\n<head>')).toBe(true);
  });

  it('writes what Properties changes of the body onto the <body> tag', () => {
    const written = editedOnce(PAGE, (elements) => void (byTag(elements, 'div').props.class = 'app dark'));
    expect(written).toContain('<body class="app dark" data-x="1">');
    expect(written.endsWith('</body>\n</html>\n')).toBe(true);
  });

  it('keeps a script at the end of the body, inside it', () => {
    const page = PAGE.replace('</body>', '  <script src="later.js"></script>\n</body>');
    const written = editedOnce(page, (elements) => void (byTag(elements, 'h1').props.children = 'Chores'));
    expect(written).toContain('<script src="later.js"></script>\n</body>\n</html>\n');
    expect(written.match(/<\/body>/g)).toHaveLength(1);
  });

  it('is the same page to the engine as the one it was, but for the edit', () => {
    const written = editedOnce(PAGE, (elements) => void (byTag(elements, 'h1').props.children = 'Chores'));
    expect(parseSource(written).fidelity.reasons).toEqual([]);
    // And a second write of what was written moves nothing.
    const again = parseSource(written);
    expect(writeBack(written, parse(written), again.elements, again.rootId)).toBe(written);
  });

  it('keeps </html> where the page has no <body> tag', () => {
    const page = '<!DOCTYPE html>\n<html>\n<head><title>T</title></head>\n<p>One</p>\n</html>\n';
    const written = editedOnce(page, (elements) => void (byTag(elements, 'p').props.children = 'Two'));
    expect(written).toContain('<p>Two</p>');
    expect(written.endsWith('</html>\n')).toBe(true);
  });
});

describe('a page saved with CR LF, edited on the canvas', () => {
  it('is written back with CR LF throughout', () => {
    const page = '<logic src="../logic/main.logic" />\r\n\r\n<App>\r\n  <Stack>\r\n    <Text>One</Text>\r\n  </Stack>\r\n</App>\r\n<style>\r\n.a { color: red; }\r\n</style>\r\n';
    const written = editedOnce(page, (elements) => void (byTag(elements, 'Text').props.children = 'Two'));
    expect(written).toContain('<Text>Two</Text>');
    expect(written.replace(/\r\n/g, '')).not.toContain('\n');
    expect(written.startsWith('<logic src="../logic/main.logic" />\r\n\r\n<App>\r\n')).toBe(true);
  });

  it('and a page saved with LF stays LF', () => {
    const page = '<App>\n  <Text>One</Text>\n</App>\n';
    const written = editedOnce(page, (elements) => void (byTag(elements, 'Text').props.children = 'Two'));
    expect(written).toBe('<App>\n  <Text>Two</Text>\n</App>\n');
  });
});
