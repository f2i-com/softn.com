/**
 * The capability schema: reading a declaration the way every host must.
 */

import { describe, expect, it } from 'vitest';
import { CAPABILITIES, CAPABILITY_INFO, STORAGE_POLICIES, STORAGE_POLICY_INFO, inspectDeclaration, isCapability, storagePolicyFor } from '../src/runtime/capabilities';

describe('inspectDeclaration', () => {
  it('lists what was enabled, in schema order', () => {
    const report = inspectDeclaration({
      permissions: { storage: { enabled: true }, net: { enabled: true, allowed_hosts: ['a.example'] }, camera: { enabled: false } },
    });
    expect(report).toEqual({ requested: ['net', 'storage'], unknown: [], malformed: [], storagePolicies: {} });
  });

  it('reads a policy per storage collection, and names the ones it cannot accept', () => {
    const report = inspectDeclaration({
      permissions: {
        storage: {
          enabled: true,
          collections: { scores: 'append-only', notes: 'private', '*': 'owner-write', posts: 'readonly', 'Bad-Name': 'public', admin: 7 },
        },
      },
    });
    expect(report.requested).toEqual(['storage']);
    expect(report.storagePolicies).toEqual({ scores: 'append-only', notes: 'private', '*': 'owner-write' });
    expect(report.malformed).toEqual(['storage.collections.posts', 'storage.collections.Bad-Name', 'storage.collections.admin']);
    expect(inspectDeclaration({ permissions: { storage: { enabled: true, collections: ['scores'] } } }).malformed).toEqual(['storage.collections']);
    expect(inspectDeclaration({ permissions: { storage: { enabled: true } } }).storagePolicies).toEqual({});
  });

  it('answers the policy for a collection: named, else the default, else shared', () => {
    const policies = { scores: 'append-only' as const, '*': 'private' as const };
    expect(storagePolicyFor(policies, 'scores')).toBe('append-only');
    expect(storagePolicyFor(policies, 'anything')).toBe('private');
    expect(storagePolicyFor({ scores: 'append-only' }, 'anything')).toBe('public');
    expect(storagePolicyFor(undefined, 'scores')).toBe('public');
  });

  it('accepts an empty or absent declaration', () => {
    const empty = { requested: [], unknown: [], malformed: [], storagePolicies: {} };
    expect(inspectDeclaration({})).toEqual(empty);
    expect(inspectDeclaration({ permissions: {} })).toEqual(empty);
    expect(inspectDeclaration({ permissions: { net: undefined } })).toEqual(empty);
  });

  it('names what it cannot accept instead of dropping it', () => {
    const report = inspectDeclaration({
      permissions: { network: { enabled: true }, net: 'yes', camera: { enabled: 'true' }, mic: null, accel: { enabled: true } },
    });
    expect(report.unknown).toEqual(['network']);
    expect(report.malformed).toEqual(['net', 'camera', 'mic']);
    expect(report.requested).toEqual(['accel']);
  });

  it('refuses a declaration that is not an object', () => {
    expect(inspectDeclaration(null).malformed).toEqual(['permissions']);
    expect(inspectDeclaration([]).malformed).toEqual(['permissions']);
    expect(inspectDeclaration({ permissions: [] }).malformed).toEqual(['permissions']);
    expect(inspectDeclaration({ permissions: 'all' }).malformed).toEqual(['permissions']);
  });
});

describe('the schema', () => {
  it('has words for every capability and no words for anything else', () => {
    for (const name of CAPABILITIES) {
      expect(CAPABILITY_INFO[name].label).not.toBe('');
      expect(CAPABILITY_INFO[name].summary).not.toBe('');
    }
    expect(Object.keys(CAPABILITY_INFO).sort()).toEqual([...CAPABILITIES].sort());
    expect(isCapability('accel')).toBe(true);
    expect(isCapability('network')).toBe(false);
    expect(Object.keys(STORAGE_POLICY_INFO).sort()).toEqual([...STORAGE_POLICIES].sort());
  });
});
