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

  // The box is disabled while the agent works, and a browser takes the focus from a control
  // that becomes disabled: it fell to the page, and stayed there when the run ended. Someone
  // working from the keyboard sent one message and then had to find the box again for the next.
  it('gives the keyboard back to the box when the run a message started with Enter ends', () => {
    input.focus();
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
    expect(runAgentTurn).toHaveBeenCalledOnce();
    act(() => useAIStore.getState().setAgentState('building'));
    expect(input.disabled).toBe(true);
    // jsdom leaves the focus on a control that was disabled, and will not blur it; a browser
    // drops the focus to the page, which is done here through another control.
    const other = document.createElement('button');
    document.body.appendChild(other);
    other.focus();
    other.blur();
    other.remove();
    expect(document.activeElement).toBe(document.body);
    act(() => useAIStore.getState().setAgentState('idle'));
    expect(document.activeElement).toBe(input);
  });

  it('leaves the focus where the person put it while the agent worked', () => {
    const elsewhere = document.createElement('button');
    document.body.appendChild(elsewhere);
    input.focus();
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
    act(() => useAIStore.getState().setAgentState('building'));
    elsewhere.focus();
    act(() => useAIStore.getState().setAgentState('idle'));
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });

  it('keeps Shift+Enter available for a newline', () => {
    const event = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true });
    act(() => input.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
    expect(runAgentTurn).not.toHaveBeenCalled();
  });
});
