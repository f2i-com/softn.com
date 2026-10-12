/** @vitest-environment jsdom */
/**
 * An agent run that another tab is working on.
 *
 * A run is a chat message, and a tab now takes in the chat another tab saves
 * as it is saved (lib/projectSession.ts). So a run working in one tab shows
 * in the other, step by step, and the other tab drives no such run: it was
 * shown there as "Stopped: this run stopped because the page reloaded", with
 * Continue, which starts a second agent on the same files while the first is
 * still working. A run is known to be working elsewhere by the lock its tab
 * holds for it (lib/agent/keepAlive.ts), and at once when a save of that
 * tab's brings it in.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeIndexedDB } from '@softn/test-utils/fake-indexeddb';
import { RunTimeline } from '../src/components/ai/RunTimeline';
import { continueInterruptedRun, wasInterrupted } from '../src/lib/agent/runAgent';
import { RUNS_ELSEWHERE_ASKED_EVERY_MS, holdPageForRun, releasePageForRun } from '../src/lib/agent/keepAlive';
import type { AgentRunRecord } from '../src/lib/agent/types';
import * as session from '../src/lib/projectSession';
import { loadProjectRecord } from '../src/lib/persistence';
import { useAIStore, useVFSStore, useWorkspaceStore } from '../src/stores';
import type { ChatMessage } from '../src/types/studio';
import { resetAgent, seedApp } from './helpers/agentHarness';

/** The locks held now, as every tab of the origin sees them. */
let heldLocks: string[];

function installLocks(): void {
  heldLocks = [];
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: (name: string, _options: unknown, callback: () => Promise<void>) => {
        heldLocks.push(name);
        return callback().then(() => {
          heldLocks = heldLocks.filter((held) => held !== name);
        });
      },
      query: async () => ({ held: heldLocks.map((name) => ({ name, mode: 'exclusive', clientId: 'x' })), pending: [] }),
    },
  });
}

const run = (status: AgentRunRecord['status'], id = 'run-1'): AgentRunRecord => ({
  id,
  status,
  plan: [],
  entries: [{ kind: 'tool', id: 'e1', name: 'read_file', subject: 'ui/main.ui', status: 'ok', result: '', at: 1 }],
  steps: 1,
  maxSteps: 40,
  tokens: { input: 100, output: 20 },
  tokenBudget: 2_000_000,
  protocol: 'anthropic',
  transactions: [],
  startedAt: 1,
  request: 'Call the heading Today',
});

const message = (record: AgentRunRecord): ChatMessage => ({ id: 'm-run', role: 'assistant', content: '', timestamp: 2, run: record });

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  resetAgent();
  seedApp();
  installLocks();
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
  releasePageForRun();
  Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
  resetAgent();
  delete (globalThis as unknown as { indexedDB?: unknown }).indexedDB;
});

function show(record: AgentRunRecord): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<RunTimeline message={message(record)} />));
}

const settle = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
const button = (label: string) => [...container!.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);

describe('a run another tab is working on', () => {
  it('holds a lock that names the run, which is how another tab knows of it', () => {
    holdPageForRun('run-9');
    expect(heldLocks).toHaveLength(1);
    expect(heldLocks[0]).toMatch(/^softn-studio-agent-run:[^:]+:run-9$/);
    releasePageForRun('run-9');
  });

  it('is shown as working there, with nothing to stop, answer or continue here', async () => {
    heldLocks.push('softn-studio-agent-run:othertab:run-1');
    show(run('running'));
    await settle();
    expect(container!.textContent).toContain('This run is working in another tab');
    expect(container!.textContent).not.toContain('This run stopped because the page reloaded');
    expect(container!.querySelector('.st-run')?.getAttribute('data-state')).toBe('running');
    expect(button('Continue')).toBeUndefined();
    expect(button('Stop')).toBeUndefined();
    expect(wasInterrupted(run('running'))).toBe(false);
  });

  it('is not continued from here while it works there', async () => {
    heldLocks.push('softn-studio-agent-run:othertab:run-1');
    useAIStore.getState().addMessage(message(run('running')));
    show(run('running'));
    await settle();
    await continueInterruptedRun('m-run');
    const runs = useAIStore.getState().messages.filter((m) => m.run);
    expect(runs).toHaveLength(1);
    expect(runs[0].run?.continuedBy).toBeUndefined();
  });

  it('can be continued here once that tab is gone', async () => {
    vi.useFakeTimers();
    heldLocks.push('softn-studio-agent-run:othertab:run-1');
    show(run('waiting'));
    await settle();
    expect(container!.textContent).toContain('This run is working in another tab');
    expect(button('Continue')).toBeUndefined();

    // The other tab is closed: its lock goes with it.
    heldLocks = [];
    await act(async () => { await vi.advanceTimersByTimeAsync(RUNS_ELSEWHERE_ASKED_EVERY_MS + 50); });
    expect(container!.textContent).toContain('This run stopped because the page reloaded');
    expect(button('Continue')).toBeDefined();
  });

  it('a run this page’s own reload cut short is still offered Continue', async () => {
    show(run('running'));
    await settle();
    expect(container!.textContent).toContain('This run stopped because the page reloaded');
    expect(button('Continue')).toBeDefined();
    expect(wasInterrupted(run('running'))).toBe(true);
  });
});

describe('a run brought in from another tab’s save', () => {
  let autosave: session.AutosaveController | null = null;

  afterEach(() => {
    autosave?.stop();
    autosave = null;
  });

  /** The other tab, which opened the stored copy, saves the chat with its run in it. */
  async function otherTabSavesRun(id: string, record: AgentRunRecord): Promise<void> {
    const { saveProjectRecord } = await import('../src/lib/persistence');
    const stored = (await loadProjectRecord(id))!;
    const messages = [...stored.session.messages.filter((m) => m.id !== 'm-run'), message(record)];
    expect(await saveProjectRecord({ ...stored, revision: stored.revision + 7, session: { ...stored.session, messages } }, stored.revision)).toEqual({ ok: true });
  }

  it('is known to be that tab’s at once, where there are no locks to ask, until that tab ends it', async () => {
    // No Web Locks here (a page not served over https has none).
    Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
    installFakeIndexedDB();
    localStorage.clear();
    const id = session.beginNewProjectSession();
    seedApp();
    useWorkspaceStore.getState().setProjectName('Tasks');
    autosave = session.startProjectAutosave({ debounceMs: 60_000, maxWaitMs: 60_000 });
    expect(await autosave.flush()).toEqual({ ok: true });

    await otherTabSavesRun(id, run('running'));
    useVFSStore.getState().updateFile('ui/main.ui', '<Text>Changed here</Text>');
    expect(await autosave.flush()).toEqual({ ok: true });
    const taken = useAIStore.getState().messages.find((m) => m.id === 'm-run')!;
    expect(taken.run?.status).toBe('running');
    expect(wasInterrupted(taken.run!)).toBe(false);

    await otherTabSavesRun(id, { ...run('finished'), summary: 'Done.', endedAt: 5 });
    useVFSStore.getState().updateFile('ui/main.ui', '<Text>Changed here, again</Text>');
    expect(await autosave.flush()).toEqual({ ok: true });
    const ended = useAIStore.getState().messages.find((m) => m.id === 'm-run')!;
    expect(ended.run?.status).toBe('finished');
    // And it is not held to be that tab's for good: a record of it left running would be one a reload cut short.
    expect(wasInterrupted(run('running'))).toBe(true);
  });

  /** This tab with the project saved, and the other tab's run brought in by this tab's next save. */
  async function bringInRun(record: AgentRunRecord): Promise<ChatMessage> {
    installFakeIndexedDB();
    localStorage.clear();
    const id = session.beginNewProjectSession();
    seedApp();
    useWorkspaceStore.getState().setProjectName('Tasks');
    autosave = session.startProjectAutosave({ debounceMs: 60_000, maxWaitMs: 60_000 });
    expect(await autosave.flush()).toEqual({ ok: true });
    await otherTabSavesRun(id, record);
    useVFSStore.getState().updateFile('ui/main.ui', '<Text>Changed here</Text>');
    expect(await autosave.flush()).toEqual({ ok: true });
    return useAIStore.getState().messages.find((m) => m.id === 'm-run')!;
  }

  // A run that paused (a request the provider failed) holds no lock: its tab may sleep. It is
  // still that tab's, which can Resume it, and here it read "stopped because the page reloaded".
  it('paused in that tab, is shown as paused there, with its reason, and not continued from here', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const paused = { ...run('paused'), reason: 'The provider is rate limiting requests. Nothing was lost: Resume sends the request again.' };
    const taken = await bringInRun(paused);
    expect(taken.run?.status).toBe('paused');
    expect(wasInterrupted(taken.run!)).toBe(false);

    show(taken.run!);
    await settle();
    // The locks are asked, and name no such run: a paused run is not known by a lock.
    await act(async () => { await vi.advanceTimersByTimeAsync(RUNS_ELSEWHERE_ASKED_EVERY_MS + 50); });
    expect(container!.querySelector('.st-run')?.getAttribute('data-state')).toBe('paused');
    expect(container!.textContent).toContain('The provider is rate limiting requests.');
    expect(container!.textContent).toContain('This run is paused in another tab. Resume it there');
    expect(container!.textContent).not.toContain('This run stopped because the page reloaded');
    expect(button('Continue')).toBeUndefined();
    expect(button('Resume')).toBeUndefined();
  });

  it('at work in that tab when it was saved, is one a closed tab left once the locks name no such run', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const taken = await bringInRun(run('running'));
    expect(wasInterrupted(taken.run!)).toBe(false);
    show(taken.run!);
    await settle();
    await act(async () => { await vi.advanceTimersByTimeAsync(RUNS_ELSEWHERE_ASKED_EVERY_MS + 50); });
    expect(container!.textContent).toContain('This run stopped because the page reloaded');
    expect(button('Continue')).toBeDefined();
  });
});
