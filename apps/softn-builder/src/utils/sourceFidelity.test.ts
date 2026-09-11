/**
 * A visual edit never silently discards what the visual model cannot hold.
 *
 * `parseSource` reports whether its elements reproduce the source; the
 * store asks before it regenerates a file from them. A file with a
 * comment, an expression the parser stops reading part way through, text
 * between child elements or a header block the regenerator does not carry
 * is source-only: the edit is refused, the file keeps its bytes, and the
 * reasons are recorded for the editor to show. A file the model does hold
 * — nested blocks, `#empty` branches and grouped expressions included — is
 * regenerated, and what comes out renders the same in the engine.
 */

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { parse, renderDocument, ComponentRegistry } from '@softn/core';
import type { SoftNRenderContext } from '@softn/core';
import { parseSource, assessSourceFidelity } from './sourceParser';
import { useFilesStore } from '../stores/filesStore';
import type { CanvasElement } from '../types/builder';

const UI_ID = 'main_ui';

function store() {
  return useFilesStore.getState();
}

function file() {
  return store().uiFiles.get(UI_ID)!;
}

/** Open `source` as the UI file the way the app does: text plus its parsed elements. */
function open(source: string): void {
  store().updateUIFileSource(UI_ID, source);
  const parsed = parseSource(source);
  store().syncUIFileElements(UI_ID, parsed.elements, parsed.rootId);
  store().markFileDirty(UI_ID, false);
}

/** A copy of the file's elements with one text changed — a real visual edit. */
function editedElements(from: string, to: string): Map<string, CanvasElement> {
  const copy = new Map([...file().elements].map(([id, el]) => [id, { ...el, props: { ...el.props } }]));
  const target = [...copy.values()].find((el) => el.props.children === from);
  if (!target) throw new Error(`no element with text ${from}`);
  target.props.children = to;
  return copy;
}

function registry(): ComponentRegistry {
  const r = new ComponentRegistry();
  const box = (tag: string) => {
    const Box = ({ children }: { children?: React.ReactNode }) => React.createElement(tag, null, children);
    Box.displayName = `Box(${tag})`;
    return Box;
  };
  r.register('App', box('main'));
  r.register('Stack', box('div'));
  r.register('Text', box('span'));
  r.register('Badge', box('b'));
  r.register('Header', box('header'));
  return r;
}

function render(source: string, state: Record<string, unknown>): string {
  const doc = parse(source);
  const context: SoftNRenderContext = {
    state,
    setState: () => {},
    data: {},
    props: {},
    functions: {},
    asyncFunctions: {},
    computed: {},
  };
  return renderToStaticMarkup(
    React.createElement(React.Fragment, null, renderDocument(doc, context, registry()))
  );
}

const LOSSLESS_UI = `<import Header from="./components/Header.ui" />
<logic src="../logic/main.logic" />

<data>
  <collection name="tasks" as="tasks" />
</data>

<App theme="dark" title="Round trip">
  <Stack direction="vertical" gap="md">
    <Header title={(a + b) * c} />
    #if (outer)
      #if (inner)
        <Text>{items.length > 0 ? "some" : "none"}</Text>
      #end
    #end
    #each (task, i in tasks)
      #each (tag in task.tags)
        <Badge>{i}:{tag}</Badge>
      #end
    #empty
      <Text>Nothing yet</Text>
    #end
    <Text>Footer</Text>
  </Stack>
</App>

<style>
  .custom { color: rebeccapurple; }
</style>
`;

beforeEach(() => {
  store().reset();
  store().initializeProject();
});

describe('what parseSource reports', () => {
  it('calls a file with blocks, grouped expressions and every header block lossless', () => {
    expect(parseSource(LOSSLESS_UI).fidelity).toEqual({ lossless: true, reasons: [] });
  });

  it('names a comment', () => {
    const { lossless, reasons } = assessSourceFidelity(`<App>\n  // not kept\n  <Text>x</Text>\n</App>`);
    expect(lossless).toBe(false);
    expect(reasons).toEqual([expect.stringMatching(/comment on line 2/)]);
  });

  it('names an HTML comment too', () => {
    const { reasons } = assessSourceFidelity(`<App>\n  <!-- not kept -->\n  <Text>x</Text>\n</App>`);
    expect(reasons).toEqual([expect.stringMatching(/comment on line 2/)]);
  });

  it('names an expression the parser stops reading part way through', () => {
    const { lossless, reasons } = assessSourceFidelity(
      `<App>\n  <Text @click={() => count = count + 1}>x</Text>\n</App>`
    );
    expect(lossless).toBe(false);
    expect(reasons.join('\n')).toMatch(/\{\(\) => count = count \+ 1\} on line 2 is not fully supported/);
  });

  it('names text that sits between child elements', () => {
    const { lossless, reasons } = assessSourceFidelity(`<App>\n  <Text>Hi <Badge>x</Badge> there</Text>\n</App>`);
    expect(lossless).toBe(false);
    expect(reasons.join('\n')).toMatch(/text "Hi there" sits between child elements of <Text>/);
  });

  it('names a <script> block, which the regenerator does not carry', () => {
    const { reasons } = assessSourceFidelity(`<script>let a = 1</script>\n<App><Text>x</Text></App>`);
    expect(reasons).toEqual([expect.stringMatching(/<script> block/)]);
  });

  it('names a file with both a <logic src> and an inline <logic>', () => {
    const { reasons } = assessSourceFidelity(
      `<logic src="./a.logic" />\n<logic>let b = 1</logic>\n<App><Text>x</Text></App>`
    );
    expect(reasons).toEqual([expect.stringMatching(/both a <logic src> reference and an inline <logic>/)]);
  });

  it('does not count layout whitespace, attribute quoting or bare numbers as loss', () => {
    const { lossless } = assessSourceFidelity(
      `<App>\n\n  <Stack gap=md count=5 open>\n    <Text>Hello   {name}</Text>\n  </Stack>\n\n</App>\n`
    );
    expect(lossless).toBe(true);
  });
});

describe('a visual edit on a lossless file', () => {
  beforeEach(() => open(LOSSLESS_UI));

  it('is written back with the nested blocks, the #empty branch and the header intact', () => {
    store().updateUIFile(UI_ID, editedElements('Footer', 'Edited footer'), file().rootId);
    const out = file().originalSource!;
    expect(out).toContain('Edited footer');
    expect(out).toContain('<import Header from="./components/Header.ui" />');
    expect(out).toContain('<logic src="../logic/main.logic" />');
    expect(out).toContain('<collection name="tasks" as="tasks" />');
    expect(out).toContain('rebeccapurple');
    expect(out).toContain('<Header title={(a + b) * c} />');
    expect(out).toContain('#if (outer)');
    expect(out).toContain('#if (inner)');
    expect(out).toContain('#each (task, i in tasks)');
    expect(out).toContain('#each (tag in task.tags)');
    expect(out).toContain('#empty');
    expect(file().visualEditBlocked).toBeUndefined();
    expect(file().sourceFidelity).toEqual({ lossless: true, reasons: [] });
    expect(store().nodes.get(UI_ID)?.isDirty).toBe(true);
  });

  it('renders the same in the engine as the original, edit aside', () => {
    store().updateUIFile(UI_ID, editedElements('Footer', 'Edited footer'), file().rootId);
    const out = file().originalSource!;
    const states = [
      { outer: false, inner: true, items: [1], tasks: [] },
      { outer: true, inner: true, items: [1], tasks: [{ tags: ['x', 'y'] }, { tags: ['z'] }] },
      { outer: true, inner: false, items: [], tasks: [] },
    ];
    for (const state of states) {
      const expected = render(LOSSLESS_UI, { a: 2, b: 3, c: 5, ...state }).replace('Footer', 'Edited footer');
      expect(render(out, { a: 2, b: 3, c: 5, ...state })).toBe(expected);
    }
    expect(render(out, { outer: false, inner: true, items: [1], tasks: [] })).not.toContain('some');
    expect(render(out, { outer: false, inner: true, items: [1], tasks: [] })).toContain('Nothing yet');
    expect(render(out, { outer: true, inner: true, items: [1], tasks: [{ tags: ['x'] }] })).not.toContain('Nothing yet');
  });

  it('stays lossless, so a second edit is written back as well', () => {
    store().updateUIFile(UI_ID, editedElements('Footer', 'Edited footer'), file().rootId);
    store().updateUIFile(UI_ID, editedElements('Edited footer', 'Edited twice'), file().rootId);
    expect(file().originalSource).toContain('Edited twice');
    expect(file().visualEditBlocked).toBeUndefined();
  });
});

describe('a visual edit on a source-only file', () => {
  const LOSSY_UI = `// keep me\n<App>\n  #each (task in tasks)\n    <Text>{task}</Text>\n  #empty\n    <Text>Nothing yet</Text>\n  #end\n  <Text>Footer</Text>\n</App>\n`;

  beforeEach(() => open(LOSSY_UI));

  it('is refused: the source keeps its bytes and the file is not dirty', () => {
    store().updateUIFile(UI_ID, editedElements('Footer', 'Edited footer'), file().rootId);
    expect(file().originalSource).toBe(LOSSY_UI);
    expect(store().nodes.get(UI_ID)?.isDirty).toBe(false);
  });

  it('records the reason on the file for the editor to show', () => {
    store().updateUIFile(UI_ID, editedElements('Footer', 'Edited footer'), file().rootId);
    expect(file().sourceFidelity?.lossless).toBe(false);
    expect(file().visualEditBlocked).toEqual([expect.stringMatching(/comment on line 1/)]);
  });

  it('keeps the elements the source describes, not the refused ones', () => {
    store().updateUIFile(UI_ID, editedElements('Footer', 'Edited footer'), file().rootId);
    const texts = [...file().elements.values()].map((el) => el.props.children).filter(Boolean);
    expect(texts).toContain('Footer');
    expect(texts).not.toContain('Edited footer');
  });

  it('is lifted once the source no longer has the construct', () => {
    store().updateUIFile(UI_ID, editedElements('Footer', 'Edited footer'), file().rootId);
    expect(file().visualEditBlocked).toBeDefined();

    // The creator removes the comment in the source view.
    const fixed = LOSSY_UI.replace('// keep me\n', '');
    open(fixed);
    expect(file().visualEditBlocked).toBeUndefined();
    expect(file().sourceFidelity).toBeUndefined();

    store().updateUIFile(UI_ID, editedElements('Footer', 'Edited footer'), file().rootId);
    expect(file().originalSource).toContain('Edited footer');
    expect(file().originalSource).toContain('#empty');
    expect(file().visualEditBlocked).toBeUndefined();
  });
});
