// @vitest-environment jsdom
/**
 * The components' accessibility props (component-manifest.json) are offered
 * in the property panel, together, under Accessibility — and what is typed
 * there is written to the source.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseSource } from '../../utils/sourceParser';
import { generateSource } from '../../utils/sourceGenerator';
import { componentRegistry } from '../../utils/componentRegistry';
import { useCanvasStore } from '../../stores/canvasStore';
import { useFilesStore } from '../../stores/filesStore';
import { PropertyPanel } from './PropertyPanel';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let root: Root | undefined;
let host: HTMLDivElement;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  useCanvasStore.getState().reset();
  useFilesStore.getState().reset();
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
});

function select(source: string, type: string): void {
  const parsed = parseSource(source);
  const element = [...parsed.elements.values()].find((el) => el.componentType === type)!;
  useCanvasStore.getState().loadState(parsed.elements, parsed.rootId);
  useCanvasStore.getState().selectElement(element.id);
  root = createRoot(host);
  act(() => root!.render(React.createElement(PropertyPanel)));
}

const labelsIn = (group: Element | null) => [...(group?.querySelectorAll('label') ?? [])].map((label) => label.textContent);

describe('accessibility props in the property panel', () => {
  it('offers what the components now take', () => {
    const offered = (name: string) => componentRegistry.find((c) => c.name === name)!.propSchema.map((p) => p.name);
    for (const name of ['BarChart', 'Modal', 'Icon', 'Slider', 'Tabs', 'Table']) expect(offered(name), name).toContain('ariaLabel');
    expect(offered('Table')).toContain('caption');
    expect(offered('Tag')).toContain('removeLabel');
    expect(offered('Section')).toContain('headingLevel');
    expect(offered('Alert')).toContain('role');
    const viewMode = componentRegistry.find((c) => c.name === 'MarkdownEditor')!.propSchema.find((p) => p.name === 'onViewModeChange');
    expect(viewMode?.type).toBe('event');
  });

  it('groups them under Accessibility and writes them to the source', () => {
    select('<App><Table /></App>', 'Table');
    const group = host.querySelector('[data-prop-group="accessibility"]');
    expect(group?.querySelector('button')?.textContent).toContain('Accessibility');
    expect(labelsIn(group)).toEqual(expect.arrayContaining(['caption', 'ariaLabel']));

    const input = group!.querySelector<HTMLInputElement>(`input[id$="-ariaLabel"]`)!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Monthly totals');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const { elements, rootId } = useCanvasStore.getState();
    expect(generateSource(elements, rootId, '')).toContain('ariaLabel="Monthly totals"');
  });
});
