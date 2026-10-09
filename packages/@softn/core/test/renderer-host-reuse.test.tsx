/**
 * The two changes to drawing, held on the path an app actually runs.
 *
 * The tests of element reuse and of writes to a loop item draw with
 * `renderDocument` and a context they make themselves. An app is drawn by
 * `SoftNRenderer`: its context is made again whenever state changes, its
 * state is written by its own `setState`, and its logic runs in the script
 * engine. These hold that, mounted there:
 *
 *   - a keystroke in a bound field does not run a component elsewhere on
 *     the page again, and does when the host is told not to reuse;
 *   - a checkbox bound to a loop item writes that row of the list (the list
 *     stays a list), stays checked, and the app's logic sees the change.
 */

import { act } from 'react';
import type { MutableRefObject } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SoftNRenderer } from '../src/loader/SoftNRenderer';
import { getDefaultRegistry } from '../src/renderer/registry';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;
let probeRuns = 0;

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  probeRuns = 0;
  getDefaultRegistry().register('HostReuseProbe', (props: { label?: string }) => {
    probeRuns++;
    return <aside>{props.label}</aside>;
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
});

async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function until(holds: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (holds()) return;
    await settle(25);
  }
  throw new Error(`timed out waiting for ${what}; the page holds: ${container.textContent}`);
}

async function type(input: HTMLInputElement, text: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
}

const SOURCE = `<logic>
let query = ""
let summary = "not asked"
let todos = [
  { id: "a", title: "First", done: false },
  { id: "b", title: "Second", done: false },
  { id: "c", title: "Third", done: false }
]

function report() {
  summary = todos.map((todo) => (todo.done ? "1" : "0")).join("") + ":" + todos.length
}
</logic>
<div>
  <input id="query" :bind={query} />
  <p id="echo">{query}</p>
  <HostReuseProbe label="fixed" />
  #each (todo in todos) key={todo.id}
    <label><input type="checkbox" class="done" :bind={todo.done} />{todo.title}</label>
  #end
  <button id="report" @click={() => report()}>Report</button>
  <p id="summary">{summary}</p>
</div>`;

describe('SoftNRenderer', () => {
  it('does not run a component again for a keystroke in a field elsewhere on the page', async () => {
    await act(async () => {
      root.render(<SoftNRenderer source={SOURCE} appId="HostReuseA" scriptExecutionMode="main" />);
    });
    await until(() => container.querySelectorAll('input.done').length === 3, 'the list');
    await settle(50);

    const before = probeRuns;
    expect(before).toBeGreaterThan(0);
    const field = container.querySelector<HTMLInputElement>('#query')!;
    await type(field, 'a');
    await type(field, 'ab');
    await type(field, 'abc');
    expect(container.querySelector('#echo')!.textContent).toBe('abc');
    expect(field.value).toBe('abc');
    // The page was drawn for each keystroke; the probe was handed the element it had.
    expect(probeRuns).toBe(before);
  });

  it('runs it again each time when told not to reuse, as it always did', async () => {
    await act(async () => {
      root.render(<SoftNRenderer source={SOURCE} appId="HostReuseB" scriptExecutionMode="main" reuseElements={false} />);
    });
    await until(() => container.querySelectorAll('input.done').length === 3, 'the list');
    await settle(50);

    const before = probeRuns;
    const field = container.querySelector<HTMLInputElement>('#query')!;
    await type(field, 'a');
    await type(field, 'ab');
    expect(container.querySelector('#echo')!.textContent).toBe('ab');
    expect(probeRuns).toBeGreaterThan(before);
  });

  it('writes a checkbox bound to a loop item into that row, where the app’s logic reads it', async () => {
    const stateRef: MutableRefObject<(() => Record<string, unknown>) | null> = { current: null };
    await act(async () => {
      root.render(<SoftNRenderer source={SOURCE} appId="HostReuseC" scriptExecutionMode="main" stateRef={stateRef} />);
    });
    await until(() => container.querySelectorAll('input.done').length === 3, 'the list');
    await settle(50);

    const boxes = () => Array.from(container.querySelectorAll<HTMLInputElement>('input.done'));
    await act(async () => {
      boxes()[1].click();
    });
    await settle(50);

    // The box stays checked: the row it shows is the row that was written.
    expect(boxes().map((box) => box.checked)).toEqual([false, true, false]);

    const state = stateRef.current!();
    expect(Array.isArray(state.todos)).toBe(true);
    expect((state.todos as Array<{ id: string; done: boolean }>).map((todo) => [todo.id, todo.done])).toEqual([
      ['a', false],
      ['b', true],
      ['c', false],
    ]);
    // And no state variable named after the loop variable.
    expect(state).not.toHaveProperty('todo');

    // The logic reads the list it was written to.
    await act(async () => {
      container.querySelector<HTMLButtonElement>('#report')!.click();
    });
    await until(() => container.querySelector('#summary')!.textContent !== 'not asked', 'the report');
    expect(container.querySelector('#summary')!.textContent).toBe('010:3');

    // Unchecking it writes the row back.
    await act(async () => {
      boxes()[1].click();
    });
    await settle(50);
    expect(boxes().map((box) => box.checked)).toEqual([false, false, false]);
    expect((stateRef.current!().todos as Array<{ done: boolean }>).map((todo) => todo.done)).toEqual([false, false, false]);
  });
});
