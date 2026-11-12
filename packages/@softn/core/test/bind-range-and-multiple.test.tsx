/**
 * `:bind` on a slider and on a list of choices.
 *
 * `<input type="range" :bind={volume} />` made `volume` the text "50", so
 * `volume + 10` was "5010": a field's value is always text, and only
 * `type="number"` was read as the number it holds. `<select multiple
 * :bind={picked}>` wrote the first chosen value, one text, over the list the
 * variable held: a select's `value` is the first of its chosen options.
 *
 * A slider writes a number, and a `<select multiple>` the list of the values
 * chosen, drawn back from the list it is bound to.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SoftNRenderer, type SoftNRendererProps } from '../src/loader/SoftNRenderer';
import { logicEngineRunsPython } from '../src/runtime/vm-adapter';
import { choose, drawPage, removeDrawnPages, typeInto } from './helpers/drawn-page';
import { withInProcessWorker } from './helpers/in-process-worker';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let root: Root | null = null;
let container: HTMLElement | undefined;

afterEach(async () => {
  removeDrawnPages();
  if (root) {
    const current = root;
    await act(async () => current.unmount());
    root = null;
  }
  container?.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const OPTIONS = '<option value="a">A</option><option value="b">B</option><option value="c">C</option>';
const chosen = (select: HTMLSelectElement) => Array.from(select.selectedOptions, (option) => option.value);

// ── The renderer ────────────────────────────────────────────────────────────

describe(':bind on a slider', () => {
  it('writes the number it is set to', () => {
    const { writes, state, text, one } = drawPage('<input type="range" min="0" max="100" :bind={volume} /><p>{volume + 10}</p>', { volume: 20 });
    expect(text('p')).toBe('30');
    typeInto(one('input'), '50');
    expect(writes).toEqual([['volume', 50]]);
    expect(state().volume).toBe(50);
    expect(text('p')).toBe('60');
  });

  it('writes a number with a fraction, where its step allows one', () => {
    const { writes, one } = drawPage('<input type="range" min="0" max="1" step="0.1" :bind={opacity} />', { opacity: 1 });
    typeInto(one('input'), '0.3');
    expect(writes).toEqual([['opacity', 0.3]]);
  });

  it('leaves a text field’s text as text, and a number field’s number a number', () => {
    const { writes, all } = drawPage('<input :bind={code} /><input type="number" :bind={qty} />', { code: '', qty: 0 });
    typeInto(all('input')[0], '007');
    typeInto(all('input')[1], '7');
    expect(writes).toEqual([['code', '007'], ['qty', 7]]);
  });
});

describe(':bind on a <select multiple>', () => {
  it('writes the list of the values chosen', () => {
    const { writes, state, one } = drawPage(`<select multiple :bind={picked}>${OPTIONS}</select>`, { picked: ['b'] });
    choose(one<HTMLSelectElement>('select'), 'a', 'c');
    expect(writes).toEqual([['picked', ['a', 'c']]]);
    expect(state().picked).toEqual(['a', 'c']);
    // Drawn back from the list.
    expect(chosen(one<HTMLSelectElement>('select'))).toEqual(['a', 'c']);
  });

  it('writes an empty list when nothing is chosen any more', () => {
    const { state, one } = drawPage(`<select multiple :bind={picked}>${OPTIONS}</select>`, { picked: ['a', 'b'] });
    choose(one<HTMLSelectElement>('select'));
    expect(state().picked).toEqual([]);
  });

  it('shows the choices of the list it is bound to, and nothing chosen for a variable not set yet', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const set = drawPage(`<select multiple :bind={picked}>${OPTIONS}</select>`, { picked: ['b', 'c'] });
    expect(chosen(set.one<HTMLSelectElement>('select'))).toEqual(['b', 'c']);
    const unset = drawPage(`<select multiple :bind={picked}>${OPTIONS}</select>`, {});
    expect(chosen(unset.one<HTMLSelectElement>('select'))).toEqual([]);
    const one = drawPage(`<select multiple :bind={picked}>${OPTIONS}</select>`, { picked: 'c' });
    expect(chosen(one.one<HTMLSelectElement>('select'))).toEqual(['c']);
    // React refuses anything but a list for it, and says so.
    expect(errors.mock.calls.filter((call) => String(call[0]).includes('must be an array'))).toEqual([]);
  });

  it('is a list where multiple is worked out, and one value where it is not on', () => {
    const many = drawPage(`<select multiple={many} :bind={picked}>${OPTIONS}</select>`, { picked: [], many: true });
    choose(many.one<HTMLSelectElement>('select'), 'b', 'c');
    expect(many.writes).toEqual([['picked', ['b', 'c']]]);

    const single = drawPage(`<select :bind={picked}>${OPTIONS}</select>`, { picked: 'a' });
    choose(single.one<HTMLSelectElement>('select'), 'b');
    expect(single.writes).toEqual([['picked', 'b']]);
  });
});

// ── A page and its logic, on each engine and thread ─────────────────────────

const shown = () => container?.querySelector('#out')?.textContent ?? '';

async function mountPage(source: string, props: Partial<SoftNRendererProps> = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container!);
    root.render(<SoftNRenderer source={source} appId="bind-range-and-multiple" scriptExecutionMode="main" {...props} />);
  });
  for (let i = 0; i < 150 && !shown().startsWith('yes|'); i++) {
    await act(async () => {
      await sleep(20);
    });
  }
  expect(shown()).toBe('yes|30|b|');
}

async function settle(what: () => void, expected: string): Promise<string> {
  await act(async () => {
    what();
    await sleep(20);
  });
  for (let i = 0; i < 50 && shown() !== expected; i++) {
    await act(async () => {
      await sleep(20);
    });
  }
  await act(async () => {
    await sleep(60);
  });
  return shown();
}

const slideTo = (value: string) => () => {
  const input = container!.querySelector('input') as HTMLInputElement;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};
const pick = (...values: string[]) => () => {
  const select = container!.querySelector('select') as HTMLSelectElement;
  for (const option of Array.from(select.options)) option.selected = values.includes(option.value);
  select.dispatchEvent(new Event('change', { bubbles: true }));
};
const pressButton = (id: string) => () => (container!.querySelector(`#${id}`) as HTMLElement).click();

const MARKUP = `<div>
<input type="range" min="0" max="100" :bind={volume} />
<select multiple :bind={picked}>${OPTIONS}</select>
<button id="louder" @click={louder()}>louder</button>
<button id="count" @click={count()}>count</button>
<p id="out">{loaded}|{volume + 10}|{picked.join("+")}|{seen}</p>
</div>`;

const LOGIC = `<logic>
let loaded = 'yes'
let volume = 20
let picked = ['b']
let seen = ''
function louder() { volume = volume + 10 }
function count() { seen = picked.length + ':' + picked.join('+') }
</logic>`;

/** Slide, let the logic add to the number, choose two, and ask the logic how many. */
async function slideAndChoose(): Promise<void> {
  expect(await settle(slideTo('50'), 'yes|60|b|')).toBe('yes|60|b|');
  expect(await settle(pressButton('louder'), 'yes|70|b|')).toBe('yes|70|b|');
  expect(await settle(pick('a', 'c'), 'yes|70|a+c|')).toBe('yes|70|a+c|');
  expect(await settle(pressButton('count'), 'yes|70|a+c|2:a+c')).toBe('yes|70|a+c|2:a+c');
}

describe('a slider and a list of choices, with the logic on the main thread', () => {
  it('give the logic a number and a list', async () => {
    await mountPage(`${LOGIC}\n${MARKUP}`);
    await slideAndChoose();
  });
});

describe('a slider and a list of choices, with the logic in the worker', () => {
  it('give the logic a number and a list', async () => {
    await withInProcessWorker(async () => {
      await mountPage(`${LOGIC}\n${MARKUP}`, { scriptExecutionMode: 'worker', executionPreference: 'worker' });
      await slideAndChoose();
    });
  });
});

describe.skipIf(!logicEngineRunsPython())('a slider and a list of choices, with the logic in Python', () => {
  const python = {
    files: {
      app: [
        'loaded = "yes"',
        'volume = 20',
        'picked = ["b"]',
        'seen = ""',
        '',
        'def louder():',
        '    global volume',
        '    volume = volume + 10',
        '',
        'def count():',
        '    global seen',
        '    seen = str(len(picked)) + ":" + "+".join(picked)',
        '',
      ].join('\n'),
    },
    modules: ['app'],
  };

  it('give the logic a number and a list', async () => {
    await mountPage(`${MARKUP}\n<logic>\n</logic>`, { python });
    await slideAndChoose();
  });
});
