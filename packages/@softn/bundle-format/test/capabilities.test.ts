import { describe, it, expect } from 'vitest';
import { describeStoragePolicy, inspectDeclaration, storagePolicyFor, type StoragePolicy } from '../src/capabilities';

describe('storage policies by collection name', () => {
  it('does not answer a collection name with something inherited from Object', () => {
    // "constructor" is a valid collection name (lowercase letters), and a
    // plain object answers it with a function. That is neither a policy nor
    // nullish, so `??` kept it and the default was never reached.
    expect(storagePolicyFor({}, 'constructor')).toBe('public');
    expect(storagePolicyFor({ '*': 'private' }, 'constructor')).toBe('private');
    const named: Record<string, StoragePolicy> = {};
    named['constructor'] = 'append-only';
    expect(storagePolicyFor(named, 'constructor')).toBe('append-only');
    expect(storagePolicyFor(inspectDeclaration({ permissions: { storage: { enabled: true } } }).storagePolicies, 'constructor')).toBe('public');
  });

  it('describes a policy it does not know as unknown, whatever its name', () => {
    expect(describeStoragePolicy('constructor')).toEqual({ label: 'constructor', summary: 'a policy this build does not describe' });
    expect(describeStoragePolicy('private').label).toBe('private to you');
  });
});
