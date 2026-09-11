// @vitest-environment jsdom
/**
 * A control-flow block is a first-class node on the canvas.
 *
 * Blocks have been nodes of the visual model since BLD-03, but the canvas
 * rendered children only for registered components with `allowChildren`,
 * and the registry has no entry for `#if` or `#each`: a block drew a
 * notice ("edit the branch in Source"), its branch was neither visible nor
 * droppable, and the property panel had nothing to edit its condition
 * with. Pinned here: the canvas draws a block as a labelled container with
 * its branch children inside a drop area; the hierarchy names it by its
 * header; the property panel exposes the condition and the branch actions.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useCanvasStore } from '../../stores/canvasStore';
import { useHistoryStore } from '../../stores/historyStore';
import { parseSource } from '../../utils/sourceParser';
import { generateSource } from '../../utils/sourceGenerator';
import { CanvasElement } from './CanvasElement';
import { PropertyPanel } from '../panels/PropertyPanel';
import { TreeView } from '../panels/TreeView';

const SOURCE = `<App>
  #if (outer)
    <Text>Inside</Text>
  #else
    <Text>Otherwise</Text>
  #end
  #each (task, i in tasks) key={task.id}
    <Badge>{task.name}</Badge>
  #empty
    <Text>Nothing yet</Text>
  #end
</App>
`;

const mounted: Root[] = [];

function mount(node: React.ReactElement): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted.push(root);
  act(() => {
    root.render(node);
  });
  return host;
}

function canvas() {
  return useCanvasStore.getState();
}

function blockOf(type: string): string {
  const match = [...canvas().elements.values()].find((el) => el.componentType === type);
  if (!match) throw new Error(`no ${type} block`);
  return match.id;
}

function setValue(input: HTMLInputElement, value: string): void {
  // React listens to the native value setter, so the prototype's is used.
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  canvas().reset();
  useHistoryStore.getState().clear();
  const parsed = parseSource(SOURCE);
  canvas().loadState(new Map(parsed.elements), parsed.rootId);
});

afterEach(() => {
  act(() => {
    while (mounted.length) mounted.pop()!.unmount();
  });
});

describe('a block on the canvas', () => {
  it('shows its header and the children of its branch inside a drop area', () => {
    const host = mount(React.createElement(CanvasElement, { elementId: blockOf('#if') }));
    expect(host.querySelector('[data-block-notice]')).toBeNull();
    expect(host.querySelector('[data-block-header="if"]')?.textContent).toContain('#if');
    expect(host.querySelector('[data-block-header="if"]')?.textContent).toContain('(outer)');
    // The branch: its own drop area, holding the text element.
    const area = host.querySelector('[data-children-area="true"]');
    expect(area).not.toBeNull();
    expect(area!.textContent).toContain('Inside');
    // The #else branch is drawn inside the #if, as its own labelled container.
    expect(host.querySelector('[data-block-header="else"]')).not.toBeNull();
    expect(host.textContent).toContain('Otherwise');
    expect(host.querySelector('[role="treeitem"]')?.getAttribute('aria-label')).toBe('Select #if (outer) block');
    expect(host.querySelector('[role="treeitem"]')?.getAttribute('aria-expanded')).toBe('true');
  });

  it('shows an #each with its loop header and its #empty branch', () => {
    const host = mount(React.createElement(CanvasElement, { elementId: blockOf('#each') }));
    expect(host.querySelector('[data-block-header="each"]')?.textContent).toContain('(task, i in tasks) key={task.id}');
    expect(host.querySelector('[data-block-header="empty"]')).not.toBeNull();
    expect(host.textContent).toContain('Nothing yet');
  });

  it('is named by its header in the hierarchy', () => {
    const host = mount(React.createElement(TreeView));
    const labels = [...host.querySelectorAll('[data-tree-label="block"]')].map((el) => el.textContent);
    expect(labels).toEqual(['#if (outer)', '#else', '#each (task, i in tasks) key={task.id}', '#empty']);
  });
});

describe('the property panel for a block', () => {
  it('exposes the condition of an #if and writes an edit into the source', () => {
    const ifId = blockOf('#if');
    act(() => canvas().selectElement(ifId));
    const host = mount(React.createElement(PropertyPanel));
    const condition = host.querySelector<HTMLInputElement>('[data-block-field="condition"]');
    expect(condition?.value).toBe('outer');
    // A block has no inline directives of its own.
    expect(host.textContent).not.toContain('Event Handlers');

    setValue(condition!, 'outer && ready');
    expect(canvas().elements.get(ifId)?.block?.condition).toBe('outer && ready');
    expect(generateSource(canvas().elements, canvas().rootId, '')).toContain('#if (outer && ready)');
    expect(useHistoryStore.getState().canUndo()).toBe(true);
  });

  it('exposes the loop variables of an #each', () => {
    act(() => canvas().selectElement(blockOf('#each')));
    const host = mount(React.createElement(PropertyPanel));
    expect(host.querySelector<HTMLInputElement>('[data-block-field="itemName"]')?.value).toBe('task');
    expect(host.querySelector<HTMLInputElement>('[data-block-field="indexName"]')?.value).toBe('i');
    expect(host.querySelector<HTMLInputElement>('[data-block-field="iterable"]')?.value).toBe('tasks');
    expect(host.querySelector<HTMLInputElement>('[data-block-field="keyExpression"]')?.value).toBe('task.id');
    // It already has an #empty branch, so a second one is not offered.
    expect(host.querySelector('[data-block-action="add-empty"]')).toBeNull();
    expect(host.querySelector('[data-block-action="unwrap"]')).not.toBeNull();
  });

  it('offers only the branches the block does not have yet, and removes a branch', () => {
    const ifId = blockOf('#if');
    act(() => canvas().selectElement(ifId));
    const host = mount(React.createElement(PropertyPanel));
    expect(host.querySelector('[data-block-action="add-elseif"]')).not.toBeNull();
    expect(host.querySelector('[data-block-action="add-else"]')).toBeNull();

    act(() => canvas().selectElement(blockOf('#else')));
    const remove = host.querySelector<HTMLButtonElement>('[data-block-action="remove-branch"]');
    expect(remove).not.toBeNull();
    act(() => remove!.click());
    expect(generateSource(canvas().elements, canvas().rootId, '')).not.toContain('#else');
    expect(generateSource(canvas().elements, canvas().rootId, '')).not.toContain('Otherwise');
  });

  it('wraps a selected element in an #if from the panel, undoably', () => {
    const text = [...canvas().elements.values()].find((el) => el.props.children === 'Inside')!;
    const before = generateSource(canvas().elements, canvas().rootId, '');
    act(() => canvas().selectElement(text.id));
    const host = mount(React.createElement(PropertyPanel));
    act(() => host.querySelector<HTMLButtonElement>('[data-block-action="wrap-if"]')!.click());
    expect(generateSource(canvas().elements, canvas().rootId, '')).toContain(
      '#if (outer)\n    #if (true)\n      <Text>Inside</Text>\n    #end\n  #else'
    );
    const entry = useHistoryStore.getState().undo({ elements: canvas().elements, rootId: canvas().rootId, timestamp: Date.now() });
    act(() => canvas().loadState(entry!.elements, entry!.rootId));
    expect(generateSource(canvas().elements, canvas().rootId, '')).toBe(before);
  });
});
