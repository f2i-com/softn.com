/**
 * A bundle's asset is never handed out as an active document on the site's
 * origin. A `blob:` URL belongs to the page that made it: a link to an `.html`
 * or `.svg` asset, or its address pasted into a tab, opened the bundle's own
 * document as a page of the site, its script held back only by the page's
 * `<meta>` CSP, and in a new tab not even by that.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { assetObjectUrl } from '../src/bundle/asset-classification';

const made: Blob[] = [];

function capture() {
  made.length = 0;
  const create = vi.fn((blob: Blob) => {
    made.push(blob);
    return `blob:https://site.example/${made.length}`;
  });
  Object.defineProperty(URL, 'createObjectURL', { value: create, configurable: true, writable: true });
  return create;
}

afterEach(() => {
  delete (URL as unknown as Record<string, unknown>).createObjectURL;
});

describe('an asset URL', () => {
  it('is a data: URL for an SVG, which an <img> draws and no browser opens as a page of the site', () => {
    const create = capture();
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    const url = assetObjectUrl('assets/logo.svg', new TextEncoder().encode(svg));
    expect(create).not.toHaveBeenCalled();
    expect(url.startsWith('data:image/svg+xml;base64,')).toBe(true);
    expect(new TextDecoder().decode(Uint8Array.from(atob(url.split(',')[1]), (c) => c.charCodeAt(0)))).toBe(svg);
    // Text of an SVG, as a bundle may carry one, the same.
    expect(assetObjectUrl('icon.svg', svg)).toBe(url);
  });

  it('is plain text for a document type, so opening it shows text', () => {
    capture();
    for (const path of ['guide.html', 'feed.xml', 'tool.js']) {
      expect(assetObjectUrl(path, '<html><script>alert(1)</script></html>')).toMatch(/^blob:/);
    }
    expect(made.map((blob) => blob.type)).toEqual(['text/plain;charset=utf-8', 'text/plain;charset=utf-8', 'text/plain;charset=utf-8']);
  });

  it('is a blob: URL of its own type for everything else, as before', () => {
    capture();
    for (const path of ['photo.png', 'song.mp3', 'manual.pdf', 'model.glb', 'data.json']) assetObjectUrl(path, new Uint8Array([1, 2, 3]));
    expect(made.map((blob) => blob.type)).toEqual(['image/png', 'audio/mpeg', 'application/pdf', 'model/gltf-binary', 'application/json']);
  });
});
