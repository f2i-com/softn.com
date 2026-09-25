/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MediaView, mediaKindFor } from '../src/components/canvas/MediaView';

let root: Root;
let container: HTMLDivElement;
let created: Array<{ url: string; blob: Blob }>;
let revoked: string[];

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  created = [];
  revoked = [];
  let n = 0;
  vi.stubGlobal('URL', Object.assign(URL, {
    createObjectURL: vi.fn((blob: Blob) => {
      const url = `blob:test/${++n}`;
      created.push({ url, blob });
      return url;
    }),
    revokeObjectURL: vi.fn((url: string) => { revoked.push(url); }),
  }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const bytes = new Uint8Array([1, 2, 3, 4]);

describe('which viewer a file gets', () => {
  it.each([
    ['assets/a.png', 'image'], ['assets/a.JPG', 'image'], ['assets/a.gif', 'image'], ['assets/a.webp', 'image'],
    ['assets/a.svg', 'image'], ['assets/a.avif', 'image'],
    ['assets/a.mp3', 'audio'], ['assets/a.wav', 'audio'], ['assets/a.ogg', 'audio'], ['assets/a.m4a', 'audio'], ['assets/a.flac', 'audio'],
    ['assets/a.mp4', 'video'], ['assets/a.webm', 'video'],
    ['assets/a.woff2', 'font'], ['assets/a.ttf', 'font'],
    ['assets/a.pdf', 'pdf'],
    ['assets/a.exr', null], ['assets/a.glb', null], ['logic/main.py', null],
  ])('%s → %s', (path, kind) => {
    expect(mediaKindFor(path)).toBe(kind);
  });
});

describe('MediaView', () => {
  it.each([
    ['assets/cover.png', 'img', 'image/png'],
    ['assets/theme.mp3', 'audio', 'audio/mpeg'],
    ['assets/clip.webm', 'video', 'video/webm'],
    ['assets/guide.pdf', 'object', 'application/pdf'],
  ])('shows %s in a <%s>, from a blob typed %s', (path, element, mime) => {
    act(() => root.render(<MediaView path={path} content={bytes} />));
    const node = container.querySelector(`.st-media-stage ${element}`);
    expect(node).toBeTruthy();
    expect(created).toHaveLength(1);
    expect(created[0].blob.type).toBe(mime);
    expect(node?.getAttribute(element === 'object' ? 'data' : 'src')).toBe(created[0].url);
    if (element === 'audio' || element === 'video') expect(node?.hasAttribute('controls')).toBe(true);
    expect(container.querySelector('.st-media-name')?.textContent).toBe(path.split('/').pop());
    expect(container.textContent).toContain('4 B');
  });

  it('draws an SVG kept as text through an image blob, never into the page', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="4" height="4"/></svg>';
    act(() => root.render(<MediaView path="assets/logo.svg" content={svg} />));
    expect(container.querySelector('img')?.getAttribute('src')).toBe(created[0].url);
    expect(created[0].blob.type).toBe('image/svg+xml');
    expect(container.querySelector('svg, script, rect')).toBeNull();
  });

  it('revokes the URL when the file changes and when the view goes', () => {
    act(() => root.render(<MediaView path="assets/a.png" content={bytes} />));
    const first = created[0].url;
    act(() => root.render(<MediaView path="assets/a.png" content={new Uint8Array([9])} />));
    expect(revoked).toEqual([first]);
    expect(created).toHaveLength(2);
    expect(container.querySelector('img')?.getAttribute('src')).toBe(created[1].url);
    act(() => root.unmount());
    expect(revoked).toEqual([first, created[1].url]);
    root = createRoot(container);
  });

  it('shows a font as a specimen, and removes the face again', async () => {
    const added: unknown[] = [];
    const deleted: unknown[] = [];
    class FakeFontFace {
      constructor(readonly family: string, readonly source: string) {}
      load() { return Promise.resolve(this); }
    }
    vi.stubGlobal('FontFace', FakeFontFace);
    Object.defineProperty(document, 'fonts', {
      value: { add: (face: unknown) => added.push(face), delete: (face: unknown) => deleted.push(face) },
      configurable: true,
    });
    await act(async () => { root.render(<MediaView path="assets/brand.woff2" content={bytes} />); });
    const face = added[0] as FakeFontFace;
    expect(face.source).toBe(`url(${created[0].url})`);
    const specimen = container.querySelector<HTMLElement>('.st-media-font')!;
    expect(specimen.style.fontFamily).toContain(face.family);
    expect(specimen.textContent).toContain('The quick brown fox');
    act(() => root.unmount());
    expect(deleted).toEqual([face]);
    root = createRoot(container);
  });

  it('gives any other file its name, type, size and a download instead of a viewer', () => {
    act(() => root.render(<MediaView path="assets/scene.glb" content={new Uint8Array(2048)} />));
    expect(container.textContent).toContain('No preview for this file type');
    expect(container.textContent).toContain('model/gltf-binary');
    expect(container.textContent).toContain('2.0 KB');
    const link = container.querySelector('a[download]');
    expect(link?.getAttribute('download')).toBe('scene.glb');
  });
});
