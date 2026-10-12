// @vitest-environment jsdom
/**
 * A save FormLogic is still applying is not a save that failed.
 *
 * FormLogic answers `save-requested` by asking the editor for the project
 * (`export`, which it allows 45 seconds), then applies it, which has no time
 * limit (it can be the owner reviewing the changes), and only then sends
 * `save-result`. The editor gave FormLogic 60 seconds for all of it, and a
 * slow apply showed "FormLogic did not confirm the save" for a save that
 * went on to succeed. The 60 seconds are now for FormLogic to take the save
 * up: once it has asked for the project, its answer is waited for, and a
 * parent that never asks still fails at the deadline (the Builder's contract
 * test, apps/softn-builder/src/hostedEditor.test.ts, holds that half).
 */
import { afterEach, expect, it, vi } from 'vitest';

type Mod = typeof import('../src/hostedEditor');

function hostedLocation() {
  Object.defineProperty(window, 'location', { value: { ...window.location, search: '?formlogicEditor=1', origin: 'http://formlogic.test', href: 'http://formlogic.test/app-editors/builder/index.html?formlogicEditor=1' }, configurable: true, writable: true });
  Object.defineProperty(window, 'parent', { value: { postMessage: vi.fn() }, configurable: true, writable: true });
}

async function connected() {
  vi.resetModules();
  const mod: Mod = await import('../src/hostedEditor');
  const dispose = mod.connectHostedEditor({ open: async () => {}, export: () => new Uint8Array([7]) });
  const channel = new MessageChannel();
  const fromEditor: Array<Record<string, unknown>> = [];
  channel.port2.onmessage = (event) => { fromEditor.push(event.data); };
  channel.port2.start();
  window.dispatchEvent(new MessageEvent('message', { data: { kind: 'formlogic-editor-connect', protocol: 1 }, origin: location.origin, source: window.parent as unknown as Window, ports: [channel.port1] }));
  await settle();
  channel.port2.postMessage({ id: 'open-1', method: 'open', bytes: new Uint8Array([1]), name: 'App' });
  await settle();
  expect(fromEditor.find((m) => m.id === 'open-1')).toMatchObject({ ok: true });
  return { mod, dispose, parent: channel.port2, fromEditor };
}

afterEach(() => {
  vi.useRealTimers();
});

/** Messages cross the port on the real event loop; only the deadline's clock is faked. */
async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}
const fakeClock = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

it('takes a confirmation that comes after the deadline, once FormLogic has asked for the project', async () => {
  hostedLocation();
  fakeClock();
  const { mod, dispose, parent, fromEditor } = await connected();
  const outcome = mod.requestHostedSave();
  if (!outcome.handled) throw new Error('unreachable');
  let result: unknown = null;
  void outcome.completion.then((value) => { result = value; });
  await settle();
  expect(fromEditor.find((m) => m.kind === 'save-requested')).toMatchObject({ id: outcome.id });

  // FormLogic takes the save up: it asks for the project, and applies it.
  parent.postMessage({ id: 'export-1', method: 'export' });
  await settle();
  expect(fromEditor.find((m) => m.id === 'export-1')).toMatchObject({ ok: true });
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  expect(result).toBeNull();
  expect(mod.pendingHostedSaves()).toBe(1);

  parent.postMessage({ kind: 'save-result', id: outcome.id, ok: true });
  await settle();
  expect(result).toEqual({ ok: true, state: 'draft' });
  expect(mod.pendingHostedSaves()).toBe(0);
  dispose();
});

it('still reports a save FormLogic took up and then refused', async () => {
  hostedLocation();
  fakeClock();
  const { mod, dispose, parent } = await connected();
  const outcome = mod.requestHostedSave();
  if (!outcome.handled) throw new Error('unreachable');
  parent.postMessage({ id: 'export-1', method: 'export' });
  await settle();
  await vi.advanceTimersByTimeAsync(90_000);
  parent.postMessage({ kind: 'save-result', id: outcome.id, ok: false, error: 'The project changed. Reload before importing.' });
  await expect(outcome.completion).resolves.toEqual({ ok: false, state: 'error', error: 'The project changed. Reload before importing.' });
  dispose();
});

it('fails at the deadline when FormLogic never takes the save up', async () => {
  hostedLocation();
  fakeClock();
  const { mod, dispose } = await connected();
  const outcome = mod.requestHostedSave();
  if (!outcome.handled) throw new Error('unreachable');
  await vi.advanceTimersByTimeAsync(60_000);
  await expect(outcome.completion).resolves.toMatchObject({ ok: false, state: 'error' });
  dispose();
});

it('settles a save FormLogic took up as not saved when the session ends first', async () => {
  hostedLocation();
  fakeClock();
  const { mod, dispose, parent } = await connected();
  const outcome = mod.requestHostedSave();
  if (!outcome.handled) throw new Error('unreachable');
  parent.postMessage({ id: 'export-1', method: 'export' });
  await settle();
  dispose();
  await expect(outcome.completion).resolves.toMatchObject({ ok: false, state: 'error' });
});
