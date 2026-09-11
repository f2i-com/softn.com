// @vitest-environment jsdom
/**
 * Opening a bundle from a `?open=` link cannot overtake what came after it.
 *
 * The fetch used to start unbound: nothing tied it to the workspace it was
 * fetched for, so a person who started a new project, imported a file or
 * accepted a restore while the response was on its way had that work
 * replaced when the response arrived last — and an aborted or failed open
 * still put "Could not open" on a project it was no longer about. Pinned
 * here with a fetch resolved by hand: a superseded response is not
 * imported; the superseding action aborts the signal; a fetch that ignores
 * its signal is still dropped at the ownership re-check; a superseded
 * error is not logged; and an unsuperseded open imports as usual. The link
 * checks — same origin, .softn — stay.
 */

import { describe, expect, it, vi } from 'vitest';
import { claimWorkspace, openRemoteBundle, readOpenLink, releaseWorkspace, bundleNameFromUrl } from '../src/lib/projectSession';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function response(bytes: Uint8Array): Response {
  return new Response(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { status: 200 });
}

const url = new URL('http://studio.test/apps/notes/bundle.softn');

describe('remote open ownership', () => {
  it('a late response cannot overwrite a newer project', async () => {
    const gate = deferred<Response>();
    const fetchStub = vi.fn(() => gate.promise);
    const importFile = vi.fn(async () => {});
    const log = vi.fn();

    const opening = openRemoteBundle(url, { fetch: fetchStub as unknown as typeof fetch, importFile, log });
    // The person starts something else before the response lands.
    claimWorkspace();
    gate.resolve(response(new Uint8Array([1, 2, 3])));
    await opening;

    expect(importFile).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('a superseding action aborts the request signal', async () => {
    const gate = deferred<Response>();
    let signal: AbortSignal | undefined;
    const fetchStub = vi.fn((_input: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return gate.promise;
    });
    const importFile = vi.fn(async () => {});
    const log = vi.fn();

    const opening = openRemoteBundle(url, { fetch: fetchStub as unknown as typeof fetch, importFile, log });
    expect(signal?.aborted).toBe(false);
    claimWorkspace();
    expect(signal?.aborted).toBe(true);
    gate.reject(new DOMException('aborted', 'AbortError'));
    await opening;

    expect(importFile).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('a fetch that ignores its signal is still dropped at the ownership re-check', async () => {
    const gate = deferred<Response>();
    const fetchStub = vi.fn(() => gate.promise);
    const importFile = vi.fn(async () => {});
    const log = vi.fn();

    const opening = openRemoteBundle(url, { fetch: fetchStub as unknown as typeof fetch, importFile, log });
    claimWorkspace();
    // Resolves anyway: the stub never looked at the signal.
    gate.resolve(response(new Uint8Array([1, 2, 3])));
    await opening;

    expect(importFile).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('an unmount suppresses a stale error', async () => {
    const gate = deferred<Response>();
    const fetchStub = vi.fn(() => gate.promise);
    const importFile = vi.fn(async () => {});
    const log = vi.fn();

    const opening = openRemoteBundle(url, { fetch: fetchStub as unknown as typeof fetch, importFile, log });
    releaseWorkspace();
    gate.reject(new TypeError('network gone'));
    await opening;

    expect(log).not.toHaveBeenCalled();
    expect(importFile).not.toHaveBeenCalled();
  });

  it('an open nobody superseded imports the bundle under the app name, as the claim owner', async () => {
    const bytes = new Uint8Array([80, 75, 3, 4]);
    const fetchStub = vi.fn(async () => response(bytes));
    const importFile = vi.fn(async () => {});
    const log = vi.fn();

    await openRemoteBundle(url, { fetch: fetchStub as unknown as typeof fetch, importFile, log });

    expect(importFile).toHaveBeenCalledTimes(1);
    const [file, generation] = importFile.mock.calls[0] as unknown as [File, number];
    expect(file.name).toBe('notes.softn');
    // jsdom's File has no arrayBuffer(); the size is what can be checked here.
    expect(file.size).toBe(bytes.length);
    expect(typeof generation).toBe('number');
    expect(log).not.toHaveBeenCalled();
  });

  it('a failed response is reported when nothing superseded it', async () => {
    const fetchStub = vi.fn(async () => new Response('', { status: 404 }));
    const log = vi.fn();
    await openRemoteBundle(url, { fetch: fetchStub as unknown as typeof fetch, importFile: vi.fn(async () => {}), log });
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/responded 404/));
  });
});

describe('the open link', () => {
  it('accepts only a same-origin .softn address', () => {
    const origin = 'http://studio.test';
    expect(readOpenLink('', origin)).toBeNull();
    expect(readOpenLink('?open=/apps/notes/bundle.softn', origin)).toMatchObject({ url: expect.any(URL) });
    expect(readOpenLink('?open=http://elsewhere.test/x.softn', origin)).toMatchObject({ error: expect.stringMatching(/this site/) });
    expect(readOpenLink('?open=/apps/notes/bundle.zip', origin)).toMatchObject({ error: expect.stringMatching(/\.softn/) });
    expect(readOpenLink('?open=%', origin)).toMatchObject({ error: expect.any(String) });
  });

  it('names the bundle after its app segment', () => {
    expect(bundleNameFromUrl(new URL('http://s.test/apps/my%20app/bundle.softn'))).toBe('my app');
    expect(bundleNameFromUrl(new URL('http://s.test/files/todo.softn'))).toBe('todo');
  });
});
