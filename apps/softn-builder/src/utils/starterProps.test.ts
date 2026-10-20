// @vitest-environment jsdom
/**
 * A component taken from the palette is the component its registry entry
 * describes, in the source and in the app that runs, not only on the canvas.
 *
 * Each entry's `defaultProps` were read by nothing: a dropped Button was
 * drawn on the canvas with a placeholder label and written to the source as
 * `<Button />`. They are applied at the drop now. This takes every entry
 * down the whole path a drop goes: the store, Builder's generator, the
 * engine's parser, the real components, and Builder's own parser back again,
 * which has to give the same element (or a file would change by being
 * reopened).
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ComponentRegistry, parse, renderDocument, type SoftNComponent, type SoftNRenderContext } from '@softn/core';
import { builtinComponents } from '../../../../packages/@softn/components/src/registry';
import { insertFromPalette } from '../components/panels/ComponentPalette';
import { useCanvasStore } from '../stores/canvasStore';
import type { CanvasElement } from '../types/builder';
import { componentRegistry } from './componentRegistry';
import { applyStarterTemplate } from './newProject';
import { generateSource } from './sourceGenerator';
import { parseSource } from './sourceParser';
import { starterProps } from './starterProps';

// The scanner library needs a camera and a canvas it cannot have here.
vi.mock('@yudiel/react-qr-scanner', () => ({
  prepareZXingModule: () => {},
  Scanner: (): React.ReactElement => React.createElement('video'),
}));

const registry = new ComponentRegistry();
registry.registerAll(builtinComponents as unknown as Record<string, SoftNComponent>);

function rendered(source: string): string {
  const doc = parse(source);
  expect(doc.diagnostics ?? [], source).toEqual([]);
  const context: SoftNRenderContext = {
    state: {}, setState: () => {}, data: {}, props: {},
    functions: {}, asyncFunctions: {}, computed: {},
  };
  const quiet = [vi.spyOn(console, 'error').mockImplementation(() => {}), vi.spyOn(console, 'warn').mockImplementation(() => {})];
  try {
    return renderToStaticMarkup(React.createElement(React.Fragment, null, renderDocument(doc, context, registry)));
  } finally {
    for (const spy of quiet) spy.mockRestore();
  }
}

function sourceOfCanvas(): string {
  const canvas = useCanvasStore.getState();
  return generateSource(canvas.elements, canvas.rootId, '');
}

/** The element the palette put on the canvas. It says null for what it does not insert (the page itself). */
function dropped(id: string | null): CanvasElement {
  if (id === null) throw new Error('the palette inserted nothing');
  return useCanvasStore.getState().elements.get(id)!;
}

/** The same element as Builder's parser reads it back out of the source. */
function reopened(source: string): CanvasElement {
  const parsed = parseSource(source);
  const root = parsed.elements.get(parsed.rootId)!;
  return parsed.elements.get(root.children[0])!;
}

beforeEach(() => {
  useCanvasStore.getState().reset();
});

// App is the page itself; it is the root and is not dropped into one.
const entries = componentRegistry.filter((meta) => meta.name !== 'App').map((meta) => meta.name);

describe.each(entries)('a %s taken from the palette', (name) => {
  it('is written, read back and drawn as its registry entry describes', () => {
    const canvas = useCanvasStore.getState();
    const id = canvas.addElement(name, canvas.rootId, undefined, { starter: true });
    const element = dropped(id);
    const meta = componentRegistry.find((entry) => entry.name === name)!;

    // Everything the entry gives a new one is on the element...
    for (const [prop, value] of Object.entries(meta.defaultProps)) {
      if (value === '' || value === null || value === undefined) continue;
      expect(element.props, `${prop} of ${name}`).toHaveProperty(prop);
    }

    // ...and in the source, which the engine reads without complaint...
    const source = sourceOfCanvas();
    expect(source).toContain(`<${name}`);
    const markup = rendered(source);
    // ...and which the real component draws, where it used to be drawn bare.
    expect(markup).not.toContain('--softn-error-bg');
    if (typeof meta.defaultProps.children === 'string') {
      expect(source).toContain(`>${meta.defaultProps.children}</${name}>`);
      // What an overlay holds is drawn when it is opened, not before.
      if (!['Modal', 'Drawer', 'Toast', 'Popover', 'Tooltip'].includes(name)) expect(markup).toContain(meta.defaultProps.children);
    }

    // Reopening the file gives the element that was dropped.
    const again = reopened(source);
    expect(again.componentType).toBe(name);
    expect(again.props).toEqual(element.props);
    expect([...(again.expressionProps ?? [])].sort()).toEqual([...(element.expressionProps ?? [])].sort());
    // And writing it out again changes nothing.
    const parsed = parseSource(source);
    expect(generateSource(parsed.elements, parsed.rootId, '')).toBe(source);
  });
});

describe('what a drop writes', () => {
  it('a Button has its label and a Steps its steps', () => {
    insertFromPalette('Button');
    insertFromPalette('Steps');
    insertFromPalette('SortableList');
    const source = sourceOfCanvas();
    expect(source).toContain('<Button variant="primary" size="md">Click me</Button>');
    expect(source).toContain('<Steps items={["Details", "Review", "Done"]} current={1} />');
    // A list typed as an expression is written as one, not as the text "[]".
    expect(source).toContain('<SortableList items={[]} renderKey="id" />');
    expect(rendered(source)).toContain('Click me');
  });

  it('a Radio, a Select and an Avatar start with something to show', () => {
    // Each was dropped with nothing a person could see in the running app:
    // a radio group with no options draws nothing at all, a select opens on
    // an empty list, and an avatar with no name is a question mark.
    insertFromPalette('Radio');
    insertFromPalette('Select');
    insertFromPalette('Avatar');
    const html = rendered(sourceOfCanvas());
    expect(html.match(/type="radio"/g)).toHaveLength(3);
    expect(html).toContain('Option one');
    expect(html).toContain('>AL<');
    expect(sourceOfCanvas()).toContain('<Select placeholder="Select an option..." options={[{ value: "one", label: "Option one" }');
  });

  it('a Breadcrumb and a Table start with something to show', () => {
    // A Breadcrumb with no items draws nothing at all, on the canvas or in
    // the app, and a Table with neither columns nor rows is the words "No
    // data available" under no header.
    insertFromPalette('Breadcrumb');
    insertFromPalette('Table');
    const source = sourceOfCanvas();
    expect(source).toContain('<Breadcrumb items={[{ label: "Home" }, { label: "Projects" }, { label: "This page" }]} />');
    expect(source).toContain('<Table columns={[{ key: "name", header: "Name" }, { key: "role", header: "Role" }]} data={[{ name: "Ada Lovelace", role: "Engineer" }, { name: "Grace Hopper", role: "Admiral" }]} rowKey="name" />');
    const html = rendered(source);
    for (const shown of ['Home', 'Projects', 'This page', 'Name', 'Role', 'Ada Lovelace', 'Admiral']) expect(html, shown).toContain(shown);
    expect(html).not.toContain('No data available');
  });

  it('selects what was inserted, as before', () => {
    const id = insertFromPalette('Text');
    expect(useCanvasStore.getState().selectedIds).toEqual([id]);
    expect(dropped(id).props.children).toBe('Hello World');
  });

  it('gives two of a kind a value each', () => {
    const first = dropped(insertFromPalette('Steps'));
    const second = dropped(insertFromPalette('Steps'));
    expect(second.props).toEqual(first.props);
    expect(second.props).not.toBe(first.props);
    expect(second.expressionProps).not.toBe(first.expressionProps);
    // Changing one does not change the other, or the registry entry.
    useCanvasStore.getState().updateElementProps(first.id, { current: '2' });
    expect(dropped(second.id).props.current).toBe('1');
    expect(starterProps('Steps').props.current).toBe('1');
  });

  it('keeps a false it was given, which leaving out would turn into the component’s own default', () => {
    const loop = dropped(insertFromPalette('Loop'));
    expect(loop.props.running).toBe('false');
    expect(sourceOfCanvas()).toContain('running={false}');
  });
});

describe('what is not a drop', () => {
  it('an element added without asking for a starter has no props: a template sets its own', () => {
    const canvas = useCanvasStore.getState();
    const id = canvas.addElement('Button', canvas.rootId);
    expect(dropped(id).props).toEqual({});
    expect(dropped(id).expressionProps).toEqual([]);
  });

  it('the project templates are what they were', () => {
    applyStarterTemplate('landing');
    const source = sourceOfCanvas();
    expect(source).toContain('<Stack direction="vertical" gap="lg" align="center" padding="xl">');
    expect(source).toContain('<Button variant="primary">Get Started</Button>');
    expect(source).not.toContain('size="md"');
  });

  it('a type with no registry entry starts with nothing', () => {
    expect(starterProps('div')).toEqual({ props: {}, expressionProps: [] });
    expect(starterProps('NoSuchComponent')).toEqual({ props: {}, expressionProps: [] });
  });
});

describe('the registry entries themselves', () => {
  it('give no component one of Builder’s own theme tokens: an app does not define them', () => {
    const leaked = componentRegistry.filter((meta) => JSON.stringify(meta.defaultProps).includes('var(--')).map((meta) => meta.name);
    expect(leaked).toEqual([]);
    expect(starterProps('ColorPicker').props.defaultValue).toMatch(/^#[0-9a-f]{6}$/i);
  });
});
