// @vitest-environment jsdom
/**
 * Which AI the host answers the editor's AI requests with (`aiLabel` on `open`): an embedded
 * Studio says which AI that is. Optional, with no capability: a host that sends none leaves the
 * editor saying only that the host's AI answers.
 */
import { describe, expect, it, vi } from 'vitest';

type Mod = typeof import('../src/hostedEditor');

async function loadModule(): Promise<Mod> {
  vi.resetModules();
  return import('../src/hostedEditor');
}

function hostedLocation() {
  Object.defineProperty(window, 'location', { value: { ...window.location, search: '?formlogicEditor=1', origin: 'http://formlogic.test', href: 'http://formlogic.test/app-editors/studio/index.html?formlogicEditor=1' }, configurable: true, writable: true });
  Object.defineProperty(window, 'parent', { value: { postMessage: vi.fn() }, configurable: true, writable: true });
}

function session(mod: Mod, opened: (label: string | null) => void = () => {}) {
  // What the editor's own `open` sees: the label is read before the project is handed over.
  const dispose = mod.connectHostedEditor({ open: async () => { opened(mod.hostedAiLabel()); }, export: () => new Uint8Array([1]) });
  const channel = new MessageChannel();
  channel.port2.start();
  window.dispatchEvent(new MessageEvent('message', {
    data: { kind: 'formlogic-editor-connect', protocol: 1 },
    origin: location.origin,
    source: window.parent as unknown as Window,
    ports: [channel.port1],
  }));
  const open = (extra: Record<string, unknown>) => channel.port2.postMessage({ id: 'open-1', method: 'open', bytes: new Uint8Array([80, 75]), name: 'Notes', ...extra });
  return { dispose, open };
}

describe('hosted AI label', () => {
  it('is the label the host opened with, there when the project opens, and goes with the host', async () => {
    hostedLocation();
    const mod = await loadModule();
    const heard = vi.fn();
    const unsubscribe = mod.subscribeHostedAiLabel(heard);
    const opened = vi.fn();
    const s = session(mod, opened);
    expect(mod.hostedAiLabel()).toBeNull();
    s.open({ aiLabel: '  Desktop AI —\n oaiy-engine · flash ' });
    await vi.waitFor(() => expect(mod.hostedAiLabel()).toBe('Desktop AI — oaiy-engine · flash'));
    await vi.waitFor(() => expect(opened).toHaveBeenCalledWith('Desktop AI — oaiy-engine · flash'));
    expect(heard).toHaveBeenCalledTimes(1);
    s.dispose();
    expect(mod.hostedAiLabel()).toBeNull();
    expect(heard).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it('is null when the host sends none or something that is not text, and a long one is cut', async () => {
    hostedLocation();
    const mod = await loadModule();
    const opened = vi.fn();
    const s = session(mod, opened);
    s.open({});
    await vi.waitFor(() => expect(opened).toHaveBeenCalledWith(null));
    s.dispose();
    expect(mod.readHostedAiLabel(42)).toBeNull();
    expect(mod.readHostedAiLabel('   ')).toBeNull();
    const long = mod.readHostedAiLabel('x'.repeat(mod.HOSTED_AI_LABEL_MAX_CHARS + 10))!;
    expect(long).toHaveLength(mod.HOSTED_AI_LABEL_MAX_CHARS);
    expect(long.endsWith('…')).toBe(true);
  });
});
