/** @vitest-environment jsdom */
import { act, type PropsWithChildren } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SoftNRendererProps } from '@softn/core';
import { VisualCanvas } from '../src/components/canvas/VisualCanvas';
import { useVFSStore, useWorkspaceStore } from '../src/stores';
import { READING_LIST } from '../src/examples/readingList';
import { READING_LIST_PYTHON } from '../src/examples/readingListPython';

const { register, rendered } = vi.hoisted(() => ({ register: vi.fn(), rendered: [] as SoftNRendererProps[] }));
vi.mock('@softn/components', () => ({
  registerAllBuiltins: register,
  ThemeProvider: ({ children }: PropsWithChildren) => children,
}));
// The real core, for the composer and the asset registry the preview uses;
// only storage and the renderer itself are stood in for. The renderer records
// what it was handed, which is what these tests are about.
vi.mock('@softn/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@softn/core')>()),
  getXDB: () => { throw new Error('No persistent preview storage in this fixture'); },
  SoftNRenderer: (props: SoftNRendererProps) => {
    rendered.push(props);
    return <div data-testid="ready-preview">Rendered app</div>;
  },
}));

let root: Root;
let container: HTMLDivElement;
const source = '<style>.app { color: red; }</style><Text>App content</Text>';
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  register.mockReset();
  rendered.length = 0;
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

/** Replace the fixture's single file with a whole project, previewing its main. */
function openProject(files: Array<{ path: string; content: string }>): void {
  useVFSStore.getState().reset();
  useVFSStore.getState().batchCreateFiles(files, 'user');
  useWorkspaceStore.getState().setActiveFilePath('ui/main.ui');
}

describe('what the Studio preview hands the renderer', () => {
  it('gives a Python app its Python project and entry path, as Run does', async () => {
    openProject(READING_LIST_PYTHON.files);
    await act(async () => { root.render(<VisualCanvas />); await vi.dynamicImportSettled(); });
    expect(container.querySelector('[data-testid="ready-preview"]')).toBeTruthy();
    const props = rendered.at(-1)!;
    expect(props.python?.modules).toEqual(['shelf', 'main']);
    expect(props.logicBasePath).toBe('logic/main.py');
    expect(props.source).toMatch(/<logic>\n<\/logic>$/);
  });

  it('gives a JavaScript app its inlined logic and no Python project', async () => {
    openProject(READING_LIST.files);
    await act(async () => { root.render(<VisualCanvas />); await vi.dynamicImportSettled(); });
    const props = rendered.at(-1)!;
    expect(props.python).toBeUndefined();
    expect(props.logicBasePath).toBe('logic/main.logic');
    expect(props.source).toContain('let appName = "Reading list"');
  });

  it("shows the composer's refusal instead of rendering an app Run would stop on", async () => {
    openProject([{ path: 'ui/main.ui', content: '<logic src="../logic/gone.logic" />\n<Text>Hi</Text>' }]);
    await act(async () => { root.render(<VisualCanvas />); await vi.dynamicImportSettled(); });
    expect(container.querySelector('[data-testid="ready-preview"]')).toBeNull();
    expect(rendered).toEqual([]);
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('logic/gone.logic is referenced by ui/main.ui but is not in the bundle');
  });
});
