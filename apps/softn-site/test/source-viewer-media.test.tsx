import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SourceFile } from '../src/lib/api';

const { getSource, copyText } = vi.hoisted(() => ({ getSource: vi.fn(), copyText: vi.fn() }));
vi.mock('../src/lib/api', () => ({ getSource }));
vi.mock('../src/lib/share', () => ({ copyText }));
import { SourceViewer } from '../src/components/directory/SourceViewer';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('SourceViewer all-file & media support', () => {
  let container: HTMLDivElement;
  let root: Root;

  const files: SourceFile[] = [
    { path: 'index.html', size: 28, text: '<h1>App</h1>', kind: 'text', mime: 'text/plain; charset=utf-8' },
    { path: 'server/index.php', size: 32, text: '<?php\n$x = 1;\necho $x;\n', kind: 'text', mime: 'text/plain; charset=utf-8' },
    { path: 'backend/src/main.rs', size: 36, text: '// rust\nfn main() -> u32 { 42 }\n', kind: 'text', mime: 'text/plain; charset=utf-8' },
    { path: 'server/schema.sql', size: 42, text: 'CREATE TABLE items (id INTEGER PRIMARY KEY);', kind: 'text', mime: 'text/plain; charset=utf-8' },
    { path: 'assets/logo.svg', size: 60, text: '<svg xmlns="http://www.w3.org/2000/svg"></svg>', kind: 'image', mime: 'image/svg+xml' },
    { path: 'assets/shot.png', size: 1200, text: null, kind: 'image', mime: 'image/png' },
    { path: 'assets/click.mp3', size: 4800, text: null, kind: 'audio', mime: 'audio/mpeg' },
    { path: 'assets/demo.mp4', size: 9600, text: null, kind: 'video', mime: 'video/mp4' },
  ];

  beforeEach(() => {
    vi.resetAllMocks();
    getSource.mockResolvedValue({ files, version: 2, truncated: false });
    copyText.mockResolvedValue(true);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const pickFile = async (name: string) => {
    const btn = [...container.querySelectorAll<HTMLButtonElement>('.source-file')].find((b) =>
      b.querySelector('.source-file-name')?.textContent === name,
    )!;
    expect(btn, `file button ${name}`).toBeDefined();
    await act(async () => btn.click());
  };

  it('highlights PHP, Rust, and SQL files and previews images, SVG code, audio, and video', async () => {
    await act(async () => {
      root.render(<SourceViewer slug="my-app" version={2} main="index.html" />);
    });

    // PHP syntax highlighting
    await pickFile('index.php');
    expect(container.querySelector('.source-code .tok-tag')?.textContent).toBe('<?php');
    expect(container.querySelector('.source-code .tok-attr')?.textContent).toBe('$x');

    // Rust syntax highlighting
    await pickFile('main.rs');
    expect(container.querySelector('.source-code .tok-com')?.textContent).toBe('// rust');
    expect(container.querySelector('.source-code .tok-mark')?.textContent).toBe('fn');

    // SQL syntax highlighting
    await pickFile('schema.sql');
    expect(container.querySelector('.source-code .tok-mark')?.textContent).toBe('CREATE');

    // PNG inline image preview
    await pickFile('shot.png');
    const img = container.querySelector<HTMLImageElement>('.source-media-image img')!;
    expect(img).not.toBeNull();
    expect(img.getAttribute('src')).toBe('/api/apps/my-app/source/file?path=assets%2Fshot.png&v=2');

    // SVG inline preview + toggle to inspect SVG code
    await pickFile('logo.svg');
    expect(container.querySelector('.source-media-image img')).not.toBeNull();
    const toggleBtn = [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'View SVG code')!;
    await act(async () => toggleBtn.click());
    expect(container.querySelector('.source-code')?.textContent).toContain('<svg');

    // Audio inline player
    await pickFile('click.mp3');
    const audio = container.querySelector<HTMLAudioElement>('audio')!;
    expect(audio).not.toBeNull();
    expect(audio.controls).toBe(true);
    expect(audio.getAttribute('src')).toBe('/api/apps/my-app/source/file?path=assets%2Fclick.mp3&v=2');

    // Video inline player
    await pickFile('demo.mp4');
    const video = container.querySelector<HTMLVideoElement>('video')!;
    expect(video).not.toBeNull();
    expect(video.controls).toBe(true);
    expect(video.getAttribute('src')).toBe('/api/apps/my-app/source/file?path=assets%2Fdemo.mp4&v=2');
  });
});
