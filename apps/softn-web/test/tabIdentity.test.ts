/**
 * Which tab a bundle belongs to: identity, never the name.
 *
 * The launcher used to find a running tab by the manifest's name and a
 * placeholder by the file's name. Two builds of Notes, or two unrelated
 * bundles both called Notes, selected the tab already open — the person who
 * had just opened an update was shown the old build with nothing to say so.
 */

import { describe, expect, it } from 'vitest';
import { displayNameFor, findPlaceholder, findRunningTab, findTabForUrlName, type TabLike } from '../src/lib/tabIdentity';

const running = (id: string, name: string, appId: string, version?: string): TabLike => ({ id, name, appId, source: '<App/>', version });
const placeholder = (id: string, name: string): TabLike => ({ id, name, source: '' });

describe('findRunningTab', () => {
  it('finds the tab running these exact bytes and not a same-name one', () => {
    const tabs = [running('t1', 'Notes', 'digest-a', '1.0.0'), running('t2', 'Notes', 'digest-b', '1.1.0')];
    expect(findRunningTab(tabs, 'digest-b')?.id).toBe('t2');
    expect(findRunningTab(tabs, 'digest-a')?.id).toBe('t1');
    expect(findRunningTab(tabs, 'digest-c')).toBeUndefined();
  });

  it('does not count a placeholder, which has no bytes yet', () => {
    const tabs = [placeholder('p', 'Notes')];
    expect(findRunningTab(tabs, 'digest-a')).toBeUndefined();
  });
});

describe('findPlaceholder', () => {
  it('claims the placeholder by the id the load was given, whatever it is called', () => {
    const tabs = [placeholder('p1', 'AIChat'), placeholder('p2', 'Notes'), running('t1', 'Notes', 'digest-a')];
    expect(findPlaceholder(tabs, 'p1')?.name).toBe('AIChat');
    expect(findPlaceholder(tabs, 'p2')?.name).toBe('Notes');
  });

  it('claims nothing without an id, and nothing already filled in', () => {
    const tabs = [placeholder('p1', 'Notes'), running('t1', 'Notes', 'digest-a')];
    expect(findPlaceholder(tabs, undefined)).toBeUndefined();
    expect(findPlaceholder(tabs, 't1')).toBeUndefined();
    expect(findPlaceholder(tabs, 'gone')).toBeUndefined();
  });
});

describe('findTabForUrlName', () => {
  it('prefers the tab being looked at when two share the address', () => {
    const tabs = [running('t1', 'Notes', 'a'), running('t2', 'Notes', 'b')];
    expect(findTabForUrlName(tabs, 'Notes', 't2')?.id).toBe('t2');
    expect(findTabForUrlName(tabs, 'Notes', 't1')?.id).toBe('t1');
    expect(findTabForUrlName(tabs, 'Notes', null)?.id).toBe('t1');
    expect(findTabForUrlName(tabs, 'Notes', 'elsewhere')?.id).toBe('t1');
    expect(findTabForUrlName(tabs, 'Other', 't2')).toBeUndefined();
  });
});

describe('displayNameFor', () => {
  it('appends the version only when two open tabs share a name and differ by it', () => {
    const one = [running('t1', 'Notes', 'a', '1.0.0')];
    expect(displayNameFor(one[0], one)).toBe('Notes');

    const two = [running('t1', 'Notes', 'a', '1.0.0'), running('t2', 'Notes', 'b', '1.1.0')];
    expect(displayNameFor(two[0], two)).toBe('Notes v1.0.0');
    expect(displayNameFor(two[1], two)).toBe('Notes v1.1.0');

    const same = [running('t1', 'Notes', 'a', '1.0.0'), running('t2', 'Notes', 'b', '1.0.0')];
    expect(displayNameFor(same[0], same)).toBe('Notes');

    const unversioned = [running('t1', 'Notes', 'a'), running('t2', 'Notes', 'b', '2.0.0')];
    expect(displayNameFor(unversioned[0], unversioned)).toBe('Notes');
    expect(displayNameFor(unversioned[1], unversioned)).toBe('Notes v2.0.0');
  });
});
