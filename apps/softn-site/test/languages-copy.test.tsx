/**
 * The front door says what the product is: app logic in JavaScript or Python,
 * and torch for Python apps that declare it. The Python sample is highlighted
 * as Python (a `#` is a comment there, and `#each` everywhere else), and every
 * link to the languages guide points at a guide the docs build really has.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { Language, panelTag } from '../src/components/Language';
import { Pipeline } from '../src/components/Pipeline';
import { Footer } from '../src/components/Footer';
import { Doors } from '../src/components/Doors';
import { SAMPLES } from '../src/data/language';
import { highlight, languageOf } from '../src/lib/highlight';
import { runsLabel } from '../src/lib/format';
import content from '../../../docs/content/softn-docs.json';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const text = (element: React.ReactElement) => renderToStaticMarkup(element).replace(/<[^>]+>/g, '').replace(/&#x27;|&rsquo;/g, '’');

it('names both logic languages wherever the site describes the engine', () => {
  expect(text(<Footer />)).toMatch(/engine for JavaScript\s+and Python/);
  expect(text(<Doors />)).toContain('choose JavaScript or Python');
  const pipeline = text(<Pipeline />);
  expect(pipeline).toContain('JavaScript, or Python');
  expect(pipeline).toMatch(/declares torch in its manifest/);
  // Measured: CPU, small models — never a GPU claim the runtime does not wire.
  expect(pipeline).not.toMatch(/GPU/);
});

it('links the languages guide, and that guide exists', () => {
  const slugs = new Set(content.pages.map((p: { slug: string }) => p.slug));
  expect(slugs.has('language-support')).toBe(true);
  for (const markup of [renderToStaticMarkup(<Pipeline />), renderToStaticMarkup(<Language />)]) {
    expect(markup).toContain('href="/docs/language-support/"');
  }
});

it('highlights Python as Python and SoftN markup as markup', () => {
  const classes = (source: string, lang?: 'python' | 'softn') =>
    highlight(source, lang).map((el) => [el.props.className as string, el.props.children as string]);
  expect(classes('# a comment\nx = 1', 'python')[0]).toEqual(['tok-com', '# a comment']);
  expect(classes('def train():\n    global loss', 'python').filter(([c]) => c === 'tok-mark').map(([, t]) => t)).toEqual(['def', 'global']);
  // The default rules keep `#each` a directive rather than a comment.
  expect(classes('#each (t in tasks)')[0]).toEqual(['tok-mark', '#each']);
  expect(languageOf('logic/main.py')).toBe('python');
  expect(languageOf('logic/main.logic')).toBe('softn');
});

it('shows the Python sample under a Python tag, with its declaration of torch', () => {
  const python = SAMPLES.find((s) => s.file.endsWith('.py'));
  expect(python?.source).toContain('"config": { "python": { "packages": ["torch"] } }');
  expect(panelTag('logic/main.py')).toBe('python');
  expect(panelTag('logic/main.logic')).toBe('logic');
  expect(panelTag('ui/main.ui')).toBe('markup');

  act(() => root.render(<Language />));
  const tab = host.querySelector<HTMLButtonElement>('#lang-tab-python')!;
  act(() => tab.click());
  expect(host.querySelector('.panel-bar-tag')?.textContent).toBe('python');
  expect(host.querySelector('.panel-bar-name')?.textContent).toBe('logic/main.py');
  expect(host.querySelector('.lang-code .tok-com')?.textContent).toMatch(/^# /);
});

it('agrees the noun with the run count', () => {
  expect(runsLabel(1)).toBe('1 run');
  expect(runsLabel(0)).toBe('0 runs');
  expect(runsLabel(12)).toBe('12 runs');
});
