import { describe, expect, it } from 'vitest';
import { createPreviewAssetResolver } from '../src/lib/previewAssets';
import type { VFSFile } from '../src/types/studio';

const file = (path: string, content: string | Uint8Array): VFSFile => ({
  path, content, mimeType: 'application/octet-stream', lastModified: 1,
  lastModifiedBy: 'user', version: 1,
});

describe('Studio bundle asset previews', () => {
  it('renders assets outside assets/ with the same MIME classification as the runtime', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>Portable</text></svg>';
    const files = new Map([
      ['images/logo.svg', file('images/logo.svg', svg)],
      ['media/voice.wav', file('media/voice.wav', new Uint8Array([82, 73, 70, 70]))],
      ['images/photo.webp', file('images/photo.webp', new Uint8Array([1, 2, 3]))],
    ]);
    const resolve = createPreviewAssetResolver(files, 'ui/main.ui');
    expect(resolve('images/logo.svg')).toBe(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
    expect(resolve('media/voice.wav')).toMatch(/^data:audio\/wav;base64,/);
    expect(resolve('images/photo.webp')).toBe('data:image/webp;base64,AQID');
    expect(resolve('../images/logo.svg')).toBe(resolve('images/logo.svg'));
  });

  it('keeps the assets/ shorthand and refreshes after an asset edit', () => {
    const before = new Map([['assets/logo.svg', file('assets/logo.svg', '<svg>Before</svg>')]]);
    const after = new Map([['assets/logo.svg', file('assets/logo.svg', '<svg>After</svg>')]]);
    const resolveBefore = createPreviewAssetResolver(before, 'ui/main.ui');
    const resolveAfter = createPreviewAssetResolver(after, 'ui/main.ui');
    expect(resolveBefore('logo.svg')).toBe(resolveBefore('./assets/logo.svg'));
    expect(decodeURIComponent(resolveBefore('logo.svg'))).toContain('Before');
    expect(decodeURIComponent(resolveAfter('logo.svg'))).toContain('After');
  });

  it('leaves missing assets empty and never exposes private editor state', () => {
    const files = new Map([['builder/brief.json', file('builder/brief.json', '{"private":true}')]]);
    const resolve = createPreviewAssetResolver(files, 'ui/main.ui');
    for (const path of ['missing.png', '../../outside.svg', '/images/logo.svg', 'builder/brief.json', '../builder/brief.json']) {
      expect(resolve(path)).toBe('');
    }
    expect(resolve('data:image/png;base64,AQID')).toBe('data:image/png;base64,AQID');
  });
});
