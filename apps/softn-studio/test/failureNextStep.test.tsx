/** @vitest-environment jsdom */
/**
 * After a run that did not finish, the chat says what to do and offers the
 * control to do it with.
 *
 * A run that stops says why in its own block: "the server did not accept the
 * key given", "raise the limit in Settings". The only button under those
 * words was Continue, which asks again with the same key and the same limit.
 * Why the last run stopped was kept in the store (`lastFailure`) and nothing
 * drew it. It is drawn now, above the message box, with the AI setup, the
 * provider or the limits one press away.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FailureNextStep } from '../src/components/ai/FailureNextStep';
import { nextStepFor } from '../src/lib/agent/failureNextStep';
import { continueAgentRun, startAgentRun } from '../src/lib/agent/runAgent';
import { useAIStore } from '../src/stores/aiStore';
import { useWorkspaceStore } from '../src/stores/workspaceStore';
import { ANTHROPIC, assertScriptsPassed, fakeProvider, lastRun, resetAgent, say, seedApp } from './helpers/agentHarness';

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  resetAgent();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  assertScriptsPassed();
  resetAgent();
});

const strip = () => host.querySelector('[aria-label="What to do next"]');
const button = (name: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === name);
const draw = (onOpenSettings?: () => void) => act(() => root.render(<FailureNextStep onOpenSettings={onOpenSettings} />));

describe('what the chat offers after a run that did not finish', () => {
  it('offers the provider’s own setup when the provider did not accept the key', async () => {
    seedApp();
    fakeProvider('anthropic', [{ error: { status: 401, body: { error: { message: 'invalid x-api-key' } } } }]);
    say('Add a page');
    await startAgentRun();
    expect(lastRun().run.status).toBe('failed');
    expect(useAIStore.getState().lastFailure).toMatchObject({ kind: 'provider', fix: 'provider' });

    draw();
    expect(strip()?.textContent).toContain('The AI provider answered with an error');
    expect(strip()?.textContent).toContain('Check its key and its address, then press Continue on the run above.');
    act(() => button(`Check ${ANTHROPIC.name}`)!.click());
    expect(useAIStore.getState().setupDialog).toEqual({ providerId: ANTHROPIC.id });
  });

  it('offers the limits when a run used up its steps, and goes when the run goes on', async () => {
    seedApp();
    useAIStore.getState().updateAgentSettings({ maxSteps: 5 });
    const read = { calls: [{ name: 'read_file', input: { path: 'manifest.json' } }] };
    fakeProvider('anthropic', [read, read, read, read, read, { calls: [{ name: 'finish', input: { summary: 'Read it.' } }] }]);
    say('Read the manifest five times');
    await startAgentRun();
    expect(lastRun().run.status).toBe('failed');
    expect(lastRun().run.reason).toMatch(/limit of 5 steps/);
    // It was recorded as the provider's failure.
    expect(useAIStore.getState().lastFailure).toMatchObject({ kind: 'budget', fix: 'limits' });

    draw();
    expect(strip()?.textContent).toContain('The AI stopped at a limit you set');
    useWorkspaceStore.getState().setLeftPanel('ai');
    act(() => button('Open the limits')!.click());
    expect(useWorkspaceStore.getState().leftPanel).toBe('settings');

    await act(async () => { await continueAgentRun(lastRun().run.id); });
    expect(lastRun().run.status).toBe('finished');
    expect(useAIStore.getState().lastFailure).toBeNull();
    expect(strip()).toBeNull();
  });

  it('on a phone shows the settings through the way it is given, and can be dismissed', () => {
    useAIStore.getState().setLastFailure({ kind: 'budget', message: 'The session token budget is used up.', fix: 'limits', at: 1 });
    const onOpenSettings = vi.fn();
    draw(onOpenSettings);
    act(() => button('Open the limits')!.click());
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    // With no run to go on, the request is sent again.
    expect(strip()?.textContent).toContain('then send your message again.');
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]')!.click());
    expect(strip()).toBeNull();
    expect(useAIStore.getState().lastFailure).toBeNull();
  });

  it('opens the AI setup when there is no provider, and says nothing while a run works', () => {
    useAIStore.setState({ providers: [], activeProviderId: null });
    useAIStore.getState().setLastFailure({ kind: 'setup', message: 'Connect an AI provider to start generating.', fix: 'setup', at: 1 });
    draw();
    act(() => button('Open AI setup')!.click());
    expect(useAIStore.getState().setupDialog).toEqual({ providerId: null });
    act(() => useAIStore.getState().setAgentState('building'));
    expect(strip()).toBeNull();
  });
});

describe('the step for each kind of failure', () => {
  const at = 1;
  it('says how long a provider asked to wait, and offers no control it does not have', () => {
    const step = nextStepFor({ kind: 'rate-limited', message: 'Rate limited.', retryAfterMs: 7000, at }, { providerName: 'Local', goOn: 'resume' })!;
    expect(step.advice).toBe('It asked for 7 seconds. Wait that long, then press Resume on the run above. If it goes on, check the usage and billing of your account with Local.');
    expect(step.action).toBeUndefined();
  });

  it('has nothing to say of a run the person stopped', () => {
    expect(nextStepFor({ kind: 'cancelled', message: 'The run was stopped.', at })).toBeNull();
  });

  it('offers no setup in a hosted editor, whose AI is its host’s, but still the limits', () => {
    const provider = nextStepFor({ kind: 'network', message: 'x', fix: 'provider', at }, { hosted: true })!;
    expect(provider.action).toBeUndefined();
    expect(provider.advice).toMatch(/the one chosen in the site Studio is opened in/);
    expect(nextStepFor({ kind: 'budget', message: 'x', fix: 'limits', at }, { hosted: true })!.action).toEqual({ label: 'Open the limits', opens: 'limits' });
  });

  it('tells a run that stopped itself from a provider’s error', () => {
    expect(nextStepFor({ kind: 'stuck', message: 'x', at }, { goOn: 'continue' })!.title).toBe('The run stopped itself');
    expect(nextStepFor({ kind: 'provider', message: 'x', at }, { goOn: 'continue' })!.title).toBe('The AI provider had an error of its own');
  });
});
