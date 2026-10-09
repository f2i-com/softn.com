// @vitest-environment jsdom
/**
 * A component is offered children on the canvas only if it draws them.
 *
 * Whether an entry of Builder's registry takes children is editorial, like
 * the rest of the entry: a Text draws children, and is still better edited
 * as its words. What an entry may not do is offer a place for children to a
 * component that has none. `component-manifest.json` is generated from the
 * component sources and says, for each, whether its props name `children`
 * at all. Six entries offered a drop where the component's props name none,
 * and whatever was dropped there was in the file and never on the page.
 *
 * One of them, Tabs, also described its content as "the children under each
 * key", and was dropped with a key to start on and no tabs: nothing was
 * drawn for it in the running app.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ComponentRegistry, parse, renderDocument, type SoftNComponent, type SoftNRenderContext } from '@softn/core';
import { builtinComponents } from '../../../../packages/@softn/components/src/registry';
import { insertFromPalette } from '../components/panels/ComponentPalette';
import { useCanvasStore } from '../stores/canvasStore';
import { componentRegistry } from './componentRegistry';
import { generateSource } from './sourceGenerator';

// The scanner library needs a camera and a canvas it cannot have here.
vi.mock('@yudiel/react-qr-scanner', () => ({
  prepareZXingModule: () => {},
  Scanner: (): React.ReactElement => React.createElement('video'),
}));

type ManifestMember = { name: string };
type ManifestComponent = { name: string; props: { members: ManifestMember[] } | null };

/**
 * The manifest, found by walking up from the working directory:
 * `import.meta.url` is an http URL under jsdom, not a file one.
 */
function findManifest(): string {
  const rel = 'packages/@softn/components/component-manifest.json';
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = resolve(dir, rel);
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error(`Could not find ${rel} from ${process.cwd()}`);
}

const manifest: { components: ManifestComponent[] } = JSON.parse(readFileSync(findManifest(), 'utf8'));
const drawsChildren = new Map(
  manifest.components.map((component) => [component.name, (component.props?.members ?? []).some((member) => member.name === 'children')])
);

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

beforeEach(() => {
  useCanvasStore.getState().reset();
});

describe('the Builder registry against what each component draws', () => {
  it('offers no place for children to a component whose props name none', () => {
    const offered = componentRegistry
      .filter((meta) => meta.allowChildren && drawsChildren.get(meta.name) === false)
      .map((meta) => meta.name);
    expect(offered, 'dropped there, an element is written to the file and not drawn').toEqual([]);
  });

  it('knows every component it is asked about', () => {
    const unknown = componentRegistry.filter((meta) => !drawsChildren.has(meta.name)).map((meta) => meta.name);
    expect(unknown).toEqual([]);
  });

  it('limits what a container holds only to components the palette has', () => {
    const names = new Set(componentRegistry.map((meta) => meta.name));
    const strays = componentRegistry.flatMap((meta) => (meta.childTypes ?? []).filter((type) => !names.has(type)).map((type) => `${meta.name}: ${type}`));
    expect(strays).toEqual([]);
  });

  it('keeps as leaves the components whose content is their words', () => {
    // Each draws children, and a page may put a key or a link among the
    // words; but a new one is words, edited in the panel, not a container.
    const held = ['Text', 'Heading', 'Badge', 'Tag', 'Kbd'].filter((name) => componentRegistry.find((meta) => meta.name === name)!.allowChildren);
    expect(held).toEqual([]);
  });
});

describe('a Tabs taken from the palette', () => {
  it('starts with tabs to show, and on the first of them', () => {
    insertFromPalette('Tabs');
    const canvas = useCanvasStore.getState();
    const source = generateSource(canvas.elements, canvas.rootId, '');
    const html = rendered(source);
    expect(html.match(/role="tab"/g)).toHaveLength(2);
    expect(html).toContain('First');
    expect(html).toContain('aria-selected="true"');
  });

  it('says where its content goes', () => {
    const tabs = componentRegistry.find((meta) => meta.name === 'Tabs')!;
    const described = tabs.propSchema.find((prop) => prop.name === 'tabs')!.description ?? '';
    expect(described).not.toContain('children');
  });
});
