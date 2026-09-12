import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SourceFile } from '../src/lib/api';

const { getSource, copyText } = vi.hoisted(() => ({ getSource: vi.fn(), copyText: vi.fn() }));
vi.mock('../src/lib/api', () => ({ getSource }));
vi.mock('../src/lib/share', () => ({ copyText }));
import { SourceViewer } from '../src/components/directory/SourceViewer';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
const ui: SourceFile = { path: 'ui/main.ui', size: 35, text: '<Text>Hello</Text>' };
const logic: SourceFile = { path: 'logic/main.logic', size: 20, text: 'let count = 1;' };
const reply = (files = [ui, logic], version = 1) => ({ files, version, truncated: false });
async function render(version = 1): Promise<void> {
  await act(async () => { root.render(<SourceViewer slug="demo" version={version} main="ui/main.ui" />); });
}
function button(label: string): HTMLButtonElement {
  return [...container.querySelectorAll('button')].find((el) => el.textContent === label)!;
}
beforeEach(() => {
  vi.resetAllMocks();
  getSource.mockResolvedValue(reply());
  copyText.mockResolvedValue(true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

describe('source reader recovery and mobile actions', () => {
  it('retries a failed read without leaving a permanent error', async () => {
    getSource.mockRejectedValueOnce(new Error('Temporary outage'));
    await render();
    expect(container.textContent).toContain('Temporary outage');
    await act(async () => button('Retry source').click());
    expect(getSource).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('Hello');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('recovers from an error when another version is selected', async () => {
    getSource.mockRejectedValueOnce(new Error('Missing version'));
    await render();
    await render(2);
    expect(container.textContent).toContain('Hello');
    expect(container.textContent).not.toContain('Missing version');
  });

  it('ignores an old version that resolves after the current one', async () => {
    let finish!: (value: ReturnType<typeof reply>) => void;
    getSource.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await render();
    await render(2);
    await act(async () => finish(reply([{ ...ui, text: 'OLD VERSION' }])));
    expect(container.textContent).toContain('Hello');
    expect(container.textContent).not.toContain('OLD VERSION');
  });

  it('lets the phone file selector switch files and copies the exact source', async () => {
    await render();
    const select = container.querySelector('select')!;
    await act(async () => { select.value = logic.path; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(container.querySelector('.source-pane')?.textContent).toBe(logic.text);
    await act(async () => button('Copy source').click());
    expect(copyText).toHaveBeenCalledWith(logic.text);
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Source copied.');
    await act(async () => button('Wrap lines').click());
    expect(button('Wrap lines').getAttribute('aria-pressed')).toBe('false');
  });

  it('explains unavailable copy and distinguishes empty from unavailable source', async () => {
    copyText.mockResolvedValue(false);
    await render();
    await act(async () => button('Copy source').click());
    expect(container.textContent).toContain('Copy unavailable');
    getSource.mockResolvedValue(reply([{ ...ui, text: '' }]));
    await render(2);
    expect(container.textContent).toContain('This file is empty.');
    getSource.mockResolvedValue(reply([{ ...ui, text: null }]));
    await render(3);
    expect(container.textContent).toContain('may be binary or too large');
    expect(button('Copy source')).toBeUndefined();
  });
});
