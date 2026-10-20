// @vitest-environment jsdom
/**
 * The header of Preview, over an app that has stopped.
 *
 * Driven first: logic that throws as it starts. The app's place said "The
 * app stopped with an error", and the header above it went on saying
 * "Running", with no way to start the app again short of leaving Preview.
 * The strip of what the logic reported leaves this failure to the renderer,
 * which draws it in place of the app (utils/previewProblems.ts), so the
 * header heard of it from nowhere.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useCanvasStore } from '../../stores/canvasStore';
import { useFilesStore } from '../../stores/filesStore';
import { useProjectStore } from '../../stores/projectStore';
import { useSchemaStore } from '../../stores/schemaStore';
import { LivePreview } from './LivePreview';

/** Whether the app, as the renderer runs it, throws as it starts, or as its page is drawn; and how often it was started. */
const app = vi.hoisted(() => ({ throws: true, drawingThrows: false, starts: 0 }));

// The renderer, standing in for the engine: it draws what it is given for an
// app that failed, as SoftNRenderer does, or the app.
vi.mock('./PreviewRuntime', async () => {
  const { createElement, useState } = await import('react');
  function PreviewRuntime(props: { error?: (error: Error) => React.ReactNode }) {
    const [failed] = useState(() => {
      app.starts += 1;
      return app.throws;
    });
    if (app.drawingThrows) throw new Error('the page could not be drawn');
    return failed ? props.error?.(new Error('boom as it starts')) : createElement('p', null, 'The app');
  }
  return { PreviewRuntime, previewRecordsFor: () => ({}) };
});
vi.mock('@softn/components/theme', () => ({ ThemeProvider: ({ children }: { children: React.ReactNode }) => children }));

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  app.throws = true;
  app.drawingThrows = false;
  app.starts = 0;
  useProjectStore.getState().reset();
  useFilesStore.getState().reset();
  useCanvasStore.getState().reset();
  useSchemaStore.getState().reset();
  const page = useFilesStore.getState().uiFiles.get('main_ui')!;
  useCanvasStore.getState().loadState(page.elements, page.rootId);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const badge = () => host.querySelector('[data-preview-live]');

async function open(): Promise<void> {
  await act(async () => {
    root.render(React.createElement(LivePreview));
  });
  // The renderer is loaded when Preview opens.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('an app whose logic throws as it starts', () => {
  it('is said to have stopped, and runs again from Restart once it can', async () => {
    await open();
    expect(app.starts).toBeGreaterThan(0);
    expect(badge()?.getAttribute('data-preview-live')).toBe('false');
    expect(badge()?.textContent).toBe('Stopped');

    app.throws = false;
    const restart = host.querySelector<HTMLButtonElement>('[data-action="restart-preview"]');
    expect(restart).not.toBeNull();
    act(() => restart!.click());
    expect(badge()?.getAttribute('data-preview-live')).toBe('true');
    expect(badge()?.textContent).toBe('Running');
    expect(host.querySelector('[data-action="restart-preview"]')).toBeNull();
  });

  it('is said to have stopped where its page could not be drawn, and that is started again by Restart too', async () => {
    app.throws = false;
    app.drawingThrows = true;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await open();
    expect(badge()?.textContent).toBe('Stopped');
    app.drawingThrows = false;
    act(() => host.querySelector<HTMLButtonElement>('[data-action="restart-preview"]')!.click());
    expect(badge()?.textContent).toBe('Running');
    vi.restoreAllMocks();
  });

  it('is running from the first where it does not throw', async () => {
    app.throws = false;
    await open();
    expect(badge()?.textContent).toBe('Running');
  });
});
