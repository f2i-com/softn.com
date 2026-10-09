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

  // The bar said "Blueprint ready" and "1 page targets": the brief's own page list, or 1 when
  // it named none, beside a plan that had three pages.
  it('says what the plan holds, counted from the plan', () => {
    const pills = () => [...container.querySelectorAll('span')].map((s) => s.textContent).filter((t) => /ready|page/i.test(t ?? ''));
    act(() => root.render(<AIChat />));
    expect(pills()).toEqual(['Plan ready', '1 page']);
    const three = { ...BRIEF, pages: ['Home', 'Scores', 'About'] };
    act(() => useWorkspaceStore.setState({ brief: three, blueprint: generateBlueprintFromBrief(three) }));
    expect(pills()).toEqual(['Plan ready', '3 pages']);
    expect(container.textContent).not.toMatch(/page targets/);
  });

  it('with a brief and no plan yet, says the brief is ready and counts no pages', () => {
    useWorkspaceStore.setState({ blueprint: null });
    act(() => root.render(<AIChat />));
    const pills = [...container.querySelectorAll('span')].map((s) => s.textContent).filter((t) => /ready|page/i.test(t ?? ''));
    expect(pills).toEqual(['Brief ready']);
  });

  it('clears the offer from the box, where an earlier press without a provider left it, once it starts the build', () => {
    useAIStore.setState({ providers: [{ id: 'local', type: 'custom', name: 'Local', apiKey: '', modelId: 'test' }], activeProviderId: 'local', draftMessage: 'Build Counter Club as the brief describes' });
    act(() => root.render(<AIChat />));
    act(() => offer()!.click());
    expect(buildFromBrief).toHaveBeenCalledOnce();
    expect(useAIStore.getState().draftMessage).toBe('');
  });

  it('with no provider, the offer opens the AI setup and keeps the request for when there is one', () => {
    act(() => root.render(<AIChat />));
    act(() => offer()!.click());
    expect(buildFromBrief).not.toHaveBeenCalled();
    expect(useAIStore.getState().setupDialog).not.toBeNull();
    expect(useAIStore.getState().draftMessage).toBe('Build Counter Club as the brief describes');
  });
});
