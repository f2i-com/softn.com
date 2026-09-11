/**
 * What each engine offers the apps, recorded per run. TEST_PLAN.md §1:
 * "Test File System Access separately from fallback download behaviour.
 * Document browser differences instead of expecting a native file handle
 * everywhere."
 *
 * The editors save and export through the File System Access API where it
 * exists and through a download where it does not; the hand-off runs on
 * IndexedDB and `rel="noopener"`; the runtime's engine is WebAssembly and
 * its scripts prefer a Worker. None of that is asserted to be *equal*
 * across engines — Firefox and WebKit have no `showSaveFilePicker`, and
 * that is a fact to record, not a failure. What every engine must have is
 * the floor the journeys stand on, and that is the only assertion here.
 *
 * The table is attached to the run as `browser-capabilities`, one line per
 * feature, so the matrix report shows what differed without anyone opening
 * a trace. The three desktop projects run this; the gate's Chromium row is
 * the baseline the others are read against.
 */
import { expect, test } from '@playwright/test';

test('records the engine’s capabilities and holds the floor the journeys need', async ({ page, browserName }, testInfo) => {
  await page.goto('/');
  const caps = await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const has = (name: string) => typeof w[name] !== 'undefined';
    return {
      userAgent: navigator.userAgent,
      // Saving and opening files: native handles, or a download and an <input type=file>.
      'File System Access: showSaveFilePicker': has('showSaveFilePicker'),
      'File System Access: showOpenFilePicker': has('showOpenFilePicker'),
      'File System Access: showDirectoryPicker': has('showDirectoryPicker'),
      'Origin-private file system (navigator.storage.getDirectory)': typeof navigator.storage?.getDirectory === 'function',
      // The hand-off and the apps' data.
      IndexedDB: has('indexedDB'),
      localStorage: (() => {
        try {
          return typeof localStorage !== 'undefined';
        } catch {
          return false;
        }
      })(),
      BroadcastChannel: has('BroadcastChannel'),
      'Storage persistence (navigator.storage.persist)': typeof navigator.storage?.persist === 'function',
      // The engine and where scripts run.
      WebAssembly: has('WebAssembly'),
      Worker: has('Worker'),
      SharedArrayBuffer: has('SharedArrayBuffer'),
      crossOriginIsolated: Boolean((w as { crossOriginIsolated?: boolean }).crossOriginIsolated),
      // What the runtime's optional capabilities would find.
      WebGPU: 'gpu' in navigator,
      'Web Speech (speechSynthesis)': has('speechSynthesis'),
      'Clipboard API (navigator.clipboard)': 'clipboard' in navigator,
      'Media devices (getUserMedia)': typeof navigator.mediaDevices?.getUserMedia === 'function',
      'Reduced motion honoured (matchMedia)': typeof window.matchMedia === 'function',
    };
  });

  const lines = Object.entries(caps).map(([name, value]) => `${String(value).padEnd(5)}  ${name}`);
  await testInfo.attach('browser-capabilities', {
    body: [`# ${browserName} (${testInfo.project.name})`, '', ...lines].join('\n'),
    contentType: 'text/plain',
  });

  // The floor: without these the hand-off, the runtime and the key store
  // cannot work, whichever engine this is.
  expect(caps.IndexedDB, 'IndexedDB carries the hand-off').toBe(true);
  expect(caps.localStorage, 'localStorage keeps the site’s keys').toBe(true);
  expect(caps.WebAssembly, 'the engine is WebAssembly').toBe(true);
  expect(caps.Worker, 'scripts prefer a Worker').toBe(true);
  expect(caps['Reduced motion honoured (matchMedia)']).toBe(true);

  // The documented differences, pinned so the report says which side each
  // engine is on and a change in either direction is noticed.
  const nativeFileHandles = caps['File System Access: showSaveFilePicker'];
  if (browserName === 'chromium') {
    expect(nativeFileHandles, 'Chromium: saves through a native handle').toBe(true);
  } else {
    expect(nativeFileHandles, `${browserName}: saves are downloads (no File System Access API)`).toBe(false);
  }
});
