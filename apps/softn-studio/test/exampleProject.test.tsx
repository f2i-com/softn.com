/** @vitest-environment jsdom */
/**
 * The first-run path: a bundled example that ends in a runnable,
 * exportable project.
 *
 * The dashboard offered "Start with AI", which needs a provider key, and
 * "Import bundle", which needs a bundle; a first visit with neither had no
 * way to a project. Pinned here: the example opens into the stores as a
 * complete project whose manifest passes the validator with no error, so
 * Run and Export are enabled the way the bar computes them; the dashboard
 * offers it only when there is nothing recent, labelled as an example; and
 * the bundle it exports is a real archive the validator accepts again.
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dashboard } from '../src/components/layout/Dashboard';
import { useProjectActions } from '../src/components/common/ProjectActions';
import { DEFAULT_EXAMPLE, EXAMPLES, openExampleInStores } from '../src/examples';
import { buildBundle } from '../src/lib/exportBundle';
import { validateProject } from '../src/lib/validator';
import { useAIStore, useVFSStore, useWorkspaceStore } from '../src/stores';
import { inspectBundle } from '@softn/core';

let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  useWorkspaceStore.getState().reset();
  useVFSStore.getState().reset();
  useAIStore.setState({ messages: [] });
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  container.remove();
});

/** What the bar reads, captured from the hook on render. */
function probeActions(): ReturnType<typeof useProjectActions> {
  let seen: ReturnType<typeof useProjectActions> | null = null;
  const Probe: React.FC = () => {
    seen = useProjectActions();
    return null;
  };
  root = createRoot(container);
  act(() => root!.render(<Probe />));
  return seen!;
}

describe('the bundled example', () => {
  it('opens as a complete project whose manifest passes the validator, with Run and Export enabled', () => {
    const projectId = openExampleInStores();
    const ws = useWorkspaceStore.getState();
    const files = useVFSStore.getState().files;

    expect(ws.projectId).toBe(projectId);
    expect(ws.projectName).toMatch(/example/i);
    expect(files.size).toBe(DEFAULT_EXAMPLE.files.length);
    expect(files.has('manifest.json')).toBe(true);
    expect(files.has('permission.json')).toBe(true);
    // One import unit in the history, not one create per file.
    expect(new Set(useVFSStore.getState().history.map((e) => e.transactionId)).size).toBe(1);

    const errors = validateProject(files, ws.blueprint);
    expect(errors.filter((e) => e.level === 'error')).toEqual([]);
    // As App does after validation: the bar reads the workspace's errors.
    ws.clearErrors();
    for (const error of errors) ws.addError(error);

    const actions = probeActions();
    expect(actions.hasFiles).toBe(true);
    expect(actions.refused).toBe(false);
    expect(actions.canRun).toBe(true);
    expect(actions.canExport).toBe(true);
    expect(actions.canPublish).toBe(true);
  });

  it('exports as an archive the inspector accepts, with the manifest naming an entry that is there', () => {
    openExampleInStores();
    const bytes = buildBundle(useVFSStore.getState().files);
    const inspection = inspectBundle(bytes);
    expect(inspection.problem).toBeNull();
    expect(inspection.main).toBe('ui/main.ui');
    expect(inspection.name).toBe('Reading list');
    expect(inspection.files).toBe(DEFAULT_EXAMPLE.files.length);
  });

  it('every bundled example is labelled as one and has the files its manifest lists', () => {
    for (const example of EXAMPLES) {
      expect(example.name).toMatch(/example/i);
      const paths = new Set(example.files.map((f) => f.path));
      const manifest = JSON.parse(example.files.find((f) => f.path === 'manifest.json')!.content) as { main: string; files: Record<string, string[]> };
      expect(paths.has(manifest.main)).toBe(true);
      for (const group of Object.values(manifest.files)) for (const path of group) expect(paths.has(path)).toBe(true);
    }
  });
});

describe('the dashboard offers the example', () => {
  it('only when there is nothing recent, as a labelled button that opens it', () => {
    const onOpenExample = vi.fn();
    root = createRoot(container);
    act(() => root!.render(<Dashboard onNewProject={() => {}} onOpenExample={onOpenExample} recentProjects={[]} />));
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="Open an example project"]')!;
    expect(button).not.toBeNull();
    expect(button.textContent).toMatch(/Example/);
    act(() => button.click());
    expect(onOpenExample).toHaveBeenCalledTimes(1);

    act(() =>
      root!.render(
        <Dashboard
          onNewProject={() => {}}
          onOpenExample={onOpenExample}
          recentProjects={[{ id: 'a', name: 'Alpha', target: 'web', lastModified: 'today', saved: true, active: false }]}
        />,
      ),
    );
    expect(container.querySelector('button[aria-label="Open an example project"]')).toBeNull();
  });
});
