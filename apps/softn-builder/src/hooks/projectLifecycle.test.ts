// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { useProjectStartup } from './useProjectStartup';
import { useUnsavedChanges } from './useUnsavedChanges';
import { openRemoteBundle, SESSION_STORAGE_KEY, type StartupAction } from '../utils/openProject';
import { useProjectStore } from '../stores/projectStore';
import { useFilesStore } from '../stores/filesStore';
import { useCanvasStore } from '../stores/canvasStore';
import { useSchemaStore } from '../stores/schemaStore';

let root: Root;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear();
  window.history.replaceState({}, '', '/');
  useProjectStore.getState().reset();
  useFilesStore.getState().reset();
  useCanvasStore.getState().reset();
  useSchemaStore.getState().reset();
  root = createRoot(document.createElement('div'));
});
afterEach(() => { act(() => root.unmount()); vi.restoreAllMocks(); });

function Startup({ run }: { run: (action: StartupAction) => void | (() => void) }) {
  useProjectStartup(run);
  return null;
}

describe('startup under React StrictMode', () => {
  it('restarts the consumed link after effect cleanup and opens the actual bundle', async () => {
    window.history.replaceState({}, '', '/?open=/test.softn');
    window.localStorage.setItem(SESSION_STORAGE_KEY, 'stored session must not replace the link');
    const bytes = zipSync({
      'manifest.json': strToU8(JSON.stringify({ name: 'Linked app', version: '1.0.0', main: 'ui/main.ui', files: { ui: ['ui/main.ui'], logic: [], xdb: [], assets: [] } })),
      'ui/main.ui': strToU8('<App><Text>Linked app</Text></App>'),
    });
    const signals: AbortSignal[] = [];
    const outcomes: ReturnType<typeof openRemoteBundle>[] = [];
    const fetchImpl = vi.fn(async (_url: string, options?: RequestInit) => {
      signals.push(options!.signal!);
      await Promise.resolve();
      return new Response(new Uint8Array(bytes));
    }) as unknown as typeof fetch;
    const run = vi.fn((action: StartupAction) => {
      if (action.kind !== 'remote-open') return;
      const controller = new AbortController();
      outcomes.push(openRemoteBundle(action.url, controller.signal, { fetchImpl }));
      return () => controller.abort();
    });
    await act(async () => {
      root.render(React.createElement(React.StrictMode, null, React.createElement(Startup, { run })));
    });
    const results = await Promise.all(outcomes);
    if (results[1].kind === 'failed') throw results[1].error;
    expect(results[1]).toMatchObject({ kind: 'opened' });
    expect(run.mock.calls.map(([action]) => action.kind)).toEqual(['remote-open', 'remote-open']);
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
    expect(useProjectStore.getState().name).toBe('Linked app');
    expect(window.location.search).toBe('');
  });

  it.each(['/?open=https://elsewhere.test/x.softn', '/'])('shows one refusal/restore prompt for %s', async (url) => {
    window.history.replaceState({}, '', url);
    window.localStorage.setItem(SESSION_STORAGE_KEY, '{}');
    const run = vi.fn();
    await act(async () => root.render(React.createElement(React.StrictMode, null, React.createElement(Startup, { run }))));
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0].kind).toBe(url === '/' ? 'restore-prompt' : 'refused-link');
  });
});

describe('unsaved navigation protection', () => {
  function Guard() { useUnsavedChanges(); return null; }
  const unload = () => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };
  it('warns for live schema/source edits, clears after save, and cleans up on unmount', () => {
    act(() => root.render(React.createElement(React.StrictMode, null, React.createElement(Guard))));
    expect(unload()).toBe(false);
    useSchemaStore.getState().addEntity({ x: 0, y: 0 });
    expect(unload()).toBe(true);
    useProjectStore.getState().markClean();
    expect(unload()).toBe(false);
    useProjectStore.getState().setLogicSource('let changed = true;');
    expect(unload()).toBe(true);
    act(() => root.render(null));
    expect(unload()).toBe(false);
  });
});
