// @vitest-environment jsdom
/**
 * What the app's logic reports while it runs in Preview is shown in Preview.
 *
 * Driven in Chromium first: a handler that is `while (true) {}` does not
 * hold the editor's tab (the engine stops the call when its budget of steps
 * is spent, in about a tenth of a second), but the engine is gone with it.
 * Every later press did nothing, the header said "Running", and the only
 * account of any of it was in the browser's console. A handler that threw
 * was the same button that did nothing.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readRuntimeProblem, stoppedSentence, watchRuntimeProblems, withProblem } from '../../utils/previewProblems';
import { PreviewProblems } from './PreviewProblems';

const budget = () => new RangeError('script exceeded its instruction budget');

describe('what the runtime writes to the console, read as a problem', () => {
  it('names the function that threw and says what it threw', () => {
    const thrown = new TypeError("Cannot read properties of null (reading 'here') (in save)");
    expect(readRuntimeProblem(['[SoftN] Error executing function save:', thrown])).toEqual({
      text: "save() failed: TypeError: Cannot read properties of null (reading 'here') (in save)",
      stopped: false,
    });
    expect(readRuntimeProblem(['[SoftN] Error executing sync function label:', new Error('no such name')])).toEqual({
      text: 'label() failed: no such name',
      stopped: false,
    });
  });

  it('knows the engine has stopped from a spent budget, and from what every call after it is told', () => {
    expect(readRuntimeProblem(['[SoftN] Error executing function spin:', budget()])?.stopped).toBe(true);
    expect(readRuntimeProblem(['[SoftN] Error executing function find:', new RangeError('regular expression exceeded its execution budget')])?.stopped).toBe(true);
    expect(readRuntimeProblem(['[SoftN] Error syncing state after spin:', 'zipp: engine is disposed'])).toEqual({
      text: 'What spin() changed could not be read back: zipp: engine is disposed',
      stopped: true,
    });
    expect(readRuntimeProblem(['[SoftN] The script engine has stopped (a call exceeded its budget or failed to compile); ignoring bump and later calls until the app is reloaded.'])?.stopped).toBe(true);
  });

  it('leaves alone what is not the runtime\'s, and what the renderer shows in place of the app already', () => {
    expect(readRuntimeProblem(['Warning: Each child in a list should have a unique "key" prop.'])).toBeNull();
    expect(readRuntimeProblem([new Error('[SoftN] not a line of the runtime')])).toBeNull();
    expect(readRuntimeProblem(['[SoftN] Error loading script:', budget()])).toBeNull();
    expect(readRuntimeProblem(['[SoftN] Component stack:', '\n    at Button'])).toBeNull();
  });

  it('keeps a sentence once, and hands back the same list when there is nothing new', () => {
    // The same list, not a copy: a page that reports at every drawing must
    // not be drawn again for a report already shown.
    const one = withProblem([], { text: 'a() failed: x', stopped: false });
    expect(one).toHaveLength(1);
    expect(withProblem(one, { text: 'a() failed: x', stopped: false })).toBe(one);
    let full = one;
    for (let i = 0; i < 40; i++) full = withProblem(full, { text: `b() failed: ${i}`, stopped: false });
    expect(full).toHaveLength(20);
    expect(withProblem(full, { text: 'never said before', stopped: true })).toBe(full);
    expect(full[0].text).toBe('a() failed: x');
  });

  it('still writes every line to the console, and gives the console back as it was', () => {
    const written: unknown[][] = [];
    const target = { error: (...args: unknown[]) => void written.push(args) };
    const original = target.error;
    const heard: string[] = [];
    const stop = watchRuntimeProblems(target, (problem) => heard.push(problem.text));
    target.error('[SoftN] Error executing function spin:', budget());
    target.error('something of the editor\'s own');
    expect(written).toHaveLength(2);
    expect(heard).toEqual(['spin() failed: RangeError: script exceeded its instruction budget']);
    stop();
    expect(target.error).toBe(original);
  });

  it('says which function ran past its budget where the runtime named one', () => {
    const spin = readRuntimeProblem(['[SoftN] Error executing function spin:', budget()])!;
    expect(stoppedSentence([spin])).toBe(
      'spin() ran past the number of steps one call is given, which is what a loop that never ends does. Nothing in the app answers until the preview is restarted.'
    );
    expect(stoppedSentence([{ text: 'What spin() changed could not be read back: zipp: engine is disposed', stopped: true }])).toBe(
      'Nothing in the app answers until the preview is restarted.'
    );
  });
});

describe('the sentences this reads are the ones the runtime writes', () => {
  // The runtime has no other way to be heard on the thread Preview runs it
  // on, so the lines are read as written. Reworded there, they would be
  // shown as they come, unnamed, and a stopped engine would not be known:
  // this fails first.
  const core = path.resolve(__dirname, '../../../../../packages/@softn/core/src/runtime');
  const runtime = fs.readFileSync(path.join(core, 'script-runtime.ts'), 'utf8');
  const engine = fs.readFileSync(path.join(core, 'zipp-wasm-adapter.ts'), 'utf8');

  it('as script-runtime.ts and the engine\'s adapter have them', () => {
    expect(runtime).toContain('console.error(`[SoftN] Error executing function ${name}:`, error)');
    expect(runtime).toContain('console.error(`[SoftN] Error executing sync function ${name}:`, error)');
    expect(runtime).toContain('console.error(`[SoftN] Error syncing state after ${name}:`, syncError)');
    expect(runtime).toContain('[SoftN] The script engine has stopped');
    expect(engine).toMatch(/engine is disposed/);
  });
});

describe('the strip above the app in Preview', () => {
  let root: Root;
  let host: HTMLDivElement;
  let restarts = 0;
  let stopped: boolean[] = [];
  const quiet = vi.fn();
  const original = console.error;

  const mount = (run = 0) =>
    act(() => root.render(React.createElement(PreviewProblems, { run, onRestart: () => void restarts++, onStopped: (now) => void stopped.push(now) })));
  /** As the runtime says it, and the microtask the strip waits before it keeps the sentence. */
  const say = (...args: unknown[]) =>
    act(async () => {
      console.error(...args);
      await Promise.resolve();
    });
  const strip = () => host.querySelector('[data-preview-problems]');

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    console.error = quiet;
    restarts = 0;
    stopped = [];
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    console.error = original;
  });

  it('is not there while the app has reported nothing', async () => {
    mount();
    expect(strip()).toBeNull();
    await say('Warning: something React said');
    expect(strip()).toBeNull();
  });

  it('shows what a handler threw, and can be put away', async () => {
    mount();
    await say('[SoftN] Error executing function save:', new TypeError('title is not defined'));
    expect(strip()?.getAttribute('data-preview-problems')).toBe('reported');
    expect(strip()?.getAttribute('role')).toBe('status');
    expect(strip()?.textContent).toContain('save() failed: TypeError: title is not defined');
    act(() => host.querySelector<HTMLButtonElement>('[data-action="dismiss-preview-problems"]')!.click());
    expect(strip()).toBeNull();
  });

  it('says the app has stopped when a call spends its budget, and restarts it from there', async () => {
    mount();
    await say('[SoftN] Error executing function spin:', budget());
    await say('[SoftN] Error syncing state after spin:', 'zipp: engine is disposed');
    expect(strip()?.getAttribute('data-preview-problems')).toBe('stopped');
    expect(strip()?.getAttribute('role')).toBe('alert');
    expect(strip()?.textContent).toContain('The app’s logic has stopped.');
    expect(strip()?.textContent).toContain('spin() ran past the number of steps one call is given');
    // Nothing to put away: the app does not answer until it is started again.
    expect(host.querySelector('[data-action="dismiss-preview-problems"]')).toBeNull();
    expect(stopped.at(-1)).toBe(true);

    act(() => host.querySelector<HTMLButtonElement>('[data-action="restart-preview"]')!.click());
    expect(restarts).toBe(1);
    // The new start begins with nothing reported.
    mount(1);
    expect(strip()).toBeNull();
    expect(stopped.at(-1)).toBe(false);
  });

  it('draws once for a sentence said at every drawing', async () => {
    mount();
    await say('[SoftN] Error executing sync function label:', new Error('engine is disposed'));
    const before = strip()!.innerHTML;
    const draws = vi.fn();
    const observer = new MutationObserver(draws);
    observer.observe(host, { childList: true, subtree: true, characterData: true });
    for (let i = 0; i < 50; i++) await say('[SoftN] Error executing sync function label:', new Error('engine is disposed'));
    await Promise.resolve();
    observer.disconnect();
    expect(draws).not.toHaveBeenCalled();
    expect(strip()!.innerHTML).toBe(before);
  });

  it('gives the console back when Preview is left', () => {
    mount();
    expect(console.error).not.toBe(quiet);
    act(() => root.render(null));
    expect(console.error).toBe(quiet);
  });
});
