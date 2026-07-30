/**
 * What ?open= is allowed to fetch.
 *
 * The value comes out of a link anyone can send the user and its contents are
 * executed, so the only thing standing between a crafted URL and a bundle from
 * somebody else's server is the origin check below.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { resolveBundleUrl, bundleNameFromUrl, fetchRemoteBundle } from '../src/lib/remoteBundle';

const ORIGIN = 'https://softn.example';

describe('a same-origin bundle path', () => {
  it('resolves against the page origin', () => {
    const url = resolveBundleUrl('/demos/SnakeGame.softn', ORIGIN);
    expect(url.href).toBe('https://softn.example/demos/SnakeGame.softn');
  });

  it('accepts the fully written form of the same URL', () => {
    const url = resolveBundleUrl('https://softn.example/demos/SnakeGame.softn', ORIGIN);
    expect(url.pathname).toBe('/demos/SnakeGame.softn');
  });

  it('accepts a subpath deployment', () => {
    expect(resolveBundleUrl('/web/demos/Notes.softn', ORIGIN).pathname).toBe('/web/demos/Notes.softn');
  });
});

describe('a bundle somewhere else', () => {
  it('is refused when named absolutely', () => {
    expect(() => resolveBundleUrl('https://evil.example/x.softn', ORIGIN)).toThrow(/another|only bundles served from this site/i);
  });

  it('is refused when named protocol-relatively', () => {
    // The case a naive check misses: "//evil.example/x.softn" starts with a
    // slash and contains no scheme, so it reads as a path — and resolves to
    // somebody else's host.
    expect(() => resolveBundleUrl('//evil.example/x.softn', ORIGIN)).toThrow(/evil\.example/);
  });

  it('is refused when the slashes are backslashes', () => {
    // URL parsing treats a backslash as a slash in the authority of a special
    // scheme, so these are the protocol-relative case wearing a hat.
    expect(() => resolveBundleUrl('\\\\evil.example/x.softn', ORIGIN)).toThrow(/evil\.example/);
    expect(() => resolveBundleUrl('/\\evil.example/x.softn', ORIGIN)).toThrow(/evil\.example/);
  });

  it('is refused when the origin differs only by scheme or port', () => {
    expect(() => resolveBundleUrl('http://softn.example/x.softn', ORIGIN)).toThrow();
    expect(() => resolveBundleUrl('https://softn.example:8443/x.softn', ORIGIN)).toThrow();
  });

  it('is refused for a scheme that is not the web at all', () => {
    expect(() => resolveBundleUrl('javascript:alert(1)//x.softn', ORIGIN)).toThrow();
    expect(() => resolveBundleUrl('data:application/zip;base64,UEsDBA==', ORIGIN)).toThrow();
  });

  it('is refused for a blob: URL, which claims this origin as its own', () => {
    // A blob URL's origin is the origin of the document that minted it, so
    // "blob:https://softn.example/<uuid>" passes an origin comparison, and its
    // pathname is the inner URL — which can be made to end in .softn. Only the
    // scheme distinguishes it from a bundle this site actually served.
    expect(() => resolveBundleUrl(`blob:${ORIGIN}/9a4dd0c5.softn`, ORIGIN)).toThrow(/http/i);
    expect(() => resolveBundleUrl(`filesystem:${ORIGIN}/temporary/x.softn`, ORIGIN)).toThrow(/http/i);
  });
});

describe('a same-origin path that is not a bundle', () => {
  it('is refused', () => {
    expect(() => resolveBundleUrl('/etc/passwd', ORIGIN)).toThrow(/only \.softn/i);
    expect(() => resolveBundleUrl('/demos/SnakeGame.softn.exe', ORIGIN)).toThrow(/only \.softn/i);
  });

  it('is not talked round by a query string that ends in .softn', () => {
    expect(() => resolveBundleUrl('/evil.html?x=.softn', ORIGIN)).toThrow(/only \.softn/i);
  });
});

describe('a same-origin path that redirects away', () => {
  const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);

  /** `Response.url` is getter-only, so the landing URL has to be faked wholesale. */
  function landingAt(finalUrl: string) {
    return vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          statusText: 'OK',
          url: finalUrl,
          headers: new Headers({ 'content-type': 'application/zip' }),
          body: null,
          arrayBuffer: async () => ZIP.buffer.slice(0),
        }) as unknown as Response
    );
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is refused after the fact, because the check before the fetch cannot see it', async () => {
    vi.stubGlobal('fetch', landingAt('https://evil.example/x.softn'));
    await expect(fetchRemoteBundle(new URL(`${ORIGIN}/demos/SnakeGame.softn`))).rejects.toThrow(/evil\.example/);
  });

  it('is allowed when the redirect stays on this origin', async () => {
    vi.stubGlobal('fetch', landingAt(`${ORIGIN}/demos/snakegame.softn`));
    const bytes = await fetchRemoteBundle(new URL(`${ORIGIN}/demos/SnakeGame.softn`));
    expect(Array.from(bytes.slice(0, 2))).toEqual([0x50, 0x4b]);
  });
});

describe('the name shown while a bundle downloads', () => {
  it('is the file name without its extension', () => {
    expect(bundleNameFromUrl(new URL('https://softn.example/demos/SnakeGame.softn'))).toBe('SnakeGame');
  });

  it('is decoded', () => {
    expect(bundleNameFromUrl(new URL('https://softn.example/demos/AI%20Chat.softn'))).toBe('AI Chat');
  });
});
