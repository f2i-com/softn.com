/**
 * A new app starts with the template it was made from, in its entry file.
 * The template used to reach only the canvas, which the workspace reloads
 * from the (just reset, empty) entry file, so every template came out blank.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { useCanvasStore } from '../stores/canvasStore';
import { useFilesStore } from '../stores/filesStore';
import { useProjectStore } from '../stores/projectStore';
import { startNewProject } from './newProject';
import type { NewProjectConfig } from '../components/toolbar/NewProjectDialog';

const config = (overrides: Partial<NewProjectConfig> = {}): NewProjectConfig => ({
  name: 'Shop',
  description: '',
  theme: 'dark',
  template: 'landing',
  language: 'javascript',
  pythonPackages: [],
  ...overrides,
});

/** The component types in the active UI file — what the canvas reloads from. */
function entryFileTypes(): string[] {
  const files = useFilesStore.getState();
  const file = files.activeFileId ? files.uiFiles.get(files.activeFileId) : undefined;
  return [...(file?.elements?.values() ?? [])].map((el) => el.componentType);
}

beforeEach(() => {
  useFilesStore.getState().reset();
  useCanvasStore.getState().reset();
  useProjectStore.getState().reset();
});

describe('starting a new app', () => {
  it('leaves a blank app with the root and nothing else', () => {
    startNewProject(config({ template: 'blank' }));
    expect(entryFileTypes()).toEqual(['App']);
  });

  it.each([
    ['landing', ['Stack', 'Heading', 'Text', 'Button']],
    ['dashboard', ['Stack', 'Heading', 'SmartStats', 'SmartCards', 'SmartList']],
  ] as const)('writes the %s template into the entry file', (template, types) => {
    startNewProject(config({ template }));
    const inFile = entryFileTypes();
    for (const type of types) expect(inFile).toContain(type);
  });

  it('keeps the chosen theme on the root and the project unsaved', () => {
    startNewProject(config({ theme: 'light', name: 'Notes' }));
    const canvas = useCanvasStore.getState();
    expect(canvas.getElement(canvas.rootId)?.props.theme).toBe('light');
    const project = useProjectStore.getState();
    expect(project.name).toBe('Notes');
    expect(project.isDirty).toBe(true);
  });

  it('makes a Python app with torch when asked', () => {
    startNewProject(config({ language: 'python', pythonPackages: ['torch'] }));
    const logicPaths = [...useFilesStore.getState().logicFiles.values()].map((file) => file.path);
    expect(logicPaths).toContain('logic/main.py');
    expect(useProjectStore.getState().pythonPackages).toEqual(['torch']);
  });
});
