/**
 * `$:` values that read each other, on a page.
 *
 * computed-dependencies.test.ts holds the runtime to it. This mounts the real
 * loader over the real engine and clicks, because a page reaches the values
 * by another road — every `$:` is read at each draw, before the markup is —
 * and that road has to arrive at the same values logic reads.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { SoftNRenderer } from '../src/loader/SoftNRenderer';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// A to-do list written the way a newcomer writes one: the list shown is
// worked out from the lists of done and not done, and those from the records.
// `shown` is written above the two it reads.
const SOURCE = `<logic>
let todos = [{ id: 1, title: "write", done: true }, { id: 2, title: "test", done: false }]
let filter = "all"
let cleared = 0
$: shown = filter === "active" ? active : filter === "done" ? done : todos
$: active = todos.filter(t => !t.done)
$: done = todos.filter(t => t.done)
$: summary = active.length + " of " + todos.length + " to do"
function show(which) { filter = which }
function add(title) { todos = [...todos, { id: todos.length + 1, title: title, done: false }] }
function finish(id) { todos = todos.map(t => t.id === id ? { id: t.id, title: t.title, done: true } : t) }
function clearDone() { cleared = cleared + done.length; todos = todos.filter(t => !t.done) }
function describe() { return "showing " + shown.length }
</logic>

<div>
  <button id="all" @click={() => show("all")}>All</button>
  <button id="active" @click={() => show("active")}>Active</button>
  <button id="done" @click={() => show("done")}>Done</button>
  <button id="add" @click={() => add("ship")}>Add</button>
  <button id="finish" @click={() => finish(2)}>Finish</button>
  <button id="clear" @click={() => clearDone()}>Clear</button>
  <p class="summary">{summary}</p>
  <p class="asked">{describe()}</p>
  <p class="cleared">{cleared}</p>
  <ul>
    #each (todo in shown) key={todo.id}
      <li>{todo.title}</li>
    #end
  </ul>
</div>`;

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
});

const text = (selector: string) => container.querySelector(selector)?.textContent;
const rows = () => [...container.querySelectorAll('li')].map((li) => li.textContent);

async function click(id: string) {
  await act(async () => {
    (container.querySelector(`#${id}`) as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 120));
  });
}

/** Mount a page and wait for its logic to have loaded and its markup to be drawn. */
async function mount(source: string, ready: string) {
  await act(async () => {
    root = createRoot(container);
    root.render(<SoftNRenderer source={source} />);
  });
  // The engine loads asynchronously; give it room to compile and run.
  for (let i = 0; i < 60; i++) {
    if (container.querySelector(ready)) break;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
  }
  expect(container.querySelector(ready), 'the page should render').not.toBeNull();
}

describe('a page that reads state only through a $: value', () => {
  // State the markup never names is kept in the engine and not mirrored to
  // the page: nothing on the page could read it, and mirroring it costs. But
  // a `$:` value is how a page reads it. `step` below is named by logic
  // alone, so changing it changed nothing the page was told about, the page
  // was not redrawn, and `label` stood at its first value on the screen —
  // with one `$:`, before any `$:` read another.
  it('is redrawn when that state changes', async () => {
    await mount(
      `<logic>
let step = 1
$: label = "step " + step
function faster() { step = step + 1 }
</logic>

<div>
  <button id="faster" @click={() => faster()}>Faster</button>
  <p class="label">{label}</p>
</div>`,
      '#faster'
    );
    expect(text('.label')).toBe('step 1');
    await click('faster');
    expect(text('.label')).toBe('step 2');
    await click('faster');
    expect(text('.label')).toBe('step 3');
    await act(async () => root.unmount());
  }, 60_000);
});

describe('a page over $: values built on each other', () => {
  it('shows what logic works out, at every step', async () => {
    await mount(SOURCE, '#all');

    expect(rows()).toEqual(['write', 'test']);
    expect(text('.summary')).toBe('1 of 2 to do');
    expect(text('.asked')).toBe('showing 2');

    await click('active');
    expect(rows()).toEqual(['test']);
    expect(text('.asked')).toBe('showing 1');

    await click('done');
    expect(rows()).toEqual(['write']);

    await click('add');
    expect(rows()).toEqual(['write']);
    expect(text('.summary')).toBe('2 of 3 to do');

    await click('active');
    expect(rows()).toEqual(['test', 'ship']);
    expect(text('.asked')).toBe('showing 2');

    await click('finish');
    expect(rows()).toEqual(['ship']);
    expect(text('.summary')).toBe('1 of 3 to do');

    // A function that loops over a `$:` value: both done todos, not the one
    // that was done when the script loaded.
    await click('clear');
    expect(text('.cleared')).toBe('2');
    expect(text('.summary')).toBe('1 of 1 to do');
    await click('all');
    expect(rows()).toEqual(['ship']);

    await act(async () => root.unmount());
  }, 60_000);
});
