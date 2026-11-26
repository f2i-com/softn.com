/**
 * An element of a page drawn from its document (document-shell/) is drawn
 * when React renders it, by ShellElement, outside the one call that draws
 * the rest of the page. It is still a drawing of the page: an expression
 * there is worth its value and changes no state, as everywhere else the page
 * is drawn. `title={n++}` on such an element wrote `n` while the element was
 * drawn, which drew it again, which wrote `n` again: the app's page never
 * finished drawing and the tab spun on it.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from '../src/parser';
import { renderDocument, ComponentRegistry } from '../src/renderer';
import type { DocumentShellView } from '../src/document-shell/host';
import type { ElementNode, TemplateNode } from '../src/parser/ast';
import type { SoftNRenderContext } from '../src/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => current.unmount());
    root = null;
  }
  container?.remove();
  container = null;
  vi.restoreAllMocks();
});

/** A document that draws every element of `source` itself, as a page's document does. */
function drawnFromItsDocument(source: string, state: Record<string, unknown>) {
  const doc = parse(source);
  const ids = new Map<TemplateNode, number>();
  let next = 2;
  const visit = (nodes: TemplateNode[]) => {
    for (const node of nodes) {
      if (node.type !== 'Element') continue;
      ids.set(node, next++);
      visit(node.children);
    }
  };
  visit(doc.template);
  const byId = new Map([...ids].map(([node, id]) => [id, node as ElementNode]));
  const shell: DocumentShellView = {
    bodyId: 1,
    idOf: (node) => ids.get(node),
    subscribe: () => () => {},
    version: () => 0,
    elementFor: (id) => byId.get(id)!,
    bodyFor: (template) => template,
    settle: () => {},
    rootAttributes: () => ({}),
  };
  const writes: Array<[string, unknown]> = [];
  const context: SoftNRenderContext = {
    state,
    setState: (path, value) => {
      writes.push([path, value]);
    },
    data: {},
    props: {},
    computed: {},
    functions: {},
    asyncFunctions: {},
    documentShell: shell,
  };
  return { doc, context, writes };
}

async function draw(doc: ReturnType<typeof parse>, context: SoftNRenderContext): Promise<HTMLElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container!);
    root.render(<>{renderDocument(doc, context, new ComponentRegistry())}</>);
  });
  return container;
}

describe('an element drawn from the page’s document', () => {
  it('writes no state while it is drawn, as any element of the page does', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { doc, context, writes } = drawnFromItsDocument('<p id="a" title={n++}>x</p>', { n: 0 });
    const page = await draw(doc, context);
    expect(writes).toEqual([]);
    // Worth its value, as `{n++}` in the body of a page is.
    expect(page.querySelector('#a')!.getAttribute('title')).toBe('0');
    // And said, once, as it is everywhere else.
    expect(errors.mock.calls.some((call) => String(call[0]).includes('changes state while the page is being drawn'))).toBe(true);
  });

  it('and one inside it, drawn by its own element, the same', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { doc, context, writes } = drawnFromItsDocument(
      '<div id="outer"><span id="inner" class:on={on = true}>y</span></div>',
      { on: false }
    );
    const page = await draw(doc, context);
    expect(writes).toEqual([]);
    expect(page.querySelector('#inner')!.className).toBe('on');
  });

  it('still lets its handlers write state when they run', async () => {
    const { doc, context, writes } = drawnFromItsDocument('<button id="b" @click={() => n++}>add</button>', { n: 4 });
    const page = await draw(doc, context);
    await act(async () => {
      page.querySelector<HTMLButtonElement>('#b')!.click();
    });
    expect(writes).toEqual([['n', 5]]);
  });
});
