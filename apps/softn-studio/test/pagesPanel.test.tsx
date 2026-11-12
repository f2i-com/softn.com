/** @vitest-environment jsdom */
/**
 * Clicking a blueprint page opens its file.
 *
 * The panel looked for `pages/<slug>` and `ui/<slug>.ui`, but the scaffold
 * writes `pages/<slug>.html` (`ui/pages/<slug>.ui` before), so in every project Studio created the click
 * selected the page and opened nothing. The panel now asks the same helper
 * the scaffold writes with.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PagesPanel, pageRows } from '../src/components/panels/PagesPanel';
import { generateBlueprintFromBrief, scaffoldProjectFiles } from '../src/lib/studioProject';
import { useVFSStore, useWorkspaceStore } from '../src/stores';
import type { ProjectBrief } from '../src/types/studio';

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  useWorkspaceStore.getState().reset();
  useVFSStore.getState().reset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('the pages panel', () => {
  it('opens the file of a page in a project Studio scaffolded', () => {
    const brief: ProjectBrief = {
      appName: 'Club',
      description: 'A club app.',
      target: 'web',
      pages: ['Home', 'Team Settings'],
      collections: [],
      authNeeded: false,
      style: 'clean',
      referenceImages: [],
    };
    const blueprint = generateBlueprintFromBrief(brief);
    useVFSStore.getState().batchCreateFiles(scaffoldProjectFiles(brief, blueprint), 'ai');
    useWorkspaceStore.getState().setBlueprint(blueprint);

    act(() => root.render(<PagesPanel />));
    const button = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Team Settings'))!;
    expect(button).toBeTruthy();
    act(() => button.click());

    const ws = useWorkspaceStore.getState();
    expect(ws.activePageId).toBe(blueprint.pages[1].id);
    expect(ws.activeFilePath).toBe('pages/team-settings.html');
  });

  // The plan's pages, then "All pages" with every page file: each page of an app Studio made
  // was in the panel twice, once by its name and once by its file.
  it('lists each page once: the plan\'s pages with their files, then the files the plan does not list', () => {
    const brief: ProjectBrief = { appName: 'Club', description: 'A club app.', target: 'web', pages: ['Home', 'Team Settings'], collections: [], authNeeded: false, style: 'clean', referenceImages: [] };
    const blueprint = generateBlueprintFromBrief(brief);
    useVFSStore.getState().hydrateFiles([...scaffoldProjectFiles(brief, blueprint), { path: 'pages/extra.html', content: '<p>Extra</p>' }]);
    useWorkspaceStore.getState().setBlueprint(blueprint);

    act(() => root.render(<PagesPanel />));
    expect(container.textContent).not.toContain('All pages');
    const rows = [...container.querySelectorAll('ul[aria-label="Pages"] button')].map((b) => [...b.querySelectorAll('span')].map((s) => s.textContent));
    expect(rows).toEqual([
      ['Home', 'pages/home.html'],
      ['Team Settings', 'pages/team-settings.html'],
      ['extra.html', 'pages/extra.html'],
    ]);
    // The entry page is the card above the list, and not a row of it.
    expect(container.textContent).toContain('Entry page');
    expect(rows.flat()).not.toContain('index.html');
    // The canvas shows the entry page, so no row is lit until one is opened.
    expect(container.querySelector('[aria-current]')).toBeNull();
    expect(container.querySelector('[data-shown]')?.textContent).toContain('index.html');
    act(() => (container.querySelectorAll('ul[aria-label="Pages"] button')[2] as HTMLButtonElement).click());
    expect(useWorkspaceStore.getState().activeFilePath).toBe('pages/extra.html');
    expect(container.querySelector('[aria-current="page"]')?.textContent).toContain('extra.html');
    expect(container.querySelector('[data-shown]')).toBeNull();
  });

  it('a page in the plan that nothing has written yet is one row that says so', () => {
    expect(pageRows(new Map([['index.html', '']]), [{ id: 'p1', name: 'Scores', route: '/scores' }], 'index.html')).toEqual([
      { key: 'page:p1', name: 'Scores', path: null, pageId: 'p1', route: '/scores' },
    ]);
    // A project with no plan lists its page files, the entry page left to its card.
    expect(pageRows(new Map([['ui/main.ui', ''], ['ui/pages/a.ui', ''], ['logic/main.logic', '']]), [], 'ui/main.ui').map((r) => r.path)).toEqual(['ui/pages/a.ui']);
  });
});
