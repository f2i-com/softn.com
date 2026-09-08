/**
 * What a tab's app starts from: the page it was opened at and the room it
 * was last in — and no connection flag.
 *
 * The runner used to seed `syncConnecting` beside a saved room whenever the
 * consent bar was answered. Nothing reconnects a saved room on open (softn-web
 * never passes resumeSavedSyncRoom), so the flag described a connection
 * nothing was attempting, and the only code that would clear it — the app's
 * own sync control, on a status coming back — never ran. The app came up
 * saying "connecting" and stayed there.
 */

import { describe, expect, it } from 'vitest';
import { buildRunnerInitialState, savedSyncRoomKey } from '../src/lib/runnerState';

describe('buildRunnerInitialState', () => {
  it('seeds the saved room without claiming a connection', () => {
    const state = buildRunnerInitialState({ initialPage: 'home', savedRoom: 'room-1' });
    expect(state).toEqual({ currentPage: 'home', syncRoom: 'room-1' });
    expect(state).not.toHaveProperty('syncConnecting');
  });

  it('seeds the room alone when the tab has no page', () => {
    expect(buildRunnerInitialState({ savedRoom: 'room-1' })).toEqual({ syncRoom: 'room-1' });
  });

  it('seeds only the page when no room was saved', () => {
    expect(buildRunnerInitialState({ initialPage: 'home', savedRoom: null })).toEqual({
      currentPage: 'home',
    });
    expect(buildRunnerInitialState({ initialPage: 'home' })).toEqual({ currentPage: 'home' });
  });

  it('is undefined with nothing to seed, so the renderer keeps its own defaults', () => {
    expect(buildRunnerInitialState({})).toBeUndefined();
    expect(buildRunnerInitialState({ initialPage: '', savedRoom: '' })).toBeUndefined();
  });
});

describe('savedSyncRoomKey', () => {
  it('is the app-namespaced key core writes, so a room seeded here is this app\'s own', () => {
    expect(savedSyncRoomKey('digest-a')).toBe('xdb-sync-active-room:digest-a');
  });

  it('is the bare key only for an app run without an id', () => {
    expect(savedSyncRoomKey(undefined)).toBe('xdb-sync-active-room');
  });
});
