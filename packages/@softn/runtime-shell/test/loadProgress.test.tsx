/** @vitest-environment jsdom */
/**
 * The progress a host shows while an app's pieces download (src/LoadProgress.tsx),
 * over core's list of downloads.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetLoadProgressForTests, trackLoad, type LoadProgressItem } from '@softn/core';
import {
  FEATURE_LABELS,
  LoadProgress,
  describeDownload,
  downloadDetail,
  downloadedShare,
  formatBytes,
  visibleDownloads,
} from '../src/LoadProgress';
import { componentGroupChunks, featureChunks } from '../../../../scripts/build/on-demand-chunks.mjs';

const MB = 1024 * 1024;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const download = (change: Partial<LoadProgressItem>): LoadProgressItem => ({
  id: 'engine',
  kind: 'engine',
  loaded: 0,
  done: false,
  failed: false,
  startedAt: 0,
  ...change,
});

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  resetLoadProgressForTests();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('a download, in words', () => {
  it('is named as a person would name it', () => {
    expect(describeDownload(download({ kind: 'engine' }))).toBe('Script engine');
    expect(describeDownload(download({ kind: 'bundle', name: 'Notes' }))).toBe('Notes');
    expect(describeDownload(download({ kind: 'bundle' }))).toBe('The app');
    expect(describeDownload(download({ kind: 'components', name: 'scene3d' }))).toBe('3D');
    expect(describeDownload(download({ kind: 'components', name: 'something-new' }))).toBe('something-new');
  });

  it('names every on-demand feature the hosts build', () => {
    for (const feature of [...featureChunks, ...componentGroupChunks]) expect(FEATURE_LABELS[feature], feature).toBeTruthy();
  });

  it('says how far it has got', () => {
    expect(formatBytes(300)).toBe('1 KB');
    expect(formatBytes(512 * 1024)).toBe('512 KB');
    expect(formatBytes(6.5 * MB)).toBe('6.5 MB');
    expect(downloadDetail(download({ loaded: 2.4 * MB, total: 6.5 * MB }))).toBe('2.4 MB of 6.5 MB');
    expect(downloadDetail(download({ kind: 'components' }))).toBe('Loading…');
    expect(downloadDetail(download({ kind: 'components', done: true }))).toBe('Ready');
    expect(downloadDetail(download({ done: true, failed: true }))).toBe('Failed');
  });

  it('counts the bytes of the downloads whose size is known', () => {
    expect(downloadedShare([download({ loaded: MB, total: 4 * MB }), download({ kind: 'components' })])).toBe(0.25);
    expect(downloadedShare([download({ loaded: MB, total: 4 * MB }), download({ id: 'b', kind: 'bundle', total: 4 * MB, done: true })])).toBe(0.625);
    expect(downloadedShare([download({ kind: 'components' })])).toBeNull();
  });
});

describe('when it shows', () => {
  const items = [download({ startedAt: 100 }), download({ id: 'old', kind: 'bundle', done: true, startedAt: 10 })];

  it('waits out the delay, and shows nothing once everything has arrived', () => {
    expect(visibleDownloads(items, 'panel', 50, 200, 400)).toMatchObject({ show: false, nextCheck: 250 });
    expect(visibleDownloads(items, 'panel', 50, 450, 400).show).toBe(true);
    expect(visibleDownloads([download({ done: true })], 'panel', 0, 9999, 400).show).toBe(false);
    // A screen that replaces another while the engine is still on its way
    // shows it at once rather than waiting out the delay again.
    expect(visibleDownloads([download({ startedAt: 0 })], 'panel', 1000, 1001, 400).show).toBe(true);
  });

  it('counts, on a loading screen, what started since it appeared; over an app, what is still arriving', () => {
    expect(visibleDownloads(items, 'panel', 50, 999, 400).items.map((item) => item.id)).toEqual(['engine']);
    const finished = download({ id: 'b', kind: 'bundle', done: true, startedAt: 120 });
    expect(visibleDownloads([...items, finished], 'panel', 50, 999, 400).items.map((item) => item.id)).toEqual(['engine', 'b']);
    expect(visibleDownloads([...items, finished], 'bar', 50, 999, 400).items.map((item) => item.id)).toEqual(['engine']);
    // Over an app, from when the download started, not from when the bar mounted.
    expect(visibleDownloads(items, 'bar', 0, 450, 400).show).toBe(false);
    expect(visibleDownloads(items, 'bar', 0, 501, 400).show).toBe(true);
  });
});

describe('the panel', () => {
  it('appears once a download has gone on past the delay, with a bar and a line a download', async () => {
    act(() => root.render(<LoadProgress delayMs={30} />));
    let engine!: ReturnType<typeof trackLoad>;
    act(() => {
      engine = trackLoad('engine', 'engine', { total: 4 * MB });
      engine.advance(MB);
      trackLoad('components:controls', 'components', { name: 'controls' });
    });
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
    await act(async () => {
      await sleep(80);
    });
    const bar = container.querySelector('[role="progressbar"]')!;
    expect(bar.getAttribute('aria-valuenow')).toBe('25');
    expect(bar.getAttribute('aria-valuetext')).toContain('Script engine, 1.0 MB of 4.0 MB');
    expect(container.textContent).toContain('Form controls');
    await act(async () => {
      engine.finish();
      await sleep(40);
    });
    expect(container.querySelector('[role="progressbar"]')!.getAttribute('aria-valuenow')).toBe('100');
  });

  it('runs over an app as a line, under what the host draws above it, with a word for what is arriving', async () => {
    act(() => root.render(<LoadProgress variant="bar" delayMs={30} top="46px" />));
    act(() => {
      trackLoad('engine', 'engine', { total: 4 * MB }).advance(MB);
      trackLoad('components:scene3d', 'components', { name: 'scene3d' });
    });
    await act(async () => {
      await sleep(80);
    });
    expect(container.querySelector<HTMLElement>('.softn-load-bar')?.style.top).toBe('46px');
    expect(container.querySelector('.softn-load-pill')?.textContent).toBe('Script engine · 25%');
    expect(container.querySelector('.softn-load-pill')?.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuetext')).toContain('3D, Loading…');
  });

  it('never appears for a load that is over before the delay', async () => {
    act(() => root.render(<LoadProgress delayMs={30} />));
    act(() => trackLoad('engine', 'engine', { total: MB }).finish());
    await act(async () => {
      await sleep(80);
    });
    expect(container.innerHTML).toBe('');
  });
});
