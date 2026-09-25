/** @vitest-environment jsdom */
/**
 * A project's logic language, from the brief to the model.
 *
 * Studio wrote JavaScript only: the brief had no choice, the scaffold always
 * wrote `logic/main.logic`, and the prompt taught `.logic` alone, so a model
 * asked to work on an imported Python app answered in JavaScript and the
 * result was refused for mixing languages. Pinned here: the choice is made in
 * the wizard and kept with the project (and a brief saved before it existed
 * still loads, as JavaScript); a Python brief scaffolds `logic/main.py`; an
 * existing project's language is read from its files; and the prompt teaches
 * Python's rules for a Python project while a JavaScript project's prompt is
 * the one it always had.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BriefWizard } from '../src/components/brief/BriefWizard';
import { openExampleInStores } from '../src/examples';
import { READING_LIST } from '../src/examples/readingList';
import { READING_LIST_PYTHON } from '../src/examples/readingListPython';
import { buildSystemPromptWithRecord } from '../src/lib/agentOrchestrator';
import { isPersistedWorkspace } from '../src/lib/persistence';
import { composePreviewProject } from '../src/lib/previewProject';
import { generateBlueprintFromBrief, projectLogicLanguage, scaffoldProjectFiles } from '../src/lib/studioProject';
import { validateProject } from '../src/lib/validator';
import { useVFSStore, useWorkspaceStore } from '../src/stores';
import type { ProjectBrief, VFSFile } from '../src/types/studio';

const BRIEF: ProjectBrief = {
  appName: 'Club "Quotes" \\ App',
  description: "Line one\nLine two, with 'quotes'",
  target: 'web',
  pages: ['Home', 'Members'],
  collections: ['Members'],
  authNeeded: false,
  style: 'clean',
  referenceImages: [],
};

const toVfs = (files: Array<{ path: string; content: string }>) =>
  new Map<string, VFSFile>(
    files.map((f) => [
      f.path,
      { path: f.path, content: f.content, mimeType: 'text/plain', lastModified: 0, lastModifiedBy: 'user', version: 1 },
    ]),
  );

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
  useWorkspaceStore.getState().reset();
  useVFSStore.getState().reset();
});

describe('the scaffold in each language', () => {
  it('writes logic/main.py for a Python brief: a bundle the validator passes and the preview composes as Python', () => {
    const brief: ProjectBrief = { ...BRIEF, logicLanguage: 'python' };
    const files = scaffoldProjectFiles(brief, generateBlueprintFromBrief(brief));
    const paths = files.map((f) => f.path);
    expect(paths).toContain('logic/main.py');
    expect(paths).not.toContain('logic/main.logic');

    const manifest = JSON.parse(files.find((f) => f.path === 'manifest.json')!.content);
    expect(manifest.files.logic).toEqual(['logic/main.py']);
    expect(files.find((f) => f.path === 'ui/main.ui')!.content).toContain('<logic src="../logic/main.py" />');

    const python = files.find((f) => f.path === 'logic/main.py')!.content;
    expect(python).toContain('def go(page_id):\n    # Assigning a module-level name needs `global`, or Python makes a local.\n    global page\n    page = page_id');
    // The brief's text is data, as a JSON string literal Python also reads.
    expect(python).toContain(`appName = ${JSON.stringify(BRIEF.appName)}`);

    const vfs = toVfs(files);
    expect(validateProject(vfs, null).filter((e) => e.level === 'error')).toEqual([]);
    const preview = composePreviewProject(vfs, 'ui/main.ui');
    expect(preview.ok && preview.composition.python?.modules).toEqual(['main']);
  });

  it('writes logic/main.logic, as before, for a JavaScript brief and for one that predates the choice', () => {
    for (const brief of [{ ...BRIEF, logicLanguage: 'javascript' as const }, BRIEF]) {
      const files = scaffoldProjectFiles(brief, generateBlueprintFromBrief(brief));
      expect(files.map((f) => f.path)).toContain('logic/main.logic');
      expect(files.map((f) => f.path)).not.toContain('logic/main.py');
      expect(files.find((f) => f.path === 'ui/main.ui')!.content).toContain('<logic src="../logic/main.logic" />');
    }
  });
});

describe("a project's language", () => {
  it('is what its logic files say, and the brief only when they cannot say', () => {
    expect(projectLogicLanguage(toVfs(READING_LIST_PYTHON.files))).toBe('python');
    expect(projectLogicLanguage(toVfs(READING_LIST.files), { logicLanguage: 'python' })).toBe('javascript');
    expect(projectLogicLanguage(new Map(), { logicLanguage: 'python' })).toBe('python');
    expect(projectLogicLanguage(new Map(), null)).toBe('javascript');
    // Private editor state is not the project's logic.
    expect(projectLogicLanguage(toVfs([{ path: 'builder/notes.py', content: 'x = 1\n' }]))).toBe('javascript');
  });

  it('is inferred for a project opened without a brief', () => {
    openExampleInStores(READING_LIST_PYTHON);
    expect(useWorkspaceStore.getState().brief?.logicLanguage).toBe('python');
  });

  it('is kept with the project, and a brief saved before the choice existed still loads', () => {
    const workspace = {
      projectName: 'Notes', projectId: 'a', blueprint: null, taskGraph: [], blueprintApproved: true, mode: 'design',
      leftPanel: 'ai', leftPanelExpanded: true, rightSidebarOpen: true, bottomDrawerOpen: false, bottomTab: 'log',
      advancedMode: false, activePageId: null, activeFilePath: null, selectedComponentId: null, devicePreset: 'desktop',
      zoom: 100, themePreview: 'dark', consoleOutput: [],
    };
    const { referenceImages: _images, ...saved } = BRIEF;
    expect(isPersistedWorkspace({ ...workspace, brief: saved })).toBe(true);
    expect(isPersistedWorkspace({ ...workspace, brief: { ...saved, logicLanguage: 'python' } })).toBe(true);
    expect(isPersistedWorkspace({ ...workspace, brief: { ...saved, logicLanguage: undefined } })).toBe(true);
    expect(isPersistedWorkspace({ ...workspace, brief: { ...saved, logicLanguage: 'ruby' } })).toBe(false);
  });
});

describe('the prompt in each language', () => {
  it('teaches Python and its rules for a Python project', () => {
    useVFSStore.getState().batchCreateFiles(READING_LIST_PYTHON.files, 'user');
    const { system } = buildSystemPromptWithRecord();
    expect(system).toContain('## Python logic (.py)');
    expect(system).toContain('<logic src="../logic/main.py" />');
    expect(system).toMatch(/No inline Python/);
    expect(system).toMatch(/One language per app/);
    expect(system).toMatch(/Handlers use `global`/);
    expect(system).toContain('Reserved, and refused as file names: `softn`, any name starting `__softn`, `json`, `math`');
    expect(system).toContain('lists every .ui, .py, .xdb and asset');
    expect(system).not.toContain('## .logic Syntax');
    expect(system).not.toContain('<import { formatDate } from="./utils.logic" />');
    // Two things rendering the Python example found: a handler named bare is
    // called with the event (a TypeError in a def without a parameter), and
    // only :bind writes an input back to state.
    expect(system).toMatch(/Call handlers with an arrow/);
    // No example hands an event a bare name; the rule's own warning is the one mention.
    expect(system.replace('Never hand an event a function by name (`@click={add_task}`)', '')).not.toMatch(/@(click|submit)=\{[a-z_]+\}/i);
    expect(system).toContain('<Input :bind={new_task}');
    expect(system).not.toMatch(/<(Input|Select) :value=/);
  });

  it('teaches Python for a new project whose brief chose it, before any logic exists', () => {
    useWorkspaceStore.getState().setBrief({ ...BRIEF, logicLanguage: 'python' });
    expect(buildSystemPromptWithRecord().system).toContain('## Python logic (.py)');
  });

  it('is the JavaScript prompt, with no Python in it, for a JavaScript project', () => {
    useVFSStore.getState().batchCreateFiles(READING_LIST.files, 'user');
    const { system } = buildSystemPromptWithRecord();
    expect(system).toContain('## .logic Syntax');
    expect(system).toContain('- **.logic** — JavaScript, run in a sandboxed VM. Imported by .ui files for shared logic.');
    expect(system).toContain('lists every .ui, .logic, .xdb and asset');
    expect(system).not.toMatch(/Python/);
  });
});

describe('the brief wizard', () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(text))!;

  it('offers the language, and a project generated in Python is scaffolded and briefed in Python', () => {
    useWorkspaceStore.getState().setBrief(BRIEF);
    act(() => root.render(<BriefWizard onBack={() => {}} onSubmit={() => {}} />));
    act(() => button('Next').click());

    const javascript = button('JavaScript');
    const python = button('Python');
    // A brief from before the choice shows JavaScript chosen.
    expect(javascript.getAttribute('aria-pressed')).toBe('true');
    expect(python.getAttribute('aria-pressed')).toBe('false');
    act(() => python.click());
    expect(button('Python').getAttribute('aria-pressed')).toBe('true');

    act(() => button('Next').click());
    act(() => button('Generate').click());
    expect(useWorkspaceStore.getState().brief?.logicLanguage).toBe('python');
    expect(useVFSStore.getState().files.has('logic/main.py')).toBe(true);
    expect(useVFSStore.getState().files.has('logic/main.logic')).toBe(false);
  });
});
