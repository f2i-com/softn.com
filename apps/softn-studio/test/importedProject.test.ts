/**
 * An import opens with the chat showing: the first thing in it is the message
 * that says what was imported and what can be asked for next.
 *
 * The import asked for the AI panel with the call that toggles a panel: a
 * project that has just been reset already has the AI panel open, so the call
 * closed it. Every import opened on the preview alone, with the message that
 * was written for the person behind a rail button.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { openImportedInStores } from '../src/lib/importedProject';
import { useAIStore, useVFSStore, useWorkspaceStore } from '../src/stores';

const FILES = [
  { path: 'manifest.json', content: JSON.stringify({ name: 'Tasks', version: '1.0.0', main: 'ui/main.ui', files: { ui: ['ui/main.ui'] } }) },
  { path: 'ui/main.ui', content: '<App><Text>Tasks</Text></App>' },
];

beforeEach(() => {
  useWorkspaceStore.getState().reset();
  useVFSStore.getState().reset();
  useAIStore.getState().resetSession();
});

describe('opening an imported project', () => {
  // The project took the file's name, whatever the app inside was called: a second download
  // of Counter Club opened as "Counter Club (1)", and one renamed to backup.softn as "backup".
  it('is named as its manifest names the app, and by its file only when the manifest gives no name', () => {
    const named = (name: unknown) => [{ path: 'manifest.json', content: JSON.stringify({ name, version: '1.0.0', main: 'ui/main.ui' }) }, FILES[1]];
    openImportedInStores('Counter Club (1).softn', named('Counter Club'));
    expect(useWorkspaceStore.getState().projectName).toBe('Counter Club');
    // The message still names the file that was chosen.
    expect(useAIStore.getState().messages[0].content).toMatch(/^Imported `Counter Club \(1\)\.softn`/);

    for (const missing of ['', '   ', 42, null]) {
      openImportedInStores('backup.softn', named(missing));
      expect(useWorkspaceStore.getState().projectName, JSON.stringify(missing)).toBe('backup');
    }
    openImportedInStores('pages.zip', [FILES[1]]);
    expect(useWorkspaceStore.getState().projectName).toBe('pages');
    openImportedInStores('broken.softn', [{ path: 'manifest.json', content: '{ not json' }, FILES[1]]);
    expect(useWorkspaceStore.getState().projectName).toBe('broken');
  });

  it('takes the name its opener gives it, when a host opens the app under its own name for it', () => {
    openImportedInStores('app-1234.softn', FILES, { name: 'Tasks for the team' });
    expect(useWorkspaceStore.getState().projectName).toBe('Tasks for the team');
  });

  it('shows the chat, with the message that says what was imported', () => {
    openImportedInStores('tasks.softn', FILES);
    const ws = useWorkspaceStore.getState();
    expect(ws.projectName).toBe('Tasks');
    expect([...useVFSStore.getState().files.keys()].sort()).toEqual(['manifest.json', 'ui/main.ui']);
    expect(useAIStore.getState().messages.map((m) => m.content)).toEqual([expect.stringMatching(/^Imported `tasks\.softn` and mapped 1 page\(s\)\./)]);
    expect(ws.leftPanel).toBe('ai');
    expect(ws.leftPanelExpanded).toBe(true);
  });

  it('shows the chat whichever panel the project before it had open', () => {
    useWorkspaceStore.getState().setLeftPanel('history');
    openImportedInStores('tasks.softn', FILES);
    expect(useWorkspaceStore.getState().leftPanel).toBe('ai');
    expect(useWorkspaceStore.getState().leftPanelExpanded).toBe(true);
  });
});
