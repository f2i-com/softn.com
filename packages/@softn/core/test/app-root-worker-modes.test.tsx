/**
 * In SoftN Web's default execution (scriptExecutionMode "worker", the script
 * on the main thread's engine behind a hybrid or worker handle), the app's
 * element is named to key-capture.ts as it is in main mode: its window
 * listeners hear a key aimed at its own elements, and not one aimed at the
 * host's button beside it. The handles did not pass setAppRoot on, so the app
 * heard every key the page had outside a text field.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { SoftNRenderer } from '../src/loader/SoftNRenderer';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let root: Root | null = null;
let container: HTMLElement;
let hostButton: HTMLButtonElement;

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => current.unmount());
    root = null;
  }
  container?.remove();
  hostButton?.remove();
});

describe('an app in the default (worker) execution', () => {
  it('hears a key aimed at its own element, and not one aimed at the host', async () => {
    hostButton = document.createElement('button');
    hostButton.textContent = 'Host';
    document.body.appendChild(hostButton);
    container = document.createElement('div');
    document.body.appendChild(container);
    const source = `<logic>
let heard = 0
window.addEventListener('keydown', function () { heard = heard + 1 })
</logic>
<div><p id="heard">{heard}</p><button id="mine">Mine</button></div>`;
    await act(async () => {
      root = createRoot(container);
      root.render(<SoftNRenderer source={source} appId="app-root-worker" scriptExecutionMode="worker" />);
    });
    for (let i = 0; i < 100 && container.querySelector('#heard')?.textContent !== '0'; i++) {
      await act(async () => {
        await sleep(20);
      });
    }
    expect(container.querySelector('#heard')?.textContent).toBe('0');

    await act(async () => {
      hostButton.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
      await sleep(30);
    });
    expect(container.querySelector('#heard')?.textContent).toBe('0');

    await act(async () => {
      container.querySelector('#mine')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
      await sleep(30);
    });
    expect(container.querySelector('#heard')?.textContent).toBe('1');
  });
});
