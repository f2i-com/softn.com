/** @vitest-environment jsdom */
/**
 * Connecting a provider, wherever it is done: the dashboard's first-visit
 * step, the setup dialog every AI prompt opens, and Settings. Provider
 * responses come from a stubbed fetch.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsPanel } from '../src/components/panels/SettingsPanel';
import { AIChat } from '../src/components/ai/AIChat';
import { ProviderSetup } from '../src/components/ai/ProviderSetup';
import { ProviderSetupDialog } from '../src/components/ai/ProviderSetupDialog';
import { needsProviderSetup } from '../src/components/ai/AIStatusPill';
import { clearModelListCache } from '../src/components/ai/useProviderModels';
import { Dashboard } from '../src/components/layout/Dashboard';
import { useAIStore } from '../src/stores/aiStore';
import { useWorkspaceStore } from '../src/stores/workspaceStore';
import type { ExampleProject } from '../src/examples';

let root: Root;
let container: HTMLDivElement;
let fetchMock: ReturnType<typeof vi.fn>;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  useAIStore.getState().resetSession();
  useAIStore.setState({ providers: [], activeProviderId: null, setupSkipped: false, setupDialog: null, modelProfile: { architect: '', builder: '', repair: '', vision: '' } });
  useWorkspaceStore.getState().reset();
  clearModelListCache();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function render(element: React.ReactNode) { act(() => root.render(element)); }
async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });
}
function button(text: string | RegExp): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((node) => {
    const label = node.textContent?.trim() ?? '';
    return typeof text === 'string' ? label === text : text.test(label);
  });
  expect(found, `Button: ${text}`).toBeTruthy();
  return found!;
}
function click(text: string | RegExp) { act(() => button(text).click()); }
function choose(title: string) {
  const label = [...container.querySelectorAll('label.st-choice')].find((node) => node.querySelector('.st-choice-title')?.textContent === title);
  expect(label, `Choice: ${title}`).toBeTruthy();
  act(() => label!.querySelector('input')!.click());
}
function type(labelText: string, value: string) {
  const label = [...container.querySelectorAll('label')].find((node) => node.textContent?.trim().startsWith(labelText) && node.htmlFor);
  expect(label, `Field: ${labelText}`).toBeTruthy();
  const input = container.querySelector<HTMLInputElement>(`[id="${label!.htmlFor}"]`)!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
function pickModel(id: string) {
  const option = container.querySelector<HTMLInputElement>(`.st-model-option input[value="${id}"]`);
  expect(option, `Model: ${id}`).toBeTruthy();
  act(() => option!.click());
}

describe('the setup', () => {
  it('offers the three kinds, with the other endpoint as an advanced option, and no model names', () => {
    render(<ProviderSetup />);
    const titles = [...container.querySelectorAll('.st-choice-title')].map((node) => node.textContent);
    expect(titles).toEqual(['Local model', 'OpenAI API key', 'Anthropic API key']);
    click('Other OpenAI-compatible endpoint…');
    expect(container.textContent).toContain('Other OpenAI-compatible endpoint');
    expect(container.textContent).not.toMatch(/Default:/);
  });

  it('connects an OpenAI key, lists its chat models, and saves the chosen one as the active provider', async () => {
    fetchMock.mockResolvedValueOnce(json({ data: [{ id: 'chat-one', created: 2 }, { id: 'text-embedding-x', created: 3 }, { id: 'chat-two', created: 1 }] }));
    const done = vi.fn();
    render(<ProviderSetup onDone={done} />);
    choose('OpenAI API key');
    expect(container.textContent).toMatch(/local storage for this site — not encrypted/);
    click('Connect');
    expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/Paste your OpenAI API key/);
    expect(fetchMock).not.toHaveBeenCalled();
    type('API key', '  sk-test-not-real  ');
    click('Connect');
    await settle();
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.openai.com/v1/models');
    const offered = [...container.querySelectorAll('.st-model-option input')].map((node) => (node as HTMLInputElement).value);
    expect(offered).toEqual(['chat-one', 'chat-two']);
    expect(button('Save and use').disabled).toBe(true);
    // "Show all" brings back the embedding model.
    act(() => container.querySelector<HTMLInputElement>('.st-check input')!.click());
    expect(container.querySelectorAll('.st-model-option')).toHaveLength(3);
    pickModel('chat-two');
    click('Save and use');
    const [provider] = useAIStore.getState().providers;
    expect(provider).toMatchObject({ type: 'openai', name: 'OpenAI', apiKey: 'sk-test-not-real', modelId: 'chat-two' });
    expect(provider.baseUrl).toBeUndefined();
    expect(useAIStore.getState().activeProviderId).toBe(provider.id);
    expect(done).toHaveBeenCalledWith(provider);
  });

  it('prefills a local server’s usual address and lets a model be typed when listing fails', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    render(<ProviderSetup />);
    choose('Local model');
    const address = () => container.querySelector<HTMLInputElement>('input[type="url"]')!.value;
    expect(address()).toBe('http://localhost:11434');
    const lmStudio = [...container.querySelectorAll('label.st-segment')].find((node) => node.textContent === 'LM Studio')!;
    act(() => lmStudio.querySelector('input')!.click());
    expect(address()).toBe('http://localhost:1234');
    click('Connect');
    await settle();
    expect(container.querySelector('.st-setup-error')?.textContent).toMatch(/Enable CORS/);
    // The fallback: an id typed as the server spells it.
    const manual = container.querySelector<HTMLInputElement>('.st-models input:not([type="search"])')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(manual, 'my-local-model');
      manual.dispatchEvent(new Event('input', { bubbles: true }));
    });
    click('Save and use');
    expect(useAIStore.getState().providers[0]).toMatchObject({ type: 'local', serverKind: 'lmstudio', apiKey: '', baseUrl: 'http://localhost:1234', modelId: 'my-local-model', name: 'LM Studio' });
  });

  it.each(['not a url', 'file:///tmp/model', 'https://user:password@example.com/v1', 'https://example.com/v1#secret'])('rejects an unusable address: %s', (url) => {
    render(<ProviderSetup />);
    choose('Local model');
    type('Server address', url);
    click('Connect');
    expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/http:\/\/ or https:\/\//);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('clears a pasted key when the kind changes, and never shows a saved key', async () => {
    fetchMock.mockImplementation(async () => json({ data: [{ id: 'm' }] }));
    render(<ProviderSetup />);
    choose('OpenAI API key');
    type('API key', 'example-only-secret');
    choose('Anthropic API key');
    expect(container.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe('');
    type('API key', 'short');
    click('Connect');
    await settle();
    pickModel('m');
    click('Save and use');
    const saved = useAIStore.getState().providers[0];
    expect(saved).toMatchObject({ type: 'anthropic', apiKey: 'short' });
    act(() => root.render(<ProviderSetup key="edit" provider={saved} />));
    await settle();
    expect(container.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe('');
    expect(container.innerHTML).not.toContain('short');
  });
});

describe('an old provider that relied on the removed default model', () => {
  const legacy = { id: 'old', type: 'anthropic' as const, name: 'Anthropic', apiKey: 'sk-test-not-real' };

  it('is shown as needing a model, and the chat asks for one instead of sending', () => {
    useAIStore.setState({ providers: [legacy], activeProviderId: 'old' });
    render(<AIChat />);
    expect(container.textContent).toContain('Choose a model for Anthropic');
    act(() => useAIStore.getState().setDraftMessage('Build a tracker'));
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.click());
    expect(useAIStore.getState().setupDialog).toEqual({ providerId: 'old' });
    expect(useAIStore.getState().messages).toHaveLength(0);
    expect(useAIStore.getState().draftMessage).toBe('Build a tracker');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('opens the dialog straight at its model list, and saving keeps its key', async () => {
    fetchMock.mockImplementation(async () => json({ data: [{ id: 'chosen-model' }], has_more: false, last_id: 'chosen-model' }));
    useAIStore.setState({ providers: [legacy], activeProviderId: 'old', setupDialog: { providerId: 'old' } });
    render(<ProviderSetupDialog />);
    await settle();
    expect(container.querySelector('#st-setup-dialog-title')?.textContent).toBe('Choose a model for Anthropic');
    expect(container.textContent).toContain('Change connection');
    pickModel('chosen-model');
    click('Save');
    expect(useAIStore.getState().providers).toEqual([{ ...legacy, modelId: 'chosen-model', baseUrl: undefined, orgId: undefined, serverKind: undefined }]);
    expect(useAIStore.getState().setupDialog).toBeNull();
  });

  it('is marked in Settings with a button that opens the setup dialog at its model list; saving refreshes the row', async () => {
    fetchMock.mockImplementation(async () => json({ data: [{ id: 'chosen-model' }], has_more: false, last_id: 'chosen-model' }));
    useAIStore.setState({ providers: [legacy], activeProviderId: 'old' });
    render(<><SettingsPanel /><ProviderSetupDialog /></>);
    expect(container.textContent).toContain('No model chosen');
    click('Choose a model');
    await settle();
    expect(useAIStore.getState().setupDialog).toEqual({ providerId: 'old' });
    expect(container.querySelector('#st-setup-dialog-title')?.textContent).toBe('Choose a model for Anthropic');
    // The dialog's own list: Settings shows a model picker too.
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
    act(() => dialog.querySelector<HTMLInputElement>('.st-model-option input[value="chosen-model"]')!.click());
    act(() => [...dialog.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Save')!.click());
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.textContent).not.toContain('No model chosen');
    expect(container.querySelector('.st-provider-model')?.textContent).toBe('chosen-model');
  });
});

describe('the chat without a provider', () => {
  it('opens the setup and keeps an unsent draft through panel switches', () => {
    useAIStore.getState().setDraftMessage('Build my appointment app');
    render(<AIChat />);
    expect(container.textContent).toContain('Connect an AI provider');
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.click());
    expect(useAIStore.getState().setupDialog).toEqual({ providerId: null });
    expect(useAIStore.getState().messages).toHaveLength(0);
    render(<SettingsPanel />);
    render(<AIChat />);
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Message to AI"]')!.value).toBe('Build my appointment app');
  });

  it('has one button that opens the setup, not a dead label', () => {
    render(<AIChat />);
    expect(container.textContent).not.toContain('No provider');
    click('Connect a provider');
    expect(useAIStore.getState().setupDialog).toEqual({ providerId: null });
  });

  it('clears the draft when starting another project', () => {
    useAIStore.getState().setDraftMessage('Only for the old app');
    useAIStore.getState().resetSession();
    expect(useAIStore.getState().draftMessage).toBe('');
  });
});

describe('Settings', () => {
  it('lists providers accessibly, picks the generation model from the provider’s list, and removes', async () => {
    fetchMock.mockImplementation(async () => json({ data: [{ id: 'model-a', created: 2 }, { id: 'model-b', created: 1 }] }));
    useAIStore.setState({
      providers: [{ id: 'p', type: 'local', serverKind: 'other', name: '127.0.0.1:9999', apiKey: '', baseUrl: 'http://127.0.0.1:9999/v1', modelId: 'model-a' }],
      activeProviderId: 'p',
    });
    render(<SettingsPanel />);
    await settle();
    expect(container.querySelector('[aria-label="Use 127.0.0.1:9999 (model-a)"]')?.getAttribute('aria-pressed')).toBe('true');
    // Per-role model: the provider's own is the default, the rest come from its list.
    expect(container.textContent).toContain('Same as the provider: model-a');
    pickModel('model-b');
    expect(useAIStore.getState().modelProfile.builder).toBe('model-b');
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Remove 127.0.0.1:9999 (model-a)"]')!.click());
    expect(useAIStore.getState().activeProviderId).toBeNull();
  });

  it('adds a provider in the same setup dialog, moving focus into it and back to the opener on Escape or Cancel', () => {
    render(<><SettingsPanel /><ProviderSetupDialog /></>);
    // The panel itself stays a compact list: no setup inline.
    expect(container.querySelector('.st-settings .st-choice')).toBeNull();
    const opener = button('Connect a provider');
    act(() => opener.focus());
    act(() => opener.click());
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.querySelectorAll('.st-choice')).toHaveLength(3);
    expect(dialog.contains(document.activeElement)).toBe(true);
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener);

    act(() => opener.click());
    click('Cancel');
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('opens the dialog from Add a provider and a row\'s Edit, and tests a provider from its row', async () => {
    fetchMock.mockImplementation(async (url: string) => (String(url).endsWith('/models') ? json({ data: [{ id: 'model-a' }] }) : json({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }], usage: {} })));
    useAIStore.setState({ providers: [{ id: 'p', type: 'openai', name: 'OpenAI', apiKey: 'k', modelId: 'model-a' }], activeProviderId: 'p' });
    render(<><SettingsPanel /><ProviderSetupDialog /></>);
    click('Add a provider');
    expect(useAIStore.getState().setupDialog).toEqual({ providerId: null });
    click('Cancel');
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Edit OpenAI (model-a)"]')!.click());
    expect(container.querySelector('#st-setup-dialog-title')?.textContent).toBe('Edit OpenAI');
    act(() => useAIStore.getState().closeProviderSetup());
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Test OpenAI (model-a)"]')!.click());
    await settle();
    expect(container.querySelector('.st-provider-test')?.textContent).toBe('Connected: the model replied.');
  });

  it('keeps the agent run settings', () => {
    render(<SettingsPanel />);
    const autoCheck = container.querySelector<HTMLInputElement>('#studio-agent-autocheck')!;
    expect(container.querySelector('label[for="studio-agent-autocheck"]')).toBeTruthy();
    expect(autoCheck.checked).toBe(true);
    act(() => autoCheck.click());
    expect(useAIStore.getState().agentSettings.autoCheck).toBe(false);
    act(() => container.querySelector<HTMLInputElement>('#studio-agent-deletes')!.click());
    expect(useAIStore.getState().agentSettings.confirmDeletes).toBe(false);
    expect(container.querySelector('label[for="studio-agent-steps"]')?.textContent).toBe('Max steps');
  });
});

describe('the dashboard asks for a provider first', () => {
  const example: ExampleProject = { id: 'ex', name: 'Example', description: 'An example.', files: [{ path: 'logic/main.logic', content: 'function go(id) {\n  page = id\n}' }] } as unknown as ExampleProject;

  it('gates only a first visit: no provider, not skipped, not a hosted editor', () => {
    expect(needsProviderSetup({ hosted: false, providerCount: 0, setupSkipped: false })).toBe(true);
    expect(needsProviderSetup({ hosted: false, providerCount: 0, setupSkipped: true })).toBe(false);
    expect(needsProviderSetup({ hosted: false, providerCount: 1, setupSkipped: false })).toBe(false);
    expect(needsProviderSetup({ hosted: true, providerCount: 0, setupSkipped: false })).toBe(false);
  });

  it('shows the setup before everything else, and locks the rest until it is done or skipped', () => {
    const onNewProject = vi.fn();
    const onSkip = vi.fn();
    render(<Dashboard onNewProject={onNewProject} onOpenExample={() => {}} examples={[example]} ai={{ gate: true, onSkip }} />);
    const first = container.querySelector('.st-home-inner')!.firstElementChild!;
    expect(first.querySelector('h1')?.textContent).toBe('Connect an AI provider.');
    expect(first.querySelector('.st-setup')).toBeTruthy();
    const locked = container.querySelector('.st-home-locked')!;
    expect(locked.hasAttribute('inert')).toBe(true);
    expect(locked.textContent).toContain('Start a new app');
    click('Explore examples without AI');
    expect(onSkip).toHaveBeenCalledOnce();
  });

  it('once skipped, the examples and a new app are usable, with a way back to the setup', () => {
    const onNewProject = vi.fn();
    const onOpenExample = vi.fn();
    render(<Dashboard onNewProject={onNewProject} onOpenExample={onOpenExample} examples={[example]} ai={{ gate: false, onSkip: () => {} }} />);
    expect(container.querySelector('[inert]')).toBeNull();
    expect(container.querySelector('.st-onboard')).toBeNull();
    act(() => container.querySelector<HTMLButtonElement>('[aria-label^="Open the JavaScript example"]')!.click());
    expect(onOpenExample).toHaveBeenCalledOnce();
    click(/Start a new app/);
    expect(onNewProject).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('The AI is not connected yet.');
    click(/Connect AI/);
    expect(useAIStore.getState().setupDialog).toEqual({ providerId: null });
  });

  it('shows no AI step or line in a hosted editor, where App passes no `ai`', () => {
    render(<Dashboard onNewProject={() => {}} />);
    expect(container.querySelector('.st-onboard')).toBeNull();
    expect(container.querySelector('.st-ai-pill')).toBeNull();
  });
});
