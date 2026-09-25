/** @vitest-environment jsdom */
/**
 * torch, from the brief to the preview.
 *
 * A Python app may use the runtime's torch once manifest.json asks for it:
 * `"config": { "python": { "packages": ["torch"] } }`, and core's composer
 * refuses an `import torch` the manifest does not declare. Pinned here: the
 * wizard offers torch for Python only and the scaffold writes the
 * declaration (a JavaScript brief never gets one); a brief saved before the
 * choice still loads; export keeps `config.python`; the prompt teaches torch
 * to a project that declares it and names the declaration to one that does
 * not, while a JavaScript prompt is untouched; and the preview's refusal
 * offers "Enable torch", which edits manifest.json as one undoable change.
 */

import { act, type PropsWithChildren } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SoftNRendererProps } from '@softn/core';
import { BriefWizard } from '../src/components/brief/BriefWizard';
import { VisualCanvas } from '../src/components/canvas/VisualCanvas';
import { READING_LIST } from '../src/examples/readingList';
import { buildSystemPromptWithRecord, PYTHON_TORCH_SECTION, PYTHON_TORCH_UNDECLARED } from '../src/lib/agentOrchestrator';
import { normalizeManifestForBundle } from '../src/lib/exportBundle';
import { isPersistedWorkspace } from '../src/lib/persistence';
import {
  declarePythonPackage,
  generateBlueprintFromBrief,
  projectPythonPackages,
  scaffoldProjectFiles,
  undeclaredPythonPackage,
} from '../src/lib/studioProject';
import { useVFSStore, useWorkspaceStore } from '../src/stores';
import type { ProjectBrief, VFSFile } from '../src/types/studio';

const { rendered } = vi.hoisted(() => ({ rendered: [] as SoftNRendererProps[] }));
vi.mock('@softn/components', () => ({
  registerAllBuiltins: () => {},
  ThemeProvider: ({ children }: PropsWithChildren) => children,
}));
vi.mock('@softn/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@softn/core')>()),
  getXDB: () => { throw new Error('No persistent preview storage in this fixture'); },
  SoftNRenderer: (props: SoftNRendererProps) => {
    rendered.push(props);
    return <div data-testid="ready-preview">Rendered app</div>;
  },
}));

const BRIEF: ProjectBrief = {
  appName: 'Fit a line',
  description: 'Train y = 2x + 1 with one linear layer.',
  target: 'web',
  pages: ['Home'],
  collections: [],
  authNeeded: false,
  style: 'clean',
  logicLanguage: 'python',
  referenceImages: [],
};

const toVfs = (files: Array<{ path: string; content: string }>) =>
  new Map<string, VFSFile>(
    files.map((f) => [f.path, { path: f.path, content: f.content, mimeType: 'text/plain', lastModified: 0, lastModifiedBy: 'user', version: 1 }]),
  );

const manifestOf = (files: Array<{ path: string; content: string }>) =>
  JSON.parse(files.find((f) => f.path === 'manifest.json')!.content) as { config: Record<string, unknown> };

const TORCH_APP = [
  {
    path: 'manifest.json',
    content: JSON.stringify({ name: 'Fit', version: '1.0.0', main: 'ui/main.ui', files: { ui: ['ui/main.ui'], logic: ['logic/main.py'], xdb: [], assets: [] }, config: { theme: { mode: 'light' } } }, null, 2),
  },
  { path: 'ui/main.ui', content: '<logic src="../logic/main.py" />\n\n<App title="Fit">\n  <Text>{loss}</Text>\n</App>\n' },
  { path: 'logic/main.py', content: 'import torch\n\nloss = 0.0\n' },
];

let root: Root | null = null;
let container: HTMLDivElement;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
  rendered.length = 0;
  useWorkspaceStore.getState().reset();
  useVFSStore.getState().reset();
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  container.remove();
});

describe('the scaffold', () => {
  it('declares torch in manifest.json for a Python brief that uses it, and keeps the rest of config', () => {
    const brief = { ...BRIEF, pythonPackages: ['torch'] };
    const files = scaffoldProjectFiles(brief, generateBlueprintFromBrief(brief));
    const manifest = manifestOf(files);
    expect(manifest.config.python).toEqual({ packages: ['torch'] });
    expect(manifest.config.theme).toBeDefined();
    expect(projectPythonPackages(toVfs(files))).toEqual(['torch']);
  });

  it('declares nothing for a Python brief without it, or for a JavaScript brief that somehow has it', () => {
    for (const brief of [BRIEF, { ...BRIEF, logicLanguage: 'javascript' as const, pythonPackages: ['torch'] }]) {
      const files = scaffoldProjectFiles(brief, generateBlueprintFromBrief(brief));
      expect(manifestOf(files).config.python).toBeUndefined();
    }
  });
});

describe('the brief', () => {
  const workspace = {
    projectName: 'Fit', projectId: 'a', blueprint: null, taskGraph: [], blueprintApproved: true, mode: 'design',
    leftPanel: 'ai', leftPanelExpanded: true, rightSidebarOpen: true, bottomDrawerOpen: false, bottomTab: 'log',
    advancedMode: false, activePageId: null, activeFilePath: null, selectedComponentId: null, devicePreset: 'desktop',
    zoom: 100, themePreview: 'dark', consoleOutput: [],
  };
  const { referenceImages: _images, ...saved } = BRIEF;

  it('keeps the choice, and a brief saved before it existed still loads', () => {
    expect(isPersistedWorkspace({ ...workspace, brief: saved })).toBe(true);
    expect(isPersistedWorkspace({ ...workspace, brief: { ...saved, pythonPackages: ['torch'] } })).toBe(true);
    expect(isPersistedWorkspace({ ...workspace, brief: { ...saved, pythonPackages: 'torch' } })).toBe(false);
  });

  it('is offered in the wizard for Python only, and a generated project declares it', () => {
    useWorkspaceStore.getState().setBrief(BRIEF);
    root = createRoot(container);
    act(() => root!.render(<BriefWizard onBack={() => {}} onSubmit={() => {}} />));
    const button = (text: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(text));
    act(() => button('Next')!.click());

    const torch = button('Uses machine learning')!;
    expect(torch.getAttribute('aria-pressed')).toBe('false');
    act(() => torch.click());
    expect(button('Uses machine learning')!.getAttribute('aria-pressed')).toBe('true');

    act(() => button('JavaScript')!.click());
    expect(button('Uses machine learning')).toBeUndefined();
    act(() => button('Python')!.click());
    expect(button('Uses machine learning')!.getAttribute('aria-pressed')).toBe('true');

    act(() => button('Next')!.click());
    act(() => button('Generate')!.click());
    expect(useWorkspaceStore.getState().brief?.pythonPackages).toEqual(['torch']);
    const manifest = useVFSStore.getState().files.get('manifest.json')!.content as string;
    expect(JSON.parse(manifest).config.python).toEqual({ packages: ['torch'] });
  });
});

describe('export', () => {
  it('keeps config.python in the bundle manifest', () => {
    const files = toVfs(TORCH_APP.map((f) => (f.path === 'manifest.json' ? { ...f, content: declarePythonPackage(f.content, 'torch')! } : f)));
    const manifest = JSON.parse(normalizeManifestForBundle(files)!);
    expect(manifest.config.python).toEqual({ packages: ['torch'] });
    expect(manifest.config.theme).toEqual({ mode: 'light' });
  });
});

describe('the prompt', () => {
  it('teaches torch to a Python project that declares it', () => {
    const files = TORCH_APP.map((f) => (f.path === 'manifest.json' ? { ...f, content: declarePythonPackage(f.content, 'torch')! } : f));
    useVFSStore.getState().batchCreateFiles(files, 'user');
    const { system } = buildSystemPromptWithRecord();
    expect(system).toContain(PYTHON_TORCH_SECTION);
    expect(system).not.toContain(PYTHON_TORCH_UNDECLARED);
    expect(system).toMatch(/loss = float\(current\)/);
    expect(system).toMatch(/torch\.compile/);
  });

  it('tells a Python project without the declaration that it needs one', () => {
    useVFSStore.getState().batchCreateFiles(TORCH_APP, 'user');
    const { system } = buildSystemPromptWithRecord();
    expect(system).toContain(PYTHON_TORCH_UNDECLARED);
    expect(system).not.toContain(PYTHON_TORCH_SECTION);
  });

  it('leaves a JavaScript prompt exactly as it was, whatever the brief says about packages', () => {
    useVFSStore.getState().batchCreateFiles(READING_LIST.files, 'user');
    const plain = buildSystemPromptWithRecord().system;
    expect(plain).not.toMatch(/torch/);
    useWorkspaceStore.getState().setBrief({ ...BRIEF, logicLanguage: 'javascript', pythonPackages: ['torch'] });
    const withBrief = buildSystemPromptWithRecord().system;
    useWorkspaceStore.getState().setBrief({ ...BRIEF, logicLanguage: 'javascript' });
    expect(withBrief).toBe(buildSystemPromptWithRecord().system);
    expect(withBrief).not.toMatch(/torch/);
  });
});

describe('the declaration helpers', () => {
  it('add torch without losing the manifest, once, and refuse what is not a package or not JSON', () => {
    const text = TORCH_APP[0].content;
    const next = declarePythonPackage(text, 'torch')!;
    expect(JSON.parse(next).config).toEqual({ theme: { mode: 'light' }, python: { packages: ['torch'] } });
    expect(declarePythonPackage(next, 'torch')).toBe(next);
    expect(declarePythonPackage(text, 'numpy')).toBeNull();
    expect(declarePythonPackage('not json', 'torch')).toBeNull();
  });

  it("recognise the composer's refusal for an undeclared package and nothing else", () => {
    expect(undeclaredPythonPackage('logic/main.py imports torch, which an app asks for in manifest.json: "config": { "python": { "packages": ["torch"] } }')).toBe('torch');
    expect(undeclaredPythonPackage('logic/gone.logic is referenced by ui/main.ui but is not in the bundle')).toBeNull();
  });
});

describe('the preview', () => {
  it('offers Enable torch on the refusal, and the fix is one undoable edit to manifest.json', async () => {
    useVFSStore.getState().batchCreateFiles(TORCH_APP, 'user');
    useWorkspaceStore.getState().setActiveFilePath('ui/main.ui');
    root = createRoot(container);
    await act(async () => { root!.render(<VisualCanvas />); await vi.dynamicImportSettled(); });

    const alert = container.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain('imports torch');
    expect(rendered).toEqual([]);
    const enable = [...alert.querySelectorAll('button')].find((b) => b.textContent === 'Enable torch')!;
    expect(enable).toBeDefined();

    await act(async () => { enable.click(); await vi.dynamicImportSettled(); });
    const manifest = useVFSStore.getState().files.get('manifest.json')!.content as string;
    expect(JSON.parse(manifest).config.python).toEqual({ packages: ['torch'] });
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('[data-testid="ready-preview"]')).not.toBeNull();
    expect(rendered.at(-1)?.python?.packages).toEqual(['torch']);

    await act(async () => { useVFSStore.getState().undoLast(); await vi.dynamicImportSettled(); });
    expect(JSON.parse(useVFSStore.getState().files.get('manifest.json')!.content as string).config.python).toBeUndefined();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('imports torch');
  });
});
