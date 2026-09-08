/**
 * A parsed document is never written to after the parser returns it.
 *
 * parseCached hands one document to every stage that asks for the same
 * source — SoftNWithXDB's data-block scan and the SoftNRenderer under it —
 * and keeps it for the next mount. That is only sound if nothing on the way
 * to the screen writes into the tree: a renderer that annotated a node, a
 * runtime that trimmed a script block, a data hook that sorted a collection
 * list in place would be editing every other holder's copy.
 *
 * So: parse a document with every kind of block, freeze every object in it,
 * put that frozen instance in the cache, and run the real thing over it —
 * mount, change state from a click, re-render the conditional and the loop,
 * remount under StrictMode, mount through SoftNWithXDB. Module code runs in
 * strict mode, so a write into a frozen object throws a TypeError rather than
 * failing silently: the render must finish, the click must land, and no such
 * error may reach the console.
 */

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearParseCache, parseCached } from '../src/parser';
import type { SoftNDocument } from '../src/parser';
import { SoftNRenderer, SoftNWithXDB } from '../src/loader/SoftNRenderer';
import { registerComponent, type SoftNComponent } from '../src/renderer/registry';
import type { SoftNProps } from '../src/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// A host component, so the component path (props evaluated, children handed
// down) runs over the frozen nodes too.
function FreezeProbe({ label, children }: SoftNProps): React.ReactElement {
  return <div className={`probe-${String(label)}`}>{children as React.ReactNode}</div>;
}
registerComponent('FreezeProbe', FreezeProbe as SoftNComponent);

const SOURCE = `<component name="Frozen">
  <prop name="title" type="string" />
</component>

<data>
  <collection name="notes" as="notes" />
</data>

<logic>
let count = 0
let items = ["a", "b", "c"]
function bump() { count = count + 1 }
</logic>

<div class="app">
  <FreezeProbe label="p">
    <span class="count">{count}</span>
  </FreezeProbe>
  <button class="bump" @click={bump()}>+</button>
  #if (count > 0)
    <span class="pos">positive</span>
  #else
    <span class="zero">zero</span>
  #end
  #each (item, i in items)
    <span class="item" data-i={i}>{item}</span>
  #empty
    <span class="none">none</span>
  #end
</div>`;

/** Freeze every object reachable from `value`; returns how many were frozen. */
function deepFreeze(value: unknown, seen = new Set<object>()): number {
  if (typeof value !== 'object' || value === null || seen.has(value)) return 0;
  seen.add(value);
  Object.freeze(value);
  let frozen = 1;
  for (const key of Object.getOwnPropertyNames(value)) {
    frozen += deepFreeze((value as Record<string, unknown>)[key], seen);
  }
  return frozen;
}

/** The messages a strict-mode write into a frozen object produces. */
const FROZEN_WRITE =
  /read.only|not extensible|Cannot (add|assign|delete|define|redefine)|TypeError/i;

let container: HTMLElement;
let root: Root;
let consoleErrors: string[];
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  clearParseCache();
  localStorage.clear();
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  consoleErrors = [];
  errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    consoleErrors.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '));
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  errorSpy.mockRestore();
});

async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function waitFor(check: () => boolean, tries = 150): Promise<void> {
  for (let i = 0; i < tries && !check(); i++) await settle(20);
  expect(check()).toBe(true);
}

/** Parse, freeze the instance the cache holds, and prove it is the one shared. */
function frozenDocument(): SoftNDocument {
  const doc = parseCached(SOURCE);
  // A syntax slip in SOURCE would still parse (the parser recovers) but would
  // not be the document this test means to exercise.
  expect(doc.diagnostics ?? []).toEqual([]);
  expect(doc.component?.name).toBe('Frozen');
  expect(doc.data?.collections.map((c) => c.name)).toEqual(['notes']);
  expect(doc.logic?.code).toContain('function bump');
  const frozen = deepFreeze(doc);
  expect(frozen).toBeGreaterThan(40);
  expect(Object.isFrozen(doc.template)).toBe(true);
  expect(parseCached(SOURCE)).toBe(doc);
  return doc;
}

async function mountAndExercise(tree: React.ReactElement): Promise<void> {
  await act(async () => {
    root.render(tree);
  });
  await waitFor(() => container.querySelector('.count')?.textContent === '0');
  expect(container.querySelector('.probe-p')).not.toBeNull();
  expect(container.querySelector('.zero')).not.toBeNull();
  expect(container.querySelector('.pos')).toBeNull();
  expect(Array.from(container.querySelectorAll('.item')).map((el) => el.textContent)).toEqual([
    'a',
    'b',
    'c',
  ]);

  act(() => {
    (container.querySelector('.bump') as HTMLButtonElement).click();
  });
  await waitFor(() => container.querySelector('.count')?.textContent === '1');
  expect(container.querySelector('.pos')).not.toBeNull();
  expect(container.querySelector('.zero')).toBeNull();
}

function expectNoFrozenWrite(): void {
  const offending = consoleErrors.filter((message) => FROZEN_WRITE.test(message));
  expect(offending).toEqual([]);
}

describe('a deep-frozen document', () => {
  it('renders and re-renders through SoftNRenderer', async () => {
    const doc = frozenDocument();
    await mountAndExercise(<SoftNRenderer source={SOURCE} appId="frozen-plain" />);
    expectNoFrozenWrite();
    expect(Object.isFrozen(doc.template)).toBe(true);
  });

  it('renders and re-renders under StrictMode', async () => {
    frozenDocument();
    await mountAndExercise(
      <React.StrictMode>
        <SoftNRenderer source={SOURCE} appId="frozen-strict" />
      </React.StrictMode>
    );
    expectNoFrozenWrite();
  });

  it('renders through SoftNWithXDB, whose data block reads the same instance', async () => {
    frozenDocument();
    await mountAndExercise(
      <React.StrictMode>
        <SoftNWithXDB source={SOURCE} appId="frozen-xdb" />
      </React.StrictMode>
    );
    expectNoFrozenWrite();
  });

  it('survives a source change and a change back', async () => {
    // Hot reload: the source is replaced, then the original text comes back
    // and the cache hands out the frozen instance a second time, to a VM
    // that is rebuilt around it. State carries across a reload, so the count
    // is read rather than assumed.
    const doc = frozenDocument();
    await mountAndExercise(<SoftNRenderer source={SOURCE} appId="frozen-reload" />);
    const reloaded = (): boolean =>
      /^\d+$/.test(container.querySelector('.count')?.textContent ?? '') &&
      container.querySelectorAll('.item').length === 3;

    await act(async () => {
      root.render(<SoftNRenderer source={`${SOURCE}\n`} appId="frozen-reload" />);
    });
    await waitFor(reloaded);
    await act(async () => {
      root.render(<SoftNRenderer source={SOURCE} appId="frozen-reload" />);
    });
    await waitFor(reloaded);
    expect(parseCached(SOURCE)).toBe(doc);

    const before = Number(container.querySelector('.count')?.textContent);
    act(() => {
      (container.querySelector('.bump') as HTMLButtonElement).click();
    });
    await waitFor(() => Number(container.querySelector('.count')?.textContent) === before + 1);
    expect(container.querySelector('.pos')).not.toBeNull();
    expectNoFrozenWrite();
  });
});
