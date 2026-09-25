/** @vitest-environment jsdom */
import { act, useEffect, type PropsWithChildren } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodeView } from '../src/components/canvas/CodeView';
import { VisualCanvas } from '../src/components/canvas/VisualCanvas';
import { useVFSStore, useWorkspaceStore } from '../src/stores';

const { mounts, unmounts } = vi.hoisted(() => ({ mounts: vi.fn(), unmounts: vi.fn() }));
vi.mock('@softn/components', () => ({
  registerAllBuiltins: () => {},
  ThemeProvider: ({ children }: PropsWithChildren) => children,
}));
vi.mock('@softn/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@softn/core')>()),
  getXDB: () => { throw new Error('No persistent preview storage in this fixture'); },
  SoftNRenderer: () => {
    useEffect(() => {
      mounts();
      return unmounts;
    }, []);
    return <div data-testid="ready-preview">Rendered app</div>;
  },
}));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mounts.mockReset();
  unmounts.mockReset();
  window.sessionStorage.clear();
  useWorkspaceStore.getState().reset();
  useVFSStore.getState().reset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

function button(name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === name);
  expect(found, `button ${name}`).toBeTruthy();
  return found!;
}

describe('CodeView', () => {
  it('shows every line, coloured by kind, with markup in the source kept as text', () => {
    const source = 'def greet():\n    return "<script>alert(1)</script>"  # hi\n';
    act(() => root.render(<CodeView path="logic/main.py" source={source} />));
    expect(container.querySelector('.st-codeview-lang')?.textContent).toBe('Python');
    const lines = container.querySelectorAll('.st-code-line');
    expect(lines).toHaveLength(3);
    // The text is the source exactly; the tag in the string is a text node.
    expect(container.querySelector('code')?.textContent).toBe(`${source}\n`);
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('.tk-string')?.textContent).toBe('"<script>alert(1)</script>"');
    expect(container.querySelector('.tk-comment')?.textContent).toBe('# hi');
    expect(container.querySelector('.tk-keyword')?.textContent).toBe('def');
  });

  it('highlights .logic as JavaScript and .xdb as JSON', () => {
    act(() => root.render(<CodeView path="logic/main.logic" source="let x = 1;" />));
    expect(container.querySelector('.st-codeview-lang')?.textContent).toBe('JavaScript');
    act(() => root.render(<CodeView path="data/books.xdb" source='{"a": 1}' />));
    expect(container.querySelector('.st-codeview-lang')?.textContent).toBe('JSON');
    expect(container.querySelector('.tk-property')?.textContent).toBe('"a"');
  });

  it('reads the languages the shared scanner adds, by file name', () => {
    act(() => root.render(<CodeView path="src/util.ts" source="let n: number = 1;" />));
    expect(container.querySelector('.st-codeview-lang')?.textContent).toBe('TypeScript');
    expect(container.querySelector('.tk-type')?.textContent).toBe('number');
    act(() => root.render(<CodeView path="README.md" source={'# Title\n'} />));
    expect(container.querySelector('.st-codeview-lang')?.textContent).toBe('Markdown');
    expect(container.querySelector('code')?.textContent).toBe('# Title\n\n');
  });

  it('copies the source, and says so', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    act(() => root.render(<CodeView path="logic/main.logic" source="let x = 1;" />));
    await act(async () => { button('Copy').click(); });
    expect(writeText).toHaveBeenCalledWith('let x = 1;');
    expect(container.textContent).toContain('Copied');
  });
});

describe('Preview | Code on a page', () => {
  const ui = '<Text>{greeting}</Text>\n';

  it('switches a .ui file between its running preview and its source without restarting the app, and remembers the choice for the session', async () => {
    useVFSStore.getState().createFile('ui/main.ui', ui);
    await act(async () => { root.render(<VisualCanvas />); await vi.dynamicImportSettled(); });
    expect(container.querySelector('[data-testid="ready-preview"]')).toBeTruthy();
    expect(button('Preview').getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('.st-live')).toBeTruthy();
    expect(mounts).toHaveBeenCalledOnce();

    act(() => button('Code').click());
    expect(button('Code').getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('.st-codeview-lang')?.textContent).toBe('SoftN markup');
    expect(container.querySelector('code')?.textContent).toBe(`${ui}\n`);
    // The app is still mounted, hidden, and the chrome no longer says it is running.
    const preview = container.querySelector<HTMLElement>('[data-testid="ready-preview"]')!;
    expect(preview.parentElement?.style.display).toBe('none');
    expect(container.querySelector('.st-live')).toBeNull();
    expect(unmounts).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem('softn.studio.canvasView.v1')).toBe('code');

    act(() => button('Preview').click());
    expect(container.querySelector('.st-codeview')).toBeNull();
    expect(mounts).toHaveBeenCalledOnce();
    expect(unmounts).not.toHaveBeenCalled();

    // A new canvas in the same session opens in the mode last chosen.
    act(() => button('Code').click());
    act(() => root.unmount());
    root = createRoot(container);
    await act(async () => { root.render(<VisualCanvas />); await vi.dynamicImportSettled(); });
    expect(button('Code').getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('.st-codeview')).toBeTruthy();
  });

  it('shows a logic file as highlighted code, with no switch', async () => {
    useVFSStore.getState().batchCreateFiles([
      { path: 'ui/main.ui', content: ui },
      { path: 'logic/main.py', content: 'goal = 3\n' },
    ], 'user');
    useWorkspaceStore.getState().setActiveFilePath('logic/main.py');
    await act(async () => { root.render(<VisualCanvas />); await vi.dynamicImportSettled(); });
    expect(container.querySelector('.st-codeview-lang')?.textContent).toBe('Python');
    expect([...container.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Code')).toBe(false);
  });
});
