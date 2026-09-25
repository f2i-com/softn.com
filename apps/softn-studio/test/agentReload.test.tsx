/** @vitest-environment jsdom */
/**
 * A run and the page it lives in. While a run works the page holds a Web
 * Lock (so the browser does not freeze or discard a background tab) and asks
 * before it is unloaded; both are let go when the run ends. A page that
 * reloads anyway — here, fresh modules given the chat as it was saved — shows
 * the run as stopped by the reload, with Continue, which starts a new run from
 * the request, the plan and the steps the old one recorded.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { holdPageForRun, releasePageForRun, wasInBackground } from '../src/lib/agent/keepAlive';
import { startAgentRun } from '../src/lib/agent/runAgent';
import type { AgentEnvironment } from '../src/lib/agent/appCheck';
import { useAIStore } from '../src/stores/aiStore';
import { useVFSStore } from '../src/stores/vfsStore';
import { ANTHROPIC, assertScriptsPassed, fakeProvider, lastRun, resetAgent, say, seedApp } from './helpers/agentHarness';

const quiet: AgentEnvironment = {
  checkApp: async () => ({ ok: true, errors: [], warnings: [], renderedHeadless: false }),
  inspectPreview: async () => ({ ok: true, text: '' }),
  runFunction: async () => ({ ok: true, text: '' }),
};

interface FakeLock {
  name: string;
  mode: string | undefined;
  released: boolean;
}

let locks: FakeLock[];

function installLocks(): void {
  locks = [];
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: vi.fn((name: string, options: { mode?: string }, callback: () => Promise<void>) => {
        const lock: FakeLock = { name, mode: options.mode, released: false };
        locks.push(lock);
        return callback().then(() => {
          lock.released = true;
        });
      }),
    },
  });
}

function removeLocks(): void {
  Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
}

/** Whether leaving the page now would be questioned. */
function unloadIsQuestioned(): boolean {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => {
  resetAgent(ANTHROPIC, quiet);
  seedApp();
  installLocks();
  sessionStorage.clear();
});
afterEach(() => {
  assertScriptsPassed();
  resetAgent();
  removeLocks();
});

describe('keeping the page while a run works', () => {
  it('holds a Web Lock and questions an unload only while the run is active', async () => {
    let during: { locks: FakeLock[]; questioned: boolean } | null = null;
    fakeProvider('anthropic', [
      { calls: [{ name: 'list_files', input: {} }] },
      () => {
        during = { locks: locks.map((l) => ({ ...l })), questioned: unloadIsQuestioned() };
        return { calls: [{ name: 'finish', input: { summary: 'ok' } }] };
      },
    ]);
    expect(unloadIsQuestioned()).toBe(false);
    say('Look');
    await startAgentRun();
    await settle();
    expect(during).toEqual({ locks: [{ name: expect.stringMatching(/^softn-studio-agent-run:/), mode: 'exclusive', released: false }], questioned: true });
    expect(lastRun().run.status).toBe('finished');
    expect(locks).toHaveLength(1);
    expect(locks[0].released).toBe(true);
    expect(unloadIsQuestioned()).toBe(false);
  });

  it('lets go when the run pauses on a network failure, and runs without Web Locks', async () => {
    removeLocks();
    fakeProvider('anthropic', [{ calls: [{ name: 'list_files', input: {} }] }, { networkError: true }]);
    say('Look');
    await startAgentRun();
    expect(lastRun().run.status).toBe('paused');
    expect(unloadIsQuestioned()).toBe(false);
  });
});

describe('whether the tab was in the background', () => {
  const setVisibility = (state: 'visible' | 'hidden') => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
    document.dispatchEvent(new Event('visibilitychange'));
  };
  afterEach(() => {
    releasePageForRun();
    setVisibility('visible');
  });

  it('is noted when the tab goes to the background, and not when a visible page is reloaded', () => {
    holdPageForRun('hidden-run');
    setVisibility('hidden');
    expect(wasInBackground('hidden-run')).toBe(true);
    setVisibility('visible');
    expect(wasInBackground('hidden-run')).toBe(false);
    releasePageForRun();

    // A reload of a visible tab: beforeunload first, then the page turns hidden on its way out.
    holdPageForRun('visible-run');
    window.dispatchEvent(new Event('beforeunload', { cancelable: true }));
    setVisibility('hidden');
    window.dispatchEvent(new Event('pagehide'));
    expect(wasInBackground('visible-run')).toBe(false);
  });
});

describe('a run the page reloaded under', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;
  afterEach(() => {
    if (root) act(() => root!.unmount());
    container?.remove();
    root = null;
    container = null;
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  });

  it('shows why it stopped and Continue, which carries on from its request and plan in a new run', async () => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const provider = fakeProvider('anthropic', [
      {
        calls: [
          { name: 'update_plan', input: { items: [{ text: 'Add a due date', status: 'done' }, { text: 'Show it in the list', status: 'active' }] } },
          { name: 'read_file', input: { path: 'ui/main.ui' } },
        ],
      },
      () => {
        // The next request never comes back: the tab goes to the background and the page is reloaded under it.
        provider.hold();
        return { calls: [{ name: 'edit_file', input: { path: 'ui/main.ui', old_string: '<Heading level={1}>Tasks</Heading>', new_string: '<Heading level={1}>Due</Heading>' } }] };
      },
      (body) => {
        const sent = JSON.stringify(body.messages);
        expect(sent).toContain('This continues a run that stopped when the page reloaded, after 3 step(s)');
        expect(sent).toContain('The request was: Add due dates to the tasks');
        expect(sent).toContain('- [done] Add a due date');
        expect(sent).toContain('- [active] Show it in the list');
        expect(sent).toContain('- edit_file ui/main.ui — ok');
        // The files as they are now, the old run's edit included.
        expect(sent).toContain('# The project at the start of this run');
        return { calls: [{ name: 'finish', input: { summary: 'Due dates are shown.' } }] };
      },
    ]);
    say('Add due dates to the tasks');
    void startAgentRun();
    await vi.waitFor(() => expect(provider.count()).toBe(2));
    await vi.waitFor(() => expect(provider.bodies).toHaveLength(3));
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(lastRun().run.status).toBe('running');

    // What the page had saved when it went away.
    const saved = JSON.parse(JSON.stringify(useAIStore.getState().messages)) as ReturnType<typeof useAIStore.getState>['messages'];
    const files = [...useVFSStore.getState().files.values()].map((f) => ({ path: f.path, content: f.content as string }));
    expect(files.find((f) => f.path === 'ui/main.ui')?.content).toContain('Due');
    // (The old page's run is left hanging on its request, as a reload leaves it; afterEach discards it.)

    // The reloaded page: fresh modules, the chat and the files restored from what was saved.
    vi.resetModules();
    const fresh = {
      ai: (await import('../src/stores/aiStore')).useAIStore,
      vfs: (await import('../src/stores/vfsStore')).useVFSStore,
      agent: await import('../src/lib/agent/runAgent'),
      Timeline: (await import('../src/components/ai/RunTimeline')).RunTimeline,
    };
    fresh.agent.setAgentEnvironment(quiet);
    fresh.agent.setAgentSleep(async () => {});
    fresh.vfs.getState().hydrateFiles(files);
    const { providers, activeProviderId, modelProfile, maxIterations, tokenBudget, maxOutputTokens, requestTimeoutMs, agentSettings, toolProtocols, streamModes } = useAIStore.getState();
    fresh.ai.setState({ providers, activeProviderId, modelProfile, maxIterations, tokenBudget, maxOutputTokens, requestTimeoutMs, agentSettings, toolProtocols, streamModes, messages: saved });
    const message = fresh.ai.getState().messages.find((m) => m.run)!;
    expect(fresh.agent.isRunLive(message.run!.id)).toBe(false);

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const view = () => <fresh.Timeline message={fresh.ai.getState().messages.find((m) => m.id === message.id)!} />;
    act(() => root!.render(view()));
    expect(container.textContent).toContain('This run stopped because the page reloaded while the tab was in the background');
    expect(container.textContent).toContain('Its changes are kept.');
    expect(container.textContent).not.toMatch(/interrupted when Studio closed/);
    const cont = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Continue'));
    expect(cont).toBeTruthy();

    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    await act(async () => {
      cont!.click();
      await settle();
    });
    await vi.waitFor(() => expect(fresh.ai.getState().messages.filter((m) => m.run).at(-1)?.run?.status).toBe('finished'));
    const runs = fresh.ai.getState().messages.filter((m) => m.run).map((m) => m.run!);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ status: 'stopped', continuedBy: runs[1].id });
    expect(runs[0].reason).toContain('It was continued in the run below.');
    expect(runs[1]).toMatchObject({ continues: runs[0].id, request: 'Add due dates to the tasks', summary: 'Due dates are shown.' });
    expect(runs[1].plan.map((p) => p.text)).toEqual(['Add a due date', 'Show it in the list']);
    act(() => root!.render(view()));
    expect(container.textContent).not.toContain('Continue');
    // What the old run wrote is still there.
    expect(String(fresh.vfs.getState().readFile('ui/main.ui'))).toContain('<Heading level={1}>Due</Heading>');
  });
});
