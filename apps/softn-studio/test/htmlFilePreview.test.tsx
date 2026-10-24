/** @vitest-environment jsdom */
/**
 * An .html file a project keeps among its assets is shown from its text,
 * never from an address with Studio's origin.
 *
 * It was a blob: URL in a sandboxed frame. The sandbox held it inside the
 * frame, but the URL is Studio's: opened as a page of its own ("Open Frame
 * in New Tab"), the file's script ran as Studio, with the provider keys in
 * its localStorage and every project in its IndexedDB.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VisualCanvas } from '../src/components/canvas/VisualCanvas';
import { useVFSStore, useWorkspaceStore } from '../src/stores';

const GUIDE = '<h1>Guide</h1><script>parent.document.title = "reached"</script>';

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  useWorkspaceStore.getState().reset();
  useVFSStore.getState().reset();
  useWorkspaceStore.setState({ projectId: `html-${Math.random().toString(36).slice(2)}`, projectName: 'Guide' });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('an .html file among the assets', () => {
  it('is drawn from its text in a sandboxed frame, and no URL is made of it', async () => {
    const made = vi.spyOn(URL, 'createObjectURL');
    useVFSStore.getState().hydrateFiles([
      { path: 'manifest.json', content: JSON.stringify({ name: 'Guide', version: '1.0.0', main: 'ui/main.ui' }) },
      { path: 'ui/main.ui', content: '<App><Text>Home</Text></App>' },
      { path: 'assets/guide.html', content: GUIDE },
    ]);
    useWorkspaceStore.setState({ activeFilePath: 'assets/guide.html' });
    await act(async () => { root.render(<VisualCanvas />); });
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    const frame = container.querySelector<HTMLIFrameElement>('iframe[title="App Preview"]');
    expect(frame).not.toBeNull();
    expect(frame!.getAttribute('srcdoc')).toBe(GUIDE);
    expect(frame!.hasAttribute('src')).toBe(false);
    expect(frame!.getAttribute('sandbox')).toBe('allow-scripts');
    expect(made.mock.calls.some(([blob]) => blob instanceof Blob && blob.type === 'text/html')).toBe(false);
  });
});
