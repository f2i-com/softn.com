/** @vitest-environment jsdom */
/**
 * Studio inside FormLogic: its AI is FormLogic's, chosen there. Settings and the AI pill name
 * that AI (FormLogic sends its label with `open`), the test goes through FormLogic, and nothing
 * reaches for a provider of Studio's own: they said "localhost:11434 · no key", and their test
 * and model list asked that address, so FormLogic's AI looked unused. The bridge is a stand-in.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({ label: null as string | null, asked: [] as Array<Array<{ role: string; content: string }>>, reply: 'OK' as string | Error }));
vi.mock('@softn/editor-shared/hostedEditor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@softn/editor-shared/hostedEditor')>();
  return {
    ...actual,
    isHostedEditor: () => true,
    hostedAiLabel: () => host.label,
    subscribeHostedAiLabel: () => () => {},
    requestHostedAI: async (messages: Array<{ role: string; content: string }>) => {
      host.asked.push(messages);
      if (host.reply instanceof Error) throw host.reply;
      return host.reply;
    },
  };
});

import { SettingsPanel } from '../src/components/panels/SettingsPanel';
import { AIStatusPill } from '../src/components/ai/AIStatusPill';
import { useAIStore } from '../src/stores/aiStore';

let root: Root;
let container: HTMLDivElement;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host.label = 'Desktop AI — oaiy-engine · flash';
  host.asked = [];
  host.reply = 'OK';
  // What App.tsx sets when FormLogic opens the project.
  useAIStore.setState({ providers: [{ id: 'formlogic', type: 'custom', name: 'FormLogic AI', apiKey: '', modelId: host.label }], activeProviderId: 'formlogic', modelProfile: { architect: host.label, builder: host.label, repair: host.label, vision: host.label } });
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

const settle = async () => { for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); }); };
const buttons = () => [...container.querySelectorAll('button')].map((b) => b.textContent?.trim() ?? '');

describe('Studio in FormLogic', () => {
  it('names FormLogic’s AI in Settings, with nothing of a provider of its own, and never asks the network', async () => {
    act(() => root.render(<SettingsPanel />));
    await settle();
    const text = container.textContent ?? '';
    expect(text).toContain('FormLogic AI');
    expect(text).toContain('Desktop AI — oaiy-engine · flash');
    expect(text).toContain('Settings → AI');
    expect(text).not.toContain('localhost');
    expect(text).not.toContain('no key');
    // No list of providers to add to, edit or remove, and no model list to load.
    expect(buttons()).not.toContain('Add a provider');
    expect(container.querySelector('button[aria-label^="Remove"]')).toBeNull();
    expect(container.querySelector('button[aria-label^="Edit"]')).toBeNull();
    expect(text).not.toContain('Generation model');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('tests FormLogic’s AI through FormLogic, and says what it answered', async () => {
    act(() => root.render(<SettingsPanel />));
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="Test FormLogic’s AI"]')!.click(); });
    await settle();
    expect(host.asked).toHaveLength(1);
    expect(container.textContent).toContain('Connected: FormLogic’s AI replied.');
    host.reply = new Error('this desktop has no provider named "oaiy-engine"');
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="Test FormLogic’s AI"]')!.click(); });
    await settle();
    expect(container.querySelector('.st-provider-test.is-error')?.textContent).toContain('no provider named "oaiy-engine"');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('says only that FormLogic’s AI answers when FormLogic sent no label', async () => {
    host.label = null;
    act(() => root.render(<SettingsPanel />));
    expect(container.textContent).toContain('Your default AI in FormLogic');
  });

  it('shows FormLogic’s AI in the pill, which opens nothing it cannot', () => {
    act(() => root.render(<AIStatusPill />));
    const pill = container.querySelector('.st-ai-pill')!;
    expect(pill.tagName).toBe('SPAN');
    expect(pill.textContent).toBe('FormLogic AIDesktop AI — oaiy-engine · flash');
    expect(pill.getAttribute('title')).toContain('Change it in FormLogic: Settings → AI');
  });
});
