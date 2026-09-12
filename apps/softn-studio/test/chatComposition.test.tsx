/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AIChat } from '../src/components/ai/AIChat';
import { useAIStore, useWorkspaceStore } from '../src/stores';
import { runAgentTurn } from '../src/lib/agentOrchestrator';

vi.mock('../src/lib/agentOrchestrator', () => ({ runAgentTurn: vi.fn(), abortAgentTurn: vi.fn() }));

let root: Root;
let container: HTMLDivElement;
let input: HTMLTextAreaElement;
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  useWorkspaceStore.getState().reset();
  useAIStore.getState().resetSession();
  useAIStore.setState({ providers: [{ id: 'local', type: 'custom', name: 'Local', apiKey: '', modelId: 'test' }], activeProviderId: 'local', draftMessage: '予約アプリを作成' });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<AIChat />));
  input = container.querySelector<HTMLTextAreaElement>('[aria-label="Message to AI"]')!;
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

describe('chat composition', () => {
  it.each([{ isComposing: true }, { keyCode: 229 }])('keeps a candidate-confirming Enter out of the AI queue (%j)', (init) => {
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init });
    act(() => input.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
    expect(useAIStore.getState().draftMessage).toBe('予約アプリを作成');
    expect(useAIStore.getState().messages).toHaveLength(0);
    expect(runAgentTurn).not.toHaveBeenCalled();
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
    expect(useAIStore.getState().messages).toHaveLength(1);
    expect(useAIStore.getState().messages[0].content).toBe('予約アプリを作成');
    expect(useAIStore.getState().draftMessage).toBe('');
    expect(runAgentTurn).toHaveBeenCalledOnce();
  });

  it('keeps Shift+Enter available for a newline', () => {
    const event = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true });
    act(() => input.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
    expect(runAgentTurn).not.toHaveBeenCalled();
  });
});
