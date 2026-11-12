/**
 * Which node drew an element, for a host that edits an app while it runs
 * (edit/edit-marks.ts, edit/source-origins.ts).
 *
 * Off, the renderer makes what it always made: the same elements, no ref, no
 * prop. On, every element on the page is traced to the file and the place
 * that drew it, through loops, conditions, components and imported pages, and
 * still nothing is written on the page: the app's styles and code have
 * nothing to read.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { composeBundleSource } from '../src/bundle/source-composer';
import { composeBundleOrigins, createEditMarks, drawnAt, drawnFrom, originOf, placesOf, type EditMarks } from '../src/edit';
import { SoftNRenderer } from '../src/loader/SoftNRenderer';
import { parse } from '../src/parser';
import { ComponentRegistry, createRenderCache, renderDocument } from '../src/renderer';
import { logicEngineIsSandboxed } from '../src/runtime/vm-adapter';
import type { SoftNRenderContext } from '../src/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
});

/** What each probe component was given, by the name it was drawn under. */
const given: Array<Record<string, unknown>> = [];

function registry(): ComponentRegistry {
  const made = new ComponentRegistry();
  made.register('Card', ({ children, title }: { children?: React.ReactNode; title?: string }) => (
    <section className="card">
      <header>{title}</header>
      <div className="card-body">{children}</div>
    </section>
  ));
  // Two elements at its top, and a record of everything it was handed.
  made.register('Probe', (props: Record<string, unknown>) => {
    given.push(props);
    return (
      <>
        <b className="probe-a">a</b>
        <i className="probe-b">b</i>
      </>
    );
  });
  return made;
}

const FILES = new Map<string, string>([
  ['manifest.json', JSON.stringify({ name: 'Traced', version: '1.0.0', main: 'ui/main.ui' })],
  [
    'ui/main.ui',
    [
      '<import Header from="./header.ui" />',
      '<import Row from="./parts/row.ui" />',
      '<logic src="../logic/main.logic" />',
      '<link rel="stylesheet" href="../styles/app.css">',
      '<main class="page">',
      '  <Header />',
      '  <h1 id="title">Tasks</h1>',
      '  #if (open)',
      '    <p class="shown">Open</p>',
      '  #else',
      '    <p class="hidden">Closed</p>',
      '  #end',
      '  <ul>',
      '    #each (task in tasks)',
      '      <Row />',
      '    #end',
      '  </ul>',
      '  <span class="tag" each={tags} as="tag">{tag}</span>',
      '  <Card title="Notes">',
      '    <em class="inside">kept</em>',
      '    <Probe label="x" />',
      '  </Card>',
      '  <Header />',
      '</main>',
      '',
    ].join('\n'),
  ],
  [
    'ui/header.ui',
    ['// The bar every page wears.', '<style>', '.bar { color: red; }', '</style>', '<App theme="dark">', '  <nav class="bar">', '    <a class="home" href="#">Home</a>', '  </nav>', '</App>', ''].join('\n'),
  ],
  ['ui/parts/row.ui', '<li class="row"><strong>{task.name}</strong> <small if={task.done}>done</small></li>\n'],
  ['logic/main.logic', 'let open = true\n'],
  ['styles/app.css', '.page { margin: 0; }\n'],
]);

const STATE = { open: true, tasks: [{ id: 1, name: 'One', done: true }, { id: 2, name: 'Two', done: false }], tags: ['a', 'b', 'c'] };

function context(marks?: EditMarks, cached = false): SoftNRenderContext {
  return {
    state: STATE,
    setState: () => {},
    data: {} as SoftNRenderContext['data'],
    props: {},
    computed: {},
    functions: {},
    asyncFunctions: {},
    ...(cached ? { renderCache: createRenderCache() } : {}),
    ...(marks ? { editMarks: marks } : {}),
  };
}

function draw(source: string, marks?: EditMarks): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  const doc = parse(source);
  const made = registry();
  act(() => {
    root.render(<>{renderDocument(doc, context(marks), made)}</>);
  });
  return container;
}

/** Every React element under `node`, however it is held. */
function elementsOf(node: React.ReactNode, into: React.ReactElement[] = []): React.ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) elementsOf(child, into);
  } else if (React.isValidElement(node)) {
    into.push(node);
    elementsOf((node.props as { children?: React.ReactNode }).children, into);
  }
  return into;
}

/** Where two texts first differ, with what each says there; null when they are the same. */
function firstDifference(a: string, b: string): string | null {
  if (a === b) return null;
  let at = 0;
  while (at < a.length && a[at] === b[at]) at++;
  return `at ${at}: ${JSON.stringify(a.slice(Math.max(0, at - 60), at + 80))} against ${JSON.stringify(b.slice(Math.max(0, at - 60), at + 80))}`;
}

/** The line and column (from 1) of `offset` in `text`. */
function lineOf(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset);
  const line = before.split('\n').length;
  return { line, column: offset - (before.lastIndexOf('\n') + 1) + 1 };
}

describe('a page drawn with no host editing it', () => {
  it('is made of the elements it was always made of: no ref, no prop, the same markup', () => {
    const composed = composeBundleSource(FILES, 'ui/main.ui');
    const doc = parse(composed.source);
    const plain = renderDocument(doc, context(), registry());
    for (const element of elementsOf(plain)) {
      expect((element as unknown as { ref: unknown }).ref ?? null).toBeNull();
      expect(Object.keys(element.props as object)).not.toContain('mark');
      expect(Object.keys(element.props as object)).not.toContain('ref');
    }
    const marks = createEditMarks();
    const marked = renderDocument(doc, context(marks), registry());
    // The page a host edits is, to anything that reads it, the page it would be otherwise.
    expect(renderToStaticMarkup(<>{marked}</>)).toBe(renderToStaticMarkup(<>{plain}</>));
    expect(draw(composed.source, marks).innerHTML).toBe(draw(composed.source).innerHTML);
  });

  it('composes the same page whether or not its origins are asked for', () => {
    const plain = composeBundleSource(FILES, 'ui/main.ui', ['logic/main.logic']);
    const traced = composeBundleOrigins(FILES, 'ui/main.ui', ['logic/main.logic']);
    const { origins, ...rest } = traced;
    expect(rest).toEqual(plain);
    expect(origins.length).toBeGreaterThan(0);
  });

  it('hands React the same element again, and a new one when a host starts or stops editing', () => {
    const doc = parse('<div><p id="p">Words</p></div>');
    const cached = context(undefined, true);
    const made = registry();
    const first = elementsOf(renderDocument(doc, cached, made));
    const second = elementsOf(renderDocument(doc, cached, made));
    expect(second[0]).toBe(first[0]);
    const marks = createEditMarks();
    const editing = elementsOf(renderDocument(doc, { ...cached, editMarks: marks }, made));
    expect(editing[0]).not.toBe(first[0]);
    expect(elementsOf(renderDocument(doc, { ...cached, editMarks: marks }, made))[0]).toBe(editing[0]);
    expect(elementsOf(renderDocument(doc, cached, made))[0]).not.toBe(editing[0]);
  });
});

describe('a page drawn for a host that is editing it', () => {
  it('traces every element on the page to the file and the place that drew it', () => {
    const composed = composeBundleOrigins(FILES, 'ui/main.ui', ['logic/main.logic']);
    const marks = createEditMarks();
    const container = draw(composed.source, marks);
    const drawn = Array.from(container.querySelectorAll('*'));
    expect(drawn.length).toBeGreaterThan(20);

    const traced = new Map<Element, { file: string; line: number; tag: string; component: boolean }>();
    for (const element of drawn) {
      const from = drawnFrom(marks, element);
      expect(from, element.outerHTML).not.toBeNull();
      const origin = originOf(composed.origins, from!.node.loc.start);
      expect(origin, `<${from!.node.tag}> at ${from!.node.loc.start}`).not.toBeNull();
      const written = FILES.get(origin!.file)!;
      // The place is where the tag's name is written, in its own file.
      expect(written.slice(origin!.offset - 1, origin!.offset + from!.node.tag.length)).toBe(`<${from!.node.tag}`);
      traced.set(element, { file: origin!.file, line: lineOf(written, origin!.offset).line, tag: from!.node.tag, component: from!.component });
    }
    const at = (selector: string) => Array.from(container.querySelectorAll(selector), (element) => traced.get(element)!);

    // The page's own elements, by the line they are written on.
    expect(at('#title')).toEqual([{ file: 'ui/main.ui', line: 7, tag: 'h1', component: false }]);
    expect(at('main.page')).toEqual([{ file: 'ui/main.ui', line: 5, tag: 'main', component: false }]);
    // Inside a condition: the branch that is drawn.
    expect(at('p.shown')).toEqual([{ file: 'ui/main.ui', line: 9, tag: 'p', component: false }]);
    expect(at('p.hidden')).toEqual([]);
    // An element with each=: drawn three times from one place.
    expect(at('span.tag')).toEqual(Array(3).fill({ file: 'ui/main.ui', line: 18, tag: 'span', component: false }));
    // Inside a loop, in an imported page: each pass from that page's one line.
    expect(at('li.row')).toEqual(Array(2).fill({ file: 'ui/parts/row.ui', line: 1, tag: 'li', component: false }));
    expect(at('li.row strong')).toEqual(Array(2).fill({ file: 'ui/parts/row.ui', line: 1, tag: 'strong', component: false }));
    expect(at('li.row small')).toEqual([{ file: 'ui/parts/row.ui', line: 1, tag: 'small', component: false }]);
    // An imported page used twice: both uses from its own file, past what was taken off it.
    expect(at('nav.bar')).toEqual(Array(2).fill({ file: 'ui/header.ui', line: 6, tag: 'nav', component: false }));
    expect(at('a.home')).toEqual(Array(2).fill({ file: 'ui/header.ui', line: 7, tag: 'a', component: false }));
    // What a component draws is the component's, at the place the component is written.
    expect(at('section.card')).toEqual([{ file: 'ui/main.ui', line: 19, tag: 'Card', component: true }]);
    expect(at('section.card > header')).toEqual([{ file: 'ui/main.ui', line: 19, tag: 'Card', component: true }]);
    // What is written inside a component is its own.
    expect(at('em.inside')).toEqual([{ file: 'ui/main.ui', line: 20, tag: 'em', component: false }]);
    expect(at('b.probe-a')).toEqual([{ file: 'ui/main.ui', line: 21, tag: 'Probe', component: true }]);
    expect(at('i.probe-b')).toEqual([{ file: 'ui/main.ui', line: 21, tag: 'Probe', component: true }]);
  });

  it('says what a component drew, and finds everything a place in the source drew', () => {
    const composed = composeBundleOrigins(FILES, 'ui/main.ui', ['logic/main.logic']);
    const marks = createEditMarks();
    const container = draw(composed.source, marks);

    const probe = drawnFrom(marks, container.querySelector('.probe-b')!)!;
    expect(probe.elements).toEqual([container.querySelector('.probe-a'), container.querySelector('.probe-b')]);
    const card = drawnFrom(marks, container.querySelector('.card-body')!)!;
    expect(card.elements).toEqual([container.querySelector('section.card')]);

    // A place in a file, to every place of the composed page made from it, to what each drew.
    const nav = FILES.get('ui/header.ui')!.indexOf('<nav') + 1;
    const places = placesOf(composed.origins, 'ui/header.ui', nav);
    expect(places).toHaveLength(2);
    const navs = places.flatMap((place) => drawnAt(marks, container, place)).flatMap((from) => from.elements);
    expect(navs).toEqual(Array.from(container.querySelectorAll('nav.bar')));

    const row = placesOf(composed.origins, 'ui/parts/row.ui', 1);
    expect(row).toHaveLength(1);
    expect(drawnAt(marks, container, row[0]).flatMap((from) => from.elements)).toEqual(Array.from(container.querySelectorAll('li.row')));

    const cardAt = placesOf(composed.origins, 'ui/main.ui', FILES.get('ui/main.ui')!.indexOf('<Card') + 1);
    expect(drawnAt(marks, container, cardAt[0])).toMatchObject([{ component: true, elements: [container.querySelector('section.card')] }]);
  });

  it('says what drew an element now, however many times the page has been drawn again from newer text', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });
    const marks = createEditMarks();
    const made = registry();
    // Each version has more words on its first line than the last: every
    // element after it is on the line and at the column it was, so it is the
    // element it was to React, and at another place in the text.
    const version = (n: number) => `<p class="lead">${'word '.repeat(n)}</p>\n<div class="page">\n  <Card title="T"><em class="inside">in</em></Card>\n  <Probe label="p" />\n</div>`;
    const placeOf = (selector: string) => drawnFrom(marks, container.querySelector(selector)!)!;
    const kept = new Map<string, Element>();
    for (let n = 1; n <= 6; n++) {
      const source = version(n);
      const doc = parse(source);
      act(() => {
        root.render(<>{renderDocument(doc, context(marks), made)}</>);
      });
      // The elements are the ones first made: only what drew them is newer.
      for (const selector of ['section.card', '.probe-a', 'em.inside']) {
        const element = container.querySelector(selector)!;
        if (n > 1) expect(element, `${selector} at version ${n}`).toBe(kept.get(selector));
        kept.set(selector, element);
      }
      const card = placeOf('section.card > header');
      expect(card.node.loc.start, `the card at version ${n}`).toBe(source.indexOf('<Card') + 1);
      expect(card.elements).toEqual([container.querySelector('section.card')]);
      const probe = placeOf('.probe-a');
      expect(probe.node.loc.start, `the probe at version ${n}`).toBe(source.indexOf('<Probe') + 1);
      expect(probe.elements).toEqual([container.querySelector('.probe-a'), container.querySelector('.probe-b')]);
      expect(placeOf('em.inside').node.loc.start, `the em at version ${n}`).toBe(source.indexOf('<em') + 1);
      expect(placeOf('div.page').node.loc.start).toBe(source.indexOf('<div') + 1);
      // And from the place to the elements: the ones on screen now, once each.
      expect(drawnAt(marks, container, source.indexOf('<Probe') + 1)).toHaveLength(1);
      expect(drawnAt(marks, container, source.indexOf('<Card') + 1).flatMap((from) => from.elements)).toEqual([container.querySelector('section.card')]);
      expect(drawnAt(marks, container, source.indexOf('<em') + 1).flatMap((from) => from.elements)).toEqual([container.querySelector('em.inside')]);
      // The place the version before had the component at draws nothing now.
      if (n > 1) expect(drawnAt(marks, container, version(n - 1).indexOf('<Card') + 1)).toEqual([]);
    }
  });

  it('leaves what the composer wrote without an origin, and every origin reads the same in its file', () => {
    const composed = composeBundleOrigins(FILES, 'ui/main.ui', ['logic/main.logic']);
    for (const origin of composed.origins) {
      expect(composed.source.slice(origin.start, origin.end)).toBe(FILES.get(origin.file)!.slice(origin.fileStart, origin.fileStart + (origin.end - origin.start)));
    }
    // The stylesheet's rules stand where its link was, and the logic at the end: neither is a page's own text.
    expect(originOf(composed.origins, composed.source.indexOf('.page { margin'))).toBeNull();
    expect(originOf(composed.origins, composed.source.indexOf('let open'))).toBeNull();
    expect(originOf(composed.origins, composed.source.indexOf('.bar { color'))).toBeNull();
  });

  it('gives a component nothing of it, and writes nothing on an element', () => {
    given.length = 0;
    const source = composeBundleSource(FILES, 'ui/main.ui').source;
    const plain = draw(source);
    const off = given.splice(0);
    const marks = createEditMarks();
    const marked = draw(source, marks);
    const on = given.splice(0);
    expect(on.length).toBeGreaterThan(0);
    expect(on.map((props) => Object.keys(props).sort())).toEqual(off.map((props) => Object.keys(props).sort()));
    for (const props of on) expect(Object.keys(props)).not.toContain('mark');

    const own = (element: Element) => Object.keys(element).filter((key) => !key.startsWith('__react'));
    const names = (element: Element) => element.getAttributeNames().sort();
    const markedElements = Array.from(marked.querySelectorAll('*'));
    const plainElements = Array.from(plain.querySelectorAll('*'));
    expect(markedElements.map(names)).toEqual(plainElements.map(names));
    expect(markedElements.map(own)).toEqual(plainElements.map(own));
  });

  it('does not take an app’s own prop for a note of the renderer’s', () => {
    const made = new ComponentRegistry();
    made.register('Forged', () => <output className="forged">x</output>);
    const marks = createEditMarks();
    const doc = parse('<div id="outer"><Forged mark={fake} /></div>');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });
    const fake = { type: 'Element', tag: 'Elsewhere', loc: { line: 1, column: 1, start: 9999, end: 9999 } };
    act(() => {
      root.render(<>{renderDocument(doc, { ...context(marks), state: { fake } }, made)}</>);
    });
    const from = drawnFrom(marks, container.querySelector('.forged')!)!;
    expect(from.node.tag).toBe('Forged');
    expect(from.node.loc.start).toBe(doc.template[0].type === 'Element' ? (doc.template[0].children[0] as { loc: { start: number } }).loc.start : -1);
    expect(drawnAt(marks, container, 9999)).toEqual([]);
  });

  it('notes an element through its ref, and leaves one that wrote a ref of its own as it was', () => {
    const refOf = (element: React.ReactElement) => (element as unknown as { ref: unknown }).ref;
    const doc = parse('<div id="outer"><p id="plain" ref="mine">a</p></div>');
    const off = elementsOf(renderDocument(doc, context(), registry()));
    const on = elementsOf(renderDocument(doc, context(createEditMarks()), registry()));
    expect(typeof refOf(on[0])).toBe('function');
    expect(refOf(on[1])).toBe(refOf(off[1]));
    expect(refOf(on[1])).toBe('mine');
  });
});

// A page's code is given a document of its own only where the code runs in a
// sandbox (see vitest.host-js.config.ts on document-shell-page.test.tsx): on
// the host-JavaScript engine there is no such page to draw.
describe.skipIf(!logicEngineIsSandboxed())('an app whose page a host is editing', () => {
  const PAGE = `<!DOCTYPE html>
<html>
<body>
  <h1 id="title" class="big">Title</h1>
  <button id="look">Look</button>
  <pre id="seen"></pre>
  <script>
    document.getElementById('look').addEventListener('click', (event) => {
      const title = document.getElementById('title');
      const target = event.target;
      document.getElementById('seen').textContent = JSON.stringify({
        html: document.body.innerHTML.replace(/<pre[^]*<\\/pre>/, ''),
        names: title.getAttributeNames(),
        data: Object.keys(title.dataset),
        own: Object.keys(title),
        target: Object.keys(target.dataset).concat(target.getAttributeNames()),
      });
    });
  </script>
</body>
</html>`;

  async function seenBy(marks?: EditMarks): Promise<{ seen: string; html: string }> {
    const container = document.createElement('div');
    document.body.appendChild(container);
    let root: Root | null = null;
    await act(async () => {
      root = createRoot(container);
      root.render(<SoftNRenderer source={PAGE} appId={`edit-marks-${marks ? 'on' : 'off'}`} scriptExecutionMode="main" editMarks={marks} />);
    });
    mounted.push({ root: root!, container });
    for (let i = 0; i < 200 && !container.querySelector('#look'); i++) {
      await act(async () => {
        await sleep(20);
      });
    }
    // Asked until the page's code has answered: its listener is there once its script has run.
    for (let i = 0; i < 200 && !container.querySelector('#seen')?.textContent; i++) {
      await act(async () => {
        container.querySelector('#look')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await sleep(20);
      });
    }
    const seen = container.querySelector('#seen')?.textContent ?? '';
    return { seen, html: container.innerHTML.replace(/<pre[^]*<\/pre>/, '') };
  }

  it('shows its code the page it would see with no host editing: no attribute, no property, nothing in what it reads', async () => {
    const off = await seenBy();
    const marks = createEditMarks();
    const on = await seenBy(marks);
    expect(off.seen).not.toBe('');
    // Its own name for the document aside (each mount has one), the code reads the same page.
    const steady = (text: string) =>
      text
        .replace(/edit-marks-(?:on|off)/g, 'app')
        .replace(/\ba\d+\b/g, 'scope')
        .replace(/(data-softn-node=\\*")[a-z0-9]+:/g, '$1shell:');
    expect(firstDifference(steady(on.seen), steady(off.seen))).toBeNull();
    expect(firstDifference(steady(on.html), steady(off.html))).toBeNull();
    // And the host can still say what drew the element.
    const title = Array.from(document.querySelectorAll('#title')).find((element) => drawnFrom(marks, element) !== null);
    expect(title, 'the title is traced while its code runs').toBeDefined();
    expect(drawnFrom(marks, title!)!.node.tag).toBe('h1');
    expect(PAGE.slice(drawnFrom(marks, title!)!.node.loc.start - 1).startsWith('<h1 id="title"')).toBe(true);
  });
});
