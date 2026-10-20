/** @vitest-environment jsdom */
import { act, type PropsWithChildren } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SoftNRendererProps } from '@softn/core';
import { VisualCanvas } from '../src/components/canvas/VisualCanvas';
import { useVFSStore, useWorkspaceStore } from '../src/stores';
import { READING_LIST } from '../src/examples/readingList';
import { READING_LIST_PYTHON } from '../src/examples/readingListPython';

const { register, rendered, themed } = vi.hoisted(() => ({ register: vi.fn(), rendered: [] as SoftNRendererProps[], themed: [] as Array<Record<string, unknown>> }));
// The preview registers components as the runtimes do (@softn/components/lazy)
// and takes the theme provider from the theme entry.
vi.mock('@softn/components/lazy', () => ({ registerRuntimeComponents: register }));
vi.mock('@softn/components/theme', () => ({
  ThemeProvider: ({ children, ...props }: PropsWithChildren<Record<string, unknown>>) => {
    themed.push(props);
    return children;
  },
}));
// The real core, for the composer and the asset registry the preview uses;
// only storage and the renderer itself are stood in for. The renderer records
// what it was handed, which is what these tests are about.
vi.mock('@softn/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@softn/core')>()),
  getXDB: () => { throw new Error('No persistent preview storage in this fixture'); },
  // The renderer the preview mounts: the one a runtime uses, which binds the page's <data> block.
  SoftNWithXDB: (props: SoftNRendererProps) => {
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
  themed.length = 0;
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

/** Replace the fixture's single file with a whole project, previewing its main (ui/main.ui when it names none). */
function openProject(files: Array<{ path: string; content: string }>): void {
  useVFSStore.getState().reset();
  useVFSStore.getState().batchCreateFiles(files, 'user');
  const manifest = files.find((f) => f.path === 'manifest.json');
  const main = manifest ? (JSON.parse(manifest.content) as { main?: string }).main : undefined;
  useWorkspaceStore.getState().setActiveFilePath(main ?? 'ui/main.ui');
}

describe('what the Studio preview hands the renderer', () => {
  it('gives a Python app its Python project and entry path, as Run does', async () => {
    openProject(READING_LIST_PYTHON.files);
    await act(async () => { root.render(<VisualCanvas />); await vi.dynamicImportSettled(); });
    expect(container.querySelector('[data-testid="ready-preview"]')).toBeTruthy();
    const props = rendered.at(-1)!;
    expect(props.python?.modules).toEqual(['shelf', 'main']);
    expect(props.logicBasePath).toBe('main.py');
    expect(props.source).toMatch(/<logic>\n<\/logic>$/);
  });

  it('gives a JavaScript app its inlined logic and no Python project', async () => {
    openProject(READING_LIST.files);
    await act(async () => { root.render(<VisualCanvas />); await vi.dynamicImportSettled(); });
    const props = rendered.at(-1)!;
    expect(props.python).toBeUndefined();
    expect(props.logicBasePath).toBe('main.js');
    expect(props.source).toContain('let appName = "Reading list"');
  });

  // The renderer's default is "worker", which without the bundle asking for one is the page's own
  // thread plus an advisory on the console: "scriptExecutionMode="worker" without forceWorker runs
  // scripts on the main thread … Set forceWorker for untrusted or long-running code". It was
  // printed at every start of every preview, and a check running at that moment collected it
  // and handed it to the agent as a warning about the person's app. The preview runs the logic
  // on this thread (the engine's step count is what ends a call that never returns, see
  // previewFaults.test.tsx), so it asks for that, as the check's own render always has.
  it('asks for the app’s logic to run on this thread, which is where it runs, so nothing is advised', async () => {
    for (const project of [READING_LIST.files, READING_LIST_PYTHON.files]) {
      openProject(project);
      await act(async () => { root.render(<VisualCanvas />); await vi.dynamicImportSettled(); });
      expect(rendered.at(-1)!.scriptExecutionMode).toBe('main');
    }
  });

  // The runtimes draw an app on the side its project declares (manifest.json's
  // `config.theme.mode`), unless its page pins one with `<App theme>`. Studio writes that key
  // into every app it scaffolds and then drew the preview by its own light or dark, whichever
  // the person had the editor in: a page with no theme of its own, in a project declared dark,
  // was light here in a light Studio and dark everywhere it was run.
  // The rule itself is the runtimes' (@softn/components, theme/app-theme.ts), so the preview
  // hands the provider what a runtime hands it and decides nothing of its own: the mode as the
  // manifest has it, and Studio as the host to follow where the project declares no side. It
  // must not pass `darkMode`: that is an editor's switch, which outranks a page's own live
  // `<App theme>`, and Studio has no such switch. The preview is one box in Studio's document,
  // so a declared side is written on that box and not on Studio's own page.
  it('hands the theme provider the project’s declared mode and Studio as the host, and no switch of its own', async () => {
    const project = (mode: unknown) => [
      { path: 'manifest.json', content: JSON.stringify({ name: 'Notes', version: '1.0.0', main: 'ui/main.ui', ...(mode === undefined ? {} : { config: { theme: { mode } } }) }) },
      { path: 'ui/main.ui', content: '<App>\n  <Text>Notes</Text>\n</App>\n' },
    ];
    for (const mode of ['dark', 'light', 'system', undefined, 'sepia']) {
      themed.length = 0;
      openProject(project(mode));
      await act(async () => { root.render(<VisualCanvas />); await vi.dynamicImportSettled(); });
      const props = themed.at(-1)!;
      // As written, a missing mode included: nothing is made up for a project that declares none.
      expect(props.declaredMode, String(mode)).toBe(mode);
      expect(props.followHost).toBe(true);
      expect(props.followSystem).toBe(true);
      expect('darkMode' in props).toBe(false);
      expect(typeof props.box).toBe('string');
      expect(container.querySelector(`[data-softn-theme-box="${String(props.box)}"] [data-testid="ready-preview"]`)).toBeTruthy();
    }
  });

  // A bundle file drawn from its bare path (`<Image src="assets/logo.png" />`) is not loaded
  // by any runtime: `asset("assets/logo.png")` is what resolves it. The preview rewrote every
  // quoted "assets/…" that named a file into a data: URL before the page was parsed, so the
  // picture drew here and was broken everywhere the app was run. The page is handed over as
  // it is written; `asset()` and the components that ask the host for a bundle file resolve
  // through the resolver, as they do in a runtime.
  it('hands the page over with its asset paths as written, and resolves them where a runtime does', async () => {
    openProject([
      { path: 'manifest.json', content: JSON.stringify({ name: 'Notes', version: '1.0.0', main: 'ui/main.ui' }) },
      { path: 'ui/main.ui', content: '<App>\n  <Image src="assets/logo.svg" />\n  <Image src={asset("assets/" + name + ".svg")} />\n</App>\n' },
      { path: 'assets/logo.svg', content: '<svg xmlns="http://www.w3.org/2000/svg" />' },
    ]);
    await act(async () => { root.render(<VisualCanvas />); await vi.dynamicImportSettled(); });
    const props = rendered.at(-1)!;
    expect(props.source).toContain('<Image src="assets/logo.svg" />');
    expect(props.source).not.toContain('data:image');
    const asset = props.functions!.asset as (path: string) => string;
    expect(asset('assets/' + 'logo' + '.svg')).toMatch(/^data:image\/svg\+xml/);
    expect(props.assetResolver!('assets/logo.svg')).toMatch(/^data:image\/svg\+xml/);
    expect(props.assetResolver!('assets/gone.svg')).toBe('');
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
