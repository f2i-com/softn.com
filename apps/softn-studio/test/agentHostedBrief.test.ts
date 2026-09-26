/**
 * A host opens Studio with a brief (the bridge's `agentRuns`): Studio puts the
 * request in the chat, runs the agent on it, and tells the host where the
 * agent is while it works. The bridge is replaced by a scripted host; the
 * loop, the tools and the VFS are real.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostedAgentStatus, HostedAIReply, HostedAIRequest } from '@softn/editor-shared/hostedEditor';

const host = vi.hoisted(() => ({
  replies: [] as Array<unknown>,
  statuses: [] as Array<{ state: string; step?: string; summary?: string; reason?: string }>,
}));

vi.mock('@softn/editor-shared/hostedEditor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@softn/editor-shared/hostedEditor')>();
  return {
    ...actual,
    isHostedEditor: () => true,
    hostedAIToolsVersion: () => 1,
    hostedAgentRunsVersion: () => 1,
    requestHostedAIReply: async (_request: HostedAIRequest): Promise<HostedAIReply> => {
      const reply = host.replies.shift();
      if (reply === undefined) throw new Error('The scripted host has no reply left.');
      return actual.readHostedAIReply(reply);
    },
    reportHostedAgentStatus: (status: HostedAgentStatus) => { host.statuses.push({ ...status }); },
  };
});

const { currentAgentStatus, reportAgentStatusToHost, startRunFromBrief } = await import('../src/lib/agent/hostedAgent');
const { useAIStore } = await import('../src/stores/aiStore');
const { useWorkspaceStore } = await import('../src/stores/workspaceStore');
const { assertScriptsPassed, lastRun, resetAgent, seedApp, text } = await import('./helpers/agentHarness');

const FORMLOGIC = { id: 'formlogic', type: 'custom' as const, name: 'FormLogic AI', apiKey: '', modelId: 'host-default' };

beforeEach(() => {
  resetAgent(FORMLOGIC);
  seedApp();
  host.replies = [];
  host.statuses = [];
});
afterEach(() => {
  assertScriptsPassed();
  expect(host.replies).toEqual([]);
});

describe('a run started from the host\'s brief', () => {
  it('puts the brief in the chat as the person\'s request, opens the chat, and builds what it asks', async () => {
    host.replies = [
      { text: 'Reading the page.', toolCalls: [{ id: 'h1', name: 'read_file', arguments: { path: 'ui/main.ui' } }], stopReason: 'tool_use' },
      { text: '', toolCalls: [{ id: 'h2', name: 'edit_file', arguments: { path: 'ui/main.ui', old_string: '<Heading level={1}>Tasks</Heading>', new_string: '<Heading level={1}>Recipes</Heading>' } }], stopReason: 'tool_use' },
      { text: '', toolCalls: [{ id: 'h3', name: 'finish', arguments: { summary: 'Turned the list into a recipe box.' } }], stopReason: 'tool_use' },
    ];
    const stop = reportAgentStatusToHost();
    const run = startRunFromBrief({ prompt: 'Make this a recipe box.', kind: 'edit' });
    expect(run).not.toBeNull();
    await run;
    stop();

    const requests = useAIStore.getState().messages.filter((m) => m.role === 'user');
    expect(requests.at(-1)?.content).toBe('Make this a recipe box.');
    expect(useWorkspaceStore.getState().leftPanel).toBe('ai');
    expect(lastRun().run.status).toBe('finished');
    expect(lastRun().run.kind).toBe('edit');
    expect(text('ui/main.ui')).toContain('<Heading level={1}>Recipes</Heading>');

    // The host heard the run start, work and finish, with the summary at the end.
    const states = host.statuses.map((s) => s.state);
    expect(states[0]).toBe('idle');
    expect(states).toContain('running');
    expect(host.statuses.at(-1)).toEqual({ state: 'finished', summary: 'Turned the list into a recipe box.', reason: undefined });
    expect(states.indexOf('running')).toBeLessThan(states.lastIndexOf('finished'));
  });

  it('does not start a second run while one is going', () => {
    useAIStore.getState().setAgentState('building');
    const before = useAIStore.getState().messages.length;
    expect(startRunFromBrief({ prompt: 'Another thing', kind: 'build' })).toBeNull();
    expect(useAIStore.getState().messages).toHaveLength(before);
    useAIStore.getState().setAgentState('idle');
  });
});

describe('the status the host hears', () => {
  it('is idle before any run, and running with the current step while one works', () => {
    expect(currentAgentStatus()).toEqual({ state: 'idle' });
    useAIStore.getState().setAgentState('building');
    useAIStore.getState().setCurrentStep('Checking the app…');
    expect(currentAgentStatus()).toEqual({ state: 'running', step: 'Checking the app…' });
    useAIStore.getState().setAgentState('idle');
    useAIStore.getState().setCurrentStep('');
  });

  it('reads a run the store no longer drives as paused, with its reason', () => {
    useAIStore.getState().addMessage({
      id: 'm-run', role: 'assistant', content: '', timestamp: Date.now(),
      run: { id: 'r1', status: 'running', reason: 'The page reloaded.', plan: [], entries: [], steps: 3, maxSteps: 40, tokens: { input: 0, output: 0 }, tokenBudget: 1000, protocol: 'hosted', transactions: [], startedAt: Date.now() },
    });
    expect(currentAgentStatus()).toEqual({ state: 'paused', summary: undefined, reason: 'The page reloaded.' });
  });
});
