/**
 * Channels the consent bar does not describe, held on consent state.
 *
 * permission.json enumerates the softn.* capabilities, and withholding them is
 * what the bar's Allow releases. Two outbound channels are not in that list at
 * all, so nothing about withholding could touch them — and while a modal
 * blocked the load they were unreachable by accident, because the app did not
 * exist yet. Rendering the app first removes the accident.
 *
 * `manifest.config.server.url` is the worse of the two: a socket to a host the
 * bundle chose, replicating the app's collections to it, opened on mount. It
 * appears in no requestedCapabilities list, so the bar can say "this app wants
 * to use the internet" while the socket is already up.
 *
 * It is replication of the app's database to other devices, which is what
 * permission.json's `sync` declares and the bar names ("your other
 * devices"), so it is held to that declaration as peer sync is: a bundle that
 * does not declare `sync`, or ships no permission.json, opens no socket.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SoftNWithXDB, createXDBHelpers } from '../src/loader/xdb-bindings';
import { getXDB } from '../src/runtime/xdb';
import type { PermissionConfig } from '../src/runtime/script-runtime';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Every XDBServerSync this test constructed, and every URL it dialled. */
const dialled: string[] = [];

vi.mock('../src/runtime/xdb-server-sync', () => ({
  XDBServerSync: class {
    constructor(_xdb: unknown, options: { wsUrl: string }) {
      if (options.wsUrl.includes('refused')) throw new Error('refused by the client');
      dialled.push(options.wsUrl);
    }
    on(): void {}
    setAppShown(): void {}
    connect(): void {}
    disconnect(): void {}
  },
}));

const SERVER = 'wss://sync.example.com/sync';

/** What the host runs an app with while the bar is unanswered. */
const withheld: PermissionConfig = {
  app: { name: 'Probe' },
  permissions: {},
  consentPending: true,
} as PermissionConfig;

/** What it runs with after Allow. */
const granted: PermissionConfig = {
  app: { name: 'Probe' },
  permissions: { net: { enabled: true }, sync: { enabled: true } },
} as PermissionConfig;

/** A bundle that names a sync server and does not declare sync. */
const undeclared: PermissionConfig = {
  app: { name: 'Probe' },
  permissions: { net: { enabled: true } },
} as PermissionConfig;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function render(config: PermissionConfig | undefined): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container!);
    root.render(
      <SoftNWithXDB source="<div>probe</div>" serverUrl={SERVER} permissionConfig={config} />,
    );
  });
  await settle();
}

async function rerender(config: PermissionConfig): Promise<void> {
  await act(async () => {
    root!.render(
      <SoftNWithXDB source="<div>probe</div>" serverUrl={SERVER} permissionConfig={config} />,
    );
  });
  await settle();
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  dialled.length = 0;
});

describe('a bundle whose manifest names a sync server', () => {
  it('opens no socket while the consent bar is unanswered', async () => {
    await render(withheld);
    expect(dialled).toEqual([]);
  });

  it('opens it once the user allows, without a reload', async () => {
    await render(withheld);
    expect(dialled).toEqual([]);
    // Exactly what Allow does to the tab: same tree, granted config.
    await rerender(granted);
    expect(dialled).toEqual([SERVER]);
  });

  it('opens it immediately when there is nothing to consent to', async () => {
    await render(granted);
    expect(dialled).toEqual([SERVER]);
  });

  it('opens none for a bundle that does not declare sync, and says what to declare', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await render(undeclared);
    expect(dialled).toEqual([]);
    expect(warn.mock.calls.some((call) => String(call[0]).startsWith('[SoftN] Server sync not started') && String(call[0]).includes('"sync": { "enabled": true }'))).toBe(true);
    warn.mockRestore();
  });

  it('opens none for a bundle that ships no permission.json', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await render(undefined);
    expect(dialled).toEqual([]);
    warn.mockRestore();
  });

  it('says so when the sync client cannot start, rather than running silently unsynced', async () => {
    // The failure used to land in an empty `.catch`: the app looked normal
    // and simply never synced.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    container = document.createElement('div');
    document.body.appendChild(container);
    await act(async () => {
      root = createRoot(container!);
      root.render(
        <SoftNWithXDB
          source="<div>probe</div>"
          serverUrl="wss://refused.example.com/sync"
          permissionConfig={granted}
        />
      );
    });
    await settle();
    expect(warn).toHaveBeenCalledWith(
      '[SoftN] Server sync could not start:',
      expect.objectContaining({ message: 'refused by the client' })
    );
    warn.mockRestore();
  });
});

describe('the xdb helpers sync gate', () => {
  const helpers = (config?: PermissionConfig) =>
    createXDBHelpers(getXDB(), undefined, 'consent-test', config);

  it('refuses peer replication while consent is pending', () => {
    expect(() => helpers(withheld).startSync('room')).toThrow(/not permitted yet/i);
  });

  it('tells the user which button to press, not the author which file to edit', () => {
    // The third of three sync gates. checkPermission and
    // createDBNamespace.startSync were both given this branch; this one still
    // told a user to go and edit a permission.json inside a bundle they cannot
    // open, for a line its author had already written.
    let message = '';
    try {
      helpers(withheld).startSync('room');
    } catch (err) {
      message = String(err);
    }
    expect(message).toMatch(/Allow/);
    expect(message).not.toMatch(/permission\.json/);
  });

  it('still tells an author with no declaration what to declare', () => {
    expect(() => helpers().startSync('room')).toThrow(/permission\.json/);
  });
});
