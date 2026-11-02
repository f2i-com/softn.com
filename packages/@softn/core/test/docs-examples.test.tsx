/**
 * The examples the guides and the front page show (docs/examples/*.ui), run for real: parsed without a word, drawn
 * by the loader, their logic run in the engine, and used the way a reader would. Each is shown from its file — the
 * site imports it, and the guides' copy is held to it below — so what a page teaches is what runs.
 */
import { act } from 'react';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { parse } from '../src/parser';
import { SoftNRenderer } from '../src/loader/SoftNRenderer';
import { registerComponent, type SoftNComponent } from '../src/renderer/registry';
import { App } from '../../components/src/layout/App';
import { Stack } from '../../components/src/layout/Stack';
import { Heading } from '../../components/src/display/Heading';
import { Text } from '../../components/src/display/Text';
import { Button } from '../../components/src/form/Button';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const EXAMPLES = join(__dirname, '../../../../docs/examples');
const example = (name: string) => readFileSync(join(EXAMPLES, name), 'utf8');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(() => {
  for (const [name, component] of Object.entries({ App, Stack, Heading, Text, Button })) {
    registerComponent(name, component as unknown as SoftNComponent);
  }
});

let root: Root | null = null;
let container: HTMLElement;

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => current.unmount());
    root = null;
  }
  container?.remove();
});

async function mount(source: string, appId: string, ready: () => boolean) {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container);
    root.render(<SoftNRenderer source={source} appId={appId} scriptExecutionMode="main" />);
  });
  for (let i = 0; i < 150 && !ready(); i++) {
    await act(async () => { await sleep(20); });
  }
  expect(ready(), 'the page and its logic loaded').toBe(true);
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(20);
  });
}

async function press(button: HTMLElement) {
  await act(async () => {
    button.click();
    await sleep(60);
  });
}

const button = (text: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) as HTMLButtonElement;

describe('the examples the guides show', () => {
  it('every one parses without a word', () => {
    const files = readdirSync(EXAMPLES).filter((file) => file.endsWith('.ui'));
    expect(files).toEqual(expect.arrayContaining(['first-counter.ui', 'hello-name.ui']));
    for (const file of files) expect(parse(example(file)).diagnostics ?? [], file).toEqual([]);
  });

  it('hello-name: an HTML page with SoftN in it — the field binds, the button runs the logic, the text shows it', async () => {
    await mount(example('hello-name.ui'), 'docs-hello-name', () => Boolean(container.querySelector('main.card input#visitor')) && Boolean(button('Say hello')));
    const label = container.querySelector('label') as HTMLLabelElement;
    expect(label.textContent).toBe('Your name');
    expect(label.getAttribute('for')).toBe('visitor');
    await type(container.querySelector('#visitor') as HTMLInputElement, 'Ada');
    await press(button('Say hello'));
    expect(container.querySelector('main.card p')?.textContent).toBe('Hello, Ada');
  });

  it('first-counter: SoftN components and a logic function', async () => {
    await mount(example('first-counter.ui'), 'docs-first-counter', () => (container.textContent ?? '').includes('Count: 0'));
    await press(button('Increment'));
    await press(button('Increment'));
    expect(container.textContent).toContain('Count: 2');
  });
});
