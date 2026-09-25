/**
 * One undo step per run of edits to a field.
 *
 * The property panel pushed a step per keystroke, so typing `handleSubmit()`
 * was fourteen of the fifty the history keeps. Edits under one key join a
 * step while they keep coming; a pause, another key, an unkeyed change, an
 * undo or leaving the field starts a new one.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COALESCE_MS, useHistoryStore } from './historyStore';
import type { CanvasElement } from '../types/builder';

const tree = (label: string) => new Map<string, CanvasElement>([['root', { id: 'root', componentType: label, props: {}, children: [], parentId: null }]]);
const push = (label: string, key?: string) => useHistoryStore.getState().push(tree(label), 'root', key);
const steps = () => useHistoryStore.getState().past.map((entry) => entry.elements.get('root')!.componentType);

beforeEach(() => {
  vi.useFakeTimers();
  useHistoryStore.getState().clear();
});
afterEach(() => vi.useRealTimers());

describe('keyed edits', () => {
  it('join one step while they keep coming, keeping the state from before the run', () => {
    push('a', 'el:prop:text');
    vi.advanceTimersByTime(COALESCE_MS - 1);
    push('b', 'el:prop:text');
    vi.advanceTimersByTime(COALESCE_MS - 1);
    push('c', 'el:prop:text');
    expect(steps()).toEqual(['a']);
  });

  it('start a new step after a pause', () => {
    push('a', 'el:prop:text');
    vi.advanceTimersByTime(COALESCE_MS);
    push('b', 'el:prop:text');
    expect(steps()).toEqual(['a', 'b']);
  });

  it('start a new step under another key, after an unkeyed change, or once the run is ended', () => {
    push('a', 'el:prop:text');
    push('b', 'el:prop:size');
    push('c');
    push('d', 'el:prop:size');
    useHistoryStore.getState().endCoalescing();
    push('e', 'el:prop:size');
    expect(steps()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('do not join a step across an undo', () => {
    push('a', 'el:prop:text');
    useHistoryStore.getState().undo({ elements: tree('now'), rootId: 'root', timestamp: 0 });
    push('b', 'el:prop:text');
    expect(steps()).toEqual(['b']);
  });
});
