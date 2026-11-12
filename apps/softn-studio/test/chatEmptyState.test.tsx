/** @vitest-environment jsdom */
/**
 * What the chat says before anything has been said in it.
 *
 * A project that has a brief and a plan was greeted with "Imported app
 * ready: this bundle is loaded into Studio" and three suggestions about
 * "this imported app". But an import and an example each open with a message
 * of their own, so the only project that ever met that greeting was one just
 * laid out by the brief wizard and not yet built: a person who had imported
 * nothing was told they had, and the one thing they were there to do, build
 * the app they had described, was not among the suggestions.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AIChat } from '../src/components/ai/AIChat';
import { buildFromBrief } from '../src/lib/agent/buildFromBrief';
import { sessionUse } from '../src/lib/agent/sessionUse';
import { runAgentTurn } from '../src/lib/agentOrchestrator';
import { generateBlueprintFromBrief } from '../src/lib/studioProject';
import { useAIStore, useWorkspaceStore } from '../src/stores';
import type { ProjectBrief } from '../src/types/studio';

vi.mock('../src/lib/agentOrchestrator', () => ({ runAgentTurn: vi.fn(), abortAgentTurn: vi.fn() }));
vi.mock('../src/lib/agent/buildFromBrief', () => ({ buildFromBrief: vi.fn(() => true), canBuildFromBrief: vi.fn(() => true) }));

const BRIEF: ProjectBrief = {
  appName: 'Counter Club',
  description: 'A counter with a button that adds one.',
  target: 'web',
  pages: [],
  collections: [],
  authNeeded: false,
  style: 'clean',
  logicLanguage: 'javascript',
  referenceImages: [],
};

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  useWorkspaceStore.getState().reset();
  useWorkspaceStore.setState({ brief: BRIEF, blueprint: generateBlueprintFromBrief(BRIEF), blueprintApproved: true });
  useAIStore.getState().resetSession();
  useAIStore.setState({ providers: [], activeProviderId: null, setupDialog: null });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

const offer = () => [...container.querySelectorAll('button')].find((b) => b.textContent === 'Build Counter Club as the brief describes');

describe('the chat of a project laid out from a brief, before anything is said', () => {
  it('does not call the app imported, and offers to build it, which starts the build', () => {
    useAIStore.setState({ providers: [{ id: 'local', type: 'custom', name: 'Local', apiKey: '', modelId: 'test' }], activeProviderId: 'local' });
    act(() => root.render(<AIChat />));
    const log = container.querySelector('[role="log"]')!;
    expect(log.textContent).not.toMatch(/import|bundle/i);
    expect(log.textContent).toMatch(/Ready to build/);
    act(() => offer()!.click());
    // The build run, with the brief as its request: not an edit run with the suggestion's words.
    expect(buildFromBrief).toHaveBeenCalledOnce();
    expect(runAgentTurn).not.toHaveBeenCalled();
  });

  // The header was three rows above every conversation: "0/15 runs | 0 tokens" of a session in
  // which nothing had run, and two pills ("Plan ready", "2 pages"; before that "Blueprint
  // ready" and "1 page targets") that repeated the Pages panel and the greeting. It is one
  // line now, there only when it has something to say.
  const header = () => container.querySelector('[data-chat-header]');
  const READY = { providers: [{ id: 'local', type: 'custom' as const, name: 'Local', apiKey: '', modelId: 'test' }], activeProviderId: 'local' };

  it('has no header at all with no provider and nothing used: the setup card is the top', () => {
    act(() => root.render(<AIChat />));
    expect(header()).toBeNull();
    expect(container.textContent).not.toMatch(/Plan ready|Brief ready|\d+ pages?\b|0 tokens|runs/);
    expect(container.firstElementChild?.firstElementChild?.querySelector('[aria-label="AI setup"]')).not.toBeNull();
  });

  it('with a provider and nothing used, names the model and counts nothing', () => {
    useAIStore.setState(READY);
    act(() => root.render(<AIChat />));
    expect(header()!.querySelector('.st-ai-pill')).not.toBeNull();
    expect(header()!.querySelector('[data-level]')).toBeNull();
    expect(header()!.textContent).not.toMatch(/runs|tokens|ready|page/i);
  });

  it('says what the session has used once it has used something, quietly while there is room', () => {
    useAIStore.setState({ ...READY, iterationsUsed: 3, maxIterations: 15, tokensUsed: 12340, tokenBudget: 500000 });
    act(() => root.render(<AIChat />));
    const use = header()!.querySelector('[data-level]')!;
    expect(use.getAttribute('data-level')).toBe('quiet');
    expect(use.textContent).toBe(`3 of 15 runs · ${(12340).toLocaleString()} tokens`);
    expect(use.getAttribute('title')).toMatch(/Settings, under Budget limits/);
  });

  it('speaks up when the limit is close, and when it is reached, with or without a provider', () => {
    useAIStore.setState({ ...READY, iterationsUsed: 13, maxIterations: 15, tokensUsed: 1000, tokenBudget: 500000 });
    act(() => root.render(<AIChat />));
    expect(header()!.querySelector('[data-level="near"]')!.textContent).toBe('2 runs left of 15');
    act(() => useAIStore.setState({ iterationsUsed: 15 }));
    expect(header()!.querySelector('[data-level="spent"]')!.textContent).toBe('No runs left: 15 of 15 used');
    act(() => useAIStore.setState({ providers: [], activeProviderId: null }));
    expect(header()!.querySelector('[data-level="spent"]')).not.toBeNull();
  });

  it('counts the tokens against their budget too', () => {
    expect(sessionUse({ iterationsUsed: 0, maxIterations: 15, tokensUsed: 0, tokenBudget: 1000 })).toBeNull();
    expect(sessionUse({ iterationsUsed: 1, maxIterations: 15, tokensUsed: 850, tokenBudget: 1000 })).toEqual({ text: '85% of the token budget used', level: 'near' });
    expect(sessionUse({ iterationsUsed: 1, maxIterations: 15, tokensUsed: 1000, tokenBudget: 1000 })?.level).toBe('spent');
    // A small limit: close means the last run.
    expect(sessionUse({ iterationsUsed: 1, maxIterations: 3, tokensUsed: 10, tokenBudget: 1000 })).toEqual({ text: '1 of 3 runs · 10 tokens', level: 'quiet' });
    expect(sessionUse({ iterationsUsed: 2, maxIterations: 3, tokensUsed: 10, tokenBudget: 1000 })).toEqual({ text: '1 run left of 3', level: 'near' });
  });

  it('clears the offer from the box, where an earlier press without a provider left it, once it starts the build', () => {
    useAIStore.setState({ providers: [{ id: 'local', type: 'custom', name: 'Local', apiKey: '', modelId: 'test' }], activeProviderId: 'local', draftMessage: 'Build Counter Club as the brief describes' });
    act(() => root.render(<AIChat />));
    act(() => offer()!.click());
    expect(buildFromBrief).toHaveBeenCalledOnce();
    expect(useAIStore.getState().draftMessage).toBe('');
  });

  // With no provider the card that says so sits above the conversation, and in a short window
  // (1280 by 640) the picture, the title and the three lines under it filled what was left: the
  // offer to build was 41 pixels under the box the message is typed in, found only by scrolling
  // a conversation that looked empty. While the card is there the greeting is its title and
  // the offers, and nothing else. (jsdom lays nothing out: the positions are measured in Chromium.)
  it('with no provider, greets with its title and the offers alone, so they fit under the card', () => {
    act(() => root.render(<AIChat />));
    const log = container.querySelector('[role="log"]')!;
    expect(container.querySelector('[aria-label="AI setup"]')).not.toBeNull();
    expect(log.textContent).toContain('Ready to build');
    expect(log.textContent).not.toMatch(/The pages are laid out and waiting/);
    // No picture above the title: the greeting begins with it.
    expect(log.firstElementChild?.firstElementChild?.tagName).toBe('P');
    expect(log.firstElementChild?.firstElementChild?.textContent).toBe('Ready to build');
    // The offer is the first thing after the title.
    expect([...log.querySelectorAll('button')].map((b) => b.textContent)[0]).toBe('Build Counter Club as the brief describes');
    expect(log.querySelector('p')?.nextElementSibling?.querySelector('button')?.textContent).toBe('Build Counter Club as the brief describes');
  });

  it('with a provider, keeps the whole greeting: there is room for it', () => {
    useAIStore.setState({ providers: [{ id: 'local', type: 'custom', name: 'Local', apiKey: '', modelId: 'test' }], activeProviderId: 'local' });
    act(() => root.render(<AIChat />));
    const log = container.querySelector('[role="log"]')!;
    expect(log.textContent).toMatch(/The pages are laid out and waiting/);
    expect(log.firstElementChild?.firstElementChild?.querySelector('svg')).not.toBeNull();
  });

  it('with no provider, the offer opens the AI setup and keeps the request for when there is one', () => {
    act(() => root.render(<AIChat />));
    act(() => offer()!.click());
    expect(buildFromBrief).not.toHaveBeenCalled();
    expect(useAIStore.getState().setupDialog).not.toBeNull();
    expect(useAIStore.getState().draftMessage).toBe('Build Counter Club as the brief describes');
  });
});
