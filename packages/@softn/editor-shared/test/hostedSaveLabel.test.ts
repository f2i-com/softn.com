// @vitest-environment jsdom
/**
 * The host's name for saving back to it (`saveLabel` on `open`): the editor's
 * own button says what the host's button beside it says. Optional, with no
 * capability: a host that sends none leaves each editor its own label.
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

function session(mod: Mod) {
  const dispose = mod.connectHostedEditor({ open: async () => {}, export: () => new Uint8Array([1]) });
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

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('hosted save label', () => {
  it('is the label the host opened with, is announced to listeners, and goes with the host', async () => {
    hostedLocation();
    const mod = await loadModule();
    const heard = vi.fn();
    const unsubscribe = mod.subscribeHostedSaveLabel(heard);
    const s = session(mod);
    expect(mod.hostedSaveLabel()).toBeNull();
    s.open({ saveLabel: '  Save   changes ' });
    await flush();
    expect(mod.hostedSaveLabel()).toBe('Save changes');
    expect(heard).toHaveBeenCalledTimes(1);
    s.dispose();
    expect(mod.hostedSaveLabel()).toBeNull();
    expect(heard).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it('is null when the host sends none, or something that is not a short line of text', async () => {
    hostedLocation();
    const mod = await loadModule();
    const s = session(mod);
    s.open({});
    await flush();
    expect(mod.hostedSaveLabel()).toBeNull();
    s.dispose();
    expect(mod.readHostedSaveLabel(42)).toBeNull();
    expect(mod.readHostedSaveLabel('   ')).toBeNull();
    expect(mod.readHostedSaveLabel('x'.repeat(mod.HOSTED_SAVE_LABEL_MAX_CHARS + 1))).toBeNull();
    expect(mod.readHostedSaveLabel('Keep\nchanges')).toBe('Keep changes');
  });
});
