/** @vitest-environment jsdom */
/**
 * Two tabs on one project, each told when the other saves.
 *
 * A tab took in what another tab saved only at its own next save, so an
 * idle tab showed an old copy for as long as nobody touched it. A save is now
 * announced to the other tabs (a BroadcastChannel), and a tab with the
 * project open takes it in at once, by the same merge as a save
 * (lib/projectMerge.ts). A tab with nothing of its own to save only reads:
 * it never writes on hearing of a save, so two tabs cannot set each other
 * off. A tab with work not saved yet saves it, merged, once.
 *
 * Here tab A is the modules as imported, and tab B a second copy of them,
 * as a second page loads them; both use the one (fake) IndexedDB.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeIndexedDB } from '@softn/test-utils/fake-indexeddb';
import * as sessionA from '../src/lib/projectSession';
import { loadProjectRecord } from '../src/lib/persistence';
import { useAIStore as aiA, useVFSStore as vfsA, useWorkspaceStore as wsA } from '../src/stores';
import { ANTHROPIC, assertScriptsPassed, fakeProvider, resultsIn } from './helpers/agentHarness';

type Session = typeof sessionA;
type Stores = typeof import('../src/stores');

let tabA: sessionA.AutosaveController | null = null;
let tabB: sessionA.AutosaveController | null = null;
let B: { session: Session; stores: Stores };
let projectId: string;

beforeEach(async () => {
  installFakeIndexedDB();
  localStorage.clear();
  wsA.getState().reset();
  vfsA.getState().reset();
  aiA.setState({ providers: [], activeProviderId: null, messages: [], agentState: 'idle', iterationsUsed: 0, tokensUsed: 0, filesChanged: 0 });
  projectId = sessionA.beginNewProjectSession();
  wsA.getState().setProjectName('Notes');
  vfsA.getState().createFile('ui/main.ui', '<Text>Main</Text>');
  vfsA.getState().createFile('ui/about.ui', '<Text>About</Text>');
  // Saves only when asked, or when told of another tab's save: what is under test.
  tabA = sessionA.startProjectAutosave({ debounceMs: 60_000, maxWaitMs: 60_000, live: true });
  expect(await tabA.flush()).toEqual({ ok: true });

  // Tab B: the same project, opened from storage in a second copy of the modules.
  vi.resetModules();
  B = { session: await import('../src/lib/projectSession'), stores: await import('../src/stores') };
  B.session.applyProjectRecord((await loadProjectRecord(projectId))!);
  tabB = B.session.startProjectAutosave({ debounceMs: 60_000, maxWaitMs: 60_000, live: true });
});

afterEach(() => {
  tabA?.stop();
  tabB?.stop();
  tabA = tabB = null;
  delete (globalThis as unknown as { indexedDB?: unknown }).indexedDB;
});

/** Wait until `done` holds, or fail saying what was waited for. */
async function until(what: string, done: () => boolean | Promise<boolean>, ms = 2_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await done()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const stored = async (path: string) => (await loadProjectRecord(projectId))?.files.find((f) => f.path === path)?.content;
const storedRevision = async () => (await loadProjectRecord(projectId))?.revision;
const inB = (path: string) => B.stores.useVFSStore.getState().files.get(path)?.content;
const inA = (path: string) => vfsA.getState().files.get(path)?.content;
/** Long enough for any save one of the tabs would make to have been made and heard. */
const quiet = () => new Promise((r) => setTimeout(r, 300));

describe('a tab told of another tab’s save', () => {
  it('takes it in at once when idle, and writes nothing itself', async () => {
    vfsA.getState().updateFile('ui/main.ui', '<Text>Main, from tab A</Text>');
    expect(await tabA!.flush()).toEqual({ ok: true });
    const revision = await storedRevision();
    await until('tab B to take in tab A’s save', () => inB('ui/main.ui') === '<Text>Main, from tab A</Text>');
    await quiet();
    expect(await storedRevision()).toBe(revision);
    expect(B.session.getSaveStatus()).toMatchObject({ state: 'saved' });
  });

  it('takes in a new name, as any other part of the project', async () => {
    sessionA.renameProject('Field notes');
    expect(await tabA!.flush()).toEqual({ ok: true });
    await until('tab B to show the new name', () => B.stores.useWorkspaceStore.getState().projectName === 'Field notes');
  });

  it('saves its own work not saved yet once, merged, and the other tab then takes that in', async () => {
    B.stores.useVFSStore.getState().updateFile('ui/about.ui', '<Text>About, from tab B</Text>');
    vfsA.getState().updateFile('ui/main.ui', '<Text>Main, from tab A</Text>');
    expect(await tabA!.flush()).toEqual({ ok: true });
    await until('both changes to be stored', async () => (await stored('ui/about.ui')) === '<Text>About, from tab B</Text>' && (await stored('ui/main.ui')) === '<Text>Main, from tab A</Text>');
    await until('tab A to take in tab B’s save', () => inA('ui/about.ui') === '<Text>About, from tab B</Text>');
    expect(inB('ui/main.ui')).toBe('<Text>Main, from tab A</Text>');
    expect(inB('ui/about.ui')).toBe('<Text>About, from tab B</Text>');
    // And then nothing: neither tab sets the other off.
    const revision = await storedRevision();
    await quiet();
    expect(await storedRevision()).toBe(revision);
  });

  it('never writes over a change not saved yet to the same file: it names the conflict', async () => {
    B.stores.useVFSStore.getState().updateFile('ui/main.ui', '<Text>Main, from tab B</Text>');
    vfsA.getState().updateFile('ui/main.ui', '<Text>Main, from tab A</Text>');
    expect(await tabA!.flush()).toEqual({ ok: true });
    await until('tab B to say ui/main.ui conflicts', () => B.session.getSaveStatus().state === 'failed');
    expect(B.session.getSaveStatus()).toMatchObject({ reason: 'conflict', parts: 'ui/main.ui' });
    expect(inB('ui/main.ui')).toBe('<Text>Main, from tab B</Text>');
    expect(await stored('ui/main.ui')).toBe('<Text>Main, from tab A</Text>');
    const revision = await storedRevision();
    await quiet();
    expect(await storedRevision()).toBe(revision);
  });

  // A conflict kept tab B's main.ui out of storage. Tab A then puts its own back as it was
  // (an undo), so the merge now takes tab B's: taking the save in settled that merge without
  // writing it. Tab B said "Saved" over a storage that did not hold its file, and the next
  // save it heard of put the stored copy over the file in tab B as well.
  it('saves its own version of a part once the other tab has put its own back as it was', async () => {
    B.stores.useVFSStore.getState().updateFile('ui/main.ui', '<Text>Main, from tab B</Text>');
    vfsA.getState().updateFile('ui/main.ui', '<Text>Main, from tab A</Text>');
    expect(await tabA!.flush()).toEqual({ ok: true });
    await until('tab B to say ui/main.ui conflicts', () => B.session.getSaveStatus().state === 'failed');

    vfsA.getState().updateFile('ui/main.ui', '<Text>Main</Text>');
    expect(await tabA!.flush()).toEqual({ ok: true });
    await until('tab B to settle', () => B.session.getSaveStatus().state !== 'failed');
    await quiet();
    // "Saved" is so: what tab B holds is what is stored.
    expect(B.session.getSaveStatus()).toMatchObject({ state: 'saved' });
    expect(await stored('ui/main.ui')).toBe('<Text>Main, from tab B</Text>');

    // And a later save from tab A, of another file, does not take tab B's file from it.
    await until('tab A to take in tab B’s main.ui', () => inA('ui/main.ui') === '<Text>Main, from tab B</Text>');
    vfsA.getState().updateFile('ui/about.ui', '<Text>About, from tab A</Text>');
    expect(await tabA!.flush()).toEqual({ ok: true });
    await until('tab B to take in tab A’s about.ui', () => inB('ui/about.ui') === '<Text>About, from tab A</Text>');
    expect(inB('ui/main.ui')).toBe('<Text>Main, from tab B</Text>');
    expect(await stored('ui/main.ui')).toBe('<Text>Main, from tab B</Text>');
    const revision = await storedRevision();
    await quiet();
    expect(await storedRevision()).toBe(revision);
  });

  it('hears nothing of another project', async () => {
    const other = sessionA.beginNewProjectSession();
    wsA.getState().setProjectName('Elsewhere');
    vfsA.getState().createFile('ui/main.ui', '<Text>Elsewhere</Text>');
    expect(await tabA!.flush()).toEqual({ ok: true });
    expect(other).not.toBe(projectId);
    await quiet();
    expect(inB('ui/main.ui')).toBe('<Text>Main</Text>');
    expect(B.stores.useWorkspaceStore.getState().projectName).toBe('Notes');
  });
});

describe('a tab in the middle of an agent run, told of another tab’s save', () => {
  it('takes in the file, and the agent’s write to it is refused until the agent has read it again', async () => {
    const agent = await import('../src/lib/agent/runAgent');
    agent.setAgentEnvironment({
      checkApp: async () => ({ ok: true, errors: [], warnings: [], renderedHeadless: false }),
      inspectPreview: async () => ({ ok: true, text: '' }),
      runFunction: async () => ({ ok: true, text: '' }),
    });
    agent.setAgentSleep(async () => {});
    B.stores.useAIStore.setState({
      providers: [ANTHROPIC], activeProviderId: ANTHROPIC.id, modelProfile: { architect: '', builder: '', repair: '', vision: '' },
      maxIterations: 50, tokenBudget: 5_000_000, maxOutputTokens: 4_096, requestTimeoutMs: 60_000,
      agentSettings: { maxSteps: 40, runTokenBudget: 2_000_000, autoCheck: true, confirmDeletes: true },
    });
    let held: { release(): void } | null = null;
    const provider = fakeProvider('anthropic', [
      () => {
        held = provider.hold();
        return { calls: [{ name: 'read_file', input: { path: 'ui/main.ui' } }] };
      },
      { calls: [{ name: 'edit_file', input: { path: 'ui/main.ui', old_string: 'Main', new_string: 'Main, from tab B’s agent' } }] },
      (body) => {
        expect(resultsIn(body)).toContain('ui/main.ui changed since you read it');
        return { calls: [{ name: 'finish', input: { summary: 'Did not change it.' } }] };
      },
    ]);
    B.stores.useAIStore.getState().addMessage({ id: 'ask', role: 'user', content: 'Change the main page', timestamp: Date.now() });
    const run = agent.startAgentRun();
    // Tab A saves while tab B's run waits for its second reply.
    await until('tab B’s run to ask for its second reply', () => provider.bodies.length === 2);
    vfsA.getState().updateFile('ui/main.ui', '<Text>Main, from tab A</Text>');
    expect(await tabA!.flush()).toEqual({ ok: true });
    await until('tab B to take in tab A’s save', () => inB('ui/main.ui') === '<Text>Main, from tab A</Text>');
    held!.release();
    await run;
    assertScriptsPassed();
    expect(provider.count()).toBe(3);
    expect(inB('ui/main.ui')).toBe('<Text>Main, from tab A</Text>');
    await tabB!.flush();
    expect(await stored('ui/main.ui')).toBe('<Text>Main, from tab A</Text>');
    agent.discardAgentRuns();
  });
});

describe('a tab whose project another tab deletes', () => {
  // Deleted from the list in tab B while open in tab A. Tab A went on saying "Saved", and its
  // next change wrote the whole project back: the deletion was undone with no word to anyone.
  it('is told at once, writes nothing, and keeps the project only when the person says so', async () => {
    vfsA.getState().updateFile('ui/main.ui', '<Text>Main, from tab A</Text>');
    expect(await tabA!.flush()).toEqual({ ok: true });
    expect(await B.session.deleteProject(projectId)).toEqual({ ok: true });
    await until('tab A to be told', () => sessionA.getSaveStatus().state === 'failed');
    expect(sessionA.getSaveStatus()).toMatchObject({ reason: 'deleted', message: expect.stringMatching(/^Deleted in another tab\./) });
    // A change in tab A is not saved over the deletion.
    vfsA.getState().updateFile('ui/about.ui', '<Text>About, from tab A</Text>');
    expect(await tabA!.flush()).toMatchObject({ ok: false, reason: 'deleted' });
    expect(sessionA.getSaveStatus()).toMatchObject({ reason: 'deleted', message: expect.stringMatching(/^Deleted in another tab\./) });
    await quiet();
    expect(await loadProjectRecord(projectId)).toBeNull();
    expect(inA('ui/main.ui')).toBe('<Text>Main, from tab A</Text>');

    expect(await sessionA.keepDeletedProject()).toEqual({ ok: true });
    expect(sessionA.getSaveStatus().state).toBe('saved');
    expect(await stored('ui/main.ui')).toBe('<Text>Main, from tab A</Text>');
    expect(await stored('ui/about.ui')).toBe('<Text>About, from tab A</Text>');
  });

  it('says nothing to a tab with another project open', async () => {
    const other = sessionA.beginNewProjectSession();
    wsA.getState().setProjectName('Other');
    vfsA.getState().createFile('ui/main.ui', '<Text>Other</Text>');
    expect(await tabA!.flush()).toEqual({ ok: true });
    expect(await B.session.deleteProject(projectId)).toEqual({ ok: true });
    await quiet();
    expect(wsA.getState().projectId).toBe(other);
    expect(sessionA.getSaveStatus().state).toBe('saved');
  });
});
