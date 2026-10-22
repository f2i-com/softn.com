/**
 * Peer-to-peer sync is for the app on screen. SoftN Web keeps every open app
 * mounted and shows one tab at a time, and an app's rooms ran on behind the
 * others — talking to peers, writing what they said into its records — and on
 * after the app closed, until the same app was opened again. Its rooms now
 * wait while its host shows another app, rejoin when it shows this one, and
 * close with it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const { providers, MockWebrtcProvider } = vi.hoisted(() => {
  const providers: Array<{
    shouldConnect: boolean;
    signalingConns: unknown[];
    connects: number;
    disconnects: number;
    destroyed: boolean;
  }> = [];
  class MockWebrtcProvider {
    shouldConnect = true;
    signalingConns: unknown[] = ['signaling'];
    awareness = {
      getStates: () => new Map([[1, {}], [2, {}]]),
      getLocalState: () => ({}),
      setLocalState: () => undefined,
      setLocalStateField: () => undefined,
    };
    room = { webrtcConns: new Map() };
    connects = 0;
    disconnects = 0;
    destroyed = false;
    constructor() {
      providers.push(this);
    }
    get connected() {
      return this.shouldConnect;
    }
    connect() {
      this.shouldConnect = true;
      this.connects++;
    }
    disconnect() {
      this.shouldConnect = false;
      this.disconnects++;
    }
    destroy() {
      this.destroyed = true;
    }
  }
  return { providers, MockWebrtcProvider };
});

vi.mock('y-webrtc', () => ({ WebrtcProvider: MockWebrtcProvider }));

import { appClosings, isAppShown, onAppActivity, openAppView, type AppView } from '../src/runtime/sync-activity';
import { getSavedSyncRoom, getSyncAdapter, startSync, stopAllSync } from '../src/runtime/xdb-sync';
import { createSyncControls } from '../src/runtime/db-sync-controls';
import type { PermissionConfig } from '../src/runtime/script-runtime';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { SoftNRenderer } from '../src/loader/SoftNRenderer';
import { SoftNWithXDB } from '../src/loader/xdb-bindings';

const views: AppView[] = [];
const view = (appId: string, shown = true): AppView => {
  const opened = openAppView(appId, shown);
  views.push(opened);
  return opened;
};
const sync = (appId: string, room: string) => startSync({ room, appId, signaling: [], persist: false });
const lastProvider = () => providers[providers.length - 1];

afterEach(() => {
  for (const opened of views.splice(0)) opened.close();
  stopAllSync();
});

describe("an app's views", () => {
  it('show the app while any of them is shown, and close it with the last', () => {
    const heard: string[] = [];
    const stop = onAppActivity((app, activity) => heard.push(`${app}:${activity}`));
    try {
      expect(isAppShown('views')).toBe(true);
      const first = view('views', false);
      expect(isAppShown('views')).toBe(false);
      const second = view('views');
      expect(isAppShown('views')).toBe(true);
      second.setShown(false);
      expect(isAppShown('views')).toBe(false);
      second.close();
      expect(appClosings('views')).toBe(0);
      first.close();
      expect(heard).toEqual(['views:hidden', 'views:shown', 'views:hidden', 'views:closed']);
      expect(appClosings('views')).toBe(1);
      expect(isAppShown('views')).toBe(true);
    } finally {
      stop();
    }
  });
});

describe("an app's rooms", () => {
  it('wait while the app is behind another, and rejoin on the same provider when it is shown', () => {
    const chat = view('chat');
    sync('chat', 'lobby');
    const provider = lastProvider();
    view('neighbour');
    sync('neighbour', 'lobby');
    const neighbourProvider = lastProvider();

    chat.setShown(false);
    expect(provider.shouldConnect).toBe(false);
    expect(provider.signalingConns).toEqual([]);
    expect(getSyncAdapter('lobby', 'chat')!.getStatus()).toMatchObject({ connected: false, peers: 0 });
    expect(neighbourProvider.shouldConnect).toBe(true);

    const count = providers.length;
    chat.setShown(true);
    expect(providers.length).toBe(count);
    expect(provider.connects).toBe(1);
    expect(getSyncAdapter('lobby', 'chat')!.getStatus()).toMatchObject({ connected: true, peers: 1 });
    expect(neighbourProvider.disconnects).toBe(0);
  });

  it('started while the app is hidden, open nothing until it is shown', () => {
    const late = view('late', false);
    const count = providers.length;
    const adapter = sync('late', 'room');
    expect(providers.length).toBe(count);
    expect(adapter.getStatus().connected).toBe(false);

    late.setShown(true);
    expect(providers.length).toBe(count + 1);
    expect(adapter.getStatus().connected).toBe(true);
  });

  it('close with the app, which still remembers the room it was in', () => {
    const closer = view('closer');
    sync('closer', 'keep');
    const provider = lastProvider();
    view('bystander');
    sync('bystander', 'keep');

    closer.close();
    expect(getSyncAdapter('keep', 'closer')).toBeNull();
    expect(provider.disconnects).toBe(1);
    expect(provider.destroyed).toBe(true);
    expect(getSavedSyncRoom('closer')).toBe('keep');
    expect(getSyncAdapter('keep', 'bystander')).not.toBeNull();
  });

  it('close cleanly while they wait', () => {
    const paused = view('paused-close');
    sync('paused-close', 'room');
    const provider = lastProvider();
    paused.setShown(false);
    paused.close();
    expect(provider.disconnects).toBe(1);
    expect(provider.destroyed).toBe(true);
    expect(getSyncAdapter('room', 'paused-close')).toBeNull();
  });

  it('are not started for an app that closed while the sync module loaded', async () => {
    const permissionConfig = { permissions: { sync: { enabled: true } } } as unknown as PermissionConfig;
    const controls = createSyncControls({ appId: 'gone', getPermissionConfig: () => permissionConfig, refuse: () => undefined });
    const first = view('gone');
    controls.startSync('early', { signaling: [], persist: false });
    first.close();

    view('gone');
    controls.startSync('later', { signaling: [], persist: false });
    await vi.waitFor(() => expect(getSyncAdapter('later', 'gone')).not.toBeNull());
    expect(getSyncAdapter('early', 'gone')).toBeNull();
  });
});

describe('the renderer', () => {
  it("says whether its host shows the app, and closes the app's view as it goes", async () => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const render = (active: boolean) =>
      act(async () => root.render(createElement(SoftNRenderer, { source: '<p>hi</p>', appId: 'rendered', active })));
    try {
      await render(true);
      await render(false);
      expect(isAppShown('rendered')).toBe(false);
      await render(true);
      expect(isAppShown('rendered')).toBe(true);
      await render(false);
      expect(isAppShown('rendered')).toBe(false);
      await act(async () => root.unmount());
      expect(appClosings('rendered')).toBe(1);
      expect(isAppShown('rendered')).toBe(true);
    } finally {
      container.remove();
    }
  });

  // Mounting closed the app's saved room, taken for one a previous mount had
  // left open; with the app open in another view, it was that view's room.
  it("leaves the room another view of the app is in when it mounts", async () => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    view('twin');
    sync('twin', 'shared-desk');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(createElement(SoftNWithXDB, { source: '<p>hi</p>', appId: 'twin' })));
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      expect(getSyncAdapter('shared-desk', 'twin')).not.toBeNull();
      await act(async () => root.unmount());
      // The first view is still open, so the app is too.
      expect(getSyncAdapter('shared-desk', 'twin')).not.toBeNull();
    } finally {
      container.remove();
    }
  });
});
