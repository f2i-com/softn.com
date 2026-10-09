/**
 * createBundleFromDirectory, which for a long time only threw.
 *
 * It is in the package's public types and its message said it needed Node or
 * Tauri — which it also said when called from Node, so it was a dead end rather
 * than a direction. The bundler CLI's help offers the directory it could not
 * read as the worked example: `bundle ./demo-bundle ./demo.softn`.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { existsSync, readFileSync, unlinkSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  classifyAsset,
  composeBundleSource,
  createBundleFromDirectory,
  extractPermissions,
  parseXDBFile,
  readBundle,
  readBundleEntries,
} from '../src/bundle';
import { parse } from '../src/parser';
import type { SoftNDocument, TemplateNode } from '../src/parser';
import { renderDocument, ComponentRegistry } from '../src/renderer';
import { builtinHelpers } from '../src/runtime/helpers';
import type { SoftNRenderContext, SoftNProps } from '../src/types';

/** The project narrows the ambient Buffer type, so compare the bytes directly. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

describe('createBundleFromDirectory', () => {
  it('bundles the demo directory the CLI help points at', async () => {
    const bytes = await createBundleFromDirectory({ sourceDir: 'demo-bundle', outputPath: '' });
    expect(bytes.byteLength).toBeGreaterThan(1000);
    const bundle = await readBundle(bytes);
    expect(bundle.manifest.name).toBe('Todo App Demo');
  });

  it('copies every file through byte for byte', async () => {
    // The archive is checked against its sources, so a round trip through a
    // string — which would decide line endings on the reader's behalf — is not
    // good enough. Nested directories included.
    const bytes = await createBundleFromDirectory({ sourceDir: 'demo-bundle', outputPath: '' });
    const entries = await readBundleEntries(bytes);
    const names = [...entries.keys()].filter((n) => n !== 'manifest.json');
    expect(names).toContain('components/todo-item.ui');
    expect(names).toContain('assets/icon.svg');
    for (const name of names) {
      const onDisk = new Uint8Array(readFileSync(join('demo-bundle', name)));
      expect(sameBytes(entries.get(name)!, onDisk), `${name} differs from its source`).toBe(true);
    }
  });

  it('writes to outputPath when one is given', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'softn-bundle-')), 'demo.softn');
    const bytes = await createBundleFromDirectory({ sourceDir: 'demo-bundle', outputPath: out });
    expect(existsSync(out)).toBe(true);
    expect(sameBytes(new Uint8Array(readFileSync(out)), bytes)).toBe(true);
    unlinkSync(out);
  });

  it('honours exclude', async () => {
    const bytes = await createBundleFromDirectory({
      sourceDir: 'demo-bundle',
      outputPath: '',
      exclude: ['utils.logic'],
    });
    const entries = await readBundleEntries(bytes);
    expect([...entries.keys()]).not.toContain('utils.logic');
    expect([...entries.keys()]).toContain('app.logic');
  });

  it('does not pack manifest.json twice', async () => {
    // createBundleFromFiles writes the manifest from the parsed object, so the
    // file on disk must not be added alongside it.
    const bytes = await createBundleFromDirectory({ sourceDir: 'demo-bundle', outputPath: '' });
    const entries = await readBundleEntries(bytes);
    expect([...entries.keys()].filter((n) => n === 'manifest.json')).toHaveLength(1);
  });

  it('says which thing is missing', async () => {
    await expect(
      createBundleFromDirectory({ sourceDir: 'no-such-directory-here', outputPath: '' })
    ).rejects.toThrow(/Source directory not found/);

    const empty = mkdtempSync(join(tmpdir(), 'softn-empty-'));
    mkdirSync(join(empty, 'sub'), { recursive: true });
    writeFileSync(join(empty, 'sub', 'a.logic'), 'let a = 1\n');
    await expect(createBundleFromDirectory({ sourceDir: empty, outputPath: '' })).rejects.toThrow(
      /manifest\.json not found/
    );
  });
});

describe('the worked example', () => {
  // The directory the CLI's help offers is what a newcomer opens to see how a
  // bundle is put together, so it has to be an app that runs. For a long time
  // it was written for a language SoftN is not. It passed attributes and
  // events to the pages it imported and had them answer with `$emit`; it kept
  // each row's state in the row's own file, where there is one scope for
  // every row; it wrote its imports the one way the composer did not read;
  // and it shipped its seed records in a shape no reader reads. All of it
  // parsed, so nothing said so. These hold it to what a loader does with it:
  // compose, parse, draw.

  /** The bundle as a loader has it: its text files and its manifest. */
  async function example() {
    const bytes = await createBundleFromDirectory({ sourceDir: 'demo-bundle', outputPath: '' });
    const text = new Map<string, string>();
    for (const [name, data] of await readBundleEntries(bytes)) {
      if (!classifyAsset(name).binary) text.set(name, new TextDecoder().decode(data));
    }
    const manifest = JSON.parse(text.get('manifest.json')!);
    return { text, manifest };
  }

  /** Composed as the runtime composes it, with whatever the composer said on the way. */
  async function composed() {
    const { text, manifest } = await example();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = composeBundleSource(text, manifest.main, manifest.files.logic);
      return { ...result, warnings: warn.mock.calls.map((call) => call.map(String).join(' ')) };
    } finally {
      warn.mockRestore();
    }
  }

  /** Every element's tag in a parsed template, blocks included. */
  function tagsIn(nodes: TemplateNode[]): string[] {
    const tags: string[] = [];
    const visit = (list: TemplateNode[] | undefined): void => {
      for (const node of list ?? []) {
        if (node.type === 'Element') {
          tags.push(node.tag);
          visit(node.children);
        } else if (node.type === 'IfBlock') {
          visit(node.consequent);
          if (Array.isArray(node.alternate)) visit(node.alternate);
          else if (node.alternate) visit([node.alternate]);
        } else if (node.type === 'EachBlock') {
          visit(node.body);
          visit(node.emptyFallback);
        }
      }
    };
    visit(nodes);
    return tags;
  }

  /** The names a template calls as functions: `count(todos)`, `() => addTodo()`. */
  function calledIn(doc: SoftNDocument): string[] {
    const names = new Set<string>();
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
        return;
      }
      if (!value || typeof value !== 'object') return;
      const node = value as { type?: string; callee?: { type?: string; name?: string } };
      if (node.type === 'CallExpression' && node.callee?.type === 'Identifier' && node.callee.name) {
        names.add(node.callee.name);
      }
      for (const [key, child] of Object.entries(value)) if (key !== 'loc') visit(child);
    };
    visit(doc.template);
    return [...names].sort();
  }

  const todo = (id: string, text: string, completed: boolean) => ({
    id,
    data: { text, completed, createdAt: '2024-01-01T00:00:00.000Z' },
  });

  /** Draw the composed page over the state its logic declares, with stand-ins for the five components it uses. */
  function draw(doc: SoftNDocument, overrides: Record<string, unknown> = {}): string {
    const registry = new ComponentRegistry();
    const wrapper = (tag: string) =>
      function Wrapper(props: SoftNProps) {
        return React.createElement(tag, { className: props.className as string | undefined }, props.children as React.ReactNode);
      };
    registry.register('App', wrapper('section'));
    registry.register('Button', wrapper('button'));
    registry.register('Icon', (props: SoftNProps) => React.createElement('i', null, String(props.name)));
    registry.register('Input', (props: SoftNProps) =>
      React.createElement('input', { value: String(props.value ?? ''), readOnly: true })
    );
    registry.register('Checkbox', (props: SoftNProps) =>
      React.createElement('input', { type: 'checkbox', checked: props.checked === true, readOnly: true })
    );

    const todos = [todo('a', 'Write the example', true), todo('b', 'Run it', false)];
    const context: SoftNRenderContext = {
      state: { title: 'My Todos', todos, newTodoText: '', filter: 'all', editingId: '', editText: '', ...overrides },
      setState: () => {},
      data: {},
      props: {},
      functions: {
        ...(builtinHelpers as unknown as SoftNRenderContext['functions']),
        formatRelativeTime: () => 'just now',
      },
      asyncFunctions: {},
      computed: {
        activeTodos: () => todos.filter((t) => !t.data.completed),
        completedTodos: () => todos.filter((t) => t.data.completed),
        filteredTodos: () => todos,
      },
    };
    return renderToStaticMarkup(renderDocument(doc, context, registry) as React.ReactElement);
  }

  it('composes without a word from the composer', async () => {
    // A warning here would be the composer saying an import was not found,
    // or that something written on an imported page's tag was ignored.
    const { source, warnings } = await composed();
    expect(warnings).toEqual([]);
    expect(source).not.toMatch(/<import\b/);
  });

  it('parses with no diagnostics, as one document', async () => {
    const { source } = await composed();
    const doc = parse(source);
    expect(doc.diagnostics ?? []).toEqual([]);
    expect(doc.imports).toEqual([]);
    // One logic block holding both files, the helpers first, and the one
    // style block the main page declares.
    expect(doc.logic?.code.indexOf('function formatRelativeTime')).toBeGreaterThan(-1);
    expect(doc.logic?.code.indexOf('function addTodo')).toBeGreaterThan(
      doc.logic?.code.indexOf('function formatRelativeTime') ?? -1
    );
    expect(doc.style?.content).toContain('.todo-item');
  });

  it('has every imported page in place, and no tag the runtime does not know', async () => {
    const { source } = await composed();
    const tags = [...new Set(tagsIn(parse(source).template))];
    // What is left of an import that was not placed is a tag by its name. A
    // `Header` or a `Footer` would even be drawn — the component library has
    // both — which is how the example showed a header for years without ever
    // reading its own header.ui.
    expect(tags).not.toContain('TodoItem');
    expect(tags).not.toContain('Header');
    expect(tags).not.toContain('Footer');
    // A declaration that ended up inside the markup is an element the
    // renderer refuses to draw.
    for (const declaration of ['import', 'logic', 'data', 'style']) expect(tags).not.toContain(declaration);
    // Capitalised tags are components, and these five are in the library.
    expect(tags.filter((tag) => /^[A-Z]/.test(tag)).sort()).toEqual(['App', 'Button', 'Checkbox', 'Icon', 'Input']);
    // The pages themselves, by the element each is.
    expect(tags).toEqual(expect.arrayContaining(['header', 'footer', 'form', 'main']));
  });

  it('calls only functions its logic defines, or the helpers every page has', async () => {
    // `$emit("toggle")` parsed, and did nothing: no such function exists. A
    // name a page calls is one of the app's own functions or a built-in
    // helper, and nothing else.
    const { source } = await composed();
    const doc = parse(source);
    const defined = new Set([
      ...[...(doc.logic?.code ?? '').matchAll(/^function\s+(\w+)\s*\(/gm)].map((match) => match[1]),
      ...Object.keys(builtinHelpers),
    ]);
    const called = calledIn(doc);
    expect(called.filter((name) => !defined.has(name))).toEqual([]);
    // Each thing the app does is a function the pages call directly.
    expect(called).toEqual(
      expect.arrayContaining(['addTodo', 'toggleTodo', 'startEdit', 'saveEdit', 'cancelEdit', 'deleteTodo', 'setFilter', 'clearCompleted'])
    );
  });

  it('draws its header, a row for each todo, and its footer', async () => {
    const { source } = await composed();
    const html = draw(parse(source));
    expect(html).not.toContain('Unknown component');
    // components/header.ui, reading the page's title and count.
    expect(html).toContain('<h1 class="title">My Todos</h1>');
    expect(html).toContain('1 to do');
    // components/todo-item.ui, once for each todo, reading the loop's `todo`.
    expect(html.match(/class="todo-item/g)).toHaveLength(2);
    expect(html.match(/class="todo-item completed"/g)).toHaveLength(1);
    expect(html).toContain('Write the example');
    expect(html).toContain('Run it');
    expect(html.match(/class="view-mode"/g)).toHaveLength(2);
    // components/footer.ui, counting for itself.
    expect(html).toContain('2 items total');
    expect(html).toContain('1 completed');
    expect(html).toContain('Clear completed');
  });

  it('opens one row for editing, by the page’s state', async () => {
    // The row has no state of its own: which one is open is `editingId`, in
    // the page's logic. A flag kept in the row's file would be one flag for
    // every row.
    const { source } = await composed();
    const html = draw(parse(source), { editingId: 'b', editText: 'Run it' });
    expect(html.match(/class="edit-mode"/g)).toHaveLength(1);
    expect(html.match(/class="view-mode"/g)).toHaveLength(1);
    expect(html).toContain('value="Run it"');
  });

  it('ships seed records in the form the runtime reads', async () => {
    // `{ "schema": …, "data": { "todos": […] } }` is read as a collection
    // with no records, without a warning: the app opened empty.
    const { text, manifest } = await example();
    expect(manifest.files.xdb).toEqual(['todos.xdb']);
    const seeds = parseXDBFile('todos.xdb', text.get('todos.xdb')!);
    expect(seeds.warning).toBeUndefined();
    expect(seeds.collection).toBe('todos');
    expect(seeds.records).toHaveLength(4);
    for (const record of seeds.records) {
      expect(Object.keys(record.data).sort()).toEqual(['completed', 'createdAt', 'text']);
    }
  });

  it('asks its host for nothing', async () => {
    // A to-do list kept on the device needs no capability. The manifest used
    // to carry a `permissions` block asking for the network, so opening the
    // example began with a prompt to let it use the internet.
    const { text, manifest } = await example();
    expect(extractPermissions(text, manifest)).toBeNull();
  });

  it('lists the files it carries, and carries the files it lists', async () => {
    const { text, manifest } = await example();
    const listed = [...manifest.files.ui, ...manifest.files.logic, ...manifest.files.xdb];
    const carried = [...text.keys()].filter((name) => name !== 'manifest.json');
    expect([...listed].sort()).toEqual([...carried].sort());
    const bytes = await createBundleFromDirectory({ sourceDir: 'demo-bundle', outputPath: '' });
    const entries = [...(await readBundleEntries(bytes)).keys()];
    for (const asset of manifest.files.assets) expect(entries).toContain(asset);
    expect(entries.filter((name) => classifyAsset(name).binary).sort()).toEqual([...manifest.files.assets].sort());
  });
});
