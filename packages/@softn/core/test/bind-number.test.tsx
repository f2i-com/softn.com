/**
 * `:bind` on a number field writes a number.
 *
 * A field's `value` is text, and `:bind` wrote what it held: `<input
 * type="number" :bind={qty} />` made `qty` the string "5", and `qty + 1` in
 * the logic was "51". Now a number field writes a number when what it holds
 * is one, and `''` while it is empty or holds something that is not a
 * number, so a page's `qty === ''` still means "nothing entered".
 *
 * The write happens in the renderer, so it is the same whichever thread or
 * language runs the logic; each is driven here through the real loader.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SoftNRenderer, type SoftNRendererProps } from '../src/loader/SoftNRenderer';
import { registerComponent, type SoftNComponent } from '../src/renderer/registry';
import { logicEngineRunsPython } from '../src/runtime/vm-adapter';
import { Input } from '../../components/src/form/Input';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => {
  registerComponent('Input', Input as unknown as SoftNComponent);
});

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
  vi.unstubAllGlobals();
});

async function mount(props: SoftNRendererProps) {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container);
    root.render(<SoftNRenderer {...props} />);
  });
  // Until the logic has loaded: before it has, `qty` is undefined on the page.
  for (let i = 0; i < 150 && !/^number:/.test(container.querySelector('#out')?.textContent ?? ''); i++) {
    await act(async () => {
      await sleep(20);
    });
  }
}

async function type(value: string) {
  await act(async () => {
    const input = container.querySelector('input') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(20);
  });
}

async function click(id: string) {
  await act(async () => {
    (container.querySelector(`#${id}`) as HTMLElement).click();
    await sleep(60);
  });
}

const shown = () => container.querySelector('#out')?.textContent;

const page = (field: string) => `<logic>
let qty = 1
function more() { qty = qty + 1 }
</logic>
<div>
  ${field}
  <button id="more" @click={() => more()}>More</button>
  <p id="out">{typeof qty}:{qty === '' ? 'empty' : qty}</p>
</div>`;

describe('a number field bound with :bind', () => {
  for (const [name, field] of [
    ['<input type="number">', '<input type="number" :bind={qty} />'],
    ['<Input type="number">', '<Input type="number" :bind={qty} />'],
  ] as const) {
    it(`writes a number, and '' while it is empty, for ${name}`, async () => {
      await mount({ source: page(field), appId: `bind-number-${name.length}`, scriptExecutionMode: 'main' });
      expect(shown()).toBe('number:1');
      await type('5');
      expect(shown()).toBe('number:5');
      await click('more');
      expect(shown()).toBe('number:6');
      await type('');
      expect(shown()).toBe('string:empty');
      await type('2.5');
      expect(shown()).toBe('number:2.5');
    });
  }

  it('leaves a text field writing text', async () => {
    await mount({ source: page('<input :bind={qty} />'), appId: 'bind-number-text', scriptExecutionMode: 'main' });
    await type('5');
    expect(shown()).toBe('string:5');
  });
});

// ── The worker, with the real worker script run in this realm ───────────────

const workerScope = self as unknown as {
  postMessage: (message: unknown) => void;
  onmessage: ((event: { data: unknown }) => unknown) | null;
};

class InProcessWorker {
  onmessage: ((evt: MessageEvent) => void) | null = null;
  onerror: ((evt: ErrorEvent) => void) | null = null;
  onmessageerror: ((evt: MessageEvent) => void) | null = null;
  terminated = false;
  constructor() {
    workerScope.postMessage = (message: unknown) => {
      if (!this.terminated) setTimeout(() => this.onmessage?.({ data: message } as MessageEvent), 0);
    };
  }
  postMessage(message: unknown): void {
    if (this.terminated) return;
    setTimeout(() => void workerScope.onmessage?.({ data: message }), 0);
  }
  terminate(): void {
    this.terminated = true;
  }
}

describe('a number field bound with :bind, with the logic in the worker', () => {
  it('hands the worker a number', async () => {
    const realPostMessage = workerScope.postMessage;
    vi.stubGlobal('Worker', InProcessWorker);
    await import('../src/runtime/script-worker');
    try {
      await mount({
        source: page('<input type="number" :bind={qty} />'),
        appId: 'bind-number-worker',
        scriptExecutionMode: 'worker',
        executionPreference: 'worker',
      });
      await type('5');
      await click('more');
      await act(async () => {
        await sleep(60);
      });
      expect(shown()).toBe('number:6');
    } finally {
      workerScope.postMessage = realPostMessage;
    }
  });
});

describe.skipIf(!logicEngineRunsPython())('a number field bound with :bind, with the logic in Python', () => {
  it('hands Python a number', async () => {
    // The empty <logic> block a Python composition leaves in the markup.
    const source = `<div>
  <input type="number" :bind={qty} />
  <button id="more" @click={() => more()}>More</button>
  <p id="out">{typeof qty}:{qty}</p>
</div>
<logic>
</logic>`;
    await mount({
      source,
      appId: 'bind-number-python',
      scriptExecutionMode: 'main',
      python: { files: { app: ['qty = 1', '', 'def more():', '    global qty', '    qty = qty + 1', ''].join('\n') }, modules: ['app'] },
    });
    await type('5');
    await click('more');
    expect(shown()).toBe('number:6');
  });
  it('keeps a value the page holds only a copy of, a tuple or a record with number keys', async () => {
    const source = `<div>
  <button id="more" @click={() => more()}>More</button>
  <p id="out">{label}</p>
  <p id="sizes">{pair.length} {Object.keys(names).length}</p>
</div>
<logic>
</logic>`;
    await mount({
      source,
      appId: 'python-lossy-copy',
      scriptExecutionMode: 'main',
      python: {
        files: {
          app: [
            'names = {1: "one", 2: "two"}',
            'pair = (1, 2)',
            'label = "start"',
            '',
            'def more():',
            '    global label',
            '    label = names[1] + ":" + type(pair).__name__',
            '',
          ].join('\n'),
        },
        modules: ['app'],
      },
    });
    await click('more');
    expect(shown()).toBe('one:tuple');
  }, 30_000);
});
