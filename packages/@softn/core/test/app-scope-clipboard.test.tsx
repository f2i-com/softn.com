/**
 * A component can ask whether its app may use the clipboard.
 *
 * The manifest's `permissions.clipboard: false` is kept by the script's
 * sandbox: the script is simply not given the bridge. A component is not in
 * the sandbox. It runs in the page, and one that copies text (CopyButton)
 * would do for the app what the app was told it may not do, unless the
 * renderer tells the components below it. It does, through the app scope.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SoftNRenderer } from '../src/loader/SoftNRenderer';
import { useAppScope } from '../src/loader/app-scope';
import { getDefaultRegistry } from '../src/renderer/registry';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  getDefaultRegistry().register('ClipboardProbe', () => <output>{String(useAppScope().clipboard)}</output>);
});

afterEach(async () => {
  await act(async () => root.unmount());
});

async function shown(permissions?: { clipboard?: boolean }): Promise<string> {
  await act(async () => {
    root.render(<SoftNRenderer source="<ClipboardProbe />" appId="clipboard-scope" scriptExecutionMode="main" permissions={permissions} />);
  });
  for (let attempt = 0; attempt < 200; attempt++) {
    const output = container.querySelector('output');
    if (output) return output.textContent ?? '';
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
  }
  throw new Error(`the probe was never drawn: ${container.textContent}`);
}

describe('the app scope', () => {
  it('says the clipboard may be used where the manifest says nothing, as the script is told', async () => {
    expect(await shown()).toBe('true');
  });

  it('says so where the manifest grants it', async () => {
    expect(await shown({ clipboard: true })).toBe('true');
  });

  it('says it may not where the manifest denies it', async () => {
    expect(await shown({ clipboard: false })).toBe('false');
  });
});
