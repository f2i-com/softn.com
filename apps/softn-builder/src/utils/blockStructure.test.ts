/**
 * Conditional and repetition blocks keep their structure through the
 * visual model (F03).
 *
 * The builder used to flatten every `#if` and `#each` block into inline
 * `if=` / `each=` attributes on the block's children, and only set an
 * attribute where the child had none. An inner condition therefore
 * replaced the outer one — `#if (outer) #if (inner) <Text/> #end #end`
 * came back as `<Text if={inner} />`, which renders when the outer guard is
 * false — one level of two nested loops disappeared together with its
 * variable, and the `#empty` branch of an `#each` was dropped outright.
 *
 * Blocks are now nodes of the visual model in their own right: `#if`,
 * `#elseif`, `#else`, `#each` and `#empty` elements that carry their
 * condition or loop header in `block` and hold their branch as children.
 * The generator prints them back as blocks. Each fixture here goes
 * parseSource → generateSource and is then rendered by the core engine, so
 * the assertions are about what the user would see, not about text.
 */

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { parse, renderDocument, ComponentRegistry } from '@softn/core';
import type { SoftNRenderContext } from '@softn/core';
import { parseSource } from './sourceParser';
import { generateSource } from './sourceGenerator';
import { useCanvasStore } from '../stores/canvasStore';
import { useHistoryStore } from '../stores/historyStore';
import type { CanvasElement } from '../types/builder';

function registry(): ComponentRegistry {
  const r = new ComponentRegistry();
  const box = (tag: string) => {
    const Box = ({ children }: { children?: React.ReactNode }) => React.createElement(tag, null, children);
    Box.displayName = `Box(${tag})`;
    return Box;
  };
  r.register('App', box('main'));
  r.register('Stack', box('div'));
  r.register('Box', box('section'));
  r.register('Text', box('span'));
  r.register('Badge', box('b'));
  return r;
}

function context(state: Record<string, unknown>): SoftNRenderContext {
  return {
    state,
    setState: () => {},
    data: {},
    props: {},
    functions: {},
    asyncFunctions: {},
    computed: {},
  };
}

function render(source: string, state: Record<string, unknown>): string {
  const doc = parse(source);
  expect(doc.diagnostics ?? []).toEqual([]);
  return renderToStaticMarkup(
    React.createElement(React.Fragment, null, renderDocument(doc, context(state), registry()))
  );
}

/** What the builder writes back for `source` after a parse → generate trip. */
function roundTrip(source: string): string {
  const parsed = parseSource(source);
  return generateSource(parsed.elements, parsed.rootId, '');
}

const NESTED_IF = `<App>
  #if (outer)
    #if (inner)
      <Text>inner text</Text>
    #end
  #end
</App>
`;

const NESTED_EACH = `<App>
  #each (group, gi in groups)
    #each (item, ii in group.items)
      <Badge>{gi}.{ii}:{group.name}/{item}</Badge>
    #end
  #end
</App>
`;

const EACH_EMPTY = `<App>
  #each (task in tasks)
    <Text>{task}</Text>
  #empty
    <Text>Nothing yet</Text>
  #end
</App>
`;

const ELSE_CHAIN = `<App>
  #if (n > 1)
    <Text>many</Text>
  #elseif (n == 1)
    <Text>one</Text>
  #else
    <Text>none</Text>
  #end
</App>
`;

describe('nested conditions', () => {
  it('render the same before and after the round trip: outer=false hides inner=true', () => {
    const before = render(NESTED_IF, { outer: false, inner: true });
    expect(before).not.toContain('inner text');
    const after = render(roundTrip(NESTED_IF), { outer: false, inner: true });
    expect(after).not.toContain('inner text');
  });

  it('still show the inner text when both are true', () => {
    expect(render(roundTrip(NESTED_IF), { outer: true, inner: true })).toContain('inner text');
  });

  it('keep both levels as blocks in the regenerated source', () => {
    const out = roundTrip(NESTED_IF);
    expect(out).toContain('#if (outer)');
    expect(out).toContain('#if (inner)');
    expect(out.indexOf('#if (outer)')).toBeLessThan(out.indexOf('#if (inner)'));
    expect((out.match(/#end/g) ?? []).length).toBe(2);
  });
});

describe('nested loops', () => {
  const state = {
    groups: [
      { name: 'a', items: ['x', 'y'] },
      { name: 'b', items: ['z'] },
    ],
  };

  it('keep both iteration levels and both variable scopes', () => {
    const expected = render(NESTED_EACH, state);
    expect(expected).toContain('0.0:a/x');
    expect(expected).toContain('0.1:a/y');
    expect(expected).toContain('1.0:b/z');
    expect(render(roundTrip(NESTED_EACH), state)).toBe(expected);
  });

  it('keep the loop headers with their item and index names', () => {
    const out = roundTrip(NESTED_EACH);
    expect(out).toContain('#each (group, gi in groups)');
    expect(out).toContain('#each (item, ii in group.items)');
  });
});

describe('an #empty branch', () => {
  it('survives the round trip and shows only when the list is empty', () => {
    const out = roundTrip(EACH_EMPTY);
    expect(out).toContain('#empty');
    expect(render(out, { tasks: [] })).toContain('Nothing yet');
    const filled = render(out, { tasks: ['one', 'two'] });
    expect(filled).not.toContain('Nothing yet');
    expect(filled).toContain('one');
    expect(filled).toContain('two');
  });
});

describe('an #elseif / #else chain', () => {
  it('renders every branch the same after the round trip', () => {
    const out = roundTrip(ELSE_CHAIN);
    for (const n of [0, 1, 2]) {
      expect(render(out, { n })).toBe(render(ELSE_CHAIN, { n }));
    }
  });

  it('is written back as one chain', () => {
    const out = roundTrip(ELSE_CHAIN);
    expect(out).toContain('#elseif (n == 1)');
    expect(out).toContain('#else');
    expect((out.match(/#end/g) ?? []).length).toBe(1);
  });
});

describe('inline directives', () => {
  it('keep an inline if= and each= on the same element, inside a block', () => {
    const src = `<App>
  #if (show)
    <Text each={items} as="item, i" if={item.visible}>{i}:{item.label}</Text>
  #end
</App>
`;
    const out = roundTrip(src);
    expect(out).toContain('#if (show)');
    expect(out).toContain('each={items}');
    expect(out).toContain('as="item, i"');
    expect(out).toContain('if={item.visible}');
    const state = { show: true, items: [{ label: 'a', visible: true }, { label: 'b', visible: false }] };
    expect(render(out, state)).toBe(render(src, state));
    expect(render(out, { ...state, show: false })).toBe(render(src, { ...state, show: false }));
  });
});

describe('the visual model', () => {
  it('holds a block as an element with its header and its branch as children', () => {
    const parsed = parseSource(EACH_EMPTY);
    const each = [...parsed.elements.values()].find((e) => e.componentType === '#each')!;
    expect(each).toBeDefined();
    expect(each.block).toEqual({ kind: 'each', iterable: 'tasks', itemName: 'task' });
    const [body, empty] = each.children.map((id) => parsed.elements.get(id)!);
    expect(body.componentType).toBe('Text');
    expect(empty.componentType).toBe('#empty');
    expect(empty.block).toEqual({ kind: 'empty' });
    expect(parsed.elements.get(empty.children[0])?.props.children).toBe('Nothing yet');
  });

  it('is restored, block and all, by undo of a structural edit', () => {
    const parsed = parseSource(EACH_EMPTY);
    const canvas = useCanvasStore.getState();
    canvas.reset();
    useHistoryStore.getState().clear();
    canvas.loadState(new Map(parsed.elements), parsed.rootId);

    const before = generateSource(useCanvasStore.getState().elements, parsed.rootId, '');
    const each = [...parsed.elements.values()].find((e) => e.componentType === '#each')!;

    // A structural edit: the whole loop, fallback included, is deleted.
    useHistoryStore.getState().push(useCanvasStore.getState().elements, parsed.rootId);
    useCanvasStore.getState().deleteElement(each.id);
    const deleted = generateSource(useCanvasStore.getState().elements, parsed.rootId, '');
    expect(deleted).not.toContain('#each');
    expect(deleted).not.toContain('#empty');

    const state = useCanvasStore.getState();
    const entry = useHistoryStore.getState().undo({ elements: state.elements, rootId: state.rootId, timestamp: Date.now() });
    expect(entry).toBeTruthy();
    useCanvasStore.getState().loadState(entry!.elements, entry!.rootId);

    const restored: CanvasElement | undefined = useCanvasStore.getState().elements.get(each.id);
    expect(restored?.block).toEqual({ kind: 'each', iterable: 'tasks', itemName: 'task' });
    expect(generateSource(useCanvasStore.getState().elements, parsed.rootId, '')).toBe(before);
  });
});
