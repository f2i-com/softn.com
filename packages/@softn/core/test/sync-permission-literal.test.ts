/**
 * Peer sync starts only for `"sync": { "enabled": true }`.
 *
 * permission.json is a stranger's JSON, read as it came. The consent bar and
 * the directory's listing take a capability as asked for only when `enabled`
 * is the value `true`, so an app that wrote `"enabled": "false"` or `1`
 * showed as asking for no sync, and the one path that starts WebRTC
 * replication of the whole database took anything truthy.
 */
import { describe, expect, it, vi } from 'vitest';
import { createSyncControls } from '../src/runtime/db-sync-controls';
import type { PermissionConfig } from '../src/runtime/script-runtime';

function refusalFor(enabled: unknown): string[] {
  const refused: string[] = [];
  const controls = createSyncControls({
    appId: 'sync-permission-literal',
    getPermissionConfig: () => ({ permissions: { sync: { enabled } } }) as unknown as PermissionConfig,
    refuse: (reason) => refused.push(reason),
  });
  // A granted start loads the sync module; this test is about the ones that must not get that far.
  vi.spyOn(console, 'error').mockImplementation(() => {});
  controls.startSync('room');
  vi.restoreAllMocks();
  return refused;
}

describe('peer sync and a permission.json that says something other than true', () => {
  for (const enabled of ['false', 'true', 'yes', 1, {}, []]) {
    it(`refuses sync.enabled ${JSON.stringify(enabled)}`, () => {
      expect(refusalFor(enabled)).toEqual(['denied']);
    });
  }

  it('refuses a config that is absent or does not mention sync', () => {
    expect(refusalFor(undefined)).toEqual(['denied']);
    expect(refusalFor(false)).toEqual(['denied']);
  });

  // The hosts empty `permissions` while the bar asks, and the gate held only because each did.
  it('refuses while the permission bar is unanswered, whatever the config grants', () => {
    const refused: string[] = [];
    const controls = createSyncControls({
      appId: 'sync-permission-pending',
      getPermissionConfig: () => ({ permissions: { sync: { enabled: true } }, consentPending: true }) as unknown as PermissionConfig,
      refuse: (reason) => refused.push(reason),
    });
    controls.startSync('room');
    expect(refused).toEqual(['pending']);
  });
});
