/**
 * One capability schema, everywhere it is copied.
 *
 * The runtime enforces a list of capability names; the launcher asks consent
 * for them; the directory's PHP inspects a bundle for them; the site's pages
 * describe them. TypeScript holds the launcher and the runtime to the schema
 * at build time. The PHP and the site cannot import it — one is another
 * language, the other does not depend on the engine — so this test reads
 * their copies and compares. The lists had drifted for months before it
 * existed: `accel` was enforced and consented to while the directory
 * described a bundle asking for it as asking for nothing of the kind.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { CAPABILITIES, CAPABILITY_INFO, CAPABILITY_SCHEMA_VERSION, STORAGE_POLICIES, STORAGE_POLICY_INFO, inspectDeclaration, inspectBundle as coreInspect } from '@softn/core';
import { inspectBundle as siteInspect } from '../../softn-site/src/lib/inspectBundle';
import * as site from '../../softn-site/src/lib/capabilities';
import { CAPABILITIES as loaderList } from '../src/lib/bundleProcessor';
import { PERMISSION_INFO } from '../src/components/PermissionPrompt';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');

function phpList(source: string, constant: string): string[] {
  const list = source.match(new RegExp(`public const ${constant} = \\[([^\\]]*)\\];`));
  if (!list) throw new Error(`the PHP no longer declares ${constant} where this test reads it`);
  return list[1]
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

function phpSchema(): { version: number; names: string[]; policies: string[] } {
  const bundle = fs.readFileSync(path.join(repo, 'apps/softn-api/lib/bundle.php'), 'utf8');
  const storage = fs.readFileSync(path.join(repo, 'apps/softn-api/lib/storage.php'), 'utf8');
  const version = bundle.match(/public const CAPABILITY_SCHEMA_VERSION = (\d+);/);
  if (!version) throw new Error('bundle.php no longer declares CAPABILITY_SCHEMA_VERSION where this test reads it');
  return { version: Number(version[1]), names: phpList(bundle, 'CAPABILITIES'), policies: phpList(storage, 'POLICIES') };
}

describe('the capability schema', () => {
  it('is the same list in the runtime, the launcher, the directory API and the site', () => {
    const schema = [...CAPABILITIES];
    expect([...loaderList]).toEqual(schema);
    expect([...site.CAPABILITIES]).toEqual(schema);
    expect(phpSchema().names).toEqual(schema);
  });

  it('is the same version everywhere', () => {
    expect(site.CAPABILITY_SCHEMA_VERSION).toBe(CAPABILITY_SCHEMA_VERSION);
    expect(phpSchema().version).toBe(CAPABILITY_SCHEMA_VERSION);
  });

  it('has words for every capability in every place that describes one', () => {
    for (const name of CAPABILITIES) {
      expect(CAPABILITY_INFO[name].label, `core words for ${name}`).toBeTruthy();
      expect(site.CAPABILITY_INFO[name].label, `site words for ${name}`).toBeTruthy();
      expect(PERMISSION_INFO[name]?.label, `consent dialog words for ${name}`).toBeTruthy();
    }
    expect(Object.keys(site.CAPABILITY_INFO).sort()).toEqual([...CAPABILITIES].sort());
    expect(Object.keys(PERMISSION_INFO).sort()).toEqual([...CAPABILITIES].sort());
  });

  it('is the same list of storage policies, with words, in the runtime, the directory API and the site', () => {
    const policies = [...STORAGE_POLICIES];
    expect([...site.STORAGE_POLICIES]).toEqual(policies);
    expect(phpSchema().policies).toEqual(policies);
    expect(Object.keys(STORAGE_POLICY_INFO).sort()).toEqual([...policies].sort());
    expect(Object.keys(site.STORAGE_POLICY_INFO).sort()).toEqual([...policies].sort());
    for (const policy of STORAGE_POLICIES) {
      expect(site.STORAGE_POLICY_INFO[policy].label, `site words for ${policy}`).toBeTruthy();
    }
  });

  it('marks the same capabilities as reaching towards the person', () => {
    for (const name of CAPABILITIES) {
      expect(site.CAPABILITY_INFO[name].sensitive, name).toBe(CAPABILITY_INFO[name].sensitive);
    }
  });
});

describe('reading a declaration', () => {
  // The site refuses, in its pre-publish report, exactly what the directory
  // refuses; both are the runtime's reading. Same fixtures, same answers.
  const fixtures: unknown[] = [
    null,
    [],
    {},
    { permissions: {} },
    { permissions: [] },
    { permissions: { net: { enabled: true }, storage: { enabled: true, collections: { notes: 'private', '*': 'append-only' } } } },
    { permissions: { network: { enabled: true }, net: 'yes', camera: { enabled: 'true' }, mic: null, accel: { enabled: true } } },
    { permissions: { storage: { enabled: true, collections: ['scores'] } } },
    { permissions: { storage: { enabled: true, collections: { scores: 'readonly', 'Bad-Name': 'public', ok_name: 'owner-write' } } } },
    { permissions: { net: undefined, qr: { enabled: false }, gpu: {} } },
  ];
  it('is the same reading in the runtime and on the site', () => {
    for (const fixture of fixtures) {
      expect(site.inspectDeclaration(fixture), JSON.stringify(fixture)).toEqual(inspectDeclaration(fixture));
    }
  });
});

/**
 * The bundle inspector has two copies for the same reason the schema does:
 * the engine's (Builder, Studio and the runtime read it) and the site's
 * (which does not depend on the engine). What one refuses the other must
 * refuse, in the same words, or an author is told a bundle is fine in
 * Builder and refused on the publish page.
 */
describe('the bundle inspector', () => {
  const zip = (files: Record<string, string>) => {
    const entries: Record<string, Uint8Array> = {};
    for (const [k, v] of Object.entries(files)) entries[k] = strToU8(v, true);
    return zipSync(entries);
  };
  const manifest = (over: Record<string, unknown>) =>
    JSON.stringify({ name: 'Notes', version: '1.0.0', description: 'Keeps notes', main: 'ui/main.ui', files: { ui: ['ui/main.ui'] }, ...over });
  const fixtures: Record<string, Uint8Array> = {
    good: zip({ 'manifest.json': manifest({}), 'ui/main.ui': '<App/>', 'permission.json': JSON.stringify({ permissions: { net: { enabled: true } } }) }),
    'no manifest': zip({ 'ui/main.ui': '<App/>' }),
    'bad manifest': zip({ 'manifest.json': '{', 'ui/main.ui': '<App/>' }),
    'missing main': zip({ 'manifest.json': manifest({ main: 'ui/gone.ui' }) }),
    'missing listed file': zip({ 'manifest.json': manifest({ files: { ui: ['ui/main.ui'], logic: ['logic/x.logic'] } }), 'ui/main.ui': '<App/>' }),
    'unknown capability': zip({ 'manifest.json': manifest({}), 'ui/main.ui': '<App/>', 'permission.json': JSON.stringify({ permissions: { network: { enabled: true } } }) }),
    'bad policy': zip({ 'manifest.json': manifest({}), 'ui/main.ui': '<App/>', 'permission.json': JSON.stringify({ permissions: { storage: { enabled: true, collections: { notes: 'nope' } } } }) }),
    'no description or icon': zip({ 'manifest.json': manifest({ description: '' }), 'ui/main.ui': '<App/>' }),
    'icon missing': zip({ 'manifest.json': manifest({ icon: 'assets/icon.png' }), 'ui/main.ui': '<App/>' }),
    'icon present': zip({ 'manifest.json': manifest({ icon: 'assets/icon.svg' }), 'ui/main.ui': '<App/>', 'assets/icon.svg': '<svg/>' }),
    'worker': zip({ 'manifest.json': manifest({ config: { execution: 'worker' } }), 'ui/main.ui': '<App/>' }),
    'not a zip': strToU8('hello', true),
  };

  it('says the same in the engine and on the site, over the same bundles', () => {
    for (const [label, bytes] of Object.entries(fixtures)) {
      const a = JSON.parse(JSON.stringify(coreInspect(bytes)));
      const b = JSON.parse(JSON.stringify(siteInspect(bytes)));
      expect(a, label).toEqual(b);
    }
  });
});
