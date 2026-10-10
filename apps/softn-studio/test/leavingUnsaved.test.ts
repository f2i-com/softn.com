/** @vitest-environment jsdom */
/**
 * Closing the tab on a project that could not be saved asks first.
 *
 * When a save fails (the browser's storage full, blocked, or not answering)
 * the bar says "Not saved" and offers the export, and the project lives on in
 * the tab's memory alone. Closing or reloading the tab then lost it without a
 * word: the browser's own "leave this page?" was asked only for a file being
 * edited by hand. It is asked now whenever the last save failed and there is
 * a project to lose, and not otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectRecord, SaveResult } from '../src/lib/persistence';
import { beginNewProjectSession, startProjectAutosave, type AutosaveController } from '../src/lib/projectSession';
import { useAIStore, useVFSStore, useWorkspaceStore } from '../src/stores';

let autosave: AutosaveController | null = null;
let outcome: SaveResult = { ok: true };

beforeEach(() => {
  useAIStore.setState({ providers: [], activeProviderId: null, messages: [], agentState: 'idle', currentStep: '', iterationsUsed: 0, tokensUsed: 0, filesChanged: 0 });
  beginNewProjectSession();
  autosave = startProjectAutosave({ debounceMs: 5, save: async (_record: ProjectRecord) => outcome });
});

afterEach(() => {
  autosave?.stop();
  autosave = null;
  beginNewProjectSession();
});

/** Whether the browser would ask before the page is left. */
function asksBeforeLeaving(): boolean {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

describe('leaving the page', () => {
  it('is asked about when the project’s last save failed, and not once a later save has gone through', async () => {
    outcome = { ok: false, reason: 'quota', message: 'This project is larger than the browser will store. Export the bundle to keep it.' };
    useWorkspaceStore.getState().setProjectName('Notes');
    useVFSStore.getState().createFile('ui/main.ui', '<App />');
    await autosave!.flush();
    expect(asksBeforeLeaving()).toBe(true);

    outcome = { ok: true };
    useVFSStore.getState().updateFile('ui/main.ui', '<App theme="light" />', 'user');
    await autosave!.flush();
    expect(asksBeforeLeaving()).toBe(false);
  });

  it('is not asked about for a project that saved, or when there is no project', async () => {
    expect(asksBeforeLeaving()).toBe(false);
    outcome = { ok: true };
    useWorkspaceStore.getState().setProjectName('Notes');
    useVFSStore.getState().createFile('ui/main.ui', '<App />');
    await autosave!.flush();
    expect(asksBeforeLeaving()).toBe(false);
  });
});
