/**
 * An app hosted on FormLogic, mounted as SoftN's FormLogic frame mounts it (apps/formlogic-host/
 * src/web.ts): its archive made from what FormLogic sends (buildContainerSource), its media as
 * views into the one media pack the page fetched, what the frame lets the page hold (FRAME_EMBEDS),
 * nothing granted but what `init.permissions` grants, and its backend calls routed by the frame
 * (frameBackendCall). Its page nests an app it keeps under assets/, which starts in its box; it
 * holds no frame of another site; and its calls to FormLogic's page reach the parent, where the
 * nested app's, and the frame's own calls made by the app, reach nothing.
 *
 * In this package because its jsdom suite and its built engine are where SoftN runs a container in
 * a test; the FormLogic frame's own tests run under node, with no DOM (core's tests import the
 * frame's modules the same way).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { strToU8, zipSync } from 'fflate';
import { mountSoftNContainer } from '../src/index';
import { buildContainerSource, FRAME_EMBEDS, frameBackendCall, grantedContainerCapabilities } from '../../../../apps/formlogic-host/src/containerBridge';
import { grantedPermissions } from '../../../../apps/formlogic-host/src/permissions';
import type { Capability } from '@softn/bundle-format/capabilities';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LITE_WASM = path.join(PKG_ROOT, 'dist', 'runtime', 'engines', 'zipp-javascript-lite.wasm');

function settle(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** FormLogic's media pack as the page reads it (readMediaPackBytes): each file a view into one buffer. */
function mediaPack(files: Record<string, Uint8Array>): Record<string, Uint8Array> {
  const total = Object.values(files).reduce((sum, bytes) => sum + bytes.length, 0);
  const pack = new Uint8Array(12 + total);
  let at = 12;
  const views: Record<string, Uint8Array> = {};
  for (const [name, bytes] of Object.entries(files)) {
    pack.set(bytes, at);
    views[name] = pack.subarray(at, at + bytes.length);
    at += bytes.length;
  }
  return views;
}

/**
 * The storage the frame hands the container (its copy of what FormLogic keeps for the app, each
 * change sent to the parent as `nativeStorage`): here, a map of what was written to it.
 */
function frameStorage(): { storage: Storage; written: Map<string, string> } {
  const written = new Map<string, string>();
  const storage = {
    get length() { return written.size; },
    key: (index: number) => [...written.keys()][index] ?? null,
    getItem: (key: string) => written.get(key) ?? null,
    setItem: (key: string, value: string) => { written.set(key, String(value)); },
    removeItem: (key: string) => { written.delete(key); },
    clear: () => written.clear(),
  } as Storage;
  return { storage, written };
}

/** The app nested in the hosted one: an archive of its own, kept with the hosted app's media. */
const clock = zipSync({
  'index.html': strToU8(`<!DOCTYPE html><html><body><p id="time">12:00</p><script>
    console.log('clock ran');
    localStorage.setItem('who', 'clock-saved');
    console.log('clock kept ' + localStorage.getItem('who'));
    softn.backend.call('formlogicWallet', { op: 'open' }).then(function (reply) { console.log('clock wallet: ' + (reply && reply.error)); });
  </script></body></html>`),
});

/** What FormLogic's runtime GET sends a web app's frame: its manifest with `container`, and an empty permission.json. */
const client = new Map<string, string>([
  ['manifest.json', JSON.stringify({ name: 'Board', main: 'index.html', container: true })],
  ['permission.json', '{"permissions":{}}'],
  [
    'index.html',
    `<!DOCTYPE html><html><body>
      <softn-app id="clock" src="assets/widgets/clock.softn" style="display:block;height:120px"></softn-app>
      <iframe id="video" src="https://www.youtube.com/embed/abc"></iframe>
      <script>
        console.log('board ran');
        localStorage.setItem('who', 'board-saved');
        softn.backend.call('formlogicWallet', { op: 'open' }).then(function (reply) { console.log('board wallet: ' + JSON.stringify(reply)); });
        softn.backend.call('nativeStorage', { operation: 'batch', ops: [] }).then(function (reply) { console.log('board storage: ' + (reply && reply.error)); });
      </script>
    </body></html>`,
  ],
]);

describe('an app hosted on FormLogic', () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
  });

  it('runs an app it keeps among its media in a box of its page, through the FormLogic frame', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const said: string[] = [];
    const errors: string[] = [];
    const sent: Array<[string, Record<string, unknown>]> = [];
    const manifest = JSON.parse(client.get('manifest.json') as string) as Record<string, unknown>;
    const assets = mediaPack({ 'assets/logo.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47]), 'assets/widgets/clock.softn': clock });
    // As web.ts mounts it (a frame FormLogic gave no files grant), with the test's two stand-ins
    // for a browser: no Worker in jsdom, and the lite engine from this package's build.
    const permissions = grantedPermissions(undefined);
    const { storage, written } = frameStorage();
    const handle = await mountSoftNContainer(host, {
      source: buildContainerSource(client, assets, { allowLocalBackend: true, manifest }),
      appId: 'formlogic-board',
      storage,
      ...FRAME_EMBEDS,
      permissionMode: 'deny',
      permissionsOverride: permissions,
      initialGrantedCapabilities: grantedContainerCapabilities(permissions) as Capability[],
      downloads: 'deny',
      theme: 'light',
      backendCall: frameBackendCall(async (action, input) => {
        sent.push([action, input]);
        return { result: { closed: true, balanceCents: 250 } };
      }),
      onConsole: (level, text) => said.push(`${level}: ${text}`),
      onError: (error) => errors.push(error.message),
      isolation: 'inline',
      engineWasm: { lite: LITE_WASM },
    });
    await expect.poll(() => said.includes('log: clock ran') && said.some((line) => line.startsWith('log: clock wallet')), { timeout: 5000 }).toBe(true);
    await settle(100);
    expect(errors).toEqual([]);
    expect(said).toContain('log: board ran');

    // The nested app, in its box, read from the archive by the name its page gave it.
    const box = handle.shadowRoot.getElementById('clock') as HTMLElement;
    expect(box.localName).toBe('softn-app');
    expect(box.getAttribute('src')).toBe('/assets/widgets/clock.softn');
    // No frame of another site in this frame's page: its policy has no frame-src.
    expect(handle.shadowRoot.querySelectorAll('iframe')).toHaveLength(0);

    // The app's call to FormLogic's wallet reaches the parent and comes back with its answer; the
    // frame's own storage call is refused before the parent is asked; the nested app has no
    // backend of its own to ask through.
    expect(said).toContain('log: board wallet: {"result":{"closed":true,"balanceCents":250}}');
    expect(said).toContain('log: board storage: Use an app-relative API route under /api/.');
    expect(said).toContain('log: clock wallet: This app has no connected backend.');
    expect(sent).toEqual([['formlogicWallet', { op: 'open' }]]);

    // The app keeps its data where the frame keeps it (and so with FormLogic); the nested app keeps
    // its own while the page is open, in neither that storage nor the page's.
    await expect.poll(() => [...written.values()].some((value) => value.includes('board-saved')), { timeout: 5000 }).toBe(true);
    expect(said).toContain('log: clock kept clock-saved');
    expect([...written.values()].some((value) => value.includes('clock-saved'))).toBe(false);
    expect(Object.keys(localStorage).some((key) => (localStorage.getItem(key) ?? '').includes('clock-saved'))).toBe(false);
    handle.dispose();
  });
});
