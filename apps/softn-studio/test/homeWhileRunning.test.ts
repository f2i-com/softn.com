/** @vitest-environment jsdom */
/**
 * Home, pressed while the AI is working.
 *
 * Home ended every run without a word: the run was discarded, its row left
 * saying "working" over nothing, and on coming back the only offer was to
 * start again from its notes. Now a run that is working is asked about, and
 * stopped as the chat's Stop stops it: what it wrote stays, and Continue
 * picks it up with its conversation. Answering no changes nothing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { continueAgentRun, isRunLive, startAgentRun } from '../src/lib/agent/runAgent';
import { leaveRunQuestion, stopRunToLeave } from '../src/lib/leaveRun';
import { useAIStore } from '../src/stores/aiStore';
import { useWorkspaceStore } from '../src/stores/workspaceStore';
import { assertScriptsPassed, fakeProvider, lastRun, resetAgent, say, seedApp } from './helpers/agentHarness';

beforeEach(() => resetAgent());
afterEach(() => {
  vi.restoreAllMocks();
  assertScriptsPassed();
  resetAgent();
});

describe('Home while the AI is working', () => {
  it('asks first, and leaves the run working when the answer is no', async () => {
    seedApp();
    useWorkspaceStore.setState({ projectName: 'Tea Log' });
    fakeProvider('anthropic', [{ stall: true }]);
    say('Add a page for finished books');
    const running = startAgentRun();
    await vi.waitFor(() => expect(useAIStore.getState().agentState).toBe('building'));

    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    expect(stopRunToLeave()).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0]).toBe(leaveRunQuestion('Tea Log'));
    expect(String(confirm.mock.calls[0][0])).toMatch(/still working on Tea Log.*stops it.*kept.*Continue/s);
    expect(lastRun().run.status).toBe('running');
    expect(useAIStore.getState().agentState).toBe('building');

    // (Let the stalled request end, so the test does.)
    confirm.mockReturnValue(true);
    expect(stopRunToLeave()).toBe(true);
    await running;
  });

  it('stops the run as Stop does when the answer is yes, and Continue picks it up afterwards', async () => {
    seedApp();
    fakeProvider('anthropic', [{ stall: true }, { calls: [{ name: 'finish', input: { summary: 'Added the page.' } }] }]);
    say('Add a page for finished books');
    const running = startAgentRun();
    await vi.waitFor(() => expect(useAIStore.getState().agentState).toBe('building'));

    vi.spyOn(window, 'confirm').mockReturnValue(true);
    expect(stopRunToLeave()).toBe(true);
    await running;
    const stopped = lastRun().run;
    expect(stopped.status).toBe('stopped');
    expect(stopped.reason).toMatch(/Stopped by you.*Continue/);
    expect(useAIStore.getState().agentState).toBe('idle');
    // Not discarded: the run is still this page's, so the chat offers Continue.
    expect(isRunLive(stopped.id)).toBe(true);

    await continueAgentRun(stopped.id);
    expect(lastRun().run.status).toBe('finished');
    expect(lastRun().run.summary).toBe('Added the page.');
  });

  it('asks nothing when no run is working', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    expect(stopRunToLeave()).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('names an app that has no name yet as "this app"', () => {
    expect(leaveRunQuestion('  ')).toContain('still working on this app.');
  });
});
