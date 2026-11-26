/**
 * The elements a page's code measures (document-shell/host.ts `measure`,
 * audit round 4).
 *
 * The shell keeps a ResizeObserver on each element whose size the code asked
 * for, at most MAX_MEASURED (2,000) of them. Two things went wrong:
 *
 * - An element drawn in another's place for the same node was unobserved but
 *   kept in the list, which held the old element and counted it: after 2,000
 *   such replacements nothing on the page was measured again.
 * - Disconnecting (a container drawn anew, and React's StrictMode, which
 *   disconnects and connects once at mount) let the observer go and kept the
 *   list. The code asks once, so on the page connected next nothing was
 *   measured, and the code's ResizeObserver never heard another size.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from '../src/parser';
import { DocumentShell, SHELL_NODE_ATTRIBUTE } from '../src/document-shell/host';
import type { ElementNode } from '../src/parser/ast';

class FakeResizeObserver {
  static live = new Set<FakeResizeObserver>();
  readonly observed = new Set<Element>();
  constructor(readonly callback: (entries: Array<{ target: Element }>) => void) {
    FakeResizeObserver.live.add(this);
  }
  observe(element: Element) {
    this.observed.add(element);
  }
  unobserve(element: Element) {
    this.observed.delete(element);
  }
  disconnect() {
    this.observed.clear();
    FakeResizeObserver.live.delete(this);
  }
}

const observed = (): Element[] => [...FakeResizeObserver.live].flatMap((observer) => [...observer.observed]);

/** The one element observed, by identity (toEqual takes two like elements for one). */
function onlyObserved(): Element | undefined {
  const all = observed();
  expect(all).toHaveLength(1);
  return all[0];
}

let saved: unknown;
beforeEach(() => {
  saved = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver;
  FakeResizeObserver.live.clear();
});
afterEach(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = saved;
  document.body.innerHTML = '';
});

/** A shell for `<p>hi</p>` and the id of its `<p>`. */
function shellOfOneParagraph(): { shell: DocumentShell; id: number } {
  const doc = parse('<p>hi</p>');
  const p = doc.template.find((node): node is ElementNode => node.type === 'Element')!;
  const shell = new DocumentShell(doc.template, () => true);
  return { shell, id: shell.idOf(p)! };
}

function drawn(shell: DocumentShell, id: number, container: HTMLElement): HTMLElement {
  const element = document.createElement('p');
  element.setAttribute(SHELL_NODE_ATTRIBUTE, `${shell.key}:${id}`);
  container.append(element);
  return element;
}

function askToMeasure(shell: DocumentShell, id: number): void {
  shell.apply([['p', id, 'measure', true]] as never);
  shell.settle(id);
}

describe('an element the page’s code measures', () => {
  it('is measured however often it has been drawn again in another’s place', () => {
    const { shell, id } = shellOfOneParagraph();
    const container = document.createElement('div');
    document.body.append(container);
    shell.connect(container);
    let element = drawn(shell, id, container);
    askToMeasure(shell, id);
    expect(onlyObserved()).toBe(element);
    for (let i = 0; i < 2100; i++) {
      element.remove();
      element = drawn(shell, id, container);
      askToMeasure(shell, id);
    }
    // One element observed, the one on the page now.
    expect(onlyObserved()).toBe(element);
  });

  it('is measured again on the page the shell is connected to next, without being asked again', () => {
    const { shell, id } = shellOfOneParagraph();
    const boxes: unknown[] = [];
    shell.attach((_target, type, props) => {
      if (type === 'softn:boxes') boxes.push(props.boxes);
      return 0;
    }, () => {});
    const first = document.createElement('div');
    document.body.append(first);
    shell.connect(first);
    const once = drawn(shell, id, first);
    askToMeasure(shell, id);
    expect(onlyObserved()).toBe(once);

    // The container drawn anew (or StrictMode's disconnect and connect).
    shell.disconnect();
    first.remove();
    const second = document.createElement('div');
    document.body.append(second);
    const again = drawn(shell, id, second);
    shell.connect(second);
    expect(onlyObserved()).toBe(again);

    // And what it measures is told to the code.
    const [observer] = [...FakeResizeObserver.live];
    observer.callback([{ target: again }]);
    expect(boxes).toEqual([[[id, 0, 0, 0, 0]]]);
  });
});
