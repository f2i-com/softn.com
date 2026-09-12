/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsPanel } from '../src/components/panels/SettingsPanel';
import { AIChat } from '../src/components/ai/AIChat';
import { useAIStore } from '../src/stores/aiStore';
import { useWorkspaceStore } from '../src/stores/workspaceStore';

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  useAIStore.getState().resetSession();
  useAIStore.setState({ providers: [], activeProviderId: null, modelProfile: { architect: '', builder: '', repair: '', vision: '' } });
  useWorkspaceStore.getState().reset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(element: React.ReactNode) { act(() => root.render(element)); }
function click(text: string) {
  const button = [...container.querySelectorAll('button')].find((node) => node.textContent?.trim() === text);
  expect(button, `Button: ${text}`).toBeTruthy();
  act(() => button!.click());
}
function field(id: string, value: string) {
  const input = container.querySelector<HTMLInputElement | HTMLSelectElement>(`#${id}`)!;
  expect(input).toBeTruthy();
  act(() => {
    const proto = input.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event(input.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  });
}
function localProvider() {
  render(<SettingsPanel />);
  click('Add Provider');
  field('studio-provider-preset', 'custom');
}

describe('provider setup', () => {
  it('explains a missing key instead of silently ignoring Save', () => {
    render(<SettingsPanel />);
    click('Add Provider');
    click('Save Provider');
    expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/Enter an API key/);
    expect(useAIStore.getState().providers).toHaveLength(0);
  });

  it('requires the actual local model instead of sending a made-up default', () => {
    localProvider();
    click('Save Provider');
    expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/Enter the model name/);
    expect(useAIStore.getState().providers).toHaveLength(0);
  });

  it.each(['not a url', 'file:///tmp/model', 'https://user:password@example.com/v1', 'https://example.com/v1#secret'])('rejects an unusable endpoint: %s', (url) => {
    localProvider();
    field('studio-provider-model', 'test-model');
    field('studio-provider-endpoint', url);
    click('Save Provider');
    expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/HTTP or HTTPS/);
    expect(useAIStore.getState().providers).toHaveLength(0);
  });

  it('saves trimmed local settings without a key, with accessible selection and removal', () => {
    localProvider();
    field('studio-provider-model', '  test-model  ');
    field('studio-provider-endpoint', '  http://127.0.0.1:9999/v1/chat/completions  ');
    click('Save Provider');
    const [provider] = useAIStore.getState().providers;
    expect(provider).toMatchObject({ type: 'custom', apiKey: '', modelId: 'test-model', baseUrl: 'http://127.0.0.1:9999/v1/chat/completions' });
    expect(useAIStore.getState().activeProviderId).toBe(provider.id);
    expect(container.querySelector('[aria-label="Use 127.0.0.1 (test-model)"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('label[for="studio-generation-model"]')).toBeTruthy();
    expect(container.textContent).not.toContain('Reads screenshots');
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Remove 127.0.0.1 (test-model)"]')!.click());
    expect(useAIStore.getState().activeProviderId).toBeNull();
  });

  it('clears a pasted secret on preset changes and never shows saved key fragments', () => {
    render(<SettingsPanel />);
    click('Add Provider');
    field('studio-provider-key', 'example-only-secret');
    field('studio-provider-preset', 'openai');
    expect(container.querySelector<HTMLInputElement>('#studio-provider-key')!.value).toBe('');
    field('studio-provider-key', '  short  ');
    click('Save Provider');
    expect(useAIStore.getState().providers[0].apiKey).toBe('short');
    expect(container.textContent).toContain('API key saved');
    expect(container.textContent).not.toContain('short');
  });
});

describe('chat setup navigation', () => {
  it('opens the mobile settings action and retains an unsent draft through panel switches', () => {
    const openSettings = vi.fn();
    useAIStore.getState().setDraftMessage('Build my appointment app');
    render(<AIChat onOpenSettings={openSettings} />);
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.click());
    expect(openSettings).toHaveBeenCalledOnce();
    expect(useAIStore.getState().messages).toHaveLength(0);
    render(<SettingsPanel />);
    render(<AIChat onOpenSettings={openSettings} />);
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Message to AI"]')!.value).toBe('Build my appointment app');
  });

  it('routes the mobile Set up button through the host navigation', () => {
    const openSettings = vi.fn();
    render(<AIChat onOpenSettings={openSettings} />);
    click('Set up');
    expect(openSettings).toHaveBeenCalledOnce();
  });

  it('clears the draft when starting another project', () => {
    useAIStore.getState().setDraftMessage('Only for the old app');
    useAIStore.getState().resetSession();
    expect(useAIStore.getState().draftMessage).toBe('');
  });
});
