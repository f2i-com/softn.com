/**
 * The shared same-origin fetch: a redirect off this site is refused, a
 * page is not a bundle, a superseded response is dropped with its body
 * cancelled, and a good response yields its bytes.
 */
import { describe, expect, it, vi } from 'vitest';
import { fetchSameOriginBundle, isAbort, readRemoteBundle } from '../src/remoteOpen';

const url = new URL('http://studio.test/app/notes/bundle.softn');
const body = (bytes: number[]) => new Response(new Uint8Array(bytes), { status: 200 });

describe('fetchSameOriginBundle', () => {
  it('returns the bytes of a good response', async () => {
    const fetchStub = vi.fn(async (_input: string, _init?: RequestInit) => body([1, 2, 3]));
    const result = await fetchSameOriginBundle(url, { fetch: fetchStub as unknown as typeof fetch, signal: new AbortController().signal });
    expect(result).toEqual({ kind: 'bytes', bytes: new Uint8Array([1, 2, 3]) });
    expect(fetchStub.mock.calls[0]?.[1]).toMatchObject({ credentials: 'same-origin', mode: 'same-origin' });
  });

  it('refuses a response that redirected away from this site', async () => {
    const resp = body([1]);
    Object.defineProperty(resp, 'url', { value: 'http://elsewhere.test/x.softn' });
    await expect(fetchSameOriginBundle(url, { fetch: async () => resp, signal: new AbortController().signal }))
      .rejects.toThrow(/redirected away from this site/);
  });

  it('reports the status of a failed response and a page served instead of a bundle', async () => {
    await expect(fetchSameOriginBundle(url, { fetch: async () => new Response('nope', { status: 404 }), signal: new AbortController().signal }))
      .rejects.toThrow('/app/notes/bundle.softn responded 404');
    const page = new Response('<html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    await expect(fetchSameOriginBundle(url, { fetch: async () => page, signal: new AbortController().signal }))
      .rejects.toThrow(/returned a page/);
  });

  it('drops a response the workspace has moved past, cancelling its body', async () => {
    const resp = body([1, 2, 3]);
    const cancel = vi.spyOn(resp.body!, 'cancel');
    let moved = false;
    const result = await fetchSameOriginBundle(url, { fetch: async () => { moved = true; return resp; }, signal: new AbortController().signal, superseded: () => moved });
    expect(result).toEqual({ kind: 'superseded' });
    expect(cancel).toHaveBeenCalled();
  });

  it('bounds the download', async () => {
    await expect(readRemoteBundle(body([1, 2, 3, 4, 5, 6]), new AbortController().signal, 5)).rejects.toThrow(/smaller than 200 MB/);
    expect(isAbort(new DOMException('x', 'AbortError'))).toBe(true);
    expect(isAbort(new Error('x'))).toBe(false);
  });
});
