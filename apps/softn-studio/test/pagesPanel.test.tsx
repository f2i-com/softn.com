/** @vitest-environment jsdom */
/**
 * Clicking a blueprint page opens its file.
 *
 * The panel looked for `pages/<slug>` and `ui/<slug>.ui`, but the scaffold
 * writes `ui/pages/<slug>.ui`, so in every project Studio created the click
 * selected the page and opened nothing. The panel now asks the same helper
 * the scaffold writes with.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PagesPanel } from '../src/components/panels/PagesPanel';
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
    expect(ws.activeFilePath).toBe('ui/pages/team-settings.ui');
  });
});
