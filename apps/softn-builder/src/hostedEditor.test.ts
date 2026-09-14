// @vitest-environment jsdom
/**
 * Hosted editor save contract (audit SN-04): a save is only "handled" once
 * the FormLogic parent confirms it; a closed channel is reported, never
 * swallowed; teardown settles every pending save as not saved.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Handlers = { open(bytes: Uint8Array, name: string): Promise<void>; export(): Promise<Uint8Array> | Uint8Array };

async function loadModule() {
  vi.resetModules();
  return import('../../shared/hostedEditor');
}

function hostedLocation() {
  Object.defineProperty(window, 'location', { value: { ...window.location, search: '?formlogicEditor=1', origin: 'http://formlogic.test', href: 'http://formlogic.test/app-editors/builder/index.html?formlogicEditor=1' }, configurable: true, writable: true });
  Object.defineProperty(window, 'parent', { value: { postMessage: vi.fn() }, configurable: true, writable: true });
}

function connect(mod: Awaited<ReturnType<typeof loadModule>>, handlers: Handlers) {
  const dispose = mod.connectHostedEditor(handlers);
  const channel = new MessageChannel();
  const fromParent: unknown[] = [];
  channel.port2.onmessage = event => { fromParent.push(event.data); };
  channel.port2.start();
  window.dispatchEvent(new MessageEvent('message', { data: { kind: 'formlogic-editor-connect', protocol: 1 }, origin: location.origin, source: window.parent as unknown as Window, ports: [channel.port1] }));
  return { dispose, parentPort: channel.port2, fromParent };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('requestHostedSave', () => {
  beforeEach(() => { vi.useRealTimers(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('is not handled outside a hosted editor', async () => {
    const mod = await loadModule();
    expect(mod.requestHostedSave()).toEqual({ handled: false, reason: 'not-hosted' });
  });

  it('reports a disconnected channel before the handshake instead of pretending', async () => {
    hostedLocation();
    const mod = await loadModule();
    expect(mod.requestHostedSave()).toEqual({ handled: false, reason: 'disconnected' });
    expect(mod.pendingHostedSaves()).toBe(0);
  });

  it('resolves only when FormLogic acknowledges the draft', async () => {
    hostedLocation();
    const mod = await loadModule();
    const { dispose, parentPort, fromParent } = connect(mod, { open: async () => {}, export: () => new Uint8Array([1]) });
    await flush();
    const outcome = mod.requestHostedSave();
    expect(outcome.handled).toBe(true);
    if (!outcome.handled) throw new Error('unreachable');
    await flush();
    const request = fromParent.find((m: unknown) => (m as { kind?: string }).kind === 'save-requested') as { kind: string; id: string };
    expect(request.id).toBe(outcome.id);
    let settled = false;
    void outcome.completion.then(() => { settled = true; });
    await flush();
    expect(settled).toBe(false);
    expect(mod.pendingHostedSaves()).toBe(1);

    parentPort.postMessage({ kind: 'save-result', id: outcome.id, ok: true });
    await expect(outcome.completion).resolves.toEqual({ ok: true, state: 'draft' });
    expect(mod.pendingHostedSaves()).toBe(0);

    const refused = mod.requestHostedSave();
    if (!refused.handled) throw new Error('unreachable');
    parentPort.postMessage({ kind: 'save-result', id: refused.id, ok: false, error: 'Version changed.' });
    await expect(refused.completion).resolves.toEqual({ ok: false, state: 'error', error: 'Version changed.' });
    dispose();
  });

  it('settles pending saves as not saved when the session ends', async () => {
    hostedLocation();
    const mod = await loadModule();
    const { dispose } = connect(mod, { open: async () => {}, export: () => new Uint8Array([1]) });
    await flush();
    const outcome = mod.requestHostedSave();
    if (!outcome.handled) throw new Error('unreachable');
    dispose();
    await expect(outcome.completion).resolves.toMatchObject({ ok: false, state: 'error' });
    expect(mod.requestHostedSave()).toEqual({ handled: false, reason: 'disconnected' });
  });

  it('times out an acknowledgement that never arrives', async () => {
    hostedLocation();
    vi.useFakeTimers();
    const mod = await loadModule();
    const { dispose } = connect(mod, { open: async () => {}, export: () => new Uint8Array([1]) });
    await vi.advanceTimersByTimeAsync(0);
    const outcome = mod.requestHostedSave();
    if (!outcome.handled) throw new Error('unreachable');
    await vi.advanceTimersByTimeAsync(60000);
    await expect(outcome.completion).resolves.toMatchObject({ ok: false, state: 'error' });
    dispose();
    vi.useRealTimers();
  });
});
