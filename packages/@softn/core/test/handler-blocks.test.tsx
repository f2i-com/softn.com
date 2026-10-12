/**
 * A handler with a block body runs its statements.
 *
 * `@click={() => { save() }}` did nothing: the braces were read as a record,
 * and calling it threw where no one heard. A body of statements now runs one
 * after another, as an author writes it, with the same rule for state as any
 * expression: a handler writes state, and an arrow run while the page is
 * drawn does not.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SoftNRenderer } from '../src/loader/SoftNRenderer';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let root: Root | null = null;
let container: HTMLElement;

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => current.unmount());
    root = null;
  }
  container?.remove();
  vi.restoreAllMocks();
});

async function mount(source: string) {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container);
    root.render(<SoftNRenderer source={source} appId="handler-blocks" scriptExecutionMode="main" />);
  });
  for (let i = 0; i < 60 && !/^n=/.test(container.querySelector('#out')?.textContent ?? ''); i++) {
    await act(async () => {
      await sleep(20);
    });
  }
}

async function click(id: string) {
  await act(async () => {
    (container.querySelector(`#${id}`) as HTMLElement).click();
    await sleep(60);
  });
}

const shown = () => container.querySelector('#out')?.textContent;

const LOGIC = `<logic>
let n = 0
let saved = ''
function save(why) { saved = why || 'saved' }
</logic>`;

describe('a handler with a block body', () => {
  it('runs a single call', async () => {
    await mount(`${LOGIC}
<div><button id="b" @click={() => { save() }}>x</button><p id="out">n={n} {saved}</p></div>`);
    expect(shown()).toBe('n=0 ');
    await click('b');
    expect(shown()).toBe('n=0 saved');
  });

  it('runs each statement in order, an assignment among them', async () => {
    await mount(`${LOGIC}
<div><button id="b" @click={(e) => {
  n = n + 1
  save('twice'); n++
}}>x</button><p id="out">n={n} {saved}</p></div>`);
    await click('b');
    expect(shown()).toBe('n=2 twice');
  });

  it('lets a logic function it calls see what it wrote first', async () => {
    await mount(`<logic>
let n = 0
let saved = ''
function save() { saved = 'n was ' + n }
</logic>
<div><button id="b" @click={() => { n = 5; save() }}>x</button><p id="out">n={n} {saved}</p></div>`);
    await click('b');
    expect(shown()).toBe('n=5 n was 5');
  });

  it('hands back what its return gives', async () => {
    await mount(`${LOGIC}
<div><p id="out">n={n} {[1, 2].map((x) => { return x * 10 }).join(',')}</p></div>`);
    expect(shown()).toBe('n=0 10,20');
  });

  it('writes no state from an arrow the page runs while it is drawn', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await mount(`${LOGIC}
<div><p id="out">n={n} {[1].map((x) => { n = 99; return x }).join(',')}</p></div>`);
    expect(shown()).toBe('n=0 1');
    expect(errors.mock.calls.some((call) => String(call[0]).includes('changes state while the page is being drawn'))).toBe(true);
  });

  it('runs nothing of a body with a statement markup does not read', async () => {
    await mount(`${LOGIC}
<div><button id="b" @click={() => { if (n) save() }}>x</button><p id="out">n={n} {saved}</p></div>`);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await click('b');
    expect(shown()).toBe('n=0 ');
    expect(errors.mock.calls.some((call) => String(call[0]).startsWith('[SoftN] This handler did not run'))).toBe(true);
  });
});
