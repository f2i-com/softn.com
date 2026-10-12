/** @vitest-environment jsdom */
/**
 * An agent run whose changes the browser will not store.
 *
 * A run saves at every write and waits for the save at its finish, to learn
 * which files another tab changed too (agentTwoTabs.test.ts). What the save
 * itself came to was not looked at: storage full, or blocked, and the run was
 * told nothing, called finish and ended "Finished" over a project that was in
 * the tab's memory only. The run is told now, in the result of the write
 * whose save failed, and a finish over a project that is still not saved ends
 * the run as stopped, with the reason, never as finished.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installFakeIndexedDB } from '@softn/test-utils/fake-indexeddb';
import { startAgentRun } from '../src/lib/agent/runAgent';
import { beginNewProjectSession, getSaveStatus, startProjectAutosave, type AutosaveController } from '../src/lib/projectSession';
import { loadProjectRecord, saveProjectRecord, type SaveResult } from '../src/lib/persistence';
import { useWorkspaceStore } from '../src/stores/workspaceStore';
import type { AgentEnvironment } from '../src/lib/agent/appCheck';
import { ANTHROPIC, assertScriptsPassed, fakeProvider, lastRun, resetAgent, resultsIn, say, seedApp, text } from './helpers/agentHarness';

/** Checks that pass: what is under test is the saving, not the app. */
const passingChecks: AgentEnvironment = {
  checkApp: async () => ({ ok: true, errors: [], warnings: [], renderedHeadless: false }),
  inspectPreview: async () => ({ ok: true, text: '' }),
  runFunction: async () => ({ ok: true, text: '' }),
};

const FULL: SaveResult = { ok: false, reason: 'quota', message: 'This project is larger than the browser will store. Export the bundle to keep it.' };

let autosave: AutosaveController | null = null;
/** Whether the browser refuses the next saves, as a full disk does. */
let full = false;

beforeEach(async () => {
  resetAgent(ANTHROPIC, passingChecks);
  installFakeIndexedDB();
  localStorage.clear();
  full = false;
  beginNewProjectSession();
  seedApp();
  useWorkspaceStore.getState().setProjectName('Tasks');
  // Saves only when asked: the run's own saves are the ones under test.
  autosave = startProjectAutosave({
    debounceMs: 60_000,
    maxWaitMs: 60_000,
    save: (record, lastSeen, reconcile) => (full ? Promise.resolve(FULL) : saveProjectRecord(record, lastSeen, reconcile)),
  });
  expect(await autosave.flush()).toEqual({ ok: true });
});

afterEach(() => {
  assertScriptsPassed();
  autosave?.stop();
  autosave = null;
  resetAgent();
  delete (globalThis as unknown as { indexedDB?: unknown }).indexedDB;
});

const READ = { name: 'read_file', input: { path: 'ui/main.ui' } };
const EDIT = { name: 'edit_file', input: { path: 'ui/main.ui', old_string: '>Tasks<', new_string: '>Today<' } };
const finish = (summary: string) => ({ name: 'finish', input: { summary } });
const storedMain = async () => (await loadProjectRecord(useWorkspaceStore.getState().projectId!))?.files.find((f) => f.path === 'ui/main.ui')?.content;

describe('a run whose save the browser refuses', () => {
  it('is told in the result of the write, and its finish does not end the run as finished', async () => {
    full = true;
    const provider = fakeProvider('anthropic', [
      { calls: [READ, EDIT] },
      (body) => {
        const sent = resultsIn(body);
        expect(sent).toContain('The project could not be saved');
        expect(sent).toContain('larger than the browser will store');
        return { calls: [finish('Renamed the heading to Today. The project is not saved: the browser is out of room.')] };
      },
    ]);
    say('Call the heading Today');
    await startAgentRun();
    const { run } = lastRun();
    expect(provider.count()).toBe(2);
    expect(run.status).toBe('failed');
    expect(run.reason).toMatch(/not saved/);
    expect(run.reason).toContain('larger than the browser will store');
    // What the agent said is kept with the run.
    expect(run.summary).toMatch(/Renamed the heading to Today/);
    expect(text('ui/main.ui')).toContain('>Today<');
    expect(await storedMain()).toContain('>Tasks<');
    expect(getSaveStatus()).toMatchObject({ state: 'failed', reason: 'quota' });
  });

  it('ends as stopped at a finish in the same reply as the write', async () => {
    full = true;
    const provider = fakeProvider('anthropic', [
      { calls: [READ] },
      { calls: [EDIT, finish('Renamed the heading to Today.')] },
    ]);
    say('Call the heading Today');
    await startAgentRun();
    const { run } = lastRun();
    expect(provider.count()).toBe(2);
    expect(run.status).toBe('failed');
    expect(run.reason).toContain('larger than the browser will store');
  });

  it('is told when the save goes through again, and then finishes', async () => {
    full = true;
    const provider = fakeProvider('anthropic', [
      { calls: [READ, EDIT] },
      (body) => {
        expect(resultsIn(body)).toContain('The project could not be saved');
        full = false;
        return { calls: [{ name: 'edit_file', input: { path: 'ui/main.ui', old_string: '>Today<', new_string: '>Today’s tasks<' } }] };
      },
      (body) => {
        expect(resultsIn(body)).toContain('The project is saved now');
        return { calls: [finish('Renamed the heading to Today’s tasks.')] };
      },
    ]);
    say('Call the heading Today’s tasks');
    await startAgentRun();
    const { run } = lastRun();
    expect(provider.count()).toBe(3);
    expect(run.status).toBe('finished');
    expect(await storedMain()).toContain('>Today’s tasks<');
    expect(getSaveStatus()).toMatchObject({ state: 'saved' });
  });

  it('is told nothing about saving when the saves go through', async () => {
    const provider = fakeProvider('anthropic', [
      { calls: [READ, EDIT] },
      (body) => {
        expect(resultsIn(body)).not.toContain('could not be saved');
        return { calls: [finish('Renamed the heading to Today.')] };
      },
    ]);
    say('Call the heading Today');
    await startAgentRun();
    expect(provider.count()).toBe(2);
    expect(lastRun().run.status).toBe('finished');
    expect(await storedMain()).toContain('>Today<');
  });
});
