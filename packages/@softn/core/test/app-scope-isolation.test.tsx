/**
 * Two apps mounted at once keep their records apart, across an await.
 *
 * softn-web keeps every open tab mounted and toggles them with `display`. A
 * component below the renderer used to find its store through a module-level
 * pointer that SoftNRenderer set during render — so it named whichever app had
 * rendered most recently, not the app the component was in. A handler in tab
 * A that yielded before it saved (SmartForm's submit awaited an import first)
 * resumed after any re-render of tab B and wrote A's record into B's store.
 *
 * The store now comes from context, read at render and captured by the
 * handler. These tests drive exactly that sequence: trigger A, re-render B
 * while A is suspended, let A resume, and look at where the record went.
 */

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SoftNWithXDB } from '../src/loader/SoftNRenderer';
import { useAppXDB } from '../src/loader/app-scope';
import { registerComponent, type SoftNComponent } from '../src/renderer/registry';
import { getXDB } from '../src/runtime/xdb';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The shape of every handler that saves after it yields — a form submit, a
// confirm dialog, a fetch: the store is read at render, the write lands a
// task later.
function ScopeProbe({ label }: { label?: unknown }): React.ReactElement {
  const xdb = useAppXDB();
  const write = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    xdb.create('items', { from: String(label) });
  };
  return (
    <button className={`probe-${String(label)}`} onClick={() => void write()}>
      write
    </button>
  );
}
registerComponent('ScopeProbe', ScopeProbe as SoftNComponent);

const SOURCE_A = `<div><ScopeProbe label="a" /></div>`;
const SOURCE_B = `<div><span class="title">{title}</span><ScopeProbe label="b" /></div>`;

// Both apps in one root, the way the tab strip holds them. B's title is
// state, so changing it re-renders B's tree and nothing else.
function Host({ titleB, strict }: { titleB: string; strict: boolean }): React.ReactElement {
  const tree = (
    <>
      <SoftNWithXDB source={SOURCE_A} appId="iso-a" />
      <SoftNWithXDB source={SOURCE_B} appId="iso-b" initialState={{ title: titleB }} />
    </>
  );
  return strict ? <React.StrictMode>{tree}</React.StrictMode> : tree;
}

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  // Instances are memoised per app and cache in memory, so clearing storage
  // alone leaves the records of the previous test in place.
  for (const id of ['iso-a', 'iso-b']) getXDB(id).clear('items');
  getXDB().clear('items');
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
});

async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function mountBoth(strict: boolean): Promise<void> {
  await act(async () => {
    root.render(<Host titleB="one" strict={strict} />);
  });
  for (let i = 0; i < 40; i++) {
    if (container.querySelector('.probe-a') && container.querySelector('.probe-b')) break;
    await settle(10);
  }
  expect(container.querySelector('.probe-a')).not.toBeNull();
  expect(container.querySelector('.probe-b')).not.toBeNull();
}

async function triggerAWhileBRerenders(strict: boolean): Promise<void> {
  // A's handler starts and yields.
  act(() => {
    (container.querySelector('.probe-a') as HTMLButtonElement).click();
  });
  // B re-renders while A is suspended: the moment the old pointer moved.
  await act(async () => {
    root.render(<Host titleB="two" strict={strict} />);
  });
  expect(container.querySelector('.title')?.textContent).toBe('two');
  // A resumes.
  await settle(20);
}

describe.each([
  { name: 'plain', strict: false },
  { name: 'under StrictMode', strict: true },
])('two mounted apps, $name', ({ strict }) => {
  it('writes a record into the app whose handler was suspended, not the one that re-rendered', async () => {
    await mountBoth(strict);
    await triggerAWhileBRerenders(strict);

    expect(getXDB('iso-a').getAll('items').map((r) => r.data.from)).toEqual(['a']);
    expect(getXDB('iso-b').getAll('items')).toHaveLength(0);
  });

  it('never moves the no-argument store off the shared default', async () => {
    const shared = getXDB();
    await mountBoth(strict);
    await triggerAWhileBRerenders(strict);

    // Rendering two apps did not repoint the module-level lookup, and nothing
    // a component wrote landed there.
    expect(getXDB()).toBe(shared);
    expect(shared.getAppId()).toBeUndefined();
    expect(shared.getAll('items')).toHaveLength(0);
  });
});
