/** @vitest-environment jsdom */
import { act, type PropsWithChildren } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VisualCanvas } from '../src/components/canvas/VisualCanvas';
import { useVFSStore, useWorkspaceStore } from '../src/stores';

const { register } = vi.hoisted(() => ({ register: vi.fn() }));
vi.mock('@softn/components', () => ({
  registerAllBuiltins: register,
  ThemeProvider: ({ children }: PropsWithChildren) => children,
}));
vi.mock('@softn/core', () => ({
  getXDB: () => { throw new Error('No persistent preview storage in this fixture'); },
  SoftNRenderer: () => <div data-testid="ready-preview">Rendered app</div>,
}));

let root: Root;
let container: HTMLDivElement;
const source = '<style>.app { color: red; }</style><Text>App content</Text>';
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  register.mockReset();
  useWorkspaceStore.getState().reset();
  useVFSStore.getState().reset();
  useVFSStore.getState().createFile('ui/main.ui', source);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

describe('Studio preview initialization', () => {
  it('shows a concise live loading state instead of the source while the renderer starts', async () => {
    act(() => root.render(<VisualCanvas />));
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Preparing preview…');
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy();
    expect(container.querySelector('pre')).toBeNull();
    expect(container.textContent).not.toContain('.app { color: red; }');
    await act(async () => { await vi.dynamicImportSettled(); });
    expect(container.querySelector('[data-testid="ready-preview"]')).toBeTruthy();
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it('reports an initialization failure with source inspection and a working retry', async () => {
    register.mockImplementationOnce(() => { throw new Error('Preview assets did not load'); });
    await act(async () => { root.render(<VisualCanvas />); await vi.dynamicImportSettled(); });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Preview could not start.');
    expect(container.textContent).toContain('Preview assets did not load');
    const details = container.querySelector('details')!;
    expect(details.querySelector('summary')?.textContent).toBe('View source');
    expect(details.hasAttribute('open')).toBe(false);
    expect(details.querySelector('pre')?.textContent).toBe(source);
    const retry = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Retry preview')!;
    act(() => retry.click());
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Preparing preview…');
    expect(container.querySelector('pre')).toBeNull();
    await act(async () => { await vi.dynamicImportSettled(); });
    expect(container.querySelector('[data-testid="ready-preview"]')).toBeTruthy();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(register).toHaveBeenCalledTimes(2);
  });
});
