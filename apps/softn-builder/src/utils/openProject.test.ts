// @vitest-environment jsdom
/**
 * Opening replaces the workspace whole, or not at all.
 *
 * Opening a file, restoring the session and following a `?open=` link all
 * used to reset the live stores and then fill them in step by step, so a
 * failure halfway left the previous project gone and the new one half
 * there; the picker was awaited outside any handler, so a rejected read
 * was an unhandled rejection; a session that failed to parse was deleted,
 * taking the only copy of the work with it; and a `?open=` response that
 * arrived late replaced whatever project had been opened or edited since.
 *
 * Pinned: an invalid bundle, a rejected read or a malformed session
 * produce an error and leave the previous project and its dirty state
 * exactly as they were; a failure injected mid-commit rolls every store
 * back; a malformed session is quarantined, kept and exportable, not
 * deleted; a late remote result cannot overwrite a newer project or edits;
 * a link wins over the restore prompt, deterministically.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { loadBundle } from './bundleLoader';
import {
  QUARANTINE_STORAGE_KEY,
  SESSION_STORAGE_KEY,
  captureSession,
  commitProjectSnapshot,
  discardQuarantinedSession,
  openRemoteBundle,
  prepareProjectSnapshot,
  prepareSessionSnapshot,
  quarantineSession,
  readQuarantinedSession,
  startupAction,
} from './openProject';
import { useProjectStore } from '../stores/projectStore';
import { useCanvasStore } from '../stores/canvasStore';
import { useSchemaStore } from '../stores/schemaStore';
import { useFilesStore } from '../stores/filesStore';
import { useHistoryStore } from '../stores/historyStore';

function bundleNamed(name: string, extra: Record<string, string> = {}): Uint8Array {
  const files: Record<string, Uint8Array> = {
    'manifest.json': strToU8(
      JSON.stringify({ name, version: '1.0.0', description: '', main: 'ui/main.ui', files: { ui: ['ui/main.ui'], logic: [], xdb: [], assets: [] } })
    ),
    'ui/main.ui': strToU8(`<App><Text>${name}</Text></App>\n`),
  };
  for (const [k, v] of Object.entries(extra)) files[k] = strToU8(v);
  return zipSync(files);
}

/** Everything a test compares to prove the workspace did not move. */
function fingerprint() {
  const p = useProjectStore.getState();
  const c = useCanvasStore.getState();
  const f = useFilesStore.getState();
  const s = useSchemaStore.getState();
  return {
    projectId: p.projectId,
    revision: p.revision,
    isDirty: p.isDirty,
    name: p.name,
    description: p.description,
    canvasIds: [...c.elements.keys()],
    rootId: c.rootId,
    uiPaths: [...f.uiFiles.values()].map((u) => u.path),
    entities: s.entities.map((e) => e.name),
  };
}

beforeEach(() => {
  useCanvasStore.getState().reset();
  useProjectStore.getState().reset();
  useSchemaStore.getState().reset();
  useFilesStore.getState().reset();
  useHistoryStore.getState().clear();
  window.localStorage.clear();
  useProjectStore.getState().setName('Current work');
  useProjectStore.getState().setDescription('edited, unsaved');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a candidate that cannot be opened', () => {
  it('invalid bundle bytes: a thrown error, the workspace untouched', async () => {
    const before = fingerprint();
    await expect(loadBundle(new Uint8Array([1, 2, 3]))).rejects.toThrow();
    expect(fingerprint()).toEqual(before);
    expect(useProjectStore.getState().isDirty).toBe(true);
  });

  it('a bundle without its entry file: a named error, the workspace untouched', async () => {
    const before = fingerprint();
    const broken = zipSync({
      'manifest.json': strToU8(JSON.stringify({ name: 'B', version: '1', main: 'ui/app.ui', files: { ui: ['ui/app.ui'] } })),
      'ui/other.ui': strToU8('<App></App>'),
    });
    await expect(loadBundle(broken)).rejects.toThrow(/ui\/app\.ui/);
    expect(fingerprint()).toEqual(before);
  });

  it('a snapshot whose commit fails halfway: every store rolled back, still dirty', async () => {
    const before = fingerprint();
    const snapshot = prepareProjectSnapshot(await loadBundle(bundleNamed('Replacement')));
    const original = useFilesStore.getState().loadFromBundle;
    useFilesStore.setState({
      loadFromBundle: () => {
        throw new Error('injected: files store failed');
      },
    });
    try {
      expect(() => commitProjectSnapshot(snapshot)).toThrow(/injected/);
    } finally {
      useFilesStore.setState({ loadFromBundle: original });
    }
    expect(fingerprint()).toEqual(before);
    expect(useProjectStore.getState().name).toBe('Current work');
    expect(useProjectStore.getState().isDirty).toBe(true);
  });

  it('a good snapshot: committed whole, clean, a new project id', async () => {
    const before = fingerprint();
    commitProjectSnapshot(prepareProjectSnapshot(await loadBundle(bundleNamed('Replacement'))));
    const after = fingerprint();
    expect(after.name).toBe('Replacement');
    expect(after.isDirty).toBe(false);
    expect(after.revision).toBe(0);
    expect(after.projectId).not.toBe(before.projectId);
    expect(after.uiPaths).toEqual(['ui/main.ui']);
  });
});

describe('a malformed saved session', () => {
  it('is refused before any store is touched', () => {
    const before = fingerprint();
    expect(() => prepareSessionSnapshot('{not json')).toThrow(/not valid JSON/);
    expect(() => prepareSessionSnapshot(JSON.stringify({ project: {}, canvas: {} }))).toThrow(/missing/);
    // A session with a canvas that names a root it does not have.
    const good = captureSession('design');
    const bad = { ...good, canvas: { ...good.canvas, rootId: 'nowhere' } };
    expect(() => prepareSessionSnapshot(JSON.stringify(bad))).toThrow(/root element/);
    // A session whose asset does not decode.
    const badAsset = { ...good, files: { ...good.files, assetFiles: [['a', { name: 'x.png', type: 'image/png', data: '!!!not base64!!!' }]] } };
    expect(() => prepareSessionSnapshot(JSON.stringify(badAsset))).toThrow(/x\.png/);
    expect(fingerprint()).toEqual(before);
  });

  it('is quarantined with the reason, kept for export, not deleted', () => {
    const raw = '{"project":{},"canvas":{}}';
    window.localStorage.setItem(SESSION_STORAGE_KEY, raw);
    let error: unknown;
    try {
      prepareSessionSnapshot(raw);
    } catch (e) {
      error = e;
    }
    quarantineSession(raw, error);
    expect(window.localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
    const kept = readQuarantinedSession();
    expect(kept?.payload).toBe(raw);
    expect(kept?.error).toMatch(/missing/);
    expect(JSON.parse(window.localStorage.getItem(QUARANTINE_STORAGE_KEY)!).payload).toBe(raw);
    discardQuarantinedSession();
    expect(readQuarantinedSession()).toBeNull();
  });

  it('a good session round-trips through capture → prepare → commit with identity and passthrough intact', async () => {
    commitProjectSnapshot(
      prepareProjectSnapshot(await loadBundle(bundleNamed('With extras', { 'server/api.logic': 'export function onRequest() {}\n', 'README.md': 'hi' })))
    );
    const session = JSON.stringify(captureSession('data'));
    useProjectStore.getState().reset();
    const snapshot = prepareSessionSnapshot(session);
    commitProjectSnapshot(snapshot);
    expect(useProjectStore.getState().name).toBe('With extras');
    expect([...useProjectStore.getState().source.extraEntries.keys()].sort()).toEqual(['README.md', 'server/api.logic']);
    expect(new TextDecoder().decode(useProjectStore.getState().source.extraEntries.get('README.md'))).toBe('hi');
    expect(useProjectStore.getState().source.manifest?.main).toBe('ui/main.ui');
    expect(snapshot.view).toBe('data');
  });
});

describe('startup precedence', () => {
  function fakeLocation(search: string): Location {
    return { search, origin: 'https://builder.test', pathname: '/' } as Location;
  }
  function fakeHistory(): History & { replaced: string[] } {
    const replaced: string[] = [];
    return { replaced, replaceState: (_s: unknown, _t: string, url?: string | URL | null) => void replaced.push(String(url)) } as unknown as History & { replaced: string[] };
  }

  it('a same-origin .softn link wins over a stored session, and is consumed from the address bar', () => {
    const history = fakeHistory();
    const action = startupAction(fakeLocation('?open=/apps/x.softn&tab=2'), history, '{"a":1}');
    expect(action.kind).toBe('remote-open');
    expect((action as { url: URL }).url.href).toBe('https://builder.test/apps/x.softn');
    expect(history.replaced).toEqual(['/?tab=2']);
  });

  it('without a link, a stored session is offered; without either, nothing', () => {
    expect(startupAction(fakeLocation(''), fakeHistory(), '{"a":1}').kind).toBe('restore-prompt');
    expect(startupAction(fakeLocation(''), fakeHistory(), null).kind).toBe('nothing');
  });

  it('refuses another origin or a non-.softn path, and does not fall back to the restore prompt', () => {
    expect(startupAction(fakeLocation('?open=https://evil.test/x.softn'), fakeHistory(), '{"a":1}').kind).toBe('refused-link');
    expect(startupAction(fakeLocation('?open=/apps/x.zip'), fakeHistory(), '{"a":1}').kind).toBe('refused-link');
  });
});

describe('a remote open (?open=)', () => {
  type Deferred = { resolve: (r: Response) => void; reject: (e: unknown) => void };

  function deferredFetch(honourSignal: boolean): { fetchImpl: typeof fetch; deferred: Deferred } {
    const deferred: Deferred = { resolve: () => {}, reject: () => {} };
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        deferred.resolve = resolve;
        deferred.reject = reject;
        if (honourSignal) init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })) as unknown as typeof fetch;
    return { fetchImpl, deferred };
  }

  const response = (bytes: Uint8Array) => new Response(new Uint8Array(bytes), { status: 200 });
  const url = new URL('https://builder.test/apps/late.softn');

  it('cannot overwrite a project opened while it was in flight, even when the fetch ignores the signal', async () => {
    const { fetchImpl, deferred } = deferredFetch(false);
    const controller = new AbortController();
    const pending = openRemoteBundle(url, controller.signal, { fetchImpl, confirmReplace: () => true });

    // Meanwhile: a new project (as New / Open / restore do) and an edit to it.
    commitProjectSnapshot(prepareProjectSnapshot(await loadBundle(bundleNamed('Newer project'))));
    controller.abort();
    useProjectStore.getState().setDescription('newer edit');
    const before = fingerprint();

    deferred.resolve(response(bundleNamed('Late arrival')));
    const outcome = await pending;
    expect(outcome.kind).toBe('superseded');
    expect(fingerprint()).toEqual(before);
    expect(useProjectStore.getState().name).toBe('Newer project');
  });

  it('is dropped when the generation moved even without an abort', async () => {
    const { fetchImpl, deferred } = deferredFetch(false);
    const pending = openRemoteBundle(url, new AbortController().signal, { fetchImpl, confirmReplace: () => true });
    useProjectStore.getState().reset(); // a new project, generation advanced
    useProjectStore.getState().setName('Fresh');
    deferred.resolve(response(bundleNamed('Late arrival')));
    expect((await pending).kind).toBe('superseded');
    expect(useProjectStore.getState().name).toBe('Fresh');
  });

  it('asks before replacing an edited initial workspace, and a "no" keeps the edits', async () => {
    const { fetchImpl, deferred } = deferredFetch(true);
    const confirmReplace = vi.fn(() => false);
    const pending = openRemoteBundle(url, new AbortController().signal, { fetchImpl, confirmReplace });
    const before = fingerprint();
    deferred.resolve(response(bundleNamed('Offered')));
    expect((await pending).kind).toBe('declined');
    expect(confirmReplace).toHaveBeenCalledTimes(1);
    expect(fingerprint()).toEqual(before);
  });

  it('opens when nothing moved and the person agrees', async () => {
    const { fetchImpl, deferred } = deferredFetch(true);
    const pending = openRemoteBundle(url, new AbortController().signal, { fetchImpl, confirmReplace: () => true });
    deferred.resolve(response(bundleNamed('Accepted')));
    const outcome = await pending;
    expect(outcome.kind).toBe('opened');
    expect(useProjectStore.getState().name).toBe('Accepted');
    expect(useProjectStore.getState().isDirty).toBe(false);
  });

  it('an abort is quiet; a real failure is reported with the workspace untouched', async () => {
    const aborted = deferredFetch(true);
    const controller = new AbortController();
    const pendingAbort = openRemoteBundle(url, controller.signal, { fetchImpl: aborted.fetchImpl });
    controller.abort();
    expect((await pendingAbort).kind).toBe('superseded');

    const before = fingerprint();
    const failing = deferredFetch(true);
    const pendingFail = openRemoteBundle(url, new AbortController().signal, { fetchImpl: failing.fetchImpl });
    failing.deferred.resolve(new Response('nope', { status: 404 }));
    const outcome = await pendingFail;
    expect(outcome.kind).toBe('failed');
    expect(String((outcome as { error: Error }).error.message)).toMatch(/404/);
    expect(fingerprint()).toEqual(before);
  });
});
