/** @vitest-environment jsdom */
/**
 * An agent run in a tab whose project is open in another tab too.
 *
 * A save is merged with what the other tab saved (lib/projectMerge.ts), and a
 * file both tabs changed is not written over: storage keeps the other tab's
 * version and the status bar says so. The run was told nothing. A real run
 * edited a file the other tab had changed, its save kept the other tab's
 * copy, and the run ended "Done: Reset now says Start over." over a project
 * in which it did not. The run is told now, in the result of the write whose
 * save met the other tab's change, or at its finish, once per file.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installFakeIndexedDB } from '@softn/test-utils/fake-indexeddb';
import { startAgentRun } from '../src/lib/agent/runAgent';
import { beginNewProjectSession, getSaveStatus, startProjectAutosave, type AutosaveController } from '../src/lib/projectSession';
import { loadProjectRecord, saveProjectRecord } from '../src/lib/persistence';
import { useWorkspaceStore } from '../src/stores/workspaceStore';
import type { AgentEnvironment } from '../src/lib/agent/appCheck';
import { ANTHROPIC, APP, assertScriptsPassed, fakeProvider, lastRun, resetAgent, resultsIn, say, seedApp, text } from './helpers/agentHarness';

/** Checks that pass: what is under test is the saving, not the app. */
const passingChecks: AgentEnvironment = {
  checkApp: async () => ({ ok: true, errors: [], warnings: [], renderedHeadless: false }),
  inspectPreview: async () => ({ ok: true, text: '' }),
  runFunction: async () => ({ ok: true, text: '' }),
};

let autosave: AutosaveController | null = null;

beforeEach(async () => {
  resetAgent(ANTHROPIC, passingChecks);
  installFakeIndexedDB();
  localStorage.clear();
  beginNewProjectSession();
  seedApp();
  useWorkspaceStore.getState().setProjectName('Tasks');
  // Saves only when asked: the run's own saves are the ones under test.
  autosave = startProjectAutosave({ debounceMs: 60_000, maxWaitMs: 60_000 });
  expect(await autosave.flush()).toEqual({ ok: true });
});

afterEach(() => {
  assertScriptsPassed();
  autosave?.stop();
  autosave = null;
  resetAgent();
  delete (globalThis as unknown as { indexedDB?: unknown }).indexedDB;
});

/** The other tab, which opened the stored copy, changes ui/main.ui and saves. */
async function otherTabChangesMain(): Promise<string> {
  const id = useWorkspaceStore.getState().projectId!;
  const stored = (await loadProjectRecord(id))!;
  const files = stored.files.map((f) => (f.path === 'ui/main.ui' ? { ...f, content: APP.ui.replace('>Tasks<', '>Tasks, from the other tab<') } : f));
  expect(await saveProjectRecord({ ...stored, revision: stored.revision + 7, files }, stored.revision)).toEqual({ ok: true });
  return id;
}

const READ = { name: 'read_file', input: { path: 'ui/main.ui' } };
const EDIT = { name: 'edit_file', input: { path: 'ui/main.ui', old_string: '>Tasks<', new_string: '>Today<' } };
const finish = (summary: string) => ({ name: 'finish', input: { summary } });
const storedMain = async (id: string) => (await loadProjectRecord(id))?.files.find((f) => f.path === 'ui/main.ui')?.content;

describe('a run whose write meets another tab’s change to the same file', () => {
  it('is told in the result of that write, so that its summary can say so', async () => {
    const id = await otherTabChangesMain();
    const provider = fakeProvider('anthropic', [
      { calls: [READ, EDIT] },
      (body) => {
        const sent = resultsIn(body);
        expect(sent).toContain('ui/main.ui was also changed in another tab');
        expect(sent).toContain('storage kept the other tab’s version');
        return { calls: [finish('Renamed the heading to Today in this tab. ui/main.ui was also changed in another tab, so it is not saved here yet.')] };
      },
    ]);
    say('Call the heading Today');
    await startAgentRun();
    const { run } = lastRun();
    expect(provider.count()).toBe(2);
    expect(run.status).toBe('finished');
    expect(run.summary).toMatch(/not saved here yet/);
    // What the run said is so: this tab has its edit, storage has the other tab's.
    expect(text('ui/main.ui')).toContain('>Today<');
    expect(await storedMain(id)).toContain('>Tasks, from the other tab<');
    expect(getSaveStatus()).toMatchObject({ state: 'failed', reason: 'conflict', parts: 'ui/main.ui' });
  });

  it('is told at a finish in the same reply as the write, which is not accepted until it has been', async () => {
    await otherTabChangesMain();
    const provider = fakeProvider('anthropic', [
      { calls: [READ] },
      { calls: [EDIT, finish('Renamed the heading to Today.')] },
      (body) => {
        const sent = resultsIn(body);
        expect(sent).toContain('Not accepted yet: ui/main.ui was also changed in another tab');
        return { calls: [finish('Renamed the heading to Today here; ui/main.ui is not saved, because another tab changed it too.')] };
      },
    ]);
    say('Call the heading Today');
    await startAgentRun();
    const { run } = lastRun();
    expect(provider.count()).toBe(3);
    expect(run.status).toBe('finished');
    expect(run.summary).toMatch(/another tab changed it too/);
    const finishes = run.entries.filter((e) => e.kind === 'tool' && e.name === 'finish') as Array<{ status: string }>;
    expect(finishes.map((e) => e.status)).toEqual(['error', 'ok']);
  });

  it('is told nothing when the other tab changed a file the run did not write', async () => {
    const id = useWorkspaceStore.getState().projectId!;
    const stored = (await loadProjectRecord(id))!;
    const files = stored.files.map((f) => (f.path === 'logic/main.logic' ? { ...f, content: `${APP.logic}\n// from the other tab\n` } : f));
    await saveProjectRecord({ ...stored, revision: stored.revision + 7, files }, stored.revision);
    const provider = fakeProvider('anthropic', [
      { calls: [READ, EDIT] },
      (body) => {
        expect(resultsIn(body)).not.toContain('another tab');
        return { calls: [finish('Renamed the heading to Today.')] };
      },
    ]);
    say('Call the heading Today');
    await startAgentRun();
    expect(provider.count()).toBe(2);
    expect(lastRun().run.status).toBe('finished');
    expect(await storedMain(id)).toContain('>Today<');
    expect(text('logic/main.logic')).toContain('// from the other tab');
  });
});
