/**
 * A new app starts with the template it was made from, in its entry file.
 * The template used to reach only the canvas, which the workspace reloads
 * from the (just reset, empty) entry file, so every template came out blank.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from '@softn/core';
import { useCanvasStore } from '../stores/canvasStore';
import { useFilesStore } from '../stores/filesStore';
import { useProjectStore } from '../stores/projectStore';
import { startNewProject } from './newProject';
import { EDITORIAL_PROPS } from './componentRegistryContract';
import { generateSource } from './sourceGenerator';
import { parseSource } from './sourceParser';
import { TEMPLATES, type NewProjectConfig } from '../components/toolbar/NewProjectDialog';

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

/**
 * A starter is made of components, and gives each only what it takes.
 *
 * The Dashboard gave its cards `titleField` and `descriptionField` and its
 * list `titleField` and `subtitleField`: names from before the components
 * were renamed (utils/propMigrations.ts knows them as old), which SmartCards
 * and SmartList do not read. The page said which fields to show and showed
 * the components' defaults. Every starter the dialog offers is held to
 * component-manifest.json, which is made from the components' sources.
 */
describe('what a starter gives its components', () => {
  type Member = { name: string; type: { kind: string; options?: string[] } };
  const manifestPath = fileURLToPath(new URL('../../../../packages/@softn/components/component-manifest.json', import.meta.url));
  const manifest: { components: { name: string; props: { members: Member[] } | null }[] } = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const membersOf = new Map(manifest.components.map((c) => [c.name, new Map((c.props?.members ?? []).map((m) => [m.name, m]))]));

  /** The elements of the entry file a starter made, less the page itself. */
  function made(template: NewProjectConfig['template']) {
    startNewProject(config({ template }));
    const files = useFilesStore.getState();
    const file = files.uiFiles.get(files.activeFileId!)!;
    return [...file.elements.values()].filter((el) => el.id !== file.rootId);
  }

  it('covers every starter the dialog offers', () => {
    expect(TEMPLATES.map((t) => t.key).sort()).toEqual(['blank', 'dashboard', 'landing']);
  });

  it.each(TEMPLATES.map((t) => t.key))('is, for the %s starter, only props the component declares, with a choice it accepts', (template) => {
    const wrong: string[] = [];
    for (const element of made(template)) {
      const members = membersOf.get(element.componentType);
      if (!members) {
        wrong.push(`${element.componentType}: not a component of the manifest`);
        continue;
      }
      for (const [name, value] of Object.entries(element.props)) {
        const member = members.get(name);
        if (!member) {
          if (!EDITORIAL_PROPS.has(name)) wrong.push(`${element.componentType}.${name}: the component does not declare it`);
          continue;
        }
        const plain = !(element.expressionProps ?? []).includes(name);
        if (plain && member.type.kind === 'enum' && !(member.type.options ?? []).includes(String(value))) {
          wrong.push(`${element.componentType}.${name}: ${JSON.stringify(value)} is not one of ${(member.type.options ?? []).join(', ')}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it.each(TEMPLATES.map((t) => t.key))('is, for the %s starter, a page that reads back as it was written', (template) => {
    made(template);
    const canvas = useCanvasStore.getState();
    const source = generateSource(canvas.elements, canvas.rootId, '');
    expect(parse(source).diagnostics ?? [], source).toEqual([]);
    const again = parseSource(source);
    expect(generateSource(again.elements, again.rootId, '')).toBe(source);
  });

  it('names, for the Dashboard, the fields its cards and its list show', () => {
    const byType = new Map(made('dashboard').map((el) => [el.componentType, el]));
    expect(byType.get('SmartCards')!.props).toMatchObject({ title: 'title', description: 'description' });
    expect(byType.get('SmartList')!.props).toMatchObject({ primary: 'title', secondary: 'status' });
  });

  // It ran as a heading over "No items to display", twice, and no stat tiles.
  it('gives the Dashboard something to show: figures, and example rows that have the fields named', () => {
    const byType = new Map(made('dashboard').map((el) => [el.componentType, el]));
    expect(byType.get('SmartStats')!.props.stats).toBe('Open: 12, Done: 30, Overdue: 2');
    for (const [type, fields] of [['SmartCards', ['title', 'description']], ['SmartList', ['title', 'status']]] as const) {
      const element = byType.get(type)!;
      expect(element.expressionProps).toEqual(['data']);
      const rows = String(element.props.data);
      expect(rows.startsWith('[') && rows.endsWith(']'), rows).toBe(true);
      for (const field of fields) expect(rows).toContain(`${field}:`);
    }
  });
});
